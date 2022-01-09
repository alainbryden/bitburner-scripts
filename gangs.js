import { formatMoney, formatNumberShort, getNsDataThroughFile, getActiveSourceFiles, runCommand, tryGetBitNodeMultipliers } from './helpers.js'

// Global constants
const updateInterval = 200;
const maxSpendPerTickTransientEquipment = 0.01;
const maxSpendPerTickPermanentEquipment = 0.5; // Spend up to this percent of non-reserved cash on permanent member upgrades
const wantedPenaltyThreshold = 0.0001; // Don't let the wanted penalty get worse than this

// Territory-related variables
const gangsByPower = ["Speakers for the Dead", "The Dark Army", "The Syndicate", "Slum Snakes", /* Hack gangs don't scale as far */ "The Black Hand", /* "NiteSec" Been there, not fun. */]
const territoryEngageThreshold = 0.70; // Minimum average win chance (of gangs with territory) before we engage other clans
let territoryTickDetected = false;
let territoryTickTime = 20000; // Est. milliseconds until territory *ticks*. Can vary if processing offline time
let territoryNextTick = null; // The next time territory will tick
let isReadyForNextTerritoryTick = false;
let warfareFinished = false;
let lastTerritoryPower = 0;
let lastOtherGangInfo = null;

// Crime activity-related variables TODO all tasks list to evaluate
const crimes = ["Mug People", "Deal Drugs", "Strongarm Civilians", "Run a Con", "Armed Robbery", "Traffick Illegal Arms", "Threaten & Blackmail", "Human Trafficking", "Terrorism",
    "Ransomware", "Phishing", "Identity Theft", "DDoS Attacks", "Plant Virus", "Fraud & Counterfeiting", "Money Laundering", "Cyberterrorism"];
let pctTraining = 0.20;
let multGangSoftcap;
let allTaskNames;
let allTaskStats;
let assignedTasks = {}; // Each member will independently attempt to scale up the crime they perform until they are ineffective or we start generating wanted levels
let lastMemberReset = {}; // Tracks when each member last ascended

// Global state
let ownedSourceFiles;
let myGangFaction = "";
let isHackGang = false;
let requiredRep = 0;
let myGangMembers = [];
let equipments = [];
let importantStats = [];

let options;
const argsSchema = [
    ['training-percentage', 0.20], // Spend this percent of time training gang members versus doing crime
    ['no-training', false], // Don't train unless all other tasks generate no gains
    ['no-auto-ascending', false], // Don't ascend members
    ['ascend-multi-threshold', 2.3], // Ascend if any stat multi would increase by more than this amount
    ['min-training-ticks', 20], // Require this many ticks of training after ascending or recruiting
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    ownedSourceFiles = await getActiveSourceFiles(ns);
    const sf2Level = ownedSourceFiles[2] || 0;
    if (sf2Level == 0)
        return log(ns, "ERROR: You have no yet unlocked gangs. Script should not be run...");

    await initialize(ns);
    log(ns, "Starting main loop...");
    while (true) {
        try { await mainLoop(ns); }
        catch (err) { log(ns, `ERROR: Caught an unhandled error in the main loop: ${String(err)}`, 'error', true); }
        await ns.sleep(updateInterval);
    }
}

/** @param {NS} ns 
 * One-time setup actions. **/
async function initialize(ns) {
    ns.disableLog('ALL');
    options = ns.flags(argsSchema);
    pctTraining = options['no-training'] ? 0 : options['training-percentage'];

    let loggedWaiting = false;
    while (!(await getNsDataThroughFile(ns, 'ns.gang.inGang()', '/Temp/player-gang-joined.txt'))) {
        if (!loggedWaiting) {
            log(ns, `Waiting to be in a gang. Will create the highest faction gang as soon as it is available...`);
            loggedWaiting = true;
        }
        await runCommand(ns, `${JSON.stringify(gangsByPower)}.forEach(g => ns.gang.createGang(g))`, '/Temp/gang-createGang.js');
        await ns.sleep(1000); // Wait for our human to join a gang
    }
    log(ns, "Collecting gang information...");
    const myGangInfo = ns.gang.getGangInformation(); //await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()', '/Temp/gang-info.txt');
    myGangFaction = myGangInfo.faction;
    if (loggedWaiting) log(ns, `SUCCESS: Created gang ${myGangFaction}`, 'success', true);
    isHackGang = myGangInfo.isHacking;
    importantStats = isHackGang ? ["hack"] : ["str", "def", "dex", "agi"];
    lastTerritoryPower = myGangInfo.power;
    territoryNextTick = Date.now() + territoryTickTime; // Expect to miss be "caught unaware" by the first territory tick
    territoryTickDetected = isReadyForNextTerritoryTick = warfareFinished = false;
    lastOtherGangInfo = null;

    // If possible, determine how much rep we would need to get the most expensive unowned augmentation
    const sf4Level = ownedSourceFiles[4] || 0;
    requiredRep = -1;
    if (sf4Level == 0)
        log(ns, `INFO: SF4 required to get gang augmentation info. Defaulting to assuming ~2.5 million rep is desired.`);
    else {
        try {
            if (sf4Level < 3)
                log(ns, `WARNING: This script makes heavy use of singularity functions, which are quite expensive before you have SF4.3. ` +
                    `Unless you have a lot of free RAM for temporary scripts, you may get runtime errors.`);
            const augmentationNames = await getNsDataThroughFile(ns, `ns.getAugmentationsFromFaction('${myGangFaction}')`, '/Temp/gang-augs.txt');
            const ownedAugmentations = await getNsDataThroughFile(ns, `ns.getOwnedAugmentations(true)`, '/Temp/player-augs-purchased.txt');
            const dictAugRepReqs = await getDict(ns, augmentationNames, 'getAugmentationRepReq', '/Temp/aug-repreqs.txt');
            // Due to a bug, gangs appear to provide "The Red Pill" even when it's unavailable (outside of BN2), so ignore this one.
            requiredRep = augmentationNames.filter(aug => !ownedAugmentations.includes(aug) && aug != "The Red Pill").reduce((max, aug) => Math.max(max, dictAugRepReqs[aug]), -1);
            log(ns, `Highest augmentation reputation cost is ${formatNumberShort(requiredRep)}`);
        } catch {
            log(ns, `WARNING: Failed to get augmentation info despite having SF4.${sf4Level}. This may be due to you having insufficient RAM to launch the temporary scripts. ` +
                `Proceeding with the default assumption that ~2.5 million rep is desired.`);
        }
    }
    if (requiredRep == -1)
        requiredRep = 2.5e6

    // Initialize equipment information
    const equipmentNames = await getNsDataThroughFile(ns, 'ns.gang.getEquipmentNames()', '/Temp/gang-equipment-names.txt');
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
    allTaskNames = await getNsDataThroughFile(ns, 'ns.gang.getTaskNames()', '/Temp/gang-task-names.txt')
    allTaskStats = await getGangInfoDict(ns, allTaskNames, 'getTaskStats');
    multGangSoftcap = (await tryGetBitNodeMultipliers(ns))?.GangSoftcap || 1;
    myGangMembers = await getNsDataThroughFile(ns, 'ns.gang.getMemberNames()', '/Temp/gang-member-names.txt');
    const dictMembers = await getGangInfoDict(ns, myGangMembers, 'getMemberInformation');
    for (const member of Object.values(dictMembers)) // Initialize the current activity of each member
        assignedTasks[member.name] = (member.task && member.task !== "Unassigned") ? member.task : ("Train " + (isHackGang ? "Hacking" : "Combat"));
    while (myGangMembers.length < 3) await doRecruitMember(ns); // We should be able to recruit our first three members immediately (for free)
    await optimizeGangCrime(ns, myGangInfo);
}

/** @param {NS} ns 
 * Executed every `interval` **/
async function mainLoop(ns) {
    // Update gang information (specifically monitoring gang power to see when territory ticks)
    const myGangInfo = ns.gang.getGangInformation(); //await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()', '/Temp/gang-info.txt');
    // If territory is about to tick, quick - set everyone to do "territory warfare"!
    if (!isReadyForNextTerritoryTick && territoryTickDetected && (Date.now() + updateInterval >= territoryNextTick)) {
        isReadyForNextTerritoryTick = true;
        await updateMemberActivities(ns, null, "Territory Warfare");
    } else if (!territoryTickDetected) { // Detect the first territory tick by watching for other gang's territory power to update.
        const otherGangInfo = await getNsDataThroughFile(ns, 'ns.gang.getOtherGangInformation()', '/Temp/gang-other-gang-info.txt'); // Returns dict of { [gangName]: { "power": Number, "territory": Number } }
        if (lastOtherGangInfo != null && Object.keys(otherGangInfo).some(g => otherGangInfo[g].power != lastOtherGangInfo[g].power)) {
            territoryNextTick = Date.now() - updateInterval;
            territoryTickDetected = true;
        }
        lastOtherGangInfo = otherGangInfo;
    }
    // Detect if territory power has been updated in the last tick (or if we have no power, assume it has ticked and we just haven't generated power yet)
    if ((isReadyForNextTerritoryTick && myGangInfo.power != lastTerritoryPower) || (Date.now() > territoryNextTick + 5 * updateInterval)) {
        await onTerritoryTick(ns, myGangInfo); //Do most things only once per territory tick
        lastTerritoryPower = myGangInfo.power;
    }
}

/** @param {NS} ns 
 * Do some things only once per territory tick **/
async function onTerritoryTick(ns, myGangInfo) {
    territoryNextTick = Date.now() - updateInterval + territoryTickTime; // Reset the time the next tick will occur
    if (lastTerritoryPower != myGangInfo.power)
        log(ns, `Territory power updated from ${formatNumberShort(lastTerritoryPower)} to ${formatNumberShort(myGangInfo.power)}.`)
    if (!isReadyForNextTerritoryTick) log(ns, `WARNING: Territory tick happend before we were ready!`, 'warning');
    if (!warfareFinished) // Once we hit 100% territory, there's no need to keep swapping members to warfare
        isReadyForNextTerritoryTick = false;

    // Update gang members in case someone died in a clash
    myGangMembers = await getNsDataThroughFile(ns, 'ns.gang.getMemberNames()', '/Temp/gang-member-names.txt');
    const nextMemberCost = Math.pow(5, myGangMembers.length - (3 /*numFreeMembers*/ - 1));
    if (myGangMembers.length < 12 /* Game Max */ && myGangInfo.respect * 0.75 > nextMemberCost) // Don't spend more than 75% of our respect on new members.
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
async function updateMemberActivities(ns, dictMemberInfo = null, forceTask = null) {
    const dictMembers = dictMemberInfo || (await getGangInfoDict(ns, myGangMembers, 'getMemberInformation'));
    const workOrders = [];
    for (const member of Object.values(dictMembers)) { // Set the desired activity of each member
        let task = forceTask ? forceTask : assignedTasks[member.name];
        if (member.task != task) workOrders.push({ name: member.name, task }); // Only bother with the API call if this isn't their current task
    }
    if (workOrders.length == 0) return;
    // Set the activities in bulk using a ram-dodging script
    if (await getNsDataThroughFile(ns, `${JSON.stringify(workOrders)}.reduce((success, m) => success && ns.gang.setMemberTask(m.name, m.task), true)`, '/Temp/gang-set-member-tasks.txt'))
        log(ns, `INFO: Assigned ${workOrders.length} gang member tasks! (${workOrders.map(o => o.task).filter((v, i, self) => self.indexOf(v) === i).join(", ")})`)
    else
        log(ns, `ERROR: Failed to set member task of one or more members: ` + JSON.stringify(workOrders), 'error');
}

/** @param {NS} ns 
 * Logic to assign tasks that maximize rep gain rate without wanted gain getting out of control **/
async function optimizeGangCrime(ns, myGangInfo) {
    const dictMembers = await getGangInfoDict(ns, myGangMembers, 'getMemberInformation');
    const factionRep = await getNsDataThroughFile(ns, `ns.getFactionRep('${myGangFaction}')`, `/Temp/gang-faction-rep.txt`);
    // Tolerate our wanted level increasing, as long as reputation increases several orders of magnitude faster and we do not currently have a penalty more than -0.01%
    let currentWantedPenalty = getWantedPenalty(myGangInfo) - 1;
    // Note, until we have ~200 respect, the best way to recover from wanted penalty is to focus on gaining respect, rather than doing vigilante work.
    let wantedGainTolerance = currentWantedPenalty < -1.1 * wantedPenaltyThreshold && myGangInfo.wantedLevel >= (1.1 + myGangInfo.respect / 1000) &&
        myGangInfo.respect > 200 ? -0.01 * myGangInfo.wantedLevel /* Recover from wanted penalty */ :
        currentWantedPenalty < -0.9 * wantedPenaltyThreshold && myGangInfo.wantedLevel >= (1.1 + myGangInfo.respect / 10000) ? 0 /* Sustain */ :
            Math.max(myGangInfo.respectGainRate / 1000, myGangInfo.wantedLevel / 10) /* Allow wanted to increase at a manageable rate */;
    const playerData = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
    const optStat = factionRep > requiredRep ? "money" : (playerData.money > 1E11 || myGangInfo.respect) < 9000 ? "respect" : "both money and respect"; // Change priority based on achieved rep/money
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
    for (let shuffle = 0; shuffle < 1000; shuffle++) { // We can discover more optimal results by greedy-optimizing gang members in a different order. Try a few.
        let proposedTasks = {}, totalWanted = 0, totalGain = 0;
        shuffleArray(myGangMembers.slice()).forEach((member, index) => {
            const taskRates = memberTaskRates[member];
            // "Greedy" optimize one member at a time, but as we near the end of the list, we can no longer expect future members to make for wanted increases
            const sustainableTasks = (index < myGangMembers.length - 2) ? taskRates : taskRates.filter(c => (totalWanted + c.wanted) <= wantedGainTolerance);
            // Find the crime with the best gain (If we can't generate value for any tasks, then we should only be training)
            const bestTask = taskRates[0][optStat] == 0 || (Date.now() - (lastMemberReset[member] || 0) < options['min-training-ticks'] * territoryTickTime) ?
                taskRates.find(t => t.name === ("Train " + (isHackGang ? "Hacking" : "Combat"))) :
                (totalWanted > wantedGainTolerance || sustainableTasks.length == 0) ? taskRates.find(t => t.name === "Vigilante Justice") : sustainableTasks[0];
            [proposedTasks[member], totalWanted, totalGain] = [bestTask, totalWanted + bestTask.wanted, totalGain + bestTask[optStat]];
        });
        // Following the above attempted optimization, if we're above our wanted gain threshold, downgrade the task of the greatest generators of wanted until within our limit
        let infiniteLoop = 9999;
        while (totalWanted > wantedGainTolerance && Object.values(proposedTasks).some(t => t.name !== "Vigilante Justice")) {
            const mostWanted = Object.keys(proposedTasks).reduce((t, c) => proposedTasks[c].name !== "Vigilante Justice" && (t == null || proposedTasks[t].wanted < proposedTasks[c].wanted) ? c : t, null);
            const nextBestTask = memberTaskRates[mostWanted].filter(c => c.wanted < proposedTasks[mostWanted].wanted)[0] ?? memberTaskRates[mostWanted].find(t => t.name === "Vigilante Justice");
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
                `but they are Rep:${formatNumberShort(myGangInfo.respectGainRate)} Wanted: ${myGangInfo.wantedLevelGainRate.toPrecision(3)} Money: ${formatMoney(myGangInfo.moneyGainRate)}`, 'warning');
    } else
        log(ns, `INFO: Determined all gang member assignments are already optimal for ${optStat} with wanted gain tolerance ${wantedGainTolerance.toPrecision(2)} (${elapsed} ms).`);
    // Fail-safe: If we somehow over-shot and are generating wanted levels, start randomly assigning members to vigilante to fix it
    if (myGangInfo.wantedLevelGainRate > wantedGainTolerance) await fixWantedGainRate(ns, myGangInfo, wantedGainTolerance);
}

/** @param {NS} ns 
 * Logic to reduce crime tiers when we're generating a wanted level **/
async function fixWantedGainRate(ns, myGangInfo, wantedGainTolerance = 0) {
    // TODO: steal actual wanted level calcs and strategically pick the member(s) who can bridge the gap while losing the least rep/sec
    let lastWantedLevelGainRate = myGangInfo.wantedLevelGainRate;
    log(ns, `WARNING: Generating wanted levels (${lastWantedLevelGainRate.toPrecision(3)}/sec > ${wantedGainTolerance.toPrecision(3)}/sec), temporarily assigning random members to Vigilante Justice...`, 'warning');
    for (const member of shuffleArray(myGangMembers.slice())) {
        if (!crimes.includes(assignedTasks[member])) continue; // This member isn't doing crime, so they aren't contributing to wanted
        assignedTasks[member] = "Vigilante Justice";
        await updateMemberActivities(ns);
        const wantedLevelGainRate = (myGangInfo = await waitForGameUpdate(ns, myGangInfo)).wantedLevelGainRate;
        if (wantedLevelGainRate < wantedGainTolerance) return;
        if (lastWantedLevelGainRate == wantedLevelGainRate)
            log(ns, `Warning: Attempt to rollback crime of ${member} to ${assignedTasks[member]} resulted in no change in wanted level gain rate ` +
                `(${lastWantedLevelGainRate.toPrecision(3)})`, 'warning');
    }
}

/** @param {NS} ns 
 * Recruit new members if available **/
async function doRecruitMember(ns) {
    let i = 0, newMemberName;
    do { newMemberName = `Thug ${++i}`; } while (myGangMembers.includes(newMemberName) || myGangMembers.includes(newMemberName + " Understudy"));
    if (i < myGangMembers.length) newMemberName += " Understudy"; // Pay our respects to the deceased
    if (await getNsDataThroughFile(ns, `ns.gang.canRecruitMember() && ns.gang.recruitMember('${newMemberName}')`, '/Temp/gang-recruit-member.txt')) {
        myGangMembers.push(newMemberName);
        assignedTasks[newMemberName] = "Train " + (isHackGang ? "Hacking" : "Combat");
        lastMemberReset[newMemberName] = Date.now();
        log(ns, `SUCCESS: Recruited a new gang member "${newMemberName}"!`, 'success');
    } else {
        log(ns, `ERROR: Failed to recruit a new gang member "${newMemberName}"!`, 'error');
    }
}

/** @param {NS} ns 
 * Check if any members are deemed worth ascending to increase a stat multiplier **/
async function tryAscendMembers(ns) {
    const dictAscensionResults = await getGangInfoDict(ns, myGangMembers, 'getAscensionResult');
    for (const member of myGangMembers) {
        const ascResult = dictAscensionResults[member];
        // Hack: Until we know what threshold is best, give each member a different threshold and see how they all do!
        const ascMultiThreshold = options['ascend-multi-threshold'] /* 2.3 */ - Number(member.split(" ")[1]) * 0.1; /* 1.1 for member 12 */
        if (!ascResult || !importantStats.some(stat => ascResult[stat] >= ascMultiThreshold))
            continue;
        if (undefined !== (await getNsDataThroughFile(ns, `ns.gang.ascendMember('${member}')`, '/Temp/gang-ascend-member.txt'))) {
            log(ns, `SUCCESS: Ascended member ${member} to increase multis by ${importantStats.map(s => `${s} -> ${ascResult[s].toFixed(2)}x`).join(", ")}`, 'success');
            lastMemberReset[member] = Date.now();
        }
        else
            log(ns, `ERROR: Attempt to ascended member ${member} failed. Go investigate!`, 'error');
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
    const playerData = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
    const homeMoney = playerData.money - (Number.parseFloat(ns.read("reserve.txt")) || 0);
    let budget = maxSpendPerTickTransientEquipment * homeMoney;
    let augBudget = maxSpendPerTickPermanentEquipment * homeMoney;
    // Hack: Budget is cut by 1/100 if we don't yet own the Stockmarket 4S API (main source of income early BN)
    if (!playerData.has4SDataTixApi) budget /= 100, augBudget /= 100;
    if (budget <= 0) return;
    // Find out what outstanding equipment can be bought within our budget
    for (const equip of equipments) {
        for (const member of Object.values(dictMembers)) { // Get this equip for each member before considering the next most expensive equip
            // Bit of a hack: Inflate the "cost" of equipment that doesn't contribute to our main stats so that we don't purchase them unless we have ample cash
            let percievedCost = equip.cost * (Object.keys(equip.stats).some(stat => importantStats.some(i => stat.includes(i))) ? 1 : 50);
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
    const orderSummary = purchaseOrder.map(o => `${o.member} ${o.type}: "${o.equipmentName}"`).join(", ");
    if (await getNsDataThroughFile(ns, `${JSON.stringify(purchaseOrder)}.reduce((success, o) => success && ns.gang.purchaseEquipment(o.member, o.equipmentName), true)`, '/Temp/gang-upgrade-members.txt'))
        log(ns, `SUCCESS: Purchased ${purchaseOrder.length} gang member upgrades for ${formatMoney(purchaseOrder.reduce((t, e) => t + e.cost, 0))}. (${orderSummary})`, 'success')
    else
        log(ns, `ERROR: Failed to purchase one or more gang member upgrades. (${orderSummary})`, 'error');
}

/** @param {NS} ns 
 * Helper to wait for the game to update stats (typically 2 seconds per cycle) **/
async function waitForGameUpdate(ns, oldGangInfo) {
    if (!myGangMembers.some(member => !assignedTasks[member].includes("Train")))
        return oldGangInfo; // Ganginfo will never change if all members are training, so don't wait for an update
    const maxWaitTime = 2500;
    const waitInterval = 100;
    const start = Date.now()
    while (Date.now() < start + maxWaitTime) {
        var latestGangInfo = ns.gang.getGangInformation();
        if (JSON.stringify(latestGangInfo) != JSON.stringify(oldGangInfo))
            return latestGangInfo;
        await ns.sleep(Math.min(waitInterval, start + maxWaitTime - Date.now()));
    }
    log(ns, `WARNING: Max wait time ${maxWaitTime} exceeded while waiting for old gang info to update.\n${JSON.stringify(oldGangInfo)}\n===\n${JSON.stringify(latestGangInfo)}`, 'warning');
    territoryTickDetected = false;
    return latestGangInfo;
}

/** @param {NS} ns 
 * Checks whether we should be engaging in warfare based on our gang power and that of other gangs. **/
async function enableOrDisableWarfare(ns, myGangInfo) {
    warfareFinished = Math.round(myGangInfo.territory * 2 ** 20) / 2 ** 20 /* Handle API imprecision */ >= 1;
    if (warfareFinished && !myGangInfo.territoryWarfareEngaged) return; // No need to engage once we hit 100%
    const otherGangs = await getNsDataThroughFile(ns, 'ns.gang.getOtherGangInformation()', '/Temp/gang-other-gang-info.txt'); // Returns dict of { [gangName]: { "power": Number, "territory": Number } }
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
                'We have destroyed all other gangs and earned 100% territory'), warfareFinished ? 'info' : 'success');
        await runCommand(ns, `ns.gang.setTerritoryWarfare(${shouldEngage})`, '/Temp/gang-set-warfare.js');
    }
}

// Ram-dodging helper to get gang information for each item in a list
const getGangInfoDict = async (ns, elements, gangFunction) => await getDict(ns, elements, `gang.${gangFunction}`, `/Temp/gang-${gangFunction}.txt`);
const getDict = async (ns, elements, nsFunction, fileName) => await getNsDataThroughFile(ns, `Object.fromEntries(${JSON.stringify(elements)}.map(e => [e, ns.${nsFunction}(e)]))`, fileName);

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

/** @param {NS} ns **/
function log(ns, message, toastStyle, terminal = undefined) {
    ns.print(message);
    if (terminal === true || (terminal === undefined && toastStyle === 'error')) ns.tprint(message);
    if (toastStyle) ns.toast(message, toastStyle);
}

/** Helps us not get caught in cycles by reducing gang member crime tiers in a random order */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}