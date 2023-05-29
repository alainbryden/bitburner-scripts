import {
	log,
	getConfiguration,
	instanceCount,
	formatMoney,
	parseShortNumber,
	formatNumberShort,
	tryGetBitNodeMultipliers,
	getStocksValue,
	getNsDataThroughFile,
	getFilePath,
	waitForProcessToComplete,
	autoRetry,
	runCommand,
} from "./helpers";

// Global config
const default_priority_augs = ["The Red Pill", "The Blade's Simulacrum", "Neuroreceptor Management Implant"],
	strNF = "NeuroFlux Governor",
	factions = [
		"Illuminati",
		"Daedalus",
		"The Covenant",
		"ECorp",
		"MegaCorp",
		"Bachman & Associates",
		"Blade Industries",
		"NWO",
		"Clarke Incorporated",
		"OmniTek Incorporated",
		"Four Sigma",
		"KuaiGong International",
		"Fulcrum Secret Technologies",
		"BitRunners",
		"The Black Hand",
		"NiteSec",
		"Aevum",
		"Chongqing",
		"Ishima",
		"New Tokyo",
		"Sector-12",
		"Volhaven",
		"Speakers for the Dead",
		"The Dark Army",
		"The Syndicate",
		"Silhouette",
		"Tetrads",
		"Slum Snakes",
		"Netburners",
		"Tian Di Hui",
		"CyberSec",
	],
	specialFaction = ["Bladeburners", "Shadows of Anarchy", "Church of the Machine God"],
	companies = [
		"AeroCorp",
		"Bachman & Associates",
		"Clarke Incorporated",
		"ECorp",
		"Fulcrum Technologies",
		"Galactic Cybersystems",
		"NetLink Technologies",
		"Aevum Police Headquarters",
		"Rho Construction",
		"Watchdog Security",
		"KuaiGong International",
		"Solaris Space Systems",
		"Nova Medical",
		"Omega Software",
		"Storm Technologies",
		"DefComm",
		"Global Pharmaceuticals",
		"Noodle Bar",
		"VitaLife",
		"Alpha Enterprises",
		"Blade Industries",
		"Carmichael Security",
		"DeltaOne",
		"Four Sigma",
		"Icarus Microsystems",
		"MegaCorp",
		"Universal Energy",
		"CompuTek",
		"Helios Labs",
		"LexoCorp",
		"OmniTek Incorporated",
		"Omnia Cybersystems",
		"SysCore Securities",
	],
	output_file = "/Temp/infiltrator.txt",
	ignoreTarget = ["NWO", "Joe's Guns"];

// Global State
let wnd,
	doc,
	btnSaveGame,
	verbose,
	desiredStatsFilters = [],
	desiredAugs,
	dictFactionAugs,
	augmentationData = {},
	factionData = {},
	favorToDonate = null,
	gangFaction = null,
	player = null,
	infiltrationStack = [],
	locations = [],
	options = null; // The options used at construction time

const argsSchema = [
	// The set of all command line arguments
	["info", false], // get info in output_file: /Temp/infiltrator.txt
	["boost-Faction", ""], // boost one Faction
	["ignore-Faction", []], // ignored Faction will not boosted
	["target", ""], // use only this target
	["max-loop", 15], // Max Loops per Faction
	["sleep-Between-Infiltration-Time", 5000], // Sleep between Infiltration
	["getMoney", undefined], // Use this to boost Player Money
	["stock", true], // Use Stockvalue for getMoney
	["verbose", false], // Print Output to terminal
];

/**
 * @param data
 * @param args
 * @returns An array of strings.
 */
export function autocomplete(data, args) {
	data.flags(argsSchema);
	const lastFlag = args.length > 1 ? args[args.length - 2] : null;
	if (["--boost-Faction"].includes(lastFlag)) return factions.map((f) => f.replaceAll(" ", "_"));
	if (["--ignore-Faction"].includes(lastFlag)) return factions.map((f) => f.replaceAll(" ", "_"));
	if (["--target"].includes(lastFlag)) return companies.map((f) => f.replaceAll(" ", "_"));
	return [];
}

/** @param {NS} ns  */
export async function main(ns) {
	augmentationData = {};
	const runOptions = getConfiguration(ns, argsSchema);
	if (!runOptions || (await instanceCount(ns)) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
	options = runOptions; // We don't set the global "options" until we're sure this is the only running instance

	const args = ns.flags(argsSchema);
	const boostFaction = options["boost-Faction"] ? args["boost-Faction"].replaceAll("_", " ") : "";
	const ignoreFaction = options["ignore-Faction"].length > 0 ? args["ignore-Faction"].map((f) => f.replaceAll("_", " ")) : [];
	const forceTarget = options["target"] ? args.target.replaceAll("_", " ") : "";

	verbose = options["verbose"];

	if (!options["info"]) ns.tail();

	wnd = eval("window");
	doc = wnd["document"];
	btnSaveGame = await findRetry(ns, "//button[@aria-label = 'save game']");
	if (!btnSaveGame) return log(ns, 'ERROR: Sorry, couldn\'t find the Overview Save (💾) button. Is your "Overview" panel collapsed or modded?', verbose);

	if (!wnd.tmrAutoInf && !options["info"]) {
		let iargs = ["--start"];
		if (!verbose) iargs.push("--quiet");
		let pid = launchScriptHelper(ns, "infiltrate.js", iargs);
		if (pid) await waitForProcessToComplete(ns, pid);
		//close tail opened at launchScriptHelper
		ns.closeTail()
	}

	const bnMults = await tryGetBitNodeMultipliers(ns);
	const wks = await hasSoaAug(ns);

	log(ns, `Infiltration multipliers: ${bnMults?.InfiltrationRep}× rep, ${bnMults?.InfiltrationMoney}× money`, verbose);
	log(ns, `WKS harmonizer aug: ${wks ? "yes" : "no"}`, verbose);

	player = await getPlayerInfo(ns);
	locations = await getLocations(ns, verbose);
	if (verbose) console.log(locations);

	infiltrationStack = [];

	if (options["info"]) {
		await buildInfiltrationStack(ns, ignoreFaction, boostFaction, forceTarget);
		if (infiltrationStack.length == 0) {
			ns.write(output_file, "", "w");
		} else {
			ns.write(output_file, JSON.stringify(infiltrationStack), "w");
		}
		return;
	}

	if (!options["getMoney"] && !(options["getMoney"] === "")) {
		await buildInfiltrationStack(ns, ignoreFaction, boostFaction, forceTarget);
		if (infiltrationStack.length == 0) return log(ns, "No Factions need Reputation", verbose);
		if (options["info"]) return;
		for (const stack of infiltrationStack) {
			await infiltrateForFaction(ns, stack);
			if (ns.read("/Temp/stopInfiltration.txt")) return
		}
	} else {
		let maxMoney = options["getMoney"] == "" ? 1e39 : parseShortNumber(options["getMoney"]);
		let stock = options["stock"];
		await infiltrateForMoney(ns, player, maxMoney, forceTarget, stock);
	}
	//close our window so we don't clutter everything, but give the player time to read it
	runCommand(ns,"await ns.sleep(10000);ns.closeTail("+ns.pid+")")
}

/**
 * It will infiltrate the target location until the faction's reputation is at the highest reputation
 * augmentation
 * @param {NS} ns
 * @param {Array<string>} stack - This is the target Stack that we'll be using to infiltrate.
 * @returns {Promise<void>}
 */
async function infiltrateForFaction(ns, stack) {
	let loop = 1;
	let highestRepAug = stack.reputation;
	let currentReputation = await getFactionReputation(ns, stack.faction);
	while (currentReputation < highestRepAug) {
		if (loop > options["max-loop"]) return log(ns, "maximum loops reached");
		if (ns.read("/Temp/stopInfiltration.txt")) return

		ns.tail();
		if (options["sleep-Between-Infiltration-Time"]) await ns.sleep(options["sleep-Between-Infiltration-Time"]);

		player = await getPlayerInfo(ns);

		let city = player.city == stack.target.city ? false : stack.target.city;
		if (city && player.money < 2e5) {
			let cityMax = Math.min(...locations.filter((location) => location.city == player.city && location.reward.sellCash > 2e5).map((location) => location.reward.sellCash));
			let cityTarget = locations.filter((location) => location.reward.sellCash === cityMax)[0];
			log(ns, `Player money is too low (${formatMoney(player.money, 6, 1)}), will Infiltrate 1x ${cityTarget.name}`);
			await infiltrateForMoney(ns, player, 2e5, cityTarget, false);
			continue;
		}

		log(ns, `Infiltrating ${stack.target.name} at loop ${loop} to push ${stack.faction}´s Reputation`);
		if (await infiltrate(ns, city, stack.target.name, stack.faction)) {
			loop++;
			stack.loop--;
		}

		await click(btnSaveGame); // Save if we won
		await ns.sleep(10);

		currentReputation = await getFactionReputation(ns, stack.faction);

		if (stack.loop < 1) {
			break;
		}
	}
}

/**
 * It will infiltrate the location with the highest moneyScore until the player has at least maxMoney
 * @param {NS} ns
 * @param {Player} player
 * @param {number} maxMoney - The maximum amount of money you want to have.
 * @param {{name, city, moneyGain, moneyScore} | undefined} [target] - If you want to force a specific target, put it here.
 * @param {boolean} [stock] - If true, the script will take into account the value of your stocks when calculating how much money you have.
 * @returns {Promise<void>}
 */
async function infiltrateForMoney(ns, player, maxMoney, target, stock = true) {
	let faction = "none";
	let loop = 1;
	let currentMoney = player.money + (stock ? await getStocksValue(ns) : 0);
	let moneyNeed = maxMoney - currentMoney;
	if (moneyNeed < 0) return log(ns, "Max Money < current Money");

	if (!target) {
		let locationsfiltered = locations.filter((location) => location.reward.sellCash > moneyNeed);
		if (locationsfiltered.length > 0) {
			let min = Math.min(...locationsfiltered.map((location) => location.reward.sellCash));
			target = locations.filter((location) => location.reward.sellCash === min)[0];
		} else {
			let max = Math.max(...locations.map((location) => location.reward.moneyScore));
			target = locations.filter((location) => location.reward.moneyScore === max)[0];
		}
	} else if (typeof target == "string") {
		target = locations.filter((location) => location.name === target)[0];
	}

	log(ns, `Infiltrate ${target.name} to get ${formatMoney(moneyNeed)}, need ${Math.ceil(moneyNeed / target.reward.sellCash)} loops`, verbose);

	if (options["info"]) return;

	while (currentMoney < maxMoney) {
		if (loop > options["max-loop"]) return log(ns, "maximum loops reached");
		if (ns.read("/Temp/stopInfiltration.txt")) return

		ns.tail();
		if (options["sleep-Between-Infiltration-Time"]) await ns.sleep(options["sleep-Between-Infiltration-Time"]);

		let city = player.city == target.city ? false : target.city;
		if (city && player.money < 2e5) {
			let cityMax = Math.min(...locations.filter((location) => location.city == player.city && location.reward.sellCash > 2e5).map((location) => location.reward.sellCash));
			let cityTarget = locations.filter((location) => location.reward.sellCash === cityMax)[0];
			log(ns, `Player money is too low to travel (${formatMoney(player.money, 6, 1)}), will Infiltrate 1x ${cityTarget.name}`, verbose);
			await infiltrateForMoney(ns, player, 2e5, cityTarget, false);
			player = await getPlayerInfo(ns);
			continue;
		}

		log(ns, `Infiltrating ${target.name} at loop ${loop} to get ${formatMoney(maxMoney)} (currently at ${formatMoney(currentMoney)})`, verbose);
		if (await infiltrate(ns, city, target.name, faction)) {
			loop++;
		}

		await click(btnSaveGame);
		await ns.sleep(10);

		player = await getPlayerInfo(ns);
		currentMoney = player.money + (stock ? await getStocksValue(ns) : 0);
	}
}

/** It tries to infiltrate the target, and then trades it to the faction
 * @param {NS} ns
 * @param {string | false} city - The city to travel to.
 * @param {string} target - The name of the company you want to infiltrate.
 * @param {string} faction - The faction to trade with
 * @returns {Promise<boolean>} completet */
async function infiltrate(ns, city, target, faction) {
	let completet = false;
	if (city) {
		await getNsDataThroughFile(ns, "ns.singularity.travelToCity(ns.args[0])", "/Temp/travel.txt", [city]);
		player = await getPlayerInfo(ns);
	}
	try {
		await click(await findRetry(ns, "//div[(@role = 'button') and (contains(., 'Travel'))]")); // Workaraound, somtimes click on "City" wil not show the right City
		await click(await findRetry(ns, "//div[(@role = 'button') and (contains(., 'City'))]"));
		await click(await findRetry(ns, `//span[@aria-label = '${target}']`));
		await click(await findRetry(ns, "//button[contains(text(), 'Infiltrate Company')]"));
	} catch (err) {
		log(ns, `Couldn't find ${city} / ${target}: ${err}`, verbose);
	} finally {
		while (!completet) {
			if (faction == "none") {
				const btn = find("//button[contains(text(), 'Sell')]");
				if (btn) {
					await click(btn);
					log(ns, `${btn.innerText}`, verbose);
					completet = true;
					break;
				}
			} else {
				const option = find("//div[@aria-haspopup = 'listbox']");
				if (option) {
					await setText(option.nextSibling, faction);
					const btn = find("//button[contains(text(), 'Trade')]");
					if (btn) {
						await click(btn);
						log(ns, `${btn.innerText} with ${faction}`, verbose);
						completet = true;
						break;
					}
				}
			}
			await ns.sleep(1000);
			if (find("//div[(@role = 'button') and (contains(., 'City'))]")) {
				log(ns, "Infiltration canceled?", verbose);
				break;
			}
		}
		await ns.sleep(1000);
		return completet;
	}
}

/**
 * @param {NS} ns
 * @param {Player} player
 * @param {Array<string>} ignoreFaction
 */
async function updateAugmentationData(ns, player, ignoreFaction) {
	const invitations = await getNsDataThroughFile(ns, "ns.singularity.checkFactionInvitations()", "/Temp/checkFactionInvitations.txt");
	let joinedFactions = player.factions;
	let factionNames = joinedFactions.concat(invitations);
	factionNames.push(...factions.filter((f) => !factionNames.includes(f)));
	factionNames = factionNames.filter((f) => !specialFaction.includes(f) && !ignoreFaction.includes(f));

	dictFactionAugs = await getNsDataThroughFile(ns, dictCommand("ns.singularity.getAugmentationsFromFaction(o)"), "/Temp/getAugmentationsFromFactions.txt", factionNames);
	let dictFactionReps = await getNsDataThroughFile(ns, dictCommand("ns.singularity.getFactionRep(o)"), "/Temp/getFactionReps.txt", factionNames);
	let dictFactionFavors = await getNsDataThroughFile(ns, dictCommand("ns.singularity.getFactionFavor(o)"), "/Temp/getFactionFavors.txt", factionNames);

	const gangInfo = await getGangInfo(ns);
	gangFaction = gangInfo ? gangInfo.faction : false;
	favorToDonate = await getNsDataThroughFile(ns, "ns.getFavorToDonate()", "/Temp/favor-to-donate.txt");

	factionData = Object.fromEntries(
		factionNames.map((faction) => [
			faction,
			{
				name: faction,
				invited: invitations.includes(faction),
				joined: joinedFactions.includes(faction),
				reputation: dictFactionReps[faction] || 0,
				favor: dictFactionFavors[faction],
				donationsUnlocked:
					dictFactionFavors[faction] >= favorToDonate &&
					// As a rule, cannot donate to gang factions or any of the below factions - need to use other mechanics to gain rep.
					![gangFaction, ...specialFaction].includes(faction),
				augmentations: dictFactionAugs[faction],
				unownedAugmentations: function (includeNf = false) {
					return this.augmentations.filter((aug) => !simulatedOwnedAugmentations.includes(aug) && (aug != strNF || includeNf));
				},
				mostExpensiveAugCost: function () {
					return this.augmentations.map((augName) => augmentationData[augName]).reduce((max, aug) => Math.max(max, aug.price), 0);
				},
				totalUnownedMults: function () {
					return this.unownedAugmentations()
						.map((augName) => augmentationData[augName])
						.reduce((arr, aug) => Object.keys(aug.stats).forEach((stat) => (arr[stat] = (arr[stat] || 1) * aug.stats[stat])) || arr, new Map());
				},
			},
		])
	);

	const augmentationNames = [...new Set(Object.values(factionData).flatMap((f) => f.augmentations))]; // augmentations.slice();
	const dictAugRepReqs = await getNsDataThroughFile(ns, dictCommand("ns.singularity.getAugmentationRepReq(o)"), "/Temp/getAugmentationRepReqs.txt", augmentationNames);
	const dictAugPrices = await getNsDataThroughFile(ns, dictCommand("ns.singularity.getAugmentationPrice(o)"), "/Temp/getAugmentationPrices.txt", augmentationNames);
	const dictAugStats = await getNsDataThroughFile(ns, dictCommand("ns.singularity.getAugmentationStats(o)"), "/Temp/getAugmentationStats.txt", augmentationNames);
	const dictAugPrereqs = await getNsDataThroughFile(ns, dictCommand("ns.singularity.getAugmentationPrereq(o)"), "/Temp/getAugmentationPrereqs.txt", augmentationNames);
	const ownedAugmentations = await getNsDataThroughFile(ns, `ns.singularity.getOwnedAugmentations(true)`, "/Temp/player-augs-purchased.txt");
	let simulatedOwnedAugmentations = ownedAugmentations.filter((a) => a != strNF);
	let priorityAugs = default_priority_augs;
	desiredAugs = priorityAugs.filter((name) => !simulatedOwnedAugmentations.includes(name));

	if ((desiredStatsFilters?.length ?? 0) == 0)
		// If the user does has not specified stats or augmentations to prioritize, use sane defaults
		desiredStatsFilters =
			ownedAugmentations.length > 40
				? ["_"] // Once we have more than N augs, switch to buying up anything and everything
				: player.bitNodeN == 6 || player.bitNodeN == 7 || player.factions.includes("Bladeburners")
				? ["_"] // If doing bladeburners, combat augs matter too, so just get everything
				: ["hacking", "faction_rep", "company_rep", "charisma", "hacknet", "crime_money"]; // Otherwise get hacking + rep boosting, etc. for unlocking augs more quickly

	/** Compute how much money must be donated to the faction to afford an augmentation. Faction can be either a faction object, or faction name */
	let getReqDonationForRep = (rep, faction) => Math.ceil((1e6 * Math.max(0, rep - (faction.name ? faction : factionData[faction]).reputation)) / player.mults.faction_rep);
	let getReqDonationForAug = (aug, faction) => getReqDonationForRep(aug.reputation, faction || aug.getFromJoined());

	augmentationData = Object.fromEntries(
		augmentationNames.map((aug) => [
			aug,
			{
				name: aug,
				displayName: aug,
				owned: simulatedOwnedAugmentations.includes(aug),
				reputation: dictAugRepReqs[aug],
				price: dictAugPrices[aug],
				stats: Object.fromEntries(Object.entries(dictAugStats[aug]).filter(([k, v]) => v != 1)),
				prereqs: dictAugPrereqs[aug] || [],
				// The best augmentations either have no stats (special effect like no Focus penalty, or Red Pill), or stats in the 'stat-desired' command line options
				desired:
					desiredAugs.includes(aug) || Object.keys(dictAugStats[aug]).length == 0 || Object.keys(dictAugStats[aug]).some((key) => desiredStatsFilters.some((filter) => key.includes(filter))),
				// Get the name of the "most-early-game" faction from which we can buy this augmentation. Estimate this by cost of the most expensive aug the offer
				getFromAny:
					factionNames
						.map((f) => factionData[f])
						.sort((a, b) => a.mostExpensiveAugCost - b.mostExpensiveAugCost)
						.filter((f) => f.augmentations.includes(aug))[0]?.name ?? "(unknown)",
				// Get a list of joined factions that have this augmentation
				joinedFactionsWithAug: function () {
					return factionNames.map((f) => factionData[f]).filter((f) => f.joined && f.augmentations.includes(this.name));
				},
				// Whether there is some joined faction which already has enough reputation to buy this augmentation
				canAfford: function () {
					return this.joinedFactionsWithAug().some((f) => f.reputation >= this.reputation);
				},
				canAffordWithDonation: function () {
					return this.joinedFactionsWithAug().some((f) => f.donationsUnlocked);
				},
				// Get the name of the **joined** faction from which we can buy this augmentation (sorted by which is closest to being able to afford it, then by most preferred)
				getFromJoined: function () {
					return (
						this.joinedFactionsWithAug().filter((f) => f.reputation >= this.reputation)[0] ||
						this.joinedFactionsWithAug()
							.filter((f) => f.donationsUnlocked)
							.sort((a, b) => getReqDonationForAug(this, a) - getReqDonationForAug(this, b))[0] ||
						this.joinedFactionsWithAug()[0]
					)?.name;
				},
			},
		])
	);
	// Propagate desired/priority status to any dependencies of desired augs. Note when --all-factions mode is not enabled, it's possible some prereqs are not in our list
	let propagateDesired = (aug) =>
		!aug.desired ||
		!aug.prereqs ||
		aug.prereqs.forEach((prereqName) => {
			let pa = augmentationData[prereqName];
			if (!pa) return log(ns, `WARNING: Missing info about aug ${aug.name} prerequisite ${prereqName}. We likely don't have access.`);
			if (pa.owned) return;
			if (!pa.desired) {
				log(ns, `INFO: Promoting aug "${prereqName}" to "desired" status, because desired aug "${aug.name}" depends on it.`);
				pa.desired = true;
			} // Also propagate the "priority" status to any dependencies of priority augs (dependency must be made a higher priority)
			if (priorityAugs.includes(aug.name) && !priorityAugs.includes(prereqName)) {
				log(ns, `INFO: Promoting aug "${prereqName}" to "priority" status, because priority aug "${aug.name}" depends on it.`, true);
				priorityAugs.splice(priorityAugs.indexOf(aug.name), 0, prereqName);
			}
			propagateDesired(pa); // Recurse on any nested prerequisites of this prerequisite aug.
		});
	Object.values(augmentationData).forEach((a) => propagateDesired(a));
}

/**
 * @param {NS} ns
 * @param {boolean} [display=]
 * @returns {Promise<Array<{city: string, maxClearanceLevel: number, name: string, reward: {SoARep: number, tradeRep: number, sellCash: number, repScore: number, moneyScore: number}}>>} Array of locations
 */
async function getLocations(ns, display = false) {
	let locations = [];
	let locationsRAW = await getNsDataThroughFile(ns, "ns.infiltration.getPossibleLocations()", "/Temp/infiltration-getPossibleLocations.txt");
	for (const l of locationsRAW) {
		if (ignoreTarget.some((location) => location == l.name)) continue;
		let info = await getNsDataThroughFile(ns, "ns.infiltration.getInfiltration(ns.args[0])", "/Temp/infiltration-getInfiltration.txt", [l.name]);
		let location = {
			name: info.location.name,
			city: info.location.city,
			maxClearanceLevel: info.location.infiltrationData.maxClearanceLevel,
			reward: info.reward,
			toString: function () {
				return (
					`${this.name.padEnd(25)}  ${this.maxClearanceLevel.toString().padStart(2)}   ` +
					`${formatNumberShort(this.reward.tradeRep, 4).padEnd(6)} (${formatNumberShort(this.reward.repScore, 3).padStart(5)})   ` +
					`${formatMoney(this.reward.sellCash, 4).padEnd(7)} (${formatMoney(this.reward.moneyScore, 4).padStart(6)})`
				);
			},
		};
		location.reward.repScore = location.reward.tradeRep / location.maxClearanceLevel;
		location.reward.moneyScore = location.reward.sellCash / location.maxClearanceLevel;
		locations.push(location);
	}
	locations.sort((a, b) => a.reward.repScore - b.reward.repScore);
	if (display) {
		log(ns, `Locations:\n  Faction                    Lvl  Rep    (/ lvl)   Money   ( / lvl) \n  ${locations.join("\n  ")}`, true);
	}
	return locations;
}

/** SoA aug check
 * @param {NS} ns
 * @returns {Promise<Boolean>} */
async function hasSoaAug(ns) {
	try {
		const augs = await getNsDataThroughFile(ns, "ns.singularity.getOwnedAugmentations()", "/Temp/player-augs-installed.txt");
		return augs.some((aug) => aug.toLowerCase().includes("wks harmonizer"));
	} catch (err) {
		log(ns, `WARN: Could not get list of owned augs: ${err.toString()}`);
		log(ns, "WARN: Assuming no WKS harmonizer aug is installed.");
	}
	return false;
}

/** Builds a list of targets to infiltrate
 * @param {NS} ns
 * @param {Array<string>} [ignoreFaction] - This is a faction that you want to ignore.
 * @param {string} [boostFaction] - If you want to boost a specific faction, put it here.
 * @param {string} [forceTarget] - If you want to force a specific target, you can put it here.
 * @returns {Promise<void>}
 */
async function buildInfiltrationStack(ns, ignoreFaction = [], boostFaction = "", forceTarget = "") {
	let factionsNeedReputation = {};
	// TODO: Export "augmentationData, (factionData), desiredAugs, dictFactionAugs" in facman?
	await updateAugmentationData(ns, player, ignoreFaction);

	const unownedAugs = Object.values(augmentationData).filter((aug) => !aug.owned || aug.name == strNF);
	let availableAugs = unownedAugs.filter((aug) => aug.getFromJoined() != null);

	for (const aug of availableAugs) {
		let faction = aug.getFromJoined();
		if (boostFaction && boostFaction != faction) continue;
		let reputation = aug.reputation;
		let repNeed = reputation - (await getFactionReputation(ns, faction));
		if (repNeed < 0) continue;
		if (!factionsNeedReputation[faction]) {
			factionsNeedReputation[faction] = { reputation, repNeed };
		} else if (factionsNeedReputation[faction].reputation < aug.reputation) {
			factionsNeedReputation[faction].reputation = reputation;
			factionsNeedReputation[faction].repNeed = repNeed;
		}
	}
	if (factionsNeedReputation.length == 0) return log(ns, "No Faction need Reputation", verbose);

	Object.entries(factionsNeedReputation)
		.sort(function (a, b) {
			let x = a[1].repNeed;
			let y = b[1].repNeed;
			if (x - y || dictFactionAugs[b[0]].some((aug) => desiredAugs.includes(aug))) return 1;
			if (y - x || dictFactionAugs[a[0]].some((aug) => desiredAugs.includes(aug))) return -1;
			return 0;
		})
		.forEach((faction) => getTarget(ns, locations, faction, forceTarget));
	return;
}

/** Get optimized Target for faction
 * @param {NS} ns
 * @param {Array<{city: string, maxClearanceLevel: number, name: string, reward: {SoARep: number, tradeRep: number, sellCash: number, repScore: number, moneyScore: number}}>} locations - Array of locations
 * @param {[string, {repNeed: number, reputation: number}]} faction - The faction you want to boost.
 * @param {string} [target] - The target to infiltrate.
 * @param {number} [loop] - The number of times to run the infiltration.
 * @returns {Promise<void>} */
function getTarget(ns, locations, faction, target = undefined, loop = 1) {
	let target2;
	let repNeed = faction[1].repNeed;
	let reputation = faction[1].reputation;
	let factionName = faction[0];

	if (!target) {
		if (locations.filter((location) => location.reward.tradeRep > repNeed).length > 0) {
			let min = Math.min(...locations.filter((location) => location.reward.tradeRep > repNeed).map((location) => location.reward.tradeRep));
			target = locations.filter((location) => location.reward.tradeRep === min)[0];
		} else {
			let max = Math.max(...locations.map((location) => location.reward.repScore));
			target = locations.filter((location) => location.reward.repScore === max)[0];

			loop = Math.ceil(repNeed / target.reward.tradeRep);
			if (loop > options["max-loop"]) loop = options["max-loop"];
		}
	}
	if (typeof target == "string") {
		target = locations.filter((location) => location.name === forceTarget[0])[0];
	}

	infiltrationStack.push({
		faction: factionName,
		target,
		loop,
		repNeed,
		reputation,
	});

	if (loop > 1 && loop != options["max-loop"]) {
		loop--;
		let repNeed2 = repNeed - target.reward.tradeRep * loop;

		let min2 = Math.min(...locations.filter((location) => location.reward.tradeRep > repNeed2).map((location) => location.reward.tradeRep));
		target2 = locations.filter((location) => location.reward.tradeRep === min2)[0];

		if (target.name == target2.name) {
			target2 = null;
			loop++;
		} else {
			infiltrationStack[infiltrationStack.length - 1].loop--;
			infiltrationStack.push({
				faction: factionName,
				target: target2,
				loop: 1,
				repNeed: repNeed2,
				reputation,
			});
		}
	}
	log(
		ns,
		`Faction ${factionName} need ${formatNumberShort(repNeed, 5)} Rep, infiltrate ${loop}x ${target.name} (${formatNumberShort(target.reward.tradeRep, 6, 1)}/loop)` +
			(target2 ? ` and 1x ${target2.name} (${formatNumberShort(target2.reward.tradeRep, 6, 1)})/loop)` : ""),
		verbose
	);

	return;
}

/** Helper to launch a script and log whether if it succeeded or failed
 * @param {NS} ns  */
function launchScriptHelper(ns, baseScriptName, args = [], convertFileName = true) {
	ns.tail(); // If we're going to be launching scripts, show our tail window so that we can easily be killed if the user wants to interrupt.
	const pid = ns.run(convertFileName ? getFilePath(baseScriptName) : baseScriptName, 1, ...args);
	if (!pid) log(ns, `ERROR: Failed to launch ${baseScriptName} with args: [${args.join(", ")}]`, true, "error");
	else log(ns, `INFO: Launched ${baseScriptName} (pid: ${pid}) with args: [${args.join(", ")}]`, true);
	return pid;
}

// Ram-dodging helper, runs a command for all items in a list and returns a dictionary.
const dictCommand = (command) => `Object.fromEntries(ns.args.map(o => [o, ${command}]))`;

/** Ram-dodge getting updated player info.
 * @param {NS} ns
 * @returns {Promise<Player>} */
async function getPlayerInfo(ns) {
	return await getNsDataThroughFile(ns, `ns.getPlayer()`, "/Temp/player-info.txt");
}

/** Ram-dodge getting updated Gang info.
 * @param {NS} ns
 *  @returns {Promise<GangGenInfo|boolean>} Gang information, if we're in a gang, or False */
async function getGangInfo(ns) {
	return await getNsDataThroughFile(ns, "ns.gang.inGang() ? ns.gang.getGangInformation() : false", "/Temp/gang-stats.txt");
}

/** Ram-dodge getting Faction Reputation.
 * @param {NS} ns
 * @param {string} factionName
 * @returns {Promise<Number>} Current reputation with the specified faction */
async function getFactionReputation(ns, factionName) {
	return await getNsDataThroughFile(ns, `ns.singularity.getFactionRep(ns.args[0])`, "/Temp/getFactionRep.txt", [factionName]);
}

// TODO: Share instead of copy-paste from casino -->
/**
 * It clicks on an element
 * @param elem - The element you want to click.
 */
async function click(elem) {
	await elem[Object.keys(elem)[1]].onClick({
		isTrusted: true,
	});
}

/**
 * It sets the text of an input field
 * @param input - The input field you want to set text to.
 * @param text - The text you want to set the input to.
 */
async function setText(input, text) {
	await input[Object.keys(input)[1]].onChange({
		isTrusted: true,
		target: { value: text },
	});
}

/**
 * It takes an XPath expression and returns the first element that matches it
 * @param xpath - The XPath expression to evaluate.
 * @returns The first element that matches the xpath expression.
 */
function find(xpath) {
	return doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
}

/**
 * "Find an element with the given xpath, retrying up to 10 times if it's not found, and throwing an
 * error if it's not found after 10 tries."
 *
 * @param ns
 * @param xpath - The xpath of the element you're looking for
 * @param [expectFailure=false] - If true, the function will throw an error if the element is found.
 * @param [retries=null] - The number of times to retry the function.
 * @returns
 */
async function findRetry(ns, xpath, expectFailure = false, retries = null) {
	try {
		return await autoRetry(
			ns,
			() => find(xpath),
			(e) => e !== undefined,
			() => (expectFailure ? `It's looking like the element with xpath: ${xpath} isn't present...` : `Could not find the element with xpath: ${xpath}\nSomething may have re-routed the UI`),
			retries != null ? retries : expectFailure ? 3 : 10,
			1,
			2
		);
	} catch (e) {
		if (!expectFailure) throw e;
	}
}
