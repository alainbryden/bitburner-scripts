// /darkweb/dnet-crack.js — RAM-dodged darknet cracker for all 25 password models
// ZERO direct ns.dnet.* calls in main body — all routed through rd() temp scripts.
// In-game RAM: ~3-4 GB (vs 15+ GB for direct-call approach).
// Source-confirmed model catalog, fixed EU country list, fixed BigMo%od formula.
//
// Usage:
//   run /darkweb/dnet-crack.js <hostname> [--scrape] [--copy-home] [--tail]

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const target = String(ns.args[0] ?? "");
  if (!target || target.startsWith("-")) {
    ns.tprint("Usage: run /darkweb/dnet-crack.js <hostname> [--scrape] [--copy-home] [--tail]");
    return;
  }

  const HOST = ns.getHostname();
  const HOME = "home";
  const SELF = ns.getScriptName();
  const DIR = dirname(SELF);
  const path = name => DIR ? `${DIR}/${name}` : name;

  const CRAWL  = path("dnet-crawl.js");
  const CRACK  = path("dnet-crack.js");
  const OPS    = path("dnet-ops.js");
  const SCRAPE = path("dnet-scrape.js");
  const ROUTE  = path("dnet-route.js");
  const LAB    = path("dnet-lab.js");

  const LEDGER  = "/darkweb/dnet-passwords.txt";
  const MAP     = "/darkweb/dnet-map.txt";
  const UNKNOWN = "/darkweb/dnet-unknown.txt";
  const LOCK    = `${DIR || "/darkweb"}/dnet-crack-lock-${safeFileName(target)}.txt`;
  const LOCK_TTL_MS = 120_000;

  const RD_TIMEOUT_MS = getFlagNumber(ns, ["--rd-timeout"], 8_000);
  const KEEP_RD    = hasArg(ns, "--keep-rd");
  const ENABLE_SCRAPE = hasArg(ns, "--scrape");
  const COPY_HOME  = hasArg(ns, "--copy-home");

  if (hasArg(ns, "--tail")) {
    try { ns.ui.openTail(); } catch (_) {}
  }

  if (!acquireTargetLock()) {
    ns.print(`[DNET-CRACK] Lock exists for ${target}; another cracker is already working it.`);
    return;
  }

  try {
    if (HOST !== HOME) await pullLedgerFromHome();

    // Try existing password from ledger first
    const known = readLedger().get(target);
    if (known) {
      const conn = await rdConnect(target, known.password);
      if (conn?.success || conn === true) {
        ns.print(`[DNET-CRACK] Reused ledger password for ${target}`);
        await spread(target, known.password);
        return;
      }
    }

    // Get server details via rd()
    const details = await rdDetails(target);
    if (!details) {
      ns.print(`[DNET-CRACK] getServerDetails failed for ${target}; may be offline or unreachable`);
      return;
    }
    if (!details.isOnline || !details.isConnectedToCurrentServer) {
      ns.print(`[DNET-CRACK] ${target} offline/not adjacent`);
      return;
    }
    if (details.hasSession) {
      ns.print(`[DNET-CRACK] ${target} already has session`);
      await spread(target, "");
      return;
    }

    const model = String(details.modelId ?? "");
    const len   = Number(details.passwordLength ?? 0);
    const hint  = String(details.passwordHint ?? "");
    const data  = String(details.data ?? details.passwordHintData ?? "");
    const fmt   = String(details.passwordFormat ?? "").toLowerCase();

    ns.print(`[DNET-CRACK] Cracking ${target} model=${model} len=${len || "?"} fmt=${fmt || "?"}`);
    ns.print(`[DNET-CRACK] hint=${JSON.stringify(hint)} data=${JSON.stringify(data).slice(0, 200)}`);

    // Labyrinth — delegate entirely to dnet-lab.js (needs a single-PID session)
    if (model === "(The Labyrinth)") {
      ns.print(`[DNET-CRACK] Delegating labyrinth to ${LAB}`);
      ns.exec(LAB, HOST, { preventDuplicates: true }, target,
        ...(hasArg(ns, "--tail") ? ["--tail"] : []));
      return;
    }

    let result = { success: false };

    switch (model) {
      case "ZeroLogon":
        result = await tryPw(target, "", model); break;
      case "DeskMemo_3.1":
        result = await crackEcho(target, model, len, hint, data); break;
      case "PHP 5.4":
        result = await crackSortedEcho(target, model, len, data, hint); break;
      case "FreshInstall_1.0":
        result = await tryCandidates(target, DEFAULTS, model, len, "default passwords"); break;
      case "CloudBlare":
      case "CloudBlare(tm)":
        result = await crackCaptcha(target, model, len, hint, data); break;
      case "Laika4":
        result = await tryCandidates(target, DOGS, model, len, "dog names"); break;
      case "TopPass":
        result = await tryCandidates(target, COMMON_PASSWORDS, model, len, "common passwords"); break;
      case "EuroZone Free":
        result = await crackEuroZone(target, model, len); break;
      case "BellaCuore":
        result = await crackRoman(target, model, hint, data); break;
      case "PrimeTime 2":
        result = await crackLargestPrime(target, model, hint, data); break;
      case "AccountsManager_4.2":
        result = await crackGuessNumber(target, model, len, hint); break;
      case "110100100":
        result = await crackBinary(target, model, len, hint, data); break;
      case "OrdoXenos":
        result = await crackXor(target, model, len, hint, data); break;
      case "OctantVoxel":
        result = await crackBase10(target, model, hint, data); break;
      case "MathML":
        result = await crackMath(target, model, hint, data); break;
      case "Pr0verFl0":
        result = await crackBufferOverflow(target, model, len, hint); break;
      case "2G_cellular":
        result = await crackTimingAttack(target, model, len, fmt); break;
      case "DeepGreen":
        result = await crackDeepGreen(target, model, len, fmt); break;
      case "NIL":
        result = await crackNil(target, model, len, fmt); break;
      case "Factori-Os":
        result = await crackDivisibility(target, model, len); break;
      case "BigMo%od":
        result = await crackBigMo(target, model, len); break;
      case "OpenWebAccessPoint":
      case "OpenWebAccessPoiont":
        result = await crackOpenWeb(target, model, len, fmt, hint, data); break;
      case "KingOfTheHill":
        result = await crackKingOfTheHill(target, model, len); break;
      case "RateMyPix.Auth":
        result = await crackRateMyPix(target, model, len, fmt, hint, data); break;
      default:
        result = await crackGeneric(target, model, len, hint, data);
    }

    if (!result.success) {
      const hb = await rdHeartbleed(target);
      await dumpUnknown(target, details, hb?.logs ?? []);
      return;
    }

    await recordPassword(target, result.password, model);
    if (HOST !== HOME) await pushLedgerToHome();
    await spread(target, result.password);

  } finally {
    releaseTargetLock();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // rd() RAM-dodge engine — the reason this file is ~3 GB instead of 15+ GB
  // ════════════════════════════════════════════════════════════════════════════

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
      ns.print(`[RD] exec failed ${sf} — not enough free RAM?`);
      if (!KEEP_RD) { try { ns.rm(sf, HOST); } catch (_) {} }
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && ns.isRunning(pid)) await ns.sleep(25);
    if (ns.isRunning(pid)) {
      try { ns.kill(pid); } catch (_) {}
      if (!KEEP_RD) { try { ns.rm(sf, HOST); } catch (_) {} try { ns.rm(of, HOST); } catch (_) {} }
      ns.print(`[RD] timeout ${safeLabel} (${timeoutMs}ms)`);
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

  // ── dnet API wrappers (all via rd()) ──────────────────────────────────────

  // Returns { success, code, message, data } or null
  async function rdRaw(host, pw) {
    return rd("raw", `(async()=>{try{const r=await ns.dnet.authenticate(args[0],args[1]);return{success:!!r?.success,code:r?.code??0,message:String(r?.message??""),data:r?.data??null}}catch(e){return{success:false,error:String(e)}}})()`, [host, pw]);
  }

  async function rdAuth(host, pw) {
    const r = await rdRaw(host, pw);
    if (r?.success) return r;
    return { success: false };
  }

  async function rdHeartbleed(host) {
    const r = await rd("hb", `ns.dnet.heartbleed(args[0],{peek:true})`, [host], RD_TIMEOUT_MS * 2);
    return { logs: r?.logs ?? [] };
  }

  async function rdDetails(host) {
    return rd("details", `ns.dnet.getServerDetails(args[0])`, [host]);
  }

  async function rdConnect(host, pw) {
    return rd("session", `ns.dnet.connectToSession(args[0],args[1])`, [host, pw]);
  }

  // ── Common attempt helpers ─────────────────────────────────────────────────

  async function tryPw(host, pw, model, source = "") {
    const r = await rdAuth(host, String(pw ?? ""));
    if (r?.success) {
      ns.print(`[DNET-CRACK] CRACKED ${host} pw="${pw}" model=${model}${source ? ` via ${source}` : ""}`);
      return { success: true, password: String(pw ?? ""), model };
    }
    return { success: false };
  }

  async function tryCandidates(host, candidates, model, requiredLen, source = "") {
    const list = cleanCandidates(candidates, requiredLen);
    if (list.length) ns.print(`[DNET-CRACK] ${model}: trying ${list.length} candidates${source ? ` (${source})` : ""}`);
    let count = 0;
    for (const pw of list) {
      const r = await tryPw(host, pw, model, source);
      if (r.success) return r;
      if (++count % 250 === 0) await ns.sleep(0);
    }
    return { success: false };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Model solvers
  // ════════════════════════════════════════════════════════════════════════════

  // ZeroLogon — NoPassword: password is always ""
  // (handled inline above as tryPw(target, ""))

  // DeskMemo_3.1 — EchoVuln: password is getPassword(3), shown plainly in hint
  async function crackEcho(host, model, len, hint, data) {
    const candidates = [...extractNumbers(hint), ...extractNumbers(data)];
    if (len) { candidates.push(hint.slice(-len), data.slice(-len)); }
    return tryCandidates(host, candidates, model, len, "echo hint");
  }

  // PHP 5.4 — SortedEchoVuln: sorted digits of password are in hint/data
  async function crackSortedEcho(host, model, len, data, hint) {
    const sorted = (data || extractNumbers(hint).sort((a, b) => b.length - a.length)[0] || "")
      .replace(/[^0-9]/g, "");
    if (!sorted) return { success: false };
    const passLen = len || sorted.length;
    ns.print(`[DNET-CRACK] PHP 5.4 sorted="${sorted}" len=${passLen}`);
    let count = 0;
    for (const p of uniquePermutations(sorted, 500_000)) {
      if (p.length !== passLen) continue;
      if (p.length > 1 && p.startsWith("0")) continue;
      const r = await tryPw(host, p, model, "sorted permutation");
      if (r.success) return r;
      if (++count % 250 === 0) await ns.sleep(0);
    }
    ns.print(`[DNET-CRACK] PHP 5.4 exhausted ${count} permutations`);
    return { success: false };
  }

  // CloudBlare(tm) — Captcha: numeric password, digits appear in data (filler chars stripped)
  async function crackCaptcha(host, model, len, hint, data) {
    const candidates = [digitsOnly(data, len), digitsOnly(hint, len),
      ...extractNumbers(data), ...extractNumbers(hint)];
    return tryCandidates(host, candidates, model, len || undefined, "captcha digits");
  }

  // EuroZone Free — EUCountryDictionary: exact country name from source list
  // FIXED: "Republic of Cyprus" (not "Cyprus"), "Czech Republic" (not "Czechia"),
  //        "Netherlands" (not "The Netherlands") — source-exact from dictionaryData.ts
  async function crackEuroZone(host, model, len) {
    const all = [];
    for (const country of EU_COUNTRIES) all.push(...countryVariants(country));
    const passLen = Number(len || 0);
    const byLen  = passLen > 0 ? all.filter(p => p.length === passLen) : [];
    const rest   = passLen > 0 ? all.filter(p => !byLen.includes(p)) : all;
    ns.print(`[DNET-CRACK] EuroZone: ${byLen.length} length-match + ${rest.length} fallback`);
    const r = await tryCandidates(host, byLen, model, undefined, "EU length-match");
    if (r.success) return r;
    return tryCandidates(host, rest, model, undefined, "EU full list");
  }

  // BellaCuore — RomanNumeral: diff<8: single Roman numeral; diff≥8: range with feedback
  // Feedback: "PARUM BREVIS" = too low, "ALTUS NIMIS" = too high
  async function crackRoman(host, model, hint, data) {
    const text = `${hint}\n${data}`;
    const pair = parseRomanRange(text);

    if (pair) {
      const lo0 = Math.max(0, Math.min(pair[0], pair[1]));
      const hi0 = Math.max(pair[0], pair[1]);
      let lo = lo0, hi = hi0;
      const tried = new Set();
      ns.print(`[DNET-CRACK] BellaCuore binary search ${lo0}..${hi0}`);

      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        tried.add(String(mid));
        const raw = await rdRaw(host, String(mid));
        if (raw?.success) return { success: true, password: String(mid), model };
        const fb = parseBellaFeedback(raw);
        ns.print(`[DNET-CRACK] BellaCuore ${mid} → ${fb || "?"}`);
        if (fb === "low")  lo = mid + 1;
        else if (fb === "high") hi = mid - 1;
        else break;
        await ns.sleep(0);
      }
      // Sweep narrowed window then full range as fallback
      for (let n = Math.max(lo0, lo - 3); n <= Math.min(hi0, hi + 3); n++) {
        if (tried.has(String(n))) continue;
        const r = await tryPw(host, String(n), model, "roman binary final");
        if (r.success) return r;
      }
      for (let n = lo0; n <= hi0; n++) {
        if (tried.has(String(n))) continue;
        const r = await tryPw(host, String(n), model, "roman range sweep");
        if (r.success) return r;
        if (n % 250 === 0) await ns.sleep(0);
      }
      return { success: false };
    }

    for (const token of extractRomanTokens(text)) {
      const value = romanToInt(token);
      if (value === null) continue;
      const r = await tryPw(host, String(value), model, "roman direct");
      if (r.success) return r;
    }
    return { success: false };
  }

  // PrimeTime 2 — LargestPrimeFactor: find largest prime factor of number in hint/data
  async function crackLargestPrime(host, model, hint, data) {
    const nums = extractNumbers(`${data}\n${hint}`).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
    for (const n of nums) {
      const factor = largestPrimeFactor(n);
      if (!factor) continue;
      const r = await tryPw(host, String(factor), model, `largest prime of ${n}`);
      if (r.success) return r;
    }
    return { success: false };
  }

  // AccountsManager_4.2 — GuessNumber: binary search with "Higher"/"Lower" feedback
  async function crackGuessNumber(host, model, len, hint) {
    const maxFromHint = Number((hint.match(/between\s+0\s+and\s+(\d+)/i) ?? [])[1]);
    const max = Number.isFinite(maxFromHint) && maxFromHint > 0
      ? maxFromHint
      : 10 ** Math.max(1, len || 3);
    const cap = Math.min(max, 1_000_000);
    ns.print(`[DNET-CRACK] GuessNumber range [0, ${cap}]`);
    // Binary search using feedback
    let lo = 0, hi = cap;
    const tried = new Set();
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      tried.add(String(mid));
      const raw = await rdRaw(host, String(mid));
      if (raw?.success) return { success: true, password: String(mid), model };
      const fb = String(raw?.message ?? "").toLowerCase();
      if (fb.includes("higher")) lo = mid + 1;
      else if (fb.includes("lower")) hi = mid - 1;
      else break; // fallback: linear scan
      await ns.sleep(0);
    }
    // Linear sweep for any remaining numbers
    for (let n = 0; n < cap; n++) {
      if (tried.has(String(n))) continue;
      const r = await tryPw(host, String(n), model, "linear");
      if (r.success) return r;
      if (n % 250 === 0) await ns.sleep(0);
    }
    return { success: false };
  }

  // 110100100 — BinaryEncodedFeedback: 8-bit groups in data decode to ASCII
  async function crackBinary(host, model, len, hint, data) {
    const chunks = [...String(data || hint).matchAll(/\b[01]{8}\b/g)].map(m => m[0]);
    if (!chunks.length) return { success: false };
    const pw = chunks.map(b => String.fromCharCode(parseInt(b, 2))).join("");
    return tryCandidates(host, [pw], model, len, "binary decode");
  }

  // OrdoXenos — encryptedPassword: XOR each char against bitmask list
  async function crackXor(host, model, len, hint, data) {
    let payload = data;
    if (!payload) {
      const m = hint.match(/"([\s\S]*)".*?([01]{8}(?:\s+[01]{8})*)/);
      if (m) payload = `${m[1]};${m[2]}`;
    }
    const [encoded, masksRaw] = String(payload).split(";");
    if (!encoded || !masksRaw) return { success: false };
    const masks = masksRaw.trim().split(/\s+/).map(b => parseInt(b, 2)).filter(Number.isFinite);
    const pw = [...encoded].slice(0, masks.length)
      .map((ch, i) => String.fromCharCode(ch.charCodeAt(0) ^ masks[i])).join("");
    return tryCandidates(host, [pw], model, len, "xor decode");
  }

  // OctantVoxel — ConvertToBase10: decimal encoded in base N
  async function crackBase10(host, model, hint, data) {
    const parsed = parseBaseData(data) ?? parseBaseData(hint);
    if (!parsed) return { success: false };
    const [base, encoded] = parsed;
    const value = parseBaseN(encoded, base);
    if (!Number.isFinite(value)) return { success: false };
    const candidates = [Math.round(value), Math.floor(value), Math.ceil(value)].map(String);
    return tryCandidates(host, candidates, model, undefined, `base ${base} decode`);
  }

  // MathML — parsedExpression: evaluate arithmetic expression
  // WARNING: source can embed "ns.exit()," injection — cleanArithmetic strips it
  async function crackMath(host, model, hint, data) {
    const expr = data || hint.replace(/^.*?expression\b/i, "");
    const value = parseSimpleArithmetic(cleanArithmetic(expr));
    if (!Number.isFinite(value)) return { success: false };
    const candidates = [String(value), String(Math.round(value)),
      String(Math.floor(value)), String(Math.ceil(value))];
    return tryCandidates(host, candidates, model, undefined, "math eval");
  }

  // Pr0verFl0 — BufferOverflow: source-confirmed exploit
  // buffer = "ˍ".repeat(passLen) + "■".repeat(passLen)
  // overwritten = attempt + buffer.slice(attempt.length)
  // success: overwritten.slice(0,passLen) === overwritten.slice(passLen)
  // → sending "A".repeat(passLen*2) makes both halves identical → SUCCESS
  async function crackBufferOverflow(host, model, len, hint) {
    const bufferSize = Number((hint.match(/buffer\s+(?:is\s+)?(\d+)\s*(?:bytes)?/i) ?? [])[1])
      || Number(len) || 4;
    const payloadLen = bufferSize * 2;
    ns.print(`[DNET-CRACK] Pr0verFl0 bufferSize=${bufferSize} payloadLen=${payloadLen}`);
    // Primary: repeat any single char to fill both halves identically
    const payloads = [
      "A".repeat(payloadLen), "a".repeat(payloadLen),
      "0".repeat(payloadLen), "x".repeat(payloadLen),
      "A".repeat(bufferSize + 1), "0".repeat(bufferSize + 1),
    ];
    return tryCandidates(host, payloads, model, undefined, "buffer overflow");
  }

  // 2G_cellular — TimingAttack: each correct prefix char adds 50ms to response time
  // Timing measured INSIDE the temp script to avoid exec overhead variance
  async function crackTimingAttack(host, model, len, fmt) {
    const n = len || 6;
    if (n > 12) { ns.print(`[DNET-CRACK] 2G_cellular len=${n} too large`); return { success: false }; }
    const charset = getCharset(fmt || (n > 6 ? "alphanumeric" : "numeric"), true);
    let prefix = "";
    ns.print(`[DNET-CRACK] 2G_cellular timing len=${n} charset=${charset.length}`);

    // Each position: probe all chars inside a single temp script (eliminates exec overhead)
    for (let pos = 0; pos < n; pos++) {
      const timingExpr = `(async()=>{
  const host=args[0]; const prefix=args[1]; const charset=[...args[2]]; const n=args[3]; const fillChar=charset[0];
  let best={ch:charset[0],ms:-1};
  for(const ch of charset){
    const guess=(prefix+ch).padEnd(n,fillChar);
    const t0=Date.now();
    const r=await ns.dnet.authenticate(host,guess);
    const ms=Date.now()-t0;
    if(r?.success) return{success:true,pw:guess};
    if(ms>best.ms) best={ch,ms};
  }
  return{success:false,bestChar:best.ch,bestMs:best.ms};
})()`;
      const r = await rd("timing", timingExpr, [host, prefix, charset, n], RD_TIMEOUT_MS * 5);
      if (!r) { ns.print(`[DNET-CRACK] 2G timing probe failed at pos ${pos}`); return { success: false }; }
      if (r.success) return { success: true, password: r.pw, model };
      prefix += r.bestChar;
      ns.print(`[DNET-CRACK] 2G_cellular prefix="${prefix}" (${r.bestMs?.toFixed(0)}ms at pos ${pos})`);
    }
    return tryPw(host, prefix, model, "2G timing final");
  }

  // DeepGreen — MastermindHint: filter pool by exact/misplaced counts per attempt
  async function crackDeepGreen(host, model, len, fmt) {
    const n = len || 3;
    const charset = getCharset(fmt || "numeric", false);
    const maxPool = 100_000;
    let pool = generateCandidates(charset, n, fmt || "numeric");
    if (!pool.length || pool.length > maxPool) {
      ns.print(`[DNET-CRACK] DeepGreen pool too large len=${n} fmt=${fmt} count=${pool.length}`);
      return { success: false };
    }
    const tried = new Set();
    ns.print(`[DNET-CRACK] DeepGreen len=${n} fmt=${fmt} pool=${pool.length}`);

    // Warm up with probe patterns
    for (const ch of [...charset].slice(0, Math.min(charset.length, 10))) {
      if (pool.length <= 1) break;
      const guess = ch.repeat(n);
      if (tried.has(guess)) continue;
      const { r, fb } = await deepGreenAttempt(host, guess, model);
      tried.add(guess);
      if (r?.success) return { success: true, password: guess, model };
      if (fb) {
        pool = pool.filter(c => sameMastermind(c, guess, fb));
        ns.print(`[DNET-CRACK] DG ${guess} → ${fb.exact},${fb.misplaced}; pool=${pool.length}`);
      }
      if (pool.length === 1 && !tried.has(pool[0])) break;
      await ns.sleep(0);
    }

    while (pool.length) {
      const guess = pool.find(c => !tried.has(c));
      if (!guess) break;
      const { r, fb } = await deepGreenAttempt(host, guess, model);
      tried.add(guess);
      if (r?.success) return { success: true, password: guess, model };
      if (!fb) return { success: false };
      pool = pool.filter(c => sameMastermind(c, guess, fb));
      ns.print(`[DNET-CRACK] DG ${guess} → ${fb.exact},${fb.misplaced}; pool=${pool.length}`);
      if (pool.length === 1 && !tried.has(pool[0])) {
        return tryPw(host, pool[0], model, "DeepGreen final");
      }
      if (tried.size % 25 === 0) await ns.sleep(0);
    }
    return { success: false };
  }

  async function deepGreenAttempt(host, guess, model) {
    const raw = await rdRaw(host, guess);
    if (raw?.success) return { r: raw, fb: null };
    const fb = parseDeepGreenFeedback(raw);
    return { r: raw, fb };
  }

  // NIL — Yesn't: per-position yes/yesn't feedback; elimination matrix
  async function crackNil(host, model, len, fmt) {
    const n = len || 4;
    const chars = [...getCharset(fmt || "numeric", true)];
    const pos = Array.from({ length: n }, () => new Set(chars));
    const tried = new Set();
    const obs = [];

    const known = () => pos.map(s => s.size === 1 ? [...s][0] : null);
    const solved = () => pos.every(s => s.size === 1);

    ns.print(`[DNET-CRACK] NIL len=${n} fmt=${fmt} charset=${chars.length}`);

    // Phase 1: probe each char across all positions
    for (const ch of chars) {
      if (solved()) break;
      const k = known();
      const guess = k.map((v, i) => v ?? (pos[i].has(ch) ? ch : [...pos[i]][0])).join("");
      if (tried.has(guess)) { await ns.sleep(0); continue; }

      const raw = await rdRaw(host, guess);
      tried.add(guess);
      if (raw?.success) return { success: true, password: guess, model };

      const mask = parseNilMask(raw, n);
      if (!mask) { await ns.sleep(0); continue; }
      obs.push({ guess, mask });

      for (let i = 0; i < n; i++) {
        if (mask[i] === "yes") { pos[i] = new Set([guess[i]]); }
        else { pos[i].delete(guess[i]); }
      }
      ns.print(`[DNET-CRACK] NIL ${guess} → ${mask.join(",")} | ${known().map(v => v ?? "_").join("")}`);
      await ns.sleep(0);
    }

    if (solved()) {
      const final = known().join("");
      if (!tried.has(final)) return tryPw(host, final, model, "NIL solved");
      return { success: false };
    }

    // Phase 2: constraint search for residual unknowns
    const unknownIdx = known().reduce((a, v, i) => (v === null && a.push(i), a), []);
    const kArr = known();
    const fill = combo => kArr.map((v, i) => {
      const ui = unknownIdx.indexOf(i);
      return ui >= 0 ? combo[ui] : v;
    }).join("");

    let pool = cartesianProduct(unknownIdx.map(i => [...pos[i]]))
      .filter(c => obs.every(o => matchesYesnt(fill(c), o.guess, o.mask)));

    ns.print(`[DNET-CRACK] NIL phase-2 unknowns=${unknownIdx.length} pool=${pool.length}`);
    if (pool.length > 100_000) return { success: false };

    while (pool.length) {
      const combo = pool.find(c => !tried.has(fill(c)));
      if (!combo) break;
      const guess = fill(combo);
      const raw = await rdRaw(host, guess);
      tried.add(guess);
      if (raw?.success) return { success: true, password: guess, model };
      const mask = parseNilMask(raw, n);
      if (!mask) break;
      pool = pool.filter(c => matchesYesnt(fill(c), guess, mask));
      if (pool.length === 1 && !tried.has(fill(pool[0])))
        return tryPw(host, fill(pool[0]), model, "NIL p2 final");
      if (tried.size % 25 === 0) await ns.sleep(0);
    }
    return { success: false };
  }

  // Factori-Os — divisibilityTest: password is product of primes, brute respecting length
  async function crackDivisibility(host, model, len) {
    const passLen = Number(len || 0);
    const start = passLen > 1 ? 10 ** (passLen - 1) : 0;
    const end   = passLen > 0 ? 10 ** passLen : 100_000;
    if (end - start > 1_000_000) {
      ns.print(`[DNET-CRACK] Factori-Os range too large: [${start},${end - 1}]`);
      return { success: false };
    }
    ns.print(`[DNET-CRACK] Factori-Os brute [${start},${end - 1}]`);
    for (let n = start; n < end; n++) {
      const pw = String(n);
      if (passLen > 0 && pw.length !== passLen) continue;
      const r = await tryPw(host, pw, model, "numeric brute");
      if (r.success) return r;
      if ((n - start) % 250 === 0) await ns.sleep(0);
    }
    return { success: false };
  }

  // BigMo%od — tripleModulo: source-confirmed formula (P%n)%((n-1)%32+1)=r
  // FIXED from existing script which used wrong formula c.n%32 instead of ((c.n-1)%32)+1
  async function crackBigMo(host, model, len) {
    const passLen = Number(len || 0);
    const lo = passLen > 1 ? 10 ** (passLen - 1) : 0;
    const hi = passLen > 0 ? 10 ** passLen - 1 : 999_999;
    const maxTry = 20_000;
    const constraints = [];
    const triedProbes = new Set();

    function addConstraint(c) {
      if (!c || !Number.isFinite(c.n) || !Number.isFinite(c.r)) return;
      if (c.n <= 1) return;
      const m = ((c.n - 1) % 32) + 1; // source-exact formula
      if (m <= 1) return;
      if (constraints.some(x => x.n === c.n)) return;
      constraints.push({ n: c.n, m, r: c.r });
      ns.print(`[DNET-CRACK] BigMo constraint ${c.n}: (P%${c.n})%${m}=${c.r}`);
    }

    async function probe(n) {
      if (triedProbes.has(n)) return null;
      triedProbes.add(n);
      const raw = await rdRaw(host, String(n));
      if (raw?.success) return { done: true, password: String(n) };
      addConstraint(parseBigMoResponse(raw, n));
      return null;
    }

    ns.print(`[DNET-CRACK] BigMo len=${passLen || "?"} range=[${lo},${hi}]`);

    // Seed from heartbleed logs
    const hb = await rdHeartbleed(host);
    for (const c of parseBigMoHeartbleed(hb.logs ?? [])) addConstraint(c);

    // Probe plan: values where (n-1)%32 > 1 (gives useful modulus)
    const probePlan = [257,259,261,263,265,269,271,277,281,283,293,307,311,313,317,331,337,347,349,353,359,367,373,379,383,389,397,401,409,419,421,431,433,439,443,449,457,461,463,467,479,487,491,499]
      .filter(n => ((n - 1) % 32) + 1 > 1);

    for (const n of probePlan) {
      const r = await probe(n);
      if (r?.done) return { success: true, password: r.password, model };
      if (constraints.length >= 6) break;
      await ns.sleep(0);
    }

    if (hi - lo + 1 > 12_000_000) {
      ns.print(`[DNET-CRACK] BigMo range too large for scan`);
      return { success: false };
    }

    let candidates = collectBigMoCandidates(lo, hi, passLen, constraints, maxTry + 1);
    ns.print(`[DNET-CRACK] BigMo candidates after ${constraints.length} constraints: ${candidates.length}${candidates.length > maxTry ? "+" : ""}`);

    for (const n of probePlan) {
      if (candidates.length <= maxTry) break;
      const r = await probe(n);
      if (r?.done) return { success: true, password: r.password, model };
      candidates = collectBigMoCandidates(lo, hi, passLen, constraints, maxTry + 1);
      ns.print(`[DNET-CRACK] BigMo narrowed to ${candidates.length}`);
      await ns.sleep(0);
    }

    if (!candidates.length || candidates.length > maxTry) return { success: false };
    return tryCandidates(host, candidates, model, passLen || undefined, "BigMo constrained");
  }

  // OpenWebAccessPoint — packetSniffer: heartbleed logs contain "Logging in with passcode: PW"
  async function crackOpenWeb(host, model, len, fmt, hint, data) {
    const n = Number(len || 0);
    const hb = await rdHeartbleed(host);
    const logLines = hb.logs ?? [];
    const allText = [hint, data, ...logLines].join("\n");

    const priority = [];
    for (const m of allText.matchAll(/Logging in with passcode:\s*(\S+?)(?:\s|\.{3}|$)/gi))
      priority.push(m[1]);
    const hostRe = new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":([\\w]+)", "g");
    for (const m of allText.matchAll(hostRe)) priority.push(m[1]);

    const clean = [...new Set(priority)].filter(p => !n || p.length === n);
    if (clean.length) {
      const r = await tryCandidates(host, clean, model, undefined, "heartbleed direct");
      if (r.success) return r;
    }

    const nums = [...new Set(extractNumbers(allText))].filter(p => !n || p.length === n);
    if (nums.length) {
      const r = await tryCandidates(host, nums, model, undefined, "text numbers");
      if (r.success) return r;
    }

    const staticCandidates = ["", ...DEFAULTS, ...DOGS, ...hostDerivedCandidates(host, n)];
    return tryCandidates(host, staticCandidates, model, undefined, "static/derived");
  }

  // KingOfTheHill — globalMaxima: Gaussian altitude; ternary search or gradient ascent (SF15 only)
  // f(x) = 10000 * exp(-k * (x-password)^2), success when altitude = 10000
  async function crackKingOfTheHill(host, model, len) {
    const n = len || 2;
    const lo = n > 1 ? 10 ** (n - 1) : 0;
    const hi = 10 ** n - 1;
    const tried = new Set();
    const altCache = new Map();

    function altitude(raw) {
      if (!raw) return 0;
      if (raw.success) return Infinity;
      const v = Number(raw.data);
      if (Number.isFinite(v) && v >= 0) return v;
      const m = String(raw.message ?? "").match(/altitude.*?([\d.]+)/i);
      return m ? Number(m[1]) : 0;
    }

    async function sampleAlt(g) {
      const pw = String(g);
      if (altCache.has(pw)) return altCache.get(pw);
      tried.add(pw);
      const raw = await rdRaw(host, pw);
      const alt = altitude(raw);
      altCache.set(pw, { alt, success: !!raw?.success });
      return altCache.get(pw);
    }

    async function tryKotH(pw) {
      if (!pw || pw.length !== n || (n > 1 && pw.startsWith("0")) || tried.has(pw)) return null;
      return tryPw(host, pw, model, "KotH");
    }

    ns.print(`[DNET-CRACK] KotH len=${n} range=[${lo},${hi}]`);

    // Heartbleed: extract previous altitude attempts and focus near best
    const hb = await rdHeartbleed(host);
    const records = parseKotHHeartbleed(hb.logs ?? [], n)
      .filter(r => r.attempt >= lo && r.attempt <= hi)
      .sort((a, b) => b.alt - a.alt);

    if (records.length) {
      const priority = [];
      for (const rec of records.slice(0, 8)) {
        priority.push(rec.password);
        priority.push(...neighborStrings(rec.attempt, n, lo, hi, 3));
        if (n <= 6) priority.push(...uniquePermutationsArray(rec.password, 720));
      }
      for (const pw of uniqueStrings(priority)) {
        const r = await tryKotH(pw);
        if (r?.success) return r;
      }
    }

    // Ternary search
    const t1 = Math.floor(lo + (hi - lo) / 3);
    const t2 = Math.floor(hi - (hi - lo) / 3);
    const p1 = await sampleAlt(t1);
    const p2 = await sampleAlt(t2);
    if (p1?.success) return { success: true, password: String(t1), model };
    if (p2?.success) return { success: true, password: String(t2), model };

    if (p1?.alt > 0 || p2?.alt > 0) {
      // Wide Gaussian — ternary search
      let [tlo, thi] = [lo, hi];
      while (thi - tlo > 4) {
        const m1 = Math.floor(tlo + (thi - tlo) / 3);
        const m2 = Math.floor(thi - (thi - tlo) / 3);
        const s1 = await sampleAlt(m1); if (s1?.success) return { success: true, password: String(m1), model };
        const s2 = await sampleAlt(m2); if (s2?.success) return { success: true, password: String(m2), model };
        ns.print(`[DNET-CRACK] KotH ternary [${tlo},${thi}] ${m1}→${s1?.alt.toFixed(0)} ${m2}→${s2?.alt.toFixed(0)}`);
        if (s1?.alt >= s2?.alt) thi = m2; else tlo = m1;
        await ns.sleep(0);
      }
      for (let g = tlo - 2; g <= thi + 2; g++) {
        const r = await tryKotH(String(g));
        if (r?.success) return r;
      }
    } else {
      // Narrow Gaussian — step scan + gradient ascent
      let best = lo, bestAlt = 0;
      for (let g = lo; g <= hi; g += 3) {
        const p = await sampleAlt(g);
        if (p?.success) return { success: true, password: String(g), model };
        if (p?.alt > bestAlt) { bestAlt = p.alt; best = g; }
        if (p?.alt > 50) break;
        if (tried.size % 100 === 0) await ns.sleep(0);
      }
      if (!bestAlt) {
        for (let g = hi; g >= lo; g -= 3) {
          const p = await sampleAlt(g);
          if (p?.success) return { success: true, password: String(g), model };
          if (p?.alt > bestAlt) { bestAlt = p.alt; best = g; }
          if (p?.alt > 50) break;
          if (tried.size % 100 === 0) await ns.sleep(0);
        }
      }
      if (!bestAlt) return { success: false };
      let cur = best, curAlt = bestAlt;
      ns.print(`[DNET-CRACK] KotH ascending from ${cur} (${curAlt.toFixed(0)}m)`);
      while (true) {
        let nextBest = null;
        for (const delta of [1, -1]) {
          const next = cur + delta;
          if (next < lo || next > hi) continue;
          const p = await sampleAlt(next);
          if (p?.success) return { success: true, password: String(next), model };
          if (p?.alt > curAlt && (!nextBest || p.alt > nextBest.alt)) nextBest = { v: next, alt: p.alt };
        }
        if (!nextBest) break;
        cur = nextBest.v; curAlt = nextBest.alt;
        await ns.sleep(0);
      }
      if (n <= 6) {
        for (const pw of uniquePermutationsArray(String(cur), 720)) {
          const r = await tryKotH(pw);
          if (r?.success) return r;
        }
      }
    }
    return { success: false };
  }

  // RateMyPix.Auth — SpiceLevel: 🌶️/len score; each pos: swap chars until score drops
  async function crackRateMyPix(host, model, len, fmt, hint, data) {
    const n = Number(len || 0);
    if (!n || n > 64) return { success: false };
    const charset = [...getCharset(fmt || "alphanumeric", true)];
    const baseline = charset.includes("0") ? "0" : charset[0];
    const baseGuess = baseline.repeat(n);

    async function scoreAttempt(pw) {
      const raw = await rdRaw(host, pw);
      if (raw?.success) return { success: true };
      const score = parseRateMyPixScore(raw, n);
      return { success: false, score };
    }

    ns.print(`[DNET-CRACK] RateMyPix len=${n} fmt=${fmt} charset=${charset.length}`);
    let base = await scoreAttempt(baseGuess);
    if (base.success) return { success: true, password: baseGuess, model };
    if (!Number.isFinite(base.score)) {
      ns.print(`[DNET-CRACK] RateMyPix no parseable score from baseline`);
      return { success: false };
    }

    const solved = Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      for (const ch of charset) {
        if (ch === baseline) continue;
        const arr = baseGuess.split("");
        arr[i] = ch;
        const r = await scoreAttempt(arr.join(""));
        if (r.success) return { success: true, password: arr.join(""), model };
        if (!Number.isFinite(r.score)) continue;
        if (r.score > base.score) { solved[i] = ch; break; }
        if (r.score < base.score) { solved[i] = baseline; break; }
        await ns.sleep(0);
      }
      if (!solved[i]) solved[i] = baseline;
      ns.print(`[DNET-CRACK] RateMyPix pos ${i + 1}/${n}: ${solved[i]}`);
    }

    if (solved.every(Boolean)) {
      return tryPw(host, solved.join(""), model, "RateMyPix score-solve");
    }
    return { success: false };
  }

  async function crackGeneric(host, model, len, hint, data) {
    const candidates = [...extractNumbers(`${hint}\n${data}`), ...DEFAULTS, ...DOGS];
    return tryCandidates(host, candidates, model, len, "generic");
  }

  // ── Feedback parsers ──────────────────────────────────────────────────────

  function parseDeepGreenFeedback(raw) {
    if (!raw) return null;
    const text = `${raw.data ?? ""}\n${raw.message ?? ""}`;
    const m = text.match(/(?:data["']?\s*[:=]\s*["']?)?(\d+)\s*,\s*(\d+)/i);
    return m ? { exact: Number(m[1]), misplaced: Number(m[2]) } : null;
  }

  function parseNilMask(raw, n) {
    if (!raw) return null;
    const text = `${raw.data ?? ""}\n${raw.message ?? ""}`;
    // "yesn't" must come before "yes" in alternation to avoid partial match
    const m = text.match(/data["']?\s*[:=]\s*["']?((?:yesn't|yes)(?:\s*,\s*(?:yesn't|yes))*)/i);
    if (!m) return null;
    const parts = m[1].split(/\s*,\s*/).map(x => x.toLowerCase().trim());
    return parts.length === n && parts.every(x => x === "yes" || x === "yesn't") ? parts : null;
  }

  function parseBellaFeedback(raw) {
    const text = `${raw?.message ?? ""}\n${raw?.data ?? ""}`.toUpperCase();
    if (text.includes("PARUM BREVIS") || text.includes("TOO LOW")) return "low";
    if (text.includes("ALTUS NIMIS") || text.includes("TOO HIGH")) return "high";
    return null;
  }

  // BigMo%od — source formula: (P%n)%((n-1)%32+1)=r
  function parseBigMoResponse(raw, attempted) {
    if (!raw) return null;
    const text = `${raw.message ?? ""}\n${raw.data ?? ""}`;
    // Extract result r from "= R" at end of the feedback expression
    const eqMatch = text.match(/=\s*(-?\d+)\s*$/m) || text.match(/\)\s*=\s*(-?\d+)/);
    const n = Number(attempted);
    const r = eqMatch ? Number(eqMatch[1]) : NaN;
    if (!Number.isFinite(n) || n <= 1 || !Number.isFinite(r)) return null;
    return { n, r };
  }

  function parseBigMoHeartbleed(logs) {
    const text = (logs ?? []).map(x => typeof x === "string" ? x : JSON.stringify(x)).join("\n");
    const out = [];
    // Match the formula structure and extract n and r
    const re = /Password\s*%\s*(\d+)[^=]*=\s*(-?\d+)/gi;
    for (const m of text.matchAll(re)) {
      const n = Number(m[1]);
      const r = Number(m[2]);
      if (Number.isFinite(n) && Number.isFinite(r) && n > 1) out.push({ n, r });
    }
    return out;
  }

  function parseRateMyPixScore(raw, len = 0) {
    const text = `${raw?.data ?? ""}\n${raw?.message ?? ""}`;
    const slash = text.match(/([0-9]+)\s*\/\s*([0-9]+)/);
    if (slash) return Number(slash[1]);
    const peppers = [...text.matchAll(/🌶(?:️)?/gu)].length;
    return peppers || null;
  }

  function parseKotHHeartbleed(logs, len) {
    const text = (logs ?? []).map(x => typeof x === "string" ? x : JSON.stringify(x)).join("\n");
    const out = [];
    const re = /current altitude:\s*([\d.]+)\s*m[\s\S]*?passwordAttempted:\s*([^\s\n]+)/gi;
    for (const m of text.matchAll(re)) {
      const alt = Number(m[1]);
      const pw = String(m[2] ?? "").trim();
      if (!Number.isFinite(alt) || !/^\d+$/.test(pw)) continue;
      if (len && pw.length !== len) continue;
      out.push({ alt, password: pw, attempt: Number(pw) });
    }
    return out;
  }

  // ── Ledger / spreading ────────────────────────────────────────────────────

  function readLedger() {
    const out = new Map();
    try {
      const raw = String(ns.read(LEDGER) || "");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [host, pw = "", model = "?"] = line.split("|");
        if (host) out.set(host, { password: pw, model });
      }
    } catch (_) {}
    return out;
  }

  async function writeLedger(map) {
    const rows = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([h, r]) => `${h}|${r.password ?? ""}|${r.model ?? "?"}`);
    try { await ns.write(LEDGER, rows.join("\n") + (rows.length ? "\n" : ""), "w"); } catch (_) {}
  }

  async function recordPassword(host, password, model) {
    const map = readLedger();
    const old = map.get(host);
    if (old && old.password === String(password ?? "") && old.model === model) return;
    map.set(host, { password: String(password ?? ""), model });
    await writeLedger(map);
    ns.print(`[DNET-CRACK] saved ${host} model=${model}`);
  }

  async function pullLedgerFromHome() {
    try { if (ns.fileExists(LEDGER, HOME)) await ns.scp(LEDGER, HOST, HOME); }
    catch (e) { ns.print(`[DNET-CRACK] ledger pull failed: ${e}`); }
  }

  async function pushLedgerToHome() {
    try { if (ns.fileExists(LEDGER, HOST)) await ns.scp(LEDGER, HOME, HOST); }
    catch (e) { ns.print(`[DNET-CRACK] ledger push failed: ${e}`); }
  }

  async function spread(host, password) {
    try { await rdConnect(host, password); } catch (_) {}

    const files = [CRAWL, CRACK, OPS, SCRAPE, ROUTE, LAB, LEDGER, MAP]
      .filter(f => ns.fileExists(f, HOST));
    try { await ns.scp(files, host, HOST); }
    catch (e) { ns.print(`[DNET-CRACK] scp to ${host} failed: ${e}`); return; }

    const extraArgs = [
      ...(ENABLE_SCRAPE ? ["--scrape"] : []),
      ...(COPY_HOME ? ["--copy-home"] : []),
    ];
    const pid = ns.exec(CRAWL, host, { preventDuplicates: true }, ...extraArgs);
    ns.print(`[DNET-CRACK] spread ${CRAWL} → ${host} pid=${pid}`);
    if (pid > 0) {
      ns.exec(OPS, host, { preventDuplicates: true }, "--realloc");
    }
  }

  async function dumpUnknown(host, details, logs) {
    const block = [
      `=== ${new Date().toISOString()} ${host} ===`,
      `modelId: ${details.modelId}`,
      `passwordLength: ${details.passwordLength ?? "?"}`,
      `passwordFormat: ${details.passwordFormat ?? ""}`,
      `passwordHint: ${details.passwordHint ?? ""}`,
      `data: ${details.data ?? details.passwordHintData ?? ""}`,
      `--- logs ---`,
      ...logs,
      "",
    ].join("\n");
    try { await ns.write(UNKNOWN, block, "a"); }
    catch (_) {}
    ns.print(`[DNET-CRACK] unsolved ${host} model=${details.modelId}; appended to ${UNKNOWN}`);
  }

  // ── Lock helpers ──────────────────────────────────────────────────────────

  function acquireTargetLock() {
    const now = Date.now();
    try {
      if (ns.fileExists(LOCK, HOST)) {
        const ts = Number(String(ns.read(LOCK) || "").split("|")[0]);
        if (Number.isFinite(ts) && now - ts < LOCK_TTL_MS) return false;
      }
      ns.write(LOCK, `${now}|${target}|${HOST}`, "w");
      return true;
    } catch (_) { return true; }
  }

  function releaseTargetLock() {
    try {
      const raw = String(ns.read(LOCK) || "");
      if (!raw || raw.includes(`|${target}|`)) ns.rm(LOCK, HOST);
    } catch (_) {}
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Module-level constants (source-exact from bitburner-src dictionaryData.ts)
// ════════════════════════════════════════════════════════════════════════════════

const DEFAULTS = ["admin", "password", "0000", "12345"]; // FreshInstall_1.0
const DOGS     = ["fido", "spot", "rover", "max"];        // Laika4

// EuroZone Free — CRITICAL: exact names from source (NOT "Cyprus"/"Czechia"/"The Netherlands")
const EU_COUNTRIES = [
  "Austria", "Belgium", "Bulgaria", "Croatia", "Republic of Cyprus", "Czech Republic",
  "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Ireland",
  "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Poland",
  "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden",
];

const COMMON_PASSWORDS = [
  "123456","password","12345678","qwerty","123456789","12345","1234","111111","1234567",
  "dragon","123123","baseball","abc123","football","monkey","letmein","696969","shadow",
  "master","666666","qwertyuiop","123321","mustang","1234567890","michael","654321",
  "superman","1qaz2wsx","7777777","121212","0","qazwsx","123qwe","trustno1","jordan",
  "jennifer","zxcvbnm","asdfgh","hunter","buster","soccer","harley","batman","andrew",
  "tigger","sunshine","iloveyou","2000","charlie","robert","thomas","hockey","ranger",
  "daniel","starwars","112233","george","computer","michelle","jessica","pepper","1111",
  "zxcvbn","555555","11111111","131313","freedom","777777","pass","maggie","159753",
  "aaaaaa","ginger","princess","joshua","cheese","amanda","summer","love","ashley",
  "6969","nicole","chelsea","biteme","matthew","access","yankees","987654321","dallas",
  "austin","thunder","taylor","matrix",
];

// ════════════════════════════════════════════════════════════════════════════════
// Pure JS helpers (no ns.* calls — zero additional RAM cost)
// ════════════════════════════════════════════════════════════════════════════════

const NUMBERS = "0123456789";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const LETTERS_UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALPHANUM = NUMBERS + LETTERS + LETTERS_UP;

function getCharset(fmt = "", includeUpper = false) {
  const f = String(fmt || "").toLowerCase();
  if (f === "numeric")      return NUMBERS;
  if (f === "alphabetic")   return includeUpper ? LETTERS + LETTERS_UP : LETTERS;
  if (f === "alphanumeric") return includeUpper ? NUMBERS + LETTERS + LETTERS_UP : NUMBERS + LETTERS;
  return includeUpper ? ALPHANUM : NUMBERS + LETTERS;
}

function generateCandidates(charset, n, fmt = "") {
  const f = String(fmt || "").toLowerCase();
  const chars = [...charset];
  const noLeadZero = f === "numeric" && n > 1;
  const out = [];
  function rec(prefix) {
    if (prefix.length === n) { out.push(prefix); return; }
    for (const ch of chars) {
      if (prefix.length === 0 && noLeadZero && ch === "0") continue;
      rec(prefix + ch);
      if (out.length > 100_000) return;
    }
  }
  rec(""); return out;
}

function cleanCandidates(arr, len) {
  return [...new Set(
    arr.flat().filter(x => x !== null && x !== undefined)
      .map(String).filter(x => x.length > 0 || len === 0)
      .filter(x => !len || x.length === len || x === "")
  )];
}

function countryVariants(country) {
  const raw = String(country ?? "").trim();
  const lower = raw.toLowerCase();
  const title = raw.split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(" ");
  const noThe = lower.replace(/^the\s+/, "");
  return uniqueStrings([raw, lower, title, noThe, lower.replace(/\s+/g, "")]);
}

function extractNumbers(str) {
  return [...String(str).matchAll(/\b(\d+)\b/g)].map(m => m[1]);
}

function digitsOnly(str, len = 0) {
  const d = String(str).replace(/[^0-9]/g, "");
  if (!len) return d || null;
  return d.length >= len ? d.slice(0, len) : null;
}

function extractRomanTokens(str) {
  return [...String(str).matchAll(/\b([IVXLCDM]+|nulla)\b/gi)].map(m => m[1]);
}

function romanToInt(input) {
  if (!input) return null;
  if (String(input).toLowerCase() === "nulla") return 0;
  const roman = String(input).toUpperCase();
  const v = { I:1, V:5, X:10, L:50, C:100, D:500, M:1000 };
  let total = 0, prev = 0;
  for (let i = roman.length - 1; i >= 0; i--) {
    const cur = v[roman[i]]; if (!cur) return null;
    total += cur < prev ? -cur : cur; prev = cur;
  }
  return total;
}

function parseRomanRange(str) {
  const vals = extractRomanTokens(str).map(romanToInt).filter(x => x !== null);
  return vals.length >= 2 ? [vals[0], vals[1]] : null;
}

function largestPrimeFactor(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 2) return null;
  let largest = 1;
  while (n % 2 === 0) { largest = 2; n /= 2; }
  for (let f = 3; f * f <= n; f += 2) { while (n % f === 0) { largest = f; n /= f; } }
  return n > 1 ? n : largest;
}

function parseBaseData(str) {
  const s = String(str);
  const direct = s.match(/^\s*([0-9]+)\s*,\s*([0-9A-Z.]+)\s*$/i);
  if (direct) return [Number(direct[1]), direct[2].toUpperCase()];
  const hint = s.match(/base\s+([0-9]+)\s+(?:number\s+)?([0-9A-Z.]+)/i);
  if (hint) return [Number(hint[1]), hint[2].toUpperCase()];
  return null;
}

function parseBaseN(numberString, base) {
  const chars = [...NUMBERS, ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  const s = String(numberString).toUpperCase();
  let result = 0, index = 0;
  let digit = s.split(".")[0].length - 1;
  while (index < s.length) {
    const ch = s[index];
    if (ch === ".") { index++; continue; }
    const place = chars.indexOf(ch);
    if (place < 0) return NaN;
    result += place * base ** digit;
    index++; digit--;
  }
  return result;
}

function cleanArithmetic(expr) {
  return String(expr)
    .replaceAll("ҳ", "*").replaceAll("÷", "/").replaceAll("➕", "+").replaceAll("➖", "-")
    .replaceAll("ns.exit(),", "").split(",")[0]
    .replace(/[^0-9+\-*/().\s]/g, "");
}

function parseSimpleArithmetic(expression) {
  const tokens = cleanArithmetic(expression).replace(/\s+/g, "").split("");
  let depth = 0;
  const depths = tokens.map(t => { if (t === "(") depth++; else if (t === ")") { depth--; return depth + 1; } return depth; });
  const d1 = depths.indexOf(1);
  if (d1 !== -1) {
    let end = depths.indexOf(0, d1);
    if (end === -1) end = depths.length - 1;
    const sub = parseSimpleArithmetic(tokens.slice(d1 + 1, end).join(""));
    tokens.splice(d1, end - d1 + 1, sub.toString());
    return parseSimpleArithmetic(tokens.join(""));
  }
  let rem = tokens.join("");
  let m = rem.match(/(-?\d*\.?\d+) *([*/]) *(-?\d*\.?\d+)/);
  while (m) {
    const res = m[2] === "*" ? parseFloat(m[1]) * parseFloat(m[3]) : parseFloat(m[1]) / parseFloat(m[3]);
    rem = rem.replace(m[0], res.toString());
    m = rem.match(/(-?\d*\.?\d+) *([*/]) *(-?\d*\.?\d+)/);
  }
  m = rem.match(/(-?\d*\.?\d+) *([+-]) *(-?\d*\.?\d+)/);
  while (m) {
    const res = m[2] === "+" ? parseFloat(m[1]) + parseFloat(m[3]) : parseFloat(m[1]) - parseFloat(m[3]);
    rem = rem.replace(m[0], res.toString());
    m = rem.match(/(-?\d*\.?\d+) *([+-]) *(-?\d*\.?\d+)/);
  }
  return parseFloat((rem.match(/(-?\d*\.?\d+)/) ?? ["", ""])[1]);
}

function sameMastermind(candidate, guess, fb) {
  let exact = 0;
  const c = new Map(), g = new Map();
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] === guess[i]) exact++;
    else {
      c.set(candidate[i], (c.get(candidate[i]) || 0) + 1);
      g.set(guess[i], (g.get(guess[i]) || 0) + 1);
    }
  }
  let mis = 0;
  for (const [ch, n] of c) mis += Math.min(n, g.get(ch) || 0);
  return exact === fb.exact && mis === fb.misplaced;
}

function matchesYesnt(candidate, guess, mask) {
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === "yes" && candidate[i] !== guess[i]) return false;
    if (mask[i] === "yesn't" && candidate[i] === guess[i]) return false;
  }
  return true;
}

function cartesianProduct(arrays) {
  return arrays.reduce((acc, arr) => acc.flatMap(combo => arr.map(v => [...combo, v])), [[]]);
}

function collectBigMoCandidates(lo, hi, len, constraints, limit = Infinity) {
  const out = [];
  if (!constraints.length) return out;
  for (let p = lo; p <= hi; p++) {
    const s = String(p);
    if (len && s.length !== len) continue;
    if (constraints.every(c => (p % c.n) % c.m === c.r)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function* uniquePermutations(str, max = Infinity) {
  const counts = new Map();
  for (const ch of str) counts.set(ch, (counts.get(ch) || 0) + 1);
  const chars = [...counts.keys()].sort();
  const buf = [];
  let n = 0;
  function* rec() {
    if (n >= max) return;
    if (buf.length === str.length) { n++; yield buf.join(""); return; }
    for (const ch of chars) {
      const left = counts.get(ch) || 0;
      if (!left) continue;
      counts.set(ch, left - 1); buf.push(ch);
      yield* rec();
      buf.pop(); counts.set(ch, left);
      if (n >= max) return;
    }
  }
  yield* rec();
}

function uniquePermutationsArray(str, max = Infinity) {
  const out = [];
  for (const p of uniquePermutations(String(str), max)) out.push(p);
  return out;
}

function uniqueStrings(values) {
  return [...new Set(values.map(v => String(v ?? "")).filter(v => v.length > 0))];
}

function neighborStrings(value, len, lo, hi, radius = 2) {
  const out = [];
  for (let n = Number(value) - radius; n <= Number(value) + radius; n++) {
    if (!Number.isFinite(n) || n < lo || n > hi) continue;
    const s = String(Math.trunc(n));
    if (s.length === len) out.push(s);
  }
  return out;
}

function hostDerivedCandidates(host, len = 0) {
  const raw = String(host || "");
  const parts = raw.split(/[^0-9a-zA-Z]+/).filter(Boolean);
  const out = [raw, raw.replace(/[^0-9a-zA-Z]/g, "")];
  for (const p of parts) {
    out.push(p, p.toLowerCase());
    const digits = p.replace(/[^0-9]/g, "");
    if (digits) out.push(digits);
  }
  return uniqueStrings(out);
}

function dirname(file) {
  const idx = String(file).lastIndexOf("/");
  return idx <= 0 ? "" : file.slice(0, idx);
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "unknown";
}

function hasArg(ns, ...names) {
  return names.some(n => ns.args.includes(n));
}

function getFlagNumber(ns, names, fallback = 0) {
  for (const name of [].concat(names)) {
    const idx = ns.args.indexOf(name);
    if (idx >= 0) { const v = Number(ns.args[idx + 1]); if (Number.isFinite(v) && v >= 0) return v; }
  }
  return fallback;
}

export function autocomplete() {
  return ["--scrape", "--copy-home", "--tail", "--rd-timeout", "--keep-rd"];
}
