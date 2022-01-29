import { getNsDataThroughFile, formatMoney, formatDuration, getActiveSourceFiles, disableLogs } from './helpers.js'

const interval = 5000; // Uodate (tick) this often
const minTaskWorkTime = 59000; // Sleeves assigned a new task should stick to it for at least this many milliseconds
const tempFile = '/Temp/sleeve-set-task.txt';
const crimes = ['mug', 'homicide']
const works = ['security', 'field', 'hacking']; // When doing faction work, we prioritize physical work since sleeves tend towards having those stats be highest
const workByFaction = {}

let options;
const argsSchema = [
    ['shock-recovery', 0.25], // Set to a number between 0 and 1 to devote that much time to shock recovery
    ['crime', ''],
    ['aug-budget', 0.5], // Spend up to this much of current cash on augs per tick (Default is high, because these are permanent for the rest of the BN)
    ['buy-cooldown', 60 * 1000], // Must wait this may milliseconds before buying more augs for a sleeve
    ['min-aug-batch', 20], // Must be able to afford at least this many augs before we pull the trigger (or fewer if buying all remaining augs)
	['mimic-player', true], // Whether sleeve 0 always attempts work instead of doing crime, prioritizing the same faction/company as the player
	['work-chance', 0.5], // General chance of working instead of doing crime, if we still need more karma for a gang, or money
	['money-threshold', 10000000], // Above this amount of money, don't worry about crime unless we're still trying to get a gang
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    options = ns.flags(argsSchema);
    disableLogs(ns, ['getServerMoneyAvailable']);
    if (!crimes.includes(options.crime)) crimes.push(options.crime);
    let task = [], lastUpdate = [], lastPurchase = [], availableAugs = [], lastReassign = [], sleeveFactions = [], ownedSourceFiles = [];
	let needGang, randomCrime, doWork, doFaction;
	let crimeRoll, randomIndex;
	
	ownedSourceFiles = await getActiveSourceFiles(ns);
    const sf2Level = ownedSourceFiles[2] || 0;
    if (sf2Level == 0) {
		needGang = false;
        log(ns, "Gangs not unlocked.");
	} else {
		needGang = true;
	}

    log(ns, `WARN: Do not go to Sleeves tab while sleeve.js is managing multiple sleeves, until https://github.com/danielyxie/bitburner/issues/2832 is resolved. It can trigger Recovery Mode, but is seemingly harmless.`, `warning`, true);

    // Collect info that won't change or that we can track ourselves going forward
    let numSleeves;
    try {
        numSleeves = await getNsDataThroughFile(ns, `ns.sleeve.getNumSleeves()`, '/Temp/sleeve-count.txt');
    } catch {
        return ns.print("User does not appear to have access to sleeves. Exiting...");
    }
    for (let i = 0; i < numSleeves; i++) {
            availableAugs[i] = null;
			await getNsDataThroughFile(ns, `ns.sleeve.setToShockRecovery(${i})`, tempFile); // Default everyone to non-faction work to avoid trouble before sleeveFactions are populated
	}

    while (true) {
        let cash = ns.getServerMoneyAvailable("home") - Number(ns.read("reserve.txt"));
        let budget = cash * options['aug-budget'];
        let playerInfo = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');
		const gangInfo = await getNsDataThroughFile(ns, 'ns.gang.inGang() ? ns.gang.getGangInformation() : false', '/Temp/gang-stats.txt');
		let gangFaction = ' ';
		if (gangInfo && gangInfo.faction) {
			needGang = false;
            gangFaction = gangInfo.faction;
		}
		randomCrime = (cash < options['money-threshold'] || needGang);
		let numJoinedFactions = playerInfo.factions.length;
		let factionIndex = 0;
        for (let i = 0; i < numSleeves; i++) {
            let sleeveStats = ns.sleeve.getSleeveStats(i);
            let shock = sleeveStats.shock;
            let sync = sleeveStats.sync;
			let factionAssignedName = ' ';
            // Manage Augmentations
            if (shock == 0 && availableAugs[i] == null) // No augs are available augs until shock is 0
                availableAugs[i] = (await getNsDataThroughFile(ns, `ns.sleeve.getSleevePurchasableAugs(${i})`, '/Temp/sleeve-augs.txt')).sort((a, b) => a.cost - b.cost); // list of { name, cost }
            if (shock == 0 && availableAugs[i].length > 0) {
                const cooldownLeft = Math.max(0, options['buy-cooldown'] - (Date.now() - (lastPurchase[i] || 0)));
                const [batchCount, batchCost] = availableAugs[i].reduce(([n, c], aug) => c + aug.cost <= budget ? [n + 1, c + aug.cost] : [n, c], [0, 0]);
                const purchaseUpdate = `sleeve ${i} can afford ${batchCount.toFixed(0).padStart(2)}/${availableAugs[i].length.toFixed(0).padEnd(2)} remaining augs (cost ${formatMoney(batchCost)} of ` +
                    `${formatMoney(availableAugs[i].reduce((t, aug) => t + aug.cost, 0))}).`;
                if (lastUpdate[i] != purchaseUpdate)
                    log(ns, `INFO: With budget ${formatMoney(budget)}, ` + (lastUpdate[i] = purchaseUpdate) + ` (Min batch size: ${options['min-aug-batch']}, Cooldown: ${formatDuration(cooldownLeft)})`);
                if (cooldownLeft == 0 && batchCount > 0 && ((batchCount >= availableAugs[i].length - 1) || batchCount >= options['min-aug-batch'])) { // Don't require the last aug it's so much more expensive
                    let strAction = `Purchase ${batchCount} augmentations for sleeve ${i} at total cost of ${formatMoney(batchCost)}`;
                    let toPurchase = availableAugs[i].splice(0, batchCount);
                    budget -= batchCost;
                    if (await getNsDataThroughFile(ns, JSON.stringify(toPurchase.map(a => a.name)) +
                        `.reduce((s, aug) => s && ns.sleeve.purchaseSleeveAug(${i}, aug), true)`, '/Temp/sleeve-purchase.txt'))
                        log(ns, `SUCCESS: ${strAction}`, 'success');
                    else log(ns, `ERROR: Failed to ${strAction}`, 'error');
                    lastPurchase[i] = Date.now();
                }
            }
			
			if (!randomCrime || Math.random() < options['work-chance']) {
				doWork = true;
			    // Pick a valid faction that no one else is using
				randomIndex = Math.floor(Math.random() * numJoinedFactions); // This will remove the bias for our earlier, less-useful factions
				for (let j = 0; j < numJoinedFactions; j++) {
					if ((!sleeveFactions.includes(playerInfo.factions[(j+randomIndex) % numJoinedFactions]) || sleeveFactions[i] == playerInfo.factions[(j+randomIndex) % numJoinedFactions]) && playerInfo.factions[(j+randomIndex) % numJoinedFactions] != gangFaction) {
						factionIndex = (j+randomIndex) % numJoinedFactions;
						doFaction = true
						break;
					} else if (j == numJoinedFactions - 1) {
						doFaction = false
					}
				}
			} else {
				doWork = false;
				doFaction = false;
			}
            // Manage what this sleeve should be doing
            let command, designatedTask;
            if (sync < 100) { // Synchronize
                designatedTask = "synchronize";
                command = `ns.sleeve.setToSynchronize(${i})`;
                if (task[i] == designatedTask && Date.now() - (lastUpdate[i] ?? 0) > minTaskWorkTime) {
                    log(ns, `INFO: Sleeve ${i} is syncing... ${sync.toFixed(2)}%`);
                    lastUpdate[i] = Date.now();
                }
            } else if (shock > 0 && options['shock-recovery'] > 0 && Math.random() < options['shock-recovery']) { // Recover from shock
                designatedTask = "recover from shock";
                command = `ns.sleeve.setToShockRecovery(${i})`;
                if (task[i] == designatedTask && Date.now() - (lastUpdate[i] ?? 0) > minTaskWorkTime) {
                    log(ns, `INFO: Sleeve ${i} is recovering from shock... ${shock.toFixed(2)}%`);
                    lastUpdate[i] = Date.now();
                }
            } else if (i == 0 && playerInfo.isWorking && playerInfo.workType == "Working for Faction" && !sleeveFactions.includes(playerInfo.currentWorkFactionName) && (doWork || options['mimic-player'])) { // If player is currently working for faction rep, sleeves 0 shall help him out (only one sleeve can work for a faction)
                // TODO: We should be able to borrow logic from work-for-factions.js to have more sleeves work for useful factions / companies
			    factionAssignedName = playerInfo.currentWorkFactionName;
                let work = works[workByFaction[playerInfo.currentWorkFactionName] || 0];
                designatedTask = `work for faction '${factionAssignedName}' (${work})`;
                command = `ns.sleeve.setToFactionWork(${i}, '${factionAssignedName}', '${work}')`; // TODO: Auto-determine the most productive faction work to do?
            } else if (i == 0 && playerInfo.isWorking && playerInfo.workType == "Working for Company" && (doWork || options['mimic-player'])) { // If player is currently working for a company rep, sleeves 0 shall help him out (only one sleeve can work for a company)
                designatedTask = `work for company '${playerInfo.companyName}'`;
                command = `ns.sleeve.setToCompanyWork(${i}, '${playerInfo.companyName}')`;
            } else if (doWork && doFaction) {
				factionAssignedName = playerInfo.factions[factionIndex];
				let work = works[workByFaction[playerInfo.factions[factionIndex]] || 0];
                designatedTask = `work for faction '${factionAssignedName}' (${work})`;
                command = `ns.sleeve.setToFactionWork(${i}, '${factionAssignedName}', '${work}')`;
			} else { // Do something productive
                let crime = options.crime || (sleeveStats.strength < 100 ? 'mug' : 'homicide');
                designatedTask = `commit ${crime}`;
                command = `ns.sleeve.setToCommitCrime(${i}, '${crime}')`;
            }
            // Don't change tasks if we've changed tasks recently
            if (Date.now() - (lastReassign[i] || 0) < minTaskWorkTime || task[i] == designatedTask) continue;
            // Start doing the specified task
            let strAction = `Set sleeve ${i} to ${designatedTask}`;
            if (await getNsDataThroughFile(ns, command, tempFile)) {
                task[i] = designatedTask;
				sleeveFactions[i] = factionAssignedName;
                lastReassign[i] = Date.now();
                log(ns, `SUCCESS: ${strAction}`);
            } else {
                // If working for faction / company, it's possible he current work isn't supported, so try the next one.
                if (designatedTask.startsWith('work for faction')) {
                    log(ns, `WARN: Failed to ${strAction} - work type may not be supported.`, 'warning');
                    workByFaction[factionAssignedName] = (workByFaction[factionAssignedName] || 0) + 1;
                } else
                    log(ns, `ERROR: Failed to ${strAction}`, 'error');
            }
        }
        await ns.sleep(interval);
    }
}

function log(ns, log, toastStyle, printToTerminal) {
    ns.print(log);
    if (toastStyle) ns.toast(log, toastStyle);
    if (printToTerminal) ns.tprint(log);
}