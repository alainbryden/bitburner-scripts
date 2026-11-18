/**
 * Darknet bootstrap, home side: `run darknet-daemon.js --tail` (re-running restarts it and the coordinator; alias godark="home; run darknet-daemon.js --tail").
 * Stamps the worm build, starts the coordinator, infects darkweb (home's only darknet neighbour) with dark-w0rm.js, then exits:
 * the worms spread themselves and the coordinator looks after the rest (autopilot.js restarts this if either vanishes).
 * --follow: stay running and relay coordinator events (and keep darkweb infected) instead of exiting.
 * Settings: CRAWLER_SCHEMA in darknet/darknet-crawl.js, darknet-daemon.js.config.txt or command line.
 */
import { getConfiguration, getFnRunViaNsExec, getNsDataThroughFile_Custom, log } from "./helpers.js";
import { COORDINATOR, DAEMON, WORM, buildOf, samePath, stampBuild } from "./darknet/darknet-paths.js";
import {
  CRAWLER_SCHEMA,
  info,
  isRunningOn,
  logChanged,
  newState,
  options,
  parseKnown,
  report,
  runningCrawler,
  setOptions,
  toast,
  visitNeighbour,
} from "./darknet/darknet-crawl.js";

const argsSchema = [
  ...CRAWLER_SCHEMA,
  ["follow", false], // stay running and relay coordinator events instead of exiting once darkweb runs the worm
];
const DARKSCAPE = "DarkscapeNavigator.exe";
const DARKWEB = "darkweb";
// Settings passed to the coordinator on its command line
const SHARED_OPTIONS = ["report-port", "control-port", "event-port", "state-file", "max-known-passwords"];

export function autocomplete(data, _) {
  data.flags(argsSchema);
  return [];
}

/** @param {NS} ns */
export async function main(ns) {
  const runOptions = getConfiguration(ns, argsSchema);
  if (!runOptions) {
    return; // invalid config or args; getConfiguration explained why
  }
  setOptions(runOptions);
  ns.disableLog("ALL"); // silences per-guess dnet log lines
  if (ns.getHostname() !== "home") {
    ns.tprint(`ERROR: ${ns.getScriptName()} runs on home only; darknet servers run ${WORM}.`);
    return;
  }
  // Passwords saved by the coordinator survive kills
  const saved = parseKnown(ns.read(options["state-file"]));
  const state = newState(saved.passwords ?? {});
  await stopPreviousRun(ns);
  ns.clearPort(options["event-port"]); // drop events from a previous run
  refreshBuild(ns, state);
  info(ns, `Started on home, ${Object.keys(state.known).length} known passwords (${options["state-file"]}), build ${state.build}. ` +
    `Cracking ${DARKWEB} and starting ${WORM} on it. Coordinator lines show here as [coordinator].`);

  while (true) {
    try {
      await runPass(ns, state);
    } catch (error) {
      toast(ns, "warning", "DN: Pass failed.", `Pass failed: ${error}`);
    }
    if (!options.follow && readyToHandOff(ns, state)) {
      relayCoordinatorEvents(ns);
      info(ns, `Handing off: ${COORDINATOR} runs on home and ${WORM} (build ${state.build}) runs on ${DARKWEB}; ` +
        `they carry on from here. Exiting to free this script's RAM.`);
      return;
    }
    // Short sleep steps keep coordinator events prompt
    for (let waited = 0; waited < options["hack-loop-wait-ms"]; waited += 1000) {
      relayCoordinatorEvents(ns);
      await ns.sleep(Math.min(1000, options["hack-loop-wait-ms"] - waited));
    }
  }
}

/** One sweep: ensure the coordinator runs, refresh the build stamp, crack and infect (or update) darkweb. */
const runPass = async (ns, state) => {
  if (!isRunningOn(ns, "home", COORDINATOR)) {
    const pid = ns.exec(COORDINATOR, "home", 1, ...SHARED_OPTIONS.flatMap((key) => [`--${key}`, options[key]]));
    if (pid) {
      info(ns, `Launched ${COORDINATOR} (pid ${pid}): saves passwords, manages stasis links, backdoors, relaunches.`);
    } else {
      toast(ns, "warning", "DN: Coordinator won't start.", `Can't launch ${COORDINATOR} (low RAM on home?). Retrying next pass.`);
    }
  }
  if (!ns.fileExists(DARKSCAPE, "home")) {
    logChanged(ns, state, "darkscape", `INFO: Waiting for ${DARKSCAPE} (the coordinator buys it when possible).`);
    return;
  }
  logChanged(ns, state, "darkscape", `INFO: ${DARKSCAPE} is available.`);
  refreshBuild(ns, state); // picks up script updates (e.g. git-pull)
  await visitNeighbour(ns, state, DARKWEB);
  report(ns, state, "home", [DARKWEB]); // sends the passwords we cracked, so the coordinator can relaunch the worm
};

/** The coordinator runs and darkweb runs a worm of the current build. */
const readyToHandOff = (ns, state) => {
  if (!isRunningOn(ns, "home", COORDINATOR) || !ns.fileExists(DARKSCAPE, "home")) {
    return false;
  }
  const worm = runningCrawler(ns, DARKWEB);
  return worm !== undefined && buildOf(worm) >= state.build;
};

/** Prints events from the coordinator's event port (toasts already shown). */
const relayCoordinatorEvents = (ns) => {
  for (let raw = ns.readPort(options["event-port"]); raw !== "NULL PORT DATA"; raw = ns.readPort(options["event-port"])) {
    log(ns, `[coordinator] ${raw}`);
  }
};

/** Stops earlier copies of this script and the coordinator (kill by name needs identical args); the first pass relaunches the coordinator with current config. */
const stopPreviousRun = async (ns) => {
  const stale = [DAEMON, COORDINATOR];
  const previous = ns.ps("home").filter((p) => p.pid !== ns.pid && stale.some((script) => samePath(p.filename, script)));
  if (previous.length > 0) {
    await getNsDataThroughFile_Custom(ns, getFnRunViaNsExec(ns, "home"), "ns.args.map((pid) => ns.kill(pid))",
      "/Temp/darknet-stop-previous.txt", previous.map((p) => p.pid));
    info(ns, `Restarted: stopped ${previous.map((p) => `${p.filename} (pid ${p.pid})`).join(", ")}.`);
  }
};

/** Refreshes state.build (stampBuild); the stamp travels with CHILD_FILES so instances detect outdated builds. */
const refreshBuild = (ns, state) => {
  const { build, previous } = stampBuild(ns);
  state.build = build;
  if (build !== previous) {
    log(ns, `INFO: Darknet scripts ${previous ? "changed" : "stamped"}: build ${build}. Instances running an older build ` +
      `update themselves as their neighbours reach them.`, previous > 0);
  }
};

