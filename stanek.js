import { getNsDataThroughFile, disableLogs, formatNumberShort, getFilePath, waitForProcessToComplete } from './helpers.js'

const maxCharges = 10000; // Don't bother adding charges beyond this amount (diminishing returns - num charges is ^0.07 )

/** @param {NS} ns 
 * Maximizes charge on staney fragments based on current home RAM.
 * IMPORTANT: You should have no other scripts running on home while you do this. **/
export async function main(ns) {
    disableLogs(ns, ['sleep', 'run', 'getServerMaxRam', 'getServerUsedRam'])
    while (true) {
        let fragments = await getNsDataThroughFile(ns, 'ns.stanek.activeFragments()', '/Temp/stanek-fragments.txt'); //ns.stanek.activeFragments();
        for (const fragment of fragments)
            ns.print(`Fragment ${String(fragment.id).padStart(2)} at [${fragment.x},${fragment.y}] ` +
                `charge num: ${formatNumberShort(fragment.numCharge)} avg: ${formatNumberShort(fragment.avgCharge)}`);
        for (const fragment of fragments) {
            const threads = Math.floor((ns.getServerMaxRam('home') - ns.getServerUsedRam('home')) / 2.0);
            // Only charge if we will not be bringing down the average
            if (threads < fragment.avgCharge || fragment.numCharge > maxCharges) continue;
            const pid = ns.run(getFilePath('/stanek.js.charge.js'), threads, fragment.x, fragment.y);
            await waitForProcessToComplete(ns, pid);
        }
        await ns.sleep(1000);
    }
}