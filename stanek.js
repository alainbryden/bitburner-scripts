import { getNsDataThroughFile, disableLogs, formatNumberShort, formatRam, getFilePath, waitForProcessToComplete, log } from './helpers.js'

let options;
const argsSchema = [
    ['reserved-ram', 0], // Don't use this RAM
    ['reserved-ram-ideal', 32], // Leave this amount of RAM free if it represents less than 5% of available RAM
    ['max-charges', 100], // Stop charging when all fragments have this many charges (diminishing returns - num charges is ^0.07 )
    // By default, starting an augmentation with stanek.js will still spawn daemon.js, but will instruct it not to schedule any hack cycles against home by 'reserving' all its RAM
    ['on-startup-script', 'daemon.js'], // Spawn this script when stanek is launched (HACK: to support running stanek as the installAugmentations startup script)
    ['on-startup-script-args', ['--reserved-ram', Number.MAX_SAFE_INTEGER]],
    // When stanek completes, it will run daemon.js again (which will terminate the initial ram-starved daemon that is running)
    ['on-completion-script', 'daemon.js'], // Spawn this script when max-charges is reached
    ['on-completion-script-args', ['-v', '--stock-manipulation']], // Optional args to pass to the script when launched
    ['no-tail', false], // By default, keeps a tail window open, because it's pretty important to know when this script is running (can't use home for anything else)
    ['average-charge-sensitivity', 0.95], // Monitor available ram and do not charge fragments if current available RAM is less than this percentage of the current average charge.
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
    disableLogs(ns, ['sleep', 'run', 'getServerMaxRam', 'getServerUsedRam'])
    options = ns.flags(argsSchema);
    const maxCharges = options['max-charges']; // Don't bother adding charges beyond this amount
    const idealReservedRam = 32; // Reserve this much RAM, if it wouldnt make a big difference anyway. Leaves room for other temp-scripts to spawn.
    // If so configured, launch the start-up script to run alongside stanek and let it consume the RAM it needs before initiating stanek loops.
    if (ns.run(options['on-startup-script'], 1, ...options['on-startup-script-args'])) {
        log(ns, `INFO: Stanek.js is launching accompanying 'on-startup-script': ${options['on-startup-script']}...`, false, 'info');
        await ns.sleep(1000); // Give time for the accompanying script to start up and consume its required RAM footprint.
    } else
        log(ns, `ERROR: Stanek.js has started successfully, but failed to launch accompanying 'on-startup-script': ${options['on-startup-script']}...`, true, 'error');
    // Start the main stanek loop
    while (true) {
        if (!options['no-tail'])
            ns.tail();
        // Make sure we have the latest information about all fragments
        let fragments = await getNsDataThroughFile(ns, 'ns.stanek.activeFragments()', '/Temp/stanek-fragments.txt'); //ns.stanek.activeFragments();
        if (fragments.length == 0) {
            log(ns, "ERROR: You must manually populate your stanek grid with your desired fragments before you run this script to charge them.", true, 'error');
            return;
        }
        // Print a status update (current charge level of all fragments)
        let statusUpdate = `Preparing to charge ${fragments.length} fragments to ${maxCharges}. Curent charges:\n`;
        let minCharges = Number.MAX_SAFE_INTEGER;
        for (const fragment of fragments) {
            statusUpdate += `Fragment ${String(fragment.id).padStart(2)} at [${fragment.x},${fragment.y}] ` +
                (fragment.id < 100 ? `charge: ${fragment.numCharge} avg: ${formatNumberShort(fragment.avgCharge)}` :
                    `(booster, no charge effect)`) + `\n`;
            if (fragment.id < 100)
                minCharges = Math.min(minCharges, fragment.numCharge)
        }
        log(ns, statusUpdate);
        if (minCharges >= maxCharges) break;
        // Charge each fragment one at a time
        for (const fragment of fragments.filter(f => f.numCharge < maxCharges && /* Don't charge boosters */ f.id < 100)) {
            let availableRam = ns.getServerMaxRam('home') - ns.getServerUsedRam('home');
            let reservedRam = (idealReservedRam / availableRam < 0.05) ? options['reserved-ram-ideal'] : options['reserved-ram'];
            const threads = Math.floor((availableRam - reservedRam) / 2.0);
            // Only charge if we will not be bringing down the average (After some initial threshold of charges has been established)
            if (threads < fragment.avgCharge * options['average-charge-sensitivity'] && fragment.numCharge > 5) {
                log(ns, `WARNING: The current average charge of fragment ${fragment.id} is ${formatNumberShort(fragment.avgCharge)}, ` +
                    `indicating that it has been charged while there was ${formatRam(2 * fragment.avgCharge)} or more free RAM on home, ` +
                    `but currently there is only ${formatRam(availableRam)} available, which would reduce the average charge and lower your stats. ` +
                    `This update will be skipped, and you should free up RAM on home to resume charging.`, false, 'warning');
                await ns.sleep(1000);
                continue;
            }
            const pid = ns.run(getFilePath('/stanek.js.charge.js'), threads, fragment.x, fragment.y);
            await waitForProcessToComplete(ns, pid);
        }
        await ns.sleep(100);
    }
    log(ns, `SUCCESS: All stanek fragments at desired charge ${maxCharges}`, true, 'success');
    if (ns.run(options['on-completion-script'], 1, ...options['on-completion-script-args']))
        log(ns, `INFO: Stanek.js shutting down and launching ${options['on-completion-script']}...`, false, 'info');
    else
        log(ns, `ERROR: Stanek.js shutting down, but failed to launch ${options['on-completion-script']}...`, true, 'error');
}