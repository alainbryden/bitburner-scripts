/**
 * Spawned by dark-w0rm.js when caches appear on its server: opens them and appends the rewards to LOOT_FILE.
 * Separate script because dnet.openCache costs 2 GB. Args: .cache file names.
 */
import { LOOT_FILE } from "./darknet-paths.js";

/** @param {NS} ns */
export async function main(ns) {
  const open = (file) => {
    try {
      return ns.dnet.openCache(file, true); // the crawler toasts the reward
    } catch (error) {
      return { success: false, message: String(error) };
    }
  };
  const lines = ns.args.map((file) => JSON.stringify({ file, ...open(String(file)) }) + "\n");
  ns.write(LOOT_FILE, lines.join(""), "a");
}