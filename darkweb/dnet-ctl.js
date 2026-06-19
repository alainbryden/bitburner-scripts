// /darkweb/dnet-ctl.js — darknet control plane
// Combines dnet-kill.js + dnet-port.js with status command added.
// No ns.dnet.* calls; RAM budget: ~1 GB.
//
// Usage:
//   run /darkweb/dnet-ctl.js --kill [--restart]
//   run /darkweb/dnet-ctl.js --stormseed [target]
//   run /darkweb/dnet-ctl.js --stasis <target> | --unstasis <target>
//   run /darkweb/dnet-ctl.js --backdoor <target> | --backdoor-all
//   run /darkweb/dnet-ctl.js --status
//   run /darkweb/dnet-ctl.js --clear | --clear-kill

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const SELF = ns.getScriptName();
  const DIR = dirname(SELF);
  const CRAWL = DIR ? `${DIR}/dnet-crawl.js` : "dnet-crawl.js";

  const KILL_PORT = getFlagNumber(ns, ["--kill-port"], 20);
  const CMD_PORT = getFlagNumber(ns, ["--cmd-port"], 21);
  const KILL_PREFIX = "DNET_KILL|";
  const CMD_PREFIX = "DNET_CMD|";
  const TTL_MS = getFlagNumber(ns, ["--ttl-ms", "--ttl"], 15_000);

  // ── --status ─────────────────────────────────────────────────────────────
  if (hasArg(ns, "--status")) {
    const killVal = ns.peek(KILL_PORT);
    const cmdVal = ns.peek(CMD_PORT);
    ns.tprint(`[DNET-CTL] Kill port ${KILL_PORT}: ${JSON.stringify(killVal)}`);
    ns.tprint(`[DNET-CTL] Cmd  port ${CMD_PORT}: ${JSON.stringify(cmdVal)}`);
    return;
  }

  // ── --clear-kill ──────────────────────────────────────────────────────────
  if (hasArg(ns, "--clear-kill")) {
    clearPort(ns, KILL_PORT);
    ns.tprint(`[DNET-CTL] Cleared kill port ${KILL_PORT}.`);
    return;
  }

  // ── --clear ───────────────────────────────────────────────────────────────
  if (hasArg(ns, "--clear")) {
    clearPort(ns, CMD_PORT);
    ns.tprint(`[DNET-CTL] Cleared command port ${CMD_PORT}.`);
    return;
  }

  // ── --kill ────────────────────────────────────────────────────────────────
  if (hasArg(ns, "--kill")) {
    const signal = `${KILL_PREFIX}${Date.now()}`;
    clearPort(ns, KILL_PORT);
    await ns.writePort(KILL_PORT, signal);
    ns.tprint(`[DNET-CTL] Kill signal sent on port ${KILL_PORT}: ${signal}`);

    if (hasArg(ns, "--restart")) {
      await ns.sleep(5_000);
      clearPort(ns, KILL_PORT);
      const args = ["--tail"];
      const pid = ns.run(CRAWL, 1, ...args);
      ns.tprint(pid > 0
        ? `[DNET-CTL] Restarted ${CRAWL} pid=${pid}`
        : `[DNET-CTL] Restart failed — run ${CRAWL} manually`);
    }
    return;
  }

  // ── command bus ───────────────────────────────────────────────────────────
  const parsed = parseActionAndTarget(ns);
  if (!parsed.action) {
    ns.tprint([
      "Usage:",
      `  run ${SELF} --kill [--restart]`,
      `  run ${SELF} --stormseed [target]`,
      `  run ${SELF} --stasis <target>`,
      `  run ${SELF} --unstasis <target>`,
      `  run ${SELF} --backdoor <target>`,
      `  run ${SELF} --backdoor-all`,
      `  run ${SELF} --status`,
      `  run ${SELF} --clear`,
      `  run ${SELF} --clear-kill`,
    ].join("\n"));
    return;
  }

  if ((parsed.action === "backdoor" || parsed.action === "stasis" || parsed.action === "unstasis") && !parsed.target) {
    ns.tprint(`[DNET-CTL] ${parsed.action} requires a <target> hostname or IP.`);
    return;
  }

  const id = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const expiresAt = Date.now() + Math.max(1_000, TTL_MS);
  const signal = `${CMD_PREFIX}${id}|${expiresAt}|${parsed.action}|${encodeURIComponent(parsed.target || "")}`;

  clearPort(ns, CMD_PORT);
  await ns.writePort(CMD_PORT, signal);
  ns.tprint(`[DNET-CTL] ${parsed.action} → port ${CMD_PORT}; target="${parsed.target || "*"}"; ttl=${TTL_MS}ms; id=${id}`);

  if (!hasArg(ns, "--no-reset")) {
    await ns.sleep(Math.max(1_000, TTL_MS));
    if (ns.peek(CMD_PORT) === signal) {
      clearPort(ns, CMD_PORT);
      ns.tprint(`[DNET-CTL] Command port ${CMD_PORT} auto-cleared.`);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseActionAndTarget(ns) {
  const defs = [
    ["stormseed",    ["--stormseed", "--storm"]],
    ["backdoor-all", ["--backdoor-all"]],
    ["backdoor",     ["--backdoor"]],
    ["stasis",       ["--stasis"]],
    ["unstasis",     ["--unstasis", "--remove-stasis"]],
  ];
  for (const [action, flags] of defs) {
    for (const flag of flags) {
      const idx = ns.args.indexOf(flag);
      if (idx < 0) continue;
      const next = ns.args[idx + 1];
      const explicit = getFlagValue(ns, ["--target"]);
      const target = explicit || (next !== undefined && !String(next).startsWith("-") ? String(next) : "");
      return { action, target };
    }
  }
  return { action: "", target: "" };
}

function clearPort(ns, port) {
  try { ns.clearPort(port); }
  catch (_) { try { ns.getPortHandle(port).clear(); } catch (_) {} }
}

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

function getFlagValue(ns, names) {
  for (const name of names) {
    const idx = ns.args.indexOf(name);
    if (idx >= 0 && ns.args[idx + 1] !== undefined) return String(ns.args[idx + 1]);
  }
  return "";
}

export function autocomplete() {
  return [
    "--kill", "--restart", "--stormseed", "--stasis", "--unstasis",
    "--backdoor", "--backdoor-all", "--status", "--clear", "--clear-kill",
    "--target", "--ttl-ms", "--kill-port", "--cmd-port", "--no-reset",
  ];
}
