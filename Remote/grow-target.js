/** @param {NS} ns 
 * the purpose of grow-target is to wait until an appointed time and then execute a grow. b*/
export async function main(ns) {
    const sleepDuration = ns.args.length > 1 ? ns.args[1] - Date.now() : 0;
    const manipulateStock = ns.args.length > 5 && ns.args[5] ? true : false;
    if (sleepDuration > 0)
        await ns.sleep(sleepDuration);
    await ns.grow(ns.args[0], { stock: manipulateStock });
}