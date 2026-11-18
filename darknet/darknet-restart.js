/**
 * Started by dark-w0rm.js when newer scripts arrived on its server: waits for that crawler to exit, then starts the new one.
 * Args: pid of the exiting crawler, then the new crawler's args.
 */
import { WORM } from "./darknet-paths.js";

/** @param {NS} ns */
export async function main(ns) {
  const [pid, ...args] = ns.args;
  for (let waited = 0; ns.isRunning(Number(pid)) && waited < 30000; waited += 100) {
    await ns.sleep(100);
  }
  if (ns.isRunning(Number(pid))) {
    ns.print(`WARNING: pid ${pid} did not exit; not restarting ${WORM}.`);
    return;
  }
  const started = ns.exec(WORM, ns.getHostname(), { preventDuplicates: true }, ...args);
  ns.print(started ? `INFO: Restarted ${WORM} (pid ${started}).` : `WARNING: Couldn't restart ${WORM} (not enough RAM?).`);
}
