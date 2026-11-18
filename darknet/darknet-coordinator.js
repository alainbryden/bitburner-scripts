/**
 * Started on home by darknet-daemon.js. Buys DarkscapeNavigator.exe, saves passwords and reports, manages stasis
 * links (lab gateway first, then deepest servers) and backdoors, relaunches dark-w0rm.js on linked/backdoored servers.
 * Settings: argsSchema, darknet/darknet-coordinator.js.config.txt or command line; shared ones arrive as args from darknet-daemon.js.
 */
import { getConfiguration, getFnRunViaNsExec, getNsDataThroughFile_Custom, log as logToTail, formatRam } from "../helpers.js";
import { BACKDOOR_WORKER, KNOWN_FILE, WORM, RELAUNCH_WORKER, STASIS_WORKER, samePath } from "./darknet-paths.js";

const CRAWLER = WORM;
const CONTRACTOR = "/Tasks/contractor.js";
const DARKSCAPE = "DarkscapeNavigator.exe";
const TOR_BUYER = "/Tasks/tor-manager.js";
const PROGRAM_BUYER = "/Tasks/program-manager.js";
const NO_DATA = "NULL PORT DATA";
const AIR_GAP_DEPTH = 8; // every 8th row of the darknet is empty, so no connection crosses it (game constant)
const LAB_NAMES = [
  "th3_l4byr1nth", "cru3l_l4byr1nth", "m3rc1l3ss_l4byr1nth", "ub3r_l4byr1nth",
  "et3rn4l_l4byr1nth", "end13ss_l4byr1nth", "f1n4l_l4byr1nth", "b0nus_l4byr1nth",
];

const argsSchema = [
  ["report-port", 7461], // instances -> coordinator (from darknet-daemon.js)
  ["control-port", 7462], // coordinator -> instances (from darknet-daemon.js)
  ["event-port", 7463], // coordinator -> darknet-daemon.js tail (from darknet-daemon.js)
  ["state-file", "/data/darknet-state.json"], // saved passwords and nodes (from darknet-daemon.js)
  ["max-known-passwords", 300], // passwords handed to relaunched instances (from darknet-daemon.js)
  ["max-backdoors", 2], // game adds instability above 2 backdoors; 0 disables
  ["relink-depth", 3], // move a stasis link when a held server is this many levels deeper than the shallowest link
  ["fresh-ms", 90000], // node reports older than this are ignored for planning / routing
  ["forget-ms", 900000], // drop node reports older than this
  ["plan-ms", 10000], // planning interval
  ["backdoor-retry-ms", 300000], // wait before retrying a backdoor on the same server
  ["backdoor-min-rooted", 8], // rooted servers needed before any backdoor
  ["backdoor-min-gain", 8], // terminal hops a backdoor must save across the known net
  ["max-passwords", 500], // passwords kept in the state file
  ["notes-file", "/data/darknet-notes.txt"], // clue/lore notes archive (read with cat)
  ["contract-ms", 60000], // min time between contractor.js runs
  ["cross-air-gaps", true], // induce migrations to carry instances across air gaps towards the labyrinth
  ["verbose", false], // also log every password learned and relaunch check
];
// Defaults until main() loads the config (also used when tests call the planners directly)
let options = Object.fromEntries(argsSchema);

export function autocomplete(data, _) {
  data.flags(argsSchema);
  return [];
}

/** @param {NS} ns */
export async function main(ns) {
  const runOptions = getConfiguration(ns, argsSchema);
  if (!runOptions) {
    return;
  }
  options = runOptions;
  ns.disableLog("ALL");
  const saved = parseJson(ns.read(options["state-file"]));
  const state = {
    passwords: saved.passwords ?? {},
    nodes: saved.nodes ?? {},
    backdoorRetryAt: {},
    relaunchRetryAt: {},
    lastPlan: 0,
    lastLog: new Map(),
    lastContractRun: 0,
    // Notes are archived as "[file @ host] text"; dedupe on text since lore repeats across servers
    notesSeen: new Set(ns.read(options["notes-file"]).split("\n").map((line) => line.replace(/^\[[^\]]*\] /, "")).filter(Boolean)),
  };
  const hasSingularity = await nsData(ns,
    "(() => { const r = ns.getResetInfo(); return r.currentNode === 4 || (r.ownedSF.get(4) ?? 0) > 0; })()",
    "/Temp/darknet-has-singularity.txt");
  info(
    ns,
    `Loaded ${plural(Object.keys(state.passwords).length, "password")} and ${plural(Object.keys(state.nodes).length, "node")} ` +
      `from ${options["state-file"]}. ` +
      (hasSingularity
        ? `Singularity found: buying ${DARKSCAPE} if needed, up to ${options["max-backdoors"]} backdoors.`
        : `No Singularity (needs BN4/SF4): buy ${DARKSCAPE} yourself; no backdoors, stasis links still work.`),
  );
  await ensureDarkscape(ns, hasSingularity);
  info(ns, `Stasis link limit: ${ns.dnet.getStasisLinkLimit()}. Links go to the deepest servers we hold, so the net can't shake us off.`);

  while (true) {
    drainReports(ns, state);
    if (Date.now() - state.lastPlan >= options["plan-ms"]) {
      state.lastPlan = Date.now();
      try {
        await plan(ns, state, hasSingularity);
      } catch (error) {
        toast(ns, "warning", "DN: Planning failed.", `Planning failed: ${error}`);
      }
      ns.write(options["state-file"], JSON.stringify({ passwords: state.passwords, nodes: state.nodes }), "w");
    }
    await ns.sleep(1000);
  }
}

// Tail logging; every line is mirrored to the event port for the darknet-daemon.js tail.
/** Runs a RAM-heavy ns call in a temp script via ns.exec, keeping its RAM cost out of the coordinator. */
const nsData = (ns, command, file, args = []) => getNsDataThroughFile_Custom(ns, getFnRunViaNsExec(ns, "home"), command, file, args);
const log = (ns, message, ...rest) => {
  logToTail(ns, message, ...rest);
  ns.writePort(options["event-port"], message);
  return message;
};
const info = (ns, message) => log(ns, `INFO: ${message}`);
const detail = (ns, message) => options.verbose && log(ns, `INFO: ${message}`);
/** Short screen toast plus the full tail line. */
const toast = (ns, style, short, full, toTerminal = false) => {
  log(ns, `${style === "success" ? "SUCCESS" : "WARNING"}: ${full}`, toTerminal);
  ns.toast(short, style);
};
/** Logs only when the message for `key` changed since the last call. */
const logChanged = (ns, state, key, message) => {
  if (state.lastLog.get(key) !== message) {
    state.lastLog.set(key, message);
    if (message) log(ns, message);
  }
};
const depthOf = (state, host) => state.nodes[host]?.depth ?? "?";
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** ns.dnet calls throw until DarkscapeNavigator.exe is owned. Singularity buys it (TOR first); otherwise the player must. */
const ensureDarkscape = async (ns, hasSingularity) => {
  if (ns.fileExists(DARKSCAPE, "home")) {
    return;
  }
  if (hasSingularity) {
    info(ns, `${DARKSCAPE} missing: buying the TOR router, then ${DARKSCAPE}, as soon as we can afford them.`);
  } else {
    ns.tprint(`darknet: waiting for ${DARKSCAPE}. Buy it via the TOR router (terminal: buy ${DARKSCAPE}).`);
    info(ns, `${DARKSCAPE} missing and no Singularity to buy it: waiting for you (terminal: buy ${DARKSCAPE}).`);
  }
  while (!ns.fileExists(DARKSCAPE, "home")) {
    if (hasSingularity) {
      ns.exec(TOR_BUYER, "home");
      ns.exec(PROGRAM_BUYER, "home", 1, DARKSCAPE);
    }
    await ns.sleep(5000);
  }
  toast(ns, "success", "DN: Access unlocked.", `${DARKSCAPE} acquired. Darknet automation is starting.`, true);
};

const drainReports = (ns, state) => {
  for (let raw = ns.readPort(options["report-port"]); raw !== NO_DATA; raw = ns.readPort(options["report-port"])) {
    const message = parseJson(raw);
    if (message.type === "pw" && typeof message.password === "string") {
      const previous = state.passwords[message.host];
      delete state.passwords[message.host];
      state.passwords[message.host] = message.password;
      if (previous !== message.password) {
        const node = state.nodes[message.host];
        info(
          ns,
          `${previous === undefined ? "Saved password" : "Password changed (server reset)"} for ` +
            `${message.host}${node ? ` (depth ${node.depth})` : ""}: "${message.password}". ${capitalize(message.via ?? "learned")}` +
            `${message.from ? ` (from ${message.from})` : ""}. Dictionary: ${plural(Object.keys(state.passwords).length, "password")}.`,
        );
      }
    } else if (message.type === "node") {
      const { type, ...node } = message;
      if (!state.nodes[node.host] && node.host !== "home") {
        info(ns, `New server: ${node.host} (depth ${node.depth}, ${formatRam(node.maxRam)}, ${plural(node.neighbours?.length ?? 0, "neighbour")}). Our instance runs there.`);
      }
      state.nodes[node.host] = { ...node, seen: Date.now() };
    } else if (message.type === "note" && typeof message.text === "string" && !state.notesSeen.has(message.text)) {
      state.notesSeen.add(message.text);
      ns.write(options["notes-file"], `[${message.file} @ ${message.host}] ${message.text}\n`, "a");
      toast(ns, "success", `DN: LOOT: lore: [${message.host}]`, `New note from ${message.host}, archived to ${options["notes-file"]}: "${message.text}"`);
    } else if (message.type === "relaunch") {
      // The worker toasts success itself; failures repeat per retry, so log them on change only
      if (message.ok) {
        state.lastLog.delete(`relaunch-${message.host}`);
        log(ns, `SUCCESS: Relaunched ${CRAWLER} on ${message.host} (${message.message})`);
      } else {
        logChanged(ns, state, `relaunch-${message.host}`, `WARNING: ${CRAWLER} isn't running on ${message.host}: ${message.message}`);
      }
    }
  }
  const hosts = Object.keys(state.passwords);
  hosts.slice(0, Math.max(hosts.length - options["max-passwords"], 0)).forEach((host) => delete state.passwords[host]);
};

const plan = async (ns, state, hasSingularity) => {
  const now = Date.now();
  for (const [host, node] of Object.entries(state.nodes)) {
    if (now - node.seen > options["forget-ms"]) {
      delete state.nodes[host];
    }
  }

  const linked = ns.dnet.getStasisLinkedServers();
  const lab = findLabyrinth(ns);
  const contractHosts = Object.values(state.nodes)
    .filter((node) => now - node.seen <= options["fresh-ms"] && node.host !== "home" && (node.contracts ?? []).length > 0)
    .map((node) => node.host);
  const status = await serverStatus(ns, [...Object.keys(state.passwords), ...contractHosts, ...(lab ? [lab.name] : [])]);
  // Stationary servers (the labyrinth) add no instability and take no backdoor slot
  const backdoored = Object.keys(state.passwords).filter(
    (host) => !linked.includes(host) && !isStationary(state, host) && status.get(host) === BACKDOORED,
  );
  const labBackdoored = !!lab && status.get(lab.name) === BACKDOORED;
  const neededRam = ns.getScriptRam(CRAWLER) + ns.getScriptRam(STASIS_WORKER);
  const limit = ns.dnet.getStasisLinkLimit();
  const control = planStasis(state, linked, limit, neededRam, now, lab);
  const migration = options["cross-air-gaps"] ? planMigration(state, linked, lab, now) : { plan: null, reason: "INFO: Air-gap crossing is off (cross-air-gaps)." };
  control.migrate = migration.plan;
  ns.clearPort(options["control-port"]);
  ns.writePort(options["control-port"], JSON.stringify(control));
  logChanged(ns, state, "stasis", describeStasisPlan(state, control, linked, limit, neededRam, lab));
  logChanged(ns, state, "migrate", migration.reason);

  const anchors = [...linked, ...backdoored, ...(labBackdoored ? [lab.name] : [])];
  for (const host of new Set(anchors)) {
    relaunch(ns, state, host, now);
  }
  runContractor(ns, state, contractHosts.filter((host) => status.get(host) !== MISSING), now);

  if (!hasSingularity) {
    logChanged(ns, state, "backdoor", "");
  } else if (isRunningOn(ns, "home", BACKDOOR_WORKER)) {
    logChanged(ns, state, "backdoor", `INFO: ${BACKDOOR_WORKER} is still heading to its target...`);
  } else if (!(lab && !labBackdoored && options["max-backdoors"] > 0 && planLabBackdoor(ns, state, anchors, lab, now))) {
    planBackdoor(ns, state, anchors, backdoored, now);
  }
  const fresh = Object.values(state.nodes).filter((node) => now - node.seen <= options["fresh-ms"]);
  const deepest = Math.max(-1, ...fresh.map((node) => node.depth));
  logChanged(
    ns,
    state,
    "summary",
    `INFO: Network: ${plural(Object.keys(state.passwords).length, "password")} saved, ${plural(fresh.length, "server")} reporting ` +
      `(deepest ${deepest}) | stasis [${linked.join(", ")}] ${linked.length}/${limit} | backdoors [${backdoored.join(", ")}]` +
      (labBackdoored ? ` + ${lab.name}` : ""),
  );
};

const isStationary = (state, host) => LAB_NAMES.includes(host) || state.nodes[host]?.stationary === true;

/** True if `node` neighbours the labyrinth (adjacency is two-way). */
export const isLabGateway = (state, lab, node) =>
  !!lab && ((node.neighbours ?? []).includes(lab.name) || (state.nodes[lab.name]?.neighbours ?? []).includes(node.host));

/** Describes the stasis plan for the tail. */
const describeStasisPlan = (state, control, linked, limit, neededRam, lab) => {
  const gateway = (host) => !!state.nodes[host] && isLabGateway(state, lab, state.nodes[host]);
  if (control.link.length > 0) {
    const targets = control.link.map((host) => `${host} (depth ${depthOf(state, host)}${gateway(host) ? ", next to the labyrinth" : ""})`).join(", ");
    return `INFO: Asking ${targets} to apply a stasis link (${linked.length}/${limit} used): ` +
      (control.link.some(gateway)
        ? `a linked server never moves, so it keeps its connection to ${lab.name} for good. `
        : `deepest we hold with ${neededRam.toFixed(2)}GB free. `) +
      `Linked servers never move, restart or go offline.`;
  }
  if (control.unlink.length > 0) {
    const host = control.unlink[0];
    return `INFO: Asking ${host} (depth ${depthOf(state, host)}) to drop its stasis link: ` +
      (lab && !linked.some(gateway)
        ? `all ${limit} links are used and none is next to the labyrinth ${lab.name}, but a server we hold is.`
        : `a server ${options["relink-depth"]}+ levels deeper is held and all ${limit} links are used.`);
  }
  if (linked.length < limit) {
    return `INFO: ${limit - linked.length} stasis link(s) unused: no held, movable server has ${neededRam.toFixed(2)}GB ` +
      `free yet. Waiting for deeper reports.`;
  }
  return `INFO: Stasis links in place on ${linked.map((host) => `${host} (depth ${depthOf(state, host)}${gateway(host) ? ", labyrinth gateway" : ""})`).join(", ")}.`;
};

/** The current labyrinth and its depth, or null if none exists yet. */
const findLabyrinth = (ns) => {
  for (const name of LAB_NAMES) {
    if (ns.dnet.isDarknetServer(name)) {
      return { name, depth: ns.dnet.getServerDetails(name).depth };
    }
  }
  return null;
};

/**
 * Air-gap crossing: when our deepest server sits right above a gap before the labyrinth, a neighbouring instance
 * (carrier) induces migration of a held server (rider) whose difficulty can land past the gap (difficulty-2 .. +4).
 * Returns { plan: {target, from} | null, reason }.
 */
export const planMigration = (state, linked, lab, now) => {
  const fresh = Object.values(state.nodes).filter((node) => now - node.seen <= options["fresh-ms"] && node.host !== "home");
  if (!lab) {
    return { plan: null, reason: "INFO: No labyrinth yet (needs full darknet access), so no air gaps to cross." };
  }
  if (fresh.length === 0) {
    return { plan: null, reason: "" };
  }
  const deepest = Math.max(...fresh.map((node) => node.depth));
  const goal = lab.depth - 1;
  if (deepest >= goal) {
    return { plan: null, reason: `INFO: We hold depth ${deepest}, next to the labyrinth ${lab.name} (depth ${lab.depth}). No migration needed.` };
  }
  const gap = (Math.floor(deepest / AIR_GAP_DEPTH) + 1) * AIR_GAP_DEPTH;
  if (deepest < gap - 1 || gap > goal) {
    return { plan: null, reason: `INFO: Deepest held depth ${deepest}, labyrinth ${lab.name} at ${lab.depth}: still spreading normally.` };
  }
  const riders = fresh
    .filter((node) => !node.stationary && !linked.includes(node.host) && (node.difficulty ?? node.depth) + 4 > gap)
    .sort((a, b) => (b.difficulty ?? b.depth) - (a.difficulty ?? a.depth));
  for (const rider of riders) {
    // Links are two-way: either side may have reported the other
    const carrier = fresh.find(
      (node) => node.host !== rider.host && ((node.neighbours ?? []).includes(rider.host) || (rider.neighbours ?? []).includes(node.host)),
    );
    if (carrier) {
      return {
        plan: { target: rider.host, from: carrier.host },
        reason:
          `INFO: Stuck at depth ${deepest} above the air gap at ${gap} (labyrinth ${lab.name} at ${lab.depth}). ` +
          `${carrier.host} will induce migration of ${rider.host} (difficulty ${rider.difficulty}, lands up to depth ` +
          `${(rider.difficulty ?? rider.depth) + 4}) to carry our instance across.`,
      };
    }
  }
  return {
    plan: null,
    reason: `INFO: Stuck above the air gap at depth ${gap}, but no held, movable server with difficulty ${gap - 3}+ ` +
      `has a neighbour running our instance yet. Waiting for one.`,
  };
};

/** ns.scan misses darknet servers, so contractor.js gets the contract hosts as args. */
const runContractor = (ns, state, hosts, now) => {
  if (hosts.length === 0 || now - state.lastContractRun < options["contract-ms"] || isRunningOn(ns, "home", CONTRACTOR)) {
    return;
  }
  state.lastContractRun = now;
  const count = hosts.reduce((sum, host) => sum + state.nodes[host].contracts.length, 0);
  if (ns.exec(CONTRACTOR, "home", 1, ...hosts) !== 0) {
    info(ns, `Found ${plural(count, "coding contract")} on darknet servers (${hosts.join(", ")}). Running ${CONTRACTOR} on them, since its own scan can't see the darknet.`);
    hosts.forEach((host) => (state.nodes[host].contracts = [])); // wait for fresh reports
  } else {
    toast(ns, "warning", "DN: Contracts waiting.", `Can't start ${CONTRACTOR} for ${plural(count, "darknet contract")} (low RAM on home?). Retrying later.`);
  }
};

/** Held servers fit for a long-term foothold, deepest first. */
const candidates = (state, now, minFreeRam = 0) =>
  Object.values(state.nodes)
    .filter(
      (node) =>
        now - node.seen <= options["fresh-ms"] &&
        node.host !== "home" &&
        !node.stationary &&
        !/l4byr1nth$/.test(node.host) &&
        state.passwords[node.host] !== undefined &&
        node.maxRam - (node.blockedRam ?? 0) >= minFreeRam,
    )
    .sort((a, b) => b.depth - a.depth);

/** Picks servers to apply or drop a stasis link: a lab gateway first (its labyrinth connection freezes), then the deepest. */
export const planStasis = (state, linked, limit, neededRam, now, lab = null) => {
  const gateway = (node) => isLabGateway(state, lab, node);
  const free = candidates(state, now, neededRam)
    .filter((node) => !linked.includes(node.host))
    .sort((a, b) => gateway(b) - gateway(a)); // stable: deepest first within each group
  if (linked.length < limit) {
    return { link: free.slice(0, limit - linked.length).map((node) => node.host), unlink: [] };
  }
  const known = linked.filter((host) => state.nodes[host]).sort((a, b) => state.nodes[a].depth - state.nodes[b].depth);
  const keptGateway = known.find((host) => gateway(state.nodes[host]));
  if (!keptGateway && known[0] && free[0] && gateway(free[0])) {
    return { link: [], unlink: [known[0]] };
  }
  const shallowest = known.find((host) => host !== keptGateway);
  if (shallowest && free[0] && free[0].depth >= state.nodes[shallowest].depth + options["relink-depth"]) {
    return { link: [], unlink: [shallowest] };
  }
  return { link: [], unlink: [] };
};

/** Two-way adjacency between fresh nodes; home links to darkweb before it reports. */
const buildEdges = (state, now) => {
  const edges = new Map();
  const link = (a, b) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a).add(b);
  };
  for (const node of Object.values(state.nodes)) {
    if (now - node.seen > options["fresh-ms"]) continue;
    for (const neighbour of node.neighbours ?? []) {
      link(node.host, neighbour);
      link(neighbour, node.host);
    }
  }
  if (!state.nodes.home) {
    link("home", "darkweb");
  }
  return edges;
};

/** BFS from home; anchors (backdoored/linked) are one `connect` from anywhere. Returns { previous, distance }. */
const searchFromHome = (edges, anchors, target = null) => {
  const previous = new Map([["home", null]]);
  const distance = new Map([["home", 0]]);
  const queue = ["home"];
  while (queue.length > 0) {
    const host = queue.shift();
    if (host === target) break;
    for (const next of [...(edges.get(host) ?? []), ...anchors]) {
      if (!previous.has(next)) {
        previous.set(next, host);
        distance.set(next, distance.get(host) + 1);
        queue.push(next);
      }
    }
  }
  return { previous, distance };
};

/** Terminal route from home to `target` over reported adjacency or straight to an anchor; null if none. */
export const findRoute = (state, anchors, target, now) => {
  const { previous } = searchFromHome(buildEdges(state, now), anchors, target);
  if (!previous.has(target)) {
    return null;
  }
  const route = [];
  for (let at = target; at !== "home"; at = previous.get(at)) route.unshift(at);
  return route;
};

/** Ranks backdoor candidates by terminal hops saved across all known servers given current anchors; ties go deeper. */
export const rankBackdoors = (state, anchors, now) => {
  const edges = buildEdges(state, now);
  const hosts = [...edges.keys()].filter((host) => host !== "home");
  const before = searchFromHome(edges, anchors).distance;
  const unreachable = Math.max(0, ...before.values()) + 1;
  const hopsWith = (distance) => hosts.reduce((sum, host) => sum + (distance.get(host) ?? unreachable), 0);
  const baseline = hopsWith(before);
  return candidates(state, now)
    .filter((node) => !anchors.includes(node.host))
    .map((node) => ({ node, gain: baseline - hopsWith(searchFromHome(edges, [...anchors, node.host]).distance) }))
    .sort((a, b) => b.gain - a.gain || b.node.depth - a.node.depth);
};

/** Backdoors the stationary labyrinth (no instability, no --max-backdoors slot). Returns true if a worker started. */
const planLabBackdoor = (ns, state, anchors, lab, now) => {
  if (now < (state.backdoorRetryAt[lab.name] ?? 0)) {
    return false;
  }
  const route = findRoute(state, anchors, lab.name, now);
  if (!route) {
    detail(ns, `No terminal route to the labyrinth ${lab.name} yet (no reporting server next to it).`);
    return false;
  }
  state.backdoorRetryAt[lab.name] = now + options["backdoor-retry-ms"];
  if (ns.exec(BACKDOOR_WORKER, "home", 1, JSON.stringify(route)) === 0) {
    return false;
  }
  logChanged(ns, state, "backdoor", `INFO: Backdooring the labyrinth ${lab.name} (depth ${lab.depth}): it never moves, so ` +
    `the backdoor is free (no instability, no slot) and permanent. Terminal route: ${route.join(" > ")}.`);
  return true;
};

const planBackdoor = (ns, state, anchors, backdoored, now) => {
  if (backdoored.length >= options["max-backdoors"]) {
    logChanged(ns, state, "backdoor", options["max-backdoors"] === 0
      ? "INFO: Backdoors off (max-backdoors is 0)."
      : `INFO: Backdoors at the cap (${backdoored.length}/${options["max-backdoors"]}): more would add instability.`);
    return;
  }
  const rooted = Object.keys(state.passwords).length;
  if (rooted < options["backdoor-min-rooted"]) {
    logChanged(ns, state, "backdoor", `INFO: Backdoors wait until ${options["backdoor-min-rooted"]} servers are rooted, to judge which are deep (${rooted} so far).`);
    return;
  }
  const instability = ns.dnet.getDarknetInstability().authenticationDurationMultiplier;
  if (instability > 1) {
    logChanged(ns, state, "backdoor", `INFO: No new backdoors: the darknet is already unstable (auth time x${instability.toFixed(2)}).`);
    return;
  }
  const ranked = rankBackdoors(state, anchors, now);
  for (const { node, gain } of ranked) {
    if (gain < options["backdoor-min-gain"]) {
      break;
    }
    if (now < (state.backdoorRetryAt[node.host] ?? 0)) {
      continue;
    }
    const route = findRoute(state, anchors, node.host, now);
    if (!route) {
      detail(ns, `No terminal route to ${node.host} in the latest reports, trying the next candidate.`);
      continue;
    }
    state.backdoorRetryAt[node.host] = now + options["backdoor-retry-ms"];
    const pid = ns.exec(BACKDOOR_WORKER, "home", 1, JSON.stringify(route));
    if (pid !== 0) {
      logChanged(ns, state, "backdoor", `INFO: Backdooring ${node.host} (depth ${node.depth}, ` +
        `${plural((node.neighbours ?? []).length, "neighbour")}, backdoor ${backdoored.length + 1}/${options["max-backdoors"]}): ` +
        `best coverage, saves ${plural(gain, "terminal hop")} across the known net. Terminal route: ${route.join(" > ")}.`);
    } else {
      logChanged(ns, state, "backdoor", `WARNING: Can't start ${BACKDOOR_WORKER} on home (needs ` +
        `${ns.getScriptRam(BACKDOOR_WORKER, "home").toFixed(2)}GB free). Retrying later.`);
    }
    return;
  }
  const best = ranked[0];
  logChanged(ns, state, "backdoor", best && best.gain < options["backdoor-min-gain"]
    ? `INFO: Backdoors ${backdoored.length}/${options["max-backdoors"]}: holding the slot. Best candidate ${best.node.host} ` +
      `(depth ${best.node.depth}) would save only ${plural(best.gain, "hop")} (backdoor-min-gain ${options["backdoor-min-gain"]}).`
    : `INFO: Backdoors ${backdoored.length}/${options["max-backdoors"]}: no reachable candidate right now.`);
};

/** Restarts dark-w0rm.js on a linked/backdoored server via a one-shot worker that reports on the report port. */
const relaunch = (ns, state, host, now) => {
  const password = state.passwords[host];
  if (password === undefined || now < (state.relaunchRetryAt[host] ?? 0) || isRunningOn(ns, host, CRAWLER) ||
    ns.ps("home").some((process) => samePath(process.filename, RELAUNCH_WORKER) && process.args[0] === host)) {
    return;
  }
  state.relaunchRetryAt[host] = now + options["plan-ms"] * 3;
  const known = Object.fromEntries(Object.entries(state.passwords).slice(-options["max-known-passwords"]));
  ns.write(KNOWN_FILE, JSON.stringify(known), "w"); // the worker copies it over with the scripts
  if (ns.exec(RELAUNCH_WORKER, "home", 1, host, password, options["report-port"]) === 0) {
    logChanged(ns, state, `relaunch-${host}`, `WARNING: ${CRAWLER} isn't running on ${host}, and home lacks the ` +
      `${formatRam(ns.getScriptRam(RELAUNCH_WORKER, "home"))} for ${RELAUNCH_WORKER} to relaunch it.`);
  }
};

const isRunningOn = (ns, host, script) => {
  try {
    return ns.ps(host).some((process) => samePath(process.filename, script));
  } catch {
    return false; // the server went offline
  }
};

// Server states from serverStatus
const MISSING = 0;
const PRESENT = 1;
const BACKDOORED = 2;
/** One temp script per plan (getServer costs 2 GB). Returns Map host -> MISSING | PRESENT | BACKDOORED. */
const serverStatus = async (ns, hosts) => {
  const unique = [...new Set(hosts)];
  if (unique.length === 0) {
    return new Map();
  }
  const codes = await nsData(ns,
    "ns.args.map((h) => { try { return !ns.serverExists(h) ? 0 : ns.getServer(h).backdoorInstalled ? 2 : 1; } catch { return 0; } })",
    "/Temp/darknet-server-status.txt", unique);
  return new Map(unique.map((host, i) => [host, codes[i]]));
};

const parseJson = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};
