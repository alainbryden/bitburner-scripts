import { scanAllServers } from './helpers.js'

// the purpose of cascade kill is to kill all scripts running on any server in the game
// but saving the host that you run it on for last (so that it doesn't kill itself prematurely)
/** @param {NS} ns **/
export async function main(ns) {
    var startingNode = ns.getHostname();
    const serverList = scanAllServers(ns);

    // Send the kill command to all servers
    for (const server of serverList) {
        // skip if this host, we save it for last
        if (server == startingNode)
            continue;

        // skip if not running anything
        if (ns.ps(server) === 0)
            continue;

        // kill all scripts
        ns.killall(server);
    }

    // idle for things to die
    for (const server of serverList) {
        // skip if this host, we save it for last
        if (server == startingNode)
            continue;
        // idle until they're dead, this is to avoid killing the cascade before it's finished.
        while (ns.ps(server) > 0) {
            await ns.sleep(20);
        }
        // Remove script files the daemon would have copied over (in case we update the source)
        for (let file of ns.ls(server, '.js'))
            ns.rm(file, server)
    }

    // wait to kill these. This kills itself, obviously.
    ns.killall(startingNode);
}