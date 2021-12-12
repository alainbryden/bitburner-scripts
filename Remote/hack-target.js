/** @param {NS} ns 
 * The purpose of hack-target is to wait until an appointed time and then execute a hack. */
export async function main(ns) {
    const sleepDuration = ns.args.length > 1 ? ns.args[1] - Date.now() : 0;
    const manipulateStock = ns.args.length > 5 && ns.args[5] ? true : false;
    const disableToastWarnings = ns.args.length > 6 ? ns.args[6] : false;
    if (sleepDuration > 0)
        await ns.sleep(sleepDuration);
    if (!await ns.hack(ns.args[0], { stock: manipulateStock }) && !disableToastWarnings)
        ns.toast(`Warning, hack stole 0 money. Might be a misfire. ${JSON.stringify(ns.args)}`, 'warning');
}