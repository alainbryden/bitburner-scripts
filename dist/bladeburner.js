import { log, disableLogs, getNsDataThroughFile, runCommand, getActiveSourceFiles, formatNumberShort, formatDuration } from './helpers.js'

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
let inFaction, haveSimulacrum, lastBlackOpReady, lowStaminaTriggered, timesTrained, currentTaskEndTime;
let player, ownedSourceFiles;
let options;
const argsSchema = [
    ['success-threshold', 0.99], // Attempt the best action whose minimum chance of success exceeds this threshold
    ['chaos-recovery-threshold', 50], // Prefer to do "Stealth Retirement" operations to reduce chaos when it reaches this number
    ['max-chaos', 100], // If chaos exceeds this amount in every city, we will reluctantly resort to diplomacy to reduce it.
    ['toast-upgrades', false], // Set to true to toast each time a skill is upgraded
    ['toast-operations', false], // Set to true to toast each time we switch operations
    ['toast-relocations', false], // Set to true to toast each time we change cities
    ['low-stamina-pct', 0.5], // Switch to no-stamina actions when we drop below this stamina percent
    ['high-stamina-pct', 0.6], // Switch back to stamina-consuming actions when we rise above this stamina percent
    ['training-limit', 50], // Don't bother training more than this many times, since Training is slow and earns no rank
    ['update-interval', 2000], // How often to refresh bladeburner status
    ['ignore-busy-status', false], // If set to true, we will attempt to do bladeburner tasks even if we are currently busy and don't have The Blade's Simulacrum
    ['allow-raiding-highest-pop-city', false], // Set to true, we will allow Raid to be used even in our highest-population city (disabled by default)
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
        const nextTaskComplete = currentTaskEndTime - Date.now();
        await ns.asleep(Math.min(options['update-interval'], nextTaskComplete > 0 ? nextTaskComplete : Number.MAX_VALUE));
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
    currentTaskEndTime = 0; // When set to a date, we will not assign new tasks until that date.
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
    // Create some quick-reference collections of action names that are limited in count and/or reserved for special purpose
    const limitedActions = [nextBlackOp].concat(operationNames).concat(contractNames);
    const reservedOperations = ["Raid", "Stealth Retirement Operation", nextBlackOp];
    const unreservedOperations = limitedActions.filter(o => !reservedOperations.includes(o));

    // NEXT STEP: Determine which city to work in
    // Get the population, communities, and chaos in each city
    const populationByCity = await getBBDict(ns, 'getCityEstimatedPopulation(%)', cityNames);
    const communitiesByCity = await getBBDict(ns, 'getCityCommunities(%)', cityNames);
    const chaosByCity = await getBBDict(ns, 'getCityChaos(%)', cityNames);
    let goToCity, population, travelReason, goingRaiding = false;

    // SPECIAL CASE: GO TO LOWEST-POPULATION CITY
    // If the only operations left to us are "Raid" (reduces population by a %, which, counter-intuitively, is bad for us),
    // thrash the city with the lowest population (but still having some communities to enable Raid).
    if (getCount("Raid") > 0 && !operationNames.filter(o => !reservedOperations.includes(o)).some(c => getCount(c) > 0)) {
        const raidableCities = cityNames.filter(c => communitiesByCity[c] > 0); // Cities with at least one community
        // Only allow Raid if we would not be raiding our highest-population city (need to maintain at least one)
        const [highestPopCity, _] = getMaxKeyValue(populationByCity, cityNames);
        goingRaiding = raidableCities.length > 0 && (raidableCities[0] != highestPopCity || options['allow-raiding-highest-pop-city']);
        if (goingRaiding) { // Select the raid-able city with the smallest population
            [goToCity, population] = getMinKeyValue(populationByCity, raidableCities);
            travelReason = `Lowest population (${formatNumberShort(population)}) city with communities (${communitiesByCity[goToCity]}) to use up ${getCount("Raid")} Raid operations`;
        }
    }
    // SPECIAL CASE: GO TO HIGHEST-CHAOS CITY
    if (!goToCity && !unreservedOperations.some(c => getCount(c) > 0)) {
        let [maxChaosCity, maxChaos] = getMaxKeyValue(chaosByCity, cityNames);
        // If all we have left is "Stealth Retirement Operation", switch to the city with the most chaos (if it's a decent amount), and use them up.
        if (getCount("Stealth Retirement Operation") && maxChaos > options['chaos-recovery-threshold']) {
            goToCity = maxChaosCity;
            travelReason = `Highest-chaos (${maxChaos.toFixed(1)}) city to use up Stealth Retirement Operations`;
        } else if (maxChaos > options['max-chaos']) {
            goToCity = maxChaosCity;
            travelReason = `Nothing better to do, and city chaos ${maxChaos.toFixed(1)} is above --max-chaos threshold ${options['max-chaos']} - should use Diplomacy`;
        }
    } // Also, if we have nothing to do (even no Stealth Retirement), but chaos is above 'max-chaos' in some city, switch to it to do Diplomacy

    // GENERAL CASE: GO TO HIGHEST-POPULATION CITY
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
    // Change cities if we aren't blocked on our last task, and found a better city to work in
    if (currentCity != goToCity && Date.now() > currentTaskEndTime && (await switchToCity(ns, goToCity, travelReason)))
        currentCity = goToCity;

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
    const actionSummaryString = (action) => `Success Chance: ${(100 * minChance(action)).toFixed(1)}%` +
        (maxChance(action) - minChance(action) < 0.001 ? '' : ` to ${(100 * maxChance(action)).toFixed(1)}%`) + `, Remaining: ${getCount(action)}`

    // Trigger stamina recovery if we drop below our --low-stamina-pct configuration, and remain trigered until we've recovered to --high-stamina-pct
    const stamina = await getBBInfo(ns, `getStamina()`); // Returns [current, max];
    const staminaPct = stamina[0] / stamina[1];
    lowStaminaTriggered = staminaPct < options['low-stamina-pct'] || lowStaminaTriggered && staminaPct < options['high-stamina-pct'];
    // If we are suffering a stamina penalty, perform an action that consumes no stamina
    if (lowStaminaTriggered) {
        bestActionName = chaosByCity[currentCity] > options['max-chaos'] ? "Diplomacy" : "Field Analysis";
        reason = `Stamina is low: ${(100 * staminaPct).toFixed(1)}% < ${(100 * options['low-stamina-pct']).toFixed(1)}%`
    } // If current city chaos is greater than our threshold, keep it low with "Stealth Retirement" if odds are good
    else if (chaosByCity[currentCity] > options['chaos-recovery-threshold'] && getCount(antiChaosOperation) > 0 && minChance(antiChaosOperation) > 0.99) {
        bestActionName = antiChaosOperation;
        reason = `Chaos is high: ${chaosByCity[currentCity].toFixed(2)} > ${options['chaos-recovery-threshold']} (--chaos-recovery-threshold) ${actionSummaryString(bestActionName)}`;
    } // If current city chaos is very high, we should be very wary of the snowballing effects, and try to reduce it.
    else if (chaosByCity[currentCity] > options['max-chaos']) {
        bestActionName = getCount(antiChaosOperation) > 0 && minChance(antiChaosOperation) > 0.8 ? antiChaosOperation : "Diplomacy";
        reason = `Out of ${antiChaosOperation}s, and chaos ${chaosByCity[currentCity].toFixed(2)} is higher than --max-chaos ${options['max-chaos']}`;
    } // If we've previously detemined we will be raiding the lowest-population city
    else if (goingRaiding && maxChance("Raid") > options['success-threshold']) { // Special-case: Ignore min-chance. Population estimate turns bad as we decimate it, but doesn't seem to affect success.
        bestActionName = "Raid";
        reason = `Only remaining Operations. ${actionSummaryString(bestActionName)}`;
    } else { // Otherwise, pick the "highest-tier" action we can confidently perform, which should lead to the fastest rep-gain.
        // Note: Candidate actions will be maintained in order of highest-rep to lowest-rep earning, so we can pick the first after filtering.
        let candidateActions = limitedActions;
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
            reason = actionSummaryString(bestActionName);

        // If there were no operations/contracts, resort to a "general action" which always have 100% chance, but take longer and gives less reward
        if (!bestActionName) {
            if (populationUncertain) { // Lower population uncertainty
                bestActionName = "Field Analysis";
                reason = `High population uncertainty in ${currentCity}`;
            } // If all (non-reserved) operation counts are 0, and chaos isn't too high, Incite Violence to get more work (logic above should subsequently reduce chaos)
            else if (unreservedOperations.every(a => getCount(a) == 0) && cityNames.every(c => chaosByCity[c] < options['max-chaos'])) {
                bestActionName = "Incite Violence";
                let [maxChaosCity, maxChaos] = getMaxKeyValue(chaosByCity, cityNames);
                reason = `No work available, and max city chaos is ${maxChaos.toFixed(1)} in ${maxChaosCity}, ` +
                    `which is less than --max-chaos threshold ${options['max-chaos']}`;
            }// Otherwise, consider training
            else if (unreservedOperations.some(a => maxChance(a) < options['success-threshold']) && // Only if we aren't at 100% chance for everything
                staminaPct > options['high-stamina-pct'] && timesTrained < options['training-limit']) { // Only if we have plenty of stamina and have barely trained
                timesTrained += options['update-interval'] / 30000; // Take into account the training time (30 seconds) vs how often this code is called
                bestActionName = "Training";
                reason = `Nothing better to do, times trained (${timesTrained.toFixed(0)}) < --training-limit (${options['training-limit']}), and ` +
                    `some actions are below success threshold: ` + unreservedOperations.filter(a => maxChance(a) < options['success-threshold'])
                        .map(a => `${a} (${(100 * maxChance(a)).toFixed(1)})`).join(", ");
            } else { // Otherwise, Field Analysis
                bestActionName = "Field Analysis"; // Gives a little rank, and improves population estimate. Best we can do when there's nothing else.
                reason = `Nothing better to do`;
            }
        }
        // NOTE: We never "Recruit". Community consensus is that team mates die too readily, and have minimal impact on success.
        // NOTE: We don't use the "Hyperbolic Regeneration Chamber". We are cautious enough that we should never need healing.
    }

    // Detect our current action (API returns an object like { "type":"Operation", "name":"Investigation" })
    const currentAction = await getBBInfo(ns, `getCurrentAction()`);

    // Normally, we don't switch tasks if our previously assigned task hasn't had time to complete once.
    // EXCEPTION: Early after a reset, this time is LONG, and in a few seconds it may be faster to just stop and restart it.
    const currentDuration = await getBBInfo(ns, `getActionTime(ns.args[0], ns.args[1])`, currentAction.type, currentAction.name);
    if (currentDuration < currentTaskEndTime - Date.now()) {
        log(ns, `INFO: ${bestActionName == currentAction.name ? 'Restarting' : 'Cancelling'} action ${currentAction.name} because its new duration ` +
            `is less than the time remaining (${formatDuration(currentDuration)} < ${formatDuration(currentTaskEndTime - Date.now())})`);
    } else if (Date.now() < currentTaskEndTime || bestActionName == currentAction.name) return;

    // Change actions if we're not currently doing the desired action
    const bestActionType = nextBlackOp == bestActionName ? "Black Op" : contractNames.includes(bestActionName) ? "Contract" :
        operationNames.includes(bestActionName) ? "Operation" : "General Action";
    const success = await getBBInfo(ns, `startAction(ns.args[0], ns.args[1])`, bestActionType, bestActionName);
    const expectedDuration = await getBBInfo(ns, `getActionTime(ns.args[0], ns.args[1])`, bestActionType, bestActionName);
    log(ns, (!success ? `ERROR: Failed to switch to Bladeburner ${bestActionType} "${bestActionName}"` :
        `INFO: Switched to Bladeburner ${bestActionType} "${bestActionName}" (${reason}). ETA: ${formatDuration(expectedDuration)}`),
        !success, success ? (options['toast-operations'] ? 'info' : undefined) : 'error');
    // Ensure we perform this new action at least once before interrupting it
    currentTaskEndTime = !success ? 0 : Date.now() + expectedDuration + 200; // Pad this a little to ensure we don't interrupt it.
}

/** @param {NS} ns 
 * Helper to switch cities. */
async function switchToCity(ns, city, reason) {
    const success = await getBBInfo(ns, `switchCity(ns.args[0])`, city);
    log(ns, (success ? 'INFO: Switched' : 'ERROR: Failed to switch') + ` to Bladeburner city "${city}" (${reason})`,
        !success, success ? (options['toast-relocations'] ? 'info' : undefined) : 'error');
    return success;
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