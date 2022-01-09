import { formatNumberShort, formatMoney, getNsDataThroughFile, getActiveSourceFiles } from './helpers.js'

// Prefer to join factions in (ish) order of most expensive to least expensive 
// This also acts as a list of default "easy" factions to list and compare, in addition to any other invites you may have
const preferredFactionOrder = [
    "BitRunners", "The Black Hand", "NiteSec", "CyberSec", "Netburners", // Hack Based
    "Tian Di Hui", "Sector-12", "Chongqing", "New Tokyo", "Ishima", "Aevum", "Volhaven", // Location Based
    "Slum Snakes", "Tetrads" // Crime Based
];
let factionNames = [];
let playerData = null;
let joinedFactions = [];
let ownedAugmentations = [];
let factionData = {};
let augmentationData = {};
let allAugStats = [];
let options = null; // A copy of the options used at construction time
let purchaseableAugs;
let purchaseFactionDonations;
// Factors that control how augmentation prices scale
const nfCountMult = 1.14
let augCountMult = 1.9; // The multiplier for the cost increase of augmentations (changes based on SF11 level)

const argsSchema = [
    ['a', false], // Display all factions (spoilers), not just unlocked and early-game factions
    ['all', false],
    ['after-faction', []], // Pretend we were to buy all augs offered by these factions. Show us only what remains.
    ['join-only', false], // Don't generate input, just join factions that can/should be joined
    ['force-join', ['Slum Snakes']], // Always join these factions if we have an invite
    // Display-related options - controls what information is displayed and how
    ['v', false], // Print the terminal as well as the script logs
    ['verbose', false],
    ['i', false], // Display stats for all factions and augs, despite what we already have (kind of a "mock" mode)
    ['ignore-player-data', false],
    ['u', false], // When displaying total aug stats for a faction, only include augs not given by a faction further up the list
    ['unique', false],
    ['sort', 'hacking'], // What stat is the table of total faction stats sorted by
    ['hide-stat', ['bladeburner', 'hacknet']], // Stats to exclude from the final table (partial matching works)
    // Augmentation purchasing-related options. Controls what augmentations are included in cost calculations, and optionally purchased
    ['aug-desired', []], // These augs will be marked as "desired" whether or not they match desired-stats
    ['omit-aug', []], // Augmentations to exclude from the augmentation summary because we do not wish to purchase this round
    ['stat-desired', ['hacking', 'faction_rep', 'company_rep', 'charisma', 'hacknet']], // Augs that give these will be starred
    ['disable-faction', []], // Factions to omit from all data, stats, and calcs, (e.g.) if you do not want to purchase augs from them, or do not want to see them because they are impractical to join at this time
    ['disable-donations', false], // When displaying "obtainable" augs and prices, don't include augs that require a donation to meet their rep requirements
    ['purchase', false], // Set to true to pull the trigger on purchasing all desired augs in the order specified
    ['neuroflux-disabled', false], // Set to true to skip including as many neuroflux upgrades as we can afford
];

const stat_multis = ["agility_exp", "agility", "charisma_exp", "charisma", "company_rep", "crime_money", "crime_success", "defense_exp", "defense", "dexterity_exp", "dexterity",
    "faction_rep", "hacking_chance", "hacking_exp", "hacking_grow", "hacking_money", "hacking", "hacking_speed", "strength_exp", "strength", "work_money",
    "bladeburner_analysis", "bladeburner_max_stamina", "bladeburner_stamina_gain", "bladeburner_success_chance",
    "hacknet_node_core_cost", "hacknet_node_level_cost", "hacknet_node_money", "hacknet_node_purchase_cost", "hacknet_node_ram_cost"];

const factions = ["Illuminati", "Daedalus", "The Covenant", "ECorp", "MegaCorp", "Bachman & Associates", "Blade Industries", "NWO", "Clarke Incorporated", "OmniTek Incorporated",
    "Four Sigma", "KuaiGong International", "Fulcrum Secret Technologies", "BitRunners", "The Black Hand", "NiteSec", "Aevum", "Chongqing", "Ishima", "New Tokyo", "Sector-12",
    "Volhaven", "Speakers for the Dead", "The Dark Army", "The Syndicate", "Silhouette", "Tetrads", "Slum Snakes", "Netburners", "Tian Di Hui", "CyberSec", "Bladeburners"];

const augmentations = ["ADR-V1 Pheromone Gene", "ADR-V2 Pheromone Gene", "Artificial Bio-neural Network Implant", "Artificial Synaptic Potentiation", "Augmented Targeting I", "Augmented Targeting II", "Augmented Targeting III", "BLADE-51b Tesla Armor", "BLADE-51b Tesla Armor: Energy Shielding Upgrade", "BLADE-51b Tesla Armor: IPU Upgrade", "BLADE-51b Tesla Armor: Omnibeam Upgrade", "BLADE-51b Tesla Armor: Power Cells Upgrade", "BLADE-51b Tesla Armor: Unibeam Upgrade", "Bionic Arms", "Bionic Legs", "Bionic Spine", "BitRunners Neurolink", "BitWire", "Blade's Runners", "BrachiBlades", "CRTX42-AA Gene Modification", "CashRoot Starter Kit", "Combat Rib I", "Combat Rib II", "Combat Rib III", "CordiARC Fusion Reactor", "Cranial Signal Processors - Gen I", "Cranial Signal Processors - Gen II", "Cranial Signal Processors - Gen III", "Cranial Signal Processors - Gen IV", "Cranial Signal Processors - Gen V", "DataJack", "DermaForce Particle Barrier", "ECorp HVMind Implant", "EMS-4 Recombination", "Embedded Netburner Module", "Embedded Netburner Module Analyze Engine", "Embedded Netburner Module Core Implant", "Embedded Netburner Module Core V2 Upgrade", "Embedded Netburner Module Core V3 Upgrade", "Embedded Netburner Module Direct Memory Access Upgrade", "Enhanced Myelin Sheathing", "Enhanced Social Interaction Implant", "EsperTech Bladeburner Eyewear", "FocusWire", "GOLEM Serum", "Graphene Bionic Arms Upgrade", "Graphene Bionic Legs Upgrade", "Graphene Bionic Spine Upgrade", "Graphene Bone Lacings", "Graphene BrachiBlades Upgrade", "Hacknet Node CPU Architecture Neural-Upload", "Hacknet Node Cache Architecture Neural-Upload", "Hacknet Node Core Direct-Neural Interface", "Hacknet Node Kernel Direct-Neural Interface", "Hacknet Node NIC Architecture Neural-Upload", "HemoRecirculator", "Hydroflame Left Arm", "HyperSight Corneal Implant", "Hyperion Plasma Cannon V1", "Hyperion Plasma Cannon V2", "I.N.T.E.R.L.I.N.K.E.D", "INFRARET Enhancement", "LuminCloaking-V1 Skin Implant", "LuminCloaking-V2 Skin Implant", "NEMEAN Subdermal Weave", "Nanofiber Weave", "Neotra", "Neural Accelerator", "Neural-Retention Enhancement", "Neuralstimulator", "Neuregen Gene Modification", "NeuroFlux Governor", "Neuronal Densification", "Neuroreceptor Management Implant", "Neurotrainer I", "Neurotrainer II", "Neurotrainer III", "Nuoptimal Nootropic Injector Implant", "NutriGen Implant", "ORION-MKIV Shoulder", "OmniTek InfoLoad", "PC Direct-Neural Interface", "PC Direct-Neural Interface NeuroNet Injector", "PC Direct-Neural Interface Optimization Submodule", "PCMatrix", "Photosynthetic Cells", "Power Recirculation Core", "SPTN-97 Gene Modification", "SmartJaw", "SmartSonar Implant", "Social Negotiation Assistant (S.N.A)", "Speech Enhancement", "Speech Processor Implant", "Synaptic Enhancement Implant", "Synfibril Muscle", "Synthetic Heart", "TITN-41 Gene-Modification Injection", "The Black Hand", "The Blade's Simulacrum", "The Red Pill", "The Shadow's Simulacrum", "Unstable Circadian Modulator", "Vangelis Virus", "Vangelis Virus 3.0", "Wired Reflexes", "Xanipher", "nextSENS Gene Modification"]
const strNF = "NeuroFlux Governor"

export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (lastFlag == "--sort")
        return stat_multis;
    if (lastFlag == "--disable-faction" || lastFlag == "--after-faction")
        return factions.map(f => f.replaceAll(" ", "_")).sort(); // Command line doesn't like spaces
    if (lastFlag == "--omit-aug" || lastFlag == "--aug-desired")
        return augmentations.map(f => f.replaceAll(" ", "_"));
    return [];
}

// Flags -a for all factions, -v to print to terminal
/** @param {NS} ns **/
export async function main(ns) {
    options = ns.flags(argsSchema);
    const verbose = options.v || options.verbose;
    const allFactions = options.a || options.all;
    const afterFactions = options['after-faction'].map(f => f.replaceAll("_", " "));
    const omitFactions = options['disable-faction'].map(f => f.replaceAll("_", " "));
    const omitAugs = options['omit-aug'].map(f => f.replaceAll("_", " "));
    const desiredAugs = options['aug-desired'].map(f => f.replaceAll("_", " "));
    const ignorePlayerData = options.i || options['ignore-player-data'];
    const sort = unshorten(options.sort); // Support the user leaving off the _mult suffix
    playerData = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
    const ownedSourceFiles = await getActiveSourceFiles(ns);
    const sf4Level = ownedSourceFiles[4] || 0;
    if (sf4Level == 0)
        log(ns, `WARNING: This script makes heavy use of singularity functions. Without SF4, you're unlikely to get it working.`);
    else if (sf4Level < 3)
        log(ns, `WARNING: This script makes heavy use of singularity functions, which are quite expensive before you have SF4.3. ` +
            `Unless you have a lot of free RAM for temporary scripts, you may get runtime errors.`);
    const sf11Level = ownedSourceFiles[11] || 0;
    augCountMult = [1.9, 1.824, 1.786, 1.767][sf11Level];
    log(ns, `Player has sf11Level ${sf11Level}, so the multiplier after each aug purchased is ${augCountMult}.`);
    joinedFactions = ignorePlayerData ? [] : playerData.factions;
    log(ns, 'In factions: ' + joinedFactions);
    // Get owned augmentations (whether they've been installed or not). Ignore strNF because you can always buy more.
    ownedAugmentations = ignorePlayerData ? [] :
        (await getNsDataThroughFile(ns, 'ns.getOwnedAugmentations(true)', '/Temp/player-augs-purchased.txt')).filter(a => a != strNF);
    if (options['neuroflux-disabled']) omitAugs.push(strNF);
    log(ns, 'Getting all faction data...');
    await updateFactionData(ns, allFactions, omitFactions);
    log(ns, 'Getting all augmentation data...');
    await updateAugmentationData(ns, options['stat-desired'], desiredAugs);
    //ns.tprint(Object.values(augmentationData).map(a => a.name).sort()); Print a list of all augmentation names
    if (!ignorePlayerData) {
        log(ns, 'Joining available factions...');
        await joinFactions(ns);
        if (options['join-only']) return;
        displayJoinedFactionSummary(ns, verbose);
    }
    await manageUnownedAugmentations(ns, omitAugs, verbose);
    displayFactionSummary(ns, verbose, sort, options.u || options.unique, afterFactions, options['hide-stat']);
    if (options.purchase && purchaseableAugs)
        await purchaseDesiredAugs(ns, verbose);
}

function log(ns, log, alsoPrintToTerminal, toastStyle) {
    ns.print(log);
    if (alsoPrintToTerminal) ns.tprint(log);
    if (toastStyle) ns.toast(log, toastStyle);
}

// Helper function to make multi names shorter for display in a table
function shorten(mult) {
    return mult.replace("_mult", "").replace("company", "cmp").replace("faction", "fac").replace("money", "$").replace("crime", "crm")
        .replace("agility", "agi").replace("strength", "str").replace("charisma", "cha").replace("defense", "def").replace("dexterity", "dex").replace("hacking", "hack")
        .replace("hacknet_node", "hn").replace("bladeburner", "bb").replace("stamina", "stam")
        .replace("success_chance", "success").replace("success", "prob").replace("chance", "prob");
}

// Helper function to take a shortened multi name provided by the user and map it to a real multi
function unshorten(strMult) {
    if (stat_multis.includes(strMult)) return strMult + "_mult"; // They just omitted the "_mult" suffix shared by all
    if (stat_multis.includes(strMult.replace("_mult", ""))) return strMult; // It's fine as is
    let match = stat_multis.find(m => shorten(m) == strMult);
    if (find !== undefined) return match + "_mult";
    throw `The specified stat name '${strMult}' does not match any of the known stat names: ${stat_multis.join(', ')}`;
}

let factionSortOrder = (a, b) => factionSortValue(a) - factionSortValue(b);
let factionSortValue = faction => {
    let preferredIndex = factionNames.indexOf(faction.name || faction);
    return preferredIndex == -1 ? 99 : preferredIndex;
};

/** @param {NS} ns **/
async function updateFactionData(ns, allFactions, factionsToOmit) {
    factionNames = preferredFactionOrder.filter(f => !factionsToOmit.includes(f));
    // Add any player joined factions that may not be in the pre-defined list
    factionNames.push(...joinedFactions.filter(f => !factionNames.includes(f) && !factionsToOmit.includes(f)));
    // Add any factions that the player has earned an invite to
    const invitations = await getNsDataThroughFile(ns, 'ns.checkFactionInvitations()', '/Temp/player-faction-invites.txt');
    factionNames.push(...invitations.filter(f => !factionNames.includes(f) && !factionsToOmit.includes(f)));
    // If specified, get info about *all* factions in the game, not just the ones hard-coded in the preferred faction order list.
    if (allFactions)
        factionNames.push(...factions.filter(f => !factionNames.includes(f) && !factionsToOmit.includes(f)));

    let factionsDictCommand = command => `Object.fromEntries(${JSON.stringify(factionNames)}.map(faction => [faction, ${command}]))`;
    let dictFactionAugs = await getNsDataThroughFile(ns, factionsDictCommand('ns.getAugmentationsFromFaction(faction)'), '/Temp/faction-augs.txt');
    let dictFactionReps = await getNsDataThroughFile(ns, factionsDictCommand('ns.getFactionRep(faction)'), '/Temp/faction-rep.txt');
    let dictFactionFavors = await getNsDataThroughFile(ns, factionsDictCommand('ns.getFactionFavor(faction)'), '/Temp/faction-favor.txt');

    // Need information about our gang to work around a TRP bug - gang faction appears to have it available, but it's not    
    const gangFaction = await getNsDataThroughFile(ns, 'ns.gang.inGang() ? ns.gang.getGangInformation().faction : false', '/Temp/gang-faction.txt');
    if (gangFaction) dictFactionAugs[gangFaction] = dictFactionAugs[gangFaction]?.filter(a => a != "The Red Pill");

    factionData = Object.fromEntries(factionNames.map(faction => [faction, {
        name: faction,
        invited: invitations.includes(faction),
        joined: joinedFactions.includes(faction),
        reputation: dictFactionReps[faction] || 0,
        favor: dictFactionFavors[faction],
        donationsUnlocked: dictFactionFavors[faction] >= ns.getFavorToDonate() && faction !== gangFaction, // Can't donate to gang factions for rep
        augmentations: dictFactionAugs[faction],
        unownedAugmentations: function (includeNf = false) { return this.augmentations.filter(aug => !ownedAugmentations.includes(aug) && (aug != strNF || includeNf)) },
        mostExpensiveAugCost: function () { return this.augmentations.map(augName => augmentationData[augName]).reduce((max, aug) => Math.max(max, aug.price), 0) },
        totalUnownedMults: function () {
            return this.unownedAugmentations().map(augName => augmentationData[augName])
                .reduce((arr, aug) => Object.keys(aug.stats).forEach(stat => arr[stat] = ((arr[stat] || 1) * aug.stats[stat])) || arr, new Map);
        }
    }]));
}

/** @param {NS} ns **/
async function updateAugmentationData(ns, desiredStatsFilters, desiredAugs) {
    const augmentationNames = [...new Set(Object.values(factionData).flatMap(f => f.augmentations))]; // augmentations.slice();
    const augsDictCommand = command => `Object.fromEntries(${JSON.stringify(augmentationNames)}.map(aug => [aug, ${command}]))`;
    const dictAugRepReqs = await getNsDataThroughFile(ns, augsDictCommand('ns.getAugmentationRepReq(aug)'), '/Temp/aug-repreqs.txt');
    const dictAugPrices = await getNsDataThroughFile(ns, augsDictCommand('ns.getAugmentationPrice(aug)'), '/Temp/aug-prices.txt');
    const dictAugStats = await getNsDataThroughFile(ns, augsDictCommand('ns.getAugmentationStats(aug)'), '/Temp/aug-stats.txt');
    const dictAugPrereqs = await getNsDataThroughFile(ns, augsDictCommand('ns.getAugmentationPrereq(aug)'), '/Temp/aug-prereqs.txt');
    augmentationData = Object.fromEntries(augmentationNames.map(aug => [aug, {
        name: aug,
        owned: ownedAugmentations.includes(aug),
        reputation: dictAugRepReqs[aug],
        price: dictAugPrices[aug],
        stats: dictAugStats[aug],
        prereqs: dictAugPrereqs[aug] || [],
        // The best augmentations either have no stats (special effect like no Focus penalty, or Red Pill), or stats in the 'stat-desired' command line options
        desired: desiredAugs.includes(aug) || Object.keys(dictAugStats[aug]).length == 0 ||
            Object.keys(dictAugStats[aug]).some(key => desiredStatsFilters.some(filter => key.includes(filter))),
        // Get the name of the "most-early-game" faction from which we can buy this augmentation. Estimate this by cost of the most expensive aug the offer
        getFromAny: factionNames.map(f => factionData[f]).sort((a, b) => a.mostExpensiveAugCost - b.mostExpensiveAugCost)
            .filter(f => f.augmentations.includes(aug))[0]?.name ?? "(unknown)",
        // Get a list of joined factions that have this augmentation
        joinedFactionsWithAug: function () { return factionNames.map(f => factionData[f]).filter(f => f.joined && f.augmentations.includes(this.name)); },
        // Whether there is some joined faction which already has enough reputation to buy this augmentation
        canAfford: function () { return this.joinedFactionsWithAug().some(f => f.reputation >= this.reputation); },
        canAffordWithDonation: function () { return this.joinedFactionsWithAug().some(f => f.donationsUnlocked); },
        // Get the name of the **joined** faction from which we can buy this augmentation (sorted by which is closest to being able to afford it, then by most preferred)
        getFromJoined: function () {
            return (this.joinedFactionsWithAug().filter(f => f.reputation >= this.reputation)[0] ||
                this.joinedFactionsWithAug().filter(f => f.donationsUnlocked).sort((a, b) => getReqDonationForAug(this, a) - getReqDonationForAug(this, b))[0] ||
                this.joinedFactionsWithAug()[0])?.name;
        },
        toString: function () {
            const factionColWidth = 16, augColWidth = 40, statsColWidth = 60;
            const statKeys = Object.keys(this.stats);
            const statsString = `Stats:${statKeys.length.toFixed(0).padStart(2)}` + (statKeys.length == 0 ? '' : ` { ${statKeys.map(prop => shorten(prop) + ': ' + this.stats[prop]).join(', ')} }`);
            const factionName = this.getFromJoined() || this.getFromAny;
            const fCreep = Math.max(0, factionName.length - factionColWidth);
            const augNameShort = this.name.length <= (augColWidth - fCreep) ? this.name :
                `${this.name.slice(0, Math.ceil(augColWidth / 2 - 3 - fCreep))}...${this.name.slice(this.name.length - Math.floor(augColWidth / 2))}`;
            return `${this.desired ? '*' : ' '} ${this.canAfford() ? '✓' : this.canAffordWithDonation() ? '$' : '✗'} Price: ${formatMoney(this.price, 4).padEnd(7)}  ` +
                `Rep: ${formatNumberShort(this.reputation, 4)}  Faction: ${factionName.padEnd(factionColWidth)}  Aug: ${augNameShort.padEnd(augColWidth - fCreep)}` +
                `  ${statsString.length <= statsColWidth ? statsString : (statsString.substring(0, statsColWidth - 4) + '... }')}`;
        }
    }]));
    // Propagate desired status to any dependencies of desired augs. Note when --all-factions mode is not enabled, it's possible some prereqs are not in our list
    let propagateDesired = aug => !aug.desired || !aug.prereqs ? null :
        aug.prereqs.forEach(p => { let pa = augmentationData[p]; if (!pa) return; pa.desired = true; propagateDesired(pa); });
    Object.values(augmentationData).forEach(a => propagateDesired(a));
    allAugStats = Object.values(augmentationData).flatMap(aug => Object.keys(aug.stats)).filter((v, i, a) => a.indexOf(v) === i).sort();
}

/** @param {NS} ns **/
async function joinFactions(ns) {
    let manualJoin = ["Sector-12", "Chongqing", "New Tokyo", "Ishima", "Aevum", "Volhaven"];
    // If we have already joined one of the "precluding" factions, we are free to join the remainder
    if (joinedFactions.some(f => manualJoin.includes(f)))
        manualJoin = [];
    // Collect the set of augmentations we already have access to given the factions we've joined
    const accessibleAugmentations = new Set(joinedFactions.flatMap(fac => factionData[fac]?.augmentations ?? []));
    log(ns, `${accessibleAugmentations.size} augmentations are already accessible from our ${joinedFactions.length} joined factions.`);
    // Check for faction invitations
    const invitations = Object.values(factionData).filter(f => f.invited);
    log(ns, `Outstanding invitations from ${invitations.length} factions: ${JSON.stringify(invitations.map(f => f.name))}`);
    // Join all factions with remaining augmentations we care about
    for (const faction of invitations.sort(factionSortOrder)) {
        let unownedAugs = faction.unownedAugmentations(true); // Filter out augmentations we've already purchased
        let newAugs = unownedAugs.filter(aug => !accessibleAugmentations.has(aug)); //  Filter out augmentations we can purchase from another faction we've already joined
        let desiredAugs = newAugs.filter(aug => augmentationData[aug].desired); //  Filter out augmentations we have no interest in
        log(ns, `${faction.name} has ${faction.augmentations.length} augs, ${unownedAugs.length} unowned, ${newAugs.length} not offered by joined factions, ` +
            `${desiredAugs.length} with desirable stats` + (desiredAugs.length == 0 ? ' (not joining)' : `: ${JSON.stringify(desiredAugs)}`));
        if (desiredAugs.length == 0 && !options['force-join'].includes(faction.name)) continue;
        if (manualJoin.includes(faction.name) && !options['force-join'].includes(faction.name))
            log(ns, `Faction ${faction.name} must be manually joined.`);
        else {
            log(ns, `Joining faction ${faction.name} which has ${desiredAugs.length} desired augmentations: ${desiredAugs}`);
            let response;
            if (response = await getNsDataThroughFile(ns, `ns.joinFaction('${faction.name}')`, '/Temp/join-faction.txt')) {
                faction.joined = true;
                faction.augmentations.forEach(aug => accessibleAugmentations.add(aug));
                joinedFactions.push(faction.name);
                log(ns, `Joined faction ${faction.name} (Response: ${response})`, true, 'success')
            } else
                log(ns, `Error joining faction ${faction.name}. Response: ${response}`, false, 'error')
        }
    }
}

/** Compute how much money must be donated to the faction to afford an augmentation. Faction can be either a faction object, or faction name */
let getReqDonationForRep = (rep, faction) => Math.ceil(1e6 * (Math.max(0, rep - (faction.name ? faction : factionData[faction]).reputation)) / (playerData.faction_rep_mult));
let getReqDonationForAug = (aug, faction) => getReqDonationForRep(aug.reputation, faction);

let getTotalCost = (augPurchaseOrder) => augPurchaseOrder.reduce((total, aug, i) => total + aug.price * augCountMult ** i, 0);

let augSortOrder = (a, b) => (b.price - a.price) || (b.reputation - a.reputation) ||
    (b.desired != a.desired ? (a.desired ? -1 : 1) : a.name.localeCompare(b.name));

// Sort augmentations such that they are in order of price, except when there are prerequisites to worry about
function sortAugs(ns, augs = []) {
    augs.sort(augSortOrder);
    // Bubble up prerequisites to the top
    for (let i = 0; i < augs.length; i++) {
        for (let j = 0; j < augs[i].prereqs.length; j++) {
            const prereqIndex = augs.findIndex(a => a.name == augs[i].prereqs[j]);
            if (prereqIndex === -1 /* Already bought */ || prereqIndex < i /* Already sorted up */) continue;
            augs.splice(i, 0, augs.splice(prereqIndex, 1)[0]);
            i -= 1; // Back up i so that we revisit the prerequisites' own prerequisites
            break;
        }
    }
    // Since we are no longer most-expensive to least-expensive, the "ideal purchase order" is more complicated.
    // So now see if moving each chunk of prereqs down a slot reduces the overall price.
    let initialCost = getTotalCost(augs);
    let totalMoves = 0;
    for (let i = augs.length - 1; i > 0; i--) {
        let batchLengh = 1; // Look for a "batch" of prerequisites, evidenced by augs above this one being cheaper instead of more expensive
        while (i - batchLengh >= 0 && augs[i].price > augs[i - batchLengh].price) batchLengh++;
        if (batchLengh == 1) continue; // Not the start of a batch of prerequisites
        log(ns, `Detected a batch of length ${batchLengh} from ${augs[i - batchLengh + 1].name} to ${augs[i].name}`);
        let moved = 0, bestCost = initialCost;
        while (i + moved + 1 < augs.length) { // See if promoting augs from below the batch to above the batch reduces the overall cost
            let testOrder = augs.slice(), moveIndex = i + moved + 1, insertionIndex = i - batchLengh + 1 + moved;
            testOrder.splice(insertionIndex, 0, testOrder.splice(moveIndex, 1)[0]); // Try moving it above the batch
            let newCost = getTotalCost(testOrder);
            //log(ns, `Cost would change by ${((newCost - bestCost) / bestCost * 100).toPrecision(2)}% from ${formatMoney(bestCost)} to ${formatMoney(newCost)} by buying ${augs[moveIndex].name} before ${augs[insertionIndex].name}`);
            if (bestCost < newCost) break; // If the cost is worse or the same, stop shifting augs
            //log(ns, `Cost reduced by ${formatMoney(bestCost - newCost)} from ${formatMoney(bestCost)} to ${formatMoney(newCost)} by buying ${augs[moveIndex].name} before ${augs[insertionIndex].name}`);
            bestCost = newCost;
            augs.splice(insertionIndex, 0, augs.splice(moveIndex, 1)[0]); // Found a cheaper sort order - lock in the move!
            moved++;
        }
        i = i - batchLengh + 1; // Decrement i to past the batch so it doesn't try to change the batch's own order
        totalMoves += moved;
    }
    let finalCost = getTotalCost(augs);
    if (totalMoves > 0) log(ns, `Cost reduced by ${formatMoney(initialCost - finalCost)} (from ${formatMoney(initialCost)} to ${formatMoney(finalCost)}) by bubbling ${totalMoves} augs up above batches of dependencies.`);
    return augs;
}

/** @param {NS} ns 
 * Display all information about all augmentations, including lists of available / desired / affordable augmentations in their optimal purchase order.  */
async function manageUnownedAugmentations(ns, ignoredAugs, alsoPrintToTerminal) {
    const outputRows = [`Currently have ${ownedAugmentations.length}/30 Augmentations required for Daedalus.`];
    const unownedAugs = Object.values(augmentationData).filter(aug => (!aug.owned || aug.name == strNF) && !ignoredAugs.includes(aug.name));
    if (unownedAugs.length == 0) return log(ns, `All ${Object.keys(augmentationData).length} augmentations are either owned or ignored!`, alsoPrintToTerminal)
    let unavailableAugs = unownedAugs.filter(aug => aug.getFromJoined() == null);
    let firstListPrinted = unavailableAugs.length > 0;
    if (firstListPrinted) await manageFilteredSubset(ns, outputRows, 'Unavailable', unavailableAugs, true);
    // We use the return value to "lock in" the new sort order. Going forward, the routine will only re-print the aug list if the sort order changes (or forcePrint == true)
    let availableAugs = await manageFilteredSubset(ns, outputRows, 'Available', unownedAugs.filter(aug => aug.getFromJoined() != null), firstListPrinted ? undefined : true);
    if (availableAugs?.length > 0) {
        let augsWithRep = availableAugs.filter(aug => aug.canAfford() || (aug.canAffordWithDonation() && !options['disable-donations']));
        let desiredAugs = availableAugs.filter(aug => aug.desired);
        if (augsWithRep.length > desiredAugs.length) {
            augsWithRep = await manageFilteredSubset(ns, outputRows, 'Within Rep', augsWithRep)
            desiredAugs = await manageFilteredSubset(ns, outputRows, 'Desired', desiredAugs);
        } else {
            desiredAugs = await manageFilteredSubset(ns, outputRows, 'Desired', desiredAugs);
            augsWithRep = await manageFilteredSubset(ns, outputRows, 'Within Rep', augsWithRep);
        }
        await manageFilteredSubset(ns, outputRows, 'Desired Within Rep', augsWithRep.filter(aug => aug.desired), undefined, true);
    }
    // Print all rows of output that were prepped
    log(ns, outputRows.join("\n  "), alsoPrintToTerminal);
}

/** @param {NS} ns 
 * Helper to generate outputs for different subsets of the augmentations, each in optimal sort order */
async function manageFilteredSubset(ns, outputRows, subsetName, subset, printList = undefined /* undefined => automatically print if sort order changed */, purchaseable = false) {
    subset = subset.slice(); // Take a copy so we don't mess up the original array sent in.
    let subsetLength = subset.length;
    if (subsetLength == 0) return subset;
    // Remove augs that cannot be purchased because their prerequisites are not owned and have been filtered out
    do {
        subsetLength = subset.length
        for (const aug of subset.slice())
            if (aug.prereqs.length > 0 && aug.prereqs.some(prereq => !(ownedAugmentations.includes(prereq) || subset.some(a => a.name === prereq))))
                subset.splice(subset.indexOf(aug), 1);
    } while (subsetLength !== subset.length);
    // Sort the filtered subset into its optimal purchase order
    let subsetSorted = sortAugs(ns, subset.slice());
    let repCostByFaction = computeAugsRepReqDonationByFaction(ns, subsetSorted);
    // Compute the total rep cost for augmentations, including the cost of donating for access
    let totalRepCost = Object.values(repCostByFaction).reduce((t, r) => t + r, 0);
    let totalAugCost = getTotalCost(subsetSorted);
    if (printList === true || printList === undefined && !subset.every((v, i) => v == subsetSorted[i])) // If the purchase order is unchanged after filtering out augmentations, don't bother reprinting the full list
        outputRows.push(`${subset.length} ${subsetName} Augmentations in Optimized Purchase Order (*'s are desired augs and/or stats: ${options['stat-desired'].join(", ")}):\n  ${subsetSorted.join('\n  ')}`);
    outputRows.push(`Total Cost of ${subset.length} ${subsetName}:`.padEnd(37) + ` ${formatMoney(totalRepCost + totalAugCost)}` +
        (totalRepCost == 0 ? '' : ` (Augs: ${formatMoney(totalAugCost)} + Rep: ${formatMoney(totalRepCost)})  Donate: ${JSON.stringify(repCostByFaction).replaceAll(",", ", ")}`));
    if (!purchaseable) return subsetSorted; // The remainder of the logic only applies if we are preparing a purchase order

    // Hack: Set globals that will be purchased by another method as a final action in the main method
    purchaseableAugs = subsetSorted.slice();
    purchaseFactionDonations = repCostByFaction;
    // Ensure we can afford the purchase order
    if (totalAugCost + totalRepCost <= playerData.money && options['neuroflux-disabled']) return subsetSorted;
    // Remove the most expensive augmentation until we can afford all that remain
    const dropped = [];
    while (totalAugCost + totalRepCost > playerData.money) {
        const mostExpensiveAug = purchaseableAugs.slice().sort((a, b) => b.price - a.price)[0];
        let costBefore = `${formatMoney(totalRepCost + totalAugCost)} (Augs: ${formatMoney(totalAugCost)} + Rep: ${formatMoney(totalRepCost)})`;
        purchaseableAugs = sortAugs(ns, purchaseableAugs.filter(aug => aug !== mostExpensiveAug));
        purchaseFactionDonations = computeAugsRepReqDonationByFaction(ns, purchaseableAugs);
        totalRepCost = Object.values(purchaseFactionDonations).reduce((t, r) => t + r, 0);
        totalAugCost = getTotalCost(purchaseableAugs);
        let costAfter = `${formatMoney(totalRepCost + totalAugCost)} (Augs: ${formatMoney(totalAugCost)} + Rep: ${formatMoney(totalRepCost)})`;
        dropped.unshift({ aug: mostExpensiveAug, costBefore, costAfter });
        let dropLog = `Dropping aug from the purchase order: \"${mostExpensiveAug.name}\". New total cost: ${costAfter}`;
        log(ns, dropLog);
    }
    // Recursively call this method one time to display the reduced list of affordable purchases as a separate section
    manageFilteredSubset(ns, outputRows, 'Affordable', purchaseableAugs, purchaseableAugs.length < subset.length);
    // Let us know how far away we are from being able to get just one more aug:
    if (dropped.length > 0)
        outputRows.push(`Insufficient funds: had to drop ${dropped.length} augs. Next aug \"${dropped[0].aug.name}\" at: ${dropped[0].costBefore}`);
    // Maybe add a bunch of NeuroFlux levels to our purchase?
    if (!options['neuroflux-disabled']) {
        const augNf = augmentationData[strNF];
        // Arrange to purchase NF from the faction with the most reputation, to reduce the chance of having insufficient rep for higher levels TODO: Compute rep / faction donation requirements for these NF levels
        augNf.getFromJoined = function () { return this.joinedFactionsWithAug().sort((a, b) => b.reputation - a.reputation)[0]?.name };
        if (!augNf.canAfford() && !augNf.canAffordWithDonation()) {
            const getFrom = augNf.getFromJoined();
            outputRows.push(`Cannot purchase any ${strNF} because the next level requires ${formatNumberShort(augNf.reputation)} reputation, but ` +
                (!getFrom ? `it isn't being offered by any of our factions` : `the best faction (${getFrom}) has insufficient rep (${formatNumberShort(factionData[getFrom].reputation)}).`));
            const factionsWithAug = Object.values(factionData).filter(f => f.augmentations.includes(augNf.name)).sort((a, b) => b.favor - a.favor);
            const factionsWithAugAndInvite = factionsWithAug.filter(f => f.invited || f.joined).sort((a, b) => b.favor - a.favor);
            const factionWithMostFavor = factionsWithAugAndInvite[0] ?? factionsWithAug[0];
            if (getFrom != factionsWithAug[0].name && factionsWithAug[0] != factionsWithAugAndInvite[0])
                outputRows.push(`SUGGESTION: Earn an invitation to faction ${factionsWithAug[0].name} to make it easier to get rep for ${strNF} since it has the most favor (${factionsWithAug[0].favor}).`);
            else if (factionsWithAug[0].joined && !factionsWithAug[0].donationsUnlocked)
                outputRows.push(`SUGGESTION: Do some work for faction ${factionsWithAug[0].name} to qickly earn rep for ${strNF} since it has the most favor (${factionsWithAug[0].favor}).`);
            else if ((!getFrom || factionData[getFrom].favor < factionWithMostFavor.favor) && factionWithMostFavor.invited) {
                outputRows.push(`Attempting to join faction ${factionWithMostFavor.name} to make it easier to get rep for ${strNF} since it has the most favor (${factionWithMostFavor.favor}).`);
                options['force-join'].push(factionWithMostFavor.name);
                await joinFactions(ns);
                if (joinedFactions.includes(factionWithMostFavor.name) && factionWithMostFavor.donationsUnlocked)
                    augNf.getFromJoined = () => factionWithMostFavor.name;
            }
            if (!(joinedFactions.includes(factionWithMostFavor.name) && factionWithMostFavor.donationsUnlocked))
                return subsetSorted;
        }
        let nfPurchased = purchaseableAugs.filter(a => a.name === augNf.name).length;
        const augNfFaction = factionData[augNf.getFromJoined()];
        log(ns, `nfPurchased: ${nfPurchased}, augNfFaction: ${augNfFaction.name} (rep: ${augNfFaction.reputation}), augNf.price: ${augNf.price}, augNf.reputation: ${augNf.reputation}`);
        while (nfPurchased < 50) {
            const nextNfCost = augNf.price * (augCountMult ** purchaseableAugs.length) * (nfCountMult ** nfPurchased);
            const nextNfRep = augNf.reputation * (nfCountMult ** nfPurchased);
            let nfMsg = `Cost of NF ${nfPurchased + 1} is ${formatMoney(nextNfCost)} and will require ${formatNumberShort(nextNfRep)} reputation`
            if (totalAugCost + totalRepCost + nextNfCost > playerData.money) break;
            purchaseableAugs.push(augNf);
            totalAugCost += nextNfCost;
            if (nextNfRep > augNfFaction.reputation) {
                if (augNfFaction.donationsUnlocked) {
                    purchaseFactionDonations[augNfFaction.name] = Math.max(purchaseFactionDonations[augNfFaction.name] || 0, getReqDonationForRep(nextNfRep, augNfFaction));
                    totalRepCost = Object.values(purchaseFactionDonations).reduce((t, r) => t + r, 0);
                    nfMsg += `, which will require a donation of ${formatMoney(purchaseFactionDonations[augNfFaction.name])} to faction ${augNfFaction.name}`
                } else {
                    outputRows.push(nfMsg + `, but we only have ${formatNumberShort(augNfFaction.reputation)} reputation with faction ${augNfFaction.name}!`);
                    break;
                }
            } else
                nfMsg += ` (✓ have ${formatNumberShort(augNfFaction.reputation)} rep with faction ${augNfFaction.name})`
            log(ns, nfMsg);
            nfPurchased++;
        }
        log(ns, `Can afford to purchase ${nfPurchased} levels of ${strNF}. New total cost: ${formatMoney(totalRepCost + totalAugCost)}` +
            (totalRepCost == 0 ? '' : ` (Augs: ${formatMoney(totalAugCost)} + Rep: ${formatMoney(totalRepCost)})`));
        outputRows.push(`Total Cost of ${purchaseableAugs.length} (with +${nfPurchased} NF):`.padEnd(37) + ` ${formatMoney(totalRepCost + totalAugCost)}` +
            (totalRepCost == 0 ? '' : ` (Augs: ${formatMoney(totalAugCost)} + Rep: ${formatMoney(totalRepCost)})  Donate: ${JSON.stringify(repCostByFaction).replaceAll(",", ", ")}`));
    }
    return subsetSorted;
};

/** @param {NS} ns 
 * Find out the optimal set of factions and rep-donations required to access them */
function computeAugsRepReqDonationByFaction(ns, augmentations) {
    const repCostByFaction = {};
    for (const aug of augmentations) {
        let faction = factionData[aug.getFromJoined() || aug.getFromAny];
        if (!faction.donationsUnlocked) continue; // getFromJoined() already ensures that we don't resort to faction requiring donations unless we must (and can)
        let reqDonation = getReqDonationForAug(aug, faction);
        // See if any other faction we're already planning to donate to offers the same augmentation, so we can avoid donating to multiple factions
        // Use the alternative faction if we're already planning on donating this much to them, or if they're closer to the donation requirement than this faction currently is
        let fDonationsIndex = Object.keys(repCostByFaction).findIndex(f => f == faction.name);
        let alternativeFaction = Object.keys(repCostByFaction).find((f, i) => f != faction.name && factionData[f].augmentations.includes(aug.name) && (
            (repCostByFaction[f] >= reqDonation && (fDonationsIndex == -1 || i < fDonationsIndex)) || // We're donating the same or more to the other faction, and were planning on donating to it before this one
            ((getReqDonationForAug(aug, f) - repCostByFaction[f]) < (reqDonation - (repCostByFaction[faction.name] || 0))))); // The amount we've committed to donating the other faction is closer to this requirement
        if (alternativeFaction) {
            log(ns, `Using alternative faction "${alternativeFaction}" for "${aug.name}" rather than earlier faction "${faction.name}"`)
            aug.getFromJoined = () => alternativeFaction;
            reqDonation = getReqDonationForAug(aug, alternativeFaction);
            faction = factionData[alternativeFaction];
        }
        if (reqDonation > 0)
            repCostByFaction[faction.name] = Math.max(repCostByFaction[faction.name] || 0, reqDonation);
    }
    return repCostByFaction;
}

/** @param {NS} ns 
 * Donate any required rep and purchase the desired augmentations */
async function purchaseDesiredAugs(ns, verbose) {
    let totalRepCost = Object.values(purchaseFactionDonations).reduce((t, r) => t + r, 0);
    let totalAugCost = getTotalCost(purchaseableAugs);
    let money = (await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt')).money;
    if (totalAugCost + totalRepCost > money)
        return log(ns, `ERROR: Purchase order total cost (${formatMoney(totalRepCost + totalAugCost)}` + (totalRepCost == 0 ? '' : ` (Augs: ${formatMoney(totalAugCost)} + Rep: ${formatMoney(totalRepCost)}))`) +
            ` is more than current player money (${formatMoney(money)}).`, verbose, 'error')
    // Donate to factions if necessary (using a ram-dodging script of course)
    if (Object.keys(purchaseFactionDonations).length > 0 && Object.values(purchaseFactionDonations).some(v => v > 0)) {
        if (await getNsDataThroughFile(ns, JSON.stringify(Object.keys(purchaseFactionDonations).map(f => ({ faction: f, repDonation: purchaseFactionDonations[f] }))) +
            '.reduce((success, o) => success && ns.donateToFaction(o.faction, o.repDonation), true)', '/Temp/facman-donate.txt'))
            log(ns, `SUCCESS: Donated to ${Object.keys(purchaseFactionDonations).length} factions to gain access to desired augmentations.`, verbose, 'success')
        else
            log(ns, `ERROR: One or more attempts to donate to factions for reputation failed. Go investigate!`, verbose, 'error');
    }
    // Purchase desired augs (using a ram-dodging script of course)
    if (purchaseableAugs.length == 0)
        log(ns, `INFO: Cannot afford to buy any augmentations at this time.`, verbose)
    else if (await getNsDataThroughFile(ns, JSON.stringify(purchaseableAugs.map(aug => ({ faction: aug.getFromJoined(), augmentation: aug.name }))) +
        '.reduce((success, o) => ns.purchaseAugmentation(o.faction, o.augmentation) && success, true)', '/Temp/facman-purchase-augs.txt'))
        log(ns, `SUCCESS: Purchased ${purchaseableAugs.length} desired augmentations in optimal order!`, verbose, 'success')
    else
        log(ns, `ERROR: Failed to purchase one or more augmentations.`, verbose, 'error');
}

/** @param {NS} ns **/
function displayJoinedFactionSummary(ns, alsoPrintToTerminal) {
    let joinedFactions = Object.values(factionData).filter(f => f.joined);
    let summary = `${joinedFactions.length} Joined Factions:`
    let noaugs = joinedFactions.filter(f => f.unownedAugmentations().length == 0)
    if (noaugs.length > 0)
        summary += `\n  ${noaugs.length} joined factions have no unowned augs remaining: "${noaugs.map(f => f.name).join('", "')}"`;
    for (const faction of joinedFactions.filter(f => !noaugs.includes(f)))
        summary += `\n  ${faction.name}: ${faction.unownedAugmentations().length} augs remaining (${faction.unownedAugmentations().join(", ")})`;
    log(ns, summary, alsoPrintToTerminal);
}

/** @param {NS} ns **/
function displayFactionSummary(ns, alsoPrintToTerminal, sortBy, unique, overrideFinishedFactions, excludedStats) {
    let noAugs = Object.values(factionData).filter(f => f.unownedAugmentations().length == 0);
    if (noAugs.length > 0)
        log(ns, `${noAugs.length} factions have no augmentations to purchase (excluding NF): ${JSON.stringify(noAugs.map(a => a.name))}`, alsoPrintToTerminal);
    let summaryFactions = Object.values(factionData).filter(f => f.unownedAugmentations().length > 0 && !overrideFinishedFactions.includes(f.name));
    if (summaryFactions.length == 0) return;
    // Apply any override faction options
    joinedFactions.push(...overrideFinishedFactions.filter(f => !joinedFactions.includes(f)));
    for (const faction of overrideFinishedFactions)
        ownedAugmentations.push(...factionData[faction].unownedAugmentations());
    // Grab disctinct augmentations stats 
    const relevantAugStats = allAugStats.filter(s => !excludedStats.find(excl => s.includes(excl)) &&
        undefined !== summaryFactions.find(f => f.unownedAugmentations().find(aug => 1 != (augmentationData[aug].stats[s] || 1))));
    let summary = `${summaryFactions.length} factions with augmentations (sorted by total ${sortBy}):`;
    // Creates the table header row
    let getHeaderRow = countName => `\n   Faction Name ${countName.padStart(9)} / Total Augs ` + relevantAugStats.map(key => shorten(key).padStart(4)).join(' ');
    // Creates the string to display a single faction's stats in the table
    let getFactionSummary = faction => {
        const totalMults = faction.totalUnownedMults();
        return `\n ${faction.joined ? '✓' : faction.invited ? '✉' : '✗'} ${faction.name} `.padEnd(32) + // TODO: Display faction rep / max aug rep
            `${String(faction.unownedAugmentations().length).padStart(2)} / ${String(faction.augmentations.length).padEnd(2)} ` +
            relevantAugStats.map(key => (totalMults[key] === undefined ? '-' : totalMults[key].toPrecision(3)).padStart(Math.max(shorten(key).length, 4))).join(' ');
    };
    // Helper to sort the factions in order of most-contributing to the desired multiplier
    let sortFunction = (a, b) => {
        let aMultiContrib = a.totalUnownedMults()[sortBy] || 1, bMultiContrib = b.totalUnownedMults()[sortBy] || 1;
        let sort1 = bMultiContrib - aMultiContrib; // Sort by the total amount of desired multi provided by this faction
        let sort2 = (a.joined ? 0 : 1) - (b.joined ? 0 : 1); // If tied, sort by which faction we've joined
        if (unique && bMultiContrib > 1 && aMultiContrib > 1 && sort2 != 0) return sort2; // When in "unique" mode it's important to first list contributing factions we've already joined
        if (sort1 != 0) return sort1;
        if (sort2 != 0) return sort2;
        let sort3 = b.reputation - a.reputation; // If tied, sort by which faction we have the most rep with
        if (sort3 != 0) return sort3;
        let sort4 = a.mostExpensiveAugCost().length - b.mostExpensiveAugCost().length; // If tied, "soonest to unlock", estimated by their most expensive aug cost
        if (sort4 != 0) return sort4;
        return (a.name).localeCompare(b.name) // If still tied, sort by naeme
    };
    // Helper to insert a table separator between factions that do and don't contribute to the specified stat
    let moreContributors = true;
    let getSeparator = faction => (moreContributors && !(moreContributors = faction.totalUnownedMults()[sortBy] !== undefined)) ?
        `\n---------------------------  (Factions below offer no augs that contribute to '${sortBy}')` : '';
    summary += getHeaderRow(unique ? 'New' : 'Unowned');
    if (!unique) // Each faction is summarized based on all the unowned augs it has, regardless of whether a faction higher up the list has the same augs
        for (const faction of summaryFactions.sort(sortFunction))
            summary += getSeparator(faction) + getFactionSummary(faction);
    else { // Each faction's stats computed as though the faction sorted above it was joined and bought out first, so only showing new augs
        const actualOwnedAugs = ownedAugmentations;
        const actualUnjoinedFactions = summaryFactions;
        do {
            summaryFactions.sort(sortFunction);
            const faction = summaryFactions.shift();
            summary += getSeparator(faction) + getFactionSummary(faction);
            joinedFactions.push(faction.name);  // Simulate that we've now joined and bought out all this factions augs
            ownedAugmentations.push(...faction.unownedAugmentations())
        } while (summaryFactions.length > 0)
        ownedAugmentations = actualOwnedAugs; // Restore the original lists once the simulation is complete
        summaryFactions = actualUnjoinedFactions;
    }
    log(ns, summary, alsoPrintToTerminal);
}