/**
 * Spawned by dark-w0rm.js: frees all RAM blocked on a server (more threads free more per call).
 * Args: [target], default this server; may be a neighbour we hold.
 */
import { stopRequested } from "./darknet-paths.js";

/** @param {NS} ns */
export async function main(ns) {
  const host = String(ns.args[0] ?? ns.getHostname());
  while (ns.dnet.getBlockedRam(host) > 0 && !stopRequested(ns)) {
    const result = await ns.dnet.memoryReallocation(host);
    if (!result.success) {
      return;
    }
  }
}