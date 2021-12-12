import { disableLogs, formatDuration, formatMoney } from './helpers.js'

const argsSchema = [
    ['v', false], // Verbose
    ['verbose', false],
    ['l', false], // Turn all hashes into money
    ['liquidate', false],
    ['interval', 1000] // Rate at which the program runs and spends hashes
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = ns.flags(argsSchema);
    const verbose = options.v || options.verbose;
    const liquidate = options.l || options.liquidate;
    const interval = options.interval;
    disableLogs(ns, ['sleep']);
    ns.print(`Starting spend-hacknet-hashes.js to ensure no hashes go unspent. Will check in every ${formatDuration(interval)}`);
    ns.print(liquidate ? `-l --liquidate mode active! Will spend all hashes on money as soon as possible.` :
        `Only spending hashes every when near capacity to avoid wasting them.`);

    while (true) {
        let capacity = ns.hacknet.hashCapacity() || Number.MAX_VALUE;
        let startingHashes = ns.hacknet.numHashes() || 0;
        let globalProduction = Array.from({ length: ns.hacknet.numNodes() }, (_, i) => ns.hacknet.getNodeStats(i))
            .reduce((total, node) => total + node.production, 0);
        //ns.print(`Current hacknet production: ${globalProduction.toPrecision(3)}...`);
        // Spend hashes before we lose them
        let reserve = 10 + globalProduction * interval / 1000; // If we produce more than 10/sec, spend more to avoid lost production in the next second
        let success = true;
        while (success && ns.hacknet.numHashes() > (liquidate ? 4 : capacity - reserve))
            success = ns.hacknet.spendHashes("Sell for Money");
        if (!success)
            ns.print(`Weird, failed to spend hashes. (Have: ${ns.hacknet.numHashes()} Capacity: ${ns.hacknet.hashCapacity()}`);
        if (verbose && ns.hacknet.numHashes() < startingHashes)
            ns.print(`Spent ${(startingHashes - ns.hacknet.numHashes()).toFixed(0)} hashes` +
                (liquidate ? '' : ` to avoid reaching capacity (${capacity})`) + ` at ${globalProduction.toPrecision(3)} hashes per second`);
        await ns.sleep(interval);
    }
}