import { getFilePath, getNsDataThroughFile, runCommand, formatRam } from './helpers.js'

/** @param {NS} ns
 * Remove the worst owned server respective of RAM */
export async function main(ns) {
    const purchasedServers = await getNsDataThroughFile(ns, 'ns.getPurchasedServers()', '/Temp/purchased-servers.txt');
    if (purchasedServers.length === 0)
        return ns.tprint("Nothing to delete - you have purchased no servers.");

    const minServer = purchasedServers.reduce((minServer, currServer) => {
        const currRam = ns.getServerMaxRam(currServer);
        return minServer.ram > currRam ? { name: currServer, ram: currRam } : minServer;
    }, { name: null, ram: Number.MAX_VALUE });

    if (!minServer.name)
        return ns.tprint(`Nothing to delete - all ${purchasedServers.length} servers have the maximum RAM (2^20 or ${formatRam(2 ** 20)})`);

    // Flag the server for deletion with a file - daemon should check for this and stop scheduling against it.
    await runCommand(ns, `await ns.scp("${getFilePath('/Flags/deleting.txt')}", ns.args[0])`, '/Temp/flag-server-for-deletion.js', [minServer.name]);
    const success = await getNsDataThroughFile(ns, `ns.deleteServer(ns.args[0])`, '/Temp/deleteServer.txt', [minServer.name]);
    if (success)
        ns.tprint(`Deleted ${minServer.name} which had ${formatRam(minServer.ram)} of RAM (${purchasedServers.length - 1} servers remaining).`);
    else
        ns.tprint(`Waiting to delete ${minServer.name} (${formatRam(minServer.ram)} of RAM) - scripts are still running...`);
}