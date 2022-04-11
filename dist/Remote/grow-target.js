/** @param {NS} ns 
 * Wait until an appointed time and then execute a grow. */
export async function main(ns) {
    //args[0: target, 1: desired start time, 2: expected end, 3: expected duration, 4: description, 5: manipulate stock, 6: loop]
    const sleepDuration = ns.args.length > 1 ? ns.args[1] - Date.now() : 0;
    const expectedDuration = ns.args.length > 3 ? ns.args[3] : 0;
    const manipulateStock = ns.args.length > 5 && ns.args[5] ? true : false;
    const loop = ns.args.length > 6 ? ns.args[6] : false;
    const cycleTime = expectedDuration / 3.2 * 4;
    if (sleepDuration > 0)
        await ns.sleep(sleepDuration);
    do {
        await ns.grow(ns.args[0], { stock: manipulateStock });
        if (loop) await ns.sleep(cycleTime - expectedDuration);
    } while (loop);
}