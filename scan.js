/**
 * @param {NS} ns
 * @returns interactive server map
 */
export function main(ns) {
    const factionServers = ["CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z", "w0r1d_d43m0n", "fulcrumassets"],
        css = `    <style id="scanCSS">
        .serverscan {white-space:pre; color:#ccc; font:14px monospace; line-height: 16px; }
        .serverscan .server {color:#080;cursor:pointer;text-decoration:underline}
        .serverscan .faction {color:#088}
        .serverscan .rooted {color:#6f3}
        .serverscan .rooted.faction {color:#0ff}
        .serverscan .rooted::before {color:#6f3}
        .serverscan .hack {display:inline-block; font:12px monospace}
        .serverscan .red {color:red;}
        .serverscan .green {color:green;}
        .serverscan .backdoor {color:#6f3; font:12px monospace}
        .serverscan .backdoor > a {cursor:pointer; text-decoration:underline;}
        .serverscan .cct {color:#0ff;}
    </style>`,
        doc = eval("document"),
        terminalInsert = html => doc.getElementById("terminal").insertAdjacentHTML('beforeend', `<li>${html}</li>`),
        terminalInput = doc.getElementById("terminal-input"),
        terminalEventHandlerKey = Object.keys(terminalInput)[1],
        setNavCommand = async inputValue => {
            terminalInput.value = inputValue
            terminalInput[terminalEventHandlerKey].onChange({ target: terminalInput })
            terminalInput.focus()
            await terminalInput[terminalEventHandlerKey].onKeyDown({ key: 'Enter', preventDefault: () => 0 })
        },
        myHackLevel = ns.getHackingLevel(),
        serverInfo = (serverName) => {
            // Costs 2 GB. If you can't don't need backdoor links, uncomment and use the alternate implementations below
            return ns.getServer(serverName)
            /* return {
                requiredHackingSkill: ns.getServerRequiredHackingLevel(serverName),
                hasAdminRights: ns.hasRootAccess(serverName),
                purchasedByPlayer: serverName.includes('daemon') || serverName.includes('hacknet'),
                backdoorInstalled: true // No way of knowing without ns.getServer
            } */
        },
        createServerEntry = serverName => {
            let server = serverInfo(serverName),
                requiredHackLevel = server.requiredHackingSkill,
                rooted = server.hasAdminRights,
                canHack = requiredHackLevel <= myHackLevel,
                shouldBackdoor = !server?.backdoorInstalled && canHack && serverName != 'home' && rooted && !server.purchasedByPlayer,
                contracts = ns.ls(serverName, ".cct")

            return `<span id="${serverName}">`
                + `<a class="server${factionServers.includes(serverName) ? " faction" : ""}`
                + `${rooted ? " rooted" : ""}">${serverName}</a>`
                + (server.purchasedByPlayer ? '' : ` <span class="hack ${(canHack ? 'green' : 'red')}">(${requiredHackLevel})</span>`)
                + `${(shouldBackdoor ? ' <span class="backdoor">[<a>backdoor</a>]</span>' : '')}`
                + ` ${contracts.map(c => `<span class="cct" title="${c}">@</span>`)}`
                + "</span>"
        },
        buildOutput = (parent = servers[0], prefix = ["\n"]) => {
            let output = prefix.join("") + createServerEntry(parent)
            for (let i = 0; i < servers.length; i++) {
                if (parentByIndex[i] != parent) continue
                let newPrefix = prefix.slice()
                const appearsAgain = parentByIndex.slice(i + 1).includes(parentByIndex[i]),
                    lastElementIndex = newPrefix.length - 1

                newPrefix.push(appearsAgain ? "├╴" : "└╴")

                newPrefix[lastElementIndex] = newPrefix[lastElementIndex].replace("├╴", "│ ").replace("└╴", "  ")
                output += buildOutput(servers[i], newPrefix)
            }

            return output
        },
        ordering = (serverA, serverB) => {
            // Sort servers with fewer connections towards the top.
            let orderNumber = ns.scan(serverA).length - ns.scan(serverB).length
            // Purchased servers to the very top
            orderNumber = orderNumber != 0 ? orderNumber
                : serverInfo(serverB).purchasedByPlayer - serverInfo(serverA).purchasedByPlayer
            // Hack: compare just the first 2 chars to keep purchased servers in order purchased
            orderNumber = orderNumber != 0 ? orderNumber
                : serverA.slice(0, 2).toLowerCase().localeCompare(serverB.slice(0, 2).toLowerCase())

            return orderNumber
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
                const backdoored = serverInfo(oneScanResult)?.backdoorInstalled
                servers.push(oneScanResult)
                parentByIndex.push(server)
                routes[oneScanResult] = backdoored ? "connect " + oneScanResult : routes[server] + ";connect " + oneScanResult
            }

    terminalInsert(`<div class="serverscan new">${buildOutput()}</div>`)
    doc.querySelectorAll(".serverscan.new .server").forEach(serverEntry => serverEntry
        .addEventListener('click', setNavCommand.bind(null, routes[serverEntry.childNodes[0].nodeValue])))
    doc.querySelectorAll(".serverscan.new .backdoor").forEach(backdoorButton => backdoorButton
        .addEventListener('click', setNavCommand.bind(null, routes[backdoorButton.parentNode.childNodes[0].childNodes[0].nodeValue] + ";backdoor")))
    doc.querySelector(".serverscan.new").classList.remove("new")
}
