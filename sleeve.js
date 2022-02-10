import { getNsDataThroughFile, formatMoney, formatDuration, disableLogs, formatNumberShort, getActiveSourceFiles_Custom } from './helpers.js'
/** @typedef {import('./index.js').NS} NS*/

const interval = 5000; // Uodate (tick) this often
const minTaskWorkTime = 59000; // Sleeves assigned a new task should stick to it for at least this many milliseconds
const tempFile = '/Temp/sleeve-set-task.txt';
const crimes = ['mug', 'homicide']
const works = ['security', 'field', 'hacking']; // When doing faction work, we prioritize physical work since sleeves tend towards having those stats be highest
const workByFaction = {}

let options;
let running;
let dictSourceFiles;
const argsSchema = [
    ['shock-recovery', 0.25], // Set to a number between 0 and 1 to devote that much time to shock recovery
    ['crime', ''],
    ['aug-budget', 0.1], // Spend up to this much of current cash on augs per tick (Default is high, because these are permanent for the rest of the BN)
    ['buy-cooldown', 60 * 1000], // Must wait this may milliseconds before buying more augs for a sleeve
    ['min-aug-batch', 20], // Must be able to afford at least this many augs before we pull the trigger (or fewer if buying all remaining augs)
    ['study', ''], // Study 'Hacking' or 'Charisma' at univeristy, or 'Combat', 'Strength', 'Defense', 'Dexterity', or 'Agility' in a gym.
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    options = ns.flags(argsSchema);
    disableLogs(ns, ['getServerMoneyAvailable']);
    if (!crimes.includes(options.crime)) crimes.push(options.crime);
    // We've set our global options. If there's already an instance of this script running, we can just quit now, and let it take over.
    if (running === true) {
        ns.exit();
    } else if (running === undefined) {
        running = true;
        ns.atExit(() => running = undefined);
    }

    let task = [], lastUpdate = [], lastPurchase = [], availableAugs = [], lastReassign = [];
    // Collect info that won't change or that we can track ourselves going forward
    dictSourceFiles = await getActiveSourceFiles_Custom(ns, getNsDataThroughFile);
    let numSleeves;
    try {
        numSleeves = await getNsDataThroughFile(ns, `ns.sleeve.getNumSleeves()`, '/Temp/sleeve-count.txt');
    } catch {
        return ns.print("User does not appear to have access to sleeves. Exiting...");
    }
    for (let i = 0; i < numSleeves; i++)
        availableAugs[i] = null;

    while (true) {
        let cash = ns.getServerMoneyAvailable("home") - Number(ns.read("reserve.txt"));
        let budget = cash * options['aug-budget'];
        let playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt')
        for (let i = 0; i < numSleeves; i++) {
            let sleeveStats = ns.sleeve.getSleeveStats(i);
            let shock = sleeveStats.shock;
            let sync = sleeveStats.sync;
            // Manage Augmentations
            if (shock == 0 && availableAugs[i] == null) // No augs are available augs until shock is 0
                availableAugs[i] = (await getNsDataThroughFile(ns, `ns.sleeve.getSleevePurchasableAugs(${i})`, '/Temp/sleeve-augs.txt')).sort((a, b) => a.cost - b.cost); // list of { name, cost }
            if (shock == 0 && availableAugs[i].length > 0) {
                const cooldownLeft = Math.max(0, options['buy-cooldown'] - (Date.now() - (lastPurchase[i] || 0)));
                const [batchCount, batchCost] = availableAugs[i].reduce(([n, c], aug) => c + aug.cost <= budget ? [n + 1, c + aug.cost] : [n, c], [0, 0]);
                const purchaseUpdate = `sleeve ${i} can afford ${batchCount.toFixed(0).padStart(2)}/${availableAugs[i].length.toFixed(0).padEnd(2)} remaining augs (cost ${formatMoney(batchCost)} of ` +
                    `${formatMoney(availableAugs[i].reduce((t, aug) => t + aug.cost, 0))}).`;
                if (lastUpdate[i] != purchaseUpdate)
                    log(ns, `INFO: With budget ${formatMoney(budget)}, ` + (lastUpdate[i] = purchaseUpdate) + ` (Min batch size: ${options['min-aug-batch']}, Cooldown: ${formatDuration(cooldownLeft)})`);
                if (cooldownLeft == 0 && batchCount > 0 && ((batchCount >= availableAugs[i].length - 1) || batchCount >= options['min-aug-batch'])) { // Don't require the last aug it's so much more expensive
                    let strAction = `Purchase ${batchCount} augmentations for sleeve ${i} at total cost of ${formatMoney(batchCost)}`;
                    let toPurchase = availableAugs[i].splice(0, batchCount);
                    budget -= batchCost;
                    if (await getNsDataThroughFile(ns, JSON.stringify(toPurchase.map(a => a.name)) +
                        `.reduce((s, aug) => s && ns.sleeve.purchaseSleeveAug(${i}, aug), true)`, '/Temp/sleeve-purchase.txt'))
                        log(ns, `SUCCESS: ${strAction}`, 'success');
                    else log(ns, `ERROR: Failed to ${strAction}`, 'error');
                    lastPurchase[i] = Date.now();
                }
            }
            // Manage what this sleeve should be doing
            let command, designatedTask;
            if (sync < 100) { // Synchronize
                designatedTask = "synchronize";
                command = `ns.sleeve.setToSynchronize(${i})`;
                if (task[i] == designatedTask && Date.now() - (lastUpdate[i] ?? 0) > minTaskWorkTime) {
                    log(ns, `INFO: Sleeve ${i} is syncing... ${sync.toFixed(2)}%`);
                    lastUpdate[i] = Date.now();
                }
            } else if (shock > 0 && options['shock-recovery'] > 0 && Math.random() < options['shock-recovery']) { // Recover from shock
                designatedTask = "recover from shock";
                command = `ns.sleeve.setToShockRecovery(${i})`;
                if (task[i] == designatedTask && Date.now() - (lastUpdate[i] ?? 0) > minTaskWorkTime) {
                    log(ns, `INFO: Sleeve ${i} is recovering from shock... ${shock.toFixed(2)}%`);
                    lastUpdate[i] = Date.now();
                }
            } else if (i == 0 && playerInfo.isWorking && playerInfo.workType == "Working for Faction") { // If player is currently working for faction rep, sleeves 0 shall help him out (only one sleeve can work for a faction)
                // TODO: We should be able to borrow logic from work-for-factions.js to have more sleeves work for useful factions / companies
                let work = works[workByFaction[playerInfo.currentWorkFactionName] || 0];
                designatedTask = `work for faction '${playerInfo.currentWorkFactionName}' (${work})`;
                command = `ns.sleeve.setToFactionWork(${i}, '${playerInfo.currentWorkFactionName}', '${work}')`; // TODO: Auto-determine the most productive faction work to do?
            } else if (i == 0 && playerInfo.isWorking && playerInfo.workType == "Working for Company") { // If player is currently working for a company rep, sleeves 0 shall help him out (only one sleeve can work for a company)
                designatedTask = `work for company '${playerInfo.companyName}'`;
                command = `ns.sleeve.setToCompanyWork(${i}, '${playerInfo.companyName}')`;
            } else { // Do something productive
                if (options.study) {
                    if (['charisma', 'hacking'].includes(options.study.toLowerCase()))
                        ({ designatedTask, command } = await doUniversityCourse(ns, i));
                    else if (['combat', 'strength', 'defense', 'dexterity', 'agility'].includes(options.study.toLowerCase()))
                        ({ designatedTask, command } = await doGymWorkout(ns, playerInfo, i));
                    else options.study = ''; // Unknown study option, so just clear it.
                } else {
                    let crime = options.crime || (sleeveStats.strength < 100 ? 'mug' : 'homicide');
                    designatedTask = `commit ${crime}`;
                    command = `ns.sleeve.setToCommitCrime(${i}, '${crime}')`;
                }
            }
            // Don't change tasks if we've changed tasks recently
            if (Date.now() - (lastReassign[i] || 0) < minTaskWorkTime || task[i] == designatedTask) continue;
            // Start doing the specified task
            let strAction = `Set sleeve ${i} to ${designatedTask}`;
            if (await getNsDataThroughFile(ns, command, tempFile)) {
                task[i] = designatedTask;
                lastReassign[i] = Date.now();
                log(ns, `SUCCESS: ${strAction}`);
            } else {
                // If working for faction / company, it's possible he current work isn't supported, so try the next one.
                if (designatedTask.startsWith('work for faction')) {
                    log(ns, `WARN: Failed to ${strAction} - work type may not be supported.`, 'warning');
                    workByFaction[playerInfo.currentWorkFactionName] = (workByFaction[playerInfo.currentWorkFactionName] || 0) + 1;
                } else
                    log(ns, `ERROR: Failed to ${strAction}`, 'error');
            }
        }
        await ns.sleep(interval);
    }
}

async function doUniversityCourse(ns, sleeveNum) {
    let city = 'Volhaven'
    let university = 'ZB Institute of Technology'; // Gains 80 exp per sec, costs $8k/s
    let course = 'Algorithms'; 
    if ('charisma' === options.study.toLowerCase())
        course = 'Leadership';
    // If we're studying, and we have spare hashes, spend them to increase our exp gains.
    if (ns.getPlayer().money > 100E6 && 9 in dictSourceFiles) { // Make sure we have a decent amount of money ($100m) before spending hashes this way.
        let spentHashes = 0;
        do {
            spentHashes = await getNsDataThroughFile(ns, 'ns.hacknet.numHashes() + ns.hacknet.spendHashes("Improve Studying") - ns.hacknet.numHashes()', '/Temp/spend-hacknet-hashes.txt');
            if (spentHashes > 0) log(ns, `Improved studying for ${formatNumberShort(Math.round(spentHashes / 50) * 50)} hashes`, 'success');
        } while (spentHashes > 0);
    }
    const designatedTask = `Study ${course} at ${university} in ${city}`;
    const command = `ns.sleeve.travel(${sleeveNum}, '${city}') && ns.sleeve.setToUniversityCourse(${sleeveNum}, '${university}', '${course}')`;
    return { designatedTask, command };

}

async function doGymWorkout(ns, playerInfo, sleeveNum) {
    let city = 'Sector-12'
    let gymName = 'Powerhouse Gym'; // Looks like the best Exp rate comes from powerhouse gym (50 exp/sec, costs $12k/sec)
    let gymStat = options.study;
    if (gymStat.toLowerCase() === 'combat') {
        let playerStats = [];
        playerStats.push(['Agility', playerInfo.agility]);
        playerStats.push(['Strength', playerInfo.strength]);
        playerStats.push(['Defense', playerInfo.defense]);
        playerStats.push(['Dexterity', playerInfo.dexterity]);
        playerStats.sort((a, b) => a[1] - b[1]); // Sort by stat value.
        gymStat = playerStats[0][0]; // Work on the stat with the lowest value.
    }
    // If we're working out in the gym, and we have spare hashes, spend them to increase our exp gains.
    if (ns.getPlayer().money > 100E6 && 9 in dictSourceFiles) { // Make sure we have a decent amount of money ($100m) before spending hashes this way.
        let spentHashes = 0;
        do {
            spentHashes = await getNsDataThroughFile(ns, 'ns.hacknet.numHashes() + ns.hacknet.spendHashes("Improve Gym Training") - ns.hacknet.numHashes()', '/Temp/spend-hacknet-hashes.txt');
            if (spentHashes > 0) log(ns, `Improved gym training for ${formatNumberShort(Math.round(spentHashes / 50) * 50)} hashes`, 'success');
        } while (spentHashes > 0);
    }
    const designatedTask = `Working on ${gymStat} at ${gymName} in ${city}`;
    const command = `ns.sleeve.travel(${sleeveNum}, '${city}') && ns.sleeve.setToGymWorkout(${sleeveNum}, '${gymName}', '${gymStat}')`;
    return { designatedTask, command };
}

function log(ns, log, toastStyle, printToTerminal) {
    ns.print(log);
    if (toastStyle) ns.toast(log, toastStyle);
    if (printToTerminal) ns.tprint(log);
}