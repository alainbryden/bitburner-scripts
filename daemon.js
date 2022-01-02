import {
    formatMoney, formatRam, formatDuration, formatDateTime, formatNumber,
    scanAllServers, hashCode, disableLogs, log as logHelper,
    getNsDataThroughFile_Custom, runCommand_Custom, waitForProcessToComplete_Custom,
    tryGetBitNodeMultipliers_Custom, getActiveSourceFiles_Custom,
    getFnRunViaNsExec, getFnIsAliveViaNsPs
} from './helpers.js'

// the purpose of the daemon is: it's our global starting point.
// it handles several aspects of the game, primarily hacking for money.
// since it requires a robust "execute arbitrarily" functionality
// it serves as the launching point for all the helper scripts we need.
// this list has been steadily growing as time passes.

/*jshint loopfunc:true */

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
// Pad weaken thread counts to account for undershooting. (Shouldn't happen. And if this is a timing issue, padding won't help)
const weakenThreadPadding = 0; //0.01;
// The name given to purchased servers (should match what's in host-manager.js)
const purchasedServersName = "daemon";

// The maximum current total RAM utilization before we stop attempting to schedule work for the next less profitable server. Can be used to reserve capacity.
const maxUtilization = 0.95;
const lowUtilizationThreshold = 0.80; // The counterpart - low utilization, which leads us to ramp up targets
// If we have plenty of resources after targeting all possible servers, we can start to grow/weaken servers above our hack level - up to this utilization
const maxUtilizationPreppingAboveHackLevel = 0.75;
// Maximum number of milliseconds the main targeting loop should run before we take a break until the next loop
const maxLoopTime = 1000; //ms
let loopInterval = 1000; //ms
// the number of milliseconds to delay the grow execution after theft to ensure it doesn't trigger too early and have no effect.
// For timing reasons the delay between each step should be *close* 1/4th of this number, but there is some imprecision
let cycleTimingDelay = 1600;
let queueDelay = 100; // the delay that it can take for a script to start, used to pessimistically schedule things in advance
let maxBatches = 40; // the max number of batches this daemon will spool up to avoid running out of IRL ram (TODO: Stop wasting RAM by scheduling batches so far in advance. e.g. Grind XP while waiting for cycle start!)
let maxTargets = 0; // Initial value, will grow if there is an abundance of RAM
let maxPreppingAtMaxTargets = 3; // The max servers we can prep when we're at our current max targets and have spare RAM
// Allows some home ram to be reserved for ad-hoc terminal script running and when home is explicitly set as the "preferred server" for starting a helper 
let homeReservedRam = 32;

// --- VARS ---
// some ancillary scripts that run asynchronously, we utilize the startup/execute capabilities of this daemon to run when able
let asynchronousHelpers = [];
let periodicScripts = [];
// The primary tools copied around and used for hacking
let hackTools = [];
// the port cracking array, we use this to do some things
let portCrackers = [];
// toolkit var for remembering the names and costs of the scripts we use the most
let tools = [];
let toolsByShortName = []; // Dictionary keyed by tool short name

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

// simple name array of servers that have been added
let addedServerNames = [];
// complex arrays of servers with relevant properties, one is sorted for ram available, the other is for money
let serverListByFreeRam = [];
let serverListByMaxRam = [];
let serverListByTargetOrder = [];

let _ns = null; // Globally available ns reference, for convenience
let daemonHost = null; // the name of the host of this daemon, so we don't have to call the function more than once.
let playerStats = null; // stores ultipliers for player abilities and other player info
let hasFormulas = true;
let currentTerminalServer; // Periodically updated when intelligence farming, the current connected terminal server.
let dictSourceFiles; // Available source files
let bitnodeMults = null; // bitnode multipliers that can be automatically determined after SF-5

// Property to avoid log churn if our status hasn't changed since the last loop
let lastUpdate = "";
let lastUpdateTime = Date.now();
let lowUtilizationIterations = 0;
let highUtilizationIterations = 0;

// Replacements / wrappers for various NS calls to let us keep track of them in one place and consolidate where possible
let log = (...args) => logHelper(_ns, ...args);

function updatePlayerStats() { return playerStats = _ns.getPlayer(); }

function playerHackSkill() { return playerStats.hacking; }

function getPlayerHackingGrowMulti() { return playerStats.hacking_grow_mult };
//let playerMoney = () => playerStats.money;
function doesFileExist(filename, hostname = undefined) { return _ns.fileExists(filename, hostname); }

let psCache = [];
/** @param {NS} ns 
 * PS can get expensive, and we use it a lot so we cache this for the duration of a loop */
function ps(ns, server, canUseCache = true) {
    const cachedResult = psCache[server];
    return canUseCache && cachedResult ? cachedResult : (psCache[server] = ns.ps(server));
}

// Returns true if we're at a point where we want to save money for a big purchase on the horizon
function shouldReserveMoney() {
    let playerMoney = _ns.getServerMoneyAvailable("home");
    if (!doesFileExist("SQLInject.exe", "home")) {
        if (playerMoney > 20000000)
            return true; // Start saving at 200m of the 250m required for SQLInject
    } else if (!playerStats.has4SDataTixApi) {
        if (playerMoney >= (bitnodeMults.FourSigmaMarketDataApiCost * 25000000000) / 2)
            return true; // Start saving if we're half-way to buying 4S market access  
    }
    return false;
}

let options;
const argsSchema = [
    ['h', false], // Do nothing but hack, no prepping (drains servers to 0 money, if you want to do that for some reason)
    ['hack-only', false],
    ['s', false], // Enable Stock Manipulation
    ['stock-manipulation', false],
    ['stock-manipulation-focus', false], // Stocks are main source of income - kill any scripts that would do them harm
    ['v', false], // Detailed logs about batch scheduling / tuning
    ['verbose', false],
    ['o', false], // Good for debugging, run the main targettomg loop once then stop, with some extra logs
    ['run-once', false],
    ['x', false], // Focus on a strategy that produces the most hack EXP rather than money
    ['xp-only', false],
    ['n', false], // Can toggle on using hacknet nodes for extra hacking ram (at the expense of hash production)
    ['silent-misfires', false],
    ['use-hacknet-nodes', false],
    ['initial-max-targets', 2],
    ['max-steal-percentage', 0.75], // Don't steal more than this in case something goes wrong with timing or scheduling, it's hard to recover from
    ['cycle-timing-delay', 16000],
    ['queue-delay', 1000],
    ['max-batches', 40],
    ['i', false], // Farm intelligence with manual hack.
    ['reserved-ram', 32],
    ['looping-mode', false], // Set to true to attempt to schedule perpetually-looping tasks.
    ['recovery-thread-padding', 1],
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

// script entry point
/** @param {NS} ns **/
export async function main(ns) {
    _ns = ns;
    daemonHost = "home"; // ns.getHostname(); // get the name of this node (realistically, will always be home)
    updatePlayerStats();
    dictSourceFiles = await getActiveSourceFiles_Custom(ns, getNsDataThroughFile);
    log("The following source files are active: " + JSON.stringify(dictSourceFiles));
    //ns.disableLog('ALL');
    disableLogs(ns, ['getServerMaxRam', 'getServerUsedRam', 'getServerMoneyAvailable', 'getServerGrowth', 'getServerSecurityLevel', 'exec', 'scan']);

    // Reset global vars on startup since they persist in memory in certain situations (such as on Augmentation)
    lastUpdate = "";
    lastUpdateTime = Date.now();
    lowUtilizationIterations = 0;
    highUtilizationIterations = 0;
    serverListByFreeRam = [];
    serverListByTargetOrder = [];
    serverListByMaxRam = [];
    addedServerNames = [];
    portCrackers = [];
    tools = [];
    toolsByShortName = [];
    psCache = [];

    // Process command line args (if any)
    options = ns.flags(argsSchema);
    hackOnly = options.h || options['hack-only'];
    xpOnly = options.x || options['xp-only'];
    stockMode = options.s || options['stock-manipulation'] || options['stock-manipulation-focus'];
    stockFocus = options['stock-manipulation-focus'];
    useHacknetNodes = options.n || options['run-once'];
    verbose = options.v || options.verbose;
    runOnce = options.o || options['run-once'];
    loopingMode = options['looping-mode'];
    recoveryThreadPadding = options['recovery-thread-padding'];
    // Log which flaggs are active
    if (hackOnly) log('-h - Hack-Only mode activated!');
    if (xpOnly) log('-x - Hack XP Grinding mode activated!');
    if (stockMode) log('-s - Stock market manipulation mode activated!');
    if (stockFocus) log('--stock-manipulation-focus - Stock market manipulation is the main priority');
    if (xpOnly) log('-n - Using hacknet nodes to run scripts!');
    if (verbose) log('-v - Verbose logging activated!');
    if (runOnce) log('-o - Run-once mode activated!');
    if (loopingMode) {
        log('--looping-mode - scheduled remote tasks will loop themselves');
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
    asynchronousHelpers = [
        { name: "stats.js", shouldRun: () => ns.getServerMaxRam("home") >= 64 /* Don't waste precious RAM */ }, // Adds stats not usually in the HUD
        { name: "hacknet-upgrade-manager.js", args: ["-c", "--max-payoff-time", "1h"] }, // Kickstart hash income by buying everything with up to 1h payoff time immediately
        { name: "stockmaster.js", tail: true, shouldRun: () => playerStats.hasTixApiAccess, args: ["--show-market-summary"] }, // Start our stockmaster if we have the required stockmarket access
        { name: "gangs.js", tail: true, shouldRun: () => 2 in dictSourceFiles }, // Script to create manage our gang for us
        { name: "work-for-factions.js", shouldRun: () => 4 in dictSourceFiles, args: ['--fast-crimes-only', '--no-coding-contracts'] }, // Script to manage how we use our "focus" work
        { name: "spend-hacknet-hashes.js", shouldRun: () => 9 in dictSourceFiles, args: ["-v"] }, // Always have this running to make sure hashes aren't wasted
        { name: "sleeve.js", tail: true, shouldRun: () => 10 in dictSourceFiles }, // Script to create manage our sleeves for us
    ];
    asynchronousHelpers.forEach(helper => helper.isLaunched = false);
    asynchronousHelpers.forEach(helper => helper.requiredServer = "home"); // All helpers should be launched at home since they use tempory scripts, and we only reserve ram on home
    // These scripts are spawned periodically (at some interval) to do their checks, with an optional condition that limits when they should be spawned
    let shouldUpgradeHacknet = () => !shouldReserveMoney() && (whichServerIsRunning(ns, "hacknet-upgrade-manager.js", false) === null);
    periodicScripts = [
        // Buy tor as soon as we can if we haven't already, and all the port crackers
        { interval: 29000, name: "/Tasks/tor-manager.js", shouldRun: () => 4 in dictSourceFiles && !addedServerNames.includes("darkweb") },
        { interval: 30000, name: "/Tasks/program-manager.js", shouldRun: () => 4 in dictSourceFiles && getNumPortCrackers() != 5 },
        { interval: 31000, name: "/Tasks/ram-manager.js", shouldRun: () => 4 in dictSourceFiles && dictSourceFiles[4] >= 2 && !shouldReserveMoney() && (getTotalNetworkUtilization() > 0.85 || xpOnly) },
        // Buy every hacknet upgrade with up to 4h payoff if it is less than 10% of our current money or 8h if it is less than 1% of our current money
        { interval: 32000, name: "hacknet-upgrade-manager.js", shouldRun: shouldUpgradeHacknet, args: () => ["-c", "--max-payoff-time", "4h", "--max-spend", ns.getServerMoneyAvailable("home") * 0.1] },
        { interval: 33000, name: "hacknet-upgrade-manager.js", shouldRun: shouldUpgradeHacknet, args: () => ["-c", "--max-payoff-time", "8h", "--max-spend", ns.getServerMoneyAvailable("home") * 0.01] },
        // Don't start auto-joining factions until we're holding 1 billion (so coding contracts returning money is probably less critical) or we've joined one already
        { interval: 34000, name: "faction-manager.js", requiredServer: "home", args: ['--join-only'], shouldRun: () => 4 in dictSourceFiles && (playerStats.factions.length > 0 || ns.getServerMoneyAvailable("home") > 1e9) },
        { interval: 51000, name: "/Tasks/contractor.js", requiredServer: "home" },
        { interval: 110000, name: "/Tasks/backdoor-all-servers.js", requiredServer: "home", shouldRun: () => 4 in dictSourceFiles },
        { interval: 111000, name: "host-manager.js", requiredServer: "home", shouldRun: () => !shouldReserveMoney() },
    ];
    hackTools = [
        { name: "/Remote/weak-target.js", shortName: "weak" },
        { name: "/Remote/grow-target.js", shortName: "grow" },
        { name: "/Remote/hack-target.js", shortName: "hack" },
        { name: "/Remote/manualhack-target.js", shortName: "manualhack" }
    ];
    // TODO: Revive these tools when needed.
    buildToolkit(ns); // build toolkit
    await getStaticServerData(ns, scanAllServers(ns)); // Gather information about servers that will never change
    buildServerList(ns); // create the exhaustive server list    
    buildPortCrackingArray(ns); // build port cracking array  
    await establishMultipliers(ns); // figure out the various bitnode and player multipliers

    if (!hackOnly)
        await runStartupScripts(ns); // Start helper scripts
    if (playerHackSkill() < 3000 && !xpOnly)
        await kickstartHackXp(ns, 0.5, verbose, 1); // Fire a hack XP cycle using a chunk of free RAM
    if (stockFocus)
        maxTargets = Object.keys(serverStockSymbols).length; // Ensure we immediately attempt to target all servers that represent stocks
    if (stockMode && !playerStats.hasTixApiAccess)
        log("WARNING: Ran with '--stock-manipulation' flag, but this will have no effect until you buy access to the stock market API then restart or manually run stockmaster.js");

    maxTargets = Math.max(maxTargets, options['initial-max-targets'])

    // the actual worker processes live here
    await doTargetingLoop(ns);
}

// Check running status of scripts on servers
function whichServerIsRunning(ns, scriptName, canUseCache = true) {
    for (const server of serverListByFreeRam)
        if (ps(ns, server.name, canUseCache).some(process => process.filename === scriptName))
            return server.name;
    return null;
}

// Helper to kick off helper scripts
async function runStartupScripts(ns) {
    log("runStartupScripts");
    for (const helper of asynchronousHelpers)
        if (!helper.isLaunched && (helper.shouldRun === undefined || helper.shouldRun()))
            helper.isLaunched = await tryRunTool(ns, getTool(helper))
    // if every helper is launched already return "true" so we can skip doing this each cycle going forward.
    return asynchronousHelpers.reduce((allLaunched, tool) => allLaunched && tool.isLaunched, true);
}

// Checks whether it's time for any scheduled tasks to run
/** @param {NS} ns **/
async function runPeriodicScripts(ns) {
    for (const task of periodicScripts) {
        let tool = getTool(task);
        if ((Date.now() - (task.lastRun || 0) >= task.interval) && (task.shouldRun === undefined || task.shouldRun())) {
            task.lastRun = Date.now()
            await tryRunTool(ns, tool);
        }
    }
    // A couple other quick tasks
    let playerMoney = ns.getServerMoneyAvailable("home");
    // Super-early aug, if we are poor, spend hashes as soon as we get them for a quick cash injection:
    if (playerMoney < 10000000) {
        await runCommand(ns, `0; if(ns.hacknet.spendHashes("Sell for Money")) ns.toast('Sold 4 hashes for \$1M', 'success')`, '/Temp/sell-hashes-for-money.js');
    }
}

// Returns true if the tool is running (including if it was already running), false if it could not be run.
/** @param {NS} ns **/
async function tryRunTool(ns, tool) {
    if (!doesFileExist(tool.name)) {
        log(`ERROR: Tool ${tool.name} was not found on ${daemonHost}`, true, 'error');
        return false;
    }
    let runningOnServer = whichServerIsRunning(ns, tool.name);
    if (runningOnServer != null) {
        if (verbose) log(`INFO: Tool ${tool.name} is already running on server ${runningOnServer}.`);
        return true;
    }
    const args = tool.args ? (tool.args instanceof Function ? tool.args() : tool.args) : []; // Support either a static args array, or a function returning the args.
    const runResult = await arbitraryExecution(ns, tool, 1, args, tool.requiredServer || "home"); // TODO: Allow actually requiring a server
    if (runResult) {
        runningOnServer = whichServerIsRunning(ns, tool.name, false);
        if (verbose) log(`Ran tool: ${tool.name} on server ${runningOnServer}` + (args.length > 0 ? ` with args ${JSON.stringify(args)}` : ''));
        if (tool.tail === true) {
            log(`Tailing Tool: ${tool.name} on server ${runningOnServer}` + (args.length > 0 ? ` with args ${JSON.stringify(args)}` : ''));
            ns.tail(tool.name, runningOnServer, ...args);
            tool.tail = false; // Avoid popping open additional tail windows in the future
        }
        return true;
    } else
        log(`WARNING: Tool cannot be run (insufficient RAM? REQ: ${formatRam(tool.cost)}): ${tool.name}`, false, 'warning');
    return false;
}

// Main targeting loop
/** @param {NS} ns **/
async function doTargetingLoop(ns) {
    log("doTargetingLoop");
    let loops = -1;
    //var isHelperListLaunched = false; // Uncomment this and related code to keep trying to start helpers
    do {
        loops++;
        if (loops > 0) await ns.sleep(loopInterval);
        try {
            var start = Date.now();
            psCache = []; // Clear the cache of the process list we update once per loop           
            buildServerList(ns, true); // Check if any new servers have been purchased by the external host_manager process           
            updatePlayerStats(); // Update player info
            // run some auxilliary processes that ease the ram burden of this daemon and add additional functionality (like managing hacknet or buying servers)
            //if (!isHelperListLaunched) isHelperListLaunched = await runStartupScripts(ns);
            await runPeriodicScripts(ns);

            if (stockMode) await updateStockPositions(ns); // In stock market manipulation mode, get our current position in all stocks
            sortServerList("targeting"); // Update the order in which we ought to target servers

            if (loops % 60 == 0) { // For more expensive updates, only do these every so often
                await refreshDynamicServerData(ns, addedServerNames);
                if (verbose && loops % 600 == 0) // Occassionally print our current targetting order (todo, make this controllable with a flag or custom UI?)
                    log('Targetting Order:\n  ' + serverListByTargetOrder.filter(s => s.shouldHack()).map(s =>
                        `${s.isPrepped() ? '*' : ' '} ${s.canHack() ? '✓' : 'X'} Money: ${formatMoney(s.getMoney(), 4)} of ${formatMoney(s.getMaxMoney(), 4)} ` +
                        `(${formatMoney(s.getMoneyPerRamSecond(), 4)}/ram.sec), Sec: ${formatNumber(s.getSecurity(), 3)} of ${formatNumber(s.getMinSecurity(), 3)}, ` +
                        `TTW: ${formatDuration(s.timeToWeaken())}, Hack: ${s.requiredHackLevel} - ${s.name}` +
                        (!stockMode || !serverStockSymbols[s.name] ? '' : ` Sym: ${serverStockSymbols[s.name]} Owned: ${serversWithOwnedStock.includes(s.name)} ` +
                            `Manip: ${shouldManipulateGrow[s.name] ? "grow" : shouldManipulateHack[s.name] ? "hack" : '(disabled)'}`))
                        .join('\n  '));
            }
            var prepping = [];
            var preppedButNotTargeting = [];
            var targeting = [];
            var notRooted = [];
            var cantHack = [];
            var cantHackButPrepped = [];
            var cantHackButPrepping = [];
            var noMoney = [];
            var failed = [];
            var skipped = [];
            var lowestUnhackable = 99999;

            // Hack: We can get stuck and never improve if we don't try to prep at least one server to improve our future targeting options.
            // So get the first un-prepped server that is within our hacking level, and move it to the front of the list.
            var firstUnpreppedServerIndex = serverListByTargetOrder.findIndex(s => s.shouldHack() && s.canHack() && !s.isPrepped() && !s.isTargeting())
            if (firstUnpreppedServerIndex !== -1 && !stockMode)
                serverListByTargetOrder.unshift(serverListByTargetOrder.splice(firstUnpreppedServerIndex, 1)[0]);

            // If this gets set to true, the loop will continue (e.g. to gather information), but no more work will be scheduled
            var workCapped = false;
            // Function to assess whether we've hit some cap that should prevent us from scheduling any more work
            let isWorkCapped = () => workCapped = workCapped || failed.length > 0 // Scheduling fails when there's insufficient RAM. We've likely encountered a "soft cap" on ram utilization e.g. due to fragmentation
                || getTotalNetworkUtilization() >= maxUtilization // "hard cap" on ram utilization, can be used to reserve ram or reduce the rate of encountering the "soft cap"
                || targeting.length >= maxTargets // variable cap on the number of simultaneous targets
                || (targeting.length + prepping.length) >= (maxTargets + maxPreppingAtMaxTargets); // Only allow a couple servers to be prepped in advance when at max-targets

            // check for servers that need to be rooted
            // simultaneously compare our current target to potential targets
            for (var i = 0; i < serverListByTargetOrder.length; i++) {
                if ((Date.now() - start) >= maxLoopTime) { // To avoid lagging the game, completely break out of the loop if we start to run over
                    skipped = skipped.concat(serverListByTargetOrder.slice(i));
                    workCapped = true;
                    break;
                }

                const server = serverListByTargetOrder[i];
                // Attempt to root any servers that are not yet rooted
                if (!server.hasRoot() && server.canCrack())
                    doRoot(server);

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
                    targeting.push(server); // TODO: While targeting, we should keep queuing more batches
                } else if (server.isPrepping()) { // Note servers already being prepped from a prior loop
                    prepping.push(server);
                } else if (isWorkCapped() || xpOnly) { // Various conditions for which we'll postpone any additional work on servers (computed at the end of each loop)
                    if (xpOnly && (((nextXpCycleEnd[server.name] || 0) > start - 10000) || server.isXpFarming()))
                        targeting.push(server); // A server counts as "targeting" if in XP mode and its due to be farmed or was in the past 10 seconds
                    else
                        skipped.push(server);
                } else if (!hackOnly && true == await prepServer(ns, server)) { // Returns true if prepping, false if prepping failed, null if prepped
                    if (server.previouslyPrepped)
                        log(`WARNING ${server.prepRegressions++}: Server was prepped, but now at security: ${formatNumber(server.getSecurity())} ` +
                            `(min ${formatNumber(server.getMinSecurity())}) money: ${formatMoney(server.getMoney(), 3)} (max ${formatMoney(server.getMaxMoney(), 3)}). ` +
                            `Prior cycle: ${server.previousCycle}. ETA now (Hack ${playerHackSkill()}) is ${formatDuration(server.timeToWeaken())}`, true, 'warning');
                    prepping.push(server); // Perform weakening and initial growth until the server is "perfected" (unless in hack-only mode)
                } else if (!hackOnly && !server.isPrepped()) { // If prepServer returned false or null. Check ourselves whether it is prepped
                    log('Prep failed for "' + server.name + '" (RAM Utilization: ' + (getTotalNetworkUtilization() * 100).toFixed(2) + '%)');
                    failed.push(server);
                } else if (targeting.length >= maxTargets) { // Hard cap on number of targets, changes with utilization
                    server.previouslyPrepped = true;
                    preppedButNotTargeting.push(server);
                } else { // Otherwise, server is prepped at min security & max money and ready to target                       
                    var performanceSnapshot = optimizePerformanceMetrics(server); // Adjust the percentage to steal for optimal scheduling
                    if (server.actualPercentageToSteal() === 0) { // Not enough RAM for even one hack thread of this next-best target.
                        failed.push(server);
                    } else if (true == await performScheduling(ns, server, performanceSnapshot)) { // once conditions are optimal, fire barrage after barrage of cycles in a schedule
                        targeting.push(server);
                    } else {
                        log('Targeting failed for "' + server.name + '" (RAM Utilization: ' + (getTotalNetworkUtilization() * 100).toFixed(2) + '%)');
                        failed.push(server);
                    }
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
                // TODO: Something is not working right here, so until we figure it out, never look at more than the first unhackable server.
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
                        log('Pre-Prep failed for "' + server.name + '" with ' + server.requiredHackLevel +
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
            //log(`intervalsPerTargetCycle: ${intervalsPerTargetCycle} lowUtilizationIterations: ${lowUtilizationIterations} loopInterval: ${loopInterval}`);
            if ((lowUtilizationIterations > intervalsPerTargetCycle || utilizationPercent < 0.01) && skipped.length > 0 && maxTargets < serverListByTargetOrder.length) {
                maxTargets++;
                log(`Increased max targets to ${maxTargets} since utilization (${formatNumber(utilizationPercent * 100, 3)}%) has been quite low for ${lowUtilizationIterations} iterations.`);
                lowUtilizationIterations = 0; // Reset the counter of low-utilization iterations
            } else if (highUtilizationIterations > 60) { // Decrease max-targets by 1 ram utilization is too high (prevents scheduling efficient cycles)
                maxTargets -= 1;
                log(`Decreased max targets to ${maxTargets} since utilization has been > ${formatNumber(maxUtilization * 100, 3)}% for 60 iterations and scheduling failed.`);
                highUtilizationIterations = 0; // Reset the counter of high-utilization iterations
            }
            maxTargets = Math.max(maxTargets, targeting.length - 1, 1); // Ensure that after a restart, maxTargets start off with no less than 1 fewer max targets

            // Ifthere is still unspent utilization, we can use a chunk of it it to farm XP
            if (xpOnly) { // If all we want to do is gain hack XP
                let time = await kickstartHackXp(ns, 1.00, verbose);
                loopInterval = Math.min(1000, time || 1000); // Wake up earlier if we're almost done an XP cycle
            } else if (!workCapped && lowUtilizationIterations > 10) {
                let expectedRunTime = getXPFarmServer().timeToHack();
                let freeRamToUse = (expectedRunTime < loopInterval) ? // If expected runtime is fast, use as much RAM as we want, it'll all be free by our next loop.
                    1 - (1 - lowUtilizationThreshold) / (1 - utilizationPercent) : // Take us just up to the threshold for 'lowUtilization' so we don't cause unecessary server purchases
                    1 - (1 - maxUtilizationPreppingAboveHackLevel - 0.05) / (1 - utilizationPercent); // Otherwise, leave more room (e.g. for scheduling new batches.)
                await kickstartHackXp(ns, freeRamToUse, verbose && (expectedRunTime > 10000 || lowUtilizationIterations % 10 == 0), 1);
            }

            // Log some status updates
            let keyUpdates = `Of ${serverListByFreeRam.length} total servers:\n > ${noMoney.length} were ignored (owned or no money)`;
            if (notRooted.length > 0)
                keyUpdates += `, ${notRooted.length} are not rooted (missing ${portCrackers.filter(c => !c.exists()).map(c => c.name).join(',')})`;
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
                log((lastUpdate = keyUpdates) +
                    '\n > RAM Utilization: ' + formatRam(Math.ceil(network.totalUsedRam)) + ' of ' + formatRam(network.totalMaxRam) + ' (' + (utilizationPercent * 100).toFixed(1) + '%) ' +
                    `for ${lowUtilizationIterations || highUtilizationIterations} its, Max Targets: ${maxTargets}, Loop Took: ${Date.now() - start}ms`);
                lastUpdateTime = Date.now();
            }
            //log('Prepping: ' + prepping.map(s => s.name).join(', '))
            //log('targeting: ' + targeting.map(s => s.name).join(', '))
        } catch (err) {
            log('WARNING: Caught an error in the targeting loop: ' + err, true, 'warning');
            // Note netscript errors are raised as a simple string (no message property)
            var errorMessage = String(err.message || err);
            // Catch errors that appear to be caused by deleted servers, and remove the server from our lists.
            const expectedDeletedHostPhrase = "Invalid IP/hostname: ";
            let expectedErrorPhraseIndex = errorMessage.indexOf(expectedDeletedHostPhrase);
            if (expectedErrorPhraseIndex == -1) continue;
            let start = expectedErrorPhraseIndex + expectedDeletedHostPhrase.length;
            let lineBreak = errorMessage.indexOf('<br>', start);
            let deletedHostName = errorMessage.substring(start, lineBreak);
            log('INFO: The server "' + deletedHostName + '" appears to have been deleted. Removing it from our lists', false, 'info');
            removeServerByName(deletedHostName);
        }
    } while (!runOnce);
}

// How much a weaken thread is expected to reduce security by
let actualWeakenPotency = () => bitnodeMults.ServerWeakenRate * weakenThreadPotency * (1 - weakenThreadPadding);

// Dictionaries of static server information
let serversDictCommand = (servers, command) => `Object.fromEntries(${JSON.stringify(servers)}.map(server => [server, ${command}]))`;
let dictServerRequiredHackinglevels;
let dictServerNumPortsRequired;
let dictServerMinSecurityLevels;
let dictServerMaxMoney;
let dictServerProfitInfo;

// Gathers up arrays of server data via external request to have the data written to disk.
async function getStaticServerData(ns, serverNames) {
    dictServerRequiredHackinglevels = await getNsDataThroughFile(ns, serversDictCommand(serverNames, 'ns.getServerRequiredHackingLevel(server)'), '/Temp/servers-hack-req.txt');
    dictServerNumPortsRequired = await getNsDataThroughFile(ns, serversDictCommand(serverNames, 'ns.getServerNumPortsRequired(server)'), '/Temp/servers-num-ports.txt');
    await refreshDynamicServerData(ns, serverNames);
}

/** @param {NS} ns **/
async function refreshDynamicServerData(ns, serverNames) {
    dictServerMinSecurityLevels = await getNsDataThroughFile(ns, serversDictCommand(serverNames, 'ns.getServerMinSecurityLevel(server)'), '/Temp/servers-security.txt');
    dictServerMaxMoney = await getNsDataThroughFile(ns, serversDictCommand(serverNames, 'ns.getServerMaxMoney(server)'), '/Temp/servers-max-money.txt');
    // Get the information about the relative profitability of each server
    const pid = ns.exec('analyze-hack.js', 'home', 1, '--all', '--silent');
    await waitForProcessToComplete_Custom(ns, getFnIsAliveViaNsPs(ns), pid);
    dictServerProfitInfo = ns.read('/Temp/analyze-hack.txt');
    if (!dictServerProfitInfo) return log(ns, "WARN: analyze-hack info unavailable.");
    dictServerProfitInfo = Object.fromEntries(JSON.parse(dictServerProfitInfo).map(s => [s.hostname, s]));
    //ns.print(dictServerProfitInfo);
    if (options.i)
        currentTerminalServer = getServerByName(await getNsDataThroughFile(ns, 'ns.getCurrentServer()'));
}

/** @param {NS} ns **/
function buildServerObject(ns, node) {
    return {
        ns: ns,
        name: node,
        requiredHackLevel: dictServerRequiredHackinglevels[node],
        portsRequired: dictServerNumPortsRequired[node],
        getMinSecurity: () => dictServerMinSecurityLevels[node] ?? 0, // Servers not in our dictionary were purchased, and so undefined is okay
        getMaxMoney: () => dictServerMaxMoney[node] ?? 0,
        getMoneyPerRamSecond: () => dictServerProfitInfo ? dictServerProfitInfo[node]?.gainRate ?? 0 : (dictServerMaxMoney[node] ?? 0),
        getExpPerSecond: () => dictServerProfitInfo ? dictServerProfitInfo[node]?.expRate ?? 0 : (1 / dictServerMinSecurityLevels[node] ?? 0),
        percentageToSteal: 1.0 / 16.0, // This will get tweaked automatically based on RAM available and the relative value of this server
        getMoney: function () { return this.ns.getServerMoneyAvailable(this.name); },
        getSecurity: function () { return this.ns.getServerSecurityLevel(this.name); },
        canCrack: function () { return getNumPortCrackers() >= this.portsRequired; },
        canHack: function () { return this.requiredHackLevel <= playerHackSkill(); },
        shouldHack: function () {
            return this.getMaxMoney() > 0 && this.name !== "home" && !this.name.startsWith('hacknet-node-') &&
                !this.name.startsWith(purchasedServersName); // Hack, but beats wasting 2.25 GB on ns.getPurchasedServers()
        },
        previouslyPrepped: false,
        prepRegressions: 0,
        previousCycle: null,
        // "Prepped" means current security is at the minimum, and current money is at the maximum
        isPrepped: function () {
            let currentSecurity = this.getSecurity();
            let currentMoney = this.getMoney();
            // Logic for whether we consider the server "prepped" (tolerate a 1% discrepancy)
            let isPrepped = (currentSecurity == 0 || ((this.getMinSecurity() / currentSecurity) >= 0.99)) &&
                (this.getMaxMoney() != 0 && ((currentMoney / this.getMaxMoney()) >= 0.99) || stockFocus /* Only prep security in stock-focus mode */);
            return isPrepped;
        },
        // Function to tell if the sever is running any tools, with optional filtering criteria on the tool being run
        isSubjectOfRunningScript: function (filter, useCache = true, count = false) {
            const toolNames = hackTools.map(t => t.name);
            let total = 0;
            // then figure out if the servers are running the other 2, that means prep
            for (const hostname of addedServerNames)
                for (const process of ps(ns, hostname, useCache))
                    if (toolNames.includes(process.filename) && process.args[0] == this.name && (!filter || filter(process))) {
                        if (count) total++; else return true;
                    }
            return count ? total : false;
        },
        isPrepping: function (useCache = true) {
            return this.isSubjectOfRunningScript(process => process.args.length > 4 && process.args[4] == "prep", useCache);
        },
        isTargeting: function (useCache = true) {
            return this.isSubjectOfRunningScript(process => process.args.length > 4 && process.args[4].includes('Batch'), useCache);
        },
        isXpFarming: function (useCache = true) {
            return this.isSubjectOfRunningScript(process => process.args.length > 4 && process.args[4].includes('FarmXP'), useCache);
        },
        serverGrowthPercentage: function () {
            return this.ns.getServerGrowth(this.name) * bitnodeMults.ServerGrowthRate * getPlayerHackingGrowMulti() / 100;
        },
        adjustedGrowthRate: function () { return Math.min(maxGrowthRate, 1 + ((unadjustedGrowthRate - 1) / this.getMinSecurity())); },
        actualServerGrowthRate: function () {
            return Math.pow(this.adjustedGrowthRate(), this.serverGrowthPercentage());
        },
        // this is the target growth coefficient *immediately*
        targetGrowthCoefficient: function () {
            return this.getMaxMoney() / Math.max(this.getMoney(), 1);
        },
        // this is the target growth coefficient per cycle, based on theft
        targetGrowthCoefficientAfterTheft: function () {
            return 1 / (1 - (this.getHackThreadsNeeded() * this.percentageStolenPerHackThread()));
        },
        cyclesNeededForGrowthCoefficient: function () {
            return Math.log(this.targetGrowthCoefficient()) / Math.log(this.adjustedGrowthRate());
        },
        cyclesNeededForGrowthCoefficientAfterTheft: function () {
            return Math.log(this.targetGrowthCoefficientAfterTheft()) / Math.log(this.adjustedGrowthRate());
        },
        percentageStolenPerHackThread: function () {
            if (hasFormulas) {
                try {
                    let server = {
                        hackDifficulty: this.getMinSecurity(),
                        requiredHackingSkill: this.requiredHackLevel
                    }
                    return ns.formulas.hacking.hackPercent(server, playerStats); // hackAnalyzePercent(this.name) / 100;
                } catch {
                    hasFormulas = false;
                }
            }
            return Math.min(1, Math.max(0, (((100 - Math.min(100, this.getMinSecurity())) / 100) *
                ((playerHackSkill() - (this.requiredHackLevel - 1)) / playerHackSkill()) / 240)));
        },
        actualPercentageToSteal: function () {
            return this.getHackThreadsNeeded() * this.percentageStolenPerHackThread();
        },
        getHackThreadsNeeded: function () {
            // Force rounding of low-precision digits before taking the floor, to avoid double imprecision throwing us way off.
            return Math.floor((this.percentageToSteal / this.percentageStolenPerHackThread()).toPrecision(14));
        },
        getGrowThreadsNeeded: function () {
            return Math.min(this.getMaxMoney(), // Worse case (0 money on server) we get 1$ per thread
                Math.ceil((this.cyclesNeededForGrowthCoefficient() / this.serverGrowthPercentage()).toPrecision(14)));
        },
        getGrowThreadsNeededAfterTheft: function () {
            return Math.min(this.getMaxMoney(), // Worse case (0 money on server) we get 1$ per thread
                Math.ceil((this.cyclesNeededForGrowthCoefficientAfterTheft() / this.serverGrowthPercentage()).toPrecision(14)));
        },
        getWeakenThreadsNeededAfterTheft: function () {
            return Math.ceil((this.getHackThreadsNeeded() * hackThreadHardening / actualWeakenPotency()).toPrecision(14));
        },
        getWeakenThreadsNeededAfterGrowth: function () {
            return Math.ceil((this.getGrowThreadsNeededAfterTheft() * growthThreadHardening / actualWeakenPotency()).toPrecision(14));
        },
        // Once we get root, we never lose it, so we can stop asking
        _hasRootCached: false,
        hasRoot: function () { return this._hasRootCached || (this._hasRootCached = this.ns.hasRootAccess(this.name)); },
        isHost: function () { return this.name == daemonHost; },
        totalRam: function () { return this.ns.getServerMaxRam(this.name); },
        // Used ram is constantly changing
        usedRam: function () {
            var usedRam = this.ns.getServerUsedRam(this.name);
            // Complete HACK: but for most planning purposes, we want to pretend home has more ram in use than it does to leave room for "preferred" jobs at home
            if (this.name == "home")
                usedRam = Math.min(this.totalRam(), usedRam + homeReservedRam);
            return usedRam;
        },
        ramAvailable: function () { return this.totalRam() - this.usedRam(); },
        growDelay: function () { return this.timeToWeaken() - this.timeToGrow() + cycleTimingDelay; },
        hackDelay: function () { return this.timeToWeaken() - this.timeToHack(); },
        timeToWeaken: function () { return this.ns.getWeakenTime(this.name); },
        timeToGrow: function () { return this.ns.getGrowTime(this.name); },
        timeToHack: function () { return this.ns.getHackTime(this.name); },
        weakenThreadsNeeded: function () { return Math.ceil(((this.getSecurity() - this.getMinSecurity()) / actualWeakenPotency()).toPrecision(14)); }
    };
}

// Helpers to get slices of info / cumulative stats across all rooted servers
function getNetworkStats() {
    const rootedServers = serverListByMaxRam.filter(server => server.hasRoot());
    const listOfServersFreeRam = rootedServers.map(s => s.ramAvailable()).filter(ram => ram > 1.6); // Servers that can't run a script don't count
    const totalMaxRam = rootedServers.map(s => s.totalRam()).reduce((a, b) => a + b, 0);
    const totalFreeRam = listOfServersFreeRam.reduce((a, b) => a + b, 0);
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
// TODO: Better gaugue of performance is money stolen per (RAM * time) cost - we can schedule as many cycles as we want if done smart
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
function optimizePerformanceMetrics(currentTarget) {
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
        const adjustment = analyzeSnapshot(performanceSnapshot, currentTarget, networkStats, increment);
        if (runOnce && verbose)
            log(`Adjustment ${attempts} (increment ${increment}): ${adjustment} to ${newHackThreads} hack threads ` +
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
        log(`Tuned % to steal from ${formatNumber(oldActualPercentageToSteal * 100)}% (${oldHackThreads} threads) to ` +
            `${formatNumber(currentTarget.actualPercentageToSteal() * 100)}% (${currentTarget.getHackThreadsNeeded()} threads) ` +
            `(${currentTarget.name}) Iterations: ${attempts} Took: ${Date.now() - start} ms`);
    }
    if (verbose && currentTarget.actualPercentageToSteal() == 0) {
        currentTarget.percentageToSteal = percentPerHackThread;
        log(`Insufficient RAM for min cycle: ${getTargetSummary(currentTarget)}`);
        currentTarget.percentageToSteal = 0.0;
    }
    if (currentTarget.percentageToSteal != 0 && (currentTarget.actualPercentageToSteal() == 0 ||
        Math.abs(currentTarget.actualPercentageToSteal() - currentTarget.percentageToSteal) / currentTarget.percentageToSteal > 0.5))
        log(`WARNING: Big difference between %ToSteal (${formatNumber(currentTarget.percentageToSteal * 100)}%) ` +
            `and actual%ToSteal (${formatNumber(currentTarget.actualPercentageToSteal() * 100)}%) after ${attempts} attempts. ` +
            `Min is: ${formatNumber(currentTarget.percentageStolenPerHackThread() * 100)}%`, false, 'warning');
    return performanceSnapshot;
}

// Suggests an adjustment to the percentage to steal based on how much ram would be consumed if attempting the current percentage.
function analyzeSnapshot(snapshot, currentTarget, networkStats, incrementalHackThreads) {
    const maxPercentageToSteal = options['max-steal-percentage'];
    const lastP2steal = currentTarget.percentageToSteal;
    // Priority is to use as close to the target ram as possible overshooting.
    const isOvershot = s => !s.canBeScheduled || s.maxCompleteCycles < s.optimalPacedCycles;
    if (verbose && runOnce)
        log(`canBeScheduled: ${snapshot.canBeScheduled},  maxCompleteCycles: ${snapshot.maxCompleteCycles}, optimalPacedCycles: ${snapshot.optimalPacedCycles}`);
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
    if (!snapshot)
        return;
    if (maxCycles === 0) {
        log(`WARNING: Attempt to schedule ${getTargetSummary(currentTarget)} returned 0 max cycles? ${JSON.stringify(snapshot)}`, false, 'warning');
        return;
    } else if (currentTarget.getHackThreadsNeeded() === 0) {
        log(`WARNING: Attempted to schedule empty cycle ${maxCycles} x ${getTargetSummary(currentTarget)}? ${JSON.stringify(snapshot)}`, false, 'warning');
        return;
    }
    let firstEnding = null, lastStart = null, lastBatch = 0, cyclesScheduled = 0;
    while (cyclesScheduled < maxCycles) {
        const newBatchStart = new Date((cyclesScheduled === 0) ? Date.now() + queueDelay : lastBatch.getTime() + cycleTimingDelay);
        lastBatch = new Date(newBatchStart.getTime());
        const batchTiming = getScheduleTiming(newBatchStart, currentTarget);
        const newBatch = getScheduleObject(batchTiming, currentTarget, scheduledTasks.length);
        if (firstEnding === null) { // Can't start anything after this first hack completes (until back at min security), or we risk throwing off timing
            firstEnding = new Date(newBatch.hackEnd.valueOf());
        }
        if (lastStart === null || lastStart < newBatch.firstFire) {
            lastStart = new Date(newBatch.lastFire.valueOf());
        }
        if (cyclesScheduled > 0 && lastStart >= firstEnding) {
            if (verbose)
                log(`Had to stop scheduling at ${cyclesScheduled} of ${maxCycles} desired cycles (lastStart: ${lastStart} >= firstEnding: ${firstEnding}) ${JSON.stringify(snapshot)}`);
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
            if (["hack", "grow"].includes(schedItem.toolShortName)) // Push an arg used by remote hack/grow tools to determine whether it should manipulate the stock market
                args.push(stockMode && (schedItem.toolShortName == "hack" && shouldManipulateHack[currentTarget.name] || schedItem.toolShortName == "grow" && shouldManipulateGrow[currentTarget.name]) ? 1 : 0);
            if (["hack", "weak"].includes(schedItem.toolShortName))
                args.push(options['silent-misfires'] || (schedItem.toolShortName == "hack" && bitnodeMults.ScriptHackMoneyGain == 0) ? 1 : 0); // Optional arg to disable toast warnings about a failed hack if hacking money gain is disabled
            args.push(loopingMode ? 1 : 0); // Argument to indicate whether the cycle should loop perpetually
            if (recoveryThreadPadding > 1 && ["weak", "grow"].includes(schedItem.toolShortName))
                schedItem.threadsNeeded *= recoveryThreadPadding; // Only need to pad grow/weaken threads
            if (options.i && currentTerminalServer?.name == currentTarget.name && schedItem.toolShortName == "hack")
                schedItem.toolShortName = "manualhack";
            const result = await arbitraryExecution(ns, getTool(schedItem.toolShortName), schedItem.threadsNeeded, args)
            if (result == false) { // If execution fails, we have probably run out of ram.
                log(`WARNING: Scheduling failed for ${getTargetSummary(currentTarget)} ${discriminationArg} of ${cyclesScheduled} Took: ${Date.now() - start}ms`, false, 'warning');
                currentTarget.previousCycle = `INCOMPLETE. Tried: ${cyclesScheduled} x ${getTargetSummary(currentTarget)}`;
                return false;
            }
        }
    }
    if (verbose)
        log(`Scheduled ${cyclesScheduled} x ${getTargetSummary(currentTarget)} Took: ${Date.now() - start}ms`);
    currentTarget.previousCycle = `${cyclesScheduled} x ${getTargetSummary(currentTarget)}`
    return true;
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
    if (verbose && runOnce) {
        log(`Current Time: ${formatDateTime(new Date())} Established a schedule for ${getTargetSummary(currentTarget)} from requested startTime ${formatDateTime(fromDate)}:` +
            `\n  Hack - End: ${formatDateTime(schedule.hackEnd)}  Start: ${formatDateTime(schedule.hackStart)}  Time: ${formatDuration(hackTime)}` +
            `\n  Weak1- End: ${formatDateTime(schedule.firstWeakenEnd)}  Start: ${formatDateTime(schedule.firstWeakenStart)}  Time: ${formatDuration(weakenTime)}` +
            `\n  Grow - End: ${formatDateTime(schedule.growEnd)}  Start: ${formatDateTime(schedule.growStart)}  Time: ${formatDuration(growTime)}` +
            `\n  Weak2- End: ${formatDateTime(schedule.secondWeakenEnd)}  Start: ${formatDateTime(schedule.secondWeakenStart)}  Time: ${formatDuration(weakenTime)}`);
    }
    return schedule;
}

function getScheduleObject(batchTiming, currentTarget, batchNumber) {
    var schedItems = [];

    var schedHack = getScheduleItem("hack", "hack", batchTiming.hackStart, batchTiming.hackEnd, currentTarget.getHackThreadsNeeded());
    var schedWeak1 = getScheduleItem("weak1", "weak", batchTiming.firstWeakenStart, batchTiming.firstWeakenEnd, currentTarget.getWeakenThreadsNeededAfterTheft());
    // Special end-game case, if we have no choice but to hack a server to zero money, schedule back-to-back grows to restore money
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
        if (verbose)
            log(`INFO: Special grow strategy since percentage stolen per hack thread is 100%: G1: ${injectThreads}, G1: ${schedGrowThreads}, W2: ${schedWeak2.threadsNeeded} (${currentTarget.name})`);
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
/** @param {NS} ns **/
export async function arbitraryExecution(ns, tool, threads, args, preferredServerName = null, useSmallestServerPossible = false) {
    // We will be using the list of servers that is sorted by most available ram
    sortServerList("ram");
    var rootedServersByFreeRam = serverListByFreeRam.filter(server => server.hasRoot() && server.totalRam() > 1.6);

    // Sort servers by total ram, and try to fill these before utilizing another server.
    sortServerList("totalram");
    var preferredServerOrder = serverListByMaxRam.filter(server => server.hasRoot() && server.totalRam() > 1.6);
    if (useSmallestServerPossible) // Fill up small servers before utilizing larger ones (can be laggy)
        preferredServerOrder.reverse();
    // IDEA: "home" is more effective at grow() and weaken() than other nodes (has multiple cores) (TODO: By how much?)
    //       so if this is one of those tools, put it at the front of the list of preferred candidates, otherwise keep home ram free if possible
    //       TODO: This effort is wasted unless we also scale down the number of threads "needed" when running on home. We will overshoot grow/weaken
    //             Disable this for now, and enable it once we have solved for reducing grow/weak threads
    var home = preferredServerOrder.splice(preferredServerOrder.findIndex(i => i.name == "home"), 1)[0];
    if (tool.shortName == "grow" || tool.shortName == "weak" || preferredServerName == "home")
        preferredServerOrder.unshift(home); // Send to front
    else
        preferredServerOrder.push(home);
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
            log(`ERROR: Configured preferred server "${preferredServerName}" for ${tool.name} is not a valid server name`, true, 'error');
    }
    //log(`Preferred Server ${preferredServerName} for ${tool.name} resulted in preferred order: ${preferredServerOrder.map(srv => srv.name)}`);
    //log(`Servers by free ram: ${rootedServersByFreeRam.map(svr => svr.name + " (" + svr.ramAvailable() + ")")}`);

    // Helper function to compute the most threads a server can run 
    let computeMaxThreads = function (server) {
        if (tool.cost == 0) return 1;
        let ramAvailable = server.ramAvailable();
        // It's a hack, but we know that "home"'s reported ram available is lowered to leave room for "preferred" jobs, 
        // so if this is a preferred job, ignore what the server object says and get it from the source
        if (server.name == "home" && preferredServerName == "home")
            ramAvailable = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
        return Math.floor((ramAvailable / tool.cost).toPrecision(14));
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
                    //log('Opted to exec ' + tool.name + ' on preferred server ' + nextMostPreferredServer.name + ' rather than the one with most ram (' + targetServer.name + ')');
                    targetServer = nextMostPreferredServer;
                    break;
                }
            }
        }

        // if not on the daemon host, do a script copy check before running
        if (targetServer.name != daemonHost && !doesFileExist(tool.name, targetServer.name)) {
            if (verbose)
                log(`Copying ${tool.name} from ${daemonHost} to ${targetServer.name} so that it can be executed remotely.`);
            await ns.scp(tool.name, daemonHost, targetServer.name);
            // Some tools require helpers.js
            if (!doesFileExist('helpers.js', targetServer.name))
                await ns.scp('helpers.js', daemonHost, targetServer.name);

        }
        let pid = ns.exec(tool.name, targetServer.name, maxThreadsHere, ...(args || []));
        // A pid of 0 indicates that the run failed
        if (pid == 0) {
            log('ERROR: Failed to exec ' + tool.name + ' on server ' + targetServer.name + ' with ' + maxThreadsHere + ' threads', false, 'error');
            return false;
        }
        // Decrement the threads that have been successfully scheduled
        remainingThreads -= maxThreadsHere;
        if (remainingThreads > 0) {
            if (!tool.isThreadSpreadingAllowed) break;
            // No need to warn if it's allowed? log(`WARNING: Had to split ${threads} ${tool.name} threads across multiple servers. ${maxThreadsHere} on ${targetServer.name}`);
            splitThreads = true;
        }
    }
    // the run failed if there were threads left to schedule after we exhausted our pool of servers
    if (remainingThreads > 0)
        log(`ERROR: Ran out of RAM to run ${tool.name} against ${args[0]} - ${threads - remainingThreads} of ${threads} threads were spawned.`, false, 'error');
    if (splitThreads && !tool.isThreadSpreadingAllowed)
        return false;
    return remainingThreads == 0;
}

// Brings the server to minimum security and maximum money to prepare for cycling scheduler activity
async function prepServer(ns, currentTarget) {
    // Check if already prepped or in targeting mode, in which case presume prep server is to be skipped.
    if (currentTarget.isPrepped() || currentTarget.isTargeting())
        return null;

    var start = Date.now();
    var now = new Date(start.valueOf());
    var prepSucceeding = true;
    var growThreadsScheduled = 0;
    var weakenForGrowthThreadsNeeded = 0;
    var weakenTool = getTool("weak");
    // Schedule grow, if needed
    if (currentTarget.getMoney() < currentTarget.getMaxMoney() && !stockFocus /* Prep should only weaken in stock-focus mode */) {
        var growTool = getTool("grow");
        var growThreadsAllowable = growTool.getMaxThreads();
        var growThreadsNeeded = currentTarget.getGrowThreadsNeeded();
        growThreadsScheduled = Math.min(growThreadsAllowable, growThreadsNeeded);
        weakenForGrowthThreadsNeeded = Math.ceil((growThreadsScheduled * growthThreadHardening / actualWeakenPotency()).toPrecision(14));
        /* // Logic for "releasing" grow threads to make room for weaken threads? Doesn't seem necessary and also may be buggy
        var growThreadThreshold = (growThreadsAllowable - growThreadsNeeded) * (growTool.cost / weakenTool.cost);
        var growThreadsReleased = weakenTool.cost / growTool.cost * (weakenForGrowthThreadsNeeded + currentTarget.weakenThreadsNeeded());
        if (growThreadThreshold >= growThreadsReleased) {
            growThreadsReleased = 0;
        }
        growThreadsScheduled = Math.max(0, growThreadsScheduled - growThreadsReleased);
        */
        if (growThreadsScheduled > 0)
            prepSucceeding = await arbitraryExecution(ns, growTool, growThreadsScheduled, [currentTarget.name, now.getTime(), now.getTime(), 0, "prep"]);
        if (prepSucceeding == false)
            log('Failed to schedule all ' + growThreadsScheduled + ' prep grow threads (' + currentTarget.name + ')');
    }
    // Schedule weaken, if needed
    var weakenThreadsScheduled = 0;
    if (prepSucceeding && (currentTarget.getSecurity() > currentTarget.getMinSecurity() || weakenForGrowthThreadsNeeded > 0)) {
        var weakenThreadsNeeded = currentTarget.weakenThreadsNeeded() + weakenForGrowthThreadsNeeded;
        var weakenThreadsAllowable = weakenTool.getMaxThreads();
        weakenThreadsScheduled = Math.min(weakenThreadsAllowable, weakenThreadsNeeded);
        if (weakenThreadsScheduled > 0)
            prepSucceeding = await arbitraryExecution(ns, weakenTool, weakenThreadsScheduled, [currentTarget.name, now.getTime(), now.getTime(), 0, "prep"]);
        if (prepSucceeding == false)
            log('Failed to schedule all ' + weakenThreadsScheduled + ' prep weaken threads (' + currentTarget.name + ')');
    }
    // Log a summary of what we did here today
    if (verbose && prepSucceeding && (weakenThreadsScheduled > 0 || growThreadsScheduled > 0))
        log(`Prepping with ${weakenThreadsScheduled} weaken, ${growThreadsScheduled} grow threads (${weakenThreadsNeeded || 0} / ${growThreadsNeeded || 0} needed)` +
            ' ETA ' + Math.floor((currentTarget.timeToWeaken() + queueDelay) / 1000) + 's (' + currentTarget.name + ')' +
            ' Took: ' + (Date.now() - start) + 'ms');
    return prepSucceeding;
}

function getXPFarmServer(all = false) {
    const hackableServers = serverListByMaxRam.filter(server => (server.hasRoot() || server.canCrack()) && server.canHack() && server.shouldHack())
        .sort((a, b) => b.getExpPerSecond() - a.getExpPerSecond());
    return all ? hackableServers : hackableServers[0];
}

let singleServerLimit; // If prior cycles failed to be scheduled, force one additional server into single-server mode until we aqcuire more RAM
let lastCycleTotalRam = 0; // Cache of total ram on the server to check whether we should attempt to lift the above restriction.

/** @param {NS} ns 
 * Gain a bunch of hack XP early after a new Augmentation by filling a bunch of RAM with weaken() against a relatively easy target */
async function kickstartHackXp(ns, percentOfFreeRamToConsume = 1, verbose = false, targets = undefined) {
    if (!xpOnly)
        return await scheduleHackExpCycle(ns, getXPFarmServer(), percentOfFreeRamToConsume, verbose, false); // Grind some XP from the single best target for farming XP
    // Otherwise, target multiple servers until we can't schedule any more. Each next best target should get the next best (biggest) server
    sortServerList("totalram");
    getTool("grow").isThreadSpreadingAllowed = true; // Only true when in XP mode - where each grow thread is expected to give 1$. "weak" can always spread.   
    var jobHosts = serverListByMaxRam.filter(s => s.hasRoot() && s.totalRam() > 128); // Get the set of servers that can be reasonably expected to host decent-sized jobs
    if (jobHosts.length == 0) jobHosts = serverListByMaxRam.filter(s => s.hasRoot() && s.totalRam() > 16); // Lower our standards if we're early-game and nothing qualifies
    var homeRam = ns.getServerMaxRam("home"); // If home ram is large enough, the XP contributed by additional targets is insignificant compared to the risk of increased lag/latency.
    targets = Math.min(maxTargets, Math.floor(jobHosts.filter(s => s.totalRam() > 0.01 * homeRam).length)); // Limit targets (too many creates lag which worsens performance, and need a dedicated server for each)
    let targetsByExp = getXPFarmServer(true);
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
        etas.push(lastSchedulingResult = (await scheduleHackExpCycle(ns, targetsByExp[i], 1, verbose, tryAdvanceMode, jobHosts[i], singleServerMode)) || Number.MAX_SAFE_INTEGER);
        if (lastSchedulingResult == Number.MAX_SAFE_INTEGER) break; // Stop scheduling targets if the last attempt failed
    }
    // TODO: waitForCycleEnd - if any targets are within 200ms? (one game tick) of the end of their cycle, wait for it to end and trigger the next cycle immediately?
    // Wait for all job scheduling threads to return, and sleep for the smallest cycle time remaining
    return Math.max(0, Math.min(...etas));
}

// In case we've misfired a bit, this helper can wait a short while to see if we can start a new cycle right as the last one completes.
async function waitForCycleEnd(ns, server, maxWaitTime = 200, waitInterval = 5) {
    const eta = nextXpCycleEnd[server.name];
    if (verbose) return log(`WARNING: ${server.name} FarmXP process is still in progress from a prior run. Completion time is unknown...`);
    const activeCycleTimeLeft = (eta || 0) - Date.now();
    let stillBusy;
    if (verbose) log(`Waiting for last ${server.name} FarmXP process to complete... (ETA ${eta ? formatDuration(activeCycleTimeLeft) : 'unknown'})`);
    while (stillBusy = server.isXpFarming(false) && maxWaitTime > 0) {
        await ns.asleep(waitInterval); // Sleep a very short while, then get a fresh process list to check again whether the process is done
        maxWaitTime -= waitInterval;
    }
    if (stillBusy)
        log(`WARNING: ${server.name} FarmXP process is ` + (eta ? `more than ${formatDuration(-activeCycleTimeLeft)} overdue...` : 'still in progress from a prior run...'));
    return !stillBusy;
}

let farmXpReentryLock = []; // A dictionary of server names and whether we're currently scheduling / polling for its cycle to end
let nextXpCycleEnd = []; // A dictionary of server names and when their next XP farming cycle is expected to end
/** @param {NS} ns **/
async function scheduleHackExpCycle(ns, server, percentOfFreeRamToConsume, verbose, advancedMode, allocatedServer = null, singleServer = false) {
    if (!server.hasRoot() && server.canCrack()) doRoot(server); // Get root if we do not already have it.
    if (!server.hasRoot()) return log(`ERROR: Cannot farm XP from unrooted server ${server.name}`, true, 'error');
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
        if (server.isXpFarming()) {
            if (verbose && activeCycleTimeLeft < -50) // Warn about big misfires (sign of lag)
                log(`WARNING: ${server.name} FarmXP process is ` + (eta ? `more than ${formatDuration(-activeCycleTimeLeft)} overdue...` :
                    `still in progress from a prior run. ETA unknown, assuming '${expTool.name}' time: ${formatDuration(expTime)}`));
            return eta ? (activeCycleTimeLeft > 0 ? activeCycleTimeLeft : 10 /* If we're overdue, sleep only 10 ms before checking again */) : expTime /* Have no ETA, sleep for expTime */;
        }
        let threads = Math.floor(((allocatedServer == null ? expTool.getMaxThreads() : allocatedServer.ramAvailable() / expTool.cost) * percentOfFreeRamToConsume).toPrecision(14));
        if (threads == 0)
            return log(`WARNING: Cannot farm XP from ${server.name}, threads == 0 for allocated server ` + (allocatedServer == null ? '(any server)' :
                `${allocatedServer.name} with ${formatRam(allocatedServer.ramAvailable())} free RAM`), false, 'warning');

        if (advancedMode) { // Need to keep server money above zero, and security at minimum to farm xp from hack(); 
            const effectiveHackThreads = Math.ceil(1 / server.percentageStolenPerHackThread()); // Only this many hack threads "count" for stealing/hardening. The rest get a 'free ride'
            if (threads <= effectiveHackThreads) {
                farmXpReentryLock[server.name] = false;
                // We don't have enough ram for advanced XP grind (no hack threads would get a 'free ride'). Revert to simple weak/grow farming mode.
                return await scheduleHackExpCycle(ns, server, percentOfFreeRamToConsume, verbose, false, allocatedServer, singleServer);
            }
            var growThreadsNeeded = effectiveHackThreads; // To hack for money, server must have at least 1$ per thread that "counts" for the steal (threads required to steal 100%)
            const securityHardeningToCombat = Math.max(effectiveHackThreads * hackThreadHardening + growThreadsNeeded * growthThreadHardening, // Security that will be incurred hack() + grow() threads
                server.getSecurity() - server.getMinSecurity()); // If the current security level is higher than this, add enough weaken threads to correct it
            var weakenThreadsNeeded = Math.ceil(securityHardeningToCombat / actualWeakenPotency());
            // TODO: If the remaining hosts on the network can't fit 4 sets of grow + weaken recovery threads needed, switch to single-server mode! (should take into account already-scheduled cycles)
            if (singleServer) // If set to only use a single server, free up the hack threads to make room for recovery threads
                threads = Math.max(0, threads - Math.ceil((growThreadsNeeded + weakenThreadsNeeded) * 1.75 / expTool.cost)); // Make room for recovery threads
            if (threads == 0)
                return log(`Cannot farm XP from ${server.name} on ` + (allocatedServer == null ? '(any server)' : `${allocatedServer.name} with ${formatRam(allocatedServer.ramAvailable())} free RAM`) +
                    `: hack threads == 0 after releasing for ${growThreadsNeeded} grow threads and ${weakenThreadsNeeded} weaken threads for ${effectiveHackThreads} effective hack threads.`);
        }

        let scheduleDelay = 10; // Assume it will take this long a script fired immediately to start running
        let now = Date.now();
        let scheduleTime = now + scheduleDelay;
        let cycleTime = scheduleDelay + expTime + 10; // Wake up this long after a hack has fired (to ensure we don't wake up too early)
        nextXpCycleEnd[server.name] = now + cycleTime; // Store when this server's next cycle is expected to end
        // Schedule the FarmXP threads first, ensuring that they are not split (if they our split, our hack threads above 'effectiveHackThreads' lose their free ride)
        let success = await arbitraryExecution(ns, expTool, threads, [server.name, scheduleTime, 0, expTime, "FarmXP"], allocatedServer?.name);

        if (advancedMode) { // Need to keep server money above zero, and security at minimum to farm xp from hack(); 
            const scheduleGrow = scheduleTime + cycleTime * 2 / 15 - scheduleDelay; // Time this to resolve at 1/3 * cycleTime after each hack fires
            const scheduleWeak = scheduleTime + cycleTime * 2 / 3 - scheduleDelay; //  Time this to resolve at 2/3 * cycleTime after each hack fires
            success &&= await arbitraryExecution(ns, getTool("grow"), growThreadsNeeded, [server.name, scheduleGrow, 0, server.timeToGrow(), "growForXp"],
                singleServer ? allocatedServer?.name : null, !singleServer);
            success &&= await arbitraryExecution(ns, getTool("weak"), weakenThreadsNeeded, [server.name, scheduleWeak, 0, server.timeToWeaken(), "weakenForXp"],
                singleServer ? allocatedServer?.name : null, !singleServer);
            //log(`XP Farm ${server.name} money available is ${formatMoney(server.getMoney())} and security is ` +
            //    `${server.getSecurity().toPrecision(3)} of ${server.getMinSecurity().toPrecision(3)}`);
            //log(`Planned start: Hack: ${Math.round(scheduleTime - now)} Grow: ${Math.round(scheduleGrow - now)} ` +
            //    `Weak: ${Math.round(scheduleWeak - now)} Tick: ${Math.round(cycleTime)} Cycle: ${threads} / ${growThreadsNeeded} / ${weakenThreadsNeeded}`);
            if (verbose) log(`Exp Cycle: ${threads} x Hack in ${Math.round(scheduleTime - now + expTime)}ms, ` +
                `${growThreadsNeeded} x Grow in ${Math.round((scheduleGrow - now + server.timeToGrow()) % cycleTime)}ms, ` +
                `${weakenThreadsNeeded} x Weak in ${Math.round((scheduleWeak - now + server.timeToWeaken()) % cycleTime)}ms, ` +
                `Tick: ${Math.round(cycleTime)}ms on ${allocatedServer?.name ?? '(any server)'} targeting "${server.name}"`);
        } else if (verbose)
            log(`In ${formatDuration(cycleTime)}, ${threads} ${expTool.shortName} threads will fire against ${server.name} (for Hack Exp)`);
        if (!success) { // If some aspect scheduling fails, we should try adjusting our future scheduling tactics to attempt to use less RAM
            if (singleServerLimit >= maxTargets && maxTargets > 1)
                maxTargets--;
            else
                singleServerLimit++;
        }
        // Note: Next time we tick, Hack will have *just* fired, so for the moment we will be at 0 money and above min security. Trust that all is well
        return cycleTime; // Ideally we wake up right after hack has fired so we can schedule another immediately
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
    if (!playerStats.hasTixApiAccess) return; // No point in attempting anything here if the user doesn't have stock market access yet.
    let updatedPositions = ns.read(`/Temp/stock-probabilities.txt`); // Should be a dict of stock symbol -> prob left by the stockmaster.js script.
    if (!updatedPositions) {
        failedStockUpdates++;
        if (failedStockUpdates % 60 == 10) // Periodically warn if stockmaster is not running (or not generating the required file)
            log(`WARNING: The file "/Temp/stock-probabilities.txt" has been missing or empty the last ${failedStockUpdates} attempts.` +
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
    const problematicProcesses = addedServerNames.flatMap(hostname => ps(ns, hostname)
        .filter(process => servers.includes(process.args[0]) && (loopingMode || toolName == process.filename && process.args.length > 5 && process.args[5]))
        .map(process => ({ pid: process.pid, hostname })));
    if (problematicProcesses.length > 0)
        await runCommand(ns, JSON.stringify(problematicProcesses) + '.forEach(p => ns.kill(p.pid, p.hostname))', '/Temp/kill-remote-stock-manipulation.js');
}

function addServer(server, verbose) {
    if (verbose) log(`Adding a new server to all lists: ${server}`);
    addedServerNames.push(server.name);
    // Lists maintained in various sort orders
    serverListByFreeRam.push(server);
    serverListByMaxRam.push(server);
    serverListByTargetOrder.push(server);
}

function removeServerByName(deletedHostName) {
    addedServerNames.splice(addedServerNames.indexOf(deletedHostName), 1);
    const removeByName = (hostname, list, listname) => {
        const toRemove = list.findIndex(s => s.name === hostname);
        if (toRemove === -1)
            log(`ERROR: Failed to find server by name ${hostname}.`, true, 'error');
        else {
            list.splice(toRemove, 1);
            log(`${hostname} was found at index ${toRemove} of list ${listname} and removed leaving ${list.length} items.`);
        }
    }
    removeByName(deletedHostName, serverListByFreeRam, 'serverListByFreeRam');
    removeByName(deletedHostName, serverListByMaxRam, 'serverListByMaxRam');
    removeByName(deletedHostName, serverListByTargetOrder, 'serverListByTargetOrder');
}

let getServerByName = hostname => serverListByFreeRam.find(s => s.name == hostname);

// Indication that a server has been flagged for deletion (by the host manager). Doesn't count for home of course, as this is where the flag file is stored for copying.
let isFlaggedForDeletion = (hostName) => hostName != "home" && doesFileExist("/Flags/deleting.txt", hostName);

// Helper to construct our server lists from a list of all host names
function buildServerList(ns, verbose = false) {
    // Get list of servers (i.e. all servers on first scan, or newly purchased servers on subsequent scans) that are not currently flagged for deletion
    let allServers = scanAllServers(ns).filter(hostName => !isFlaggedForDeletion(hostName));
    // Ignore hacknet node servers if we are not supposed to run scripts on them (reduces their hash rate when we do)
    if (!useHacknetNodes)
        allServers = allServers.filter(hostName => !hostName.startsWith('hacknet-node-'))
    // Remove all servers we currently have added that are no longer being returned by the above query
    for (const hostName of addedServerNames.filter(hostName => !allServers.includes(hostName)))
        removeServerByName(hostName);
    // Add any servers that are new
    allServers.filter(hostName => !addedServerNames.includes(hostName)).forEach(hostName => addServer(buildServerObject(ns, hostName, verbose)));
}

// Helper to sort various copies of our host list in different ways.
function sortServerList(o) {
    switch (o) {
        case "ram":
            // Original sort order adds jobs to the server with the most free ram
            serverListByFreeRam.sort(function (a, b) {
                var ramDiff = b.ramAvailable() - a.ramAvailable();
                return ramDiff != 0.0 ? ramDiff : a.name.localeCompare(b.name); // Break ties by sorting by name
            });
            break;
        case "totalram":
            // Original sort order adds jobs to the server with the most free ram
            serverListByMaxRam.sort(function (a, b) {
                var ramDiff = b.totalRam() - a.totalRam();
                return ramDiff != 0.0 ? ramDiff : a.name.localeCompare(b.name); // Break ties by sorting by name
            });
            break;
        case "targeting":
            // To ensure we establish some income, prep fastest-to-prep servers first, and target prepped servers before unprepped servers.
            serverListByTargetOrder.sort(function (a, b) {
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
            break;
    }
}

async function runCommand(ns, ...args) {
    return await runCommand_Custom(ns, getFnRunViaNsExec(ns, daemonHost), ...args);
}

async function getNsDataThroughFile(ns, ...args) {
    return await getNsDataThroughFile_Custom(ns, getFnRunViaNsExec(ns, daemonHost), getFnIsAliveViaNsPs(ns), ...args);
}

async function establishMultipliers(ns) {
    log("establishMultipliers");

    bitnodeMults = (await tryGetBitNodeMultipliers_Custom(ns, getNsDataThroughFile)) || {
        // prior to SF-5, bitnodeMults stays null and these mults are set to 1.
        ServerGrowthRate: 1,
        ServerWeakenRate: 1,
        FourSigmaMarketDataApiCost: 1,
        ScriptHackMoneyGain: 1
    };
    if (verbose)
        log(`Bitnode mults:\n  ${Object.keys(bitnodeMults).filter(k => bitnodeMults[k] != 1.0).map(k => `${k}: ${bitnodeMults[k]}`).join('\n  ')}`);
}

/** @param {NS} ns **/
function buildToolkit(ns) {
    log("buildToolkit");
    for (const toolConfig of hackTools.concat(asynchronousHelpers).concat(periodicScripts)) {
        let tool = {
            instance: ns,
            name: toolConfig.name,
            shortName: toolConfig.shortName,
            tail: toolConfig.tail || false,
            args: toolConfig.args || [],
            shouldRun: toolConfig.shouldRun,
            requiredServer: toolConfig.requiredServer,
            isThreadSpreadingAllowed: toolConfig.shortName === "weak",
            cost: ns.getScriptRam(toolConfig.name, daemonHost),
            canRun: function (server) {
                return doesFileExist(this.name, server.name) && server.ramAvailable() >= this.cost;
            },
            getMaxThreads: function () {
                // analyzes the servers array and figures about how many threads can be spooled up across all of them.
                let maxThreads = 0;
                sortServerList("ram");
                for (const server of serverListByFreeRam.filter(s => s.hasRoot())) {
                    var threadsHere = Math.floor((server.ramAvailable() / this.cost).toPrecision(14));
                    if (!this.isThreadSpreadingAllowed)
                        return threadsHere;
                    maxThreads += threadsHere;
                }
                return maxThreads;
            }
        };
        tools.push(tool);
        toolsByShortName[tool.shortName || hashToolDefinition(tool)] = tool;
    }
}

const hashToolDefinition = s => hashCode(s.name + JSON.stringify(s.args || []));

function getTool(s) { return toolsByShortName[s] || toolsByShortName[s.shortName || hashToolDefinition(s)]; }

function getNumPortCrackers() { return portCrackers.filter(c => c.exists()).length; }

// assemble a list of port crackers and abstract their functionality
function buildPortCrackingArray(ns) {
    var crackNames = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];
    for (var i = 0; i < crackNames.length; i++) {
        var cracker = buildPortCrackerObject(ns, crackNames[i]);
        portCrackers.push(cracker);
    }
}

/** @param {NS} ns **/
function buildPortCrackerObject(ns, crackName) {
    var crack = {
        ns: ns,
        name: crackName,
        exists: () => doesFileExist(crackName, "home"),
        runAt: function (target) {
            switch (this.name) {
                case "BruteSSH.exe":
                    this.ns.brutessh(target);
                    break;
                case "FTPCrack.exe":
                    this.ns.ftpcrack(target);
                    break;
                case "relaySMTP.exe":
                    this.ns.relaysmtp(target);
                    break;
                case "HTTPWorm.exe":
                    this.ns.httpworm(target);
                    break;
                case "SQLInject.exe":
                    this.ns.sqlinject(target);
                    break;
            }
        },
        // I made this a function of the crackers out of laziness.
        doNuke: target => ns.nuke(target)
    };
    return crack;
}

function doRoot(server) {
    try {
        var portsCracked = 0;
        var portsNeeded = server.portsRequired;
        for (var i = 0; i < portCrackers.length; i++) {
            var cracker = portCrackers[i];
            if (cracker.exists()) {
                cracker.runAt(server.name);
                portsCracked++;
            }
            if (portsCracked >= portsNeeded) {
                cracker.doNuke(server.name);
                break;
            }
        }
    }
    catch (err) {
        log(`ERROR while attempting to root ${server.name} with ${server.portsRequired} ports needed.`, true, 'error');
        throw err;
    }
}