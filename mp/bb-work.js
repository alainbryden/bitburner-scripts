/** @type NS */
let ns;

const cities = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];
const phases = ['rank', 'overclock', 'blackop'];
const phase = phases[2];

function getStaminaPercentage() {
  const [cur, max] = ns.bladeburner.getStamina();
  return cur / max;
}

function canWork() {
  return getStaminaPercentage(ns) > 0.5;
}

function shouldTrain() {
  const [_, max] = ns.bladeburner.getStamina();
  return max > 400;
}

function getCitiesWithCommunities() {
  return cities.filter(city => ns.bladeburner.getCityCommunities(city) > 0);
}

function rest() {
  return {
    type: 'general',
    name: shouldTrain() ? 'Training' : 'Hyperbolic Regeneration Chamber'
  };
}

const getChance = (type, name) =>
  ns.bladeburner.getActionEstimatedSuccessChance(type, name)[0];

function work() {
  let validCitiesForRaid = getCitiesWithCommunities();
  const jobs =
    ns.bladeburner.getContractNames()
      .map((job, i) => {
        return {
          type: 'contract',
          name: job,
          rank: i,
          amount: ns.bladeburner.getActionCountRemaining('contract', job),
          chance: getChance('contract', job)
        };
      })
      .concat(
        ns.bladeburner.getOperationNames()
          .map((job, i) => {
            return {
              type: 'operation',
              name: job,
              rank: i+10,
              amount: ns.bladeburner.getActionCountRemaining('operation', job),
              chance: getChance('operation', job)
            };
          })
      )
      .filter(x => x.amount > 0)
      .filter(x => !(x.name == 'Raid' && validCitiesForRaid.length == 0));
  let blackops = ns.bladeburner.getBlackOpNames()
    .filter(op => ns.bladeburner.getActionCountRemaining('blackop', op) > 0 && ns.bladeburner.getRank() > ns.bladeburner.getBlackOpRank(op));
  let op = blackops.length > 0 && blackops[0];
  let chance = op ? getChance('blackop', op) : 0;
  let bestJob;
  if ((phase == 'blackop' && chance > 0) || (ns.bladeburner.getSkillLevel('Overclock') == 90 && chance > .95)) {
    bestJob = { type: 'blackop', name: op, amount: 1, chance: chance };
  }

  if (jobs.length == 0)
    return rest();

  // Pick the highest rank (last in the array) job with 80%+ success chance.
  // Fall back to the highest rank job with the best success rate (which can be tied).
  jobs.sort((a, b) => b.rank - a.rank);
  let maxChance = jobs.reduce((max, job) => job.chance > max ? job.chance : max, 0);
  let fallbackJob = jobs.filter(job => job.chance >= maxChance)[0];
  bestJob = bestJob || jobs.find(x => x.chance >= .8) || fallbackJob;

  if (bestJob.name == 'Raid' && !validCitiesForRaid.includes(ns.bladeburner.getCity()))
    ns.bladeburner.switchCity(validCitiesForRaid[0]);

  return bestJob;
}

const forceOverclock = true;
function checkSkills() {
  let maxAll = 50;
  let skillList = {
    "Blade's Intuition": maxAll,
    "Cloak": 25,
    "Short-Circuit": 25,
    "Digital Observer": maxAll,
    "Tracer": 10,
    "Reaper": maxAll,
    "Evasive System": maxAll,
  };
  if (ns.bladeburner.getSkillLevel('Overclock') < 90 && (phase == 'overclock' || getChance('operation', 'Assassination') > .95)) {
    skillList = {"Overclock": 90};
  }
  const skills = Object.keys(skillList).map(skill => {
    return {
      name: skill,
      level: () => ns.bladeburner.getSkillLevel(skill),
      maxLevel: skillList[skill],
      cost: () => ns.bladeburner.getSkillUpgradeCost(skill)
    };
  });
  for (var i = 0; i < 100; i++) {
    let bestSkill = skills
      .filter((s) => s.level() < s.maxLevel)
      .filter((s) => s.cost() <= ns.bladeburner.getSkillPoints())
      .reduce((a, b) => a && a.level() < b.level() ? a : b, null);
    if (!bestSkill)
      break;
    ns.bladeburner.upgradeSkill(bestSkill.name);
  }
}

function maybeBuyHashes() {
  const upgrades = ['Exchange for Bladeburner Rank', 'Exchange for Bladeburner SP'];
  const rankPerSP = 6;
  for (let i = 0; i < 100; i++) {
    // Buy the upgrade with the best SP-to-cost ratio.
    let which =
      ((100/rankPerSP / ns.hacknet.hashCost(upgrades[0])) > 10/ns.hacknet.hashCost(upgrades[1])
        && ns.hacknet.hashCost(upgrades[0]) < ns.hacknet.hashCapacity())
        ? upgrades[0] : upgrades[1];
    if (ns.hacknet.numHashes() < ns.hacknet.hashCost(which))
      break;
    ns.hacknet.spendHashes(which);
  }
}

export async function main(_ns) {
  ns = _ns;
  // Set max autolevel of everything.
  ns.bladeburner.getContractNames().forEach(contract =>
    ns.bladeburner.setActionAutolevel("contract", contract, true)
  );
  ns.bladeburner.getOperationNames().forEach(operation =>
    ns.bladeburner.setActionAutolevel("operation", operation, true)
  );
  while (true) {
    let job = canWork() ? work() : rest();
  // If we're already doing it, don't interrupt. We might be out of sync with the start time (can happen with bonus time).
    if (ns.bladeburner.getCurrentAction().name != job.name)
      ns.bladeburner.startAction(job.type, job.name);
    let sleepTime = ns.bladeburner.getActionTime(job.type, job.name);
    if (ns.bladeburner.getBonusTime() > sleepTime)
      sleepTime /= 5;
    await ns.sleep(sleepTime + 100);
    maybeBuyHashes();
    checkSkills();
  }
}