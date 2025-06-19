import {
    formatMoney, formatRam, formatDuration, formatDateTime, formatNumber, formatNumberShort,
    hashCode, disableLogs, log, getFilePath, getConfiguration,
    getNsDataThroughFile_Custom, runCommand_Custom, waitForProcessToComplete_Custom,
    tryGetBitNodeMultipliers_Custom, getActiveSourceFiles_Custom,
    getFnRunViaNsExec, tail, autoRetry, getErrorInfo
} from './helpers.js'

// daemon.js has histocially been the central orchestrator of almost every script in the game.
// Only recently has it been "indentured" to an even higher-level orchestrator: autopilot.js
// Its primary job is to manage hacking servers for income, but it also manages launching
// a myriad of helper scripts to take advantage of other game mechanics (such as solving coding contraacts)

// NOTE: This is the the oldest piece of code in the repo and is a mess of global properties and
//       functions scattered all over the place. I'll try to clean it up and organize it better over time
//       but my appologies if you are trying to read it. Other scripts should serve as better examples.

// These parameters are meant to let you tweak the script's behaviour from the command line (without altering source code)
let options;
const argsSchema = [
    // Behaviour-changing flags
    ['disable-stock-manipulation', false], // You must now opt *out* of stock-manipulation mode by enabling this flag.
    ['stock-manipulation-focus', false], // Stocks are main source of income - kill any scripts that would do them harm (TODO: Enable automatically in BN8)
    ['s', true], // (obsolete) Enable Stock Manipulation. This is now true for default, but left as a valid argument for backwards-compatibility.
    ['stock-manipulation', true], // (obsolete) Same as above

    ['n', false], // Can toggle on using hacknet nodes for extra hacking ram (at the expense of hash production)
    ['use-hacknet-nodes', false], // Same as above (kept for backwards compatibility, but these are now called hacknet-servers)
    ['use-hacknet-servers', false], // Same as above, but the game recently renamed these

    ['spend-hashes-for-money-when-under', 10E6], // (Default 10m) Convert 4 hashes to money whenever we're below this amount
    ['disable-spend-hashes', false], // An easy way to set the above to a very large negative number, thus never spending hashes for Money

    ['x', false], // Focus on a strategy that produces the most hack EXP rather than money
    ['xp-only', false], // Same as above
    ['initial-study-time', 10], // Seconds. Set to 0 to not do any studying at startup. By default, if early in an augmentation, will start with a little study to boost hack XP
    ['initial-hack-xp-time', 10], // Seconds. Set to 0 to not do any hack-xp grinding at startup. By default, if early in an augmentation, will start with a little study to boost hack XP

    ['reserved-ram', 32], // Keep this much home RAM free when scheduling hack/grow/weaken cycles on home.
    ['double-reserve-threshold', 512], // in GB of RAM. Double our home RAM reserve once there is this much home max RAM.

    ['share', undefined], // Enable sharing free ram to increase faction rep gain (by default, is enabled automatically once RAM is sufficient)
    ['no-share', false],  // Disable sharing free ram to increase faction rep gain
    ['share-cooldown', 5000], // Wait before attempting to schedule more share threads (e.g. to free RAM to be freed for hack batch scheduling first)
    ['share-max-utilization', 0.8], // Set to 1 if you don't care to leave any RAM free after sharing. Will use up to this much of the available RAM

    ['disable-script', []], // The names of scripts that you do not want run by our scheduler
    ['run-script', []], // The names of additional scripts that you want daemon to run on home

    ['max-purchased-server-spend', 0.25], // Percentage of total hack income earnings we're willing to re-invest in new hosts (extra RAM in the current aug only)

    // Batch script fine-tuning flags
    ['initial-max-targets', undefined], // Initial number of servers to target / prep (default is 2 + 1 for every 500 TB of RAM on the network)
    ['cycle-timing-delay', 4000], // (ms) Length of a hack cycle. The smaller this is, the more batches (HWGW) we can schedule before the first cycle fires, but the greater the chance of a misfire
    ['queue-delay', 1000], // (ms) Delay before the first script begins, to give time for all scripts to be scheduled
    ['recovery-thread-padding', 1], // Multiply the number of grow/weaken threads needed by this amount to automatically recover more quickly from misfires.
    ['max-batches', 40], // Maximum overlapping cycles to schedule in advance. Note that once scheduled, we must wait for all batches to complete before we can schedule mor
    ['max-steal-percentage', 0.75], // Don't steal more than this in case something goes wrong with timing or scheduling, it's hard to recover frome

    ['looping-mode', false], // Set to true to attempt to schedule perpetually-looping tasks.

    // Special-situation flags
    ['i', false], // Farm intelligence with manual hack.

    // Debugging flags
    ['silent-misfires', false], // Instruct remote scripts not to alert when they misfire
    ['no-tail-windows', false], // Set to true to prevent the default behaviour of opening a tail window for certain launched scripts. (Doesn't affect scripts that open their own tail windows)
    ['h', false], // Do nothing but hack, no prepping (drains servers to 0 money, if you want to do that for some reason)
    ['hack-only', false], // Same as above
    ['v', false], // Detailed logs about batch scheduling / tuning
    ['verbose', false], // Same as above
    ['o', false], // Good for debugging, run the main targettomg loop once then stop, with some extra logs
    ['run-once', false], // Same as above
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (lastFlag == "--disable-script" || lastFlag == "--run-script")
        return data.scripts;
    return [];
}

// script entry point
/** @param {NS} ns **/
export async function main(ns) {
    // --- CONSTANTS ---
    // track how costly (in security) a growth/hacking thread is.
    const growthThreadHardening = 0.004;
    const hackThreadHardening = 0.002;
    // initial potency of weaken threads before multipliers
    const weakenThreadPotency = 0.05;
    // unadjusted server growth rate, this is way more than what you actually get
    const unadjustedGrowthRate = 1.03;
    // max server growth rate, growth rates higher than this are throttled.
    const maxGrowthRate = 1.0035;
    // The name given to purchased servers (should match what's in host-manager.js)
    const purchasedServersName = "daemon";
    // The name of the server to try running scripts on if home RAM is <= 16GB (early BN1)
    const backupServerName = 'harakiri-sushi'; // Somewhat arbitrarily chosen. It's one of several servers with 16GB which requires no open ports to crack.

    // The maximum current total RAM utilization before we stop attempting to schedule work for the next less profitable server. Can be used to reserve capacity.
    const maxUtilization = 0.95;
    const lowUtilizationThreshold = 0.80; // The counterpart - low utilization, which leads us to ramp up targets
    // If we have plenty of resources after targeting all possible servers, we can start to grow/weaken servers above our hack level - up to this utilization
    const maxUtilizationPreppingAboveHackLevel = 0.75;
    // Maximum number of milliseconds the main targeting loop should run before we take a break until the next loop
    const maxLoopTime = 1000; //ms

    // --- VARS ---
    // DISCLAIMER: Take any values you see assigned here with a grain of salt. Due to oddities in how Bitburner runs scripts,
    // global state can be shared between multiple instances of the same script. As such, many of these values must
    // be reset in the main method of this script (and if they aren't it's likely to manifest as a bug.)

    let loopInterval = 1000; //ms
    // the number of milliseconds to delay the grow execution after theft to ensure it doesn't trigger too early and have no effect.
    // For timing reasons the delay between each step should be *close* 1/4th of this number, but there is some imprecision
    let cycleTimingDelay = 0; // (Set in command line args)
    let queueDelay = 0; // (Set in command line args) The delay that it can take for a script to start, used to pessimistically schedule things in advance
    let maxBatches = 0; // (Set in command line args) The max number of batches this daemon will spool up to avoid running out of IRL ram (TODO: Stop wasting RAM by scheduling batches so far in advance. e.g. Grind XP while waiting for cycle start!)
    let maxTargets = 0; // (Set in command line args) Initial value, will grow if there is an abundance of RAM
    let maxPreppingAtMaxTargets = 3; // The max servers we can prep when we're at our current max targets and have spare RAM
    // Allows some home ram to be reserved for ad-hoc terminal script running and when home is explicitly set as the "preferred server" for starting a helper
    let homeReservedRam = 0; // (Set in command line args)

    let allHostNames = (/**@returns {string[]}*/() => [])(); // simple name array of servers that have been discovered
    let _allServers = (/**@returns{Server[]}*/() => [])(); // Array of Server objects - our internal model of servers for hacking
    let homeServer = (/**@returns{Server}*/() => [])(); // Quick access to the home server object.
    // Lists of tools (external scripts) run
    let hackTools, asynchronousHelpers, periodicScripts;
    // Helper dict for remembering the names and costs of the scripts we use the most
    let toolsByShortName = (/**@returns{{[id: string]: Tool;}}*/() => undefined)(); // Dictionary of tools keyed by tool short name
    let allHelpersRunning = false; // Tracks whether all long-lived helper scripts have been launched
    let studying = false; // Whether we're currently studying

    // Command line Flags
    let hackOnly = false; // "-h" command line arg - don't grow or shrink, just hack (a.k.a. scrapping mode)
    let stockMode = false; // "-s" command line arg - hack/grow servers in a way that boosts our current stock positions
    let stockFocus = false;  // If true, stocks are main source of income - kill any scripts that would do them harm
    let xpOnly = false; // "-x" command line arg - focus on a strategy that produces the most hack EXP rather than money
    let verbose = false; // "-v" command line arg - Detailed logs about batch scheduling / tuning
    let runOnce = false; // "-o" command line arg - Good for debugging, run the main targettomg loop once then stop
    let useHacknetNodes = false; // "-n" command line arg - Can toggle using hacknet nodes for extra hacking ram
    let loopingMode = false;
    let recoveryThreadPadding = 1; // How many multiples to increase the weaken/grow threads to recovery from misfires automatically (useful when RAM is abundant and timings are tight)

    let daemonHost = null; // the name of the host of this daemon, so we don't have to call the function more than once.
    let hasFormulas = true;
    let currentTerminalServer = ""; // Periodically updated when intelligence farming, the current connected terminal server.
    let dictSourceFiles = (/**@returns{{[bitNode: number]: number;}}*/() => undefined)(); // Available source files
    let bitNodeMults = (/**@returns{BitNodeMultipliers}*/() => undefined)();
    let bitNodeN = 1; // The bitnode we're in
    let haveTixApi = false, have4sApi = false; // Whether we have WSE API accesses
    let _cachedPlayerInfo = (/**@returns{Player}*/() => undefined)(); // stores multipliers for player abilities and other player info
    let moneySources = (/**@returns{MoneySources}*/() => undefined)(); // Cache of player income/expenses by category

    // Property to avoid log churn if our status hasn't changed since the last loop
    let lastUpdate = "";
    let lastUpdateTime = Date.now();
    let lowUtilizationIterations = 0;
    let highUtilizationIterations = 0;
    let lastShareTime = 0; // Tracks when share was last invoked so we can respect the configured share-cooldown
    let allTargetsPrepped = false;

    /** Ram-dodge getting updated player info.
     * @param {NS} ns
     * @returns {Promise<Player>} */
    async function getPlayerInfo(ns) {
        // return _cachedPlayerInfo = ns.getPlayer();
        return _cachedPlayerInfo = await getNsDataThroughFile(ns, `ns.getPlayer()`);
    }

    function playerHackSkill() { return _cachedPlayerInfo.skills.hacking; }

    function getPlayerHackingGrowMulti() { return _cachedPlayerInfo.mults.hacking_grow; };

    /** @param {NS} ns
     * @returns {Promise<{ type: "COMPANY"|"FACTION"|"CLASS"|"CRIME", cyclesWorked: number, crimeType: string, classType: string, location: string, companyName: string, factionName: string, factionWorkType: string }>} */
    async function getCurrentWorkInfo(ns) {
        return (await getNsDataThroughFile(ns, 'ns.singularity.getCurrentWork()')) ?? {};
    }

    /** Helper to check if a file exists.
     * A helper is used so that we have the option of exploring alternative implementations that cost less/no RAM.
     * @param {NS} ns
     * @returns {Promise<boolean>} */
    async function doesFileExist(ns, fileName, hostname = undefined) {
        // Fast (and free) - for local files, try to read the file and ensure it's not empty
        hostname ??= daemonHost;
        if (hostname === daemonHost && !fileName.endsWith('.exe'))
            return ns.read(fileName) != '';
        // return ns.fileExists(fileName, hostname);
        // TODO: If the approach below causes too much latency, we may wish to cease ram dodging and revert to the simple method above.
        const targetServer = getServerByName(hostname); // Each server object should have a cache of files on that server.
        if (!targetServer) // If the servers are not yet set up, use the fallback approach (filesExist)
            return await filesExist(ns, [fileName], hostname);
        return await targetServer.hasFile(fileName);
    }

    /** Helper to check which of a set of files exist on a remote server in a single batch ram-dodging request
     * @param {NS} ns
     * @param {string[]} fileNames
     * @returns {Promise<boolean[]>} */
    async function filesExist(ns, fileNames, hostname = undefined) {
        return await getNsDataThroughFile(ns, `ns.args.slice(1).map(f => ns.fileExists(f, ns.args[0]))`,
            '/Temp/files-exist.txt', [hostname ?? daemonHost, ...fileNames])
    }

    let psCache = (/**@returns{{[serverName: string]: ProcessInfo[];}}*/() => ({}))();
    /** PS can get expensive, and we use it a lot so we cache this for the duration of a loop
     * @param {NS} ns
     * @param {string} serverName
     * @returns {ProcessInfo[]} All processes running on this server. */
    function processList(ns, serverName, canUseCache = true) {
        let psResult = null;
        if (canUseCache)
            psResult = psCache[serverName];
        // Note: We experimented with ram-dodging `ps`, but there's so much data involed that serializing/deserializing generates a lot of latency
        //psResult ??= await getNsDataThroughFile(ns, 'ns.ps(ns.args[0])', null, [serverName]));
        psResult ??= psCache[serverName] = ns.ps(serverName);
        return psResult;
    }

    /** Get the players own money
     * @param {NS} ns
     * @returns {number} */
    function getPlayerMoney(ns) {
        return ns.getServerMoneyAvailable("home");
    }

    /** Returns the amount of money we should currently be reserving. Dynamically adapts to save money for a couple of big purchases on the horizon
     * @param {NS} ns
     * @returns {number} */
    function reservedMoney(ns) {
        let shouldReserve = Number(ns.read("reserve.txt") || 0);
        let playerMoney = getPlayerMoney(ns);
        // Conserve money if we get close to affording the last hack tool
        if (!ownedCracks.includes("SQLInject.exe") && playerMoney > 200e6)
            shouldReserve += 250e6; // Start saving at 200m of the 250m required for SQLInject
        // Conserve money if we're close to being able to afford the Stock Market 4s API
        const fourSigmaCost = (bitNodeMults.FourSigmaMarketDataApiCost * 25000000000);
        if (!have4sApi && playerMoney >= fourSigmaCost / 2)
            shouldReserve += fourSigmaCost; // Start saving if we're half-way to buying 4S market access
        // Conserve money if we're in BN10 and nearing the cost of the last last sleeve
        if (bitNodeN == 10 && playerMoney >= 10e15) // 10q - 10% the cost of the last sleeve
            shouldReserve = 100e15; // 100q, the cost of the 6th sleeve from The Covenant
        return shouldReserve;
    }

    /** @param {NS} ns **/
    async function startup(ns) {
        daemonHost = "home"; // ns.getHostname(); // get the name of this node (realistically, will always be home)
        const runOptions = getConfiguration(ns, argsSchema);
        if (!runOptions) return;

        // Ensure no other copies of this script are running (they share memory)
        const scriptName = ns.getScriptName();
        const competingDaemons = processList(ns, daemonHost, false /* Important! Don't use the (global shared) cache. */)
            .filter(s => s.filename == scriptName && s.pid != ns.pid);
        if (competingDaemons.length > 0) { // We expect only 1, due to this logic, but just in case, generalize the code below to support multiple.
            const daemonPids = competingDaemons.map(p => p.pid);
            log(ns, `Info: Killing another '${scriptName}' instance running on home (pid: ${daemonPids} args: ` +
                `[${competingDaemons[0].args.join(", ")}]) with new args ([${ns.args.join(", ")}])...`, true)
            const killPid = await killProcessIds(ns, daemonPids);
            await waitForProcessToComplete_Custom(ns, getHomeProcIsAlive(ns), killPid);
            await ns.sleep(loopInterval); // The game can be slow to kill scripts, give it an extra bit of time.
        }

        disableLogs(ns, ['getServerMaxRam', 'getServerUsedRam', 'getServerMoneyAvailable', 'getServerGrowth', 'getServerSecurityLevel', 'exec', 'scan', 'sleep']);
        // Reset global vars on startup since they persist in memory in certain situations (such as on Augmentation)
        // TODO: Can probably get rid of all of this now that the entire script is wrapped in the main function.
        lastUpdate = "";
        lastUpdateTime = Date.now();
        maxTargets = 2;
        lowUtilizationIterations = highUtilizationIterations = 0;
        allHostNames = [], _allServers = [], homeServer = null;
        resetServerSortCache();
        ownedCracks = [];
        psCache = {};
        // XpMode Related Caches
        singleServerLimit = 0, lastCycleTotalRam = 0; // Cache of total ram on the server to check whether we should attempt to lift the above restriction.
        targetsByExp = [], jobHostMappings = {}, farmXpReentryLock = [], nextXpCycleEnd = [];
        loopsHackThreadsByServer = {}, loopsByServer_Grow = {}, loopsByServer_Weaken = {};
        // Stock mode related caches
        serversWithOwnedStock = [], shouldManipulateGrow = [], shouldManipulateHack = [];
        failedStockUpdates = 0;

        // Get information about the player's current stats (also populates a cache)
        const playerInfo = await getPlayerInfo(ns);

        // Try to get "resetInfo", with a fallback for a failed dynamic call (i.e. low-ram conditions)
        let resetInfo;
        try {
            resetInfo = await getNsDataThroughFile(ns, `ns.getResetInfo()`);
        } catch {
            resetInfo = { currentNode: 1, lastAugReset: Date.now() };
        }
        bitNodeN = resetInfo.currentNode;
        dictSourceFiles = await getActiveSourceFiles_Custom(ns, getNsDataThroughFile);
        log(ns, "The following source files are active: " + JSON.stringify(dictSourceFiles));

        // Process configuration
        options = runOptions;
        hackOnly = options.h || options['hack-only'];
        xpOnly = options.x || options['xp-only'];
        stockMode = (options.s || options['stock-manipulation'] || options['stock-manipulation-focus']) && !options['disable-stock-manipulation'];
        stockFocus = options['stock-manipulation-focus'] && !options['disable-stock-manipulation'];
        useHacknetNodes = options.n || options['use-hacknet-nodes'] || options['use-hacknet-servers'];
        verbose = options.v || options['verbose'];
        runOnce = options.o || options['run-once'];
        loopingMode = options['looping-mode'];
        recoveryThreadPadding = options['recovery-thread-padding'];
        cycleTimingDelay = options['cycle-timing-delay'];
        queueDelay = options['queue-delay'];
        maxBatches = options['max-batches'];
        homeReservedRam = options['reserved-ram']
        maxTargets = options['initial-max-targets'] ?? 0;
        if (stockFocus) { // If the user explicitly requested to focus on stocks, ensure we start with as many targets as there are stock symbols
            maxTargets = Math.max(maxTargets, Object.keys(serverStockSymbols).length);
            log(ns, `Defaulting --initial-max-targets to ${maxTargets} so that we may manipulate every stock (due to --stock-manipulation-focus flag)`);
        }

        // Log which flaggs are active
        if (hackOnly) log(ns, '-h - Hack-Only mode activated!');
        if (xpOnly) log(ns, '-x - Hack XP Grinding mode activated!');
        if (useHacknetNodes) log(ns, '-n - Using hacknet nodes to run scripts!');
        if (verbose) log(ns, '-v - Verbose logging activated!');
        if (runOnce) log(ns, '-o - Run-once mode activated!');
        if (stockMode) log(ns, 'Stock market manipulation mode is active (now enabled by default)');
        if (!stockMode) log(ns, "--disable-stock-manipulation - Stock manipulation has been disabled.");
        if (stockFocus) log(ns, '--stock-manipulation-focus - Stock market manipulation is the main priority');
        if (loopingMode) {
            log(ns, '--looping-mode - scheduled remote tasks will loop themselves');
            // cycleTimingDelay = 0;
            // queueDelay = 0;
            if (recoveryThreadPadding == 1) recoveryThreadPadding = 10; // Default if not specified (TODO: Improve timings so we don't need so much padding)
            if (stockMode) stockFocus = true; // Need to actively kill scripts that go against stock because they will live forever
        }
        if (xpOnly && !options['no-share']) {
            options['no-share'] = true;
            log(ns, '--no-share has been implied by -x (--xp-only)');
        }

        // These scripts are started once and expected to run forever (or terminate themselves when no longer needed)
        const openTailWindows = !options['no-tail-windows'];
        if (openTailWindows) log(ns, 'Opening tail windows for helper scripts (run with --no-tail-windows to disable)');

        await establishMultipliers(ns); // figure out the various bitNode and player multipliers

        // Helper to determine whether we meed a given home RAM requirement (To avoid wasting precious early-BN RAM, many scripts don't launch unless we have more than a certain amount)
        const reqRam = (ram) => homeServer.totalRam(/*ignoreReservedRam:*/true) >= ram;
        // Helper to decide whether we should launch one of the hacknet upgrade manager scripts.
        const shouldUpgradeHacknet = () =>
            bitNodeMults.HacknetNodeMoney > 0 && // Ensure hacknet is not disabled in this BN
            reqRam(Math.min(64, homeReservedRam + 6.1)) && // These scripts consume 6.1 GB and keep running a long time, so we want to ensure we have more than the home reservered RAM amount available if home reserved RAM is a small number
            getPlayerMoney(ns) > reservedMoney(ns); // Player money exceeds the reserve (otherwise it will sit there buying nothing)

        // ASYNCHRONOUS HELPERS
        // Set up "asynchronous helpers" - standalone scripts to manage certain aspacts of the game. daemon.js launches each of these once when ready (but not again if they are shut down)
        asynchronousHelpers = [
            { name: "stats.js", shouldRun: () => reqRam(64), shouldTail: false }, // Adds stats not usually in the HUD (nice to have)
            { name: "go.js", shouldRun: () => reqRam(64), minRamReq: 20.2 }, // Play go.js (various multipliers, but large dynamic ram requirements)
            { name: "stockmaster.js", shouldRun: () => reqRam(64), args: openTailWindows ? ["--show-market-summary"] : [] }, // Start our stockmaster
            { name: "hacknet-upgrade-manager.js", shouldRun: () => shouldUpgradeHacknet(), args: ["-c", "--max-payoff-time", "1h", "--interval", "0"], shouldTail: false }, // One-time kickstart of hash income by buying everything with up to 1h payoff time immediately
            { name: "spend-hacknet-hashes.js", shouldRun: () => reqRam(64) && 9 in dictSourceFiles, args: [], shouldTail: false }, // Always have this running to make sure hashes aren't wasted
            { name: "sleeve.js", shouldRun: () => reqRam(64) && 10 in dictSourceFiles }, // Script to create manage our sleeves for us
            { name: "gangs.js", shouldRun: () => reqRam(64) && 2 in dictSourceFiles }, // Script to create manage our gang for us
            {
                name: "work-for-factions.js", args: ['--fast-crimes-only', '--no-coding-contracts'],  // Singularity script to manage how we use our "focus" work.
                shouldRun: () => 4 in dictSourceFiles && reqRam(256 / (2 ** dictSourceFiles[4]) && !studying) // Higher SF4 levels result in lower RAM requirements
            },
            {
                name: "bladeburner.js", // Script to manage bladeburner for us. Run automatically if not disabled and bladeburner API is available
                shouldRun: () => !options['disable-script'].includes('bladeburner.js') && reqRam(64)
                    && 7 in dictSourceFiles && bitNodeMults.BladeburnerRank != 0 // Don't run bladeburner in BN's where it can't rank up (currently just BN8)
            },
        ];
        // Add any additional scripts to be run provided by --run-script arguments
        options['run-script'].forEach(s => asynchronousHelpers.push({ name: s }));
        // Set these helper functions to not be marked as "temporary" when they are run (save their execution state)
        asynchronousHelpers.forEach(helper => helper.runOptions = { temporary: false });
        asynchronousHelpers.forEach(helper => helper.isLaunched = false);
        asynchronousHelpers.forEach(helper => helper.ignoreReservedRam = true);
        if (openTailWindows) // Tools should be tailed unless they explicitly opted out in the config above
            asynchronousHelpers.forEach(helper => helper.shouldTail ??= true);

        // PERIODIC SCRIPTS
        // These scripts are spawned periodically (at some interval) to do their checks, with an optional condition that limits when they should be spawned
        // Note: Periodic script are generally run every 30 seconds, but intervals are spaced out to ensure they aren't all bursting into temporary RAM at the same time.
        periodicScripts = [
            // Buy tor as soon as we can if we haven't already, and all the port crackers
            { interval: 25000, name: "/Tasks/tor-manager.js", shouldRun: () => 4 in dictSourceFiles && !allHostNames.includes("darkweb") },
            { interval: 26000, name: "/Tasks/program-manager.js", shouldRun: () => 4 in dictSourceFiles && ownedCracks.length != 5 },
            { interval: 27000, name: "/Tasks/contractor.js", minRamReq: 14.2 }, // Periodically look for coding contracts that need solving
            // Buy every hacknet upgrade with up to 4h payoff if it is less than 10% of our current money or 8h if it is less than 1% of our current money.
            { interval: 28000, name: "hacknet-upgrade-manager.js", shouldRun: shouldUpgradeHacknet, args: () => ["-c", "--max-payoff-time", "4h", "--max-spend", getPlayerMoney(ns) * 0.1] },
            { interval: 28500, name: "hacknet-upgrade-manager.js", shouldRun: shouldUpgradeHacknet, args: () => ["-c", "--max-payoff-time", "8h", "--max-spend", getPlayerMoney(ns) * 0.01] },
            // Buy upgrades regardless of payoff if they cost less than 0.1% of our money
            { interval: 29000, name: "hacknet-upgrade-manager.js", shouldRun: shouldUpgradeHacknet, args: () => ["-c", "--max-payoff-time", "1E100h", "--max-spend", getPlayerMoney(ns) * 0.001] },
            {   // Spend about 50% of un-reserved cash on home RAM upgrades (permanent) when they become available
                interval: 30000, name: "/Tasks/ram-manager.js", args: () => ['--budget', 0.5, '--reserve', reservedMoney(ns)],
                shouldRun: () => 4 in dictSourceFiles && shouldImproveHacking() // Only trigger if hack income is important
            },
            {   // Periodically check for new faction invites and join if deemed useful to be in that faction. Also determines how many augs we could afford if we installed right now
                interval: 31000, name: "faction-manager.js", args: ['--verbose', 'false'],
                // Don't start auto-joining factions until we're holding 1 billion (so coding contracts returning money is probably less critical) or we've joined one already
                shouldRun: () => 4 in dictSourceFiles && (_cachedPlayerInfo.factions.length > 0 || getPlayerMoney(ns) > 1e9) &&
                    reqRam(128 / (2 ** dictSourceFiles[4])) // Uses singularity functions, and higher SF4 levels result in lower RAM requirements
            },
            {   // Periodically look to purchase new servers, but note that these are often not a great use of our money (hack income isn't everything) so we may hold-back.
                interval: 32000, name: "host-manager.js", minRamReq: 6.55,
                // Restrict spending on new servers (i.e. temporary RAM for the current augmentation only) to be a % of total earned hack income.
                shouldRun: () => shouldImproveHacking() && getHostManagerBudget() > 0,
                args: () => ['--budget', getHostManagerBudget(), '--absolute-reserve', reservedMoney(ns),
                    // Mechanic to reserve more of our money the longer we've been in the BN. Starts at 0%, after 24h we should be reserving 92%.
                    '--reserve-by-time', true, '--reserve-by-time-decay-factor', 0.1, '--reserve-percent', 0,
                    '--utilization-trigger', '0'], // Disable utilization-based restrictions on purchasing RAM
            },
            // Check if any new servers can be backdoored. If there are many, this can eat up a lot of RAM, so make this the last script scheduled at startup.
            { interval: 33000, name: "/Tasks/backdoor-all-servers.js", shouldRun: () => 4 in dictSourceFiles && playerHackSkill() > 10 }, // Don't do this until we reach hack level 10. If we backdoor too early, it's very slow and eats up RAM for a long time,
        ];
        periodicScripts.forEach(tool => tool.ignoreReservedRam = true);
        if (verbose) // In verbose mode, have periodic sripts persist their logs.
            periodicScripts.forEach(tool => tool.runOptions = { temporary: false });
        // HACK TOOLS (run with many threads)
        hackTools = [
            { name: "/Remote/weak-target.js", shortName: "weak", threadSpreadingAllowed: true },
            { name: "/Remote/grow-target.js", shortName: "grow" }, // Don't want to split because of security hardening after each fire, reducing success chance of next chunk. Also, a minor reduction in gains due to loss of thread count in base money added before exponential growth.
            { name: "/Remote/hack-target.js", shortName: "hack" }, // Don't want to split because of security hardening, as above.
            { name: "/Remote/manualhack-target.js", shortName: "manualhack" },
            { name: "/Remote/share.js", shortName: "share", threadSpreadingAllowed: true },
        ];
        hackTools.forEach(tool => tool.ignoreReservedRam = false);

        await buildToolkit(ns, [...asynchronousHelpers, ...periodicScripts, ...hackTools]); // build toolkit
        await buildServerList(ns, false); // create the exhaustive server list

        // If we ascended less than 10 minutes ago, start with some study and/or XP cycles to quickly restore hack XP
        const timeSinceLastAug = Date.now() - resetInfo.lastAugReset;
        const shouldKickstartHackXp = (playerHackSkill() < 500 && timeSinceLastAug < 600000 && reqRam(16)); // RamReq ensures we don't attempt this in BN1.1
        studying = shouldKickstartHackXp ? true : false; // Flag will be used to prevent focus-stealing scripts from running until we're done studying.

        // Immediately crack all servers we can to maximize RAM available on the first loop
        for (const server of getAllServers())
            if (!server.hasRoot() && server.canCrack())
                await doRoot(ns, server);

        if (shouldKickstartHackXp) {
            // Start helper scripts and run periodic scripts for the first time to e.g. buy tor and any hack tools available to us (we will continue studying briefly while this happens)
            await runStartupScripts(ns);
            await runPeriodicScripts(ns);
            await kickstartHackXp(ns);
        }

        // Default the initial maximum number of targets of none was specified.
        if (maxTargets == 0) {
            const networkStats = getNetworkStats();
            maxTargets = 2 + Math.round(networkStats.totalMaxRam / (500 * 1024));
            log(ns, `Defaulting --initial-max-targets to ${maxTargets} since total ram available is ${formatRam(networkStats.totalMaxRam)}`);
        }

        // Start the main targetting loop
        await doTargetingLoop(ns);
    }

    /** Periodic scripts helper function: In bitnodes with hack income disabled, don't waste money on improving hacking infrastructure */
    function shouldImproveHacking() {
        return 0 != (bitNodeMults.ScriptHackMoneyGain * bitNodeMults.ScriptHackMoney) || // Check for disabled hack-income
            getPlayerMoney(ns) > 1e12 || // If we have sufficient money, we may consider improving hack infrastructure (to earn hack exp more quickly)
            bitNodeN === 8 // The exception is in BN8, we still want lots of hacking to take place to manipulate stocks, which requires this infrastructure (TODO: Strike a balance between spending on this stuff and leaving money for stockmaster.js)
    }

    /** Periodic scripts helper function: Get how much we're willing to spend on new servers (host-manager.js budget) */
    function getHostManagerBudget() {
        const serverSpend = -(moneySources?.sinceInstall?.servers ?? 0); // This is given as a negative number (profit), we invert it to get it as a positive expense amount
        const budget = Math.max(0,
            // Ensure the total amount of money spent on new servers is less than the configured max spend amount
            options['max-purchased-server-spend'] * (moneySources?.sinceInstall?.hacking ?? 0) - serverSpend,
            // Special-case support: In some BNs hack income is severely penalized (or zero) but earning hack exp is still useful.
            // To support these, always allow a small percentage (0.1%) of our total earnings (including other income sources) to be spent on servers
            (moneySources?.sinceInstall?.total ?? 0) * 0.001 - serverSpend);
        //log(ns, `Math.max(0, ${options['max-purchased-server-spend']} * (${formatMoney(moneySources?.sinceInstall?.hacking)} ?? 0) - ${formatMoney(serverSpend)}, ` +
        //    `(${formatMoney(moneySources?.sinceInstall?.total)} ?? 0) * 0.001 - ${formatMoney(serverSpend)}) = ${formatMoney(budget)}`);
        return budget;
    }

    /** @param {NS} ns
     * Gain a hack XP early after a new Augmentation by studying a bit, then doing a bit of XP grinding */
    async function kickstartHackXp(ns) {
        let startedStudying = false;
        try {
            if (4 in dictSourceFiles && options['initial-study-time'] > 0) {
                // The safe/cheap thing to do is to study for free at the local university in our current town
                // The most effective thing is to study Algorithms at ZB university in Aevum.
                // Depending on our money, try to do the latter.
                try {
                    const studyTime = options['initial-study-time'];
                    log(ns, `INFO: Studying for ${studyTime} seconds to kickstart hack XP and speed up initial cycle times. (set --initial-study-time 0 to disable this step.)`);
                    const money = getPlayerMoney(ns)
                    const { CityName, LocationName, UniversityClassType } = ns.enums
                    if (money >= 200000) { // If we can afford to travel, we're probably far enough along that it's worthwhile going to Volhaven where ZB university is.
                        log(ns, `INFO: Travelling to Volhaven for best study XP gain rate.`);
                        await getNsDataThroughFile(ns, `ns.singularity.travelToCity(ns.args[0])`, null, [CityName.Volhaven]);
                    }
                    const playerInfo = await getPlayerInfo(ns); // Update player stats to be certain of our new location.
                    const university = playerInfo.city == CityName.Sector12 ? LocationName.Sector12RothmanUniversity :
                        playerInfo.city == CityName.Aevum ? LocationName.AevumSummitUniversity :
                            playerInfo.city == CityName.Volhaven ? LocationName.VolhavenZBInstituteOfTechnology : null;
                    if (!university)
                        log(ns, `WARN: Cannot study, because you are in city ${playerInfo.city} which has no known university, and you cannot afford to travel to another city.`, false, 'warning');
                    else {
                        const course = playerInfo.city == CityName.Sector12 ? UniversityClassType.computerScience : UniversityClassType.algorithms; // Assume if we are still in Sector-12 we are poor and should only take the free course
                        log(ns, `INFO: Studying "${course}" at "${university}" because we are in city "${playerInfo.city}".`);
                        startedStudying = await getNsDataThroughFile(ns, `ns.singularity.universityCourse(ns.args[0], ns.args[1], ns.args[2])`, null, [university, course, false]);
                        if (startedStudying)
                            await ns.sleep(studyTime * 1000); // Wait for studies to affect Hack XP. This will often greatly reduce time-to-hack/grow/weaken, and avoid a slow first cycle
                        else
                            log(ns, `WARNING: Failed to study to kickstart hack XP: ns.singularity.universityCourse("${university}", "${course}", false) returned "false".`, false, 'warning');
                    }
                } catch (err) { log(ns, `WARNING: Caught error while trying to study to kickstart hack XP: ${getErrorInfo(err)}`, false, 'warning'); }
            }
            // Immediately attempt to root initially-accessible targets before attempting any XP cycles
            for (const server of getAllServers().filter(s => !s.hasRoot() && s.canCrack()))
                await doRoot(ns, server);
            // Before starting normal hacking, fire a couple hack XP-focused cycle using a chunk of free RAM to further boost RAM
            if (!xpOnly) {
                let maxXpCycles = 10000; // Avoid an infinite loop if something goes wrong
                const maxXpTime = options['initial-hack-xp-time'];
                const start = Date.now();
                const xpTarget = getBestXPFarmTarget();
                const minCycleTime = xpTarget.timeToWeaken();
                if (minCycleTime > maxXpTime * 1000)
                    return log(ns, `INFO: Skipping XP cycle because the best target (${xpTarget.name}) time to weaken (${formatDuration(minCycleTime)})` +
                        ` is greater than the configured --initial-hack-xp-time of ${maxXpTime} seconds.`);
                log(ns, `INFO: Running Hack XP-focused cycles for ${maxXpTime} seconds to further boost hack XP and speed up main hack cycle times. (set --initial-hack-xp-time 0 to disable this step.)`);
                while (maxXpCycles-- > 0 && Date.now() - start < maxXpTime * 1000) {
                    let cycleTime = await farmHackXp(ns, 1, verbose, 1);
                    if (cycleTime)
                        await ns.sleep(cycleTime);
                    else
                        return log(ns, 'WARNING: Failed to schedule an XP cycle', false, 'warning');
                    log(ns, `INFO: Hacked ${xpTarget.name} for ${cycleTime.toFixed(1)}ms, (${Date.now() - start}ms total) of ${maxXpTime * 1000}ms`);
                }
            }
        } catch {
            log(ns, 'WARNING: Encountered an error while trying to kickstart hack XP (low RAM issues perhaps?)', false, 'warning');
        } finally {
            // Ensure we stop studying (in case no other running scripts end up stealing focus, so we don't keep studying forever)
            if (startedStudying) await getNsDataThroughFile(ns, `ns.singularity.stopAction()`);
            studying = false; // This will allow work-for-faction to launch
        }
    }

    /** Check running status of scripts on servers
     * @param {NS} ns
     * @param {string} scriptName
     * @returns {[string, pid]} */
    function whichServerIsRunning(ns, scriptName, canUseCache = true) {
        for (const server of getAllServers()) {
            const psList = processList(ns, server.name, canUseCache);
            const matches = psList.filter(p => p.filename == scriptName);
            if (matches.length >= 1)
                return [server.name, matches[0].pid];
        }
        return [null, null];
    }

    /** Helper to kick off external scripts
     * @param {NS} ns
     * @returns {Promise<boolean>} true if all scripts have been launched */
    async function runStartupScripts(ns) {
        let launched = 0;
        for (const script of asynchronousHelpers.filter(s => !s.isLaunched)) {
            if (!(await tryRunTool(ns, getTool(script))))
                continue; // We may have chosen not to run the script for a number of reasons. Proceed to the next one.
            if (++launched > 1) await ns.sleep(1); // If we successfully launch more than 1 script at a time, yeild execution a moment to give them a chance to complete, so many aren't all fighting for temp RAM at the same time.
            script.isLaunched = true;
        }
        // if every helper is launched already return "true" so we can skip doing this each cycle going forward.
        return asynchronousHelpers.reduce((allLaunched, tool) => allLaunched && tool.isLaunched, true);
    }

    /** Checks whether it's time for any scheduled tasks to run
     * @param {NS} ns */
    async function runPeriodicScripts(ns) {
        let launched = 0;
        for (const script of periodicScripts) {
            // Only run this tool if it's been more than <task.interval> milliseconds since it was last run
            const timeSinceLastRun = Date.now() - (script.lastRun || 0);
            if (timeSinceLastRun <= script.interval) continue;
            script.lastRun = Date.now(); // Update the last run date whether we successfully ran it or not           
            if (await tryRunTool(ns, getTool(script))) // Try to run the task
                if (++launched > 1) await ns.sleep(1); // If we successfully launch more than 1 script at a time, yeild execution a moment to give them a chance to complete, so many aren't all fighting for temp RAM at the same time.
        }

        // Hack: this doesn't really belong here, but is essentially a "temp script" we periodically run when needed
        // Super-early aug, if we are poor, spend hashes as soon as we get them for a quick cash injection. (Only applies if we have hacknet servers)
        if (9 in dictSourceFiles && !options['disable-spend-hashes']) { // See if we have a hacknet, and spending hashes for money isn't disabled
            if (homeServer.getMoney() < options['spend-hashes-for-money-when-under'] // Only if money is below the configured threshold
                && homeServer.ramAvailable(/*ignoreReservedRam:*/true) >= 5.6) { // Ensure we have spare RAM to run this temp script
                await runCommand(ns, `0; if(ns.hacknet.spendHashes("Sell for Money")) ns.toast('Sold 4 hashes for \$1M', 'success')`, '/Temp/sell-hashes-for-money.js');
            }
        }
    }

    // Helper that gets the either invokes a function that returns a value, or returns the value as-is if it is not a function.
    const funcResultOrValue = fnOrVal => (fnOrVal instanceof Function ? fnOrVal() : fnOrVal);

    /** Returns true if the tool is running (including if it was already running), false if it could not be run.
     * @param {NS} ns
     * @param {Tool} tool */
    async function tryRunTool(ns, tool) {
        if (options['disable-script'].includes(tool.name)) { // Ensure the script hasn't been disabled
            if (verbose) log(ns, `Tool ${tool.name} was not launched as it was specified with --disable-script`);
            return false;
        }
        if (tool.shouldRun != null && !(await tool.shouldRun())) { // Check the script's own conditions for being run
            if (verbose) log(ns, `INFO: Tool ${tool.name} was not launched as its shouldRun() function returned false.`);
            return false;
        }
        if (!(await doesFileExist(ns, tool.name))) { // Ensure the script exists
            log(ns, `ERROR: Tool ${tool.name} was not found on ${daemonHost}`, true, 'error');
            return false;
        }
        let [runningOnServer, runningPid] = whichServerIsRunning(ns, tool.name, false);
        if (runningOnServer != null) { // Ensure the script isn't already running
            if (verbose) log(ns, `INFO: Tool ${tool.name} is already running on server ${runningOnServer} as pid ${runningPid}.`);
            return true;
        }
        // If all criteria pass, launch the script on home, or wherever we have space for it.
        const args = funcResultOrValue(tool.args) || []; // Support either a static args array, or a function returning the args.
        const lowHomeRam = homeServer.totalRam(true) < 32; // Special-case. In early BN1.1, when home RAM is <32 GB, allow certain scripts to be run on any host
        const runResult = lowHomeRam ?
            (await arbitraryExecution(ns, tool, 1, args, getServerByName(backupServerName).hasRoot() ? backupServerName : daemonHost)) :
            (await exec(ns, tool.name, daemonHost, tool.runOptions, ...args));
        if (runResult) {
            [runningOnServer, runningPid] = whichServerIsRunning(ns, tool.name, false);
            //if (verbose)
            log(ns, `INFO: Ran tool: ${tool.name} ` + (args.length > 0 ? `with args ${JSON.stringify(args)} ` : '') +
                (runningPid ? `on server ${runningOnServer} (pid ${runningPid}).` : 'but it shut down right away.'));
            if (tool.shouldTail == true && runningPid) {
                log(ns, `Tailing Tool: ${tool.name}` + (args.length > 0 ? ` with args ${JSON.stringify(args)}` : '') + ` on server ${runningOnServer} (pid ${runningPid})`);
                tail(ns, runningPid);
                //tool.shouldTail = false; // Avoid popping open additional tail windows in the future
            }
            return true;
        } else {
            const errHost = getServerByName(daemonHost);
            log(ns, `WARN: Tool could not be run on ${lowHomeRam ? "any host" : errHost} at this time (likely due to insufficient RAM. Requires: ${formatRam(tool.cost)} ` +
                (lowHomeRam ? '' : `FREE: ${formatRam(errHost.ramAvailable(/*ignoreReservedRam:*/true))})`) + `: ${tool.name} [${args}]`, false, lowHomeRam ? undefined : 'warning');
        }
        return false;
    }

    /** Wrapper for ns.exec which automatically retries if there is a failure.
     * @param {NS} ns
     * @param {string} script - Filename of script to execute.
     * @param {string?} hostname - Hostname of the target server on which to execute the script.
     * @param {number|RunOptions?} numThreadsOrOptions - Optional thread count or RunOptions. Default is { threads: 1, temporary: true }
     * @param {any} args - Additional arguments to pass into the new script that is being run. Note that if any arguments are being passed into the new script, then the third argument numThreads must be filled in with a value.
     * @returns — Returns the PID of a successfully started script, and 0 otherwise.
     * Workaround a current bitburner bug by yeilding briefly to the game after executing something. **/
    async function exec(ns, script, hostname = null, numThreadsOrOptions = null, ...args) {
        // Defaults
        hostname ??= daemonHost;
        numThreadsOrOptions ??= { threads: 1, temporary: true };
        let fnRunScript = () => ns.exec(script, hostname, numThreadsOrOptions, ...args);
        // Wrap the script execution in an auto-retry if it fails to start
        // It doesn't make sense to auto-retry hack tools, only add error handling to other scripts
        if (hackTools.some(h => h.name === script))
            return fnRunScript();
        // Otherwise, run with auto-retry to handle e.g. temporary ram issues
        let p;
        const pid = await autoRetry(ns, async () => {
            p = fnRunScript();
            return p;
        }, p => {
            if (p == 0) log(ns, `WARNING: pid = ${p} after trying to exec ${script} on ${hostname}. Trying again...`, false, "warning");
            return p !== 0;
        }, () => new Error(`Failed to exec ${script} on ${hostname}. ` +
            `This is likely due to having insufficient RAM.\nArgs were: [${args}]`),
            undefined, undefined, undefined, verbose, verbose);
        return pid; // Caller is responsible for handling errors if final pid returned is 0 (indicating failure)
    }

    /** @param {NS} ns
     * @param {Server} server
     * Execute an external script that roots a server, and wait for it to complete. **/
    async function doRoot(ns, server) {
        if (verbose) log(ns, `Rooting Server ${server.name}`);
        const pid = await exec(ns, getFilePath('/Tasks/crack-host.js'), daemonHost, { temporary: true }, server.name);
        await waitForProcessToComplete_Custom(ns, getHomeProcIsAlive(ns), pid);
        server.resetCaches(); // If rooted status was cached, we must now reset it
    }

    // Main targeting loop
    /** @param {NS} ns **/
    async function doTargetingLoop(ns) {
        log(ns, "doTargetingLoop");
        let loops = -1;
        //let isHelperListLaunched = false; // Uncomment this and related code to keep trying to start helpers
        do {
            loops++;
            if (loops > 0) await ns.sleep(loopInterval);
            try {
                let start = Date.now();
                psCache = {}; // Clear the cache of the process list we update once per loop
                await buildServerList(ns, true); // Check if any new servers have been purchased by the external host_manager process
                await updateCachedServerData(ns); // Update server data that only needs to be refreshed once per loop
                await updatePortCrackers(ns); // Check if any new port crackers have been purchased
                await getPlayerInfo(ns); // Force an update of _cachedPlayerInfo               
                if (!allHelpersRunning && loops % 60 == 0) // If we have not yet launched all helpers see if any are now ready to be run (launch may have been postponed while e.g. awaiting more home ram, or TIX API to be purchased)
                    allHelpersRunning = await runStartupScripts(ns);
                // Run some auxilliary processes that ease the ram burden of this daemon and add additional functionality (like managing hacknet or buying servers)
                await runPeriodicScripts(ns);
                if (stockMode) await updateStockPositions(ns); // In stock market manipulation mode, get our current position in all stocks, as it affects targetting order
                // For early players, change behaviour slightly
                const homeRam = homeServer.totalRam(true);
                let targetingOrder = await getAllServersByTargetOrder(homeRam); // Sort the targets in the order we should prioritize spending RAM on them

                if (!(4 in dictSourceFiles) && homeRam < 64) {
                    // Until the user buys the first home RAM upgrade, prioritize just one target, so that we see fast results.
                    if (homeRam == 8) // Note: getAllServersByTargetOrder should be sorting by 
                        maxTargets = maxPreppingAtMaxTargets = 1;
                    // Periodically provide a hint to buy more home RAM asap
                    if (loops % 600 == 0)
                        log(ns, `Reminder: Daemon.js can do a lot more if you have more Home RAM. Right now, you must buy this yourself.` +
                            `\n  Head to the "City", visit [alpha ent.] (or other Tech store), and purchase at least 64 GB as soon as possible!` +
                            `\n  Also be sure to purchase TOR and run "buy -a" from the terminal until you own all hack tools.`, true, 'info');
                }

                if (loops % 60 == 0) { // For more expensive updates, only do these every so often
                    // Pull additional data about servers that infrequently changes
                    await refreshDynamicServerData(ns);
                    // Occassionally print our current targetting order (todo, make this controllable with a flag or custom UI?)
                    if (verbose || loops % 600 == 0) {
                        const targetsLog = 'Targetting Order: (* = prepped, ✓ = hackable)\n  ' + targetingOrder.filter(s => s.shouldHack()).map(s =>
                            `${s.isPrepped() ? '*' : ' '} ${s.canHack() ? '✓' : 'X'}` +
                            ` Money: ${formatMoney(s.getMoney(), 4)} of ${formatMoney(s.getMaxMoney(), 4)} ` +
                            // In Hack Exp mode, show estimated hack exp earned per second, otherwise show money per RAM-second.
                            (xpOnly ? `Exp: ${formatNumberShort(s.getExpPerSecond(), 4)}/sec` : `(${formatMoney(s.getMoneyPerRamSecond(), 4)}/ram.sec),`) +
                            ` Sec: ${formatNumber(s.getSecurity(), 3)} of ${formatNumber(s.getMinSecurity(), 3)},` +
                            ` TTW: ${formatDuration(s.timeToWeaken())}, Hack: ${s.requiredHackLevel} - ${s.name}` +
                            // In stock mode, show any associated stock symbol and whether we have shares to dictate stock manipulation direction
                            (!stockMode || !serverStockSymbols[s.name] ? '' : ` Sym: ${serverStockSymbols[s.name]} Owned: ${serversWithOwnedStock.includes(s.name)} ` +
                                `Manip: ${shouldManipulateGrow[s.name] ? "grow" : shouldManipulateHack[s.name] ? "hack" : '(disabled)'}`))
                            .join('\n  ');
                        log(ns, targetsLog);
                        ns.write("/Temp/targets.txt", targetsLog, "w");
                    }
                }
                // Processed servers will be split into various lists for generating a summary at the end
                const n = (/**@returns{Server[]}*/() => []); // Trick to initialize new arrays with a strong type
                const prepping = n(), preppedButNotTargeting = n(), targeting = n(), notRooted = n(), cantHack = n(),
                    cantHackButPrepped = n(), cantHackButPrepping = n(), noMoney = n(), failed = n(), skipped = n();
                let lowestUnhackable = 99999;
                let maxPossibleTargets = targetingOrder.filter(s => s.shouldHack()).length;

                // Hack: We can get stuck and never improve if we don't try to prep at least one server to improve our future targeting options.
                // So get the first un-prepped server that is within our hacking level, and move it to the front of the list.
                let firstUnpreppedServerIndex = -1;
                for (let i = 0; i < targetingOrder.length; i++) {
                    const s = targetingOrder[i];
                    if (s.shouldHack() && s.canHack() && !s.isPrepped() && !(await s.isTargeting())) {
                        firstUnpreppedServerIndex = i; // Note: Can't use array.findIndex due to await.
                        break;
                    }
                }
                if (firstUnpreppedServerIndex !== -1 && !stockMode)
                    targetingOrder.unshift(targetingOrder.splice(firstUnpreppedServerIndex, 1)[0]);

                // If this gets set to true, the loop will continue (e.g. to gather information), but no more work will be scheduled
                let workCapped = false;
                // Function to assess whether we've hit some cap that should prevent us from scheduling any more work
                let isWorkCapped = () => workCapped = workCapped || failed.length > 0 // Scheduling fails when there's insufficient RAM. We've likely encountered a "soft cap" on ram utilization e.g. due to fragmentation
                    || getTotalNetworkUtilization() >= maxUtilization // "hard cap" on ram utilization, can be used to reserve ram or reduce the rate of encountering the "soft cap"
                    || targeting.length >= maxTargets // variable cap on the number of simultaneous targets
                    || (targeting.length + prepping.length) >= (maxTargets + maxPreppingAtMaxTargets); // Only allow a couple servers to be prepped in advance when at max-targets

                // check for servers that need to be rooted
                // simultaneously compare our current target to potential targets
                for (let i = 0; i < targetingOrder.length; i++) {
                    if ((Date.now() - start) >= maxLoopTime) { // To avoid lagging the game, completely break out of the loop if we start to run over
                        skipped.push(...targetingOrder.slice(i));
                        workCapped = true;
                        break;
                    }

                    const server = targetingOrder[i];
                    server.resetCaches(); // For each new loop, reset any cached properties
                    // Attempt to root any servers that are not yet rooted
                    if (!server.hasRoot() && server.canCrack())
                        await doRoot(ns, server);

                    // Check whether we can / should attempt any actions on this server
                    if (!server.shouldHack()) { // Ignore servers we own (bought servers / home / no money)
                        noMoney.push(server);
                    } else if (!server.hasRoot()) { // Can't do anything to servers we have not yet cracked
                        notRooted.push(server);
                    } else if (!server.canHack()) { // Note servers above our Hack skill. We can prep them a little if we have spare RAM at the end.
                        cantHack.push(server);
                        lowestUnhackable = Math.min(lowestUnhackable, server.requiredHackLevel);
                        // New logic allows for unhackable servers to be prepping. Keep tabs on how many we have of each
                        if (server.isPrepped())
                            cantHackButPrepped.push(server);
                        else if (await server.isPrepping())
                            cantHackButPrepping.push(server);
                    } else if (await server.isTargeting()) { // Note servers already being targeted from a prior loop
                        targeting.push(server); // TODO: Switch to continuously queing batches in the seconds leading up instead of far in advance with large delays
                    } else if (await server.isPrepping()) { // Note servers already being prepped from a prior loop
                        prepping.push(server);
                    } else if (isWorkCapped() || xpOnly) { // Various conditions for which we'll postpone any additional work on servers
                        if (xpOnly && (((nextXpCycleEnd[server.name] || 0) > start - 10000) || (await server.isXpFarming())))
                            targeting.push(server); // A server counts as "targeting" if in XP mode and its due to be farmed or was in the past 10 seconds
                        else
                            skipped.push(server);
                    } else if (!hackOnly && true == await prepServer(ns, server)) { // Returns true if prepping, false if prepping failed, null if prepped
                        if (server.previouslyPrepped)
                            log(ns, `WARNING ${server.prepRegressions++}: Server was prepped, but now at security: ${formatNumber(server.getSecurity())} ` +
                                `(min ${formatNumber(server.getMinSecurity())}) money: ${formatMoney(server.getMoney(), 3)} (max ${formatMoney(server.getMaxMoney(), 3)}). ` +
                                `Prior cycle: ${server.previousCycle}. ETA now (Hack ${playerHackSkill()}) is ${formatDuration(server.timeToWeaken())}`, true, 'warning');
                        prepping.push(server); // Perform weakening and initial growth until the server is "perfected" (unless in hack-only mode)
                    } else if (!hackOnly && !server.isPrepped()) { // If prepServer returned false or null. Check ourselves whether it is prepped
                        log(ns, 'Prep failed for "' + server.name + '" (RAM Utilization: ' + (getTotalNetworkUtilization() * 100).toFixed(2) + '%)');
                        failed.push(server);
                    } else if (targeting.length >= maxTargets) { // Hard cap on number of targets, changes with utilization
                        server.previouslyPrepped = true;
                        preppedButNotTargeting.push(server);
                    } else { // Otherwise, server is prepped at min security & max money and ready to target
                        let performanceSnapshot = optimizePerformanceMetrics(ns, server); // Adjust the percentage to steal for optimal scheduling
                        if (server.actualPercentageToSteal() === 0) { // Not enough RAM for even one hack thread of this next-best target.
                            failed.push(server);
                        } else if (true == await performScheduling(ns, server, performanceSnapshot)) { // once conditions are optimal, fire barrage after barrage of cycles in a schedule
                            targeting.push(server);
                        } else {
                            log(ns, 'Targeting failed for "' + server.name + '" (RAM Utilization: ' + (getTotalNetworkUtilization() * 100).toFixed(2) + '%)');
                            failed.push(server);
                        }
                    }

                    // Hack: Quickly ramp up our max-targets without waiting for the next loop if we are far below the low-utilization threshold
                    if (lowUtilizationIterations >= 5 && targeting.length == maxTargets && maxTargets < maxPossibleTargets) {
                        let network = getNetworkStats();
                        let utilizationPercent = network.totalUsedRam / network.totalMaxRam;
                        if (utilizationPercent < lowUtilizationThreshold / 2) {
                            maxTargets++;
                            log(ns, `Increased max targets to ${maxTargets} since utilization (${formatNumber(utilizationPercent * 100, 3)}%) ` +
                                `is less than ${lowUtilizationThreshold * 50}% after scheduling the first ${maxTargets - 1} targets.`);
                        }
                    }
                }

                // Mini-loop for servers that we can't hack yet, but might have access to soon, we can at least prep them.
                if (!isWorkCapped() && cantHack.length > 0 && !hackOnly && !xpOnly) {
                    // Prep in order of soonest to become available to us
                    cantHack.sort(function (a, b) {
                        const diff = a.requiredHackLevel - b.requiredHackLevel;
                        return diff != 0.0 ? diff : b.getMoneyPerRamSecond() - a.getMoneyPerRamSecond(); // Break ties by sorting by max-money
                    });
                    // Try to prep them all unless one of our capping rules are hit
                    // TODO: Something was not working right here (might be working now that prep code is fixed) so we can probably start prepping more than 1 server again.
                    for (let j = 0; j < 1 /*cantHack.length*/; j++) {
                        const server = cantHack[j];
                        if (isWorkCapped()) break;
                        if (cantHackButPrepped.includes(server) || cantHackButPrepping.includes(server))
                            continue;
                        const prepResult = await prepServer(ns, server);
                        if (prepResult == true) {
                            cantHackButPrepping.push(server);
                        } else if (prepResult == null) {
                            cantHackButPrepped.push(server);
                        } else {
                            log(ns, 'Pre-Prep failed for "' + server.name + '" with ' + server.requiredHackLevel +
                                ' hack requirement (RAM Utilization: ' + (getTotalNetworkUtilization() * 100).toFixed(2) + '%)');
                            failed.push(server);
                            break;
                        }
                    }
                }

                let network = getNetworkStats();
                let utilizationPercent = network.totalUsedRam / network.totalMaxRam;
                highUtilizationIterations = utilizationPercent >= maxUtilization ? highUtilizationIterations + 1 : 0;
                lowUtilizationIterations = utilizationPercent <= lowUtilizationThreshold ? lowUtilizationIterations + 1 : 0;

                // If we've been at low utilization for longer than the max hack cycle out of all our targets, we can add a target.
                // 
                // TODO: Make better use of RAM by prepping more targets. Try not scheduling batches way in advance with a sleep, but instead
                //       witholding batches until they're closer to when they need to be kicked off.
                //       We can add logic to kill lower priority tasks using RAM (such as share, and scripts targetting low priority targets)
                //       if necessary to free up ram for new high-priority target batches.
                let intervalsPerTargetCycle = targeting.length == 0 ? 120 :
                    Math.ceil((targeting.reduce((max, t) => Math.max(max, t.timeToWeaken()), 0) + cycleTimingDelay) / loopInterval);
                //log(ns, `intervalsPerTargetCycle: ${intervalsPerTargetCycle} lowUtilizationIterations: ${lowUtilizationIterations} loopInterval: ${loopInterval}`);
                if (lowUtilizationIterations > intervalsPerTargetCycle) {
                    // Increase max targets if to make use of additional RAM
                    let actionTaken = null;
                    if (skipped.length > 0 && maxTargets < maxPossibleTargets) {
                        maxTargets++;
                        actionTaken = `Increased max targets to ${maxTargets}`;
                    } else if (maxTargets >= maxPossibleTargets && recoveryThreadPadding < 10) {
                        // If we're already targetting every host and we have RAM to spare, increase the recovery padding 
                        // to speed up our recovering from misfires (at the cost of "wasted" ram on every batch)
                        recoveryThreadPadding = Math.min(10, recoveryThreadPadding * 1.5);
                        actionTaken = `Increased recovery thread padding to ${formatNumber(recoveryThreadPadding, 2, 1)}`;
                    }
                    if (actionTaken) {
                        log(ns, `${actionTaken} since utilization (${formatNumber(utilizationPercent * 100, 3)}%) has been quite low for ${lowUtilizationIterations} iterations.`);
                        lowUtilizationIterations = 0; // Reset the counter of low-utilization iterations
                    }
                } else if (highUtilizationIterations > 60) { // Decrease max-targets by 1 ram utilization is too high (prevents scheduling efficient cycles)
                    if (maxTargets > 1) {
                        maxTargets -= 1;
                        log(ns, `Decreased max targets to ${maxTargets} since utilization has been > ${formatNumber(maxUtilization * 100, 3)}% for 60 iterations and scheduling failed.`);
                    }
                    highUtilizationIterations = 0; // Reset the counter of high-utilization iterations
                }
                if (targeting.length - 1 > maxTargets) { // Ensure that after a restart, maxTargets start off with no less than 1 fewer max targets
                    maxTargets = targeting.length - 1;
                    log(ns, `Increased max targets to ${maxTargets} since we had previous scripts targetting ${targeting.length} servers at startup.`);
                }
                allTargetsPrepped = prepping.length == 0;

                // If there is still unspent utilization, we can use a chunk of it it to farm XP
                if (xpOnly) { // If all we want to do is gain hack XP
                    let time = await farmHackXp(ns, 1.00, verbose);
                    loopInterval = Math.min(1000, time || 1000); // Wake up earlier if we're almost done an XP cycle
                    // Take note of any new exp targets for our summary, since these those targets aren't tracked in this main loop
                    for (let server of Object.keys(nextXpCycleEnd).filter(n => nextXpCycleEnd[n] > start && skipped.some(s => s.name == n)).map(n => getServerByName(n))) {
                        targeting.push(server);
                        skipped.splice(skipped.findIndex(s => s.name == server.name), 1);
                    }
                } else if (!isWorkCapped() && lowUtilizationIterations > 10) {
                    let expectedRunTime = getBestXPFarmTarget().timeToHack();
                    let freeRamToUse = (expectedRunTime < loopInterval) ? // If expected runtime is fast, use as much RAM as we want, it'll all be free by our next loop.
                        1 - (1 - lowUtilizationThreshold) / (1 - utilizationPercent) : // Take us just up to the threshold for 'lowUtilization' so we don't cause unecessary server purchases
                        1 - (1 - maxUtilizationPreppingAboveHackLevel - 0.05) / (1 - utilizationPercent); // Otherwise, leave more room (e.g. for scheduling new batches.)
                    await farmHackXp(ns, freeRamToUse, verbose && (expectedRunTime > 10000 || lowUtilizationIterations % 10 == 0), 1);
                }

                // Use any unspent RAM on share if we are currently working for a faction
                const maxShareUtilization = options['share-max-utilization']
                if (failed.length <= 0 && utilizationPercent < maxShareUtilization && // Only share RAM if we have succeeded in all hack cycle scheduling and have RAM to space
                    (Date.now() - lastShareTime) > options['share-cooldown'] && // Respect the share rate-limit if configured to leave gaps for scheduling
                    options['share'] !== false && options['no-share'] !== true &&
                    (options['share'] === true || network.totalMaxRam > 1024)) // If not explicitly enabled or disabled, auto-enable share at 1TB of network RAM
                {
                    let shareTool = getTool("share");
                    let maxThreads = shareTool.getMaxThreads(); // This many threads would use up 100% of the (1-utilizationPercent)% RAM remaining
                    if (xpOnly) maxThreads -= Math.floor(getServerByName('home').ramAvailable() / shareTool.cost); // Reserve home ram entirely for XP cycles when in xpOnly mode
                    network = getNetworkStats(); // Update network stats since they may have changed after scheduling xp cycles above
                    utilizationPercent = network.totalUsedRam / network.totalMaxRam;
                    let shareThreads = Math.floor(maxThreads * (maxShareUtilization - utilizationPercent) / (1 - utilizationPercent)); // Ensure we don't take utilization above (1-maxShareUtilization)%
                    if (shareThreads > 0) {
                        if (verbose) log(ns, `Creating ${shareThreads.toLocaleString('en')} share threads to improve faction rep gain rates. Using ${formatRam(shareThreads * 4)} of ${formatRam(network.totalMaxRam)} ` +
                                         `(${(400 * shareThreads / network.totalMaxRam).toFixed(1)}%) of all RAM). Final utilization will be ${(100 * (4 * shareThreads + network.totalUsedRam) / network.totalMaxRam).toFixed(1)}%`);
                        await arbitraryExecution(ns, getTool('share'), shareThreads, [Date.now()], null, true) // Note: Need a unique argument to facilitate multiple parallel share scripts on the same server
                        lastShareTime = Date.now();
                    }
                } //else log(ns, `Not Sharing. workCapped: ${isWorkCapped()} utilizationPercent: ${utilizationPercent} maxShareUtilization: ${maxShareUtilization} cooldown: ${formatDuration(Date.now() - lastShareTime)} networkRam: ${network.totalMaxRam}`);

                // Log some status updates
                let keyUpdates = `Of ${allHostNames.length} total servers:\n > ${noMoney.length} were ignored (owned or no money)`;
                if (notRooted.length > 0 || ownedCracks.length < 5)
                    keyUpdates += `, ${notRooted.length} are not rooted (missing ${crackNames.filter(c => !ownedCracks.includes(c)).join(', ')})`;
                if (cantHack.length > 0)
                    keyUpdates += `\n > ${cantHack.length} cannot be hacked (${cantHackButPrepping.length} prepping, ` +
                        `${cantHackButPrepped.length} prepped, next unlock at Hack ${lowestUnhackable})`;
                if (preppedButNotTargeting.length > 0)
                    keyUpdates += `\n > ${preppedButNotTargeting.length} are prepped but are not a priority target`;
                if (skipped.length > 0)
                    keyUpdates += `\n > ${skipped.length} were skipped for now (time, RAM, or target + prepping cap reached)`;
                if (failed.length > 0)
                    keyUpdates += `\n > ${failed.length} servers failed to be scheduled (insufficient RAM?).`;
                keyUpdates += `\n > Targeting: ${targeting.length} servers, Prepping: ${prepping.length + cantHackButPrepping.length}`;
                if (xpOnly)
                    keyUpdates += targeting.length > 0 ? `\n > Grinding XP from ${targeting.map(s => s.name).join(", ")}` :
                        prepping.length > 0 ? `\n > Prepping to grind XP from ${prepping.map(s => s.name).join(", ")}` :
                            '\nERROR: In --xp-mode, but doing nothing!';
                // To reduce log spam, only log if some key status changes, or if it's been a minute
                if (keyUpdates != lastUpdate || (Date.now() - lastUpdateTime) > 60000) {
                    log(ns, (lastUpdate = keyUpdates) +
                        '\n > RAM Utilization: ' + formatRam(Math.ceil(network.totalUsedRam)) + ' of ' + formatRam(network.totalMaxRam) + ' (' + (utilizationPercent * 100).toFixed(1) + '%) ' +
                        `for ${lowUtilizationIterations || highUtilizationIterations} its, Max Targets: ${maxTargets}, Loop Took: ${Date.now() - start}ms`);
                    lastUpdateTime = Date.now();
                }
                //log(ns, 'Prepping: ' + prepping.map(s => s.name).join(', '))
                //log(ns, 'targeting: ' + targeting.map(s => s.name).join(', '))
            } catch (err) {
                // Sometimes a script is shut down by throwing an object containing internal game script info. Detect this and exit silently
                if (err?.env?.stopFlag) return;
                log(ns, `WARNING: daemon.js Caught an error in the targeting loop: ${getErrorInfo(err)}`, true, 'warning');
                continue;
            }
        } while (!runOnce);
    }

    // How much a weaken thread is expected to reduce security by
    let actualWeakenPotency = () => bitNodeMults.ServerWeakenRate * weakenThreadPotency;

    // Get a dictionary from retrieving the same infromation for every server name
    async function getServersDict(ns, command) {
        return await getNsDataThroughFile(ns, `Object.fromEntries(ns.args.map(server => [server, ns.${command}(server)]))`,
            `/Temp/${command}-all.txt`, allHostNames);
    }

    let dictInitialServerInfos = (/**@returns{{[serverName: string]: globalThis.Server;}}*/() => undefined)();
    let dictServerRequiredHackinglevels = (/**@returns{{[serverName: string]: number;}}*/() => undefined)();
    let dictServerNumPortsRequired = (/**@returns{{[serverName: string]: number;}}*/() => undefined)();
    let dictServerMinSecurityLevels = (/**@returns{{[serverName: string]: number;}}*/() => undefined)();
    let dictServerMaxMoney = (/**@returns{{[serverName: string]: number;}}*/() => undefined)();
    let dictServerMaxRam = (/**@returns{{[serverName: string]: number;}}*/() => undefined)();
    let dictServerProfitInfo = (/**@returns{{[serverName: string]: {gainRate: number, expRate: number}}}*/() => undefined)();
    let dictServerGrowths = (/**@returns{{[serverName: string]: number;}}*/() => undefined)();

    /** Gathers up arrays of server data via external request to have the data written to disk.
     * This data should only need to be gathered once per run, as it never changes
     * @param {NS} ns */
    async function getStaticServerData(ns) {
        if (verbose) log(ns, `getStaticServerData: ${allHostNames}`);
        dictServerRequiredHackinglevels = await getServersDict(ns, 'getServerRequiredHackingLevel');
        dictServerNumPortsRequired = await getServersDict(ns, 'getServerNumPortsRequired');
        dictServerGrowths = await getServersDict(ns, 'getServerGrowth');
        // The "GetServer" object result is used with the formulas API (due to type checking that the parameter is a valid "server" instance)
        // TODO: There is now a "ns.formulas.mockServer()" function that we can switch to
        dictInitialServerInfos = await getServersDict(ns, 'getServer');
        // Also immediately retrieve the data which is occasionally updated
        await updateCachedServerData(ns);
        await refreshDynamicServerData(ns);
    }

    /** Refresh information about servers that should be updated once per loop, but doesn't need to be up-to-the-second.
     * @param {NS} ns */
    async function updateCachedServerData(ns) {
        //if (verbose) log(ns, `updateCachedServerData`);
        dictServerMaxRam = await getServersDict(ns, 'getServerMaxRam');
    }

    /** Refresh data that might change rarely over time, but for which having precice up-to-the-minute information isn't critical.
     * @param {NS} ns */
    async function refreshDynamicServerData(ns) {
        if (verbose) log(ns, `refreshDynamicServerData: ${allHostNames}`);
        // Min Security / Max Money can be affected by Hashnet purchases, so we should update this occasionally
        dictServerMinSecurityLevels = await getServersDict(ns, 'getServerMinSecurityLevel');
        dictServerMaxMoney = await getServersDict(ns, 'getServerMaxMoney');
        // Get the information about the relative profitability of each server (affects targetting order)
        const pid = await exec(ns, getFilePath('analyze-hack.js'), null, null, '--all', '--silent');
        await waitForProcessToComplete_Custom(ns, getHomeProcIsAlive(ns), pid);
        const analyzeHackResult = dictServerProfitInfo = ns.read('/Temp/analyze-hack.txt');
        if (!analyzeHackResult)
            log(ns, "WARNING: analyze-hack info unavailable. Will use fallback approach.");
        else
            dictServerProfitInfo = Object.fromEntries(JSON.parse(analyzeHackResult).map(s => [s.hostname, s]));
        // Double home reserved ram once we reach the configured threshold
        if (homeServer && homeServer.totalRam(true) >= options['double-reserve-threshold'])
            homeReservedRam = 2 * options['reserved-ram'];

        // Hack: Below concerns aren't related to "server data", but are things we also wish to refresh just once in a while
        // Determine whether we have purchased stock API accesses yet (affects reserving and attempts to manipulate stock markets)
        haveTixApi = haveTixApi || await getNsDataThroughFile(ns, `ns.stock.hasTIXAPIAccess()`);
        have4sApi = have4sApi || await getNsDataThroughFile(ns, `ns.stock.has4SDataTIXAPI()`);
        // If required, determine the current terminal server (used when intelligence farming)
        if (options.i)
            currentTerminalServer = getServerByName(await getNsDataThroughFile(ns, 'ns.singularity.getCurrentServer()'));
        // Check whether we've purchased access to the formulas API ("formulas.exe")
        hasFormulas = await doesFileExist(ns, "Formulas.exe")
        // Update our cache of income / expenses by category
        moneySources = await getNsDataThroughFile(ns, 'ns.getMoneySources()');
    }

    class Server {
        /** @param {NS} ns
         * @param {string} node - a.k.a host / server **/
        constructor(ns, node) {
            this.ns = ns; // TODO: This might get us in trouble
            this.name = node;
            this.server = dictInitialServerInfos[node];
            this.requiredHackLevel = dictServerRequiredHackinglevels[node];
            this.portsRequired = dictServerNumPortsRequired[node];
            this.serverGrowth = dictServerGrowths[node];
            this.percentageToSteal = 1.0 / 16.0; // This will get tweaked automatically based on RAM available and the relative value of this server
            this.previouslyPrepped = false;
            this.prepRegressions = 0;
            this.previousCycle = null;
            this._isPrepped = null;
            this._isPrepping = null;
            this._isTargeting = null;
            this._isXpFarming = null;
            this._percentStolenPerHackThread = null;
            this._hasRootCached = null; // Once we get root, we never lose it, so we can stop asking
            this._files = (/**@returns{Set<string>}*/() => null)(); // Unfortunately, can't cache this forever because a "kill-all-scripts.js" or "cleanup.js" run will wipe them.
        }
        resetCaches() {
            // Reset any caches that can change over time
            this._isPrepped = this._isPrepping = this._isTargeting = this._isXpFarming =
                this._percentStolenPerHackThread = this._files = null;
            // Once true - Does not need to be reset, because once rooted, this fact will never change
            if (this._hasRootCached == false) this._hasRootCached = null;
        }
        getMinSecurity() { return dictServerMinSecurityLevels[this.name] ?? 0; } // Servers not in our dictionary were purchased, and so undefined is okay
        getMaxMoney() { return dictServerMaxMoney[this.name] ?? 0; }
        getMoneyPerRamSecond() { return dictServerProfitInfo ? dictServerProfitInfo[this.name]?.gainRate ?? 0 : (dictServerMaxMoney[this.name] ?? 0); }
        getExpPerSecond() { return dictServerProfitInfo ? dictServerProfitInfo[this.name]?.expRate ?? 0 : (1 / dictServerMinSecurityLevels[this.name] ?? 0); }
        getMoney() { return this.ns.getServerMoneyAvailable(this.name); }
        getSecurity() { return this.ns.getServerSecurityLevel(this.name); }
        canCrack() { return ownedCracks.length >= this.portsRequired; }
        canHack() { return this.requiredHackLevel <= playerHackSkill(); }
        shouldHack() {
            return this.getMaxMoney() > 0 && this.name !== "home" && !this.name.startsWith('hacknet-server-') && !this.name.startsWith('hacknet-node-') &&
                !this.name.startsWith(purchasedServersName); // Hack, but beats wasting 2.25 GB on ns.getPurchasedServers()
        }
        // "Prepped" means current security is at the minimum, and current money is at the maximum
        isPrepped() {
            if (this._isPrepped != null) return this._isPrepped;
            let currentSecurity = this.getSecurity();
            let currentMoney = this.getMoney();
            // Logic for whether we consider the server "prepped" (tolerate a 1% discrepancy)
            this._isPrepped = (currentSecurity == 0 || ((this.getMinSecurity() / currentSecurity) >= 0.99)) &&
                (this.getMaxMoney() != 0 && ((currentMoney / this.getMaxMoney()) >= 0.99) || stockFocus /* Only prep security in stock-focus mode */);
            return this._isPrepped;
        }
        /** Does this server have a copy of this file on it last we checked?
         * @param {string} fileName */
        async hasFile(fileName) {
            this._files ??= new Set(await getNsDataThroughFile(ns, 'ns.ls(ns.args[0])', null, [this.name]));
            // The game does not start folder names with a slash, we have to remove this before searching the ls result
            if (fileName.startsWith('/')) fileName = fileName.substring(1);
            return this._files.has(fileName);
        }
        // Function to tell if the sever is running any tools, with optional filtering criteria on the tool being run
        async isSubjectOfRunningScript(filter, useCache = true, count = false) {
            let total = 0;
            for (const hostname of allHostNames) // For each server that could be running scripts (TODO: Maintain a smaller list of only servers with more than 1.6GB RAM)
                for (const process of processList(this.ns, hostname, useCache)) // For all scripts on the server
                    // Does the script's arguments suggest it is targetting this server and matches the filter criteria?
                    if (process.args.length > 0 && process.args[0] == this.name && (!filter || filter(process))) {
                        if (count)
                            total++;
                        else
                            return true;
                    }
            return count ? total : false;
        }
        async isPrepping(useCache = true) {
            this._isPrepping ??= await this.isSubjectOfRunningScript(process => process.args.length > 3 && process.args[3] == "prep", useCache);
            return this._isPrepping;
        }
        async isTargeting(useCache = true) {
            this._isTargeting ??= await this.isSubjectOfRunningScript(process => process.args.length > 3 && process.args[3].startsWith('Batch'), useCache);
            return this._isTargeting;
        }
        async isXpFarming(useCache = true) {
            this._isXpFarming ??= await this.isSubjectOfRunningScript(process => process.args.length > 3 &&
                (['FarmXP', 'weakenForXp', 'growForXp'].includes(process.args[3])), useCache);
            return this._isXpFarming;
        }
        serverGrowthPercentage() {
            return this.serverGrowth * bitNodeMults.ServerGrowthRate * getPlayerHackingGrowMulti() / 100;
        }
        adjustedGrowthRate() {
            return Math.min(maxGrowthRate, 1 + ((unadjustedGrowthRate - 1) / this.getMinSecurity()));
        }
        actualServerGrowthRate() {
            return Math.pow(this.adjustedGrowthRate(), this.serverGrowthPercentage());
        }
        // this is the target growth coefficient *immediately*
        targetGrowthCoefficient() {
            return this.getMaxMoney() / Math.max(this.getMoney(), 1);
        }
        // this is the target growth coefficient per cycle, based on theft
        targetGrowthCoefficientAfterTheft() {
            return 1 / (1 - (this.getHackThreadsNeeded() * this.percentageStolenPerHackThread()));
        }
        cyclesNeededForGrowthCoefficient() {
            return Math.log(this.targetGrowthCoefficient()) / Math.log(this.adjustedGrowthRate());
        }
        cyclesNeededForGrowthCoefficientAfterTheft() {
            return Math.log(this.targetGrowthCoefficientAfterTheft()) / Math.log(this.adjustedGrowthRate());
        }
        percentageStolenPerHackThread() {
            // Value is cached until the next call to resetCaches()
            if (this._percentStolenPerHackThread !== null) return this._percentStolenPerHackThread;
            // All calculations assume the server will be weakened to minimum security
            const hackDifficulty = this.getMinSecurity();
            if (hackDifficulty > 100) return 0; // Shouldn't happen, but cannot hack servers whose minimum security is over 100
            // Use the formulas API if we have access, to ensure the answer is accurate
            if (hasFormulas) {
                try {
                    // Mock the properties required to determine the hackPercent at minimum security
                    this.server.hackDifficulty = hackDifficulty;
                    this.server.requiredHackingSkill = this.requiredHackLevel;
                    return this._percentStolenPerHackThread =
                        this.ns.formulas.hacking.hackPercent(this.server, _cachedPlayerInfo);
                } catch {
                    hasFormulas = false;
                }
            }
            // Taken from https://github.com/bitburner-official/bitburner-src/blob/dev/src/Hacking.ts#L43 (calculatePercentMoneyHacked)
            const hackLevel = playerHackSkill();
            const difficultyMult = (100 - hackDifficulty) / 100;
            const skillMult = (hackLevel - (this.requiredHackLevel - 1)) / hackLevel;
            const percentMoneyHacked = (difficultyMult * skillMult * _cachedPlayerInfo.mults.hacking_money * bitNodeMults.ScriptHackMoney) / 240;
            return this._percentStolenPerHackThread = Math.min(1, Math.max(0, percentMoneyHacked));
        }
        actualPercentageToSteal() {
            return this.getHackThreadsNeeded() * this.percentageStolenPerHackThread();
        }
        getHackThreadsNeeded() {
            // Force rounding of low-precision digits before taking the floor, to avoid double imprecision throwing us way off.
            return Math.floor((this.percentageToSteal / this.percentageStolenPerHackThread()).toPrecision(14));
        }
        getGrowThreadsNeeded() {
            return Math.max(0, Math.ceil(Math.min(this.getMaxMoney(),
                // TODO: Not true! Worst case is 1$ per thread and *then* it multiplies. We can return a much lower number here.
                this.cyclesNeededForGrowthCoefficient() / this.serverGrowthPercentage()).toPrecision(14)));
        }
        getWeakenThreadsNeeded() {
            return Math.max(0, Math.ceil(((this.getSecurity() - this.getMinSecurity()) / actualWeakenPotency()).toPrecision(14)));
        }
        getGrowThreadsNeededAfterTheft() {
            // Note: If recovery thread padding > 1.0, require a minimum of 2 recovery threads, no matter how scaled stats are
            return Math.max(recoveryThreadPadding > 1 ? 2 : 1, Math.ceil(Math.min(this.getMaxMoney(),
                this.cyclesNeededForGrowthCoefficientAfterTheft() / this.serverGrowthPercentage() * recoveryThreadPadding).toPrecision(14)));
        }
        getWeakenThreadsNeededAfterTheft() {
            // Note: If recovery thread padding > 1.0, require a minimum of 2 recovery threads, no matter how scaled stats are
            return Math.max(recoveryThreadPadding > 1 ? 2 : 1, Math.ceil((this.getHackThreadsNeeded() * hackThreadHardening / actualWeakenPotency() * recoveryThreadPadding).toPrecision(14)));
        }
        getWeakenThreadsNeededAfterGrowth() {
            // Note: If recovery thread padding > 1.0, require a minimum of 2 recovery threads, no matter how scaled stats are
            return Math.max(recoveryThreadPadding > 1 ? 2 : 1, Math.ceil((this.getGrowThreadsNeededAfterTheft() * growthThreadHardening / actualWeakenPotency() * recoveryThreadPadding).toPrecision(14)));
        }
        hasRoot() { return this._hasRootCached ??= this.ns.hasRootAccess(this.name); }
        isHost() { return this.name == daemonHost; }
        totalRam(ignoreReservedRam = false) {
            let maxRam = dictServerMaxRam[this.name]; // Use a cached max ram amount to save time.
            if (maxRam == null) throw new Error(`Dictionary of servers' max ram was missing information for ${this.name}`);
            // Complete HACK: but for most planning purposes, we want to pretend home has less ram to leave room for temp scripts to run
            if (!ignoreReservedRam && (this.name == "home" ||
                (this.name == backupServerName && dictServerMaxRam["home"] <= 16))) // Double-hack: When home RAM sucks (start of BN 1.1) reserve a server for helpers.
                maxRam = Math.max(0, maxRam - homeReservedRam);
            return maxRam;
        }
        usedRam() { return this.ns.getServerUsedRam(this.name); }
        ramAvailable(ignoreReservedRam = false) { return this.totalRam(ignoreReservedRam) - this.usedRam(); }
        growDelay() { return this.timeToWeaken() - this.timeToGrow() + cycleTimingDelay; }
        hackDelay() { return this.timeToWeaken() - this.timeToHack(); }
        timeToWeaken() { return this.ns.getWeakenTime(this.name); }
        timeToGrow() { return this.ns.getGrowTime(this.name); }
        timeToHack() { return this.ns.getHackTime(this.name); }
    }

    // Helpers to get slices of info / cumulative stats across all rooted servers
    function getNetworkStats() {
        const rootedServers = getAllServers().filter(server => server.hasRoot());
        const listOfServersFreeRam = rootedServers.map(s => s.ramAvailable()).filter(ram => ram > 1.6); // Servers that can't run a script don't count
        const totalMaxRam = rootedServers.map(s => s.totalRam()).reduce((a, b) => a + b, 0);
        const totalFreeRam = Math.max(0, listOfServersFreeRam.reduce((a, b) => a + b, 0)); // Hack, free ram can be negative due to "pretending" reserved home ram doesn't exist. Clip to 0
        return {
            listOfServersFreeRam: listOfServersFreeRam,
            totalMaxRam: totalMaxRam,
            totalFreeRam: totalFreeRam,
            totalUsedRam: totalMaxRam - totalFreeRam,
            // The money we could make if we took 100% from every currently hackable server, to help us guage how relatively profitable each server is
            //totalMaxMoney: rootedServers.filter(s => s.canHack() && s.shouldHack()).map(s => s.getMaxMoney()).reduce((a, b) => a + b, 0)
        };
    }
    // Simpler function to get current total percentage of ram used across the network
    function getTotalNetworkUtilization() {
        const utilizationStats = getNetworkStats();
        return utilizationStats.totalUsedRam / utilizationStats.totalMaxRam;
    }

    /** return a "performance snapshot" (Ram required for the cycle) to compare against optimal, or another snapshot
     * TODO: Better gauge of performance might be money stolen per (RAM * time) cost
     * @param {} currentTarget
     * @param {{ listOfServersFreeRam: number[]; totalMaxRam: number; totalFreeRam: number; totalUsedRam: number; }} networkStats */
    function getPerformanceSnapshot(currentTarget, networkStats) {
        // The total RAM cost of running one weaken/hack/grow cycle to steal `currentTarget.percentageToSteal` of `currentTarget.money`
        const weaken1Cost = currentTarget.getWeakenThreadsNeededAfterTheft() * getTool("weak").cost;
        const weaken2Cost = currentTarget.getWeakenThreadsNeededAfterGrowth() * getTool("weak").cost;
        const growCost = currentTarget.getGrowThreadsNeededAfterTheft() * getTool("grow").cost;
        const hackCost = currentTarget.getHackThreadsNeeded() * getTool("hack").cost;
        // Simulate how many times we could schedule this batch given current server ram availability
        // (and hope that whatever executes the tasks in this batch is clever enough to slot them in as such (TODO: simulate using our actual executor logic?)
        const jobs = [weaken1Cost, weaken2Cost, growCost, hackCost].sort((a, b) => b - a); // Sort jobs largest to smallest
        const simulatedRemainingRam = networkStats.listOfServersFreeRam.slice()
            // Scheduler would sort servers by largest to smallest before slotting jobs
            // Technically, we should re-sort after each simulated job, but for performance (and because this is an estimate), don't bother.
            .sort((a, b) => b - a);
        let maxScheduled = -1;
        let canScheduleAnother = true;
        while (canScheduleAnother && maxScheduled++ <= maxBatches) {
            for (const job of jobs) {
                // Find a free slot for this job, starting with largest servers as the scheduler tends to do
                const freeSlot = simulatedRemainingRam/*.sort((a, b) => b - a)*/.findIndex(ram => ram >= job);
                if (freeSlot === -1)
                    canScheduleAnother = false;
                else
                    simulatedRemainingRam[freeSlot] -= job;
            }
        }
        return {
            percentageToSteal: currentTarget.actualPercentageToSteal(),
            canBeScheduled: maxScheduled > 0,
            // Given our timing delay, **approximately** how many cycles can we initiate before the first batch's first task fires?
            // TODO: Do a better job of calculating this *outside* of the performance snapshot, and only calculate it once.
            optimalPacedCycles: Math.min(maxBatches, Math.max(1, Math.floor(((currentTarget.timeToWeaken()) / cycleTimingDelay).toPrecision(14))
                - 1)), // Fudge factor, this isnt an exact science
            // Given RAM availability, how many cycles could we schedule across all hosts?
            maxCompleteCycles: Math.max(maxScheduled - 1, 1) // Fudge factor. The executor isn't perfect
        };
    }

    // Produce a summary string containing information about a hack batch for a given target configuration
    let getTargetSummary = currentTarget =>
        `(H:${currentTarget.getHackThreadsNeeded()} W:${currentTarget.getWeakenThreadsNeededAfterTheft()} ` +
        `G:${currentTarget.getGrowThreadsNeededAfterTheft()} W²:${currentTarget.getWeakenThreadsNeededAfterGrowth()}) ` +
        (stockMode && shouldManipulateGrow[currentTarget.name] ? 'with grow stock ' : stockMode && shouldManipulateHack[currentTarget.name] ? 'with hack stock ' : '') +
        `to steal ${formatNumber(currentTarget.actualPercentageToSteal() * 100)}% ` +
        `(${formatMoney(currentTarget.actualPercentageToSteal() * currentTarget.getMaxMoney(), 3, 1)}) ` +
        `ETA: ${formatDuration(currentTarget.timeToWeaken())} at Hack ${playerHackSkill()} (${currentTarget.name})`;

    // Adjusts the "percentage to steal" for a target based on its respective cost and the current network RAM available
    function optimizePerformanceMetrics(ns, currentTarget) {
        const maxAdjustments = 1000;
        const start = Date.now();
        const networkStats = getNetworkStats();
        const percentPerHackThread = currentTarget.percentageStolenPerHackThread();
        const oldHackThreads = currentTarget.getHackThreadsNeeded();
        const oldActualPercentageToSteal = currentTarget.percentageToSteal = currentTarget.actualPercentageToSteal();

        if (percentPerHackThread >= 1) {
            currentTarget.percentageToSteal = percentPerHackThread;
            currentTarget.percentageToSteal = 1;
            return getPerformanceSnapshot(currentTarget, networkStats);
        }

        let lastAdjustmentSign = 1;
        let attempts = 0;
        let increment = Math.ceil((0.01 / percentPerHackThread).toPrecision(14)); // Initialize the adjustment increment to be the number of hack threads to steal roughly 1%
        let newHackThreads = oldHackThreads;
        let performanceSnapshot = null;
        currentTarget.percentageToSteal = Math.max(currentTarget.percentageToSteal, percentPerHackThread); // If the initial % to steal is below the minimum, raise it
        // Make adjustments to the number of hack threads until we zero in on the best amount
        while (++attempts < maxAdjustments) {
            performanceSnapshot = getPerformanceSnapshot(currentTarget, networkStats);
            const adjustment = analyzeSnapshot(ns, performanceSnapshot, currentTarget, networkStats, increment);
            if (runOnce && verbose)
                log(ns, `Adjustment ${attempts} (increment ${increment}): ${adjustment} to ${newHackThreads} hack threads ` +
                    `(from ${formatNumber(currentTarget.actualPercentageToSteal() * 100)}% or ${currentTarget.getHackThreadsNeeded()} hack threads)`);
            if (adjustment === 0.00 && increment == 1) break; // We've zeroed in on the exact number of hack threads we want
            if (adjustment === 0.00 || Math.sign(adjustment) != lastAdjustmentSign) { // Each time we change the direction of adjustments, slow the adjustment rate
                increment = Math.max(1, Math.floor((increment / 2.0).toPrecision(14)));
                lastAdjustmentSign = adjustment === 0.00 ? lastAdjustmentSign : Math.sign(adjustment);
            }
            newHackThreads = Math.max(newHackThreads + adjustment, 0); // Adjust the percentage to steal with pefect precision by actually adjusting the number of hack threads
            currentTarget.percentageToSteal = Math.max(0, newHackThreads * percentPerHackThread);
        }
        if (attempts >= maxAdjustments || verbose && currentTarget.actualPercentageToSteal() != oldActualPercentageToSteal) {
            log(ns, `Tuned % to steal from ${formatNumber(oldActualPercentageToSteal * 100)}% (${oldHackThreads} threads) to ` +
                `${formatNumber(currentTarget.actualPercentageToSteal() * 100)}% (${currentTarget.getHackThreadsNeeded()} threads) ` +
                `(${currentTarget.name}) Iterations: ${attempts} Took: ${Date.now() - start} ms`);
        }
        if (verbose && currentTarget.actualPercentageToSteal() == 0) {
            currentTarget.percentageToSteal = percentPerHackThread;
            log(ns, `Insufficient RAM for min cycle: ${getTargetSummary(currentTarget)}`);
            currentTarget.percentageToSteal = 0.0;
        }
        if (currentTarget.percentageToSteal != 0 && (currentTarget.actualPercentageToSteal() == 0 ||
            Math.abs(currentTarget.actualPercentageToSteal() - currentTarget.percentageToSteal) / currentTarget.percentageToSteal > 0.5))
            log(ns, `WARNING: Big difference between %ToSteal (${formatNumber(currentTarget.percentageToSteal * 100)}%) ` +
                `and actual%ToSteal (${formatNumber(currentTarget.actualPercentageToSteal() * 100)}%) after ${attempts} attempts. ` +
                `Min is: ${formatNumber(currentTarget.percentageStolenPerHackThread() * 100)}%`, false, 'warning');
        return performanceSnapshot;
    }

    // Suggests an adjustment to the percentage to steal based on how much ram would be consumed if attempting the current percentage.
    function analyzeSnapshot(ns, snapshot, currentTarget, networkStats, incrementalHackThreads) {
        const maxPercentageToSteal = options['max-steal-percentage'];
        const lastP2steal = currentTarget.percentageToSteal;
        // Priority is to use as close to the target ram as possible overshooting.
        const isOvershot = s => !s.canBeScheduled || s.maxCompleteCycles < s.optimalPacedCycles;
        if (verbose && runOnce)
            log(ns, `canBeScheduled: ${snapshot.canBeScheduled},  maxCompleteCycles: ${snapshot.maxCompleteCycles}, optimalPacedCycles: ${snapshot.optimalPacedCycles}`);
        if (isOvershot(snapshot)) {
            return -incrementalHackThreads;
        } else if (snapshot.maxCompleteCycles > snapshot.optimalPacedCycles && lastP2steal < maxPercentageToSteal) {
            // Test increasing by the increment, but if it causes us to go over maximum desired utilization, do not suggest it
            currentTarget.percentageToSteal = (currentTarget.getHackThreadsNeeded() + incrementalHackThreads) * currentTarget.percentageStolenPerHackThread();
            const comparisonSnapshot = getPerformanceSnapshot(currentTarget, networkStats);
            currentTarget.percentageToSteal = lastP2steal;
            return isOvershot(comparisonSnapshot) ? 0.00 : incrementalHackThreads;
        }
        return 0.00;
    }

    /** @param {NS} ns **/
    async function performScheduling(ns, currentTarget, snapshot) {
        const start = Date.now();
        const scheduledTasks = [];
        const maxCycles = Math.min(snapshot.optimalPacedCycles, snapshot.maxCompleteCycles);
        if (!snapshot) return;
        if (maxCycles === 0)
            return log(ns, `WARNING: Attempt to schedule ${getTargetSummary(currentTarget)} returned 0 max cycles? ${JSON.stringify(snapshot)}`, false, 'warning');
        if (currentTarget.getHackThreadsNeeded() === 0)
            return log(ns, `WARNING: Attempted to schedule empty cycle ${maxCycles} x ${getTargetSummary(currentTarget)}? ${JSON.stringify(snapshot)}`, false, 'warning');
        let firstEnding = null, lastStart = null, lastBatch = 0, cyclesScheduled = 0;
        while (cyclesScheduled < maxCycles) {
            const newBatchStart = new Date((cyclesScheduled === 0) ? Date.now() + queueDelay : lastBatch.getTime() + cycleTimingDelay);
            lastBatch = new Date(newBatchStart.getTime());
            const batchTiming = getScheduleTiming(newBatchStart, currentTarget);
            if (verbose && runOnce) logSchedule(ns, batchTiming, currentTarget); // Special log for troubleshooting batches
            const newBatch = getScheduleObject(ns, batchTiming, currentTarget, scheduledTasks.length);
            if (firstEnding === null) { // Can't start anything after this first hack completes (until back at min security), or we risk throwing off timing
                firstEnding = new Date(newBatch.hackEnd.valueOf());
            }
            if (lastStart === null || lastStart < newBatch.firstFire) {
                lastStart = new Date(newBatch.lastFire.valueOf());
            }
            if (cyclesScheduled > 0 && lastStart >= firstEnding) {
                if (verbose) log(ns, `Had to stop scheduling at ${cyclesScheduled} of ${maxCycles} desired cycles (lastStart: ${lastStart} >= firstEnding: ${firstEnding}) ${JSON.stringify(snapshot)}`);
                break;
            }
            scheduledTasks.push(newBatch);
            cyclesScheduled++;
        }

        for (const schedObj of scheduledTasks) {
            for (const schedItem of schedObj.scheduleItems) {
                const discriminationArg = `Batch ${schedObj.batchNumber}-${schedItem.description}`;
                // Args spec: [0: Target, 1: DesiredStartTime (used to delay tool start), 2: ExpectedEndTime (informational), 3: Duration (informational), 4: DoStockManipulation, 5: DisableWarnings]
                const args = [currentTarget.name, schedItem.start.getTime(), schedItem.end - schedItem.start, discriminationArg];
                args.push(...getFlagsArgs(schedItem.toolShortName, currentTarget.name));
                if (options.i && currentTerminalServer?.name == currentTarget.name && schedItem.toolShortName == "hack")
                    schedItem.toolShortName = "manualhack";
                const result = await arbitraryExecution(ns, getTool(schedItem.toolShortName), schedItem.threadsNeeded, args)
                if (result == false) { // If execution fails, we have probably run out of ram.
                    log(ns, `WARNING: Scheduling failed for ${getTargetSummary(currentTarget)} ${discriminationArg} of ${cyclesScheduled} Took: ${Date.now() - start}ms`, false, 'warning');
                    currentTarget.previousCycle = `INCOMPLETE. Tried: ${cyclesScheduled} x ${getTargetSummary(currentTarget)}`;
                    return false;
                }
            }
        }
        if (verbose)
            log(ns, `Scheduled ${cyclesScheduled} x ${getTargetSummary(currentTarget)} Took: ${Date.now() - start}ms`);
        currentTarget.previousCycle = `${cyclesScheduled} x ${getTargetSummary(currentTarget)}`
        return true;
    }

    /** Produces a special log for troubleshooting cycle schedules */
    let logSchedule = (ns, schedule, currentTarget) =>
        log(ns, `Current Time: ${formatDateTime(new Date())} Established a schedule for ${getTargetSummary(currentTarget)} from requested startTime ${formatDateTime(schedule.batchStart)}:` +
            `\n  Hack - End: ${formatDateTime(schedule.hackEnd)}  Start: ${formatDateTime(schedule.hackStart)}  Time: ${formatDuration(currentTarget.timeToHack())}` +
            `\n  Weak1- End: ${formatDateTime(schedule.firstWeakenEnd)}  Start: ${formatDateTime(schedule.firstWeakenStart)}  Time: ${formatDuration(currentTarget.timeToWeaken())}` +
            `\n  Grow - End: ${formatDateTime(schedule.growEnd)}  Start: ${formatDateTime(schedule.growStart)}  Time: ${formatDuration(currentTarget.timeToGrow())}` +
            `\n  Weak2- End: ${formatDateTime(schedule.secondWeakenEnd)}  Start: ${formatDateTime(schedule.secondWeakenStart)}  Time: ${formatDuration(currentTarget.timeToWeaken())}`);

    /** Produce additional args based on the hack tool name and command line flags set */
    function getFlagsArgs(toolName, target, allowLooping = true, overrideSilentMisfires = undefined) {
        const args = []
        const silentMisfires = options['silent-misfires'] ||
            // Must disable misfire alerts in BNs where hack income is disabled because the money gained will always return 0
            (toolName == "hack" && (bitNodeMults.ScriptHackMoneyGain * bitNodeMults.ScriptHackMoney == 0));
        if (["hack", "grow"].includes(toolName)) // Push an arg used by remote hack/grow tools to determine whether it should manipulate the stock market
            args.push(stockMode && (toolName == "hack" && shouldManipulateHack[target] || toolName == "grow" && shouldManipulateGrow[target]) ? 1 : 0);
        args.push(overrideSilentMisfires ?? (silentMisfires ? 1 : 0)); // Optional arg to disable toast warnings about e.g. a failed hack or early grow/weaken
        args.push(allowLooping && loopingMode ? 1 : 0); // Argument to indicate whether the cycle should loop perpetually
        return args;
    }

    // returns an object that contains all 4 timed events start and end times as dates
    function getScheduleTiming(fromDate, currentTarget) {
        const delayInterval = cycleTimingDelay / 4; // spacing interval used to pace our script resolution
        const hackTime = currentTarget.timeToHack(); // first to fire
        const weakenTime = currentTarget.timeToWeaken(); // second to fire
        const growTime = currentTarget.timeToGrow(); // third to fire
        const slowestTool = Math.max(hackTime, weakenTime, growTime);
        // Determine the times we want tasks to complete at, working backwards, and plan the execution start time accordingly
        const t4_secondWeakenResolvesAt = new Date(fromDate.getTime() + slowestTool + delayInterval * 3); // step 4 - weaken after grow fires last
        const t4_fireSecondWeakenAt = new Date(t4_secondWeakenResolvesAt.getTime() - weakenTime);
        const t3_growResolvesAt = new Date(t4_secondWeakenResolvesAt.getTime() - delayInterval); // step 3 (grow back) should resolve "delay" before the final weaken
        const t3_fireGrowAt = new Date(t3_growResolvesAt.getTime() - growTime);
        const t2_firstWeakenResolvesAt = new Date(t3_growResolvesAt.getTime() - delayInterval); // step 2 (weaken after hack) should resolve "delay" before the grow.
        const t2_fireFirstWeakenAt = new Date(t2_firstWeakenResolvesAt.getTime() - weakenTime);
        const t1_hackResolvesAt = new Date(t2_firstWeakenResolvesAt.getTime() - delayInterval); // step 1 (steal a bunch of money) should resolve "delay" before its respective weaken.
        const t1_fireHackAt = new Date(hackOnly ? fromDate.getTime() : t1_hackResolvesAt.getTime() - hackTime);
        // Track when the last task would be start (we need to ensure this doesn't happen after a prior batch has begun completing tasks)
        const lastThingThatFires = new Date(Math.max(t4_fireSecondWeakenAt.getTime(), t3_fireGrowAt.getTime(), t2_fireFirstWeakenAt.getTime(), t1_fireHackAt.getTime()));
        let schedule = {
            batchStart: fromDate,
            lastFire: lastThingThatFires,
            hackStart: t1_fireHackAt,
            hackEnd: t1_hackResolvesAt,
            firstWeakenStart: t2_fireFirstWeakenAt,
            firstWeakenEnd: t2_firstWeakenResolvesAt,
            growStart: t3_fireGrowAt,
            growEnd: t3_growResolvesAt,
            secondWeakenStart: t4_fireSecondWeakenAt,
            secondWeakenEnd: t4_secondWeakenResolvesAt
        };
        return schedule;
    }

    function getScheduleObject(ns, batchTiming, currentTarget, batchNumber) {
        let schedItems = [];

        const schedHack = getScheduleItem("hack", "hack", batchTiming.hackStart, batchTiming.hackEnd, currentTarget.getHackThreadsNeeded());
        const schedWeak1 = getScheduleItem("weak1", "weak", batchTiming.firstWeakenStart, batchTiming.firstWeakenEnd, currentTarget.getWeakenThreadsNeededAfterTheft());
        // Special end-game case, if we have no choice but to hack a server to zero money, schedule back-to-back grows to restore money
        // TODO: This approach isn't necessary if we simply include the `growThreadsNeeded` logic to take into account the +1$ added before grow.
        let schedGrow, schedWeak2;
        if (currentTarget.percentageStolenPerHackThread() >= 1) {
            // Use math and science to minimize total threads required to inject 1 dollar per threads, then grow that to max.
            let calcThreadsForGrow = money => Math.ceil(((Math.log(1 / (money / currentTarget.getMaxMoney())) / Math.log(currentTarget.adjustedGrowthRate()))
                / currentTarget.serverGrowthPercentage()).toPrecision(14));
            let stepSize = Math.floor(currentTarget.getMaxMoney() / 4), injectThreads = stepSize, schedGrowThreads = calcThreadsForGrow(injectThreads);
            for (let i = 0; i < 100 && stepSize > 0; i++) {
                if (injectThreads + schedGrowThreads > (injectThreads + stepSize) + calcThreadsForGrow(injectThreads + stepSize))
                    injectThreads += stepSize;
                else if (injectThreads + schedGrowThreads > (injectThreads - stepSize) + calcThreadsForGrow(injectThreads - stepSize))
                    injectThreads -= stepSize;
                schedGrowThreads = calcThreadsForGrow(injectThreads);
                stepSize = Math.floor(stepSize / 2);
            }
            schedItems.push(getScheduleItem("grow-from-zero", "grow", new Date(batchTiming.growStart.getTime() - (cycleTimingDelay / 8)),
                new Date(batchTiming.growEnd.getTime() - (cycleTimingDelay / 8)), injectThreads)); // Will put $injectThreads on the server
            // This will then grow from whatever % $injectThreads is back to 100%
            schedGrow = getScheduleItem("grow", "grow", batchTiming.growStart, batchTiming.growEnd, schedGrowThreads);
            schedWeak2 = getScheduleItem("weak2", "weak", batchTiming.secondWeakenStart, batchTiming.secondWeakenEnd,
                Math.ceil(((injectThreads + schedGrowThreads) * growthThreadHardening / actualWeakenPotency()).toPrecision(14)));
            if (verbose) log(ns, `INFO: Special grow strategy since percentage stolen per hack thread is 100%: G1: ${injectThreads}, G1: ${schedGrowThreads}, W2: ${schedWeak2.threadsNeeded} (${currentTarget.name})`);
        } else {
            schedGrow = getScheduleItem("grow", "grow", batchTiming.growStart, batchTiming.growEnd, currentTarget.getGrowThreadsNeededAfterTheft());
            schedWeak2 = getScheduleItem("weak2", "weak", batchTiming.secondWeakenStart, batchTiming.secondWeakenEnd, currentTarget.getWeakenThreadsNeededAfterGrowth());
        }

        if (hackOnly) {
            schedItems.push(schedHack);
        } else {
            // Schedule hack/grow first, because they cannot be split, and start with whichever requires the biggest chunk of free RAM
            schedItems.push(...(schedHack.threadsNeeded > schedGrow.threadsNeeded ? [schedHack, schedGrow] : [schedGrow, schedHack]));
            // Scheduler should ensure there's room for both, but splitting threads is annoying, so schedule the biggest first again to avoid fragmentation
            schedItems.push(...(schedWeak1.threadsNeeded > schedWeak2.threadsNeeded ? [schedWeak1, schedWeak2] : [schedWeak2, schedWeak1]));
        }

        const scheduleObject = {
            batchNumber: batchNumber,
            batchStart: batchTiming.batchStart,
            lastFire: batchTiming.lastFire,
            hackEnd: batchTiming.hackEnd,
            batchFinish: hackOnly ? batchTiming.hackEnd : batchTiming.secondWeakenEnd,
            scheduleItems: schedItems
        };
        return scheduleObject;
    }

    // initialize a new incomplete schedule item
    function getScheduleItem(description, toolShortName, start, end, threadsNeeded) {
        const schedItem = {
            description: description,
            toolShortName: toolShortName,
            start: start,
            end: end,
            threadsNeeded: threadsNeeded
        };
        return schedItem;
    }

    // Intended as a high-powered "figure this out for me" run command.
    // If it can't run all the threads at once, it runs as many as it can across the spectrum of daemons available.
    /** @param {NS} ns
     * @param {Tool} tool - An object representing the script being executed **/
    async function arbitraryExecution(ns, tool, threads, args, preferredServerName = null, useSmallestServerPossible = false, allowThreadSplitting = null) {
        // We will be using the list of servers that is sorted by most available ram
        const igRes = tool.ignoreReservedRam; // Whether this tool ignores "reserved ram"
        const rootedServersByFreeRam = getAllServersByFreeRam().filter(server => server.hasRoot() && server.totalRam(igRes) > 1.6);
        // Sort servers by total ram, and try to fill these before utilizing another server.
        const preferredServerOrder = getAllServersByMaxRam().filter(server => server.hasRoot() && server.totalRam(igRes) > 1.6);
        if (useSmallestServerPossible) // If so-configured, fill up small servers before utilizing larger ones (can be laggy)
            preferredServerOrder.reverse();

        // IDEA: "home" is more effective at grow() and weaken() than other nodes (has multiple cores) (TODO: By how much?)
        //       so if this is one of those tools, put it at the front of the list of preferred candidates, otherwise keep home ram free if possible
        //       TODO: This effort is wasted unless we also scale down the number of threads "needed" when running on home. We will overshoot grow/weaken
        const homeIndex = preferredServerOrder.findIndex(i => i.name == "home");
        if (homeIndex > -1) { // Home server might not be in the server list at all if it has insufficient RAM
            const home = preferredServerOrder.splice(homeIndex, 1)[0];
            if (tool.shortName == "grow" || tool.shortName == "weak" || preferredServerName == "home")
                preferredServerOrder.unshift(home); // Send to front
            else
                preferredServerOrder.push(home); // Otherwise, send it to the back (reserve home for scripts that benefit from cores) and use only if there's no room on any other server.
        }
        // Push all "hacknet servers" to the end of the preferred list, since they will lose productivity if used
        const anyHacknetNodes = [];
        let hnNodeIndex;
        while (-1 !== (hnNodeIndex = preferredServerOrder.indexOf(s => s.name.startsWith('hacknet-server-') || s.name.startsWith('hacknet-node-'))))
            anyHacknetNodes.push(...preferredServerOrder.splice(hnNodeIndex, 1));
        preferredServerOrder.push(...anyHacknetNodes.sort((a, b) => b.totalRam(igRes) != a.totalRam(igRes) ? b.totalRam(igRes) - a.totalRam(igRes) : a.name.localeCompare(b.name)));

        // Allow for an overriding "preferred" server to be used in the arguments, and slot it to the front regardless of the above
        if (preferredServerName && preferredServerName != "home" /*home is handled above*/ && preferredServerOrder[0].name != preferredServerName) {
            const preferredServerIndex = preferredServerOrder.findIndex(i => i.name == preferredServerName);
            if (preferredServerIndex != -1)
                preferredServerOrder.unshift(preferredServerOrder.splice(preferredServerIndex, 1)[0]);
            else
                log(ns, `ERROR: Configured preferred server "${preferredServerName}" for ${tool.name} is not a valid server name`, true, 'error');
        }
        if (verbose) log(ns, `Preferred Server ${preferredServerName ?? "(any)"} for ${threads} threads of ${tool.name} (use small=` + `${useSmallestServerPossible})` +
            ` resulted in preferred order:${preferredServerOrder.map(s => ` ${s.name} (${formatRam(s.ramAvailable(igRes))})`)}`);

        // Helper function to compute the most threads a server can run
        let computeMaxThreads = /** @param {Server} server */ function (server) {
            if (tool.cost == 0) return 1;
            let ramAvailable = server.ramAvailable(igRes);
            // Note: To be conservative, we allow double imprecision to cause this floor() to return one less than should be possible,
            //       because the game likely doesn't account for this imprecision (e.g. let 1.9999999999999998 return 1 rather than 2)
            return Math.floor((ramAvailable / tool.cost)/*.toPrecision(14)*/);
        };

        let targetServer = null;
        let remainingThreads = threads;
        let splitThreads = false;
        for (let i = 0; i < rootedServersByFreeRam.length && remainingThreads > 0; i++) {
            targetServer = rootedServersByFreeRam[i];
            const maxThreadsHere = Math.min(remainingThreads, computeMaxThreads(targetServer));
            if (maxThreadsHere <= 0)
                continue; //break; HACK: We don't break here because there are cases when sort order can change (e.g. we've reserved home RAM)

            // If this server can handle all required threads, see if a server that is more preferred also has room.
            // If so, we prefer to pack that server with more jobs before utilizing another server.
            if (maxThreadsHere == remainingThreads) {
                for (let j = 0; j < preferredServerOrder.length; j++) {
                    const nextMostPreferredServer = preferredServerOrder[j];
                    // If the next largest server is also the current server with the most capacity, then it's the best one to pack
                    if (nextMostPreferredServer == targetServer)
                        break;
                    // If the job can just as easily fit on this server, prefer to put the job there
                    if (remainingThreads <= computeMaxThreads(nextMostPreferredServer)) {
                        //log(ns, 'Opted to exec ' + tool.name + ' on preferred server ' + nextMostPreferredServer.name + ' rather than the one with most ram (' + targetServer.name + ')');
                        targetServer = nextMostPreferredServer;
                        break;
                    }
                }
            }

            // If running on a non-daemon host, do a script copy check before running
            if (targetServer.name != daemonHost && !(await tool.existsOnHost(targetServer))) {
                let missing_scripts = [tool.name];
                if (!(await doesFileExist(ns, getFilePath('helpers.js'), targetServer.name)))
                    missing_scripts.push(getFilePath('helpers.js')); // Some tools require helpers.js. Best to copy it around.
                if (tool.name.includes("/Tasks/contractor.js")) // HACK: When home RAM is low and we're running this tool on another sever, copy its dependencies
                    missing_scripts.push(getFilePath('/Tasks/contractor.js.solver.js'), getFilePath('/Tasks/run-with-delay.js'))
                if (verbose)
                    log(ns, `Copying ${tool.name} and ${missing_scripts.length - 1} dependencies from ${daemonHost} to ${targetServer.name} so that it can be executed remotely.`);
                await getNsDataThroughFile(ns, `ns.scp(ns.args.slice(2), ns.args[0], ns.args[1])`, '/Temp/copy-scripts.txt', [targetServer.name, daemonHost, ...missing_scripts])
                missing_scripts.forEach(s => targetServer._files[s] = true); // Make note that these files now exist on the target server
                //await ns.sleep(5); // Workaround for Bitburner bug https://github.com/danielyxie/bitburner/issues/1714 - newly created/copied files sometimes need a bit more time, even if awaited
            }
            // By default, tools executed in this way will be marked as "temporary" (not to be included in the save file or recent scripts history)
            const pid = await exec(ns, tool.name, targetServer.name, { threads: maxThreadsHere, temporary: (tool.runOptions.temporary ?? true) }, ...(args || []));
            if (pid == 0) {
                log(ns, `ERROR: Failed to exec ${tool.name} on server ${targetServer.name} with ${maxThreadsHere} threads`, false, 'error');
                return false;
            }
            // Decrement the threads that have been successfully scheduled
            remainingThreads -= maxThreadsHere;
            if (remainingThreads > 0) {
                if (!(allowThreadSplitting || tool.isThreadSpreadingAllowed)) break;
                if (verbose) log(ns, `INFO: Had to split ${threads} ${tool.name} threads across multiple servers. ${maxThreadsHere} on ${targetServer.name}`);
                splitThreads = true;
            }
        }
        // The run failed if there were threads left to schedule after we exhausted our pool of servers
        if (remainingThreads > 0 && threads < Number.MAX_SAFE_INTEGER) {
            const keepItQuiet = options['silent-misfires'] || homeServer.ramAvailable(true) <= 16; // Don't confuse new users with transient errors when first getting going
            log(ns, `${keepItQuiet ? 'WARN' : 'ERROR'}: Ran out of RAM to run ${tool.name} on ${splitThreads ? 'all servers (split)' : `${targetServer?.name} `}- ` +
                `${threads - remainingThreads} of ${threads} threads were spawned.`, false, keepItQuiet ? undefined : 'error');
        }
        // if (splitThreads && !tool.isThreadSpreadingAllowed) return false; // TODO: Don't think this is needed anymore. We allow overriding with "allowThreadSplitting" in some cases, doesn't mean this is an error
        return remainingThreads == 0;
    }

    /** Brings the server to minimum security and maximum money to prepare for cycling scheduler activity
     * @param {NS} ns
     * @param {Server} currentTarget */
    async function prepServer(ns, currentTarget) {
        // Check if already prepped or in targeting mode, in which case presume prep server is to be skipped.
        if (currentTarget.isPrepped() || (await currentTarget.isTargeting())) return null;
        let start = Date.now();
        let now = new Date(start.valueOf());
        let weakenTool = getTool("weak"), growTool = getTool("grow");
        // Note: We must prioritize weakening before growing, or hardened security will make everything take longer
        let weakenThreadsAllowable = weakenTool.getMaxThreads(); // Note: Max is based on total ram across all servers (since thread spreading is allowed)
        let weakenThreadsNeeded = currentTarget.getWeakenThreadsNeeded();
        if (verbose) log(ns, `INFO: Need ${weakenThreadsNeeded} threads to weaken from ${currentTarget.getSecurity()} to ${currentTarget.getMinSecurity()}. There is room for ${weakenThreadsAllowable} threads (${currentTarget.name})`);
        // Plan grow if needed, but don't bother if we didn't have enough ram to schedule all weaken threads to reach min security
        let growThreadsAllowable, growThreadsNeeded, growThreadsScheduled = 0;
        if (weakenThreadsNeeded < weakenThreadsAllowable && (growThreadsNeeded = currentTarget.getGrowThreadsNeeded())) {
            // During the prep-phase only, we allow grow threads to be split, despite the risks of added security hardening, because in practice is speeds the prep phase along more than waiting for separate batches.
            growThreadsAllowable = growTool.getMaxThreads(/*^*/ true /*^*/) - weakenThreadsNeeded; // Take into account RAM that will be consumed by weaken threads scheduled
            growThreadsScheduled = Math.min(growThreadsNeeded, growThreadsAllowable - 1); // Cap at threads-1 because we assume we will need at least one of these threads for additional weaken recovery
            if (verbose) log(ns, `INFO: Need ${growThreadsNeeded} threads to grow from ${currentTarget.getMoney()} to ${currentTarget.getMaxMoney()}. There is room for ${growThreadsAllowable} threads (${currentTarget.name})`);
            // Calculate additional weaken threads which should be fired after the grow completes.
            let weakenForGrowthThreadsNeeded = Math.ceil((growThreadsScheduled * growthThreadHardening / actualWeakenPotency()).toPrecision(14));
            // If we don't have enough room for the new weaken threads, release grow threads to make room
            const subscription = (growThreadsScheduled + weakenForGrowthThreadsNeeded) / growThreadsAllowable;
            if (subscription > 1) { // Scale down threads to schedule until we are no longer over-subscribed
                const scaleFactor = (growThreadsScheduled + weakenForGrowthThreadsNeeded + 1) / growThreadsAllowable; // +1 is because we will need to round weaken threads up, rather than down, to avoid under-recovery
                const scaledGrowThreads = Math.floor((growThreadsScheduled / scaleFactor).toPrecision(14))
                const scaledWeakThreads = Math.ceil((weakenForGrowthThreadsNeeded / scaleFactor).toPrecision(14));
                log(ns, `INFO: Insufficient RAM to schedule ${weakenForGrowthThreadsNeeded} required weaken threads to recover from ${growThreadsScheduled} prep grow threads. ` +
                    `Scaling both down by ${scaleFactor} to ${scaledGrowThreads} grow + ${scaledWeakThreads} weaken (${currentTarget.name})`);
                growThreadsScheduled = scaledGrowThreads;
                weakenForGrowthThreadsNeeded = scaledWeakThreads;
            }
            weakenThreadsNeeded += weakenForGrowthThreadsNeeded;
            growThreadsAllowable -= weakenForGrowthThreadsNeeded; // For purposes of logging this below if we fail to schedule all grow threads
        }

        // Schedule weaken first, in case ram conditions change, it's more important (security affects speed of future tools)
        let prepSucceeding = true;
        let weakenThreadsScheduled = Math.min(weakenThreadsAllowable, weakenThreadsNeeded);
        if (weakenThreadsScheduled) {
            if (weakenThreadsScheduled < weakenThreadsNeeded)
                log(ns, `INFO: At this time, we only have enough RAM to schedule ${weakenThreadsScheduled} of the ${weakenThreadsNeeded} ` +
                    `prep weaken threads needed to lower the target from current security (${formatNumber(currentTarget.getSecurity())}) ` +
                    `to min security (${formatNumber(currentTarget.getMinSecurity())}) (${currentTarget.name})`);
            prepSucceeding = await arbitraryExecution(ns, weakenTool, weakenThreadsScheduled,
                // Note: Because we are scheduling prep tasks to fire ASAP, we should override the "silent misfires" (last arg) to true
                [currentTarget.name, now.getTime(), currentTarget.timeToWeaken(), "prep", ...getFlagsArgs("weak", currentTarget.name, false, true)]);
            if (prepSucceeding == false)
                log(ns, `WARN: Failed to schedule ${weakenThreadsScheduled} prep weaken threads despite there ostensibly being room for ${weakenThreadsAllowable} (${currentTarget.name})`);
        }
        // Schedule any prep grow threads next
        if (prepSucceeding && growThreadsScheduled > 0) {
            prepSucceeding = await arbitraryExecution(ns, growTool, growThreadsScheduled,
                [currentTarget.name, now.getTime(), currentTarget.timeToGrow(), "prep", ...getFlagsArgs("grow", currentTarget.name, false, true)],
                undefined, undefined, /*allowThreadSplitting*/ true); // Special case: for prep we allow grow threads to be split
            if (prepSucceeding == false)
                log(ns, `WARN: Failed to schedule ${growThreadsScheduled} prep grow threads despite there ostensibly being room for ${growThreadsAllowable} (${currentTarget.name})`);
        }

        // Log a summary of what we did here today
        if (verbose && prepSucceeding && (weakenThreadsScheduled > 0 || growThreadsScheduled > 0))
            log(ns, `Prepping with ${weakenThreadsScheduled} weaken, ${growThreadsScheduled} grow threads (${weakenThreadsNeeded || 0} / ${growThreadsNeeded || 0} needed)` +
                ' ETA ' + Math.floor((currentTarget.timeToWeaken() + queueDelay) / 1000) + 's (' + currentTarget.name + ')' +
                ' Took: ' + (Date.now() - start) + 'ms');
        return prepSucceeding;
    }

    /** @returns {Server[]} All hackable servers, in order of best Hack Exp to worst */
    function getXPFarmTargetsByExp() {
        return getAllServers().filter(server => (server.hasRoot() || server.canCrack()) && server.canHack() && server.shouldHack())
            .sort((a, b) => b.getExpPerSecond() - a.getExpPerSecond());
    }

    /** @returns {Server} The best server to target for Hack Exp */
    function getBestXPFarmTarget() {
        return getXPFarmTargetsByExp()[0];
    }

    let singleServerLimit = 0; // If prior cycles failed to be scheduled, force one additional server into single-server mode until we aqcuire more RAM
    let lastCycleTotalRam = 0; // Cache of total ram on the server to check whether we should attempt to lift the above restriction.
    let targetsByExp = (/**@returns{Server[]}*/() => [])(); // Cached list of targets in order of best exp earning. We don't keep updating this, because we don't want the allocated host to change
    let jobHostMappings = {};

    /** @param {NS} ns
     * Grind hack XP by filling a bunch of RAM with hack() / grow() / weaken() against a relatively easy target */
    async function farmHackXp(ns, fractionOfFreeRamToConsume = 1, verbose = false, numTargets = undefined) {
        if (!xpOnly) // Only use basic single-target hacking unless we're in XP mode
            return await scheduleHackExpCycle(ns, getBestXPFarmTarget(), fractionOfFreeRamToConsume, verbose, false); // Grind some XP from the single best target for farming XP
        // Otherwise, target multiple servers until we can't schedule any more. Each next best host should get the next best (biggest) server
        getTool("grow").isThreadSpreadingAllowed = true; // Only true when in XP mode - where each grow thread is expected to give 1$. "weak" can always spread.
        const serversByMaxRam = getAllServersByMaxRam().filter(s => s.hasRoot());
        let jobHosts = serversByMaxRam.filter(s => s.totalRam() > 128); // Get the set of servers that can be reasonably expected to host decent-sized jobs
        if (jobHosts.length == 0) // Lower our standards if we're early-game and nothing qualifies
            jobHosts = serversByMaxRam.filter(s => s.totalRam() >= 16);
        if (verbose) log(ns, `INFO: Potential Exp Job Hosts (${jobHosts.length}): ` + jobHosts.map(s => ` ${s.name}: ${s.totalRam()}`));
        let homeRam = homeServer.totalRam(); // If total home ram is large enough, the XP contributed by additional targets is insignificant compared to the risk of increased lag/latency.
        // Determine which servers to target for XP
        numTargets = Math.min(maxTargets, Math.floor(jobHosts.filter(s => s.totalRam() > 0.01 * homeRam).length)); // Limit targets (too many creates lag which worsens performance, and need a dedicated server for each)
        const newTargets = getXPFarmTargetsByExp();
        if (!loopingMode)
            targetsByExp = newTargets; // Normally, we just take the latests Xp targetting order (TODO: Perhaps cache this for a limited time (30 mins?) to keep the targetting order stable)
        else if (loopingMode && targetsByExp.length < numTargets) { // In looping mode, we must keep the target-host mapping stable, we only revisit if we have capacity for new targets
            targetsByExp = targetsByExp.concat(...(newTargets
                .filter(t => !targetsByExp.includes(t)) // Only take targets not already in the target list
                .slice(0, numTargets - targetsByExp.length)));// Only take as many as we have are willing to target right now, allowing for the future target priority order to change
            // Immediately map any new targets to the next largest available host.
            for (let target of targetsByExp)
                if (!(target.name in jobHostMappings))
                    jobHostMappings[target.name] = jobHosts.filter(h => !(h.name in Object.values(jobHostMappings)))[0];
            if (verbose) {
                log(ns, `INFO: Hack XP targetting order: ${targetsByExp.map(h => `${h.name} (${formatNumber(h.getExpPerSecond())})`).join(',')}`);
                log(ns, `INFO: Hack XP host (RAM) order: ${jobHosts.map(h => `${h.name} (${formatRam(h.totalRam())})`).join(',')}`);
            }
        }
        //log(ns, `INFO: numTargets ${numTargets}, maxTargets ${maxTargets}, targetsByExp.length ${targetsByExp.length}, homeRam ${homeRam}, hosts>homeRam ${jobHosts.filter(s => s.totalRam() > 0.01 * homeRam).length}, `);
        numTargets = Math.min(numTargets, targetsByExp.length);
        if (options.i) { // To farm intelligence, use manual hack on only the current connected server
            if (currentTerminalServer.name != "home") {
                numTargets = 1;
                targetsByExp = [currentTerminalServer];
            }
        }
        const etas = [];
        const totalServerRam = jobHosts.reduce((total, s) => total + s.totalRam(), 0);
        if (totalServerRam > lastCycleTotalRam) { // If we've aqcuired more ram, remove restrictions and discover the new best balance
            singleServerLimit = 0;
            lastCycleTotalRam = totalServerRam;
        }
        let tryAdvanceMode = bitNodeMults.ScriptHackMoney != 0; // We can't attempt hack-based XP if it's impossible to drain server money (XP will always be 1/4) Note: We can still gain full Exp if ScriptHackMoneyGain is 0)
        let singleServerMode = false; // Start off maximizing hack threads for best targets by spreading their weaken/grow threads to other servers
        for (let i = 0; i < numTargets; i++) {
            let lastSchedulingResult;
            // By defaults we match the host with the highest ram to the target with the largest exp-potential
            // but in looping-mode, targets are "locked" to a host once started.
            let selectedTarget = targetsByExp[i];
            let selectedHost = loopingMode ? jobHostMappings[i] : jobHosts[i];
            // If we aren't already configured for singleServerMode, switch to single-server mode if running out of hosts with high ram
            singleServerMode = singleServerMode || (i >= (jobHosts.length - 1 - singleServerLimit) || jobHosts[i + 1].totalRam() < 1000);
            // We can disable singleServerMode if this is the last target, since we don't need to reserve room for other targets
            if (i == numTargets - 1) singleServerMode = false;
            etas.push(lastSchedulingResult = (await scheduleHackExpCycle(ns, selectedTarget, fractionOfFreeRamToConsume, verbose, tryAdvanceMode, selectedHost, singleServerMode)) || Number.MAX_SAFE_INTEGER);
            if (lastSchedulingResult == Number.MAX_SAFE_INTEGER) break; // Stop scheduling targets if the last attempt failed
        }
        if (verbose) log(ns, `INFO: farmHackXp has processed ${numTargets} targets.`);
        // Wait for all job scheduling threads to return, and sleep for the smallest cycle time remaining
        return Math.max(0, Math.min(...etas));
    }

    // In case we've misfired a bit, this helper can wait a short while to see if we can start a new cycle right as the last one completes.
    async function waitForCycleEnd(ns, server, maxWaitTime = 200, waitInterval = 5) {
        const eta = nextXpCycleEnd[server.name];
        if (verbose) return log(ns, `WARNING: ${server.name} FarmXP process is still in progress from a prior run. Completion time is unknown...`);
        const activeCycleTimeLeft = (eta || 0) - Date.now();
        let stillBusy;
        if (verbose) log(ns, `Waiting for last ${server.name} FarmXP process to complete... (ETA ${eta ? formatDuration(activeCycleTimeLeft) : 'unknown'})`);
        while (stillBusy = server.isXpFarming(false) && maxWaitTime > 0) {
            await ns.sleep(waitInterval); // Sleep a very short while, then get a fresh process list to check again whether the process is done
            maxWaitTime -= waitInterval;
        }
        if (stillBusy)
            log(ns, `WARNING: ${server.name} FarmXP process is ` + (eta ? `more than ${formatDuration(-activeCycleTimeLeft)} overdue...` : 'still in progress from a prior run...'));
        return !stillBusy;
    }

    let farmXpReentryLock = []; // A dictionary of server names and whether we're currently scheduling / polling for its cycle to end
    let nextXpCycleEnd = []; // A dictionary of server names and when their next XP farming cycle is expected to end
    let loopsHackThreadsByServer = {}, loopsByServer_Grow = {}, loopsByServer_Weaken = {}; // Tracks active looping scripts
    /** @param {NS} ns
     * @param {Server} server - The server that will be targetted
     * @param {Server} allocatedServer - You may designate a specific server on which to execute scripts. **/
    async function scheduleHackExpCycle(ns, server, percentOfFreeRamToConsume, verbose, advancedMode, allocatedServer = null, singleServer = false) {
        //if (verbose) log(ns, `scheduleHackExpCycle advancedMode=${advancedMode} singleServer=${singleServer} allocatedServer=${allocatedServer?.name ?? "(any)"} targetting=${server.name}`);
        if (!server.hasRoot() && server.canCrack()) await doRoot(ns, server); // Get root if we do not already have it.
        if (!server.hasRoot()) return log(ns, `ERROR: Cannot farm XP from unrooted server ${server.name}`, true, 'error');
        // If we are already farming XP from this server, wait for it to complete (if the last cycle is almost done) or skip scheduling more work
        const eta = nextXpCycleEnd[server.name];
        const activeCycleTimeLeft = (eta || 0) - Date.now();
        if (activeCycleTimeLeft > 1000) return activeCycleTimeLeft; // If we're more than 1s away from the expected fire time, just wait for the next loop, don't even check for early completion
        if (farmXpReentryLock[server.name] == true) return; // Ensure more than one concurrent callback isn't trying to schedule this server's faming cycle
        const [logPrefix, toastLevel] = options['silent-misfires'] ? ['INFO:', undefined] : ['WARNING:', 'warning'];
        try {
            farmXpReentryLock[server.name] = true;
            let expTool; // The tool we will use to farm XP (can be hack, grow, or weaken depending on the situation)
            let expTime; // The time this tool will take to run
            if (advancedMode) { // We get the most XP by using max possible hack threads while keeping money just above 0 (so that we get full hack() exp)
                expTool = options.i ? getTool("manualhack") : getTool("hack");
                expTime = server.timeToHack();
            } else if (server.getSecurity() > server.getMinSecurity()) { // If the server isn't at min-security, we should do that (to reduce hack/grow/weaken time to the minimum)
                expTool = getTool("weak");
                expTime = server.timeToWeaken();
            } else { // If the server is at min-security, we should farm grow(), since it takes less time (80%) than weaken(). Once at max-money, grow will no longer reduce security.
                expTool = getTool("grow");
                expTime = server.timeToGrow();
            }
            let threads = loopsHackThreadsByServer[server.name] ?? 0;
            let loopRunning = loopingMode && threads > 0;
            let getStrAllocatedServer = () => `allocated server ` + (allocatedServer == null ? '(any server)' : `${allocatedServer.name} with ${formatRam(allocatedServer.ramAvailable())} free RAM`);
            //log(ns, `loopingMode: ${loopingMode} loopRunning: ${loopRunning} for ${server.name} (loop threads: ${loopsHackThreadsByServer[server.name]})`);
            if (!loopRunning) {
                if (await server.isXpFarming()) {
                    if (verbose && activeCycleTimeLeft < -50) // Warn about big misfires (sign of lag)
                        log(ns, `${logPrefix} ${server.name} FarmXP process is ` + (eta ? `more than ${formatDuration(-activeCycleTimeLeft)} overdue...` :
                            `still in progress from a prior run. ETA unknown, assuming '${expTool.name}' time: ${formatDuration(expTime)}`));
                    return eta ? (activeCycleTimeLeft > 0 ? activeCycleTimeLeft : 10 /* If we're overdue, sleep only 10 ms before checking again */) : expTime /* Have no ETA, sleep for expTime */;
                }
                threads = Math.floor(((allocatedServer == null ? expTool.getMaxThreads() : allocatedServer.ramAvailable() / expTool.cost) * percentOfFreeRamToConsume).toPrecision(14));
                if (threads == 0)
                    return log(ns, `${logPrefix} Cannot farm XP from ${server.name}, threads == 0 for ${getStrAllocatedServer()}`, false, toastLevel);
            }

            let growThreadsNeeded, weakenThreadsNeeded; // Used in advanced mode
            if (advancedMode) { // Need to keep server money above zero, and security at minimum to farm xp from hack();
                const effectiveHackThreads = Math.ceil(1 / server.percentageStolenPerHackThread()); // Only this many hack threads "count" for stealing/hardening. The rest get a 'free ride'
                if (!loopRunning && threads <= effectiveHackThreads) {
                    // We don't have enough ram for advanced XP grind (no hack threads would get a 'free ride'). Revert to simple weak/grow farming mode.
                    farmXpReentryLock[server.name] = false;
                    return await scheduleHackExpCycle(ns, server, percentOfFreeRamToConsume, verbose, false, allocatedServer, singleServer);
                }
                growThreadsNeeded = Math.ceil(effectiveHackThreads * recoveryThreadPadding); // To hack for money, server must have at least 1$ per thread that "counts" for the steal (threads required to steal 100%)
                const securityHardeningToCombat = Math.max(effectiveHackThreads * hackThreadHardening + growThreadsNeeded * growthThreadHardening, // Security that will be incurred hack() + grow() threads
                    server.getSecurity() - server.getMinSecurity()); // If the current security level is higher than this, add enough weaken threads to correct it
                weakenThreadsNeeded = Math.ceil(securityHardeningToCombat / actualWeakenPotency() * recoveryThreadPadding);
                const priorThreads = threads;
                if (singleServer) // If set to only use a single server, free up the hack threads to make room for recovery threads on the same host
                    threads = Math.max(0, threads - Math.ceil((growThreadsNeeded + weakenThreadsNeeded) * 1.75 / expTool.cost)); // Make room for recovery threads
                else { // If not in single-server mode, but the remaining hosts on the network can't fit 4 sets of grow + weaken recovery threads needed, we similarily need to reduce hack threads until required recovery threads can fit
                    const recoveryTool = getTool('weak'); // Weak and grow take the same ram, so we can just use this
                    const threadsOnExpToolHost = (allocatedServer == null ? recoveryTool.getMaxThreads() : allocatedServer.ramAvailable() / recoveryTool.cost); // If we ran on the same host as expTool, how many threads would fit?
                    const globalThreads = getTool('weak').getMaxThreads(true); // How many threads would fit on the entire server?
                    const schedulableThreads = globalThreads - threadsOnExpToolHost; // Subtract thread we cannot schedule due to the expTool using that entire host
                    const missingThreads = growThreadsNeeded + weakenThreadsNeeded - schedulableThreads; // This is the number of threads we won't be able to schedule
                    if (missingThreads > 0) // Note, we have to free up a slightly different number of hack threads, because the RAM cost is different
                        threads = Math.max(0, threads - Math.ceil(missingThreads * 1.75 / expTool.cost));
                }
                // If after making room for recovery threads, we would be scheduling fewer hack threads than effective threads, there's no point in farming in this mode
                if (threads <= effectiveHackThreads) {
                    log(ns, `INFO: Cannot farm XP from ${server.name} on ${getStrAllocatedServer()} in advanced mode: Hack threads=${threads} after releasing ` +
                        `${priorThreads - threads} for ${growThreadsNeeded} grow threads and ${weakenThreadsNeeded} weaken threads required to counter ` +
                        `${effectiveHackThreads} effective hack threads. Reverting to basic XP farming mode.`);
                    farmXpReentryLock[server.name] = false;
                    return await scheduleHackExpCycle(ns, server, percentOfFreeRamToConsume, verbose, false, allocatedServer, singleServer);
                }
            }

            let now = Date.now();
            let scheduleTime = now + queueDelay;
            let msToCycleEnd = queueDelay + (loopingMode ? expTime * 4.0 : expTime);
            nextXpCycleEnd[server.name] = now + msToCycleEnd; // Store how many MS before when this server's next cycle is expected to end
            const allowLoop = advancedMode /*&& singleServer*/ && allTargetsPrepped; // Allow looping mode only once all targets are prepped
            //log(ns, `allowLoop: ${allowLoop} advancedMode: ${advancedMode} singleServer: ${singleServer} allTargetsPrepped: ${allTargetsPrepped}`);
            // Schedule the FarmXP threads first, ensuring that they are not split (if they our split, our hack threads above 'effectiveHackThreads' lose their free ride)
            let success = true;
            if (!loopRunning) { // In looping mode, we only schedule one FarmXp (hack) loop, so skip this if one is already running
                const farmXpArgs = [server.name, scheduleTime, expTime, "FarmXP", ...getFlagsArgs(expTool.shortName, server.name, allowLoop)];
                if (verbose) log(ns, `Scheduling ${threads}x ${expTool.shortName} on ${allocatedServer?.name ?? "(any)"} targetting ${server.name}`);
                success = await arbitraryExecution(ns, expTool, threads, farmXpArgs, allocatedServer?.name);
            }
            if (success && allowLoop) loopsHackThreadsByServer[server.name] = threads;

            if (advancedMode) { // Need to keep server money above zero, and security at minimum to farm xp from hack();
                const weakDesiredFireTime = (scheduleTime + expTime * 2 / 3); //  Time this to resolve at 2/3 * time-to-hack after each hack fires
                let scheduleWeak = weakDesiredFireTime - server.timeToWeaken();
                const growDesiredFireTime = (scheduleTime + expTime * 1 / 3); // Time this to resolve at 1/3 * time-to-hack after each hack fires
                let scheduleGrow = growDesiredFireTime - server.timeToGrow(); // TODO: This first grow will run at increased security, so it will take longer to fire. How much longer?
                // Scheduled times might be negative, because "grow" / "weaken" take longer to run than "hack"
                // This is fine, it just means we'll have one hack misfire before recovery threads "catch up" to the loop
                while (scheduleWeak < queueDelay) scheduleWeak += expTime;
                while (scheduleGrow < queueDelay) scheduleGrow += expTime;
                // Hack runs 4 times per weaken, so in looping mode we need to schedule 4 weaken loops to keep up with one hack loop.
                do {
                    const allWeakLoopsScheduled = loopingMode && (loopsByServer_Weaken[server.name] ?? 0) >= 4;
                    //log(ns, `allowLoop: ${allowLoop} allWeakLoopsScheduled: ${allWeakLoopsScheduled} for ${server.name} (loops: ${loopsByServer_Weaken[server.name]})`);
                    if (allWeakLoopsScheduled) break;
                    if (verbose) log(ns, `Scheduling ${weakenThreadsNeeded}x weak on ${allocatedServer?.name ?? "(any)"} targetting ${server.name}`);
                    success &&= await arbitraryExecution(ns, getTool("weak"), weakenThreadsNeeded,
                        [server.name, scheduleWeak, server.timeToWeaken(), "weakenForXp", ...getFlagsArgs("weak", server.name, allowLoop)],
                        singleServer ? allocatedServer?.name : null, !singleServer);
                    if (success && allowLoop && !allWeakLoopsScheduled)
                        loopsByServer_Weaken[server.name] = 1 + (loopsByServer_Weaken[server.name] ?? 0);
                    if (verbose) log(ns, `Looping ${weakenThreadsNeeded} x Weak starting in ${Math.round(scheduleWeak - now)}ms, ` +
                        `Tick: ${Math.round(msToCycleEnd)}ms on ${allocatedServer?.name ?? '(any server)'} targeting "${server.name}"`);
                    // The next loop (if any) we schedule needs to be offset by an additional +expTime
                    scheduleWeak += expTime;
                } while (loopingMode); // In looping mode, set up additional recovery loops
                // Schedule 4 grow loops to fire after each hack/weaken
                do {
                    const allGrowLoopsScheduled = loopingMode && (loopsByServer_Grow[server.name] ?? 0) >= 4;
                    //log(ns, `allowLoop: ${allowLoop} allGrowLoopsScheduled: ${allGrowLoopsScheduled} for ${server.name} (loops: ${loopsByServer_Grow[server.name]})`);
                    if (allGrowLoopsScheduled) break;
                    if (verbose) log(ns, `Scheduling ${growThreadsNeeded}x grow on ${allocatedServer?.name ?? "(any)"} targetting ${server.name}`);
                    success &&= await arbitraryExecution(ns, getTool("grow"), growThreadsNeeded,
                        [server.name, scheduleGrow, server.timeToGrow(), "growForXp", ...getFlagsArgs("grow", server.name, allowLoop)],
                        singleServer ? allocatedServer?.name : null, !singleServer);
                    if (success && allowLoop && !allGrowLoopsScheduled)
                        loopsByServer_Grow[server.name] = 1 + (loopsByServer_Grow[server.name] ?? 0);
                    if (verbose) log(ns, `Looping ${growThreadsNeeded} x Grow starting in ${Math.round(scheduleGrow - now)}ms, ` +
                        `Tick: ${Math.round(msToCycleEnd)}ms on ${allocatedServer?.name ?? '(any server)'} targeting "${server.name}"`);
                    // The next loop (if any) we schedule needs to be offset by an additional +expTime
                    scheduleGrow += expTime;
                } while (loopingMode); // In looping mode, set up additional recovery loops
                //log(ns, `XP Farm ${server.name} money available is ${formatMoney(server.getMoney())} and security is ` +
                //    `${server.getSecurity().toPrecision(3)} of ${server.getMinSecurity().toPrecision(3)}`);
                //log(ns, `Planned start: Hack: ${Math.round(scheduleTime - now)} Grow: ${Math.round(scheduleGrow - now)} ` +
                //    `Weak: ${Math.round(scheduleWeak - now)} Tick: ${Math.round(msToCycleEnd)} Cycle: ${threads} / ${growThreadsNeeded} / ${weakenThreadsNeeded}`);
                if (verbose) log(ns, `Exp Cycle: ${threads} x Hack in ${Math.round(scheduleTime - now + expTime)}ms, ` +
                    `${growThreadsNeeded} x Grow in ${Math.round((scheduleGrow - now + server.timeToGrow()) % msToCycleEnd)}ms, ` + // TODO: This "in ...ms" time seems messed up. Need a comment at least
                    `${weakenThreadsNeeded} x Weak in ${Math.round((scheduleWeak - now + server.timeToWeaken()) % msToCycleEnd)}ms, ` +
                    `Tick: ${Math.round(msToCycleEnd)}ms on ${allocatedServer?.name ?? '(any server)'} targeting "${server.name}"`);
            } else if (verbose)
                log(ns, `In ${formatDuration(msToCycleEnd)}, ${threads} ${expTool.shortName} threads will fire against ${server.name} on ${allocatedServer?.name ?? '(any server)'} (for Hack Exp)`);
            if (!success) { // If some aspect scheduling fails, we should try adjusting our future scheduling tactics to attempt to use less RAM
                if (singleServerLimit >= maxTargets && maxTargets > 1)
                    maxTargets--;
                else
                    singleServerLimit++;
            }
            // Note: Plan to wake up soon after our planned exp cycle has fired 
            return success ? msToCycleEnd + 10 : false; // TODO: In advance mode, we can probably return a longer delay, since there's no need to wake up often in looping mode
        } finally {
            farmXpReentryLock[server.name] = false;
        }
    }

    // In "-s" mode, we collect information about our current stock positions and hack/grow with stock manipulation enabled in order to boost that stock's position.
    const serverStockSymbols = Object.fromEntries([
        ["foodnstuff", "FNS"], ["sigma-cosmetics", "SGC"], ["omega-net", "OMGA"], ["comptek", "CTK"], ["netlink", "NTLK"], ["syscore", "SYSC"], ["catalyst", "CTYS"], ["lexo-corp", "LXO"], ["alpha-ent", "APHE"], ["rho-construction", "RHOC"],
        ["aerocorp", "AERO"], ["global-pharm", "GPH"], ["omnia", "OMN"], ["defcomm", "DCOMM"], ["solaris", "SLRS"], ["icarus", "ICRS"], ["univ-energy", "UNV"], ["nova-med", "NVMD"], ["titan-labs", "TITN"], ["microdyne", "MDYN"], ["stormtech", "STM"],
        ["helios", "HLS"], ["vitalife", "VITA"], ["fulcrumtech", "FLCM"], ["4sigma", "FSIG"], ["kuai-gong", "KGI"], ["omnitek", "OMTK"], ["blade", "BLD"], ["clarkinc", "CLRK"], ["ecorp", "ECP"], ["megacorp", "MGCP"], ["fulcrumassets", "FLCM"]
    ]);
    let serversWithOwnedStock = []; // Dict of server names, with a value of "true" if we should turn on stock-manipulation when growing this server
    let shouldManipulateGrow = []; // Dict of server names, with a value of "true" if we should turn on stock-manipulation when growing this server
    let shouldManipulateHack = []; // Dict of server names, with a value of "true" if we should turn on stock-manipulation when hacking this server
    let failedStockUpdates = 0;
    /** @param {NS} ns **/
    async function updateStockPositions(ns) {
        if (!haveTixApi) return; // No point in attempting anything here if the user doesn't have stock market access yet.
        let updatedPositions = ns.read(`/Temp/stock-probabilities.txt`); // Should be a dict of stock symbol -> prob left by the stockmaster.js script.
        if (!updatedPositions) {
            failedStockUpdates++;
            if (failedStockUpdates % 60 == 10) // Periodically warn if stockmaster is not running (or not generating the required file)
                log(ns, `WARNING: The file "/Temp/stock-probabilities.txt" has been missing or empty the last ${failedStockUpdates} attempts.` +
                    `\nEnsure stockmaster.js is running, or turn off the --stock-manipulation flag when running.`, false, 'warning');
            return
        }
        failedStockUpdates = 0;
        updatedPositions = JSON.parse(updatedPositions); // Should be a dict of stock symbol -> prob left by the stockmaster.js script.
        // Strengthen whatever trend a stock currently has, whether we own it or not
        const newShouldManipulateGrow = {}, newShouldManipulateHack = {}, newServersWithOwnedStock = [];
        Object.keys(serverStockSymbols).forEach(server => {
            const sym = serverStockSymbols[server];
            const pos = updatedPositions[sym];
            newShouldManipulateGrow[server] = pos.sharesLong > 0 ? true : pos.prob >= 0.5; // If bullish, grow should be made to influence stock
            newShouldManipulateHack[server] = pos.sharesShort > 0 ? true : pos.prob < 0.5; // If bearish, hack should be made to influence stock
            if (pos.sharesLong > 0 || pos.sharesShort > 0) newServersWithOwnedStock.push(server); // Keep track of servers we own stock in so we can prioritize hacking them in stockFocus mode
        });
        if (stockFocus) { // Detect any positions that have reversed and kill all active hack/grow scripts against that server set to manipulate in the wrong direction
            const newLongPositions = Object.keys(serverStockSymbols).filter(server => newShouldManipulateGrow[server] && !shouldManipulateGrow[server]);
            if (newLongPositions.length > 0) await terminateScriptsManipulatingStock(ns, newLongPositions, getTool("hack").name); // Make sure no hacks are set to manipulate our long positions down!
            const newShortPositions = Object.keys(serverStockSymbols).filter(server => newShouldManipulateHack[server] && !shouldManipulateHack[server]);
            if (newShortPositions.length > 0) await terminateScriptsManipulatingStock(ns, newShortPositions, getTool("grow").name); // Make sure no grows are set to manipulate our short positions up!
        }
        shouldManipulateGrow = newShouldManipulateGrow;
        shouldManipulateHack = newShouldManipulateHack;
        serversWithOwnedStock = newServersWithOwnedStock;
    }

    // Kills all scripts running the specified tool and targeting one of the specified servers if stock market manipulation is enabled
    async function terminateScriptsManipulatingStock(ns, servers, toolName) {
        const processes = await Promise.all(allHostNames.flatMap(hostname => processList(ns, hostname, false)));
        const stockManipArgIdx = 4; // TODO: This is unmaintanable AF
        const problematicProcesses = processes.filter(process => servers.includes(process.args[0]) &&
            (loopingMode || toolName == process.filename && process.args.length > stockManipArgIdx && process.args[stockManipArgIdx]));
        const problematicProcessesIds = problematicProcesses.map(process => process.pid);
        if (problematicProcessesIds.length > 0) {
            log(ns, `INFO: Killing ${problematicProcessesIds.length} pids running ${toolName} with stock manipulation in the wrong direction.`);
            await killProcessIds(ns, problematicProcessesIds);
        }
        // If we killed a perpetually-looping process, we will need to spawn new ones, so we need to reset the loopsByServer cache.
        if (!loopingMode) return;
        const strGrow = getTool("grow").name, strWeak = getTool("weak").name, strHack = getTool("hack").name;
        problematicProcesses.forEach(process => {
            // The "loop mode" flag is at index [6] hack and grow scripts
            if (toolName == strGrow && 1 == (process.args.length > 6 ? process.args[6] : 0))
                loopsByServer_Grow[process.args[0]] -= 1;
            else if (toolName == strWeak && 1 == (process.args.length > 6 ? process.args[6] : 0))
                loopsByServer_Weaken[process.args[0]] -= 1;
            // Weaken's "loop mode" arg is at index [5] TODO: This is annoying. Make args consistent
            else if (toolName == strHack && 1 == (process.args.length > 5 ? process.args[5] : 0))
                loopsHackThreadsByServer[process.args[0]] -= process.threads;
        });
        loopsByServer_Grow
    }

    /** Helper to kill a list of process ids
     * @param {NS} ns **/
    async function killProcessIds(ns, processIds) {
        return await runCommand(ns, `ns.args.forEach(ns.kill)`, '/Temp/kill-pids.js', processIds);
    }

    /** @param {Server} server **/
    function addServer(ns, server, verbose) {
        if (verbose) log(ns, `Adding a new server to all lists: ${server}`);
        _allServers.push(server);
        if (server.name == daemonHost)
            homeServer = server;
        resetServerSortCache(); // Reset the cached sorted lists of objects
    }

    function removeServerByName(ns, deletedHostName) {
        // Remove from the list of server names
        let findIndex = allHostNames.indexOf(deletedHostName)
        if (findIndex === -1)
            log(ns, `ERROR: Failed to find server with the name "${deletedHostName}" in the allHostNames list.`, true, 'error');
        else
            allHostNames.splice(findIndex, 1);
        // Remove from the list of server objects
        const arrAllServers = getAllServers();
        findIndex = arrAllServers.findIndex(s => s.name === deletedHostName);
        if (findIndex === -1)
            log(ns, `ERROR: Failed to find server by name "${deletedHostName}".`, true, 'error');
        else {
            arrAllServers.splice(findIndex, 1);
            log(ns, `"${deletedHostName}" was found at index ${findIndex} of servers and removed leaving ${arrAllServers.length} items.`);
        }
        resetServerSortCache(); // Reset the cached sorted lists of objects
    }

    // Helper to construct our server lists from a list of all host names
    async function buildServerList(ns, verbose = false) {
        // Get list of servers (i.e. all servers on first scan, or newly purchased servers on subsequent scans)
        let scanResult = await getNsDataThroughFile(ns, 'scanAllServers(ns)');
        // Ignore hacknet node servers if we are not supposed to run scripts on them (reduces their hash rate when we do)
        if (!useHacknetNodes)
            scanResult = scanResult.filter(hostName => !hostName.startsWith('hacknet-server-') && !hostName.startsWith('hacknet-node-'))
        // Remove all servers we currently have added that are no longer being returned by the above query
        for (const hostName of allHostNames.filter(hostName => !scanResult.includes(hostName)))
            removeServerByName(ns, hostName);
        // Check if any of the servers are new to us
        const newServers = scanResult.filter(hostName => !allHostNames.includes(hostName))
        if (newServers.length == 0) return; // If not, we're done
        // Update our list of known hostnames
        allHostNames.push(...newServers);
        // Need to refresh static server info, since there are now new servers to gather information from
        await getStaticServerData(ns);
        // Construct server objects for each new server added
        for (const hostName of newServers)
            addServer(ns, new Server(ns, hostName, verbose));
    }

    /** @returns {Server[]} A list of all server objects */
    function getAllServers() { return _allServers; }

    /** @returns {Server} A list of all server objects */
    function getServerByName(hostname) {
        const findResult = getAllServers().find(s => s.name == hostname)
        // Below can be used for debugging, but generally we allow a failed attempt to find a server (at startup)
        // if (!findResult) throw new Error(`Failed to find server for "${hostname}" in list of servers: ${getAllServers().map(s => s.name)}`);
        return findResult;
    }

    // Note: We maintain copies of the list of servers, in different sort orders, to reduce re-sorting time on each iteration
    let _serverListByFreeRam = (/**@returns{Server[]}*/() => undefined)();
    let _serverListByMaxRam = (/**@returns{Server[]}*/() => undefined)();
    let _serverListByTargetOrder = (/**@returns{Server[]}*/() => undefined)();
    const resetServerSortCache = () => _serverListByFreeRam = _serverListByMaxRam = _serverListByTargetOrder = undefined;

    /** @param {Server[]} toSort
     * @param {(a: Server, b: Server) => number} compareFn
     * @returns {Server[]} List sorted by the specified compare function */
    function _sortServersAndReturn(toSort, compareFn) {
        toSort.sort(compareFn);
        return toSort;
    }

    /** @returns {Server[]} Sorted by most free (available) ram to least */
    function getAllServersByFreeRam() {
        return _sortServersAndReturn(_serverListByFreeRam ??= getAllServers().slice(), function (a, b) {
            const ramDiff = b.ramAvailable() - a.ramAvailable();
            return ramDiff != 0.0 ? ramDiff : sortServerTieBreaker(a, b);
        });
    }

    /** @returns {Server[]} Sorted by most max ram to least */
    function getAllServersByMaxRam() {
        return _sortServersAndReturn(_serverListByMaxRam ??= getAllServers().slice(), function (a, b) {
            const ramDiff = b.totalRam() - a.totalRam();
            return ramDiff != 0.0 ? ramDiff : sortServerTieBreaker(a, b);
        });
    }

    /** Comparison function that breaks ties when sorting two servers
     * @param {Server} a
     * @param {Server} b
     * @returns {0|1|-1} */
    function sortServerTieBreaker(a, b) {
        // Sort servers by name, except daemon servers are sorted by their prefix
        return (a.name.startsWith(purchasedServersName) && b.name.startsWith(purchasedServersName)) ?
            (Number("1" + a.name.substring(purchasedServersName.length + 1)) - Number("1" + b.name.substring(purchasedServersName.length + 1))) :
            a.name.localeCompare(b.name); // Other servers, basic sort by name
    }

    /** @param {number} homeRam Current ram on the home server (if low, priorities change slightly)
     * @returns {Promise<Server[]>} Sorted in the order we should prioritize spending ram on targeting them (for hacking) */
    async function getAllServersByTargetOrder(homeRam) {
        _serverListByTargetOrder ??= getAllServers().slice(); // Take a fresh copy if not already cached
        // The check for whether a server is being targetted is async, so we must collect this info upfront before using in a sort function
        const dictIsTargeting = {};
        for (const server of _serverListByTargetOrder)
            dictIsTargeting[server.name] = await server.isTargeting();
        return _sortServersAndReturn(_serverListByTargetOrder, function (a, b) {
            if (a.canHack() != b.canHack()) return a.canHack() ? -1 : 1; // Sort all hackable servers first
            // In xp-only mode, make the targeting order consist with the current cached "targetsByExp" order
            if (xpOnly) {
                let targetIdxA = targetsByExp.indexOf(a);
                let targetIdxB = targetsByExp.indexOf(b);
                if (targetIdxA != -1 || targetIdxB != -1) // If one or both are in the targetsByExp list, sort based on this
                    return targetIdxA == -1 ? 1 : targetIdxB == -1 ? -1 : targetIdxA < targetIdxB ? -1 : 1;
            }
            if (stockFocus) { // If focused on stock-market manipulation, sort up servers with a stock, prioritizing those we have some position in
                let stkCmp = serversWithOwnedStock.includes(a.name) == serversWithOwnedStock.includes(b.name) ? 0 : serversWithOwnedStock.includes(a.name) ? -1 : 1;
                let manipA = (shouldManipulateGrow[a.name] || shouldManipulateHack[a.name]); // Whether we want to manipulate the stock associated with server A
                let manipB = (shouldManipulateGrow[b.name] || shouldManipulateHack[b.name]); // Whether we want to manipulate the stock associated with server A
                if (stkCmp == 0) stkCmp = manipA == manipB ? 0 : manipA ? -1 : 1;
                if (stkCmp != 0) return stkCmp;
            }
            // Next, Sort already-prepped servers to the front (they can be hacked now)
            let aIsPrepped = (a.isPrepped() || dictIsTargeting[a.name]); // Assume that if we're targetting a server, it's prepped
            let bIsPrepped = (b.isPrepped() || dictIsTargeting[b.name]);
            if (aIsPrepped != bIsPrepped) return aIsPrepped ? -1 : 1;
            if (!a.canHack()) return a.requiredHackLevel - b.requiredHackLevel; // Not-yet-hackable servers are sorted by lowest hack requirement (earliest unlock)
            //if (!a.isPrepped()) return a.timeToWeaken() - b.timeToWeaken(); // Unprepped servers are sorted by lowest time to weaken
            // To speed things along for new players starting BN 1.1, select targetes by lowest security
            if (homeRam == 8) {
                let lowestSec = a.getSecurity() - b.getSecurity();
                if (lowestSec != 0) return lowestSec;
            }
            // For ready-to-hack servers, the sort order is based on money, RAM cost, and cycle time
            let bestGains = b.getMoneyPerRamSecond() - a.getMoneyPerRamSecond(); // Groups of prepped and un-prepped servers are sorted by most money/ram.second
            if (bestGains != 0) return bestGains;
            // In the unlikely event that two servers have the same gains, sort them alphabetically to ensure a stable sort
            return a.name.localeCompare(b.name)
        });
    }

    async function runCommand(ns, ...args) {
        return await runCommand_Custom(ns, getFnRunViaNsExec(ns, daemonHost), ...args);
    }
    /** A custom daemon.js wrapper around the helpers.js ram-dodging function which uses exec rather than run
     * @param {NS} ns The nestcript instance passed to your script's main entry point
     * @param {string} command The ns command that should be invoked to get the desired data (e.g. "ns.getServer('home')" )
     * @param {string?} fName (default "/Temp/{command-name}.txt") The name of the file to which data will be written to disk by a temporary process
     * @param {any[]?} args args to be passed in as arguments to command being run as a new script.
     * @param {boolean?} verbose (default false) If set to true, pid and result of command are logged. */
    async function getNsDataThroughFile(ns, command, fName, args = [], verbose, maxRetries, retryDelayMs, silent) {
        return await getNsDataThroughFile_Custom(ns, getFnRunViaNsExec(ns, daemonHost), command, fName, args, verbose, maxRetries, retryDelayMs, silent);
    }
    function getHomeProcIsAlive(ns) {
        return (pid) => processList(ns, daemonHost, false).some(p => p.pid === pid);
    }

    async function establishMultipliers(ns) {
        log(ns, "establishMultipliers");
        bitNodeMults = await tryGetBitNodeMultipliers_Custom(ns, getNsDataThroughFile);
        if (verbose)
            log(ns, `Bitnode mults:\n  ${Object.keys(bitNodeMults)
                //.filter(k => bitNodeMults[k] != 1.0)
                .map(k => `${k}: ${bitNodeMults[k]}`).join('\n  ')}`);
    }

    class Tool {
        /** @param {({name: string; shortName: string; shouldRun: () => Promise<boolean>; args: string[]; shouldTail: boolean; threadSpreadingAllowed: boolean; ignoreReservedRam: boolean; minRamReq: number, runOptions: RunOptions; })} toolConfig
         * @param {Number} toolCost **/
        constructor(toolConfig, toolCost) {
            this.name = toolConfig.name;
            this.shortName = toolConfig.shortName;
            this.shouldTail = toolConfig.shouldTail ?? false;
            this.args = toolConfig.args || [];
            this.shouldRun = toolConfig.shouldRun;
            // If tools use ram-dodging, they can specify their "real" minimum ram requirement to run without errors on some host
            this.cost = toolConfig.minRamReq ?? toolCost;
            // "Reserved ram" is reserved for helper scripts and ram-dodging. Tools can specify whether or not they ignore reserved ram during execution.
            this.ignoreReservedRam = toolConfig.ignoreReservedRam ?? false;
            // Whether, in general, it's save to spread threads for this tool around to different servers (overridden in some cases)
            this.isThreadSpreadingAllowed = toolConfig.threadSpreadingAllowed === true;
            // New option to control script RunOptions. By default, they are marked as temporary.
            this.runOptions = toolConfig.runOptions ?? { temporary: true };
        }
        /** @param {Server} server
         * @returns {Promise<boolean>} true if the server has a copy of this tool. */
        async existsOnHost(server) {
            return await server.hasFile(this.name);
        }
        /** @param {Server} server
         * @returns {Promise<boolean>} true if the server has this tool and enough ram to run it. */
        async canRun(server) {
            return await server.hasFile(this.name) && server.ramAvailable(this.ignoreReservedRam) >= this.cost;
        };
        /** @param {boolean} allowSplitting - Whether max threads is computed across the largest server, or all servers (defaults to this.isThreadSpreadingAllowed)
         * @returns {number} The maximum number of threads we can run this tool with given the ram present. */
        getMaxThreads(allowSplitting = undefined) {
            if (allowSplitting === undefined)
                allowSplitting = this.isThreadSpreadingAllowed;
            // analyzes the servers array and figures about how many threads can be spooled up across all of them.
            let maxThreads = 0;
            for (const server of getAllServersByFreeRam().filter(s => s.hasRoot())) {
                // Note: To be conservative, we allow double imprecision to cause this floor() to return one less than should be possible,
                //       because the game likely doesn't account for this imprecision (e.g. let 1.9999999999999998 return 1 rather than 2)
                let serverRamAvailable = server.ramAvailable(this.ignoreReservedRam);
                // HACK: Temp script firing before the script gets scheduled can cause further available home ram reduction, don't promise as much from home
                // TODO: Revise this hack, it is technically messing further with the "servers by free ram" sort order. Perhaps an alternative to this approach
                //       is that the scheduler should not be so strict about home reserved ram enforcement if we use thread spreading and save scheduling on home for last?
                if (server.name == "home" && !this.ignoreReservedRam)
                    serverRamAvailable -= homeReservedRam; // Note: Effectively doubles home reserved RAM in cases where we plan to consume all available RAM            
                const threadsHere = Math.max(0, Math.floor(serverRamAvailable / this.cost));
                //log(server.ns, `INFO: Can fit ${threadsHere} threads of ${this.shortName} on ${server.name} (ignoreReserve: ${this.ignoreReservedRam})`)
                if (!allowSplitting)
                    return threadsHere;
                maxThreads += threadsHere;
            }
            return maxThreads;
        }
    }

    /** @param {NS} ns
     * @param {({name: string; shortName: string; shouldRun: () => Promise<boolean>; args: string[]; shouldTail: boolean; threadSpreadingAllowed: boolean; ignoreReservedRam: boolean; minRamReq: number, runOptions: RunOptions; })[]} allTools **/
    async function buildToolkit(ns, allTools) {
        log(ns, "buildToolkit");
        // Fix the file path for each tool if this script was cloned to a sub-directory
        allTools.forEach(script => script.name = getFilePath(script.name));
        // Get the cost (RAM) of each tool from the API
        let toolCosts = await getNsDataThroughFile(ns, `Object.fromEntries(ns.args.map(s => [s, ns.getScriptRam(s, 'home')]))`,
            '/Temp/script-costs.txt', allTools.map(t => t.name));
        // Construct a Tool class instance for each configured item
        const toolsTyped = allTools.map(toolConfig => new Tool(toolConfig, toolCosts[toolConfig.name]));
        toolsByShortName = Object.fromEntries(toolsTyped.map(tool => [tool.shortName || hashToolDefinition(tool), tool]));
        await updatePortCrackers(ns);
        return toolsTyped;
    }

    /** @returns {string} */
    const hashToolDefinition = s => hashCode(s.name + (s.args?.toString() || ''));

    /** @returns {Tool} */
    function getTool(s) {
        //return tools.find(t => t.shortName == (s.shortName || s) || hashToolDefinition(t) == hashToolDefinition(s))
        return toolsByShortName[s] || toolsByShortName[s.shortName || hashToolDefinition(s)];
    }

    const crackNames = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];
    let ownedCracks = [];

    /** Determine which port crackers we own
     * @param {NS} ns */
    async function updatePortCrackers(ns) {
        const owned = await filesExist(ns, crackNames);
        ownedCracks = crackNames.filter((s, i) => owned[i]);
    }

    // script entry point
    /** @param {NS} ns **/
    async function startup_withRetries(ns) {
        let startupAttempts = 0;
        while (startupAttempts++ <= 5) {
            try {
                await startup(ns);
            } catch (err) {
                if (startupAttempts == 5)
                    log(ns, `ERROR: daemon.js Keeps catching a fatal error during startup: ${getErrorInfo(err)}`, true, 'error');
                else {
                    log(ns, `WARN: daemon.js Caught an error during startup: ${getErrorInfo(err)}` +
                        `\nWill try again (attempt ${startupAttempts} of 5)`, false, 'warning');
                    await ns.sleep(5000);
                }
            }
        }
    }

    // Start daemon.js
    await startup_withRetries(ns);
}
