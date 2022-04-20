import {
	log, getFilePath, instanceCount, getNsDataThroughFile, waitForProcessToComplete,
	getActiveSourceFiles, tryGetBitNodeMultipliers,
	formatMoney, formatDuration
} from './helpers.js'

const persistentLog = "log.autopilot.txt";
const factionManagerOutputFile = "/Temp/affordable-augs.txt"; // Temp file produced by faction manager with status information

let options = null; // The options used at construction time
// TODO: Currently these may as well be hard-coded, args are lost when various other scripts kill and restart us.
const argsSchema = [ // The set of all command line arguments
	//TODO: Not yet possible ['next-bn', 12], // If we destroy the current BN, the next BN to start
	['install-at-aug-count', 13], // Automatically install when we can afford this many new augmentations (with NF only counting as 1)
	['install-at-aug-plus-nf-count', 18], // or... automatically install when we can afford this many augmentations including additional levels of Neuroflux
	['install-for-augs', ["The Red Pill"]], // or... automatically install as soon as we can afford one of these augmentations
	['reduced-aug-requirement-per-hour', 1], // For every hour since the last reset, require this many fewer augs to install.
	['interval', 5000], // Wake up this often (milliseconds) to check on things
	['interval-check-scripts', 60000], // Get a listing of all running processes on home this frequently
	['high-hack-threshold', 8000], // Once hack level reaches this, we start daemon in high-performance hacking mode
	['enable-bladeburner', false], // Set to true to allow bladeburner progression (probably slows down BN completion)
	['wait-for-4s', true], // If true, will not reset until the 4S Tix API has been acquired (major source of income early on, especially in harder nodes)
];
export function autocomplete(data, args) {
	data.flags(argsSchema);
	return [];
}

let playerInGang; // Tells us whether we're in a gang or not
let wdUnavailable; // A flag indicating whether the BN is completable on this reset
let ranCasino; // Flag to indicate whether we've stolen 10b from the casino yet
let reservedPurchase; // Flag to indicate whether we've reservedPurchase money and can still afford augmentations
let spendingHashesOnHacking; // Flag to indicate whether we've kicked off spend-hacknet-hashes already
let lastScriptsCheck; // Last time we got a listing of all running scripts
let sourceFiles, bitnodeMults; // Info for the current bitnode

/** @param {NS} ns **/
export async function main(ns) {
	if (await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
	options = ns.flags(argsSchema);
	log(ns, "INFO: Auto-pilot engaged...", true, 'info');

	// Clear reset global state
	playerInGang = wdUnavailable = ranCasino = reservedPurchase = spendingHashesOnHacking = false;
	lastScriptsCheck = 0;

	// Collect and cache some one-time data
	sourceFiles = await getActiveSourceFiles(ns, false);
	const player = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/getPlayer.txt');
	if (!(4 in sourceFiles) && player.bitNodeN != 4)
		return log(ns, `ERROR: This script requires SF4 (singularity) functions to work.`, true, 'ERROR');
	bitnodeMults = await tryGetBitNodeMultipliers(ns);
	if (player.playtimeSinceLastBitnode < 60 * 1000) // Skip initialization if we've been in the bitnode for more than 1 minute
		await initializeNewBitnode(ns);

	// Main loop: Monitor progress in the current BN and automatically reset when we can afford TRP, or N augs.
	while (true) {
		try { await mainLoop(ns); }
		catch (err) {
			log(ns, `WARNING: Caught (and suppressed) an unexpected error in the main loop:\n` +
				(typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
		}
		await ns.asleep(options['interval']);
	}
}

/** @param {NS} ns 
 * Logic run periodically throughout the BN **/
async function initializeNewBitnode(ns) {
	// Clean up all temporary scripts, which will include stale temp files
	// launchScriptHelper(ns, 'cleanup.js'); // No need, ascedd.js and casino.js do this
	// await ns.sleep(200); // Wait a short while for the dust to settle.
}

/** @param {NS} ns 
 * Logic run periodically throughout the BN **/
async function mainLoop(ns) {
	const player = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/getPlayer.txt');
	await manageReservedMoney(ns, player);
	await checkIfBnIsComplete(ns, player);
	await checkOnRunningScripts(ns, player);
	await maybeDoCasino(ns, player);
	await maybeInstallAugmentations(ns, player);
}

/** @param {NS} ns 
 * Logic run periodically throughout the BN **/
async function checkIfBnIsComplete(ns, player) {
	if (wdUnavailable) return false;
	const wdHack = await getNsDataThroughFile(ns,
		'ns.scan("The-Cave").includes("w0r1d_d43m0n") ? ns.getServerRequiredHackingLevel("w0r1d_d43m0n"): -1',
		'/Temp/wd-hackingLevel.txt');
	if (wdHack == -1) return !(wdUnavailable = true);
	if (player.hacking < wdHack)
		return false; // We can't hack it yet, but soon!
	const text = `BN ${player.bitNodeN}.${sourceFiles[player.bitNodeN] + 1} completed at ${formatDuration(player.playtimeSinceLastBitnode)}`;
	await persist_log(ns, text);
	log(ns, `SUCCESS: ${text}`, true, 'success');
	// TODO: Use the new singularity function coming soon to automate entering a new BN
	wdUnavailable = true; // TODO: Temporary: For now, set this so this doesn't run again
	return true;
}

/** @param {NS} ns 
 * Logic to ensure scripts are running to progress the BN **/
async function checkOnRunningScripts(ns, player) {
	if (lastScriptsCheck > Date.now() - options['interval-check-scripts']) return;
	lastScriptsCheck = Date.now();
	const runningScripts = await getNsDataThroughFile(ns, 'ns.ps()', '/Temp/ps.txt');
	const findScript = (baseScriptName) => runningScripts.filter(s => s.filename == getFilePath(baseScriptName))[0];

	// Launch stock-master in a way that emphasizes it as our main source of income early-on
	if (!findScript('stockmaster.js'))
		launchScriptHelper(ns, 'stockmaster.js', [
			"fracH", 0.1, // Increase the default proportion of money we're willing to hold as stock, it's often our best source of income
			"--reserve", 0, // Override to ignore the global reserve.txt. Any money we reserve can more or less safely live as stocks
		]);

	// Launch sleeves and allow them to also ignore the reserve so they can train up to boost gang unlock speed
	if (!findScript('sleeve.js'))
		launchScriptHelper(ns, 'sleeve.js', ["--training-reserve", 300000]); // Only avoid training away our casino seed money

	// Launch work-for-factions with different arguments if we're still working towards a gang
	if (!findScript('work-for-factions.js')) { // Don't bother re-launching if it's already going
		const workArgs = []; // Default args are good in most cases (NOTE: Will spend hashes on coding contracts by default, which we like)
		// If we're not yet in a gang, run in such a way that we will spend most of our time doing crime, improving Karma (also is good early income)
		playerInGang = playerInGang || await getNsDataThroughFile(ns, 'ns.gang.inGang()', '/Temp/gang-inGang.txt');
		if (!playerInGang) workArgs.push("--prioritize-invites", "--crime-focus")
		launchScriptHelper(ns, 'work-for-factions.js', workArgs);
	}

	// Spend hacknet hashes on our boosting best hack-income server once established
	if (!spendingHashesOnHacking && player.playtimeSinceLastAug >= 20 * 60 * 1000) { // 20 minutes seems about right
		const strServerIncomeInfo = ns.read('/Temp/analyze-hack.txt');	// HACK: Steal this file that Daemon also relies on
		if (strServerIncomeInfo) {
			const incomeByServer = JSON.parse(strServerIncomeInfo);
			const dictServerHackReqs = await getNsDataThroughFile(ns, 'Object.fromEntries(ns.args.map(server => [server, ns.getServerRequiredHackingLevel(server)]))',
				'/Temp/servers-hack-req.txt', incomeByServer.map(s => s.hostname));
			const [bestServer, gain] = incomeByServer.filter(s => dictServerHackReqs[s.hostname] <= player.hacking)
				.reduce(([bestServer, bestIncome], target) => target.gainRate > bestIncome ? [target.hostname, target.gainRate] : [bestServer, bestIncome], [null, 0]);
			//ns.getServerRequiredHackingLevel
			log(ns, `Identified that the best hack income server is ${bestServer} worth ${formatMoney(gain)}/sec.`)
			launchScriptHelper(ns, 'spend-hacknet-hashes.js',
				["--liquidate", "--spend-on", "Increase_Maximum_Money", "--spend-on", "Reduce_Minimum_Security", "--spend-on-server", bestServer]);
			spendingHashesOnHacking = true;
		}
	}

	// TODO: stanek.acceptGift before ascend. Once stanek's gift is accepted and not charged, launch it first

	// Ensure daemon.js is running in some form
	const daemon = findScript('daemon.js');
	// If player hacking level is about 8000, run in "start-tight" mode
	const hackThreshold = options['high-hack-threshold'];
	const daemonArgs = player.hacking < hackThreshold ? ["--stock-manipulation"] :
		// Launch daemon in "looping" mode if we have sufficient hack level
		["--looping-mode", "--recovery-thread-padding", 10, "--cycle-timing-delay", 2000, "--queue-delay", "10",
			"--stock-manipulation-focus", "--silent-misfires", "--initial-max-targets", "63", "--no-share"];
	// By default, disable joining bladeburner, since it slows BN12 progression by requiring combat augs not used elsewhere
	if (!options['enable-bladeburner']) daemonArgs.push('--disable-script', getFilePath('bladeburner.js'));
	// Launch or re-launch daemon with the desired arguments
	if (!daemon || player.hacking >= hackThreshold && !daemon.args.includes("--looping-mode")) {
		if (player.hacking >= hackThreshold)
			log(ns, `INFO: Hack level (${player.hacking}) is >= ${hackThreshold} (--high-hack-threshold): Starting daemon.js in high-performance hacking mode.`);
		launchScriptHelper(ns, 'daemon.js', daemonArgs);
	}
}

/** @param {NS} ns 
 * Logic to steal 10b from the casino **/
async function maybeDoCasino(ns, player) {
	if (ranCasino) return;
	if (ns.read("/Temp/ran-casino.txt")) return ranCasino = true;
	if (player.playtimeSinceLastAug < 60000) // If it's been less than 1 minute, wait a while to establish income
		return;
	if (player.money / player.playtimeSinceLastAug > 5e9 / 60000) // If we're making more than ~5b / minute, no need to run casino.
		return ranCasino = true;
	if (player.money > 10E9) // If we already have 10b, assume we ran and lost track, or just don't need the money
		return ranCasino = true;
	if (player.money < 210000)
		return; // We need at least 200K (and change) to run casino so we can travel to aevum
	// Run casino.js and expect ourself to get killed in the process
	// TODO: Preserve the current script's state / args through the reset
	if (launchScriptHelper(ns, 'casino.js', ['kill-all-scripts', true, '--on-completion-script', ns.getScriptName()]))
		await ns.asleep(30000); // Just sleep for 30 seconds. casino.js should kill/restart us before that long.
}

/** @param {NS} ns 
 * Logic to detect if it's a good time to install augmentations, and if so, do so **/
async function maybeInstallAugmentations(ns, player) {
	// If we previously attempted to reserve money for an augmentation purchase order, do a fresh facman run to ensure it's still available
	if (reservedPurchase) {
		log(ns, "INFO: Manually running faction-manager.js to ensure previously reserved purchase is still obtainable.");
		await ns.write(factionManagerOutputFile, "", "w"); // Reset the output file to ensure it isn't stale
		const pid = launchScriptHelper(ns, 'faction-manager.js');
		await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down (and output to be generated)
	}
	// Grab the latest output from faction manager to see if it's a good time to reset
	const facmanOutput = ns.read(factionManagerOutputFile);
	if (!facmanOutput) return reservedPurchase = false;
	const facman = JSON.parse(facmanOutput); // { affordable_nf_count: int, affordable_augs: [string], owned_count: int, unowned_count: int, total_rep_cost: number, total_aug_cost: number }
	const affordableAugCount = facman.affordable_augs.length;

	// Determine whether we can afford enough augmentations to merit a reset
	const reducedAugReq = Math.floor(options['reduced-aug-requirement-per-hour'] * player.playtimeSinceLastAug / 3.6E6);
	const augsNeeded = Math.max(1, options['install-at-aug-count'] - reducedAugReq);
	const augsNeededInclNf = Math.max(1, options['install-at-aug-plus-nf-count'] - reducedAugReq);
	const shouldReset = options['install-for-augs'].some(a => facman.affordable_augs.includes(a)) ||
		affordableAugCount >= augsNeeded || (affordableAugCount + facman.affordable_nf_count - 1) >= augsNeededInclNf;
	const augSummary = `${formatMoney(facman.total_rep_cost + facman.total_aug_cost)} for ${facman.affordable_nf_count} levels of ` +
		`NeuroFlux and ${affordableAugCount} of ${facman.unowned_count} remaining unique augmentations: ${facman.affordable_augs.join(", ")}`;

	// If not ready to reset, set a status with our progress and return
	if (!shouldReset) {
		setStatus(ns, `Currently at ${formatDuration(player.playtimeSinceLastAug)} since last aug. ` +
			`Need ${augsNeeded} unique augs or ${augsNeededInclNf} including NeuroFlux levels to install.\n` +
			`Can afford: ${augSummary}`, augSummary);
		return reservedPurchase = false; // If we were previously reserving money for a purcahse, reset that flag now
	}
	// If we want to reset, but there is a reason to delay, don't reset
	if (await shouldDelayInstall(ns, player)) // If we're currently in a state where we should not be resetting, skip reset logic
		return reservedPurchase = false; // TODO: A slick way to not have to reset this flag on every early-return statement.
	// Ensure the money needed for the above augs doesn't get ripped out from under us by reserving it and waiting one more loop
	if (!reservedPurchase) {
		log(ns, `INFO: Reserving ${augSummary}`, true, 'info');
		await ns.write("reserve.txt", facman.total_rep_cost + facman.total_aug_cost, "w"); // Should prevent other scripts from spending this money
		return reservedPurchase = true; // Set a flag so that on our next loop, we actually try to execute the purchase
	}
	// Otherwise, we've got the money reserved, we can afford the augs, we should be confident to ascend
	const resetLog = `Invoking ascend.js at ${formatDuration(player.playtimeSinceLastAug)} since last aug to install: ${augSummary}`;
	log(ns, `INFO: ${resetLog}`, true, 'info');
	await persist_log(ns, resetLog);
	// Kick off ascend.js
	let pid = launchScriptHelper('ascend.js', ['--install-augmentations', true,
		'--on-reset-script', ns.getScriptName(), // TODO: Preserve the current script's state / args through the reset		
		'--bypass-stanek-warning', true]); // Until there's an officially supported way to automate accepting stanek's gift, bypass it.
	let errLog;
	if (pid) {
		await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down (Ascend should get killed as it does, since the BN will be rebooting)
		await ns.asleep(1000); // If we've been scheduled to be killed, awaiting an NS function should trigger it?
		errLog = `ERROR: ascend.js ran, but we're still here. Something must have gone wrong. Will try again later`;
		log(ns, errLog, true, 'error');
	} else
		errLog = `ERROR: Failed to launch ascend.js (pid == 0). Will try again later`;
	// If we got this far, something went wrong
	await persist_log(ns, errLog);
}

/** @param {NS} ns 
 * Logic to detect if we are close to a milestone and should postpone installing augmentations until it is hit **/
async function shouldDelayInstall(ns, player) {
	// Are we close to being able to afford 4S TIX data?
	if (!player.has4SDataTixApi) {
		const totalWorth = getLiquidationValue(ns, player);
		const totalCost = 25E9 * (bitnodeMults?.FourSigmaMarketDataApiCost || 1) +
			(playerStats.has4SData ? 0 : 5E9 * (bitnodeMults?.FourSigmaMarketDataCost || 1));
		// If we're 50% of the way there, hold off, regardless of the '--wait-for-4s' setting
		if (totalWorth / totalCost > 0.5 || options['wait-for-4s']) {
			setStatus(`Waiting for scripts to purchase the 4SDataTixApi because ` +
				`${options['wait-for-4s'] ? '--wait-for-4s is true. W' : 'w'}e are ${(100 * totalWorth / totalCost).toFixed(0)}% of the way there.`);
			return true;
		}
	}
	// TODO: Bladeburner black-op in progress
	// TODO: Close to the rep needed for unlocking donations with a new faction?
	return false;
}

/** @param {NS} ns 
 * Consolidated logic for all the times we want to reserve money **/
async function manageReservedMoney(ns, player) {
	if (reservedPurchase) return; // Do not mess with money reserved for installing augmentations
	// if(!player.has4SDataTixApi) {
	if (Number(ns.read("reserve.txt") || 0) != 8E9)
		await ns.write("reserve.txt", 8E9, "w"); // Reserve 8 of the 10b casino money for stock seed money
	// NOTE: After several iterations, I decided that the above is actually best to keep in all scenarios:
	// - Casino.js ignores the reserve, so the above takes care of ensuring our casino seed money isn't spent
	// - In low-income situations, stockmaster will be our best source of income. We invoke it such that it ignores 
	//	 the global reserve, so this 8B is for stocks only. The 2B remaining is plenty to kickstart the rest.
	// - Once high-hack/gang income is achieved, this 8B will not be missed anyway. 
	/*
	if(!ranCasino) { // In practice, 
		await ns.write("reserve.txt", 300000, "w"); // Prevent other scripts from spending our casino seed money
		return moneyReserved = true;
	}
	// Otherwise, clear any reserve we previously had
	if(moneyReserved) await ns.write("reserve.txt", 0, "w"); // Remove the casino reserve we would have placed
	return moneyReserved = false;
	*/
}

/** @param {NS} ns 
 * Helper to launch a script and log whether if it succeeded or failed **/
function launchScriptHelper(ns, baseScriptName, args = []) {
	const pid = ns.run(getFilePath(baseScriptName), 1, ...args);
	if (!pid)
		log(ns, `ERROR: Failed to launch ${baseScriptName} with args: [${args.join(", ")}]`, true, 'error');
	else
		log(ns, `INFO: Launched ${baseScriptName} (pid: ${pid}) with args: [${args.join(", ")}]`, true, 'info');
	return pid;
}

let lastStatusLog = ""; // The current or last-assigned long-term status (what this script is waiting to happen)

/** @param {NS} ns 
 * Helper to set a global status and print it if it changes. **/
function setStatus(ns, status, uniquePart = null) {
	uniquePart = uniquePart || status; // Can be used to consider a logs "the same" (not worth re-printing) even if they have some different text
	if (lastStatusLog == uniquePart) return;
	lastStatusLog = uniquePart
	log(ns, status);
}

/** @param {NS} ns 
 * Helper to get a user's total money including stocks **/
function getLiquidationValue(ns, player) {
	// Hack: stats.js conveniently polls for our stock value. I'm just going to steal it from there.
	return player.money + Number(ns.read('/Temp/stock-portfolio-value.txt') || 0)
}

/** @param {NS} ns 
 * Append the specified text (with timestamp) to a persistent log in the home directory **/
async function persist_log(ns, text) {
	await ns.write(persistentLog, `${(new Date()).toISOString().substring(0, 19)} ${text}\n`, "a")
}