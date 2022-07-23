import { log, getConfiguration, getFilePath, waitForProcessToComplete, runCommand, getNsDataThroughFile, autoRetry } from './helpers.js'

const ran_flag = "/Temp/ran-casino.txt"
let doc = eval("document");
let options;
const argsSchema = [
	['save-sleep-time', 10], // Time to sleep in milliseconds after saving. If you are having trouble with your automatic saves not "taking effect" try increasing this.
	['click-sleep-time', 1], // Time to sleep in milliseconds after clicking any button (or setting text). Increase if your are getting errors on click.
	['use-basic-strategy', false], // Set to true to use the basic strategy (Stay on 17+)
	['enable-logging', false], // Set to true to pop up a tail window and generate logs.
	['kill-all-scripts', false], // Set to true to kill all running scripts before running.
	['no-deleting-remote-files', false], // By default, if --kill-all-scripts, we will also remove remote files to speed up save/reload
	['on-completion-script', null], // Spawn this script when max-charges is reached
	['on-completion-script-args', []], // Optional args to pass to the script when launched
];
export function autocomplete(data, args) {
	data.flags(argsSchema);
	const lastFlag = args.length > 1 ? args[args.length - 2] : null;
	if (["--on-completion-script"].includes(lastFlag))
		return data.scripts;
	return [];
}

let _ns; // Lazy global copy of ns so we can sleep in the click handler

/** Helper to open a tail window and log a message to the console and terminal. Useful when trying to inform the player of a failure.
 * @param {NS} ns **/
function tailAndLog(ns, message) {
	ns.tail();
	log(ns, message, true);
}

/** @param {NS} ns **/
export async function main(ns) {
	options = getConfiguration(ns, argsSchema);
	if (!options) return; // Invalid options, or ran in --help mode.
	_ns = ns;
	const saveSleepTime = options['save-sleep-time'];
	if (options['enable-logging'])
		ns.tail()
	else
		ns.disableLog("ALL");

	// Step 1: Go to Aevum if we aren't already there. (Must be done manually if you don't have SF4)
	if (ns.getPlayer().city != "Aevum") {
		try {
			if (ns.getPlayer().money < 200000 || !(await getNsDataThroughFile(ns, 'ns.singularity.travelToCity(ns.args[0])', '/Temp/travelToCity.txt', ["Aevum"])))
				return tailAndLog(ns, "ERROR: Sorry, you need at least 200k to travel to the casino.");
		} catch (err) {
			return tailAndLog(ns, "ERROR: You must manually travel to to Aevum to use this script until you get SF4");
		}
	}

	// Helper function to detect if the "Stop [[faction|company] work|styding|training]" etc... button from the focus screen is up
	const checkForFocusScreen = async () =>
		await findRetry(ns, "//button[contains(text(), 'Stop playing')]", true) ? false : // False positive, casino "stop" button, no problems here
			await findRetry(ns, "//button[contains(text(), 'Stop')]", true); // Otherwise, a button with "Stop" on it is probably from the work screen

	// Find the button used to save the game
	const btnSaveGame = await findRetry(ns, "//button[@aria-label = 'save game']");
	let inputWager, btnStartGame;

	// Step 2: Try to navigate to the blackjack game until successful, in case something repeatedly steals focus
	let attempts = 0;
	while (attempts++ <= 10) {
		if (attempts > 1) ns.sleep(1000);
		try {
			// Step 2.1: If the player is focused, stop the current action
			const btnStopAction = await checkForFocusScreen();
			if (btnStopAction) { // If we were performing an action unfocused, it will be focused on restart and we must stop that action to navigate.
				log(ns, "It looks like we're on a focus screen. Stopping whatever we're doing...")
				await click(btnStopAction);
			}
			// Step 2.2: Navigate to the City Casino
			try { // Try to do this without SF4, because it's faster and doesn't require a temp script to be cleaned up below
				// Click our way to the city casino
				await click(await findRetry(ns, "//div[(@role = 'button') and (contains(., 'City'))]"));
				await click(await findRetry(ns, "//span[@aria-label = 'Iker Molina Casino']"));
			} catch { // Use SF4 as a fallback, it's more reliable.
				try { await getNsDataThroughFile(ns, 'ns.singularity.goToLocation(ns.args[0])', '/Temp/goToLocation.txt', ["Iker Molina Casino"]); }
				catch { return tailAndLog(ns, "ERROR: Failed to travel to the casino both using UI navigation and using SF4 as a fall-back."); }
			}
			// Step 2.3: Try to start the blackjack game
			const blackjack = await findRetry(ns, "//button[contains(text(), 'blackjack')]");
			if (!blackjack) {
				tailAndLog(ns, `ERROR: Could not find the "Play blackjack" button. Did something steal focus? Trying again... ` +
					`Please post a full-game screenshot on Discord if you can't get past this point.`)
				continue; // Loop back to start and try again
			}
			await click(blackjack);

			// Step 2.4: Get some buttons we will need to play blackjack
			inputWager = await findRetry(ns, "//input[@value = 1000000]");
			btnStartGame = await findRetry(ns, "//button[text() = 'Start']");
			if (!inputWager || !btnStartGame) {
				tailAndLog(ns, `ERROR: Could not find one or more game controls. Did something steal focus? Trying again... ` +
					`Please post a full-game screenshot on Discord if you can't get past this point.`)
				continue; // Loop back to start and try again
			}

			// Step 2.5: Clean up temp files and kill other running scripts to speed up the reload cycle
			if (ns.ls("home", "/Temp/").length > 0) { // Do a little clean-up to speed up save/load.
				// Step 2.5.1: Test that we aren't already kicked out of the casino before doing drastic things like killing scripts
				await setText(inputWager, `1`); // Bet just a dollar and quick the game right away, no big deal
				await click(btnStartGame);
				if (await findRetry(ns, "//p[contains(text(), 'Count:')]", true, 10)) { // If this works, we're still allowed in
					const btnStay = await findRetry(ns, "//button[text() = 'Stay']", true);
					if (btnStay) await click(btnStay); // Trigger the game to end if we didn't instantly win/lose our $1 bet.
				} else { // Otherwise, we've probably been kicked out of the casino, but...
					// because we haven't killed scripts yet, it's possible another script stole focus again. Detect and handle that case.
					if (await checkForFocusScreen()) {
						log(ns, "ERROR: It looks like something stole focus while we were trying to automate the casino. Trying again.");
						continue; // Loop back to start and try again
					}
					await ns.write(ran_flag, true, "w"); // Write a flag other scripts can check for indicating we think we've been kicked out of the casino.
					return log(ns, "INFO: We appear to already have been previously kicked out of the casino.", true);
				}
				// Step 2.5.2: Kill all other scripts if enabled (note, we assume that if the temp folder is empty, they're already killed and this is a reload)
				if (options['kill-all-scripts'])
					await killAllOtherScripts(ns, !options['no-deleting-remote-files']);
				// Step 2.5.3: Clear the temp folder on home (all transient scripts / outputs)
				await waitForProcessToComplete(ns, ns.run(getFilePath('cleanup.js')));
			}
			break; // We achieved everthing we wanted, we can exit the while loop.
		} catch (err) {
			ns.tail(); // We're having difficulty, pop open a tail window so the user is aware.
			log(ns, `WARNING: casino.js Caught (and suppressed) an unexpected error while navigating to blackjack. Will try again...\n` +
				(typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
		}
	}

	if (ns.getPlayer().money < 1)
		return log(ns, "WARNING: Whoops, we have no money to bet! Kill whatever's spending it and try again later.", true, 'warning');

	// Step 3: Save the fact that this script is now running, so that future reloads start this script back up immediately.
	if (saveSleepTime) await ns.sleep(saveSleepTime); // Anecdotally, some users report the first save is "stale" (doesn't include casino.js running). Maybe this delay helps?
	await click(btnSaveGame);
	if (saveSleepTime) await ns.sleep(saveSleepTime);

	// Step 4: Play until we lose
	while (true) {
		const bet = Math.min(1E8, ns.getPlayer().money * 0.9 /* Avoid timing issues with other scripts spending money */);
		if (bet < 0) return await reload(ns); // If somehow we have no money, we can't continue
		await setText(inputWager, `${bet}`);
		await click(btnStartGame);
		const btnHit = await findRetry(ns, "//button[text() = 'Hit']");
		const btnStay = await findRetry(ns, "//button[text() = 'Stay']");
		let won;
		do { // Inner-loop to play a single hand
			won = await findRetry(ns, "//p[contains(text(), 'lost')]", true) ? false : // Detect whether we lost or won. Annoyingly, when we win with blackjack, "Won" is Title-Case.
				await findRetry(ns, "//p[contains(text(), 'won')]", true) ||
					await findRetry(ns, "//p[contains(text(), 'Won')]", true) ? true : null;
			if (won === null) {
				if (await findRetry(ns, "//p[contains(text(), 'Tie')]", true)) break; // If we tied, break and start a new hand.
				const txtCount = await findRetry(ns, "//p[contains(text(), 'Count:')]", true, 20);
				if (!txtCount) { // If we can't find the count, we've either been kicked out, or maybe routed to another screen.
					return await checkForFocusScreen() /* Detect the case where we started working/training */ ?
						log(ns, "ERROR: It looks like something stole focus while we were trying to automate the casino. Please try again.", true) :
						await onCompletion(ns); // Otherwise, assume we've been kicked out of the casino for having stolen the max 10b
				}
				const allCounts = txtCount.querySelectorAll('span');
				const highCount = Number(allCounts[allCounts.length - 1].innerText);
				const shouldHit = options['use-basic-strategy'] ? highCount < 17 : shouldHitAdvanced(ns, txtCount);
				if (options['enable-logging']) log(ns, `INFO: Count is ${highCount}, we will ${shouldHit ? 'Hit' : 'Stay'}`);
				await click(shouldHit ? btnHit : btnStay);
				await ns.sleep(1); // Yield for an instant so the UI can update and process events
			}
		} while (won === null);
		if (won === null) continue; // Only possible if we tied and broke out early. Start a new hand.
		if (!won) return await reload(ns); // Reload if we lost
		await click(btnSaveGame); // Save if we won
		if (saveSleepTime) await ns.sleep(saveSleepTime);
	}
}

/** Forces the game to reload (without saving). Great for save scumming.
 * WARNING: Doesn't work if the user last ran the game with "Reload and kill all scripts" 
 * @param {NS} ns */
async function reload(ns) {
	eval("window").onbeforeunload = null; // Disable the unsaved changes warning before reloading
	await ns.sleep(options['save-sleep-time']); // Yield execution for an instant incase the game needs to finish a save or something
	location.reload(); // Force refresh the page without saving           
	await ns.sleep(10000); // Keep the script alive to be safe. Presumably the page reloads before this completes.
}

/** @param {NS} ns 
 *  Helper to kill all scripts on all other servers, except this one **/
async function killAllOtherScripts(ns, removeRemoteFiles) {
	// Kill processes on home (except this one)
	let pid = await runCommand(ns, `ns.ps().filter(s => s.filename != ns.args[0]).forEach(s => ns.kill(s.pid));`,
		'/Temp/kill-everything-but.js', [ns.getScriptName()]);
	await waitForProcessToComplete(ns, pid);
	log(ns, `INFO: Killed other scripts running on home...`, true);

	// Kill processes on all other servers
	const allServers = await getNsDataThroughFile(ns, 'scanAllServers(ns)', '/Temp/scanAllServers.txt');
	const serversExceptHome = allServers.filter(s => s != "home");
	pid = await runCommand(ns, 'ns.args.forEach(host => ns.killall(host))',
		'/Temp/kill-all-scripts-on-servers.js', serversExceptHome);
	await waitForProcessToComplete(ns, pid);
	log(ns, 'INFO: Killed all scripts running on other hosts...', true);

	// If enabled, remove files on all other servers
	if (removeRemoteFiles) {
		pid = await runCommand(ns, 'ns.args.forEach(host => ns.ls(host).forEach(file => ns.rm(file, host)))',
			'/Temp/delete-files-on-servers.js', serversExceptHome)
		await waitForProcessToComplete(ns, pid);
		log(ns, 'INFO: Removed all files on other hosts...', true)
	}
}

/** @param {NS} ns 
 *  Run when we can no longer gamble at the casino (presumably because we've been kicked out) **/
async function onCompletion(ns) {
	await ns.write(ran_flag, true, "w"); // Write an file indicating we think we've been kicked out of the casino.
	log(ns, "SUCCESS: We've been kicked out of the casino.", true);

	// Run the completion script before shutting down    
	let completionScript = options['on-completion-script'];
	if (!completionScript) return;
	let completionArgs = options['on-completion-script-args'];
	if (ns.run(completionScript, 1, ...completionArgs))
		log(ns, `INFO: casino.js shutting down and launching ${completionScript}...`, false, 'info');
	else
		log(ns, `WARNING: casino.js shutting down, but failed to launch ${completionScript}...`, false, 'warning');
}

// Some DOM helpers (partial credit to @ShamesBond)
async function click(elem) {
	await elem[Object.keys(elem)[1]].onClick({ isTrusted: true });
	if (options['click-sleep-time']) await _ns.sleep(options['click-sleep-time']);
}
async function setText(input, text) {
	await input[Object.keys(input)[1]].onChange({ isTrusted: true, target: { value: text } });
	if (options['click-sleep-time']) await _ns.sleep(options['click-sleep-time']);
}
function find(xpath) { return doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }
async function findRetry(ns, xpath, expectFailure = false, retries = null) {
	try {
		return await autoRetry(ns, () => find(xpath), e => e !== undefined,
			() => expectFailure ? `It's looking like the element with xpath: ${xpath} isn't present...` :
				`Could not find the element with xpath: ${xpath}\nSomething may have re-routed the UI`,
			retries != null ? retries : expectFailure ? 3 : 10, 1, 2);
	} catch (e) {
		if (!expectFailure) throw e;
	}
}

// Better logic for when to HIT / STAY (Partial credit @drider)
function shouldHitAdvanced(ns, playerCountElem) {
	const txtPlayerCount = playerCountElem.textContent.substring(7);
	const player = parseInt(txtPlayerCount.match(/\d+/).shift());
	const dealer = getDealerCount();
	if (options['enable-logging']) log(ns, `Player Count Text: ${txtPlayerCount}, Player: ${player}, Dealer: ${dealer}`);
	// Strategy to minimize house-edge. See https://wizardofodds.com/blackjack/images/bj_4d_s17.gif
	if (txtPlayerCount.includes("or")) { // Player has an Ace
		if (player >= 9) return false; // Stay on Soft 19 or higher
		if (player == 8 && dealer <= 8) return false; // Soft 18 - Stay if dealer has 8 or less
		return true; // Otherwise, hit on Soft 17 or less
	}
	if (player >= 17) return false; // Stay on Hard 17 or higher
	if (player >= 13 && dealer <= 6) return false; // Stay if player has 13-16 and dealer shows 6 or less.
	if (player == 12 && 4 <= dealer && dealer <= 6) return false; // Stay if player has 12 and dealer has 4 to 6	
	return true;// Otherwise Hit
}
function getDealerCount() {
	const text = find("//p[contains(text(), 'Dealer')]/..").innerText.substring(8, 9);
	let cardValue = parseInt(text);
	return isNaN(cardValue) ? (text == 'A' ? 11 : 10) : cardValue;
}