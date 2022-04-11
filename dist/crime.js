import { formatDuration, formatNumberShort } from './helpers.js'
import { crimeForKillsKarmaStats } from './work-for-factions.js'

const crimes = ["shoplift", "rob store", "mug", "larceny", "deal drugs", "bond forgery", "traffick arms", "homicide", "grand theft auto", "kidnap", "assassinate", "heist"]
export function autocomplete() { return crimes; }

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog('sleep');
    let crime = ns.args.length == 0 ? undefined : ns.args.join(" "); // Need to join in case the crime has a space in it - it will be treated as two args
    ns.tail();
    if (!crime || ns.args.includes("--fast-crimes-only")) // More sophisticated auto-scaling crime logic
        await crimeForKillsKarmaStats(ns, 0, 0, Number.MAX_SAFE_INTEGER, ns.commitCrime, ns.args.includes("--fast-crimes-only"));
    else // Simple crime loop for the specified crime
        await legacyAutoCrime(ns, crime);
}

/** @param {NS} ns **/
async function legacyAutoCrime(ns, crime = "mug") {
    let interval = 100;
    while (true) {
        let maxBusyLoops = 100;
        while (ns.isBusy() && maxBusyLoops-- > 0) {
            await ns.sleep(interval);
            ns.print("Waiting to no longer be busy...");
        }
        if (maxBusyLoops <= 0) {
            ns.tprint("User have been busy for too long. auto-crime.js exiting...");
            return;
        }
        ns.tail(); // Force a tail window open when auto-criming, or else it's very difficult to stop if it was accidentally closed.
        let wait = ns.commitCrime(crime) + 10;
        ns.print(`Karma: ${formatNumberShort(ns.heart.break())} Committing crime \"${crime}\" and sleeping for ${formatDuration(wait)}...`);
        await ns.sleep(wait);
    }
}