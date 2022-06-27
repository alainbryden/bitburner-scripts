import {
    formatMoney, formatRam, formatDuration, formatDateTime, formatNumber,
    scanAllServers, hashCode, disableLogs, log, getFilePath, getConfiguration,
    getNsDataThroughFile_Custom, runCommand_Custom, waitForProcessToComplete_Custom,
    tryGetBitNodeMultipliers_Custom, getActiveSourceFiles_Custom,
    getFnRunViaNsExec, getFnIsAliveViaNsPs, autoRetry
} from './helpers.js'

// daemon.js has histocially been the central orchestrator of almost every script in the game.
// Only recently has it been "enslaved" to an even higher-level orchestrator: autopilot.js
// Its primary job is to manage hacking servers for income, but it also manages launching
// a myriad of helper scripts to take advantage of other game mechanics (such as solving coding contraacts)

// NOTE: This is the the oldest piece of code in the repo and is a mess of global properties and
//       functions scattered all over the place. I'll try to clean it up and organize it better over time
//       but my appologies if you are trying to read it. Other scripts should serve as better examples.

// These parameters are meant to let you tweak the script's behaviour from the command line (without altering source code)
let options;
const argsSchema = [
    ['h', false], // Do nothing but hack, no prepping (drains servers to 0 money, if you want to do that for some reason)
    ['hack-only', false], // Same as above
    ['s', true], // Enable Stock Manipulation. This is now true for default, but left as a valid argument for backwards-compatibility.
    ['stock-manipulation', true], // Same as above
    ['disable-stock-manipulation', false], // You must now opt *out* of stock-manipulation mode by enabling this flag.
    ['stock-manipulation-focus', false], // Stocks are main source of income - kill any scripts that would do them harm (TODO: Enable automatically in BN8)
    ['v', false], // Detailed logs about batch scheduling / tuning
    ['verbose', false], // Same as above
    ['o', false], // Good for debugging, run the main targettomg loop once then stop, with some extra logs
    ['run-once', false], // Same as above
    ['x', false], // Focus on a strategy that produces the most hack EXP rather than money
    ['xp-only', false], // Same as above
    ['n', false], // Can toggle on using hacknet nodes for extra hacking ram (at the expense of hash production)
    ['use-hacknet-nodes', false], // Same as above
    ['spend-hashes-for-money-when-under', 10E6], // (Default 10m) Convert 4 hashes to money whenever we're below this amount
    ['disable-spend-hashes', false], // An easy way to set the above to a very large negative number, thus never spending hashes for Money
    ['silent-misfires', false], // Instruct remote scripts not to alert when they misfire
    ['initial-max-targets', 2], // Initial number of servers to target / prep (TODO: Scale this as BN progression increases)
    ['max-steal-percentage', 0.75], // Don't steal more than this in case something goes wrong with timing or scheduling, it's hard to recover from
    ['cycle-timing-delay', 16000], // Time
    ['queue-delay', 1000], // Delay before the first script begins, to give time for all scripts to be scheduled
    ['max-batches', 40], // Maximum overlapping cycles to schedule in advance. Note that once scheduled, we must wait for all batches to complete before we can schedule more
    ['i', false], // Farm intelligence with manual hack.
    ['reserved-ram', 32], // Keep this much home RAM free when scheduling hack/grow/weaken cycles on home.
    ['looping-mode', false], // Set to true to attempt to schedule perpetually-looping tasks.
    ['recovery-thread-padding', 1], // Multiply the number of grow/weaken threads needed by this amount to automatically recover more quickly from misfires.
    ['share', false], // Enable sharing free ram to increase faction rep gain (enabled automatically once RAM is sufficient)
    ['no-share', false], // Disable sharing free ram to increase faction rep gain
    ['share-cooldown', 5000], // Wait before attempting to schedule more share threads (e.g. to free RAM to be freed for hack batch scheduling first)
    ['share-max-utilization', 0.8], // Set to 1 if you don't care to leave any RAM free after sharing. Will use up to this much of the available RAM
    ['no-tail-windows', false], // Set to true to prevent the default behaviour of opening a tail window for certain launched scripts. (Doesn't affect scripts that open their own tail windows)
    ['initial-study-time', 10], // Seconds. Set to 0 to not do any studying at startup. By default, if early in an augmentation, will start with a little study to boost hack XP
    ['initial-hack-xp-time', 10], // Seconds. Set to 0 to not do any hack-xp grinding at startup. By default, if early in an augmentation, will start with a little study to boost hack XP
    ['disable-script', []], // The names of scripts that you do not want run by our scheduler
    ['run-script', []], // The names of additional scripts that you want daemon to run on home
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (lastFlag == "--disable-script" || lastFlag == "--run-script")
        return data.scripts;
    return [];
}

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
let cycleTimingDelay; // (Set in command line args)
let queueDelay; // (Set in command line args) The delay that it can take for a script to start, used to pessimistically schedule things in advance
let maxBatches; // (Set in command line args) The max number of batches this daemon will spool up to avoid running out of IRL ram (TODO: Stop wasting RAM by scheduling batches so far in advance. e.g. Grind XP while waiting for cycle start!)
let maxTargets; // (Set in command line args) Initial value, will grow if there is an abundance of RAM
let maxPreppingAtMaxTargets = 3; // The max servers we can prep when we're at our current max targets and have spare RAM
// Allows some home ram to be reserved for ad-hoc terminal script running and when home is explicitly set as the "preferred server" for starting a helper
let homeReservedRam; // (Set in command line args)

let allHostNames = []; // simple name array of servers that have been discovered
let _allServers = []; // Array of Server objects - our internal model of servers for hacking
// Lists of tools (external scripts) run
let hackTools, asynchronousHelpers, periodicScripts;
// toolkit var for remembering the names and costs of the scripts we use the most
let toolsByShortName; // Dictionary of tools keyed by tool short name
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
let currentTerminalServer; // Periodically updated when intelligence farming, the current connected terminal server.
let dictSourceFiles; // Available source files
let bitnodeMults = null; // bitnode multipliers that can be automatically determined after SF-5
let playerBitnode = 0;
/** @returns {Player} Trick to get TS to detect the correct type for the global "_cachedPlayerInfo" below. */
let getPlayerType = () => null;
let _cachedPlayerInfo = getPlayerType(); // stores multipliers for player abilities and other player info
/** @returns {NS} Trick to get TS to detect the correct type for the global ns instance below. */
let getNSType = () => null;
let _ns = getNSType(); // Globally available ns reference, for convenience

// Property to avoid log churn if our status hasn't changed since the last loop
let lastUpdate = "";
let lastUpdateTime = Date.now();
let lowUtilizationIterations = 0;
let highUtilizationIterations = 0;
let lastShareTime = 0; // Tracks when share was last invoked so we can respect the configured share-cooldown
let allTargetsPrepped = false;

/** Ram-dodge getting updated player info. Note that this is the only async routine called in the main loop.
 * If latency or ram instability is an issue, you may wish to try uncommenting the direct request.
 * @param {NS} ns
 * @returns {Promise<Player>} */
async function getPlayerInfo(ns) {
    // return _cachedPlayerInfo = ns.getPlayer();
    return _cachedPlayerInfo = await getNsDataThroughFile(ns, `ns.getPlayer()`, '/Temp/player-info.txt');
}

function playerHackSkill() { return _cachedPlayerInfo.hacking; }

function getPlayerHackingGrowMulti() { return _cachedPlayerInfo.hacking_grow_mult };

/** Helper to check if a file exists.
 * A helper is used so that we have the option of exploring alternative implementations that cost less/no RAM.
 * @param {NS} ns */
function doesFileExist(ns, filename, hostname = undefined) { return ns.fileExists(filename, hostname); }

let psCache = [];
/** PS can get expensive, and we use it a lot so we cache this for the duration of a loop
 * @param {NS} ns */
function ps(ns, server, canUseCache = true) {
    const cachedResult = psCache[server];
    return canUseCache && cachedResult ? cachedResult : (psCache[server] = ns.ps(server));
}

// Returns the amount of money we should currently be reserving. Dynamically adapts to save money for a couple of big purchases on the horizon
function reservedMoney(ns) {
    let shouldReserve = Number(ns.read("reserve.txt") || 0);
    let playerMoney = ns.getServerMoneyAvailable("home");
    if (!doesFileExist(ns, "SQLInject.exe", "home") && playerMoney > 200e6)
        shouldReserve += 250e6; // Start saving at 200m of the 250m required for SQLInject
    const fourSigmaCost = (bitnodeMults.FourSigmaMarketDataApiCost * 25000000000);
    if (!_cachedPlayerInfo.has4SDataTixApi && playerMoney >= fourSigmaCost / 2)
        shouldReserve += fourSigmaCost; // Start saving if we're half-way to buying 4S market access
    return shouldReserve;
}

// script entry point
/** @param {NS} ns **/
export async function main(ns) {
    daemonHost = "home"; // ns.getHostname(); // get the name of this node (realistically, will always be home)
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions) return;

    // Ensure no other copies of this script are running (they share memory)
    const scriptName = ns.getScriptName();
    const competingDaemons = ns.ps("home").filter(s => s.filename == scriptName && JSON.stringify(s.args) != JSON.stringify(ns.args));
    if (competingDaemons.length > 0) { // We expect only 1, due to this logic, but just in case, generalize the code below to support multiple.
        const daemonPids = competingDaemons.map(p => p.pid);
        log(ns, `Info: Restarting another '${scriptName}' instance running on home (pid: ${daemonPids} args: ` +
            `[${competingDaemons[0].args.join(", ")}]) with new args ([${ns.args.join(", ")}])...`, true)
        const killPid = await killProcessIds(ns, daemonPids);
        await waitForProcessToComplete_Custom(ns, getFnIsAliveViaNsPs(ns), killPid);
        await ns.sleep(loopInterval); // The game can be slow to kill scripts, give it an extra bit of time.
    }

    _ns = ns;
    disableLogs(ns, ['getServerMaxRam', 'getServerUsedRam', 'getServerMoneyAvailable', 'getServerGrowth', 'getServerSecurityLevel', 'exec', 'scan', 'sleep']);
    // Reset global vars on startup since they persist in memory in certain situations (such as on Augmentation)
    lastUpdate = "";
    lastUpdateTime = Date.now();
    maxTargets = 2;
    lowUtilizationIterations = highUtilizationIterations = 0;
    allHostNames = [], _allServers = [], psCache = [];

    const playerInfo = await getPlayerInfo(ns);
    playerBitnode = playerInfo.bitNodeN;
    dictSourceFiles = await getActiveSourceFiles_Custom(ns, getNsDataThroughFile);
    log(ns, "The following source files are active: " + JSON.stringify(dictSourceFiles));

    // Process configuration
    options = runOptions;
    hackOnly = options.h || options['hack-only'];
    xpOnly = options.x || options['xp-only'];
    stockMode = (options.s || options['stock-manipulation'] || options['stock-manipulation-focus']) && !options['disable-stock-manipulation'];
    stockFocus = options['stock-manipulation-focus'] && !options['disable-stock-manipulation'];
    useHacknetNodes = options.n || options['use-hacknet-nodes'];
    verbose = options.v || options['verbose'];
    runOnce = options.o || options['run-once'];
    loopingMode = options['looping-mode'];
    recoveryThreadPadding = options['recovery-thread-padding'];
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
        cycleTimingDelay = 0;
        queueDelay = 0;
        if (recoveryThreadPadding == 1) recoveryThreadPadding = 10;
        if (stockMode) stockFocus = true; // Need to actively kill scripts that go against stock because they will live forever
    }
    cycleTimingDelay = options['cycle-timing-delay'];
    queueDelay = options['queue-delay'];
    maxBatches = options['max-batches'];
    homeReservedRam = options['reserved-ram']

    // These scripts are started once and expected to run forever (or terminate themselves when no longer needed)
    const openTailWindows = !options['no-tail-windows'];
    const reqRam = (ram) => ns.getServerMaxRam("home") >= ram; // To avoid wasting precious RAM, many scripts don't launch unless we have more than a certain amount
    asynchronousHelpers = [
        { name: "stats.js", shouldRun: () => reqRam(64) }, // Adds stats not usually in the HUD
        { name: "stockmaster.js", shouldRun: () => reqRam(64), args: openTailWindows ? ["--show-market-summary"] : [], tail: openTailWindows }, // Start our stockmaster
        { name: "hacknet-upgrade-manager.js", shouldRun: () => reqRam(64), args: ["-c", "--max-payoff-time", "1h"] }, // Kickstart hash income by buying everything with up to 1h payoff time immediately
        { name: "spend-hacknet-hashes.js", args: [], shouldRun: () => reqRam(64) && 9 in dictSourceFiles }, // Always have this running to make sure hashes aren't wasted
        { name: "sleeve.js", tail: openTailWindows, shouldRun: () => 10 in dictSourceFiles }, // Script to create manage our sleeves for us
        { name: "gangs.js", tail: openTailWindows, shouldRun: () => reqRam(64) && 2 in dictSourceFiles }, // Script to create manage our gang for us
        {
            name: "work-for-factions.js", args: ['--fast-crimes-only', '--no-coding-contracts'],  // Singularity script to manage how we use our "focus" work.
            shouldRun: () => 4 in dictSourceFiles && reqRam(256 / (2 ** dictSourceFiles[4]) && !studying) // Higher SF4 levels result in lower RAM requirements
        },
        {   // Script to create manage bladeburner for us
            name: "bladeburner.js", tail: openTailWindows,
            shouldRun: () => 7 in dictSourceFiles && (_cachedPlayerInfo.inBladeburner || [6, 7].includes(playerBitnode))
        },
    ];
    asynchronousHelpers.forEach(helper => helper.name = getFilePath(helper.name));
    // Add any additional scripts to be run provided by --run-script arguments
    options['run-script'].forEach(s => asynchronousHelpers.push({ name: s }));
    asynchronousHelpers.forEach(helper => helper.isLaunched = false);
    asynchronousHelpers.forEach(helper => helper.requiredServer = "home"); // All helpers should be launched at home since they use tempory scripts, and we only reserve ram on home
    // These scripts are spawned periodically (at some interval) to do their checks, with an optional condition that limits when they should be spawned
    let shouldUpgradeHacknet = () => (whichServerIsRunning(ns, "hacknet-upgrade-manager.js", false) === null) && reservedMoney(ns) < ns.getServerMoneyAvailable("home");
    // In BN8 (stocks-only bn) and others with hack income disabled, don't waste money on improving hacking infrastructure unless we have plenty of money to spare
    let shouldImproveHacking = () => bitnodeMults.ScriptHackMoneyGain != 0 && playerBitnode != 8 || ns.getServerMoneyAvailable("home") > 1e12;
    // Note: Periodic script are generally run every 30 seconds, but intervals are spaced out to ensure they aren't all bursting into temporary RAM at the same time.
    periodicScripts = [
        // Buy tor as soon as we can if we haven't already, and all the port crackers (exception: don't buy 2 most expensive port crackers until later if in a no-hack BN)
        { interval: 25000, name: "/Tasks/tor-manager.js", shouldRun: () => 4 in dictSourceFiles && !allHostNames.includes("darkweb") },
        { interval: 26000, name: "/Tasks/program-manager.js", shouldRun: () => 4 in dictSourceFiles && getNumPortCrackers(ns) != 5 },
        { interval: 27000, name: "/Tasks/contractor.js", requiredServer: "home" }, // Periodically look for coding contracts that need solving
        // Buy every hacknet upgrade with up to 4h payoff if it is less than 10% of our current money or 8h if it is less than 1% of our current money.
        { interval: 28000, name: "hacknet-upgrade-manager.js", shouldRun: shouldUpgradeHacknet, args: () => ["-c", "--max-payoff-time", "4h", "--max-spend", ns.getServerMoneyAvailable("home") * 0.1] },
        { interval: 28500, name: "hacknet-upgrade-manager.js", shouldRun: shouldUpgradeHacknet, args: () => ["-c", "--max-payoff-time", "8h", "--max-spend", ns.getServerMoneyAvailable("home") * 0.01] },
        // Buy upgrades regardless of payoff if they cost less than 0.1% of our money
        { interval: 29000, name: "hacknet-upgrade-manager.js", shouldRun: shouldUpgradeHacknet, args: () => ["-c", "--max-payoff-time", "1E100h", "--max-spend", ns.getServerMoneyAvailable("home") * 0.001] },
        {
            interval: 30000, name: "/Tasks/ram-manager.js", args: () => ['--budget', 0.5, '--reserve', reservedMoney(ns)], // Spend about 50% of un-reserved cash on home RAM upgrades (permanent) when they become available
            shouldRun: () => 4 in dictSourceFiles && shouldImproveHacking() // Only trigger if hack income is important
        },
        {   // Periodically check for new faction invites and join if deemed useful to be in that faction. Also determines how many augs we could afford if we installed right now
            interval: 31000, name: "faction-manager.js", requiredServer: "home", args: ['--verbose', 'false'],
            // Don't start auto-joining factions until we're holding 1 billion (so coding contracts returning money is probably less critical) or we've joined one already
            shouldRun: () => 4 in dictSourceFiles && (_cachedPlayerInfo.factions.length > 0 || ns.getServerMoneyAvailable("home") > 1e9) &&
                (ns.getServerMaxRam("home") >= 128 / (2 ** dictSourceFiles[4])) // Uses singularity functions, and higher SF4 levels result in lower RAM requirements
        },
        {   // Periodically look to purchase new servers, but note that these are often not a great use of our money (hack income isn't everything) so we may hold-back.
            interval: 32000, name: "host-manager.js", requiredServer: "home",
            // Funky heuristic warning: I find that new players with fewer SF levels under their belt are obsessed with hack income from servers,
            // but established players end up finding auto-purchased hosts annoying - so now the % of money we spend shrinks as SF levels grow.
            args: () => ['--reserve-percent', Math.min(0.9, 0.1 * Object.values(dictSourceFiles).reduce((t, v) => t + v, 0)), '--absolute-reserve', reservedMoney(ns), '--utilization-trigger', '0'],
            shouldRun: () => {
                if (!shouldImproveHacking()) return false; // Skip if hack income is not important in this BN or at this time
                let utilization = getTotalNetworkUtilization(); // Utilization-based heuristics for when we likely could use more RAM for hacking
                return utilization >= maxUtilization || utilization > 0.80 && maxTargets < 20 || utilization > 0.50 && maxTargets < 5;
            }
        },
        // Check if any new servers can be backdoored. If there are many, this can eat up a lot of RAM, so make this the last script scheduled at startup.
        { interval: 33000, name: "/Tasks/backdoor-all-servers.js", requiredServer: "home", shouldRun: () => 4 in dictSourceFiles },
    ];
    periodicScripts.forEach(tool => tool.name = getFilePath(tool.name));
    hackTools = [
        { name: "/Remote/weak-target.js", shortName: "weak", threadSpreadingAllowed: true },
        { name: "/Remote/grow-target.js", shortName: "grow" },
        { name: "/Remote/hack-target.js", shortName: "hack" },
        { name: "/Remote/manualhack-target.js", shortName: "manualhack" },
        { name: "/Remote/share.js", shortName: "share", threadSpreadingAllowed: true },
    ];
    hackTools.forEach(tool => tool.name = getFilePath(tool.name));

    await buildToolkit(ns, [...asynchronousHelpers, ...periodicScripts, ...hackTools]); // build toolkit
    await getStaticServerData(ns, scanAllServers(ns)); // Gather information about servers that will never change
    buildServerList(ns); // create the exhaustive server list
    await establishMultipliers(ns); // figure out the various bitnode and player multipliers
    maxTargets = stockFocus ? Object.keys(serverStockSymbols).length : options['initial-max-targets']; // Ensure we immediately attempt to target all servers that represent stocks if in stock-focus mode

    // If we ascended less than 10 minutes ago, start with some study and/or XP cycles to quickly restore hack XP
    const shouldKickstartHackXp = (playerHackSkill() < 500 && playerInfo.playtimeSinceLastAug < 600000);
    studying = shouldKickstartHackXp ? true : false; // Flag will prevent focus-stealing scripts from running until we're done studying.

    // Start helper scripts and run periodic scripts for the first time to e.g. buy tor and any hack tools available to us (we will continue studying briefly while this happens)
    await runStartupScripts(ns);
    await runPeriodicScripts(ns);
    if (shouldKickstartHackXp) await kickstartHackXp(ns);

    // Start the main targetting loop
    await doTargetingLoop(ns);
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
                const money = ns.getServerMoneyAvailable("home")
                if (money >= 200000) // If we can afford to travel, we're probably far enough along that it's worthwhile going to Volhaven where ZB university is.
                    await getNsDataThroughFile(ns, `ns.travelToCity("Volhaven")`, '/Temp/travel-to-city.txt');
                const playerInfo = await getPlayerInfo(); // Update player stats to be certain of our new location.
                const university = playerInfo.city == "Sector-12" ? "Rothman University" : playerInfo.city == "Aevum" ? "Summit University" : playerInfo.city == "Volhaven" ? "ZB Institute of Technology" : null;
                if (!university)
                    log(ns, `INFO: Cannot study, because you are in city ${playerInfo.city} which has no known university, and you cannot afford to travel to another city.`);
                else {
                    const course = playerInfo.city == "Sector-12" ? "Study Computer Science" : "Algorithms"; // Assume if we are still in Sector-12 we are poor and should only take the free course
                    await getNsDataThroughFile(ns, `ns.universityCourse(ns.args[0], ns.args[1], ns.args[2])`, '/Temp/study.txt', [university, course, false]);
                    startedStudying = true;
                    await ns.sleep(studyTime * 1000); // Wait for studies to affect Hack XP. This will often greatly reduce time-to-hack/grow/weaken, and avoid a slow first cycle
                }
            } catch { log(ns, 'WARNING: Failed to study to kickstart hack XP', false, 'warning'); }
        }
        // Immediately attempt to root initially-accessible targets before attempting any XP cycles
        for (const server of getAllServers().filter(s => !s.hasRoot() && s.canCrack()))
            await doRoot(ns, server);
        // Before starting normal hacking, fire a couple hack XP-focused cycle using a chunk of free RAM to further boost RAM
        if (!xpOnly) {
            let maxXpCycles = 10;
            const maxXpTime = options['initial-hack-xp-time'];
            const start = Date.now();
            const minCycleTime = getBestXPFarmTarget().timeToWeaken();
            if (minCycleTime > maxXpTime * 1000)
                return log(ns, `INFO: Skipping XP cycle because the best target (${getBestXPFarmTarget().name}) time to weaken (${formatDuration(minCycleTime)})` +
                    ` is greater than the configured --initial-hack-xp-time of ${maxXpTime} seconds.`);
            log(ns, `INFO: Running Hack XP-focused cycles for ${maxXpTime} seconds to further boost hack XP and speed up main hack cycle times. (set --initial-hack-xp-time 0 to disable this step.)`);
            while (maxXpCycles-- > 0 && Date.now() - start < maxXpTime * 1000) {
                let cycleTime = await farmHackXp(ns, 1, verbose, 1);
                if (cycleTime)
                    await ns.sleep(cycleTime);
                else
                    return log(ns, 'WARNING: Failed to schedule an XP cycle', false, 'warning');
            }
        }
    } catch {
        log(ns, 'WARNING: Encountered an error while trying to kickstart hack XP (low RAM issues perhaps?)', false, 'warning');
    } finally {
        // Ensure we stop studying (in case no other running scripts end up stealing focus, so we don't keep studying forever)
        if (startedStudying) await getNsDataThroughFile(ns, `ns.stopAction()`, '/Temp/stop-action.txt');
        studying = false; // This will allow work-for-faction to launch
    }
}

/** Check running status of scripts on servers
 * @param {NS} ns
 * @returns {string} */
function whichServerIsRunning(ns, scriptName, canUseCache = true) {
    for (const server of getAllServers())
        if (ps(ns, server.name, canUseCache).some(process => process.filename === scriptName))
            return server.name;
    return null;
}

/** Helper to kick off external scripts
 * @param {NS} ns
 * @returns {boolean} true if all scripts have been launched */
async function runStartupScripts(ns) {
    let launched = 0;
    for (const helper of asynchronousHelpers) {
        if (!helper.isLaunched && (helper.shouldRun === undefined || helper.shouldRun())) {
            if (launched > 0) await ns.sleep(200); // Sleep a short while between each script being launched, so they aren't all fighting for temp RAM at the same time.
            helper.isLaunched = await tryRunTool(ns, getTool(helper))
            if (helper.isLaunched) launched++;
        }
    }
    // if every helper is launched already return "true" so we can skip doing this each cycle going forward.
    return asynchronousHelpers.reduce((allLaunched, tool) => allLaunched && tool.isLaunched, true);
}

/** Checks whether it's time for any scheduled tasks to run
 * @param {NS} ns */
async function runPeriodicScripts(ns) {
    let launched = 0;
    for (const task of periodicScripts) {
        let tool = getTool(task);
        if ((Date.now() - (task.lastRun || 0) >= task.interval) && (task.shouldRun === undefined || task.shouldRun())) {
            task.lastRun = Date.now()
            if (launched > 0) await ns.sleep(11); // Sleep a short while between each script being launched, so they aren't all fighting for temp RAM at the same time.
            if (await tryRunTool(ns, tool))
                launched++;
        }
    }
    // Super-early aug, if we are poor, spend hashes as soon as we get them for a quick cash injection. (Only applies if we have hacknet servers)
    if (9 in dictSourceFiles && !options['disable-spend-hashes'] // See if we have a hacknet, and spending hashes for money isn't disabled
        && ns.getServerMoneyAvailable("home") < options['spend-hashes-for-money-when-under'] // Only if money is below the configured threshold
        && (ns.getServerMaxRam("home") - ns.getServerUsedRam("home")) >= 5.6) { // Ensure we have spare RAM to run this temp script
        await runCommand(ns, `0; if(ns.hacknet.spendHashes("Sell for Money")) ns.toast('Sold 4 hashes for \$1M', 'success')`, '/Temp/sell-hashes-for-money.js');
    }
}

// Helper that gets the either invokes a function that returns a value, or returns the value as-is if it is not a function.
const funcResultOrValue = fnOrVal => (fnOrVal instanceof Function ? fnOrVal() : fnOrVal);

/** Returns true if the tool is running (including if it was already running), false if it could not be run.
 * @param {NS} ns
 * @param {Tool} tool */
async function tryRunTool(ns, tool) {
    if (options['disable-script'].includes(tool.name)) {
        if (verbose) log(ns, `Tool ${tool.name} was not launched as it was specified with --disable-script`);
        return false;
    }
    if (!doesFileExist(ns, tool.name)) {
        log(ns, `ERROR: Tool ${tool.name} was not found on ${daemonHost}`, true, 'error');
        return false;
    }
    let runningOnServer = whichServerIsRunning(ns, tool.name);
    if (runningOnServer != null) {
        if (verbose) log(ns, `INFO: Tool ${tool.name} is already running on server ${runningOnServer}.`);
        return true;
    }
    const args = funcResultOrValue(tool.args) || []; // Support either a static args array, or a function returning the args.
    const runResult = await arbitraryExecution(ns, tool, 1, args, tool.requiredServer || "home");
    if (runResult) {
        runningOnServer = whichServerIsRunning(ns, tool.name, false);
        if (verbose) log(ns, `Ran tool: ${tool.name} ` + (args.length > 0 ? `with args ${JSON.stringify(args)} ` : '') + (runningOnServer ? `on server ${runningOnServer}.` : 'but it shut down right away.'));
        if (tool.tail === true && runningOnServer) {
            log(ns, `Tailing Tool: ${tool.name} on server ${runningOnServer}` + (args.length > 0 ? ` with args ${JSON.stringify(args)}` : ''));
            ns.tail(tool.name, runningOnServer, ...args);
            //tool.tail = false; // Avoid popping open additional tail windows in the future
        }
        return true;
    } else
        log(ns, `WARNING: Tool cannot be run (insufficient RAM? REQ: ${formatRam(tool.cost)} FREE: ${formatRam(ns.getServerMaxRam("home") - ns.getServerUsedRam("home"))}): ${tool.name}`, false, 'warning');
    return false;
}

let dictScriptsRun = {}; // Keep a cache of every script run on every host, and sleep if it's our first run (to work around a bitburner bug)

/** Workaround a current bitburner bug by yeilding briefly to the game after executing something.
 * @param {NS} ns
 * @param {String} script - Filename of script to execute.
 * @param {int} host - Hostname of the target server on which to execute the script.
 * @param {int} numThreads - Optional thread count for new script. Set to 1 by default. Will be rounded to nearest integer.
 * @param args - Additional arguments to pass into the new script that is being run. Note that if any arguments are being passed into the new script, then the third argument numThreads must be filled in with a value.
 * @returns — Returns the PID of a successfully started script, and 0 otherwise.
 * Workaround a current bitburner bug by yeilding briefly to the game after executing something. **/
async function exec(ns, script, host, numThreads, ...args) {
    // Try to run the script with auto-retry if it fails to start
    // It doesn't make sense to auto-retry hack tools, only add error handling to other scripts
    if (hackTools.some(h => h.name === script))
        return ns.exec(script, host, numThreads, ...args);
    // Otherwise, run with auto-retry to handle e.g. temporary ram issues
    const pid = await autoRetry(ns, async () => {
        const p = ns.exec(script, host, numThreads, ...args)
        return p;
    }, p => p !== 0, () => new Error(`Failed to exec ${script} on ${host} with ${numThreads} threads. ` +
        `This is likely due to having insufficient RAM. Args were: [${args}]`),
        undefined, undefined, undefined, verbose, verbose);
    return pid; // Caller is responsible for handling errors if final pid returned is 0 (indicating failure)
}

/** @param {NS} ns
 * @param {Server} server
 * Execute an external script that roots a server, and wait for it to complete. **/
async function doRoot(ns, server) {
    if (verbose) log(ns, `Rooting Server ${server.name}`);
    const pid = await exec(ns, getFilePath('/Tasks/crack-host.js'), 'home', 1, server.name);
    await waitForProcessToComplete_Custom(ns, getFnIsAliveViaNsPs(ns), pid);
}

// Main targeting loop
/** @param {NS} ns **/
async function doTargetingLoop(ns) {
    log(ns, "doTargetingLoop");
    let loops = -1;
    //var isHelperListLaunched = false; // Uncomment this and related code to keep trying to start helpers
    do {
        loops++;
        if (loops > 0) await ns.sleep(loopInterval);
        try {
            let start = Date.now();
            psCache = []; // Clear the cache of the process list we update once per loop
            buildServerList(ns, true); // Check if any new servers have been purchased by the external host_manager process
            const playerInfo = await getPlayerInfo(ns); // Update player info
            // Run some auxilliary processes that ease the ram burden of this daemon and add additional functionality (like managing hacknet or buying servers)
            await runPeriodicScripts(ns);

            if (stockMode) await updateStockPositions(ns); // In stock market manipulation mode, get our current position in all stocks
            const targetingOrder = getAllServersByTargetOrder();

            if (loops % 60 == 0) { // For more expensive updates, only do these every so often
                // If we have not yet launched all helpers (e.g. awaiting more home ram, or TIX API to be purchased) see if any are now ready to be run
                if (!allHelpersRunning) allHelpersRunning = await runStartupScripts(ns);
                // Pull additional data about servers that infrequently changes
                await refreshDynamicServerData(ns, allHostNames);
                // Occassionally print our current targetting order (todo, make this controllable with a flag or custom UI?)
                if (verbose && loops % 600 == 0) {
                    const targetsLog = 'Targetting Order:\n  ' + targetingOrder.filter(s => s.shouldHack()).map(s =>
                        `${s.isPrepped() ? '*' : ' '} ${s.canHack() ? '✓' : 'X'} Money: ${formatMoney(s.getMoney(), 4)} of ${formatMoney(s.getMaxMoney(), 4)} ` +
                        `(${formatMoney(s.getMoneyPerRamSecond(), 4)}/ram.sec), Sec: ${formatNumber(s.getSecurity(), 3)} of ${formatNumber(s.getMinSecurity(), 3)}, ` +
                        `TTW: ${formatDuration(s.timeToWeaken())}, Hack: ${s.requiredHackLevel} - ${s.name}` +
                        (!stockMode || !serverStockSymbols[s.name] ? '' : ` Sym: ${serverStockSymbols[s.name]} Owned: ${serversWithOwnedStock.includes(s.name)} ` +
                            `Manip: ${shouldManipulateGrow[s.name] ? "grow" : shouldManipulateHack[s.name] ? "hack" : '(disabled)'}`))
                        .join('\n  ');
                    log(ns, targetsLog);
                    await ns.write("/Temp/targets.txt", targetsLog, "w");
                }
            }
            // Processed servers will be split into various lists for generating a summary at the end
            const prepping = [], preppedButNotTargeting = [], targeting = [], notRooted = [], cantHack = [],
                cantHackButPrepped = [], cantHackButPrepping = [], noMoney = [], failed = [], skipped = [];
            var lowestUnhackable = 99999;

            // Hack: We can get stuck and never improve if we don't try to prep at least one server to improve our future targeting options.
            // So get the first un-prepped server that is within our hacking level, and move it to the front of the list.
            var firstUnpreppedServerIndex = targetingOrder.findIndex(s => s.shouldHack() && s.canHack() && !s.isPrepped() && !s.isTargeting())
            if (firstUnpreppedServerIndex !== -1 && !stockMode)
                targetingOrder.unshift(targetingOrder.splice(firstUnpreppedServerIndex, 1)[0]);

            // If this gets set to true, the loop will continue (e.g. to gather information), but no more work will be scheduled
            var workCapped = false;
            // Function to assess whether we've hit some cap that should prevent us from scheduling any more work
            let isWorkCapped = () => workCapped = workCapped || failed.length > 0 // Scheduling fails when there's insufficient RAM. We've likely encountered a "soft cap" on ram utilization e.g. due to fragmentation
                || getTotalNetworkUtilization() >= maxUtilization // "hard cap" on ram utilization, can be used to reserve ram or reduce the rate of encountering the "soft cap"
                || targeting.length >= maxTargets // variable cap on the number of simultaneous targets
                || (targeting.length + prepping.length) >= (maxTargets + maxPreppingAtMaxTargets); // Only allow a couple servers to be prepped in advance when at max-targets

            // check for servers that need to be rooted
            // simultaneously compare our current target to potential targets
            for (var i = 0; i < targetingOrder.length; i++) {
                if ((Date.now() - start) >= maxLoopTime) { // To avoid lagging the game, completely break out of the loop if we start to run over
                    skipped.push(...targetingOrder.slice(i));
                    workCapped = true;
                    break;
                }

                const server = targetingOrder[i];
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
                    else if (server.isPrepping())
                        cantHackButPrepping.push(server);
                } else if (server.isTargeting()) { // Note servers already being targeted from a prior loop
                    targeting.push(server); // TODO: Switch to continuously queing batches in the seconds leading up instead of far in advance with large delays
                } else if (server.isPrepping()) { // Note servers already being prepped from a prior loop
                    prepping.push(server);
                } else if (isWorkCapped() || xpOnly) { // Various conditions for which we'll postpone any additional work on servers
                    if (xpOnly && (((nextXpCycleEnd[server.name] || 0) > start - 10000) || server.isXpFarming()))
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
                    var performanceSnapshot = optimizePerformanceMetrics(ns, server); // Adjust the percentage to steal for optimal scheduling
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
                if (lowUtilizationIterations >= 5 && targeting.length == maxTargets && maxTargets < allHostNames.length - noMoney.length) {
                    let network = getNetworkStats();
                    let utilizationPercent = network.totalUsedRam / network.totalMaxRam;
                    if (utilizationPercent < lowUtilizationThreshold / 2) maxTargets++;
                }
            }

            // Mini-loop for servers that we can't hack yet, but might have access to soon, we can at least prep them.
            if (!isWorkCapped() && cantHack.length > 0 && !hackOnly && !xpOnly) {
                // Prep in order of soonest to become available to us
                cantHack.sort(function (a, b) {
                    var diff = a.requiredHackLevel - b.requiredHackLevel;
                    return diff != 0.0 ? diff : b.getMoneyPerRamSecond() - a.getMoneyPerRamSecond(); // Break ties by sorting by max-money
                });
                // Try to prep them all unless one of our capping rules are hit
                // TODO: Something was not working right here (might be working now that prep code is fixed) so we can probably start prepping more than 1 server again.
                for (var j = 0; j < 1 /*cantHack.length*/; j++) {
                    const server = cantHack[j];
                    if (isWorkCapped()) break;
                    if (cantHackButPrepped.includes(server) || cantHackButPrepping.includes(server))
                        continue;
                    var prepResult = await prepServer(ns, server);
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

            // If we've been at low utilization for longer than the cycle of all our targets, we can add a target
            let intervalsPerTargetCycle = targeting.length == 0 ? 120 :
                Math.ceil((targeting.reduce((max, t) => Math.max(max, t.timeToWeaken()), 0) + cycleTimingDelay) / loopInterval);
            //log(ns, `intervalsPerTargetCycle: ${intervalsPerTargetCycle} lowUtilizationIterations: ${lowUtilizationIterations} loopInterval: ${loopInterval}`);
            if (lowUtilizationIterations > intervalsPerTargetCycle && skipped.length > 0) {
                maxTargets++;
                log(ns, `Increased max targets to ${maxTargets} since utilization (${formatNumber(utilizationPercent * 100, 3)}%) has been quite low for ${lowUtilizationIterations} iterations.`);
                lowUtilizationIterations = 0; // Reset the counter of low-utilization iterations
            } else if (highUtilizationIterations > 60) { // Decrease max-targets by 1 ram utilization is too high (prevents scheduling efficient cycles)
                maxTargets -= 1;
                log(ns, `Decreased max targets to ${maxTargets} since utilization has been > ${formatNumber(maxUtilization * 100, 3)}% for 60 iterations and scheduling failed.`);
                highUtilizationIterations = 0; // Reset the counter of high-utilization iterations
            }
            maxTargets = Math.max(maxTargets, targeting.length - 1, 1); // Ensure that after a restart, maxTargets start off with no less than 1 fewer max targets
            allTargetsPrepped = skipped.length == 0 && prepping.length == 0;

            // If there is still unspent utilization, we can use a chunk of it it to farm XP
            if (xpOnly) { // If all we want to do is gain hack XP
                let time = await farmHackXp(ns, 1.00, verbose);
                loopInterval = Math.min(1000, time || 1000); // Wake up earlier if we're almost done an XP cycle
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
                playerInfo.isWorking && playerInfo.workType == "Working for Faction" && // No point in sharing RAM if we aren't currently working for a faction.
                (Date.now() - lastShareTime) > options['share-cooldown'] && // Respect the share rate-limit if configured to leave gaps for scheduling
                !options['no-share'] && (options['share'] || network.totalMaxRam > 1024)) // If not explicitly enabled or disabled, auto-enable share at 1TB of network RAM
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
            } // else log(ns, `Not Sharing. workCapped: ${isWorkCapped()} utilizationPercent: ${utilizationPercent} maxShareUtilization: ${maxShareUtilization} cooldown: ${formatDuration(Date.now() - lastShareTime)} networkRam: ${network.totalMaxRam}`);

            // Log some status updates
            let keyUpdates = `Of ${allHostNames.length} total servers:\n > ${noMoney.length} were ignored (owned or no money)`;
            if (notRooted.length > 0)
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
                keyUpdates += `\n > Grinding XP from ${targeting.map(s => s.name).join(", ")}`;
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
            // Sometimes a script is shut down by throwing an object contianing internal game script info. Detect this and exit silently
            if (err?.env?.stopFlag) return;
            // Note netscript errors are raised as a simple string (no message property)
            var errorMessage = typeof err === 'string' ? err : err.message || JSON.stringify(err);
            // Catch errors that appear to be caused by deleted servers, and remove the server from our lists.
            const expectedDeletedHostPhrase = "Invalid hostname: ";
            let expectedErrorPhraseIndex = errorMessage.indexOf(expectedDeletedHostPhrase);
            if (expectedErrorPhraseIndex == -1) {
                if (err?.stack) errorMessage += '\n' + err.stack;
                log(ns, `WARNING: daemon.js Caught an error in the targeting loop: ${errorMessage}`, true, 'warning');
                continue;
            }
            let start = expectedErrorPhraseIndex + expectedDeletedHostPhrase.length;
            let lineBreak = errorMessage.indexOf('<br>', start); // Error strings can appear in different ways
            if (lineBreak == -1) lineBreak = errorMessage.indexOf(' ', start); // Try to handle them all
            if (lineBreak == -1) lineBreak = errorMessage.length; // To extract the name of the server deleted
            let deletedHostName = errorMessage.substring(start, lineBreak);
            log(ns, 'INFO: The server "' + deletedHostName + '" appears to have been deleted. Removing it from our lists', true, 'info');
            removeServerByName(ns, deletedHostName);
        }
    } while (!runOnce);
}

// How much a weaken thread is expected to reduce security by
let actualWeakenPotency = () => bitnodeMults.ServerWeakenRate * weakenThreadPotency;

// Dictionaries of static server information
let serversDictCommand = command => `Object.fromEntries(ns.args.map(server => [server, ${command}]))`;
let dictServerRequiredHackinglevels;
let dictServerNumPortsRequired;
let dictServerMinSecurityLevels;
let dictServerMaxMoney;
let dictServerProfitInfo;

// Gathers up arrays of server data via external request to have the data written to disk.
async function getStaticServerData(ns, serverNames) {
    dictServerRequiredHackinglevels = await getNsDataThroughFile(ns, serversDictCommand('ns.getServerRequiredHackingLevel(server)'), '/Temp/servers-hack-req.txt', serverNames);
    dictServerNumPortsRequired = await getNsDataThroughFile(ns, serversDictCommand('ns.getServerNumPortsRequired(server)'), '/Temp/servers-num-ports.txt', serverNames);
    await refreshDynamicServerData(ns, serverNames);
}

/** @param {NS} ns **/
async function refreshDynamicServerData(ns, serverNames) {
    if (verbose) log(ns, "refreshDynamicServerData");
    dictServerMinSecurityLevels = await getNsDataThroughFile(ns, serversDictCommand('ns.getServerMinSecurityLevel(server)'), '/Temp/servers-security.txt', serverNames);
    dictServerMaxMoney = await getNsDataThroughFile(ns, serversDictCommand('ns.getServerMaxMoney(server)'), '/Temp/servers-max-money.txt', serverNames);
    // Get the information about the relative profitability of each server
    const pid = await exec(ns, getFilePath('analyze-hack.js'), 'home', 1, '--all', '--silent');
    await waitForProcessToComplete_Custom(ns, getFnIsAliveViaNsPs(ns), pid);
    dictServerProfitInfo = ns.read('/Temp/analyze-hack.txt');
    if (!dictServerProfitInfo) return log(ns, "WARNING: analyze-hack info unavailable. Will use fallback approach.");
    dictServerProfitInfo = Object.fromEntries(JSON.parse(dictServerProfitInfo).map(s => [s.hostname, s]));
    //ns.print(dictServerProfitInfo);
    if (options.i)
        currentTerminalServer = getServerByName(await getNsDataThroughFile(ns, 'ns.getCurrentServer()', '/Temp/terminal-server.txt'));
}

class Server {
    /** @param {NS} ns
     * @param {string} node - a.k.a host / server **/
    constructor(ns, node) {
        this.ns = ns;
        this.name = node;
        this.requiredHackLevel = dictServerRequiredHackinglevels[node];
        this.portsRequired = dictServerNumPortsRequired[node];
        this.percentageToSteal = 1.0 / 16.0; // This will get tweaked automatically based on RAM available and the relative value of this server
        this.previouslyPrepped = false;
        this.prepRegressions = 0;
        this.previousCycle = null;
        this._hasRootCached = false; // Once we get root, we never lose it, so we can stop asking
    }
    getMinSecurity() { return dictServerMinSecurityLevels[this.name] ?? 0; } // Servers not in our dictionary were purchased, and so undefined is okay
    getMaxMoney() { return dictServerMaxMoney[this.name] ?? 0; }
    getMoneyPerRamSecond() { return dictServerProfitInfo ? dictServerProfitInfo[this.name]?.gainRate ?? 0 : (dictServerMaxMoney[this.name] ?? 0); }
    getExpPerSecond() { return dictServerProfitInfo ? dictServerProfitInfo[this.name]?.expRate ?? 0 : (1 / dictServerMinSecurityLevels[this.name] ?? 0); }
    getMoney() { return this.ns.getServerMoneyAvailable(this.name); }
    getSecurity() { return this.ns.getServerSecurityLevel(this.name); }
    canCrack() { return getNumPortCrackers(this.ns) >= this.portsRequired; }
    canHack() { return this.requiredHackLevel <= playerHackSkill(); }
    shouldHack() {
        return this.getMaxMoney() > 0 && this.name !== "home" && !this.name.startsWith('hacknet-node-') &&
            !this.name.startsWith(purchasedServersName); // Hack, but beats wasting 2.25 GB on ns.getPurchasedServers()
    }
    // "Prepped" means current security is at the minimum, and current money is at the maximum
    isPrepped() {
        let currentSecurity = this.getSecurity();
        let currentMoney = this.getMoney();
        // Logic for whether we consider the server "prepped" (tolerate a 1% discrepancy)
        let isPrepped = (currentSecurity == 0 || ((this.getMinSecurity() / currentSecurity) >= 0.99)) &&
            (this.getMaxMoney() != 0 && ((currentMoney / this.getMaxMoney()) >= 0.99) || stockFocus /* Only prep security in stock-focus mode */);
        return isPrepped;
    }
    // Function to tell if the sever is running any tools, with optional filtering criteria on the tool being run
    isSubjectOfRunningScript(filter, useCache = true, count = false) {
        const toolNames = hackTools.map(t => t.name);
        let total = 0;
        // then figure out if the servers are running the other 2, that means prep
        for (const hostname of allHostNames)
            for (const process of ps(this.ns, hostname, useCache))
                if (toolNames.includes(process.filename) && process.args[0] == this.name && (!filter || filter(process))) {
                    if (count)
                        total++;
                    else
                        return true;
                }
        return count ? total : false;
    }
    isPrepping(useCache = true) {
        return this.isSubjectOfRunningScript(process => process.args.length > 4 && process.args[4] == "prep", useCache);
    }
    isTargeting(useCache = true) {
        return this.isSubjectOfRunningScript(process => process.args.length > 4 && process.args[4].includes('Batch'), useCache);
    }
    isXpFarming(useCache = true) {
        return this.isSubjectOfRunningScript(process => process.args.length > 4 && process.args[4].includes('FarmXP'), useCache);
    }
    serverGrowthPercentage() {
        return this.ns.getServerGrowth(this.name) * bitnodeMults.ServerGrowthRate * getPlayerHackingGrowMulti() / 100;
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
        if (hasFormulas) {
            try {
                let server = {
                    hackDifficulty: this.getMinSecurity(),
                    requiredHackingSkill: this.requiredHackLevel
                };
                return this.ns.formulas.hacking.hackPercent(server, _cachedPlayerInfo); // hackAnalyzePercent(this.name) / 100;
            } catch {
                hasFormulas = false;
            }
        }
        return Math.min(1, Math.max(0, (((100 - Math.min(100, this.getMinSecurity())) / 100) *
            ((playerHackSkill() - (this.requiredHackLevel - 1)) / playerHackSkill()) / 240)));
    }
    actualPercentageToSteal() {
        return this.getHackThreadsNeeded() * this.percentageStolenPerHackThread();
    }
    getHackThreadsNeeded() {
        // Force rounding of low-precision digits before taking the floor, to avoid double imprecision throwing us way off.
        return Math.floor((this.percentageToSteal / this.percentageStolenPerHackThread()).toPrecision(14));
    }
    getGrowThreadsNeeded() {
        return Math.min(this.getMaxMoney(),

            // TODO: Not true! Worst case is 1$ per thread and *then* it multiplies. We can return a much lower number here.
            Math.ceil((this.cyclesNeededForGrowthCoefficient() / this.serverGrowthPercentage()).toPrecision(14)));
    }
    getWeakenThreadsNeeded() {
        return Math.ceil(((this.getSecurity() - this.getMinSecurity()) / actualWeakenPotency()).toPrecision(14));
    }
    getGrowThreadsNeededAfterTheft() {
        return Math.min(this.getMaxMoney(),
            Math.ceil((this.cyclesNeededForGrowthCoefficientAfterTheft() / this.serverGrowthPercentage() * recoveryThreadPadding).toPrecision(14)));
    }
    getWeakenThreadsNeededAfterTheft() {
        return Math.ceil((this.getHackThreadsNeeded() * hackThreadHardening / actualWeakenPotency() * recoveryThreadPadding).toPrecision(14));
    }
    getWeakenThreadsNeededAfterGrowth() {
        return Math.ceil((this.getGrowThreadsNeededAfterTheft() * growthThreadHardening / actualWeakenPotency() * recoveryThreadPadding).toPrecision(14));
    }
    hasRoot() { return this._hasRootCached || (this._hasRootCached = this.ns.hasRootAccess(this.name)); }
    isHost() { return this.name == daemonHost; }
    totalRam() {
        let maxRam = this.ns.getServerMaxRam(this.name);
        if (this.name == "home")
            maxRam = Math.max(0, maxRam - homeReservedRam); // Complete HACK: but for most planning purposes, we want to pretend home has less ram to leave room for temp scripts to run
        return maxRam;
    }
    usedRam() { return this.ns.getServerUsedRam(this.name); }
    ramAvailable() { return this.totalRam() - this.usedRam(); }
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

// return a "performance snapshot" (Ram required for the cycle) to compare against optimal, or another snapshot
// TODO: Better gauge of performance might be money stolen per (RAM * time) cost
function getPerformanceSnapshot(currentTarget, networkStats) {
    // The total RAM cost of running one weaken/hack/grow cycle to steal `currentTarget.percentageToSteal` of `currentTarget.money`
    const weaken1Cost = currentTarget.getWeakenThreadsNeededAfterTheft() * getTool("weak").cost;
    const weaken2Cost = currentTarget.getWeakenThreadsNeededAfterGrowth() * getTool("weak").cost;
    const growCost = currentTarget.getGrowThreadsNeededAfterTheft() * getTool("grow").cost;
    const hackCost = currentTarget.getHackThreadsNeeded() * getTool("hack").cost;
    // Simulate how many times we could schedule this batch given current server ram availability
    // (and hope that whatever executes the tasks in this batch is clever enough to slot them in as such (TODO: simulate using our actual executor logic?)
    const jobs = [weaken1Cost, weaken2Cost, growCost, hackCost].sort((a, b) => b - a); // Sort jobs largest to smallest
    const simulatedRemainingRam = networkStats.listOfServersFreeRam.slice();
    var maxScheduled = -1;
    var canScheduleAnother = true;
    while (canScheduleAnother && maxScheduled++ <= maxBatches) {
        for (const job of jobs) {
            // Find a free slot for this job, starting with largest servers as the scheduler tends to do
            const freeSlot = simulatedRemainingRam.sort((a, b) => b - a).findIndex(ram => ram >= job);
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
            - 1)), // Fudge factor, this isnt an exact scuence
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
    currentTarget.percentageToSteal = Math.max(currentTarget.percentageToSteal, percentPerHackThread); // If the initial % to steal is below the minimum, raise it
    // Make adjustments to the number of hack threads until we zero in on the best amount
    while (++attempts < maxAdjustments) {
        var performanceSnapshot = getPerformanceSnapshot(currentTarget, networkStats);
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
        var comparisonSnapshot = getPerformanceSnapshot(currentTarget, networkStats);
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
        if (verbose && runOnce) logSchedule(batchTiming, currentTarget); // Special log for troubleshooting batches
        const newBatch = getScheduleObject(batchTiming, currentTarget, scheduledTasks.length);
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
            const args = [currentTarget.name, schedItem.start.getTime(), schedItem.end.getTime(), schedItem.end - schedItem.start, discriminationArg];
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
let logSchedule = (schedule, currentTarget) =>
    log(ns, `Current Time: ${formatDateTime(new Date())} Established a schedule for ${getTargetSummary(currentTarget)} from requested startTime ${formatDateTime(schedule.batchStart)}:` +
        `\n  Hack - End: ${formatDateTime(schedule.hackEnd)}  Start: ${formatDateTime(schedule.hackStart)}  Time: ${formatDuration(currentTarget.timeToHack())}` +
        `\n  Weak1- End: ${formatDateTime(schedule.firstWeakenEnd)}  Start: ${formatDateTime(schedule.firstWeakenStart)}  Time: ${formatDuration(currentTarget.timeToWeaken())}` +
        `\n  Grow - End: ${formatDateTime(schedule.growEnd)}  Start: ${formatDateTime(schedule.growStart)}  Time: ${formatDuration(currentTarget.timeToGrow())}` +
        `\n  Weak2- End: ${formatDateTime(schedule.secondWeakenEnd)}  Start: ${formatDateTime(schedule.secondWeakenStart)}  Time: ${formatDuration(currentTarget.timeToWeaken())}`);

/** Produce additional args based on the hack tool name and command line flags set */
function getFlagsArgs(toolName, target, allowLooping = true) {
    const args = []
    if (["hack", "grow"].includes(toolName)) // Push an arg used by remote hack/grow tools to determine whether it should manipulate the stock market
        args.push(stockMode && (toolName == "hack" && shouldManipulateHack[target] || toolName == "grow" && shouldManipulateGrow[target]) ? 1 : 0);
    if (["hack", "weak"].includes(toolName))
        args.push(options['silent-misfires'] || // Optional arg to disable toast warnings about a failed hack if hacking money gain is disabled
            (toolName == "hack" && (bitnodeMults.ScriptHackMoneyGain == 0 || playerBitnode == 8)) ? 1 : 0); // Disable automatically in BN8 (hack income disabled)
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

function getScheduleObject(batchTiming, currentTarget, batchNumber) {
    var schedItems = [];

    var schedHack = getScheduleItem("hack", "hack", batchTiming.hackStart, batchTiming.hackEnd, currentTarget.getHackThreadsNeeded());
    var schedWeak1 = getScheduleItem("weak1", "weak", batchTiming.firstWeakenStart, batchTiming.firstWeakenEnd, currentTarget.getWeakenThreadsNeededAfterTheft());
    // Special end-game case, if we have no choice but to hack a server to zero money, schedule back-to-back grows to restore money
    // TODO: This approach isn't necessary if we simply include the `growThreadsNeeded` logic to take into account the +1$ added before grow.
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
        var schedGrow = getScheduleItem("grow", "grow", batchTiming.growStart, batchTiming.growEnd, schedGrowThreads);
        var schedWeak2 = getScheduleItem("weak2", "weak", batchTiming.secondWeakenStart, batchTiming.secondWeakenEnd,
            Math.ceil(((injectThreads + schedGrowThreads) * growthThreadHardening / actualWeakenPotency()).toPrecision(14)));
        if (verbose) log(_ns, `INFO: Special grow strategy since percentage stolen per hack thread is 100%: G1: ${injectThreads}, G1: ${schedGrowThreads}, W2: ${schedWeak2.threadsNeeded} (${currentTarget.name})`);
    } else {
        var schedGrow = getScheduleItem("grow", "grow", batchTiming.growStart, batchTiming.growEnd, currentTarget.getGrowThreadsNeededAfterTheft());
        var schedWeak2 = getScheduleItem("weak2", "weak", batchTiming.secondWeakenStart, batchTiming.secondWeakenEnd, currentTarget.getWeakenThreadsNeededAfterGrowth());
    }

    if (hackOnly) {
        schedItems.push(schedHack);
    } else {
        // Schedule hack/grow first, because they cannot be split, and start with whichever requires the biggest chunk of free RAM
        schedItems.push(...(schedHack.threadsNeeded > schedGrow.threadsNeeded ? [schedHack, schedGrow] : [schedGrow, schedHack]));
        // Scheduler should ensure there's room for both, but splitting threads is annoying, so schedule the biggest first again to avoid fragmentation
        schedItems.push(...(schedWeak1.threadsNeeded > schedWeak2.threadsNeeded ? [schedWeak1, schedWeak2] : [schedWeak2, schedWeak1]));
    }

    var scheduleObject = {
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
    var schedItem = {
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
export async function arbitraryExecution(ns, tool, threads, args, preferredServerName = null, useSmallestServerPossible = false, allowThreadSplitting = null) {
    // We will be using the list of servers that is sorted by most available ram
    var rootedServersByFreeRam = getAllServersByFreeRam().filter(server => server.hasRoot() && server.totalRam() > 1.6 || server.name == "home");
    // Sort servers by total ram, and try to fill these before utilizing another server.
    var preferredServerOrder = getAllServersByMaxRam().filter(server => server.hasRoot() && server.totalRam() > 1.6 || server.name == "home");
    if (useSmallestServerPossible) // If so-configured, fill up small servers before utilizing larger ones (can be laggy)
        preferredServerOrder.reverse();
    // IDEA: "home" is more effective at grow() and weaken() than other nodes (has multiple cores) (TODO: By how much?)
    //       so if this is one of those tools, put it at the front of the list of preferred candidates, otherwise keep home ram free if possible
    //       TODO: This effort is wasted unless we also scale down the number of threads "needed" when running on home. We will overshoot grow/weaken
    var home = preferredServerOrder.splice(preferredServerOrder.findIndex(i => i.name == "home"), 1)[0];
    if (tool.shortName == "grow" || tool.shortName == "weak" || preferredServerName == "home")
        preferredServerOrder.unshift(home); // Send to front
    else
        preferredServerOrder.push(home); // Otherwise, send it to the back (reserve home for scripts that benefit from cores) and use only if there's no room on any other server.
    // Push all "hacknet-node" servers to the end of the preferred list, since they will lose productivity if used
    var anyHacknetNodes = [];
    let hnNodeIndex;
    while (-1 !== (hnNodeIndex = preferredServerOrder.indexOf(s => s.name.startsWith('hacknet-node-'))))
        anyHacknetNodes.push(preferredServerOrder.splice(hnNodeIndex, 1));
    preferredServerOrder.push(...anyHacknetNodes.sort((a, b) => b.totalRam != a.totalRam ? b.totalRam - a.totalRam : a.name.localeCompare(b.name)));

    // Allow for an overriding "preferred" server to be used in the arguments, and slot it to the front regardless of the above
    if (preferredServerName && preferredServerName != "home" /*home is handled above*/) {
        const preferredServerIndex = preferredServerOrder.findIndex(i => i.name == preferredServerName);
        if (preferredServerIndex != -1)
            preferredServerOrder.unshift(preferredServerOrder.splice(preferredServerIndex, 1)[0]);
        else
            log(ns, `ERROR: Configured preferred server "${preferredServerName}" for ${tool.name} is not a valid server name`, true, 'error');
    }
    //log(ns, `Preferred Server ${preferredServerName} for ${tool.name} resulted in preferred order: ${preferredServerOrder.map(srv => srv.name)}`);
    //log(ns, `Servers by free ram: ${rootedServersByFreeRam.map(svr => svr.name + " (" + svr.ramAvailable() + ")")}`);

    // Helper function to compute the most threads a server can run
    let computeMaxThreads = function (server) {
        if (tool.cost == 0) return 1;
        let ramAvailable = server.ramAvailable();
        // It's a hack, but we know that "home"'s reported ram available is lowered to leave room for "preferred" jobs,
        // so if this is a preferred job, ignore what the server object says and get it from the source
        if (server.name == "home" && preferredServerName == "home")
            ramAvailable = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
        // Note: To be conservative, we allow double imprecision to cause this floor() to return one less than should be possible,
        //       because the game likely doesn't account for this imprecision (e.g. let 1.9999999999999998 return 1 rather than 2)
        return Math.floor((ramAvailable / tool.cost)/*.toPrecision(14)*/);
    };

    let remainingThreads = threads;
    let splitThreads = false;
    for (var i = 0; i < rootedServersByFreeRam.length && remainingThreads > 0; i++) {
        var targetServer = rootedServersByFreeRam[i];
        var maxThreadsHere = Math.min(remainingThreads, computeMaxThreads(targetServer));
        if (maxThreadsHere <= 0)
            continue; //break; HACK: We don't break here because there are cases when sort order can change (e.g. we've reserved home RAM)

        // If this server can handle all required threads, see if a server that is more preferred also has room.
        // If so, we prefer to pack that server with more jobs before utilizing another server.
        if (maxThreadsHere == remainingThreads) {
            for (var j = 0; j < preferredServerOrder.length; j++) {
                var nextMostPreferredServer = preferredServerOrder[j];
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
        if (targetServer.name != daemonHost && !doesFileExist(ns, tool.name, targetServer.name)) {
            let missing_scripts = [tool.name];
            if (!doesFileExist(ns, getFilePath('helpers.js'), targetServer.name))
                missing_scripts.push(getFilePath('helpers.js')); // Some tools require helpers.js. Best to copy it around.
            if (verbose)
                log(ns, `Copying ${tool.name} from ${daemonHost} to ${targetServer.name} so that it can be executed remotely.`);
            await getNsDataThroughFile(ns, `await ns.scp(ns.args.slice(2), ns.args[0], ns.args[1])`,
                '/Temp/copy-scripts.txt', [daemonHost, targetServer.name, ...missing_scripts])
            //await ns.sleep(5); // Workaround for Bitburner bug https://github.com/danielyxie/bitburner/issues/1714 - newly created/copied files sometimes need a bit more time, even if awaited
        }
        let pid = await exec(ns, tool.name, targetServer.name, maxThreadsHere, ...(args || []));
        if (pid == 0) {
            log(ns, `ERROR: Failed to exec ${tool.name} on server ${targetServer.name} with ${maxThreadsHere} threads`, false, 'error');
            return false;
        }
        // Decrement the threads that have been successfully scheduled
        remainingThreads -= maxThreadsHere;
        if (remainingThreads > 0) {
            if (!(allowThreadSplitting || tool.isThreadSpreadingAllowed)) break;
            // No need to warn if it's allowed? log(ns, `WARNING: Had to split ${threads} ${tool.name} threads across multiple servers. ${maxThreadsHere} on ${targetServer.name}`);
            splitThreads = true;
        }
    }
    // The run failed if there were threads left to schedule after we exhausted our pool of servers
    if (remainingThreads > 0 && threads < Number.MAX_SAFE_INTEGER)
        log(ns, `ERROR: Ran out of RAM to run ${tool.name} on ${splitThreads ? 'all servers (split)' : `${targetServer?.name} `}- ` +
            `${threads - remainingThreads} of ${threads} threads were spawned.`, false, 'error');
    if (splitThreads && !tool.isThreadSpreadingAllowed)
        return false;
    return remainingThreads == 0;
}

/** Brings the server to minimum security and maximum money to prepare for cycling scheduler activity
 * @param {NS} ns
 * @param {Server} currentTarget */
async function prepServer(ns, currentTarget) {
    // Check if already prepped or in targeting mode, in which case presume prep server is to be skipped.
    if (currentTarget.isPrepped() || currentTarget.isTargeting()) return null;
    let start = Date.now();
    let now = new Date(start.valueOf());
    let weakenTool = getTool("weak"), growTool = getTool("grow");
    // Note: We must prioritize weakening before growing, or hardened security will make everything take longer
    let weakenThreadsAllowable = weakenTool.getMaxThreads(); // Note: Max is based on total ram across all servers (since thread spreading is allowed)
    let weakenThreadsNeeded = currentTarget.getWeakenThreadsNeeded();
    // Plan grow if needed, but don't bother if we didn't have enough ram to schedule all weaken threads to reach min security
    let growThreadsNeeded, growThreadsScheduled;
    if (weakenThreadsNeeded < weakenThreadsAllowable && (growThreadsNeeded = currentTarget.getGrowThreadsNeeded())) {
        let growThreadsAllowable = growTool.getMaxThreads(true) - weakenThreadsNeeded; // Take into account RAM that will be consumed by weaken threads scheduled
        growThreadsScheduled = Math.min(growThreadsAllowable, growThreadsNeeded);
        // Calculate additional weaken threads which should be fired after the grow completes.
        let weakenForGrowthThreadsNeeded = Math.ceil((growThreadsScheduled * growthThreadHardening / actualWeakenPotency()).toPrecision(14));
        // If we don't have enough room for the new weaken threads, release grow threads to make room
        const subscription = (growThreadsScheduled + weakenForGrowthThreadsNeeded) / growThreadsAllowable;
        if (subscription > 1) { // Scale down threads to schedule until we are no longer over-subscribed
            log(ns, `INFO: Insufficient RAM to schedule all ${weakenForGrowthThreadsNeeded} required weaken threads to recover from ` +
                `${growThreadsScheduled} prep grow threads. Scaling both down by ${subscription} (${currentTarget.name})`);
            growThreadsScheduled = Math.floor((growThreadsScheduled / subscription).toPrecision(14));
            weakenForGrowthThreadsNeeded = Math.floor((weakenForGrowthThreadsNeeded / subscription).toPrecision(14));
        }
        weakenThreadsNeeded += weakenForGrowthThreadsNeeded;
    }

    // Schedule weaken first, in case ram conditions change, it's more important (security affects speed of future tools)
    let prepSucceeding = true;
    let weakenThreadsScheduled = Math.min(weakenThreadsAllowable, weakenThreadsNeeded);
    if (weakenThreadsScheduled) {
        if (weakenThreadsScheduled < weakenThreadsNeeded)
            log(ns, `At this time, we only have enough RAM to schedule ${weakenThreadsScheduled} of the ${weakenThreadsNeeded} ` +
                `prep weaken threads needed to lower the target from current security (${formatNumber(currentTarget.getSecurity())}) ` +
                `to min security (${formatNumber(currentTarget.getMinSecurity())}) (${currentTarget.name})`);
        prepSucceeding = await arbitraryExecution(ns, weakenTool, weakenThreadsScheduled,
            [currentTarget.name, now.getTime(), now.getTime(), 0, "prep", ...getFlagsArgs("weak", currentTarget.name, false)]);
        if (prepSucceeding == false)
            log(ns, `Failed to schedule all ${weakenThreadsScheduled} prep weaken threads (${currentTarget.name})`);
    }
    // Schedule any prep grow threads next
    if (prepSucceeding && growThreadsScheduled > 0) {
        prepSucceeding = await arbitraryExecution(ns, growTool, growThreadsScheduled,
            [currentTarget.name, now.getTime(), now.getTime(), 0, "prep", ...getFlagsArgs("grow", currentTarget.name, false)],
            undefined, undefined, /*allowThreadSplitting*/ true); // Special case: for prep we allow grow threads to be split
        if (prepSucceeding == false)
            log(ns, `Failed to schedule all ${growThreadsScheduled} prep grow threads (${currentTarget.name})`);
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

let singleServerLimit; // If prior cycles failed to be scheduled, force one additional server into single-server mode until we aqcuire more RAM
let lastCycleTotalRam = 0; // Cache of total ram on the server to check whether we should attempt to lift the above restriction.

/** @param {NS} ns
 * Grind hack XP by filling a bunch of RAM with hack() / grow() / weaken() against a relatively easy target */
async function farmHackXp(ns, percentOfFreeRamToConsume = 1, verbose = false, targets = undefined) {
    if (!xpOnly || loopingMode) // Only use basic single-target hacking unless we're in XP mode (and not looping)
        return await scheduleHackExpCycle(ns, getBestXPFarmTarget(), percentOfFreeRamToConsume, verbose, false); // Grind some XP from the single best target for farming XP
    // Otherwise, target multiple servers until we can't schedule any more. Each next best host should get the next best (biggest) server
    getTool("grow").isThreadSpreadingAllowed = true; // Only true when in XP mode - where each grow thread is expected to give 1$. "weak" can always spread.
    const serversByMaxRam = getAllServersByMaxRam();
    var jobHosts = serversByMaxRam.filter(s => s.hasRoot() && s.totalRam() > 128); // Get the set of servers that can be reasonably expected to host decent-sized jobs
    if (jobHosts.length == 0) jobHosts = serversByMaxRam.filter(s => s.hasRoot() && s.totalRam() > 16); // Lower our standards if we're early-game and nothing qualifies
    var homeRam = Math.max(0, ns.getServerMaxRam("home") - homeReservedRam); // If home ram is large enough, the XP contributed by additional targets is insignificant compared to the risk of increased lag/latency.
    let targetsByExp = getXPFarmTargetsByExp();
    targets = Math.min(maxTargets, targetsByExp.length, Math.floor(jobHosts.filter(s => s.totalRam() > 0.01 * homeRam).length)); // Limit targets (too many creates lag which worsens performance, and need a dedicated server for each)
    if (options.i) { // To farm intelligence, use manual hack on only the current connected server
        if (currentTerminalServer.name != "home") {
            targets = 1;
            targetsByExp = [currentTerminalServer];
        }
    }
    const etas = [];
    const totalServerRam = jobHosts.reduce((total, s) => total + s.totalRam(), 0);
    if (totalServerRam > lastCycleTotalRam) { // If we've aqcuired more ram, remove restrictions and discover the new best balance
        singleServerLimit = 0;
        lastCycleTotalRam = totalServerRam;
    }
    let tryAdvanceMode = bitnodeMults.ScriptHackMoneyGain != 0; // We can't attempt hack-based XP if it's impossible to gain hack income (XP will always be 1/4)
    let singleServerMode = false; // Start off maximizing hack threads for best targets by spreading their weaken/grow threads to other servers
    for (let i = 0; i < targets; i++) {
        let lastSchedulingResult;
        singleServerMode = singleServerMode || (i >= (jobHosts.length - 1 - singleServerLimit) || jobHosts[i + 1].totalRam() < 1000); // Switch to single-server mode if running out of hosts with high ram
        etas.push(lastSchedulingResult = (await scheduleHackExpCycle(ns, targetsByExp[i], percentOfFreeRamToConsume, verbose, tryAdvanceMode, jobHosts[i], singleServerMode)) || Number.MAX_SAFE_INTEGER);
        if (lastSchedulingResult == Number.MAX_SAFE_INTEGER) break; // Stop scheduling targets if the last attempt failed
    }
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
/** @param {NS} ns
 * @param {Server} server - The server that will be targetted
 * @param {Server} allocatedServer - You may designate a specific server on which to execute scripts. **/
async function scheduleHackExpCycle(ns, server, percentOfFreeRamToConsume, verbose, advancedMode, allocatedServer = null, singleServer = false) {
    if (!server.hasRoot() && server.canCrack()) await doRoot(ns, server); // Get root if we do not already have it.
    if (!server.hasRoot()) return log(ns, `ERROR: Cannot farm XP from unrooted server ${server.name}`, true, 'error');
    // If we are already farming XP from this server, wait for it to complete (if the last cycle is almost done) or skip scheduling more work
    const eta = nextXpCycleEnd[server.name];
    const activeCycleTimeLeft = (eta || 0) - Date.now();
    if (activeCycleTimeLeft > 1000) return activeCycleTimeLeft; // If we're more than 1s away from the expected fire time, just wait for the next loop, don't even check for early completion
    if (farmXpReentryLock[server.name] == true) return; // Ensure more than one concurrent callback isn't trying to schedule this server's faming cycle
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
        let loopRunning = false;
        if (server.isXpFarming()) {
            if (loopingMode)
                loopRunning = true;
            else {
                if (verbose && activeCycleTimeLeft < -50) // Warn about big misfires (sign of lag)
                    log(ns, `WARNING: ${server.name} FarmXP process is ` + (eta ? `more than ${formatDuration(-activeCycleTimeLeft)} overdue...` :
                        `still in progress from a prior run. ETA unknown, assuming '${expTool.name}' time: ${formatDuration(expTime)}`));
                return eta ? (activeCycleTimeLeft > 0 ? activeCycleTimeLeft : 10 /* If we're overdue, sleep only 10 ms before checking again */) : expTime /* Have no ETA, sleep for expTime */;
            }
        }
        let threads = Math.floor(((allocatedServer == null ? expTool.getMaxThreads() : allocatedServer.ramAvailable() / expTool.cost) * percentOfFreeRamToConsume).toPrecision(14));
        if (threads == 0)
            return log(ns, `WARNING: Cannot farm XP from ${server.name}, threads == 0 for allocated server ` + (allocatedServer == null ? '(any server)' :
                `${allocatedServer.name} with ${formatRam(allocatedServer.ramAvailable())} free RAM`), false, 'warning');

        if (advancedMode) { // Need to keep server money above zero, and security at minimum to farm xp from hack();
            const effectiveHackThreads = Math.ceil(1 / server.percentageStolenPerHackThread()); // Only this many hack threads "count" for stealing/hardening. The rest get a 'free ride'
            if (threads <= effectiveHackThreads) {
                farmXpReentryLock[server.name] = false;
                // We don't have enough ram for advanced XP grind (no hack threads would get a 'free ride'). Revert to simple weak/grow farming mode.
                return await scheduleHackExpCycle(ns, server, percentOfFreeRamToConsume, verbose, false, allocatedServer, singleServer);
            }
            var growThreadsNeeded = effectiveHackThreads * recoveryThreadPadding; // To hack for money, server must have at least 1$ per thread that "counts" for the steal (threads required to steal 100%)
            const securityHardeningToCombat = Math.max(effectiveHackThreads * hackThreadHardening + growThreadsNeeded * growthThreadHardening, // Security that will be incurred hack() + grow() threads
                server.getSecurity() - server.getMinSecurity()); // If the current security level is higher than this, add enough weaken threads to correct it
            var weakenThreadsNeeded = Math.ceil(securityHardeningToCombat / actualWeakenPotency()) * recoveryThreadPadding;
            // TODO: If the remaining hosts on the network can't fit 4 sets of grow + weaken recovery threads needed, switch to single-server mode! (should take into account already-scheduled cycles)
            if (singleServer) // If set to only use a single server, free up the hack threads to make room for recovery threads
                threads = Math.max(0, threads - Math.ceil((growThreadsNeeded + weakenThreadsNeeded) * 1.75 / expTool.cost)); // Make room for recovery threads
            if (threads == 0)
                return log(ns, `Cannot farm XP from ${server.name} on ` + (allocatedServer == null ? '(any server)' : `${allocatedServer.name} with ${formatRam(allocatedServer.ramAvailable())} free RAM`) +
                    `: hack threads == 0 after releasing for ${growThreadsNeeded} grow threads and ${weakenThreadsNeeded} weaken threads for ${effectiveHackThreads} effective hack threads.`);
        }

        let scheduleDelay = 10; // Assume it will take this long a script fired immediately to start running
        let now = Date.now();
        let scheduleTime = now + scheduleDelay;
        let cycleTime = scheduleDelay + expTime + 10; // Wake up this long after a hack has fired (to ensure we don't wake up too early)
        nextXpCycleEnd[server.name] = now + cycleTime; // Store when this server's next cycle is expected to end
        const allowLoop = advancedMode && singleServer && allTargetsPrepped; // Allow looping mode only once all targets are prepped
        // Schedule the FarmXP threads first, ensuring that they are not split (if they our split, our hack threads above 'effectiveHackThreads' lose their free ride)
        let success = loopRunning ? true : await arbitraryExecution(ns, expTool, threads,
            [server.name, scheduleTime, 0, expTime, "FarmXP"].concat(getFlagsArgs(expTool.shortName, server.name, allowLoop)), allocatedServer?.name);

        if (advancedMode) { // Need to keep server money above zero, and security at minimum to farm xp from hack();
            const scheduleGrow = scheduleTime + cycleTime * 2 / 15 - scheduleDelay; // Time this to resolve at 1/3 * cycleTime after each hack fires
            const scheduleWeak = scheduleTime + cycleTime * 2 / 3 - scheduleDelay; //  Time this to resolve at 2/3 * cycleTime after each hack fires
            // TODO: We can set these up in looping mode as well as long as we keep track and spawn no more than 4 running instances.
            success &&= await arbitraryExecution(ns, getTool("grow"), growThreadsNeeded,
                [server.name, scheduleGrow, 0, server.timeToGrow(), "growForXp"].concat(getFlagsArgs("grow", server.name, false)), // Note: looping disabled for now
                singleServer ? allocatedServer?.name : null, !singleServer);
            success &&= await arbitraryExecution(ns, getTool("weak"), weakenThreadsNeeded,
                [server.name, scheduleWeak, 0, server.timeToWeaken(), "weakenForXp"].concat(getFlagsArgs("weak", server.name, false)),
                singleServer ? allocatedServer?.name : null, !singleServer);
            //log(ns, `XP Farm ${server.name} money available is ${formatMoney(server.getMoney())} and security is ` +
            //    `${server.getSecurity().toPrecision(3)} of ${server.getMinSecurity().toPrecision(3)}`);
            //log(ns, `Planned start: Hack: ${Math.round(scheduleTime - now)} Grow: ${Math.round(scheduleGrow - now)} ` +
            //    `Weak: ${Math.round(scheduleWeak - now)} Tick: ${Math.round(cycleTime)} Cycle: ${threads} / ${growThreadsNeeded} / ${weakenThreadsNeeded}`);
            if (verbose) log(ns, `Exp Cycle: ${threads} x Hack in ${Math.round(scheduleTime - now + expTime)}ms, ` +
                `${growThreadsNeeded} x Grow in ${Math.round((scheduleGrow - now + server.timeToGrow()) % cycleTime)}ms, ` +
                `${weakenThreadsNeeded} x Weak in ${Math.round((scheduleWeak - now + server.timeToWeaken()) % cycleTime)}ms, ` +
                `Tick: ${Math.round(cycleTime)}ms on ${allocatedServer?.name ?? '(any server)'} targeting "${server.name}"`);
        } else if (verbose)
            log(ns, `In ${formatDuration(cycleTime)}, ${threads} ${expTool.shortName} threads will fire against ${server.name} (for Hack Exp)`);
        if (!success) { // If some aspect scheduling fails, we should try adjusting our future scheduling tactics to attempt to use less RAM
            if (singleServerLimit >= maxTargets && maxTargets > 1)
                maxTargets--;
            else
                singleServerLimit++;
        }
        // Note: Next time we tick, Hack will have *just* fired, so for the moment we will be at 0 money and above min security. Trust that all is well
        return success ? cycleTime : false; // Ideally we wake up right after hack has fired so we can schedule another immediately
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
    if (!_cachedPlayerInfo.hasTixApiAccess) return; // No point in attempting anything here if the user doesn't have stock market access yet.
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
    const problematicProcesses = allHostNames.flatMap(hostname => ps(ns, hostname)
        .filter(process => servers.includes(process.args[0]) && (loopingMode || toolName == process.filename && process.args.length > 5 && process.args[5]))
        .map(process => process.pid));
    if (problematicProcesses.length > 0) {
        log(ns, `INFO: Killing ${problematicProcesses.length} pids running ${toolName} with stock manipulation in the wrong direction.`);
        await killProcessIds(ns, problematicProcesses);
    }
}

/** Helper to kill a list of process ids
 * @param {NS} ns **/
async function killProcessIds(ns, processIds) {
    return await runCommand(ns, `ns.args.forEach(ns.kill)`, '/Temp/kill-pids.js', processIds);
}

/** @param {Server} server **/
function addServer(ns, server, verbose) {
    if (verbose) log(ns, `Adding a new server to all lists: ${server}`);
    allHostNames.push(server.name);
    _allServers.push(server);
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

// Indication that a server has been flagged for deletion (by the host manager). Doesn't count for home of course, as this is where the flag file is stored for copying.
let isFlaggedForDeletion = (ns, hostName) => hostName != "home" && doesFileExist(ns, getFilePath("/Flags/deleting.txt"), hostName);

// Helper to construct our server lists from a list of all host names
function buildServerList(ns, verbose = false) {
    // Get list of servers (i.e. all servers on first scan, or newly purchased servers on subsequent scans) that are not currently flagged for deletion
    let scanResult = scanAllServers(ns).filter(hostName => !isFlaggedForDeletion(ns, hostName));
    // Ignore hacknet node servers if we are not supposed to run scripts on them (reduces their hash rate when we do)
    if (!useHacknetNodes)
        scanResult = scanResult.filter(hostName => !hostName.startsWith('hacknet-node-'))
    // Remove all servers we currently have added that are no longer being returned by the above query
    for (const hostName of allHostNames.filter(hostName => !scanResult.includes(hostName)))
        removeServerByName(ns, hostName);
    // Add any servers that are new
    for (const hostName of scanResult.filter(hostName => !allHostNames.includes(hostName)))
        addServer(ns, new Server(ns, hostName, verbose));
}

/** @returns {Server[]} A list of all server objects */
function getAllServers() { return _allServers; }

/** @returns {Server} A list of all server objects */
function getServerByName(hostname) { return getAllServers().find(s => s.name == hostname); }

// Note: We maintain copies of the list of servers, in different sort orders, to reduce re-sorting time on each iteration
let _serverListByFreeRam, _serverListByMaxRam, _serverListByTargetOrder;
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
        var ramDiff = b.ramAvailable() - a.ramAvailable();
        return ramDiff != 0.0 ? ramDiff : a.name.localeCompare(b.name); // Break ties by sorting by name
    });
}

/** @returns {Server[]} Sorted by most max ram to least */
function getAllServersByMaxRam() {
    return _sortServersAndReturn(_serverListByMaxRam ??= getAllServers().slice(), function (a, b) {
        var ramDiff = b.totalRam() - a.totalRam();
        return ramDiff != 0.0 ? ramDiff : a.name.localeCompare(b.name); // Break ties by sorting by name
    });
}

/** @returns {Server[]} Sorted in the order we should prioritize spending ram on targeting them (for hacking) */
function getAllServersByTargetOrder() {
    return _sortServersAndReturn(_serverListByTargetOrder ??= getAllServers().slice(), function (a, b) {
        // To ensure we establish some income, prep fastest-to-prep servers first, and target prepped servers before unprepped servers.
        if (a.canHack() != b.canHack()) return a.canHack() ? -1 : 1; // Sort all hackable servers first
        if (stockFocus) { // If focused on stock-market manipulation, sort up servers with a stock, prioritizing those we have some position in
            let stkCmp = serversWithOwnedStock.includes(a.name) == serversWithOwnedStock.includes(b.name) ? 0 : serversWithOwnedStock.includes(a.name) ? -1 : 1;
            if (stkCmp == 0) stkCmp = ((shouldManipulateGrow[a.name] || shouldManipulateHack[a.name]) == (shouldManipulateGrow[b.name] || shouldManipulateHack[b.name])) ? 0 :
                shouldManipulateGrow[a.name] || shouldManipulateHack[a.name] ? -1 : 1;
            if (stkCmp != 0) return stkCmp;
        }
        // Next, Sort prepped servers to the front. Assume that if we're targetting, we're prepped (between cycles)
        if ((a.isPrepped() || a.isTargeting()) != (b.isPrepped() || b.isTargeting)) return a.isPrepped() || a.isTargeting() ? -1 : 1;
        if (!a.canHack()) return a.requiredHackLevel - b.requiredHackLevel; // Unhackable servers are sorted by lowest hack requirement
        //if (!a.isPrepped()) return a.timeToWeaken() - b.timeToWeaken(); // Unprepped servers are sorted by lowest time to weaken
        // For ready-to-hack servers, the sort order is based on money, RAM cost, and cycle time
        return b.getMoneyPerRamSecond() - a.getMoneyPerRamSecond(); // Prepped servers are sorted by most money/ram.second
    });
}

async function runCommand(ns, ...args) {
    return await runCommand_Custom(ns, getFnRunViaNsExec(ns, daemonHost), ...args);
}

async function getNsDataThroughFile(ns, ...args) {
    return await getNsDataThroughFile_Custom(ns, getFnRunViaNsExec(ns, daemonHost), getFnIsAliveViaNsPs(ns), ...args);
}

async function establishMultipliers(ns) {
    log(ns, "establishMultipliers");

    bitnodeMults = (await tryGetBitNodeMultipliers_Custom(ns, getNsDataThroughFile)) || {
        // prior to SF-5, bitnodeMults stays null and these mults are set to 1.
        ServerGrowthRate: 1,
        ServerWeakenRate: 1,
        FourSigmaMarketDataApiCost: 1,
        ScriptHackMoneyGain: 1
    };
    if (verbose)
        log(ns, `Bitnode mults:\n  ${Object.keys(bitnodeMults).filter(k => bitnodeMults[k] != 1.0).map(k => `${k}: ${bitnodeMults[k]}`).join('\n  ')}`);
}

class Tool {
    /** @param {({name: string; shortName: string; shouldRun: () => boolean; args: string[]; tail: boolean; requiredServer: string; threadSpreadingAllowed: boolean; })} toolConfig
     * @param {Number} toolCost **/
    constructor(toolConfig, toolCost) {
        this.name = toolConfig.name;
        this.shortName = toolConfig.shortName;
        this.tail = toolConfig.tail || false;
        this.args = toolConfig.args || [];
        this.shouldRun = toolConfig.shouldRun;
        this.requiredServer = toolConfig.requiredServer;
        // Whether, in general, it's save to spread threads for this tool around to different servers (overridden in some cases)
        this.isThreadSpreadingAllowed = toolConfig.threadSpreadingAllowed === true;
        this.cost = toolCost;
    }
    /** @returns {boolean} true if the server has this tool and enough ram to run it. */
    canRun(server) {
        return doesFileExist(_ns, this.name, server.name) && server.ramAvailable() >= this.cost;
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
            let threadsHere = Math.floor((server.ramAvailable() / this.cost) /*.toPrecision(14)*/);
            // HACK: Temp script firing before the script gets scheduled can cause home ram reduction, don't promise as much from home
            if (server.name == "home") // TODO: Revise this hack, it is technically messing further with the "servers by free ram" sort order
                threadsHere = Math.max(0, threadsHere - Math.ceil(homeReservedRam / this.cost)); // Note: Effectively doubles home reserved RAM in cases where we plan to consume all available RAM
            // TODO: Perhaps an alternative to the above is that the scheduler should not be so strict about home reserved ram enforcement if we use thread spreading and save scheduling on home for last?
            if (!allowSplitting)
                return threadsHere;
            maxThreads += threadsHere;
        }
        return maxThreads;
    }
}

/** @param {NS} ns
 * @param {({name: string; shortName: string; shouldRun: () => boolean; args: string[]; tail: boolean; requiredServer: string; threadSpreadingAllowed: boolean; })[]} allTools **/
async function buildToolkit(ns, allTools) {
    log(ns, "buildToolkit");
    let toolCosts = await getNsDataThroughFile(ns, `Object.fromEntries(ns.args.map(s => [s, ns.getScriptRam(s, 'home')]))`,
        '/Temp/script-costs.txt', allTools.map(t => t.name));
    const toolsTyped = allTools.map(toolConfig => new Tool(toolConfig, toolCosts[toolConfig.name]));
    toolsByShortName = Object.fromEntries(toolsTyped.map(tool => [tool.shortName || hashToolDefinition(tool), tool]));
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

function getNumPortCrackers(ns) {
    // Once we own a port cracker, assume it won't be deleted.
    if (ownedCracks.length == 5) return 5;
    for (const crack of crackNames.filter(c => !ownedCracks.includes(c)))
        if (doesFileExist(ns, crack, 'home'))
            ownedCracks.push(crack);
    return ownedCracks.length;
}