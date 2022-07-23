import { log, getConfiguration, disableLogs, formatMoney, formatDuration, formatNumberShort } from './helpers.js'

const sellForMoney = 'Sell for Money';

const argsSchema = [
    ['l', false], // Spend hashes as soon as we can afford any --spend-on purchase item. Otherwise, only spends when nearing capacity.
    ['liquidate', false], // Long-form of above flag
    ['interval', 1000], // Rate at which the program runs and spends hashes
    ['spend-on', [sellForMoney]], // One or more actions to spend hashes on.
    ['spend-on-server', null], // The server to boost, for spend options that take a server argument: 'Reduce Minimum Security' and 'Increase Maximum Money'
    ['no-capacity-upgrades', false], // By default, we will attempt to upgrade the hacknet node capacity if we cannot afford any purchases. Set to true to disable this.
    ['reserve-buffer', 1], // To avoid wasting hashes, spend if would be within this many hashes of our max capacity on the next tick.
];

const basicSpendOptions = ['Sell for Money', 'Generate Coding Contract', 'Improve Studying', 'Improve Gym Training',
    'Sell for Corporation Funds', 'Exchange for Corporation Research', 'Exchange for Bladeburner Rank', 'Exchange for Bladeburner SP'];
const parameterizedSpendOptions = ['Reduce Minimum Security', 'Increase Maximum Money'];
const purchaseOptions = basicSpendOptions.concat(parameterizedSpendOptions);

export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (lastFlag == "--spend-on") // Provide a couple auto-complete options to facilitate these arguments with spaces in them
        return purchaseOptions.map(f => f.replaceAll(" ", "_"))
            .concat(purchaseOptions.map(f => `'${f}'`));
    return [];
}

/** @param {NS} ns 
 * Executes instructions to spend hacknet hashes continuously.
 * NOTE: This script is written to support multiple concurrent instances running with different arguments. **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return; // Invalid options, or ran in --help mode.
    const liquidate = options.l || options.liquidate;
    const interval = options.interval;
    const toBuy = options['spend-on'].map(s => s.replaceAll("_", " "));
    const spendOnServer = options['spend-on-server']?.replaceAll("_", " ") ?? undefined;
    // Validate arguments
    if (toBuy.length == 0)
        return log(ns, "ERROR: You must specify at least one thing to spend hashes on via the --spend-on argument.", true, 'error');
    const unrecognized = toBuy.filter(p => !purchaseOptions.includes(p));
    if (unrecognized.length > 0)
        return log(ns, `ERROR: One or more --spend-on arguments are not recognized: ${unrecognized.join(", ")}`, true, 'error');
    disableLogs(ns, ['sleep']);
    ns.print(`Starting spend-hacknet-hashes.js... Will check in every ${formatDuration(interval)}`);
    ns.print(liquidate ? `-l --liquidate mode active! Will spend all hashes as soon as possible.` :
        `Saving up hashes, only spending hashes when near capacity to avoid wasting them.`);
    // Function determines the current cheapest upgrade of all the upgrades we wish to keep purchasing
    const getMinCost = spendActions => Math.min(...spendActions.map(p => ns.hacknet.hashCost(p)));
    while (true) {
        await ns.sleep(interval);
        try {
            // Compute the total income rate of all hacknet nodes. We have to spend faster than this when near capacity.
            const nodes = ns.hacknet.numNodes();
            let capacity = ns.hacknet.hashCapacity() || 0;
            if (nodes == 0) {
                log(ns, 'WARN: Hacknet is empty, no hashes to spend yet...');
                continue; // Nothing to do until at least one node is purchased.
            } else if (capacity == 0)
                return log(ns, 'INFO: You have hacknet nodes, not hacknet servers, so spending hashes is not applicable.');
            let globalProduction = Array.from({ length: nodes }, (_, i) => ns.hacknet.getNodeStats(i))
                .reduce((total, node) => total + node.production, 0);
            const reserve = globalProduction * interval / 1000 + options['reserve-buffer']; // If we are this far from our capacity, start spending
            // Define the spend hash loop as a local function, since we may need to call it twice.
            const fnSpendHashes = async (purchases, spendAllHashes) => {
                const startingHashes = ns.hacknet.numHashes() || 0;
                capacity = ns.hacknet.hashCapacity() || 0;
                let success = true;
                while (success && ns.hacknet.numHashes() > (spendAllHashes ? getMinCost(purchases) : capacity - reserve)) {
                    for (const spendAction of purchases.filter(p => ns.hacknet.numHashes() >= ns.hacknet.hashCost(p))) {
                        const cost = ns.hacknet.hashCost(spendAction);
                        if (cost > ns.hacknet.numHashes()) break;
                        success = ns.hacknet.spendHashes(spendAction, parameterizedSpendOptions.includes(spendAction) ? spendOnServer : undefined);
                        if (!success) // Minor warning, possible if there are multiple versions of this script running, one beats the other two the punch.
                            ns.print(`WARN: Failed to spend hashes on '${spendAction}'. (Cost: ${formatNumberShort(cost, 6, 3)} ` +
                                `Have: ${formatNumberShort(ns.hacknet.numHashes(), 6, 3)} Capacity: ${formatNumberShort(capacity, 6, 3)}`);
                        else if (spendAction != sellForMoney) // This would be to noisy late-game, since cost never scales
                            log(ns, `SUCCESS: Spent ${cost} hashes on '${spendAction}'. ` +
                                `Next upgrade will cost ${formatNumberShort(ns.hacknet.hashCost(spendAction), 6, 3)}.`, false, 'success');
                    }
                    await ns.sleep(1); // Defend against infinite loop if there's a bug
                }
                if (ns.hacknet.numHashes() < startingHashes)
                    ns.print(`SUCCESS: Spent ${(startingHashes - ns.hacknet.numHashes()).toFixed(0)} hashes ` +
                        (spendAllHashes ? '' : ` to avoid reaching capacity (${capacity})`) +
                        ` while earning ${globalProduction.toPrecision(3)} hashes per second.`);
            };
            // Spend hashes normally on any/all user-specified purchases        
            await fnSpendHashes(toBuy, liquidate);
            // Determine if we should try to upgrade our hacknet capacity
            const remaining = capacity - ns.hacknet.numHashes();
            if (remaining < reserve)
                log(ns, `INFO: We're still at hash capacity (${formatNumberShort(capacity, 6, 3)}) after spending hashes as instructed. ` +
                    `We currently have ${formatNumberShort(ns.hacknet.numHashes(), 6, 3)} hashes - which is ${remaining} away.`);
            else if (getMinCost(toBuy) > capacity - options['reserve-buffer'])
                log(ns, `INFO: Our hash capacity is ${formatNumberShort(capacity, 6, 3)}, but the cheapest upgrade we wish to purchase ` +
                    `costs ${formatNumberShort(getMinCost(toBuy), 6, 3)} hashes. A capacity upgrade is needed before anything else is purchase.`);
            else // Current hash capacity suffices
                continue;
            if (options['no-capacity-upgrades']) // Not allowed to upgrade hacknet capacity
                log(ns, `WARNING: spend-hacknet-hashes.js cannot afford any of the desired upgrades (${toBuy.join(", ")}) at the ` +
                    `current hash capacity (${formatNumberShort(capacity, 6, 3)}), and --no-capacity-upgrades is set, ` +
                    `so we cannot increase our hash capacity.`, false, remaining < reserve ? 'warning' : undefined);
            else { // Try to upgrade hacknet capacity so we can save up for more upgrades
                let lowestLevel = Number.MAX_SAFE_INTEGER, lowestIndex = null;
                for (let i = 0; i < nodes; i++)
                    if (ns.hacknet.getNodeStats(i).hashCapacity < lowestLevel)
                        lowestIndex = i, lowestLevel = ns.hacknet.getNodeStats(i).hashCapacity;
                if (lowestIndex !== null && ns.hacknet.upgradeCache(lowestIndex, 1)) {
                    log(ns, `SUCCESS: Upgraded hacknet node ${lowestIndex} hash capacity in order to afford further purchases. ` +
                        `(You can disable this with --no-capacity-upgrades)`, false, 'success');
                    capacity = ns.hacknet.hashCapacity()
                } else if (nodes > 0)
                    log(ns, `WARNING: We cannot afford to buy any of the desired upgrades (${toBuy.join(", ")}) at our current hash capacity, ` +
                        `and we failed to increase our hash capacity (cost: ${formatMoney(ns.hacknet.getCacheUpgradeCost(lowestIndex, 1))}).`, false, 'warning');
            }
            // If for any of the above reasons, we weren't able to upgrade capacity, calling 'SpendHashes' once more
            // with these arguments will only convert enough hashes to money to ensure they aren't wasted before the next tick.
            await fnSpendHashes([sellForMoney], false);
        }
        catch (err) {
            log(ns, `WARNING: spend-hacknet-hashes.js Caught (and suppressed) an unexpected error in the main loop:\n` +
                (typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
        }
    }
}