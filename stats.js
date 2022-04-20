import { log, formatNumberShort, formatMoney, instanceCount, getNsDataThroughFile, getActiveSourceFiles, disableLogs } from './helpers.js'

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
    if (await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    const options = ns.flags(argsSchema);
    const doc = eval('document');
    const hook0 = doc.getElementById('overview-extra-hook-0');
    const hook1 = doc.getElementById('overview-extra-hook-1');
    const dictSourceFiles = await getActiveSourceFiles(ns, false); // Find out what source files the user has unlocked
    let playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
    let inBladeburner = playerInfo.inBladeburner;
    const bitNode = playerInfo.bitNodeN;
    let stkSymbols = null;
    if (!options['hide-stocks'] && playerInfo.hasTixApiAccess) // Auto-disabled if we do not have the TIX API
        stkSymbols = await getNsDataThroughFile(ns, `ns.stock.getSymbols()`, '/Temp/stock-symbols.txt');
    disableLogs(ns, ['sleep']);

    // Logic for adding a single custom HUD entry
    const newline = (txt, tt = "") => { let p = doc.createElement("p"); p.appendChild(doc.createTextNode(txt)); p.style = "margin: 0"; p.title = tt; return p; };
    const hudData = [];
    const addHud = (...args) => hudData.push(args);

    // Main stats update loop
    while (true) {
        try {
            // Show what bitNode we're currently playing
            addHud("BitNode", `${bitNode}.${1 + (dictSourceFiles[bitNode] || 0)}`, "Detected as being one more than your current owned SF level.");

            if (9 in dictSourceFiles || 9 == bitNode) { // Section not relevant if you don't have access to hacknet servers
                const hashes = await getNsDataThroughFile(ns, '[ns.hacknet.numHashes(), ns.hacknet.hashCapacity()]', '/Temp/hash-stats.txt')
                if (hashes[1] > 0) {
                    addHud("Hashes", `${formatNumberShort(hashes[0], 3, 1)}/${formatNumberShort(hashes[1], 3, 1)}`, 'Current Hashes / Current Hash Capacity');
                }
                // Detect and notify the HUD if we are liquidating hashes (selling them as quickly as possible)               
                if (ns.isRunning('spend-hacknet-hashes.js', 'home', '--liquidate') || ns.isRunning('spend-hacknet-hashes.js', 'home', '-l')) {
                    addHud(" ", "Liquidating", 'You have a script running that is selling hashes as quickly as possible (likely `spend-hacknet-hashes.js --liquidate`)');
                }
            }

            if (stkSymbols && !doc.getElementById("stock-display-1")) { // Don't add stocks if unavailable or the stockmaster HUD is active
                const stkPortfolio = await getNsDataThroughFile(ns, JSON.stringify(stkSymbols) +
                    `.map(sym => ({ sym, pos: ns.stock.getPosition(sym), ask: ns.stock.getAskPrice(sym), bid: ns.stock.getBidPrice(sym) }))` +
                    `.reduce((total, stk) => total + stk.pos[0] * stk.bid + stk.pos[2] * (stk.pos[3] * 2 - stk.ask) -100000 * (stk.pos[0] + stk.pos[2] > 0 ? 1 : 0), 0)`,
                    '/Temp/stock-portfolio-value.txt');
                if (stkPortfolio > 0) addHud("Stock", formatMoney(stkPortfolio)); // Also, don't bother showing a section for stock if we aren't holding anything
            }
            // Show total instantaneous script income and EXP (values provided directly by the game)
            addHud("ScrInc", formatMoney(ns.getScriptIncome()[0], 3, 2) + '/sec', "Total 'instantenous' income per second being earned across all scripts running on all servers.");
            addHud("ScrExp", formatNumberShort(ns.getScriptExpGain(), 3, 2) + '/sec', "Total 'instantenous' hack experience per second being earned across all scripts running on all servers.");

            const reserve = ns.read("reserve.txt") || 0;
            if (reserve > 0) // Bitburner bug: Trace amounts of share power sometimes left over after we stop sharing
                addHud("Reserve", formatNumberShort(reserve, 3, 2), "Most scripts will leave this much money unspent. Remove with `run reserve.js 0`");

            let gangInfo = false;
            if (2 in dictSourceFiles || 2 == bitNode) { // Gang income is only relevant once gangs are unlocked
                gangInfo = await getNsDataThroughFile(ns, 'ns.gang.inGang() ? ns.gang.getGangInformation() : false', '/Temp/gang-stats.txt');
                if (gangInfo !== false) {
                    // Add Gang Income
                    addHud("Gang", formatMoney(gangInfo.moneyGainRate * 5, 3, 2) + '/sec', "Gang income per second while doing tasks. (Note: If 0, your gang may temporarily be set to all be training).");
                    // Add Gang Territory
                    addHud("Territory", formatNumberShort(gangInfo.territory * 100, 4, 2) + "%", "How your gang is currently doing in territory warfare. Starts at 14.29%");
                }
            }

            const karma = ns.heart.break();
            if (karma <= -9 // Don't spoiler Karma if they haven't started doing crime yet
                && !gangInfo) { // If in a gang, you know you have oodles of bad Karma. Save some space
                let karmaShown = formatNumberShort(karma, 3, 2);
                if (2 in dictSourceFiles && 2 != bitNode && !gangInfo) karmaShown += '/54k'; // Display karma needed to unlock gangs ouside of BN2
                addHud("Karma", karmaShown, "After Completing BN2, you need -54,000 Karma in other BNs to start a gang. You also need a tiny amount to join some factions. The most is -90 for 'The Syndicate'");
            }

            if (options['show-peoplekilled']) {
                playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
                const numPeopleKilled = playerInfo.numPeopleKilled;
                addHud("Kills", formatSixSigFigs(numPeopleKilled), "Count of successful Homicides. Note: The most kills you need is 30 for 'Speakers for the Dead'");
            }

            if (7 in dictSourceFiles || 7 == bitNode) { // Bladeburner API unlocked
                inBladeburner = inBladeburner || playerInfo.inBladeburner || // Avoid RAM dodge call if we have this info already
                    (playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt')).inBladeburner;
                if (inBladeburner) {
                    const bbRank = await getNsDataThroughFile(ns, 'ns.bladeburner.getRank()', '/Temp/bladeburner-rank.txt');
                    const bbSP = await getNsDataThroughFile(ns, 'ns.bladeburner.getSkillPoints()', '/Temp/bladeburner-skill-points.txt');
                    addHud("BB Rank", formatSixSigFigs(bbRank), "Your current bladeburner rank");
                    addHud("BB SP", formatSixSigFigs(bbSP), "Your current unspent bladeburner skill points");
                }
            }

            const sharePower = await getNsDataThroughFile(ns, 'ns.getSharePower()', '/Temp/share-power.txt');
            if (sharePower > 1.0001) // Bitburner bug: Trace amounts of share power sometimes left over after we stop sharing
                addHud("Share Pwr", formatNumberShort(sharePower, 3, 2), "Uses RAM to boost faction reputation gain rate while working for factions. Run `daemon.js` with the `--no-share` flag to disable.");

            // Clear the previous loop's custom HUDs
            hook1.innerHTML = hook0.innerHTML = "";
            // Create new HUD elements with info collected above.
            for (const hudRow of hudData) {
                const [header, formattedValue, toolTip] = hudRow;
                hook0.appendChild(newline(header, toolTip));
                hook1.appendChild(newline(formattedValue, toolTip));
            }
            hudData.length = 0; // Clear the hud data for the next iteration

        } catch (err) { // Might run out of ram from time to time, since we use it dynamically
            log(ns, `WARNING: stats.js Caught (and suppressed) an unexpected error in the main loop. Update Skipped:\n` +
                (typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
        }
        await ns.sleep(1000);
    }
}

function formatSixSigFigs(value, minDecimalPlaces = 0, maxDecimalPlaces = 0) {
    return value >= 1E7 ? formatNumberShort(value, 6, 3) :
        value.toLocaleString(undefined, { minimumFractionDigits: minDecimalPlaces, maximumFractionDigits: maxDecimalPlaces });
}