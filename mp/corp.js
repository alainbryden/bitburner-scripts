import { formatMoney } from '/alain/helpers.js'

/** @type NS **/
let ns;

const sum = a => a.reduce((acc, x) => acc + x);

let noBuys = true;
let options;
let totalCost = 0;
const argsSchema = [
  ['s', 'MAX'], // sell price
  ['n', false], // no-buys
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
  noBuys = options.n;
  const sellAmt = options.s;
  const phase = options.p;

  const divName = ns.args[0];
  const division = ns.corporation.getDivision(divName);

  totalCost = 0;
  if (division.type == 'Agriculture') {
    const employeeGoals = {
      'other': phase == 1 ? [2, 2, 2, 1, 0] : [2, 2, 4, 1, 0],
      // 'other': [2, 2, 1, 2, 0],
    };
    const materialGoals = { // ???
      'Hardware': 930,
      'Robots': 72,
      'AI Cores': 630,
      'Real Estate': 23000,
    }

    ns.tprint(`Selling all Agri materials: ${sellAmt} per cycle`);
    for (var cityName of division.cities) {
      ns.corporation.sellMaterial(divName, cityName, 'Plants', sellAmt, 'MP');
      ns.corporation.sellMaterial(divName, cityName, 'Food', sellAmt, 'MP');
    }
    await hireEmployees(division, employeeGoals);
    await setupWarehouse(division, materialGoals, phase == 1 ? 600 : 1400);
  } else if (division.type == 'Tobacco') {
    const amt = [10, 25, 30][phase];
    const researchers = [10, 60, 90][phase];
    const wh = 1; // make sure warehouse upgrade = wh*10
    const employeeGoals = {
      'Aevum': [amt, amt, amt, amt, amt],
      'other': [2, 2, 2, 2, researchers],
    };
    const materialGoals = { //costs $40b
      'Hardware': 2000,
      'Robots': 600,
      'AI Cores': 1200,
      'Real Estate': 40000,
    }
    await hireEmployees(division, employeeGoals);
    await setupWarehouse(division, materialGoals, 2500 * wh);
  }
  ns.tprint(`Corp costs: ${formatMoney(totalCost)}`);
}

const jobNames = [
  'Operations',
  'Engineer',
  'Business',
  'Management',
  'Research & Development',
];

function addCost(str, cost) {
  totalCost += cost;
  ns.tprint(`${str} costs ${formatMoney(cost)}; total cost ${formatMoney(totalCost)}`);
}

/** @param {Division} division **/
async function hireEmployees(division, employeeGoals) {
  for (var cityName of division.cities) {
    let office = ns.corporation.getOffice(division.name, cityName);
    let goals = employeeGoals[cityName] || employeeGoals['other'];
    let goalSize = sum(goals);
    let employeesNeeded = goalSize - office.size;
    if (employeesNeeded > 0) {
      addCost(`Upgrading ${division.name};${cityName} to ${goalSize}`,
        ns.corporation.getOfficeSizeUpgradeCost(division.name, cityName, employeesNeeded));
      if (!noBuys)
        ns.corporation.upgradeOfficeSize(division.name, cityName, employeesNeeded);
    }
    ns.tprint(`Hiring ${employeesNeeded} employees in ${cityName}`);
    while (employeesNeeded-- > 0)
      ns.corporation.hireEmployee(division.name, cityName);
    while (await assignJob(division, cityName, employeeGoals))
      ;
  }
}

/** @param {Division} division **/
async function assignJob(division, cityName, employeeGoals) {
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
async function setupWarehouse(division, materialGoals, warehouseSize) {
  for (var cityName of division.cities) {
    let warehouse = ns.corporation.getWarehouse(division.name, cityName);
    let perLevel = warehouse.size / warehouse.level;
    let timesToBuy = Math.max(0, warehouseSize - warehouse.size) / perLevel;
    addCost(`Ensuring ${warehouseSize} storage in ${cityName} (${timesToBuy} upgrades)`,
      ns.corporation.getUpgradeWarehouseCost(division.name, cityName) * timesToBuy);
    if (!noBuys) {
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
        ns.tprint(`Buying ${need} ${matName} in ${cityName}; have ${mat.qty}, want ${materialGoals[matName]}`);
        if (!noBuys)
          ns.corporation.buyMaterial(division.name, cityName, matName, need / 10);
      }
    }
    if (!noBuys)
      await ns.sleep(10000);
  }
}