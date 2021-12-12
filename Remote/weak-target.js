// the purpose of weak-target is to wait until an appointed time and then execute a weaken.
export async function main(ns) {
    let sleepDuration = ns.args[1] - Date.now();
    if (sleepDuration > 0)
        await ns.sleep(sleepDuration);
    if (!await ns.weaken(ns.args[0]))
        ns.toast(`Warning, weaken reduced 0 security. Might be a misfire. ${JSON.stringify(ns.args)}`, 'warning');
}