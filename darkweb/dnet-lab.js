// /darkweb/dnet-lab.js — RAM-dodged labyrinth solver
// Solves any of the 7 Labyrinth variants via DFS. All ns.dnet.* calls are
// embedded inside a SINGLE rd() temp script (critical: labyrinth state is
// tied to the PID, so all movement must happen in one continuous execution).
// In-game RAM: ~2 GB. Temp script runs for up to 10 minutes for large mazes.
//
// Usage:
//   run /darkweb/dnet-lab.js [hostname]   -- auto-detects if omitted
//   run /darkweb/dnet-lab.js NormalLab --tail

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const HOST = ns.getHostname();
  const SELF = ns.getScriptName();
  const DIR = dirname(SELF);
  const path = name => DIR ? `${DIR}/${name}` : name;

  const LEDGER = "/darkweb/dnet-passwords.txt";
  const OPS = path("dnet-ops.js");

  const RD_TIMEOUT_MS = 600_000; // 10-minute timeout for full maze traversal
  const KEEP_RD = hasArg(ns, "--keep-rd");
  const NO_RADAR = hasArg(ns, "--no-radar");
  const KILL_PORT = 20;
  const KILL_PREFIX = "DNET_KILL|";

  if (hasArg(ns, "--tail")) {
    try { ns.ui.openTail(); } catch (_) {}
  }

  // Detect labyrinth host from args or probe neighbors
  let labHost = String(ns.args[0] ?? "");
  if (!labHost || labHost.startsWith("-")) {
    labHost = await detectLabHost();
    if (!labHost) {
      ns.tprint("[DNET-LAB] No labyrinth server found in neighbors. Specify hostname as first arg.");
      return;
    }
  }

  ns.print(`[DNET-LAB] Solving labyrinth: ${labHost}`);

  // The entire DFS solver runs as a single rd() temp script so the PID
  // (which tracks labyrinth position) stays consistent throughout navigation.
  const expr = buildLabSolverExpr();
  const result = await rd("lab-dfs", expr, [labHost, NO_RADAR], RD_TIMEOUT_MS);

  if (!result?.success) {
    ns.tprint(`[DNET-LAB] Labyrinth failed for ${labHost}: ${JSON.stringify(result)}`);
    return;
  }

  const pw = String(result.password ?? "");
  ns.tprint(`[DNET-LAB] Labyrinth SOLVED! ${labHost} password="${pw}" in ${result.steps} steps`);

  await recordPassword(labHost, pw, "(The Labyrinth)");

  // Open the cache reward from the lab
  try {
    const pid = ns.exec(OPS, HOST, { preventDuplicates: true }, "--open-caches");
    if (pid) ns.print(`[DNET-LAB] Launched ${OPS} --open-caches pid=${pid}`);
  } catch (_) {}

  // ── rd() RAM-dodge engine ─────────────────────────────────────────────────

  async function rd(label, expr, args = [], timeoutMs = 8_000) {
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
    while (Date.now() < deadline && ns.isRunning(pid)) await ns.sleep(200);
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

  // Probe neighbors to find a lab server
  async function detectLabHost() {
    const neighbors = await rd("probe", `ns.dnet.probe()`, [], 8_000) ?? [];
    const labNames = ["NormalLab","CruelLab","MercilessLab","UberLab","EternalLab","EndlessLab","FinalLab","BonusLab"];
    for (const h of neighbors) {
      if (labNames.some(n => h.toLowerCase().includes(n.toLowerCase()))) return h;
    }
    // Check details for labyrinth modelId
    for (const h of neighbors) {
      const d = await rd("details", `ns.dnet.getServerDetails(args[0])`, [h], 8_000);
      if (d?.modelId === "(The Labyrinth)") return h;
    }
    return null;
  }

  // ── Ledger ────────────────────────────────────────────────────────────────

  async function recordPassword(host, password, model) {
    const map = new Map();
    try {
      const raw = String(ns.read(LEDGER) || "");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [h, pw = "", m = "?"] = line.split("|");
        if (h) map.set(h, { password: pw, model: m });
      }
    } catch (_) {}
    map.set(host, { password: String(password ?? ""), model });
    const rows = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([h, r]) => `${h}|${r.password}|${r.model}`);
    try { await ns.write(LEDGER, rows.join("\n") + "\n", "w"); } catch (_) {}
    ns.print(`[DNET-LAB] Saved password for ${host} in ledger`);
  }
}

// ── Labyrinth solver expression (runs inside the temp script) ─────────────────
// IMPORTANT: This entire function runs as a single PID so labyrinth state is consistent.
// The temp script calls ns.dnet.labreport() and ns.dnet.authenticate(host, dir).

function buildLabSolverExpr() {
  return String.raw`(async () => {
  const host = args[0];
  const noRadar = args[1] === true || args[1] === "true";

  const rev = { north: "south", south: "north", east: "west", west: "east" };
  const deltas = { north: [0, -2], south: [0, 2], east: [2, 0], west: [-2, 0] };
  const DIRS = ["north", "east", "south", "west"];

  // Get initial position via labreport (free call, no state change)
  let loc;
  try { loc = await ns.dnet.labreport(); } catch (e) {
    return { success: false, error: String(e), step: "labreport" };
  }
  if (!loc?.coords) return { success: false, error: "no coords from labreport" };
  if (loc.code === 451) return { success: false, error: "insufficient charisma" };

  let [cx, cy] = loc.coords;
  const visited = new Set([cx + "," + cy]);
  let steps = 0;

  const stack = [{ remaining: DIRS.filter(d => loc[d]), back: null }];
  ns.print("[LAB-DFS] start [" + cx + "," + cy + "] open: " + DIRS.filter(d => loc[d]).join(","));

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    // Skip already-visited neighbors
    while (frame.remaining.length > 0) {
      const [ndx, ndy] = deltas[frame.remaining[0]];
      if (visited.has((cx + ndx) + "," + (cy + ndy))) frame.remaining.shift();
      else break;
    }

    if (frame.remaining.length === 0) {
      // Backtrack
      stack.pop();
      if (frame.back) {
        const [bdx, bdy] = deltas[frame.back];
        await ns.dnet.authenticate(host, frame.back);
        cx += bdx; cy += bdy;
        steps++;
        ns.print("[LAB-DFS] ← backtrack [" + cx + "," + cy + "] depth=" + stack.length);
      }
      continue;
    }

    const dir = frame.remaining.shift();
    const r = await ns.dnet.authenticate(host, dir);
    steps++;

    // Exit reached
    if (r?.success) {
      const pw = String(r.data ?? "");
      ns.print("[LAB-DFS] SOLVED! steps=" + steps + " cells=" + visited.size + " pw=" + pw);
      return { success: true, password: pw, steps, cells: visited.size };
    }

    const msg = String(r?.message ?? "");

    // Insufficient charisma mid-run
    if (r?.code === 451) return { success: false, error: "charisma dropped mid-run", steps };

    // Wall (should not happen with visited filter, but guard anyway)
    if (!msg.includes("moved to")) {
      ns.print("[LAB-DFS] wall " + dir + " at [" + cx + "," + cy + "]");
      continue;
    }

    // Successful move
    const [dx, dy] = deltas[dir];
    cx += dx; cy += dy;
    visited.add(cx + "," + cy);

    // Parse open directions from 3x3 surroundings in r.data
    const lines = String(r.data ?? "").split("\n");
    const open = [];
    if (lines.length >= 3) {
      if (lines[0]?.[1] === " ") open.push("north");
      if (lines[1]?.[2] === " ") open.push("east");
      if (lines[2]?.[1] === " ") open.push("south");
      if (lines[1]?.[0] === " ") open.push("west");
    } else {
      open.push(...DIRS); // fallback: try all, DFS handles walls
    }

    ns.print("[LAB-DFS] → " + dir + " [" + cx + "," + cy + "] open:" + open.join(",") + " depth=" + stack.length);
    stack.push({ remaining: open, back: rev[dir] });

    if (steps % 50 === 0) await ns.sleep(0);
  }

  return { success: false, error: "DFS exhausted all paths", steps, cells: visited.size };
})()`;
}

// ── Module helpers ────────────────────────────────────────────────────────────

function dirname(file) {
  const idx = String(file).lastIndexOf("/");
  return idx <= 0 ? "" : file.slice(0, idx);
}

function hasArg(ns, ...names) {
  return names.some(n => ns.args.includes(n));
}

export function autocomplete() {
  return [
    "NormalLab", "CruelLab", "MercilessLab", "UberLab",
    "EternalLab", "EndlessLab", "FinalLab", "BonusLab",
    "--tail", "--no-radar", "--keep-rd",
  ];
}
