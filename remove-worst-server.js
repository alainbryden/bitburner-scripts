import { getNsDataThroughFile, runCommand } from './helpers.js'

/** @param {NS} ns 
 *  Remove the worst server we own (RAM) **/
export async function main(ns) {
    let worstServerName = null;
    let worstServerRam = Math.pow(2, 20);
    let purchasedServers = await getNsDataThroughFile(ns, 'ns.getPurchasedServers()', '/Temp/purchased-servers.txt');
    if (purchasedServers.length == 0) {
        ns.tprint("Nothing to delete - you have purchased no servers.");
        return;
    }
    purchasedServers.forEach(serverName => {
        let ram = ns.getServerMaxRam(serverName);
        if (ram < worstServerRam) {
            worstServerName = serverName;
            worstServerRam = ram;
        }
    });
    if (worstServerName == null) {
        ns.tprint("Nothing to delete - all " + purchasedServers.length + " servers have the maximum " + worstServerRam + " GB of RAM");
        return;
    }
    // Flag the server for deletion with a file - daemon should check for this and stop scheduling against it.
    await runCommand(ns, `await ns.scp("/Flags/deleting.txt", "${worstServerName}")`, '/Temp/flag-server-for-deletion.js');
    var success = await getNsDataThroughFile(ns, `ns.deleteServer("${worstServerName}")`, '/Temp/try-delete-server-result.txt');
    if (success)
        ns.tprint("Deleted " + worstServerName + " which had only " + worstServerRam + " GB of RAM. " + (purchasedServers.length - 1) + " servers remain.");
    else
        ns.tprint("Tried to delete " + worstServerName + " with " + worstServerRam + " GB RAM, but it failed (scripts still running)");
}