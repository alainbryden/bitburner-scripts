import {
    log, getConfiguration, getFilePath, waitForProcessToComplete,
    runCommand, getNsDataThroughFile, formatMoney, getErrorInfo, tail
} from './helpers.js'

const argsSchema = [
    ['save-sleep-time', 10], // Time to sleep in milliseconds before and after saving. If you are having trouble with your automatic saves not "taking effect" try increasing this.
    ['click-sleep-time', 5], // Time to sleep in milliseconds before and after clicking any button (or setting text). Increase if clicks don't appear to be "taking effect".
    ['find-sleep-time', 0], // Time to sleep in milliseconds before (but not after) trying to find any element on screen. Increase if you are frequently getting errors detecting elements that should be on screen.
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

/** @param {NS} ns **/
export async function main(ns) {
    // Note to self: This script doesn't use ram-dodging in the inner loop, because we want to
    // delete all temp files and avoid creating more so that the game saves / reloads faster.
    const supportMsg = "Consider posting a full-game screenshot and your save file in the Discord channel or in a new github issue if you want help debugging this issue.";
    let doc = eval("document");
    let options;
    let verbose = false;

    async function start() {
        options = getConfiguration(ns, argsSchema);
        if (!options) return; // Invalid options, or ran in --help mode.
        const saveSleepTime = options['save-sleep-time'];
        verbose = options['enable-logging'];
        if (verbose)
            tail(ns)
        else
            ns.disableLog("ALL");

        let abort = false;
        /*// TODO:
        // Let the user know what's going on and give them an easy way to kill casino.js
        function showDialog(onCancel) {
            const dlg = doc.createElement('div');
            dlg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:20px;';
            dlg.innerHTML = `<p>casino.js is running until it wins \$10b. It will reload the save if it loses too much.<br/>` +
                `It should only take a minute or two, but you can cancel by clicking the button below.</p>` +
                `<button>Cancel</button>`;
            dlg.querySelector('button').onclick = () => { onCancel(); doc.body.removeChild(dlg); };
            doc.body.appendChild(dlg);
        }
        showDialog(() => abort = true);
        //*/

        /** Helper function to detect if focus was stolen by (e.g.) faction|company work|studying|training and send that work to the background
         * @param {boolean} throwError (default true) If true, and we were doing focus work, throws an Error.
         *                  If false, it will log a warning, try to stop any focus work (up to `retries` times), then return true.
         * @param {number} retries (default 0) Only applicable if `throwErrorIfNot` is false. Try this many times to stop focus work before throwing an error.
         * @param {silent} (default false) Set to true to suppress the warning popup if throwError is false and something has focus.
         * @returns {Promise<boolean>} false if focus was not stolen, true if it was and `throwErrorIfNot` is false. */
        async function checkForStolenFocus(throwError = true, retries = 0, silent = false) {
            // See if we are on the "focus" (work/study/training) screen
            const btnUnfocus = await tryfindElement("//button[text()='Do something else simultaneously']");
            if (!btnUnfocus) return false; // All good, we aren't focus-working on anything
            let baseMessage = "It looks like something stole focus while casino.js was trying to automate the casino.";
            if (throwError) // If we weren't instructed to stop whatever took focus, raise an error
                throw new Error(baseMessage + `\nPlease ensure no other scripts are running and try again.`);
            // Otherwise, log a warning, and return true (focus was stolen)
            log(ns, (silent ? `INFO` : `WARNING`) + `: ${baseMessage}\nTrying to un-focus it so we can keep going...`, false, (silent ? undefined : `WARNING`));
            await click(btnUnfocus); // Click the button that should let us take back focus and return to the casino
            // Now we should confirm that we're no longer doing focus work (that the click above worked) by recursing.
            retries--; // Decrement "retries" each time we discover we're still on the focus screen.
            return await checkStillAtCasino(retries <= 0, retries); // If out of retries, throw error on next failure
        }

        /** Helper function to detect if we're still at the casino (returns true) or if we've left.
         * If not, checks explicitly if focus was stolen by (e.g.) faction|company work|studying|training and sends that work to the background
         * @param {boolean} throwError (default true) If true, and we are no longer on the casino page, throws an Error.
         *                  If false, it will log a warning, try to stop any focus work (up to `retries` times), then return true.
         * @param {silent} (default false) Set to true if we fully expect not to be at the casino yet, so we don't want to log a warning if that is the case.
         * @returns {Promise<boolean>} true if we are still at the casino, false we are not and `throwErrorIfNot` is false. */
        async function checkStillAtCasino(throwError = true, silent = false) {
            // Check whether we're still on the casino page
            let stillAtCasino = await tryfindElement("//h4[text()='Iker Molina Casino']", silent ? 3 : 10);
            if (stillAtCasino) return true; // All seems good, nothing is stealing focus
            // If we're not still at the casino, see if we are on the "focus" (work/study/training) screen
            const focusWasStolen = await checkForStolenFocus(throwError, silent ? 3 : 1);
            // If we aren't meant to log a warning, or focus was stolen (which has now been deal with) we can return
            if (focusWasStolen || silent)
                return false; // Do not log a warning
            // Otherwise, something else took us away from the casino page when we expected to be there
            let baseMessage = "It looks like the user (or another script) navigated away from the casino page" +
                " while casino.js was trying to automate the casino.";
            if (throwError) // If we weren't instructed to stop whatever took focus, raise an error
                throw new Error(baseMessage + `\nPlease ensure no other scripts are running and try again ` +
                    `(or ignore this error if you left the casino on purpose.)`);
            // Otherwise, log a warning, and return false (no longer at the casino)
            log(ns, `WARNING: ${baseMessage}`, false, 'warning');
            return false;
        }

        // Helper function to detect getting kicked out of the casino
        /** Helper function to detect getting kicked out of the casino.
         * @param {int?} retries (default 10) how many times to check for each element before deciding they aren't there
         * @returns {Promise<boolean>} true if there is an open dialog telling us we've been kicked out of the casino */
        async function checkForKickedOut(retries = 10) {
            let closeModal;
            do {
                const kickedOut = await tryfindElement("//span[contains(text(), 'Alright cheater get out of here')]", retries);
                if (kickedOut !== null) return true; // Success: We've been kicked out
                // If there are any other modals, they may need to be closed before we can see the kicked out alert.
                let closeModal = await tryfindElement("//button[contains(@class,'closeButton')]", retries);
                if (!closeModal) break; // There appears to be no other modals blocking in the way
                log(ns, "Found a modal that needs to be closed.")
                await click(closeModal); // Click the close button on this modal so we can see others behind it
            } while (closeModal !== null);
            return false;
        }

        // Run this to try and pre-emptively clear away any modals that pop up when we restart.
        // Note that at game startup it seems to take a long while for these to be detected,
        // so we might miss them, but we don't want to slow down the reload-loop too much by waiting to clear them.
        await checkForKickedOut(3);

        // Step 1: Find the button used to save the game. (Lots of retries because it can take a while after reloading the page)
        const btnSaveGame = await findRequiredElement("//button[@aria-label = 'save game']", 100,
            `Sorry, couldn't find the Overview Save (💾) button. Is your \"Overview\" panel collapsed or modded?`, true);
        async function saveGame() {
            if (saveSleepTime) await ns.sleep(saveSleepTime);
            await click(btnSaveGame);
            if (saveSleepTime) await ns.sleep(saveSleepTime);
        }
        let inputWager, btnStartGame;

        // Note, we deliberately DO NOT pre-emptively check our active source files, or do any kind of RAM dodging
        // const unlockedSFs = await getActiveSourceFiles(ns, true); // See if we have SF4 to travel automatically
        // Why? Because this creates "Temp files", and we want to keep the save file as small as possible for fast saves and reloads.
        //      We use an empty temp folder as a sign that we previously ran and killed all scripts and can safely proceed.

        // Step 2: Try to navigate to the blackjack game (with retries in case of transient errors)
        let priorAttempts = 0;
        while (true) {
            if (priorAttempts > 0)
                await ns.sleep(1000);
            try {
                // Step 2.1: Each time this while loop restarts, check if the player is focused, and stop whatever they're doing.
                await checkForStolenFocus(false, // throwError: false - because we have yet to travel to the casino
                    3, true); // silent: true - means don't raise a warning if we're focus-working. Just background it.

                // Step 2.2: Go to Aevum if we aren't already there. (Must be done manually if you don't have SF4)
                if (ns.getPlayer().city != "Aevum") {
                    if (ns.getPlayer().money < 200000)
                        throw new Error("Sorry, you need at least 200k to travel to the casino.");
                    let travelled = false;
                    try {
                        travelled = await getNsDataThroughFile(ns, 'ns.singularity.travelToCity(ns.args[0])', null, ["Aevum"]);
                    } catch { }
                    if (!travelled) // Note: While it would be nice to confirm whether we have SF4 for the message, it's not worth the cost.
                        log(ns, "INFO: Canot use singularity travel to Aevum via singularity. We will try to go there manually for now.", true);
                    // If automatic travel failed or couldn't be attempted, try clicking our way there!
                    if (!travelled) {
                        await click(await findRequiredElement("//div[@role='button' and ./div/p/text()='Travel']"));
                        await click(await findRequiredElement("//span[contains(@class,'travel') and ./text()='A']"));
                        // If this didn't put us in Aevum, there's likely a travel confirmation dialog we need to click through
                        if (!ns.getPlayer().city != "Aevum")
                            await click(await findRequiredElement("//button[p/text()='Travel']"));
                    }
                    if (ns.getPlayer().city == "Aevum")
                        log(ns, `SUCCESS: We're now in Aevum!`)
                    else
                        throw new Error(`We thought we travelled to Aevum, but we're apparently still in ${ns.getPlayer().city}...`);
                }

                // Step 2.3: Navigate to the City Casino
                try { // Try to do this without SF4, because it's faster and doesn't require a temp script to be cleaned up below
                    // Click our way to the city casino
                    await click(await findRequiredElement("//div[(@role = 'button') and (contains(., 'City'))]", 15,
                        `Couldn't find the "🏙 City" menu button. Is your \"World\" nav menu collapsed?`));
                    await click(await findRequiredElement("//span[@aria-label = 'Iker Molina Casino']"));
                } catch (err) { // Try to use SF4 as a fallback (if available) - it's more reliable.
                    let success = false, err2;
                    try { success = await getNsDataThroughFile(ns, 'ns.singularity.goToLocation(ns.args[0])', null, ["Iker Molina Casino"]); }
                    catch (singErr) { err2 = singErr; }
                    if (!success)
                        throw new Error("Failed to travel to the casino both using UI navigation and using SF4 as a fall-back." +
                            `\nUI navigation error was: ${getErrorInfo(err)}\n` + (err2 ? `Singularity error was: ${getErrorInfo(err2)}` :
                                '`ns.singularity.goToLocation("Iker Molina Casino")` returned false, but no error...'));
                }

                // Step 2.4: Try to start the blackjack game
                await click(await findRequiredElement("//button[contains(text(), 'blackjack')]"));

                // Step 2.5: Get some buttons we will need to play blackjack
                inputWager = await findRequiredElement("//input[@type='number']");
                btnStartGame = await findRequiredElement("//button[text() = 'Start']");

                // Step 2.6: Clean up temp files and kill other running scripts to speed up the reload cycle
                if (ns.ls("home", "Temp/").length > 0) { // If there are some temp files, it suggests we haven't killed all scripts and cleaned up yet
                    // Step 2.6.1: Test that we aren't already kicked out of the casino before doing drastic things like killing scripts
                    const moneySources = await getNsDataThroughFile(ns, 'ns.getMoneySources()'); // NEW (2022): We can use money sources to see what our casino earnings have been
                    const priorCasinoEarnings = moneySources.sinceInstall.casino;
                    if (priorCasinoEarnings >= 1e10)
                        log(ns, `INFO: We've previously earned ${formatMoney(priorCasinoEarnings)} from the casino, which should mean we've already been kicked out, ` +
                            `but we can double-check anyway by attempting to play a game, since you bothered running this script, and I've bothered scripting the check :)`, true)
                    await setText(inputWager, `1`); // Bet just a dollar and quick the game right away, no big deal
                    await click(btnStartGame);
                    if (await tryfindElement("//p[contains(text(), 'Count:')]", 10)) { // If this works, we're still allowed in
                        const btnStay = await tryfindElement("//button[text() = 'Stay']");
                        if (btnStay) await click(btnStay); // Trigger the game to end (optional - game might already be over if dealer got blackjack)
                    } else { // Otherwise, we've probably been kicked out of the casino, but...
                        // because we haven't killed scripts yet, it's possible another script stole focus again. Detect and handle that case.
                        if (!(await checkStillAtCasino(false))) continue; // Loop back after taking back focus and try again
                        if (await checkForKickedOut()) return await onCompletion(false); // We appear to have previously been kicked out
                        throw new Error("Couldn't start a game of blackjack at the casino, but we don't appear to be kicked out...");
                    }
                    // Step 2.6.2: Kill all other scripts if enabled (note, we assume that if the temp folder is empty, they're already killed and this is a reload)
                    if (options['kill-all-scripts'])
                        await killAllOtherScripts(!options['no-deleting-remote-files']);
                    // Step 2.6.3: Clear the temp folder on home (all transient scripts / outputs)
                    await waitForProcessToComplete(ns, ns.run(getFilePath('cleanup.js')));
                }
                break; // We achieved everthing we wanted, we can exit the retry loop.
            } catch (err) {
                // The first 5 errors that occur, we will start over and retry
                if (++priorAttempts < 5) {
                    tail(ns); // Since we're having difficulty, pop open a tail window so the user is aware and can monitor.
                    verbose = true; // Switch on verbose logs
                    log(ns, `WARNING: casino.js Caught (and suppressed) an unexpected error while navigating to blackjack. ` +
                        `Error was:\n${getErrorInfo(err)}\nWill try again (attempt ${priorAttempts} of 5)...`, false, 'warning');
                } else // More than 5 errors, give up and prompt the user to investigate
                    return log(ns, `ERROR: After ${priorAttempts} attempts, casino.js continues to catch unexpected errors ` +
                        `while navigating to blackjack. The final error was:\n  ${getErrorInfo(err)}\n${supportMsg}`, true, 'error');
            }
        }

        if (ns.getPlayer().money < 1)
            return log(ns, "WARNING: Whoops, we have no money to bet! Kill whatever's spending it and try again later.", true, 'warning');

        // Step 3: Save the game state now that this script is running, so that future reloads start this script back up immediately.
        await saveGame();

        // Step 4: Play until we lose or are kicked out
        try {
            let startGameRetries = 0, netWinnings = 0, peakWinnings = 0;
            while (true) {
                if (abort) return;
                // Step 4.1: Bet the maximum amount (we save scum to avoid losing, so no risk of going broke)
                const bet = Math.min(1E8, ns.getPlayer().money * 0.9 /* Avoid timing issues with other scripts spending money */);
                if (bet < 0) return await reload(); // If somehow we have no money, we can't continue
                await setText(inputWager, `${bet}`); // Set our bet amount

                /* Step 4.2: Try to start a new game. There are a few possible outcomes here:
                   #1 We start a game (typical) in which case we should see "Hit" and "Stay" buttons
                   #2 We instantly won, lost, or tied if the player and/or dealer got 21 (blackjack)
                   #3 No game starts and we get a notification that we've been kicked out of the casino (a good thing)
                   #4 (annoying) The user, or another script, left the casino page (stole focus)
                   #5 (even more annoying) The "click" event didn't "take effect" and we should retry it
                The seemingly-excessive logic below tries to distinguish between those cases and handle them appropriately */
                await click(btnStartGame);
                let winLoseTie = null; // For storing a string indicating the game state after each card is dealt

                // Step 4.3: Look for the "hit" and "stay" buttons, or alternatively the "start" button
                let btnHit, btnStay;
                let retries = 0;
                while (retries++ < 10) { // Quickly distinguish between outcomes #1 and #2. Start retrying only if we can't find any expected buttons
                    if (await tryfindElement("//button[text() = 'Start']", retries))
                        break; // If the start button is present, Outcome #2 or #5 has occurred. (typically #2)
                    // Otherwise, expect to find the hit and stay buttons
                    btnHit = await tryfindElement("//button[text() = 'Hit']", retries);
                    btnStay = await tryfindElement("//button[text() = 'Stay']", retries);
                    // If we detected both buttons, the game is on.
                    if ((btnHit && btnStay))
                        break;
                    // If we only detected one of hit/stay buttons, or no buttons this is surely a UI-lag issue. Try again.
                }
                const gameStarted = btnHit && btnStay; // Outcome #1: Game Started

                // Step 4.4: If this round of blackjack did not start (or ended immediately), figure out why
                if (!gameStarted) {
                    // Step 4.4.1: Detect Outcome #2 - Whether we instantly won/lost/tied via blackjack (21)
                    winLoseTie = await getWinLoseOrTie();
                    if (winLoseTie == null) { // Handle Outcomes #3-5 (atypical of normal casino gameplay)
                        // Step 4.4.2: Detect Outcome #3 (kicked out of casino)
                        if (await checkForKickedOut()) // Were we kicked out of the casino?
                            return await onCompletion(ns); // This is a good thing!

                        // Step 4.4.3: Detect Outcome #4 (something stole focus). We can't recover because we're out of the "navigate to casino" loop.
                        await checkStillAtCasino(); // Throws an error if not. User must stop whatever is stealing focus.

                        // Step 4.5.2: Detect Outcome #5 (The "click" event didn't "take effect" - game never started)
                        // If there's no game-over text, no Hit/Stay buttons, and we've ruled out #3 and #4 already, click must have failed.
                        const errMessage = 'Clicking the start button appears to have done nothing: ' +
                            'Cannot find the Hit/Stay buttons, but there is no game-over text (win/lose/tie) either.';
                        if (startGameRetries++ >= 5) // Retry up to 5 times before giving up and crashing out.
                            throw new Error(errMessage + ` Gave up after 5 retry attempts.\n${supportMsg}`);
                        tail(ns); // Since we're having difficulty, pop open a tail window so the user is aware and can monitor.
                        verbose = true; // Switch on verbose logs
                        log(ns, `WARNING: ${errMessage} Trying again...`, false, 'warning');
                        continue; // Back to 4.1 (Place bet, and try to start a new game)
                    }
                }

                // Step 4.5: Play blackjack until the game is over
                while (winLoseTie == null) {
                    let midGameRetries = 0;
                    try {
                        // Step 4.5.1: Get the current card count
                        const txtCount = await findRequiredElement("//p[contains(text(), 'Count:')]");
                        const allCounts = txtCount.querySelectorAll('span'); // The text might contain multiple counts (if there is an Ace)

                        // Step 4.5.2: Decide to hit or stay
                        let shouldHit;
                        if (options['use-basic-strategy']) { // Basic strategy just looks at our count
                            const highCount = Number(allCounts[allCounts.length - 1].innerText); // The larger value (with Ace=11) - used in basic-strategy mode
                            shouldHit = highCount < 17; // Basic strategy, hit on 16 or less, stay on 17 or over (whether hard or soft)
                            if (verbose) log(ns, `INFO: Count is ${highCount}, we will ${shouldHit ? 'Hit' : 'Stay'}`);
                        } else // Advanced strategy will also look at the dealer card
                            shouldHit = await shouldHitAdvanced(txtCount);

                        // Step 4.5.3: Click either the hit or stay button
                        await click(shouldHit ? btnHit : btnStay);
                        await ns.sleep(1); // Yield for an instant so the game can update and process events (e.g. deal the next card)

                        // Step 4.5.4: A new card should have been dealt, check if the game is over
                        winLoseTie = await getWinLoseOrTie();
                    }
                    catch (err) {
                        // We can't get kicked out mid-game, so no need to check for that. See if we left the casino.
                        await checkStillAtCasino(); // Will throw another error with a best guess at how we were interrupted
                        // Any other errors must be transient failures to pick up certain UI elements, so try again
                        const errMessage = `an unexpected error in the middle of a game of blackjack:\n${getErrorInfo(err)}`;
                        if (midGameRetries++ >= 5)  // Retry up to 5 times before giving up and crashing out.
                            throw new Error(`After ${priorAttempts} attempts, casino.js continues to catch ${errMessage}`);
                        tail(ns); // Since we're having difficulty, pop open a tail window so the user is aware and can monitor.
                        verbose = true; // Switch on verbose logs
                        log(ns, `WARNING: casino.js Caught (and suppressed) ${errMessage}\n` +
                            `Will try again (attempt ${midGameRetries} of 5)...`, false, 'warning');
                    }
                } // Once the above loop is over winLoseTie is guaranteed be set to some non-null value

                // Step 4.6: Take action depending on whether we won, lost, or tied
                switch (winLoseTie) {
                    case "tie": // Nothing gained or lost, we can immediately start a new game.
                        continue;
                    case "win": // We want to "lock in" our wins by saving the game after each one
                        netWinnings += bet;
                        // Keep tabs of our best winnings, and save the game each time we top it
                        if (netWinnings > peakWinnings) {
                            peakWinnings = netWinnings
                            if (netWinnings > 0)
                                if (saveSleepTime) await ns.sleep(saveSleepTime);
                            await click(btnSaveGame); // Save if we won
                            if (saveSleepTime) await ns.sleep(saveSleepTime);
                        }
                        // Quick pre-emptive test after each win to see if we've been kicked out
                        if (await checkForKickedOut(1)) // Only 1 retry should be very fast
                            return await onCompletion(ns);
                        continue;
                    case "lose":
                        netWinnings -= bet;
                        // To avoid reloading too often, only reload if we're losing really badly (almost broke, or down by 10 games)
                        if (ns.getPlayer().money < 1E8 || netWinnings <= peakWinnings - 10 * 1E8)
                            return await reload(); // We want to reload the game (save scum) to undo our loss :)
                        continue;
                    default:
                        throw new Error(`winLoseTie was set to \"${(winLoseTie === undefined ? 'undefined' :
                            winLoseTie === null ? 'null' : winLoseTie)}\", which shouldn't be possible`);
                }
                throw new Error('This code should be unreachable - did someone break the logic above?');
            }
        }
        catch (err) {
            tail(ns); // Display the tail log if anything goes wrong so the user can review the logs
            log(ns, `ERROR: casino.js Caught a fatal error while playing blackjack:\n${getErrorInfo(err)}\n${supportMsg}`, true, 'error');
        }
    }

    /** This helper function will help us detect if we lost, won or tied.
     * @param {NS} ns
     * @returns {Promise<null|"win"|"lose"|"tie">} null indicates no outcome could be detected (game either not over or still in progres) */
    async function getWinLoseOrTie() {
        // To strike a balance between quickly finding the right outcome, and not wasting too much time,
        // cycle between each xpath search, increasing the the number of retries each time, until we hit 5 each.
        // 1+2+3+4+5=15 total retries, but all with small ms wait times (<20ms), so should still only take a second
        let retries = 0;
        while (retries++ < 5) {
            if (await tryfindElement("//button[text() = 'Hit']", retries))
                return null; // Game is not over yet, we can still hit
            if (await tryfindElement("//p[contains(text(), 'lost')]", retries))
                return "lose";
            // Annoyingly, when we win with blackjack, "Won" is Title-Case, but normal wins is just "won".
            if (await tryfindElement("//p/text()[contains(.,'won') or contains(.,'Won')]", retries))
                return "win";
            if (await tryfindElement("//p[contains(text(), 'Tie')]", retries))
                return "tie";
        }
        return null;
    }

    /** Forces the game to reload (without saving). Great for save scumming.
     * WARNING: Doesn't work if the user last ran the game with "Reload and kill all scripts"
     * @param {NS} ns */
    async function reload() {
        let attempts = 0;
        let errMessage = '';
        while (attempts++ <= 5) {
            eval("window").onbeforeunload = null; // Disable the unsaved changes warning before reloading
            await ns.sleep(options['save-sleep-time']); // Yield execution for an instant incase the game needs to finish a save or something
            location.reload(); // Force refresh the page without saving
            await ns.sleep(10000); // Keep the script alive to be safe. Presumably the page reloads before this completes.
            errMessage = `casino.js asked the game to reload ${attempts} times, but it didn't.`
            log(ns, `WARNING: ${errMessage} Trying again...`, true, 'warning');
        }
        throw new Error(`${errMessage} Giving up.`);
    }

    /** @param {NS} ns
     *  Helper to kill all scripts on all other servers, except this one **/
    async function killAllOtherScripts(removeRemoteFiles) {
        // Kill processes on home (except this one)
        let pid = await runCommand(ns, `ns.ps().filter(s => s.filename != ns.args[0]).forEach(s => ns.kill(s.pid));`,
            '/Temp/kill-everything-but.js', [ns.getScriptName()]);
        await waitForProcessToComplete(ns, pid);
        log(ns, `INFO: Killed other scripts running on home...`, true);

        // Kill processes on all other servers
        const allServers = await getNsDataThroughFile(ns, 'scanAllServers(ns)');
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
     *  @param {boolean} kickedOutAfterPlaying (default: true) set to false if we detected having been kicked out before we even started.
     *  Run when we can no longer gamble at the casino (presumably because we've been kicked out) **/
    async function onCompletion(kickedOutAfterPlaying = true) {
        if (kickedOutAfterPlaying)
            log(ns, "SUCCESS: We've been kicked out of the casino.", true);
        else
            log(ns, "INFO: We appear to have been previously kicked out of the casino. Continuing without playing...", true);

        // For convenience, route to the terminal (but no stress if it doesn't work)
        try {
            const terminalNav = await tryfindElement("//div[(@role = 'button') and (contains(., 'Terminal'))]");
            if (terminalNav) await click(terminalNav);
        } catch (err) { log(ns, `WARNING: Failed to route to the terminal: ${getErrorInfo(err)}`, false); }

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
    async function click(button) {
        if (button === null || button === undefined)
            throw new Error("click was called on a null reference. This means the prior button detection failed, but was assumed to have succeeded.");
        // Sleep before clicking, if so configured
        let sleepDelay = options['click-sleep-time'];
        if (sleepDelay > 0) await ns.sleep(sleepDelay);
        // Find the onclick method on the button
        let fnOnClick = button[Object.keys(button)[1]].onClick; // This is voodoo to me. Apparently it's function on the first property of this button?
        if (!fnOnClick)
            throw new Error(`Odd, we found the button we were looking for (${button.text()}), but couldn't find its onclick method!`)
        if (verbose) log(ns, `Clicking the button.`);
        // Click the button. The "secret" to this working is just to pass any object containing isTrusted:true
        await fnOnClick({ isTrusted: true });
        // Sleep after clicking, if so configured
        if (sleepDelay > 0) await ns.sleep(sleepDelay);
    }

    async function setText(input, text) {
        if (input === null || input === undefined)
            throw new Error("setText was called on a null reference. This means the prior input detection failed, but was assumed to have succeeded.");
        let sleepDelay = options['click-sleep-time'];
        if (sleepDelay > 0) await ns.sleep(sleepDelay);
        if (verbose) log(ns, `Setting text: ${text} on input.`);
        await input[Object.keys(input)[1]].onChange({ isTrusted: true, target: { value: text } });
        if (sleepDelay > 0) await ns.sleep(sleepDelay);
    }

    /** Try to find an element, with retries. Throws an error if the element could not be found.
     * @param {NS} ns
     * @param {string} xpath The xpath 1.0 expression to use to find the element.
     * @param {number} retries (default 10) The number of times to retry.
     * @param {string?} customErrorMessage (optional) A custom error message to replace the default on failure. */
    async function findRequiredElement(xpath, retries = 15, customErrorMessage = null) {
        return await internalfindWithRetry(xpath, false, retries, customErrorMessage);
    }
    /** Try to find an element, with retries. Returns null if the element is not found.
     * @param {NS} ns
     * @param {string} xpath The xpath 1.0 expression to use to find the element.
     * @param {number} retries (default 4) The number of times to check if the element exists before assuming it does not.
     * It's important to retry a few times, since the UI can lag. An element not here now might appear in a few milliseconds. */
    async function tryfindElement(xpath, retries = 4) {
        return await internalfindWithRetry(xpath, true, retries);
    }

    /* Used to search for an element in the document. This can fail if the dom isn't fully re-rendered yet. */
    function internalFind(xpath) { return doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }

    /** Try to find an element, with retries.
     * This is tricky - in some cases we are just checking if the element exists, but expect that it might not
     * (expectFailure = true) - in this case we want some retries in case we were just too fast to detect the element
     * but we don't want to retry too much. We also don't want to be too noisy if we fail to find the element.
     * In other cases, we always expect to find the element we're looking for, and if we don't it's an error.
     * @param {NS} ns
     * @param {string} xpath The xpath 1.0 expression to use to find the element.
     * @param {boolean} expectFailure Changes the behaviour when an item cannot be found.
     *                                If false, failing to find the element is treated as an error.
     *                                If true, we simply return null indicating that no such element was found.
     * @param {null|number} maxRetries (default null) The number of times to retry.
     * @param {string?} customErrorMessage (optional) A custom error message to replace the default on failure. */
    async function internalfindWithRetry(xpath, expectFailure, maxRetries, customErrorMessage = null) {
        try {
            // NOTE: We cannot actually log the xpath we're searching for because depending on the xpath, it might match our log!
            // So here's a trick to convert the characters into "look-alikes"
            let logSafeXPath = xpath.substring(2, 20) + "..."; // TODO: Some trick to convert the characters into "look-alikes" (ạḅc̣ḍ...)
            if (verbose)
                log(ns, `INFO: ${(expectFailure ? "Checking if element is on screen" : "Searching for expected element")}: \"${logSafeXPath}\"`, false);
            // If enabled give the game some time to render an item before we try to find it on screen
            if (options['find-sleep-time'])
                await ns.sleep(options['find-sleep-time']);
            let attempts = 0, retryDelayMs = 1; // starting retry delay (ms), will be increased with each attempt
            while (attempts++ <= maxRetries) {
                // Sleep between attempts
                if (attempts > 1) {
                    if (verbose || !expectFailure)
                        log(ns, (expectFailure ? 'INFO' : 'WARN') + `: Attempt ${attempts - 1} of ${maxRetries} to find \"${logSafeXPath}\" failed. Retrying...`, false);
                    await ns.sleep(retryDelayMs);
                    retryDelayMs *= 2; // back-off rate (increases next sleep time before retrying)
                    retryDelayMs = Math.min(retryDelayMs, 200); // Cap the retry rate at 200 ms (game tick rate)
                }
                const findAttempt = internalFind(xpath);
                if (findAttempt !== null)
                    return findAttempt;
            }
            if (expectFailure) {
                if (verbose)
                    log(ns, `INFO: Element doesn't appear to be present, moving on...`, false);
            } else {
                const errMessage = customErrorMessage ?? `Could not find the element with xpath: \"${logSafeXPath}\"\n` +
                    `Something may have stolen focus or otherwise routed the UI away from the Casino.`;
                log(ns, 'ERROR: ' + errMessage, true, 'error')
                throw new Error(errMessage, true, 'error');
            }
        } catch (e) {
            if (!expectFailure) throw e;
        }
        return null;
    }

    // Better logic for when to HIT / STAY (Partial credit @drider)
    async function shouldHitAdvanced(playerCountElem) {
        const txtPlayerCount = playerCountElem.textContent.substring(7);
        const player = parseInt(txtPlayerCount.match(/\d+/).shift());
        const dealer = await getDealerCount();
        if (verbose)
            log(ns, `Player Count Text: ${txtPlayerCount}, Player: ${player}, Dealer: ${dealer}`);
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

    async function getDealerCount() {
        const dealerCount = await findRequiredElement("//p[contains(text(), 'Dealer')]/..");
        const text = dealerCount.innerText.substring(8, 9);
        let cardValue = parseInt(text);
        return isNaN(cardValue) ? (text == 'A' ? 11 : 10) : cardValue;
    }

    // Run the program
    await start();
}