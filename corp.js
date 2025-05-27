import {
	log, disableLogs, instanceCount, getConfiguration, getNsDataThroughFile, getActiveSourceFiles,
	getStocksValue, formatNumberShort, formatMoney, getFilePath
} from './helpers.js'

/**
 *
 * @param {NS} ns
 * @returns {Promise<void>}
 */
export async function main(ns) {
	ns.disableLog('ALL');
	ns.print("CORP: Starting corporation automation script...");

	// Check if we have required source file
	const unlocked = ns.singularity.getOwnedSourceFiles().some(s => s.n === 3 && s.lvl === 3);
	if (!unlocked) {
		ns.print("ERROR: Requires Source-File 3.3 to run this script");
		throw new Error(`This script requires the 3.3`);
	}

	// Initialize corporation
	let player = ns.getPlayer();
	ns.print(`CORP: Current player funds: ${formatMoney(player.money)}`);

	while (!ns.corporation.hasCorporation()) {
		const personalMoney = ns.getServerMoneyAvailable("home");
		const stockMoney = await getStocksValue(ns);
		if ((personalMoney + stockMoney) > 150e9) {
			ns.run("stockmaster.js", 1, "--liquidate");
		}
		player = ns.getPlayer();
		if (player.money > 150e9) {
			ns.print("CORP: Sufficient funds ($150b), creating corporation...");
			ns.corporation.createCorporation("MyCorp");
			ns.print("CORP: Corporation created successfully!");
		} else {
			const needed = 150e9 - player.money - stockMoney;
			const waitTime = 60;
			ns.print(`CORP: Insufficient funds (need ${formatMoney(150e9)}, ${formatMoney(needed)} short). Waiting ${waitTime} seconds...`);
			await ns.sleep(waitTime * 1000);
		}
	}
	if (!unlocked && !ns.corporation.hasUnlock('Warehouse API')) throw new Error(`This script requires the Warehouse API`);
	if (!unlocked && !ns.corporation.hasUnlock('Office API')) throw new Error(`This script requires the Office API`);
	// Initial setup
	ns.print("CORP: Initializing corporation setup...");
	const cities = getCities();
	const jobs = getJobs();
	const division1 = 'Agriculture';
	const division2 = 'Tobacco';

	ns.print(`CORP: Operating in cities: ${cities.join(", ")}`);
	ns.print(`CORP: Available job positions: ${Object.values(jobs).join(", ")}`);

	// Execute corporation development plan
	ns.print(`CORP: Starting Phase 1: ${division1} division development`);
	const phase1Start = Date.now();
	await part1(ns, cities, jobs, division1);
	ns.print(`CORP: Completed Phase 1 in ${formatTime(ns, Date.now() - phase1Start)}`);
	ns.run("corp-morale-manager.js", 1);
	ns.print(`CORP: Starting Phase 2: ${division1} division upgrade`);
	const phase2Start = Date.now();
	await part2(ns, cities, jobs, division1);
	ns.print(`CORP: Completed Phase 2 in ${formatTime(ns, Date.now() - phase2Start)}`);

	ns.print(`CORP: Starting Phase 3: ${division2} division development`);
	const phase3Start = Date.now();
	await part3(ns, cities, jobs, division2);
	ns.print(`CORP: Completed Phase 3 in ${formatTime(ns, Date.now() - phase3Start)}`);

	ns.print(`CORP: Starting autopilot mode for ${division2} division`);
	await autopilot(ns, cities, jobs, division2);
}

/**
 *
 * @param {NS} ns
 * @param {string[]} cities
 * @param {Object<string>} jobs
 * @param {string} division
 * @returns {Promise<void>}
 */
export async function part1(ns, cities, jobs, division) {
	const corp = ns.corporation;
	ns.print(`CORP: Starting Phase 1 setup for ${division} division`);

	// Expand to Agriculture division
	ns.print(`CORP: Expanding to ${division} industry...`);
	await expandIndustry(ns, 'Agriculture', division);
	ns.print(`CORP: Successfully expanded to ${division} industry`);

	// Unlock Smart Supply
	ns.print("CORP: Unlocking Smart Supply upgrade...");
	await unlockUpgrade(ns, 'Smart Supply');
	ns.print("CORP: Smart Supply unlocked successfully");

	// Turn on Smart Supply
	ns.print("CORP: Enabling Smart Supply for Sector-12...");
	corp.setSmartSupply(division, 'Sector-12', true);
	ns.print("CORP: Smart Supply enabled for Sector-12");
	// Expand to all cities
	ns.print(`CORP: Expanding ${division} division to all cities...`);
	for (let city of cities) {
		ns.print(`CORP: Processing city ${city}...`);

		// Expand to city
		ns.print(`CORP: Expanding to ${city}...`);
		await expandCity(ns, division, city);
		ns.print(`CORP: Successfully expanded to ${city}`);

		// Purchase warehouse
		ns.print(`CORP: Purchasing warehouse in ${city}...`);
		await purchaseWarehouse(ns, division, city);
		ns.print(`CORP: Warehouse purchased in ${city}`);

		// Upgrade office and assign jobs
		const positions = [
			{ job: jobs.operations, num: 1 },
			{ job: jobs.engineer, num: 1 },
			{ job: jobs.business, num: 1 }
		];
		ns.print(`CORP: Upgrading office in ${city} with positions: ${JSON.stringify(positions)}`);
		await upgradeOffice(ns, division, city, 3, positions);
		ns.print(`CORP: Office upgraded in ${city}`);

		// Start selling materials
		ns.print(`CORP: Setting up material sales in ${city}...`);
		corp.sellMaterial(division, city, 'Food', 'MAX', 'MP');
		corp.sellMaterial(division, city, 'Plants', 'MAX', 'MP');
		ns.print(`CORP: Material sales configured in ${city}`);
	}

	// Upgrade warehouses
	ns.print(`CORP: Upgrading warehouses to level 2...`);
	for (let city of cities) {
		ns.print(`CORP: Upgrading warehouse in ${city}...`);
		await upgradeWarehouseUpto(ns, division, city, 2);
		ns.print(`CORP: Warehouse upgraded in ${city}`);
	}

	// Hire advertisement
	ns.print(`CORP: Hiring advertisement up to level 1...`);
	await hireAdVertUpto(ns, division, 1);
	ns.print(`CORP: Advertisement hired successfully`);
}

/**
 *
 * @param {NS} ns
 * @param {string[]} cities
 * @param {Object<string>} jobs
 * @param {string }division
 * @returns {Promise<void>}
 */
export async function part2(ns, cities, jobs, division) {
	ns.print(`CORP: Starting Phase 2 for ${division} division`);

	// Get and apply initial upgrades
	let upgrades = [
		{ name: 'FocusWires', level: 2 },
		{ name: 'Neural Accelerators', level: 2 },
		{ name: 'Speech Processor Implants', level: 2 },
		{ name: 'Nuoptimal Nootropic Injector Implants', level: 2 },
		{ name: 'Smart Factories', level: 2 }
	];
	ns.print(`CORP: Applying initial upgrades: ${JSON.stringify(upgrades)}`);
	await upgradeUpto(ns, upgrades);
	ns.print("CORP: Initial upgrades completed successfully");

	// First production boost
	ns.print("CORP: Starting first production boost");
	for (let city of cities) {
		const materials = [
			{ name: 'Hardware', stored: 125 },
			{ name: 'AI Cores', stored: 75 },
			{ name: 'Real Estate', stored: 27e3 }
		];
		ns.print(`CORP: Purchasing materials for ${city}: ${JSON.stringify(materials)}`);
		await buyMaterialsUpto(ns, division, city, materials);
		ns.print(`CORP: Materials purchased for ${city}`);
	}
	ns.print("CORP: First production boost completed");

	// Wait for first investment offer
	ns.print("CORP: Waiting for first investment offer ($210b)");
	await investmentOffer(ns, 210e9, 1);
	ns.print("CORP: First investment offer received");

	// Upgrade offices
	ns.print("CORP: Upgrading offices to size 9");
	for (let city of cities) {
		const positions = [
			{ job: jobs.operations, num: 2 },
			{ job: jobs.engineer, num: 2 },
			{ job: jobs.business, num: 1 },
			{ job: jobs.management, num: 2 },
			{ job: jobs.RAndD, num: 2 }
		];
		ns.print(`CORP: Upgrading office in ${city} with positions: ${JSON.stringify(positions)}`);
		await upgradeOffice(ns, division, city, 9, positions);
		ns.print(`CORP: Office upgraded in ${city}`);
	}
	ns.print("CORP: Office upgrades completed");

	// Upgrade factories and storage
	upgrades = [
		{ name: 'Smart Factories', level: 10 },
		{ name: 'Smart Storage', level: 10 }
	];
	ns.print(`CORP: Applying major upgrades: ${JSON.stringify(upgrades)}`);
	await upgradeUpto(ns, upgrades);
	ns.print("CORP: Major upgrades completed");

	// Upgrade warehouses
	ns.print("CORP: Upgrading warehouses to level 10");
	for (let city of cities) {
		ns.print(`CORP: Upgrading warehouse in ${city}`);
		await upgradeWarehouseUpto(ns, division, city, 10);
		ns.print(`CORP: Warehouse upgraded in ${city}`);
	}
	ns.print("CORP: Warehouse upgrades completed");

	// Second production boost
	ns.print("CORP: Starting second production boost");
	for (let city of cities) {
		const materials = [
			{ name: 'Hardware', stored: 2800 },
			{ name: 'Robots', stored: 96 },
			{ name: 'AI Cores', stored: 2520 },
			{ name: 'Real Estate', stored: 146400 }
		];
		ns.print(`CORP: Purchasing materials for ${city}: ${JSON.stringify(materials)}`);
		await buyMaterialsUpto(ns, division, city, materials);
		ns.print(`CORP: Materials purchased for ${city}`);
	}
	ns.print("CORP: Second production boost completed");

	// Wait for second investment offer
	ns.print("CORP: Waiting for second investment offer ($5t)");
	await investmentOffer(ns, 5e12, 2);
	ns.print("CORP: Second investment offer received");

	// Final warehouse upgrades
	ns.print("CORP: Upgrading warehouses to level 19");
	for (let city of cities) {
		ns.print(`CORP: Upgrading warehouse in ${city}`);
		await upgradeWarehouseUpto(ns, division, city, 19);
		ns.print(`CORP: Warehouse upgraded in ${city}`);
	}
	ns.print("CORP: Final warehouse upgrades completed");

	// Final production boost
	ns.print("CORP: Starting final production boost");
	for (let city of cities) {
		const materials = [
			{ name: 'Hardware', stored: 9300 },
			{ name: 'Robots', stored: 726 },
			{ name: 'AI Cores', stored: 6270 },
			{ name: 'Real Estate', stored: 230400 }
		];
		ns.print(`CORP: Purchasing materials for ${city}: ${JSON.stringify(materials)}`);
		await buyMaterialsUpto(ns, division, city, materials);
		ns.print(`CORP: Materials purchased for ${city}`);
	}
	ns.print("CORP: Phase 2 completed successfully");
}

/**
 *
 * @param {NS} ns
 * @param {string[]} cities
 * @param {Object<string>} jobs
 * @param {string} division
 * @param {string} mainCity
 * @returns {Promise<void>}
 */
export async function part3(ns, cities, jobs, division, mainCity = 'Aevum') {
	ns.print(`CORP: Starting Phase 3 for ${division} division in ${mainCity}`);

	// Expand into Tobacco industry
	ns.print(`CORP: Expanding into Tobacco industry for ${division} division`);
	await expandIndustry(ns, 'Tobacco', division);
	ns.print(`CORP: Successfully expanded into Tobacco industry`);

	// Process all cities
	for (let city of cities) {
		ns.print(`CORP: Processing city ${city}...`);

		// Expand to city
		ns.print(`CORP: Expanding to ${city}`);
		await expandCity(ns, division, city);
		ns.print(`CORP: Successfully expanded to ${city}`);

		// Purchase warehouse
		ns.print(`CORP: Purchasing warehouse in ${city}`);
		await purchaseWarehouse(ns, division, city);
		ns.print(`CORP: Warehouse purchased in ${city}`);

		// Upgrade office based on city type
		if (city === mainCity) {
			const positions = [
				{ job: jobs.operations, num: 6 },
				{ job: jobs.engineer, num: 6 },
				{ job: jobs.business, num: 6 },
				{ job: jobs.management, num: 6 },
				{ job: jobs.RAndD, num: 6 }
			];
			ns.print(`CORP: Upgrading main office in ${city} to size 30 with positions: ${JSON.stringify(positions)}`);
			await upgradeOffice(ns, division, city, 30, positions);
			ns.print(`CORP: Main office upgraded in ${city}`);
		} else {
			const positions = [
				{ job: jobs.operations, num: 2 },
				{ job: jobs.engineer, num: 2 },
				{ job: jobs.business, num: 1 },
				{ job: jobs.management, num: 2 },
				{ job: jobs.RAndD, num: 2 }
			];
			ns.print(`CORP: Upgrading office in ${city} to size 9 with positions: ${JSON.stringify(positions)}`);
			await upgradeOffice(ns, division, city, 9, positions);
			ns.print(`CORP: Office upgraded in ${city}`);
		}
	}

	// Start making Tobacco v1
	if (getLatestVersion(ns, division) === 0) {
		ns.print(`CORP: Starting production of Tobacco v1 in ${mainCity}`);
		await makeProduct(ns, division, mainCity, 'Tobacco v1', 1e9, 1e9);
		ns.print(`CORP: Successfully started production of Tobacco v1`);
	} else {
		ns.print(`CORP: Skipping product creation - already have version ${getLatestVersion(ns, division)}`);
	}

	ns.print(`CORP: Phase 3 completed successfully`);
}

/**
 *
 * @param {NS} ns
 * @param {string[]} cities
 * @param {Object<string>} jobs
 * @param {string} division
 * @param {string} mainCity
 * @returns {Promise<void>}
 */
export async function autopilot(ns, cities, jobs, division, mainCity = 'Aevum') {
	ns.print(`CORP: Starting autopilot for ${division} division in ${mainCity}`);

	const corp = ns.corporation;
	const upgrades = getResearch();
	const minResearch = 50e3;
	let maxProducts = 3;

	// Check product capacity upgrades
	if (corp.hasResearched(division, upgrades.capacity1)) {
		ns.print(`CORP: Capacity I upgrade detected, increasing max products`);
		maxProducts++;
	}
	if (corp.hasResearched(division, upgrades.capacity2)) {
		ns.print(`CORP: Capacity II upgrade detected, increasing max products`);
		maxProducts++;
	}

	// Get latest product version
	let version = getLatestVersion(ns, division);
	ns.print(`CORP: Current product version: Tobacco v${version}`);

	// Main autopilot loop
	while (true) {
		const productName = `Tobacco v${version}`;

		// Check if current product is ready
		if (corp.getProduct(division, mainCity, productName).developmentProgress >= 100) {
			ns.print(`CORP: ${productName} development complete, starting sales`);

			// Start selling the product
			corp.sellProduct(division, mainCity, productName, 'MAX', 'MP*' + (2 ** (version - 1)), true);

			// Apply Market-TA II if researched
			if (corp.hasResearched(division, upgrades.market2)) {
				ns.print(`CORP: Applying Market-TA II to ${productName}`);
				corp.setProductMarketTA2(division, productName, true);
			}

			// Discontinue oldest product if at max capacity
			if (corp.getDivision(division).products.length === maxProducts) {
				const oldestVersion = getEarliestVersion(ns, division);
				ns.print(`CORP: Max products reached, discontinuing Tobacco v${oldestVersion}`);
				corp.discontinueProduct(division, `Tobacco v${oldestVersion}`);
			}

			// Start developing next version
			const newVersion = version + 1;
			const investment = 1e9 * 2 ** version;
			ns.print(`CORP: Starting development of Tobacco v${newVersion} with $${formatNumberShort(investment)} investment`);
			await makeProduct(ns, division, mainCity, `Tobacco v${newVersion}`, investment, investment);

			version = newVersion;
			ns.print(`CORP: Updated to version ${version}`);
		}

		// Use hashes to boost research if needed
		if (ns.hacknet.numHashes() >= ns.hacknet.hashCost('Exchange for Corporation Research') &&
			corp.getDivision(division).research < 3 * minResearch) {
			ns.print(`CORP: Spending hashes to boost research`);
			ns.hacknet.spendHashes('Exchange for Corporation Research');
		}

		// Research lab if possible
		if (!corp.hasResearched(division, upgrades.lab) &&
			corp.getDivision(division).research - corp.getResearchCost(division, upgrades.lab) >= minResearch) {
			ns.print(`CORP: Researching Lab`);
			corp.research(division, upgrades.lab);
		}

		// Research Market TAs if possible
		let researchCost = 0;
		if (!corp.hasResearched(division, upgrades.market1)) researchCost += corp.getResearchCost(division, upgrades.market1);
		if (!corp.hasResearched(division, upgrades.market2)) researchCost += corp.getResearchCost(division, upgrades.market2);

		if (corp.hasResearched(division, upgrades.lab) && researchCost > 0 &&
			corp.getDivision(division).research - researchCost >= minResearch) {

			if (!corp.hasResearched(division, upgrades.market1)) {
				ns.print(`CORP: Researching Market-TA I`);
				corp.research(division, upgrades.market1);
			}

			if (!corp.hasResearched(division, upgrades.market2)) {
				ns.print(`CORP: Researching Market-TA II`);
				corp.research(division, upgrades.market2);

				// Apply TA2 to all products
				ns.print(`CORP: Applying Market-TA II to all products`);
				for (const product of corp.getDivision(division).products) {
					corp.setProductMarketTA2(division, product, true);
				}
			}
		}

		// Research Fulcrum if possible
		if (corp.hasResearched(division, upgrades.market2) && !corp.hasResearched(division, upgrades.fulcrum) &&
			corp.getDivision(division).research - corp.getResearchCost(division, upgrades.fulcrum) >= minResearch) {
			ns.print(`CORP: Researching Fulcrum`);
			corp.research(division, upgrades.fulcrum);
		}

		// Research Capacity upgrades if possible
		if (corp.hasResearched(division, upgrades.fulcrum) && !corp.hasResearched(division, upgrades.capacity1) &&
			corp.getDivision(division).research - corp.getResearchCost(division, upgrades.capacity1) >= minResearch) {
			ns.print(`CORP: Researching Capacity I`);
			corp.research(division, upgrades.capacity1);
			maxProducts++;
			ns.print(`CORP: Max products increased to ${maxProducts}`);
		}

		if (corp.hasResearched(division, upgrades.capacity1) && !corp.hasResearched(division, upgrades.capacity2) &&
			corp.getDivision(division).research - corp.getResearchCost(division, upgrades.capacity2) >= minResearch) {
			ns.print(`CORP: Researching Capacity II`);
			corp.research(division, upgrades.capacity2);
			maxProducts++;
			ns.print(`CORP: Max products increased to ${maxProducts}`);
		}

		// Office upgrades vs advertising
		if (corp.getOfficeSizeUpgradeCost(division, mainCity, 15) < corp.getHireAdVertCost(division)) {
			if (corp.getCorporation().funds >= corp.getOfficeSizeUpgradeCost(division, mainCity, 15)) {
				ns.print(`CORP: Upgrading office size in ${mainCity} by 15`);
				corp.upgradeOfficeSize(division, mainCity, 15);

				// Hire and assign employees
				ns.print(`CORP: Hiring max employees in ${mainCity}`);
				hireMaxEmployees(ns, division, mainCity);

				const dist = Math.floor(corp.getOffice(division, mainCity).size / Object.keys(jobs).length);
				ns.print(`CORP: Assigning ${dist} employees to each job in ${mainCity}`);
				for (let job of Object.values(jobs)) {
					await corp.setAutoJobAssignment(division, mainCity, job, dist);
				}
			}
		} else if (corp.getCorporation().funds >= corp.getHireAdVertCost(division)) {
			ns.print(`CORP: Hiring advertisement`);
			corp.hireAdVert(division);
		}

		// Level upgrades
		ns.print(`CORP: Applying level upgrades with 10% of funds`);
		levelUpgrades(ns, 0.1);

		// Go public if revenue is high enough
		if (corp.getCorporation().revenue >= 1e18) {
			ns.print(`CORP: Revenue reached $1q, going public`);
			if (!corp.getCorporation().public) {
				corp.goPublic(0);
			}
		}

		// Public company actions
		if (corp.getCorporation().public) {
			// Share management
			if (corp.getCorporation().shareSaleCooldown <= 0 &&
				corp.getCorporation().sharePrice * 1e6 > ns.getPlayer().money) {
				ns.print(`CORP: Selling 1m shares (worth more than current cash)`);
				corp.sellShares(1e6);
			} else if (corp.getCorporation().issuedShares > 0 &&
				ns.getPlayer().money > 2 * corp.getCorporation().issuedShares * corp.getCorporation().sharePrice) {
				ns.print(`CORP: Buying back all issued shares`);
				corp.buyBackShares(corp.getCorporation().issuedShares);
			}

			// Unlock special features
			if (corp.getCorporation().funds >= corp.getUnlockCost('Shady Accounting') &&
				!corp.hasUnlock('Shady Accounting')) {
				ns.print(`CORP: Unlocking Shady Accounting`);
				corp.purchaseUnlock('Shady Accounting');
			}

			if (corp.getCorporation().funds >= corp.getUnlockCost('Government Partnership') &&
				!corp.hasUnlock('Government Partnership')) {
				ns.print(`CORP: Unlocking Government Partnership`);
				corp.purchaseUnlock('Government Partnership');
			}

			// Issue dividends
			const divPercent = dividendsPercentage(ns);
			ns.print(`CORP: Issuing dividends at ${divPercent}% rate`);
			corp.issueDividends(divPercent);
		}

		// Wait for next cycle
		await ns.sleep(1000);
	}
}

/**
 * Function to level the cheapest upgrade if under a certain percentage of the corp funds
 *
 * @param {NS} ns
 * @param {number} percent
 */
function levelUpgrades(ns, percent) {
	const corp = ns.corporation;
	let cheapestCost = Infinity;
	let cheapestUpgrade;
	for (const upgrade of getUpgrades()) {
		const cost = corp.getUpgradeLevelCost(upgrade);
		if (cost < cheapestCost) {
			cheapestUpgrade = upgrade;
			cheapestCost = cost;
		}
	}
	if (percent * corp.getCorporation().funds >= cheapestCost) corp.levelUpgrade(cheapestUpgrade);
}

/**
 * Function to return a list of upgrades
 *
 * @return {string[]}
 */
function getUpgrades() {
	return [
		'Smart Factories',
		'Smart Storage',
		'DreamSense',
		'Wilson Analytics',
		'Nuoptimal Nootropic Injector Implants',
		'Speech Processor Implants',
		'Neural Accelerators',
		'FocusWires',
		'ABC SalesBots',
		'Project Insight'
	];
}

/**
 *
 * @param {NS} ns
 * @returns {number}
 */
function dividendsPercentage(ns) {
	return Math.max(0, Math.min(0.99, Math.log(ns.corporation.getCorporation().revenue) / (20 * Math.log(1000))));
}

/**
 *
 * @returns {Object<string>} Jobs
 */
function getJobs() {
	return {
		operations: 'Operations',
		engineer: 'Engineer',
		business: 'Business',
		management: 'Management',
		RAndD: 'Research & Development'
	};
}


/**
 * Function to wait for enough money
 *
 * @param {NS} ns
 * @param {function} func
 * @param {*[]} args
 * @returns {Promise<void>}
 */
async function moneyFor(ns, func, ...args) {
	while (func(...args) > ns.corporation.getCorporation().funds) {
		await ns.sleep(1000);
	}
}

/**
 * Function to wait for enough money
 *
 * @param {NS} ns
 * @param {number} amount
 * @returns {Promise<void>}
 */
async function moneyForAmount(ns, amount) {
	while (amount > ns.corporation.getCorporation().funds) {
		await ns.sleep(1000);
	}
}

/**
 * Function to hire employees up to office size
 *
 * @param {NS} ns
 * @param {string} division
 * @param {string} city
 */
function hireMaxEmployees(ns, division, city) {
	const corp = ns.corporation;
	ns.print(`Hiring employees for ${division} (${city})`);
	while (corp.getOffice(division, city).numEmployees < corp.getOffice(division, city).size) {
		corp.hireEmployee(division, city);
	}
}

/**
 * Function to upgrade list of upgrades upto a certain level
 *
 * @param {NS} ns
 * @param {Object<string, number>[]} upgrades
 * @returns {Promise<void>}
 */
async function upgradeUpto(ns, upgrades) {
	const corp = ns.corporation;
	for (let upgrade of upgrades) {
		while (corp.getUpgradeLevel(upgrade.name) < upgrade.level) {
			await moneyFor(ns, corp.getUpgradeLevelCost, upgrade.name);
			corp.levelUpgrade(upgrade.name);
			ns.print(`Upgraded ${upgrade.name} to level ${corp.getUpgradeLevel(upgrade.name)}`);
		}
	}
}

/**
 * Function to buy materials upto a certain quantity
 *
 * @param {NS} ns
 * @param {string} division
 * @param {string} city
 * @param {Object<string, number>[]} materials
 * @returns {Promise<void>}
 */
async function buyMaterialsUpto(ns, division, city, materials) {
	const corp = ns.corporation;
	for (let material of materials) {
		const curStored = corp.getMaterial(division, city, material.name).stored;
		if (curStored < material.stored) {
			ns.print(`Buying ${material.name} for ${division} (${city})`);
			corp.buyMaterial(division, city, material.name, (material.stored - curStored) / 10);
		}
	}
	while (true) {
		let breakOut = true;
		for (let material of materials) {
			const curStored = corp.getMaterial(division, city, material.name).stored;
			if (curStored >= material.stored) corp.buyMaterial(division, city, material.name, 0);
			else breakOut = false;
		}
		if (breakOut) break;
		await ns.sleep(100);
	}
}

/**
 * Function to upgrade warehouse up to certain level
 *
 * @param {NS} ns
 * @param {string} division
 * @param {string} city
 * @param {number} level
 * @returns {Promise<void>}
 */
async function upgradeWarehouseUpto(ns, division, city, level) {
	const corp = ns.corporation;
	while (corp.getWarehouse(division, city).level < level) {
		await moneyFor(ns, corp.getUpgradeWarehouseCost, division, city);
		corp.upgradeWarehouse(division, city);
		ns.print(`Upgraded warehouse in ${division} (${city}) to level ${corp.getWarehouse(division, city).level}`);
	}
}

/**
 * Function to hire AdVert up to certain level
 *
 * @param {NS} ns
 * @param {string} division
 * @param {number} level
 * @returns {Promise<void>}
 */
async function hireAdVertUpto(ns, division, level) {
	const corp = ns.corporation;
	while (corp.getHireAdVertCount(division) < level) {
		await moneyFor(ns, corp.getHireAdVertCost, division);
		corp.hireAdVert(division);
		ns.print(`Hired AdVert in ${division} to level ${level}`);
	}
}

/**
 * Function to upgrade an office, hire maximum number of employees and assign them jobs
 *
 * @param {NS} ns
 * @param {string} division
 * @param {string} city
 * @param {number} size
 * @param {Object<string, number>[]} positions
 * @returns {Promise<void>}
 */
async function upgradeOffice(ns, division, city, size, positions) {
	const corp = ns.corporation;
	const upgradeSize = size - corp.getOffice(division, city).size;
	if (size < corp.getOffice(division, city).numEmployees) return []
	if (upgradeSize > 0) {
		ns.print(`Upgrading office in ${division} (${city}) to ${size}`);
		await moneyFor(ns, corp.getOfficeSizeUpgradeCost, division, city, upgradeSize);
		corp.upgradeOfficeSize(division, city, upgradeSize);
	}
	hireMaxEmployees(ns, division, city);
	const allPositions = getPositions(ns, division, city);
	for (let position of positions) {
		if (allPositions[position.job] !== position.num) await corp.setAutoJobAssignment(division, city, position.job, position.num);
	}
}

/**
 *
 * @param {NS} ns
 * @param division
 * @param city
 * @returns {Object<string, number>[]}
 */
function getPositions(ns, division, city) {
	const corp = ns.corporation;
	return corp.getOffice(division, city).employeeJobs;
	// const positions = {};	
	// const employeeNames = corp.getOffice(division, city).employees;
	// for (let employeeName of employeeNames) {
	// 	const employeePos = corp.getEmployee(division, city, employeeName).pos;
	// 	positions[employeePos] = (positions[employeePos] || 0) + 1;
	// }
	// return positions;
}

/**
 * Function to wait for an investment offer of a certain amount
 *
 * @param {NS} ns
 * @param {number} amount
 * @param {number} round
 * @returns {Promise<void>}
 */
async function investmentOffer(ns, amount, round = 5) {
	const corp = ns.corporation;
	if (corp.getInvestmentOffer().round > round) return;
	ns.print(`Waiting for investment offer of ${formatMoney(amount)}`);
	// Wait for investment
	var loopAmount = amount
	while (corp.getInvestmentOffer().funds < loopAmount) {
		ns.print(`Waiting for investment offer of fixed amount ${formatMoney(loopAmount)}`);
		if (corp.getInvestmentOffer().round > round) {
			ns.print(`Already accepted investment offer at round ${corp.getInvestmentOffer().round}, ` +
				`or it was manually accepted now.`);
			return;
		}
		// Pump in corp funds if we have hashes
		if (ns.hacknet.numHashes() >= ns.hacknet.hashCost('Sell for Corporation Funds')) {
			ns.hacknet.spendHashes('Sell for Corporation Funds');
		}
		loopAmount = amount - (corp.getCorporation().funds * (2 / 3));
		await ns.sleep(10*1000);
	}
	ns.print(`Accepted investment offer of ${formatMoney(corp.getInvestmentOffer().funds)}`);
	corp.acceptInvestmentOffer();
}

/**
 * Function to start making a product
 *
 * @param {NS} ns
 * @param {string} division
 * @param {string} city
 * @param {string} name
 * @param {number} design
 * @param {number} marketing
 * @returns {Promise<void>}
 */
async function makeProduct(ns, division, city, name, design = 0, marketing = 0) {
	const corp = ns.corporation;
	const products = corp.getDivision(division).products;
	const proposedVersion = parseVersion(name);
	let currentBestVersion = 0;
	for (let product of products) {
		let version = parseVersion(product);
		if (version > currentBestVersion) currentBestVersion = version;
	}
	if (proposedVersion > currentBestVersion) {
		await moneyForAmount(ns, design + marketing);
		corp.makeProduct(division, city, name, design, marketing);
		ns.print(`Started to make ${name} in ${division} (${city}) with ${formatMoney(design)} for design and ${formatMoney(marketing)} for marketing`);
	} else ns.print(`Already making/made ${name} in ${division} (${city})`);
}

/**
 * Function to get latest product version
 *
 * @param {NS} ns
 * @param {string} division
 * @return {number}
 */
function getLatestVersion(ns, division) {
	const products = ns.corporation.getDivision(division).products;
	let latestVersion = 0;
	for (let product of products) {
		let version = parseVersion(product);
		if (version > latestVersion) latestVersion = version;
	}
	return latestVersion;
}

/**
 * Function to get earliest product version
 *
 * @param {NS} ns
 * @param {string} division
 * @returns {number}
 */
function getEarliestVersion(ns, division) {
	const products = ns.corporation.getDivision(division).products;
	let earliestVersion = Number.MAX_SAFE_INTEGER;
	for (let product of products) {
		let version = parseVersion(product);
		if (version < earliestVersion) earliestVersion = version;
	}
	return earliestVersion;
}

/**
 * Function to parse product version from name
 *
 * @param {string} name
 * @returns {number}
 */
function parseVersion(name) {
	let version = '';
	for (let i = 1; i <= name.length; i++) {
		let slice = name.slice(-i);
		if (!isNaN(slice)) version = slice;
		else if (version === '') throw new Error(`Product name must end with version number`);
		else return parseInt(version);
	}
}

/**
 * Function to expand industry
 *
 * @param {NS} ns
 * @param {string} industry
 * @param {string} division
 * @returns {Promise<void>}
 */
async function expandIndustry(ns, industry, division) {
	const corp = ns.corporation;
	if (!corp.getCorporation().divisions.includes(division)) {
		ns.print(`Expanding to ${industry} industry: ${division}`);
		await moneyFor(ns, corp.getIndustryData, industry);
		corp.expandIndustry(industry, division);
	} else ns.print(`Already expanded to ${industry} industry: ${division}`);
}


/**
 * Function to expand city
 *
 * @param {NS} ns
 * @param {string} division
 * @param {string} city
 * @returns {Promise<void>}
 */
async function expandCity(ns, division, city) {
	const corp = ns.corporation;
	if (!corp.getDivision(division).cities.includes(city)) {
		await moneyForAmount(ns, corp.getConstants().officeInitialCost);
		corp.expandCity(division, city);
		ns.print(`Expanded to ${city} for ${division}`);
	} else ns.print(`Already expanded to ${city} for ${division}`);
}

/**
 * Function to purchase warehouse
 *
 * @param {NS} ns
 * @param {string} division
 * @param {string} city
 * @returns {Promise<void>}
 */
async function purchaseWarehouse(ns, division, city) {
	const corp = ns.corporation;
	if (!corp.hasWarehouse(division, city)) {
		await moneyForAmount(ns, corp.getConstants().warehouseInitialCost);
		corp.purchaseWarehouse(division, city);
		ns.print(`Purchased warehouse in ${division} (${city})`);
	} else ns.print(`Already purchased warehouse in ${city} for ${division}`);
}

/**
 * Function to unlock upgrade
 *
 * @param {NS} ns
 * @param {string} upgrade
 * @returns {Promise<void>}
 */
async function unlockUpgrade(ns, upgrade) {
	const corp = ns.corporation;
	if (!corp.hasUnlock(upgrade)) {
		await moneyFor(ns, corp.getUnlockCost, upgrade);
		corp.purchaseUnlock(upgrade);
		ns.print(`Purchased ${upgrade}`);
	} else ns.print(`Already purchased ${upgrade}`);
}

/**
 * Function to return important research
 *
 * @returns {Object<string>}
 */
function getResearch() {
	return {
		lab: 'Hi-Tech R&D Laboratory',
		market1: 'Market-TA.I',
		market2: 'Market-TA.II',
		fulcrum: 'uPgrade: Fulcrum',
		capacity1: 'uPgrade: Capacity.I',
		capacity2: 'uPgrade: Capacity.II'
	};
}


/**
 *
 * @returns {string[]}
 */
export function getCities() {
	return Object.values(getOrganisations()).filter(v => v.city).map(v => v.location);
}

/**
 *
 * @param {NS} ns
 * @param {number} t
 * @param {boolean} milliPrecision
 * @return {string}
 */
export function formatTime(ns, t, milliPrecision = false) {
	return isNaN(t) ? 'NaN' : ns.tFormat(t, milliPrecision);
}
/**
 *
 * @returns {Object<Object>}
 */
function getOrganisations() {
	return {
		'ECorp': {
			location: 'Aevum',
			stockSymbol: 'ECP',
			server: 'ecorp',
			faction: 'ECorp',
			company: 'ECorp',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			companyPositions: ['Business', 'IT', 'Security', 'Software']
		},
		'MegaCorp': {
			location: 'Sector-12',
			stockSymbol: 'MGCP',
			server: 'megacorp',
			faction: 'MegaCorp',
			company: 'MegaCorp',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			companyPositions: ['Business', 'IT', 'Security', 'Software']
		},
		'Blade Industries': {
			location: 'Sector-12',
			stockSymbol: 'BLD',
			server: 'blade',
			faction: 'Blade Industries',
			company: 'Blade Industries',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			companyPositions: ['Business', 'IT', 'Security', 'Software']
		},
		'Clarke Incorporated': {
			location: 'Aevum',
			stockSymbol: 'CLRK',
			server: 'clarkinc',
			faction: 'Clarke Incorporated',
			company: 'Clarke Incorporated',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			companyPositions: ['Business', 'IT', 'Security', 'Software']
		},
		'OmniTek Incorporated': {
			location: 'Volhaven',
			stockSymbol: 'OMTK',
			server: 'omnitek',
			faction: 'OmniTek Incorporated',
			company: 'OmniTek Incorporated',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			companyPositions: ['Business', 'IT', 'Security', 'Software']
		},
		'Four Sigma': {
			location: 'Sector-12',
			stockSymbol: 'FSIG',
			server: '4sigma',
			faction: 'Four Sigma',
			company: 'Four Sigma',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			companyPositions: ['Business', 'IT', 'Security', 'Software']
		},
		'KuaiGong International': {
			location: 'Chongqing',
			stockSymbol: 'KGI',
			server: 'kuai-gong',
			faction: 'KuaiGong International',
			company: 'KuaiGong International',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			companyPositions: ['Business', 'IT', 'Security', 'Software']
		},
		'Fulcrum Technologies': {
			location: 'Aevum',
			stockSymbol: 'FLCM',
			server: 'fulcrumtech',
			company: 'Fulcrum Technologies',
			companyPositions: ['Business', 'IT', 'Software']
		},
		'Storm Technologies': {
			location: 'Ishima',
			stockSymbol: 'STM',
			server: 'stormtech',
			company: 'Storm Technologies',
			companyPositions: ['Business', 'IT', 'Software Consultant', 'Software']
		},
		'DefComm': {
			location: 'New Tokyo',
			stockSymbol: 'DCOMM',
			server: 'defcomm',
			company: 'DefComm',
			companyPositions: ['IT', 'Software Consultant', 'Software']
		},
		'Helios Labs': {
			location: 'Volhaven',
			stockSymbol: 'HLS',
			server: 'helios',
			company: 'Helios Labs',
			companyPositions: ['IT', 'Software Consultant', 'Software']
		},
		'VitaLife': {
			location: 'New Tokyo',
			stockSymbol: 'VITA',
			server: 'vitalife',
			company: 'VitaLife',
			companyPositions: ['Business', 'IT', 'Software Consultant', 'Software']
		},
		'Icarus Microsystems': {
			location: 'Sector-12',
			stockSymbol: 'ICRS',
			server: 'icarus',
			company: 'Icarus Microsystems',
			companyPositions: ['Business', 'IT', 'Software Consultant', 'Software']
		},
		'Universal Energy': {
			location: 'Sector-12',
			stockSymbol: 'UNV',
			server: 'univ-energy',
			company: 'Universal Energy',
			companyPositions: ['Business', 'IT', 'Software Consultant', 'Software']
		},
		'AeroCorp': {
			location: 'Aevum',
			stockSymbol: 'AERO',
			server: 'aerocorp',
			company: 'AeroCorp',
			companyPositions: ['IT', 'Security', 'Software']
		},
		'Omnia Cybersystems': {
			location: 'Volhaven',
			stockSymbol: 'OMN',
			server: 'omnia',
			company: 'Omnia Cybersystems',
			companyPositions: ['IT', 'Security', 'Software']
		},
		'Solaris Space Systems': {
			location: 'Chongqing',
			stockSymbol: 'SLRS',
			server: 'solaris',
			company: 'Solaris Space Systems',
			companyPositions: ['IT', 'Security', 'Software']
		},
		'Global Pharmaceuticals': {
			location: 'New Tokyo',
			stockSymbol: 'GPH',
			server: 'global-pharm',
			company: 'Global Pharmaceuticals',
			companyPositions: ['Business', 'IT', 'Security', 'Software Consultant', 'Software']
		},
		'Nova Medical': {
			location: 'Ishima',
			stockSymbol: 'NVMD',
			server: 'nova-med',
			company: 'Nova Medical',
			companyPositions: ['Business', 'IT', 'Security', 'Software Consultant', 'Software']
		},
		'Watchdog Security': {
			location: 'Aevum',
			stockSymbol: 'WDS',
			company: 'Watchdog Security',
			companyPositions: ['Agent', 'IT', 'Security', 'Software Consultant', 'Software']
		},
		'LexoCorp': {
			location: 'Volhaven',
			stockSymbol: 'LXO',
			server: 'lexo-corp',
			company: 'LexoCorp',
			companyPositions: ['Business', 'IT', 'Security', 'Software Consultant', 'Software']
		},
		'Rho Construction': {
			location: 'Aevum',
			stockSymbol: 'RHOC',
			server: 'rho-construction',
			company: 'Rho Construction',
			companyPositions: ['Business', 'Software']
		},
		'Alpha Enterprises': {
			location: 'Sector-12',
			stockSymbol: 'APHE',
			server: 'alpha-ent',
			company: 'Alpha Enterprises',
			companyPositions: ['Business', 'Software Consultant', 'Software']
		},
		'SysCore Securities': {
			location: 'Volhaven',
			stockSymbol: 'SYSC',
			server: 'syscore',
			company: 'SysCore Securities',
			companyPositions: ['IT', 'Software']
		},
		'CompuTek': {
			location: 'Volhaven',
			stockSymbol: 'CTK',
			server: 'comptek',
			company: 'CompuTek',
			companyPositions: ['IT', 'Software']
		},
		'NetLink Technologies': {
			location: 'Aevum',
			stockSymbol: 'NTLK',
			server: 'netlink',
			company: 'NetLink Technologies',
			companyPositions: ['IT', 'Software']
		},
		'Omega Software': {
			location: 'Ishima',
			stockSymbol: 'OMGA',
			server: 'omega-net',
			company: 'Omega Software',
			companyPositions: ['IT', 'Software Consultant', 'Software']
		},
		'FoodNStuff': {
			location: 'Sector-12',
			stockSymbol: 'FNS',
			server: 'foodnstuff',
			company: 'FoodNStuff',
			companyPositions: ['Employee', 'part-time Employee']
		},
		'Sigma Cosmetics': { stockSymbol: 'SGC', server: 'sigma-cosmetics' },
		'Joe\'s Guns': {
			location: 'Sector-12',
			stockSymbol: 'JGN',
			server: 'joesguns',
			company: 'Joe\'s Guns',
			companyPositions: ['Employee', 'part-time Employee']
		},
		'Catalyst Ventures': { stockSymbol: 'CTYS', server: 'catalyst' },
		'Microdyne Technologies': { stockSymbol: 'MDYN', server: 'microdyne' },
		'Titan Laboratories': { stockSymbol: 'TITN', server: 'titan-labs' },
		'CyberSec': { server: 'CSEC', faction: 'CyberSec', factionWorkTypes: ['Hacking'] },
		'The Runners': { server: 'run4theh111z', faction: 'BitRunners', factionWorkTypes: ['Hacking'] },
		'Bachman & Associates': {
			location: 'Aevum',
			server: 'b-and-a',
			faction: 'Bachman & Associates',
			company: 'Bachman & Associates',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			companyPositions: ['Business', 'IT', 'Security', 'Software']
		},
		'Fulcrum Secret Technologies': {
			server: 'fulcrumassets',
			faction: 'Fulcrum Secret Technologies',
			factionWorkTypes: ['Hacking', 'Security']
		},
		'NiteSec': { server: 'avmnite-02h', faction: 'NiteSec', factionWorkTypes: ['Hacking'], gang: true },
		'I.I.I.I': { server: 'I.I.I.I', faction: 'The Black Hand', factionWorkTypes: ['Hacking', 'Field'], gang: true },
		'Slum Snakes': { faction: 'Slum Snakes', factionWorkTypes: ['Field', 'Security'], gang: true },
		'Tetrads': { faction: 'Tetrads', factionWorkTypes: ['Field', 'Security'], gang: true },
		'Speakers for the Dead': {
			faction: 'Speakers for the Dead',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			gang: true
		},
		'.': { server: '.', faction: 'The Dark Army', factionWorkTypes: ['Hacking', 'Field'], gang: true },
		'The Syndicate': { faction: 'The Syndicate', factionWorkTypes: ['Hacking', 'Field', 'Security'], gang: true },
		'Rothman University': { location: 'Sector-12', server: 'rothman-uni', university: 'Rothman University' },
		'ZB Institute of Technology': {
			location: 'Volhaven',
			server: 'zb-institute',
			university: 'ZB Institute of Technology'
		},
		'Summit University': { location: 'Aevum', server: 'summit-university', university: 'Summit University' },
		'Crush Fitness': { location: 'Aevum', server: 'crush-fitness', gym: 'Crush Fitness Gym' },
		'Millenium Fitness Network': { location: 'Volhaven', server: 'millenium-fitness', gym: 'Millenium Fitness Gym' },
		'Iron Gym Network': { location: 'Sector-12', server: 'iron-gym', gym: 'Iron Gym' },
		'Powerhouse Fitness': { location: 'Sector-12', server: 'powerhouse-fitness', gym: 'Powerhouse Gym' },
		'Snap Fitness': { location: 'Aevum', server: 'snap-fitness', gym: 'Snap Fitness Gym' },
		'Silhouette': { faction: 'Silhouette', factionWorkTypes: ['Hacking', 'Field'] },
		'Tian Di Hui': { faction: 'Tian Di Hui', factionWorkTypes: ['Hacking', 'Security'] },
		'Netburners': { faction: 'Netburners', factionWorkTypes: ['Hacking'] },
		'Aevum': {
			location: 'Aevum',
			faction: 'Aevum',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			city: true
		},
		'Sector-12': {
			location: 'Sector-12',
			faction: 'Sector-12',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			city: true
		},
		'Chongqing': {
			location: 'Chongqing',
			faction: 'Chongqing',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			city: true
		},
		'New Tokyo': {
			location: 'New Tokyo',
			faction: 'New Tokyo',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			city: true
		},
		'Ishima': {
			location: 'Ishima',
			faction: 'Ishima',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			city: true
		},
		'Volhaven': {
			location: 'Volhaven',
			faction: 'Volhaven',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			city: true
		},
		'NWO': {
			location: 'Volhaven',
			server: 'nwo',
			faction: 'NWO',
			company: 'NWO',
			factionWorkTypes: ['Hacking', 'Field', 'Security'],
			companyPositions: ['Business', 'IT', 'Security', 'Software']
		},
		'Delta One': {
			location: 'Sector-12',
			server: 'deltaone',
			company: 'Delta One',
			companyPositions: ['IT', 'Security', 'Software']
		},
		'Central Intelligence Agency': {
			location: 'Sector-12',
			company: 'Central Intelligence Agency',
			companyPositions: ['Agent', 'IT', 'Security', 'Software']
		},
		'National Security Agency': {
			location: 'Sector-12',
			company: 'National Security Agency',
			companyPositions: ['Agent', 'IT', 'Security', 'Software']
		},
		'Aevum Police Headquarters': {
			location: 'Aevum', server: 'aevum-police',
			company: 'Aevum Police Headquarters',
			companyPositions: ['Security', 'Software']
		},
		'Carmichael Security': {
			location: 'Sector-12',
			company: 'Carmichael Security',
			companyPositions: ['Agent', 'IT', 'Security', 'Software Consultant', 'Software']
		},
		'Galactic Cybersystems': {
			location: 'Aevum', server: 'galactic-cyber',
			company: 'Galactic Cybersystems',
			companyPositions: ['Business', 'IT', 'Software Consultant', 'Software']
		},
		'Noodle Bar': {
			location: 'New Tokyo', server: 'n00dles',
			company: 'Noodle Bar',
			companyPositions: ['Waiter', 'part-time Waiter']
		},
		'InfoComm': { server: 'infocomm' },
		'Taiyang Digital': { server: 'taiyang-digital' },
		'ZB Defense Industries': { server: 'zb-def' },
		'Applied Energetics': { server: 'applied-energetics' },
		'Zeus Medical': { server: 'zeus-med' },
		'UnitaLife Group': { server: 'unitalife' },
		'The Hub': { server: 'the-hub' },
		'Johnson Orthopedics': { server: 'johnson-ortho' },
		'ZER0 Nightclub': { server: 'zero' },
		'Nectar Nightclub Network': { server: 'nectar-net' },
		'Neo Nightclub Network': { server: 'neo-net' },
		'Silver Helix': { server: 'silver-helix' },
		'HongFang Teahouse': { server: 'hong-fang-tea' },
		'HaraKiri Sushi Bar Network': { server: 'harakiri-sushi' },
		'Phantasy Club': { server: 'phantasy' },
		'Max Hardware Store': { server: 'max-hardware' },
		'Helios': { server: 'The-Cave' },
		'w0r1d_d43m0n': { server: 'w0r1d_d43m0n' },
		'The Covenant': { faction: 'The Covenant', factionWorkTypes: ['Hacking', 'Field'] },
		'Daedalus': { faction: 'Daedalus', factionWorkTypes: ['Hacking', 'Field'] },
		'Illuminati': { faction: 'Illuminati', factionWorkTypes: ['Hacking', 'Field'] },
		'Iker Molina Casino': { location: 'Aevum' },
		'Sector-12 City Hall': { location: 'Sector-12' },
		'Arcade': { location: 'New Tokyo' },
		'0x6C1': { location: 'Ishima' },
		'Hospital': { general: true },
		'The Slums': { general: true },
		'Travel Agency': { general: true },
		'World Stock Exchange': { general: true },
		'Bladeburners': { location: 'Sector-12', faction: 'Bladeburners' },
		'Church of the Machine God': { location: 'Chongqing', faction: 'Church of the Machine God' },
		'Shadows of Anarchy': { faction: 'Shadows of Anarchy' }
	};
}
