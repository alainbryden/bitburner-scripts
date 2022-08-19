import {
    log, disableLogs, instanceCount, getConfiguration, getNsDataThroughFile, getActiveSourceFiles,
    getStocksValue, formatNumberShort, formatMoney, formatRam
} from './helpers.js'

const argsSchema = [
    ['show-peoplekilled', false],
    ['hide-stocks', false],
    ['hide-RAM-utilization', false],
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    const doc = eval('document');
    const hook0 = doc.getElementById('overview-extra-hook-0');
    const hook1 = doc.getElementById('overview-extra-hook-1');
    const dictSourceFiles = await getActiveSourceFiles(ns, false); // Find out what source files the user has unlocked
    let playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/getPlayer.txt');
    const bitNode = playerInfo.bitNodeN;
    let inBladeburner = playerInfo.inBladeburner;
    disableLogs(ns, ['sleep']);

    // Hook script exit to clean up after ourselves.
    ns.atExit(() => hook1.innerHTML = hook0.innerHTML = "");

    // Logic for adding a single custom HUD entry
    addCSS(doc);
    const hudData = [];
    const addHud = (...args) => hudData.push(args);
    const newline = (txt, tt = "") => {
        let p = doc.createElement("p"); p.appendChild(doc.createTextNode(txt)); p.className = "tooltip"; //p.title = tt;
        let s = doc.createElement("span"); p.appendChild(s); s.appendChild(doc.createTextNode(tt)); s.className = "tooltiptext";
        return p;
    };

    // Main stats update loop
    while (true) {
        try {
            // Show what bitNode we're currently playing in
            addHud("BitNode", `${bitNode}.${1 + (dictSourceFiles[bitNode] || 0)}`,
                `Detected as being one more than your current owned SF level (${dictSourceFiles[bitNode] || 0}) in the current bitnode (${bitNode}).`);

            // Show Hashes
            if (9 in dictSourceFiles || 9 == bitNode) { // Section not relevant if you don't have access to hacknet servers
                const hashes = await getNsDataThroughFile(ns, '[ns.hacknet.numHashes(), ns.hacknet.hashCapacity()]', '/Temp/hash-stats.txt')
                if (hashes[1] > 0) {
                    addHud("Hashes", `${formatNumberShort(hashes[0], 3, 1)}/${formatNumberShort(hashes[1], 3, 1)}`,
                        `Current Hashes ${hashes[0].toLocaleString('en')} / Current Hash Capacity ${hashes[1].toLocaleString('en')}`);
                }
                // Detect and notify the HUD if we are liquidating hashes (selling them as quickly as possible)               
                if (ns.isRunning('spend-hacknet-hashes.js', 'home', '--liquidate') || ns.isRunning('spend-hacknet-hashes.js', 'home', '-l')) {
                    addHud(" ", "Liquidating", 'You have a script running that is selling hashes as quickly as possible (likely `spend-hacknet-hashes.js --liquidate`)');
                }
            }

            // Show Stocks (only if stockmaster.js isn't already doing the same)
            if (!options['hide-stocks'] && !doc.getElementById("stock-display-1")) {
                const stkPortfolio = await getStocksValue(ns);
                if (stkPortfolio > 0) addHud("Stock", formatMoney(stkPortfolio)); // Also, don't bother showing a section for stock if we aren't holding anything
            }

            // Show total instantaneous script income and experience per second (values provided directly by the game)
            addHud("Scr Inc", formatMoney(ns.getTotalScriptIncome()[0], 3, 2) + '/sec', "Total 'instantenous' income per second being earned across all scripts running on all servers.");
            addHud("Scr Exp", formatNumberShort(ns.getTotalScriptExpGain(), 3, 2) + '/sec', "Total 'instantenous' hack experience per second being earned across all scripts running on all servers.");

            // Show reserved money
            const reserve = Number(ns.read("reserve.txt") || 0);
            if (reserve > 0) // Bitburner bug: Trace amounts of share power sometimes left over after we stop sharing
                addHud("Reserve", formatNumberShort(reserve, 3, 2), "Most scripts will leave this much money unspent. Remove with `run reserve.js 0`");

            // Show gang income and territory
            if (2 in dictSourceFiles || 2 == bitNode) { // Gang income is only relevant once gangs are unlocked
                var gangInfo = await getGangInfo(ns);
                if (gangInfo) {
                    // Add Gang Income
                    addHud("Gang Inc", formatMoney(gangInfo.moneyGainRate * 5, 3, 2) + '/sec',
                        `Gang (${gangInfo.faction}) income per second while doing tasks.` +
                        `\nIncome: ${formatMoney(gangInfo.moneyGainRate * 5)}/sec (${formatMoney(gangInfo.moneyGainRate)}/tick)` +
                        `  Respect: ${formatNumberShort(gangInfo.respect)} (${formatNumberShort(gangInfo.respectGainRate)}/tick)` +
                        `\nNote: If you see 0, your gang may all be temporarily set to training or territory warfare.`);
                    // Add Gang Territory
                    addHud("Territory", formatNumberShort(gangInfo.territory * 100, 4, 2) + "%",
                        `How your gang is currently doing in territory warfare. Starts at 14.29%\n` +
                        `Gang: ${gangInfo.faction} ${gangInfo.isHacking ? "(Hacking)" : "(Combat)"}  ` +
                        `Power: ${gangInfo.power.toLocaleString('en')}  Clash ${gangInfo.territoryWarfareEngaged ? "enabled" : "disabled"} ` +
                        `(${(gangInfo.territoryClashChance * 100).toFixed(0)}% chance)`);
                }
            }

            // Show Karma if we're not in a gang yet
            const karma = ns.heart.break();
            if (karma <= -9 // Don't spoiler Karma if they haven't started doing crime yet
                && !gangInfo) { // If in a gang, you know you have oodles of bad Karma. Save some space
                let karmaShown = formatNumberShort(karma, 3, 2);
                if (2 in dictSourceFiles && 2 != bitNode && !gangInfo) karmaShown += '/54k'; // Display karma needed to unlock gangs ouside of BN2
                addHud("Karma", karmaShown, "After Completing BN2, you need -54,000 Karma in other BNs to start a gang. You also need a tiny amount to join some factions. The most is -90 for 'The Syndicate'");
            }

            // Show number of kills if explicitly enabled
            if (options['show-peoplekilled']) {
                playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/getPlayer.txt');
                const numPeopleKilled = playerInfo.numPeopleKilled;
                addHud("Kills", formatSixSigFigs(numPeopleKilled), "Count of successful Homicides. Note: The most kills you need is 30 for 'Speakers for the Dead'");
            }

            // Show Bladeburner Rank and Skill Points
            if (7 in dictSourceFiles || 7 == bitNode) { // Bladeburner API unlocked
                inBladeburner = inBladeburner || playerInfo?.inBladeburner || // Avoid RAM dodge call if we have this info already
                    (playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/getPlayer.txt')).inBladeburner;
                if (inBladeburner) {
                    const bbRank = await getNsDataThroughFile(ns, 'ns.bladeburner.getRank()', '/Temp/bladeburner-getRank.txt');
                    const bbSP = await getNsDataThroughFile(ns, 'ns.bladeburner.getSkillPoints()', '/Temp/bladeburner-getSkillPoints.txt');
                    addHud("BB Rank", formatSixSigFigs(bbRank), "Your current bladeburner rank");
                    addHud("BB SP", formatSixSigFigs(bbSP), "Your current unspent bladeburner skill points");
                }
            }

            // Show various server / RAM utilization stats
            if (!options['hide-RAM-utilization']) {
                const servers = await getAllServersInfo(ns);
                const rooted = servers.filter(s => s.hasAdminRights).length;
                const purchased = servers.filter(s => s.hostname != "home" && s.purchasedByPlayer).length; // "home" counts as purchased by the game
                const likelyHacknet = servers.filter(s => s.hostname.startsWith("hacknet-node-"));
                // Add Server count.
                addHud("Servers", `${servers.length}/${rooted}/${purchased}`, `The number of servers on the network (${servers.length}) / ` +
                    `number rooted (${rooted}) / number purchased ` + (likelyHacknet.length > 0 ?
                        `(${purchased - likelyHacknet.length} servers + ${likelyHacknet.length} hacknet servers)` : `(${purchased})`));
                const home = servers.find(s => s.hostname == "home");
                // Add Home RAM and Utilization
                addHud("Home RAM", `${ns.nFormat(home.maxRam * 1E9, '0b')} ${(100 * home.ramUsed / home.maxRam).toFixed(1)}%`,
                    `Shows total home RAM (and current utilization %)\nDetails: ${home.cpuCores} cores and using ` +
                    `${formatRam(home.ramUsed)} of ${formatRam(home.maxRam)} (${formatRam(home.maxRam - home.ramUsed)} free)`);
                // If the user has any scripts running on hacknet servers, assume they want them included in available RAM stats
                const includeHacknet = likelyHacknet.some(s => s.ramUsed > 0);
                const [totalMax, totalUsed] = servers.filter(s => s.hasAdminRights && (includeHacknet || !s.hostname.startsWith("hacknet-node-")))
                    .reduce(([totalMax, totalUsed], s) => [totalMax + s.maxRam, totalUsed + s.ramUsed], [0, 0]);
                // Add Total Network RAM and Utilization
                addHud("All RAM", `${ns.nFormat(totalMax * 1E9, '0b')} ${(100 * totalUsed / totalMax).toFixed(1)}%`,
                    `Shows the sum-total RAM and utilization across all rooted hosts on the network` + (9 in dictSourceFiles || 9 == bitNode ?
                        (includeHacknet ? "\n(including hacknet servers, because you have scripts running on them)" : " (excluding hacknet servers)") : "") +
                    `\nDetails: Using ${formatRam(totalUsed)} of ${formatRam(totalMax)} (${formatRam(totalMax - totalUsed)} free)`);
            }

            // Show current share power
            const sharePower = await getNsDataThroughFile(ns, 'ns.getSharePower()', '/Temp/getSharePower.txt');
            if (sharePower > 1.0001) // Bitburner bug: Trace amounts of share power sometimes left over after we stop sharing
                addHud("Share Pwr", formatNumberShort(sharePower, 3, 2),
                    "Uses RAM to boost faction reputation gain rate while working for factions (capped at 1.5) " +
                    "\nRun `daemon.js` with the `--no-share` flag to disable.");

            // Clear the previous loop's custom HUDs
            hook1.innerHTML = hook0.innerHTML = "";
            // Create new HUD elements with info collected above.
            for (const hudRow of hudData) {
                const [header, formattedValue, toolTip] = hudRow;
                hook0.appendChild(newline(header.padEnd(9, " "), toolTip));
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

/** @param {NS} ns
 *  @returns {Promise<GangGenInfo|boolean>} Gang information, if we're in a gang, or False */
async function getGangInfo(ns) {
    return await getNsDataThroughFile(ns, 'ns.gang.inGang() ? ns.gang.getGangInformation() : false', '/Temp/gang-stats.txt')
}

/** @param {NS} ns 
 * @returns {Promise<Server[]>} **/
async function getAllServersInfo(ns) {
    const serverNames = await getNsDataThroughFile(ns, 'scanAllServers(ns)', '/Temp/scanAllServers.txt');
    return await getNsDataThroughFile(ns, 'ns.args.map(ns.getServer)', '/Temp/getServers.txt', serverNames);
}

function addCSS(doc) {
    let priorCss = doc.getElementById("statsCSS");
    if (priorCss) priorCss.parentNode.removeChild(priorCss); // Remove old CSS to facilitate tweaking css above
    // Hopefully this logic remains valid for detecting which element is the HUD draggable window
    const hudParent = doc.getElementsByClassName(`MuiCollapse-root`)[0].parentElement;
    if (hudParent) hudParent.style.zIndex = 1E4; // Tail windows start around 1500, this should keep the HUD above them
    doc.head.insertAdjacentHTML('beforeend', css(hudParent ? eval('window').getComputedStyle(hudParent) : null));
}
const css = (rootStyle) => `<style id="statsCSS">
    .MuiTooltip-popper { z-index: 10001 } /* Sadly, not parented by its owners, so must be updated with MuiCollapse-root's parent */
    .tooltip  { margin: 0; position: relative; }
    .tooltip:hover .tooltiptext { visibility: visible; opacity: 0.85; }
    .tooltip .tooltiptext {
        visibility: hidden; position: absolute; z-index: 1;
        right: 20px; top: 19px; padding: 2px 10px;
        text-align: right; white-space: pre;       
        border-radius: 6px; border: ${rootStyle?.border || "inherit"};
        background-color: ${rootStyle?.backgroundColor || "#900C"};
    }
</style>`;