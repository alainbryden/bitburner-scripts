let doc = eval("document");
/** @param {NS} ns 
 *  Super recommend you kill all other scripts before starting this up. **/
export async function main(ns) {
	// Step 1: Route to the blackjack screen. (I opted to pay the 4 GB RAM to have this be instant and fool-proof as possible)
	if (ns.getPlayer().city != "Aevum") {
		if (!ns.travelToCity("Aevum"))
			return ns.tprint("ERROR: Sorry, you need at least 200k to travel to the casino.");
	}
	ns.goToLocation("Iker Molina Casino");
	const btnBlackjack = find("//button[contains(text(), 'blackjack')]");
	await click(btnBlackjack);
	// Get some buttons we will need
	const inputWager = find("//input[@value = 1000000]");
	const btnStartGame = find("//button[text() = 'Start']");
	const btnSaveGame = find("//button[@aria-label = 'save game']");
	await click(btnSaveGame); // Save the fact that this script is now running, so that future reloads start this script back up immediately.
	while (true) {
		const bet = Math.min(1E8, ns.getPlayer().money * 0.9 /* Avoid timing issues with other scripts spending money */);
		await setText(inputWager, `${bet}`);
		await click(btnStartGame);
		const btnHit = find("//button[text() = 'Hit']");
		const btnStay = find("//button[text() = 'Stay']");
		let won;
		do { // Play the game
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
				await ns.sleep(1);
			}
		} while (won === null);
		if (won === null) continue; // Only possible if we tied and broke out early. Start a new hand.
		if (!won) { // Reload if we lost
			eval("window").onbeforeunload = null; // Disable the unsaved changes warning before reloading
			location.reload(); // Force refresh the page without saving           
			return await ns.sleep(10000); // Keep the script alive to be safe. Presumably the page reloads before this completes.
		}
		await click(btnSaveGame);// Save if we won
		await ns.sleep(1);
	}
}
// Some DOM helpers (partial credit to ShamesBond)
async function click(elem) { await elem[Object.keys(elem)[1]].onClick({ isTrusted: true }); }
async function setText(input, text) { await input[Object.keys(input)[1]].onChange({ isTrusted: true, target: { value: text } }); }
function find(xpath) { return doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }