import { formatNumberShort, formatMoney, getNsDataThroughFile, getActiveSourceFiles } from './helpers.js'

const argsSchema = [
    ['hide-stocks', false],
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
    let stkSymbols = null;
    let dictSourceFiles = await getActiveSourceFiles(ns); // Find out what source files the user has unlocked
    let playerInfo = (await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt'));
    if (!options['hide-stocks'] && playerInfo.hasTixApiAccess) // Auto-disabled if we do not have the TSK API
        stkSymbols = await getNsDataThroughFile(ns, `ns.stock.getSymbols()`, '/Temp/stock-symbols.txt');
    // Main stats update loop
    while (true) {
        try {
            const headers = []
            const values = [];

            if (9 in dictSourceFiles) { // Section not relevant if you don't have access to hacknet servers
                const hashes = await getNsDataThroughFile(ns, '[ns.hacknet.numHashes(), ns.hacknet.hashCapacity()]', '/Temp/hash-stats.txt')
                if (hashes[1] > 0) {
                    headers.push("Hashes");
                    values.push(`${formatNumberShort(hashes[0], 3, 1)}/${formatNumberShort(hashes[1], 3, 1)}`);
                }
                // Detect and notify the HUD if we are liquidating
                if (ns.ps("home").some(p => p.filename.includes('spend-hacknet-hashes') && (p.args.includes("--liquidate") || p.args.includes("-l")))) {
                    headers.splice(1, 0, " ");
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

            if (2 in dictSourceFiles) { // Gang income is only relevant once gangs are unlocked
                const gangInfo = await getNsDataThroughFile(ns, 'ns.gang.inGang() ? ns.gang.getGangInformation() : false', '/Temp/gang-stats.txt');
                if (gangInfo !== false) {
                    headers.push("Gang");
                    values.push(formatMoney(gangInfo.moneyGainRate * 5, 3, 2) + '/sec');
                }
            }

            const karma = ns.heart.break();
            if (karma <= -9) {
                headers.push("Karma");
                values.push(formatNumberShort(karma, 3, 2));
            }

            hook0.innerText = headers.join(" \n");
            hook1.innerText = values.join("\n");
        } catch (err) { // Might run out of ram from time to time, since we use it dynamically
            ns.print("ERROR: Update Skipped: " + String(err));
        }
        await ns.sleep(1000);
    }
}