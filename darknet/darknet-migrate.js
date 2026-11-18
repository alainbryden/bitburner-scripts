/**
 * Spawned by dark-w0rm.js to cross an air gap: charges induceServerMigration on a neighbour we hold until it moves with our instance.
 * Args: target hostname.
 */
import { log } from "../helpers.js";
import { stopRequested } from "./darknet-paths.js";

/** @param {NS} ns */
export async function main(ns) {
  const target = String(ns.args[0]);
  while (!stopRequested(ns)) {
    const result = await ns.dnet.induceServerMigration(target);
    if (!result.success) {
      ns.print(`Stopped: ${result.message} (${target} moved away or went offline).`);
      return;
    }
    ns.print(`Migration charge on ${target}: ${(result.progress * 100).toFixed(1)}%`);
    if (result.progress >= 1) {
      log(ns, `SUCCESS: ${target} migrated to a new spot in the net, carrying our instance with it.`, true);
      ns.toast(`DN: Migrated: ${target}.`, "success");
      return;
    }
  }
}
