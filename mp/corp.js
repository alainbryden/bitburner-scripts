import { formatMoney } from '/alain/helpers.js'

/** @type NS **/
let ns;

const sum = a => a.reduce((acc, x) => acc + x);

let options;
let totalCost = 0;
const argsSchema = [
  ['s', 'MAX'], // sell amount
  ['n', false], // no buying, just cost print
  ['p', 0], // phase
];

// Step 1: Agri phase=0
// - upgrades to 2
// - employees 2/2/2/1
// - coffee+parties
// - warehouse buys at 600
// Step 2: Agri (100b) phase=1
// - employees 2/2/4/1
// - warehouse to 1200
// Step 3: Tobacco (500b) phase=0
// - upgrades = 10
// - employees amt=10
// - warehouse buys at wh=1
// Step 4: Tobacco (7t) phase=1
// - employes amt=25, researchers=60
// Step 5: Tobacco (12t) phase=2
// - employes amt=40, researchers=90

export async function main(_ns) {
  ns = _ns;

  options = ns.flags(argsSchema);
  options.noBuys = options.n;
  options.sellAmt = options.s;
  options.phase = options.p;

  const corp = ns.corporation.getCorporation();
  const division = pickDivision(corp);
  totalCost = 0;
  if (division.type == 'Agriculture') {
    const ups = options.phase == 0 ? 2 : 5;
    const upgradeGoals = {
      'Smart Factories': ups,
      'Smart Storage': 0,
      'DreamSense': 0,
      'Wilson Analytics': 0,
      'Nuoptimal Nootropic Injector Implants': ups,
      'Speech Processor Implants': ups,
      'Neural Accelerators': ups,
      'FocusWires': ups,
      'ABC SalesBots': 0,
      'Project Insight': 0,
    }
    const employeeGoals = {
      'other': options.phase == 0 ? [2, 1, 2, 1, 0] : [2, 1, 4, 1, 0],
    };
    const materialGoals = { // ???
      'Hardware': 930,
      'Robots': 72,
      'AI Cores': 630,
      'Real Estate': 23000,
    }

    ns.tprint(`Selling all Agri materials: ${options.sellAmt} per cycle`);
    for (var cityName of division.cities) {
      ns.corporation.sellMaterial(division.name, cityName, 'Plants', options.sellAmt, 'MP');
      ns.corporation.sellMaterial(division.name, cityName, 'Food', options.sellAmt, 'MP');
    }
    await buyUpgrades(division, upgradeGoals);
    await hireEmployees(division, employeeGoals, options.phase == 0);  // wait for morale before spending all our cash in first phase
    await setupWarehouse(division, materialGoals, options.phase == 0 ? 600 : 1400);
  } else if (division.type == 'Tobacco') {
    const aevum = [10, 25, 30][options.phase];
    const researchers = [10, 60, 90][options.phase];
    const upgradeGoals = {
      'Nootropic': 10,
    }
    const employeeGoals = {
      'Aevum': [aevum, aevum, aevum, aevum, aevum],
      'other': [2, 2, 2, 2, researchers],
    };
    const materialGoals = { //costs $40b
      'Hardware': 2000,
      'Robots': 600,
      'AI Cores': 1200,
      'Real Estate': 40000,
    }
    await buyUpgrades(division, upgradeGoals);
    await hireEmployees(division, employeeGoals, false);
    await setupWarehouse(division, materialGoals, options.phase == 0 ? 2500 : 10000);
  }
  ns.tprint(`Corp costs: ${formatMoney(totalCost)}`);
}

function addCost(str, cost) {
  totalCost += cost;
  ns.tprint(`${str}; costs ${formatMoney(cost)}; total cost ${formatMoney(totalCost)}`);
}

/** @param {Corporation} corp **/
function pickDivision(corp) {
  const cities = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];

  let division;
  if (corp.divisions.length == 0) {
    ns.corporation.expandIndustry('Agriculture', 'A');
    division = ns.corporation.getDivision('A');
  } else if (corp.divisions.length == 1) {
    division = corp.divisions[0];
  } else {
    division = corp.divisions.find(d => d.type == 'Tobacco');
  }

  // One-time setup.
  if (!ns.corporation.hasUnlockUpgrade('Smart Supply'))
    ns.corporation.unlockUpgrade('Smart Supply');
  if (ns.corporation.getHireAdVertCount(division.name) < 1)
    ns.corporation.hireAdVert(division.name);
  for (var cityName of cities) {
    if (!division.cities.includes(cityName))
      ns.corporation.expandCity(division.name, cityName);
    if (!ns.corporation.hasWarehouse(division.name, cityName))
      ns.corporation.purchaseWarehouse(division.name, cityName);
  }  
  return ns.corporation.getDivision(division.name); // refresh
}

/** @param {Division} division **/
async function buyUpgrades(division, upgradeGoals) {
  let cost = 0;
  for (var up in upgradeGoals) {
    const goal = upgradeGoals[up] || 0;
    cost += ns.corporation.getUpgradeLevelCost(up) * Math.max(0, goal - ns.corporation.getUpgradeLevel(up));
    if (!options.noBuys) {
      while (ns.corporation.getUpgradeLevel(up) < goal)
        ns.corporation.levelUpgrade(up);
    }
  }
  addCost(`Upgrading stuff (estimated)`, cost);
}

/** @param {Division} division **/
async function hireEmployees(division, employeeGoals, waitForMorale) {
  // Upgrade office size first.
  for (var cityName of division.cities) {
    let office = ns.corporation.getOffice(division.name, cityName);
    let goals = employeeGoals[cityName] || employeeGoals['other'];
    let goalSize = sum(goals);
    let employeesNeeded = goalSize - office.size;
    if (employeesNeeded > 0) {
      addCost(`Hiring employees in ${division.name};${cityName} to ${goalSize}`,
        ns.corporation.getOfficeSizeUpgradeCost(division.name, cityName, employeesNeeded));
      if (!options.noBuys)
        ns.corporation.upgradeOfficeSize(division.name, cityName, employeesNeeded);
    }
  }
  // Hire and assign employees.
  let jobPromises = [];
  for (var cityName of division.cities) {
    while (ns.corporation.hireEmployee(division.name, cityName))
      ;
    while (await assignJob(division, cityName, employeeGoals))
      ;
  }
  for (var cityName of division.cities) {
    while (waitForMorale && await waitForEmployeeMorale(division, cityName))
      ;
  }
}

/** @param {Division} division **/
async function assignJob(division, cityName, employeeGoals) {
  const jobNames = ['Operations', 'Engineer', 'Business', 'Management', 'Research & Development'];

  let office = ns.corporation.getOffice(division.name, cityName);
  let goals = employeeGoals[cityName] || employeeGoals['other'];
  let jobCounts = {};
  office.employees.forEach((ename) => {
    let e = ns.corporation.getEmployee(division.name, cityName, ename);
    jobCounts[e.pos] = (jobCounts[e.pos] || 0) + 1;
  });
  let employee = office.employees.find((ename) => {
    let e = ns.corporation.getEmployee(division.name, cityName, ename);
    return e.pos == 'Unassigned';
  });
  let jobIndex = goals.findIndex((_, i) => (jobCounts[jobNames[i]] || 0) < goals[i]);
  if (jobIndex >= 0 && employee) {
    let job = jobNames[jobIndex];
    ns.tprint(`${cityName}: Assigned to ${job}`);
    await ns.corporation.assignJob(division.name, cityName, employee, job);
    return true;
  }
  return false;
}

/** @param {Division} division **/
async function waitForEmployeeMorale(division, cityName) {
  let office = ns.corporation.getOffice(division.name, cityName);
  const avgProd = office.employees.reduce((total, ename) => {
    const e = ns.corporation.getEmployee(division.name, cityName, ename);
    return total + (e.ene + e.hap + e.mor)/3 / office.employees.length;
  }, 0);
  if (avgProd < 95) {
    ns.tprint(`Waiting for employee morale in to hit 95%. Current average in ${cityName}: ${avgProd}.`);
    await ns.sleep(10000);
    return true;
  }
  return false;
}

/** @param {Division} division **/
async function setupWarehouse(division, materialGoals, warehouseSize) {
  for (var cityName of division.cities) {
    let warehouse = ns.corporation.getWarehouse(division.name, cityName);
    let perLevel = warehouse.size / warehouse.level;
    let timesToBuy = Math.max(0, warehouseSize - warehouse.size) / perLevel;
    addCost(`Ensuring ${warehouseSize} storage in ${cityName} (${timesToBuy} upgrades)`,
      ns.corporation.getUpgradeWarehouseCost(division.name, cityName) * timesToBuy);
    if (!options.noBuys) {
      while (true) {
        let warehouse = ns.corporation.getWarehouse(division.name, cityName);
        if (warehouse.size >= warehouseSize)
          break;
        ns.corporation.upgradeWarehouse(division.name, cityName);
        await ns.sleep(10);
      }
    }
  }
  for (let i = 0; i < 2; i++) {
    for (var cityName of division.cities) {
      for (var matName of Object.keys(materialGoals)) {
        let mat = ns.corporation.getMaterial(division.name, cityName, matName);
        let need = i == 1 ? 0 : Math.max(0, materialGoals[matName] - mat.qty);
        if (i == 0 && need > 0)
          ns.tprint(`Buying ${need} ${matName} in ${cityName}; have ${mat.qty}, want ${materialGoals[matName]}`);
        if (!options.noBuys)
          ns.corporation.buyMaterial(division.name, cityName, matName, need / 10);
      }
    }
    if (!options.noBuys)
      await ns.sleep(10000);
  }
}