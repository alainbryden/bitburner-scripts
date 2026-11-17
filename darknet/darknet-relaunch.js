/**
 * Started on home by darknet-coordinator.js when our worm died on a stasis-linked or backdoored server (reachable from home).
 * Separate script to keep scp/kill/session RAM out of the coordinator. Reports {type: "relaunch", host, ok, message} to the coordinator.
 * Args: host, password, report port. Known passwords come from KNOWN_FILE on home.
 */
import { log } from "../helpers.js";
import { CHILD_FILES, KNOWN_FILE, WORM, MIGRATE_WORKER, PHISH_WORKER, RAM_WORKER, readBuild, samePath } from "./darknet-paths.js";

/** @param {NS} ns */
export async function main(ns) {
  const [host, password, reportPort] = ns.args.map(String);
  const report = (ok, message) => ns.writePort(Number(reportPort), JSON.stringify({ type: "relaunch", host, ok, message }));
  if (!ns.dnet.connectToSession(host, password).success) {
    report(false, "its saved password no longer works. Its neighbours will re-crack it.");
    return;
  }
  if (!ns.scp([...CHILD_FILES, KNOWN_FILE].filter((file) => ns.fileExists(file, "home")), host, "home")) {
    report(false, "couldn't copy the scripts there.");
    return;
  }
  if (ns.getServerMaxRam(host) - ns.getServerUsedRam(host) < ns.getScriptRam(WORM, "home")) {
    ns.ps(host)
      .filter((process) => [RAM_WORKER, PHISH_WORKER, MIGRATE_WORKER].some((worker) => samePath(process.filename, worker)))
      .forEach((process) => ns.kill(process.pid));
  }
  if (ns.exec(WORM, host, { preventDuplicates: true }, "--build", readBuild(ns)) === 0) {
    report(false, "not enough free RAM to start it.");
    return;
  }
  log(ns, `SUCCESS: Relaunched ${WORM} on ${host}.`);
  ns.toast(`DN: Revived: ${host}.`, "success");
  report(true, `it had died; ${host} is linked/backdoored, so home can reach it`);
}
