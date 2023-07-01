import {
    log, getFilePath, getConfiguration, instanceCount, getNsDataThroughFile, runCommand, waitForProcessToComplete,
    getActiveSourceFiles, tryGetBitNodeMultipliers, getStocksValue, unEscapeArrayArgs,
    formatMoney, formatDuration
} from './helpers.js'

const persistentLog = "log.autopilot.txt";
const factionManagerOutputFile = "/Temp/affordable-augs.txt"; // Temp file produced by faction manager with status information
const casinoFlagFile = "/Temp/ran-casino.txt";
const defaultBnOrder = [4.3, 1.3, 5.1, 9.2, 10.1, 2.1, 8.2, 10.3, 9.3, 11.3, 13.3, 5.3, 7.1, 6.3, 7.3, 2.3, 8.3, 3.3, 12.999];

let options; // The options used at construction time
const argsSchema = [ // The set of all command line arguments
    ['next-bn', 0], // If we destroy the current BN, the next BN to start
    ['disable-auto-destroy-bn', false], // Set to true if you do not want to auto destroy this BN when done
    ['install-at-aug-count', 11], // Automatically install when we can afford this many new augmentations (with NF only counting as 1)
    ['install-at-aug-plus-nf-count', 14], // or... automatically install when we can afford this many augmentations including additional levels of Neuroflux
    ['install-for-augs', ["The Red Pill"]], // or... automatically install as soon as we can afford one of these augmentations
    ['install-countdown', 5 * 60 * 1000], // If we're ready to install, wait this long first to see if more augs come online (we might just be gaining momentum)
    ['time-before-boosting-best-hack-server', 15 * 60 * 1000], // Wait this long before picking our best hack-income server and spending hashes on boosting it
    ['reduced-aug-requirement-per-hour', 0.5], // For every hour since the last reset, require this many fewer augs to install.
    ['interval', 2000], // Wake up this often (milliseconds) to check on things
    ['interval-check-scripts', 10000], // Get a listing of all running processes on home this frequently
    ['high-hack-threshold', 8000], // Once hack level reaches this, we start daemon in high-performance hacking mode
    ['enable-bladeburner', null], // (Deprecated) Bladeburner is now always enabled if it's available. Use '--disable-bladeburner' to explicitly turn off
    ['disable-bladeburner', false], // This will instruct daemon.js not to run the bladeburner.js, even if bladeburner is available.
    ['wait-for-4s-threshold', 0.9], // Set to 0 to not reset until we have 4S. If money is above this ratio of the 4S Tix API cost, don't reset until we buy it.
    ['disable-wait-for-4s', false], // If true, will doesn't wait for the 4S Tix API to be acquired under any circumstantes
    ['disable-rush-gangs', false], // Set to true to disable focusing work-for-faction on Karma until gangs are unlocked
    ['disable-casino', false], // Set to true to disable running the casino.js script automatically
    ['on-completion-script', null], // Spawn this script when we defeat the bitnode
    ['on-completion-script-args', []], // Optional args to pass to the script when we defeat the bitnode
];
export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (["--on-completion-script"].includes(lastFlag))
        return data.scripts;
    return [];
}

let playerInGang = false, rushGang = false; // Tells us whether we're should be trying to work towards getting into a gang
let playerInBladeburner = false; // Whether we've joined bladeburner
let wdHack = 0; // If the WD server is available (i.e. TRP is installed), caches the required hack level
let ranCasino = false; // Flag to indicate whether we've stolen 10b from the casino yet
let reservedPurchase = 0; // Flag to indicate whether we've reservedPurchase money and can still afford augmentations
let reserveForDaedalus = false, daedalusUnavailable = false; // Flags to indicate that we should be keeping 100b cash on hand to earn an invite to Daedalus
let lastScriptsCheck = 0; // Last time we got a listing of all running scripts
let killScripts = []; // A list of scripts flagged to be restarted due to changes in priority
let dictOwnedSourceFiles = [], unlockedSFs = [], bitnodeMults, nextBn = 0; // Info for the current bitnode
let installedAugmentations = [], playerInstalledAugCount = 0, stanekLaunched = false; // Info for the current ascend
let daemonStartTime = 0; // The time we personally launched daemon.
let installCountdown = 0; // Start of a countdown before we install augmentations.
let bnCompletionSuppressed = false; // Flag if we've detected that we've won the BN, but are suppressing a restart
let resetInfo = (/**@returns{ResetInfo}*/() => undefined)(); // Information about the current bitnode

// Replacements for player properties deprecated since 2.3.0
function getTimeInAug() { return Date.now() - resetInfo.lastAugReset; }
function getTimeInBitnode() { return Date.now() - resetInfo.lastNodeReset; }

/** @param {NS} ns **/
export async function main(ns) {
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions || await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    options = runOptions; // We don't set the global "options" until we're sure this is the only running instance

    log(ns, "INFO: Auto-pilot engaged...", true, 'info');
    // The game does not allow boolean flags to be turned "off" via command line, only on. Since this gets saved, notify the user about how they can turn it off.
    const flagsSet = ['disable-auto-destroy-bn', 'disable-bladeburner', 'disable-wait-for-4s', 'disable-rush-gangs'].filter(f => options[f]);
    for (const flag of flagsSet)
        log(ns, `WARNING: You have previously enabled the flag "--${flag}". Because of the way this script saves its run settings, the ` +
            `only way to now turn this back off will be to manually edit or delete the file ${ns.getScriptName()}.config.txt`, true);

    let startUpRan = false;
    while (true) {
        try {
            // Start-up actions, wrapped in error handling in case of temporary failures
            if (!startUpRan) startUpRan = await startUp(ns);
            // Main loop: Monitor progress in the current BN and automatically reset when we can afford TRP, or N augs.
            await mainLoop(ns);
        }
        catch (err) {
            log(ns, `WARNING: autopilot.js Caught (and suppressed) an unexpected error:\n` +
                (typeof err === 'string' ? err : err?.stack ? err.stack : JSON.stringify(err)),
                false, 'warning');
        }
        await ns.sleep(options['interval']);
    }
}

/** @param {NS} ns **/
async function startUp(ns) {
    await persistConfigChanges(ns);

    // Reset global state
    playerInGang = rushGang = playerInBladeburner = ranCasino = reserveForDaedalus = daedalusUnavailable =
        bnCompletionSuppressed = stanekLaunched = false;
    playerInstalledAugCount = wdHack = null;
    installCountdown = daemonStartTime = lastScriptsCheck = reservedPurchase = 0;
    lastStatusLog = "";
    installedAugmentations = killScripts = [];

    // Collect and cache some one-time data
    const player = await getNsDataThroughFile(ns, 'ns.getPlayer()');
    resetInfo = await getNsDataThroughFile(ns, 'ns.getResetInfo()');
    bitnodeMults = await tryGetBitNodeMultipliers(ns);
    dictOwnedSourceFiles = await getActiveSourceFiles(ns, false);
    unlockedSFs = await getActiveSourceFiles(ns, true);
    try {
        installedAugmentations = !(4 in unlockedSFs) ? [] :
            await getNsDataThroughFile(ns, 'ns.singularity.getOwnedAugmentations()', '/Temp/player-augs-installed.txt');
        if (!(4 in unlockedSFs))
            log(ns, `WARNING: This script requires SF4 (singularity) functions to assess purchasable augmentations ascend automatically. ` +
                `Some functionality will be disabled and you'll have to manage working for factions, purchasing, and installing augmentations yourself.`, true);
    } catch (err) {
        if (unlockedSFs[4] || 0 == 3) throw err; // No idea why this failed, treat as temporary and allow auto-retry.		
        log(ns, `WARNING: You only have SF4 level ${unlockedSFs[4]}. Without level 3, some singularity functions will be ` +
            `too expensive to run until you have bought a lot of home RAM.`, true);
    }
    if (getTimeInBitnode() < 60 * 1000) // Skip initialization if we've been in the bitnode for more than 1 minute
        await initializeNewBitnode(ns, player);

    // Decide what the next-up bitnode should be
    const getSFLevel = bn => Number(bn + "." + ((dictOwnedSourceFiles[bn] || 0) + (resetInfo.currentNode == bn ? 1 : 0)));
    const nextSfEarned = getSFLevel(resetInfo.currentNode);
    const nextRecommendedSf = defaultBnOrder.find(v => v - Math.floor(v) > getSFLevel(Math.floor(v)) - Math.floor(v));
    const nextRecommendedBn = Math.floor(nextRecommendedSf);
    nextBn = options['next-bn'] || nextRecommendedBn;
    log(ns, `INFO: After the current BN (${nextSfEarned}), the next recommended BN is ${nextRecommendedBn} until you have SF ${nextRecommendedSf}.` +
        `\nYou are currently earning SF${nextSfEarned}, and you already own the following source files: ` +
        Object.keys(dictOwnedSourceFiles).map(bn => `${bn}.${dictOwnedSourceFiles[bn]}`).join(", "));
    if (nextBn != nextRecommendedBn)
        log(ns, `WARN: The next recommended BN is ${nextRecommendedBn}, but the --next-bn parameter is set to override this with ${nextBn}.`, true, 'warning');

    return true;
}

/** Write any configuration changes to disk so that they will survive resets and new bitnodes
 * @param {NS} ns **/
async function persistConfigChanges(ns) {
    // Because we cannot pass args to "install" and "destroy" functions, we write them to disk to override defaults
    const changedArgs = JSON.stringify(argsSchema
        .filter(a => JSON.stringify(options[a[0]]) != JSON.stringify(a[1]))
        .map(a => [a[0], options[a[0]]]));
    // Only update the config file if it doesn't match the most resent set of run args
    const configPath = `${ns.getScriptName()}.config.txt`
    const currentConfig = ns.read(configPath);
    if ((changedArgs.length > 2 || currentConfig) && changedArgs != currentConfig) {
        ns.write(configPath, changedArgs, "w");
        log(ns, `INFO: Updated "${configPath}" to persist the most recent run args through resets: ${changedArgs}`, true, 'info');
    }
}

/** Logic run once at the beginning of a new BN
 * @param {NS} ns */
async function initializeNewBitnode(ns, player) {
    // Nothing to do here (yet)
}

/** Logic run periodically throughout the BN
 * @param {NS} ns */
async function mainLoop(ns) {
    const player = await getNsDataThroughFile(ns, 'ns.getPlayer()');
    let stocksValue = 0;
    try { stocksValue = await getStocksValue(ns); } catch { /* Assume if this fails (insufficient ram) we also have no stocks */ }
    manageReservedMoney(ns, player, stocksValue);
    await checkOnDaedalusStatus(ns, player, stocksValue);
    await checkIfBnIsComplete(ns, player);
    await checkOnRunningScripts(ns, player);
    await maybeDoCasino(ns, player);
    await maybeInstallAugmentations(ns, player);
}

/** Logic run periodically to if there is anything we can do to speed along earning a Daedalus invite
 * @param {NS} ns
 * @param {Player} player **/
async function checkOnDaedalusStatus(ns, player, stocksValue) {
    // Logic below is for rushing a daedalus invite.
    // We do not need to run if we've previously determined that Daedalus cannot be unlocked (insufficient augs), or if we've already got TRP
    if (daedalusUnavailable || (wdHack || 0) > 0) return reserveForDaedalus = false;
    if (player.skills.hacking < 2500) return reserveForDaedalus = false;
    if (player.factions.includes("Daedalus")) {
        if (reserveForDaedalus) {
            log(ns, "SUCCESS: We sped along joining the faction 'Daedalus'. Restarting work-for-factions.js to speed along earn rep.", false, 'success');
            killScripts.push("work-for-factions.js"); // Schedule this to be killed (will be restarted) on the next script loop.
            lastScriptsCheck = 0;
        }
        return reserveForDaedalus = false;
    }
    if (reserveForDaedalus) { // Already waiting for a Daedalus invite, try joining them
        return (4 in unlockedSFs) ? await getNsDataThroughFile(ns, 'ns.singularity.joinFaction(ns.args[0])', null, ["Daedalus"]) :
            log(ns, "INFO: Please manually join the faction 'Daedalus' as soon as possible to proceed", false, 'info');
    }
    const bitNodeMults = await tryGetBitNodeMultipliers(ns, false) || { DaedalusAugsRequirement: 1 };
    // Note: A change coming soon will convert DaedalusAugsRequirement from a fractional multiplier, to an integer number of augs. This should support both for now.
    const reqDaedalusAugs = bitNodeMults.DaedalusAugsRequirement < 2 ? Math.round(30 * bitNodeMults.DaedalusAugsRequirement) : bitNodeMults.DaedalusAugsRequirement;
    if (playerInstalledAugCount !== null && playerInstalledAugCount < reqDaedalusAugs)
        return daedalusUnavailable = true; // Won't be able to unlock daedalus this ascend
    // If we have sufficient augs and hacking, all we need is the money (100b)
    const totalWorth = player.money + stocksValue;
    if (totalWorth > 100E9 && player.money < 100E9) {
        reserveForDaedalus = true;
        log(ns, "INFO: Temporarily liquidating stocks to earn an invite to Daedalus...", true, 'info');
        launchScriptHelper(ns, 'stockmaster.js', ['--liquidate']);
    }
}

/** Logic run periodically throughout the BN to see if we are ready to complete it.
 * @param {NS} ns 
 * @param {Player} player */
async function checkIfBnIsComplete(ns, player) {
    if (bnCompletionSuppressed) return true;
    if (wdHack === null) { // If we haven't checked yet, see if w0r1d_d43m0n (server) has been unlocked and get its required hack level
        wdHack = await getNsDataThroughFile(ns, 'ns.scan("The-Cave").includes("w0r1d_d43m0n") ? ' +
            'ns.getServerRequiredHackingLevel("w0r1d_d43m0n"): -1',
            '/Temp/wd-hackingLevel.txt');
        if (wdHack == -1) wdHack = Number.POSITIVE_INFINITY; // Cannot stringify infinity, so use -1 in transit
    }
    // Detect if a BN win condition has been met
    let bnComplete = player.skills.hacking >= wdHack;
    // Detect the BB win condition (requires SF7 (bladeburner API) or being in BN6)
    if (7 in unlockedSFs) // No point making this async check if bladeburner API is unavailable
        playerInBladeburner = playerInBladeburner || await getNsDataThroughFile(ns, 'ns.bladeburner.inBladeburner()');
    if (!bnComplete && playerInBladeburner)
        bnComplete = await getNsDataThroughFile(ns,
            `ns.bladeburner.getActionCountRemaining('blackop', 'Operation Daedalus') === 0`,
            '/Temp/bladeburner-completed.txt');
    if (!bnComplete) return false; // No win conditions met

    const text = `BN ${resetInfo.currentNode}.${(dictOwnedSourceFiles[resetInfo.currentNode] || 0) + 1} completed at ` +
        `${formatDuration(getTimeInBitnode())} ` +
        `(${(player.skills.hacking >= wdHack ? `hack (${wdHack.toFixed(0)})` : 'bladeburner')} win condition)`;
    persist_log(ns, text);
    log(ns, `SUCCESS: ${text}`, true, 'success');

    // Run the --on-completion-script if specified
    if (options['on-completion-script']) {
        const pid = launchScriptHelper(ns, options['on-completion-script'], unEscapeArrayArgs(options['on-completion-script-args']), false);
        if (pid) await waitForProcessToComplete(ns, pid);
    }

    // Check if there is some reason not to automatically destroy this BN
    if (resetInfo.currentNode == 10) { // Suggest the user doesn't reset until they buy all sleeves and max memory
        const shouldHaveSleeveCount = Math.min(8, 6 + (dictOwnedSourceFiles[10] || 0));
        const numSleeves = await getNsDataThroughFile(ns, `ns.sleeve.getNumSleeves()`);
        if (numSleeves < shouldHaveSleeveCount) {
            log(ns, `WARNING: Detected that you only have ${numSleeves} sleeves, but you could have ${shouldHaveSleeveCount}.` +
                `\nTry not to leave BN10 before buying all you can from the faction "The Covenant", especially sleeve memory!` +
                `\nNOTE: You can ONLY buy sleeves/memory from The Covenant in BN10, which is why it's important to do this before you leave.`, true);
            return bnCompletionSuppressed = true;
        }
    }
    if (options['disable-auto-destroy-bn']) {
        log(ns, `--disable-auto-destroy-bn is set, you can manually exit the bitnode when ready.`, true);
        return bnCompletionSuppressed = true;
    }
    if (!(4 in dictOwnedSourceFiles)) {
        log(ns, `You do not own SF4, so you must manually exit the bitnode (` +
            `${player.skills.hacking >= wdHack ? "by hacking W0r1dD43m0n" : "on the bladeburner BlackOps tab"}).`, true);
        return bnCompletionSuppressed = true;
    }

    // Clean out our temp folder and flags so we don't have any stale data when the next BN starts.
    let pid = launchScriptHelper(ns, 'cleanup.js');
    if (pid) await waitForProcessToComplete(ns, pid);

    // Use the new special singularity function to automate entering a new BN
    pid = await runCommand(ns, `ns.singularity.destroyW0r1dD43m0n(ns.args[0], ns.args[1])`, null, [nextBn, ns.getScriptName()]);
    if (pid) {
        log(ns, `SUCCESS: Initiated process ${pid} to execute 'singularity.destroyW0r1dD43m0n' with args: [${nextBn}, ${ns.getScriptName()}]`, true, 'success')
        await waitForProcessToComplete(ns, pid);
        log(ns, `WARNING: Process is done running, why am I still here? Sleeping 10 seconds...`, true, 'error')
        await ns.sleep(10000);
    }
    persist_log(ns, log(ns, `ERROR: Tried destroy the bitnode (pid=${pid}), but we're still here...`, true, 'error'));
    //return bnCompletionSuppressed = true; // Don't suppress bn Completion, try again on our next loop.
}

/** Helper to get a list of all scripts running (on home)
 * @param {NS} ns */
async function getRunningScripts(ns) {
    return await getNsDataThroughFile(ns, 'ns.ps(ns.args[0])', null, ['home']);
}

/** Helper to get the first instance of a running script by name.
 * @param {NS} ns 
 * @param {ProcessInfo[]} runningScripts - (optional) Cached list of running scripts to avoid repeating this expensive request
 * @param {(value: ProcessInfo, index: number, array: ProcessInfo[]) => unknown} filter - (optional) Filter the list of processes beyond just matching on the script name */
function findScriptHelper(baseScriptName, runningScripts, filter = null) {
    return runningScripts.filter(s => s.filename == getFilePath(baseScriptName) && (!filter || filter(s)))[0];
}

/** Helper to kill a running script instance by name
 * @param {NS} ns 
 * @param {ProcessInfo[]} runningScripts - (optional) Cached list of running scripts to avoid repeating this expensive request
 * @param {ProcessInfo} processInfo - (optional) The process to kill, if we've already found it in advance */
async function killScript(ns, baseScriptName, runningScripts = null, processInfo = null) {
    processInfo = processInfo || findScriptHelper(baseScriptName, runningScripts || (await getRunningScripts(ns)))
    if (processInfo) {
        log(ns, `INFO: Killing script ${baseScriptName} with pid ${processInfo.pid} and args: [${processInfo.args.join(", ")}].`, false, 'info');
        return await getNsDataThroughFile(ns, 'ns.kill(ns.args[0])', null, [processInfo.pid]);
    }
    log(ns, `WARNING: Skipping request to kill script ${baseScriptName}, no running instance was found...`, false, 'warning');
    return false;
}

/** Logic to ensure scripts are running to progress the BN
 * @param {NS} ns 
 * @param {Player} player */
async function checkOnRunningScripts(ns, player) {
    if (lastScriptsCheck > Date.now() - options['interval-check-scripts']) return;
    lastScriptsCheck = Date.now();
    const runningScripts = await getRunningScripts(ns); // Cache the list of running scripts for the duration
    const findScript = (baseScriptName, filter = null) => findScriptHelper(baseScriptName, runningScripts, filter);

    // Kill any scripts that were flagged for restart
    while (killScripts.length > 0)
        await killScript(ns, killScripts.pop(), runningScripts);

    // Hold back on launching certain scripts if we are low on home RAM
    const homeRam = await getNsDataThroughFile(ns, `ns.getServerMaxRam(ns.args[0])`, null, ["home"]);

    // Launch stock-master in a way that emphasizes it as our main source of income early-on
    if (!findScript('stockmaster.js') && !reserveForDaedalus && homeRam >= 32)
        launchScriptHelper(ns, 'stockmaster.js', [
            "--fracH", 0.1, // Increase the default proportion of money we're willing to hold as stock, it's often our best source of income
            "--reserve", 0, // Override to ignore the global reserve.txt. Any money we reserve can more or less safely live as stocks
        ]);

    // Launch sleeves and allow them to also ignore the reserve so they can train up to boost gang unlock speed
    if ((10 in unlockedSFs) && (2 in unlockedSFs) && !findScript('sleeve.js')) {
        let sleeveArgs = [];
        if (!options["disable-casino"] && !ranCasino)
            sleeveArgs.push("--training-reserve", 300000); // Avoid training away our casino seed money
        if (options["disable-bladeburner"])
            sleeveArgs.push("--disable-bladeburner");
        launchScriptHelper(ns, 'sleeve.js', sleeveArgs);
    }

    // Spend hacknet hashes on our boosting best hack-income server once established
    const spendingHashesOnHacking = findScript('spend-hacknet-hashes.js', s => s.args.includes("--spend-on-server"))
    if ((9 in unlockedSFs) && !spendingHashesOnHacking && getTimeInAug() >= options['time-before-boosting-best-hack-server'] && !(resetInfo.currentNode == 8)) {
        const strServerIncomeInfo = ns.read('/Temp/analyze-hack.txt');	// HACK: Steal this file that Daemon also relies on
        if (strServerIncomeInfo) {
            const incomeByServer = JSON.parse(strServerIncomeInfo);
            const dictServerHackReqs = await getNsDataThroughFile(ns, 'Object.fromEntries(ns.args.map(server => [server, ns.getServerRequiredHackingLevel(server)]))',
                '/Temp/servers-hack-req.txt', incomeByServer.map(s => s.hostname));
            const [bestServer, gain] = incomeByServer.filter(s => dictServerHackReqs[s.hostname] <= player.skills.hacking)
                .reduce(([bestServer, bestIncome], target) => target.gainRate > bestIncome ? [target.hostname, target.gainRate] : [bestServer, bestIncome], [null, 0]);
            if (bestServer) {
                log(ns, `Identified that the best hack income server is ${bestServer} worth ${formatMoney(gain)}/sec.`)
                launchScriptHelper(ns, 'spend-hacknet-hashes.js',
                    ["--liquidate", "--spend-on", "Increase_Maximum_Money", "--spend-on", "Reduce_Minimum_Security", "--spend-on-server", bestServer]);
            } else
                log(ns, `WARNING: strServerIncomeInfo was not empty, but could not determine best server:\n${strServerIncomeInfo}`)
        }
    }

    // Determine the arguments we want to run daemon.js with. We will either pass these directly, or through stanek.js if we're running it first.	
    const hackThreshold = options['high-hack-threshold']; // If player.skills.hacking level is about 8000, run in "start-tight" mode
    const daemonArgs = (player.skills.hacking < hackThreshold) ? [] :
        // Launch daemon in "looping" mode if we have sufficient hack level
        ["--looping-mode", "--cycle-timing-delay", 2000, "--queue-delay", "10", "--initial-max-targets", "63", "--silent-misfires", "--no-share",
            // Use recovery thread padding sparingly until our hack level is significantly higher
            "--recovery-thread-padding", 1.0 + (player.skills.hacking - hackThreshold) / 1000.0];
    daemonArgs.push('--disable-script', getFilePath('work-for-factions.js')); // We will run this ourselves with args of our choosing
    // In BN8, always run in a mode that prioritizes stock market manipulation
    if (resetInfo.currentNode == 8) daemonArgs.push("--stock-manipulation-focus");
    // Don't run the script to join and manage bladeburner if it is explicitly disabled
    if (options['disable-bladeburner']) daemonArgs.push('--disable-script', getFilePath('bladeburner.js'));
    // If we have SF4, but not level 3, instruct daemon.js to reserve additional home RAM
    if ((4 in unlockedSFs) && unlockedSFs[4] < 3)
        daemonArgs.push('--reserved-ram', 32 * (unlockedSFs[4] == 2 ? 4 : 16));

    // Once stanek's gift is accepted, launch it once per reset (Note: stanek's gift is auto-purchased by faction-manager.js on your first install)
    let stanekRunning = (13 in unlockedSFs) && findScript('stanek.js') !== undefined;
    if ((13 in unlockedSFs) && installedAugmentations.includes(`Stanek's Gift - Genesis`) && !stanekLaunched && !stanekRunning) {
        stanekLaunched = true; // Once we've know we've launched stanek once, we never have to again this reset.
        const stanekArgs = ["--on-completion-script", getFilePath('daemon.js')]
        if (daemonArgs.length >= 0) stanekArgs.push("--on-completion-script-args", JSON.stringify(daemonArgs)); // Pass in all the args we wanted to run daemon.js with
        launchScriptHelper(ns, 'stanek.js', stanekArgs);
        stanekRunning = true;
    }

    // Launch daemon with the desired arguments (or re-launch if we recently decided to switch to looping mode) - so long as stanek isn't charging
    const daemon = findScript('daemon.js');
    if (!stanekRunning && (!daemon || player.skills.hacking >= hackThreshold && !daemon.args.includes("--looping-mode"))) {
        if (player.skills.hacking >= hackThreshold)
            log(ns, `INFO: Hack level (${player.skills.hacking}) is >= ${hackThreshold} (--high-hack-threshold): Starting daemon.js in high-performance hacking mode.`);
        launchScriptHelper(ns, 'daemon.js', daemonArgs);
        daemonStartTime = Date.now();
    }

    // Default work for faction args we think are ideal for speed-running BNs
    const workForFactionsArgs = [
        "--fast-crimes-only", // Essentially means we do mug until we can do homicide, then stick to homicide
        "--get-invited-to-every-faction" // Join factions even we have all their augs. Good for having NeuroFlux providers
    ];
    if (options['disable-bladeburner']) workForFactionsArgs.push("--no-bladeburner-check")
    // The following args are ideal when running 'work-for-factions.js' to rush unlocking gangs (earn karma)
    const rushGangsArgs = workForFactionsArgs.concat(...[ // Everything above, plus...
        "--crime-focus", // Start off by trying to work for each of the crime factions (generally have combat reqs)
        "--training-stat-per-multi-threshold", 200, // Be willing to spend more time grinding for stats rather than skipping a faction
        "--prioritize-invites"]); // Don't actually start working for factions until we've earned as many invites as we think we can
    // If gangs are unlocked, micro-manage how 'work-for-factions.js' is running by killing off unwanted instances
    if (2 in unlockedSFs) {
        // Check if we've joined a gang yet. (Never have to check again once we know we're in one)
        if (!playerInGang) playerInGang = await getNsDataThroughFile(ns, 'ns.gang.inGang()', null);
        rushGang = !options['disable-rush-gangs'] && !playerInGang;
        // Detect if a 'work-for-factions.js' instance is running with args that don't match our goal. We aren't too picky,
        // (so the player can run with custom args), but should have --crime-focus if (and only if) we're still working towards a gang.
        const wrongWork = findScript('work-for-factions.js', !rushGang ? s => s.args.includes("--crime-focus") :
            s => !rushGangsArgs.every(a => s.args.includes(a))); // Require all rushGangsArgs if we're not in a gang yet.
        // If running with the wrong args, kill it so we can start it with the desired args
        if (wrongWork) await killScript(ns, 'work-for-factions.js', null, wrongWork);

        // Start gangs immediately (even though daemon would eventually start it) since we want any income they provide right away after an ascend
        // TODO: Consider monitoring gangs territory progress and increasing their budget / decreasing their reserve to help kick-start them
        if (playerInGang && !findScript('gangs.js'))
            launchScriptHelper(ns, 'gangs.js');
    }

    // Launch work-for-factions if it isn't already running (rules for maybe killing unproductive instances are above)
    // Note: We delay launching our own 'work-for-factions.js' until daemon has warmed up, so we don't steal it's "kickstartHackXp" study focus
    if ((4 in unlockedSFs) && !findScript('work-for-factions.js') && Date.now() - daemonStartTime > 30000) {
        // If we're trying to rush gangs, run in such a way that we will spend most of our time doing crime, reducing Karma (also okay early income)
        // NOTE: Default work-for-factions behaviour is to spend hashes on coding contracts, which suits us fine
        launchScriptHelper(ns, 'work-for-factions.js', rushGang ? rushGangsArgs : workForFactionsArgs);
    }
}

/** Logic to steal 10b from the casino
 * @param {NS} ns 
 * @param {Player} player */
async function maybeDoCasino(ns, player) {
    if (ranCasino || options['disable-casino']) return;
    const casinoRanFileSet = ns.read(casinoFlagFile);
    const cashRootBought = installedAugmentations.includes(`CashRoot Starter Kit`);
    // If the casino flag file is already set in first 10 minutes of the reset, and we don't have anywhere near the 10B it should give,
    // it's likely a sign that the flag is wrong and we should run cleanup and let casino get run again to be safe.
    if (getTimeInAug() < 10 * 60 * 1000 && casinoRanFileSet && player.money + (await getStocksValue(ns)) < 8E9) {
        launchScriptHelper(ns, 'cleanup.js');
        await ns.sleep(200); // Wait a short while for the dust to settle.
    } else if (casinoRanFileSet)
        return ranCasino = true;
    // If it's been less than 1 minute, wait a while to establish income
    // The exception is if we are in BN8 and have CashRoot Starter Kit. In this case we can head straight to the casino.
    if (getTimeInAug() < 60000 && !(resetInfo.currentNode == 8 && cashRootBought))
        return;
    // If we're making more than ~5b / minute, no need to run casino. (Unless BN8, if BN8 we always need casino cash bootstrap)
    // Since it's possible that the CashRoot Startker Kit could give a false income velocity, account for that.
    if (resetInfo.currentNode != 8 && (cashRootBought ? player.money - 1e6 : player.money) / getTimeInAug() > 5e9 / 60000)
        return ranCasino = true;
    if (player.money > 10E9) // If we already have 10b, assume we ran and lost track, or just don't need the money
        return ranCasino = true;
    if (player.money < 250000)
        return; // We need at least 200K (and change) to run casino so we can travel to aevum

    // Run casino.js (and expect ourself to get killed in the process)
    // Make sure "work-for-factions.js" is dead first, lest it steal focus and break the casino script before it has a chance to kill all scripts.
    await killScript(ns, 'work-for-factions.js');
    // Kill any action, in case we are studying or working out, as it might steal focus or funds before we can bet it at the casino.
    if (4 in unlockedSFs) // No big deal if we can't, casino.js has logic to find the stop button and click it.
        await getNsDataThroughFile(ns, `ns.singularity.stopAction()`);

    const pid = launchScriptHelper(ns, 'casino.js', ['--kill-all-scripts', true, '--on-completion-script', ns.getScriptName()]);
    if (pid) {
        await waitForProcessToComplete(ns, pid);
        await ns.sleep(1000); // Give time for this script to be killed if the game is being restarted by casino.js
        // If we didn't get killed, see if casino.js discovered it was already previously kicked out
        if (ns.read(casinoFlagFile)) return ranCasino = true;
        // Otherwise, something went wrong
        log(ns, `ERROR: Something went wrong. Casino.js ran, but we haven't been killed, and the casino flag file "${casinoFlagFile}" isn't set.`)
    }
}

/** Retrieves the last faction manager output file, parses, and types it.
 * @param {NS} ns 
 * @returns {{ affordable_nf_count: number, affordable_augs: [string], owned_count: number, unowned_count: number, total_rep_cost: number, total_aug_cost: number }}
 */
function getFactionManagerOutput(ns) {
    const facmanOutput = ns.read(factionManagerOutputFile)
    return !facmanOutput ? null : JSON.parse(facmanOutput)
}

/** Logic to detect if it's a good time to install augmentations, and if so, do so
 * @param {NS} ns 
 * @param {Player} player */
async function maybeInstallAugmentations(ns, player) {
    if (!(4 in unlockedSFs)) {
        setStatus(ns, `No singularity access, so you're on your own. You should manually work for factions and install augmentations!`);
        return false; // Cannot automate augmentations or installs without singularity
    }
    // If we previously attempted to reserve money for an augmentation purchase order, do a fresh facman run to ensure it's still available
    if (reservedPurchase && installCountdown <= Date.now()) {
        log(ns, "INFO: Manually running faction-manager.js to ensure previously reserved purchase is still obtainable.");
        ns.write(factionManagerOutputFile, "", "w"); // Reset the output file to ensure it isn't stale
        const pid = launchScriptHelper(ns, 'faction-manager.js');
        await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down (and output to be generated)
    }

    // Grab the latest output from faction manager to see if it's a good time to reset
    const facman = getFactionManagerOutput(ns);
    if (!facman) {
        setStatus(ns, `Faction manager output not available. Will try again later.`);
        return reservedPurchase = 0;
    }
    const affordableAugCount = facman.affordable_augs.length;
    playerInstalledAugCount = facman.owned_count;

    // Determine whether we can afford enough augmentations to merit a reset
    const reducedAugReq = Math.floor(options['reduced-aug-requirement-per-hour'] * getTimeInAug() / 3.6E6);
    const augsNeeded = Math.max(1, options['install-at-aug-count'] - reducedAugReq);
    const augsNeededInclNf = Math.max(1, options['install-at-aug-plus-nf-count'] - reducedAugReq);
    const uniqueAugCount = affordableAugCount - Math.sign(facman.affordable_nf_count); // Don't count NF if included
    let totalCost = facman.total_rep_cost + facman.total_aug_cost;
    const augSummary = `${uniqueAugCount} of ${facman.unowned_count - 1} remaining augmentations` +
        (facman.affordable_nf_count > 0 ? ` + ${facman.affordable_nf_count} levels of NeuroFlux.` : '.') +
        (uniqueAugCount > 0 ? `\n  Augs: [\"${facman.affordable_augs.join("\", \"")}\"]` : '');
    let resetStatus = `Reserving ${formatMoney(totalCost)} to install ${augSummary}`
    let shouldReset = options['install-for-augs'].some(a => facman.affordable_augs.includes(a)) ||
        affordableAugCount >= augsNeeded || (affordableAugCount + facman.affordable_nf_count - 1) >= augsNeededInclNf;
    // If we are in Daedalus, and we do not yet have enough favour to unlock rep donations with Daedalus,
    // but we DO have enough rep to earn that favor on our next restart, trigger an install immediately (need at least 1 aug)
    if (player.factions.includes("Daedalus") && ns.read("/Temp/Daedalus-donation-rep-attained.txt")) {
        shouldReset = true;
        resetStatus = `We have enough reputation with Daedalus to unlock donations on our next reset.\n${resetStatus}`;
        if (totalCost == 0) totalCost = 1; // Hack, logic below expects some non-zero reserve in preparation for ascending.
    }

    // If not ready to reset, set a status with our progress and return
    if (!shouldReset) {
        setStatus(ns, `Currently at ${formatDuration(getTimeInAug())} since last aug. ` +
            `Waiting for ${augsNeeded} new augs (or ${augsNeededInclNf} including NeuroFlux levels) before installing.` +
            `\nCan currently get: ${augSummary}` +
            `\n  Total Cost: ${formatMoney(totalCost)} (\`run faction-manager.js\` for details)`, augSummary);
        return reservedPurchase = 0; // If we were previously reserving money for a purchase, reset that flag now
    }
    // If we want to reset, but there is a reason to delay, don't reset
    if (await shouldDelayInstall(ns, player, facman)) // If we're currently in a state where we should not be resetting, skip reset logic
        return reservedPurchase = 0;

    // Ensure the money needed for the above augs doesn't get ripped out from under us by reserving it and waiting one more loop
    if (reservedPurchase < totalCost) {
        if (reservedPurchase != 0) // If we were already reserving for a purchase and the nubmer went up, log a notice of the timer being reset.
            log(ns, `INFO: The augmentation purchase we can afford has increased from ${formatMoney(reservedPurchase)} ` +
                `to ${formatMoney(totalCost)}. Resetting the timer before we install augmentations.`);
        installCountdown = Date.now() + options['install-countdown']; // Each time we can afford more augs, reset the install delay timer
        ns.write("reserve.txt", totalCost, "w"); // Should prevent other scripts from spending this money
    }
    // We must wait until the configured cooldown elapses before we install augs.
    if (installCountdown > Date.now()) {
        resetStatus += `\n  Waiting for ${formatDuration(options['install-countdown'])} (--install-countdown) ` +
            `to elapse before we install, in case we're close to being able to purchase more augmentations...`;
        setStatus(ns, resetStatus);
        ns.toast(`Heads up: Autopilot plans to reset in ${formatDuration(installCountdown - Date.now())}`, 'info');
        return reservedPurchase = totalCost;
    }

    // Otherwise, we've got the money reserved, we can afford the augs, we should be confident to ascend
    const resetLog = `Invoking ascend.js at ${formatDuration(getTimeInAug()).padEnd(11)} since last aug to install: ${augSummary}`;
    persist_log(ns, log(ns, resetLog, true, 'info'));

    // Kick off ascend.js
    let errLog;
    const ascendArgs = ['--install-augmentations', true, '--on-reset-script', ns.getScriptName()]
    if (affordableAugCount == 0) // If we know we have 0 augs, but still wish to reset, we must enable soft resetting
        ascendArgs.push("--allow-soft-reset")
    let pid = launchScriptHelper(ns, 'ascend.js', ascendArgs);
    if (pid) {
        await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down (Ascend should get killed as it does, since the BN will be rebooting)
        await ns.sleep(1000); // If we've been scheduled to be killed, awaiting an NS function should trigger it?
        errLog = `ERROR: ascend.js ran, but we're still here. Something must have gone wrong. Will try again later`;
    } else
        errLog = `ERROR: Failed to launch ascend.js (pid == 0). Will try again later`;
    // If we got this far, something went wrong
    persist_log(ns, log(ns, errLog, true, 'error'));
}

/** Logic to detect if we are close to a milestone and should postpone installing augmentations until it is hit
 * @param {NS} ns 
 * @param {Player} player
 * @param {{ affordable_nf_count: number, affordable_augs: [string], owned_count: number, unowned_count: number, total_rep_cost: number, total_aug_cost: number }} facmanOutput
*/
async function shouldDelayInstall(ns, player, facmanOutput) {
    // Are we close to being able to afford 4S TIX data?
    if (!options['disable-wait-for-4s'] && !(await getNsDataThroughFile(ns, `ns.stock.has4SDataTIXAPI()`))) {
        const totalWorth = player.money + await getStocksValue(ns);
        const has4S = await getNsDataThroughFile(ns, `ns.stock.has4SData()`);
        const totalCost = 25E9 * (bitnodeMults?.FourSigmaMarketDataApiCost || 1) +
            (has4S ? 0 : 1E9 * (bitnodeMults?.FourSigmaMarketDataCost || 1));
        const ratio = totalWorth / totalCost;
        // If we're e.g. 50% of the way there, hold off, regardless of the '--wait-for-4s' setting
        // TODO: If ratio is > 1, we can afford it - but stockmaster won't buy until it has e.g. 20% more than the cost
        //       (so it still has money to invest). It doesn't know we want to restart ASAP. Perhaps we should purchase ourselves?
        if (ratio >= options['wait-for-4s-threshold']) {
            setStatus(ns, `Not installing until scripts purchase the 4SDataTixApi because we have ` +
                `${(100 * totalWorth / totalCost).toFixed(0)}% of the cost (controlled by --wait-for-4s-threshold)`);
            return true;
        }
    }
    // In BN8, money is hard to come by, so if we're in Daedalus, but can't access TRP rep yet, wait until we have
    // enough rep, or enough money to donate for rep to buy TRP (Reminder: donations always unlocked in BN8)
    if (resetInfo.currentNode == 8 && player.factions.includes("Daedalus") && (wdHack || 0) == 0) {
        // Sanity check, ensure the player hasn't manually purchased (but not yet installed) TRP
        const ownedAugmentations = await getNsDataThroughFile(ns, `ns.singularity.getOwnedAugmentations(true)`, '/Temp/player-augs-purchased.txt');
        if (!facmanOutput.affordable_augs.includes("The Red Pill") && !ownedAugmentations.includes("The Red Pill")) {
            setStatus(ns, `Not installing until we have enough Daedalus rep to install TRP on our next reset.`)
            return true;
        }
    }
    // TODO: Bladeburner black-op in progress
    // TODO: Close to the rep needed for unlocking donations with a new faction?
    return false;
}

/** Consolidated logic for all the times we want to reserve money
 * @param {NS} ns 
 * @param {Player} player */
function manageReservedMoney(ns, player, stocksValue) {
    if (reservedPurchase) return; // Do not mess with money reserved for installing augmentations
    const currentReserve = Number(ns.read("reserve.txt") || 0);
    if (reserveForDaedalus) // Reserve 100b to get the daedalus invite
        return currentReserve == 100E9 ? true : ns.write("reserve.txt", 100E9, "w");
    // Otherwise, reserve money for stocks for a while, as it's our main source of income early in the BN
    // It also acts as a decent way to save up for augmentations
    const minStockValue = 8E9; // At a minimum 8 of the 10 billion earned from the casino must be reserved for buying stock
    // As we earn more money, reserve a percentage of it for further investing in stock. Decrease this as the BN progresses.
    const minStockPercent = Math.max(0, 0.8 - 0.1 * getTimeInBitnode() / 3.6E6); // Reduce by 10% per hour in the BN
    const reserveCap = 1E12; // As we start start to earn crazy money, we will hit the stock market cap, so cap the maximum reserve
    // Dynamically update reserved cash based on how much money is already converted to stocks.
    const reserve = Math.min(reserveCap, Math.max(0, player.money * minStockPercent, minStockValue - stocksValue));
    return currentReserve == reserve ? true : ns.write("reserve.txt", reserve, "w"); // Reserve for stocks
    // NOTE: After several iterations, I decided that the above is actually best to keep in all scenarios:
    // - Casino.js ignores the reserve, so the above takes care of ensuring our casino seed money isn't spent
    // - In low-income situations, stockmaster will be our best source of income. We invoke it such that it ignores 
    //	 the global reserve, so this 8B is for stocks only. The 2B remaining is plenty to kickstart the rest.
    // - Once high-hack/gang income is achieved, this 8B will not be missed anyway. 
    /*
    if(!ranCasino) { // In practice, 
        ns.write("reserve.txt", 300000, "w"); // Prevent other scripts from spending our casino seed money
        return moneyReserved = true;
    }
    // Otherwise, clear any reserve we previously had
    if(moneyReserved) ns.write("reserve.txt", 0, "w"); // Remove the casino reserve we would have placed
    return moneyReserved = false;
    */
}

/** Helper to launch a script and log whether if it succeeded or failed
 * @param {NS} ns */
function launchScriptHelper(ns, baseScriptName, args = [], convertFileName = true) {
    ns.tail(); // If we're going to be launching scripts, show our tail window so that we can easily be killed if the user wants to interrupt.
    let pid, err;
    try { pid = ns.run(convertFileName ? getFilePath(baseScriptName) : baseScriptName, 1, ...args); }
    catch (e) { err = e; }
    if (pid)
        log(ns, `INFO: Launched ${baseScriptName} (pid: ${pid}) with args: [${args.join(", ")}]`, true);
    else
        log(ns, `ERROR: Failed to launch ${baseScriptName} with args: [${args.join(", ")}]` +
            err ? `\nCaught: ` + (typeof err === 'string' ? err : err.message || JSON.stringify(err)) : '', true, 'error');
    return pid;
}

let lastStatusLog = ""; // The current or last-assigned long-term status (what this script is waiting to happen)

/** Helper to set a global status and print it if it changes
 * @param {NS} ns */
function setStatus(ns, status, uniquePart = null) {
    uniquePart = uniquePart || status; // Can be used to consider a logs "the same" (not worth re-printing) even if they have some different text
    if (lastStatusLog == uniquePart) return;
    lastStatusLog = uniquePart
    log(ns, status);
}

/** Append the specified text (with timestamp) to a persistent log in the home directory
 * @param {NS} ns */
function persist_log(ns, text) {
    ns.write(persistentLog, `${(new Date()).toISOString().substring(0, 19)} ${text}\n`, "a")
}