/** @param {NS} ns 
 * Blindly try to open all ports and crack the specified target, regardless of owned tools. */
export async function main(ns) {
    const target = ns.args[0];
    try { ns.brutessh(target); } catch { }
    try { ns.ftpcrack(target); } catch { }
    try { ns.relaysmtp(target); } catch { }
    try { ns.httpworm(target); } catch { }
    try { ns.sqlinject(target); } catch { }
    try { ns.nuke(target); } catch { }
}