import { log, disableLogs, getFilePath, instanceCount, getNsDataThroughFile, waitForProcessToComplete, getActiveSourceFiles, formatNumberShort } from './helpers.js'

// Default sripts called at startup and shutdown of stanek
const defaultStartupScript = getFilePath('daemon.js');
const defaultStartupArgs = ['--reserved-ram', Number.MAX_SAFE_INTEGER];
const defaultCompletionScript = getFilePath('daemon.js');
const defaultCompletionArgs = ['-v', '--stock-manipulation'];
// Name of the external script that will be created and called to generate charges
const chargeScript = "/Temp/stanek.js.charge.js";
const awakeningRep = 1E6;
const serenityRep = 100E6;

let options;
const argsSchema = [
    ['reserved-ram', 0], // Don't use this RAM
    ['reserved-ram-ideal', 32], // Leave this amount of RAM free if it represents less than 5% of available RAM
    ['max-charges', 120], // Stop charging when all fragments have this many charges (diminishing returns - num charges is ^0.07 )
    // By default, starting an augmentation with stanek.js will still spawn daemon.js, but will instruct it not to schedule any hack cycles against home by 'reserving' all its RAM
    ['on-startup-script', null], // (Default above) Spawn this script when stanek is launched (HACK: to support running stanek as the installAugmentations startup script)
    ['on-startup-script-args', []], // (Default above) 
    // When stanek completes, it will run daemon.js again (which will terminate the initial ram-starved daemon that is running)
    ['on-completion-script', null], // (Default above) Spawn this script when max-charges is reached
    ['on-completion-script-args', []], // (Default above) Optional args to pass to the script when launched
    ['no-tail', false], // By default, keeps a tail window open, because it's pretty important to know when this script is running (can't use home for anything else)
    ['reputation-threshold', 0.2], // By default, if we are this close to the 100m rep needed for an unowned aug (e.g. "Stanek's Gift - Serenity"), we will keep charging despite the 'max-charges' setting
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns 
 * Maximizes charge on stanek fragments based on current home RAM.
 * IMPORTANT: You should have no other scripts running on home while you do this.
 * NOTE: Stanek stats benefit more from fewer charges with a high avg RAM used per charge, rather than just more charges. **/
export async function main(ns) {
    if (await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    disableLogs(ns, ['sleep', 'run', 'getServerMaxRam', 'getServerUsedRam'])
    options = ns.flags(argsSchema);
    let currentServer = ns.getHostname();
    const maxCharges = options['max-charges']; // Don't bother adding charges beyond this amount
    const idealReservedRam = 32; // Reserve this much RAM, if it wouldnt make a big difference anyway. Leaves room for other temp-scripts to spawn.
    let startupScript = options['on-startup-script'];
    let startupArgs = options['on-startup-script-args'];
    if (!startupScript) { // Apply defaults if not present.
        startupScript = defaultStartupScript;
        if (startupArgs.length == 0) startupArgs = defaultStartupArgs;
    }
    // If so configured, launch the start-up script to run alongside stanek and let it consume the RAM it needs before initiating stanek loops.
    if (ns.run(startupScript, 1, ...startupArgs)) {
        log(ns, `INFO: Stanek.js is launching accompanying 'on-startup-script': ${startupScript}...`, false, 'info');
        await ns.sleep(1000); // Give time for the accompanying script to start up and consume its required RAM footprint.
    } else
        log(ns, `WARNING: Stanek.js has started successfully, but failed to launch accompanying 'on-startup-script': ${startupScript}...`, false, 'warning');
    const chargeAttempts = {}; // We independently keep track of how many times we've charged each segment, to work around a placement bug where fragments can overlap, and then don't register charge

    // Check if our charge script exists. If not, we can create it (facilitates copying stanek.js to a new server to run)
    if (!ns.read(chargeScript)) {
        await ns.write(chargeScript, "export async function main(ns) { await ns.stanek.chargeFragment(ns.args[0], ns.args[1]); }", "w");
        await ns.sleep(100); // To be safe, there have been bugs with ns.write not waiting long enough
    }

    // Check what augs we own and establish the theshold to continue grinding REP if we're close to one.
    const ownedSourceFiles = await getActiveSourceFiles(ns);
    const sf4Level = ownedSourceFiles[4] || 0;
    let shouldContinueForAug = () => false;
    if (sf4Level == 0) {
        log(ns, `INFO: SF4 required to get owned faction rep and augmentation info. Ignoring the --reputation-threshold setting.`);
    } else {
        const ownedAugmentations = await getNsDataThroughFile(ns, `ns.getOwnedAugmentations(true)`, '/Temp/player-augs-purchased.txt');
        const awakeningOwned = ownedAugmentations.includes("Stanek's Gift - Awakening");
        const serenityOwned = ownedAugmentations.includes("Stanek's Gift - Serenity");
        shouldContinueForAug = (currentRep) => // return true if currentRep is high enough that we should keep grinding for the next unowned aug
            !awakeningOwned && options['reputation-threshold'] * awakeningRep <= currentRep && currentRep < awakeningRep ||
            !serenityOwned && options['reputation-threshold'] * serenityRep <= currentRep && currentRep < serenityRep
    }

    // Start the main stanek loop
    while (true) {
        try {
            if (!options['no-tail'])
                ns.tail();
            // Make sure we have the latest information about all fragments
            let fragments = await getNsDataThroughFile(ns, 'ns.stanek.activeFragments()', '/Temp/stanek-fragments.txt'); //ns.stanek.activeFragments();
            if (fragments.length == 0) {
                log(ns, "ERROR: You must manually populate your stanek grid with your desired fragments before you run this script to charge them.", true, 'error');
                return;
            }
            // If we have SF4, get our updated faction rep, and determine if we should continue past --max-charges to earn rep for the next augmentation
            const churchRep = sf4Level ? await getNsDataThroughFile(ns, 'ns.getFactionRep("Church of the Machine God")', '/Temp/stanek-reputation.txt') : 0;
            const shouldContinue = shouldContinueForAug(churchRep);

            // Collect information about each fragment's charge status, and prepare a status update
            let fragmentSummary = '';
            let minCharges = Number.MAX_SAFE_INTEGER;
            for (const fragment of fragments) {
                fragmentSummary += `Fragment ${String(fragment.id).padStart(2)} at [${fragment.x},${fragment.y}] ` +
                    (fragment.id < 100 ? `Peak: ${formatNumberShort(fragment.highestCharge)} Charges: ${fragment.numCharge.toFixed(1)}` :
                        `(booster, no charge effect)`) + `\n`;
                if (fragment.numCharge == 0 && (chargeAttempts[fragment.id] || 0) > 0) { // Ignore fragments that aren't accepting charge.
                    if (chargeAttempts[fragment.id] == 1 && fragment.id < 100) { // First time we do this, log a message
                        log(ns, `WARNING: Detected that fragment ${fragment.id} at [${fragment.x},${fragment.y}] is not accepting charge nano (root overlaps with another segment root?)`, true, 'warning');
                        chargeAttempts[fragment.id] = 2; // Hack: We will never try to charge this fragment again. Abuse this dict value so we don't see htis log again.
                    }
                } else if (fragment.id < 100)
                    minCharges = Math.min(minCharges, fragment.numCharge) // Track the least-charged fragment (ignoring fragments that take no charge)
            }
            minCharges = Math.ceil(minCharges); // Fractional charges now occur. Round these up.
            if (minCharges >= maxCharges && !shouldContinue && fragments.some(f => (chargeAttempts[f.id] || 0) > 0)) break; // Max charges reached
            // We will only charge non-booster fragments, and fragments that aren't stuck at 0 charge
            const fragmentsToCharge = fragments.filter(f => f.id < 100 && ((chargeAttempts[f.id] || 0) < 2 || f.numCharge > 0));

            // Log a status update
            log(ns, `Charging ${fragmentsToCharge.length}/${fragments.length} fragments ` + (!shouldContinue ? `to ${maxCharges}` : `until faction has ` +
                formatNumberShort(churchRep < awakeningRep ? awakeningRep : serenityRep) + ` rep (currently at ${formatNumberShort(churchRep)})`) +
                `. Curent charges:\n${fragmentSummary}`);
            // Charge each fragment one at a time
            for (const fragment of fragmentsToCharge) {
                let availableRam = ns.getServerMaxRam(currentServer) - ns.getServerUsedRam(currentServer);
                let reservedRam = (idealReservedRam / availableRam < 0.05) ? options['reserved-ram-ideal'] : options['reserved-ram'];
                const threads = Math.floor((availableRam - reservedRam) / 2.0);
                const pid = ns.run(chargeScript, threads, fragment.x, fragment.y);
                await waitForProcessToComplete(ns, pid);
                chargeAttempts[fragment.id] = 1 + (chargeAttempts[fragment.id] || 0);
            }
        }
        catch (err) {
            log(ns, `WARNING: stanek.js Caught (and suppressed) an unexpected error in the main loop:\n` +
                (typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
        }
        await ns.sleep(100);
    }
    log(ns, `SUCCESS: All stanek fragments at desired charge ${maxCharges}`, true, 'success');
    // Run the completion script before shutting down    
    let completionScript = options['on-completion-script'];
    let completionArgs = options['on-completion-script-args'];
    if (!completionScript) { // Apply defaults if not present.
        completionScript = defaultCompletionScript;
        if (completionArgs.length == 0) completionArgs = defaultCompletionArgs;
    }
    if (ns.run(completionScript, 1, ...completionArgs))
        log(ns, `INFO: Stanek.js shutting down and launching ${completionScript}...`, false, 'info');
    else
        log(ns, `WARNING: Stanek.js shutting down, but failed to launch ${completionScript}...`, false, 'warning');
}