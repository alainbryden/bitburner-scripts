import { parseShortNumber } from './helpers.js'
/** @param {NS} ns **/
export async function main(ns) {
    let parsed = parseShortNumber(ns.args[0]);
    await ns.write('reserve.txt', parsed, "w");
    ns.tprint(`Set to reserve ${parsed.toLocaleString('en')}`);
}
