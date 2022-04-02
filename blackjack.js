import { getFilePath, waitForProcessToComplete, getActiveSourceFiles, getNsDataThroughFile } from './helpers.js'

let doc = eval("document");
/** @param {NS} ns 
 *  Super recommend you kill all other scripts before starting this up. **/
export async function main(ns) {
	// Step 1: Route to the blackjack screen. (I opted to pay the 4 GB RAM to have this be instant and fool-proof as possible)
	const ownedSourceFiles = await getActiveSourceFiles(ns);
	if (ns.getPlayer().city != "Aevum") {
		if (!(4 in ownedSourceFiles))
			return ns.tprint("ERROR: You must manually travel to to Aevum to use this script.");
		if (ns.getPlayer().money < 200000 || !(await getNsDataThroughFile(ns, 'ns.travelToCity("Aevum")', '/Temp/travel-to-city.txt')))
			return ns.tprint("ERROR: Sorry, you need at least 200k to travel to the casino.");
	}
	if (!(4 in ownedSourceFiles) || !(await getNsDataThroughFile(ns, 'ns.goToLocation("Iker Molina Casino")', '/Temp/go-to-location.txt'))) {
		let btnGoToCasino = find("//span[@aria-label = 'Iker Molina Casino']");
		if (!btnGoToCasino) {// TODO: Need an automatic way to navigate to the CITY screen
			ns.tprint("INFO: Quick! Click the City tab. You have 5 seconds...")
			await ns.asleep(5000);
			btnGoToCasino = find("//span[@aria-label = 'Iker Molina Casino']");
		}
		await click(btnGoToCasino);
	}
	const btnBlackjack = find("//button[contains(text(), 'blackjack')]");
	if (!btnBlackjack) return tprint("ERROR: Attempt to automatically navigate to the Casino appears to have failed.");
	await click(btnBlackjack);
	// Step 2: Get some buttons we will need
	const inputWager = find("//input[@value = 1000000]");
	const btnStartGame = find("//button[text() = 'Start']");
	const btnSaveGame = find("//button[@aria-label = 'save game']");
	// Step 3: Save the fact that this script is now running, so that future reloads start this script back up immediately.
	if (ns.ls("home", "/Temp/").length > 0) // Do a little clean-up to speed up save/load.
		await waitForProcessToComplete(ns, ns.run(getFilePath('cleanup.js')));
	await ns.sleep(5); // Anecdotally, some users report the first save is "stale" (doesn't include blackjack.js running). Maybe this delay helps?
	await click(btnSaveGame);
	await ns.sleep(5); // Assume the game didn't save instantly and give it some time
	while (true) {
		const bet = Math.min(1E8, ns.getPlayer().money * 0.9 /* Avoid timing issues with other scripts spending money */);
		await setText(inputWager, `${bet}`);
		await click(btnStartGame);
		const btnHit = find("//button[text() = 'Hit']");
		const btnStay = find("//button[text() = 'Stay']");
		let won;
		do { // Step 3: Play the game
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
			location.reload(); // Force refresh the page without saving           
			return await ns.sleep(10000); // Keep the script alive to be safe. Presumably the page reloads before this completes.
		}
		await click(btnSaveGame); // Save if we won
		await ns.sleep(10); // Assume the game didn't save instantly and give it some time
	}
}
// Some DOM helpers (partial credit to ShamesBond)
async function click(elem) { await elem[Object.keys(elem)[1]].onClick({ isTrusted: true }); }
async function setText(input, text) { await input[Object.keys(input)[1]].onChange({ isTrusted: true, target: { value: text } }); }
function find(xpath) { return doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }