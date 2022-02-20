import { argsSchema } from './corporation.js';
import { formatRam, scanAllServers } from './helpers.js';

/** @typedef {import('./index.js').NS} NS*/

/**
 * Try to find a place to run our corporation script, copy it out there, and start it up.
 * @param {NS} ns
 */
export async function main(ns) {
	const scriptName = 'corporation.js';
	const scriptDependencies = ['helpers.js'];
    const scriptSize = ns.getScriptRam(scriptName, 'home');
	
    // Get a list of all the servers, and see if any of them can handle our script.
    let servers = scanAllServers(ns);
    servers = servers.filter((hostname) => !isFlaggedForDeletion(ns, hostname));
    servers = servers.filter((hostname) => ns.getServerMaxRam(hostname) >= scriptSize);

    if (servers.length > 0) {
        for (const hostname of servers) {
			let freeRam = ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
			if (freeRam > scriptSize) {
				await ns.scp(scriptName, hostname);
				await ns.scp(scriptDependencies, hostname);
				let pid = ns.exec(scriptName, hostname, 1, ...ns.args);
				ns.tail(pid);
				ns.exit();
			}
		}
    } else {
        ns.tprint(`No servers that can possibly run '${scriptName}' (${formatRam(scriptSize)}).`);
    }
}

function isFlaggedForDeletion(ns, hostname) {
    return hostname != 'home' && ns.fileExists('/Flags/deleting.txt', hostname);
}

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}
