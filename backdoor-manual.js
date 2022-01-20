let doc = eval("document");
export let main = ns => {
    let tIn = doc.getElementById("terminal-input"),
        tEv = tIn[Object.keys(tIn)[1]];
    let tcommand = x => {
        tIn.value = x;
        tEv.onChange({ target: tIn });
        tEv.onKeyDown({ keyCode: "13", preventDefault: () => 0 });
    };
    let anyConnected = false;
    let servers = ["home"],
        p = [""],
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

    ns.print(hackableServers);
    let toBackdoor = hackableServers.filter(s => !ns.getServer(s).backdoorInstalled);
    let count = toBackdoor.length;
    ns.tprint(`${count} servers have yet to be backdoored.`);
    if (count == 0) return;

    ns.tprint(`${toBackdoor.filter(s => ns.hasRootAccess(s)).length} of ${count} servers to backdoor are currently rooted.`);
    toBackdoor = toBackdoor.filter(s => myHackingLevel > ns.getServerRequiredHackingLevel(s));
    ns.tprint(`${toBackdoor.length} of ${count} servers to backdoor are within our hack level (${myHackingLevel}).`);
    toBackdoor = toBackdoor.filter(s => ns.hasRootAccess(s));
    ns.tprint(`${toBackdoor.length} of ${count} servers to be backdoored are rooted and within our hack level (${myHackingLevel})`);
    ns.tprint(`Will backdoor ${toBackdoor[0]}`)
    ns.tprint(`Routes: ${routes[toBackdoor[0]]}`)
    let cmd = "home";
    for (let i = 1; i < routes[toBackdoor[0]].length; i++)
        cmd += `;connect ${routes[toBackdoor[0]][i]}`;
    cmd += ';backdoor';
    tcommand(cmd);
};
