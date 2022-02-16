import { formatMoney, formatRam } from './helpers.js'

let options;
const argsSchema = [
    ['budget', 0.1], // Spend up to this much of current cash on augs per tick (Default is high, because these are permanent for the rest of the BN)
    ['reserve', null], // Reserve this much cash before determining spending budgets (defaults to contents of reserve.txt if not specified)
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    options = ns.flags(argsSchema);
    const reserve = (options['reserve'] != null ? options['reserve'] : Number(ns.read("reserve.txt") || 0));
    const money = ns.getServerMoneyAvailable("home");
    let spendable = Math.min(money - reserve, money * options.budget);
    while (true) {
        let cost = ns.getUpgradeHomeRamCost();
        let currentRam = ns.getServerMaxRam("home");
        if (cost >= Number.MAX_VALUE)
            return ns.print(`We're at max home RAM (${formatRam(currentRam)})`);
        const nextRam = currentRam * 2;
        const upgradeDesc = `home RAM from ${formatRam(currentRam)} to ${formatRam(nextRam)}`;
        if (spendable < cost)
            return ns.print(`Money we're allowed to spend (${formatMoney(spendable)}) is less than the cost (${formatMoney(cost)}) to upgrade ${upgradeDesc}`);
        if (ns.upgradeHomeRam()) {
            announce(ns, `SUCCESS: Upgraded ${upgradeDesc}`, 'success');
            if (nextRam != ns.getServerMaxRam("home"))
                announce(ns, `WARNING: Expected to upgrade ${upgradeDesc}, but new home ram is ${formatRam(ns.getServerMaxRam("home"))}`, 'warning');
            else { // Only loop again if we successfully upgraded home ram, to see if we can upgrade further
                spendable -= cost;
                continue;
            }
        } else {
            announce(ns, `ERROR: Failed to upgrade ${upgradeDesc} thinking we could afford it (cost: ${formatMoney(cost)} cash: ${formatMoney(money)} budget: ${formatMoney(spendable)})`, 'error');
        }
        await ns.sleep(1000);
        break;
    }
}

function announce(ns, message, toastStyle) {
    ns.print(message);
    ns.tprint(message);
    if (toastStyle) ns.toast(message, toastStyle);
}