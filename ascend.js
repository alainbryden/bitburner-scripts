import {
    log, getConfiguration, getFilePath, runCommand, waitForProcessToComplete, getNsDataThroughFile,
    getActiveSourceFiles, getStockSymbols
} from './helpers.js'

const argsSchema = [
    ['install-augmentations', false], // By default, augs will only be purchased. Set this flag to install (a.k.a reset)
    /* OR */['reset', false], // An alias for the above flag, does the same thing.
    ['allow-soft-reset', false], // If set to true, allows ascend.js to invoke a **soft** reset (installs no augs) when no augs are affordable. This is useful e.g. when ascending rapidly to grind hacknet hash upgrades.
    ['skip-staneks-gift', false], // By default, we get stanek's gift before our first install (except in BN8). If set to true, skip this step.
    /* Deprecated */['bypass-stanek-warning', false], // (Obsoleted by the above option) Used to warn you if you were installing augs without accepting stanek's gift
    // Spawn this script after installing augmentations (Note: Args not supported by the game)
    ['on-reset-script', null], // By default, will start with `stanek.js` if you have stanek's gift, otherwise `daemon.js`.
    ['ticks-to-wait-for-additional-purchases', 10], // Don't reset until we've gone this many game ticks without any new purchases being made (10 * 200ms (game tick time) ~= 2 seconds)
    ['max-wait-time', 60000], // The maximum number of milliseconds we'll wait for external scripts to purchase whatever permanent upgrades they can before we ascend anyway.    
    ['prioritize-home-ram', false], // If set to true, will spend as much money as possible on upgrading home RAM before buying augmentations
    /* Deprecated */['prioritize-augmentations', true], // (Legacy flag, now ignored - left for backwards compatibility)
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (["--on-reset-script"].includes(lastFlag))
        return data.scripts;
    return [];
}

/** @param {NS} ns 
 * This script is meant to do all the things best done when ascending (in a generally ideal order) **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return; // Invalid options, or ran in --help mode.
    let dictSourceFiles = await getActiveSourceFiles(ns); // Find out what source files the user has unlocked
    if (!(4 in dictSourceFiles))
        return log(ns, "ERROR: You cannot automate installing augmentations until you have unlocked singularity access (SF4).", true, 'error');
    ns.disableLog('sleep');
    if (options['prioritize-augmentations'])
        log(ns, "INFO: The --prioritize-augmentations flag is deprecated, as this is now the default behaviour. Use --prioritize-home-ram to get back the old behaviour.")

    // Kill every script except this one, since it can interfere with out spending
    let pid = await runCommand(ns, `ns.ps().filter(s => s.filename != ns.args[0]).forEach(s => ns.kill(s.pid));`,
        '/Temp/kill-everything-but.js', [ns.getScriptName()]);
    await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down, indicating it has shut down other scripts

    // Stop the current action so that we're no longer spending money (if training) and can collect rep earned (if working)
    await getNsDataThroughFile(ns, 'ns.singularity.stopAction()');

    // Clear any global reserve so that all money can be spent
    await ns.write("reserve.txt", 0, "w");

    // STEP 1: Liquidate Stocks and (SF9) Hacknet Hashes
    log(ns, 'Sell stocks and hashes...', true, 'info');
    ns.run(getFilePath('spend-hacknet-hashes.js'), 1, '--liquidate');
    const stkSymbols = await getStockSymbols(ns);
    if (stkSymbols != null) {
        const countOwnedStocks = async () => await getNsDataThroughFile(ns, `ns.args.map(sym => ns.stock.getPosition(sym))` +
            `.reduce((t, stk) => t + (stk[0] + stk[2] > 0 ? 1 : 0), 0)`, '/Temp/owned-stocks.txt', stkSymbols);
        let ownedStocks;
        do {
            log(ns, `INFO: Waiting for ${ownedStocks} owned stocks to be sold...`, false, 'info');
            pid = ns.run(getFilePath('stockmaster.js'), 1, '--liquidate');
            if (pid) await waitForProcessToComplete(ns, pid, true);
            else log(ns, `ERROR: Failed to run "stockmaster.js --liquidate" to sell ${ownedStocks} owned stocks. Will try again soon...`, false, 'true');
            await ns.sleep(1000);
            ownedStocks = await countOwnedStocks();
        } while (ownedStocks > 0);
    }

    // STEP 2: Buy Home RAM Upgrades (more important than squeezing in a few extra augs)
    const spendOnHomeRam = async () => {
        log(ns, 'Try Upgrade Home RAM...', true, 'info');
        pid = ns.run(getFilePath('Tasks/ram-manager.js'), 1, '--reserve', '0', '--budget', '0.8');
        await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down, indicating it has bought all it can.
    };
    if (options['prioritize-home-ram']) await spendOnHomeRam();

    // STEP 3: (SF13) STANEK'S GIFT
    // There is now an API to accept stanek's gift without resorting to exploits. We must do this before installing augs for the first time
    if (13 in dictSourceFiles) {
        // By feature request: Auto-skip stanek in BN8 (requires a separate API check to get current BN)
        let isInBn8 = 8 === (await getNsDataThroughFile(ns, `ns.getResetInfo()`)).currentNode;

        if (options['skip-staneks-gift'])
            log(ns, 'INFO: --skip-staneks-gift was set, we will not accept it.');
        else if (isInBn8) {
            log(ns, 'INFO: Stanek\'s gift is useless in BN8, setting the --skip-staneks-gift argument automatically.');
            options['skip-staneks-gift'] = true;
        } else {
            log(ns, 'Accepting Stanek\'s Gift (if this is the first reset)...', true, 'info');
            const haveStanek = await getNsDataThroughFile(ns, `ns.stanek.acceptGift()`);
            if (haveStanek) log(ns, 'INFO: Confirmed that we have Stanek\'s Gift', true, 'info');
            else {
                log(ns, 'WARNING: It looks like we can\'t get Stanek\'s Gift. (Did you manually purchase some augmentations?)', true, 'warning');
                options['skip-staneks-gift'] = true; // Nothing we can do, no point in failing our augmentation install
            }
        }
    }

    // STEP 4: Buy as many desired augmentations as possible
    log(ns, 'Purchasing augmentations...', true, 'info');
    const facmanArgs = ['--purchase', '-v'];
    if (options['skip-staneks-gift']) {
        log(ns, 'INFO: Sending the --ignore-stanek argument to faction-manager.js')
        facmanArgs.push('--ignore-stanek');
    }
    pid = ns.run(getFilePath('faction-manager.js'), 1, ...facmanArgs);
    await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down, indicating it is done.

    // Sanity check, if we are not slated to install any augmentations, ABORT
    // Get owned + purchased augmentations, then installed augmentations. Ensure there's a difference
    let purchasedAugmentations = await getNsDataThroughFile(ns, 'ns.singularity.getOwnedAugmentations(true)', '/Temp/player-augs-purchased.txt');
    let installedAugmentations = await getNsDataThroughFile(ns, 'ns.singularity.getOwnedAugmentations()', '/Temp/player-augs-installed.txt');
    let noAugsToInstall = purchasedAugmentations.length == installedAugmentations.length;
    if (noAugsToInstall && !options['allow-soft-reset'])
        return log(ns, `ERROR: See above faction-manager.js logs - there are no new purchased augs. ` +
            `Specify --allow-soft-reset to proceed without any purchased augs.`, true, 'error');

    // STEP 2 (If Deferred): Upgrade home RAM after purchasing augmentations if this option was set.
    if (!options['prioritize-home-ram']) await spendOnHomeRam();

    // STEP 5: Try to Buy 4S data / API if we haven't already and can afford it (although generally stockmaster.js would have bought these if it could)
    log(ns, 'Checking on Stock Market upgrades...', true, 'info');
    await getNsDataThroughFile(ns, 'ns.stock.purchaseWseAccount()');
    let hasStockApi = await getNsDataThroughFile(ns, 'ns.stock.purchaseTixApi()');
    if (hasStockApi) {
        await getNsDataThroughFile(ns, 'ns.stock.purchase4SMarketData()');
        await getNsDataThroughFile(ns, 'ns.stock.purchase4SMarketDataTixApi()');
    }

    // STEP 6: (SF10) Buy whatever sleeve upgrades we can afford
    if (10 in dictSourceFiles) {
        log(ns, 'Try Upgrade Sleeves...', true, 'info');
        ns.run(getFilePath('sleeve.js'), 1, '--reserve', '0', '--aug-budget', '1', '--min-aug-batch', '1', '--buy-cooldown', '0', '--disable-training');
        await ns.sleep(500); // Give it time to make its initial purchases. Note that we do not block on the process shutting down - it will keep running.
    }

    // STEP 7: (SF2) Buy whatever gang equipment we can afford
    if (2 in dictSourceFiles) {
        log(ns, 'Try Upgrade Gangs...', true, 'info');
        ns.run(getFilePath('gangs.js'), 1, '--reserve', '0', '--augmentations-budget', '1', '--equipment-budget', '1');
        await ns.sleep(500); // Give it time to make its initial purchases. Note that we do not block on the process shutting down - it will keep running.
    }

    // STEP 8: Buy whatever home CPU upgrades we can afford
    log(ns, 'Try Upgrade Home Cores...', true, 'info');
    pid = await runCommand(ns, `while(ns.singularity.upgradeHomeCores()); { await ns.sleep(10); }`, '/Temp/upgrade-home-ram.js');
    await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down, indicating it has bought all it can.

    // STEP 9: Join every faction we've been invited to (gives a little INT XP)
    let invites = await getNsDataThroughFile(ns, 'ns.singularity.checkFactionInvitations()');
    if (invites.length > 0) {
        pid = await runCommand(ns, 'ns.args.forEach(f => ns.singularity.joinFaction(f))', '/Temp/join-factions.js', invites);
        await waitForProcessToComplete(ns, pid, true);
    }

    // TODO: If in corporation, and buyback shares is available, buy as many as we can afford

    // STEP 10: WAIT: For money to stop decreasing, so we know that external scripts have bought what they could.
    log(ns, 'Waiting for purchasing to stop...', true, 'info');
    let money = 0, lastMoney = 0, ticksWithoutPurchases = 0;
    const maxWait = Date.now() + options['max-wait-time'];
    while (ticksWithoutPurchases < options['ticks-to-wait-for-additional-purchases'] && (Date.now() < maxWait)) {
        const start = Date.now(); // Used to wait for the game to tick.
        const refreshMoney = async () => money =
            await getNsDataThroughFile(ns, `ns.getServerMoneyAvailable(ns.args[0])`, null, ["home"]);
        while ((Date.now() - start <= 200) && lastMoney == await refreshMoney())
            await ns.sleep(10); // Wait for game to tick (money to change) - might happen sooner than 200ms
        ticksWithoutPurchases = money < lastMoney ? 0 : ticksWithoutPurchases + 1;
        lastMoney = money;
    }

    // STEP 4 REDUX: If somehow we have money left over and can afford some junk augs that weren't on our desired list, grab them too
    log(ns, 'Seeing if we can afford any other augmentations...', true, 'info');
    facmanArgs.push('--stat-desired', '_'); // Means buy any aug with any stats
    pid = ns.run(getFilePath('faction-manager.js'), 1, ...facmanArgs);
    await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down, indicating it is done.

    // Clean up our temp folder - it's good to do this once in a while to reduce the save footprint.
    await waitForProcessToComplete(ns, ns.run(getFilePath('cleanup.js')), true);

    // FINALLY: If configured, soft reset
    if (options.reset || options['install-augmentations']) {
        log(ns, '\nCatch you on the flippity-flip\n', true, 'success');
        await ns.sleep(1000); // Pause for effect?
        const resetScript = options['on-reset-script'] ??
            // Default script (if none is specified) is stanek.js if we have it (which in turn will spawn daemon.js when done)
            (purchasedAugmentations.includes(`Stanek's Gift - Genesis`) ? getFilePath('stanek.js') : getFilePath('daemon.js'));
        if (noAugsToInstall)
            await runCommand(ns, `ns.singularity.softReset(ns.args[0])`, null, [resetScript]);
        else
            await runCommand(ns, `ns.singularity.installAugmentations(ns.args[0])`, null, [resetScript]);
    } else
        log(ns, `SUCCESS: Ready to ascend. In the future, you can run with --reset (or --install-augmentations) ` +
            `to actually perform the reset automatically.`, true, 'success');
}