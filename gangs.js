import {
    log, getConfiguration, instanceCount, getNsDataThroughFile, getActiveSourceFiles, runCommand, tryGetBitNodeMultipliers,
    formatMoney, formatNumberShort, formatDuration
} from './helpers.js'

// Global config
const updateInterval = 200; // We can improve our timing by updating more often than gang stats do (which is every 2 seconds for stats, every 20 seconds for territory)
const wantedPenaltyThreshold = 0.0001; // Don't let the wanted penalty get worse than this
const offStatCostPenalty = 50; // Equipment that doesn't contribute to our main stats suffers a percieved cost penalty of this multiple
const defaultMaxSpendPerTickTransientEquipment = 0.002; // If the --equipment-budget is not specified, spend up to this percent of non-reserved cash on temporary upgrades (equipment)
const defaultMaxSpendPerTickPermanentEquipment = 0.2; // If the --augmentation-budget is not specified, spend up to this percent of non-reserved cash on permanent member upgrades

// Territory-related variables
const gangsByPower = ["Speakers for the Dead", "The Dark Army", "The Syndicate", "Tetrads", "Slum Snakes", /* Hack gangs don't scale as far */ "The Black Hand", /* "NiteSec" Been there, not fun. */]
const territoryEngageThreshold = 0.60; // Minimum average win chance (of gangs with territory) before we engage other clans
let territoryTickDetected = false;
let territoryTickTime = 20000; // Est. milliseconds until territory *ticks*. Can vary if processing offline time
let territoryTickWaitPadding = 200; // Start waiting this many milliseconds before we think territory will tick, in case it ticks early (increases automatically after misfires)
let consecutiveTerritoryDetections = 0; // Used to reduce padding if things get back on track.
let territoryNextTick = null; // The next time territory will tick
let isReadyForNextTerritoryTick = false;
let warfareFinished = false;
let lastTerritoryPower = 0;
let lastOtherGangInfo = null;
let lastLoopTime = null;

// Crime activity-related variables
const crimes = ["Mug People", "Deal Drugs", "Strongarm Civilians", "Run a Con", "Armed Robbery", "Traffick Illegal Arms", "Threaten & Blackmail", "Human Trafficking", "Terrorism",
    "Ransomware", "Phishing", "Identity Theft", "DDoS Attacks", "Plant Virus", "Fraud & Counterfeiting", "Money Laundering", "Cyberterrorism"];
let pctTraining = 0.20;
let multGangSoftcap;
let allTaskNames;
let allTaskStats;
let assignedTasks = {}; // Each member will independently attempt to scale up the crime they perform until they are ineffective or we start generating wanted levels
let lastMemberReset = {}; // Tracks when each member last ascended

// Global state
let resetInfo = (/**@returns{ResetInfo}*/() => undefined)(); // Information about the current bitnode
let ownedSourceFiles;
let myGangFaction = "";
let isHackGang = false;
let strWantedReduction;
let requiredRep = 0;
let myGangMembers = [];
let equipments = [];
let importantStats = [];

let options;
const argsSchema = [
    ['training-percentage', 0.05], // Spend this percent of time randomly training gang members versus doing crime
    ['no-training', false], // Don't train unless all other tasks generate no gains or the member ascended recently (--min-training-ticks)
    ['no-auto-ascending', false], // Don't ascend members
    ['ascend-multi-threshold', 1.05], // Ascend member #12 if a primary stat multi would increase by more than this amount
    ['ascend-multi-threshold-spacing', 0.05], // Members will space their acention multis by this amount to ensure they are ascending at different rates 
    // Note: given the above two defaults, members would ascend at multis [1.6, 1.55, 1.50, ..., 1.1, 1.05] once you have 12 members.
    ['min-training-ticks', 10], // Require this many ticks of training after ascending or recruiting to rebuild stats
    ['reserve', null], // Reserve this much cash before determining spending budgets (defaults to contents of reserve.txt if not specified)
    ['augmentations-budget', null], // Percentage of non-reserved cash to spend per tick on permanent member upgrades (If not specified, uses defaultMaxSpendPerTickPermanentEquipment)
    ['equipment-budget', null], // Percentage of non-reserved cash to spend per tick on permanent member upgrades (If not specified, uses defaultMaxSpendPerTickTransientEquipment)
    ['money-focus', false], // Always optimize gang crimes for maximum monetary gain. Is otherwise balanced.
    ['reputation-focus', false], // Always optimize gang crimes for maximum reputation gain. Is otherwise balanced.
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions || await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    options = runOptions; // We don't set the global "options" until we're sure this is the only running instance
    ownedSourceFiles = await getActiveSourceFiles(ns);
    const sf2Level = ownedSourceFiles[2] || 0;
    if (sf2Level == 0)
        return log(ns, "ERROR: You have no yet unlocked gangs. Script should not be run...");

    await initialize(ns);
    log(ns, "Starting main loop...");
    while (true) {
        try { await mainLoop(ns); }
        catch (err) {
            log(ns, `WARNING: gangs.js Caught (and suppressed) an unexpected error in the main loop:\n` +
                (typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
        }
        await ns.sleep(updateInterval);
    }
}

/** @param {NS} ns 
 * One-time setup actions. **/
async function initialize(ns) {
    ns.disableLog('ALL');
    pctTraining = options['no-training'] ? 0 : options['training-percentage'];

    let loggedWaiting = false;
    resetInfo = await getNsDataThroughFile(ns, 'ns.getResetInfo()');
    const bitNode = resetInfo.currentNode;
    let haveJoinedAGang = false;
    while (!haveJoinedAGang) {
        try {
            haveJoinedAGang = await getNsDataThroughFile(ns, 'ns.gang.inGang()');
            if (haveJoinedAGang) break;
            if (!loggedWaiting) {
                log(ns, `Waiting to be in a gang. Will create the highest faction gang as soon as it is available...`);
                loggedWaiting = true;
            }
            if (bitNode == 2 || ns.heart.break() <= -54000)
                await runCommand(ns, `ns.args.forEach(g => ns.gang.createGang(g))`, '/Temp/gang-createGang.js', gangsByPower);
        }
        catch (err) {
            log(ns, `WARNING: gangs.js Caught (and suppressed) an unexpected error while waiting to join a gang:\n` +
                (typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
        }
        await ns.sleep(1000);
    }
    const playerData = await getNsDataThroughFile(ns, 'ns.getPlayer()');
    log(ns, "Collecting gang information...");
    const myGangInfo = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
    myGangFaction = myGangInfo.faction;
    if (loggedWaiting)
        log(ns, `SUCCESS: Created gang ${myGangFaction} (At ${formatDuration(Date.now() - resetInfo.lastNodeReset)} into BitNode)`, true, 'success');
    isHackGang = myGangInfo.isHacking;
    strWantedReduction = isHackGang ? "Ethical Hacking" : "Vigilante Justice";
    importantStats = isHackGang ? ["hack"] : ["str", "def", "dex", "agi"];
    territoryNextTick = lastTerritoryPower = lastOtherGangInfo = null;
    territoryTickDetected = isReadyForNextTerritoryTick = warfareFinished = false;
    territoryTickWaitPadding = updateInterval;

    // If possible, determine how much rep we would need to get the most expensive unowned augmentation
    const sf4Level = ownedSourceFiles[4] || 0;
    requiredRep = 2.5e6;
    if (sf4Level == 0)
        log(ns, `INFO: SF4 required to get gang augmentation info. Defaulting to assuming ~2.5 million rep is desired.`);
    else {
        try {
            if (sf4Level < 3)
                log(ns, `WARNING: This script makes use of singularity functions, which are quite expensive before you have SF4.3. ` +
                    `Unless you have a lot of free RAM for temporary scripts, you may get runtime errors.`);
            const augmentationNames = await getNsDataThroughFile(ns, `ns.singularity.getAugmentationsFromFaction(ns.args[0])`, null, [myGangFaction]);
            const ownedAugmentations = await getNsDataThroughFile(ns, `ns.singularity.getOwnedAugmentations(true)`, '/Temp/player-augs-purchased.txt');
            const dictAugRepReqs = await getDict(ns, augmentationNames, 'singularity.getAugmentationRepReq', '/Temp/aug-repreqs.txt');
            // Due to a bug, gangs appear to provide "The Red Pill" even when it's unavailable (outside of BN2), so ignore this one.
            requiredRep = augmentationNames.filter(aug => !ownedAugmentations.includes(aug) && aug != "The Red Pill").reduce((max, aug) => Math.max(max, dictAugRepReqs[aug]), -1);
            log(ns, `Highest augmentation reputation cost is ${formatNumberShort(requiredRep)}`);
        } catch {
            log(ns, `WARNING: Failed to get augmentation info despite having SF4.${sf4Level}. This may be due to you having insufficient RAM to launch the temporary scripts. ` +
                `Proceeding with the default assumption that ~2.5 million rep is desired.`);
        }
    }

    // Initialize equipment information
    const equipmentNames = await getNsDataThroughFile(ns, 'ns.gang.getEquipmentNames()');
    const dictEquipmentTypes = await getGangInfoDict(ns, equipmentNames, 'getEquipmentType');
    const dictEquipmentCosts = await getGangInfoDict(ns, equipmentNames, 'getEquipmentCost');
    const dictEquipmentStats = await getGangInfoDict(ns, equipmentNames, 'getEquipmentStats');
    equipments = equipmentNames.map((equipmentName) => ({
        name: equipmentName,
        type: dictEquipmentTypes[equipmentName],
        cost: dictEquipmentCosts[equipmentName],
        stats: dictEquipmentStats[equipmentName],
    })).sort((a, b) => a.cost - b.cost);
    //log(ns, JSON.stringify(equipments));
    // Initialize information about gang members and crimes
    allTaskNames = await getNsDataThroughFile(ns, 'ns.gang.getTaskNames()')
    allTaskStats = await getGangInfoDict(ns, allTaskNames, 'getTaskStats');
    multGangSoftcap = (await tryGetBitNodeMultipliers(ns))?.GangSoftcap || 1;
    myGangMembers = await getNsDataThroughFile(ns, 'ns.gang.getMemberNames()');
    const dictMembers = await getGangInfoDict(ns, myGangMembers, 'getMemberInformation');
    for (const member of Object.values(dictMembers)) // Initialize the current activity of each member
        assignedTasks[member.name] = (member.task && member.task !== "Unassigned") ? member.task : ("Train " + (isHackGang ? "Hacking" : "Combat"));
    while (myGangMembers.length < 3) await doRecruitMember(ns); // We should be able to recruit our first three members immediately (for free)
    // Peform all updates / actions normally performed on territory tick (every 20 seconds) once before starting the main loop
    lastLoopTime = Date.now()
    await onTerritoryTick(ns, myGangInfo);
    lastTerritoryPower = myGangInfo.power;
}

/** @param {NS} ns 
 * Executed every `interval` **/
async function mainLoop(ns) {
    // Update gang information (specifically monitoring gang power to see when territory ticks)
    const myGangInfo = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
    const thisLoopStart = Date.now();
    if (!territoryTickDetected) { // Detect the first territory tick by watching for other gang's territory power to update.
        const otherGangInfo = await getNsDataThroughFile(ns, 'ns.gang.getOtherGangInformation()'); // Returns dict of { [gangName]: { "power": Number, "territory": Number } }
        if (lastOtherGangInfo != null && JSON.stringify(otherGangInfo) != JSON.stringify(lastOtherGangInfo)) {
            territoryNextTick = lastLoopTime + territoryTickTime;
            territoryTickDetected = true;
            log(ns, `INFO: Others gangs power updated (sometime in the past ${formatDuration(thisLoopStart - lastLoopTime)}. ` +
                `Will start waiting for next tick in: ${formatDuration(territoryNextTick - thisLoopStart - territoryTickWaitPadding)}`, false);
        } else if (lastOtherGangInfo == null)
            log(ns, `INFO: Waiting to detect territory to tick. (Waiting for other gangs' power to update.) Will check every ${formatDuration(updateInterval)}...`);
        lastOtherGangInfo = otherGangInfo;
    }
    // If territory is close to ticking, quick - set everyone to do "territory warfare"! Once we hit 100% territory, there's no need to keep swapping members to warfare
    if (!warfareFinished && !isReadyForNextTerritoryTick && (thisLoopStart + updateInterval + territoryTickWaitPadding >= territoryNextTick)) { // Start 1 second early to be safe
        isReadyForNextTerritoryTick = true;
        await updateMemberActivities(ns, null, "Territory Warfare", myGangInfo);
    }
    // Detect if territory power has been updated in the last tick (or if we have no power, assume it has ticked and we just haven't generated power yet)
    if ((isReadyForNextTerritoryTick && myGangInfo.power != lastTerritoryPower) || (thisLoopStart > territoryNextTick + 5000 /* Wait up to 5 additional seconds in case time was wonkey */)) {
        await onTerritoryTick(ns, myGangInfo); //Do most things only once per territory tick
        isReadyForNextTerritoryTick = false;
        lastTerritoryPower = myGangInfo.power;
    } else if (isReadyForNextTerritoryTick)
        log(ns, `INFO: Waiting for territory to tick. (Waiting for gang power to change from ${formatNumberShort(lastTerritoryPower)}. ETA: ${formatDuration(territoryNextTick - thisLoopStart)}`);
    lastLoopTime = thisLoopStart; // Due to periodic lag, we must track the last time we checked, can't assume it was `updateInterval` ago.
}

/** @param {NS} ns 
 * Do some things only once per territory tick **/
async function onTerritoryTick(ns, myGangInfo) {
    territoryNextTick = lastLoopTime + territoryTickTime / (ns.gang.getBonusTime() > 0 ? 5 : 1); // Reset the time the next tick will occur
    if (lastTerritoryPower != myGangInfo.power || lastTerritoryPower == null) {
        log(ns, `Territory power updated from ${formatNumberShort(lastTerritoryPower)} to ${formatNumberShort(myGangInfo.power)}.`)
        consecutiveTerritoryDetections++;
        if (consecutiveTerritoryDetections > 5 && territoryTickWaitPadding > updateInterval)
            territoryTickWaitPadding = Math.max(updateInterval, territoryTickWaitPadding - updateInterval);
    } else if (!warfareFinished) {
        log(ns, `WARNING: Power stats weren't updated, assuming we've lost track of territory tick`, false,
            consecutiveTerritoryDetections == 0 ? 'warning' : null); // Only pop-up a warning if this happens two territory ticks in a row (or more)
        consecutiveTerritoryDetections = 0;
        territoryTickWaitPadding = Math.min(2000, territoryTickWaitPadding + updateInterval); // Start waiting earlier to account for observed lag.
        territoryNextTick -= updateInterval; // Prep for the next tick a little earlier, in case we just lagged behind the tick by a bit.
        territoryTickDetected = false;
        lastOtherGangInfo = null;
    }

    // Update gang members in case someone died in a clash
    myGangMembers = await getNsDataThroughFile(ns, 'ns.gang.getMemberNames()');
    const nextMemberCost = Math.pow(5, myGangMembers.length - (3 /*numFreeMembers*/ - 1));
    if (myGangMembers.length < 12 /* Game Max */ && myGangInfo.respect >= nextMemberCost)
        await doRecruitMember(ns) // Recruit new members if available
    const dictMembers = await getGangInfoDict(ns, myGangMembers, 'getMemberInformation');
    if (!options['no-auto-ascending']) await tryAscendMembers(ns); // Ascend members if we deem it a good time
    await tryUpgradeMembers(ns, dictMembers); // Upgrade members if possible
    await enableOrDisableWarfare(ns, myGangInfo); // Update whether we should be participating in gang warfare
    // There's a chance we do training instead of work for this next tick. If training, we primarily train our main stat, with a small chance to train less-important stats
    const task = Math.random() >= pctTraining ? null : "Train " + (Math.random() < 0.1 ? "Charisma" : Math.random() < (isHackGang ? 0.1 : 0.9) ? "Combat" : "Hacking")
    await updateMemberActivities(ns, dictMembers, task); // Set everyone working on the next activity
    if (!task) await optimizeGangCrime(ns, await waitForGameUpdate(ns, myGangInfo));  // Finally, see if we can improve rep gain rates by micro-optimizing individual member crimes
}

/** @param {NS} ns 
 * Consolidated logic for telling members what to do **/
async function updateMemberActivities(ns, dictMemberInfo = null, forceTask = null, myGangInfo = null) {
    const dictMembers = dictMemberInfo || (await getGangInfoDict(ns, myGangMembers, 'getMemberInformation'));
    const workOrders = [];
    const maxMemberDefense = Math.max(...Object.values(dictMembers).map(m => m.def));
    for (const member of Object.values(dictMembers)) { // Set the desired activity of each member
        let task = forceTask ? forceTask : assignedTasks[member.name];
        if (forceTask == "Territory Warfare" && myGangInfo.territoryClashChance > 0 && (member.def < 100 || member.def < Math.min(10000, maxMemberDefense * 0.1)))
            task = assignedTasks[member.name]; // Hack: Spare low-defense members from engaging in in warfare since they have a higher chance of dying
        if (member.task != task) workOrders.push({ name: member.name, task }); // Only bother with the API call if this isn't their current task
    }
    if (workOrders.length == 0) return;
    // Set the activities in bulk using a ram-dodging script
    if (await getNsDataThroughFile(ns, `JSON.parse(ns.args[0]).reduce((success, m) => success && ns.gang.setMemberTask(m.name, m.task), true)`,
        '/Temp/gang-set-member-tasks.txt', [JSON.stringify(workOrders)]))
        log(ns, `INFO: Assigned ${workOrders.length}/${Object.keys(dictMembers).length} gang member tasks (${workOrders.map(o => o.task).filter((v, i, self) => self.indexOf(v) === i).join(", ")})`)
    else
        log(ns, `ERROR: Failed to set member task of one or more members: ` + JSON.stringify(workOrders), false, 'error');
}

/** @param {NS} ns 
 * Logic to assign tasks that maximize rep gain rate without wanted gain getting out of control **/
async function optimizeGangCrime(ns, myGangInfo) {
    const dictMembers = await getGangInfoDict(ns, myGangMembers, 'getMemberInformation');
    // Tolerate our wanted level increasing, as long as reputation increases several orders of magnitude faster and we do not currently have a penalty more than -0.01%
    let currentWantedPenalty = getWantedPenalty(myGangInfo) - 1;
    // Note, until we have ~200 respect, the best way to recover from wanted penalty is to focus on gaining respect, rather than doing vigilante work.
    let wantedGainTolerance = currentWantedPenalty < -1.1 * wantedPenaltyThreshold && myGangInfo.wantedLevel >= (1.1 + myGangInfo.respect / 1000) &&
        myGangInfo.respect > 200 ? -0.01 * myGangInfo.wantedLevel /* Recover from wanted penalty */ :
        currentWantedPenalty < -0.9 * wantedPenaltyThreshold && myGangInfo.wantedLevel >= (1.1 + myGangInfo.respect / 10000) ? 0 /* Sustain */ :
            Math.max(myGangInfo.respectGainRate / 1000, myGangInfo.wantedLevel / 10) /* Allow wanted to increase at a manageable rate */;
    const playerData = await getNsDataThroughFile(ns, 'ns.getPlayer()');
    // Find out how much reputation we need, without SF4, we estimate gang faction rep based on current gang rep
    let factionRep = -1;
    if (ownedSourceFiles[4] > 0) {
        try { factionRep = await getNsDataThroughFile(ns, `ns.singularity.getFactionRep(ns.args[0])`, null, [myGangFaction]); }
        catch { log(ns, 'INFO: Error suppressed. Falling back to estimating current gang faction rep.'); }
    }
    if (factionRep == -1) // Estimate current gang rep based on respect. Game gives 1/75 rep / respect. This is an underestimate, because it doesn't take into account spent/lost respect on ascend/recruit/death. 
        factionRep = myGangInfo.respect / 75;
    const optStat = options['reputation-focus'] ? "respect" : options['money-focus'] ? "money" :
        // If not specified, automatically change focus based on achieved rep/money
        factionRep > requiredRep ? "money" : (playerData.money > 1E11 || myGangInfo.respect) < 9000 ? "respect" : "both money and respect";
    // Pre-compute how every gang member will perform at every task
    const memberTaskRates = Object.fromEntries(Object.values(dictMembers).map(m => [m.name, allTaskNames.map(taskName => ({
        name: taskName,
        respect: computeRepGains(myGangInfo, taskName, m),
        money: calculateMoneyGains(myGangInfo, taskName, m),
        wanted: computeWantedGains(myGangInfo, taskName, m),
    })).filter(task => task.wanted <= 0 || task.money > 0 || task.respect > 0)])); // Completely remove tasks that offer no gains, but would generate wanted levels
    // Sort tasks by best gain rate
    if (optStat == "both money and respect") {
        Object.values(memberTaskRates).flat().forEach(v => v[optStat] = v.money / 1000 + v.respect); // Hack to support a "optimized total" stat when trying to balance both money and wanted
        Object.values(memberTaskRates).forEach((tasks, idx) => tasks.sort((a, b) => idx % 2 == 0 ? b.respect - a.respect : b.money - a.money)); // Hack: Even members prioritize respect, odd money
    } else {
        Object.values(memberTaskRates).forEach(tasks => tasks.sort((a, b) => b[optStat] - a[optStat]));
    }
    //ns.print(memberTaskRates);

    // Run "the algorithm"
    const start = Date.now(); // Time the algorithms
    let bestTaskAssignments = null, bestWanted = 0;
    let bestTotalGain = myGangInfo.wantedLevelGainRate > wantedGainTolerance ? 0 : // Forget our past achievements, we're gaining wanted levels too fast right now
        optStat == "respect" ? myGangInfo.respectGainRate : myGangInfo.moneyGainRate; // Must do better than the current gain rate if it's within our wanted threshold
    for (let shuffle = 0; shuffle < 100; shuffle++) { // We can discover more optimal results by greedy-optimizing gang members in a different order. Try a few.
        let proposedTasks = {}, totalWanted = 0, totalGain = 0;
        shuffleArray(myGangMembers.slice()).forEach((member, index) => {
            const taskRates = memberTaskRates[member];
            // "Greedy" optimize one member at a time, but as we near the end of the list, we can no longer expect future members to make for wanted increases
            const sustainableTasks = (index < myGangMembers.length - 2) ? taskRates : taskRates.filter(c => (totalWanted + c.wanted) <= wantedGainTolerance);
            // Find the crime with the best gain (If we can't generate value for any tasks, then we should only be training)
            const bestTask = taskRates[0][optStat] == 0 || (Date.now() - (lastMemberReset[member] || 0) < options['min-training-ticks'] * territoryTickTime) ?
                taskRates.find(t => t.name === ("Train " + (isHackGang ? "Hacking" : "Combat"))) :
                (totalWanted > wantedGainTolerance || sustainableTasks.length == 0) ? taskRates.find(t => t.name === strWantedReduction) : sustainableTasks[0];
            [proposedTasks[member], totalWanted, totalGain] = [bestTask, totalWanted + bestTask.wanted, totalGain + bestTask[optStat]];
        });
        // Following the above attempted optimization, if we're above our wanted gain threshold, downgrade the task of the greatest generators of wanted until within our limit
        let infiniteLoop = 9999;
        while (totalWanted > wantedGainTolerance && Object.values(proposedTasks).some(t => t.name !== strWantedReduction)) {
            const mostWanted = Object.keys(proposedTasks).reduce((t, c) => proposedTasks[c].name !== strWantedReduction && (t == null || proposedTasks[t].wanted < proposedTasks[c].wanted) ? c : t, null);
            const nextBestTask = memberTaskRates[mostWanted].filter(c => c.wanted < proposedTasks[mostWanted].wanted)[0] ?? memberTaskRates[mostWanted].find(t => t.name === strWantedReduction);
            [proposedTasks[mostWanted], totalWanted, totalGain] = [nextBestTask, totalWanted + nextBestTask.wanted - proposedTasks[mostWanted].wanted, totalGain + nextBestTask[optStat] - proposedTasks[mostWanted][optStat]];
            if (infiniteLoop-- <= 0) throw "Infinite Loop!";
        }
        //log(ns, `Optimal task assignments:. Wanted: ${totalWanted.toPrecision(3)}, Gain: ${formatNumberShort(totalGain)}`);
        // Save the new new task assignments only if it's the best gain result we've seen for the value we're trying to optimize, or the closest we've come to meeting our wanted tolerance
        if (totalWanted <= wantedGainTolerance && totalGain > bestTotalGain || totalWanted > wantedGainTolerance && totalWanted < bestWanted)
            [bestTaskAssignments, bestTotalGain, bestWanted] = [proposedTasks, totalGain, totalWanted];
    }
    const elapsed = Date.now() - start;
    // Determine whether any changes need to be made
    if (bestTaskAssignments != null && myGangMembers.some(m => assignedTasks[m] !== bestTaskAssignments[m].name)) {
        myGangMembers.forEach(m => assignedTasks[m] = bestTaskAssignments[m].name); // Update work orders for all members
        const oldGangInfo = myGangInfo;
        await updateMemberActivities(ns, dictMembers);
        const [optWanted, optRespect, optMoney] = myGangMembers.map(m => assignedTasks[m]).reduce(([w, r, m], t) => [w + t.wanted, r + t.respect, m + t.money], [0, 0, 0]);
        if (optWanted != oldGangInfo.wantedLevelGainRate || optRespect != oldGangInfo.respectGainRate || optMoney != oldGangInfo.moneyGainRate)
            myGangInfo = await waitForGameUpdate(ns, oldGangInfo);
        log(ns, `SUCCESS: Optimized gang member crimes for ${optStat} with wanted gain tolerance ${wantedGainTolerance.toPrecision(2)} (${elapsed} ms). ` +
            `Wanted: ${oldGangInfo.wantedLevelGainRate.toPrecision(3)} -> ${myGangInfo.wantedLevelGainRate.toPrecision(3)}, ` +
            `Rep: ${formatNumberShort(oldGangInfo.respectGainRate)} -> ${formatNumberShort(myGangInfo.respectGainRate)}, Money: ${formatMoney(oldGangInfo.moneyGainRate)} -> ${formatMoney(myGangInfo.moneyGainRate)}`);
        // Sanity check that our calculations (which we stole from game source code) are about right
        if ((Math.abs(myGangInfo.wantedLevelGainRate - optWanted) / optWanted > 0.01) || (Math.abs(myGangInfo.respectGainRate - optRespect) / optRespect > 0.01) || (Math.abs(myGangInfo.moneyGainRate - optMoney) / optMoney > 0.01))
            log(ns, `WARNING: Calculated new rates would be Rep:${formatNumberShort(optRespect)} Wanted: ${optWanted.toPrecision(3)} Money: ${formatMoney(optMoney)}` +
                `but they are Rep:${formatNumberShort(myGangInfo.respectGainRate)} Wanted: ${myGangInfo.wantedLevelGainRate.toPrecision(3)} Money: ${formatMoney(myGangInfo.moneyGainRate)}`, false, 'warning');
    } else
        log(ns, `INFO: Determined all ${myGangMembers.length} gang member assignments are already optimal for ${optStat} with wanted gain tolerance ${wantedGainTolerance.toPrecision(2)} (${elapsed} ms).`);
    // Fail-safe: If we somehow over-shot and are generating wanted levels, start randomly assigning members to vigilante to fix it
    if (myGangInfo.wantedLevelGainRate > wantedGainTolerance) await fixWantedGainRate(ns, myGangInfo, wantedGainTolerance);
}

/** @param {NS} ns 
 * Logic to reduce crime tiers when we're generating a wanted level **/
async function fixWantedGainRate(ns, myGangInfo, wantedGainTolerance = 0) {
    // TODO: steal actual wanted level calcs and strategically pick the member(s) who can bridge the gap while losing the least rep/sec
    let lastWantedLevelGainRate = myGangInfo.wantedLevelGainRate;
    log(ns, `WARNING: Generating wanted levels (${lastWantedLevelGainRate.toPrecision(3)}/sec > ${wantedGainTolerance.toPrecision(3)}/sec), temporarily assigning random members to Vigilante Justice...`, false, 'warning');
    for (const member of shuffleArray(myGangMembers.slice())) {
        if (!crimes.includes(assignedTasks[member])) continue; // This member isn't doing crime, so they aren't contributing to wanted
        assignedTasks[member] = strWantedReduction;
        await updateMemberActivities(ns);
        const wantedLevelGainRate = (myGangInfo = await waitForGameUpdate(ns, myGangInfo)).wantedLevelGainRate;
        if (wantedLevelGainRate < wantedGainTolerance) return;
        if (lastWantedLevelGainRate == wantedLevelGainRate)
            log(ns, `Warning: Attempt to rollback crime of ${member} to ${assignedTasks[member]} resulted in no change in wanted level gain rate ` +
                `(${lastWantedLevelGainRate.toPrecision(3)})`, false, 'warning');
    }
}

/** @param {NS} ns 
 * Recruit new members if available **/
async function doRecruitMember(ns) {
    let i = 0, newMemberName;
    do { newMemberName = `Thug ${++i}`; } while (myGangMembers.includes(newMemberName) || myGangMembers.includes(newMemberName + " Understudy"));
    if (i < myGangMembers.length) newMemberName += " Understudy"; // Pay our respects to the deceased
    if (await getNsDataThroughFile(ns, `ns.gang.canRecruitMember() && ns.gang.recruitMember(ns.args[0])`, '/Temp/gang-recruit-member.txt', [newMemberName])) {
        myGangMembers.push(newMemberName);
        assignedTasks[newMemberName] = "Train " + (isHackGang ? "Hacking" : "Combat");
        lastMemberReset[newMemberName] = Date.now();
        log(ns, `SUCCESS: Recruited a new gang member "${newMemberName}"!`, false, 'success');
    } else {
        log(ns, `ERROR: Failed to recruit a new gang member "${newMemberName}"!`, false, 'error');
    }
}

/** @param {NS} ns 
 * Check if any members are deemed worth ascending to increase a stat multiplier **/
async function tryAscendMembers(ns) {
    const dictAscensionResults = await getGangInfoDict(ns, myGangMembers, 'getAscensionResult');
    for (let i = 0; i < myGangMembers.length; i++) {
        const member = myGangMembers[i];
        // First members are given the largest threshold, so that early on when they are our only members, they are more stable
        const ascMultiThreshold = options['ascend-multi-threshold'] + (11 - i) * options['ascend-multi-threshold-spacing'];
        const ascResult = dictAscensionResults[member];
        if (!ascResult || !importantStats.some(stat => ascResult[stat] >= ascMultiThreshold))
            continue;
        if (undefined !== (await getNsDataThroughFile(ns, `ns.gang.ascendMember(ns.args[0])`, null, [member]))) {
            log(ns, `SUCCESS: Ascended member ${member} to increase multis by ${importantStats.map(s => `${s} -> ${ascResult[s].toFixed(2)}x`).join(", ")}`, false, 'success');
            lastMemberReset[member] = Date.now();
        }
        else
            log(ns, `ERROR: Attempt to ascended member ${member} failed. Go investigate!`, false, 'error');
    }
}

/** @param {NS} ns 
 * Upgrade any missing equipment / augmentations of members if we have the budget for it **/
async function tryUpgradeMembers(ns, dictMembers) {
    // Update equipment costs to take into account discounts
    const dictEquipmentCosts = await getGangInfoDict(ns, equipments.map(e => e.name), 'getEquipmentCost');
    equipments.forEach(e => e.cost = dictEquipmentCosts[e.name])
    // Upgrade members, spending no more than x% of our money per tick (and respecting the global reseve)
    const purchaseOrder = [];
    const playerData = await getNsDataThroughFile(ns, 'ns.getPlayer()');
    const homeMoney = playerData.money - (options['reserve'] != null ? options['reserve'] : Number(ns.read("reserve.txt") || 0));
    const maxBudget = 0.99; // Note: To avoid rounding issues and micro-spend race-conditions, only allow budgeting up to 99% of money per tick
    let budget = Math.min(maxBudget, (options['equipment-budget'] || defaultMaxSpendPerTickTransientEquipment)) * homeMoney;
    let augBudget = Math.min(maxBudget, (options['augmentations-budget'] || defaultMaxSpendPerTickPermanentEquipment)) * homeMoney;
    // Hack: Default aug budget is cut by 1/100 in a few situations (TODO: Add more, like when BitnodeMults are such that gang income is severely nerfed)
    if (!ns.stock.has4SDataTIXAPI() || resetInfo.currentNode === 8) {
        budget /= 100;
        augBudget /= 100;
    }
    // Find out what outstanding equipment can be bought within our budget
    for (const equip of equipments) {
        if (augBudget <= 0) break;
        for (const member of Object.values(dictMembers)) { // Get this equip for each member before considering the next most expensive equip
            if (augBudget <= 0) break;
            // Bit of a hack: Inflate the "cost" of equipment that doesn't contribute to our main stats so that we don't purchase them unless we have ample cash
            let percievedCost = equip.cost * (Object.keys(equip.stats).some(stat => importantStats.some(i => stat.includes(i))) ? 1 : offStatCostPenalty);
            if (percievedCost > augBudget) continue;
            if (equip.type != "Augmentation" && percievedCost > budget) continue;
            if (!member.upgrades.includes(equip.name) && !member.augmentations.includes(equip.name)) {
                purchaseOrder.push({ member: member.name, type: equip.type, equipmentName: equip.name, cost: equip.cost });
                budget -= equip.cost;
                augBudget -= equip.cost;
            }
        }
    }
    await doUpgradePurchases(ns, purchaseOrder);
}

/** @param {NS} ns 
 * Spawn a temporary taask to upgrade members. **/
async function doUpgradePurchases(ns, purchaseOrder) {
    if (purchaseOrder.length == 0) return;
    const totalCost = purchaseOrder.reduce((t, e) => t + e.cost, 0);
    const getOrderSummary = (items) => items.map(o => `${o.member} ${o.type}: "${o.equipmentName}"`).join(", ");
    const orderOutcomes = await getNsDataThroughFile(ns, `JSON.parse(ns.args[0]).map(o => ns.gang.purchaseEquipment(o.member, o.equipmentName))`,
        '/Temp/gang-upgrade-members.txt', [JSON.stringify(purchaseOrder)]);
    const succeeded = [], failed = [];
    for (let i = 0; i < orderOutcomes.length; i++)
        (orderOutcomes[i] ? succeeded : failed).push(purchaseOrder[i]);
    if (succeeded.length == purchaseOrder.length)
        log(ns, `SUCCESS: Purchased ${purchaseOrder.length} gang member upgrades for ${formatMoney(totalCost)}:\n${getOrderSummary(succeeded)}`, false, 'success');
    else
        log(ns, `WARNING: Failed to purchase one or more gang upgrades totalling ${formatMoney(totalCost)} (Insufficient funds?).` +
            `\n  Failed: ${getOrderSummary(failed)}\n  Succeeded: ${getOrderSummary(succeeded)}`, false, 'error');
}

let sequentialMisfires = 0;

/** @param {NS} ns 
 * Helper to wait for the game to update stats (typically 2 seconds per cycle) **/
async function waitForGameUpdate(ns, oldGangInfo) {
    if (!myGangMembers.some(member => !assignedTasks[member].includes("Train")))
        return oldGangInfo; // Ganginfo will never change if all members are training, so don't wait for an update
    const maxWaitTime = 2500;
    const waitInterval = 100;
    const start = Date.now()
    while (Date.now() < start + maxWaitTime) {
        var latestGangInfo = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
        if (JSON.stringify(latestGangInfo) != JSON.stringify(oldGangInfo)) {
            sequentialMisfires = 0;
            return latestGangInfo;
        }
        await ns.sleep(Math.min(waitInterval, start + maxWaitTime - Date.now()));
    }
    sequentialMisfires++;
    log(ns, `WARNING: Max wait time ${maxWaitTime} exceeded while waiting for old gang info to update.\n${JSON.stringify(oldGangInfo)}\n===\n${JSON.stringify(latestGangInfo)}`,
        false, sequentialMisfires < 2 ? null : 'warning'); // Only pop-up an alert if this happens twice in a row (or more)
    territoryTickDetected = false;
    return latestGangInfo;
}

/** @param {NS} ns 
 * Checks whether we should be engaging in warfare based on our gang power and that of other gangs. **/
async function enableOrDisableWarfare(ns, myGangInfo) {
    warfareFinished = Math.round(myGangInfo.territory * 2 ** 20) / 2 ** 20 /* Handle API imprecision */ >= 1;
    if (warfareFinished && !myGangInfo.territoryWarfareEngaged) return; // No need to engage once we hit 100%
    const otherGangs = await getNsDataThroughFile(ns, 'ns.gang.getOtherGangInformation()'); // Returns dict of { [gangName]: { "power": Number, "territory": Number } }
    let lowestWinChance = 1, totalWinChance = 0, totalActiveGangs = 0;
    let lowestWinChanceGang = "";
    for (const otherGang in otherGangs) {
        if (otherGangs[otherGang].territory == 0 || otherGang == myGangFaction) continue; // *New* Don't have to worry about battling a gang if it has 0 territory
        const winChance = myGangInfo.power / (myGangInfo.power + otherGangs[otherGang].power)
        if (winChance <= lowestWinChance) lowestWinChanceGang = otherGang;
        totalActiveGangs++, totalWinChance += winChance, lowestWinChance = Math.min(lowestWinChance, winChance);
    }
    // Turn on territory warfare only if we have a better than <territoryEngageThreshold>% chance of beating our random opponent
    const averageWinChance = totalWinChance / totalActiveGangs;
    const shouldEngage = !warfareFinished && territoryEngageThreshold <= averageWinChance;
    if (shouldEngage != myGangInfo.territoryWarfareEngaged) {
        log(ns, (warfareFinished ? 'SUCCESS' : 'INFO') + `: Toggling participation in territory warfare to ${shouldEngage}. Our power: ${formatNumberShort(myGangInfo.power)}. ` +
            (!warfareFinished ? `Lowest win chance is ${(100 * lowestWinChance).toFixed(2)}% with ${lowestWinChanceGang} (power ${formatNumberShort(otherGangs[lowestWinChanceGang]?.power)}). ` +
                `Average win chance ${(100 * averageWinChance).toFixed(2)}% across ${totalActiveGangs} active gangs.` :
                'We have destroyed all other gangs and earned 100% territory'), false, warfareFinished ? 'info' : 'success');
        await runCommand(ns, `ns.gang.setTerritoryWarfare(ns.args[0])`, null, [shouldEngage]);
    }
}

// Ram-dodging helper to get gang information for each item in a list
const getGangInfoDict = async (ns, elements, gangFunction) => await getDict(ns, elements, `gang.${gangFunction}`, `/Temp/gang-${gangFunction}.txt`);
const getDict = async (ns, elements, nsFunction, fileName) => await getNsDataThroughFile(ns, `Object.fromEntries(ns.args.map(o => [o, ns.${nsFunction}(o)]))`, fileName, elements);

/** Gang calcs shamefully stolen from https://github.com/danielyxie/bitburner/blob/dev/src/Gang/GangMember.ts **/
let getStatWeight = (task, memberInfo) =>
    (task.hackWeight / 100) * memberInfo["hack"] + // Need to quote to avoid paying RAM for ns.hack -_-
    (task.strWeight / 100) * memberInfo.str +
    (task.defWeight / 100) * memberInfo.def +
    (task.dexWeight / 100) * memberInfo.dex +
    (task.agiWeight / 100) * memberInfo.agi +
    (task.chaWeight / 100) * memberInfo.cha;

let getWantedPenalty = myGangInfo => myGangInfo.respect / (myGangInfo.respect + myGangInfo.wantedLevel);
let getTerritoryPenalty = myGangInfo => (0.2 * myGangInfo.territory + 0.8) * multGangSoftcap;

function computeRepGains(myGangInfo, currentTask, memberInfo) {
    const task = allTaskStats[currentTask];
    const statWeight = getStatWeight(task, memberInfo) - 4 * task.difficulty;
    if (task.baseRespect === 0 || statWeight <= 0) return 0;
    const territoryMult = Math.max(0.005, Math.pow(myGangInfo.territory * 100, task.territory.respect) / 100);
    if (isNaN(territoryMult) || territoryMult <= 0) return 0;
    const respectMult = getWantedPenalty(myGangInfo);
    const territoryPenalty = getTerritoryPenalty(myGangInfo);
    //console.log(`statWeight: ${statWeight} task.difficulty: ${task.difficulty} territoryMult: ${territoryMult} territoryPenalty: ${territoryPenalty} myGangInfo.respect ${myGangInfo.respect} myGangInfo.wanted ${myGangInfo.wanted} respectMult: ${respectMult}`);
    return Math.pow(11 * task.baseRespect * statWeight * territoryMult * respectMult, territoryPenalty);
}

function computeWantedGains(myGangInfo, currentTask, memberInfo) {
    const task = allTaskStats[currentTask];
    const statWeight = getStatWeight(task, memberInfo) - 3.5 * task.difficulty;
    if (task.baseWanted === 0 || statWeight <= 0) return 0;
    const territoryMult = Math.max(0.005, Math.pow(myGangInfo.territory * 100, task.territory.wanted) / 100);
    if (isNaN(territoryMult) || territoryMult <= 0) return 0;
    return (task.baseWanted < 0) ? 0.4 * task.baseWanted * statWeight * territoryMult :
        Math.min(100, (7 * task.baseWanted) / Math.pow(3 * statWeight * territoryMult, 0.8));
}

function calculateMoneyGains(myGangInfo, currentTask, memberInfo) {
    const task = allTaskStats[currentTask];
    const statWeight = getStatWeight(task, memberInfo) - 3.2 * task.difficulty;
    if (task.baseMoney === 0 || statWeight <= 0) return 0;
    const territoryMult = Math.max(0.005, Math.pow(myGangInfo.territory * 100, task.territory.money) / 100);
    if (isNaN(territoryMult) || territoryMult <= 0) return 0;
    const respectMult = getWantedPenalty(myGangInfo);
    const territoryPenalty = getTerritoryPenalty(myGangInfo);
    return Math.pow(5 * task.baseMoney * statWeight * territoryMult * respectMult, territoryPenalty);
}

/** Helps us not get caught in cycles by reducing gang member crime tiers in a random order */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}