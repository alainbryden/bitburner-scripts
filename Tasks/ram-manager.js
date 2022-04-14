import { formatMoney, formatRam } from './helpers.js'

const max_ram = 2 ** 30;
const argsSchema = [
    ['budget', 0.2], // Spend up to this much of current cash on ram upgrades per tick (Default is high, because these are permanent for the rest of the BN)
    ['reserve', null], // Reserve this much cash before determining spending budgets (defaults to contents of reserve.txt if not specified)
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = ns.flags(argsSchema);
    const reserve = (options['reserve'] != null ? options['reserve'] : Number(ns.read("reserve.txt") || 0));
    const money = ns.getServerMoneyAvailable("home");
    let spendable = Math.min(money - reserve, money * options.budget);
    // Quickly buy as many upgrades as we can within the budget
    do {
        let cost = ns.getUpgradeHomeRamCost();
        let currentRam = ns.getServerMaxRam("home");
        if (cost >= Number.MAX_VALUE || currentRam == max_ram)
            return ns.print(`We're at max home RAM (${formatRam(currentRam)})`);
        const nextRam = currentRam * 2;
        const upgradeDesc = `home RAM from ${formatRam(currentRam)} to ${formatRam(nextRam)}`;
        if (spendable < cost)
            return ns.print(`Money we're allowed to spend (${formatMoney(spendable)}) is less than the cost (${formatMoney(cost)}) to upgrade ${upgradeDesc}`);
        if (!ns.upgradeHomeRam())
            return announce(ns, `ERROR: Failed to upgrade ${upgradeDesc} thinking we could afford it ` +
                `(cost: ${formatMoney(cost)} cash: ${formatMoney(money)} budget: ${formatMoney(spendable)})`, 'error');
        // Otherwise, we've successfully upgraded home ram.
        announce(ns, `SUCCESS: Upgraded ${upgradeDesc}`, 'success');
        if (nextRam != ns.getServerMaxRam("home"))
            announce(ns, `WARNING: Expected to upgrade ${upgradeDesc}, but new home ram is ${formatRam(ns.getServerMaxRam("home"))}`, 'warning');
        // Only loop again if we successfully upgraded home ram, to see if we can upgrade further
        spendable -= cost;
        await ns.sleep(100); // On the off-chance we have an infinite loop bug, this makes us killable.
    } while (spendable > 0)
}

function announce(ns, message, toastStyle) {
    ns.print(message);
    ns.tprint(message);
    if (toastStyle) ns.toast(message, toastStyle);
}