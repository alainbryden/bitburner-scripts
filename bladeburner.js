import { log, disableLogs, getNsDataThroughFile, getActiveSourceFiles, formatNumberShort } from './helpers.js'

const cityNames = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"];
const antiChaosOperation = "Stealth Retirement Operation"; // Note: Faster and more effective than Diplomacy at reducing city chaos
const simulacrumAugName = "The Blade's Simulacrum"; // This augmentation lets you do bladeburner actions while busy

// In general, we will buy the skill upgrade with the next highest cost, but to tweak the priority of various skills,
// we use the following configuration to change their relative cost. Higher number means lower priority
// Note: Ideally we could emphasize Tracer "early-game" and Digital Observer "late-game", but this is too much of a pain to solve for
const costAdjustments = {
    "Reaper": 1.2, // Combat boost. Early effect is paltry (because stats are so low), will get plenty of points late game
    "Evasive Systems": 1.2, // Dex/Agi boost. Mildly deprioritized for same reasoning as above.
    "Cloak": 1.5, // Cheap, and stealth ends up with plenty of boost, so we don't need to invest in Cloak as much.
    "Overclock": 2, // While useful when playing manually, in practice, constant automation makes us not notice/care about completion times
    "Hyperdrive": 2, // Improves stats gained, but not Rank gained. Less useful if training outside of BB
    "Tracer": 2, // Only boosts Contract success chance, which are relatively easy to begin with. 
    "Cyber's Edge": 5, // Boosts stamina, but contract counts are much more limiting than stamina, so isn't really needed
    "Hands of Midas": 10 // Improves money gain. It is assumed that Bladeburner will *not* be a main source of income
};

// Some bladeburner info gathered at startup and cached
let skillNames, generalActionNames, contractNames, operationNames, remainingBlackOpsNames, blackOpsRanks;
let inFaction, haveSimulacrum, lastBlackOpReady, lowStaminaTriggered, timesTrained;
let player, ownedSourceFiles;
let options;
const argsSchema = [
    ['success-threshold', 0.98], // Attempt the best action whose minimum chance of success exceeds this threshold
    ['chaos-recovery-threshold', 50], // Prefer to do "Stealth Retirement" operations to reduce chaos when it reaches this number
    ['max-chaos', 200], // If chaos exceeds this amount in every city, we will reluctantly resort to diplomacy to reduce it.
    ['toast-upgrades', false], // Set to true to toast each time a skill is upgraded
    ['toast-operations', false], // Set to true to toast each time we switch operations
    ['toast-relocations', false], // Set to true to toast each time we change cities
    ['low-stamina-pct', 0.5], // Switch to no-stamina actions when we drop below this stamina percent
    ['high-stamina-pct', 0.6], // Switch back to stamina-consuming actions when we rise above this stamina percent
    ['training-limit', 100], // Don't bother training more than this many times, since Training earns no rank
    ['update-interval', 5000], // How often to refresh bladeburner status
    ['ignore-busy-status', false], // If set to true, we will attempt to do bladeburner tasks even if we are currently busy and don't have The Blade's Simulacrum
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
    ownedSourceFiles = await getActiveSourceFiles(ns);
    //if (!(6 in ownedSourceFiles) && player.bitNodeN != 7) // NOTE: Despite the SF6 description, it seems you don't need SF6
    //    return log(ns, "ERROR: You have no yet unlocked bladeburner outside of BNs 6 & 7 (need SF6)", true, 'error');
    if (!(7 in ownedSourceFiles))
        return log(ns, "ERROR: You have no yet unlocked the bladeburner API (need SF7)", true, 'error');
    if (player.bitNodeN == 8)
        return log(ns, "ERROR: Bladeburner is completely disabled in Bitnode 8 :`(\nHappy stonking", true, 'error');
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
    // Check if we have the aug that lets us do bladeburner while otherwise busy
    haveSimulacrum = await getNsDataThroughFile(ns, `ns.getOwnedAugmentations().includes("${simulacrumAugName}")`, '/Temp/bladeburner-hasSimulacrum.txt');
    // Initialize some flags that may change over time
    lastBlackOpReady = false; // Flag will track whether we've notified the user that the last black-op is ready
    lowStaminaTriggered = false; // Flag will track whether we've previously switched to stamina recovery to reduce noise
    timesTrained = 0; // Count of how many times we've trained (capped at --training-limit)
    inFaction = player.factions.includes("Bladeburners"); // Whether we've joined the Bladeburner faction yet
}

// Helpers to determine the the dict keys with the lowest/highest value (returns an array [key, minValue] for destructuring)
const getMinKeyValue = (dict, filteredKeys = null) => (filteredKeys || Object.keys(dict)).reduce(([k, min], key) =>
    dict[key] < min ? [key, dict[key]] : [k, min], [null, Number.MAX_VALUE]);
const getMaxKeyValue = (dict, filteredKeys = null) => (filteredKeys || Object.keys(dict)).reduce(([k, max], key) =>
    dict[key] > max ? [key, dict[key]] : [k, max], [null, -Number.MAX_VALUE]);

/** @param {NS} ns 
 * The main loop that decides what we should be doing in bladeburner. */
async function mainLoop(ns) {
    // Get player's updated rank
    const rank = await getBBInfo(ns, 'getRank()');
    // Ensure we're in the bladeburner faction ASAP
    if (!inFaction) await tryJoinFaction(ns, rank);
    // Spend any un-spent skill points
    await spendSkillPoints(ns);
    // See if we are able to do bladeburner work
    if (!(await canDoBladeburnerWork(ns))) return;

    // NEXT STEP: Gather data needed to determine what and where to work
    // If any blackops have been completed, remove them from the list of remaining blackops
    const blackOpsToBeDone = await getBBDictByActionType(ns, 'getActionCountRemaining', "blackops", remainingBlackOpsNames);
    remainingBlackOpsNames = remainingBlackOpsNames.filter(n => blackOpsToBeDone[n] === 1);

    // Gather the count of available contracts / operations
    const nextBlackOp = remainingBlackOpsNames[0];
    const contractCounts = await getBBDictByActionType(ns, 'getActionCountRemaining', "contract", contractNames);
    const operationCounts = await getBBDictByActionType(ns, 'getActionCountRemaining', "operation", operationNames);
    // Define a helper that gets the count for an action based only on the name (type is auto-determined)
    const getCount = actionName => contractNames.includes(actionName) ? contractCounts[actionName] :
        operationNames.includes(actionName) ? operationCounts[actionName] :
            generalActionNames.includes(actionName) ? Number.POSITIVE_INFINITY : remainingBlackOpsNames.includes(actionName) ? 1 : 0;

    // Get the population, communities, and chaos in each city
    const populationByCity = await getBBDict(ns, 'getCityEstimatedPopulation(%)', cityNames);
    const communitiesByCity = await getBBDict(ns, 'getCityCommunities(%)', cityNames);
    const chaosByCity = await getBBDict(ns, 'getCityChaos(%)', cityNames);

    // NEXT STEP: Determine which city to work in
    let goToCity, population, travelReason, goingRaiding = false;
    let [highestPopCity, _] = getMaxKeyValue(populationByCity, cityNames);
    // SPECIAL CASE: If the only operations left to us are "Raid" (reduces population by a %, which counter-intuitively
    // is bad for us), move to the city with the lowest population, but still having some communities to raid.
    // We will also exclude "Stealth Retirement Operation" since we try to save those for chaos reduction
    if (getCount("Raid") > 0 && !operationNames.filter(o => o != "Raid" && o != "Stealth Retirement Operation").some(c => getCount(c) > 0)) {
        // Collect a list of cities with at least one community
        const raidableCities = cityNames.filter(c => communitiesByCity[c] > 0);
        // Only allow raid if we would not be raiding our highest-population city (need to maintain at least one)
        goingRaiding = raidableCities.length > 1 || raidableCities[0] != highestPopCity;
        // Move to the city with the smallest population which has more than 1 community so that we can use our Raid operations.
        if (goingRaiding) {
            [goToCity, population] = getMinKeyValue(populationByCity, raidableCities);
            travelReason = `Lowest population (${formatNumberShort(population)}) city with communities (${communitiesByCity[goToCity]}) to use up Raid operations`;
        }
    }
    if (!goToCity) { // Otherwise, cities with higher populations give better operation chances
        // Try to narrow down the cities we wish to work in to the ones with no chaos penalties
        let acceptableCities = cityNames.filter(city => chaosByCity[city] <= options['chaos-recovery-threshold']);
        // Pick the city (within chaos thresholds) with the highest population to maximize success chance.
        // If no city is within thresholds, the largest population city will be picked regardless of chaos
        [goToCity, population] = getMaxKeyValue(populationByCity, acceptableCities.length > 0 ? acceptableCities : cityNames);
        travelReason = `Highest population (${formatNumberShort(population)}) city, with chaos ${chaosByCity[goToCity].toFixed(1)}` +
            (acceptableCities.length == 0 ? ` (all cities above chaos threshold of ${options['chaos-recovery-threshold']})` : '');
    }

    let currentCity = await getBBInfo(ns, 'getCity()');
    if (currentCity != goToCity) {
        const success = await getBBInfo(ns, `switchCity(ns.args[0])`, goToCity);
        log(ns, (success ? 'INFO: Switched' : 'ERROR: Failed to switch') + ` to Bladeburner city "${goToCity}" (${travelReason})`,
            !success, success ? (options['toast-relocations'] ? 'info' : undefined) : 'error');
        if (success) currentCity = goToCity;
    }

    // Gather the success chance of contracts (based on our current city)
    const contractChances = await getBBDictByActionType(ns, 'getActionEstimatedSuccessChance', "contract", contractNames);
    const operationChances = await getBBDictByActionType(ns, 'getActionEstimatedSuccessChance', "operation", operationNames);
    // If our rank is insufficient to perform the next blackops, ignore the stated chance and treat it as zero
    const blackOpsChance = rank < blackOpsRanks[nextBlackOp] ? [0, 0] :
        (await getBBDictByActionType(ns, 'getActionEstimatedSuccessChance', "blackops", [nextBlackOp]))[nextBlackOp];
    // Define some helpers for determining min/max chance for each action
    const getChance = actionName => contractNames.includes(actionName) ? contractChances[actionName] :
        operationNames.includes(actionName) ? operationChances[actionName] :
            generalActionNames.includes(actionName) ? [1, 1] : nextBlackOp == actionName ? blackOpsChance : [0, 0];
    const minChance = actionName => getChance(actionName)[0];
    const maxChance = actionName => getChance(actionName)[1];

    // NEXT STEP: Pick the action we should be working on.
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
    } else { // Otherwise, pick the "highest-tier" action we can confidently perform, which should lead to the fastest rep-gain.
        // Note: Candidate actions will be maintained in order of highest-rep to lowest-rep earning, so we can pick the first after filtering.
        let candidateActions = [nextBlackOp].concat(operationNames).concat(contractNames); // Note: General actions excluded for now
        // We should deal with population uncertainty if its causing some mission to be on the verge of our success threshold
        let populationUncertain = candidateActions.some(a => maxChance(a) > options['success-threshold'] && minChance(a) < options['success-threshold']);
        // If current population uncertainty is such that some actions have a maxChance of ~100%, but not a minChance of ~100%,
        //   focus on actions that improve the population estimate.
        if (populationUncertain) candidateActions = ["Undercover Operation", "Investigation", "Tracking"];
        // Special case: If Synthoid community count is 0 in a city, set effective remaining "Raid" operations
        if (communitiesByCity[currentCity] == 0) operationCounts["Raid"] = 0;
        // Filter out candidates with no contract counts remaining
        candidateActions = candidateActions.filter(a => getCount(a) > 0);
        // SPECIAL CASE: If we can complete the last bladeburner operation, leave it to the user (they may not be ready to leave the BN).
        if (remainingBlackOpsNames.length == 1 && minChance(nextBlackOp) > options['success-threshold']) {
            if (!lastBlackOpReady) log(ns, "SUCCESS: Bladeburner is ready to undertake the last BlackOp when you are!", true, 'success')
            lastBlackOpReady = true;
            candidateActions = candidateActions.filter(a => a != nextBlackOp);
        }
        // SPECIAL CASE: Leave out "Stealth Retirement" from normal rep-grinding - save it for reducing chaos unless there's nothing else to do
        if (candidateActions.length > 1) candidateActions = candidateActions.filter(a => a != "Stealth Retirement Operation");
        // SPECIAL CASE: Leave out "Raid" unless we've specifically moved to the lowest population city for Raiding
        if (!goingRaiding) candidateActions = candidateActions.filter(a => a != "Raid");
        // Pick the first candidate action with a minimum chance of success that exceeds our --success-threshold
        bestActionName = candidateActions.filter(a => minChance(a) > options['success-threshold'])[0];
        if (!bestActionName) // If there were none, allow us to fall-back to an action with a minimum chance >50%, and maximum chance > threshold
            bestActionName = candidateActions.filter(a => minChance(a) > 0.5 && maxChance(a) > options['success-threshold'])[0];
        if (bestActionName) // If we found something to do, log details about its success chance range
            reason = `Success Chance: ${(100 * minChance(bestActionName)).toFixed(1)}%` +
                (maxChance(bestActionName) - minChance(bestActionName) < 0.1 ? '' : ` to ${(100 * maxChance(bestActionName)).toFixed(1)}%`) +
                `, Remaining: ${getCount(bestActionName)}`;

        // If there were no operations/contracts, resort to a "general action" which always have 100% chance, but take longer and gives less reward
        if (!bestActionName && !populationUncertain && staminaPct > options['high-stamina-pct'] && timesTrained < options['training-limit']) {
            timesTrained += options['update-interval'] / 30000; // Take into account the training time (30 seconds) vs how often this code is called
            bestActionName = "Training";
            reason = `Nothing better to do, and times trained (${timesTrained.toFixed(0)}) < --training-limit (${options['training-limit']})`;
        } else if (!bestActionName) {
            bestActionName = "Field Analysis"; // Gives a little rank, and improves population estimate. Best we can do when there's nothing else.
            reason = populationUncertain ? `High population uncertainty in ${currentCity}` : `Nothing better to do.`;
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
 * Helper to try and join the Bladeburner faction ASAP. */
async function tryJoinFaction(ns, rank) {
    if (inFaction) return;
    if (rank >= 25 && await getBBInfo(ns, 'joinBladeburnerFaction()')) {
        log(ns, 'SUCCESS: Joined the Bladeburner Faction!', false, 'success');
        inFaction = true;
    } else if (rank >= 25)
        log(ns, `WARNING: Failed to join the Bladeburner faction despite rank of ${rank.toFixed(1)}`, false, 'warning');
}

/** @param {NS} ns 
 * Helper to see if we are able to do bladeburner work */
async function canDoBladeburnerWork(ns) {
    if (options['ignore-busy-status'] || haveSimulacrum) return true;
    // Check if the player is busy doing something else
    const busy = await getNsDataThroughFile(ns, 'ns.isBusy()', '/Temp/isBusy.txt');
    if (!busy) return true;
    log(ns, `WARNING: Cannot perform Bladeburner actions because the player is busy ` +
        `and hasn't installed the augmentation "${simulacrumAugName}"...`, false, 'warning');
    return false;
}

/** @param {NS} ns 
 * Ensure we're in the Bladeburner division */
async function beingInBladeburner(ns) {
    // Ensure we're in the Bladeburner division. If not, wait until we've joined it.
    while (!player.inBladeburner) {
        try {
            if (player.strength < 100 || player.defense < 100 || player.dexterity < 100 || player.agility < 100)
                log(ns, `Waiting for physical stats >100 to join bladeburner ` +
                    `(Currently Str: ${player.strength}, Def: ${player.defense}, Dex: ${player.dexterity}, Agi: ${player.agility})`);
            else if (await getNsDataThroughFile(ns, 'ns.bladeburner.joinBladeburnerDivision()', '/Temp/bladeburner-join.txt')) {
                let message = 'SUCCESS: Joined Bladeburner!';
                if (9 in ownedSourceFiles) message += ' Consider running the following command to give it a boost:\n' +
                    'run spend-hacknet-hashes.js --spend-on Exchange_for_Bladeburner_Rank --spend-on Exchange_for_Bladeburner_SP --liquidate';
                log(ns, message, true, 'success');
                break;
            } else
                log(ns, 'WARNING: Failed to joined Bladeburner despite physical stats. Will try again...', false, 'warning');
            player = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
        }
        catch (error) { log(ns, `WARNING: Caught an error while waiting to join bladeburner, but will keep going:\n${String(error)}`, true, 'error'); }
        await ns.asleep(5000);
    }
    log(ns, "INFO: We are in Bladeburner. Starting main loop...")
}