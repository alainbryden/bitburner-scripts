import { getNsDataThroughFile } from './helpers.js'

let spawnDelay = 50; // Delay to allow time for `installBackdoor` to start running before a background script connects back to 'home'

/** @param {NS} ns 
 * Scan all servers, backdoor anything that can be backdoored, and leave a file to indicate it's been done
 * Requires: SF-4.1 **/
export let main = async ns => {
    let anyConnected = false;
    try {
        let servers = ["home"],
            routes = { home: ["home"] },
            myHackingLevel = ns.getHackingLevel();
        // Scan all servers and keep track of the path to get to them
        ns.disableLog("scan");
        for (let i = 0, j; i < servers.length; i++)
            for (j of ns.scan(servers[i]))
                if (!servers.includes(j)) servers.push(j), routes[j] = routes[servers[i]].slice(), routes[j].push(j);
        // Filter out servers that cannot or should not be hacked / backdoored
        ns.disableLog("getServerRequiredHackingLevel");
        let hackableServers = servers.filter(s => s != "home" && !s.includes("hacknet-") && !s.includes("daemon")) /*or whatever you name your purchased servers*/
        ns.print(`${hackableServers.length} not-owned servers on the network.`);
        ns.print(`${hackableServers.filter(s => ns.hasRootAccess(s)).length} servers are currently rooted.`);
        ns.print(`${hackableServers.filter(s => myHackingLevel > ns.getServerRequiredHackingLevel(s)).length} servers are within our hack level (${myHackingLevel}).`);
        ns.print(`${hackableServers.filter(s => myHackingLevel > ns.getServerRequiredHackingLevel(s) && ns.hasRootAccess(s)).length} rooted servers are within our hack level (${myHackingLevel})`);

        let toBackdoor = await getNsDataThroughFile(ns, `${JSON.stringify(hackableServers)}.filter(s => !ns.getServer(s).backdoorInstalled)`, '/Temp/servers-to-backdoor.txt');
        let count = toBackdoor.length;
        ns.print(`${count} servers have yet to be backdoored.`);
        if (count == 0) return;

        ns.print(`${toBackdoor.filter(s => ns.hasRootAccess(s)).length} of ${count} servers to backdoor are currently rooted.`);
        toBackdoor = toBackdoor.filter(s => myHackingLevel > ns.getServerRequiredHackingLevel(s));
        ns.print(`${toBackdoor.length} of ${count} servers to backdoor are within our hack level (${myHackingLevel}).`);
        toBackdoor = toBackdoor.filter(s => ns.hasRootAccess(s));
        ns.print(`${toBackdoor.length} of ${count} servers to be backdoored are rooted and within our hack level (${myHackingLevel})`);

        for (const server of toBackdoor) {
            ns.print(`Hopping to ${server}`);
            anyConnected = true;
            for (let hop of routes[server])
                ns.connect(hop);
            if (server === "w0r1d_d43m0n") {
                ns.alert("Ready to hack w0r1d_d43m0n!");
                while (true) await ns.sleep(10000); // Sleep forever so the script isn't run multiple times to create multiple overlapping alerts
            }
            ns.print(`Installing backdoor on "${server}"...`);
            // Kick off a separate script that will run backdoor before we connect to home.
            var pid = ns.run('/Tasks/backdoor-all-servers.js.backdoor-one.js', 1, server);
            if (pid === 0)
                return ns.print(`Couldn't initiate a new backdoor of "${server}"" (insufficient RAM?). Will try again later.`);
            await ns.sleep(spawnDelay); // Wait some time for the external backdoor script to initiate its backdoor of the current connected server
            ns.connect("home");
        }
    } catch (err) {
        ns.tprint(String(err));
    } finally {
        if (anyConnected)
            ns.connect("home");
    }
};