// /darkweb/dnet-ops.js — darknet maintenance (caches, realloc, phish, storm, stasis)
// All ns.dnet.* calls routed through rd() temp scripts.
// In-game RAM: ~2-3 GB.
//
// Usage:
//   run /darkweb/dnet-ops.js --open-caches
//   run /darkweb/dnet-ops.js --realloc [N]
//   run /darkweb/dnet-ops.js --phish
//   run /darkweb/dnet-ops.js --stormseed
//   run /darkweb/dnet-ops.js --stasis [true|false]

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const HOST = ns.getHostname();
  const HOME = "home";
  const SELF = ns.getScriptName();
  const DIR = dirname(SELF);

  const LEDGER = "/darkweb/dnet-passwords.txt";
  const KILL_PORT = 20;
  const KILL_PREFIX = "DNET_KILL|";

  const RD_TIMEOUT_MS = getFlagNumber(ns, ["--rd-timeout"], 10_000);
  const KEEP_RD = hasArg(ns, "--keep-rd");
  const MAX_REALLOC = getFlagNumber(ns, ["--realloc"], 25);
  const MAX_TARGETS = getFlagNumber(ns, ["--targets"], 50);
  const DO_PHISH = hasArg(ns, "--phish");
  const DO_CACHES = hasArg(ns, "--open-caches");
  const DO_REALLOC = hasArg(ns, "--realloc") || (!hasArg(ns, "--open-caches") && !hasArg(ns, "--phish") && !hasArg(ns, "--stormseed") && !hasArg(ns, "--stasis"));
  const DO_STORM = hasArg(ns, "--stormseed");
  const DO_STASIS = hasArg(ns, "--stasis");
  const STASIS_VALUE = (() => {
    const idx = ns.args.indexOf("--stasis");
    if (idx >= 0 && ns.args[idx + 1] !== undefined) {
      const v = String(ns.args[idx + 1]);
      if (v === "false" || v === "0") return false;
    }
    return true;
  })();

  if (hasArg(ns, "--tail")) {
    try { ns.ui.openTail(); } catch (_) {}
  }

  if (shouldDie()) return;

  if (HOST !== HOME) await pullLedgerFromHome();

  if (DO_REALLOC) await freeNeighborBlockedRam();
  if (DO_CACHES || DO_REALLOC) await openLocalCaches();
  if (DO_PHISH && HOST !== HOME && HOST !== "darkweb") {
    await doPhish();
    await openLocalCaches();
  }
  if (DO_STORM && HOST !== HOME && HOST !== "darkweb") await doStormSeed();
  if (DO_STASIS && HOST !== HOME && HOST !== "darkweb") await doStasis(STASIS_VALUE);

  // ── rd() RAM-dodge engine ─────────────────────────────────────────────────

  async function rd(label, expr, args = [], timeoutMs = RD_TIMEOUT_MS) {
    const token = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const safeLabel = String(label || "rd").replace(/[^a-zA-Z0-9_-]/g, "_");
    const tempDir = DIR ? `${DIR}/Temp` : "/Temp";
    const sf = `${tempDir}/dnet-rd-${safeLabel}-${token}.js`;
    const of = `${tempDir}/dnet-rd-${safeLabel}-${token}.txt`;

    const src = `/** @param {NS} ns */
export async function main(ns) {
  const outFile = ns.args[0];
  const args = ns.args.slice(1).map(a => { try { return JSON.parse(a); } catch (_) { return a; } });
  try {
    const result = await (async () => (${expr}))();
    await ns.write(outFile, JSON.stringify({ ok: true, result }), "w");
  } catch (e) {
    await ns.write(outFile, JSON.stringify({ ok: false, error: String(e) }), "w");
  }
}`;

    try { await ns.write(sf, src, "w"); await ns.write(of, "", "w"); }
    catch (e) { ns.print(`[RD] write failed ${safeLabel}: ${e}`); return null; }

    const pid = ns.exec(sf, HOST, 1, of, ...args.map(a => JSON.stringify(a)));
    if (!pid) {
      ns.print(`[RD] exec failed ${sf}`);
      if (!KEEP_RD) { try { ns.rm(sf, HOST); } catch (_) {} }
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && ns.isRunning(pid)) await ns.sleep(50);
    if (ns.isRunning(pid)) {
      try { ns.kill(pid); } catch (_) {}
      if (!KEEP_RD) { try { ns.rm(sf, HOST); } catch (_) {} try { ns.rm(of, HOST); } catch (_) {} }
      return null;
    }

    let raw = "";
    try { raw = ns.read(of); } catch (_) {}
    if (!KEEP_RD) { try { ns.rm(sf, HOST); } catch (_) {} try { ns.rm(of, HOST); } catch (_) {} }

    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      if (!p.ok) { ns.print(`[RD] error ${safeLabel}: ${p.error}`); return null; }
      return p.result;
    } catch (e) { ns.print(`[RD] parse error ${safeLabel}: ${raw.slice(0, 100)}`); return null; }
  }

  // ── dnet API wrappers ─────────────────────────────────────────────────────

  async function rdProbe() {
    return rd("probe", `ns.dnet.probe()`, []);
  }

  async function rdGetBlockedRam(target) {
    const r = await rd("blockedram", `(()=>{try{return ns.dnet.getBlockedRam(args[0])}catch(_){try{return ns.dnet.getServerDetails(args[0]).blockedRam}catch(__){return 0}}})()`, [target]);
    return Number.isFinite(r) ? r : 0;
  }

  async function rdMemRealloc(target) {
    return rd("realloc", `ns.dnet.memoryReallocation(args[0])`, [target], RD_TIMEOUT_MS * 2);
  }

  async function rdOpenCache(file) {
    return rd("cache", `ns.dnet.openCache(args[0])`, [file]);
  }

  async function rdPhish() {
    return rd("phish", `ns.dnet.phishingAttack()`, [], RD_TIMEOUT_MS * 2);
  }

  async function rdStorm() {
    return rd("storm", `ns.dnet.unleashStormSeed()`, []);
  }

  async function rdStasis(link) {
    return rd("stasis", `ns.dnet.setStasisLink(args[0])`, [link], 45_000);
  }

  async function rdConnect(host, pw) {
    return rd("session", `ns.dnet.connectToSession(args[0],args[1])`, [host, pw]);
  }

  // ── Operations ────────────────────────────────────────────────────────────

  async function freeNeighborBlockedRam() {
    const neighbors = await rdProbe() ?? [];
    const ledger = readLedger();
    let targets = 0;

    for (const target of neighbors) {
      if (shouldDie()) return;
      if (target === "darkweb") continue;
      if (++targets > MAX_TARGETS) break;

      const rec = ledger.get(target);
      if (rec) await rdConnect(target, rec.password);

      let blocked = await rdGetBlockedRam(target);
      if (!(blocked > 0)) continue;

      ns.print(`[DNET-OPS] realloc ${target} blocked=${blocked.toFixed(2)}GB`);

      for (let i = 0; i < MAX_REALLOC; i++) {
        if (shouldDie()) return;
        const result = await rdMemRealloc(target);
        const done = result?.done === true;
        const freed = result?.ram ?? result?.recoveredRam ?? result?.freedRam ?? "?";
        ns.print(`[DNET-OPS] memoryReallocation(${target}) #${i + 1} done=${done} freed=${freed}`);
        await openLocalCaches();
        if (done) break;

        blocked = await rdGetBlockedRam(target);
        if (!(blocked > 0)) break;
        await ns.sleep(200);
      }
    }
  }

  async function openLocalCaches() {
    let caches = [];
    try { caches = ns.ls(HOST, ".cache"); } catch (e) { ns.print(`[DNET-OPS] ls cache error: ${e}`); return; }

    for (const file of caches) {
      if (shouldDie()) return;
      const result = await rdOpenCache(file);
      ns.tprint(`[DNET-OPS] CACHE ${HOST}/${file}: ${JSON.stringify(result)}`);
      try { ns.rm(file, HOST); } catch (_) {}
    }
  }

  async function doPhish() {
    const result = await rdPhish();
    if (result) ns.print(`[DNET-OPS] phish money=${result.money ?? 0} exp=${result.exp ?? result.xp ?? 0}`);
    else ns.print(`[DNET-OPS] phishingAttack returned null`);
  }

  async function doStormSeed() {
    if (!ns.fileExists("STORM_SEED.exe", HOST)) {
      ns.print(`[DNET-OPS] STORM_SEED.exe not on ${HOST}; skipping`);
      return;
    }
    ns.tprint(`[DNET-OPS] Unleashing STORM_SEED on ${HOST}...`);
    const result = await rdStorm();
    ns.tprint(`[DNET-OPS] STORM_SEED result: ${JSON.stringify(result)}`);
  }

  async function doStasis(link) {
    ns.tprint(`[DNET-OPS] setStasisLink(${link}) on ${HOST}...`);
    const result = await rdStasis(link);
    ns.tprint(`[DNET-OPS] stasis result: ${JSON.stringify(result)}`);
  }

  // ── Ledger helpers ────────────────────────────────────────────────────────

  function readLedger() {
    const out = new Map();
    try {
      const raw = String(ns.read(LEDGER) || "");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [host, password = "", model = "?"] = line.split("|");
        if (host) out.set(host, { password, model });
      }
    } catch (_) {}
    return out;
  }

  async function pullLedgerFromHome() {
    try { if (ns.fileExists(LEDGER, HOME)) await ns.scp(LEDGER, HOST, HOME); }
    catch (e) { ns.print(`[DNET-OPS] ledger pull failed: ${e}`); }
  }

  function shouldDie() {
    const v = ns.peek(KILL_PORT);
    return typeof v === "string" && v.startsWith(KILL_PREFIX);
  }
}

// ── Module helpers ────────────────────────────────────────────────────────────

function dirname(file) {
  const idx = String(file).lastIndexOf("/");
  return idx <= 0 ? "" : file.slice(0, idx);
}

function hasArg(ns, ...names) {
  return names.some(n => ns.args.includes(n));
}

function getFlagNumber(ns, names, fallback = 0) {
  for (const name of names) {
    const idx = ns.args.indexOf(name);
    if (idx >= 0) {
      const v = Number(ns.args[idx + 1]);
      if (Number.isFinite(v) && v >= 0) return v;
    }
  }
  return fallback;
}

export function autocomplete() {
  return [
    "--open-caches", "--realloc", "--phish", "--stormseed",
    "--stasis", "--tail", "--rd-timeout", "--keep-rd", "--targets",
  ];
}
