import { disableLogs, formatDuration, formatMoney } from './helpers.js'

const argsSchema = [
    ['v', false], // Verbose
    ['verbose', false],
    ['l', false], // Turn all hashes into money
    ['liquidate', false],
    ['interval', 1000], // Rate at which the program runs and spends hashes
    ['spend-on', 'Sell for Money'],
    ['spend-on-server', undefined],
];

const purchaseOptions = ['Sell for Money', 'Sell for Corporation Funds', 'Exchange for Corporation Research', 'Generate Coding Contract', 'Improve Studying', 'Improve Gym Training'];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (lastFlag == "--spend-on") // Provide a couple auto-complete options to facilitate these arguments with spaces in them
        return purchaseOptions.map(f => f.replaceAll(" ", "_")).sort().concat(purchaseOptions.map(f => `'${f}'`).sort());
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = ns.flags(argsSchema);
    const verbose = options.v || options.verbose;
    const liquidate = options.l || options.liquidate;
    const interval = options.interval;
    const toBuy = options['spend-on'].replaceAll("_", " ");
    const spendOnServer = options['spend-on-server']?.replaceAll("_", " ") ?? undefined;
    disableLogs(ns, ['sleep']);
    ns.print(`Starting spend-hacknet-hashes.js to ensure no hashes go unspent. Will check in every ${formatDuration(interval)}`);
    ns.print(liquidate ? `-l --liquidate mode active! Will spend all hashes on money as soon as possible.` :
        `Only spending hashes every when near capacity to avoid wasting them.`);
    if (ns.hacknet.hashCapacity() == 0)
        return ns.print('We have hacknet nodes, not hacknet servers, so spending hashes is not applicable.');

    while (true) {
        let capacity = ns.hacknet.hashCapacity() || Number.MAX_VALUE;
        let startingHashes = ns.hacknet.numHashes() || 0;
        let globalProduction = Array.from({ length: ns.hacknet.numNodes() }, (_, i) => ns.hacknet.getNodeStats(i))
            .reduce((total, node) => total + node.production, 0);
        //ns.print(`Current hacknet production: ${globalProduction.toPrecision(3)}...`);
        // Spend hashes before we lose them
        let reserve = 10 + globalProduction * interval / 1000; // If we are this far from our capacity, start spending
        let success = true;
        while (success && ns.hacknet.numHashes() > (liquidate ? 4 : capacity - reserve))
            success = ns.hacknet.spendHashes(toBuy, spendOnServer);
        if (!success)
            ns.print(`Weird, failed to spend hashes. (Have: ${ns.hacknet.numHashes()} Capacity: ${ns.hacknet.hashCapacity()}`);
        if (verbose && ns.hacknet.numHashes() < startingHashes)
            ns.print(`Spent ${(startingHashes - ns.hacknet.numHashes()).toFixed(0)} hashes` +
                (liquidate ? '' : ` to avoid reaching capacity (${capacity})`) + ` at ${globalProduction.toPrecision(3)} hashes per second`);
        await ns.sleep(interval);
    }
}