import { getFilePath, waitForProcessToComplete, getNsDataThroughFile } from './helpers.js'

let doc = eval("document");
const argsSchema = [
	['save-sleep-time', 5], // Time to sleep in milliseconds after saving. If you are having trouble with your automatic saves not "taking effect" try increasing this.
];
export function autocomplete(data, _) {
	data.flags(argsSchema);
	return [];
}

/** @param {NS} ns 
 *  Super recommend you kill all other scripts before starting this up. **/
export async function main(ns) {
	const options = ns.flags(argsSchema);
	const saveSleepTime = options['save-sleep-time'];
	ns.disableLog("asleep");
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
	// Step 4: Save the fact that this script is now running, so that future reloads start this script back up immediately.
	if (ns.ls("home", "/Temp/").length > 0) // Do a little clean-up to speed up save/load.
		await waitForProcessToComplete(ns, ns.run(getFilePath('cleanup.js')));
	if (saveSleepTime) await ns.asleep(saveSleepTime); // Anecdotally, some users report the first save is "stale" (doesn't include blackjack.js running). Maybe this delay helps?
	await click(btnSaveGame);
	if (saveSleepTime) await ns.asleep(saveSleepTime);
	// Step 5: Play until we lose
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
				if (!txtCount) return ns.tprint("SUCCESS: We've been kicked out of the casino."); // I'm incapable of producing a bug, so clearly the only reason for this.              
				const allCounts = txtCount.querySelectorAll('span');
				const highCount = Number(allCounts[allCounts.length - 1].innerText);
				ns.print(`INFO: Count is ${highCount}, we will ${highCount < 17 ? 'Hit' : 'Stay'}`);
				await click(highCount < 17 ? btnHit : btnStay);
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
// Some DOM helpers (partial credit to ShamesBond)
async function click(elem) { await elem[Object.keys(elem)[1]].onClick({ isTrusted: true }); }
async function setText(input, text) { await input[Object.keys(input)[1]].onChange({ isTrusted: true, target: { value: text } }); }
function find(xpath) { return doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }