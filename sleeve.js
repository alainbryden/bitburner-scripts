import { getNsDataThroughFile, runCommand, formatMoney, formatDuration, disableLogs, log } from './helpers.js'

const interval = 5000; // Uodate (tick) this often
const minTaskWorkTime = 29000; // Sleeves assigned a new task should stick to it for at least this many milliseconds
const tempFile = '/Temp/sleeve-set-task.txt';
const trainingReserveFile = '/Temp/sleeves-training-reserve.txt';
const works = ['security', 'field', 'hacking']; // When doing faction work, we prioritize physical work since sleeves tend towards having those stats be highest
const trainStats = ['strength', 'defense', 'dexterity', 'agility'];

let cachedCrimeStats, workByFaction; // Cache of crime statistics and which factions support which work
let task, lastStatusUpdateTime, lastPurchaseTime, lastPurchaseStatusUpdate, availableAugs, cacheExpiry, lastReassignTime; // State by sleeve
let playerInfo, numSleeves;
let options;

const argsSchema = [
    ['min-shock-recovery', 97], // Minimum shock recovery before attempting to train or do crime (Set to 100 to disable, 0 to recover fully)
    ['shock-recovery', 0.05], // Set to a number between 0 and 1 to devote that ratio of time to periodic shock recovery (until shock is at 0)
    ['crime', null], // If specified, sleeves will perform only this crime regardless of stats
    ['homicide-chance-threshold', 0.45], // Sleeves will automatically start homicide once their chance of success exceeds this ratio
    ['aug-budget', 0.1], // Spend up to this much of current cash on augs per tick (Default is high, because these are permanent for the rest of the BN)
    ['buy-cooldown', 60 * 1000], // Must wait this may milliseconds before buying more augs for a sleeve
    ['min-aug-batch', 20], // Must be able to afford at least this many augs before we pull the trigger (or fewer if buying all remaining augs)
    ['reserve', null], // Reserve this much cash before determining spending budgets (defaults to contents of reserve.txt if not specified)
    ['disable-follow-player', false], // Set to true to disable having Sleeve 0 work for the same faction/company as the player to boost re
    ['disable-training', false], // Set to true to disable having sleeves workout at the gym (costs money)
    ['train-to-strength', 105], // Sleeves will go to the gym until they reach this much Str
    ['train-to-defense', 105], // Sleeves will go to the gym until they reach this much Def
    ['train-to-dexterity', 70], // Sleeves will go to the gym until they reach this much Dex
    ['train-to-agility', 70], // Sleeves will go to the gym until they reach this much Agi
    ['training-reserve', null], // Defaults to global reserve.txt. Can be set to a negative number to allow debt. Sleeves will not train if money is below this amount.
    ['disable-spending-hashes-for-gym-upgrades', false], // Set to true to disable spending hashes on gym upgrades when training up sleeves.
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    options = ns.flags(argsSchema);
    disableLogs(ns, ['getServerMoneyAvailable']);
    // Ensure the global state is reset (e.g. after entering a new bitnode)
    task = [], lastStatusUpdateTime = [], lastPurchaseTime = [], lastPurchaseStatusUpdate = [], availableAugs = [], cacheExpiry = [], lastReassignTime = [];
    workByFaction = {}, cachedCrimeStats = {};

    // Collect info that won't change or that we can track ourselves going forward
    try { numSleeves = await getNsDataThroughFile(ns, `ns.sleeve.getNumSleeves()`, '/Temp/sleeve-count.txt'); }
    catch { return ns.print("User does not appear to have access to sleeves. Exiting..."); }
    for (let i = 0; i < numSleeves; i++)
        availableAugs[i] = null;

    while (true) {
        try { await mainLoop(ns); }
        catch (error) {
            log(ns, `WARNING: An error was caught (and suppressed) in the main loop: ${error?.toString() || String(error)}`, false, 'warning');
        }
        await ns.asleep(interval);
    }
}

/** @param {NS} ns 
 * Purchases augmentations for sleeves */
async function manageSleeveAugs(ns, i, budget) {
    // Retrieve and cache the set of available sleeve augs (cached temporarily, but not forever, in case rules around this change)
    if (availableAugs[i] == null || Date.now() > cacheExpiry[i]) {
        cacheExpiry[i] = Date.now() + 60000;
        availableAugs[i] = (await getNsDataThroughFile(ns, `ns.sleeve.getSleevePurchasableAugs(${i})`, '/Temp/sleeve-augs.txt')).sort((a, b) => a.cost - b.cost); // list of { name, cost }
    }
    if (availableAugs[i].length == 0) return 0;

    const cooldownLeft = Math.max(0, options['buy-cooldown'] - (Date.now() - (lastPurchaseTime[i] || 0)));
    const [batchCount, batchCost] = availableAugs[i].reduce(([n, c], aug) => c + aug.cost <= budget ? [n + 1, c + aug.cost] : [n, c], [0, 0]);
    const purchaseUpdate = `sleeve ${i} can afford ${batchCount.toFixed(0).padStart(2)}/${availableAugs[i].length.toFixed(0).padEnd(2)} remaining augs (cost ${formatMoney(batchCost)} of ` +
        `${formatMoney(availableAugs[i].reduce((t, aug) => t + aug.cost, 0))}).`;
    if (lastPurchaseStatusUpdate[i] != purchaseUpdate)
        log(ns, `INFO: With budget ${formatMoney(budget)}, ${(lastPurchaseStatusUpdate[i] = purchaseUpdate)} (Min batch size: ${options['min-aug-batch']}, Cooldown: ${formatDuration(cooldownLeft)})`);
    if (cooldownLeft == 0 && batchCount > 0 && ((batchCount >= availableAugs[i].length - 1) || batchCount >= options['min-aug-batch'])) { // Don't require the last aug it's so much more expensive
        let strAction = `Purchase ${batchCount} augmentations for sleeve ${i} at total cost of ${formatMoney(batchCost)}`;
        let toPurchase = availableAugs[i].splice(0, batchCount);
        if (await getNsDataThroughFile(ns, JSON.stringify(toPurchase.map(a => a.name)) +
            `.reduce((s, aug) => s && ns.sleeve.purchaseSleeveAug(${i}, aug), true)`, '/Temp/sleeve-purchase.txt'))
            log(ns, `SUCCESS: ${strAction}`, true, 'success');
        else log(ns, `ERROR: Failed to ${strAction}`, true, 'error');
        lastPurchaseTime[i] = Date.now();
        return batchCost; // Even if we think we failed, return the predicted cost so if the purchase did go through, we don't end up over-budget
    }
    return 0;
}

/** @param {NS} ns 
 * Main loop that gathers data, checks on all sleeves, and manages them. */
async function mainLoop(ns) {
    playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt')
    let globalReserve = Number(ns.read("reserve.txt") || 0);
    let budget = (playerInfo.money - (options['reserve'] || globalReserve)) * options['aug-budget'];
    let canTrain = !options['disable-training'] && playerInfo.money > (options['training-reserve'] ||
        (promptedForTrainingBudget ? ns.read(trainingReserveFile) : undefined) || globalReserve);
    // If any sleeve is training at the gym, see if we can purchase a gym upgrade to help them
    if (canTrain && task.some(t => t.startsWith("train")) && !options['disable-spending-hashes-for-gym-upgrades'])
        if (await getNsDataThroughFile(ns, 'ns.hacknet.spendHashes("Improve Gym Training")', '/Temp/spend-hashes-on-gym.txt'))
            log(ns, `SUCCESS: Bought "Improve Gym Training" to speed up Sleeve training.`, false, 'success');

    // Update all sleeve stats and loop over all sleeves to do some individual checks and task assignments
    let sleveStats = await getNsDataThroughFile(ns, `[...Array(${numSleeves}).keys()].map(i => ns.sleeve.getSleeveStats(i))`, '/Temp/sleeve-stats.txt');
    for (let i = 0; i < numSleeves; i++) {
        let sleeve = sleveStats[i];

        // MANAGE SLEEVE AUGMENTATIONS
        if (sleeve.shock == 0) // No augs are available augs until shock is 0
            budget -= await manageSleeveAugs(ns, i, budget);

        // ASSIGN SLEEVE TASK
        // If shock/sync just completed, and they were on that task, allow this sleeve to immediately be reassigned
        if (sleeve.shock == 0 && task[i] == "recover from shock" || sleeve.sync == 100 && task[i] == "synchronize")
            lastReassignTime[i] = 0;
        // Otherwise, don't change tasks if we've changed tasks recently (avoids e.g. disrupting long crimes too frequently)
        if (Date.now() - (lastReassignTime[i] || 0) < minTaskWorkTime) continue;

        // Decide what we think the sleeve should be doing for the next little while
        let [designatedTask, command, statusUpdate] = await pickSleeveTask(ns, i, sleeve, canTrain);

        // Start the clock, this sleeve should stick to this task for minTaskWorkTime
        lastReassignTime[i] = Date.now();
        // Set the sleeve's new task if it's not the same as what they're already doing.
        if (task[i] != designatedTask)
            await setSleeveTask(ns, i, designatedTask, command);

        // For certain tasks, log a periodic status update.
        if (statusUpdate && Date.now() - (lastStatusUpdateTime[i] ?? 0) > minTaskWorkTime) {
            log(ns, `INFO: Sleeve ${i} is ${statusUpdate} `);
            lastStatusUpdateTime[i] = Date.now();
        }
    }
}


/** @param {NS} ns 
 * Picks the best task for a sleeve, and returns the information to assign and give status updates for that task. */
async function pickSleeveTask(ns, i, sleeve, canTrain) {
    // Must synchronize first iif you haven't maxed memory on every sleeve.
    if (sleeve.sync < 100)
        return ["synchronize", `ns.sleeve.setToSynchronize(${i})`, `syncing... ${sleeve.sync.toFixed(2)}%`];
    // Opt to do shock recovery if above the --min-shock-recovery threshold, or if above 0 shock, with a probability of --shock-recovery
    if (sleeve.shock > options['min-shock-recovery'] || sleeve.shock > 0 && options['shock-recovery'] > 0 && Math.random() < options['shock-recovery'])
        return ["recover from shock", `ns.sleeve.setToShockRecovery(${i})`, `recovering from shock... ${sleeve.shock.toFixed(2)}%`];

    // Train if our sleeve's physical stats aren't where we want them
    if (canTrain) {
        let untrainedStats = trainStats.filter(stat => sleeve[stat] < options[`train-to-${stat}`]);
        if (untrainedStats.length > 0) {
            if (playerInfo.money < 1E6 && !promptedForTrainingBudget)
                await promptForTrainingBudget(ns); // If we've never checked, see if we can train into debt.
            var trainStat = untrainedStats.reduce((min, s) => sleeve[s] < sleeve[min] ? s : min, untrainedStats[0]);
            return [`train ${trainStat}`, `ns.sleeve.setToGymWorkout(${i}, 'Powerhouse Gym', '${trainStat}')`,
            /*   */ `training ${trainStat}... ${sleeve[trainStat]}/${(options[`train-to-${trainStat}`])}`];
        }
    }
    // If player is currently working for faction or company rep, sleeves 0 can help him out (Note: Only one sleeve can work for a faction)
    if (i == 0 && !options['disable-follow-player'] && playerInfo.isWorking && playerInfo.workType == "Working for Faction") {
        // TODO: We should be able to borrow logic from work-for-factions.js to have more sleeves work for useful factions / companies
        // We'll cycle through work types until we find one that is supported. TODO: Auto-determine the most productive faction work to do.
        const faction = playerInfo.currentWorkFactionName;
        const work = works[workByFaction[faction] || 0];
        return [`work for faction '${faction}' (${work})`, `ns.sleeve.setToFactionWork(${i}, '${faction}', '${work}')`,
        /*   */ `helping earn rep with faction ${faction} by doing ${work}.`];
    }
    if (i == 0 && !options['disable-follow-player'] && playerInfo.isWorking && playerInfo.workType == "Working for Company") { // If player is currently working for a company rep, sleeves 0 shall help him out (only one sleeve can work for a company)
        return [`work for company '${playerInfo.companyName}'`, `ns.sleeve.setToCompanyWork(${i}, '${playerInfo.companyName}')`,
        /*   */ `helping earn rep with company ${playerInfo.companyName}.`];
    }
    // Finally, do crime for Karma. Homicide has the rate gain, if we can manage a decent success rate.
    // TODO: This is less useful after gangs are unlocked, can we think of better things to do afterwards?
    var crime = options.crime || (await calculateCrimeChance(ns, sleeve, "homicide")) >= options['homicide-chance-threshold'] ? 'homicide' : 'mug';
    return [`commit ${crime} `, `ns.sleeve.setToCommitCrime(${i}, '${crime}')`,
    /*   */ `committing ${crime} with chance ${((await calculateCrimeChance(ns, sleeve, crime)) * 100).toFixed(2)}% ` +
    /*   */ (options.crime || crime == "homicide" ? '' : // If auto-criming, user may be curious how close we are to switching to homicide 
    /*   */     ` (Note: Homicide chance would be ${((await calculateCrimeChance(ns, sleeve, "homicide")) * 100).toFixed(2)}% `)];
}

/** @param {NS} ns 
 * Sets a sleeve to its designated task, with some extra error handling logic for working for factions. */
async function setSleeveTask(ns, i, designatedTask, command) {
    let strAction = `Set sleeve ${i} to ${designatedTask} `;
    if (await getNsDataThroughFile(ns, command, tempFile)) {
        task[i] = designatedTask;
        log(ns, `SUCCESS: ${strAction} `);
        return true;
    }
    // If assigning the task failed...
    lastReassignTime[i] = 0;
    // If working for a faction, it's possible he current work isn't supported, so try the next one.
    if (designatedTask.startsWith('work for faction')) {
        log(ns, `WARN: Failed to ${strAction} - work type may not be supported.`, false, 'warning');
        workByFaction[playerInfo.currentWorkFactionName] = (workByFaction[playerInfo.currentWorkFactionName] || 0) + 1;
    } else
        log(ns, `ERROR: Failed to ${strAction} `, true, 'error');
    return false;
}

let promptedForTrainingBudget = false;
/** @param {NS} ns 
 * For when we are at risk of going into debt while training with sleeves.
 * Contains some fancy logic to spawn an external script that will prompt the user and wait for an answer. */
async function promptForTrainingBudget(ns) {
    if (promptedForTrainingBudget) return;
    promptedForTrainingBudget = true;
    await ns.write(trainingReserveFile, '', "w");
    if (options['training-reserve'] === null && !options['disable-training'])
        await runCommand(ns, `let ans = await ns.prompt("Do you want to let sleeves put you in debt while they train?"); \n` +
            `await ns.write("${trainingReserveFile}", ans ? '-1E100' : '0', "w")`, '/Temp/sleeves-training-reserve-prompt.js');
}

/** @param {NS} ns 
 * Calculate the chance a sleeve has of committing homicide successfully. */
async function calculateCrimeChance(ns, sleeve, crimeName) {
    const crimeStats = cachedCrimeStats[crimeName] ?? // If not in the cache, retrieve this crime's stats
        (cachedCrimeStats[crimeName] = await getNsDataThroughFile(ns, `ns.getCrimeStats("${crimeName}")`, '/Temp/get-crime-stats.txt'));
    let chance =
        crimeStats.hacking_success_weight * sleeve['hacking'] +
        crimeStats.strength_success_weight * sleeve.strength +
        crimeStats.defense_success_weight * sleeve.defense +
        crimeStats.dexterity_success_weight * sleeve.dexterity +
        crimeStats.agility_success_weight * sleeve.agility +
        crimeStats.charisma_success_weight * sleeve.charisma;
    chance /= 975;
    chance /= crimeStats.difficulty;
    return Math.min(chance, 1);
}