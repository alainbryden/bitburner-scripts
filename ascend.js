import { runCommand, getNsDataThroughFile, getActiveSourceFiles, log } from './helpers.js'

const argsSchema = [
    ['force', false], // There will be sanity checks - use this option to bypass them
    ['scripts-to-kill', ['daemon.js', 'gangs.js', 'sleeves.js', 'work-for-factions.js']], // Kill these scripts at launch
    ['reset', false], // By default (for now) does not actually install augmentations unless you use this flag
    ['on-reset-script', 'daemon.js'], // Spawn this script when max-charges is reached
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
    let dictSourceFiles = await getActiveSourceFiles(ns); // Find out what source files the user has unlocked
    if (!(4 in dictSourceFiles))
        return log(ns, "ERROR: You cannot automate installing augmentations until you have unlocked singularity access (SF4).", true, 'error');

    // TODO: Sanity checks: Make sure it's a good time to reset
    // - We should be able to install ~10 augs or so after maxing home ram purchases?
    // - We should have installed 
    // - Have a force option to override (and pass-through to faction manager)

    // Kill any other scripts that may interfere with our spending
    await runCommand(ns, `ns.ps().filter(s => ${JSON.stringify(options['scripts-to-kill'])}.includes(s.filename)).forEach(s => ns.kill(s.pid));`, '/Temp/kill-processes.js');
    await ns.sleep(400); // Wait a couple ticks for things to die

    // STEP 1: Liquidate Stocks and (SF9) Hacknet Hashes
    log(ns, 'Sell stocks and hashes...', true, 'info');
    ns.run('stockmaster.js', 1, '--liquidate');
    ns.run('spend-hacknet-hashes.js', 1, '--liquidate');
    await ns.sleep(1000); // Takes a bit of time for things to get sold

    // STEP 2: Buy Home RAM Upgrades (more important than squeezing in a few extra augs)
    log(ns, 'Try Upgrade Home RAM...', true, 'info');
    ns.run('Tasks/ram-manager.js', 1, '--reserve', '0', '--budget', '0.8');
    await ns.sleep(200); // Give it time to make its purchases
    // TODO: (SF13) If Stanek is unlocked, and we have not yet accepted Stanek's gift, now's our last chance to do it

    // STEP 3: Buy as many augmentations as possible
    log(ns, 'Purchasing augmentations...', true, 'info');
    const facmanArgs = ['--purchase', '-v'];
    if (options.force) facmanArgs.push('--force')
    ns.run('faction-manager.js', 1, ...facmanArgs);
    await ns.sleep(400); // Give it time to make its purchases

    // Sanity check, if we are not slated to install any augmentations, ABORT
    // Get owned + purchased augmentations, then installed augmentations. Ensure there's a difference
    let purchasedAugmentations = await getNsDataThroughFile(ns, 'ns.getOwnedAugmentations(true)', '/Temp/player-augs-purchased.txt');
    let installedAugmentations = await getNsDataThroughFile(ns, 'ns.getOwnedAugmentations(false)', '/Temp/player-augs-installed.txt');
    if (purchasedAugmentations.length == installedAugmentations.length) {
        log(ns, 'ERROR: Something must have gone wrong, there are no new purchased augs.', true, 'error');
        if (!options.force) return;
    }

    // STEP 4: (SF10) Buy whatever sleeve upgrades we can afford
    if (10 in dictSourceFiles) {
        log(ns, 'Try Upgrade Sleeves...', true, 'info');
        ns.run('sleeve.js', 1, '--reserve', '0', '--aug-budget', '1', '--min-aug-batch', '1', '--buy-cooldown', '0');
        await ns.sleep(200); // Give it time to make its purchases
    }

    // STEP 5: (SF2) Buy whatever gang equipment we can afford
    if (2 in dictSourceFiles) {
        log(ns, 'Try Upgrade Gangs...', true, 'info');
        ns.run('gangs.js', 1, '--reserve', '0', '--augmentations-budget', '1', '--equipment-budget', '1');
        await ns.sleep(200); // Give it time to make its purchases
    }

    // STEP 6: Buy whatever home CPU upgrades we can afford
    log(ns, 'Try Upgrade Home Cores...', true, 'info');
    await runCommand(ns, `while(ns.upgradeHomeCores()); { await ns.sleep(10); }`, '/Temp/upgrade-home-ram.js');
    await ns.sleep(200); // Give it time to make its purchases
    // TODO: If in corporation, and buyback shares is available, buy as many as we can afford
    // TODO: Anything to do for Bladeburner?

    // FINALLY: If configured, soft reset
    log(ns, 'Catch you on the flippity-flip', true, 'success');
    if (options.reset) {
        await ns.sleep(1000); // Pause for effect (really, give everything time to make any additional rounds of purchases)
        await runCommand(ns, `ns.installAugmentations('${options['on-reset-script']}')`, '/Temp/soft-reset.js');
    }
}