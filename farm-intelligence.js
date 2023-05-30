import { log, waitForProcessToComplete, formatDuration, getFilePath } from './helpers.js'

/** @param {NS} ns */
export async function main(ns) {
    const timeSinceLastAug = Date.now() - ns.getResetInfo().lastAugReset;
    if (timeSinceLastAug > 20 * 60 * 1000) {
        return log(ns, `WARNING: It's been ${formatDuration(timeSinceLastAug)} since your last reset. ` +
            `For your protection, we will not soft-reset. Either install augs or soft-reset manually ` +
            `once before running this script.`, true);
    } else if (timeSinceLastAug > 5000) {
        log(ns, `Resetting to get a list of instantly-available invites...`, true);
        return ns.singularity.softReset(ns.getScriptName());
    }
    const invites = ns.singularity.checkFactionInvitations();
    if (invites.length < 10)
        return log(ns, `WARNING: You only have invites to join ${invites.length} factions. ` +
            `For best results, you should get invited to all 10 megacorp factions before running this script. ` +
            `You can achieve this by running:\n` +
            `run work-for-factions.js --get-invited-to-every-faction --invites-only \n` +
            `or just edit out this check if you're sure you want to proceed.`, true);
    await waitForProcessToComplete(ns, ns.run(getFilePath('cleanup.js')));
    // Prepare a very small script that will accept all invites in a tight loop.
    const tempFile = '/Temp/farm-intelligence.js';
    await ns.write(tempFile, `export async function main(ns) {
        ns.disableLog('ALL');
        ${JSON.stringify(ns.singularity.checkFactionInvitations())}.forEach(f => ns.singularity.joinFaction(f));
        ns.singularity.softReset('${tempFile}');
    }`, "w");
    ns.run(tempFile);
    log(ns, `SUCCESS: Beginning soft-reset loop. It may look like nothing's happening, but watch your intelligence stat...`, true, 'success');
}