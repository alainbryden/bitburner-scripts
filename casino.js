import { log, getFilePath, waitForProcessToComplete, runCommand, getNsDataThroughFile } from './helpers.js'

const ran_flag = "/Temp/ran-casino.txt"
let doc = eval("document");
let options;
const argsSchema = [
	['save-sleep-time', 5], // Time to sleep in milliseconds after saving. If you are having trouble with your automatic saves not "taking effect" try increasing this.
	['use-basic-strategy', false], // Set to true to use the basic strategy (Stay on 17+)
	['enable-logging', false], // Set to true to pop up a tail window and generate logs.
	['kill-all-scripts', false], // Set to true to kill all running scripts before running.
	['no-deleting-remote-files', false], // By default, if --kill-all-scripts, we will also remove remote files to speed up save/reload
	['on-completion-script', null], // Spawn this script when max-charges is reached
	['on-completion-script-args', []], // Optional args to pass to the script when launched
];
export function autocomplete(data, _) {
	data.flags(argsSchema);
	return [];
}

/** @param {NS} ns 
 *  Super recommend you kill all other scripts before starting this up. **/
export async function main(ns) {
	options = ns.flags(argsSchema);
	const saveSleepTime = options['save-sleep-time'];
	if (options['enable-logging'])
		ns.tail()
	else
		ns.disableLog("ALL");

	// Step 1: Go to Aevum if we aren't already there. (Must be done manually if you don't have SF4)
	if (ns.getPlayer().city != "Aevum") {
		try {
			if (ns.getPlayer().money < 200000 || !(await getNsDataThroughFile(ns, 'ns.travelToCity("Aevum")', '/Temp/travel-to-city.txt')))
				return ns.tprint("ERROR: Sorry, you need at least 200k to travel to the casino.");
		} catch (err) {
			return ns.tprint("ERROR: You must manually travel to to Aevum to use this script until you get SF4");
		}
	}

	// Step 2: Navigate to the City Casino
	try { // Try to do this without SF4, because it's faster and doesn't require a temp script to be cleaned up below
		const btnStopAction = find("//button[contains(text(), 'Stop')]");
		if (btnStopAction) // If we were performing an action unfocused, it will be focused on restart and we must stop that action to navigate.
			await click(btnStopAction);
		// Click our way to the city casino
		await click(find("//div[(@role = 'button') and (contains(., 'City'))]"));
		await click(find("//span[@aria-label = 'Iker Molina Casino']"));
	} catch { // Use SF4 as a fallback, it's more reliable.
		try { await getNsDataThroughFile(ns, 'ns.goToLocation("Iker Molina Casino")', '/Temp/go-to-location.txt'); }
		catch { return ns.tprint("ERROR: Failed to travel to the casino both using UI navigation and using SF4 as a fall-back."); }
	}
	// Pick the game we wish to automate (Blackjack)
	await click(find("//button[contains(text(), 'blackjack')]"));

	// Step 3: Get some buttons we will need to play blackjack
	const inputWager = find("//input[@value = 1000000]");
	const btnStartGame = find("//button[text() = 'Start']");
	const btnSaveGame = find("//button[@aria-label = 'save game']");

	// Step 4: Clean up temp files and kill other running scripts to speed up the reload cycle
	if (ns.ls("home", "/Temp/").length > 0) { // Do a little clean-up to speed up save/load.
		// Step 4.5: Test that we aren't already kicked out of the casino before doing drastic things like killing scripts
		await setText(inputWager, `1`); // Bet just a dollar and quick the game right away, no big deal
		await click(btnStartGame);
		if (find("//p[contains(text(), 'Count:')]")) {
			const btnStay = find("//button[text() = 'Stay']");
			if (btnStay) await click(btnStay); // Trigger the game to end if we didn't instantly win/lose our $1 bet.
		} else {
			// TODO: Gah, because we haven't killed scripts, it's possible another script stole focus. Detect and handle that case.
			await ns.write(ran_flag, true, "w"); // Write a flag other scripts can check for indicating we think we've been kicked out of the casino.
			return ns.tprint("INFO: We've appear to already have been previously kicked out of the casino.");
		}
		// Kill all other scripts if enabled (note, we assume that if the temp folder is empty, they're already killed and this is a reload)
		await killAllOtherScripts(ns, !options['no-deleting-remote-files']);
		// Clear the temp folder on home (all transient scripts / outputs)
		await waitForProcessToComplete(ns, ns.run(getFilePath('cleanup.js')));
	}

	// Step 5: Save the fact that this script is now running, so that future reloads start this script back up immediately.
	if (saveSleepTime) await ns.asleep(saveSleepTime); // Anecdotally, some users report the first save is "stale" (doesn't include blackjack.js running). Maybe this delay helps?
	await click(btnSaveGame);
	if (saveSleepTime) await ns.asleep(saveSleepTime);

	// Step 6: Play until we lose
	while (true) {
		const bet = Math.min(1E8, ns.getPlayer().money * 0.9 /* Avoid timing issues with other scripts spending money */);
		await setText(inputWager, `${bet}`);
		await click(btnStartGame);
		const btnHit = find("//button[text() = 'Hit']");
		const btnStay = find("//button[text() = 'Stay']");
		let won;
		do { // Inner-loop to play a single hand
			won = find("//p[contains(text(), 'lost')]") ? false : // Detect whether we lost or won. Annoyingly, when we win with blackjack, "Won" is Title-Case.
				find("//p[contains(text(), 'won')]") || find("//p[contains(text(), 'Won')]") ? true : null;
			if (won === null) {
				if (find("//p[contains(text(), 'Tie')]")) break; // If we tied, break and start a new hand.
				const txtCount = find("//p[contains(text(), 'Count:')]");
				if (!txtCount) { // I'm incapable of producing a bug, so clearly the only reason for this failing is we've won.
					return await onCompletion(ns);
				}
				const allCounts = txtCount.querySelectorAll('span');
				const highCount = Number(allCounts[allCounts.length - 1].innerText);
				const shouldHit = options['use-basic-strategy'] ? highCount < 17 : shouldHitAdvanced(ns, txtCount);
				if (options['enable-logging']) ns.print(`INFO: Count is ${highCount}, we will ${shouldHit ? 'Hit' : 'Stay'}`);
				await click(shouldHit ? btnHit : btnStay);
				await ns.sleep(1); // Yeild for an instant so the UI can update and process events
			}
		} while (won === null);
		if (won === null) continue; // Only possible if we tied and broke out early. Start a new hand.
		if (!won) { // Reload if we lost
			eval("window").onbeforeunload = null; // Disable the unsaved changes warning before reloading
			await ns.sleep(1); // Yeild execution for an instant incase the game needs to finish a save or something
			location.reload(); // Force refresh the page without saving           
			return await ns.asleep(10000); // Keep the script alive to be safe. Presumably the page reloads before this completes.
		}
		await click(btnSaveGame); // Save if we won
		if (saveSleepTime) await ns.asleep(saveSleepTime);
	}
}

/** @param {NS} ns 
 *  Helper to kill all scripts on all other servers, except this one **/
async function killAllOtherScripts(ns, removeRemoteFiles) {
	// Kill processes on home (except this one)
	const thisScript = ns.getScriptName();
	const otherPids = ns.ps().filter(p => p.filename != thisScript).map(p => p.pid);
	let pid = await runCommand(ns, 'ns.args.forEach(pid => ns.kill(pid))',
		'/Temp/kill-scripts-by-id.js', otherPids);
	await waitForProcessToComplete(ns, pid);
	log(ns, `INFO: Killed ${otherPids.length} other scripts running on home...`, true);

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
	ns.tprint("SUCCESS: We've been kicked out of the casino.");

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
async function click(elem) { await elem[Object.keys(elem)[1]].onClick({ isTrusted: true }); }
async function setText(input, text) { await input[Object.keys(input)[1]].onChange({ isTrusted: true, target: { value: text } }); }
function find(xpath) { return doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }

// Better logic for when to HIT / STAY (Partial credit @drider)
function shouldHitAdvanced(ns, playerCountElem) {
	const txtPlayerCount = playerCountElem.textContent.substring(7);
	const player = parseInt(txtPlayerCount.match(/\d+/).shift());
	const dealer = getDealerCount();
	if (options['enable-logging']) ns.print(`Player Count Text: ${txtPlayerCount}, Player: ${player}, Dealer: ${dealer}`);
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