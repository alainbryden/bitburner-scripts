// /darkweb/dnet-crawl.js — darknet resident agent
// Spreads across the darknet, cracks servers (simple models inline, hard via
// dnet-crack.js), records topology, maintains cache/RAM via dnet-ops.js.
// ALL ns.dnet.* calls routed through rd() temp scripts.
// In-game RAM: ~3-4 GB.
//
// Usage:
//   run /darkweb/dnet-crawl.js [--tail] [--loop 30000] [--maint-ms 120000]
//   run /darkweb/dnet-crawl.js --no-maint --no-spread --tail

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const HOST = ns.getHostname();
  const HOME = "home";
  const SELF = ns.getScriptName();
  const DIR = dirname(SELF);
  const path = name => DIR ? `${DIR}/${name}` : name;

  const LEDGER   = "/darkweb/dnet-passwords.txt";
  const MAP_FILE = "/darkweb/dnet-map.txt";
  const OPS      = path("dnet-ops.js");
  const CRACK    = path("dnet-crack.js");

  const KILL_PORT   = getFlagNumber(ns, ["--kill-port"], 20);
  const CMD_PORT    = getFlagNumber(ns, ["--cmd-port"],  21);
  const KILL_PREFIX = "DNET_KILL|";
  const CMD_PREFIX  = "DNET_CMD|";

  const LOOP_MS       = getFlagNumber(ns, ["--loop"],     30_000);
  const MAINT_MS      = getFlagNumber(ns, ["--maint-ms"], 120_000);
  const RD_TIMEOUT_MS = getFlagNumber(ns, ["--rd-timeout"], 8_000);
  const MAX_SPREAD    = getFlagNumber(ns, ["--max-spread"], 200);
  const KEEP_RD       = hasArg(ns, "--keep-rd");
  const NO_MAINT      = hasArg(ns, "--no-maint");
  const NO_SPREAD     = hasArg(ns, "--no-spread");
  const NO_SIMPLE     = hasArg(ns, "--no-simple");
  const COPY_HOME     = hasArg(ns, "--copy-home") || HOST !== HOME;
  const DOCTOR        = hasArg(ns, "--doctor");

  if (hasArg(ns, "--tail")) {
    try { ns.ui.openTail(); } catch (_) {}
  }

  if (DOCTOR) {
    doctorCheck();
    return;
  }

  ns.print(`[DNET-CRAWL] Started on ${HOST} loop=${LOOP_MS}ms maint=${MAINT_MS}ms`);

  let lastMaint = 0;
  let spreadCount = 0;
  const crackedThisSession = new Set();
  const failedThisSession  = new Set();
  const sentToCracker      = new Set();

  // Initial maintenance before main loop
  if (!NO_MAINT) {
    try {
      const pid = ns.exec(OPS, HOST, { preventDuplicates: true }, "--realloc", "--open-caches");
      if (pid) ns.print(`[DNET-CRAWL] Launched ${OPS} --realloc --open-caches pid=${pid}`);
    } catch (_) {}
    lastMaint = Date.now();
  }

  // Main loop
  while (true) {
    if (shouldDie()) {
      ns.print(`[DNET-CRAWL] Kill signal received on port ${KILL_PORT}. Exiting.`);
      return;
    }

    await handleCommandBus();

    // Probe neighbors
    const neighbors = await rd("probe", `ns.dnet.probe()`, []) ?? [];
    if (neighbors.length === 0) {
      ns.print(`[DNET-CRAWL] No neighbors found; sleeping ${LOOP_MS}ms`);
      await ns.sleep(LOOP_MS);
      continue;
    }

    // Batch-fetch server details
    const detailsMap = await batchDetails(neighbors);

    // Process each neighbor
    for (const target of neighbors) {
      if (shouldDie()) break;
      if (crackedThisSession.has(target)) continue;

      const det = detailsMap[target];
      if (!det) continue;

      // Already have a session — just spread if not yet done
      if (det.hasSession) {
        crackedThisSession.add(target);
        if (!NO_SPREAD) await spreadTo(target);
        continue;
      }

      // Check ledger first — reconnect if we know the password
      const ledger = readLedger();
      const rec = ledger.get(target);
      if (rec?.password !== undefined) {
        const ok = await rdConnect(target, rec.password);
        if (ok?.success || ok?.session) {
          ns.print(`[DNET-CRAWL] Reconnected ${target} via ledger`);
          crackedThisSession.add(target);
          if (!NO_SPREAD) await spreadTo(target);
          continue;
        }
      }

      if (failedThisSession.has(target)) continue;

      const model = det.modelId ?? det.model ?? "?";
      const pw = NO_SIMPLE ? null : await tryCrackSimple(target, det, model);

      if (pw !== null && pw !== undefined) {
        const session = await rdConnect(target, pw);
        if (session?.success || session?.session) {
          ns.print(`[DNET-CRAWL] [CRACKED] ${target} model=${model} pw="${pw}"`);
          crackedThisSession.add(target);
          await recordPassword(target, pw, model);
          if (!NO_SPREAD) await spreadTo(target);
          continue;
        }
      }

      // Delegate to dnet-crack.js for hard models
      if (!sentToCracker.has(target)) {
        const modelId = det.modelId ?? "";
        if (!isSimpleModel(modelId)) {
          await sendToCracker(target);
          sentToCracker.add(target);
        }
      }
    }

    // Record topology
    updateMap(neighbors, detailsMap);
    if (COPY_HOME && HOST !== HOME) {
      try { await ns.scp(MAP_FILE, HOME, HOST); } catch (_) {}
    }

    // Periodic maintenance
    if (!NO_MAINT && Date.now() - lastMaint >= MAINT_MS) {
      try {
        const pid = ns.exec(OPS, HOST, { preventDuplicates: true }, "--realloc", "--open-caches");
        if (pid) ns.print(`[DNET-CRAWL] Maintenance ${OPS} pid=${pid}`);
      } catch (_) {}
      lastMaint = Date.now();
    }

    await ns.sleep(LOOP_MS);
  }

  // ── rd() RAM-dodge engine ───────────────────────────────────────────────────

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

  // ── dnet API helpers ────────────────────────────────────────────────────────

  async function batchDetails(hosts) {
    if (!hosts.length) return {};
    const expr = `(async()=>{
      const out={};
      for(const h of args){
        try{ out[h]=await ns.dnet.getServerDetails(h); }catch(_){ out[h]=null; }
      }
      return out;
    })()`;
    const result = await rd("details", expr, hosts, RD_TIMEOUT_MS * hosts.length);
    return result ?? {};
  }

  async function rdAuth(target, pw) {
    return rd("auth", `ns.dnet.authenticate(args[0],args[1])`, [target, pw]);
  }

  async function rdConnect(target, pw) {
    return rd("session", `ns.dnet.connectToSession(args[0],args[1])`, [target, pw]);
  }

  async function rdStorm(target) {
    return rd("storm", `ns.dnet.unleashStormSeed()`, []);
  }

  async function rdStasis(link) {
    return rd("stasis", `ns.dnet.setStasisLink(args[0])`, [link], 45_000);
  }

  async function rdBackdoor(target) {
    return rd("backdoor", `ns.dnet.backdoor(args[0])`, [target], 30_000);
  }

  // ── Simple inline crackers ──────────────────────────────────────────────────

  const DEFAULTS         = ["admin","password","0000","12345"];
  const DOGS             = ["fido","spot","rover","max"];
  const EU_COUNTRIES     = [
    "Austria","Belgium","Bulgaria","Croatia","Republic of Cyprus","Czech Republic",
    "Denmark","Estonia","Finland","France","Germany","Greece","Hungary","Ireland",
    "Italy","Latvia","Lithuania","Luxembourg","Malta","Netherlands","Poland",
    "Portugal","Romania","Slovakia","Slovenia","Spain","Sweden",
  ];
  const COMMON_PASSWORDS = [
    "123456","password","123456789","12345678","12345","1234567","1234567890",
    "qwerty","abc123","111111","123123","admin","letmein","welcome","monkey",
    "dragon","master","shadow","qwerty123","1q2w3e4r","sunshine","princess",
    "solo","1234","iloveyou","654321","superman","batman","trustno1","hello",
    "freedom","michael","jessica","jesus","password1","ninja","mustang",
    "access","test","baseball","soccer","hockey","dallas","yankees","robert",
    "thomas","jordan","harley","ranger","daniel","andrew","andrea","joshua",
    "george","hunter","buster","cookie","charlie","samantha","jessica","fuckyou",
    "pepper","cheese","butter","summer","winter","spring","football","baseball",
    "ginger","bailey","flower","rabbit","soccer","hockey","golfer","player",
    "pass","asdf","zxcvbn","qwertyuiop","azerty","qweasdzxc","1qaz2wsx",
    "abcdef","aaaaaa","000000","696969","123321","222222","999999","888888",
    "7777777","1111111",
  ];

  function isSimpleModel(modelId) {
    return [
      "ZeroLogon","NoPassword",
      "DeskMemo_3.1","EchoVuln",
      "FreshInstall_1.0","DefaultPassword",
      "CloudBlare(tm)","Captcha",
      "Laika4","DogNames",
      "BellaCuore","RomanNumeral",
      "Pr0verFl0","BufferOverflow",
    ].includes(modelId);
  }

  async function tryCrackSimple(target, det, model) {
    switch (model) {
      case "ZeroLogon": case "NoPassword":
        return await tryPw(target, "");

      case "DeskMemo_3.1": case "EchoVuln":
        return await crackEcho(target, det);

      case "FreshInstall_1.0": case "DefaultPassword":
        return await tryCandidates(target, DEFAULTS);

      case "CloudBlare(tm)": case "Captcha":
        return await crackCaptcha(target, det);

      case "Laika4": case "DogNames":
        return await tryCandidates(target, DOGS);

      case "BellaCuore": case "RomanNumeral":
        if ((det.difficulty ?? 99) < 8) return await crackRomanSimple(target, det);
        return null; // complex range case → delegate to dnet-crack.js

      case "Pr0verFl0": case "BufferOverflow":
        return await crackBufferOverflow(target, det);

      default:
        return null;
    }
  }

  async function tryPw(target, pw) {
    const r = await rdAuth(target, pw);
    if (r?.success) return pw;
    return null;
  }

  async function tryCandidates(target, list) {
    for (const pw of list) {
      const r = await rdAuth(target, pw);
      if (r?.success) return pw;
    }
    return null;
  }

  async function crackEcho(target, det) {
    const raw = String(det.data ?? det.passwordHint ?? "");
    const nums = raw.replace(/[^0-9]/g, "");
    if (!nums) return null;
    return await tryPw(target, nums);
  }

  async function crackCaptcha(target, det) {
    const raw = String(det.data ?? det.passwordHint ?? "");
    const digits = raw.replace(/[^0-9]/g, "");
    if (!digits) return null;
    return await tryPw(target, digits);
  }

  async function crackRomanSimple(target, det) {
    // diff < 8: single Roman numeral → parse to int
    const raw = String(det.data ?? det.passwordHint ?? "");
    const romanMatch = raw.match(/([IVXLCDM]+)/i);
    if (!romanMatch) return null;
    const n = parseRoman(romanMatch[1].toUpperCase());
    if (!n) return null;
    return await tryPw(target, String(n));
  }

  async function crackBufferOverflow(target, det) {
    const passLen = det.passwordLength ?? 4;
    const exploit = "A".repeat(passLen * 2);
    return await tryPw(target, exploit);
  }

  function parseRoman(s) {
    const vals = { I:1, V:5, X:10, L:50, C:100, D:500, M:1000 };
    let total = 0, prev = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      const v = vals[s[i]] ?? 0;
      total += v < prev ? -v : v;
      prev = v;
    }
    return total;
  }

  // ── Command bus ─────────────────────────────────────────────────────────────

  async function handleCommandBus() {
    const raw = ns.peek(CMD_PORT);
    if (typeof raw !== "string" || !raw.startsWith(CMD_PREFIX)) return;

    const rest = raw.slice(CMD_PREFIX.length);
    const [id, expiresAtStr, action, encodedTarget = ""] = rest.split("|");
    const expiresAt = Number(expiresAtStr ?? 0);
    if (Date.now() > expiresAt) return;

    const target = decodeURIComponent(encodedTarget);

    ns.print(`[DNET-CRAWL] CMD id=${id} action=${action} target="${target}"`);

    switch (action) {
      case "stormseed": {
        if (!ns.fileExists("STORM_SEED.exe", HOST)) break;
        const r = await rdStorm();
        ns.tprint(`[DNET-CRAWL] STORM_SEED unleashed: ${JSON.stringify(r)}`);
        break;
      }
      case "stasis": {
        if (!target || target === HOST) {
          const r = await rdStasis(true);
          ns.print(`[DNET-CRAWL] stasis(true): ${JSON.stringify(r)}`);
        }
        break;
      }
      case "unstasis": {
        if (!target || target === HOST) {
          const r = await rdStasis(false);
          ns.print(`[DNET-CRAWL] stasis(false): ${JSON.stringify(r)}`);
        }
        break;
      }
      case "backdoor": {
        if (!target || target === HOST) break;
        const r = await rdBackdoor(target);
        ns.print(`[DNET-CRAWL] backdoor(${target}): ${JSON.stringify(r)}`);
        break;
      }
      case "backdoor-all": {
        const neighbors = await rd("probe", `ns.dnet.probe()`, []) ?? [];
        for (const h of neighbors) {
          const r = await rdBackdoor(h);
          ns.print(`[DNET-CRAWL] backdoor(${h}): ${JSON.stringify(r)}`);
        }
        break;
      }
    }
  }

  // ── Spreading ───────────────────────────────────────────────────────────────

  async function spreadTo(target) {
    if (NO_SPREAD || spreadCount >= MAX_SPREAD) return;
    if (target === HOST || target === HOME) return;

    // Files to copy
    const files = [
      SELF,
      path("dnet-crack.js"),
      path("dnet-ops.js"),
      path("dnet-lab.js"),
      path("dnet-ctl.js"),
      LEDGER,
    ].filter(f => {
      try { return ns.fileExists(f, HOST); } catch (_) { return false; }
    });

    try {
      await ns.scp(files, target, HOST);
    } catch (e) {
      ns.print(`[DNET-CRAWL] scp to ${target} failed: ${e}`);
    }

    try {
      const pid = ns.exec(SELF, target, { preventDuplicates: true },
        "--loop", LOOP_MS, "--maint-ms", MAINT_MS, "--rd-timeout", RD_TIMEOUT_MS);
      if (pid) {
        ns.print(`[DNET-CRAWL] Spread to ${target} pid=${pid}`);
        spreadCount++;
      }
    } catch (e) {
      ns.print(`[DNET-CRAWL] exec on ${target} failed: ${e}`);
    }
  }

  // ── dnet-crack.js delegation ────────────────────────────────────────────────

  async function sendToCracker(target) {
    try {
      const pid = ns.exec(CRACK, HOST, { preventDuplicates: true }, target);
      if (pid) ns.print(`[DNET-CRAWL] Cracker → ${target} pid=${pid}`);
    } catch (e) {
      ns.print(`[DNET-CRAWL] exec crack failed for ${target}: ${e}`);
    }
  }

  // ── Topology map ────────────────────────────────────────────────────────────

  function updateMap(neighbors, detailsMap) {
    try {
      const existing = new Map();
      try {
        const raw = String(ns.read(MAP_FILE) || "");
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const [h] = line.split("|");
          if (h) existing.set(h, line);
        }
      } catch (_) {}

      const ts = Date.now();
      for (const h of neighbors) {
        const det = detailsMap[h];
        const ip = det?.ip ?? "";
        const neighborList = neighbors.filter(n => n !== h).join(",");
        existing.set(h, `${encodeURIComponent(h)}|${encodeURIComponent(ip)}|${ts}|${encodeURIComponent(neighborList)}`);
      }

      const rows = [...existing.values()].sort();
      ns.write(MAP_FILE, rows.join("\n") + "\n", "w");
    } catch (e) {
      ns.print(`[DNET-CRAWL] map update error: ${e}`);
    }
  }

  // ── Ledger ───────────────────────────────────────────────────────────────────

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

  async function recordPassword(host, password, model) {
    const map = readLedger();
    map.set(host, { password: String(password ?? ""), model: String(model ?? "?") });
    const rows = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([h, r]) => `${h}|${r.password}|${r.model}`);
    try {
      await ns.write(LEDGER, rows.join("\n") + "\n", "w");
      if (COPY_HOME && HOST !== HOME) await ns.scp(LEDGER, HOME, HOST);
    } catch (_) {}
  }

  // ── Kill signal ──────────────────────────────────────────────────────────────

  function shouldDie() {
    try {
      const v = ns.peek(KILL_PORT);
      return typeof v === "string" && v.startsWith(KILL_PREFIX);
    } catch (_) { return false; }
  }

  // ── Doctor ───────────────────────────────────────────────────────────────────

  function doctorCheck() {
    const needed = [CRACK, OPS, path("dnet-lab.js"), path("dnet-ctl.js")];
    for (const f of needed) {
      const ok = ns.fileExists(f, HOST);
      ns.tprint(`[DNET-CRAWL] ${ok ? "✓" : "✗"} ${f}`);
    }
    ns.tprint(`[DNET-CRAWL] Running on: ${HOST}`);
    ns.tprint(`[DNET-CRAWL] Ledger: ${ns.fileExists(LEDGER, HOST) ? "present" : "missing"}`);
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
    "--tail", "--loop", "--maint-ms", "--rd-timeout", "--max-spread",
    "--no-maint", "--no-spread", "--no-simple", "--copy-home",
    "--kill-port", "--cmd-port", "--keep-rd", "--doctor",
  ];
}
