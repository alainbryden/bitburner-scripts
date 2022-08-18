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
  return [...Object.keys(FragmentId)];
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

  // 1. Set up priority order of stat fragments to include
  const targetIds = [FragmentId.Rep, FragmentId.Hacking2];
  const allFragments = ns.stanek.fragmentDefinitions();
  const statFrags = allFragments.filter(frag => targetIds.includes(frag.id));
  const boosterFrags = allFragments.filter(frag => frag.type == FragmentType.Booster);

  // 2. Pick dimensions (why not pick many!)
  const height = 3; //ns.stanek.giftHeight()
  const width = 3; //ns.stanek.giftWidth(); // NOTE: Width is always the same, or one more than height.
  const [score, plan] = await planFragments(ns, width, height, statFrags, boosterFrags);
  ns.tprint(score);
  const strFragments = [];
  // Output the layout so you can stick it in a database
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
  /** @type {Placement[]} */
  const placements = [];
  /** @type {Placement[]} */
  const statPlacements = [];
  /** @type {Placement[]} */
  const boosterPlacements = [];
  /** @type {Map<number, Placement[]>} */
  const statFragsPlacements = new Map(statFrags.map(frag => [frag.id, []]));
  /** @type {Map<number, Placement[]>} */
  const boosterFragsPlacements = new Map(boosterFrags.map(frag => [frag.id, []]));
  /** @type {number[][][]} */
  //const overlapping = [...new Array(width)].map(() => [...new Array(height)].map(() => []));

  let statSeqn = 0, boosterSeqn = 0;
  for (const frag of [...statFrags, ...boosterFrags]) {
    for (const { rot, mask } of rotations(frag)) {
      for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
          const coords = mask.map(([x0, y0]) => [x0 + x, y0 + y]);
          if (coords.every(([x, y]) => x < width && y < height)) {
            const key = frag.type == FragmentType.Booster ? boosterSeqn++ : statSeqn++; //`${frag.id}@${x}-${y}-${rot}`;
            const placement = {
              key, fragment: frag, x, y, rot,
              coords, adjacent: adjacents(width, height, coords)
            };

            placements.push(placement);
            if (frag.type == FragmentType.Booster) {
              boosterPlacements[key] = placement;
              boosterFragsPlacements.get(frag.id).push(placement);
            }
            else {
              statPlacements[key] = placement;
              statFragsPlacements.get(frag.id).push(placement);
            }

            //coords.forEach(([x, y]) => overlapping[x][y].push(key));
          }
        }
      }
    }
  }

  // Canonise coordinate arrays so we can use equality comparisons on them
  const canonicalCoords = [...new Array(width)].map((_, x) => [...new Array(height)].map((_, y) => [x, y]));
  for (const placement of placements) {
    placement.coords = placement.coords.map(([x, y]) => canonicalCoords[x][y]);
    placement.adjacent = placement.adjacent.map(([x, y]) => canonicalCoords[x][y]);
  }

  // Pre-compute all adjacencies
  for (const placement of placements) {
    placement.adjacentBoosters = [];
    placement.adjacentStats = [];
    placement.overlapWithBoosters = [];
    placement.overlapWithStats = [];
    for (const other of boosterPlacements) {
      if (placement.coords.some(coord => other.adjacent.includes(coord)))
        placement.adjacentBoosters.push(other.key);
      if (placement.coords.some(coord => other.coords.includes(coord))) {
        placement.overlapWithBoosters.push(other.key);
      }
    }
    for (const other of statPlacements) {
      if (placement.coords.some(coord => other.adjacent.includes(coord)))
        placement.adjacentStats.push(other.key);
      if (placement.coords.some(coord => other.coords.includes(coord))) {
        placement.overlapWithStats.push(other.key);
      }
    }
  }

  // Turn arrays to fixed type, now that we know their contents
  for (const placement of placements) {
    placement.adjacentBoosters = Int16Array.from(placement.adjacentBoosters);
    placement.adjacentStats = Int16Array.from(placement.adjacentStats);
    placement.overlapWithBoosters = Int16Array.from(placement.overlapWithBoosters);
    placement.overlapWithStats = Int16Array.from(placement.overlapWithStats);
  }

  // Exclude rotational symmetries from search by only using
  // - rot 0 placements if the board is square
  // - rot 0 and rot 1 placements if the board is non-square
  // of the first fragment
  // Select the stat fragment with most potential placements as the first fragment,
  // to get the biggest reduction of search space
  const statFragsKeys = [...statFrags]
    .sort((a, b) => statFragsPlacements.get(b.id).length - statFragsPlacements.get(a.id).length)
    .map(frag => statFragsPlacements.get(frag.id).map(placement => placement.key));
  statFragsKeys[0] = statFragsKeys[0].filter(key =>
    width == height ? statPlacements[key].rot == 0 : (statPlacements[key].rot == 0 || statPlacements[key].rot == 1));

  /// Compute stat fragment layout that maximises potential stat-booster fragment adjacencies
  const blockedStats0 = new Uint8Array(statPlacements.length);
  const blockedBoosters0 = new Uint8Array(boosterPlacements.length);
  const boosterStatAdjacencies0 = new Uint8Array(boosterPlacements.length);
  const plan0 = { stats: [], boosters: [] };
  const bestResult0 = [-Infinity, { stats: [...plan0.stats], boosters: [...plan0.boosters] }];

  planStatsCount = 0;
  planBoostersCount = 0;
  const t1 = performance.now();
  const [score, plan] = planStats(ns, statPlacements, boosterPlacements, statFragsKeys,
    blockedStats0, blockedBoosters0, boosterStatAdjacencies0, plan0, bestResult0);
  const t2 = performance.now();

  tlog(ns, "DEBUG", "Computed Stanek plan. Prep work %.3fmsec, layout search %.3fmsec, %d planStats calls, %d planBoosters calls",
    t1 - t0, t2 - t1, planStatsCount, planBoostersCount);

  return [score, plan];
}

/** @param {NS} ns
 *  @param {Placement[]} statPlacements
 *  @param {Placement[]} boosterPlacements
 *  @param {number[][]} statFragsKeys
 *  @param {Uint8Array} blockedStats
 *  @param {Plan} plan
 *  @param {[number, Plan]} bestResult
 *  @param {Uint8Array} blockedBoosters
 *  @param {Uint8Array} boosterStatAdjacencies
 *  @return {[number, Plan, Uint8Array, Uint8Array]} */
function planStats(ns, statPlacements, boosterPlacements, statFragsKeys, blockedStats, blockedBoosters, boosterStatAdjacencies, plan, bestResult) {
  planStatsCount++;
  if (statFragsKeys.length == 0) {
    // Mark boosters that are not blocked, but also not adjacent to a stat fragment as unavailable
    // and count the remaining available boosters
    let availableBoostersCount = 0;
    for (let i = 0; i < blockedBoosters.length; i++) {
      if (boosterStatAdjacencies[i] === 0) // No adjacent stat fragments => block
        blockedBoosters[i]++;
      else if (blockedBoosters[i] === 0) // Has adjacent stat fragments, and not blocked
        availableBoostersCount++;
    }

    const result = planBoosters(plan, boosterPlacements, boosterStatAdjacencies,
      blockedBoosters, availableBoostersCount, 0, bestResult);

    // Undo changes
    for (let i = 0; i < blockedBoosters.length; i++)
      if (boosterStatAdjacencies[i] === 0)
        blockedBoosters[i]--;

    return result;
  }

  for (const key of statFragsKeys[0]) {
    if (blockedStats[key] !== 0) continue;
    const placement = statPlacements[key];
    const adjacentBoosters = placement.adjacentBoosters;
    const overlapWithBoosters = placement.overlapWithBoosters;
    const overlapWithStats = placement.overlapWithStats;

    // Add the fragment placement to plan and update usability in-place to account for the new blocks
    plan.stats.push(placement);
    for (let i = 0; i < overlapWithStats.length; i++)
      blockedStats[overlapWithStats[i]]++;
    for (let i = 0; i < overlapWithBoosters.length; i++)
      blockedBoosters[overlapWithBoosters[i]]++;
    for (let i = 0; i < adjacentBoosters.length; i++)
      boosterStatAdjacencies[adjacentBoosters[i]]++;

    // Find and score best plan that includes this fragment placement
    bestResult = planStats(ns, statPlacements, boosterPlacements, statFragsKeys.slice(1),
      blockedStats, blockedBoosters, boosterStatAdjacencies, plan, bestResult);

    // Undo the changes
    plan.stats.pop();
    for (let i = 0; i < overlapWithStats.length; i++)
      blockedStats[overlapWithStats[i]]--;
    for (let i = 0; i < overlapWithBoosters.length; i++)
      blockedBoosters[overlapWithBoosters[i]]--;
    for (let i = 0; i < adjacentBoosters.length; i++)
      boosterStatAdjacencies[adjacentBoosters[i]]--;
  }

  return bestResult;
}

/** @param {Plan} plan
 *  @param {Placement[]} boosterPlacements
 *  @param {Uint8Array} boosterStatAdjacencies
 *  @param {Uint8Array} blockedBoosters
 *  @param {number} availableCount
 *  @param {number} startIdx
 *  @param {[number, Plan]} bestResult
 *  @return {[number, Plan]} */
function planBoosters(plan, boosterPlacements, boosterStatAdjacencies, blockedBoosters, availableCount, startIdx, bestResult) {
  planBoostersCount++;
  if (availableCount == 0) {
    const { stats, boosters } = plan;

    let score = 0;
    for (let i = 0; i < boosters.length; i++)
      score += boosterStatAdjacencies[boosters[i].key];

    if (score > bestResult[0])
      return [score, { stats: [...stats], boosters: [...boosters] }]; // Clone plan
    else
      return bestResult;
  }

  for (let i = startIdx; i < blockedBoosters.length; i++) {
    if (blockedBoosters[i] !== 0) continue;
    const placement = boosterPlacements[i];
    const overlapWithBoosters = placement.overlapWithBoosters;

    // Add the fragment placement to plan and update usability in-place to account for the new blocks
    plan.boosters.push(placement);
    for (let j = 0; j < overlapWithBoosters.length; j++)
      if ((blockedBoosters[overlapWithBoosters[j]]++) === 0) availableCount--; // Placement became blocked?

    // Find and score best plan that includes this fragment placement
    bestResult = planBoosters(plan, boosterPlacements, boosterStatAdjacencies, blockedBoosters, availableCount, i + 1, bestResult);

    // Undo the changes
    plan.boosters.pop();
    for (let j = 0; j < overlapWithBoosters.length; j++)
      if ((--blockedBoosters[overlapWithBoosters[j]]) === 0) availableCount++; // Placement became free?
  }

  return bestResult;
}

/** @param {Fragment} fragment
 *  @return {{ rot: number; mask: [number, number][]}[]} */
function rotations(fragment) {
  function shapeEq(s1, s2) {
    if (s1.length != s2.length)
      return false;
    for (let i = 0; i < s1.length; i++) {
      if (s1[i].length != s2[i].length)
        return false;
      for (let j = 0; j < s1[i].length; j++)
        if (s1[i][j] != s2[i][j])
          return false;
    }
    return true;
  }

  let shape = fragment.shape;
  const rotMasks = [{ rot: 0, mask: shape }];
  for (let i = 1; i < 4; i++) {
    shape = shape[0].map((_, y) => shape.map((_, x) => shape[shape.length - 1 - x][y]));
    if (!rotMasks.some(({ mask }) => shapeEq(shape, mask)))
      rotMasks.push({ rot: i, mask: shape.map(row => [...row]) });
  }

  for (const rotMask of rotMasks)
    rotMask.mask = rotMask.mask.map((row, y) => row.map((filled, x) => filled ? [x, y] : undefined))
      .flat()
      .filter(elem => elem != undefined);

  return rotMasks;
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