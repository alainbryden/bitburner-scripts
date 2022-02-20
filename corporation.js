/**
 * Set up and run a corporation. Note that access to the corporation API costs tons of RAM.
 *
 * TODO: Make daemon.js reserve memory for a corporate script to run someplace if we have enough RAM.
 * TODO: Given the memory used, would it make more sense to run this script occassionally -- like every 10 seconds, instead of with a loop?
 */

import { formatMoney, formatNumberShort, getActiveSourceFiles } from './helpers.js';

// Formatting for money and big numbers.
const mf = (n) => formatMoney(n, 6, 2);
const nf = (n) => formatNumberShort(n, 3);
const _ = globalThis._; // lodash
/** @typedef {import('./index.js').NS} NS */
/** @typedef {import('./index.js').Division} Division */
/** @typedef {import('./index.js').CorporationInfo} CorporationInfo */

// Global constants
export const argsSchema = [
    ['corporation-name', 'Turing Complete'], // Corporation name, if we have to create a new one.
    ['no-expansion', false], // If this flag is set, do not expand to new industries. Just work on what we have.
    ['reserve-amount', 1e9], // Don't spend the corporation's last $billion if we can help it.
    ['v', false], // Print extra log messages.
    ['verbose', false],
    ['can-accept-funding', true], // When we run low on money, should we look for outside funding?
    ['can-go-public', true], // If we can't get private funding, should we go public?
    ['issue-shares', 0], // If we go public, how many shares should we issue?
    ['can-spend-hashes', true], // Can we spend hacknet hashes (assuming we have them)?
    ['o', false],
    ['once', false], // Run once, then quit, instead of going into a loop.
    ['mock', false], // Run the task assignment queue, but don't actually spend any money.
    ['price-discovery-only', false], // Don't do any auto-buying, just try to keep the sale price balanced as high as possible. (Emulating TA2 as best we can)
    ['first', 'Agriculture'], // What should we use for our first division? Agriculture works well, but others should be fine too.
    ['second', 'RealEstate'], // What should we prefer for our second division? If we can't afford it, we'll buy what we can afford instead.
];

const desiredDivisions = 2; // One Material division to kickstart things, then a product division to really make money.

const bonusMaterials = ['Hardware', 'Robots', 'AICores', 'RealEstate'];
const materialSizes = { Water: 0.05, Energy: 0.01, Food: 0.03, Plants: 0.05, Metal: 0.1, Hardware: 0.06, Chemicals: 0.05, Drugs: 0.02, Robots: 0.5, AICores: 0.1, RealEstate: 0.005 };
const allMaterials = ['Water', 'Energy', 'Food', 'Plants', 'Metal', 'Hardware', 'Chemicals', 'Drugs', 'Robots', 'AICores', 'RealEstate'];
// Map of material (by name) to their sizes (how much space it takes in warehouse)
const unlocks = ['Export', 'Smart Supply', 'Market Research - Demand', 'Market Data - Competition', 'VeChain', 'Shady Accounting', 'Government Partnership', 'Warehouse API', 'Office API'];
const upgrades = ['Smart Factories', 'Smart Storage', 'DreamSense', 'Wilson Analytics', 'Nuoptimal Nootropic Injector Implants', 'Speech Processor Implants', 'Neural Accelerators', 'FocusWires', 'ABC SalesBots', 'Project Insight'];
const cities = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];
const hqCity = 'Aevum'; // Our production industries will need a headquarters. It doesn't matter which city we use, AFAICT.
const jobs = ['Operations', 'Engineer', 'Research & Development', 'Management', 'Business']; // Also, 'Training', but that's not a real job.

// Classes here, since we want to use Industry shortly.
class Industry {
    constructor(name = '', robFac = 0.0, aiFac = 0.0, advFac = 0.0, sciFac = 0.0, hwFac = 0.0, reFac = 0.0, reqMats = {}, prodMats = [], makesProducts = false, startupCost = 0) {
        this.name = name;
        this.factors = {
            Hardware: hwFac,
            Robots: robFac,
            AICores: aiFac,
            RealEstate: reFac,
            Science: sciFac,
            Advertising: advFac,
        };
        this.reqMats = reqMats;
        this.prodMats = prodMats;
        this.makesProducts = makesProducts;
        this.startupCost = startupCost;
        this.materialBonusPerSqMeter = {};
        for (const material of bonusMaterials) {
            this.materialBonusPerSqMeter[material] = this.factors[material] / materialSizes[material];
        }
        let scaleFactor = Object.values(this.materialBonusPerSqMeter).reduce((sum, prod) => sum + prod, 0);
        this.scaledMaterialBonus = {};
        for (const material of bonusMaterials) {
            this.scaledMaterialBonus[material] = this.materialBonusPerSqMeter[material] / scaleFactor;
        }
    }
    static fromObject(obj) {
        return new Industry(obj.name, obj.robFac, obj.aiFac, obj.advFac, obj.sciFac, obj.hwFac, obj.reFac, obj.reqMats, obj.prodMats, obj.makesProducts, obj.startupCost);
    }
}
class Task {
    /**
     * A Task that we will try to run later.
     * @param {string} name Human readable name of the task to be run.
     * @param {function} run callback to run the task.
     * @param {number} cost allocated budget for this task
     * @param {number} priority priority, higher number is a higher priority
     */
    constructor(name, run, cost = 0, priority = 0) {
        this.name = name;
        this.run = run;
        this.cost = cost;
        this.priority = priority; // Higher will be done sooner.
    }
}

// Industry and Material data copied from Bitburner's code on February 10, 2022. (https://github.com/danielyxie/bitburner/blob/dev/src/Corporation/Industry.ts) with startupCost added manually.
/** @type {Industry[]} */
const industries = [
    Industry.fromObject({ name: 'Agriculture', reFac: 0.72, sciFac: 0.5, hwFac: 0.2, robFac: 0.3, aiFac: 0.3, advFac: 0.04, reqMats: { Water: 0.5, Energy: 0.5 }, prodMats: ['Plants', 'Food'], startupCost: 40e9 }),
    Industry.fromObject({ name: 'Chemical', reFac: 0.25, sciFac: 0.75, hwFac: 0.2, robFac: 0.25, aiFac: 0.2, advFac: 0.07, reqMats: { Plants: 1, Energy: 0.5, Water: 0.5 }, prodMats: ['Chemicals'], startupCost: 70e9 }),
    Industry.fromObject({ name: 'Fishing', reFac: 0.15, sciFac: 0.35, hwFac: 0.35, robFac: 0.5, aiFac: 0.2, advFac: 0.08, reqMats: { Energy: 0.5 }, prodMats: ['Food'], startupCost: 80e9 }),
    Industry.fromObject({ name: 'Utilities', reFac: 0.5, sciFac: 0.6, robFac: 0.4, aiFac: 0.4, advFac: 0.08, reqMats: { Hardware: 0.1, Metal: 0.1 }, prodMats: ['Water'], startupCost: 150e9 }),
    Industry.fromObject({ name: 'Energy', reFac: 0.65, sciFac: 0.7, robFac: 0.05, aiFac: 0.3, advFac: 0.08, reqMats: { Hardware: 0.1, Metal: 0.2 }, prodMats: ['Energy'], startupCost: 225e9 }),
    Industry.fromObject({ name: 'Mining', reFac: 0.3, sciFac: 0.26, hwFac: 0.4, robFac: 0.45, aiFac: 0.45, advFac: 0.06, reqMats: { Energy: 0.8 }, prodMats: ['Metal'], startupCost: 300e9 }),
    //reFac is unique for 'Food' bc it diminishes greatly per city. Handle this separately in code?
    Industry.fromObject({ name: 'Food', sciFac: 0.12, hwFac: 0.15, robFac: 0.3, aiFac: 0.25, advFac: 0.25, reFac: 0.05, reqMats: { Food: 0.5, Water: 0.5, Energy: 0.2 }, makesProducts: true, startupCost: 10e9 }),
    Industry.fromObject({ name: 'Tobacco', reFac: 0.15, sciFac: 0.75, hwFac: 0.15, robFac: 0.2, aiFac: 0.15, advFac: 0.2, reqMats: { Plants: 1, Water: 0.2 }, makesProducts: true, startupCost: 20e9 }),
    Industry.fromObject({ name: 'Software', sciFac: 0.62, advFac: 0.16, hwFac: 0.25, reFac: 0.15, aiFac: 0.18, robFac: 0.05, reqMats: { Hardware: 0.5, Energy: 0.5 }, prodMats: ['AICores'], makesProducts: true, startupCost: 25e9 }),
    Industry.fromObject({ name: 'Pharmaceutical', reFac: 0.05, sciFac: 0.8, hwFac: 0.15, robFac: 0.25, aiFac: 0.2, advFac: 0.16, reqMats: { Chemicals: 2, Energy: 1, Water: 0.5 }, prodMats: ['Drugs'], makesProducts: true, startupCost: 200e9 }),
    Industry.fromObject({ name: 'Computer', reFac: 0.2, sciFac: 0.62, robFac: 0.36, aiFac: 0.19, advFac: 0.17, reqMats: { Metal: 2, Energy: 1 }, prodMats: ['Hardware'], makesProducts: true, startupCost: 500e9 }),
    Industry.fromObject({ name: 'RealEstate', robFac: 0.6, aiFac: 0.6, advFac: 0.25, sciFac: 0.05, hwFac: 0.05, reqMats: { Metal: 5, Energy: 5, Water: 2, Hardware: 4 }, prodMats: ['RealEstate'], makesProducts: true, startupCost: 600e9 }),
    Industry.fromObject({ name: 'Healthcare', reFac: 0.1, sciFac: 0.75, advFac: 0.11, hwFac: 0.1, robFac: 0.1, aiFac: 0.1, reqMats: { Robots: 10, AICores: 5, Energy: 5, Water: 5 }, makesProducts: true, startupCost: 750e9 }),
    Industry.fromObject({ name: 'Robotics', reFac: 0.32, sciFac: 0.65, aiFac: 0.36, advFac: 0.18, hwFac: 0.19, reqMats: { Hardware: 5, Energy: 3 }, prodMats: ['Robots'], makesProducts: true, startupCost: 1e12 }),
];

// Global state
let dictSourceFiles;
/** @type {CorporationInfo} */
let myCorporation;
let options;
let verbose;
let raisingCapital = 0; // Used to flag that we are trying to raise private funding
let extraReserve = 0; // Used when we're saving to fund a new product.
let fillSpaceQueue = []; // Flag these offices as needing workers assigned to roles.

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    // Pull in any information we only need at startup.
    options = ns.flags(argsSchema);
    verbose = options.v || options.verbose;
    dictSourceFiles = await getActiveSourceFiles(ns);
    let runOnce = options.o || options.once;
    let shouldManage = !options['price-discovery-only'];

    // If we haven't unlocked corporations, just give up now.
    if (!(3 in dictSourceFiles)) {
        ns.tprint('ERROR: You do not appear to have unlocked corporations. Exiting.');
        ns.exit();
    }

    // See if we've already created a corporation.
    let hasCorporation = false;
    try {
        myCorporation = ns.corporation.getCorporation();
        hasCorporation = true;
    } catch {}
    // With SF 3.3, we start with access to the Warehouse and Office APIs. Without that, there's no way to set up a new Corp in any reasonable way.
    if (dictSourceFiles[3] >= 3 && !hasCorporation) {
        await doInitialCorporateSetup(ns);
    } else if (dictSourceFiles[3] < 3 && !hasCorporation) {
        ns.tprint(`Missing SF 3.3. Cannot bootstrap corporation automatically.`);
        ns.tprint(`You must found the corporation manually, and manage it up to the point you can purchase the Office and Warehouse APIs before this script can take over.`);
        ns.exit();
    }

    // If we already have a corporation, make sure we didn't leave any workers waiting for assignment.
    if (hasCorporation) {
        for (const division of myCorporation.divisions) {
            for (const city of division.cities) {
                fillSpaceQueue.push(`${division.name}/${city}`);
            }
        }
    }

    // We've set up the initial corporation, now run it over time.
    while (true) {
        // Do all our spending and expanding.
        if (shouldManage) await doManageCorporation(ns);

        // Try to manage sale prices for products.
        await doPriceDiscovery(ns);

        // While we wait for the next tick, process any open office positions
        await fillOpenPositionsFromQueue(ns);

        if (runOnce) {
            log(ns, 'Ran once through the corporation loop. Exiting.');
            ns.exit();
        }

        // Sleep until the next time we go into the 'START' phase
        await sleepWhileNotInStartState(ns, true);

        log(ns, '');
    }
}

/**
 * This function is called in our main loop. Assess the current state of the corporation, and improve it as best we can.
 * @param {NS} ns
 **/
async function doManageCorporation(ns) {
    // Assess the current state of the corporation, and figure out our budget.
    myCorporation = ns.corporation.getCorporation();
    let netIncome = myCorporation.revenue - myCorporation.expenses;
    let now = new Date().toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    if (verbose) log(ns, `----- [ ${myCorporation.name} Quarterly Report ${now} ] -----`);
    log(ns, `Corporate cash on hand: ${mf(myCorporation.funds)} (Gross: ${mf(myCorporation.revenue)}/s, Net: ${mf(netIncome)}/s)`);

    // See if we can raise more money.
    await tryRaiseCapital(ns);

    myCorporation = ns.corporation.getCorporation();
    let budget = myCorporation.funds - options['reserve-amount'] - extraReserve;
    budget = Math.max(0, budget);
    if (verbose) log(ns, ``);
    if (verbose) log(ns, `Working with a corporate budget of ${mf(budget)}`);

    // Let's figure out all of the things we'd like to do, before we commit to anything.
    let tasks = [];
    /**
     * What sort of corporation-wide stuff would we like to do?
     * Buy Unlocks? Buy upgrades?
     */
    let availableUnlocks = [],
        purchasedUnlocks = [];
    for (const unlockable of unlocks) {
        if (ns.corporation.hasUnlockUpgrade(unlockable)) purchasedUnlocks.push(unlockable);
        else availableUnlocks.push(unlockable);
    }
    for (const unlockable of availableUnlocks) {
        let cost = ns.corporation.getUnlockUpgradeCost(unlockable);
        if (cost > budget) continue;
        // If we can afford it, and we don't have it yet, consider buying it.
        let shouldBuy = false;
        if (unlockable === 'Smart Supply' && cost < budget * 0.8) {
            // Push this one to the top of the list. Doing it in code is annoying.
            tasks.push(new Task('Unlock ' + unlockable, () => ns.corporation.unlockUpgrade(unlockable), cost, 110));
        } else if (unlockable === 'Warehouse API' && cost < budget * 0.25) shouldBuy = true;
        else if (unlockable === 'Office API' && cost < budget * 0.25) shouldBuy = true;
        else if (unlockable === 'Shady Accounting' && cost < budget * 0.5) shouldBuy = true;
        else if (unlockable === 'Government Partnership' && cost < budget * 0.5) shouldBuy = true;
        // else if (unlockable === 'Export' && cost < budget * 0.1) shouldBuy = true;

        // Put the task on our to-do list. Put all unlocks at priority 0 as "nice-to-haves".
        if (shouldBuy) tasks.push(new Task('Unlock ' + unlockable, () => ns.corporation.unlockUpgrade(unlockable), cost, 0));
    }

    let hasProductionDivision = false;
    for (const division of myCorporation.divisions) {
        let industry = industries.find((i) => i.name === division.type);
        if (industry.makesProducts) hasProductionDivision = true;
    }
    // Can we afford to level any upgrades?
    for (const upgrade of upgrades) {
        let cost = ns.corporation.getUpgradeLevelCost(upgrade);
        let nextLevel = ns.corporation.getUpgradeLevel(upgrade) + 1;
        if (cost > budget) continue;
        if (upgrade === 'Wilson Analytics' && cost < budget * 0.9 && hasProductionDivision) {
            // Analytics fuels advertising, which drives up the price of products, which generates profits.
            // Scale the priority based on how cheap this is (cheaper is higher priority [0-100]).
            let priority = Math.round((1 - cost / budget) * 100);
            tasks.push(new Task(`Upgrading '${upgrade}' to level ${nextLevel}`, () => ns.corporation.levelUpgrade(upgrade), cost, priority));
        } else if (['Smart Factories', 'Smart Storage'].includes(upgrade) && cost < budget * 0.1) {
            // More storage means more materials, which drives more production. More production means more sales.
            tasks.push(new Task(`Upgrading '${upgrade}' to level ${nextLevel}`, () => ns.corporation.levelUpgrade(upgrade), cost, 10));
        } else if (cost < budget * 0.01) {
            // Upgrade other stuff too, as long as it's cheap compared to our budget.
            tasks.push(new Task(`Upgrading '${upgrade}' to level ${nextLevel}`, () => ns.corporation.levelUpgrade(upgrade), cost, 1));
        }
    }
    /**
     * Let's take a look at our divisions for big problems. Do we need to expand to a new industry? Are any
     * of our existing industries showing a loss? What else might we need to consider here? We'll be looking
     * at every division at the end of the loop to do maintence, so this is just high level stuff.
     */
    if (myCorporation.divisions.length === 0) {
        // We definitely need a new division!
        // Use up to 80% of our budget to start this first division.
        let newDivisionBudget = budget * 0.9;
        // Just consider the basic materials-producing industries for our first division. Products take a long time to come online.
        let possibleIndustries = industries.filter((ind) => !ind.makesProducts);
        // And only the ones where we'll be able to spend at least half our budget setting up shop.
        possibleIndustries = possibleIndustries.filter((ind) => ind.startupCost < newDivisionBudget * 0.5);
        // TODO: Pick a starting industry using some sort of logic.
        // For the moment, let's just try to go with Agriculture. It's cheap and works well.
        let newIndustry = possibleIndustries.find((ind) => ind.name === options['first']);
        if (newIndustry) {
            tasks.push(new Task(`Add the first division, '${newIndustry.name}'`, () => doCreateNewDivision(ns, newIndustry, newDivisionBudget), newDivisionBudget, 100));
        } else {
            // If we can't afford to create our first industry, something has gone very wrong. Quit now.
            log(ns, `ERROR: Could not afford to create our first industry!`, 'error', 'true');
            ns.exit();
        }
    }
    // Figure out where we are in the fundraising progression. Don't buy a production industry until after accepting round 3.
    let offer = ns.corporation.getInvestmentOffer();
    if (myCorporation.divisions.length > 0 && myCorporation.divisions.length < desiredDivisions && offer.round > 3) {
        let newDivisionBudget = budget * 0.9;
        let possibleIndustries = industries.filter((ind) => ind.makesProducts);
        // Only consider industries where we can still have a budget to actually get started.
        possibleIndustries = possibleIndustries.filter((ind) => ind.startupCost < budget * 0.5);
        possibleIndustries.sort((a, b) => a.startupCost - b.startupCost).reverse();
        if (verbose && possibleIndustries.length) {
            log(ns, `We would like to expand into a new industry. Possibilities:`);
            for (const industry of possibleIndustries) {
                log(ns, `  ${mf(industry.startupCost)} - ${industry.name}`);
            }
        } else if (verbose) log(ns, `INFO: We would like to create a new division but we cannot afford one. Willing to spend ${mf(budget)}.`);

        // Try to use the industry from the command line. If that doesn't work, fall back to picking from our list of possibilities.
        //        let newIndustry = possibleIndustries.find((ind) => ind.name == 'Pharmaceutical');
        let newIndustry = possibleIndustries.find((ind) => ind.name === options['second']);
        if (!newIndustry && possibleIndustries.length > 0) {
            newIndustry = possibleIndustries[0];
        }
        if (newIndustry) {
            tasks.push(new Task(`Add a production division, '${newIndustry.name}'`, () => doCreateNewDivision(ns, newIndustry, newDivisionBudget), newDivisionBudget, 100));
        } else {
            log(ns, `ERROR: Buying industry failed. Aborting!`, 'error', true);
            ns.exit();
        }
    }

    /**
     * We've looked at the at the corporation, and come up with a list of tasks we'd like to do. Now, figure out
     * which ones we can actually accomplish on our budget.
     */
    tasks.sort((a, b) => a.cost - b.cost).reverse();
    tasks.sort((a, b) => a.priority - b.priority).reverse();
    /**
     * Finally, run each task in priority order. If we run out of money, should we buy lower priority stuff, or
     * wait? If we wait, the money might get spent expanding a division instead. This may all take some
     * adjustments over time.
     */
    let spent = await runTasks(ns, tasks, budget);
    if (spent) budget -= spent;
    if (spent > 0 && verbose) log(ns, `Spent ${mf(spent)} of our budget of ${mf(budget)}.`);

    /**
     * Even though we've done all of our desired high level tasks, we still need to tend to each division individually.
     * If we don't have all the automation bits, we may need to adjust pricing. If we have room in warehouses, we can buy
     * more materials. If we have products, we may be able to start on a new product. We may have research to spend.
     */
    for (const division of myCorporation.divisions) {
        // If we have multiple divisions, hold the lion's share of the budget for production industries.
        let industry = industries.find((ind) => ind.name === division.type);
        let divisionalBudget = budget;
        if (myCorporation.divisions.length > 1 && !industry.makesProducts) {
            divisionalBudget *= 0.05;
        }
        let spent = await doManageDivision(ns, division, divisionalBudget);
        if (spent) budget -= spent;
    }
}

/**
 * Try to raise money.
 * Advances through the funding rounds, eventually going public. Potentially spends hacknet hashes for money.
 * @param {NS} ns
 */
async function tryRaiseCapital(ns) {
    // First, spend hacknet hashes.
    if (options['spend-hashes']) await doSpendHashes(ns, 'Sell for Corporation Funds');
    // If we're not public, then raise private funding.
    if (!myCorporation.public) {
        let offer = ns.corporation.getInvestmentOffer();
        // If we've finished round 4, clear our raising capital flag.
        if (offer.round > 4) raisingCapital = 0;
        let willAccept = true;
        if (offer && offer.round <= 4) {
            log(ns, `Considering raising private capital round ${offer.round}. Offered ${mf(offer.funds)} for ${nf(offer.shares)} shares.`);

            // Make sure all employees are happy.
            let satisfied = allEmployeesSatisfied(ns);
            if (!satisfied) {
                let prefix = '    *';
                if (!willAccept) prefix = '     ';
                log(ns, `${prefix}  Round ${offer.round} financing waiting on employee stats to stabilize.`);
                willAccept = false;
            }

            // Make sure we have filled a reasonable amount of our warehouses with materials.
            for (const division of myCorporation.divisions) {
                let industry = industries.find((i) => i.name === division.type);
                for (const city of division.cities) {
                    let warehouse = ns.corporation.getWarehouse(division.name, city);
                    let warehouseSpaceRequiredForCycle = getReservedWarehouseSpace(ns, industry, division, city);
                    let warehouseSpaceAvailable = warehouse.size - warehouseSpaceRequiredForCycle - warehouse.sizeUsed;
                    if (warehouseSpaceAvailable > warehouseSpaceRequiredForCycle * 0.2) {
                        let prefix = '    *';
                        if (!willAccept) prefix = '     ';
                        log(ns, `${prefix}  Round ${offer.round} financing waiting on ${division.name} warehouses to gain materials.`);
                        willAccept = false;
                        break;
                    }
                }
            }
            // If we have a product division, make sure it has a maximum number of products before we accept the offer.
            for (const division of myCorporation.divisions) {
                const maxProducts = getMaxProducts(ns, division.name);
                let industry = industries.find((i) => i.name === division.type);
                if (industry.makesProducts && division.products.length < maxProducts) {
                    let prefix = '    *';
                    if (!willAccept) prefix = '     ';
                    log(ns, `${prefix}  Round ${offer.round} financing waiting on ${division.name} division to create products (${division.products.length}/${maxProducts})`);
                    willAccept = false;
                }
                if (offer.round >= 4 && industry.makesProducts) {
                    // Wait for the last product to finish researching
                    let completeProducts = division.products.map((prodName) => ns.corporation.getProduct(division.name, prodName)).filter((prod) => prod.developmentProgress >= 100);
                    if (completeProducts.length < maxProducts) {
                        let prefix = '    *';
                        if (!willAccept) prefix = '     ';
                        log(ns, `${prefix}  Round ${offer.round} financing waiting on ${division.name} division to complete products (${completeProducts.length}/${maxProducts})`);
                        willAccept = false;
                    }
                }
            }
            // TODO: Funding is proportional to revenue. We can cook the books so that revenue looks higher than it should by stockpiling goods, then selling them all at once.

            // Make sure we aren't spending money on materials when we get funding. Each time we come through the loop and would purchase, increment the counter. After 4 times, purchase.
            if (willAccept) raisingCapital++;
            else raisingCapital = 0;

            // If we've passed all the checks, then accept the next round of funding.
            if (options['can-accept-funding'] && raisingCapital > 4 && !options.mock) {
                let success = ns.corporation.acceptInvestmentOffer();
                raisingCapital = 0;
                if (success) log(ns, `WARNING: Accepted round ${offer.round} funding. Took ${mf(offer.funds)} for ${nf(offer.shares)} shares.`);
                else log(ns, `ERROR: Tried to accept round ${offer.round} funding, but something went wrong.`);
            } else if (options['can-accept-funding'] && raisingCapital > 0) {
                log(ns, `SUCCESS: Raising capital in ${5 - raisingCapital} cycles.`);
            }
        } else {
            // We're public, so we can't be raising capital.
            raisingCapital = 0;
        }
        // Finally, if we're out of private funding, we may as well go public
        offer = ns.corporation.getInvestmentOffer();
        if (options['can-go-public'] && !options.mock && offer.round > 4) {
            // Looks like we're out of private funding. Time to go public.
            log(ns, `SUCCESS: Private funding complete. Time to IPO. Selling ${options['issue-shares']} shares.`);
            ns.corporation.goPublic(options['issue-shares']);
            // and set our dividend to 10%
            ns.corporation.issueDividends(0.1);
        }
    } else {
        // We're public, so we can't be raising capital.
        raisingCapital = 0;
    }
}

/**
 * Do all employees have enough happiness, energy, and morale?
 * @param {NS} ns
 * @param {number} lowerLimit - minimum for all stats [0,1]
 * @returns {boolean}
 */
function allEmployeesSatisfied(ns, lowerLimit = 0.9995) {
    let allSatisfied = true;
    for (const division of myCorporation.divisions) {
        for (const city of division.cities) {
            let office = ns.corporation.getOffice(division.name, city);
            let employees = office.employees.map((e) => ns.corporation.getEmployee(division.name, city, e));
            let avgMorale = employees.map((e) => e.mor).reduce((sum, mor) => sum + mor, 0) / employees.length;
            let avgEnergy = employees.map((e) => e.ene).reduce((sum, ene) => sum + ene, 0) / employees.length;
            let avgHappiness = employees.map((e) => e.hap).reduce((sum, hap) => sum + hap, 0) / employees.length;
            if (avgEnergy < office.maxEne * lowerLimit || avgHappiness < office.maxHap * lowerLimit || avgMorale < office.maxMor * lowerLimit) {
                allSatisfied = false;
                break;
            }
        }
    }
    return allSatisfied;
}

/**
 * Given a list of tasks, execute them in order.
 * @param {NS} ns
 * @param {Task[]} tasks
 * @param {number} budget
 * @param {boolean} keepSpending Should we keep spending money on items further down the list after hitting an item we can't afford?
 * @returns {number} the amount spent.
 */
async function runTasks(ns, tasks, budget, keepSpending = true) {
    const startingBudget = budget;
    for (const task of tasks) {
        let success = false;
        if (budget - task.cost > 0) {
            log(ns, `  Spending ${mf(task.cost)} on ${task.name}`);
            // Some of the ns.corporation calls we use are void functions, so treat a return value of undefined with no exception as a success.
            if (!options.mock)
                try {
                    success = await task.run();
                    if (success == undefined) success = true;
                } catch (e) {
                    log(ns, `WARNING: Failed to execute ${task.name} - ${task.run}`);
                    log(ns, `WARNING: ${e}`);
                }
            if (success) budget -= task.cost;
        }
        if (!success && !keepSpending) break;
    }
    return startingBudget - budget;
}

/** @param {NS} ns **/
async function doInitialCorporateSetup(ns) {
    // No corporation yet, so create one. Try for a publicly funded corporation first (Only works in BN 3).
    if (options.mock) {
        log(ns, `Would like to create a corporation, but cannot because we are in mock mode. Nothing else to do.`);
        ns.exit();
    }
    let created = false;
    try {
        created = ns.corporation.createCorporation(options['corporation-name'], false);
    } catch {}
    while (!created) {
        // No public corp, so try to self fund. Wait around until we have the money, if neccessary
        if (ns.getPlayer().money > 150e9) created = ns.corporation.createCorporation(options['corporation-name'], true);
        if (!created) await ns.sleep(100);
    }
    log(ns, `Founded corporation ${options['corporation-name']}!`, 'info', true);
}

/**
 * Create a bare bones new division, then use any remaining money to set it up.
 * @param {NS} ns
 * @param {*} newIndustry
 * @param {number} newDivisionBudget
 * @returns {boolean} true if we created the new division, false if not.
 */
async function doCreateNewDivision(ns, newIndustry, newDivisionBudget) {
    if (options['no-expansion'] || options['mock']) return false;
    myCorporation = ns.corporation.getCorporation();
    let numDivisions = myCorporation.divisions.length;

    ns.corporation.expandIndustry(newIndustry.name, newIndustry.name);

    myCorporation = ns.corporation.getCorporation();
    if (numDivisions === myCorporation.divisions.length) {
        log(ns, `ERROR: Failed to create new division! Expected to create '${newIndustry.name}'.`, 'error', true);
        ns.exit();
    }
    newDivisionBudget -= newIndustry.startupCost;
    if (verbose) log(ns, `Spending ${mf(newIndustry.startupCost)} setting up a new '${newIndustry.name}' division.`);
    let newDivision = ns.corporation.getDivision(newIndustry.name);

    // Hire the first three employees in Sector-12
    fillSpaceQueue.push(`${newDivision.name}/Sector-12`);

    // Do the first round of purchasing now.
    await doManageDivision(ns, newDivision, newDivisionBudget);
    if (newDivision) return true;
    else return false;
}

/**
 * Given an existing division, try to allocate our budget to growing the business.
 * @param {NS} ns
 * @param {Division} division division from ns.corporation.getDivision()
 * @param {number} budget amount we can spend
 * @returns {number} the amount we spent while managing this division.
 */
async function doManageDivision(ns, division, budget) {
    myCorporation = ns.corporation.getCorporation();
    const industry = industries.find((ind) => ind.name == division.type);
    budget = Math.max(0, budget);
    const totalBudget = budget;

    // We can't do much here without both the office and warehouse api.
    for (const api of ['Warehouse API', 'Office API']) {
        if (!ns.corporation.hasUnlockUpgrade(api)) {
            if (verbose) log(ns, `Cannot manage division ${division.name} without unlocking '${api}'`);
            return 0;
        }
    }
    /**
     * Take stock of the current state of this division. Just like at the corporate level,
     * collect some tasks that we'd like to do, then see what we can execute. Don't worry too
     * much about spending the whole budget. Anything we don't spend now will get passed on
     * to other divisions, or recycled in the next pass.
     */
    if (verbose) log(ns, '');
    if (verbose) log(ns, `Managing ${division.name} division with a budget of ${mf(budget)}.`);
    let spent = 0;
    let tasks = [];

    // Can we expand to new cities?
    if (division.cities.length < cities.length) {
        // We aren't in all cities yet, so we want to expand.
        for (const city of cities) {
            if (!division.cities.includes(city)) {
                let cost = ns.corporation.getExpandCityCost();
                if (cost < budget * 0.25) {
                    if (verbose) log(ns, `Want to open new offices in ${city}.`);
                    tasks.push(new Task(`Expand ${division.name} to ${city}`, () => doExpandCity(ns, division.name, city), cost, 80));
                } else if (verbose) log(ns, `WARNING: We would like to expand to ${city}, but it would cost ${mf(cost)} on our budget of ${mf(budget)}.`);
            }
        }
    }
    // Go ahead and expand immediately, so we can buy other stuff for any new locations on this cycle.
    if (tasks.length > 0) {
        spent = await runTasks(ns, tasks, budget);
        budget -= spent;
        tasks = [];
    }
    // Update our status
    myCorporation = ns.corporation.getCorporation();
    division = ns.corporation.getDivision(division.name);
    let hasMarketTA2 = ns.corporation.hasResearched(division.name, 'Market-TA.II');

    // Division wide tasks
    // Can we buy advertising? This is how we go exponential in our production industry.
    let adCount = ns.corporation.getHireAdVertCount(division.name);
    let adPrice = ns.corporation.getHireAdVertCost(division.name);
    if (industry.makesProducts && adPrice < budget * 0.9) {
        tasks.push(new Task(`Buy advertising campaign #${adCount + 1} for ${division.name}`, () => ns.corporation.hireAdVert(division.name), adPrice, 60));
        adCount++;
    }
    // Buy the first advertising campaign for non-product industries
    if (adCount == 0 && !industry.makesProducts && adPrice < budget * 0.9) {
        // Buy one advertising campaign in material markets
        tasks.push(new Task(`Buy advertising campaign #${adCount + 1} for ${division.name}`, () => ns.corporation.hireAdVert(division.name), adPrice, 60));
    }
    // Consider buying more advertising. All industires with MarketTA2, or a second one for production industries.
    if ((industry.makesProducts || hasMarketTA2) && adPrice < budget * 0.5) {
        tasks.push(new Task(`Buy advertising campaign #${adCount + 1} for ${division.name}`, () => ns.corporation.hireAdVert(division.name), adPrice, 20));
    }

    // Should we spend any research?
    let researchToSpend = division.research;
    if (industry.makesProducts || hasMarketTA2) {
        // Willing to spend in inverse proportion to how much stored science helps this product.
        researchToSpend = division.research * (1 - industry.factors.Science);
    }
    let researchTypes = ['Hi-Tech R&D Laboratory', 'uPgrade: Fulcrum', 'uPgrade: Capacity.I', 'uPgrade: Capacity.II', 'Market-TA.I', 'Market-TA.II'];
    for (const researchType of researchTypes) {
        let hasResearch = false;
        let cost = Infinity;
        try {
            hasResearch = ns.corporation.hasResearched(division.name, researchType);
            cost = ns.corporation.getResearchCost(division.name, researchType);
        } catch {}
        if (!hasResearch && researchToSpend >= cost) {
            log(ns, `INFO: Buying reasearch project ${researchType} for ${nf(cost)} research points.`, 'info');
            ns.corporation.research(division.name, researchType);
            researchToSpend -= cost;
        } else if (!hasResearch && cost !== Infinity) {
            if (verbose) log(ns, `Considered spending up to ${nf(researchToSpend)} of ${nf(division.research)} research on '${researchType}' but it would cost ${nf(cost)}.`);
            // If we don't have this research, and can't afford to buy it, don't buy the next item on the list
            break;
        }
    }

    // If this is a production industry, see if we should be researching a new product.
    if (industry.makesProducts) {
        const maxProducts = getMaxProducts(ns, division.name);
        let products = division.products.map((p) => ns.corporation.getProduct(division.name, p));
        let progress = products.map((p) => p.developmentProgress).filter((cmp) => cmp < 100)[0];
        if (progress == undefined) progress = 100;
        if (verbose) log(ns, `Projects: ${products.length}/${maxProducts}. Current project: ${nf(progress)}% complete.`);
        if (progress === 100) {
            // No product being researched. Consider creating a new one.
            if (products.length < maxProducts) {
                // We're not full, so go ahead.
                spent += createNewProduct(ns, division);
                budget -= spent;
            } // Discontinue an existing product for a new one if we're not raising capital.
            else {
                // log(ns, `Considering creating a new product. rC: ${raisingCapital} eR: ${mf(extraReserve)}`);
                if (raisingCapital === 0) {
                    if (extraReserve > 0 && myCorporation.funds > extraReserve) {
                        // We have enough money saved up. Time to ditch the product with the lowest budget.
                        products.sort((a, b) => budgetFromProductName(a.name) - budgetFromProductName(b.name));
                        let lowBudgetProduct = products[0];
                        ns.corporation.discontinueProduct(division.name, lowBudgetProduct.name);
                        myCorporation = ns.corporation.getCorporation();
                    }
                    // Try to create the Product. If it fails, it will set a reserve for us.
                    spent += createNewProduct(ns, division);
                    budget -= spent;
                }
            }
        }
    }

    // Per city tasks.
    for (const city of division.cities) {
        // Can we expand any of our offices for more employees?
        let officeSize = ns.corporation.getOffice(division.name, city).size;
        let seats = 15; // Grow by officeSize when small, then by 15
        seats = Math.min(seats, officeSize);
        let cost = ns.corporation.getOfficeSizeUpgradeCost(division.name, city, seats);
        if (industry.makesProducts && city === hqCity && cost < budget * 0.9) {
            tasks.push(new Task(`Buy space for ${seats} more employees of ${division.name}/${city}`, () => upgradeOfficeSize(ns, division.name, city, seats), cost, 70));
        } else if (industry.makesProducts && city !== hqCity && cost < budget * 0.1) {
            tasks.push(new Task(`Buy space for ${seats} more employees of ${division.name}/${city}`, () => upgradeOfficeSize(ns, division.name, city, seats), cost, 70));
        } else if (!industry.makesProducts && cost < budget * 0.4) {
            tasks.push(new Task(`Buy space for ${seats} more employees of ${division.name}/${city}`, () => upgradeOfficeSize(ns, division.name, city, seats), cost, 70));
        }

        // Can we expand our warehouse space?
        if (!ns.corporation.hasWarehouse(division.name, city)) {
            // We don't have a warehouse here. We should try to buy one in this city.
            cost = ns.corporation.getPurchaseWarehouseCost();
            if (cost < budget * 0.5) {
                tasks.push(new Task(`Buy warehouse ${division.name}/${city}`, () => ns.corporation.purchaseWarehouse(division.name, city), cost, 80));
            }
            // Anything else we want to do with a city requires a warehouse, so just skip to the next city.
            continue;
        }

        // We have a warehouse. Can we expand it?
        let warehouse = ns.corporation.getWarehouse(division.name, city);
        // TODO: How much do we care about expanding the warehouse? We should base it on how much of an impact more materials would have.
        cost = ns.corporation.getUpgradeWarehouseCost(division.name, city);
        if (cost < budget * 0.25) {
            tasks.push(new Task(`Buy warehouse space for ${division.name}/${city}`, () => ns.corporation.upgradeWarehouse(division.name, city), cost, 20));
        }

        // Turn on Smart Supply if we have it
        if (ns.corporation.hasUnlockUpgrade('Smart Supply') && !warehouse.smartSupplyEnabled) {
            try {
                if (verbose) log(ns, `Turning on Smart Supply for ${division.name}/${city}.`);
                ns.corporation.setSmartSupply(division.name, city, true);
            } catch (e) {
                log(ns, `ERROR: ${e}`);
            }
        } else if (!ns.corporation.hasUnlockUpgrade('Smart Supply')) {
            // Try to emulate Smart Supply if we don't have it.
            // TODO: I don't think this is working.
            for (const requiredMaterialName in industry.reqMats) {
                let amtPerProduct = industry.reqMats[requiredMaterialName];
                let amtRequiredMaterial = 0;
                for (const producedMaterialName of industry.prodMats) {
                    let producedMaterial = ns.corporation.getMaterial(division.name, city, producedMaterialName);
                    let lastProduced = producedMaterial.prod;
                    if (lastProduced < 1) lastProduced = 1 * division.prodMult;
                    amtRequiredMaterial += lastProduced * amtPerProduct;
                }
                for (const productName of division.products) {
                    let lastProduced = ns.corporation.getProduct(division.name, productName).cityData[city][1];
                    if (lastProduced < 1) lastProduced = 1 * division.prodMult;
                    amtRequiredMaterial += lastProduced * amtPerProduct;
                }
                amtRequiredMaterial -= ns.corporation.getMaterial(division.name, city, requiredMaterialName).qty;
                amtRequiredMaterial = Math.max(0, amtRequiredMaterial);
                amtRequiredMaterial *= 10; // Produce 10 times per cycle
                // Set the buy amount for this city based on our calculations.
                ns.corporation.buyMaterial(division.name, city, requiredMaterialName, amtRequiredMaterial);
            }
        }

        // Can we buy more materials given the space we currently have?
        // First, wait to cycle around to 'START' so we have a clean read on the warehouse levels.
        await sleepWhileNotInStartState(ns);
        // Calculate the required free space for a production cycle's worth of Material and products.
        let warehouseSpaceRequiredForCycle = getReservedWarehouseSpace(ns, industry, division, city);

        // TODO The amounts we buy still needs to be tuned, probably based on corporate income or something?
        // We don't want to drive the corp too deeply negative with material purchases, or else nothing else
        // will ever be bought, and employees will never get happy.
        let freeSpace = warehouse.size - warehouse.sizeUsed;
        let warehouseSpaceAvailable = freeSpace - warehouseSpaceRequiredForCycle;
        let tolerance = warehouseSpaceRequiredForCycle * 0.01;
        let enoughSpace = warehouseSpaceAvailable >= tolerance; // Tiny safety margin
        const satisfied = allEmployeesSatisfied(ns);
        if ((budget > 0 || satisfied) && enoughSpace && raisingCapital === 0) {
            // We have a decent amount of space to fill.
            if (verbose) log(ns, `   ${division.name}/${city} warehouse: Wants +${nf(warehouseSpaceAvailable)} m² materials. ${nf(warehouseSpaceRequiredForCycle)} m² reserved.`);
            for (const material of bonusMaterials) {
                //if (industry.prodMats.includes(material)) continue; // Don't buy the materials we make.
                let amt = (industry.scaledMaterialBonus[material] * warehouseSpaceAvailable) / 4;
                // somewhat scale the amount we buy with our budget
                let scaleFactor = Math.log10(budget) - 11; // Don't go full speed until our budget is $100b or more.
                scaleFactor = Math.max(-2, scaleFactor);
                scaleFactor = Math.min(0, scaleFactor);
                let scale = Math.pow(10, scaleFactor);
                // Only scale if we're waiting on employees to get happy.
                if (!satisfied) amt = scale * amt;
                ns.corporation.buyMaterial(division.name, city, material, amt);
            }
        } else {
            // Make sure we're not buying anything -- we're either out of room or out of money.
            for (const material of bonusMaterials) {
                ns.corporation.buyMaterial(division.name, city, material, 0);
            }
        }
        // It's possible to get into a situation where we've grown production faster than warehouse space.
        if (warehouseSpaceAvailable < -tolerance) {
            // Start clearing things out.
            if (verbose) log(ns, `   ${division.name}/${city} warehouse: Wants to reserve ${nf(warehouseSpaceRequiredForCycle)} of ${nf(warehouse.size)} m², but only ${nf(freeSpace)} m² free! Selling some materials.`);
            for (const material of allMaterials) {
                let amt = ns.corporation.getMaterial(division.name, city, material).qty;
                let sellAmt = amt * 0.025;
                ns.corporation.sellMaterial(division.name, city, material, sellAmt.toFixed(2), 'MP*0.80');
            }
        } else {
            // Make sure we reset. It should be safe to sell '0' here, because the things we want to sell will get reset in the price discovery loop.
            for (const material of allMaterials) {
                ns.corporation.sellMaterial(division.name, city, material, '0', 'MP');
            }
        }
    }
    // Figure out which tasks we can afford to run, and in which order.
    tasks.sort((a, b) => a.cost - b.cost).reverse();
    tasks.sort((a, b) => a.priority - b.priority).reverse();
    // Finally, run all the tasks we've collected.
    spent += await runTasks(ns, tasks, budget);
    if (spent > 0 && verbose) log(ns, `Spent ${mf(spent)} of our budget of ${mf(totalBudget)}.`);

    return spent;
}

/**
 * How much space do we need to leave fee in this warehouse for a full cycle of production?
 * @param {NS} ns
 * @param {Industry} industry
 * @param {Division} division
 * @param {string} city
 * @returns {number}
 */
function getReservedWarehouseSpace(ns, industry, division, city) {
    let rawMaterialSize = 0;
    let warehouseSpaceRequiredForCycle = 0;
    let maxProd = 0;

    // Products take the same space as what was used to create it.
    for (const matName in industry.reqMats) {
        let matAmt = industry.reqMats[matName];
        rawMaterialSize += matAmt * materialSizes[matName];
    }

    // Max production is based on a bunch of production multipliers.
    maxProd = getMaximumProduction(ns, division, city);

    // How many materials could we produce? Material sizes are predefined.
    for (const matName of industry.prodMats) {
        warehouseSpaceRequiredForCycle += materialSizes[matName] * maxProd;
    }

    if (industry.makesProducts) {
        const maxProducts = getMaxProducts(ns, division.name);
        warehouseSpaceRequiredForCycle += maxProducts * maxProd * rawMaterialSize;
    }

    // We produce stuff 10 times per cycle
    warehouseSpaceRequiredForCycle *= 10;

    // If we don't have automatic price discovery, we'll need some extra free space.
    let hasMarketTA2 = ns.corporation.hasResearched(division.name, 'Market-TA.II');
    if (!hasMarketTA2) warehouseSpaceRequiredForCycle *= 3;
    else warehouseSpaceRequiredForCycle *= 1.5;

    return warehouseSpaceRequiredForCycle;
}

function getMaximumProduction(ns, division, city) {
    let office = ns.corporation.getOffice(division.name, city);
    let officeMult = getOfficeProductivity(office); // Workers
    let prodMult = division.prodMult; // Materials
    let corpMult = 1 + 0.03 * ns.corporation.getUpgradeLevel('Smart Factories'); // Corporate upgrades.
    let resMult = 1;
    if (ns.corporation.hasResearched(division.name, 'Drones - Assembly')) resMult *= 1.2;
    if (ns.corporation.hasResearched(division.name, 'Self-Correcting Assemblers')) resMult *= 1.1;
    let maxProd = officeMult * prodMult * corpMult * resMult;
    return maxProd;
}

/**
 * Try to create a new product for this division, with a budget at least twice the size of the last
 * one we bought. If we don't have enough money, or all our product slots are full,
 * then set a reserve for the desired amount.
 *
 * @param {NS} ns
 * @param {Division} division
 * @returns amount of money spent, if any.
 */
function createNewProduct(ns, division) {
    let wantToSpend = 2e9; // $2b minimum.
    let spent = 0;
    let spentOnProducts = [];
    try {
        spentOnProducts = division.products
            .map((p) => budgetFromProductName(p))
            .sort((a, b) => a - b)
            .reverse();
    } catch (error) {}
    if (spentOnProducts.length > 0) {
        // If our products weren't named correctly default to assuming they were 2b, 4b, 8b...
        wantToSpend = wantToSpend * Math.pow(2, spentOnProducts.length - 1);
        wantToSpend = Math.max(spentOnProducts[0] * 2, wantToSpend, myCorporation.revenue * 100);
    }
    let productname = `${division.type}-${Math.log10(wantToSpend).toFixed(2)}`;
    try {
        ns.corporation.makeProduct(division.name, hqCity, productname, wantToSpend / 2, wantToSpend / 2);
        log(ns, `Creating new product '${productname}' for ${mf(wantToSpend)}.`, 'info', true);
        spent += wantToSpend;
        extraReserve = 0;
    } catch (e) {
        // If we fail to create the product, just reserve the money we want to spend.
        log(ns, `Reserving budget of ${mf(wantToSpend)} for next product.`);
        extraReserve = wantToSpend;
    }
    return spent;
}

function getMaxProducts(ns, divisionName) {
    let maxProducts = 3;
    if (ns.corporation.hasResearched(divisionName, 'uPgrade: Capacity.I')) maxProducts++;
    if (ns.corporation.hasResearched(divisionName, 'uPgrade: Capacity.II')) maxProducts++;
    return maxProducts;
}

/** @param {NS} ns */
async function sleepWhileNotInStartState(ns, waitForNext = false) {
    myCorporation = ns.corporation.getCorporation();
    if (waitForNext) {
        while (myCorporation.state === 'START') {
            await ns.sleep(50);
            myCorporation = ns.corporation.getCorporation();
        }
    }
    let lastState = 'Unknown';
    while (myCorporation.state !== 'START') {
        if (verbose && myCorporation.state !== lastState) {
            log(ns, `Waiting for corporation to move into the 'START' status. Currently: '${myCorporation.state}'.`);
            lastState = myCorporation.state;
        }
        await ns.sleep(50); // Better keep the sleep short, in case we're in catch-up mode.
        myCorporation = ns.corporation.getCorporation();
    }
    myCorporation = ns.corporation.getCorporation();
}

/**
 * Buy the specified number of seats, and hire employees to fill them.
 * @param {NS} ns
 * @param {string} divisionName
 * @param {string} city
 * @param {number} seats
 * @returns {boolean} returns true on success
 */
async function upgradeOfficeSize(ns, divisionName, city, seats) {
    // First buy the new seats.
    let success = false;
    try {
        if (seats > 0) ns.corporation.upgradeOfficeSize(divisionName, city, seats);
        success = true;
    } catch (e) {
        log(ns, `ERROR: Failed to upgrade office size by ${seats} seats in ${city}.`);
        log(ns, `ERROR: ${e}`);
    }
    if (!success) return false;

    /**
     * Now that we have more office space, we need to hire and assign workers. Since
     * worker assignment takes a long time, add them to a queue and we'll handle it
     * later.
     */
    fillSpaceQueue.push(`${divisionName}/${city}`);

    return true;
}

async function fillOpenPositionsFromQueue(ns) {
    myCorporation = ns.corporation.getCorporation();
    fillSpaceQueue = [...new Set(fillSpaceQueue)]; // Unique
    // Try not to run past the end of a cycle..
    while (['START'].includes(myCorporation.state) && fillSpaceQueue.length > 0) {
        let office = fillSpaceQueue.shift();
        let divisionName = office.split('/')[0];
        let cityName = office.split('/')[1];
        await fillOpenPositions(ns, divisionName, cityName);
        myCorporation = ns.corporation.getCorporation();
    }
}

/**
 * Fill any open positions with employees.
 * @param {NS} ns
 * @param {string} divisionName
 * @param {string} cityName
 */
async function fillOpenPositions(ns, divisionName, cityName) {
    if (options.mock) return;
    let office = ns.corporation.getOffice(divisionName, cityName);
    let employees = office.employees.map((e) => ns.corporation.getEmployee(divisionName, cityName, e));
    let numUnassigned = employees.filter((e) => e.pos === 'Unassigned').length;
    let openJobs = office.size - office.employees.length;
    for (let i = 0; i < openJobs; i++) {
        ns.corporation.hireEmployee(divisionName, cityName);
    }
    openJobs += numUnassigned;
    office = ns.corporation.getOffice(divisionName, cityName);
    if (openJobs > 0) {
        if (verbose) log(ns, `Assigning ${openJobs} new employees to work in ${divisionName}/${cityName}`);
        let employeesPerJob = Math.floor(office.employees.length / jobs.length);
        let employeesLeft = office.employees.length % jobs.length;
        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            let num = employeesPerJob;
            if (i < employeesLeft) num++;
            // if (verbose) log(ns, `Assigning ${num} employees to work as ${job} in ${cityName}`);
            if (num) await ns.corporation.setAutoJobAssignment(divisionName, cityName, job, num);
        }
    }
}

/**
 * Attempt to find a reasonablly stable price for each product. This will take several production cycles to stabilize.
 * @param {NS} ns
 */
async function doPriceDiscovery(ns) {
    if (verbose) log(ns, ``);
    if (verbose) log(ns, `Doing price discovery for products.`);
    myCorporation = ns.corporation.getCorporation();
    for (const division of myCorporation.divisions) {
        const industry = industries.find((i) => i.name === division.type);
        // If we have Market-TA.II researched, just let that work.
        let hasMarketTA2 = ns.corporation.hasResearched(division.name, 'Market-TA.II');
        if (hasMarketTA2) {
            for (const city of division.cities) {
                // Default prices
                industry.prodMats.forEach((material) => ns.corporation.sellMaterial(division.name, city, material, 'MAX', 'MP'));
                division.products.forEach((product) => ns.corporation.sellProduct(division.name, city, product, 'MAX', 'MP'));
                // Turn on automation.
                industry.prodMats.forEach((material) => ns.corporation.setMaterialMarketTA2(division.name, city, material, true));
                division.products.forEach((product) => ns.corporation.setProductMarketTA2(division.name, product, true));
            }
            // No need to do any other price discovery on this division.
            continue;
        }

        // Materials are easy. Just sell them for Market price.
        for (const materialName of industry.prodMats) {
            for (const city of division.cities) {
                ns.corporation.sellMaterial(division.name, city, materialName, 'PROD', 'MP');
            }
        }

        // Go through each product, and see if the price needs to be adjusted. We can only
        // adjust the price on a per-product basis (desipe the UI letting you do it
        // manually, the API is busted.)
        let prevProductMultiplier = 1.0;
        for (const productName of division.products) {
            const product = ns.corporation.getProduct(division.name, productName);
            if (product.developmentProgress < 100) continue;
            let sPrice = product.sCost;
            // sPrice ought to be of the form 'MP * 123.45'. If not, we should use the price of the last product we calculated.
            let lastPriceMultiplier = prevProductMultiplier;
            try {
                let sMult = sPrice.split('*')[1];
                lastPriceMultiplier = Number.parseFloat(sMult);
            } catch {}
            let votes = [];
            for (const city of division.cities) {
                // Each city is going to "vote" for how they want the price to be manipulated.
                let qty = product.cityData[city][0];
                let produced = product.cityData[city][1];
                let sold = product.cityData[city][2];
                // if (verbose) log(ns, `${division.name}/${city}:${product.name} (qty, prod, sold): ` + product.cityData[city].map((n) => nf(n)));

                if (produced == sold && qty == 0) {
                    // We sold every item we produced. Vote to double the price.
                    votes.push(lastPriceMultiplier * 2);
                }
                // If we've accumulated a big stockpile, reduce our prices.
                else if (qty > produced * 100) {
                    votes.push(lastPriceMultiplier * 0.9);
                } else if (qty > produced * 40) {
                    votes.push(lastPriceMultiplier * 0.95);
                } else if (qty > produced * 20) {
                    votes.push(lastPriceMultiplier * 0.98);
                }
                // Our stock levels must be good. If we sold less than production, then our price is probably high
                else if (sold < produced) {
                    let newMultiplier = lastPriceMultiplier;
                    if (sold <= produced * 0.5) {
                        newMultiplier *= 0.75; // Our price is very high.
                    } else if (sold <= produced * 0.9) {
                        newMultiplier *= 0.95; // Our price is a bit high.
                    } else {
                        newMultiplier *= 0.99; // Our price is just barely high
                    }
                    votes.push(newMultiplier);
                }
                // If we sold more than production, then our price is probably low.
                else if (produced < sold) {
                    let newMultiplier = lastPriceMultiplier;
                    if (sold >= produced * 2) {
                        newMultiplier *= 2; // We sold way too much. Double the price.
                    } else if (sold >= produced * 1.33) {
                        newMultiplier *= 1.05; // We sold a bit too much. Bring the price up a bit.
                    } else {
                        newMultiplier *= 1.01;
                    }
                    votes.push(newMultiplier);
                }
            } // end for-cities
            // All of the cities have voted. Use the lowest price that the cities have asked for.
            votes.sort((a, b) => a - b);
            let newMultiplier = votes[0];
            let newPrice = `MP*${newMultiplier.toFixed(3)}`;
            // if (verbose) log(ns, `${prefix}Votes: ${votes.map((n) => nf(n)).join(', ')}.`);
            let sChange = percentChange(lastPriceMultiplier, newMultiplier);
            if (verbose) log(ns, `Adjusting '${product.name}' price from ${sPrice} to ${newPrice} (${sChange}).`);
            ns.corporation.sellProduct(division.name, hqCity, product.name, 'MAX', newPrice, true);
            prevProductMultiplier = newMultiplier;
        } // end for-products
    } // end for-divisions
}

/**
 * Expand to a new city and fill the newly-opened office positions.
 * @param {NS} ns
 * @param {string} divisionName
 * @param {string} cityName
 */
async function doExpandCity(ns, divisionName, cityName) {
    ns.corporation.expandCity(divisionName, cityName);
    fillSpaceQueue.push(`${divisionName}/${cityName}`);
}

/**
 * Spend hashes on something, as long as we have hacknet servers unlocked and a bit of money in the bank.
 * @param {NS} ns
 * @param {string} spendOn 'Sell for Corporation Funds' | 'Exchange for Corporation Research'
 */
async function doSpendHashes(ns, spendOn) {
    // Make sure we have a decent amount of money ($100m) before spending hashes this way.
    if (ns.getPlayer().money > 100e6 && 9 in dictSourceFiles) {
        let spentHashes = 0;
        let shortName = spendOn;
        if (spendOn === 'Sell for Corporation Funds') shortName = '$1B of corporate funding';
        else if (spendOn === 'Exchange for Corporation Research') shortName = '1000 research for each corporate division';
        do {
            let numHashes = ns.hacknet.numHashes();
            ns.hacknet.spendHashes(spendOn);
            spentHashes = numHashes - ns.hacknet.numHashes();
            if (spentHashes > 0) log(ns, `Spent ${formatNumberShort(Math.round(spentHashes / 100) * 100)} hashes on ${shortName}`, 'success');
        } while (spentHashes > 0);
    }
}

/**
 * Log a message. Optionally, pop up a toast. Optionally, print to the terminal.
 * @param {NS} ns
 * @param {string} log message to log
 * @param {string} toastStyle
 * @param {boolean} printToTerminal
 */
function log(ns, log, toastStyle, printToTerminal) {
    ns.print(log);
    if (toastStyle) ns.toast(log, toastStyle);
    if (printToTerminal) ns.tprint(log);
}

/**
 * Assuming a product is named Industry-XX.XX, where XX.XX is the log10() of the budget.
 * @param {string} projectName
 * @returns {number} - the budget
 */
function budgetFromProductName(projectName) {
    let sExp = projectName.split('-')[1];
    let exp = Number.parseFloat(sExp);
    let budget = Math.pow(10, exp);
    return budget;
}

function getOfficeProductivity(office, forProduct = false) {
    const opProd = office.employeeProd.Operations;
    const engrProd = office.employeeProd.Engineer;
    const mgmtProd = office.employeeProd.Management;
    const total = opProd + engrProd + mgmtProd;
    if (total <= 0) return 0;

    const mgmtFactor = 1 + mgmtProd / (1.2 * total);
    const prod = (Math.pow(opProd, 0.4) + Math.pow(engrProd, 0.3)) * mgmtFactor;
    const balancingMult = 0.05;

    if (forProduct) return 0.5 * balancingMult * prod;
    else return balancingMult * prod;
}

/**
 * Return the percentage change from from oldVal to NewVal.
 * @param {number} oldVal
 * @param {number} newVal
 * @returns {string} formatted as "+99.9%"
 */
function percentChange(oldVal, newVal) {
    let percentChange = (newVal / oldVal) * 100 - 100;
    let sChange = nf(percentChange) + '%';
    if (percentChange >= 0) sChange = '+' + sChange;
    return sChange;
}
