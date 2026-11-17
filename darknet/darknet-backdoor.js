/**
 * Spawned by darknet-coordinator.js on home (needs Singularity): connects along a route, backdoors the last server, returns home.
 * Args: JSON array of hostnames, starting with a neighbour of home.
 * Each Singularity call runs in its own temp script so RAM peaks at one call (32 GB each without SF4.3).
 */
import { getNsDataThroughFile, log } from "../helpers.js";

/** @param {NS} ns */
export async function main(ns) {
  const route = JSON.parse(String(ns.args[0] ?? "[]")).map(String);
  const target = route[route.length - 1];
  try {
    const brokenAt = await getNsDataThroughFile(ns,
      '(ns.singularity.connect("home"), ns.args.findIndex((hop) => !ns.singularity.connect(hop)))',
      "/Temp/darknet-backdoor-route.txt", route);
    if (brokenAt !== -1) {
      ns.print(`Route to ${target} broke at ${route[brokenAt]}`);
      return;
    }
    await getNsDataThroughFile(ns, "(await ns.singularity.installBackdoor(), true)", "/Temp/darknet-backdoor-install.txt");
    log(ns, `SUCCESS: Backdoor installed on ${target}.`, true);
    ns.toast(`DN: Backdoor: ${target}.`, "success");
  } catch (error) {
    log(ns, `WARNING: Backdoor on ${target} failed (not enough free RAM on home for a Singularity call?): ${error}`);
  } finally {
    await getNsDataThroughFile(ns, 'ns.singularity.connect("home")', "/Temp/darknet-backdoor-home.txt").catch(() => {});
  }
}