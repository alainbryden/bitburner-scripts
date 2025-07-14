import {
    log, disableLogs, instanceCount, getConfiguration, getNsDataThroughFile, getActiveSourceFiles,
    getStocksValue, formatNumberShort, formatMoney, formatRam, getFilePath
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

let doc, hook0, hook1;
let playerInBladeburner = false, nodeMap = {}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || (await instanceCount(ns)) > 1) return; // Prevent multiple instances of this script from being started, even with different args.

    const dictSourceFiles = await getActiveSourceFiles(ns, false); // Find out what source files the user has unlocked
    let resetInfo = await getNsDataThroughFile(ns, 'ns.getResetInfo()');
    const bitNode = resetInfo.currentNode;
    disableLogs(ns, ['sleep']);

    // Globals need to reset at startup. Otherwise, they can survive e.g. flumes and new BNs and return stale results
    playerInBladeburner = false;
    nodeMap = {};
    doc = eval('document');
    hook0 = doc.getElementById('overview-extra-hook-0');
    hook1 = doc.getElementById('overview-extra-hook-1');

    // Hook script exit to clean up after ourselves.
    ns.atExit(() => hook1.innerHTML = hook0.innerHTML = "")

    addCSS(doc);

    prepareHudElements(await getHudData(ns, bitNode, dictSourceFiles, options))

    // Main stats update loop
    while (true) {
        try {
            const hudData = await getHudData(ns, bitNode, dictSourceFiles, options)

            // update HUD elements with info collected above.
            for (const [header, show, formattedValue, toolTip] of hudData) {
                // Ensure values are never shown glued to the header by adding a non-breaking space to the left of each. 
                const paddedValue = formattedValue == null ? null : ' ' + formattedValue?.trim();
                updateHudElement(header, show, paddedValue, toolTip)
            }
        } catch (err) {
            // Might run out of ram from time to time, since we use it dynamically
            log(ns, `WARNING: stats.js Caught (and suppressed) an unexpected error in the main loop. Update Skipped:\n` +
                (typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
        }
        await ns.sleep(1000);
    }
}

/** Creates the new UI elements which we will be adding custom HUD data to. 
 * @param {HudRowConfig[]} hudData */
function prepareHudElements(hudData) {
    const newline = (id, txt, toolTip = "") => {
        const p = doc.createElement("p");
        p.className = "tooltip hidden";
        const text = doc.createElement("span");
        text.textContent = txt;
        p.appendChild(text);
        const tooltip = doc.createElement("span");
        p.appendChild(tooltip);
        tooltip.textContent = toolTip;
        tooltip.className = "tooltiptext";
        nodeMap[id] = [text, tooltip, p]
        return p;
    }

    for (const [header, _, value, toolTip] of hudData) {
        const id = makeID(header)
        hook0.appendChild(newline(id + "-title", header.padEnd(9, " "), toolTip))
        hook1.appendChild(newline(id + "-value", value, toolTip))
    }
}

function makeID(header) {
    return header.replace(" ", "") ?? "empty-header"
}

/** Creates the new UI elements which we will be adding custom HUD data to.
 * @param {string} header - The stat name which appears in the first column of the custom HUD row
 * @param {boolean} visible - Indicates whether the current HUD row should be displayed (true) or hidden (false)
 * @param {string} value - The value to display in the second column of the custom HUD row
 * @param {string} toolTip - The tooltip to display if the user hovers over this HUD row with their cursor. */
function updateHudElement(header, visible, value, toolTip) {
    const id = makeID(header),
        valId = id + "-value",
        titleId = id + "-title",
        maybeUpdate = (id, index, value) => {
            if (nodeMap[id][index].textContent != value)
                nodeMap[id][index].textContent = value
        }

    if (visible) {
        maybeUpdate(valId, 0, value)
        maybeUpdate(valId, 1, toolTip)
        maybeUpdate(titleId, 1, toolTip)
        nodeMap[titleId][2].classList.remove("hidden")
        nodeMap[valId][2].classList.remove("hidden")
    } else {
        nodeMap[titleId][2].classList.add("hidden")
        nodeMap[valId][2].classList.add("hidden")
    }
}

/** @param {NS} ns
 * @param {number} bitNode the current bitnode the user is in
 * @param {{[k: number]: number}} dictSourceFiles The source files the user has unlocked so far
 * @param {(string | boolean)[][]} options The run configuration of this script.
 * @typedef {string} header - The stat name which appears in the first column of the custom HUD row
 * @typedef {boolean} show - Indicates whether the current HUD row should be displayed (true) or hidden (false)
 * @typedef {string} formattedValue - The value to display in the second column of the custom HUD row
 * @typedef {string} toolTip - The tooltip to display if the user hovers over this HUD row with their cursor.
 * @typedef {[header, show, formattedValue, toolTip]} HudRowConfig The configuration for a custom row displayed in the HUD
 * @returns {Promise<HudRowConfig[]>} **/
async function getHudData(ns, bitNode, dictSourceFiles, options) {
    const hudData = (/**@returns {HudRowConfig[]}*/() => [])();

    // Show what bitNode we're currently playing in
    {
        const val = ["BitNode", true, `${bitNode}.${1 + (dictSourceFiles[bitNode] || 0)}`,
            `Detected as being one more than your current owned SF level (${dictSourceFiles[bitNode] || 0}) in the current bitnode (${bitNode}).`]
        hudData.push(val)
    }

    // Show Hashes
    {
        const val1 = ["Hashes"];
        const val2 = [" "]; // Blank line placeholder for when hashes are being liquidated
        if (9 in dictSourceFiles || 9 == bitNode) { // Section not relevant if you don't have access to hacknet servers
            const hashes = await getNsDataThroughFile(ns, '[ns.hacknet.numHashes(), ns.hacknet.hashCapacity()]', '/Temp/hash-stats.txt')
            if (hashes[1] > 0) {
                val1.push(true, `${formatNumberShort(hashes[0], 3, 1)}/${formatNumberShort(hashes[1], 3, 1)}`,
                    `Current Hashes ${hashes[0].toLocaleString('en')} / Current Hash Capacity ${hashes[1].toLocaleString('en')}`)
                // Detect and notify the HUD if any scripts are liquidating hashes (selling them as quickly as possible)
                const spendHashesScript = getFilePath('spend-hacknet-hashes.js');
                const liquidatingHashes = await (/**@returns{Promise<ProcessInfo[]>}*/async () =>
                    await getNsDataThroughFile(ns,
                        `ns.ps('home').filter(p => p.filename == ns.args[0] && (p.args.includes('--liquidate') || p.args.includes('-l')))`,
                        '/Temp/hash-liquidation-scripts.txt', [spendHashesScript])
                )();
                if (liquidatingHashes.length > 0)
                    val2.push(true, "Liquidating", `You have ${liquidatingHashes.length} script` +
                        (liquidatingHashes.length > 1 ? 's running that are' : ' running that is') +
                        ' selling hashes as quickly as possible:\n' +
                        liquidatingHashes.map(s => `${s.filename} ${s.args.join(' ')} (PID: ${s.pid})`).join('\n',));
            }
        }
        if (val1.length < 2) val1.push(false);
        if (val2.length < 2) val2.push(false);
        hudData.push(val1, val2)
    }

    {
        const val = ["Stock"]
        // Show Stocks (only if stockmaster.js isn't already doing the same)
        if (!options['hide-stocks'] && !doc.getElementById("stock-display-1")) {
            const stkPortfolio = await getStocksValue(ns);
            // Also, don't bother showing a section for stock if we aren't holding anything
            if (stkPortfolio > 0) val.push(true, formatMoney(stkPortfolio))
            else val.push(false)
        } else val.push(false)
        hudData.push(val)
    }

    // Show total instantaneous script income and experience per second (values provided directly by the game)
    const totalScriptInc = await getNsDataThroughFile(ns, 'ns.getTotalScriptIncome()');
    const totalScriptExp = await getNsDataThroughFile(ns, 'ns.getTotalScriptExpGain()');
    hudData.push(["Scr Inc", true, formatMoney(totalScriptInc[0], 3, 2) + '/sec', "Total 'instantaneous' income per second being earned across all scripts running on all servers."]);
    hudData.push(["Scr Exp", true, formatNumberShort(totalScriptExp, 3, 2) + '/sec', "Total 'instantaneous' hack experience per second being earned across all scripts running on all servers."]);

    // Show reserved money
    {
        const val = ["Reserve"]
        const reserve = Number(ns.read("reserve.txt") || 0);
        if (reserve > 0) {
            val.push(true, formatNumberShort(reserve, 3, 2), "Most scripts will leave this much money unspent. Remove with `run reserve.js 0`");
        } else val.push(false)
        hudData.push(val)
    }

    // needed for gang and karma
    const gangInfo = await getGangInfo(ns);

    // Show gang income and territory
    {
        const val1 = ["Gang Inc"]
        const val2 = ["Territory"]
        // Gang income is only relevant once gangs are unlocked
        if ((2 in dictSourceFiles || 2 == bitNode) && gangInfo) {
            // Add Gang Income
            val1.push(true, formatMoney(gangInfo.moneyGainRate * 5, 3, 2) + '/sec',
                `Gang (${gangInfo.faction}) income per second while doing tasks.` +
                `\nIncome: ${formatMoney(gangInfo.moneyGainRate * 5)}/sec (${formatMoney(gangInfo.moneyGainRate)}/tick)` +
                `  Respect: ${formatNumberShort(gangInfo.respect)} (${formatNumberShort(gangInfo.respectGainRate)}/tick)` +
                `\nNote: If you see 0, your gang may all be temporarily set to training or territory warfare.`);
            // Add Gang Territory
            val2.push(true, formatNumberShort(gangInfo.territory * 100, 4, 2) + "%",
                `How your gang is currently doing in territory warfare. Starts at 14.29%\n` +
                `Gang: ${gangInfo.faction} ${gangInfo.isHacking ? "(Hacking)" : "(Combat)"}  ` +
                `Power: ${gangInfo.power.toLocaleString('en')}  Clash ${gangInfo.territoryWarfareEngaged ? "enabled" : "disabled"} ` +
                `(${(gangInfo.territoryClashChance * 100).toFixed(0)}% chance)`);
        } else {
            val1.push(false)
            val2.push(false)
        }
        hudData.push(val1, val2)
    }

    // Show Karma if we're not in a gang yet
    {
        const val = ["Karma"]
        const karma = ns.heart.break();
        // Don't spoiler Karma if they haven't started doing crime yet
        if (karma <= -9
            // If in a gang, you know you have oodles of bad Karma. Save some space
            && !gangInfo) {
            let karmaShown = formatNumberShort(karma, 3, 2);
            if (2 in dictSourceFiles && 2 != bitNode && !gangInfo) karmaShown += '/54k'; // Display karma needed to unlock gangs ouside of BN2
            val.push(true, karmaShown, "After Completing BN2, you need -54,000 Karma in other BNs to start a gang. You also need a tiny amount to join some factions. The most is -90 for 'The Syndicate'");
        } else val.push(false)
        hudData.push(val)
    }

    // Show number of kills if explicitly enabled
    {
        const val = ["Kills"]
        if (options['show-peoplekilled']) {
            const playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()');
            const numPeopleKilled = playerInfo.numPeopleKilled;
            val.push(true, formatSixSigFigs(numPeopleKilled), "Count of successful Homicides. Note: The most kills you need is 30 for 'Speakers for the Dead'");
        } else val.push(false)
        hudData.push(val)
    }

    // Show Bladeburner Rank and Skill Points
    {
        const val1 = ["BB Rank"]
        const val2 = ["BB SP"]
        // Bladeburner API unlocked
        if ((7 in dictSourceFiles || 7 == bitNode)
            // Check if we're in bladeburner. Once we find we are, we don't have to check again.
            && (playerInBladeburner = playerInBladeburner || await getNsDataThroughFile(ns, 'ns.bladeburner.inBladeburner()'))) {
            const bbRank = await getNsDataThroughFile(ns, 'ns.bladeburner.getRank()');
            const bbSP = await getNsDataThroughFile(ns, 'ns.bladeburner.getSkillPoints()');
            val1.push(true, formatSixSigFigs(bbRank), "Your current bladeburner rank");
            val2.push(true, formatSixSigFigs(bbSP), "Your current unspent bladeburner skill points");
        } else {
            val1.push(false)
            val2.push(false)
        }
        hudData.push(val1, val2)
    }

    // Show various server / RAM utilization stats
    {
        const val1 = ["Servers"]
        const val2 = ["Home RAM"]
        const val3 = ["All RAM"]
        if (!options['hide-RAM-utilization']) {
            const servers = await getAllServersInfo(ns);
            const hnServers = servers.filter(s => s.hostname.startsWith("hacknet-server-") || s.hostname.startsWith("hacknet-node-"));
            const nRooted = servers.filter(s => s.hasAdminRights).length;
            const nPurchased = servers.filter(s => s.hostname != "home" && s.purchasedByPlayer).length; // "home" counts as purchased by the game
            // Add Server count.
            val1.push(true, `${servers.length}/${nRooted}/${nPurchased}`, `The number of servers on the network (${servers.length}) / ` +
                `number rooted (${nRooted}) / number purchased ` + (hnServers.length > 0 ?
                    `(${nPurchased - hnServers.length} servers + ${hnServers.length} hacknet servers)` : `(${nPurchased})`));
            const home = servers.find(s => s.hostname == "home");
            // Add Home RAM and Utilization
            val2.push(true, `${formatRam(home.maxRam)} ${(100 * home.ramUsed / home.maxRam).toFixed(1)}%`,
                `Shows total home RAM (and current utilization %)\nDetails: ${home.cpuCores} cores and using ` +
                `${formatRam(home.ramUsed, true)} of ${formatRam(home.maxRam, true)} (${formatRam(home.maxRam - home.ramUsed, true)} free)`);
            // If the user has any scripts running on hacknet servers, assume they want them included in the main "total available RAM" stat
            const includeHacknet = hnServers.some(s => s.ramUsed > 0);
            const fileredServers = servers.filter(s => s.hasAdminRights && !hnServers.includes(s));
            const [sMax, sUsed] = fileredServers.reduce(([tMax, tUsed], s) => [tMax + s.maxRam, tUsed + s.ramUsed], [0, 0]);
            const [hMax, hUsed] = hnServers.reduce(([tMax, tUsed], s) => [tMax + s.maxRam, tUsed + s.ramUsed], [0, 0]);
            const [tMax, tUsed] = [sMax + hMax, sUsed + hUsed];
            let statText = includeHacknet ?
                `${formatRam(tMax)} ${(100 * tUsed / tMax).toFixed(1)}%` :
                `${formatRam(sMax)} ${(100 * sUsed / sMax).toFixed(1)}%`;
            let toolTip = `Shows the sum-total RAM and utilization across all rooted hosts on the network` + (9 in dictSourceFiles || 9 == bitNode ?
                (includeHacknet ? "\n(including hacknet servers, because you have scripts running on them)" : " (excluding hacknet servers)") : "") +
                `\nUsing ${formatRam(tUsed, true)} of ${formatRam(tMax, true)} (${formatRam(tMax - tUsed, true)} free) across all servers`;
            if (hMax > 0) toolTip +=
                `\nUsing ${formatRam(sUsed, true)} of ${formatRam(sMax, true)} (${formatRam(sMax - sUsed, true)} free) excluding  hacknet` +
                `\nUsing ${formatRam(hUsed, true)} of ${formatRam(hMax, true)} (${formatRam(hMax - hUsed, true)} free) of hacknet servers`;
            // Add Total Network RAM and Utilization
            val3.push(true, statText, toolTip);
        } else {
            val1.push(false)
            val2.push(false)
            val3.push(false)
        }
        hudData.push(val1, val2, val3)
    }

    // Show current share power
    {
        const val = ["Share Pwr"]
        const sharePower = await getNsDataThroughFile(ns, 'ns.getSharePower()');
        // Bitburner bug: Trace amounts of share power sometimes left over after we stop sharing
        if (sharePower > 1.0001) {
            val.push(true, formatNumberShort(sharePower, 3, 2),
                "Uses RAM to boost faction reputation gain rate while working for factions (tapers off at ~1.65) " +
                "\nRun `daemon.js` with the `--no-share` flag to disable.");
        } else val.push(false)
        hudData.push(val)
    }

    return hudData
}

/** @param {number} value
 *  @returns {string} The number formatted as a string with up to 6 significant digits, but no more than the specified number of decimal places. */
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
    const serverNames = await getNsDataThroughFile(ns, 'scanAllServers(ns)');
    return await getNsDataThroughFile(ns, 'ns.args.map(ns.getServer)', '/Temp/getServers.txt', serverNames);
}

/** Inject the CSS that controls how custom HUD elements are displayed. */
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
    .tooltip.hidden { display: none; }
    .tooltip:hover .tooltiptext { visibility: visible; opacity: 0.85; }
    .tooltip .tooltiptext {
        visibility: hidden; position: absolute; z-index: 1;
        right: 20px; top: 19px; padding: 2px 10px;
        text-align: right; white-space: pre;
        border-radius: 6px; border: ${rootStyle?.border || "inherit"};
        background-color: ${rootStyle?.backgroundColor || "#900C"};
    }
</style>`;
