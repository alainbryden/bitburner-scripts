/**
 * Darknet crawler run on every held darknet server: self-updates, mines clues, opens caches, applies stasis links and
 * migrations on request, phishes with spare RAM, cracks/colonises neighbours and reports to the coordinator.
 * Settings: darknet-daemon.js.config.txt (copied with the scripts), then command line. Rare/costly ns calls live in /darknet workers.
 */
import { log, formatMoney, formatRam } from "../helpers.js";
import {
  CACHE_WORKER,
  DAEMON,
  KNOWN_FILE,
  LOOT_FILE,
  MIGRATE_WORKER,
  PHISH_WORKER,
  RAM_WORKER,
  RESTART_WORKER,
  STASIS_WORKER,
  configFile,
  readBuild,
  samePath,
} from "./darknet-paths.js";
import {
  CRAWLER_SCHEMA,
  crawlNeighbours,
  freeRam,
  info,
  isRunningOn,
  logChanged,
  newState,
  options,
  parseKnown,
  remember,
  setOptions,
  stopProcesses,
  stopWorkers,
  toast,
  writeKnown,
} from "./darknet-crawl.js";

const WORM_ARGS = [
  ["known", ""], // optional JSON {hostname: password} added to KNOWN_FILE
  ["build", 0], // script build this instance started with; neighbours read it from ns.ps
];

/** Defaults, then darknet-daemon.js.config.txt, then the command line. */
const loadOptions = (ns) => {
  const fromFile = parseKnown(ns.read(configFile(DAEMON)));
  return ns.flags([...WORM_ARGS, ...CRAWLER_SCHEMA].map(([key, value]) => [key, key in fromFile ? fromFile[key] : value]));
};

/** @param {NS} ns */
export async function main(ns) {
  setOptions(loadOptions(ns));
  ns.disableLog("ALL"); // silences per-guess dnet log lines
  const host = ns.getHostname();
  const state = newState({ ...parseKnown(ns.read(KNOWN_FILE)), ...parseKnown(options.known) });
  state.build = readBuild(ns);
  info(ns, `Started on ${host} (depth ${ns.dnet.getServerDetails(host).depth}), ${Object.keys(state.known).length} known passwords, ` +
    `build ${state.build}. Cracking neighbours, spreading, then using spare RAM.`);
  while (true) {
    try {
      const update = updateSelf(ns, state, host);
      if (update === "exit") {
        return; // the restart worker starts the new scripts
      }
      if (!update) {
        await maintainLocalServer(ns, state, host);
        await crawlNeighbours(ns, state, host);
      }
    } catch (error) {
      toast(ns, "warning", "DN: Pass failed.", `Pass failed: ${error}`);
    }
    await ns.sleep(options["hack-loop-wait-ms"]);
  }
}
const STORM_SEED = "STORM_SEED.exe";
/** Keeps whole loot items that fit in ~20 chars and counts the rest ("$5.2m, HTTPWorm +1"). */
const fitLoot = (loot, maxLength = 20) => {
  const items = loot.split(", ");
  let shown = items[0];
  let used = 1;
  while (used < items.length && `${shown}, ${items[used]}`.length <= maxLength) {
    shown += `, ${items[used++]}`;
  }
  return used < items.length ? `${shown} +${items.length - used}` : shown;
};
/** Short summaries of the game's cache messages (v3.0.x openCache returns only {success, message, karmaLoss}). */
const CACHE_MESSAGES = [
  [/with the augmentation (.+)!/, (m) => m[1]],
  [/cache with (\S+?)\.?$/, (m) => m[1]], // "...a cache with $1.234m."
  [/the program (\S+?)\.exe/i, (m) => m[1]],
  [/containing (\d+) shares of (\S+?)!/, (m) => `${m[1]} ${m[2]}`],
  [/WSE Account/, () => "WSE"],
  [/TIX API/, () => "TIX"],
  [/4S Data/, () => "4S data"],
  [/(\d+) data file caches?/, (m) => `${m[1]} notes`],
  [/data file cache/, () => "notes"],
  [/coding contracts/, () => "contracts"],
];
const summarizeCacheMessage = (message = "") => {
  for (const [pattern, short] of CACHE_MESSAGES) {
    const match = message.match(pattern);
    if (match) return short(match);
  }
  return "";
};
/** One-line cache summary, e.g. "$5.2m, 3 notes". */
const describeCache = (result) => {
  const parts = [];
  if (result.money) parts.push(formatMoney(result.money));
  if (result.programName) parts.push(result.programName.replace(/\.exe$/i, ""));
  if (result.stockShares) parts.push(`${result.stockShares} ${result.stockSymbol}`);
  if (result.wseAccount) parts.push("WSE");
  if (result.tixApiAccess) parts.push("TIX");
  if (result.fourSigmaData) parts.push("4S data");
  if (result.dataFilePaths?.length) parts.push(`${result.dataFilePaths.length} notes`);
  if (result.contractFilePaths?.length) parts.push(`${result.contractFilePaths.length} contracts`);
  if (result.augmentationName) parts.push(result.augmentationName);
  return parts.join(", ") || summarizeCacheMessage(result.message) || "cache";
};
/** Full cache contents, e.g. "$5.200m; program HTTPWorm.exe; 40 ECP shares; karma -1". */
const describeCacheFull = (result) => {
  const parts = [];
  if (result.money) parts.push(formatMoney(result.money));
  if (result.programName) parts.push(`program ${result.programName}`);
  if (result.stockShares) parts.push(`${result.stockShares.toLocaleString()} ${result.stockSymbol} shares`);
  if (result.wseAccount) parts.push("WSE account");
  if (result.tixApiAccess) parts.push("TIX API access");
  if (result.fourSigmaData) parts.push("4S market data");
  if (result.augmentationName) parts.push(`augmentation ${result.augmentationName}`);
  if (result.dataFilePaths?.length) parts.push(`notes: ${result.dataFilePaths.join(", ")}`);
  if (result.contractFilePaths?.length) parts.push(`contracts: ${result.contractFilePaths.join(", ")}`);
  if (parts.length === 0 && result.message) parts.push(result.message.replace(/\.$/, "")); // v3.0.x: only the message describes it
  if (result.karmaLoss) parts.push(`karma -${+Math.abs(result.karmaLoss).toFixed(2)}`);
  return parts.join("; ") || "nothing";
};
/** When newer scripts arrive, hands over to the restart worker. Returns "exit", "wait" or null. */
const updateSelf = (ns, state, host) => {
  const latest = readBuild(ns);
  if (latest <= state.build) {
    return null;
  }
  const needed = ns.getScriptRam(RESTART_WORKER, host);
  if (needed <= 0) {
    logChanged(ns, state, "update", `WARNING: Build ${latest} arrived but ${RESTART_WORKER} is missing on ${host}; keeping build ${state.build}.`);
    return null;
  }
  if (freeRam(ns, host) < needed) {
    stopWorkers(ns, host, [PHISH_WORKER, RAM_WORKER, MIGRATE_WORKER]);
    logChanged(ns, state, "update", `INFO: Build ${latest} arrived: pausing workers on ${host} to fit ${RESTART_WORKER} (${formatRam(needed)}).`);
    return "wait";
  }
  writeKnown(ns, state.known); // the new version reads them from KNOWN_FILE
  const pid = ns.exec(RESTART_WORKER, host, 1, ns.pid, "--build", latest);
  if (pid === 0) {
    logChanged(ns, state, "update", `WARNING: Build ${latest} arrived but ${RESTART_WORKER} won't start on ${host}; retrying next pass.`);
    return "wait";
  }
  log(ns, `INFO: DN update: ${host} build ${state.build || "pre-build"} -> ${latest}; restarting with the new scripts (${RESTART_WORKER}, pid ${pid}).`, true);
  return "exit";
};
// ---------------------------------------------------------------------------------------------------------------
// Looking after servers once we own them
// ---------------------------------------------------------------------------------------------------------------

/** Opens caches, frees blocked RAM, then phishes with the rest. */
const maintainLocalServer = (ns, state, host) => {
  reportLoot(ns, host);
  mineLocalFiles(ns, state, host);
  if (openCaches(ns, state, host)) {
    return; // next pass phishing restarts with all RAM
  }
  if (updateStasisLink(ns, state, host)) {
    return; // RAM goes to the stasis worker
  }
  if (updateMigration(ns, state, host)) {
    return; // spare RAM goes to the migration worker
  }
  if (state.roomFor && Date.now() < state.roomFor.until) {
    logChanged(ns, state, "worker", `INFO: Phishing paused: ${host}'s RAM is kept free to unblock RAM on ${state.roomFor.host}.`);
    return;
  }

  const blocked = ns.dnet.getBlockedRam(host);
  const worker = blocked > 0 ? RAM_WORKER : PHISH_WORKER;
  const workerRam = ns.getScriptRam(worker, host);
  if (workerRam <= 0 || isRunningOn(ns, host, worker)) {
    return;
  }
  const threads = Math.floor((ns.getServerMaxRam(host) - ns.getServerUsedRam(host)) / workerRam);
  if (threads >= 1 && ns.exec(worker, host, { threads })) {
    info(
      ns,
      blocked > 0
        ? `Started ${worker} x${threads}: freeing the ${formatRam(blocked)} the owner blocks (then phishing).`
        : `Started ${worker} x${threads}: phishing for money and charisma with spare RAM.`,
    );
  } else {
    logChanged(ns, state, "worker", `INFO: No room for ${worker} on ${host} yet (needs ${formatRam(workerRam)}).`);
  }
};
/** Toasts rewards the cache worker left in LOOT_FILE, then empties it. */
const reportLoot = (ns, host) => {
  const raw = ns.read(LOOT_FILE);
  if (!raw) {
    return;
  }
  ns.write(LOOT_FILE, "", "w");
  for (const line of raw.split("\n").filter(Boolean)) {
    const result = parseKnown(line);
    if (result.success) {
      const loot = describeCache(result);
      toast(ns, "success", `DN: LOOT: ${fitLoot(loot)}: [${host}]`,
        `DN loot: cache ${result.file ?? ""} on ${host}: ${describeCacheFull(result)}.`, true);
    } else {
      toast(ns, "warning", `DN: Cache failed: ${host}.`, `Couldn't open cache ${result.file ?? ""} on ${host}: ${result.message}`);
    }
  }
};
/** Hands caches to the cache worker (openCache costs 2 GB), pausing phishing if needed. Returns true if maintenance should wait. */
const openCaches = (ns, state, host) => {
  const caches = ns.ls(host, ".cache").filter((name) => name.endsWith(".cache"));
  if (caches.length === 0 || isRunningOn(ns, host, CACHE_WORKER)) {
    return false;
  }
  const needed = ns.getScriptRam(CACHE_WORKER, host);
  if (needed <= 0) {
    logChanged(ns, state, "cache", `WARNING: ${CACHE_WORKER} is missing on ${host}; its ${caches.length} cache(s) stay closed.`);
    return false;
  }
  if (freeRam(ns, host) >= needed && ns.exec(CACHE_WORKER, host, 1, ...caches) !== 0) {
    return true;
  }
  if (stopWorkers(ns, host, [PHISH_WORKER])) {
    logChanged(ns, state, "cache", `INFO: Pausing phishing on ${host} to open ${caches.length} cache(s) (${CACHE_WORKER} needs ${formatRam(needed)}).`);
    return true;
  }
  logChanged(ns, state, "cache", `INFO: ${caches.length} cache(s) on ${host} wait for ${formatRam(needed)} free RAM.`);
  return false;
};
/**
 * Reads *.data.txt clues: named passwords are saved, unnamed "Remember this password" clues are tried first on
 * neighbours, all text goes to the coordinator's notes archive. .lit files are copied to home.
 */
const mineLocalFiles = (ns, state, host) => {
  for (const file of ns.ls(host, ".data.txt")) {
    if (state.minedFiles.has(file)) continue;
    state.minedFiles.add(file);
    const text = ns.read(file).trim();
    const named = /Server: (\S+) Password: "(.*)"/.exec(text);
    const unnamed = /^Remember this password: (.*)$/.exec(text);
    if (named) {
      remember(state.known, named[1], named[2], `found in clue file ${file} on ${host}`);
      toast(ns, "success", `DN: LOOT: password: [${host}]`, `DN loot: clue file ${file} on ${host} names the password of ${named[1]}. Saved, no cracking needed.`, true);
    } else if (unnamed) {
      state.hintPasswords.add(unnamed[1]);
      info(ns, `Clue file ${file} on ${host}: a neighbour's password (unnamed). Tried first on uncracked neighbours.`);
    } else {
      info(ns, `Note ${file} on ${host}: "${text}"`);
    }
    ns.writePort(options["report-port"], JSON.stringify({ type: "note", host, file, text }));
  }
  for (const file of ns.ls(host, ".lit")) {
    if (state.minedFiles.has(file)) continue;
    state.minedFiles.add(file);
    if (!ns.fileExists(file, "home") && ns.scp(file, "home")) {
      toast(ns, "success", `DN: LOOT: lore: [${host}]`, `DN loot: collected ${file} from ${host} to home (read it with: cat ${file}).`, true);
    }
  }
  if (ns.fileExists(STORM_SEED, host) && !state.warned.has(STORM_SEED)) {
    state.warned.add(STORM_SEED);
    toast(
      ns,
      "warning",
      `DN: Storm seed: ${host}.`,
      `${STORM_SEED} on ${host}. It deletes ~60% of the darknet and restarts the rest, so the darknet scripts never run it.`,
      true,
    );
  }
};
/**
 * Air-gap crossing: when the coordinator names this server as carrier, a worker repeatedly induces migration of the
 * target neighbour; our instance on it moves along. Returns true while busy with that.
 */
const updateMigration = (ns, state, host) => {
  const plan = parseKnown(ns.peek(options["control-port"])).migrate;
  const processes = ns.ps(host);
  const running = processes.filter((process) => samePath(process.filename, MIGRATE_WORKER));
  const isOurs = plan && plan.from === host;
  const stale = running.filter((process) => !isOurs || process.args[0] !== plan.target);
  if (stale.length > 0) {
    stopProcesses(ns, host, stale, processes);
    logChanged(ns, state, "migrate-stop", `INFO: Stopped inducing migration of ${stale.map((process) => process.args[0]).join(", ")}: no longer needed.`);
  }
  if (!isOurs) {
    return false;
  }
  if (running.some((process) => process.args[0] === plan.target)) {
    logChanged(ns, state, "migrate", `INFO: Still inducing migration of ${plan.target} to carry our instance over the air gap...`);
    return true;
  }
  if (stale.length > 0) {
    return true; // the old worker holds its RAM until it exits
  }
  const workerRam = ns.getScriptRam(MIGRATE_WORKER, host);
  if (workerRam <= 0) {
    return false;
  }
  if (stopWorkers(ns, host, [PHISH_WORKER])) {
    logChanged(ns, state, "migrate", `INFO: Pausing phishing on ${host}: its RAM goes to inducing migration of ${plan.target} next pass.`);
    return true;
  }
  const threads = Math.floor(freeRam(ns, host) / workerRam);
  const pid = threads >= 1 ? ns.exec(MIGRATE_WORKER, host, { threads }, plan.target) : 0;
  if (pid) {
    info(
      ns,
      `Inducing migration of ${plan.target} (${threads} threads): stuck above an air gap. When it moves, our instance ` +
        `on it rides along, hopefully past the gap. Phishing paused.`,
    );
    return true;
  }
  logChanged(ns, state, "migrate", `WARNING: No room on ${host} for ${MIGRATE_WORKER} (needs ${formatRam(workerRam)}).`);
  return false;
};
/** Applies or removes this server's stasis link on the coordinator's request (worker needs 12GB+; other workers stop to make room). Returns true while pending. */
const updateStasisLink = (ns, state, host) => {
  const control = parseKnown(ns.peek(options["control-port"]));
  const linked = ns.dnet.getStasisLinkedServers().includes(host);
  const shouldLink = (control.link ?? []).includes(host) && !linked;
  const shouldUnlink = (control.unlink ?? []).includes(host) && linked;
  if (!shouldLink && !shouldUnlink) {
    return false;
  }
  const action = shouldLink ? "apply a stasis link to" : "remove the stasis link from";
  if (isRunningOn(ns, host, STASIS_WORKER)) {
    logChanged(ns, state, "stasis", `INFO: Waiting for ${STASIS_WORKER} to ${action} ${host}...`);
    return true;
  }
  const needed = ns.getScriptRam(STASIS_WORKER, host);
  if (needed <= 0) {
    return false;
  }
  const why = shouldLink
    ? "one of the deepest servers we hold, so a permanent foothold"
    : "moving the link to a much deeper server";
  if (freeRam(ns, host) < needed && stopWorkers(ns, host, [PHISH_WORKER, RAM_WORKER])) {
    logChanged(ns, state, "stasis", `INFO: Pausing RAM/phishing workers on ${host} to fit ${STASIS_WORKER} (${formatRam(needed)}).`);
    return true;
  }
  if (ns.exec(STASIS_WORKER, host, 1, shouldLink ? "link" : "unlink") !== 0) {
    info(ns, `Asked to ${action} ${host}: ${why}.`);
    return true;
  }
  logChanged(ns, state, "stasis", `WARNING: Can't start ${STASIS_WORKER} on ${host} (needs ${formatRam(needed)}).`);
  return false;
};