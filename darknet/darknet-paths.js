/**
 * Darknet script locations. Only darknet-daemon.js is in the root; the rest live in DARKNET_DIR.
 * Paths for exec/scp/fileExists start with "/"; ns.ps and ns.getScriptName() omit it, so compare with samePath().
 */
import { hashCode } from "../helpers.js";

export const DARKNET_DIR = "/darknet";
const inDir = (file) => `${DARKNET_DIR}/${file}`;

/** Runs on home only. */
export const DAEMON = "/darknet-daemon.js";
/** Crawler running on each darknet server we hold. */
export const WORM = inDir("dark-w0rm.js");
/** Cracking, spreading and reporting shared by DAEMON and WORM. */
export const CRAWL = inDir("darknet-crawl.js");
export const PATHS = inDir("darknet-paths.js");
export const COORDINATOR = inDir("darknet-coordinator.js");
export const BACKDOOR_WORKER = inDir("darknet-backdoor.js");
export const RAM_WORKER = inDir("darknet-ram.js");
export const PHISH_WORKER = inDir("darknet-phish.js");
export const STASIS_WORKER = inDir("darknet-stasis.js");
export const MIGRATE_WORKER = inDir("darknet-migrate.js");
export const CACHE_WORKER = inDir("darknet-cache.js");
export const RELAUNCH_WORKER = inDir("darknet-relaunch.js");
export const RESTART_WORKER = inDir("darknet-restart.js");

/** Build stamp "<stamp> <content hash>", rewritten by darknet-daemon.js when CHILD_FILES change and copied with them. */
export const BUILD_FILE = inDir("darknet-build.txt");
/** Build of the scripts stored on this server (0 = unknown). */
export const readBuild = (ns) => Number(String(ns.read(BUILD_FILE)).split(" ")[0]) || 0;
/** Build a running worm started with, from its --build arg (0 = none). */
export const buildOf = (process) => {
  const at = process.args.indexOf("--build");
  return at >= 0 ? Number(process.args[at + 1]) || 0 : 0;
};

/** Cache rewards (one JSON line each) written by the cache worker for the local crawler to report. */
export const LOOT_FILE = inDir("darknet-loot.txt");
/** Passwords for a new worm, written and copied by whoever starts it. Outside CHILD_FILES to keep the build stable. */
export const KNOWN_FILE = "/Temp/darknet-known.json";
/** PIDs asked to stop, per server. Workers poll it and exit, which saves the crawler ns.kill (0.5 GB). */
export const STOP_FILE = inDir("darknet-stop.txt");
const readPids = (ns) => {
  try {
    const pids = JSON.parse(ns.read(STOP_FILE) || "[]");
    return Array.isArray(pids) ? pids : [];
  } catch {
    return [];
  }
};
/** Workers: true once the local crawler asked this process to stop. */
export const stopRequested = (ns) => readPids(ns).includes(ns.pid);
/** Crawler: asks `processes` (from ns.ps) to stop and drops exited PIDs from the file. */
export const requestStop = (ns, running, processes) => {
  const alive = new Set(running.map((process) => process.pid));
  const pids = new Set([...readPids(ns).filter((pid) => alive.has(pid)), ...processes.map((process) => process.pid)]);
  ns.write(STOP_FILE, JSON.stringify([...pids]), "w");
};

const stripSlash = (path) => String(path).replace(/^\/+/, "");
/** True if two script paths match, ignoring a leading "/". */
export const samePath = (a, b) => stripSlash(a) === stripSlash(b);
/** Config file getConfiguration reads for a script, e.g. "darknet/darknet-coordinator.js.config.txt". */
export const configFile = (scriptPath) => `${stripSlash(scriptPath)}.config.txt`;

/** Files a darknet server needs for the worm and workers; also hashed into the build stamp. Includes the daemon's config, which the worm reads. */
export const CHILD_FILES = [
  WORM,
  CRAWL,
  PATHS,
  RAM_WORKER,
  PHISH_WORKER,
  STASIS_WORKER,
  MIGRATE_WORKER,
  CACHE_WORKER,
  RESTART_WORKER,
  BUILD_FILE,
  "/helpers.js",
  configFile(DAEMON),
];

/**
 * The current build: BUILD_FILE's stamp, renewed with Date.now() when the CHILD_FILES contents change (e.g. git-pull).
 * Run on home only (it holds the master copies). Returns { build, previous }; previous 0 = first stamp. File I/O only (0 GB).
 */
export const stampBuild = (ns) => {
  const hash = String(hashCode(CHILD_FILES.filter((file) => file !== BUILD_FILE).map((file) => ns.read(file)).join("\n\0")));
  const [stamp, saved] = String(ns.read(BUILD_FILE)).split(" ");
  const previous = Number(stamp) || 0;
  if (saved === hash && previous > 0) {
    return { build: previous, previous };
  }
  const build = Date.now();
  ns.write(BUILD_FILE, `${build} ${hash}`, "w");
  return { build, previous };
};
