import { log, disableLogs, formatMoney, formatDuration, formatNumberShort } from './helpers.js'

const sellForMoney = 'Sell for Money';

const argsSchema = [
    ['v', false], // Verbose
    ['verbose', false],
    ['l', false], // Turn all hashes into money
    ['liquidate', false],
    ['interval', 1000], // Rate at which the program runs and spends hashes
    ['spend-on', [sellForMoney]],
    ['spend-on-server', undefined],
    ['no-capacity-upgrades', false],
    ['reserve-buffer', 10], // To avoid wasting hashes, spend if would be within this many hashes of our max capacity on the next tick.
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

/** @param {NS} ns **/
export async function main(ns) {
    const options = ns.flags(argsSchema);
    const verbose = options.v || options.verbose;
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
    const getMinCost = () => Math.min(...toBuy.map(p => ns.hacknet.hashCost(p)));
    while (true) {
        let capacity = ns.hacknet.hashCapacity() || 0;
        let startingHashes = ns.hacknet.numHashes() || 0;
        let nodes = ns.hacknet.numNodes();
        if (capacity == 0 && nodes > 0)
            return log(ns, 'INFO: You have hacknet nodes, not hacknet servers, so spending hashes is not applicable.');
        // Compute the total income rate of all hacknet nodes. We have to spend faster than this when near capacity.
        let globalProduction = Array.from({ length: nodes }, (_, i) => ns.hacknet.getNodeStats(i))
            .reduce((total, node) => total + node.production, 0);
        // Spend hashes before we lose them
        let reserve = globalProduction * interval / 1000 + options['reserve-buffer']; // If we are this far from our capacity, start spending
        let success = true;
        let minCost = getMinCost();
        while (success && ns.hacknet.numHashes() > (liquidate ? minCost : capacity - reserve)) {
            for (const spendAction of toBuy.filter(p => ns.hacknet.numHashes() >= ns.hacknet.hashCost(p))) {
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
            if (success) minCost = getMinCost(); // Establish the new cheapest upgrade after making any purchases
            await ns.sleep(1); // Defend against infinite loop if there's a bug
        }
        if (verbose && ns.hacknet.numHashes() < startingHashes)
            ns.print(`SUCCESS: Spent ${(startingHashes - ns.hacknet.numHashes()).toFixed(0)} hashes ` +
                (liquidate ? '' : ` to avoid reaching capacity (${capacity})`) + ` at ${globalProduction.toPrecision(3)} hashes per second`);
        if (capacity - ns.hacknet.numHashes() < reserve || minCost > capacity) {
            if (minCost > capacity)
                log(ns, `INFO: Our hash capacity is ${formatNumberShort(capacity, 6, 3)}, but the cheapest upgrade we wish to purchase ` +
                    `costs ${formatNumberShort(minCost, 6, 3)} hashes.`);
            else
                log(ns, `INFO: Our hash capacity is ${formatNumberShort(capacity, 6, 3)}, and we currently have ` +
                    `${formatNumberShort(ns.hacknet.numHashes(), 6, 3)} hashes - which is ${capacity - ns.hacknet.numHashes()} away.`);
            if (options['no-capacity-upgrades'])
                log(ns, `WARNING: Hashes are at capacity, but we cannot afford to buy any of the specified upgrades (${toBuy.join(", ")}), ` +
                    `and --no-capacity-upgrades is set, so we cannot increase our hash capacity.`, false, 'warning');
            else { // Try to upgrade hacknet capacity so we can save up for more upgrades
                let lowestLevel = Number.MAX_SAFE_INTEGER, lowestIndex = null;
                for (let i = 0; i < nodes; i++)
                    if (ns.hacknet.getNodeStats(i).hashCapacity < lowestLevel)
                        lowestIndex = i, lowestLevel = ns.hacknet.getNodeStats(i).hashCapacity;
                if (lowestIndex !== null && ns.hacknet.upgradeCache(lowestIndex, 1))
                    log(ns, `SUCCESS: Upgraded hacknet node ${lowestIndex} hash capacity in order to avoid wasting hashes.`, false, 'success');
                else
                    log(ns, `WARNING: Hashes are at capacity, but we cannot afford to buy any of the specified upgrades (${toBuy.join(", ")}), ` +
                        `and we failed to increase our hash capacity (cost: ${formatMoney(ns.hacknet.getCacheUpgradeCost(lowestIndex, 1))}).`, false, 'warning');
            }
        }
        await ns.sleep(interval);
    }
}