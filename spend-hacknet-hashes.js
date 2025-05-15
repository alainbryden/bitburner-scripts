import { log as log_helper, getConfiguration, disableLogs, formatMoney, formatDuration, formatNumberShort, getErrorInfo } from './helpers.js'

const sellForMoney = 'Sell for Money';

const argsSchema = [
    ['l', false], // Spend hashes as soon as we can afford any --spend-on purchase item. Otherwise, only spends when nearing capacity.
    ['liquidate', false], // Long-form of above flag
    ['interval', 50], // (milliseonds) Interval at which the program wakes up to spends hashes
    ['spend-on', [sellForMoney]], // One or more actions to spend hashes on.
    ['spend-on-server', null], // The server to boost, for spend options that take a server argument: 'Reduce Minimum Security' and 'Increase Maximum Money'
    ['no-capacity-upgrades', false], // By default, we will attempt to upgrade the hacknet node capacity if we cannot afford any purchases. Set to true to disable this.
    ['reserve', null], // The amount of player money to leave unpent when considering buying capacity upgrades (defaults to the amount in reserve.txt on home)
    ['ignore-reserve-if-upgrade-cost-less-than-pct', 0.01], // Hack to purchase capacity upgrades regardless of the curent global reserve if they cost less than this fraction of player money
    ['reserve-buffer', 1], // To avoid wasting hashes, spend if would be within this many hashes of our max capacity on the next tick.
    ['max-purchases-per-loop', 10000], // When we're producing hashes faster than we can spend them, this keeps things from getting hung up
];

const basicSpendOptions = ['Sell for Money', 'Generate Coding Contract', 'Improve Studying', 'Improve Gym Training',
    'Sell for Corporation Funds', 'Exchange for Corporation Research', 'Exchange for Bladeburner Rank', 'Exchange for Bladeburner SP'];
const parameterizedSpendOptions = ['Reduce Minimum Security', 'Increase Maximum Money'];
const purchaseOptions = basicSpendOptions.concat(parameterizedSpendOptions);
const minTimeBetweenToasts = 5000; // milleconds. If we start buying a lot of things, throttle toast notifications.

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
    const maxPurchasesPerLoop = options['max-purchases-per-loop'];
    // Validate arguments
    if (toBuy.length == 0)
        return log(ns, "ERROR: You must specify at least one thing to spend hashes on via the --spend-on argument.", true, 'error');
    const unrecognized = toBuy.filter(p => !purchaseOptions.includes(p));
    if (unrecognized.length > 0)
        return log(ns, `ERROR: One or more --spend-on arguments are not recognized: ${unrecognized.join(", ")}`, true, 'error');
    // Operate in "low-priority" mode if our only job is to sell for money when nearing our hash capacity
    const lowPriority = !liquidate && toBuy.length == 1 && toBuy[0] == sellForMoney;

    disableLogs(ns, ['sleep', 'getServerMoneyAvailable']);
    ns.print(`Starting spend-hacknet-hashes.js... Will check in every ${formatDuration(interval)}`);
    ns.print(liquidate ? `-l --liquidate mode active! Will spend all hashes as soon as possible.` :
        `Saving up hashes, only spending hashes when near capacity to avoid wasting them.`);

    // Set up a helper to log but limit how often we generate a toast notification when making many purchases in a short time
    let lastToast = 0; // Last time we generated a toast notification about a successful purchase
    function log(ns, message, printToTerminal, toastStyle, maxLength) {
        if (toastStyle != undefined) {
            const shouldToast = Date.now() - lastToast > minTimeBetweenToasts;
            if (shouldToast)
                lastToast = Date.now();
            else
                toastStyle = undefined;
        }
        log_helper(ns, message, printToTerminal, toastStyle, maxLength);
    }


    let lastHashBalance = -1; // Balance of hashes last time we woke up. If unchanged, we go back to sleep quickly (game hasn't ticked)
    let notifiedMaxCapacity = false; // Flag indicating we've maxed our hash capacity, to avoid repeatedly logging this fact.
    // Function determines the current cheapest upgrade of all the upgrades we wish to keep purchasing
    const getMinCost = spendActions => Math.min(...spendActions.map(p => ns.hacknet.hashCost(p)));
    // Helper to format hashes in log message
    const formatHashes = (hashes) => formatNumberShort(hashes, 6, 3);
    while (true) {
        await ns.sleep(interval);
        if (lowPriority && ns.hacknet.numHashes() > 0) // Low priority mode means any competing scripts should get to spend hashes first.
            await ns.sleep(interval); // Yeild for an additional interval to give competing scripts a chance to spend first. 
        try {
            let capacity = ns.hacknet.hashCapacity() || 0;
            let currentHashes = ns.hacknet.numHashes();
            // Go back to sleep if the game hasn't ticket yet (given us more hashes) since our last loop.
            if (lastHashBalance != capacity && lastHashBalance == currentHashes) continue;
            //log(ns, `INFO: Waking up, last hash balance has changed from ${lastHashBalance} to ${currentHashes}`);
            // Compute the total income rate of all hacknet nodes. We have to spend faster than this when near capacity.
            const nodes = ns.hacknet.numNodes();
            if (nodes == 0) {
                log(ns, 'WARN: Hacknet is empty, no hashes to spend yet...');
                continue; // Nothing to do until at least one node is purchased.
            } else if (capacity == 0)
                return log(ns, 'INFO: You have hacknet nodes, not hacknet servers, so spending hashes is not applicable.');
            // Helper function to get total hash production across all nodes
            let globalProduction = Array.from({ length: nodes }, (_, i) => ns.hacknet.getNodeStats(i))
                .reduce((total, node) => total + node.production, 0);
            const hashesEarnedNextTick = globalProduction * interval / 1000 + options['reserve-buffer']; // If we are this far from our capacity, start spending
            let purchasesThisLoop = 0;
            // Define the spend hash loop as a local function, since we may need to call it twice.
            const fnSpendHashes = async (purchases, spendAllHashes) => {
                const startingHashes = ns.hacknet.numHashes() || 0;
                capacity = ns.hacknet.hashCapacity() || 0;
                // Spend every hash we can if so instructed, otherwise, spend only hashes that would be wasted on next tick.
                let maxHashSpend = () => ns.hacknet.numHashes() - (spendAllHashes ? 0 : Math.max(0, capacity - hashesEarnedNextTick));
                let lastPurchaseSucceeded = true; // Additional mechanism to break out of the while loop if any purchase fails
                // Make purchases in a loop until we hit our purchase-per-loop limit, or we've spent enough to avoid hashes being wasted next tick
                while (lastPurchaseSucceeded && purchasesThisLoop < maxPurchasesPerLoop && getMinCost(purchases) <= maxHashSpend()) {
                    lastPurchaseSucceeded = false; // Safety mechanism to avoid looping if we don't enter the for-loop below for some reason
                    // Loop over all requested purchases and try to buy each one once (TODO: Figure out in advance how many we can buy of each and buy in bulk)
                    for (const spendAction of purchases) {
                        const cost = ns.hacknet.hashCost(spendAction); // What's the cost of making this purchase
                        const budget = maxHashSpend();
                        if (cost > budget) continue; // Skip this purchase if if costs more than we have left
                        const quantity = spendAction == sellForMoney ? Math.floor(budget / cost) : 1; // We can easily buy money in bulk, because the cost doesn't scale.
                        const totalCost = cost * quantity;
                        lastPurchaseSucceeded = ns.hacknet.spendHashes(spendAction, parameterizedSpendOptions.includes(spendAction) ? spendOnServer : undefined, quantity);
                        if (!lastPurchaseSucceeded) { // Note: Even if we had enough hashes, we may fail if another script spends them first
                            log(ns, `WARN: Failed to spend hashes on ${quantity}x '${spendAction}'. Cost was: ${formatHashes(totalCost)} of ${formatHashes(budget)} ` +
                                `budgeted hashes. Have: ${formatHashes(ns.hacknet.numHashes())} of ${formatHashes(capacity)} (capacity) hashes.`);
                            break; // Break out of for-loop (should also break out of the while since lastPurchaseSucceeded == false)
                        }
                        purchasesThisLoop++;
                        if (purchasesThisLoop < 10) { // If we purchase more than 10 things, don't even bother logging each one, it'll slow us down
                            log(ns, `SUCCESS: ${purchasesThisLoop == 1 ? '' : `(${purchasesThisLoop}) `}Spent ${formatHashes(totalCost)} hashes on ` +
                                `${quantity}x '${spendAction}'. Next upgrade will cost ${formatHashes(ns.hacknet.hashCost(spendAction))}.`, false, 'success');
                        }
                        if (purchasesThisLoop % 100 == 0)
                            await ns.sleep(1); // Periodically yield to the game briefly if we're making many purchases at once.
                    }
                }
                if (purchasesThisLoop > 10)
                    log(ns, `SUCCESS: Made ${purchasesThisLoop} purchases this loop (but silenced logs to speed things up)`);
                if (ns.hacknet.numHashes() < startingHashes)
                    log(ns, `INFO: Summary: Spent ${formatHashes(startingHashes - ns.hacknet.numHashes())} hashes on ${purchasesThisLoop} purchases ` +
                        (spendAllHashes ? '' : `to avoid reaching capacity (${formatHashes(capacity)}) `) + `while earning ${formatHashes(globalProduction)} hashes per second.`);
            };
            // Spend hashes normally on any/all user-specified purchases
            await fnSpendHashes(toBuy, liquidate);
            currentHashes = lastHashBalance = ns.hacknet.numHashes();

            // Determine if we should try to upgrade our hacknet capacity
            const remaining = capacity - currentHashes;
            let capacityMessage;
            if (getMinCost(toBuy) > capacity - options['reserve-buffer'])
                capacityMessage = `Our hash capacity is ${formatHashes(capacity)}, but the cheapest upgrade we wish to purchase ` +
                    `costs ${formatHashes(getMinCost(toBuy))} hashes. A capacity upgrade is needed before any more upgrades can be purchased (${toBuy.join(", ")})`;
            else if (hashesEarnedNextTick > capacity)
                capacityMessage = `We're earning hashes faster than we can spend them (${formatHashes(globalProduction)} hashes/sec > capacity: ${formatHashes(capacity)}).`;
            else if (remaining < hashesEarnedNextTick)
                capacityMessage = `We're still at or near our hash capacity (${formatHashes(capacity)}) after spending hashes as instructed. ` +
                    `We currently have ${formatHashes(currentHashes)} hashes. This means we are ${formatHashes(remaining)} hashes ` +
                    `from capacity, but were only looking to reserve ${formatHashes(hashesEarnedNextTick)} hashes (earning ${formatHashes(globalProduction)} hashes/sec).`;
            else
                continue; // Current hash capacity suffices, go back to sleep

            // If we aren't allowed to purchase capacity upgrades by configuration (or can't afford it),
            // we may need to warn the player via toast notification so that they can intervene.
            // Don't create a toast notification unless we're nearing our capacity limit and at risk of wasting hashes.
            const warnToast = remaining < hashesEarnedNextTick ? 'warning' : undefined;
            if (options['no-capacity-upgrades']) { // If we aren't allowed to purchase capacity upgrades by configuration, warn the user so they can intervene
                log(ns, `WARNING: Upgrade your hacknet cache! spend-hacknet-hashes.js --no-capacity-upgrades is set, ` +
                    `so we cannot increase our hash capacity. ${capacityMessage}`, false, warnToast);
            } else { // Otherwise, try to upgrade hacknet capacity so we can save up for more upgrades
                if (!notifiedMaxCapacity) // Log that we want to increase hash capacity (unless we've previously seen that we are maxed out)
                    log(ns, `INFO: ${capacityMessage}`);
                let lowestLevel = Number.MAX_SAFE_INTEGER, lowestIndex = null;
                for (let i = 0; i < nodes; i++)
                    if (ns.hacknet.getNodeStats(i).hashCapacity < lowestLevel)
                        lowestIndex = i, lowestLevel = ns.hacknet.getNodeStats(i).hashCapacity;
                const nextCacheUpgradeCost = lowestIndex == null ? Number.POSITIVE_INFINITY : ns.hacknet.getCacheUpgradeCost(lowestIndex, 1);
                const nextNodeCost = ns.hacknet.getPurchaseNodeCost();
                const reservedMoney = options['reserve'] ?? Number(ns.read("reserve.txt") || 0);
                const playerMoney = ns.getServerMoneyAvailable('home');
                const spendableMoney = Math.max(0, playerMoney - reservedMoney,
                    // Hack: Because managing global reserve is tricky. We tend to always want to purchase cheap upgrades
                    playerMoney * options['ignore-reserve-if-upgrade-cost-less-than-pct']);
                // If it's cheaper to buy a new hacknet node than to upgrade the cache of an existing one, do so
                if (nextNodeCost < nextCacheUpgradeCost && nextNodeCost < spendableMoney) {
                    if (ns.hacknet.purchaseNode())
                        log(ns, `SUCCESS: spend-hacknet-hashes.js spent ${formatMoney(nextNodeCost)} to purchase a new hacknet node ${nodes + 1} ` +
                            `in order to increase hash capacity and afford further purchases (${toBuy.join(", ")}). (You can disable this with --no-capacity-upgrades)`, false, 'success');
                    else
                        log(ns, `WARNING: spend-hacknet-hashes.js attempted to spend ${formatMoney(nextNodeCost)} to purchase hacknet node ${nodes + 1}, ` +
                            `but the purchase failed for an unknown reason (despite appearing to have ${formatMoney(spendableMoney)} to spend after reserves.)`, false, 'warning');
                } // Otherwise, try upgrading the cache level of an existing hash node 
                else if (lowestIndex !== null && nextCacheUpgradeCost < spendableMoney) {
                    if (ns.hacknet.upgradeCache(lowestIndex, 1))
                        log(ns, `SUCCESS: spend-hacknet-hashes.js spent ${formatMoney(nextCacheUpgradeCost)} to upgrade hacknet node ${lowestIndex} hash capacity ` +
                            `in order to afford further purchases (${toBuy.join(", ")}). (You can disable this with --no-capacity-upgrades)`, false, 'success');
                    else
                        log(ns, `WARNING: spend-hacknet-hashes.js attempted to spend ${formatMoney(nextCacheUpgradeCost)} to upgrade hacknet node ${lowestIndex} hash capacity, ` +
                            `but the purchase failed for an unknown reason (despite appearing to have ${formatMoney(spendableMoney)} to spend after reserves.)`, false, 'warning');
                } else if (nodes > 0) {
                    // Prepare a message about our inability to upgrade hash capacity
                    let message = `Cannot upgrade hash capacity (currently ${formatHashes(capacity)} hashes max). `;
                    const nextCheapestCacheIncreaseCost = Math.min(nextCacheUpgradeCost, nextNodeCost);
                    const nextCheapestCacheIncrease = nextNodeCost < nextCacheUpgradeCost ? `buy hacknet node ${nodes + 1}` : `upgrade hacknet node ${lowestIndex} hash capacity`;
                    if (!Number.isFinite(nextCheapestCacheIncreaseCost))
                        message += `Hash Capacity is at its maximum and hacknet server limit is reached.`;
                    else
                        message += ` We cannot afford to increase our hash capacity (${formatMoney(nextCheapestCacheIncreaseCost)} to ${nextCheapestCacheIncrease}).` +
                            (playerMoney < nextCheapestCacheIncreaseCost ? '' : // Don't bother mentioning budget if the cost exceeds all player money
                                `on our budget of ${formatMoney(spendableMoney)}` + (reservedMoney > 0 ? ` (after respecting reserve of ${formatMoney(reservedMoney)}).` : '.'));
                    // Include in the message information about what we are trying to spend hashes on
                    const nextPurchaseCost = getMinCost(toBuy);
                    if (nextPurchaseCost > capacity)
                        message += ` We have insufficient hashes to buy any of the desired upgrades (${toBuy.join(", ")}) at our current hash capacity. ` +
                            `The next cheapest purchase costs ${formatHashes(nextPurchaseCost)} hashes.`;
                    // If we don't have the budget for the upgrade, toast a warning so the user can decide whether they think it worth manually intervening
                    if (Number.isFinite(nextCheapestCacheIncreaseCost)) {
                        if (playerMoney > nextCheapestCacheIncreaseCost)
                            message += ' Feel free to manually purchase this upgrade (despite the reserve/budget) if you deem it worthwhile.'
                        log(ns, `WARNING: spend-hacknet-hashes.js ${message}`, false, warnToast);

                    } else if (nextPurchaseCost > capacity) // If we can't afford anything, and have maxed our hash capacity, we may as well shut down.
                        return log(ns, `SUCCESS: We've maxed all purchases. ${message}`); // Shut down, because we will never be able to buy anything further.
                    else if (!notifiedMaxCapacity) { // The first time we discover we are at max hash capacity (infinite cost) notify the user
                        log(ns, `INFO: spend-hacknet-hashes.js ${message}`, true, 'info'); // Only inform the user of this the first time it happens.
                        notifiedMaxCapacity = true; // Set the flag to avoid repeated notifications
                    }
                }
            }
            // If for any of the above reasons, we weren't able to upgrade capacity, calling 'SpendHashes' once more
            // with these arguments will only convert enough hashes to money to ensure they aren't wasted before the next tick.
            purchasesThisLoop = 0;
            await fnSpendHashes([sellForMoney], false);
            currentHashes = lastHashBalance = ns.hacknet.numHashes();
        }
        catch (err) {
            log(ns, `WARNING: spend-hacknet-hashes.js Caught (and suppressed) an unexpected error in the main loop:\n` +
                getErrorInfo(err), false, 'warning');
        }
    }
}
