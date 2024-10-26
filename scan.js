import { getConfiguration, formatRam, formatMoney, formatNumber } from './helpers.js'

const argsSchema = [
    ['hide-stats', false], // Set to false to hide detailed server statistics (RAM, max money, etc...)
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/**
 * @param {NS} ns
 * @returns interactive server map
 */
export function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    const showStats = !options['hide-stats'];
    const factionServers = ["CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z", "w0r1d_d43m0n", "fulcrumassets"];
    const css = `    <style id="scanCSS">
        .serverscan {white-space:pre; color:#ccc; font:14px consolas,monospace; line-height: 16px; }
        .serverscan .server {color:#080; cursor:pointer; text-decoration:underline;}
        .serverscan .faction {color:#088;}
        .serverscan .rooted {color:#6f3;}
        .serverscan .rooted.faction {color:#0ff;}
        .serverscan .rooted::before {color:#6f3;}
        .serverscan .hack {display:inline-block;}
        .serverscan .red {color:red;}
        .serverscan .green {color:green;}
        .serverscan .backdoor {color:#6f3;}
        .serverscan .backdoor.faction {color:#0ff;}
        .serverscan .backdoor > a {cursor:pointer; text-decoration:underline;}
        .serverscan .cct {color:#0ff;}
        .serverscan .serverStats {color:#8AA;}
    </style>`;
    const doc = eval("document");
    const terminalInput = doc.getElementById("terminal-input");
    if (!terminalInput) throw new Error("This script must be run while the terminal is visible.");
    const terminalEventHandlerKey = Object.keys(terminalInput)[1];

    function terminalInsert(html) {
        const term = doc.getElementById("terminal");
        if (!term) throw new Error("This script must be run while the terminal is visible.");
        term.insertAdjacentHTML('beforeend', `<li>${html}</li>`);
    }
    async function setNavCommand(inputValue) {
        terminalInput.value = inputValue
        terminalInput[terminalEventHandlerKey].onChange({ target: terminalInput })
        terminalInput.focus()
        await terminalInput[terminalEventHandlerKey].onKeyDown({ key: 'Enter', preventDefault: () => 0 })
    }

    const myHackLevel = ns.getHackingLevel();

    function getServerInfo(serverName) {
        // Costs 2 GB. If you can't don't need backdoor links, uncomment and use the alternate implementations below
        return ns.getServer(serverName)
        /* return {
                requiredHackingSkill: ns.getServerRequiredHackingLevel(serverName),
                hasAdminRights: ns.hasRootAccess(serverName),
                purchasedByPlayer: serverName.includes('daemon') || serverName.includes('hacknet'),
                backdoorInstalled: true // No way of knowing without ns.getServer
                // TODO: Other things needed if showStats is true
        } */
    }
    function createServerEntry(serverName) {
        const server = getServerInfo(serverName);
        const requiredHackLevel = server.requiredHackingSkill;
        const rooted = server.hasAdminRights;
        const canHack = requiredHackLevel <= myHackLevel;
        const shouldBackdoor = !server.backdoorInstalled && canHack && serverName != 'home' && rooted && !server.purchasedByPlayer;
        const contracts = ns.ls(serverName, ".cct");
        return `<span id="${serverName}">`
            + `<a class="server${factionServers.includes(serverName) ? " faction" : ""}`
            + `${rooted ? " rooted" : ""}">${serverName}</a>`
            + (server.purchasedByPlayer ? '' : ` <span class="hack ${(canHack ? 'green' : 'red')}">(${requiredHackLevel})</span>`)
            + `${(shouldBackdoor ? ` <span class="${factionServers.includes(serverName) ? "faction " : ""}backdoor">[<a>backdoor</a>]</span>` : '')}`
            + ` ${contracts.map(c => `<span class="cct" title="${c}">@</span>`).join('')}`
            + (showStats ? ` <span class="serverStats">... ` +
                `Money: ` + ((server.moneyMax ?? 0 > 0 ? `${formatMoney(server.moneyAvailable ?? 0, 4, 1).padStart(7)} / ` : '') +
                    `${formatMoney(server.moneyMax ?? 0, 4, 1).padStart(7)} `).padEnd(18) +
                `Sec: ${formatNumber(server.hackDifficulty ?? 0, 0, 0).padStart(3)}/${formatNumber(server.minDifficulty ?? 0, 0, 0)} `.padEnd(13) +
                `RAM: ${formatRam(server.maxRam ?? 0).replace(' ', '').padStart(6)}` + (
                    server.maxRam ?? 0 > 0 ? ` (${formatNumber(server.ramUsed * 100.0 / server.maxRam, 0, 1)}% used)` : '') +
                `</span>` : '')
            + "</span>"
    }
    function buildOutput(parent = servers[0], prefix = ["\n"]) {
        let output = prefix.join("") + createServerEntry(parent);
        if (showStats) { // Roughly right-align server stats if enabled
            const expectedLength = parent.length + (2 * prefix.length) + (output.includes('backdoor') ? 11 : 0) +
                (output.match(/@/g) || []).length + (((output.match(/\(\d+\)/g) || [{ length: -1 }])[0].length) + 1);
            output = output.replace('...', '.'.repeat(Math.max(1, 60 - expectedLength)));
        }
        for (let i = 0; i < servers.length; i++) {
            if (parentByIndex[i] != parent) continue;
            const newPrefix = prefix.slice();
            const appearsAgain = parentByIndex.slice(i + 1).includes(parentByIndex[i]);
            const lastElementIndex = newPrefix.length - 1;

            newPrefix.push(appearsAgain ? "├╴" : "└╴");
            newPrefix[lastElementIndex] = newPrefix[lastElementIndex].replace("├╴", "│ ").replace("└╴", "  ");
            output += buildOutput(servers[i], newPrefix);
        }
        return output;
    }
    function ordering(serverA, serverB) {
        // Sort servers with fewer connections towards the top.
        let orderNumber = ns.scan(serverA).length - ns.scan(serverB).length;
        // Purchased servers to the very top
        orderNumber = orderNumber != 0 ? orderNumber :
            getServerInfo(serverB).purchasedByPlayer - getServerInfo(serverA).purchasedByPlayer;
        // Hack: compare just the first 2 chars to keep purchased servers in order purchased
        orderNumber = orderNumber != 0 ? orderNumber :
            serverA.slice(0, 2).toLowerCase().localeCompare(serverB.slice(0, 2).toLowerCase());
        return orderNumber;
    }

    // refresh css (in case it changed)
    doc.getElementById("scanCSS")?.remove()
    doc.head.insertAdjacentHTML('beforeend', css)
    let servers = ["home"],
        parentByIndex = [""],
        routes = { home: "home" }
    for (let server of servers)
        for (let oneScanResult of ns.scan(server).sort(ordering))
            if (!servers.includes(oneScanResult)) {
                const backdoored = getServerInfo(oneScanResult)?.backdoorInstalled;
                servers.push(oneScanResult);
                parentByIndex.push(server);
                routes[oneScanResult] = backdoored ? "connect " + oneScanResult : routes[server] + ";connect " + oneScanResult;
            }

    terminalInsert(`<div class="serverscan new">${buildOutput()}</div>`);
    doc.querySelectorAll(".serverscan.new .server").forEach(serverEntry => serverEntry
        .addEventListener('click', setNavCommand.bind(null, routes[serverEntry.childNodes[0].nodeValue])));
    doc.querySelectorAll(".serverscan.new .backdoor").forEach(backdoorButton => backdoorButton
        .addEventListener('click', setNavCommand.bind(null, routes[backdoorButton.parentNode.childNodes[0].childNodes[0].nodeValue] + ";backdoor")));
    doc.querySelector(".serverscan.new").classList.remove("new");
}
