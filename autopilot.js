import {
	log, getFilePath, instanceCount, getNsDataThroughFile, waitForProcessToComplete, getActiveSourceFiles,
	formatMoney, formatDuration
} from './helpers.js'

const persistentLog = "log.autopilot.txt";
const factionManagerOutputFile = "/Temp/affordable-augs.txt"; // Temp file produced by faction manager with status information
const casinoOutputFile = "/Temp/ran-casino.txt";

let options = null; // The options used at construction time
// TODO: Currently these may as well be hard-coded, args are lost when various other scripts kill and restart us.
const argsSchema = [ // The set of all command line arguments
	['next-bn', 12], // If we destroy the current BN, the next BN to start
	['install-at-aug-count', 10], // Automatically install when we can afford this many new augmentations (with NF only counting as 1)
	['install-at-aug-plus-nf-count', 15], // or... automatically install when we can afford this many augmentations including additional levels of Neuroflux
	['install-for-augs', ["The Red Pill", "The Blade's Simulacrum"]], // or... automatically install as soon as we can afford one of these augmentations
	['reduced-aug-requirement-per-hour', 1], // For every hour since the last reset, require this many fewer augs to install.
	['interval', 5000], // Wake up this often (milliseconds) to check on things
	['interval-check-scripts', 60000], // Get a listing of all running processes on home this frequently
	['high-hack-threshold', 8000], // Once hack level reaches this, we start daemon in high-performance hacking mode
];
export function autocomplete(data, args) {
	data.flags(argsSchema);
	return [];
}

let sourceFiles;
let reservedPurchase; // Flag to indicate whether we've reservedPurchase money and can still afford augmentations
let ranCasino; // Flag to indicate whether we've stolen 10b from the casino yet
let reservedCasino; // Flag to indicate whether we've stolen 10b from the casino yet
let lastScriptsCheck; // Last time we got a listing of all running scripts
let wdUnavailable; // A flag indicating whether the BN is completable on this reset

/** @param {NS} ns **/
export async function main(ns) {
	if (await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
	options = ns.flags(argsSchema);
	log(ns, "INFO: Auto-pilot engaged...", true, 'info');

	// Clear reset global state
	wdUnavailable = reservedPurchase = ranCasino = reservedCasino = false;
	lastScriptsCheck = 0;

	sourceFiles = await getActiveSourceFiles(ns, false);
	const player = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/getPlayer.txt');
	if (!(4 in sourceFiles) && player.bitNodeN != 4)
		return log(ns, `ERROR: This script requires SF4 (singularity) functions to work.`, true, 'ERROR');
	if (player.playtimeSinceLastBitnode < 60000)
		await initializeNewBitnode(ns);

	// Main loop: Monitor progress in the current BN and automatically reset when we can afford TRP, or N augs.
	while (true) {
		try {
			await mainLoop(ns);
		} catch (error) {
			log(ns, `WARNING: Caught (and suppressed) an unexpected error in the main loop:\n${String(error)}`, false, 'warning');
		}
		await ns.asleep(options['interval']);
	}
}

/** @param {NS} ns 
 * Logic run periodically throughout the BN **/
async function initializeNewBitnode(ns) {
	// Clean up all temporary scripts, which will include stale temp files
	if (ns.run(getFilePath('cleanup.js')))
		log(ns, `INFO: Launched cleanup.js`, true, 'info');
	else
		log(ns, `ERROR: Failed to launch cleanup.js`, true, 'error');
	await ns.sleep(200); // Wait a short while for the dust to settle.
}

/** @param {NS} ns 
 * Logic run periodically throughout the BN **/
async function mainLoop(ns) {
	const player = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/getPlayer.txt');
	await checkIfBnIsComplete(ns, player);
	await checkOnRunningScripts(ns, player);
	if (!ranCasino)
		await maybeDoCasino(ns, player);
	if (!(await shouldDelayInstall(ns, player))) // If we're currently in a state where we should not be resetting, skip reset logic
		await maybeInstallAugmentations(ns, player);
}

/** @param {NS} ns 
 * Logic run periodically throughout the BN **/
async function checkIfBnIsComplete(ns, player) {
	if (wdUnavailable) return;
	const wdHack = await getNsDataThroughFile(ns,
		'ns.serverExists("w0r1d_d43m0n") ? ns.getServerRequiredHackingLevel("w0r1d_d43m0n") : Number.POSITIVE_INFINITY',
		'/Temp/wd-hackingLevel.txt');
	wdUnavailable = !isFinite(wdHack);
	if (player.hacking >= wdHack) {
		const text = `BN ${player.bitNodeN}.${sourceFiles[player.bitNodeN] + 1} completed at ${formatDuration(player.playtimeSinceLastBitnode)}`;
		await persist_log(ns, text);
		log(ns, `SUCCESS: ${text}`, true, 'success');
	}
	// TODO: Use the new singularity function coming soon to automate entering a new BN
	wdUnavailable = true; // For now, set this so this doesn't run again
}

/** @param {NS} ns 
 * Logic to ensure scripts are running to progress the BN **/
async function checkOnRunningScripts(ns, player) {
	if (lastScriptsCheck > Date.now() - options['interval-check-scripts']) return;
	lastScriptsCheck = Date.now();
	const runningScripts = await getNsDataThroughFile(ns, 'ns.ps()', '/Temp/ps.txt');

	// TODO: If stanek's gift is accepted and not charged, launch it first
	// TODO: Maybe launch stock-master early to let it get a chunk of the casino 10b before it's all blown on servers
	// TODO: Maybe launch work-for-faction with different arguments depending on where we're at

	// Ensure daemon.js is running in some form
	const daemon = runningScripts.filter(s => s.filename == getFilePath('daemon.js'))[0];
	// If player hacking level is about 8000, run in "start-tight" mode
	const hackThreshold = options['high-hack-threshold'];
	const daemonArgs = player.hacking < hackThreshold ? ["--stock-manipulation"] :
		// Launch daemon in "looping" mode if we have sufficient hack level
		["--looping-mode", "--recovery-thread-padding", 10, "--cycle-timing-delay", 2000, "--queue-delay", "10",
			"--stock-manipulation-focus", "--silent-misfires", "--initial-max-targets", "63", "--no-share"];
	if (!daemon || player.hacking >= hackThreshold && !daemon.args.includes("--looping-mode")) { // Launch or re-launch daemon
		if (ns.run(getFilePath('daemon.js'), 1, ...daemonArgs)) {
			if (player.hacking >= hackThreshold)
				log(ns, `INFO: Hack level (${player.hacking}) is >= ${hackThreshold} (--high-hack-threshold): Starting daemon.js in high-performance hacking mode.`);
			log(ns, `INFO: Launched daemon.js with args: [${daemonArgs.join(", ")}]`, true, 'info');
		} else
			log(ns, `ERROR: Failed to launch daemon.js with args: [${daemonArgs.join(", ")}]`, true, 'error');
	}
}

/** @param {NS} ns 
 * Logic to steal 10b from the casino **/
async function maybeDoCasino(ns, player) {
	if (ranCasino) return;
	if (ns.read(casinoOutputFile)) { // Check for a file that indicates casino.js ran to completion
		await ns.write("reserve.txt", 0, "w"); // Remove the casino reserve we would have placed
		return ranCasino = true;
	}
	if (player.playtimeSinceLastAug < 60000) // If it's been less than 1 minute, wait a while to establish income
		return;
	if (player.money / player.playtimeSinceLastAug > 5e9 / 60000) // If we're making more than ~5b / minute, no need to run casino.
		return ranCasino = true;
	if (player.money > 10E9) // If we already have 10b, assume we ran and lost track, or just don't need the money
		return ranCasino = true;
	if (player.money < 210000) { // We need at least 200K (and change) to run casino so we can travel to aevum
		if (reservedCasino) return; // Avoid repeatedly setting the reserve while waiting for money to increase
		await ns.write("reserve.txt", 300000, "w"); // Should prevent other scripts from spending our casino seed money
		return reservedCasino = true;
	}
	// Run casino.js and expect ourself to get killed in the process
	if (ns.run(getFilePath('casino.js'), 1, 'kill-all-scripts', true,
		// TODO: Preserve the current script's state / args through the reset
		'--on-completion-script', ns.getScriptName()))
		log(ns, `INFO: Launched casino.js`, true, 'info');
	else
		log(ns, `ERROR: Failed to launch casino.js`, true, 'error');
	await ns.asleep(30000); // Sleep for 30 seconds. Casino.js should kill/restart us before that long.
}

let lastAugCheckLog = "";

/** @param {NS} ns 
 * Logic to detect if it's a good time to install augmentations, and if so, do so **/
async function maybeInstallAugmentations(ns, player) {
	// If we previously attempted to reserve money for an augmentation purchase order, do a fresh facman run to ensure it's still available
	if (reservedPurchase) {
		log(ns, "INFO: Manually running faction-manager.js to ensure previously reserved purchase is still obtainable.");
		await ns.write(factionManagerOutputFile, "", "w"); // Reset the output file to ensure it isn't stale
		const pid = ns.run(getFilePath('faction-manager.js'));
		await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down (and output to be generated)
	}

	const reducedAugReq = Math.floor(options['reduced-aug-requirement-per-hour'] * player.playtimeSinceLastAug / 3.6E6);
	// Grab the latest output from faction manager to see if it's a good time to reset
	const facmanOutput = ns.read(factionManagerOutputFile);
	if (!facmanOutput)
		return reservedPurchase = false;
	// Parse the output
	const facman = JSON.parse(facmanOutput); // { affordable_nf_count: int, affordable_augs: [string], owned_count: int, unowned_count: int, total_rep_cost: number, total_aug_cost: number }
	const affordableAugCount = facman.affordable_augs.length;
	const augsNeeded = Math.max(1, options['install-at-aug-count'] - reducedAugReq);
	const augsNeededInclNf = Math.max(1, options['install-at-aug-plus-nf-count'] - reducedAugReq);
	const shouldReset = options['install-for-augs'].some(a => facman.affordable_augs.includes(a)) ||
		affordableAugCount >= augsNeeded || (affordableAugCount + facman.affordable_nf_count - 1) >= augsNeededInclNf;
	const augSummary = `${formatMoney(facman.total_rep_cost + facman.total_aug_cost)} for ${facman.affordable_nf_count} levels of ` +
		`NeuroFlux and ${affordableAugCount} of ${facman.unowned_count} remaining unique augmentations: ${facman.affordable_augs.join(", ")}`;
	// If this is worth resetting for, ensure the money doesn't get ripped out from under us by reserving the cost and waiting one more loop
	if (shouldReset && !reservedPurchase) {
		log(ns, `INFO: Reserving ${augSummary}`, true, 'info');
		await ns.write("reserve.txt", facman.total_rep_cost + facman.total_aug_cost, "w"); // Should prevent other scripts from spending this money
		reservedPurchase = true; // Set a flag so that on our next loop, we actually try to execute the purchase
	} else if (shouldReset && reservedPurchase) {
		const resetLog = `Invoking ascend.js at ${formatDuration(player.playtimeSinceLastAug)} since last aug to install: ${augSummary}`;
		log(ns, `INFO: ${resetLog}`, true, 'info');
		await persist_log(ns, resetLog);
		if (ns.run(getFilePath('ascend.js'), 1, '--install-augmentations', true,
			// TODO: Preserve the current script's state / args through the reset
			'--on-reset-script', ns.getScriptName(),
			// Until there's an officially supported way to automate accepting stanek's gift, bypass it.
			'--bypass-stanek-warning', true))
			log(ns, `INFO: Launched ascend.js`, true, 'info');
		else
			log(ns, `ERROR: Failed to launch ascend.js`, true, 'error');
		await ns.asleep(30000); // Sleep for 30 seconds. Ascend should reset and kill/restart us before that long.
		log(ns, "ERROR: We tried to ascend, but we're still here?", true, 'error')
	} else {
		if (lastAugCheckLog != augSummary)
			log(ns, `Currently at ${formatDuration(player.playtimeSinceLastAug)} since last aug. ` +
				`Need ${augsNeeded} unique augs or ${augsNeededInclNf} including NeuroFlux levels to install.\n` +
				`Can afford: ${augSummary}`);
		lastAugCheckLog = augSummary;
		reservedPurchase = false;
	}
}

/** @param {NS} ns 
 * Logic to detect if we are close to a milestone and should postpone installing augmentations until it is hit **/
async function shouldDelayInstall(ns, player) {
	// TODO: Bladeburner black-op in progress
	// TODO: Close to being able to afford 4S TIX data?
	// TODO: Close to the rep needed for unlocking donations with a new faction?
	return false;
}

/** @param {NS} ns 
 * Append the specified text (with timestamp) to a persistent log in the home directory **/
async function persist_log(ns, text) {
	await ns.write(persistentLog, `${(new Date()).toISOString().substring(0, 19)} ${text}\n`, "a")
}