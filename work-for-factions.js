import {
    getNsDataThroughFile, runCommand, getActiveSourceFiles, tryGetBitNodeMultipliers,
    formatDuration, formatMoney, formatNumberShort, disableLogs, log
} from './helpers.js'

let options;
const argsSchema = [
    ['first', []], // Grind rep with these factions first. Also forces a join of this faction if we normally wouldn't (e.g. no desired augs or all augs owned)
    ['skip', []], // Don't work for these factions
    ['o', false], // Immediately grind company factions for rep after getting their invite, rather than first getting all company invites we can
    ['desired-stats', []], // Factions will be removed from our 'early-faction-order' once all augs with these stats have been bought out
    ['no-focus', false], // Disable doing work that requires focusing (crime), and forces study/faction/company work to be non-focused (even if it means incurring a penalty)
    ['no-studying', false], // Disable studying for Charisma. Useful in longer resets when Cha augs are insufficient to meet promotion requirements
    ['no-coding-contracts', false], // Disable purchasing coding contracts for reputation
    ['no-crime', false], // Disable doing crimes at all. (Also disabled with --no-focus)
    ['crime-focus', false], // Useful in crime-focused BNs when you want to focus on crime related factions
    ['fast-crimes-only', false], // Assasination and Heist are so slow, I can see people wanting to disable them just so they can interrupt at will.
    ['invites-only', false], // Just work to get invites, don't work for augmentations / faction rep
    ['prioritize-invites', false], // Prioritize working for as many invites as is practical before starting to grind for faction reputation
    ['karma-threshold-for-gang-invites', -40000], // Prioritize working for gang invites once we have this much negative Karma
];

const companySpecificConfigs = [
    { name: "NWO", statModifier: 25 },
    { name: "MegaCorp", statModifier: 25 },
    { name: "Blade Industries", statModifier: 25 },
    { name: "Fulcrum Secret Technologies", companyName: "Fulcrum Technologies", repRequiredForFaction: 250000 }, // Special snowflake
    { name: "Silhouette", companyName: "TBD", repRequiredForFaction: 999e9 /* Hack to force work until max promotion. */ }
]
const jobs = [ // Job stat requirements for a company with a base stat modifier of +224 (modifier of all megacorps except the ones above which are 25 higher)
    { name: "it", reqRep: [0, 7E3, 35E3, 175E3], reqHack: [225, 250, 275, 375], reqCha: [0, 0, 275, 300], repMult: [0.9, 1.1, 1.3, 1.4] },
    { name: "software", reqRep: [0, 8E3, 40E3, 200E3, 400E3, 800E3, 1.6e6, 3.2e6], reqHack: [225, 275, 475, 625, 725, 725, 825, 975], reqCha: [0, 0, 275, 375, 475, 475, 625, 725], repMult: [0.9, 1.1, 1.3, 1.5, 1.6, 1.6, 1.75, 2] },
]
const factions = ["Illuminati", "Daedalus", "The Covenant", "ECorp", "MegaCorp", "Bachman & Associates", "Blade Industries", "NWO", "Clarke Incorporated", "OmniTek Incorporated",
    "Four Sigma", "KuaiGong International", "Fulcrum Secret Technologies", "BitRunners", "The Black Hand", "NiteSec", "Aevum", "Chongqing", "Ishima", "New Tokyo", "Sector-12",
    "Volhaven", "Speakers for the Dead", "The Dark Army", "The Syndicate", "Silhouette", "Tetrads", "Slum Snakes", "Netburners", "Tian Di Hui", "CyberSec"]; //TODO: Add Bladeburner Automation at BN7.1
// These factions should ideally be completed in this order (TODO: Check for augmentation dependencies)
const preferredEarlyFactionOrder = [
    "Netburners", // Improve hash income, which is useful or critical for almost all BNs
    "Tian Di Hui", "Aevum", // These give all the company_rep and faction_rep bonuses early game    
    "CyberSec", /* Quick, and NightSec aug depends on an aug from here */ "NiteSec", "Tetrads", // Cha augs to speed up earning company promotions
    "Bachman & Associates", // Boost company/faction rep for future augs
    "Daedalus", // Once we have all faction_rep boosting augs, there's no reason not to work towards Daedalus as soon as it's available/feasible so we can buy Red Pill
    "Fulcrum Secret Technologies", // Will be removed if hack level is too low to backdoor their server
    "ECorp", // More cmp_rep augs, and some strong hack ones as well
    "BitRunners", "The Black Hand", // Fastest sources of hacking augs after the above companies
    "The Dark Army", // Unique cmp_rep aug TODO: Can it sensibly be gotten before corps? Requires 300 all combat stats.
    "Clarke Incorporated", "OmniTek Incorporated", "NWO", // More hack augs from companies
    "Chongqing", // Unique Source of big 1.4x hack exp boost (Can only join if not in e.g. Aevum as well)
];
// This is an approximate order of most useful augmentations left to offer, assuming all early-game factions have been cleaned out
const preferredCompanyFactionOrder = [
    "Bachman & Associates", // Augs boost company_rep by 1.65, faction_rep by 1.50. Lower rep-requirements than ECorp augs, so should be a priority to speed up future resets
    "ECorp", // Offers 2.26 multi worth of company_rep and major hacking stat boosts (1.51 hack / 1.54 exp / 1.43 success / 3.0 grow / 2.8 money / 1.25 speed), but high rep reqs
    "Clarke Incorporated", // Biggest boost to hacking after above factions (1.38)
    "OmniTek Incorporated", // Next big boost to hacking after above factions (1.20) (NWO is bigger, but this has lower Cha reqs.)
    "NWO", // Biggest boost to hacking after above factions (1.26)
    "Blade Industries", // Mostly redundant after Ecorp - provides remaining hack-related augs (1.10 money, 1.03 speed)
    "MegaCorp", // Offers 1 unique aug boosting all physical traits by 1.35
    "KuaiGong International", // 1.40 to agility, defense, strength
    "Fulcrum Secret Technologies", // Big boosts to company_rep and hacking, but requires high hack level to backdoor their server, so might have to be left until later
    "Four Sigma", // No unique augs, but note that if accessible early on, Fulcrum + Four Sigma is a one-two punch to get all company rep boosting augs in just 2 factions
]
// Order in which to focus on crime factions
const preferredCrimeFactionOrder = ["Netburners", "Slum Snakes", "NiteSec", "Tetrads", "The Black Hand", "The Syndicate", "The Dark Army", "Speakers for the Dead", "Daedalus"]
// Gang factions in order of ease-of-invite. If gangs are available, as we near 54K Karma to unlock gangs (as per --karma-threshold-for-gang-invites), we will attempt to get into any/all of these.
const desiredGangFactions = ["Slum Snakes", "The Syndicate", "The Dark Army", "Speakers for the Dead"];
const allGangFactions = ["Speakers for the Dead", "The Dark Army", "The Syndicate", "Slum Snakes", "The Black Hand", "NiteSec"];

const loopSleepInterval = 5000; // 5 seconds
const restartWorkInteval = 30 * 1000; // 30 seconds Collect e.g. rep earned by stopping and starting work;
const statusUpdateInterval = 60 * 1000; // 1 minute (outside of this, minor updates in e.g. stats aren't logged)
const checkForNewPrioritiesInterval = 10 * 60 * 1000; // 10 minutes. Interrupt whatever we're doing and check whether we could be doing something more useful.
let noFocus = false; // Can be set via command line to disable doing work that requires focusing (crime, studying, or focused faction/company work)
let noStudying = false; // Disable studying for Charisma. Useful in longer resets when Cha augs are insufficient to meet promotion requirements (Also disabled with --no-focus)
let noCrime = false; // Disable doing crimes at all. (Also disabled with --no-focus)
let crimeFocus = false; // Useful in crime-focused BNs when you want to focus on crime related factions
let fastCrimesOnly = false; // Can be set via command line argument
let prioritizeInvites = false;
let hasFocusPenaly = true;
let shouldFocusAtWork = false; // Whether we should focus on work or let it be backgrounded (based on whether "Neuroreceptor Management Implant" is owned, or "--no-focus" is specified)
let repToDonate = 150; // Updated after looking at bitnode mults
let lastActionRestart = 0;
let crimeCount = 0; // A simple count of crime commited since last script restart
let mostExpensiveAugByFaction = [];
let mostExpensiveDesiredAugByFaction = [];
let playerGang = null;
let dictFactionFavors;
let firstFactions = []; // Factions that end up in this list will be prioritized and joined regardless of their augmentations available.
let mainLoopStart;

export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (lastFlag == "--first" || lastFlag == "--skip")
        return factions.map(f => f.replaceAll(' ', '_')).sort();
    return [];
}

// Bit of an ugly afterthought, but this is all over the place to break out of whatever we're doing and return to the main loop.
const breakToMainLoop = () => Date.now() > mainLoopStart + checkForNewPrioritiesInterval;

/** @param {NS} ns */
export async function main(ns) {
    disableLogs(ns, ['sleep']);
    options = ns.flags(argsSchema);
    const desiredAugStats = options['desired-stats'];
    firstFactions = options.first = (options.first || []).map(f => f.replaceAll('_', ' '));
    let skipFactionsConfig = options.skip = (options.skip || []).map(f => f.replaceAll('_', ' '));
    noFocus = options['no-focus'];
    noStudying = options['no-studying'];
    noCrime = options['no-crime'] || noFocus; // Can't crime if we aren't allowed to steal focus
    crimeFocus = options['crime-focus'];
    prioritizeInvites = options['prioritize-invites'];
    if (crimeFocus && noFocus)
        return log(ns, "ERROR: Cannot use --no-focus and --crime-focus at the same time. You need to focus to do crime!", true, 'error');
    if (desiredAugStats.length == 0)
        desiredAugStats.push(...(crimeFocus ? ['str', 'def', 'dex', 'agi', 'faction_rep', 'hacking', 'hacknet', 'crime'] :
            ['hacking', 'faction_rep', 'company_rep', 'charisma', 'hacknet', 'crime_money']))
    fastCrimesOnly = options['fast-crimes-only'];
    const karmaThreshold = options['karma-threshold-for-gang-invites'];
    // Log command line args used
    if (firstFactions.length > 0) ns.print(`--first factions: ${firstFactions.join(", ")}`);
    if (skipFactionsConfig.length > 0) ns.print(`--skip factions: ${skipFactionsConfig.join(", ")}`);
    if (desiredAugStats.length > 0) ns.print(`--desired-stats matching: ${desiredAugStats.join(", ")}`);
    if (fastCrimesOnly) ns.print(`--fast-crimes-only`);

    let loadingComplete = false; // In the event of suboptimal RAM conditions, keep trying to start until we succeed
    let dictSourceFiles, numJoinedFactions, completedFactions, skipFactions, softCompletedFactions;
    while (!loadingComplete) {
        try {
            dictSourceFiles = await getActiveSourceFiles(ns); // Find out what source files the user has unlocked
            if (!(4 in dictSourceFiles))
                return log(ns, "ERROR: You cannot automate working for factions until you have unlocked singularity access (SF4).", true, 'error');
            else if (dictSourceFiles[4] < 3)
                log(ns, `WARNING: Singularity functions are much more expensive with lower levels of SF4 (you have SF4.${dictSourceFiles[4]}). ` +
                    `You may encounter RAM issues with and have to wait until you have more RAM available to run this script successfully.`, false, 'warning');

            let bitnodeMults = await tryGetBitNodeMultipliers(ns); // Find out the current bitnode multipliers (if available)
            repToDonate = 150 * (bitnodeMults?.RepToDonateToFaction || 1);
            crimeCount = 0;

            // Get some augmentation information to decide what remains to be purchased
            const dictFactionAugs = await getNsDataThroughFile(ns, dictCommand(factions, 'ns.getAugmentationsFromFaction(o)'), '/Temp/faction-augs.txt');
            const augmentationNames = [...new Set(Object.values(dictFactionAugs).flat())];
            const dictAugRepReqs = await getNsDataThroughFile(ns, dictCommand(augmentationNames, 'ns.getAugmentationRepReq(o)'), '/Temp/aug-repreqs.txt');
            const dictAugStats = await getNsDataThroughFile(ns, dictCommand(augmentationNames, 'ns.getAugmentationStats(o)'), '/Temp/aug-stats.txt');
            dictFactionFavors = await getNsDataThroughFile(ns, dictCommand(factions, 'ns.getFactionFavor(o)'), '/Temp/faction-favor.txt');

            const ownedAugmentations = await getNsDataThroughFile(ns, `ns.getOwnedAugmentations(true)`, '/Temp/player-augs-purchased.txt');
            const installedAugmentations = await getNsDataThroughFile(ns, `ns.getOwnedAugmentations()`, '/Temp/player-augs-installed.txt');
            hasFocusPenaly = !installedAugmentations.includes("Neuroreceptor Management Implant"); // Check if we have an augmentation that lets us not have to focus at work (always nicer if we can background it)
            shouldFocusAtWork = !noFocus && hasFocusPenaly; // Focus at work for the best rate of rep gain, unless focus activities are disabled via command line

            mostExpensiveAugByFaction = Object.fromEntries(factions.map(f => [f, dictFactionAugs[f]
                .filter(aug => !ownedAugmentations.includes(aug))
                .reduce((max, aug) => Math.max(max, dictAugRepReqs[aug]), -1)]));
            //ns.print("Most expensive unowned aug by faction: " + JSON.stringify(mostExpensiveAugByFaction));
            // TODO: Detect when the most expensive aug from two factions is the same - only need it from the first one. (Update lists and remove 'afforded' augs?)
            mostExpensiveDesiredAugByFaction = Object.fromEntries(factions.map(f => [f, dictFactionAugs[f]
                .filter(aug => !ownedAugmentations.includes(aug) && (Object.keys(dictAugStats[aug]).length == 0 || desiredAugStats.length == 0 ||
                    Object.keys(dictAugStats[aug]).some(key => desiredAugStats.some(stat => key.includes(stat)))))
                .reduce((max, aug) => Math.max(max, dictAugRepReqs[aug]), -1)]));
            //ns.print("Most expensive desired aug by faction: " + JSON.stringify(mostExpensiveDesiredAugByFaction));

            completedFactions = Object.keys(mostExpensiveAugByFaction).filter(fac => mostExpensiveAugByFaction[fac] == -1);
            softCompletedFactions = Object.keys(mostExpensiveDesiredAugByFaction).filter(fac => mostExpensiveDesiredAugByFaction[fac] == -1 && !completedFactions.includes(fac));
            skipFactions = skipFactionsConfig.concat(completedFactions).filter(fac => !firstFactions.includes(fac));
            if (completedFactions.length > 0)
                ns.print(`${completedFactions.length} factions are completed (all augs purchased): ${completedFactions.join(", ")}`);
            if (softCompletedFactions.length > 0)
                ns.print(`${softCompletedFactions.length} factions will initially be skipped (all desired augs purchased): ${softCompletedFactions.join(", ")}`);

            numJoinedFactions = (await getPlayerInfo(ns)).factions.length;
            var fulcrummHackReq = await getServerRequiredHackLevel(ns, "fulcrumassets");

            loadingComplete = true;
        } catch (err) {
            log(ns, 'WARNING: work-for-factions.js caught an unhandled error while starting up. Trying again in 5 seconds...\n' + err, true, 'warning');
            await ns.sleep(5000);
        }
    }

    let scope = 0; // Scope increases each time we complete a type of work and haven't progressed enough to unlock more factions
    mainLoopStart = Date.now();
    while (true) { // After each loop, we will repeat all prevous work "strategies" to see if anything new has been unlocked, and add one more "strategy" to the queue
        try {
            if (!breakToMainLoop()) scope++; // Increase the scope of work if the last iteration completed early (i.e. due to all work within that scope being complete)
            mainLoopStart = Date.now();
            ns.print(`INFO: Starting main work loop with scope: ${scope}...`);

            // Update information that may have changed since our last loop
            const player = (await getPlayerInfo(ns));
            if (player.factions.length > numJoinedFactions) { // If we've recently joined a new faction, reset our work scope
                scope = 1; // Back to basics until we've satisfied all highest-priority work
                numJoinedFactions = player.factions.length;
            }
            if (2 in dictSourceFiles) { // Get some information about gangs (if unlocked)
                if (!playerGang) { // Check if we've joined a gang since our last iteration
                    const gangInfo = await getNsDataThroughFile(ns, 'ns.gang.inGang() ? ns.gang.getGangInformation() : false', '/Temp/gang-stats.txt');
                    playerGang = gangInfo ? gangInfo.faction : null;
                }
                if (ns.heart.break() <= karmaThreshold) { // Start trying to earn gang faction invites if we're close to unlocking gangs
                    if (!playerGang) {
                        log(ns, `INFO: We are nearing the Karma required to unlock gangs (${formatNumberShort(ns.heart.break())} / -54K). Prioritize earning gang faction invites.`);
                        for (const factionName of desiredGangFactions)
                            await earnFactionInvite(ns, factionName);
                    }
                    // Whether we're in a gang or will be soon, there's no point in working for any factions that will become gangs, since we will lose all rep with them
                    skipFactions = skipFactions.concat(allGangFactions.filter(f => !skipFactions.includes(f)));
                }
            }

            // Remove Fulcrum from our "EarlyFactionOrder" if hack level is insufficient to backdoor their server
            let priorityFactions = crimeFocus ? preferredCrimeFactionOrder.slice() : preferredEarlyFactionOrder.slice();
            if (player.hacking < fulcrummHackReq - 10) { // Assume that if we're within 10, we'll get there by the time we've earned the invite
                priorityFactions.splice(priorityFactions.findIndex(c => c == "Fulcrum Secret Technologies"), 1);
                ns.print(`Fulcrum faction server requires ${fulcrummHackReq} hack, so removing from our initial priority list for now.`);
            } // TODO: Otherwise, if we get Fulcrum, we have no need for a couple other company factions

            // Strategy 1: Tackle a consolidated list of desired faction order, interleaving simple factions and megacorporations
            const factionWorkOrder = firstFactions.concat(priorityFactions.filter(f => // Remove factions from our initial "work order" if we've bought all desired augmentations.
                !firstFactions.includes(f) && !skipFactions.includes(f) && !softCompletedFactions.includes(f)));
            for (const faction of factionWorkOrder) {
                if (breakToMainLoop()) break; // Only continue on to the next faction if it isn't time for a high-level update.
                let earnedNewFactionInvite = false;
                if (preferredCompanyFactionOrder.includes(faction)) // If this is a company faction, we need to work for the company first
                    earnedNewFactionInvite = await workForMegacorpFactionInvite(ns, faction, true);
                // If new work was done for a company or their faction, restart the main work loop to see if we've since unlocked a higher-priority faction in the list
                if (earnedNewFactionInvite || await workForSingleFaction(ns, faction)) {
                    scope--; // De-increment scope so that effecitve scope doesn't increase on the next loop (i.e. it will be incremented back to what it is now)
                    break;
                }
            }
            if (scope <= 1 || breakToMainLoop()) continue;

            // Strategy 2: Grind XP with all priority factions that are joined or can be joined, until every single one has desired REP
            for (const faction of factionWorkOrder)
                if (!breakToMainLoop()) await workForSingleFaction(ns, faction);
            if (scope <= 2 || breakToMainLoop()) continue;

            // Strategy 3: Work for any megacorporations not yet completed to earn their faction invites. Once joined, we don't lose these factions on reset.
            let megacorpFactions = preferredCompanyFactionOrder.filter(f => !skipFactions.includes(f));
            await workForAllMegacorps(ns, megacorpFactions, false);
            if (scope <= 3 || breakToMainLoop()) continue;

            // Strategy 4: Work for megacorps again, but this time also work for the company factions once the invite is earned
            await workForAllMegacorps(ns, megacorpFactions, true);
            if (scope <= 4 || breakToMainLoop()) continue;

            // Strategies 5+ now work towards getting an invite to *all factions in the game* (sorted by least-expensive final aug (correlated to easiest faction-invite requirement))
            let joinedFactions = player.factions; // In case our hard-coded list of factions is missing anything, merge it with the list of all factions
            let knownFactions = factions.concat(joinedFactions.filter(f => !factions.includes(f)));
            let allIncompleteFactions = knownFactions.filter(f => !skipFactions.includes(f) && !completedFactions.includes(f)).sort((a, b) => mostExpensiveAugByFaction[a] - mostExpensiveAugByFaction[b]);
            // Strategy 5: For *all factions in the game*, try to earn an invite and work for rep until we can afford the most-expensive *desired* aug (or unlock donations, whichever comes first)
            for (const faction of allIncompleteFactions.filter(f => !softCompletedFactions.includes(f)))
                if (!breakToMainLoop()) await workForSingleFaction(ns, faction);
            if (scope <= 5 || breakToMainLoop()) continue;

            // Strategy 6: Revisit all factions until each has enough rep to unlock donations - so if we can't afford all augs this reset, at least we don't need to grind for rep on the next reset
            // For this, we reverse the order (ones with augs costing the most-rep to least) since these will take the most time to re-grind rep for if we can't buy them this reset.
            for (const faction of allIncompleteFactions.reverse())
                if (breakToMainLoop()) // Only continue on to the next faction if it isn't time for a high-level update.
                    await workForSingleFaction(ns, faction, true);
            if (scope <= 6 || breakToMainLoop()) continue;

            // Strategy 7:  Next, revisit all factions and grind XP until we can afford the most expensive aug, even if we could just buy the required rep next reset
            for (const faction of allIncompleteFactions.reverse()) // Re-reverse the sort order so we start with the easiest (cheapest) faction augs to complete
                if (breakToMainLoop()) // Only continue on to the next faction if it isn't time for a high-level update.
                    await workForSingleFaction(ns, faction, true, true);
            if (scope <= 7 || breakToMainLoop()) continue;

            // Strategy 8: Busy ourselves for a while longer, then loop to see if there anything more we can do for the above factions
            let factionsWeCanWorkFor = joinedFactions.filter(f => !skipFactionsConfig.includes(f) && !(playerGang ? allGangFactions : []).includes(f));
            let foundWork = false;
            if (factionsWeCanWorkFor.length > 0 && !crimeFocus) {
                // Do a little work for whatever faction has the most favor (e.g. to earn EXP and enable additional neuroflux purchases)
                let mostFavorFaction = factionsWeCanWorkFor.sort((a, b) => dictFactionFavors[b] - dictFactionFavors[a])[0];
                let targetRep = 1000 + (await getFactionReputation(ns, mostFavorFaction)) * 1.05; // Hack: Grow rep by ~5%, plus 1000 incase it's currently 0
                ns.print(`INFO: All useful work complete. Grinding an additional 5% rep (to ${formatNumberShort(targetRep)}) with highest-favor faction: ${mostFavorFaction} (${dictFactionFavors[mostFavorFaction]?.toFixed(2)} favor)`);
                foundWork = await workForSingleFaction(ns, mostFavorFaction, false, false, targetRep);
            }
            if (!foundWork && !noCrime) { // Otherwise, kill some time by doing crimes for a little while
                ns.print(`INFO: Nothing to do. Doing a little crime...`);
                await crimeForKillsKarmaStats(ns, 0, -ns.heart.break() + 1000 /* Hack: Decrease Karma by 1000 */, 0);
            } else { // If our hands our tied, twiddle our thumbs a bit
                ns.print(`INFO: Nothing to do. Sleeping for 30 seconds to see if magically we join a faction`);
                await ns.sleep(30000);
            }
            if (scope <= 8) scope--; // Cap the 'scope' value from increasing perpetually when we're on our last strategy
        } catch (err) {
            log(ns, 'WARNING: work-for-factions.js caught an unhandled error in its main loop. Trying again in 5 seconds...\n' + err, true, 'warning');
            await ns.sleep(5000);
            scope--; // Cancel out work scope increasing on the next iteration.
        }
        await ns.sleep(1); // Infinite loop protection in case somehow we loop without doing any meaningful work
    }
}

// Ram-dodging helper, runs a command for all items in a list and returns a dictionary.
const dictCommand = (list, command) => `Object.fromEntries(${JSON.stringify(list)}.map(o => [o, ${command}]))`;

/** @param {NS} ns 
 * Prints a message, and also toasts it!
 * TODO: Now redundant with log from helpers, refactor all usages. */
function announce(ns, msg, toastVariant = 'info') {
    log(ns, msg, false, toastVariant);
}

const requiredMoneyByFaction = {
    "Tian Di Hui": 1E6, "Sector-12": 15E6, "Chongqing": 20E6, "New Tokyo": 20E6, "Ishima": 30E6, "Aevum": 40E6, "Volhaven": 50E6,
    "Slum Snakes": 1E6, "Silhouette": 15E6, "The Syndicate": 10E6, "The Covenant": 75E9, "Daedalus": 100E9, "Illuminati": 150E9
};
const requiredBackdoorByFaction = { "CyberSec": "CSEC", "NiteSec": "avmnite-02h", "The Black Hand": "I.I.I.I", "BitRunners": "run4theh111z", "Fulcrum Secret Technologies": "fulcrumassets" };
const requiredHackByFaction = { "Tian Di Hui": 50, "Netburners": 80, "Speakers for the Dead": 100, "The Dark Army": 300, "The Syndicate": 200, "The Covenant": 850, "Daedalus": 2500, "Illuminati": 1500 };
const requiredCombatByFaction = { "Slum Snakes": 30, "Tetrads": 75, "Speakers for the Dead": 300, "The Dark Army": 300, "The Syndicate": 200, "The Covenant": 850, "Daedalus": 1500, "Illuminati": 1200 };
const requiredKarmaByFaction = { "Slum Snakes": 9, "Tetrads": 18, "Silhouette": 22, "Speakers for the Dead": 45, "The Dark Army": 45, "The Syndicate": 90 };
const requiredKillsByFaction = { "Speakers for the Dead": 30, "The Dark Army": 5 };
const reqHackingOrCombat = ["Daedalus"]; // Special case factions that require only hacking or combat stats, not both

/** @param {NS} ns */
async function earnFactionInvite(ns, factionName) {
    let player = await getPlayerInfo(ns);
    const joinedFactions = player.factions;
    if (joinedFactions.includes(factionName)) return true;
    var invitations = await getNsDataThroughFile(ns, 'ns.checkFactionInvitations()', '/Temp/player-faction-invites.txt');
    if (invitations.includes(factionName))
        return await tryJoinFaction(ns, factionName);

    // Can't join certain factions for various reasons
    let reasonPrefix = `Cannot join faction "${factionName}" because`;
    let precludingFaction;
    if (["Aevum", "Sector-12"].includes(factionName) && (precludingFaction = ["Chongqing", "New Tokyo", "Ishima", "Volhaven"].find(f => joinedFactions.includes(f))) ||
        ["Chongqing", "New Tokyo", "Ishima"].includes(factionName) && (precludingFaction = ["Aevum", "Sector-12", "Volhaven"].find(f => joinedFactions.includes(f))) ||
        ["Volhaven"].includes(factionName) && (precludingFaction = ["Aevum", "Sector-12", "Chongqing", "New Tokyo", "Ishima"].find(f => joinedFactions.includes(f))))
        return ns.print(`${reasonPrefix} precluding faction "${precludingFaction}"" has been joined.`);
    let requirement;
    // See if we can take action to earn an invite for the next faction under consideration
    let workedForInvite = false;
    // If committing crimes can help us join a faction - we know how to do that
    let doCrime = false;
    if ((requirement = requiredKarmaByFaction[factionName]) && -ns.heart.break() < requirement) {
        ns.print(`${reasonPrefix} you have insufficient Karma. Need: ${-requirement}, Have: ${ns.heart.break()}`);
        doCrime = true;
    }
    if ((requirement = requiredKillsByFaction[factionName]) && player.numPeopleKilled < requirement) {
        ns.print(`${reasonPrefix} you have insufficient kills. Need: ${requirement}, Have: ${player.numPeopleKilled}`);
        doCrime = true;
    }
    let deficientStats; // TODO: Not doing anything with this info yet. Maybe do some targeted training if there's only one?
    if ((requirement = requiredCombatByFaction[factionName]) &&
        (deficientStats = [{ name: "str", value: player.strength }, { name: "str", value: player.defense }, { name: "str", value: player.dexterity }, { name: "str", value: player.agility }]
            .filter(stat => stat.value < requirement)).length > 0
        && !(reqHackingOrCombat.includes(factionName) && player.hacking >= requiredHackByFaction[factionName])) { // Some special-case factions (just 'Daedalus' for now) require *either* hacking *or* combat
        ns.print(`${reasonPrefix} you have insufficient combat stats. Need: ${requirement} of each, ` +
            `Have Str: ${player.strength}, Def: ${player.defense}, Dex: ${player.dexterity}, Agi: ${player.agility}`);
        const em = requirement / 50; // Hack: A rough heuristic suggesting we need an additional x1 multi for every ~50 pysical stat points we wish to grind out in a reasonable amount of time. TODO: Be smarter
        if (!crimeFocus && (player.strength_exp_mult * player.strength_mult < em || player.defense_exp_mult * player.defense_mult < em ||
            player.dexterity_exp_mult * player.dexterity_mult < em || player.agility_exp_mult * player.agility_mult < em))
            return ns.print("Physical mults / exp_mults are too low to increase stats in a reasonable amount of time");
        doCrime = true; // TODO: There could be more efficient ways to gain combat stats than homicide, although at least this serves future crime factions
    }
    if (doCrime && noCrime)
        return ns.print(`--no-crime (or --no-focus): Doing crime to meet faction requirements is disabled.`);
    if (doCrime)
        workedForInvite = await crimeForKillsKarmaStats(ns, requiredKillsByFaction[factionName] || 0, requiredKarmaByFaction[factionName] || 0, requiredCombatByFaction[factionName] || 0);

    // Skip factions for which money/hack level requirements aren't met. We do not attempt to "train up" for these things (happens automatically outside this script)
    if ((requirement = requiredMoneyByFaction[factionName]) && player.money < requirement)
        return ns.print(`${reasonPrefix} you have insufficient money. Need: ${formatMoney(requirement)}, Have: ${formatMoney(player.money)}`);
    if ((requirement = requiredHackByFaction[factionName]) && player.hacking < requirement && !reqHackingOrCombat.includes(factionName))
        return ns.print(`${reasonPrefix} you have insufficient hack level. Need: ${requirement}, Have: ${player.hacking}`);
    // Note: This only complains if we have insuffient hack to backdoor this faction server. If we have sufficient hack, we will "waitForInvite" below assuming an external script is backdooring ASAP 
    let serverReqHackingLevel;
    if ((requirement = requiredBackdoorByFaction[factionName]) && player.hacking < (serverReqHackingLevel = (await getServerRequiredHackLevel(ns, requirement))))
        return ns.print(`${reasonPrefix} you must fist backdoor ${requirement}, which needs hack: ${serverReqHackingLevel}, Have: ${player.hacking}`);
    //await getNsDataThroughFile(ns, `ns.connect('fulcrumassets'); await ns.installBackdoor(); ns.connect(home)`, '/Temp/backdoor-fulcrum.txt') // TODO: Do backdoor if we can but haven't yet?
    if (breakToMainLoop()) return false;

    // If travelling can help us join a faction - we can do that too
    player = await getPlayerInfo(ns);
    if (['Tian Di Hui', 'Tetrads', 'The Dark Army'].includes(factionName) && !player.city == 'Chongqing')
        workedForInvite = await goToCity(ns, 'Chongqing');
    else if (['The Syndicate'].includes(factionName) && !player.city == 'Sector-12')
        workedForInvite = await goToCity(ns, 'Sector-12');
    else if (["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"].includes(factionName) && !player.city == factionName)
        workedForInvite = await goToCity(ns, factionName);
    // Special case, earn a CEO position to gain an invite to Silhouette
    if ("Silhouette" == factionName) {
        ns.print(`You must be a CO (e.g. CEO/CTO) of a company to earn an invite to ${factionName}. This may take a while!`);
        let factionConfig = companySpecificConfigs.find(f => f.name == factionName); // We set up Silhouette with a "company-specific-config" so that we can work for an invite like any megacorporation faction.
        let companyNames = preferredCompanyFactionOrder.map(f => companySpecificConfigs.find(cf => cf.name == f)?.companyName || f);
        let favorByCompany = await getNsDataThroughFile(ns, dictCommand(companyNames, 'ns.getCompanyFavor(o)'), '/Temp/company-favors.txt');
        let repByCompany = await getNsDataThroughFile(ns, dictCommand(companyNames, 'ns.getCompanyRep(o)'), '/Temp/company-reps.txt');
        // Change the company to work for into whichever company we can get to CEO fastest with. Minimize needed_rep/rep_gain_rate. CEO job is at 3.2e6 rep, so (3.2e6-current_rep)/(100+favor).
        factionConfig.companyName = companyNames.sort((a, b) => (3.2e6 - repByCompany[a]) / (100 + favorByCompany[a]) - (3.2e6 - repByCompany[b]) / (100 + favorByCompany[b]))[0];
        // Super-hack. Kick off an external script that just loops until it joins the faction, since we can't have concurrent ns calls in here.
        try { await runCommand(ns, `while(true) { if(ns.joinFaction('${factionName}')) return; else await ns.sleep(1000); }`, '/Temp/join-faction-loop.js'); }
        catch { ns.print(`WARN: Could not start a temporary script to join ${factionName} when avaialble. (Still running from a previous run?) Proceeding under the assumption something will join for us...`); }
        workedForInvite = await workForMegacorpFactionInvite(ns, factionName, false); // Work until CTO and the external script joins this faction, triggering an exit condition.
    }

    if (breakToMainLoop()) return false;
    if (workedForInvite === true) // If we took some action to earn the faction invite, wait for it to come in
        return await waitForFactionInvite(ns, factionName);
    else
        return ns.print(`Nothing we can do at this time to earn an invitation to faction "${factionName}"...`);
}

/** @param {NS} ns */
async function goToCity(ns, cityName) {
    if ((await getPlayerInfo(ns)).city == cityName) {
        ns.print(`Already in city ${cityName}`);
        return true;
    }
    if (await getNsDataThroughFile(ns, `ns.travelToCity('${cityName}')`, '/Temp/travel.txt')) {
        lastActionRestart = Date.now();
        announce(ns, `Travelled to ${cityName}`, 'info');
        return true;
    }
    announce(ns, `Failed to travelled to ${cityName} for some reason...`, 'error');
    return false;
}

/** @param {NS} ns 
 *  @param {function} crimeCommand if you want to commit the RAM footprint, you can pass in ns.commitCrime, otherise it will run via ram-dodging getNsDataThroughFile */
export async function crimeForKillsKarmaStats(ns, reqKills, reqKarma, reqStats, crimeCommand = null, doFastCrimesOnly = false) {
    const bestCrimesByDifficulty = ["heist", "assassinate", "homicide", "mug"]; // Will change crimes as our success rate improves
    const chanceThresholds = [0.75, 0.9, 0.5, 0]; // Will change crimes once we reach this probability of success for better all-round gains
    doFastCrimesOnly = doFastCrimesOnly || fastCrimesOnly;
    if (!crimeCommand) crimeCommand = async crime => await getNsDataThroughFile(ns, `ns.commitCrime('${crime}')`, '/Temp/crime-time.txt');
    let player = await getPlayerInfo(ns);
    let strRequirements = [];
    let forever = reqKills >= Number.MAX_SAFE_INTEGER || reqKarma >= Number.MAX_SAFE_INTEGER || reqStats >= Number.MAX_SAFE_INTEGER;
    if (reqKills) strRequirements.push(() => `${reqKills} kills (Have ${player.numPeopleKilled})`);
    if (reqKarma) strRequirements.push(() => `-${reqKarma} Karma (Have ${ns.heart.break()})`);
    if (reqStats) strRequirements.push(() => `${reqStats} of each combat stat (Have Str: ${player.strength}, Def: ${player.defense}, Dex: ${player.dexterity}, Agi: ${player.agility})`);
    let crime, lastCrime, lastStatusUpdateTime;
    while (forever || player.strength < reqStats || player.defense < reqStats || player.dexterity < reqStats || player.agility < reqStats || player.numPeopleKilled < reqKills || -ns.heart.break() < reqKarma) {
        if (!forever && breakToMainLoop()) return ns.print('INFO: Interrupting crime to check on high-level priorities.');
        let crimeChances = await getNsDataThroughFile(ns, `Object.fromEntries(${JSON.stringify(bestCrimesByDifficulty)}.map(c => [c, ns.getCrimeChance(c)]))`, '/Temp/crime-chances.txt');
        let needStats = player.strength < reqStats || player.defense < reqStats || player.dexterity < reqStats || player.agility < reqStats;
        let karma = -ns.heart.break();
        crime = crimeCount < 10 ? (crimeChances["homicide"] > 0.75 ? "homicide" : "mug") : // Start with a few fast & easy crimes to boost stats if we're just starting
            (!needStats && (player.numPeopleKilled < reqKills || karma < reqKarma)) ? "homicide" : // If *all* we need now is kills or Karma, homicide is the fastest way to do that
                bestCrimesByDifficulty.find((c, index) => doFastCrimesOnly ? index > 1 : crimeChances[c] >= chanceThresholds[index]); // Otherwise, crime based on success chance vs relative reward (precomputed)
        if (lastCrime != crime || (Date.now() - lastStatusUpdateTime) > statusUpdateInterval) {
            ns.print(`Committing "${crime}" (${(100 * crimeChances[crime]).toPrecision(3)}% success) ` + (forever ? 'forever...' : `until we reach ${strRequirements.map(r => r()).join(', ')}`));
            lastCrime = crime;
            lastStatusUpdateTime = Date.now();
        }
        ns.tail(); // Force a tail window open when auto-criming, or else it's very difficult to stop if it was accidentally closed.
        await ns.sleep(await crimeCommand(crime));
        while ((player = (await getPlayerInfo(ns))).crimeType == `commit ${crime}` || player.crimeType == crime) // If we woke up too early, wait a little longer for the crime to finish
            await ns.sleep(10);
        crimeCount++;
    }
    ns.print(`Done committing crimes. Reached ${strRequirements.map(r => r()).join(', ')}`);
    return true;
}

/** @param {NS} ns */
async function studyForCharisma(ns, focus) {
    await goToCity(ns, 'Volhaven');
    if (await getNsDataThroughFile(ns, `ns.universityCourse('ZB Institute Of Technology', 'Leadership', ${focus})`, '/Temp/study.txt')) {
        lastActionRestart = Date.now();
        announce(ns, `Started studying 'Leadership' at 'ZB Institute Of Technology`, 'success');
        return true;
    }
    announce(ns, `For some reason, failed to study at university (not in correct city?)`, 'error');
    return false;
}

/** @param {NS} ns */
export async function waitForFactionInvite(ns, factionName, maxWaitTime = 20000) {
    ns.print(`Waiting for invite from faction "${factionName}"...`);
    let waitTime = maxWaitTime;
    do {
        var invitations = await getNsDataThroughFile(ns, 'ns.checkFactionInvitations()', '/Temp/player-faction-invites.txt');
        var joinedFactions = (await getPlayerInfo(ns)).factions;
        if (invitations.includes(factionName) || joinedFactions.includes(factionName))
            break;
        await ns.sleep(loopSleepInterval);
    } while (!invitations.includes(factionName) && !joinedFactions.includes(factionName) && (waitTime -= 1000) > 0);
    if (joinedFactions.includes(factionName)) // Another script may have auto-joined this faction before we could
        ns.print(`An external script has joined faction "${factionName}" for us.`);
    else if (!invitations.includes(factionName))
        return announce(ns, `Waited ${formatDuration(maxWaitTime)}, but still have not recieved an invite for faction: "${factionName}" (Requirements not met?)`, 'error');
    else if (!(await tryJoinFaction(ns, factionName)))
        return announce(ns, `Something went wrong. Earned "${factionName}" faction invite, but failed to join it.`, 'error');
    return true;
}

/** @param {NS} ns */
export async function tryJoinFaction(ns, factionName) {
    var joinedFactions = (await getPlayerInfo(ns)).factions;
    if (joinedFactions.includes(factionName))
        return true;
    if (!(await getNsDataThroughFile(ns, `ns.joinFaction('${factionName}')`, '/Temp/join-faction.txt')))
        return false;
    announce(ns, `Joined faction "${factionName}"`, 'success');
    return true;
}

/** @param {NS} ns */
async function getPlayerInfo(ns) {
    return ns.getPlayer(); // Note: Decided that we call this frequently enough it is not worth ram-dodging
    // return await getNsDataThroughFile(ns, `ns.getPlayerInfo()`, '/Temp/player-info.txt');
}

/** @param {NS} ns */
async function getFactionReputation(ns, factionName) {
    return await getNsDataThroughFile(ns, `ns.getFactionRep('${factionName}')`, '/Temp/faction-rep.txt');
}

/** @param {NS} ns */
async function getCompanyReputation(ns, companyName) {
    return await getNsDataThroughFile(ns, `ns.getCompanyRep('${companyName}')`, '/Temp/company-rep.txt');
}

/** @param {NS} ns */
async function getCurrentFactionFavour(ns, factionName) {
    return await getNsDataThroughFile(ns, `ns.getFactionFavor('${factionName}')`, '/Temp/faction-favor.txt');
}

/** @param {NS} ns */
async function getServerRequiredHackLevel(ns, serverName) {
    return await getNsDataThroughFile(ns, `ns.getServerRequiredHackingLevel('${serverName}')`, '/Temp/server-required-hacking-level.txt');
}

let lastFactionWorkStatus = "";
/** @param {NS} ns 
 * Checks how much reputation we need with this faction to either buy all augmentations or get 150 favour, then works to that amount.
 * */
export async function workForSingleFaction(ns, factionName, forceUnlockDonations = false, forceBestAug = false, forceRep = undefined) {
    const repToFavour = (rep) => Math.ceil(25500 * 1.02 ** (rep - 1) - 25000);
    let highestRepAug = forceBestAug ? mostExpensiveAugByFaction[factionName] : mostExpensiveDesiredAugByFaction[factionName];
    let startingFavor = dictFactionFavors[factionName];
    let favorRepRequired = Math.max(0, repToFavour(repToDonate) - repToFavour(startingFavor));
    // When to stop grinding faction rep (usually ~467,000 to get 150 favour) Set this lower if there are no augs requiring that much REP
    let factionRepRequired = forceRep ? forceRep : forceUnlockDonations ? favorRepRequired : Math.min(highestRepAug, favorRepRequired);
    if (highestRepAug == -1 && !firstFactions.includes(factionName) && !forceRep)
        return ns.print(`All "${factionName}" augmentations are owned. Skipping unlocking faction...`);
    // Ensure we get an invite to location-based factions we might want / need
    if (!await earnFactionInvite(ns, factionName))
        return ns.print(`We are not yet part of faction "${factionName}". Skipping working for faction...`);
    if (startingFavor >= repToDonate && !forceRep) // If we have already unlocked donations via favour - no need to grind for rep
        return ns.print(`Donations already unlocked for "${factionName}". You should buy access to augs. Skipping working for faction...`);
    // Cannot work for gang factions. Detect if this is a gang faction!
    if (playerGang && allGangFactions.includes(factionName))
        return ns.print(`"${factionName}" is an active gang faction. Cannot work for gang factions...`);
    if (forceUnlockDonations && mostExpensiveAugByFaction[factionName] < 0.2 * factionRepRequired) { // Special check to avoid pointless donation unlocking
        ns.print(`The last "${factionName}" aug is only ${mostExpensiveAugByFaction[factionName].toLocaleString()} rep, ` +
            `not worth grinding ${favorRepRequired.toLocaleString()} rep to unlock donations.`);
        forceUnlockDonations = false;
        factionRepRequired = highestRepAug = mostExpensiveAugByFaction[factionName];
    }

    if ((await getPlayerInfo(ns)).workRepGained > 0) // If we're currently doing faction work, stop to collect reputation and find out how much is remaining
        await getNsDataThroughFile(ns, `ns.stopAction()`, '/Temp/stop-action.txt');
    let currentReputation = await getFactionReputation(ns, factionName);
    // If the best faction aug is within 10% of our current rep, grind all the way to it so we can get it immediately, regardless of our current rep target
    if (forceBestAug || highestRepAug <= 1.1 * Math.max(currentReputation, factionRepRequired)) {
        forceBestAug = true;
        factionRepRequired = Math.max(highestRepAug, factionRepRequired);
    }

    if (currentReputation >= factionRepRequired)
        return ns.print(`Faction "${factionName}" required rep of ${Math.round(factionRepRequired).toLocaleString()} has already been attained ` +
            `(Current rep: ${Math.round(currentReputation).toLocaleString()}). Skipping working for faction...`)

    ns.print(`Faction "${factionName}" Highest Aug Req: ${highestRepAug?.toLocaleString()}, Current Favor (` +
        `${startingFavor?.toFixed(2)}/${repToDonate?.toFixed(2)}) Req: ${Math.round(favorRepRequired).toLocaleString()}`);
    if (options['invites-only'])
        return ns.print(`--invites-only Skipping working for faction...`);
    if (prioritizeInvites && !forceUnlockDonations && !forceBestAug && !forceRep)
        return ns.print(`--prioritize-invites Skipping working for faction for now...`);

    let lastStatusUpdateTime = 0, repGainRatePerMs = 0;
    let lastRepMeasurement = await getFactionReputation(ns, factionName);
    while ((currentReputation = (await getFactionReputation(ns, factionName))) < factionRepRequired) {
        if (breakToMainLoop()) return ns.print('INFO: Interrupting faction work to check on high-level priorities.');
        const factionWork = await detectBestFactionWork(ns, factionName); // Before each loop - determine what work gives the most rep/second for our current stats
        if (await getNsDataThroughFile(ns, `ns.workForFaction('${factionName}', '${factionWork}',  ${shouldFocusAtWork})`, '/Temp/work-for-faction.txt')) {
            if (shouldFocusAtWork) ns.tail(); // Force a tail window open to help the user kill this script if they accidentally closed the tail window and don't want to keep stealing focus
            currentReputation = await getFactionReputation(ns, factionName); // Update to capture the reputation earned when restarting work
            if (currentReputation > factionRepRequired) break;
            lastActionRestart = Date.now(); repGainRatePerMs = (await getPlayerInfo(ns)).workRepGainRate; // Note: In order to get an accurate rep gain rate, we must wait for the first game tick (200ms) after starting work
            while (repGainRatePerMs === (await getPlayerInfo(ns)).workRepGainRate && (Date.now() - lastActionRestart < 400)) await ns.sleep(10); // TODO: Remove this if/when the game bug is fixed
            repGainRatePerMs = (await getPlayerInfo(ns)).workRepGainRate / 200 * (hasFocusPenaly && !shouldFocusAtWork ? 0.8 : 1 /* penalty if we aren't focused but don't have the aug to compensate */);
        } else {
            announce(ns, `Something went wrong, failed to start "${factionWork}" work for faction "${factionName}" (Is gang faction, or not joined?)`, 'error');
            break;
        }
        let status = `Doing '${factionWork}' work for "${factionName}" until ${Math.round(factionRepRequired).toLocaleString()} rep.`;
        if (lastFactionWorkStatus != status || (Date.now() - lastStatusUpdateTime) > statusUpdateInterval) {
            // Actually measure how much reputation we've earned since our last update, to give a more accurate ETA including external sources of rep
            let measuredRepGainRatePerMs = ((await getFactionReputation(ns, factionName)) - lastRepMeasurement) / (Date.now() - lastStatusUpdateTime);
            if (currentReputation > lastRepMeasurement + statusUpdateInterval * repGainRatePerMs * 2) // Detect a sudden increase in rep, but don't use it to update the expected rate
                ns.print('SUCCESS: Reputation spike! (Perhaps a coding contract was just solved?) ETA reduced.');
            else if (lastStatusUpdateTime != 0 && Math.abs(measuredRepGainRatePerMs - repGainRatePerMs) / repGainRatePerMs > 0.05) // Stick to the game-provided rate if we measured something within 5% of that number
                repGainRatePerMs = measuredRepGainRatePerMs; // If we measure a significantly different rep gain rate, this could be due to external sources of rep (e.g. sleeves) - account for it in the ETA
            lastStatusUpdateTime = Date.now(); lastRepMeasurement = currentReputation;
            const eta_milliseconds = (factionRepRequired - currentReputation) / repGainRatePerMs;
            ns.print((lastFactionWorkStatus = status) + ` Currently at ${Math.round(currentReputation).toLocaleString()}, earning ${formatNumberShort(repGainRatePerMs * 1000)} rep/sec. ` +
                (hasFocusPenaly && !shouldFocusAtWork ? 'after 20% non-focus Penalty ' : '') + `(ETA: ${formatDuration(eta_milliseconds)})`);
        }
        await tryBuyReputation(ns);
        await ns.sleep(restartWorkInteval);
        if (!forceBestAug && !forceRep) { // Detect our rep requirement decreasing (e.g. if we exported for our daily +1 faction rep)
            let currentFavor = await getCurrentFactionFavour(ns, factionName);
            if (currentFavor > startingFavor) {
                startingFavor = dictFactionFavors[factionName] = currentFavor;
                favorRepRequired = Math.max(0, repToFavour(repToDonate) - repToFavour(startingFavor));
                factionRepRequired = forceUnlockDonations ? favorRepRequired : Math.min(highestRepAug, favorRepRequired);
            }
        }
        let workRepGained = (await getPlayerInfo(ns)).workRepGained; // Delay the next loop slightly until the next game tick so we aren't missing out on a few ms of rep
        while (workRepGained === (await getPlayerInfo(ns)).workRepGained && (Date.now() - lastActionRestart < 200)) await ns.sleep(10);
        // If we explicitly stop working, we immediately get our updated faction rep, otherwise it lags by 1 loop (until after next time we call workForFaction)
        if (currentReputation + (await getPlayerInfo(ns)).workRepGained >= factionRepRequired)
            await getNsDataThroughFile(ns, `ns.stopAction()`, '/Temp/stop-action.txt'); // We're close - stop working so our current rep is accurate when we check the while loop condition
    }
    if (currentReputation >= factionRepRequired)
        ns.print(`Attained ${Math.round(currentReputation).toLocaleString()} rep with "${factionName}" (needed ${factionRepRequired.toLocaleString()}).`);
    return currentReputation >= factionRepRequired;
}

/** @param {NS} ns 
 * Try all work types and see what gives the best rep gain with this faction! */
async function detectBestFactionWork(ns, factionName) {
    let bestWork, bestRepRate = 0;
    for (const work of ["security", "field", "hacking"]) {
        if (!await getNsDataThroughFile(ns, `ns.workForFaction('${factionName}', '${work}',  ${shouldFocusAtWork})`, '/Temp/work-for-faction.txt')) {
            //ns.print(`"${factionName}" work ${work} not supported.`);
            continue; // This type of faction work must not be supported
        }
        const currentRepGainRate = (await getPlayerInfo(ns)).workRepGainRate;
        //ns.print(`"${factionName}" work ${work} provides ${formatNumberShort(currentRepGainRate)} rep rate`);
        if (currentRepGainRate > bestRepRate) {
            bestRepRate = currentRepGainRate;
            bestWork = work;
        }
    }
    return bestWork;
}

/** @param {NS} ns 
 *  @param {Array<string>} megacorpFactionsInPreferredOrder - The list of all corporate factions to work for, sorted in the order they should be worked for
 *  @param {Array<string>} megacorpFactionsInPreferredOrder - The list of all corporate factions, sorted in the order they should be worked for
 * */
export async function workForAllMegacorps(ns, megacorpFactionsInPreferredOrder, alsoWorkForCompanyFactions, oneCompanyFactionAtATime) {
    let player = (await getPlayerInfo(ns));
    if (player.hacking < 225)
        return ns.print(`Hacking Skill ${player.hacking} is to low to work for any megacorps (min req. 225).`);
    let joinedCompanyFactions = player.factions.filter(f => megacorpFactionsInPreferredOrder.includes(f)); // Company factions we've already joined
    if (joinedCompanyFactions.length > 0)
        ns.print(`${joinedCompanyFactions.length} companies' factions have already been joined: ${joinedCompanyFactions.join(", ")}`)
    let doFactionWork = alsoWorkForCompanyFactions && oneCompanyFactionAtATime;
    // Earn each obtainabl megacorp faction invite, and optionally also grind faction rep
    for (const factionName of megacorpFactionsInPreferredOrder) {
        if ((await workForMegacorpFactionInvite(ns, factionName, doFactionWork)) && doFactionWork && !breakToMainLoop())
            await workForSingleFaction(ns, factionName);
        if (breakToMainLoop()) return;
    }
    if (alsoWorkForCompanyFactions && !oneCompanyFactionAtATime) { // If configured, start grinding rep with company factions we've joined
        ns.print(`Done working for companies, now working for all incomplete company factions...`);
        for (const factionName of megacorpFactionsInPreferredOrder)
            if (!breakToMainLoop()) await workForSingleFaction(ns, factionName);
    }
}

/** If we're wealthy, hashes have relatively little monetary value, spend hacknet-node hashes on contracts to gain rep faster
 * @param {NS} ns */
export async function tryBuyReputation(ns) {
    if (options['no-coding-contracts']) return;
    if ((await getPlayerInfo(ns)).money > 100E9) { // If we're wealthy, hashes have relatively little monetary value, spend hacknet-node hashes on contracts to gain rep faster
        let spentHashes = await getNsDataThroughFile(ns, 'ns.hacknet.numHashes() + ns.hacknet.spendHashes("Generate Coding Contract") - ns.hacknet.numHashes()', '/Temp/spend-hacknet-hashes.txt');
        if (spentHashes > 0) {
            announce(ns, `Generated a new coding contract for ${formatNumberShort(Math.round(spentHashes / 100) * 100)} hashes`, 'success');
        }
    }
}

// Used when working for a company to see if their server has been backdoored. If so, we can expect an increase in rep-gain (used for predicting an ETA)
const serverByCompany = { "Bachman & Associates": "b-and-a", "ECorp": "ecorp", "Clarke Incorporated": "clarkinc", "OmniTek Incorporated": "omnitek", "NWO": "nwo", "Blade Industries": "blade", "MegaCorp": "megacorp", "KuaiGong International": "kuai-gong", "Fulcrum Technologies": "fulcrumtech", "Four Sigma": "4sigma" };

/** @param {NS} ns */
export async function workForMegacorpFactionInvite(ns, factionName, waitForInvite) {
    const companyConfig = companySpecificConfigs.find(c => c.name == factionName); // For anything company-specific
    const companyName = companyConfig?.companyName || factionName; // Name of the company that gives the faction (same for all but Fulcrum)
    const statModifier = companyConfig?.statModifier || 0; // How much e.g. Hack / Cha is needed for a promotion above the base requirement for the job
    const repRequiredForFaction = companyConfig?.repRequiredForFaction || 200000; // Required to unlock the faction

    let player = (await getPlayerInfo(ns));
    if (player.factions.includes(factionName)) return false; // Only return true if we did work to earn a new faction invite
    if ((await getNsDataThroughFile(ns, 'ns.checkFactionInvitations()', '/Temp/player-faction-invites.txt')).includes(factionName))
        return waitForInvite ? await waitForFactionInvite(ns, factionName) : false;
    // TODO: In some scenarios, the best career path may require combat stats, this hard-codes the optimal path for hack stats
    const itJob = jobs.find(j => j.name == "it");
    const softwareJob = jobs.find(j => j.name == "software");
    if (itJob.reqHack[0] + statModifier > player.hacking) // We don't qualify to work for this company yet if we can't meet IT qualifications (lowest there are)
        return ns.print(`Cannot yet work for "${companyName}": Need Hack ${itJob.reqHack[0] + statModifier} to get hired (current Hack: ${player.hacking});`);
    ns.print(`Going to work for Company "${companyName}" next...`)
    let currentReputation, currentRole = "", currentJobTier = -1; // TODO: Derive our current position and promotion index based on player.jobs[companyName]
    let lastStatus = "", lastStatusUpdateTime = 0, repGainRatePerMs = 0;
    let lastRepMeasurement = await getCompanyReputation(ns, companyName);
    let studying = false, working = false, backdoored = false;
    while (((currentReputation = (await getCompanyReputation(ns, companyName))) < repRequiredForFaction) && !player.factions.includes(factionName)) {
        if (breakToMainLoop()) return ns.print('INFO: Interrupting corporation work to check on high-level priorities.');
        player = (await getPlayerInfo(ns));
        // Determine the next promotion we're striving for (the sooner we get promoted, the faster we can earn company rep)
        const getTier = job => Math.min(job.reqRep.filter(r => r <= currentReputation).length, job.reqHack.filter(h => h <= player.hacking).length, job.reqCha.filter(c => c <= player.charisma).length) - 1;
        // It's generally best to hop back-and-forth between it and software engineer career paths (rep gain is about the same, but better money from software)
        const qualifyingItTier = getTier(itJob), qualifyingSoftwareTier = getTier(softwareJob);
        const bestJobTier = Math.max(qualifyingItTier, qualifyingSoftwareTier); // Go with whatever job promotes us higher
        const bestRoleName = qualifyingItTier > qualifyingSoftwareTier ? "it" : "software"; // If tied for qualifying tier, go for software
        if (currentJobTier < bestJobTier || currentRole != bestRoleName) { // We are ready for a promotion, ask for one!
            if (await getNsDataThroughFile(ns, `ns.applyToCompany('${companyName}','${bestRoleName}')`, '/Temp/apply-to-company.txt'))
                announce(ns, `Successfully applied to "${companyName}" for a '${bestRoleName}' Job or Promotion`, 'success');
            else if (currentJobTier !== -1) // Unless we just restarted "work-for-factions" and lost track of our current job, this is an error
                announce(ns, `Application to "${companyName}" for a '${bestRoleName}' Job or Promotion failed.`, 'error');
            currentJobTier = bestJobTier; // API to apply for a job immediately gives us the highest tier we qualify for
            currentRole = bestRoleName;
            player = (await getPlayerInfo(ns));
        }
        const currentJob = player.jobs[companyName];
        const nextJobTier = currentRole == "it" ? currentJobTier : currentJobTier + 1;
        const nextJobName = currentRole == "it" || nextJobTier >= itJob.reqRep.length ? "software" : "it";
        const nextJob = nextJobName == "it" ? itJob : softwareJob;
        const requiredHack = nextJob.reqHack[nextJobTier] === 0 ? 0 : nextJob.reqHack[nextJobTier] + statModifier; // Stat modifier only applies to non-zero reqs
        const requiredCha = nextJob.reqCha[nextJobTier] === 0 ? 0 : nextJob.reqCha[nextJobTier] + statModifier; // Stat modifier only applies to non-zero reqs
        const requiredRep = nextJob.reqRep[nextJobTier]; // No modifier on rep requirements
        let status = `Next promotion ('${nextJobName}' #${nextJobTier}) at Hack:${requiredHack} Cha:${requiredCha} Rep:${requiredRep?.toLocaleString()}` +
            (repRequiredForFaction > nextJob.reqRep[nextJobTier] ? '' : `, but we won't need it, because we'll sooner hit ${repRequiredForFaction.toLocaleString()} reputation to unlock company faction "${factionName}"!`);
        // We should only study at university if every other requirement is met but Charisma
        if (currentReputation >= requiredRep && player.hacking >= requiredHack && player.charisma < requiredCha && !noStudying) {
            status = `Studying at ZB university until Cha reaches ${requiredCha}...\n` + status;
            if (studying && player.className !== 'taking a Leadership course' && player.className !== 'Leadership' /* In case className is made more intuitive in the future */) {
                announce(ns, `Leadership studies were interrupted. player.className="${player.className}" Restarting in 5 seconds...`, 'warning');
                studying = false; // If something external has interrupted our studies, take note
                ns.tail(); // Force a tail window open to help the user kill this script if they accidentally closed the tail window and don't want to keep studying
            }
            if (!studying) { // Study at ZB university if CHA is the limiter.
                if (await studyForCharisma(ns, shouldFocusAtWork))
                    working = !(studying = true);
            }
            if (requiredCha - player.charisma > 10) { // Try to spend hacknet-node hashes on university upgrades while we've got a ways to study to make it go faster
                let spentHashes = await getNsDataThroughFile(ns, 'ns.hacknet.numHashes() + ns.hacknet.spendHashes("Improve Studying") - ns.hacknet.numHashes()', '/Temp/spend-hacknet-hashes.txt');
                if (spentHashes > 0) {
                    announce(ns, 'Bought a "Improve Studying" upgrade.', 'success');
                    await studyForCharisma(ns, shouldFocusAtWork); // We must restart studying for the upgrade to take effect.
                }
            }
        } else if (studying) { // If we no longer need to study and we currently are, turn off study mode and get back to work!
            studying = false;
            continue; // Restart the loop so we refresh our promotion index and apply for a promotion before working more
        }
        await tryBuyReputation(ns);

        // Regardless of the earlier promotion logic, always try for a promotion to make sure we don't miss a promotion due to buggy logic 
        if (await getNsDataThroughFile(ns, `ns.applyToCompany('${companyName}','${currentRole}')`, '/Temp/apply-to-company.txt'))
            announce(ns, `Unexpected '${currentRole}' promotion from ${currentJob} to "${(await getPlayerInfo(ns)).jobs[companyName]}. Promotion logic must be off..."`, 'warning');
        // TODO: If we ever get rid of the below periodic restart-work, we will need to monitor for interruptions with player.workType == e.g. "Work for Company"
        if (!studying && (!working || (Date.now() - lastActionRestart >= restartWorkInteval) /* We must periodically restart work to collect Rep Gains */)) {
            // Work for the company (assume daemon is grinding hack XP as fast as it can, so no point in studying for that)
            if (await getNsDataThroughFile(ns, `ns.workForCompany('${companyName}',  ${shouldFocusAtWork})`, '/Temp/work-for-company.txt')) {
                working = true;
                if (shouldFocusAtWork) ns.tail(); // Force a tail window open to help the user kill this script if they accidentally closed the tail window and don't want to keep stealing focus
                currentReputation = await getCompanyReputation(ns, companyName); // Update to capture the reputation earned when restarting work
                lastActionRestart = Date.now(); repGainRatePerMs = (await getPlayerInfo(ns)).workRepGainRate; // Note: In order to get an accurate rep gain rate, we must wait for the first game tick (200ms) after starting work
                while (repGainRatePerMs === (await getPlayerInfo(ns)).workRepGainRate && (Date.now() - lastActionRestart < 400)) await ns.sleep(1); // TODO: Remove this if/when the game bug is fixed
                repGainRatePerMs = (await getPlayerInfo(ns)).workRepGainRate / 200 * (hasFocusPenaly && !shouldFocusAtWork ? 0.8 : 1 /* penalty if we aren't focused but don't have the aug to compensate */);
            } else {
                announce(ns, `Something went wrong, failed to start working for company "${companyName}".`, 'error');
                break;
            }
        }
        if (lastStatus != status || (Date.now() - lastStatusUpdateTime) > statusUpdateInterval) {
            if (!backdoored) // Check if an external script has backdoored this company's server yet. If so, it affects our ETA. (Don't need to check again once we discover it is)
                backdoored = await getNsDataThroughFile(ns, `ns.getServer('${serverByCompany[companyName]}').backdoorInstalled`, '/Temp/company-is-backdoored.txt');
            const cancellationMult = backdoored ? 0.75 : 0.5; // We will lose some of our gained reputation when we stop working early
            repGainRatePerMs *= cancellationMult;
            // Actually measure how much reputation we've earned since our last update, to give a more accurate ETA including external sources of rep
            let measuredRepGainRatePerMs = ((await getCompanyReputation(ns, companyName)) - lastRepMeasurement) / (Date.now() - lastStatusUpdateTime);
            if (currentReputation > lastRepMeasurement + statusUpdateInterval * repGainRatePerMs * 2) // Detect a sudden increase in rep, but don't use it to update the expected rate
                ns.print('SUCCESS: Reputation spike! (Perhaps a coding contract was just solved?) ETA reduced.');
            else if (lastStatusUpdateTime != 0 && Math.abs(measuredRepGainRatePerMs - repGainRatePerMs) / repGainRatePerMs > 0.05) // Stick to the game-provided rate if we measured something within 5% of that number
                repGainRatePerMs = measuredRepGainRatePerMs; // If we measure a significantly different rep gain rate, this could be due to external sources of rep (e.g. sleeves) - account for it in the ETA
            lastStatusUpdateTime = Date.now(); lastRepMeasurement = currentReputation;
            const eta_milliseconds = ((requiredRep || repRequiredForFaction) - currentReputation) / repGainRatePerMs;
            player = (await getPlayerInfo(ns));
            ns.print(`Currently a "${player.jobs[companyName]}" ('${currentRole}' #${currentJobTier}) for "${companyName}" earning ${formatNumberShort(repGainRatePerMs * 1000)} rep/sec. ` +
                `(after ${(100 * (1 - cancellationMult))?.toFixed(0)}% early-quit penalty` + (hasFocusPenaly && !shouldFocusAtWork ? ' and 20% non-focus Penalty' : '') + `)\n` +
                `${status}\nCurrent player stats are Hack:${player.hacking} ${player.hacking >= (requiredHack || 0) ? '✓' : '✗'} ` +
                `Cha:${player.charisma} ${player.charisma >= (requiredCha || 0) ? '✓' : '✗'} ` +
                `Rep:${Math.round(currentReputation).toLocaleString()} ${currentReputation >= (requiredRep || repRequiredForFaction) ? '✓' : `✗ (ETA: ${formatDuration(eta_milliseconds)})`}`);
            lastStatus = status;
        }
        await ns.sleep(loopSleepInterval); // Sleep now and wake up periodically and stop working to check our stats / reputation progress
    }
    // Return true if we succeeded, false otherwise.
    if (currentReputation >= repRequiredForFaction) {
        ns.print(`Attained ${repRequiredForFaction.toLocaleString()} rep with "${companyName}".`);
        if (!player.factions.includes(factionName) && waitForInvite)
            return await waitForFactionInvite(ns, factionName);
        return true;
    }
    ns.print(`Stopped working for "${companyName}" repRequiredForFaction: ${repRequiredForFaction.toLocaleString()} ` +
        `currentReputation: ${Math.round(currentReputation).toLocaleString()} inFaction: ${player.factions.includes(factionName)}`);
    return false;
}