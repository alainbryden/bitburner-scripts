import {
    instanceCount, getConfiguration, getNsDataThroughFile, getFilePath, getActiveSourceFiles, tryGetBitNodeMultipliers,
    formatDuration, formatMoney, formatNumberShort, disableLogs, log
} from './helpers.js'

let options;
const argsSchema = [
    ['first', []], // Grind rep with these factions first. Also forces a join of this faction if we normally wouldn't (e.g. no desired augs or all augs owned)
    ['skip', []], // Don't work for these factions
    ['o', false], // Immediately grind company factions for rep after getting their invite, rather than first getting all company invites we can
    ['desired-stats', []], // Factions will be removed from our 'early-faction-order' once all augs with these stats have been bought out
    ['no-focus', false], // Disable doing work that requires focusing (crime), and forces study/faction/company work to be non-focused (even if it means incurring a penalty)
    ['no-studying', false], // Disable studying.
    ['pay-for-studies-threshold', 200000], // Only be willing to pay for our studies if we have this much money
    ['training-stat-per-multi-threshold', 100], // Heuristic: Estimate that we can train this many levels for every mult / exp_mult we have in a reasonable amount of time.
    ['no-coding-contracts', false], // Disable purchasing coding contracts for reputation
    ['no-crime', false], // Disable doing crimes at all. (Also disabled with --no-focus)
    ['crime-focus', false], // Useful in crime-focused BNs when you want to focus on crime related factions
    ['fast-crimes-only', false], // Assasination and Heist are so slow, I can see people wanting to disable them just so they can interrupt at will.
    ['invites-only', false], // Just work to get invites, don't work for augmentations / faction rep
    ['prioritize-invites', false], // Prioritize working for as many invites as is practical before starting to grind for faction reputation
    ['get-invited-to-every-faction', false], // You want to be in every faction? You got it!
    ['karma-threshold-for-gang-invites', -40000], // Prioritize working for gang invites once we have this much negative Karma
    ['disable-treating-gang-as-sole-provider-of-its-augs', false], // Set to true if you still want to grind for rep with factions that only have augs your gang provides
    ['no-bladeburner-check', false], // By default, will avoid working if bladeburner is active and "The Blade's Simulacrum" isn't installed
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
    "Volhaven", "Speakers for the Dead", "The Dark Army", "The Syndicate", "Silhouette", "Tetrads", "Slum Snakes", "Netburners", "Tian Di Hui", "CyberSec"];
const cannotWorkForFactions = ["Church of the Machine God", "Bladeburners", "Shadows of Anarchy"]
// These factions should ideally be completed in this order
const preferredEarlyFactionOrder = [
    "Netburners", // Improve hash income, which is useful or critical for almost all BNs
    "Tian Di Hui", "Aevum", // These give all the company_rep and faction_rep bonuses early game    
    "Daedalus", // Once we have all faction_rep boosting augs, there's no reason not to work towards Daedalus as soon as it's available/feasible so we can buy Red Pill
    "CyberSec", /* Quick, and NightSec aug depends on an aug from here */ "NiteSec", "Tetrads", // Cha augs to speed up earning company promotions
    "Bachman & Associates", // Boost company/faction rep for future augs
    "BitRunners", // Fast source of some unique hack augs
    "Fulcrum Secret Technologies", // Will be removed if hack level is too low to backdoor their server
    "ECorp", // More cmp_rep augs, and some strong hack ones as well
    "The Black Hand", // Fastest sources of hacking augs after the above companies
    "The Dark Army", // Unique cmp_rep aug TODO: Can it sensibly be gotten before megacorps? Requires 300 all combat stats.
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
// Order in which to focus on crime factions. Start with the hardest-to-earn invites, assume we will skip to next best if not achievable.
const preferredCrimeFactionOrder = ["Slum Snakes", "Tetrads", "Speakers for the Dead", "The Syndicate", "The Dark Army", "The Covenant", "Daedalus", "Netburners", "NiteSec", "The Black Hand"];
// Gang factions in order of ease-of-invite. If gangs are available, as we near 54K Karma to unlock gangs (as per --karma-threshold-for-gang-invites), we will attempt to get into any/all of these.
const desiredGangFactions = ["Slum Snakes", "The Syndicate", "The Dark Army", "Speakers for the Dead"];
// Previously this was needed because you couldn't work for any gang factions once in a gang, but that was changed.
const allGangFactions = ["Speakers for the Dead", "The Dark Army", "The Syndicate", "Tetrads", "Slum Snakes", "The Black Hand", "NiteSec"];

const loopSleepInterval = 5000; // 5 seconds
const restartWorkInteval = 30 * 1000; // 30 seconds Collect e.g. rep earned by stopping and starting work;
const statusUpdateInterval = 60 * 1000; // 1 minute (outside of this, minor updates in e.g. stats aren't logged)
const checkForNewPrioritiesInterval = 10 * 60 * 1000; // 10 minutes. Interrupt whatever we're doing and check whether we could be doing something more useful.
const waitForFactionInviteTime = 30 * 1000; // The game will only issue one new invite every 25 seconds, so if you earned two by travelling to one city, might have to wait a while

let shouldFocusAtWork; // Whether we should focus on work or let it be backgrounded (based on whether "Neuroreceptor Management Implant" is owned, or "--no-focus" is specified)
// And a bunch of globals because managing state and encapsulation is hard.
let hasFocusPenaly, hasSimulacrum, repToDonate, fulcrummHackReq, notifiedAboutDaedalus;
let bitnodeMultipliers, dictSourceFiles, dictFactionFavors, playerGang, mainLoopStart, scope, numJoinedFactions, lastActionRestart, lastTravel, crimeCount;
let firstFactions, skipFactions, completedFactions, softCompletedFactions, mostExpensiveAugByFaction, mostExpensiveDesiredAugByFaction;

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
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions || await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    options = runOptions; // We don't set the global "options" until we're sure this is the only running instance
    disableLogs(ns, ['sleep']);

    // Reset globals whose value can persist between script restarts in weird situations
    lastTravel = lastActionRestart = crimeCount = 0;
    notifiedAboutDaedalus = false;

    // Process configuration options
    firstFactions = (options['first'] || []).map(f => f.replaceAll('_', ' ')); // Factions that end up in this list will be prioritized and joined regardless of their augmentations available.
    options.skip = (options.skip || []).map(f => f.replaceAll('_', ' '));
    options['no-crime'] = options['no-crime'] || options['no-focus']; // Can't crime if we aren't allowed to steal focus
    if (options['crime-focus'] && options['no-focus'])
        return log(ns, "ERROR: Cannot use --no-focus and --crime-focus at the same time. You need to focus to do crime!", true, 'error');
    // Default desired-stats if none were specified
    if (options['desired-stats'].length == 0)
        options['desired-stats'] = options['crime-focus'] ? ['str', 'def', 'dex', 'agi', 'faction_rep', 'hacknet', 'crime'] :
            ['hacking', 'faction_rep', 'company_rep', 'charisma', 'hacknet', 'crime_money']

    // Log some of the options in effect
    ns.print(`--desired-stats matching: ${options['desired-stats'].join(", ")}`);
    if (firstFactions.length > 0) ns.print(`--first factions: ${firstFactions.join(", ")}`);
    if (options.skip.length > 0) ns.print(`--skip factions: ${options.skip.join(", ")}`);
    if (options['fast-crimes-only']) ns.print(`--fast-crimes-only`);

    // Find out whether the user can use this script
    dictSourceFiles = await getActiveSourceFiles(ns); // Find out what source files the user has unlocked
    if (!(4 in dictSourceFiles))
        return log(ns, "ERROR: You cannot automate working for factions until you have unlocked singularity access (SF4).", true, 'error');
    else if (dictSourceFiles[4] < 3)
        log(ns, `WARNING: Singularity functions are much more expensive with lower levels of SF4 (you have SF4.${dictSourceFiles[4]}). ` +
            `You may encounter RAM issues with and have to wait until you have more RAM available to run this script successfully.`, false, 'warning');

    let loadingComplete = false; // In the event of suboptimal RAM conditions, keep trying to start until we succeed
    while (!loadingComplete) {
        try {
            await loadStartupData(ns);
            loadingComplete = true;
        } catch (err) {
            log(ns, 'WARNING: work-for-factions.js caught an unhandled error while starting up. Trying again in 5 seconds...\n' +
                (typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
            await ns.sleep(5000);
        }
    }

    mainLoopStart = Date.now();
    scope = 0;
    while (true) { // After each loop, we will repeat all prevous work "strategies" to see if anything new has been unlocked, and add one more "strategy" to the queue
        try {
            await mainLoop(ns);
        } catch (err) {
            log(ns, 'WARNING: work-for-factions.js caught an unhandled error in its main loop. Trying again in 5 seconds...\n' +
                (typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
            await ns.sleep(5000);
            scope--; // Cancel out work scope increasing on the next iteration.
        }
        await ns.sleep(1); // Infinite loop protection in case somehow we loop without doing any meaningful work
    }
}

/** @param {NS} ns */
async function loadStartupData(ns) {
    repToDonate = await getNsDataThroughFile(ns, 'ns.getFavorToDonate()', '/Temp/favor-to-donate.txt');
    const playerInfo = await getPlayerInfo(ns);
    const allKnownFactions = factions.concat(playerInfo.factions.filter(f => !factions.includes(f)));
    bitnodeMultipliers = await tryGetBitNodeMultipliers(ns) ||
    {   // BN mults are used to estimate time to train up stats. Default to 1.0 if unknown
        HackingLevelMultiplier: 1.0,
        StrengthLevelMultiplier: 1.0,
        DefenseLevelMultiplier: 1.0,
        DexterityLevelMultiplier: 1.0,
        AgilityLevelMultiplier: 1.0,
        CharismaLevelMultiplier: 1.0,
        ClassGymExpGain: 1.0,
        CrimeExpGain: 1.0,
    };

    // Get some faction and augmentation information to decide what remains to be purchased
    dictFactionFavors = await getNsDataThroughFile(ns, dictCommand('ns.singularity.getFactionFavor(o)'), '/Temp/getFactionFavors.txt', allKnownFactions);
    const dictFactionAugs = await getNsDataThroughFile(ns, dictCommand('ns.singularity.getAugmentationsFromFaction(o)'), '/Temp/getAugmentationsFromFactions.txt', allKnownFactions);
    const augmentationNames = [...new Set(Object.values(dictFactionAugs).flat())];
    const dictAugRepReqs = await getNsDataThroughFile(ns, dictCommand('ns.singularity.getAugmentationRepReq(o)'), '/Temp/getAugmentationRepReqs.txt', augmentationNames);
    const dictAugStats = await getNsDataThroughFile(ns, dictCommand('ns.singularity.getAugmentationStats(o)'), '/Temp/getAugmentationStats.txt', augmentationNames);
    const ownedAugmentations = await getNsDataThroughFile(ns, `ns.singularity.getOwnedAugmentations(true)`, '/Temp/player-augs-purchased.txt');
    const installedAugmentations = await getNsDataThroughFile(ns, `ns.singularity.getOwnedAugmentations()`, '/Temp/player-augs-installed.txt');
    // Based on what augmentations we own, we can change our own behaviour (e.g. whether to allow work to steal focus)
    hasFocusPenaly = !installedAugmentations.includes("Neuroreceptor Management Implant"); // Check if we have an augmentation that lets us not have to focus at work (always nicer if we can background it)
    shouldFocusAtWork = !options['no-focus'] && hasFocusPenaly; // Focus at work for the best rate of rep gain, unless focus activities are disabled via command line
    hasSimulacrum = installedAugmentations.includes("The Blade's Simulacrum");

    // Find out if we're in a gang
    const gangInfo = await getGangInfo(ns);
    playerGang = gangInfo ? gangInfo.faction : null;
    if (playerGang && !options['disable-treating-gang-as-sole-provider-of-its-augs']) {
        // Whatever augmentations the gang provides are so easy to get from them, might as well ignore any other factions that have them.
        const gangAugs = dictFactionAugs[playerGang];
        ns.print(`Your gang ${playerGang} provides easy access to ${gangAugs.length} augs. Ignoring these augs from the original factions that provide them.`);
        for (const faction of allKnownFactions.filter(f => f != playerGang))
            dictFactionAugs[faction] = dictFactionAugs[faction].filter(a => !gangAugs.includes(a));
    }

    mostExpensiveAugByFaction = Object.fromEntries(allKnownFactions.map(f => [f,
        dictFactionAugs[f].filter(aug => !ownedAugmentations.includes(aug))
            .reduce((max, aug) => Math.max(max, dictAugRepReqs[aug]), -1)]));
    //ns.print("Most expensive unowned aug by faction: " + JSON.stringify(mostExpensiveAugByFaction));
    // TODO: Detect when the most expensive aug from two factions is the same - only need it from the first one. (Update lists and remove 'afforded' augs?)
    mostExpensiveDesiredAugByFaction = Object.fromEntries(allKnownFactions.map(f => [f,
        dictFactionAugs[f].filter(aug => !ownedAugmentations.includes(aug) && (
            Object.keys(dictAugStats[aug]).length == 0 || options['desired-stats'].length == 0 ||
            Object.keys(dictAugStats[aug]).some(key => options['desired-stats'].some(stat => key.includes(stat)))
        )).reduce((max, aug) => Math.max(max, dictAugRepReqs[aug]), -1)]));
    //ns.print("Most expensive desired aug by faction: " + JSON.stringify(mostExpensiveDesiredAugByFaction));

    // Filter out factions who have no augs (or tentatively filter those with no desirable augs) unless otherwise configured. The exception is
    // we will always filter the most-precluding city factions, (but not ["Chongqing", "New Tokyo", "Ishima"], which can all be joined simultaneously)
    // TODO: Think this over more. need to filter e.g. chonquing if volhaven is incomplete...
    const filterableFactions = (options['get-invited-to-every-faction'] ? ["Aevum", "Sector-12", "Volhaven"] : allKnownFactions);
    // Unless otherwise configured, we will skip factions with no remaining augmentations
    completedFactions = filterableFactions.filter(fac => mostExpensiveAugByFaction[fac] == -1);
    softCompletedFactions = filterableFactions.filter(fac => mostExpensiveDesiredAugByFaction[fac] == -1 && !completedFactions.includes(fac));
    skipFactions = options.skip.concat(cannotWorkForFactions).concat(completedFactions).filter(fac => !firstFactions.includes(fac));
    if (completedFactions.length > 0)
        ns.print(`${completedFactions.length} factions will be skipped (for having all augs purchased): ${completedFactions.join(", ")}`);
    if (softCompletedFactions.length > 0)
        ns.print(`${softCompletedFactions.length} factions will initially be skipped (all desired augs purchased): ${softCompletedFactions.join(", ")}`);

    // TODO: If --prioritize-invites is set, we should have a preferred faction order that puts easiest-invites-to-earn at the front (e.g. all city factions)
    numJoinedFactions = playerInfo.factions.length;
    fulcrummHackReq = await getServerRequiredHackLevel(ns, "fulcrumassets");
}

/** @param {NS} ns */
async function mainLoop(ns) {
    if (!breakToMainLoop()) scope++; // Increase the scope of work if the last iteration completed early (i.e. due to all work within that scope being complete)
    mainLoopStart = Date.now();
    ns.print(`INFO: Starting main work loop with scope: ${scope}...`);

    // Update information that may have changed since our last loop
    const player = (await getPlayerInfo(ns));
    if (player.factions.length > numJoinedFactions) { // If we've recently joined a new faction, reset our work scope
        scope = 1; // Back to basics until we've satisfied all highest-priority work
        numJoinedFactions = player.factions.length;
    }
    // Immediately accept any outstanding faction invitations for factions we want to earn rep with soon
    // TODO: If check if we would qualify for an invite to any factions just by travelling, and do so to start earning passive rep
    const invites = await checkFactionInvites(ns);
    const invitesToAccept = options['get-invited-to-every-faction'] || options['prioritize-invites'] ?
        invites.filter(f => !skipFactions.includes(f)) :
        invites.filter(f => !skipFactions.includes(f) && !softCompletedFactions.includes(f));
    for (const invite of invitesToAccept)
        await tryJoinFaction(ns, invite);
    // Get some information about gangs (if unlocked)
    if (2 in dictSourceFiles) {
        if (!playerGang) { // Check if we've joined a gang since our last iteration
            const gangInfo = await getGangInfo(ns);
            playerGang = gangInfo ? gangInfo.faction : null;
            // If we've only just now joined a gang, we have to reload startup data, because the augs offered by our gang faction has now changed.
            if (playerGang) await loadStartupData(ns);
        }
        if (ns.heart.break() <= options['karma-threshold-for-gang-invites']) { // Start trying to earn gang faction invites if we're close to unlocking gangs
            if (!playerGang) {
                log(ns, `INFO: We are nearing the Karma required to unlock gangs (${formatNumberShort(ns.heart.break())} / -54K). Prioritize earning gang faction invites.`);
                for (const factionName of desiredGangFactions)
                    await earnFactionInvite(ns, factionName);
            }
        }
    }
    // If bladeburner is currently active, but we do not yet have The Blade's Simulacrum decide, whether we pause working.        
    if (7 in dictSourceFiles && !hasSimulacrum && !options['no-bladeburner-check'] && player.inBladeburner) {
        if (playerGang) { // Heuristic: If we're in a gang, its rep will give us access to most augs, we can take a break from working
            ns.print(`INFO: Gang will give us most augs, so pausing work to allow Bladeburner to operate.`);
            await stop(ns); // stop working so bladeburner can run
            await ns.sleep(checkForNewPrioritiesInterval);
            return;
        }
    }

    // Remove Fulcrum from our "EarlyFactionOrder" if hack level is insufficient to backdoor their server
    let priorityFactions = options['crime-focus'] ? preferredCrimeFactionOrder.slice() : preferredEarlyFactionOrder.slice();
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
    if (scope <= 1 || breakToMainLoop()) return;

    // Strategy 2: Grind XP with all priority factions that are joined or can be joined, until every single one has desired REP
    for (const faction of factionWorkOrder)
        if (!breakToMainLoop()) await workForSingleFaction(ns, faction);
    if (scope <= 2 || breakToMainLoop()) return;

    // Strategy 3: Work for any megacorporations not yet completed to earn their faction invites. Once joined, we don't lose these factions on reset.
    let megacorpFactions = preferredCompanyFactionOrder.filter(f => !skipFactions.includes(f));
    await workForAllMegacorps(ns, megacorpFactions, false);
    if (scope <= 3 || breakToMainLoop()) return;

    // Strategy 4: Work for megacorps again, but this time also work for the company factions once the invite is earned
    await workForAllMegacorps(ns, megacorpFactions, true);
    if (scope <= 4 || breakToMainLoop()) return;

    // Strategies 5+ now work towards getting an invite to *all factions in the game* (sorted by least-expensive final aug (correlated to easiest faction-invite requirement))
    let joinedFactions = player.factions; // In case our hard-coded list of factions is missing anything, merge it with the list of all factions
    let knownFactions = factions.concat(joinedFactions.filter(f => !factions.includes(f)));
    let allIncompleteFactions = knownFactions.filter(f => !skipFactions.includes(f) && !completedFactions.includes(f)).sort((a, b) => mostExpensiveAugByFaction[a] - mostExpensiveAugByFaction[b]);
    // Strategy 5: For *all factions in the game*, try to earn an invite and work for rep until we can afford the most-expensive *desired* aug (or unlock donations, whichever comes first)
    for (const faction of allIncompleteFactions.filter(f => !softCompletedFactions.includes(f)))
        if (!breakToMainLoop()) await workForSingleFaction(ns, faction);
    if (scope <= 5 || breakToMainLoop()) return;

    // Strategy 6: Revisit all factions until each has enough rep to unlock donations - so if we can't afford all augs this reset, at least we don't need to grind for rep on the next reset
    // For this, we reverse the order (ones with augs costing the most-rep to least) since these will take the most time to re-grind rep for if we can't buy them this reset.
    for (const faction of allIncompleteFactions.reverse())
        if (breakToMainLoop()) // Only continue on to the next faction if it isn't time for a high-level update.
            await workForSingleFaction(ns, faction, true);
    if (scope <= 6 || breakToMainLoop()) return;

    // Strategy 7:  Next, revisit all factions and grind XP until we can afford the most expensive aug, even if we could just buy the required rep next reset
    for (const faction of allIncompleteFactions.reverse()) // Re-reverse the sort order so we start with the easiest (cheapest) faction augs to complete
        if (breakToMainLoop()) // Only continue on to the next faction if it isn't time for a high-level update.
            await workForSingleFaction(ns, faction, true, true);
    if (scope <= 7 || breakToMainLoop()) return;

    // Strategy 8: Busy ourselves for a while longer, then loop to see if there anything more we can do for the above factions
    let factionsWeCanWorkFor = joinedFactions.filter(f => !options.skip.includes(f) && !cannotWorkForFactions.includes(f) && f != playerGang);
    let foundWork = false;
    if (factionsWeCanWorkFor.length > 0 && !options['crime-focus']) {
        // Do a little work for whatever faction has the most favor (e.g. to earn EXP and enable additional neuroflux purchases)
        let mostFavorFaction = factionsWeCanWorkFor.sort((a, b) => dictFactionFavors[b] - dictFactionFavors[a])[0];
        let targetRep = 1000 + (await getFactionReputation(ns, mostFavorFaction)) * 1.05; // Hack: Grow rep by ~5%, plus 1000 incase it's currently 0
        ns.print(`INFO: All useful work complete. Grinding an additional 5% rep (to ${formatNumberShort(targetRep)}) with highest-favor faction: ${mostFavorFaction} (${dictFactionFavors[mostFavorFaction]?.toFixed(2)} favor)`);
        foundWork = await workForSingleFaction(ns, mostFavorFaction, false, false, targetRep);
    }
    if (!foundWork && !options['no-crime']) { // Otherwise, kill some time by doing crimes for a little while
        ns.print(`INFO: Nothing to do. Doing a little crime...`);
        await crimeForKillsKarmaStats(ns, 0, -ns.heart.break() + 1000 /* Hack: Decrease Karma by 1000 */, 0);
    } else if (!foundWork) { // If our hands our tied, twiddle our thumbs a bit
        ns.print(`INFO: Nothing to do. Sleeping for 30 seconds to see if magically we join a faction`);
        await ns.sleep(30000);
    }
    if (scope <= 8) scope--; // Cap the 'scope' value from increasing perpetually when we're on our last strategy
}

// Ram-dodging helper, runs a command for all items in a list and returns a dictionary.
const dictCommand = (command) => `Object.fromEntries(ns.args.map(o => [o, ${command}]))`;

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
const requiredHackByFaction = { "Tian Di Hui": 50, "Netburners": 80, "Speakers for the Dead": 100, "The Syndicate": 200, "The Dark Army": 300, "The Covenant": 850, "Daedalus": 2500, "Illuminati": 1500 };
const requiredCombatByFaction = { "Slum Snakes": 30, "Tetrads": 75, "Speakers for the Dead": 300, "The Syndicate": 200, "The Dark Army": 300, "The Covenant": 850, "Daedalus": 1500, "Illuminati": 1200 };
const requiredKarmaByFaction = { "Slum Snakes": 9, "Tetrads": 18, "Silhouette": 22, "Speakers for the Dead": 45, "The Dark Army": 45, "The Syndicate": 90 };
const requiredKillsByFaction = { "Speakers for the Dead": 30, "The Dark Army": 5 };
const reqHackingOrCombat = ["Daedalus"]; // Special case factions that require only hacking or combat stats, not both

/** @param {NS} ns */
async function earnFactionInvite(ns, factionName) {
    let player = await getPlayerInfo(ns);
    const joinedFactions = player.factions;
    if (joinedFactions.includes(factionName)) return true;
    var invitations = await checkFactionInvites(ns);
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
    // Check on physical stat requirements
    const physicalStats = ["strength", "defense", "dexterity", "agility"];
    // Establish some helper functions used to determine how fast we can train a stat
    const title = s => s && s[0].toUpperCase() + s.slice(1); // Annoyingly bitnode multis capitalize the first letter physical stat name
    const heuristic = (stat, trainingBitnodeMult) =>
        Math.sqrt(player[`${stat}_mult`] * bitnodeMultipliers[`${title(stat)}LevelMultiplier`] *
            /* */ player[`${stat}_exp_mult`] * trainingBitnodeMult);
    const crimeHeuristic = (stat) => heuristic(stat, bitnodeMultipliers.CrimeExpGain); // When training with crime
    const classHeuristic = (stat) => heuristic(stat, bitnodeMultipliers.ClassGymExpGain); // When training in university
    // Check which stats need to be trained up
    requirement = requiredCombatByFaction[factionName];
    let deficientStats = !requirement ? [] : physicalStats.map(stat => ({ stat, value: player[stat] })).filter(stat => stat.value < requirement);
    // Hash for special-case factions (just 'Daedalus' for now) requiring *either* hacking *or* combat
    if (reqHackingOrCombat.includes(factionName) && deficientStats.length > 0 && (
        // Compare roughly how long it will take to train up our hacking stat
        (requiredHackByFaction[factionName] - player.hacking) / classHeuristic('hacking') <
        // To the slowest time it will take to train up our deficient physical stats
        Math.min(...deficientStats.map(s => (requiredCombatByFaction[factionName] - s.value) / crimeHeuristic(s.stat)))))
        ns.print(`Ignoring combat requirement for ${factionName} as we are more likely to unlock them via hacking stats.`);
    else if (deficientStats.length > 0) {
        ns.print(`${reasonPrefix} you have insufficient combat stats. Need: ${requirement} of each, Have ` +
            physicalStats.map(s => `${s.slice(0, 3)}: ${player[s]}`).join(", "));
        const em = requirement / options['training-stat-per-multi-threshold'];
        // Hack: Create a rough heuristic suggesting how much multi we need to train physical stats in a reasonable amount of time. TODO: Be smarter
        if (deficientStats.map(s => s.stat).some(s => crimeHeuristic(s) < em))
            return ns.print("Some mults * exp_mults * bitnode mults appear to be too low to increase stats in a reasonable amount of time. " +
                `You can control this with --training-stat-per-multi-threshold. Current sqrt(mult*exp_mult*bn_mult*bn_exp_mult) ` +
                `should be ~${formatNumberShort(em, 2)}, have ` + deficientStats.map(s => s.stat).map(s => `${s.slice(0, 3)}: sqrt(` +
                    `${formatNumberShort(player[`${s}_mult`])}*${formatNumberShort(player[`${s}_exp_mult`])}*` +
                    `${formatNumberShort(bitnodeMultipliers[`${title(s)}LevelMultiplier`])}*` +
                    `${formatNumberShort(bitnodeMultipliers.CrimeExpGain)})=${formatNumberShort(crimeHeuristic(s))}`).join(", "));
        doCrime = true; // TODO: There could be more efficient ways to gain combat stats than homicide, although at least this serves future crime factions
    }
    if (doCrime && options['no-crime'])
        return ns.print(`${reasonPrefix} Doing crime to meet faction requirements is disabled. (--no-crime or --no-focus)`);
    if (doCrime)
        workedForInvite = await crimeForKillsKarmaStats(ns, requiredKillsByFaction[factionName] || 0, requiredKarmaByFaction[factionName] || 0, requiredCombatByFaction[factionName] || 0);

    // Study for hack levels if that's what's keeping us
    // Note: Check if we have insuffient hack to backdoor this faction server. If we have sufficient hack, we will "waitForInvite" below assuming an external script is backdooring ASAP 
    let serverReqHackingLevel = 0;
    if (requirement = requiredBackdoorByFaction[factionName]) {
        serverReqHackingLevel = await getServerRequiredHackLevel(ns, requirement);
        if (player.hacking < serverReqHackingLevel) {
            ns.print(`${reasonPrefix} you must first backdoor ${requirement}, which needs hack: ${serverReqHackingLevel}, Have: ${player.hacking}`);
        }
    }
    requirement = Math.max(serverReqHackingLevel, requiredHackByFaction[factionName] || 0)
    if (requirement && player.hacking < requirement &&
        // Special case (Daedalus): Don't grind for hack requirement if we previously did a grind for the physical requirements
        !(reqHackingOrCombat.includes(factionName) && workedForInvite)) {
        ns.print(`${reasonPrefix} you have insufficient hack level. Need: ${requirement}, Have: ${player.hacking}`);
        const em = requirement / options['training-stat-per-multi-threshold'];
        if (options['no-studying'])
            return ns.print(`--no-studying is set, nothing we can do to improve hack level.`);
        else if (classHeuristic('hacking') < em)
            return ns.print(`Your combination of Hacking mult (${formatNumberShort(player.hacking_mult)}), exp_mult ` +
                `(${formatNumberShort(player.hacking_exp_mult)}), and bitnode hacking / study exp mults ` +
                `(${formatNumberShort(bitnodeMultipliers.HackingLevelMultiplier)}) / (${formatNumberShort(bitnodeMultipliers.ClassGymExpGain)}) ` +
                `are probably too low to increase hack from ${player.hacking} to ${requirement} in a reasonable amount of time ` +
                `(${formatNumberShort(classHeuristic('hacking'))} < ${formatNumberShort(em, 2)} - configure with --training-stat-per-multi-threshold)`);
        let studying = false;
        if (player.money > options['pay-for-studies-threshold']) { // If we have sufficient money, pay for the best studies
            if (player.city != "Volhaven") await goToCity(ns, "Volhaven");
            studying = await study(ns, false, "Algorithms");
        } else if (uniByCity[player.city]) // Otherwise only go to free university if our city has a university
            studying = await study(ns, false, "Study Computer Science");
        else
            return ns.print(`You have insufficient money (${formatMoney(player.money)} < --pay-for-studies-threshold ` +
                `${formatMoney(options['pay-for-studies-threshold'])}) to travel or pay for studies, and your current ` +
                `city ${player.city} does not have a university from which to take free computer science.`);
        if (studying)
            workedForInvite = await monitorStudies(ns, 'hacking', requirement);
        // If we studied for hacking, and were awaiting a backdoor, spawn the backdoor script now  
        if (workedForInvite && serverReqHackingLevel) {
            player = await getPlayerInfo(ns);
            if (player.hacking > requirement) {
                ns.print(`Current hacking level ${player.hacking} seems to now meet the backdoor requirement ${requirement}. Spawning backdoor-all-servers.js...`);
                ns.run(getFilePath("/Tasks/backdoor-all-servers.js"));
            }
        }
    }
    if (breakToMainLoop()) return false;

    // Skip factions whose remaining requirement is money. There's not much we can do to earn money
    if ((requirement = requiredMoneyByFaction[factionName]) && player.money < requirement)
        return ns.print(`${reasonPrefix} you have insufficient money. Need: ${formatMoney(requirement)}, Have: ${formatMoney(player.money)}`);

    // If travelling can help us join a faction - we can do that too
    player = await getPlayerInfo(ns);
    let travelledForInvite = false;
    let travelToCityOrDidRecently = async city => // Helper to consider us as having travelled for an invite if we did just now, or recently
        player.city != city && await goToCity(ns, city) || player.city == city && (Date.now() - lastTravel < 60000)
    if (['Tian Di Hui', 'Tetrads', 'The Dark Army'].includes(factionName))
        travelledForInvite = await travelToCityOrDidRecently('Chongqing');
    else if (['The Syndicate'].includes(factionName))
        travelledForInvite = await travelToCityOrDidRecently('Sector-12');
    else if (["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"].includes(factionName))
        travelledForInvite = await travelToCityOrDidRecently(factionName);
    if (travelledForInvite) {
        workedForInvite = true;
        player = await getPlayerInfo(ns);
    }

    // Special case, earn a CEO position to gain an invite to Silhouette
    if ("Silhouette" == factionName) {
        ns.print(`You must be a CO (e.g. CEO/CTO) of a company to earn an invite to ${factionName}. This may take a while!`);
        let factionConfig = companySpecificConfigs.find(f => f.name == factionName); // We set up Silhouette with a "company-specific-config" so that we can work for an invite like any megacorporation faction.
        let companyNames = preferredCompanyFactionOrder.map(f => companySpecificConfigs.find(cf => cf.name == f)?.companyName || f);
        let favorByCompany = await getNsDataThroughFile(ns, dictCommand('ns.singularity.getCompanyFavor(o)'), '/Temp/getCompanyFavors.txt', companyNames);
        let repByCompany = await getNsDataThroughFile(ns, dictCommand('ns.singularity.getCompanyRep(o)'), '/Temp/getCompanyReps.txt', companyNames);
        // Change the company to work for into whichever company we can get to CEO fastest with. Minimize needed_rep/rep_gain_rate. CEO job is at 3.2e6 rep, so (3.2e6-current_rep)/(100+favor).
        factionConfig.companyName = companyNames.sort((a, b) => (3.2e6 - repByCompany[a]) / (100 + favorByCompany[a]) - (3.2e6 - repByCompany[b]) / (100 + favorByCompany[b]))[0];
        // Hack: We will be working indefinitely, so we rely on an external script (daemon + faction-manager) to join this faction for us, or for checkForNewPrioritiesInterval to elapse.
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
    const player = await getPlayerInfo(ns);
    if (player.city == cityName) {
        ns.print(`Already in city ${cityName}`);
        return true;
    }
    if (await getNsDataThroughFile(ns, `ns.singularity.travelToCity(ns.args[0])`, '/Temp/travel.txt', [cityName])) {
        lastActionRestart = Date.now();
        lastTravel = Date.now()
        announce(ns, `Travelled from ${player.city} to ${cityName}`, 'info');
        return true;
    }
    if (player.money < 200000)
        announce(ns, `WARN: Insufficient funds to travel from ${player.city} to ${cityName}`, 'warning');
    else
        announce(ns, `ERROR: Failed to travel from ${player.city} to ${cityName} for some reason...`, 'error');
    return false;
}

/** @param {NS} ns */
export async function crimeForKillsKarmaStats(ns, reqKills, reqKarma, reqStats, doFastCrimesOnly = false) {
    const bestCrimesByDifficulty = ["heist", "assassinate", "homicide", "mug"]; // Will change crimes as our success rate improves
    const chanceThresholds = [0.75, 0.9, 0.5, 0]; // Will change crimes once we reach this probability of success for better all-round gains
    doFastCrimesOnly = doFastCrimesOnly || (options ? options['fast-crimes-only'] : false);
    let player = await getPlayerInfo(ns);
    let strRequirements = [];
    let forever = reqKills >= Number.MAX_SAFE_INTEGER || reqKarma >= Number.MAX_SAFE_INTEGER || reqStats >= Number.MAX_SAFE_INTEGER;
    if (reqKills) strRequirements.push(() => `${reqKills} kills (Have ${player.numPeopleKilled})`);
    if (reqKarma) strRequirements.push(() => `-${reqKarma} Karma (Have ${ns.heart.break()})`);
    if (reqStats) strRequirements.push(() => `${reqStats} of each combat stat (Have Str: ${player.strength}, Def: ${player.defense}, Dex: ${player.dexterity}, Agi: ${player.agility})`);
    let crime, lastCrime, lastStatusUpdateTime;
    while (forever || player.strength < reqStats || player.defense < reqStats || player.dexterity < reqStats || player.agility < reqStats || player.numPeopleKilled < reqKills || -ns.heart.break() < reqKarma) {
        if (!forever && breakToMainLoop()) return ns.print('INFO: Interrupting crime to check on high-level priorities.');
        let crimeChances = await getNsDataThroughFile(ns, `Object.fromEntries(ns.args.map(c => [c, ns.singularity.getCrimeChance(c)]))`, '/Temp/crime-chances.txt', bestCrimesByDifficulty);
        let needStats = player.strength < reqStats || player.defense < reqStats || player.dexterity < reqStats || player.agility < reqStats;
        let karma = -ns.heart.break();
        crime = crimeCount < 10 ? (crimeChances["homicide"] > 0.75 ? "homicide" : "mug") : // Start with a few fast & easy crimes to boost stats if we're just starting
            (!needStats && (player.numPeopleKilled < reqKills || karma < reqKarma)) ? "homicide" : // If *all* we need now is kills or Karma, homicide is the fastest way to do that, even at low proababilities
                bestCrimesByDifficulty.find((c, index) => doFastCrimesOnly && index <= 1 ? 0 : crimeChances[c] >= chanceThresholds[index]); // Otherwise, crime based on success chance vs relative reward (precomputed)
        if (lastCrime != crime || (Date.now() - lastStatusUpdateTime) > statusUpdateInterval) {
            ns.print(`Committing "${crime}" (${(100 * crimeChances[crime]).toPrecision(3)}% success) ` + (forever ? 'forever...' : `until we reach ${strRequirements.map(r => r()).join(', ')}`));
            lastCrime = crime;
            lastStatusUpdateTime = Date.now();
        }
        ns.tail(); // Force a tail window open when auto-criming, or else it's very difficult to stop if it was accidentally closed.
        await ns.sleep(1 + (await getNsDataThroughFile(ns, 'ns.singularity.commitCrime(ns.args[0])', '/Temp/commitCrime.txt', [crime])));
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
    return await study(ns, focus, 'Leadership', 'ZB Institute Of Technology');
}

const uniByCity = Object.fromEntries([["Aevum", "Summit University"], ["Sector-12", "Rothman University"], ["Volhaven", "ZB Institute of Technology"]]);

/** @param {NS} ns */
async function study(ns, focus, course, university = null) {
    if (options['no-studying'])
        return announce(ns, `WARNING: Could not study '${course}' because --no-studying is set.`, 'warning');
    const playerCity = (await getPlayerInfo(ns)).city;
    if (!university) { // Auto-detect the university in our city
        university = uniByCity[playerCity];
        if (!university)
            return announce(ns, `WARNING: Could not study '${course}' because we are in city '${playerCity}' without a university.`, 'warning');
    }
    if (await getNsDataThroughFile(ns, `ns.singularity.universityCourse(ns.args[0], ns.args[1], ns.args[2])`, '/Temp/study.txt', [university, course, focus])) {
        lastActionRestart = Date.now();
        announce(ns, `Started studying '${course}' at '${university}`, 'success');
        return true;
    }
    announce(ns, `ERROR: For some reason, failed to study '${course}' at university '${university}' (Not in correct city? Player is in '${playerCity}')`, 'error');
    return false;
}

/** @param {NS} ns
 * Helper to wait for studies to be complete */
async function monitorStudies(ns, stat, requirement) {
    let lastStatusUpdateTime = 0;
    while (!breakToMainLoop()) {
        const player = await getPlayerInfo(ns);
        if (!player.className)
            return announce(ns, 'WARNING: Somebody interrupted our studies.', 'warning');
        if (player[stat] >= requirement) {
            announce(ns, `SUCCESS: Achieved ${stat} level ${player[stat]} >= ${requirement} while studying`);
            return true;
        }
        if ((Date.now() - lastStatusUpdateTime) > statusUpdateInterval) {
            lastStatusUpdateTime = Date.now();
            announce(ns, `Studying until ${stat} reaches ${requirement}. Currently at ${player[stat]}...`)
        }
        await ns.sleep(loopSleepInterval);
    }
}

/** @param {NS} ns */
export async function waitForFactionInvite(ns, factionName, maxWaitTime = waitForFactionInviteTime) {
    ns.print(`Waiting for invite from faction "${factionName}"...`);
    let waitTime = maxWaitTime;
    do {
        var invitations = await checkFactionInvites(ns);
        var joinedFactions = (await getPlayerInfo(ns)).factions;
        if (invitations.includes(factionName) || joinedFactions.includes(factionName))
            break;
        await ns.sleep(loopSleepInterval);
    } while (!invitations.includes(factionName) && !joinedFactions.includes(factionName) && (waitTime -= 1000) > 0);
    if (joinedFactions.includes(factionName)) // Another script may have auto-joined this faction before we could
        ns.print(`An external script has joined faction "${factionName}" for us.`);
    else if (!invitations.includes(factionName))
        return announce(ns, `ERROR: Waited ${formatDuration(maxWaitTime)}, but still have not recieved an invite for faction: "${factionName}" (Requirements not met?)`, 'error');
    else if (!(await tryJoinFaction(ns, factionName)))
        return announce(ns, `ERROR: Something went wrong. Earned "${factionName}" faction invite, but failed to join it.`, 'error');
    return true;
}

/** @param {NS} ns */
export async function tryJoinFaction(ns, factionName) {
    var joinedFactions = (await getPlayerInfo(ns)).factions;
    if (joinedFactions.includes(factionName))
        return true;
    if (!(await getNsDataThroughFile(ns, `ns.singularity.joinFaction(ns.args[0])`, '/Temp/join-faction.txt', [factionName])))
        return false;
    announce(ns, `Joined faction "${factionName}"`, 'success');
    return true;
}

/** @param {NS} ns
 * @returns {Promise<Player>} the result of ns.getPlayer() */
async function getPlayerInfo(ns) {
    return ns.getPlayer(); // Note: Decided that we call this frequently enough it is not worth ram-dodging
    // return await getNsDataThroughFile(ns, `ns.getPlayerInfo()`, '/Temp/player-info.txt');
}

/** @param {NS} ns
 *  @returns {Promise<string[]>} List of new faction invites */
async function checkFactionInvites(ns) {
    return await getNsDataThroughFile(ns, 'ns.singularity.checkFactionInvitations()', '/Temp/checkFactionInvitations.txt');
}

/** @param {NS} ns
 *  @returns {Promise<GangGenInfo|boolean>} Gang information, if we're in a gang, or False */
async function getGangInfo(ns) {
    return await getNsDataThroughFile(ns, 'ns.gang.inGang() ? ns.gang.getGangInformation() : false', '/Temp/gang-stats.txt')
}

/** @param {NS} ns 
 *  @returns {Promise<Number>} Current reputation with the specified faction */
async function getFactionReputation(ns, factionName) {
    return await getNsDataThroughFile(ns, `ns.singularity.getFactionRep(ns.args[0])`, '/Temp/getFactionRep.txt', [factionName]);
}

/** @param {NS} ns
 *  @returns {Promise<Number>} Current reputation with the specified company */
async function getCompanyReputation(ns, companyName) {
    return await getNsDataThroughFile(ns, `ns.singularity.getCompanyRep(ns.args[0])`, '/Temp/getCompanyRep.txt', [companyName]);
}

/** @param {NS} ns
 *  @returns {Promise<Number>} Current favour with the specified faction */
async function getCurrentFactionFavour(ns, factionName) {
    return await getNsDataThroughFile(ns, `ns.singularity.getFactionFavor(ns.args[0])`, '/Temp/getFactionFavor.txt', [factionName]);
}

/** @param {NS} ns
 *  @returns {Promise<Number>} The hacking level required for the specified server */
async function getServerRequiredHackLevel(ns, serverName) {
    return await getNsDataThroughFile(ns, `ns.getServerRequiredHackingLevel(ns.args[0])`, '/Temp/getServerRequiredHackingLevel.txt', [serverName]);
}

/** A special check for when we unlock donations with Daedalus, this is usually a good time to reset. 
 * @param {NS} ns */
async function daedalusSpecialCheck(ns, favorRepRequired, currentReputation) {
    if (favorRepRequired == 0 || currentReputation < favorRepRequired) return false;
    // If we would be unlocking donations, but actually, we're pretty close to just being able to afford TRP, no impetus to reset.
    if (currentReputation >= 0.9 * 2.500e6) return false;
    log(ns, `INFO: You have enough reputation with Daedalus (have ${formatNumberShort(currentReputation)}) that you will ` +
        `unlock donations (needed ${formatNumberShort(favorRepRequired)}) with them on your next reset.`, !notifiedAboutDaedalus, "info");
    await ns.write("/Temp/Daedalus-donation-rep-attained.txt", true, "w"); // HACK: To notify autopilot that we can reset for rep now.
    notifiedAboutDaedalus = true;
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
    if (highestRepAug == -1 && !firstFactions.includes(factionName) && !forceRep && !options['get-invited-to-every-faction'])
        return ns.print(`All "${factionName}" augmentations are owned. Skipping unlocking faction...`);
    // Ensure we get an invite to location-based factions we might want / need
    if (!await earnFactionInvite(ns, factionName))
        return ns.print(`We are not yet part of faction "${factionName}". Skipping working for faction...`);
    if (startingFavor >= repToDonate && !forceRep) // If we have already unlocked donations via favour - no need to grind for rep
        return ns.print(`Donations already unlocked for "${factionName}". You should buy access to augs. Skipping working for faction...`);
    if (playerGang == factionName) // Cannot work for your own gang faction.
        return ns.print(`"${factionName}" is your gang faction. You can only earn rep in your gang via respect.`);
    if (forceUnlockDonations && mostExpensiveAugByFaction[factionName] < 0.2 * factionRepRequired) { // Special check to avoid pointless donation unlocking
        ns.print(`The last "${factionName}" aug is only ${mostExpensiveAugByFaction[factionName].toLocaleString('en')} rep, ` +
            `not worth grinding ${favorRepRequired.toLocaleString('en')} rep to unlock donations.`);
        forceUnlockDonations = false;
        factionRepRequired = highestRepAug = mostExpensiveAugByFaction[factionName];
    }

    if ((await getPlayerInfo(ns)).workRepGained > 0) // If we're currently doing faction work, stop to collect reputation and find out how much is remaining
        await stop(ns);
    let currentReputation = await getFactionReputation(ns, factionName);
    // If the best faction aug is within 10% of our current rep, grind all the way to it so we can get it immediately, regardless of our current rep target
    if (forceBestAug || highestRepAug <= 1.1 * Math.max(currentReputation, factionRepRequired))
        factionRepRequired = Math.max(highestRepAug, factionRepRequired);
    if (factionName == "Daedalus") await daedalusSpecialCheck(ns, favorRepRequired, currentReputation);
    if (currentReputation >= factionRepRequired)
        return ns.print(`Faction "${factionName}" required rep of ${Math.round(factionRepRequired).toLocaleString('en')} has already been attained ` +
            `(Current rep: ${Math.round(currentReputation).toLocaleString('en')}). Skipping working for faction...`)

    ns.print(`Faction "${factionName}" Highest Aug Req: ${highestRepAug?.toLocaleString('en')}, Current Favor (` +
        `${startingFavor?.toFixed(2)}/${repToDonate?.toFixed(2)}) Req: ${Math.round(favorRepRequired).toLocaleString('en')}`);
    if (options['invites-only'])
        return ns.print(`--invites-only Skipping working for faction...`);
    if (options['prioritize-invites'] && !forceUnlockDonations && !forceBestAug && !forceRep)
        return ns.print(`--prioritize-invites Skipping working for faction for now...`);

    let lastStatusUpdateTime = 0, repGainRatePerMs = 0;
    let lastRepMeasurement = await getFactionReputation(ns, factionName);
    while ((currentReputation = (await getFactionReputation(ns, factionName))) < factionRepRequired) {
        if (breakToMainLoop()) return ns.print('INFO: Interrupting faction work to check on high-level priorities.');
        const factionWork = await detectBestFactionWork(ns, factionName); // Before each loop - determine what work gives the most rep/second for our current stats
        if (await startWorkForFaction(ns, factionName, factionWork, shouldFocusAtWork)) {
            if (shouldFocusAtWork) ns.tail(); // Force a tail window open to help the user kill this script if they accidentally closed the tail window and don't want to keep stealing focus
            currentReputation = await getFactionReputation(ns, factionName); // Update to capture the reputation earned when restarting work
            if (currentReputation > factionRepRequired) break;
            lastActionRestart = Date.now(); repGainRatePerMs = (await getPlayerInfo(ns)).workRepGainRate; // Note: In order to get an accurate rep gain rate, we must wait for the first game tick (200ms) after starting work
            while (repGainRatePerMs === (await getPlayerInfo(ns)).workRepGainRate && (Date.now() - lastActionRestart < 400)) await ns.sleep(10); // TODO: Remove this if/when the game bug is fixed
            repGainRatePerMs = (await getPlayerInfo(ns)).workRepGainRate / 200 * (hasFocusPenaly && !shouldFocusAtWork ? 0.8 : 1 /* penalty if we aren't focused but don't have the aug to compensate */);
        } else {
            announce(ns, `ERROR: Something went wrong, failed to start "${factionWork}" work for faction "${factionName}" (Is gang faction, or not joined?)`, 'error');
            break;
        }
        let status = `Doing '${factionWork}' work for "${factionName}" until ${Math.round(factionRepRequired).toLocaleString('en')} rep.`;
        if (lastFactionWorkStatus != status || (Date.now() - lastStatusUpdateTime) > statusUpdateInterval) {
            // Actually measure how much reputation we've earned since our last update, to give a more accurate ETA including external sources of rep
            let measuredRepGainRatePerMs = ((await getFactionReputation(ns, factionName)) - lastRepMeasurement) / (Date.now() - lastStatusUpdateTime);
            if (currentReputation > lastRepMeasurement + statusUpdateInterval * repGainRatePerMs * 2) // Detect a sudden increase in rep, but don't use it to update the expected rate
                ns.print('SUCCESS: Reputation spike! (Perhaps a coding contract was just solved?) ETA reduced.');
            else if (lastStatusUpdateTime != 0 && Math.abs(measuredRepGainRatePerMs - repGainRatePerMs) / repGainRatePerMs > 0.05) // Stick to the game-provided rate if we measured something within 5% of that number
                repGainRatePerMs = measuredRepGainRatePerMs; // If we measure a significantly different rep gain rate, this could be due to external sources of rep (e.g. sleeves) - account for it in the ETA
            lastStatusUpdateTime = Date.now(); lastRepMeasurement = currentReputation;
            const eta_milliseconds = (factionRepRequired - currentReputation) / repGainRatePerMs;
            ns.print((lastFactionWorkStatus = status) + ` Currently at ${Math.round(currentReputation).toLocaleString('en')}, earning ${formatNumberShort(repGainRatePerMs * 1000)} rep/sec. ` +
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
            await stop(ns); // We're close - stop working so our current rep is accurate when we check the while loop condition
    }
    if (currentReputation >= factionRepRequired)
        ns.print(`Attained ${Math.round(currentReputation).toLocaleString('en')} rep with "${factionName}" (needed ${factionRepRequired.toLocaleString('en')}).`);
    if (factionName == "Daedalus") await daedalusSpecialCheck(ns, favorRepRequired, currentReputation);
    return currentReputation >= factionRepRequired;
}

/** Stop whatever focus work we're currently doing
 * @param {NS} ns */
async function stop(ns) { return await getNsDataThroughFile(ns, `ns.singularity.stopAction()`, '/Temp/stopAction.txt'); }

/** Start the specified faction work
 * @param {NS} ns */
async function startWorkForFaction(ns, factionName, work, focus) {
    return await getNsDataThroughFile(ns, `ns.singularity.workForFaction(ns.args[0], ns.args[1], ns.args[2])`, '/Temp/workForFaction.txt', [factionName, work, focus])
}

/** Try all work types and see what gives the best rep gain with this faction!
 * @param {NS} ns  */
async function detectBestFactionWork(ns, factionName) {
    let bestWork, bestRepRate = 0;
    for (const work of ["security", "field", "hacking"]) {
        if (!(await startWorkForFaction(ns, factionName, work, shouldFocusAtWork))) {
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
    if (bestWork === undefined) {
        mainLoopStart = 0; // Force break out of whatever work loop we're in to update info (maybe we formed a gang with the faction we were working for?)
        throw Error(`The faction "${factionName}" does not support any of the known work types. Cannot work for this faction!`);
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
    let earnedAnyInvite = false;
    for (const factionName of megacorpFactionsInPreferredOrder) {
        const earnedInvite = await workForMegacorpFactionInvite(ns, factionName, doFactionWork);
        earnedAnyInvite = earnedAnyInvite || earnedInvite;
        if (earnedInvite && doFactionWork && !breakToMainLoop())
            await workForSingleFaction(ns, factionName);
        if (breakToMainLoop()) return;
    }
    if (alsoWorkForCompanyFactions && !oneCompanyFactionAtATime) { // If configured, start grinding rep with company factions we've joined
        if (earnedAnyInvite) // Avoid log noise by only logging this when a new invite was earned
            ns.print(`Done working for companies, now working for all incomplete company factions...`);
        for (const factionName of megacorpFactionsInPreferredOrder)
            if (!breakToMainLoop()) await workForSingleFaction(ns, factionName);
    }
}

/** Helper to spend hashes on something and return the amount of hashes spent (if any)
 * @param {NS} ns */
async function trySpendHashes(ns, spendOn) {
    return await getNsDataThroughFile(ns,
        'ns.hacknet.numHashes() + ns.hacknet.spendHashes(ns.args[0]) - ns.hacknet.numHashes()',
        '/Temp/hacknet-spendHashes-returnSpent.txt', [spendOn]);
}

/** If we're wealthy, hashes have relatively little monetary value, spend hacknet-node hashes on contracts to gain rep faster
 * @param {NS} ns */
export async function tryBuyReputation(ns) {
    if (options['no-coding-contracts']) return;
    if ((await getPlayerInfo(ns)).money > 100E9) { // If we're wealthy, hashes have relatively little monetary value, spend hacknet-node hashes on contracts to gain rep faster
        let spentHashes = await trySpendHashes(ns, "Generate Coding Contract");
        if (spentHashes > 0) {
            announce(ns, `Generated a new coding contract for ${formatNumberShort(Math.round(spentHashes / 100) * 100)} hashes`, 'success');
        }
    }
}

// Used when working for a company to see if their server has been backdoored. If so, we can expect an increase in rep-gain (used for predicting an ETA)
const serverByCompany = { "Bachman & Associates": "b-and-a", "ECorp": "ecorp", "Clarke Incorporated": "clarkinc", "OmniTek Incorporated": "omnitek", "NWO": "nwo", "Blade Industries": "blade", "MegaCorp": "megacorp", "KuaiGong International": "kuai-gong", "Fulcrum Technologies": "fulcrumtech", "Four Sigma": "4sigma" };

/** Apply to the specified role at the specified company
 * @param {NS} ns */
async function tryApplyToCompany(ns, company, role) {
    return await getNsDataThroughFile(ns, `ns.singularity.applyToCompany(ns.args[0], ns.args[1])`, '/Temp/applyToCompany.txt', [company, role])
}

/** @param {NS} ns */
export async function workForMegacorpFactionInvite(ns, factionName, waitForInvite) {
    const companyConfig = companySpecificConfigs.find(c => c.name == factionName); // For anything company-specific
    const companyName = companyConfig?.companyName || factionName; // Name of the company that gives the faction (same for all but Fulcrum)
    const statModifier = companyConfig?.statModifier || 0; // How much e.g. Hack / Cha is needed for a promotion above the base requirement for the job
    const repRequiredForFaction = companyConfig?.repRequiredForFaction || 200000; // Required to unlock the faction

    let player = (await getPlayerInfo(ns));
    if (player.factions.includes(factionName)) return false; // Only return true if we did work to earn a new faction invite
    if ((await checkFactionInvites(ns)).includes(factionName))
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
            if (await tryApplyToCompany(ns, companyName, bestRoleName))
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
        let status = `Next promotion ('${nextJobName}' #${nextJobTier}) at Hack:${requiredHack} Cha:${requiredCha} Rep:${requiredRep?.toLocaleString('en')}` +
            (repRequiredForFaction > nextJob.reqRep[nextJobTier] ? '' : `, but we won't need it, because we'll sooner hit ${repRequiredForFaction.toLocaleString('en')} reputation to unlock company faction "${factionName}"!`);
        // We should only study at university if every other requirement is met but Charisma
        if (currentReputation >= requiredRep && player.hacking >= requiredHack && player.charisma < requiredCha && !options['no-studying']) {
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
                let spentHashes = await trySpendHashes(ns, "Improve Studying");
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
        if (await tryApplyToCompany(ns, companyName, currentRole))
            announce(ns, `Unexpected '${currentRole}' promotion from ${currentJob} to "${(await getPlayerInfo(ns)).jobs[companyName]}. Promotion logic must be off..."`, 'warning');
        // TODO: If we ever get rid of the below periodic restart-work, we will need to monitor for interruptions with player.workType == e.g. "Work for Company"
        if (!studying && (!working || (Date.now() - lastActionRestart >= restartWorkInteval) /* We must periodically restart work to collect Rep Gains */)) {
            // Work for the company (assume daemon is grinding hack XP as fast as it can, so no point in studying for that)
            if (await getNsDataThroughFile(ns, `ns.singularity.workForCompany(ns.args[0], ns.args[1])`, '/Temp/workForCompany.txt', [companyName, shouldFocusAtWork])) {
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
                backdoored = await getNsDataThroughFile(ns, `ns.getServer(ns.args[0]).backdoorInstalled`, '/Temp/getServer-backdoorInstalled.txt', [serverByCompany[companyName]]);
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
                `Rep:${Math.round(currentReputation).toLocaleString('en')} ${currentReputation >= (requiredRep || repRequiredForFaction) ? '✓' : `✗ (ETA: ${formatDuration(eta_milliseconds)})`}`);
            lastStatus = status;
        }
        await ns.sleep(loopSleepInterval); // Sleep now and wake up periodically and stop working to check our stats / reputation progress
    }
    // Return true if we succeeded, false otherwise.
    if (currentReputation >= repRequiredForFaction) {
        ns.print(`Attained ${repRequiredForFaction.toLocaleString('en')} rep with "${companyName}".`);
        if (!player.factions.includes(factionName) && waitForInvite)
            return await waitForFactionInvite(ns, factionName);
        return true;
    }
    ns.print(`Stopped working for "${companyName}" repRequiredForFaction: ${repRequiredForFaction.toLocaleString('en')} ` +
        `currentReputation: ${Math.round(currentReputation).toLocaleString('en')} inFaction: ${player.factions.includes(factionName)}`);
    return false;
}