/** @param {NS} ns 
 * Wait until an appointed time and then execute a manual hack. */
export async function main(ns) {
    //args[0: target, 1: desired start time, 2: expected end, 3: expected duration, 4: description, 5: manipulate stock (N/A ignored), 6: disable toast warnings, 7: loop]
    const sleepDuration = ns.args.length > 1 ? ns.args[1] - Date.now() : 0;
    const expectedDuration = ns.args.length > 3 ? ns.args[3] : 0;
    const manipulateStock = ns.args.length > 5 && ns.args[5] ? true : false;
    const disableToastWarnings = ns.args.length > 6 ? ns.args[6] : false;
    const loop = ns.args.length > 7 ? ns.args[7] : false;
    let cycleTime = expectedDuration * 4;
    if (cycleTime < 100) cycleTime = Math.max(1, Math.min(5, cycleTime * 2)); // For fast hacking loops, inject a delay on hack in case grow/weaken are running a bit slow.
    if (sleepDuration > 0)
        await ns.sleep(sleepDuration);
    do {
        if (!await ns.singularity.manualHack() && !disableToastWarnings)
            ns.toast(`Warning, hack stole 0 money. Might be a misfire. ${JSON.stringify(ns.args)}`, 'warning');
        if (loop) await ns.sleep(cycleTime - expectedDuration);
    } while (loop);
}