import { getNsDataThroughFile, formatMoney, formatDuration, disableLogs } from './helpers.js'

const interval = 5000;
const tempFile = '/Temp/sleeve-set-task.txt';
const crimes = ['mug', 'homicide']

let options;
const argsSchema = [
    ['shock-recovery', 0.25], // Set to a number between 0 and 1 to devote that much time to shock recovery
    ['crime', ''],
    ['aug-budget', 0.5], // Spend up to this much of current cash on augs per tick (Default is high, because these are permanent for the rest of the BN)
    ['buy-cooldown', 60 * 1000], // Must wait this may milliseconds before buying more augs for a sleeve
    ['min-aug-batch', 20], // Must be able to afford at least this many augs before we pull the trigger (or fewer if buying all remaining augs)
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
    let task = [], lastUpdate = [], lastPurchase = [], availableAugs = [];

    // Collect info that won't change or that we can track ourselves going forward
    let numSleeves = await getNsDataThroughFile(ns, `ns.sleeve.getNumSleeves()`);
    for (let i = 0; i < numSleeves; i++)
        availableAugs[i] = (await getNsDataThroughFile(ns, `ns.sleeve.getSleevePurchasableAugs(${i})`, tempFile)).sort((a, b) => a.cost - b.cost); // list of { name, cost }

    while (true) {
        let cash = ns.getServerMoneyAvailable("home") - Number(ns.read("reserve.txt"));
        let budget = cash * options['aug-budget'];
        for (let i = 0; i < numSleeves; i++) {
            let sleeveStats = ns.sleeve.getSleeveStats(i);
            let shock = sleeveStats.shock;
            let sync = sleeveStats.sync;
            // Manage Shock
            if (shock > 0 && options['shock-recovery'] > 0 && Math.random() < options['shock-recovery']) {
                task[i] = "shock"
                if (task[i] == "shock") {
                    if (Date.now() - (lastUpdate[i] ?? 0) > 60000) {
                        log(ns, `INFO: Sleeve ${i} is recovering from shock... ${shock.toFixed(2)}%`);
                        lastUpdate[i] = Date.now();
                    }
                    continue;
                }
                let strAction = `Set sleeve ${i} to recover from shock`;
                if (await getNsDataThroughFile(ns, `ns.sleeve.setToShockRecovery(${i})`, tempFile)) {
                    task[i] = "shock"
                    log(ns, `SUCCESS: ${strAction}`);
                } else log(ns, `ERROR: Failed to ${strAction}`, 'error');
                continue;
            }
            // Manage Sync
            if (sync < 100) {
                if (task[i] == "sync") {
                    if (Date.now() - (lastUpdate[i] ?? 0) > 60000) {
                        log(ns, `INFO: Sleeve ${i} is syncing... ${sync.toFixed(2)}%`);
                        lastUpdate[i] = Date.now();
                    }
                    continue;
                }
                let strAction = `Set sleeve ${i} to sync`;
                if (await getNsDataThroughFile(ns, `ns.sleeve.setToSynchronize(${i})`, tempFile)) {
                    task[i] = "sync"
                    log(ns, `SUCCESS: ${strAction}`);
                } else log(ns, `ERROR: Failed to ${strAction}`, 'error');
                continue;
            }
            // Manage Augmentations
            if (shock == 0 && availableAugs[i].length > 0) {
                const cooldownLeft = Math.max(0, options['buy-cooldown'] - (Date.now() - (lastPurchase[i] || 0)));
                const [batchCount, batchCost] = availableAugs[i].reduce(([n, c], aug) => c + aug.cost <= budget ? [n + 1, c + aug.cost] : [n, c], [0, 0]);
                const purchaseUpdate = `sleeve ${i} can afford ${batchCount.toFixed(0).padStart(2)}/${availableAugs[i].length.toFixed(0).padEnd(2)} remaining augs (cost ${formatMoney(batchCost)} of ` +
                    `${formatMoney(availableAugs[i].reduce((t, aug) => t + aug.cost, 0))}).`;
                if (lastUpdate[i] != purchaseUpdate)
                    log(ns, `INFO: With budget ${formatMoney(budget)}, ` + (lastUpdate[i] = purchaseUpdate) + ` (Min batch size: ${options['min-aug-batch']}, Cooldown: ${formatDuration(cooldownLeft)})`);
                if (cooldownLeft == 0 && batchCount > 0 && ((batchCount >= availableAugs[i].length - 1) || batchCount >= options['min-aug-batch'])) { // Don't require the last aug it's so much more expensive
                    let strAction = `Purchase ${batchCount} augmentations for sleeve ${i} at total cost of ${batchCost}`;
                    let toPurchase = availableAugs[i].splice(0, batchCount);
                    budget -= batchCost;
                    if (await getNsDataThroughFile(ns, JSON.stringify(toPurchase.map(a => a.name)) + `.reduce((s, aug) => s && ns.sleeve.purchaseSleeveAug(${i}, aug), true)`, tempFile))
                        log(ns, `SUCCESS: ${strAction}`, 'success');
                    else log(ns, `ERROR: Failed to ${strAction}`, 'error');
                    lastPurchase[i] = Date.now();
                }
            }
            // Manage Task
            let designatedTask = options.crime || (sleeveStats.strength < 100 ? 'mug' : 'homicide');
            if (task[i] == designatedTask) continue;
            if (crimes.includes(designatedTask)) {
                let strAction = `Set sleeve ${i} to commit ${designatedTask}`;
                if (await getNsDataThroughFile(ns, `ns.sleeve.setToCommitCrime(${i}, '${designatedTask}')`, tempFile)) {
                    task[i] = designatedTask;
                    log(ns, `SUCCESS: ${strAction}`);
                } else log(ns, `ERROR: Failed to ${strAction}`, 'error');
            } else log(ns, `ERROR: Unrecognized task ${designatedTask}. Known crimes are: ${JSON.stringify(crimes)}`, 'error');
        }
        await ns.sleep(interval);
    }
}

function log(ns, log, toastStyle, printToTerminal) {
    ns.print(log);
    if (toastStyle) ns.toast(log, toastStyle);
    if (printToTerminal) ns.tprint(log);
}