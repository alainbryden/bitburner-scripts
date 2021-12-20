/** @param {NS} ns 
 * Wait until an appointed time and then execute a weaken. */
export async function main(ns) {
    //args[0: target, 1: desired start time, 2: expected end, 3: expected duration, 4: description, 5: disable toast warnings, 6: loop]
    let sleepDuration = ns.args[1] - Date.now();
    const disableToastWarnings = ns.args.length > 5 ? ns.args[5] : false;
    const loop = ns.args.length > 6 ? ns.args[6] : false;
    if (sleepDuration > 0)
        await ns.sleep(sleepDuration);
    do {
        if (!await ns.weaken(ns.args[0]) && !disableToastWarnings)
            ns.toast(`Warning, weaken reduced 0 security. Might be a misfire. ${JSON.stringify(ns.args)}`, 'warning');
    } while (loop);
}