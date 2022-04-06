import { log, disableLogs, getNsDataThroughFile, getActiveSourceFiles, runCommand, formatMoney, formatNumberShort, formatDuration } from './helpers.js'

const cityNames = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"];
const antiChaosOperation = "Stealth Retirement Operation"; // Note: Faster and more effective than Diplomacy at reducing city chaos
// Some bladeburner info gathered at startup and cached
let skillNames, generalActionNames, contractNames, operationNames, remainingBlackOpsNames, blackOpsRanks;
let lastBlackOpReady, lowStaminaTriggered, timesTrained;

let player;
let options;
const argsSchema = [
    ['chaos-recovery-threshold', 10], // Prefer to do "Stealth Retirement" operations to reduce chaos when it reaches this number
    ['max-chaos', 500], // If chaos exceeds this amount in every city, we will reluctantly resort to diplomacy to reduce it.
    ['toast-upgrades', false], // Set to true to toast each time a skill is upgraded
    ['toast-operations', false], // Set to true to toast each time we switch operations
    ['toast-relocations', false], // Set to true to toast each time we change cities
    ['low-stamina-pct', 0.5], // Switch to no-stamina actions when we drop below this stamina percent
    ['high-stamina-pct', 0.6], // Switch back to stamina-consuming actions when we rise above this stamina percent
    ['training-limit', 100], // Don't bother training more than this many times, since Training earns no rank
    ['update-interval', 5000], // How often to refresh bladeburner status
];
export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns */
export async function main(ns) {
    disableLogs(ns, ['asleep'])
    options = ns.flags(argsSchema);
    player = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
    // Ensure we have access to bladeburner
    const ownedSourceFiles = await getActiveSourceFiles(ns);
    if (!(6 in ownedSourceFiles) && player.bitNodeN != 7)
        return log(ns, "ERROR: You have no yet unlocked bladeburner outside of BNs 6 & 7 (need SF6)", true, 'error');
    if (!(7 in ownedSourceFiles))
        return log(ns, "ERROR: You have no yet unlocked the bladeburner API (need SF7)", true, 'error');
    // Ensure we've joined bladeburners before proceeding further
    await beingInBladeburner(ns);
    // Gather one-time info such as contract and operation names
    await gatherBladeburnerInfo(ns);
    // Start the main loop which monitors stats and changes activities as needed
    while (true) {
        try { await mainLoop(ns); }
        catch (error) { log(ns, `WARNING: Caught an error in the main loop, but will keep going:\n${String(error)}`, true, 'error'); }
        await ns.asleep(options['update-interval']);
    }
}

// Ram dodging helper to execute a parameterless bladeburner function
const getBBInfo = async (ns, strFunction, ...args) =>
    await getNsDataThroughFile(ns, `ns.bladeburner.${strFunction}`,
        `/Temp/bladeburner-${strFunction.split('(')[0]}.txt`, args);
// Ram-dodging helper to get information for each item in a list (bit hacky). Temp script will be created such that
// the first argument recieved is an array of values to map, and any additional arguments are appended afterwards.
// The strFunction should contain a '%' sign indicating where the elements from the list should be mapped to a single call.
const getBBDict = async (ns, strFunction, elements, ...args) => await getNsDataThroughFile(ns,
    `Object.fromEntries(JSON.parse(ns.args[0]).map(e => [e, ns.bladeburner.${strFunction.replace('%', 'e')}]))`,
    `/Temp/bladeburner-${strFunction.split('(')[0]}.txt`, [JSON.stringify(elements), ...args]);
// Helper for dual-parameter bladeburner functions e.g. getActionCountRemaining(actionType, action)
const getBBDictByActionType = async (ns, strFunction, actionType, elements) =>
    await getBBDict(ns, `${strFunction}(ns.args[1], %)`, elements, actionType);

/** @param {NS} ns 
 * Gather all one-time bladeburner info using ram-dodging scripts. */
async function gatherBladeburnerInfo(ns) {
    skillNames = await getBBInfo(ns, 'getSkillNames()');
    generalActionNames = await getBBInfo(ns, 'getGeneralActionNames()');
    contractNames = (await getBBInfo(ns, 'getContractNames()')).reverse(); // Reversed to put in order of highest rep to lowest
    operationNames = (await getBBInfo(ns, 'getOperationNames()')).reverse(); // Reversed to put in order of highest rep to lowest
    // Blackops data is a bit special, each can be completed one time, they should be done in order
    const blackOpsNames = await getBBInfo(ns, 'getBlackOpNames()');
    blackOpsRanks = await getBBDict(ns, 'getBlackOpRank(%)', blackOpsNames);
    const blackOpsToBeDone = await getBBDictByActionType(ns, 'getActionCountRemaining', "blackops", blackOpsNames);
    remainingBlackOpsNames = blackOpsNames.filter(n => blackOpsToBeDone[n] === 1)
        .sort((b1, b2) => blackOpsRanks[b1] - blackOpsRanks[b2]);
    log(ns, `INFO: There are ${remainingBlackOpsNames.length} remaining BlackOps operations to complete in order:\n` +
        remainingBlackOpsNames.map(n => `${n} (${blackOpsRanks[n]})`).join(", "));
    lastBlackOpReady = false; // Flag will track whether we've notified the user that the last black-op is ready
    lowStaminaTriggered = false; // Flag will track whether we've previously switched to stamina recovery to reduce noise
    timesTrained = 0; // Count of how many times we've trained (capped at --training-limit)
}

/** @param {NS} ns 
 * The main loop that decides what we should be doing in bladeburner. */
async function mainLoop(ns) {
    // Spend any un-spent skill points
    await spendSkillPoints(ns);

    // Get the chaos in each city
    const chaosByCity = await getBBDict(ns, 'getCityChaos(%)', cityNames);
    let lowestChaosCity, lowestChaos = Number.MAX_VALUE;
    for (const cityName of cityNames)
        if (chaosByCity[cityName] < lowestChaos)
            [lowestChaosCity, lowestChaos] = [cityName, chaosByCity[cityName]];

    // Work in to the city with the least chaos to minimize additional chaos gain
    let currentCity = await getBBInfo(ns, 'getCity()');
    if (currentCity != lowestChaosCity) {
        const success = await getBBInfo(ns, `switchCity(ns.args[0])`, lowestChaosCity);
        log(ns, (success ? 'INFO: Switched' : 'ERROR: Failed to switch') + ` to Bladeburner city "${lowestChaosCity}" ` +
            `with lowest chaos (${chaosByCity[lowestChaosCity].toFixed(1)})`,
            !success, success ? (options['toast-relocations'] ? 'info' : undefined) : 'error');
        if (success) currentCity = lowestChaosCity;
    }

    // If any blackops have been completed, remove them from the list of remaining blackops
    const blackOpsToBeDone = await getBBDictByActionType(ns, 'getActionCountRemaining', "blackops", remainingBlackOpsNames);
    remainingBlackOpsNames = remainingBlackOpsNames.filter(n => blackOpsToBeDone[n] === 1);

    // Gather information about all available actions
    const nextBlackOp = remainingBlackOpsNames[0];
    const contractCounts = await getBBDictByActionType(ns, 'getActionCountRemaining', "contract", contractNames);
    const operationCounts = await getBBDictByActionType(ns, 'getActionCountRemaining', "operation", operationNames);
    const contractChances = await getBBDictByActionType(ns, 'getActionEstimatedSuccessChance', "contract", contractNames);
    const operationChances = await getBBDictByActionType(ns, 'getActionEstimatedSuccessChance', "operation", operationNames);
    const blackOpsChance = (await getBBDictByActionType(ns, 'getActionEstimatedSuccessChance', "blackops", [nextBlackOp]))[nextBlackOp];
    // Special case: If Synthoid community count is 0 in current city, effect "Raid" count remaining is 0
    const communities = await getBBInfo(ns, `getCityCommunities(ns.args[0])`, currentCity);
    if (communities == 0) operationCounts["Raid"] = 0;

    // Define some helpers that get info for the action based only on the name (type is auto-determined)
    const getCount = actionName => contractNames.includes(actionName) ? contractCounts[actionName] :
        operationNames.includes(actionName) ? operationCounts[actionName] :
            generalActionNames.includes(actionName) ? Number.POSITIVE_INFINITY : remainingBlackOpsNames.includes(actionName) ? 1 : 0;
    const getChance = actionName => contractNames.includes(actionName) ? contractChances[actionName] :
        operationNames.includes(actionName) ? operationChances[actionName] :
            generalActionNames.includes(actionName) ? [1, 1] : nextBlackOp == actionName ? blackOpsChance : [0, 0];
    const minChance = actionName => getChance(actionName)[0];
    const maxChance = actionName => getChance(actionName)[1];

    // Pick the action we should be working on.
    let bestActionName, reason;

    // Trigger stamina recovery if we drop below our --low-stamina-pct configuration, and remain trigered until we've recovered to --high-stamina-pct
    const stamina = await getBBInfo(ns, `getStamina()`); // Returns [current, max];
    const staminaPct = stamina[0] / stamina[1];
    lowStaminaTriggered = staminaPct < options['low-stamina-pct'] || lowStaminaTriggered && staminaPct < options['high-stamina-pct'];
    // If we are suffering a stamina penalty, perform an action that consumes no stamina
    if (lowStaminaTriggered) {
        bestActionName = chaosByCity[currentCity] > options['max-chaos'] ? "Diplomacy" : "Field Analysis";
        reason = `Stamina is low: ${(100 * staminaPct).toFixed(1)}% < ${(100 * options['low-stamina-pct']).toFixed(1)}%`
    } // If current city chaos is greater than 10, keep it low with "Stealth Retirement" if odds are good
    else if (chaosByCity[currentCity] > options['chaos-recovery-threshold'] && getCount(antiChaosOperation) > 0 && minChance(antiChaosOperation) > 0.99) {
        bestActionName = antiChaosOperation;
        reason = `Chaos is high: ${chaosByCity[currentCity].toFixed(2)} > ${options['chaos-recovery-threshold']} (--chaos-recovery-threshold)`;
    } // If current city chaos is very high (should be rare), we should be very wary of the snowballing effects, and try to reduce it.
    else if (chaosByCity[currentCity] > options['max-chaos']) {
        bestActionName = getCount(antiChaosOperation) > 0 && minChance(antiChaosOperation) > 0.8 ? antiChaosOperation : "Diplomacy";
        reason = `Chaos is very high: ${chaosByCity[currentCity].toFixed(2)} > ${options['max-chaos']} (--max-chaos)`;
    }
    else { // Otherwise, pick the "highest-tier" action we can confidently perform, which should lead to the fastest rep-gain.
        // Note: Actions will be maintained in order of highest-rep to lowest-rep earning
        let candidateActions = [nextBlackOp].concat(operationNames).concat(contractNames); // Note: General actions excluded for now

        // If current population uncertainty is such that some actions have a maxChance of ~100%, but not a minChance of ~100%,
        //   focus on actions that improve the population estimate.
        if (candidateActions.some(a => maxChance(a) > 0.99 && minChance(a) < 0.99))
            candidateActions = ["Undercover Operation", "Investigation", "Tracking", "Field Analysis"];
        else {
            // SPECIAL CASE: Leave out "Stealth Retirement" from normal rep-grinding - save it for reducing chaos (which it is very good for)
            candidateActions = candidateActions.filter(a => !a.startsWith("Stealth Retirement"));
            // SPECIAL CASE: If we can complete the last bladeburner operation, leave it to the user (they may not be ready to leave the BN).
            if (remainingBlackOpsNames.length == 1 && minChance(nextBlackOp) > 0.99) {
                if (!lastBlackOpReady) log(ns, "SUCCESS: Bladeburner is ready to undertake the last BlackOp when you are!", true, 'success')
                lastBlackOpReady = true;
                candidateActions = candidateActions.filter(a => a != nextBlackOp);
            }
        }

        // Filter out candidates with no contract counts remaining
        candidateActions = candidateActions.filter(a => getCount(a) > 0);
        // Pick the first candidate action with a minimum chance of success of ~100%
        bestActionName = candidateActions.filter(a => minChance(a) > 0.99)[0];
        if (!bestActionName) // If there were none, pick the first candidate action with a maximum chance of ~100% and minimum of greater than 50%
            bestActionName = candidateActions.filter(a => maxChance(a) > 0.99 && minChance(a) > 0.5)[0];
        if (bestActionName)
            reason = `Success Chance: ${(100 * minChance(bestActionName)).toFixed(1)}%` +
                (maxChance(bestActionName) - minChance(bestActionName) < 0.1 ? '' : ` to ${(100 * maxChance(bestActionName)).toFixed(1)}%`) +
                `, Remaining: ${getCount(bestActionName)}`;

        // If there were no operations/contracts, resort to a "general action" which always have 100% chance, but take longer and gives less reward
        if (!bestActionName && staminaPct > options['high-stamina-pct'] && timesTrained < options['training-limit']) {
            timesTrained += options['update-interval'] / 30000; // Take into account the training time (30 seconds) vs how often this code is called
            bestActionName = "Training";
            reason = `Nothing better to do, and times trained (${timesTrained.toFixed(0)}) < --training-limit (${options['training-limit']})`;
        } else if (!bestActionName) {
            bestActionName = "Field Analysis"; // Gives a little rank, and improves population estimate. Best we can do when there's nothing else.
            reason = `Nothing better to do.`;
        }
        // NOTE: We never "Incite Violence", it's not worth the trouble of generating a handful of contracts/operations. Just wait it out.
        // NOTE: We never "Recruit". Community consensus is that team mates die too readily, and have minimal impact on success.
        // NOTE: We don't use the "Hyperbolic Regeneration Chamber". We are cautious enough that we should never need healing.
    }

    // Detect our current action (API returns an object like { "type":"Operation", "name":"Investigation" })
    const currentAction = await getBBInfo(ns, `getCurrentAction()`);
    // Change actions if we're not currently doing the desired action
    if (bestActionName != currentAction.name) {
        const bestActionType = nextBlackOp == bestActionName ? "Black Op" : contractNames.includes(bestActionName) ? "Contract" :
            operationNames.includes(bestActionName) ? "Operation" : "General Action";
        const success = await getBBInfo(ns, `startAction(ns.args[0], ns.args[1])`, bestActionType, bestActionName);
        log(ns, (success ? 'INFO: Switched' : 'ERROR: Failed to switch') + ` to Bladeburner ${bestActionType} "${bestActionName}" (${reason}).`,
            !success, success ? (options['toast-operations'] ? 'info' : undefined) : 'error');
    }
}

/** @param {NS} ns 
 * Decides how to spend skill points. */
async function spendSkillPoints(ns) {
    while (true) { // Loop until we determine there's nothing left to spend skill points on
        const unspent = await getBBInfo(ns, 'getSkillPoints()');
        if (unspent == 0) return;
        const skillLevels = await getBBDict(ns, 'getSkillLevel(%)', skillNames);
        const skillCosts = await getBBDict(ns, 'getSkillUpgradeCost(%)', skillNames);
        // In general, we will buy the skill upgrade with the next highest cost, but to tweak the priority of various skills,
        // we use the following configuration to change their relative cost. Higher number means lower priority
        const costAdjustments = { "Overclock": 0.5, "Hyperdrive": 2, "Tracer": 3, "Cyber's Edge": 5, "Hands of Midas": 10 };
        // Find the next lowest skill cost
        let skillToUpgrade, minPercievedCost = Number.MAX_SAFE_INTEGER;
        for (const skillName of skillNames) {
            let percievedCost = skillCosts[skillName] * (costAdjustments[skillName] || 1);
            // Bitburner bug workaround: Overclock is capped at lvl 90, but the cost does not return e.g. Infinity
            if (skillName === "Overclock" && skillLevels[skillName] == 90) percievedCost = Number.POSITIVE_INFINITY;
            if (percievedCost < minPercievedCost)
                [skillToUpgrade, minPercievedCost] = [skillName, percievedCost];
        }
        // If the percieved or actual cost of the next best upgrade is too high, save our remaining points for later
        if (minPercievedCost > unspent || skillCosts[skillToUpgrade] > unspent) return;
        // Otherwise, purchase the upgrade
        if (await getBBInfo(ns, `upgradeSkill(ns.args[0])`, skillToUpgrade))
            log(ns, `SUCCESS: Upgraded Bladeburner skill ${skillToUpgrade}`, false, options['toast-upgrades'] ? 'success' : undefined);
        else
            log(ns, `WARNING: Something went wrong while trying to upgrade Bladeburner skill ${skillToUpgrade}. ` +
                `Currently have ${unspent} SP, upgrade should cost ${skillCosts[skillToUpgrade]} SP.`, false, 'warning');
        await ns.asleep(10);
    }
}

/** @param {NS} ns 
 * Ensure we're in the bladeburner division and faction */
async function beingInBladeburner(ns) {
    // Ensure we're in the bladeburner division. If not, wait until we've joined it.
    while (!player.inBladeburner) {
        try {
            if (player.strength < 100 || player.defense < 100 || player.dexterity < 100 || player.agility < 100)
                log(`Waiting for physical stats >100 to join bladeburner ` +
                    `(Currently Str: ${player.strength}, Def: ${player.defense}, Dex: ${player.dexterity}, Agi: ${player.agility})`);
            else if (await getNsDataThroughFile(ns, 'ns.bladeburner.joinBladeburnerDivision()', '/Temp/bladeburner-join.txt')) {
                log('SUCCESS: Joined Bladeburner!', false, 'success');
                break;
            } else
                log('WARNING: Failed to joined Bladeburner despite physical stats. Will try again...', false, 'warning');
            player = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
        }
        catch (error) { log(ns, `WARNING: Caught an error while waiting to join bladeburner, but will keep going:\n${String(error)}`, true, 'error'); }
        await ns.asleep(5000);
    }
    // Ensure we're also in the bladeburner faction
    await getNsDataThroughFile(ns, 'ns.bladeburner.joinBladeburnerFaction()', '/Temp/bladeburner-join-faction.txt');
}