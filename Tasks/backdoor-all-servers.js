import { getNsDataThroughFile, getFilePath, instanceCount, log, getErrorInfo } from '../helpers.js'

const spawnDelay = 50; // Delay to allow time for `installBackdoor` to start running before a background script connects back to 'home'

/** Scan all servers, backdoor anything that can be backdoored, and leave a file to indicate it's been done
 * Requires: SF-4.1 **/
/** @param {NS} ns **/
export async function main(ns) {
    let notAtHome = false;
    try {
        // Prevent multiple instances of this script from being started
        if (await instanceCount(ns, "home", false, false) > 1)
            return log(ns, 'Another instance is already running. Shutting down...');

        let servers = ["home"];
        let routes = { home: ["home"] };
        let myHackingLevel = ns.getHackingLevel();
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

        let toBackdoor = await getNsDataThroughFile(ns, `ns.args.filter(s => !ns.getServer(s).backdoorInstalled)`, '/Temp/servers-to-backdoor.txt', hackableServers);
        let count = toBackdoor.length;
        // Early exit condition if there are no servers left to backdoor
        ns.print(`${count} servers have yet to be backdoored.`);
        if (count == 0) return;

        // Early exit condition if there are no servers we can currently backdoor
        ns.print(`${toBackdoor.filter(s => ns.hasRootAccess(s)).length} of ${count} servers to backdoor are currently rooted.`);
        toBackdoor = toBackdoor.filter(s => myHackingLevel > ns.getServerRequiredHackingLevel(s));
        ns.print(`${toBackdoor.length} of ${count} servers to backdoor are within our hack level (${myHackingLevel}).`);
        toBackdoor = toBackdoor.filter(s => ns.hasRootAccess(s));
        ns.print(`${toBackdoor.length} of ${count} servers to be backdoored are rooted and within our hack level (${myHackingLevel})`);
        if (toBackdoor.length == 0) return;

        // Collect information about any servers still being backdoored (from a prior run), so we can skip them
        let scriptPath = getFilePath('/Tasks/backdoor-all-servers.js.backdoor-one.js');
        let currentScripts = ns.ps().filter(s => s.filename == scriptPath).map(s => s.args[0]);

        for (const server of toBackdoor) {
            if (currentScripts.find(x => x == server)) {
                log(ns, `INFO: Server already beeing backdoored: ${server}`);
                continue;
            }
            ns.print(`Hopping to ${server}`);
            notAtHome = true; // Set a flag to get us back home if we encounter an error
            const success = await getNsDataThroughFile(ns,
                'ns.args.reduce((success, hop) => success && ns.singularity.connect(hop), true)',
                '/Temp/singularity-connect-hop-to-server.txt', routes[server]);
            if (!success)
                log(ns, `ERROR: Failed to hop to server ${server}. Backdoor probably won't work...`, true, 'error');
            if (server === "w0r1d_d43m0n") {
                ns.alert("Ready to hack w0r1d_d43m0n!");
                log(ns, "INFO: Sleeping forever to avoid multiple instances navigating to w0r1d_d43m0n.");
                while (true) await ns.sleep(10000); // Sleep forever so the script isn't run multiple times to create multiple overlapping alerts
            }
            ns.print(`Installing backdoor on "${server}"...`);
            // Kick off a separate script that will run backdoor before we connect to home.
            var pid = ns.run(scriptPath, { temporary: true }, server);
            if (pid === 0)
                return log(ns, `WARN: Couldn't initiate a new backdoor of "${server}" (insufficient RAM?). Will try again later.`, false, 'warning');
            await ns.sleep(spawnDelay); // Wait some time for the external backdoor script to initiate its backdoor of the current connected server
            const backAtHome = await getNsDataThroughFile(ns, 'ns.singularity.connect(ns.args[0])', null, ["home"]);
            if (backAtHome)
                notAtHome = false;
        }
    }
    catch (err) {
        log(ns, `ERROR: ${ns.getScriptName()} Caught an unexpected error:\n${getErrorInfo(err)}`, false, 'error');
    } finally {
        // Try to clean-up by re-connecting to home before we shut down
        if (notAtHome)
            await getNsDataThroughFile(ns, 'ns.singularity.connect(ns.args[0])', null, ["home"]);
    }
};