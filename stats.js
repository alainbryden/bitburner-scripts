import { formatNumberShort, formatMoney, getNsDataThroughFile } from './helpers.js'

/** @param {NS} ns **/
export async function main(ns) {
    const doc = eval('document');
    const hook0 = doc.getElementById('overview-extra-hook-0');
    const hook1 = doc.getElementById('overview-extra-hook-1');
    let stkSymbols = null;
    try { stkSymbols = await getNsDataThroughFile(ns, `ns.stock.getSymbols()`, '/Temp/stock-symbols.txt'); } catch { }
    while (true) {
        try {
            const headers = []
            const values = [];

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

            if (stkSymbols) {
                headers.push("Stock");
                const stkPortfolio = await getNsDataThroughFile(ns, JSON.stringify(stkSymbols) +
                    `.map(sym => ({ sym, pos: ns.stock.getPosition(sym), ask: ns.stock.getAskPrice(sym), bid: ns.stock.getBidPrice(sym) }))` +
                    `.reduce((total, stk) => total + stk.pos[0] * stk.bid + stk.pos[2] * (stk.ask * 2 - stk.bid), 0)`,
                    '/Temp/stock-portfolio-value.txt')
                values.push(formatMoney(stkPortfolio));
            }
            headers.push("ScrInc");
            values.push(formatMoney(ns.getScriptIncome()[0], 3, 2) + '/sec');

            headers.push("ScrExp");
            values.push(formatNumberShort(ns.getScriptExpGain(), 3, 2) + '/sec');

            const gangInfo = await getNsDataThroughFile(ns, 'ns.gang.inGang() ? ns.gang.getGangInformation() : false', '/Temp/gang-stats.txt');
            if (gangInfo !== false) {
                headers.push("Gang");
                values.push(formatMoney(gangInfo.moneyGainRate * 5, 3, 2) + '/sec');
            }

            const karma = ns.heart.break();
            if (karma < -100) {
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