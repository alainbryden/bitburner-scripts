import { getNsDataThroughFile, runCommand } from './helpers.js'

/** 
 * Remove the worst owned server respective of RAM
 * @param {NS} ns
 **/
export async function main(ns) {
    const purchasedServers = await getNsDataThroughFile(ns, 'ns.getPurchasedServers()', '/Temp/purchased-servers.txt');
    if (purchasedServers.length === 0)
        return ns.tprint("Nothing to delete - you have purchased no servers.");

    const minServer = purchasedServers.reduce((minServer, currServer) => {
        const currRam = ns.getServerMaxRam(currServer);
        return minServer.ram > currRam ? { name: currServer, ram: currRam } : minServer;
    }, { name: "", ram: 2 ** 20 });

    if (!minServer.name)
        return ns.tprint(`Nothing to delete - all ${purchasedServers.length} servers have the maximum RAM (${2 ** 20} GB)`);

    // Flag the server for deletion with a file - daemon should check for this and stop scheduling against it.
    await runCommand(ns, `await ns.scp("/Flags/deleting.txt", "${minServer.name}")`, '/Temp/flag-server-for-deletion.js');
    const success = await getNsDataThroughFile(ns, `ns.deleteServer("${minServer.name}")`, '/Temp/try-delete-server-result.txt');
    if (success)
        ns.tprint(`Deleted ${minServer.name} which had ${minServer.ram} GB of RAM (${purchasedServers.length - 1} servers remaining).`);
    else
        ns.tprint(`Failed to delete ${minServer.name} (${minServer.ram} GB of RAM) - scripts are likely still running`);
}
