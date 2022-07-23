import { log, getConfiguration, instanceCount, disableLogs, getActiveSourceFiles, getNsDataThroughFile, runCommand, formatMoney, formatDuration } from './helpers.js'

const interval = 5000; // Uodate (tick) this often
const minTaskWorkTime = 29000; // Sleeves assigned a new task should stick to it for at least this many milliseconds
const trainingReserveFile = '/Temp/sleeves-training-reserve.txt';
const works = ['security', 'field', 'hacking']; // When doing faction work, we prioritize physical work since sleeves tend towards having those stats be highest
const trainStats = ['strength', 'defense', 'dexterity', 'agility'];

let cachedCrimeStats, workByFaction; // Cache of crime statistics and which factions support which work
let task, lastStatusUpdateTime, lastPurchaseTime, lastPurchaseStatusUpdate, availableAugs, cacheExpiry, lastReassignTime; // State by sleeve
let numSleeves, ownedSourceFiles, playerInGang, bladeburnerCityChaos, bladeburnerTaskFailed;
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
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions || await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    options = runOptions; // We don't set the global "options" until we're sure this is the only running instance
    disableLogs(ns, ['getServerMoneyAvailable']);
    // Ensure the global state is reset (e.g. after entering a new bitnode)
    task = [], lastStatusUpdateTime = [], lastPurchaseTime = [], lastPurchaseStatusUpdate = [], availableAugs = [],
        cacheExpiry = [], lastReassignTime = [], bladeburnerTaskFailed = [];
    workByFaction = {}, cachedCrimeStats = {};
    // Ensure we have access to sleeves
    ownedSourceFiles = await getActiveSourceFiles(ns);
    if (!(10 in ownedSourceFiles))
        return ns.tprint("WARNING: You cannot run sleeve.js until you do BN10.");
    // Start the main loop
    while (true) {
        try { await mainLoop(ns); }
        catch (err) {
            log(ns, `WARNING: sleeve.js Caught (and suppressed) an unexpected error in the main loop:\n` +
                (err?.stack || '') + (typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
        }
        await ns.sleep(interval);
    }
}

/** @param {NS} ns 
 * Purchases augmentations for sleeves */
async function manageSleeveAugs(ns, i, budget) {
    // Retrieve and cache the set of available sleeve augs (cached temporarily, but not forever, in case rules around this change)
    if (availableAugs[i] == null || Date.now() > cacheExpiry[i]) {
        cacheExpiry[i] = Date.now() + 60000;
        availableAugs[i] = (await getNsDataThroughFile(ns, `ns.sleeve.getSleevePurchasableAugs(ns.args[0])`,  // list of { name, cost }
            '/Temp/sleeve-augs.txt', [i])).sort((a, b) => a.cost - b.cost);
    }
    if (availableAugs[i].length == 0) return 0;

    const cooldownLeft = Math.max(0, options['buy-cooldown'] - (Date.now() - (lastPurchaseTime[i] || 0)));
    const [batchCount, batchCost] = availableAugs[i].reduce(([n, c], aug) => c + aug.cost <= budget ? [n + 1, c + aug.cost] : [n, c], [0, 0]);
    const purchaseUpdate = `sleeve ${i} can afford ${batchCount.toFixed(0).padStart(2)}/${availableAugs[i].length.toFixed(0).padEnd(2)} remaining augs ` +
        `(cost ${formatMoney(batchCost)} of ${formatMoney(availableAugs[i].reduce((t, aug) => t + aug.cost, 0))}).`;
    if (lastPurchaseStatusUpdate[i] != purchaseUpdate)
        log(ns, `INFO: With budget ${formatMoney(budget)}, ${(lastPurchaseStatusUpdate[i] = purchaseUpdate)} ` +
            `(Min batch size: ${options['min-aug-batch']}, Cooldown: ${formatDuration(cooldownLeft)})`);
    if (cooldownLeft == 0 && batchCount > 0 && ((batchCount >= availableAugs[i].length - 1) || batchCount >= options['min-aug-batch'])) { // Don't require the last aug it's so much more expensive
        let strAction = `Purchase ${batchCount} augmentations for sleeve ${i} at total cost of ${formatMoney(batchCost)}`;
        let toPurchase = availableAugs[i].splice(0, batchCount);
        if (await getNsDataThroughFile(ns, `ns.args.slice(1).reduce((s, aug) => s && ns.sleeve.purchaseSleeveAug(ns.args[0], aug), true)`,
            '/Temp/sleeve-purchase.txt', [i, ...toPurchase.map(a => a.name)])) {
            log(ns, `SUCCESS: ${strAction}`, true, 'success');
        } else log(ns, `ERROR: Failed to ${strAction}`, true, 'error');
        lastPurchaseTime[i] = Date.now();
        return batchCost; // Even if we think we failed, return the predicted cost so if the purchase did go through, we don't end up over-budget
    }
    return 0;
}

/** @param {NS} ns 
 * Main loop that gathers data, checks on all sleeves, and manages them. */
async function mainLoop(ns) {
    // Update info
    numSleeves = await getNsDataThroughFile(ns, `ns.sleeve.getNumSleeves()`, '/Temp/sleeve-count.txt');
    const playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
    if (!playerInGang) playerInGang = await getNsDataThroughFile(ns, 'ns.gang.inGang()', '/Temp/gang-inGang.txt');
    let globalReserve = Number(ns.read("reserve.txt") || 0);
    let budget = (playerInfo.money - (options['reserve'] || globalReserve)) * options['aug-budget'];
    // Estimate the cost of sleeves training over the next time interval to see if (ignoring income) we would drop below our reserve.
    const costByNextLoop = interval / 1000 * task.filter(t => t.startsWith("train")).length * 12000; // TODO: Training cost/sec seems to be a bug. Should be 1/5 this ($2400/sec)
    let canTrain = !options['disable-training'] && (playerInfo.money - costByNextLoop) > (options['training-reserve'] ||
        (promptedForTrainingBudget ? ns.read(trainingReserveFile) : undefined) || globalReserve);
    // If any sleeve is training at the gym, see if we can purchase a gym upgrade to help them
    if (canTrain && task.some(t => t?.startsWith("train")) && !options['disable-spending-hashes-for-gym-upgrades'])
        if (await getNsDataThroughFile(ns, 'ns.hacknet.spendHashes("Improve Gym Training")', '/Temp/spend-hashes-on-gym.txt'))
            log(ns, `SUCCESS: Bought "Improve Gym Training" to speed up Sleeve training.`, false, 'success');
    if (playerInfo.inBladeburner && (7 in ownedSourceFiles)) {
        const bladeburnerCity = await getNsDataThroughFile(ns, `ns.bladeburner.getCity()`, '/Temp/bladeburner-getCity.txt');
        bladeburnerCityChaos = await getNsDataThroughFile(ns, `ns.bladeburner.getCityChaos(ns.args[0])`, '/Temp/bladeburner-getCityChaos.txt', [bladeburnerCity]);
    } else
        bladeburnerCityChaos = 0;

    // Update all sleeve stats and loop over all sleeves to do some individual checks and task assignments
    let dictSleeveCommand = async (command) => await getNsDataThroughFile(ns, `ns.args.map(i => ns.sleeve.${command}(i))`,
        `/Temp/sleeve-${command}-all.txt`, [...Array(numSleeves).keys()]);
    let sleeveStats = await dictSleeveCommand('getSleeveStats',);
    let sleeveInfo = await dictSleeveCommand('getInformation');
    let sleeveTasks = await dictSleeveCommand('getTask');
    for (let i = 0; i < numSleeves; i++) {
        let sleeve = { ...sleeveStats[i], ...sleeveInfo[i], ...sleeveTasks[i] }; // For convenience, merge all sleeve stats/info into one object
        // MANAGE SLEEVE AUGMENTATIONS
        if (sleeve.shock == 0) // No augs are available augs until shock is 0
            budget -= await manageSleeveAugs(ns, i, budget);

        // ASSIGN SLEEVE TASK
        // These tasks should be immediately discontinued in certain conditions, even if it hasn't been 'minTaskWorkTime'
        if (task[i] == "recover from shock" && sleeve.shock == 0 ||
            task[i] == "synchronize" && sleeve.sync == 100 ||
            task[i]?.startsWith("train") && !canTrain)
            lastReassignTime[i] = 0;
        // Otherwise, don't change tasks if we've changed tasks recently (avoids e.g. disrupting long crimes too frequently)
        if (Date.now() - (lastReassignTime[i] || 0) < minTaskWorkTime) continue;

        // Decide what we think the sleeve should be doing for the next little while
        let [designatedTask, command, args, statusUpdate] = await pickSleeveTask(ns, playerInfo, i, sleeve, canTrain);

        // Start the clock, this sleeve should stick to this task for minTaskWorkTime
        lastReassignTime[i] = Date.now();
        // Set the sleeve's new task if it's not the same as what they're already doing.
        let assignSuccess = true;
        if (task[i] != designatedTask)
            assignSuccess = await setSleeveTask(ns, playerInfo, i, designatedTask, command, args);

        // For certain tasks, log a periodic status update.
        if (assignSuccess && statusUpdate && (Date.now() - (lastStatusUpdateTime[i] ?? 0) > minTaskWorkTime)) {
            log(ns, `INFO: Sleeve ${i} is ${statusUpdate} `);
            lastStatusUpdateTime[i] = Date.now();
        }
    }
}


/** Picks the best task for a sleeve, and returns the information to assign and give status updates for that task.
 * @param {NS} ns 
 * @param {Player} playerInfo
 * @param {SleeveSkills | SleeveInformation | SleeveTask} sleeve */
async function pickSleeveTask(ns, playerInfo, i, sleeve, canTrain) {
    // Must synchronize first iif you haven't maxed memory on every sleeve.
    if (sleeve.sync < 100)
        return ["synchronize", `ns.sleeve.setToSynchronize(ns.args[0])`, [i], `syncing... ${sleeve.sync.toFixed(2)}%`];
    // Opt to do shock recovery if above the --min-shock-recovery threshold, or if above 0 shock, with a probability of --shock-recovery
    if (sleeve.shock > options['min-shock-recovery'] || sleeve.shock > 0 && options['shock-recovery'] > 0 && Math.random() < options['shock-recovery'])
        return ["recover from shock", `ns.sleeve.setToShockRecovery(ns.args[0])`, [i], `recovering from shock... ${sleeve.shock.toFixed(2)}%`];

    // Train if our sleeve's physical stats aren't where we want them
    if (canTrain) {
        let untrainedStats = trainStats.filter(stat => sleeve[stat] < options[`train-to-${stat}`]);
        if (untrainedStats.length > 0) {
            if (playerInfo.money < 5E6 && !promptedForTrainingBudget)
                await promptForTrainingBudget(ns); // If we've never checked, see if we can train into debt.
            if (sleeve.city != "Sector-12") {
                log(ns, `Moving Sleeve ${i} from ${sleeve.city} to Sector-12 so that they can study at Powerhouse Gym.`);
                await getNsDataThroughFile(ns, 'ns.sleeve.travel(ns.args[0], ns.args[1])', '/Temp/sleeve-travel.txt', [i, "Sector-12"]);
            }
            var trainStat = untrainedStats.reduce((min, s) => sleeve[s] < sleeve[min] ? s : min, untrainedStats[0]);
            return [`train ${trainStat}`, `ns.sleeve.setToGymWorkout(ns.args[0], ns.args[1], ns.args[2])`, [i, 'Powerhouse Gym', trainStat],
            /*   */ `training ${trainStat}... ${sleeve[trainStat]}/${(options[`train-to-${trainStat}`])}`];
        }
    }
    // If player is currently working for faction or company rep, sleeves 0 can help him out (Note: Only one sleeve can work for a faction)
    if (i == 0 && !options['disable-follow-player'] && playerInfo.isWorking && playerInfo.workType == "Working for Faction") {
        // TODO: We should be able to borrow logic from work-for-factions.js to have more sleeves work for useful factions / companies
        // We'll cycle through work types until we find one that is supported. TODO: Auto-determine the most productive faction work to do.
        const faction = playerInfo.currentWorkFactionName;
        const work = works[workByFaction[faction] || 0];
        return [`work for faction '${faction}' (${work})`, `ns.sleeve.setToFactionWork(ns.args[0], ns.args[1], ns.args[2])`, [i, faction, work],
        /*   */ `helping earn rep with faction ${faction} by doing ${work}.`];
    }
    if (i == 0 && !options['disable-follow-player'] && playerInfo.isWorking && playerInfo.workType == "Working for Company") { // If player is currently working for a company rep, sleeves 0 shall help him out (only one sleeve can work for a company)
        return [`work for company '${playerInfo.companyName}'`, `ns.sleeve.setToCompanyWork(ns.args[0], ns.args[1])`, [i, playerInfo.companyName],
        /*   */ `helping earn rep with company ${playerInfo.companyName}.`];
    }
    // If the player is in bladeburner, and has already unlocked gangs with Karma, generate contracts and operations
    if (playerInfo.inBladeburner && playerInGang) {
        // Hack: Without paying much attention to what's happening in bladeburner, pre-assign a variety of tasks by sleeve index
        const bbTasks = [/*0*/["Support main sleeve"], /*1*/["Take on contracts", "Retirement"],
            /*2*/["Take on contracts", "Bounty Hunter"], /*3*/["Take on contracts", "Tracking"], /*4*/["Infiltrate synthoids"],
            /*5*/["Diplomacy"], /*6*/["Field Analysis"], /*7*/["Recruitment"]];
        let [action, contractName] = bladeburnerCityChaos > 50 ? ["Diplomacy"] : bbTasks[i];
        // If the sleeve is performing an action with a chance of failure, fallback to another task
        if (sleeve.location.includes("%") && !sleeve.location.includes("100%"))
            bladeburnerTaskFailed[i] = Date.now(); // If not, don't re-attempt this assignment for a while
        // As current city chaos gets progressively bad, assign more and more sleeves to Diplomacy to help get it under control
        if (bladeburnerCityChaos > (10 - i) * 10) // Later sleeves are first to get assigned, sleeve 0 is last at 100 chaos.
            [action, contractName] = ["Diplomacy"]; // Fall-back to something long-term useful
        // If a prior attempt to assign a sleeve a default task failed, use a fallback
        else if (Date.now() - bladeburnerTaskFailed[i] < 5 * 60 * 1000) // 5 minutes seems reasonable for now
            [action, contractName] = ["Infiltrate synthoids"]; // Fall-back to something long-term useful
        return [`Bladeburner ${action} ${contractName || ''}`.trimEnd(),
        /*   */ `ns.sleeve.setToBladeburnerAction(ns.args[0], ns.args[1], ns.args[2])`, [i, action, contractName || ""],
        /*   */ `doing ${action}${contractName ? ` - ${contractName}` : ''} in Bladeburner.`];
    }
    // Finally, do crime for Karma. Homicide has the rate gain, if we can manage a decent success rate.
    var crime = options.crime || (await calculateCrimeChance(ns, sleeve, "homicide")) >= options['homicide-chance-threshold'] ? 'homicide' : 'mug';
    return [`commit ${crime} `, `ns.sleeve.setToCommitCrime(ns.args[0], ns.args[1])`, [i, crime],
    /*   */ `committing ${crime} with chance ${((await calculateCrimeChance(ns, sleeve, crime)) * 100).toFixed(2)}% ` +
    /*   */ (options.crime || crime == "homicide" ? '' : // If auto-criming, user may be curious how close we are to switching to homicide 
    /*   */     ` (Note: Homicide chance would be ${((await calculateCrimeChance(ns, sleeve, "homicide")) * 100).toFixed(2)}% `)];
}

/** Sets a sleeve to its designated task, with some extra error handling logic for working for factions. 
 * @param {NS} ns 
 * @param {Player} playerInfo */
async function setSleeveTask(ns, playerInfo, i, designatedTask, command, args) {
    let strAction = `Set sleeve ${i} to ${designatedTask} `;
    try { // Assigning a task can throw an error rather than simply returning false. We must suppress this
        if (await getNsDataThroughFile(ns, command, `/Temp/sleeve-${command.slice(10, command.indexOf("("))}.txt`, args)) {
            task[i] = designatedTask;
            log(ns, `SUCCESS: ${strAction} `);
            return true;
        }
    } catch { }
    // If assigning the task failed...
    lastReassignTime[i] = 0;
    // If working for a faction, it's possible he current work isn't supported, so try the next one.
    if (designatedTask.startsWith('work for faction')) {
        const nextWorkIndex = (workByFaction[playerInfo.currentWorkFactionName] || 0) + 1;
        if (nextWorkIndex >= works.length) {
            log(ns, `WARN: Failed to ${strAction}. None of the ${works.length} work types appear to be supported. Will loop back and try again.`, true, 'warning');
            nextWorkIndex = 0;
        } else
            log(ns, `INFO: Failed to ${strAction} - work type may not be supported. Trying the next work type (${works[nextWorkIndex]})`);
        workByFaction[playerInfo.currentWorkFactionName] = nextWorkIndex;
    } else if (designatedTask.startsWith('Bladeburner')) { // Bladeburner action may be out of operations
        bladeburnerTaskFailed[i] = Date.now(); // There will be a cooldown before this task is assigned again.
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
    // If not in the cache, retrieve this crime's stats
    const crimeStats = cachedCrimeStats[crimeName] ?? (cachedCrimeStats[crimeName] = (4 in ownedSourceFiles ?
        await getNsDataThroughFile(ns, `ns.singularity.getCrimeStats(ns.args[0])`, '/Temp/get-crime-stats.txt', [crimeName]) :
        // Hack: To support players without SF4, hard-code values as of the current release
        crimeName == "homicide" ? { difficulty: 1, strength_success_weight: 2, defense_success_weight: 2, dexterity_success_weight: 0.5, agility_success_weight: 0.5 } :
            crimeName == "mug" ? { difficulty: 0.2, strength_success_weight: 1.5, defense_success_weight: 0.5, dexterity_success_weight: 1.5, agility_success_weight: 0.5, } :
                undefined));
    let chance =
        (crimeStats.hacking_success_weight || 0) * sleeve.hacking +
        (crimeStats.strength_success_weight || 0) * sleeve.strength +
        (crimeStats.defense_success_weight || 0) * sleeve.defense +
        (crimeStats.dexterity_success_weight || 0) * sleeve.dexterity +
        (crimeStats.agility_success_weight || 0) * sleeve.agility +
        (crimeStats.charisma_success_weight || 0) * sleeve.charisma;
    chance /= 975;
    chance /= crimeStats.difficulty;
    return Math.min(chance, 1);
}