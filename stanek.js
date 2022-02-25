import { getNsDataThroughFile, disableLogs, formatNumberShort, formatRam, getFilePath, waitForProcessToComplete } from './helpers.js'

const maxCharges = 10000; // Don't bother adding charges beyond this amount (diminishing returns - num charges is ^0.07 )
const idealReservedRam = 32; // Reserve this much RAM, if it wouldnt make a big difference anyway

/** @param {NS} ns 
 * Maximizes charge on staney fragments based on current home RAM.
 * IMPORTANT: You should have no other scripts running on home while you do this. **/
export async function main(ns) {
    disableLogs(ns, ['sleep', 'run', 'getServerMaxRam', 'getServerUsedRam'])
    while (true) {
        // Make sure we have the latest information about all fragments
        let fragments = await getNsDataThroughFile(ns, 'ns.stanek.activeFragments()', '/Temp/stanek-fragments.txt'); //ns.stanek.activeFragments();
        if (fragments.length == 0) {
            ns.tprint("ERROR: You must manually populate your stanek grid with your desired fragments before you run this script to charge them.");
            return;
        }
        // Print a status update (current charge level of all fragments)
        let statusUpdate = `Preparing to charge each of your ${fragments.length} fragments. Curent charges:\n`;
        for (const fragment of fragments)
            statusUpdate += `Fragment ${String(fragment.id).padStart(2)} at [${fragment.x},${fragment.y}] ` +
                `charge num: ${formatNumberShort(fragment.numCharge)} avg: ${formatNumberShort(fragment.avgCharge)}\n`;
        ns.print(statusUpdate);
        // Charge each fragment one at a time
        for (const fragment of fragments) {
            let availableRam = ns.getServerMaxRam('home') - ns.getServerUsedRam('home');
            if (idealReservedRam / availableRam < 0.05)
                availableRam -= idealReservedRam;
            const threads = Math.floor(availableRam / 2.0);
            // Only charge if we will not be bringing down the average
            if (threads < fragment.avgCharge * 0.99 || fragment.numCharge > maxCharges) {
                ns.print(`WARNING: The current average charge of fragment ${fragment.id} is ${formatNumberShort(fragment.avgCharge)}, ` +
                    `indicating that it has been charged while there was ${formatRam(2 * fragment.avgCharge)} or more free RAM on home, ` +
                    `but currently there is only ${formatRam(availableRam)} available, which would reduce the average charge and lower your stats. ` +
                    `This update will be skipped, and you should free up RAM on home to resume charging.`);
                continue;
            }
            const pid = ns.run(getFilePath('/stanek.js.charge.js'), threads, fragment.x, fragment.y);
            await waitForProcessToComplete(ns, pid);
        }
        await ns.sleep(100);
    }
}