import { formatNumberShort, formatMoney, getNsDataThroughFile, getActiveSourceFiles } from './helpers.js'

const argsSchema = [
    ['hide-stocks', false],
    ['show-peoplekilled', false],
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = ns.flags(argsSchema);
    const doc = eval('document');
    const hook0 = doc.getElementById('overview-extra-hook-0');
    const hook1 = doc.getElementById('overview-extra-hook-1');
    const dictSourceFiles = await getActiveSourceFiles(ns, false); // Find out what source files the user has unlocked
    let playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
    const bitNode = playerInfo.bitNodeN;
    let stkSymbols = null;
    if (!options['hide-stocks'] && playerInfo.hasTixApiAccess) // Auto-disabled if we do not have the TSK API
        stkSymbols = await getNsDataThroughFile(ns, `ns.stock.getSymbols()`, '/Temp/stock-symbols.txt');
    // Main stats update loop
    while (true) {
        try {
            const headers = []
            const values = [];

            // Show what bitNode we're currently playing
            headers.push("BitNode");
            values.push(`${bitNode}.${1 + (dictSourceFiles[bitNode] || 0)}`);

            if (9 in dictSourceFiles || 9 == bitNode) { // Section not relevant if you don't have access to hacknet servers
                const hashes = await getNsDataThroughFile(ns, '[ns.hacknet.numHashes(), ns.hacknet.hashCapacity()]', '/Temp/hash-stats.txt')
                if (hashes[1] > 0) {
                    headers.push("Hashes");
                    values.push(`${formatNumberShort(hashes[0], 3, 1)}/${formatNumberShort(hashes[1], 3, 1)}`);
                }
                // Detect and notify the HUD if we are liquidating hashes (selling them as quickly as possible)               
                if (ns.isRunning('spend-hacknet-hashes.js', 'home', '--liquidate') || ns.isRunning('spend-hacknet-hashes.js', 'home', '-l')) {
                    headers.push(" ");
                    values.push("Liquidating");
                }
            }

            if (stkSymbols && !doc.getElementById("stock-display-1")) { // Don't add stocks if unavailable or the stockmaster HUD is active
                const stkPortfolio = await getNsDataThroughFile(ns, JSON.stringify(stkSymbols) +
                    `.map(sym => ({ sym, pos: ns.stock.getPosition(sym), ask: ns.stock.getAskPrice(sym), bid: ns.stock.getBidPrice(sym) }))` +
                    `.reduce((total, stk) => total + stk.pos[0] * stk.bid + stk.pos[2] * (stk.pos[3] * 2 - stk.ask) -100000 * (stk.pos[0] + stk.pos[2] > 0 ? 1 : 0), 0)`,
                    '/Temp/stock-portfolio-value.txt');
                if (stkPortfolio > 0) { // Don't bother showing a section for stock if we aren't holding anything
                    headers.push("Stock");
                    values.push(formatMoney(stkPortfolio));
                }
            }
            headers.push("ScrInc");
            values.push(formatMoney(ns.getScriptIncome()[0], 3, 2) + '/sec');

            headers.push("ScrExp");
            values.push(formatNumberShort(ns.getScriptExpGain(), 3, 2) + '/sec');

            let gangInfo = false;
            if (2 in dictSourceFiles || 2 == bitNode) { // Gang income is only relevant once gangs are unlocked
                gangInfo = await getNsDataThroughFile(ns, 'ns.gang.inGang() ? ns.gang.getGangInformation() : false', '/Temp/gang-stats.txt');
                if (gangInfo !== false) {
                    // Add Gang Income
                    headers.push("Gang");
                    values.push(formatMoney(gangInfo.moneyGainRate * 5, 3, 2) + '/sec');
                    // Add Gang Territory
                    headers.push("Territory");
                    values.push(formatNumberShort(gangInfo.territory * 100, 4, 2) + "%");
                }
            }

            const karma = ns.heart.break();
            if (karma <= -9 // Don't spoiler Karma if they haven't started doing crime yet
                && !gangInfo) { // If in a gang, you know you have oodles of bad Karma. Save some space
                headers.push("Karma");
                values.push(formatNumberShort(karma, 3, 2));
            }

            if (options['show-peoplekilled']) {
                playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
                const numPeopleKilled = playerInfo.numPeopleKilled;
                if (numPeopleKilled > 0) {
                    headers.push("Kills");
                    values.push(formatNumberShort(numPeopleKilled, 6, 0));
                }
            }

            const sharePower = await getNsDataThroughFile(ns, 'ns.getSharePower()', '/Temp/share-power.txt');
            if (sharePower > 1) {
                headers.push("Share Pwr");
                values.push(formatNumberShort(sharePower, 3, 2));
            }

            hook0.innerText = headers.join(" \n");
            hook1.innerText = values.join("\n");
        } catch (err) { // Might run out of ram from time to time, since we use it dynamically
            ns.print("ERROR: Update Skipped: " + String(err));
        }
        await ns.sleep(1000);
    }
}