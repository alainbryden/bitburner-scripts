import { getConfiguration, disableLogs, formatMoney, scanAllServers } from './helpers.js'

const argsSchema = [
    ['all', false], // Set to true to report on all servers, not just the ones within our hack level
    ['silent', false], // Set to true to disable outputting the best servers to the terminal
    ['at-hack-level', 0], // Simulate expected gains when the player reaches the specified hack level. 0 means use the player's current hack level.
    ['hack-percent', -1], // Compute gains when hacking a certain percentage of each server's money. -1 estimates hack percentage based on current ram available, capped at 98%
    ['include-hacknet-ram', false], // Whether to include hacknet servers' RAM when computing current ram available
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return; // Invalid options, or ran in --help mode.
    disableLogs(ns, ["scan", "sleep"]);

    let serverNames = scanAllServers(ns);

    var weaken_ram = 1.75;
    var grow_ram = 1.75;
    var hack_ram = 1.7;

    var hack_percent = options['hack-percent'] / 100;
    var use_est_hack_percent = false;
    if (options['hack-percent'] == -1) {
        use_est_hack_percent = true;
    } else {
        hack_percent = options['hack-percent'] / 100;
        if (hack_percent <= 0 || hack_percent >= 1) {
            ns.tprint("hack-percent out of range (0-100)");
            return;
        }
    }

    var player = ns.getPlayer();
    //ns.print(JSON.stringify(player));

    if (options['at-hack-level']) player.hacking = options['at-hack-level'];
    var servers = serverNames.map(ns.getServer);
    // Compute the total RAM available to us on all servers (e.g. for running hacking scripts)
    var ram_total = servers.reduce(function (total, server) {
        if (!server.hasAdminRights || (server.hostname.startsWith('hacknet') && !options['include-hacknet-ram'])) return total;
        return total + server.maxRam;
    }, 0);

    // Helper to compute server gain/exp rates at a specific hacking level
    function getRatesAtHackLevel(server, player, hackLevel) {
        // Assume we will have wekened the server to min-security and taken it to max money before targetting
        server.hackDifficulty = server.minDifficulty;
        server.moneyAvailable = server.moneyMax;
        // Temporarily change the hack level on the player object to the requested level
        const real_player_hack_skill = player.hacking;
        player.hacking = hackLevel;
        // Compute the cost (ram*seconds) for each tool
        try {
            const weakenCost = weaken_ram * ns.formulas.hacking.weakenTime(server, player);
            const growCost = grow_ram * ns.formulas.hacking.growTime(server, player) + weakenCost * 0.004 / 0.05;
            const hackCost = hack_ram * ns.formulas.hacking.hackTime(server, player) + weakenCost * 0.002 / 0.05;

            // Compute the growth and hack gain rates
            const growGain = Math.log(ns.formulas.hacking.growPercent(server, 1, player, 1));
            const hackGain = ns.formulas.hacking.hackPercent(server, player);
            server.estHackPercent = Math.min(0.98, Math.min(ram_total * hackGain / hackCost, 1 - 1 / Math.exp(ram_total * growGain / growCost))); // TODO: I think these might be off by a factor of 2x
            if (use_est_hack_percent) hack_percent = server.estHackPercent;
            const grows_per_cycle = -Math.log(1 - hack_percent) / growGain;
            const hacks_per_cycle = hack_percent / hackGain;
            const hackProfit = server.moneyMax * hack_percent * ns.formulas.hacking.hackChance(server, player);
            // Compute the relative monetary gain
            const theoreticalGainRate = hackProfit / (growCost * grows_per_cycle + hackCost * hacks_per_cycle) * 1000 /* Convert per-millisecond rate to per-second */;
            const expRate = ns.formulas.hacking.hackExp(server, player) * (1 + 0.002 / 0.05) / (hackCost) * 1000;
            // The practical cap on revenue is based on your hacking scripts. For my hacking scripts this is about 20% per second, adjust as needed
            // No idea why we divide by ram_total - Basically ensures that as our available RAM gets larger, the sort order merely becomes "by server max money"
            const cappedGainRate = Math.min(theoreticalGainRate, hackProfit / ram_total);
            ns.print(`At hack level ${hackLevel} and steal ${(hack_percent * 100).toPrecision(3)}%: Theoretical ${formatMoney(theoreticalGainRate)}, ` +
                `Limit: ${formatMoney(hackProfit / ram_total)}, Exp: ${expRate.toPrecision(3)}, Hack Chance: ${(ns.formulas.hacking.hackChance(server, player) * 100).toPrecision(3)}% (${server.hostname})`);
            player.hacking = real_player_hack_skill; // Restore the real hacking skill if we changed it temporarily
            return [theoreticalGainRate, cappedGainRate, expRate];
        }
        catch {
            // Formulas API unavailable?
            return [server.moneyMax, server.moneyMax, 1 / server.minDifficulty];
        }
    }

    ns.print(`All? ${options['all']} Player hack: ${player.hacking} Ram total: ${ram_total}`);
    //ns.print(`\n` + servers.map(s => `${s.hostname} bought: ${s.purchasedByPlayer} moneyMax: ${s.moneyMax} admin: ${s.hasAdminRights} hack: ${s.requiredHackingSkill}`).join('\n'));

    // Filter down to the list of servers we wish to report on
    servers = servers.filter(server => !server.purchasedByPlayer && (server.moneyMax || 0) > 0 &&
        (options['all'] || server.hasAdminRights && server.requiredHackingSkill <= player.hacking));

    // First address the servers within our hacking level
    const unlocked_servers = servers.filter(s => s.requiredHackingSkill <= player.hacking)
        .map(function (server) {
            [server.theoreticalGainRate, server.gainRate, server.expRate] = getRatesAtHackLevel(server, player, player.hacking);
            return server;
        });
    // The best server's gain rate will be used to pro-rate the relative gain of servers that haven't been unlocked yet (if they were unlocked at this level)
    const best_unlocked_server = unlocked_servers.sort((a, b) => b.gainRate - a.gainRate)[0];
    // Compute locked server's gain rates (pro rated back to the current player's hack level)
    const locked_servers = servers.filter(s => s.requiredHackingSkill > player.hacking).sort((a, b) => a.requiredHackingSkill - b.requiredHackingSkill)
        .map(function (server) {
            // We will need to fake the hacking skill to get the numbers for when this server will first be unlocked, but to keep the comparison
            // fair, we will need to scale down the gain by the amount current best server gains now, verses what it would gain at that hack level.
            const [bestUnlockedScaledGainRate, _, bestUnlockedScaledExpRate] = getRatesAtHackLevel(best_unlocked_server, player, server.requiredHackingSkill);
            const gainRateScaleFactor = best_unlocked_server.theoreticalGainRate / bestUnlockedScaledGainRate;
            const expRateScaleFactor = best_unlocked_server.expRate / bestUnlockedScaledExpRate;
            const [theoreticalGainRate, cappedGainRate, expRate] = getRatesAtHackLevel(server, player, server.requiredHackingSkill);
            // Apply the scaling factors, as well as the same cap as above
            server.theoreticalGainRate = theoreticalGainRate * gainRateScaleFactor;
            server.expRate = expRate * expRateScaleFactor;
            server.gainRate = Math.min(server.theoreticalGainRate, cappedGainRate);
            ns.print(`${server.hostname}: Scaled theoretical gain by ${gainRateScaleFactor.toPrecision(3)} to ${formatMoney(server.theoreticalGainRate)} ` +
                `(capped at ${formatMoney(cappedGainRate)}) and exp by ${expRateScaleFactor.toPrecision(3)} to ${server.expRate.toPrecision(3)}`);
            return server;
        }) || [];
    // Combine the lists, sort, and display a summary.
    const server_eval = unlocked_servers.concat(locked_servers);
    const best_server = server_eval.sort((a, b) => b.gainRate - a.gainRate)[0];
    if (!options['silent'])
        ns.tprint("Best server: ", best_server.hostname, " with ", formatMoney(best_server.gainRate), " per ram-second");

    let order = 1;
    let serverListByGain = `Servers in order of best to worst hack money at Hack ${player.hacking}:`;
    for (const server of server_eval)
        serverListByGain += `\n ${order++} ${server.hostname}, with ${formatMoney(server.gainRate)} per ram-second while stealing ` +
            `${(server.estHackPercent * 100).toPrecision(3)}% (unlocked at hack ${server.requiredHackingSkill})`;
    ns.print(serverListByGain);

    var best_exp_server = server_eval.sort(function (a, b) {
        return b.expRate - a.expRate;
    })[0];
    if (!options['silent'])
        ns.tprint("Best exp server: ", best_exp_server.hostname, " with ", best_exp_server.expRate, " exp per ram-second");
    order = 1;
    let serverListByExp = `Servers in order of best to worst hack exp at Hack ${player.hacking}:`;
    for (let i = 0; i < 5; i++)
        serverListByExp += `\n ${order++} ${server_eval[i].hostname}, with ${server_eval[i].expRate.toPrecision(3)} exp per ram-second`;
    ns.print(serverListByExp);

    ns.write('/Temp/analyze-hack.txt', JSON.stringify(server_eval.map(s => ({
        hostname: s.hostname,
        gainRate: s.gainRate,
        expRate: s.expRate
    }))), "w");
    // Below is stats for hacknet servers - uncomment at cost of 4 GB Ram
    /*
    var hacknet_nodes = [...(function* () {
        var n = ns.hacknet.numNodes();
        for (var i = 0; i < n; i++) {
            var server = ns.hacknet.getNodeStats(i);
            server.gainRate = 1000000 / 4 * server.production / server.ram;
            yield server;
        }
    })()];
    var best_hacknet_node = hacknet_nodes.sort(function (a, b) {
        return b.gainRate - a.gainRate;
    })[0];
    if (best_hacknet_node) ns.tprint("Best hacknet node: ", best_hacknet_node.name, " with $", best_hacknet_node.gainRate, " per ram-second");
    */
}