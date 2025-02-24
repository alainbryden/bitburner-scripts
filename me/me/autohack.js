/** @param {NS} ns**/
export async function main(ns) {
    ns.disableLog('ALL');

    const FILES = ['grow.script', 'weak.script', 'hack.script'];
    const EXCLUDE = [''];
    const CYCLE = [0, "▄", "█", "▀", "█"];
    const HACK_COMMANDS = ['brutessh', 'ftpcrack', 'relaysmtp', 'httpworm', 'sqlinject'];

    await Promise.all([
        ns.write(FILES[0], 'grow(args[0])', 'w'),
        ns.write(FILES[1], 'weaken(args[0])', 'w'),
        ns.write(FILES[2], 'hack(args[0])', 'w')
    ]);

    let servers, hosts, targets, exes, tarIndex, loop, hType, tmp, act;
    let netManager = await ns.prompt('Activate Hacknet Manager?');
    let serverManager = await ns.prompt('Activate Player Server Manager?');

    const checkFunds = (cost, divisor) => cost < ns.getServerMoneyAvailable('home') / divisor;
    const sortDesc = arr => arr.sort((a, b) => b[0] - a[0]);
    const truncate = s => s.length > 14 ? s.substring(0, 14) + '...' : s;

    const serverInfo = {
        MM: s => ns.getServerMaxMoney(s),
        MA: s => ns.getServerMoneyAvailable(s),
        MR: s => ns.getServerMaxRam(s),
        UR: s => ns.getServerUsedRam(s),
        NPR: s => ns.getServerNumPortsRequired(s),
        RHL: s => ns.getServerRequiredHackingLevel(s),
        SL: s => ns.getServerSecurityLevel(s),
        MSL: s => ns.getServerMinSecurityLevel(s)
    };

    async function updateExes() {
        exes = HACK_COMMANDS.filter(cmd => ns.fileExists(`${cmd}.exe`));
    }

    function generateLog() {
        if (CYCLE[0] >= 4) CYCLE[0] = 0;
        CYCLE[0]++;
        ns.clearLog();

        // 优化后的日志头
        ns.print('╔═══╦════════════════════════════════════════════════════╗');
        ns.print(`║ ${CYCLE[CYCLE[0]]} ║      TARGETS                ░▒▓ CASH FLOW ▓▒░      ║`);
        ns.print('╠═══╬════════════════════╦══════════╦════════════════════╣');
        const topTargets = targets.slice(0, 12);
        topTargets.forEach(t => {
            const ratio = serverInfo.MA(t[1]) / serverInfo.MM(t[1]);
            const progress = '|'.repeat(Math.floor(ratio * 10)).padEnd(10, '-');
            const balance = `[${progress}]` + `(${ns.formatPercent(ratio, 0).padStart(4, '_')})`;
            const severMA = `$${ns.formatNumber(serverInfo.MA(t[1]), 2)}`.padEnd(8);
            ns.print(`║ ${act[t[1]] || ' '} ║ ${truncate(t[1]).padEnd(18)} ║ ${severMA} ║ ${balance} ║`);
        });

        // 状态栏优化
        ns.print('╠═══╩════════════════════╩══════════╩════════════════════╣');
        const exeProgress = exes.map(_e => '●').join('') + '○'.repeat(5 - exes.length);
        ns.print(`║ EXE:[${exeProgress}]  HOSTS:${hosts.length.toString().padStart(3)}  TARGETS:${targets.length.toString().padStart(3)}                    ║`);

        // 管理器状态优化
        if (netManager || serverManager) {
            ns.print('╠════════════════════════════════════════════════════════╣');
            let status = [];
            if (netManager) status.push(`HN:${ns.hacknet.numNodes().toString().padStart(3)}`);
            if (serverManager) status.push(`SV:${ns.getPurchasedServers().length.toString().padStart(2)}`);
            ns.print(`║ [MANAGERS]  ${status.join('  ').padEnd(35)}        ║`);
        }

        ns.print('╚════════════════════════════════════════════════════════╝');
    }

    async function scanNetwork(host, current) {
        for (const server of ns.scan(current)) {
            if (host === server || EXCLUDE.includes(server)) continue;

            const isPurchased = ns.getPurchasedServers().includes(server);
            if (!isPurchased && serverInfo.NPR(server) <= exes.length) {
                HACK_COMMANDS.filter(cmd => exes.includes(cmd)).forEach(cmd => ns[cmd](server));
                ns.nuke(server);
            }

            if (serverInfo.MM(server) > 0 &&
                serverInfo.RHL(server) <= ns.getHackingLevel() &&
                serverInfo.MSL(server) < 100) {
                targets.push([Math.floor(serverInfo.MM(server) / serverInfo.MSL(server)), server]);
            }

            if (serverInfo.MR(server) > 4 && !EXCLUDE.includes(server)) {
                hosts.push([serverInfo.MR(server), server]);
            }

            servers.push(server);
            await ns.scp(FILES, server, 'home');
            await scanNetwork(current, server);
        }
        targets = sortDesc(targets);
        hosts = sortDesc(hosts);
    }

    async function allocateResources() {
        for (const [_, host] of hosts) {
            if (tarIndex >= targets.length) {
                tarIndex = 0;
                loop = true;
            }

            const target = targets[tarIndex][1];
            const freeRam = serverInfo.MR(host) - serverInfo.UR(host);
            const ramRatio = freeRam / serverInfo.MR(host);

            if (serverInfo.MA(target) < serverInfo.MM(target) * 0.8) {
                hType = 0;
            } else if (serverInfo.SL(target) > serverInfo.MSL(target) + 5 || loop) {
                hType = 1;
                if (ramRatio > 0.13 && freeRam > 4) {
                    const threads = Math.floor(freeRam / 1.75);
                    if (threads > 0) ns.exec(FILES[1], host, threads, target);
                }
            } else {
                hType = 2;
                const isHacking = hosts.some(([_, h]) => h !== host && ns.isRunning(FILES[2], h, target));
                if (!isHacking && !ns.scriptRunning(FILES[2], host)) {
                    if (freeRam < 2) ns.killall(host);
                    const maxThreads = Math.floor(freeRam / 1.7);
                    let safeThreads = 1;
                    while (ns.hackAnalyze(target) * safeThreads < 0.7 && safeThreads < maxThreads) safeThreads++;
                    ns.exec(FILES[2], host, safeThreads, target);
                }
            }

            if ((hType === 0 || hType === 2) && freeRam > 3.9) {
                const weakenThreads = Math.ceil(serverInfo.MR(host) * 0.14 / 1.75);
                const growThreads = Math.floor(serverInfo.MR(host) * 0.79 / 1.75);
                if (growThreads > 0 && ramRatio >= 0.8) ns.exec(FILES[0], host, growThreads, target);
                if (weakenThreads > 0 && ramRatio >= 0.15) ns.exec(FILES[1], host, weakenThreads, target);
            }

            if (!loop) act[target] = ['G', 'W', 'H'][hType];
            tarIndex++;
        }
    }

    async function manageHacknet() {
        if (checkFunds(ns.hacknet.getPurchaseNodeCost(), 20)) ns.hacknet.purchaseNode();
        for (let i = 0; i < ns.hacknet.numNodes(); i++) {
            ['Level', 'Ram', 'Core'].forEach(prop => {
                const cost = ns.hacknet[`get${prop}UpgradeCost`](i);
                if (checkFunds(cost, 20)) ns.hacknet[`upgrade${prop}`](i);
            });
        }
    }

    async function manageServers() {
        const maxRam = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576]
            .findLast(ram => checkFunds(ns.getPurchasedServerCost(ram), 20));

        if (ns.getPurchasedServers().length < 25 && maxRam) {
            ns.purchaseServer('daemon', maxRam);
        }

        ns.getPurchasedServers().reverse().forEach(server => {
            if (serverInfo.MR(server) < maxRam && checkFunds(ns.getPurchasedServerCost(maxRam), 20) && !EXCLUDE.includes(server)) {
                ns.killall(server);
                ns.deleteServer(server);
                ns.purchaseServer('daemon', maxRam);
            }
        });
    }

    ns.tail();
    while (true) {
        servers = [];
        targets = [];
        hosts = [[Math.max(serverInfo.MR('home') - 50, 0), 'home']];
        exes = [];
        tarIndex = 0;
        loop = false;
        act = {};

        await updateExes();
        await scanNetwork('', 'home');
        await allocateResources();      

        if (netManager) await manageHacknet();
        if (serverManager) await manageServers();

        generateLog();
        await ns.sleep(1000);
    }
}
