import { formatMoney, formatDuration, formatNumberShort, disableLogs } from './helpers.js'

const argsSchema = [
    ['trips-per-cycle', 1000],
    ['money-threshold', 1000000000000]
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns 
 * Script contributed by https://github.com/ShawnPatton
 * Concept: A small amount of intelligence is granted when you (successfully) travel to a new city. This script converts money into intelligence exp! **/
export async function main(ns) {
    disableLogs(ns, ["travelToCity", "sleep"]);
    ns.tail();
    let options = ns.flags(argsSchema);
    let tripsPerCycle = options['trips-per-cycle'];
    let moneyThreshold = options['money-threshold'];
    ns.print(`trips-per-cycle: ` + tripsPerCycle);
    ns.print(`money-threshold: ` + formatMoney(moneyThreshold));
    let justStarted = true;
    let previousInt = ns.getPlayer().intelligence;
    let currentInt = previousInt;
    let previousLevelTime = Date.now();
    let levelupTime;
    let cycles = 0;
    let duration = 0;
    let tripsPerLevel = 0;
    let tripsPerMs = 0;
    ns.print(`Starting Script at Int ` + currentInt);
    while (true) {
        while (ns.getPlayer().money > moneyThreshold) {
            for (let i = 0; i < tripsPerCycle; i++) {
                ns.travelToCity("Aevum");
                ns.travelToCity("Sector-12");
            }
            await ns.sleep(1);
            cycles++;
            if (previousInt != ns.getPlayer().intelligence) {
                currentInt = ns.getPlayer().intelligence;
                levelupTime = Date.now();
                duration = levelupTime - previousLevelTime;
                tripsPerLevel = cycles * tripsPerCycle * 2;
                tripsPerMs = Math.floor(tripsPerLevel / duration);
                ns.print(`Level Up: Int ` + currentInt + (justStarted ? ` Partial` : ` Full`) + ` Level in `
                    + formatDuration(duration) + ` & ` + formatNumberShort(tripsPerLevel) + ` Travels`);
                ns.print(`Approximately ` + tripsPerMs + ` Trips/Millisecond`);
                previousLevelTime = levelupTime;
                previousInt = currentInt;
                justStarted = false;
                cycles = 0;
            }
        }
        await ns.sleep(10000);
        ns.print(`Below money threshold, waiting 10 seconds`);
    }
}