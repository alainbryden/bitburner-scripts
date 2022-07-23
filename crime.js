import { instanceCount, getNsDataThroughFile, formatDuration, formatNumberShort } from './helpers.js'
import { crimeForKillsKarmaStats } from './work-for-factions.js'

const crimes = ["shoplift", "rob store", "mug", "larceny", "deal drugs", "bond forgery", "traffick arms", "homicide", "grand theft auto", "kidnap", "assassinate", "heist"]
const argFastCrimesOnly = "--fast-crimes-only";
export function autocomplete() { return crimes.concat(argFastCrimesOnly); }

/** @param {NS} ns **/
export async function main(ns) {
    if (await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    ns.disableLog('sleep');
    let crime = ns.args.length == 0 ? undefined : ns.args.join(" "); // Need to join in case the crime has a space in it - it will be treated as two args
    ns.tail();
    if (!crime || ns.args.includes(argFastCrimesOnly)) // More sophisticated auto-scaling crime logic
        await crimeForKillsKarmaStats(ns, 0, 0, Number.MAX_SAFE_INTEGER, ns.args.includes(argFastCrimesOnly));
    else // Simple crime loop for the specified crime
        await legacyAutoCrime(ns, crime);
}

/** @param {NS} ns **/
async function legacyAutoCrime(ns, crime = "mug") {
    let interval = 100;
    while (true) {
        let maxBusyLoops = 100;
        while ((await getNsDataThroughFile(ns, `ns.singularity.isBusy()`, '/Temp/isBusy.txt')) && maxBusyLoops-- > 0) {
            await ns.sleep(interval);
            ns.print("Waiting to no longer be busy...");
        }
        if (maxBusyLoops <= 0) {
            ns.tprint("User have been busy for too long. auto-crime.js exiting...");
            return;
        }
        ns.tail(); // Force a tail window open when auto-criming, or else it's very difficult to stop if it was accidentally closed.
        let wait = 10 + (await getNsDataThroughFile(ns, 'ns.singularity.commitCrime(ns.args[0])', '/Temp/commitCrime.txt', [crime]));
        ns.print(`Karma: ${formatNumberShort(ns.heart.break())} Committing crime \"${crime}\" and sleeping for ${formatDuration(wait)}...`);
        await ns.sleep(wait);
    }
}