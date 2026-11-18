/** Spawned by dark-w0rm.js with all spare RAM as threads (money and charisma scale with threads). */
import { stopRequested } from "./darknet-paths.js";

/** @param {NS} ns */
export async function main(ns) {
  while (!stopRequested(ns)) {
    await ns.dnet.phishingAttack();
  }
}