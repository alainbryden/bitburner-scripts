const FragmentType = {
  HackingChance: 2,
  HackingSpeed: 3,
  HackingMoney: 4,
  HackingGrow: 5,
  Hacking: 6,
  Strength: 7,
  Defense: 8,
  Dexterity: 9,
  Agility: 10,
  Charisma: 11,
  HacknetMoney: 12,
  HacknetCost: 13,
  Rep: 14,
  WorkMoney: 15,
  Crime: 16,
  Bladeburner: 17,
  Booster: 18,
}
 
const FragmentId = {
  Hacking1: 0,
  Hacking2: 1,
  HackingSpeed: 5,
  HackingMoney: 6,
  HackingGrow: 7,
  Strength: 10,
  Defense: 12,
  Dexterity: 14,
  Agility: 16,
  Charisma: 18,
  HacknetMoney: 20,
  HacknetCost: 21,
  Rep: 25,
  WorkMoney: 27,
  Crime: 28,
  Bladeburner: 30,
  //Booster1: 100,
  //Booster2: 101,
  //Booster3: 102,
  //Booster4: 103,
  //Booster5: 104,
  //Booster6: 105,
  //Booster7: 106,
  //Booster8: 107,
};

let planStatsCount = 0;
let planBoostersCount = 0;

/** @typedef {{ key: number, fragment: Fragment, x: number; y: number; rot: number;
  *             coords: [number, number][]; adjacent: [number, number][];
  *             adjacentBoosters: Int16Array; adjacentStats: Int16Array;
  *             overlapWithBoosters: Int16Array; overlapWithStats: Int16Array }} Placement */
/** @typedef {{ stats: Placement[]; boosters: Placement[] }} Plan */

export function autocomplete(data, args) {
	return [...Object.keys(FragmentType)];
}

/** @param {NS} ns */
export async function main(ns) {
	/*
	if (ns.args.length == 0) {
		tlog(ns, "ERROR", "At least one fragment type required");
		return;
	}
	if (!ns.args.every(arg => Object.keys(FragmentType).includes(arg))) {
		tlog("ERROR", "Invalid fragment type(s): %s",
			ns.args.filter(arg => !Object.keys(FragmentType).includes(arg)));
		return;
	}*/


	// 1. Pick dimensions
	const height = 5; //ns.stanek.giftHeight()
	const width = 6; //ns.stanek.giftWidth(); // NOTE: Width is always the same, or one more than height.

	// 2. 
	//const targetTypes = ns.args.map(arg => FragmentType[arg]);
	const targetTypes = [FragmentType.Rep, FragmentType.Hacking];
	const allFragments = ns.stanek.fragmentDefinitions();
	// Note boosters are automatically included, they shouldn't be specified in the list of fragment types
	const boosterFrags = allFragments.filter(frag => frag.type == FragmentType.Booster);
	const statFrags = allFragments.filter(frag => frag.type != FragmentType.Booster && targetTypes.includes(frag.type));

	const [score, plan] = await planFragments(ns, width, height, statFrags, boosterFrags);

	ns.tprint(score);
	//ns.tprint(plan);
	const strFragments = [];
	for (const elem of [...plan.stats, ...plan.boosters])
		strFragments.push(`{"id":${elem.fragment.id},"x":${elem.x},"y":${elem.y},"rotation":${elem.rot}}`);
	ns.tprint(`\n{"height": ${height}, "width": ${width}, "fragments": [\n    ${strFragments.join(",\n    ")}\n]}`);
}

/** @param {NS} ns */
function tlog(ns, prefix, format, ...args) {
	ns.tprintf(prefix + ": " + format, ...args);
}

/** @param {NS} ns
 *  @param {number} width
 *  @param {number} height
 *  @param {Fragment[]} statFrags
 *  @param {Fragment[]} boosterFrags */
async function planFragments(ns, width, height, statFrags, boosterFrags) {
	const t0 = performance.now();
	/** @type {Map<number, number[]>} */
	const statFragsKeys = new Map(statFrags.map(frag => [frag.id, []]));
	/** @type {Map<number, number[]>} */
	const boosterFragsKeys = new Map(boosterFrags.map(frag => [frag.id, []]));
	/** @type {Placement[]} */
	const placements = [];
	/** @type {number[][][]} */
	const overlapping = [...new Array(width)].map(() => [...new Array(height)].map(() => []));

	let seqn = 0;
	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++) {
			for (let rot = 0; rot < 4; rot++) {
				for (const frag of [...statFrags, ...boosterFrags]) {
					const coords = coverage(x, y, rot, frag)
					if (coords.every(([x, y]) => x < width && y < height)) {
						const key = seqn++; //`${frag.id}@${x}-${y}-${rot}`;
						const placement = {
							key, fragment: frag, x, y, rot,
							coords, adjacent: adjacents(width, height, coords)
						};

						statFragsKeys.get(frag.id)?.push(key); // Only stat fragments
						boosterFragsKeys.get(frag.id)?.push(key); // Only booster fragments
						placements[key] = placement;

						coords.forEach(([x, y]) => overlapping[x][y].push(key));
					}
				}
			}
		}
	}
	ns.tprint(`Placements: ${placements.length}`)

	/** @type {Int8Array} */
	const isBoosterFrag = Int8Array.from(placements.map(placement => placement.fragment.type == FragmentType.Booster ? 0 : 1));

	// Canonise coordinate arrays so we can use equality comparisons on them
	const canonicalCoords = [...new Array(width)].map((_, x) => [...new Array(height)].map((_, y) => [x, y]));
	for (const placement of placements) {
		placement.coords = placement.coords.map(([x, y]) => canonicalCoords[x][y]);
		placement.adjacent = placement.adjacent.map(([x, y]) => canonicalCoords[x][y]);
	}

	// Pre-compute all adjacencies
	for (const placement of placements) {
		placement.adjacentTo = [];
		placement.adjacentToBoosters = [];
		placement.adjacentToStats = [];
		placement.isAdjacentTo = new Int8Array(placements.length);
		placement.overlapWith = [];
		placement.overlapWithBoosters = [];
		placement.overlapWithStats = [];
		for (const other of placements) {
			if (placement.coords.some(coord => other.adjacent.includes(coord))) {
				placement.isAdjacentTo[other.key] = 1;
				placement.adjacentTo.push(other.key);
				if (other.fragment.type == FragmentType.Booster)
					placement.adjacentToBoosters.push(other.key);
				else
					placement.adjacentToStats.push(other.key);
			}
			if (placement.coords.some(coord => other.coords.includes(coord))) {
				placement.overlapWith.push(other.key);
				if (other.fragment.type == FragmentType.Booster)
					placement.overlapWithBoosters.push(other.key);
				else
					placement.overlapWithStats.push(other.key);
			}
		}
	}

	// Turn arrays to fixed type, now that we know their contents
	for (const placement of placements) {
		placement.adjacentTo = Int16Array.from(placement.adjacentTo);
		placement.adjacentToBoosters = Int16Array.from(placement.adjacentToBoosters);
		placement.adjacentToStats = Int16Array.from(placement.adjacentToStats);
		placement.overlapWith = Int16Array.from(placement.overlapWith);
		placement.overlapWithBoosters = Int16Array.from(placement.overlapWithBoosters);
		placement.overlapWithStats = Int16Array.from(placement.overlapWithStats);
	}

	/// Compute stat fragment layout that maximises potential stat-booster fragment adjacencies
	const available0 = new Uint8Array(placements.length);
	const availableBoosters0 = Uint8Array.from(isBoosterFrag);
	const adjacentStats0 = new Uint8Array(placements.length);
	const plan0 = { stats: [], boosters: [] };
	const bestResult0 = [-Infinity, { stats: [...plan0.stats], boosters: [...plan0.boosters] }];

	planStatsCount = 0;
	planBoostersCount = 0;
	const t1 = performance.now();
	const [score, plan] = planStats(ns, placements, statFrags, statFragsKeys,
		available0, plan0, bestResult0, availableBoosters0, adjacentStats0);
	const t2 = performance.now();

	tlog(ns, "DEBUG", "Computed Stanek plan. Prep work %.3fmsec, layout search %.3fmsec, %d planStats calls, %d planBoosters calls",
		t1 - t0, t2 - t1, planStatsCount, planBoostersCount);

	return [score, plan];
}

/** @param {NS} ns
 *  @param {Placement[]} placements
 *  @param {Fragment[]} statFrags
 *  @param {Map<number, number[]>} statFragsKeys
 *  @param {Uint8Array} available
 *  @param {Plan} plan
 *  @param {[number, Plan]} bestResult
 *  @param {Uint8Array} availableBoosters
 *  @param {Uint8Array} adjacentStats
 *  @return {[number, Plan]} */
function planStats(ns, placements, statFrags, statFragsKeys, available, plan, bestResult, availableBoosters, adjacentStats) {
	planStatsCount++;
	if (statFrags.length == 0) {
		// Mark boosters that are not blocked, but also not adjacent to a stat fragment as unavailable
		// and count the remaining available boosters
		let availableBoostersCount = 0;
		for (let i = 0; i < availableBoosters.length; i++) {
			if (adjacentStats[i] === 0) // No stats adjacent => mark unavailable
				availableBoosters[i]++;
			else if (availableBoosters[i] === 0)
				availableBoostersCount++;
		}

		const result = planBoosters(plan, placements, availableBoosters, availableBoostersCount, 0, bestResult);

		// Undo changes
		for (let i = 0; i < availableBoosters.length; i++)
			if (adjacentStats[i] === 0)
				availableBoosters[i]--;

		return result;
	}

	for (const key of statFragsKeys.get(statFrags[0].id)) {
		if (available[key] !== 0) continue;
		const placement = placements[key];
		const adjacentToBoosters = placement.adjacentToBoosters;
		const overlapWithBoosters = placement.overlapWithBoosters;
		const overlapWithStats = placement.overlapWithStats;

		// Add the fragment placement to plan and update usability in-place to account for the new blocks
		plan.stats.push(placement);
		for (let i = 0; i < overlapWithStats.length; i++)
			available[overlapWithStats[i]]++;
		for (let i = 0; i < overlapWithBoosters.length; i++)
			availableBoosters[overlapWithBoosters[i]]++;
		for (let i = 0; i < adjacentToBoosters.length; i++)
			adjacentStats[adjacentToBoosters[i]]++;

		// Find and score best plan that includes this fragment placement
		bestResult = planStats(ns, placements, statFrags.slice(1), statFragsKeys,
			available, plan, bestResult, availableBoosters, adjacentStats);

		// Undo the changes
		plan.stats.pop();
		for (let i = 0; i < overlapWithStats.length; i++)
			available[overlapWithStats[i]]--;
		for (let i = 0; i < overlapWithBoosters.length; i++)
			availableBoosters[overlapWithBoosters[i]]--;
		for (let i = 0; i < adjacentToBoosters.length; i++)
			adjacentStats[adjacentToBoosters[i]]--;
	}

	return bestResult;
}

/** @param {Plan} plan
 *  @param {Placement[]} placements
 *  @param {Uint8Array} available
 *  @param {number} availableCount
 *  @param {number} startIdx
 *  @param {[number, Plan]} bestResult
 *  @return {[number, Plan]} */
function planBoosters(plan, placements, available, availableCount, startIdx, bestResult) {
	planBoostersCount++;
	if (availableCount == 0) {
		let score = 0;
		const { stats, boosters } = plan;
		for (let i = 0; i < stats.length; i++) {
			const isAdjacentTo = stats[i].isAdjacentTo;
			for (let j = 0; j < boosters.length; j++)
				if (isAdjacentTo[boosters[j].key] !== 0)
					score += 1;
		}
		score = stats.length * (1 + 0.1 * score); // piecesPlaced*(1+0.1*numAdjacencies)
		if (score > bestResult[0])
			return [score, { stats: [...plan.stats], boosters: [...plan.boosters] }]; // Clone plan
		else
			return bestResult;
	}

	for (let i = startIdx; i < available.length; i++) {
		if (available[i] !== 0) continue;
		const placement = placements[i];
		const overlapWithBoosters = placement.overlapWithBoosters;

		// Add the fragment placement to plan and update usability in-place to account for the new blocks
		plan.boosters.push(placement);
		for (let j = 0; j < overlapWithBoosters.length; j++)
			if ((available[overlapWithBoosters[j]]++) === 0) availableCount--; // Placement became blocked?

		// Find and score best plan that includes this fragment placement
		bestResult = planBoosters(plan, placements, available, availableCount, i + 1, bestResult);

		// Undo the changes
		plan.boosters.pop();
		for (let j = 0; j < overlapWithBoosters.length; j++)
			if ((--available[overlapWithBoosters[j]]) === 0) availableCount++; // Placement became free?
	}

	return bestResult;
}

/** @param {number} x0
 *  @param {number} y0
 *  @param {number} rotation
 *  @param {Fragment} fragment
 *  @return {[number, number][]} */
function coverage(x0, y0, rotation, fragment) {
	let shape = fragment.shape;
	for (let i = 0; i < rotation; i++)
		shape = shape[0].map((_, y) => shape.map((_, x) => shape[shape.length - 1 - x][y]));

	return shape.map((row, y) => row.map((filled, x) => filled ? [x0 + x, y0 + y] : undefined))
		.flat()
		.filter(elem => elem != undefined);
}

/** @param {number} width
 *  @param {number} height
 *  @param {[number, number][]} coords 
 *  @return {[number, number][]} */
function adjacents(width, height, coords) {
	const adjacent = [...new Array(width)].map(() => [...new Array(height)].map(() => false));
	// Mark grid squares adjacent to shape member squares
	for (const [x, y] of coords) {
		if (x - 1 >= 0) adjacent[x - 1][y] = true;
		if (x + 1 < width) adjacent[x + 1][y] = true;
		if (y - 1 >= 0) adjacent[x][y - 1] = true;
		if (y + 1 < height) adjacent[x][y + 1] = true;
	}
	// Strip out the shape squares themselves
	for (const [x, y] of coords)
		adjacent[x][y] = false;

	return adjacent.map((col, x) => col.map((is, y) => is ? [x, y] : undefined))
		.flat()
		.filter(elem => elem != undefined);
}