import { getFilePath,runCommand, waitForProcessToComplete, getNsDataThroughFile, getActiveSourceFiles, log } from './helpers.js'

const argsSchema = [
    ['reset', false], // By default (for now) does not actually install augmentations unless you use this flag
    // Note: --force option results in passing faction-manager.js the flag to ignore stanek's gift not being accepted
    ['force', false], // There will be sanity checks - use this option to bypass them
    ['scripts-to-kill', ['daemon.js', 'gangs.js', 'sleeves.js', 'work-for-factions.js', 'farm-intelligence.js', 'hacknet-upgrade-manager.js']], // Kill these money-spending scripts at launch
    // Spawn this script after installing augmentations (Note: Args not supported)
    ['on-reset-script', null], // By default, will run Stanek if you have stanek's gift, otherwise daemon.
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (["--scripts-to-kill", "--on-reset-script"].includes(lastFlag))
        return data.scripts;
    return [];
}

/** @param {NS} ns 
 * This script is meant to do all the things best done when ascending (in a generally ideal order) **/
export async function main(ns) {
    const options = ns.flags(argsSchema);
	options['scripts-to-kill'] = options['scripts-to-kill'].map(s => getFilePath(s));
    let dictSourceFiles = await getActiveSourceFiles(ns); // Find out what source files the user has unlocked
    if (!(4 in dictSourceFiles))
        return log(ns, "ERROR: You cannot automate installing augmentations until you have unlocked singularity access (SF4).", true, 'error');

    // TODO: Sanity checks: Make sure it's a good time to reset
    // - We should be able to install ~10 augs or so after maxing home ram purchases?
    // - We should have installed 
    // - Have a force option to override (and pass-through to faction manager)
    const playerData = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt');

    // Kill any other scripts that may interfere with our spending
    let pid = await runCommand(ns, `ns.ps().filter(s => ${JSON.stringify(options['scripts-to-kill'])}.includes(s.filename)).forEach(s => ns.kill(s.pid));`, '/Temp/kill-processes.js');
    await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down, indicating it has shut down other scripts

    // STEP 1: Liquidate Stocks and (SF9) Hacknet Hashes
    log(ns, 'Sell stocks and hashes...', true, 'info');
    ns.run(getFilePath('spend-hacknet-hashes.js'), 1, '--liquidate');
    let stockValue = null;
    if (playerData.hasTixApiAccess) {
        ns.run(getFilePath('stockmaster.js'), 1, '--liquidate');
        const stkSymbols = await getNsDataThroughFile(ns, `ns.stock.getSymbols()`, '/Temp/stock-symbols.txt');
        while (stockValue !== 0) { // It takes a bit of time for things to get sold. Wait until we see no stock holdings
            stockValue = await getNsDataThroughFile(ns, JSON.stringify(stkSymbols) +
                `.map(sym => ({ sym, pos: ns.stock.getPosition(sym), ask: ns.stock.getAskPrice(sym), bid: ns.stock.getBidPrice(sym) }))` +
                `.reduce((total, stk) => total + stk.pos[0] * stk.bid + stk.pos[2] * (stk.pos[3] * 2 - stk.ask) -100000 * (stk.pos[0] + stk.pos[2] > 0 ? 1 : 0), 0)`,
                '/Temp/stock-portfolio-value.txt');
            log(ns, 'INFO: Waiting for stocks to be sold...', false, 'info');
            await ns.sleep(200);
        }
    }

    // STEP 2: Buy Home RAM Upgrades (more important than squeezing in a few extra augs)
    log(ns, 'Try Upgrade Home RAM...', true, 'info');
    pid = ns.run(getFilePath('Tasks/ram-manager.js'), 1, '--reserve', '0', '--budget', '0.8');
    await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down, indicating it has bought all it can.

    // TODO: (SF13) If Stanek is unlocked, and we have not yet accepted Stanek's gift, now's our last chance to do it (before purchasing augs)

    // STEP 3: Buy as many augmentations as possible
    log(ns, 'Purchasing augmentations...', true, 'info');
    const facmanArgs = ['--purchase', '-v'];
    if (options.force) facmanArgs.push('--ignore-stanek')
    pid = ns.run(getFilePath('faction-manager.js'), 1, ...facmanArgs);
    await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down, indicating it is done.

    // Sanity check, if we are not slated to install any augmentations, ABORT
    // Get owned + purchased augmentations, then installed augmentations. Ensure there's a difference
    let purchasedAugmentations = await getNsDataThroughFile(ns, 'ns.getOwnedAugmentations(true)', '/Temp/player-augs-purchased.txt');
    let installedAugmentations = await getNsDataThroughFile(ns, 'ns.getOwnedAugmentations(false)', '/Temp/player-augs-installed.txt');
    if (purchasedAugmentations.length == installedAugmentations.length) {
        log(ns, 'ERROR: Something must have gone wrong, there are no new purchased augs.', true, 'error');
        if (!options.force) return;
    }

    // STEP 4: Try to Buy 4S data / API if we haven't already and can afford it (although generally stockmaster.js would have bought these if it could)
    log(ns, 'Checking on Stock Market upgrades...', true, 'info');
    if (playerData.hasTixApiAcces && !playerData.has4SDataTixApi)
        await getNsDataThroughFile(ns, 'ns.stock.purchase4SMarketDataTixApi()', '/Temp/purchase-4s-api.txt');
    if (playerData.hasTixApiAcces && !playerData.has4SData)
        await getNsDataThroughFile(ns, 'ns.stock.purchase4SMarketData()', '/Temp/purchase-4s.txt');

    // STEP 5: (SF10) Buy whatever sleeve upgrades we can afford
    if (10 in dictSourceFiles) {
        log(ns, 'Try Upgrade Sleeves...', true, 'info');
        ns.run(getFilePath('sleeve.js'), 1, '--reserve', '0', '--aug-budget', '1', '--min-aug-batch', '1', '--buy-cooldown', '0');
        await ns.sleep(500); // Give it time to make its initial purchases. Note that we do not block on the process shutting down - it will keep running.
    }

    // STEP 6: (SF2) Buy whatever gang equipment we can afford
    if (2 in dictSourceFiles) {
        log(ns, 'Try Upgrade Gangs...', true, 'info');
        ns.run(getFilePath('gangs.js'), 1, '--reserve', '0', '--augmentations-budget', '1', '--equipment-budget', '1');
        await ns.sleep(500); // Give it time to make its initial purchases. Note that we do not block on the process shutting down - it will keep running.
    }

    // STEP 7: Buy whatever home CPU upgrades we can afford
    log(ns, 'Try Upgrade Home Cores...', true, 'info');
    pid = await runCommand(ns, `while(ns.upgradeHomeCores()); { await ns.sleep(10); }`, '/Temp/upgrade-home-ram.js');
    await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down, indicating it has bought all it can.

    // TODO: If in corporation, and buyback shares is available, buy as many as we can afford
    // TODO: Anything to do for Bladeburner?

    // WAIT: For money to stop decreasing, so we know that external scripts have bought what they could.
    log(ns, 'Waiting for purchasing to stop...', true, 'info');
    let money = 0, lastMoney = 0, ticksWithoutPurchases = 0;
    while (ticksWithoutPurchases < 10) { // 10 * 200ms (game tick time) ~= 2 seconds
        while (lastMoney == (money = await getNsDataThroughFile(ns, `ns.getServerMoneyAvailable('home')`, '/Temp/player-money.txt')))
            await ns.sleep(50); // Wait for game to tick (money to change)
        ticksWithoutPurchases = money < lastMoney ? 0 : ticksWithoutPurchases + 1;
        lastMoney = money;
    }

    // FINALLY: If configured, soft reset
    log(ns, '\nCatch you on the flippity-flip\n', true, 'success');
    if (options.reset) {
        await ns.sleep(1000); // Pause for effect?
        const resetScript = options['on-reset-script'] ??
            // Default script (if none is specified) is stanek.js if we have it (which in turn will spawn daemon.js when done)
            (purchasedAugmentations.includes(`Stanek's Gift - Genesis`) ? getFilePath('stanek.js') : getFilePath('daemon.js'));
        await runCommand(ns, `ns.installAugmentations('${resetScript}')`, '/Temp/soft-reset.js');
    }
}