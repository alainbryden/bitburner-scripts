import { getNsDataThroughFile, formatMoney, formatDuration, disableLogs, log } from './helpers.js'

const interval = 5000; // Uodate (tick) this often
const minTaskWorkTime = 59000; // Sleeves assigned a new task should stick to it for at least this many milliseconds
const tempFile = '/Temp/sleeve-set-task.txt';
const works = ['security', 'field', 'hacking']; // When doing faction work, we prioritize physical work since sleeves tend towards having those stats be highest
let cachedCrimeStats; // Cache of crime statistics

let options;
const argsSchema = [
    ['min-shock-recovery', 97], // Minimum shock recovery before attempting to train or do crime (Set to 100 to disable, 0 to recover fully)
    ['shock-recovery', 0.05], // Set to a number between 0 and 1 to devote that ratio of time to periodic shock recovery (until shock is at 0)
    ['crime', null], // If specified, sleeves will perform only this crime regardless of stats
    ['homicide-chance-threshold', 0.5], // Sleeves will automatically start homicide once their chance of success succeeds this ratio
    ['aug-budget', 0.1], // Spend up to this much of current cash on augs per tick (Default is high, because these are permanent for the rest of the BN)
    ['buy-cooldown', 60 * 1000], // Must wait this may milliseconds before buying more augs for a sleeve
    ['min-aug-batch', 20], // Must be able to afford at least this many augs before we pull the trigger (or fewer if buying all remaining augs)
    ['reserve', null], // Reserve this much cash before determining spending budgets (defaults to contents of reserve.txt if not specified)
    ['disable-follow-player', false], // Set to true to disable having Sleeve 0 work for the same faction/company as the player to boost rep gain.
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    options = ns.flags(argsSchema);
    disableLogs(ns, ['getServerMoneyAvailable']);
    let task = [], lastStatusUpdateTime = [], lastPurchaseTime = [], lastPurchaseStatusUpdate = [], availableAugs = [], lastReassignTime = [];
    const workByFaction = {}; // Cache of which factions support which type of work
    cachedCrimeStats = {}; // Ensure the global value is reset (e.g. after entering a new bitnode)

    // Collect info that won't change or that we can track ourselves going forward
    let numSleeves;
    try {
        numSleeves = await getNsDataThroughFile(ns, `ns.sleeve.getNumSleeves()`, '/Temp/sleeve-count.txt');
    } catch {
        return ns.print("User does not appear to have access to sleeves. Exiting...");
    }
    for (let i = 0; i < numSleeves; i++)
        availableAugs[i] = null;

    while (true) {
        try {
            let cash = ns.getServerMoneyAvailable("home") - (options['reserve'] != null ? options['reserve'] : Number(ns.read("reserve.txt") || 0));
            let budget = cash * options['aug-budget'];
            let playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt')
            let allSleeveStats = await getNsDataThroughFile(ns, `[...Array(${numSleeves}).keys()].map(i => ns.sleeve.getSleeveStats(i))`, '/Temp/sleeve-stats.txt');
            for (let i = 0; i < numSleeves; i++) {
                let sleeveStats = allSleeveStats[i];
                let shock = sleeveStats.shock;
                let sync = sleeveStats.sync;
                // Manage Augmentations
                if (shock == 0 && availableAugs[i] == null) // No augs are available augs until shock is 0
                    availableAugs[i] = (await getNsDataThroughFile(ns, `ns.sleeve.getSleevePurchasableAugs(${i})`, '/Temp/sleeve-augs.txt')).sort((a, b) => a.cost - b.cost); // list of { name, cost }
                if (shock == 0 && availableAugs[i].length > 0) {
                    const cooldownLeft = Math.max(0, options['buy-cooldown'] - (Date.now() - (lastPurchaseTime[i] || 0)));
                    const [batchCount, batchCost] = availableAugs[i].reduce(([n, c], aug) => c + aug.cost <= budget ? [n + 1, c + aug.cost] : [n, c], [0, 0]);
                    const purchaseUpdate = `sleeve ${i} can afford ${batchCount.toFixed(0).padStart(2)}/${availableAugs[i].length.toFixed(0).padEnd(2)} remaining augs (cost ${formatMoney(batchCost)} of ` +
                        `${formatMoney(availableAugs[i].reduce((t, aug) => t + aug.cost, 0))}).`;
                    if (lastPurchaseStatusUpdate[i] != purchaseUpdate)
                        log(ns, `INFO: With budget ${formatMoney(budget)}, ` + (lastPurchaseStatusUpdate[i] = purchaseUpdate) + ` (Min batch size: ${options['min-aug-batch']}, Cooldown: ${formatDuration(cooldownLeft)})`);
                    if (cooldownLeft == 0 && batchCount > 0 && ((batchCount >= availableAugs[i].length - 1) || batchCount >= options['min-aug-batch'])) { // Don't require the last aug it's so much more expensive
                        let strAction = `Purchase ${batchCount} augmentations for sleeve ${i} at total cost of ${formatMoney(batchCost)}`;
                        let toPurchase = availableAugs[i].splice(0, batchCount);
                        budget -= batchCost;
                        if (await getNsDataThroughFile(ns, JSON.stringify(toPurchase.map(a => a.name)) +
                            `.reduce((s, aug) => s && ns.sleeve.purchaseSleeveAug(${i}, aug), true)`, '/Temp/sleeve-purchase.txt'))
                            log(ns, `SUCCESS: ${strAction}`, true, 'success');
                        else log(ns, `ERROR: Failed to ${strAction}`, true, 'error');
                        lastPurchaseTime[i] = Date.now();
                    }
                }
                // Pick what we think the sleeve should be doing right now
                let command, designatedTask;
                if (sync < 100) { // Synchronize
                    designatedTask = "synchronize";
                    command = `ns.sleeve.setToSynchronize(${i})`;
                } // Opt to do shock recovery if above the --min-shock-recovery threshold, or if above 0 shock, with a probability of --shock-recovery
                else if (shock > options['min-shock-recovery'] || shock > 0 && options['shock-recovery'] > 0 && Math.random() < options['shock-recovery']) { // Recover from shock
                    designatedTask = "recover from shock";
                    command = `ns.sleeve.setToShockRecovery(${i})`;
                } // If player is currently working for faction or company rep, sleeves 0 can help him out (Note: Only one sleeve can work for a faction)
                else if (i == 0 && !options['disable-follow-player'] && playerInfo.isWorking && playerInfo.workType == "Working for Faction") {
                    // TODO: We should be able to borrow logic from work-for-factions.js to have more sleeves work for useful factions / companies
                    const work = works[workByFaction[playerInfo.currentWorkFactionName] || 0];
                    designatedTask = `work for faction '${playerInfo.currentWorkFactionName}' (${work})`;
                    command = `ns.sleeve.setToFactionWork(${i}, '${playerInfo.currentWorkFactionName}', '${work}')`; // TODO: Auto-determine the most productive faction work to do?
                } else if (i == 0 && !options['disable-follow-player'] && playerInfo.isWorking && playerInfo.workType == "Working for Company") { // If player is currently working for a company rep, sleeves 0 shall help him out (only one sleeve can work for a company)
                    designatedTask = `work for company '${playerInfo.companyName}'`;
                    command = `ns.sleeve.setToCompanyWork(${i}, '${playerInfo.companyName}')`;
                }  // Do crime for Karma. Homicide has the rate gain, if we can manage a decent success rate.
                else { // TODO: This is less useful after gangs are unlocked, can we think of better things to do?
                    var crime = options.crime || (await calculateCrimeChance(ns, sleeveStats, "homicide")) >= options['homicide-chance-threshold'] ? 'homicide' : 'mug';
                    designatedTask = `commit ${crime}`;
                    command = `ns.sleeve.setToCommitCrime(${i}, '${crime}')`;
                }

                // If shock/sync just completed, and they were on that task, allow this sleeve to immediately be reassigned
                if (shock == 0 && task[i] == "recover from shock" || sync == 100 && task[i] == "synchronize") lastReassignTime[i] = 0;
                // Don't change tasks if we've changed tasks recently (avoids e.g. disrupting long crimes too frequently)
                if (Date.now() - (lastReassignTime[i] || 0) < minTaskWorkTime) continue;

                // Set the sleeve's new task if it's not the same as what they're already doing.
                if (task[i] != designatedTask) {
                    let strAction = `Set sleeve ${i} to ${designatedTask}`;
                    if (await getNsDataThroughFile(ns, command, tempFile)) {
                        task[i] = designatedTask;
                        lastReassignTime[i] = Date.now();
                        log(ns, `SUCCESS: ${strAction}`);
                    } else { // Assigning the task failed
                        // If working for a faction, it's possible he current work isn't supported, so try the next one.
                        if (designatedTask.startsWith('work for faction')) {
                            log(ns, `WARN: Failed to ${strAction} - work type may not be supported.`, false, 'warning');
                            workByFaction[playerInfo.currentWorkFactionName] = (workByFaction[playerInfo.currentWorkFactionName] || 0) + 1;
                        } else
                            log(ns, `ERROR: Failed to ${strAction}`, true, 'error');
                    }
                }

                // For certain tasks, log a periodic status update.
                if (Date.now() - (lastStatusUpdateTime[i] ?? 0) > minTaskWorkTime) {
                    let statusUpdate;
                    if (designatedTask == "recover from shock")
                        statusUpdate = `Sleeve ${i} is recovering from shock... ${shock.toFixed(2)}%`;
                    else if (designatedTask == "synchronize")
                        statusUpdate = `Sleeve ${i} is syncing... ${sync.toFixed(2)}%`;
                    else if (designatedTask.startsWith("commit")) {
                        statusUpdate = `Sleeve ${i} is committing ${crime} with chance ${((await calculateCrimeChance(ns, sleeveStats, crime)) * 100).toFixed(2)}%`;
                        if (!options.crime && crime != "homicide") // If auto-criming, user will be curious how close we are to switching to homicide
                            statusUpdate += ` (Note: Homicide chance would be ${((await calculateCrimeChance(ns, sleeveStats, "homicide")) * 100).toFixed(2)}%`;
                    }
                    if (statusUpdate) {
                        log(ns, `INFO: ${statusUpdate}`);
                        lastStatusUpdateTime[i] = Date.now();
                    }
                }
            }
        } catch (error) {
            log(ns, `WARNING: An error was caught (and suppressed) in the main loop: ${error?.toString() || String(error)}`, false, 'warning');
        }
        await ns.asleep(interval);
    }
}

// Calculate the chance a sleeve has of committing homicide successfully
async function calculateCrimeChance(ns, sleeveStats, crimeName) {
    const crimeStats = cachedCrimeStats[crimeName] ?? // If not in the cache, retrieve this crime's stats
        (cachedCrimeStats[crimeName] = await getNsDataThroughFile(ns, `ns.getCrimeStats("${crimeName}")`, '/Temp/get-crime-stats.txt'));
    let chance =
        crimeStats.hacking_success_weight * sleeveStats['hacking'] +
        crimeStats.strength_success_weight * sleeveStats.strength +
        crimeStats.defense_success_weight * sleeveStats.defense +
        crimeStats.dexterity_success_weight * sleeveStats.dexterity +
        crimeStats.agility_success_weight * sleeveStats.agility +
        crimeStats.charisma_success_weight * sleeveStats.charisma;
    chance /= 975;
    chance /= crimeStats.difficulty;
    return Math.min(chance, 1);
}