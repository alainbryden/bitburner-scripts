import { formatMoney, formatRam, tryGetBitNodeMultipliers, getNsDataThroughFile, log } from './helpers.js'

// The purpose of the host manager is to buy the best servers it can
// until it thinks RAM is underutilized enough that you don't need to anymore.

const purchasedServerName = "daemon"; // The name to give all purchased servers. Also used to determine which servers were purchased
let maxPurchasableServerRamExponent = 20; // the max server ram you can buy (it's a petabyte) as an exponent (power of 2)
let maxPurchasedServers = 25; // the max number of servers you can have in your farm
let bitnodeMults;

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
    ns.disableLog('ALL')
    bitnodeMults = (await tryGetBitNodeMultipliers(ns)) ?? { PurchasedServerMaxRam: 1, PurchasedServerLimit: 1 };
    maxPurchasableServerRamExponent = Math.round(20 + Math.log2(bitnodeMults.PurchasedServerMaxRam));
    maxPurchasedServers = Math.round(25 * bitnodeMults.PurchasedServerLimit);

    options = ns.flags(argsSchema);
    keepRunning = options.c || options['run-continuously'];
    pctReservedMoney = options['reserve-percent'];
    minRamExponent = options['min-ram-exponent'];
    // Log the command line options, for new users who don't know why certain decisions are/aren't being made
    log(ns, `INFO: --utilization-trigger is set to ${options['utilization-trigger'] * 100}%: ` +
        `New servers will only be purchased when more than this much RAM is in use across the entire network.`);
    log(ns, `INFO: --min-ram-exponent is set to ${minRamExponent}: New servers will only be purchased ` +
        `if we can afford 2^${minRamExponent} (${formatRam(2 ** minRamExponent)}) or more in size.`);
    log(ns, `INFO: --compare-to-home-threshold is set to ${options['compare-to-home-threshold'] * 100}%: ` +
        `New servers are deemed "not worthwhile" unless they are at least this big compared to your home server.`);
    log(ns, `INFO: --compare-to-network-ram-threshold is set to ${options['compare-to-network-ram-threshold'] * 100}%: ` +
        `New servers are deemed "not worthwhile" unless they are this big compared to total ram on the entire network.`);
    if (options['reserve-by-time'])
        log(ns, `INFO: --reserve-by-time is active! This community-contributed option will spend more of your money on servers ` +
            `early on, and less later on. Experimental and not tested by me. Have fun!`);
    else
        log(ns, `INFO: --reserve-percent is set to ${pctReservedMoney * 100}%: ` +
            `This means we will spend more than ${((1 - pctReservedMoney) * 100).toFixed(1)}% of current Money on a new server.`);
    // Start the main loop (or run once)
    if (!keepRunning)
        log(ns, `host-manager will run once. Run with argument "-c" to run continuously.`,)
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
    // Scan the set of all servers on the network that we own (or rooted) to get a sense of RAM utilization
    let rootedServers = [];
    let ignoredServers = [];
    let hostsToScan = ["home"];
    let utilizationTotal = 0;
    let totalMaxRam = 0;
    let infLoopProtection = 1000;
    while (hostsToScan.length > 0 && infLoopProtection-- > 0) {
        let hostName = hostsToScan.pop();
        if (rootedServers.includes(hostName) || ignoredServers.includes(hostName))
            continue;
        ns.scan(hostName).forEach(connectedHost => hostsToScan.push(connectedHost));

        let serverMaxRam = ns.getServerMaxRam(hostName);
        // Don't count unrooted or useless servers
        if (ns.getServerMaxRam(hostName) <= 0 || ns.hasRootAccess(hostName) == false) {
            ignoredServers.push(hostName);
            continue;
        }
        rootedServers.push(hostName);
        totalMaxRam += serverMaxRam;
        utilizationTotal += ns.getServerUsedRam(hostName);
    }
    if (infLoopProtection <= 0)
        return log(ns, 'ERROR: Infinite Loop Detected!', true, 'error');

    // Gether up the list of servers that were previously purchased.
    // Note: You can request the official list of purchased servers (cost 2.25 GB RAM), but we have that commented out here.
    //let purchasedServers = ns.getPurchasedServers();
    // If you're willing to remember to always name manually purchased severs "daemon", then this should work
    //let purchasedServers = ns.getPurchasedServers();
    let purchasedServers = rootedServers.filter(hostName => hostName.startsWith(purchasedServerName)).sort();

    // analyze the utilization rates
    let utilizationRate = utilizationTotal / totalMaxRam;
    setStatus(ns, `Using ${Math.round(utilizationTotal).toLocaleString()}/${formatRam(totalMaxRam)} (` +
        `${(utilizationRate * 100).toFixed(1)}%) across ${rootedServers.length} servers ` +
        `(Triggers at ${options['utilization-trigger'] * 100}%, ${purchasedServers.length} bought so far)`);

    // Stop if utilization is below target. We probably don't need another server.
    if (utilizationRate < options['utilization-trigger'])
        return;

    // Check for other reasons not to go ahead with the purchase
    let prefix = 'Host-manager wants to buy another server, but ';

    let spendableMoney = ns.getServerMoneyAvailable("home");
    // Automatically reserve at least enough money to buy the final hack tool, if we do not already have it.
    if (!ns.fileExists("SQLInject.exe", "home")) {
        prefix += '(reserving an extra 250M for SQLInject) ';
        spendableMoney = Math.max(0, spendableMoney - 250000000);
    }
    // Additional reservations
    // Vary reservation by time since augment. 
    // Decay factor of 0.2 = Starts willing to spend 95% of our money, backing down to ~75% at 1 hour, ~60% at 2 hours, ~25% at 6 hours, and ~10% at 10 hours.
    // Decay factor of 0.3 = Starts willing to spend 95% of our money, backing down to ~66% at 1 hour, ~45% at 2 hours, ~23% at 4 hours, ~10% at 6 hours
    // Decay factor of 0.5 = Starts willing to spend 95% of our money, then halving every hour (to ~48% at 1 hour, ~24% at 2 hours, ~12% at 3 hours, etc)
    let t = ns.getTimeSinceLastAug() / (60 * 60 * 1000); // Time since last aug, in hours.
    let decayFactor = 0.5
    if (options['reserve-by-time'])
        pctReservedMoney = 1 - 0.95 * Math.pow(1 - decayFactor, t);

    spendableMoney = Math.min(spendableMoney * (1 - pctReservedMoney), spendableMoney - absReservedMoney);
    if (spendableMoney <= 0.01)
        return setStatus(ns, prefix + 'all cash is currently reserved.');

    // Determine the most ram we can buy with this money
    let exponentLevel = 1;
    for (; exponentLevel < maxPurchasableServerRamExponent; exponentLevel++)
        if (ns.getPurchasedServerCost(Math.pow(2, exponentLevel + 1)) > spendableMoney)
            break;

    let maxRamPossibleToBuy = Math.pow(2, exponentLevel);

    // Abort if it would put us below our reserve (shouldn't happen, since we calculated how much to buy based on reserve amount)
    let cost = ns.getPurchasedServerCost(maxRamPossibleToBuy);
    if (spendableMoney < cost)
        return setStatus(ns, prefix + 'spendableMoney (' + formatMoney(spendableMoney) + ') is less than the cost (' + formatMoney(cost) + ')');

    if (exponentLevel < minRamExponent)
        return setStatus(ns, `${prefix}The highest ram exponent we can afford (2^${exponentLevel} for ${formatMoney(cost)}) on our budget of ${formatMoney(spendableMoney)} ` +
            `is less than the minimum ram exponent (2^${minRamExponent} for ${formatMoney(ns.getPurchasedServerCost(Math.pow(2, minRamExponent)))})'`);

    // Under some conditions, we consider the new server "not worthwhile". but only if it isn't the biggest possible server we can buy
    if (exponentLevel < maxPurchasableServerRamExponent - 1) { // -1 To give a buffer if we don't have SF5, because several bitnodes lower the max exponent by 1
        // Abort if our home server is more than x times bettter (rough guage of how much we 'need' Daemon RAM at the current stage of the game?)
        const homeThreshold = options['compare-to-home-threshold'];
        // Unless we're looking at buying the maximum purchasable server size - in which case we can do no better
        if (maxRamPossibleToBuy < ns.getServerMaxRam("home") * homeThreshold)
            return setStatus(ns, prefix + `the most RAM we can buy (${formatRam(maxRamPossibleToBuy)}) on our budget of ${formatMoney(spendableMoney)} is less than ${homeThreshold}x home RAM (${formatRam(ns.getServerMaxRam("home"))})`);
        // Abort if purchasing this server wouldn't improve our total RAM by more than x% (ensures we buy in meaningful increments)
        const networkThreshold = options['compare-to-network-ram-threshold'];
        if (maxRamPossibleToBuy / totalMaxRam < networkThreshold)
            return setStatus(ns, prefix + `the most RAM we can buy (${formatRam(maxRamPossibleToBuy)}) on our budget of ${formatMoney(spendableMoney)} is less than ${networkThreshold}x total network RAM (${formatRam(totalMaxRam)})`);
    }

    let maxPurchasableServerRam = Math.pow(2, maxPurchasableServerRamExponent)
    let worstServerName = null;
    let worstServerRam = maxPurchasableServerRam;
    let bestServerName = null;
    let bestServerRam = 0;
    for (const server of purchasedServers) {
        let ram = ns.getServerMaxRam(server);
        if (ram < worstServerRam) {
            worstServerName = server;
            worstServerRam = ram;
        }
        if (ram >= bestServerRam) {
            bestServerName = server;
            bestServerRam = ram;
        }
    }

    // Abort if our worst previously-purchased server is better than the one we're looking to buy (ensures we buy in sane increments of capacity)
    if (worstServerName != null && maxRamPossibleToBuy < worstServerRam && !options['allow-worse-purchases'])
        return setStatus(ns, prefix + 'the most RAM we can buy (' + formatRam(maxRamPossibleToBuy) +
            ') on our budget of ' + formatMoney(spendableMoney) + ' is less than our worst purchased server ' + worstServerName + '\'s RAM ' + formatRam(worstServerRam));
    // Only buy new servers as good as or better than our best bought server (anything less is deemed a regression in value)
    if (bestServerRam != null && maxRamPossibleToBuy < bestServerRam && !options['allow-worse-purchases'])
        return setStatus(ns, prefix + 'the most RAM we can buy (' + formatRam(maxRamPossibleToBuy) +
            ') on our budget of ' + formatMoney(spendableMoney) + ' is less than our previously purchased server ' + bestServerName + " RAM " + formatRam(bestServerRam));

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

    let purchasedServer = await getNsDataThroughFile(ns, `ns.purchaseServer('${purchasedServerName}', ${maxRamPossibleToBuy})`, '/Temp/purchase-server.txt');
    if (!purchasedServer)
        setStatus(ns, prefix + `Could not purchase a server with ${formatRam(maxRamPossibleToBuy)} RAM for ${formatMoney(cost)} ` +
            `with a budget of ${formatMoney(spendableMoney)}. This is either a bug, or we in a SF.9`);
    else
        log(ns, `SUCCESS: Purchased a new server ${purchasedServer} with ${formatRam(maxRamPossibleToBuy)} RAM for ${formatMoney(cost)}`, true, 'success');
}