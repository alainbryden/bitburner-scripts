import { log, getConfiguration, instanceCount, getNsDataThroughFile, scanAllServers, formatMoney, formatRam } from './helpers.js'

// The purpose of the host manager is to buy the best servers it can
// until it thinks RAM is underutilized enough that you don't need to anymore.

const purchasedServerName = "daemon"; // The name to give all purchased servers. Also used to determine which servers were purchased
let maxPurchasableServerRamExponent; // The max server ram you can buy as an exponent (power of 2). Typically 1 petabyte (2^20), but less in some BNs 
let maxPurchasedServers; // The max number of servers you can have in your farm. Typically 25, but can be less in some BNs
let costByRamExponent = {}; // A dictionary of how much each server size costs, prepped in advance.

// The following globals are set via command line arguments specified below, along with their defaults
let keepRunning = false;
let minRamExponent;
let absReservedMoney;
let pctReservedMoney;

let options;
const argsSchema = [
    ['c', false], // Set to true to run continuously
    ['run-continuously', false], // Long-form alias for above flag
    ['interval', 10000], // Update interval (in milliseconds) when running continuously
    ['min-ram-exponent', 5], // the minimum amount of ram to purchase
    ['utilization-trigger', 0.80], // the percentage utilization that will trigger an attempted purchase
    ['absolute-reserve', null], // Set to reserve a fixed amount of money. Defaults to the contents of reserve.txt on home
    ['reserve-percent', 0.9], // Set to reserve a percentage of home money
    ['reserve-by-time', false], // Experimental exponential decay by time in the run. Starts willing to spend lots of money, falls off over time.
    ['allow-worse-purchases', false], // Set to true to allow purchase of servers worse than our current best purchased server
    ['compare-to-home-threshold', 0.25], // Do not bother buying servers unless they are at least this big compared to current home RAM
    ['compare-to-network-ram-threshold', 0.02], // Do not bother buying servers unless they are at least this big compared to total network RAM
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
    ns.disableLog('ALL')

    // Get the maximum number of purchased servers in this bitnode
    maxPurchasedServers = await getNsDataThroughFile(ns, 'ns.getPurchasedServerLimit()', '/Temp/getPurchasedServerLimit.txt');
    log(ns, `INFO: Max purchasable servers has been detected as ${maxPurchasedServers.toFixed(0)}.`);
    if (maxPurchasedServers == 0)
        return log(ns, `INFO: Shutting down due to host purchasing being disabled in this BN...`);

    // Get the maximum size of purchased servers in this bitnode
    maxPurchasableServerRamExponent = await getNsDataThroughFile(ns, 'Math.log2(ns.getPurchasedServerMaxRam())', '/Temp/host-max-ram-exponent.txt');
    log(ns, `INFO: Max purchasable RAM has been detected as 2^${maxPurchasableServerRamExponent} (${formatRam(2 ** maxPurchasableServerRamExponent)}).`);

    // Gather one-time info in advance about how much RAM each size of server costs (Up to 2^30 to be future-proof, but we expect everything abouve 2^20 to be Infinity)
    costByRamExponent = await getNsDataThroughFile(ns, 'Object.fromEntries([...Array(30).keys()].map(i => [i, ns.getPurchasedServerCost(2**i)]))', '/Temp/host-costs.txt');

    keepRunning = options.c || options['run-continuously'];
    pctReservedMoney = options['reserve-percent'];
    minRamExponent = options['min-ram-exponent'];
    // Log the command line options, for new users who don't know why certain decisions are/aren't being made
    if (minRamExponent > maxPurchasableServerRamExponent) {
        log(ns, `WARN: --min-ram-exponent was set to ${minRamExponent} (${formatRam(2 ** minRamExponent)}), ` +
            `but the maximum server RAM in this BN is ${maxPurchasableServerRamExponent} (${formatRam(2 ** maxPurchasableServerRamExponent)}), ` +
            `so the minimum has been lowered accordingly.`);
        minRamExponent = maxPurchasableServerRamExponent;
    } else
        log(ns, `INFO: --min-ram-exponent is set to ${minRamExponent}: New servers will only be purchased ` +
            `if we can afford 2^${minRamExponent} (${formatRam(2 ** minRamExponent)}) or more in size.`);
    log(ns, `INFO: --compare-to-home-threshold is set to ${options['compare-to-home-threshold'] * 100}%: ` +
        `New servers are deemed "not worthwhile" unless they are at least this big compared to your home server.`);
    log(ns, `INFO: --compare-to-network-ram-threshold is set to ${options['compare-to-network-ram-threshold'] * 100}%: ` +
        `New servers are deemed "not worthwhile" unless they are this big compared to total ram on the entire network.`);
    log(ns, `INFO: --utilization-trigger is set to ${options['utilization-trigger'] * 100}%: ` +
        `New servers will only be purchased when more than this much RAM is in use across the entire network.`);
    if (options['reserve-by-time'])
        log(ns, `INFO: --reserve-by-time is active! This community-contributed option will spend more of your money on servers ` +
            `early on, and less later on. Experimental and not tested by me. Have fun!`);
    else
        log(ns, `INFO: --reserve-percent is set to ${pctReservedMoney * 100}%: ` +
            `This means we will spend no more than ${((1 - pctReservedMoney) * 100).toFixed(1)}% of current Money on a new server.`);
    // Start the main loop (or run once)
    if (!keepRunning)
        log(ns, `host-manager will run once. Run with argument "-c" to run continuously.`)
    do {
        absReservedMoney = options['absolute-reserve'] != null ? options['absolute-reserve'] : Number(ns.read("reserve.txt") || 0);
        await tryToBuyBestServerPossible(ns);
        if (keepRunning)
            await ns.sleep(options['interval']);
    } while (keepRunning);
}

// Logging system to only print a log if it is different from the last log printed.
let lastStatus = "";
function setStatus(ns, logMessage) {
    return logMessage != lastStatus ? ns.print(lastStatus = logMessage) : false;
}

/** @param {NS} ns 
  * Attempts to buy a server at or better than your home machine. **/
async function tryToBuyBestServerPossible(ns) {
    // Gether the list of all purchased servers.
    const purchasedServers = await getNsDataThroughFile(ns, 'ns.getPurchasedServers()', '/Temp/getPurchasedServers.txt');
    // Scan the set of all servers on the network that we own (or rooted) to get a sense of current RAM utilization
    const rootedServers = scanAllServers(ns).filter(s => ns.hasRootAccess(s));
    const totalMaxRam = rootedServers.reduce((t, s) => t + ns.getServerMaxRam(s), 0);
    const totalUsedRam = rootedServers.reduce((t, s) => t + ns.getServerUsedRam(s), 0);
    const utilizationRate = totalUsedRam / totalMaxRam;
    setStatus(ns, `Using ${Math.round(totalUsedRam).toLocaleString('en')}/${formatRam(totalMaxRam)} (` +
        `${(utilizationRate * 100).toFixed(1)}%) across ${rootedServers.length} servers ` +
        `(Triggers at ${options['utilization-trigger'] * 100}%, ${purchasedServers.length} bought so far)`);

    // If utilization is below target. We don't need another server.
    if (utilizationRate < options['utilization-trigger']) return;

    // Check for other reasons not to go ahead with the purchase
    let prefix = 'Host-manager wants to buy another server, but ';

    // Determine our budget for spending money on home RAM
    let spendableMoney = await getNsDataThroughFile(ns, `ns.getServerMoneyAvailable(ns.args[0])`, `/Temp/getServerMoneyAvailable.txt`, ["home"]);
    if (options['reserve-by-time']) { // Option to vary pctReservedMoney by time since augment. 
        // Decay factor of 0.2 = Starts willing to spend 95% of our money, backing down to ~75% at 1 hour, ~60% at 2 hours, ~25% at 6 hours, and ~10% at 10 hours.
        // Decay factor of 0.3 = Starts willing to spend 95% of our money, backing down to ~66% at 1 hour, ~45% at 2 hours, ~23% at 4 hours, ~10% at 6 hours
        // Decay factor of 0.5 = Starts willing to spend 95% of our money, then halving every hour (to ~48% at 1 hour, ~24% at 2 hours, ~12% at 3 hours, etc)
        const timeSinceLastAug = await getNsDataThroughFile(ns, 'ns.getTimeSinceLastAug()', '/Temp/getTimeSinceLastAug.txt');
        const t = timeSinceLastAug / (60 * 60 * 1000); // Time since last aug, in hours.
        const decayFactor = 0.5;
        pctReservedMoney = 1 - 0.95 * Math.pow(1 - decayFactor, t);
    }

    spendableMoney = Math.min(spendableMoney * (1 - pctReservedMoney), spendableMoney - absReservedMoney);
    if (spendableMoney <= 0.01)
        return setStatus(ns, `${prefix}all cash is currently reserved (% reserve: ${(pctReservedMoney * 100).toFixed(1)}%, abs reserve: ${formatMoney(absReservedMoney)})`);

    // Determine the most ram we can buy with our current money
    let exponentLevel = 1;
    for (; exponentLevel < maxPurchasableServerRamExponent; exponentLevel++)
        if (costByRamExponent[exponentLevel + 1] > spendableMoney)
            break;
    let cost = costByRamExponent[exponentLevel];
    let maxRamPossibleToBuy = Math.pow(2, exponentLevel);

    // Don't buy if it would put us below our reserve (shouldn't happen, since we calculated how much to buy based on reserve amount)
    if (spendableMoney < cost)
        return setStatus(ns, `${prefix}spendableMoney (${formatMoney(spendableMoney)}) is less than the cost ` +
            `of even the cheapest server (${formatMoney(cost)} for ${formatRam(2 ** exponentLevel)})`);
    // Don't buy if we can't afford our configured --min-ram-exponent
    if (exponentLevel < minRamExponent)
        return setStatus(ns, `${prefix}The highest ram exponent we can afford (2^${exponentLevel} for ${formatMoney(cost)}) on our budget ` +
            `of ${formatMoney(spendableMoney)} is less than the --min-ram-exponent (2^${minRamExponent} for ${formatMoney(costByRamExponent[minRamExponent])})`);
    // Under some conditions, we consider the new server "not worthwhile". but only if it isn't the biggest possible server we can buy
    if (exponentLevel < maxPurchasableServerRamExponent) {
        // Abort if our home server is more than x times bettter (rough guage of how much we 'need' Daemon RAM at the current stage of the game?)
        const homeThreshold = options['compare-to-home-threshold'];
        // Unless we're looking at buying the maximum purchasable server size - in which case we can do no better
        if (maxRamPossibleToBuy < ns.getServerMaxRam("home") * homeThreshold)
            return setStatus(ns, `${prefix}the most RAM we can buy (${formatRam(maxRamPossibleToBuy)}) on our budget of ${formatMoney(spendableMoney)} ` +
                `is less than --compare-to-home-threshold (${homeThreshold}) x home RAM (${formatRam(ns.getServerMaxRam("home"))})`);
        // Abort if purchasing this server wouldn't improve our total RAM by more than x% (ensures we buy in meaningful increments)
        const networkThreshold = options['compare-to-network-ram-threshold'];
        if (maxRamPossibleToBuy / totalMaxRam < networkThreshold)
            return setStatus(ns, `${prefix}the most RAM we can buy (${formatRam(maxRamPossibleToBuy)}) on our budget of ${formatMoney(spendableMoney)} ` +
                `is less than --compare-to-network-ram-threshold (${networkThreshold}) x total network RAM (${formatRam(totalMaxRam)})`);
    }

    // Collect information about other previoulsy purchased servers
    const maxPurchasableServerRam = Math.pow(2, maxPurchasableServerRamExponent);
    const ramByServer = Object.fromEntries(purchasedServers.map(server => [server, ns.getServerMaxRam(server)]));
    let [worstServerName, worstServerRam] = purchasedServers.reduce(([minS, minR], s) =>
        ramByServer[s] < minR ? [s, ramByServer[s]] : [minS, minR], [null, maxPurchasableServerRam]);
    let [bestServerName, bestServerRam] = purchasedServers.reduce(([maxS, maxR], s) =>
        ramByServer[s] > maxR ? [s, ramByServer[s]] : [maxS, maxR], [null, 0]);

    // Abort if our worst previously-purchased server is better than the one we're looking to buy (ensures we buy in sane increments of capacity)
    if (worstServerName != null && maxRamPossibleToBuy < worstServerRam && !options['allow-worse-purchases'])
        return setStatus(ns, `${prefix}the most RAM we can buy (${formatRam(maxRamPossibleToBuy)}) on our budget of ` +
            `${formatMoney(spendableMoney)} is less than our worst purchased server ${worstServerName}'s RAM ${formatRam(worstServerRam)}`);
    // Only buy new servers as good as or better than our best bought server (anything less is deemed a regression in value)
    if (bestServerRam != null && maxRamPossibleToBuy < bestServerRam && !options['allow-worse-purchases'])
        return setStatus(ns, `${prefix}the most RAM we can buy (${formatRam(maxRamPossibleToBuy)}) on our budget of ` +
            `${formatMoney(spendableMoney)} is less than our previously purchased server ${bestServerName} RAM ${formatRam(bestServerRam)}`);

    // if we're at capacity, check to see if we can do better better than the current worst purchased server. If so, delete it to make room.
    if (purchasedServers.length >= maxPurchasedServers) {
        if (worstServerRam == maxPurchasableServerRam) {
            keepRunning = false;
            return setStatus(ns, `INFO: We are at the max number of servers ${maxPurchasedServers}, ` +
                `and all have the maximum possible RAM (${formatRam(maxPurchasableServerRam)}).`);
        }

        // It's only worth deleting our old server if the new server will be 16x bigger or more (or if it's the biggest we can buy)
        if (exponentLevel == maxPurchasableServerRamExponent || worstServerRam * 16 <= maxRamPossibleToBuy) {
            ns.run("remove-worst-server.js");
            return setStatus(ns, `hostmanager.js requested to delete server ${worstServerName} (${formatRam(worstServerRam)} RAM) ` +
                `to make room for a new ${formatRam(maxRamPossibleToBuy)} Server.`);
        } else {
            return setStatus(ns, `${prefix}the most RAM we can buy (${formatRam(maxRamPossibleToBuy)}) is less than 16x the RAM ` +
                `of the server it must delete to make room: ${worstServerName} (${formatRam(worstServerRam)} RAM)`);
        }
    }

    let purchasedServer = await getNsDataThroughFile(ns, `ns.purchaseServer(ns.args[0], ns.args[1])`,
        '/Temp/purchaseServer.txt', [purchasedServerName, maxRamPossibleToBuy]);
    if (!purchasedServer)
        setStatus(ns, `${prefix}Could not purchase a server with ${formatRam(maxRamPossibleToBuy)} RAM for ${formatMoney(cost)} ` +
            `with a budget of ${formatMoney(spendableMoney)}. This is either a bug, or we in a SF.9`);
    else
        log(ns, `SUCCESS: Purchased a new server ${purchasedServer} with ${formatRam(maxRamPossibleToBuy)} RAM for ${formatMoney(cost)}`, true, 'success');
}