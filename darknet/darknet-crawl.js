/**
 * Darknet crawling shared by darknet-daemon.js and dark-w0rm.js: crack neighbours, spread, push updates, report.
 * Part of CHILD_FILES: changes here start an update wave. Model internals: bitburner-src/src/DarkNet.
 */
import { log, formatDuration, formatRam } from "../helpers.js";
import { CHILD_FILES, KNOWN_FILE, PHISH_WORKER, RAM_WORKER, WORM, buildOf, requestStop, samePath } from "./darknet-paths.js";

/** Settings; override via darknet-daemon.js.config.txt (copied to every server) or the command line. */
export const CRAWLER_SCHEMA = [
  ["report-port", 7461], // instances -> coordinator: passwords and node reports
  ["control-port", 7462], // coordinator -> instances: stasis link apply/remove
  ["event-port", 7463], // coordinator -> daemon tail on home: coordinator actions
  ["state-file", "/data/darknet-state.json"], // coordinator's saved passwords and nodes
  ["max-known-passwords", 300], // passwords handed to each new instance
  ["hack-loop-wait-ms", 4000], // pause between passes over all neighbours
  ["report-ms", 30000], // neighbour report interval
  ["batch", 12], // guesses per heartbleed read
  ["lab-steps-per-pass", 40], // labyrinth moves per pass
  ["retry-cannot-ms", 31000], // retry delay: server cannot be solved yet (e.g. low charisma)
  ["retry-unsolved-ms", 32000], // retry delay: solver ran out of ideas
  ["retry-unknown-model-ms", 33000], // retry delay: unknown model id
  ["retry-ram-ms", 34000], // retry delay: neighbour lacks RAM
  ["verbose", false], // also log skipped neighbours, guess batches and reports
];

/** Fresh per-instance state. */
export const newState = (known) => ({
  known,
  retryAt: new Map(),
  labs: new Map(),
  warned: new Set(),
  reported: new Map(),
  lastReport: 0,
  lastLog: new Map(),
  minedFiles: new Set(), // clue/lore files already read
  hintPasswords: new Set(), // "Remember this password: X" clues (owner unknown)
  progress: new Map(), // hostname -> binary search bounds for retries
  roomFor: null, // neighbour this server keeps RAM free for (see makeRoom)
  build: 0, // build of the scripts this instance runs
});

/** Visits each neighbour (crack, spread or update), then reports. afterEach runs between neighbours. */
export const crawlNeighbours = async (ns, state, host, afterEach = () => {}) => {
  const neighbours = ns.dnet.probe();
  logChanged(ns, state, "neighbours", `INFO: Neighbours of ${host} (${neighbours.length}): ${neighbours.join(", ") || "none"}`);
  for (const neighbour of neighbours) {
    try {
      await visitNeighbour(ns, state, neighbour);
    } catch (error) {
      toast(ns, "warning", `DN: Error: ${neighbour}.`, `${neighbour}: ${error}`);
    }
    afterEach();
  }
  report(ns, state, host, neighbours);
};
export const MAX_LOGS = 200; // game log cap per server
// Defaults until main() loads the configuration
export let options = Object.fromEntries(CRAWLER_SCHEMA);
/** Called once by the entry script with its loaded settings. */
export const setOptions = (loaded) => {
  options = loaded;
};
// How each learned password was found; reported with it
export const passwordSources = new Map();
export const DIGITS = "0123456789";
export const LETTERS = "abcdefghijklmnopqrstuvwxyz" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const DEFAULT_PASSWORDS = ["admin", "password", "0000", "12345"];
export const DOG_NAMES = ["fido", "spot", "rover", "max"];
export const EU_COUNTRIES = [
  "Austria", "Belgium", "Bulgaria", "Croatia", "Republic of Cyprus", "Czech Republic", "Denmark", "Estonia",
  "Finland", "France", "Germany", "Greece", "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg",
  "Malta", "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden",
];
export const COMMON_PASSWORDS = [
  "123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111", "1234567", "dragon", "123123",
  "baseball", "abc123", "football", "monkey", "letmein", "696969", "shadow", "master", "666666", "qwertyuiop",
  "123321", "mustang", "1234567890", "michael", "654321", "superman", "1qaz2wsx", "7777777", "121212", "0", "qazwsx",
  "123qwe", "trustno1", "jordan", "jennifer", "zxcvbnm", "asdfgh", "hunter", "buster", "soccer", "harley", "batman",
  "andrew", "tigger", "sunshine", "iloveyou", "2000", "charlie", "robert", "thomas", "hockey", "ranger", "daniel",
  "starwars", "112233", "george", "computer", "michelle", "jessica", "pepper", "1111", "zxcvbn", "555555", "11111111",
  "131313", "freedom", "777777", "pass", "maggie", "159753", "aaaaaa", "ginger", "princess", "joshua", "cheese",
  "amanda", "summer", "love", "ashley", "6969", "nicole", "chelsea", "biteme", "matthew", "access", "yankees",
  "987654321", "dallas", "austin", "thunder", "taylor", "matrix",
];
export const SMALL_PRIMES = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
];
export const LARGE_PRIMES = [
  1069, 1409, 1471, 1567, 1597, 1601, 1697, 1747, 1801, 1889, 1979, 1999, 2063, 2207, 2371, 2503, 2539, 2693, 2741,
  2753, 2801, 2819, 2837, 2909, 2939, 3169, 3389, 3571, 3761, 3881, 4217, 4289, 4547, 4729, 4789, 4877, 4943, 4951,
  4957, 5393, 5417, 5419, 5441, 5519, 5527, 5647, 5779, 5881, 6007, 6089, 6133, 6389, 6451, 6469, 6547, 6661, 6719,
  6841, 7103, 7549, 7559, 7573, 7691, 7753, 7867, 8053, 8081, 8221, 8329, 8599, 8677, 8761, 8839, 8963, 9103, 9199,
  9343, 9467, 9551, 9601, 9739, 9749, 9859,
];
// Pairwise coprime prime powers with product lcm(1..32), for CRT over "% n" residues
export const LCM_MODULI = [32, 27, 25, 7, 11, 13, 17, 19, 23, 29, 31];
export const LAB_NAMES = [
  "th3_l4byr1nth", "cru3l_l4byr1nth", "m3rc1l3ss_l4byr1nth", "ub3r_l4byr1nth",
  "et3rn4l_l4byr1nth", "end13ss_l4byr1nth", "f1n4l_l4byr1nth", "b0nus_l4byr1nth",
];
// [name, dx, dy, opposite]; south/east first: the exit is bottom-right
export const LAB_DIRECTIONS = [
  ["south", 0, 1, "north"],
  ["east", 1, 0, "west"],
  ["north", 0, -1, "south"],
  ["west", -1, 0, "east"],
];
/** Thrown when a guess authenticates. */
export class Solved extends Error {
  constructor(password) {
    super("solved");
    this.password = password;
  }
}
/** The target went offline or moved. */
export class Gone extends Error {}
/** The target cannot be solved now (e.g. low charisma). */
export class Cannot extends Error {}
// Tail logging: decisions "INFO:", problems "WARNING:", detail with --verbose
export const info = (ns, message) => log(ns, `INFO: ${message}`);
export const detail = (ns, message) => options.verbose && log(ns, `INFO: ${message}`);
/** Short text on screen toast, full line in the tail. style: "success" or "warning". */
export const toast = (ns, style, short, full, toTerminal = false) => {
  log(ns, `${style === "success" ? "SUCCESS" : "WARNING"}: ${full}`, toTerminal);
  ns.toast(short, style);
};
/** Logs when the message for `key` changed. */
export const logChanged = (ns, state, key, message) => {
  if (state.lastLog.get(key) !== message) {
    state.lastLog.set(key, message);
    log(ns, message);
  }
};
export const retryIn = (ms) => `retrying in ${formatDuration(ms)}`;
/** Sends new passwords at once and this server's surroundings every --report-ms. */
export const report = (ns, state, host, neighbours) => {
  for (const [hostname, password] of Object.entries(state.known)) {
    if (state.reported.get(hostname) !== password) {
      const via = passwordSources.get(hostname) ?? "already known to this instance";
      ns.writePort(options["report-port"], JSON.stringify({ type: "pw", host: hostname, password, from: host, via }));
      state.reported.set(hostname, password);
    }
  }
  if (Date.now() - state.lastReport < options["report-ms"]) {
    return;
  }
  state.lastReport = Date.now();
  const details = host === "home" ? null : ns.dnet.getServerDetails(host);
  const node = {
    type: "node",
    host,
    neighbours,
    depth: details?.depth ?? -1,
    difficulty: details?.difficulty ?? 0,
    stationary: details?.isStationary ?? true,
    maxRam: ns.getServerMaxRam(host),
    blockedRam: details?.blockedRam ?? 0,
    contracts: ns.ls(host, ".cct"),
  };
  ns.writePort(options["report-port"], JSON.stringify(node));
  detail(ns, `Reported ${host} (depth ${node.depth}, ${neighbours.length} neighbours) to the coordinator.`);
};
export const visitNeighbour = async (ns, state, hostname) => {
  const theirs = runningCrawler(ns, hostname);
  if (theirs) {
    if (buildOf(theirs) < state.build) {
      pushUpdate(ns, state, hostname, theirs);
    } else {
      detail(ns, `${hostname}: skipped, our instance there already handles it and its neighbours.`);
    }
    return;
  }
  const retryAt = state.retryAt.get(hostname) ?? 0;
  if (Date.now() < retryAt) {
    detail(ns, `${hostname}: skipped, retry scheduled in ${formatDuration(retryAt - Date.now())}.`);
    return;
  }
  const details = ns.dnet.getServerDetails(hostname);
  if (!details.isOnline || !details.isConnectedToCurrentServer) {
    info(ns, `${hostname}: skipped, it ${details.isOnline ? "moved away" : "went offline"}.`);
    return;
  }

  if (!details.hasSession) {
    const isLabyrinth = LAB_NAMES.includes(hostname);
    const solved = isLabyrinth ? await stepLabyrinth(ns, state, hostname) : await serverSolver(ns, hostname, state);
    if (!solved) {
      return;
    }
    if (isLabyrinth) {
      toast(ns, "success", `DN: Labyrinth: ${hostname}.`, `Escaped the labyrinth ${hostname}.`, true);
    }
  }
  await spreadTo(ns, state, hostname);
};
/** One-line attack plan per model, shown in the tail. */
export const STRATEGIES = {
  ZeroLogon: "no password set, sending an empty one",
  "DeskMemo_3.1": "the hint contains the password",
  "PHP 5.4": "the hint has the sorted digits; trying arrangements, narrowed by the RMS deviation in the logs",
  "CloudBlare(tm)": "the captcha data is the password with filler symbols",
  "FreshInstall_1.0": "trying the factory default passwords",
  "Pr0verFl0": "overflowing the password buffer",
  DeepGreen: "mastermind: counting each symbol, then locating them from the exact-match feedback",
  "2G_cellular": "timing attack: the logs say where the first wrong character is",
  "PrimeTime 2": "the password is the largest prime factor of the hinted number",
  BellaCuore: "roman numerals: decoding, or binary search on the too-high/too-low feedback",
  Laika4: "trying common dog names",
  "AccountsManager_4.2": "binary search on the Higher/Lower feedback",
  TopPass: "dictionary attack with common passwords",
  "EuroZone Free": "dictionary attack with EU country names",
  NIL: "each 'ccc...c' guess reveals where symbol c is (yes / yesn't per position)",
  "110100100": "decoding the binary in the hint data",
  "RateMyPix.Auth": "pepper count = exact matches: counting each symbol, then locating them",
  OctantVoxel: "converting the hinted base-N number to base 10",
  MathML: "evaluating the hinted expression (safely, it may contain injected code)",
  "Factori-Os": "finding the prime factors with divisibility feedback",
  "BigMo%od": "collecting password residues from the modulo feedback (Chinese remainder theorem)",
  KingOfTheHill: "hill climbing on the reported altitude",
  OpenWebAccessPoint: "sniffing packets: the password is the text common to every capture",
  OrdoXenos: "undoing the XOR mask given in the hint data",
};
/** Authenticates with a server. Returns true on success.
 * @param {NS} ns
 * @param {string} hostname
 * @param {{known: Object<string, string>, retryAt: Map<string, number>, warned: Set<string>}} state
 */
export const serverSolver = async (ns, hostname, state) => {
  const details = ns.dnet.getServerDetails(hostname);
  if (!details.isConnectedToCurrentServer || !details.isOnline) {
    return false;
  }
  if (details.hasSession) {
    return true;
  }
  if (await tryRememberedPassword(ns, hostname, state, details)) {
    return true;
  }

  const solver = SOLVERS[details.modelId];
  if (!solver) {
    const retry = options["retry-unknown-model-ms"];
    if (!state.warned.has(details.modelId)) {
      state.warned.add(details.modelId);
      toast(ns, "warning", `DN: Unknown model: ${hostname}.`, `Unknown model "${details.modelId}" on ${hostname}. Hint: ${details.passwordHint}`, true);
    }
    info(ns, `${hostname}: no solver for "${details.modelId}", ${retryIn(retry)}.`);
    state.retryAt.set(hostname, Date.now() + retry);
    return false;
  }

  info(
    ns,
    `Cracking ${hostname}: ${details.modelId}, depth ${details.depth}, ${details.passwordLength}-char ` +
      `${details.passwordFormat}, hint "${details.passwordHint}". Plan: ${STRATEGIES[details.modelId]}.`,
  );
  state.progress ??= new Map();
  const target = new Target(ns, hostname, details, state.known, state.progress);
  const started = Date.now();
  const took = () => `${target.guesses} guess${target.guesses === 1 ? "" : "es"}, ${formatDuration(Date.now() - started)}`;
  try {
    // Clue-file passwords are cheap to try first when length and format fit
    const clues = [...(state.hintPasswords ?? [])].filter((password) => couldBePassword(password, details));
    if (clues.length > 0) {
      info(ns, `${hostname}: trying ${clues.length} clue-file password(s) of the right length first.`);
      await target.tryAll(clues);
    }
    await solver(target);
    const retry = options["retry-unsolved-ms"];
    toast(ns, "warning", `DN: Stuck: ${hostname}.`, `${hostname} (${details.modelId}): no password after ${took()}; ${retryIn(retry)}.`);
    state.retryAt.set(hostname, Date.now() + retry);
  } catch (error) {
    if (error instanceof Solved) {
      state.progress.delete(hostname);
      remember(state.known, hostname, error.password, `cracked as a ${details.modelId} server in ${took()}`);
      toast(ns, "success", `DN: Rooted: ${hostname}.`, `Rooted ${hostname} (${details.modelId}, depth ${details.depth}) in ${took()}.`);
      return true;
    }
    if (error instanceof Cannot) {
      const retry = options["retry-cannot-ms"];
      info(ns, `${hostname} (${details.modelId}): can't solve yet: ${error.message}; ${retryIn(retry)}.`);
      state.retryAt.set(hostname, Date.now() + retry);
    } else if (error instanceof Gone) {
      info(ns, `${hostname}: went offline or moved while cracking (${took()}).`);
    } else {
      throw error;
    }
  }
  return false;
};
/** Servers keep their password until offline, so try the remembered one. */
export const tryRememberedPassword = async (ns, hostname, state, details) => {
  const password = state.known[hostname];
  if (password === undefined) {
    return false;
  }
  if (!couldBePassword(password, details)) {
    info(ns, `${hostname}: remembered password no longer fits its ${details.passwordLength}-char ${details.passwordFormat} hint, cracking again.`);
    delete state.known[hostname]; // server reset with a new password
    return false;
  }
  if (ns.dnet.connectToSession(hostname, password).success) {
    info(ns, `${hostname}: logged in with the remembered password.`);
    return true;
  }
  info(ns, `${hostname}: retrying the remembered password (server may have restarted)...`);
  const result = await ns.dnet.authenticate(hostname, password);
  if (result.success) {
    info(ns, `${hostname}: remembered password works.`);
    return true;
  }
  if (result.code === 401) {
    info(ns, `${hostname}: remembered password rejected (new password after a reset), cracking again.`);
    delete state.known[hostname]; // server reset with a new password
  }
  return false;
};
/** One darknet server being cracked: guessing and reading feedback from its logs. */
export class Target {
  constructor(ns, host, details, known, progress) {
    this.ns = ns;
    this.host = host;
    this.known = known;
    this.progress = progress; // hostname -> search state kept across retries
    this.hint = details.passwordHint;
    this.data = details.data;
    this.length = details.passwordLength;
    this.difficulty = details.difficulty;
    this.alphabet = alphabetFor(details.passwordFormat);
    this.noise = []; // non-attempt log lines from the latest capture
    this.canReadLogs = false;
    this.guesses = 0;
  }

  /** Tries one password. Throws Solved on success, else returns the failed result. */
  async guess(password) {
    for (let retry = 0; retry < 8; retry++) {
      this.guesses++;
      const result = await this.ns.dnet.authenticate(this.host, password);
      if (result.success) {
        throw new Solved(password);
      }
      if (result.code === 408) {
        continue; // network instability: attempt not evaluated
      }
      if (result.code === 503 || result.code === 351) {
        throw new Gone();
      }
      return result;
    }
    throw new Cannot("network too unstable");
  }

  async tryAll(passwords) {
    for (const password of passwords) {
      await this.guess(password);
    }
  }

  /** Reads recent logs: parsed attempts by password; other lines go to this.noise. */
  async capture() {
    // peek: a normal read deletes the lines for every PID
    const result = await this.ns.dnet.heartbleed(this.host, { logsToCapture: MAX_LOGS, peek: true });
    if (result.code === 503 || result.code === 351) {
      throw new Gone();
    }
    if (!result.success) {
      throw new Cannot(`cannot read logs: ${result.message}`);
    }
    const attempts = new Map();
    this.noise = [];
    for (const line of result.logs) {
      const entry = parseAttemptLog(line);
      if (entry) {
        if (!attempts.has(entry.passwordAttempted)) {
          attempts.set(entry.passwordAttempted, entry); // newest first: first seen wins
        }
        continue;
      }
      this.noise.push(line);
      // Servers leak neighbours' credentials in their traffic
      const leaked = /^Connecting to (.+):([^:]*) \.\.\.$/.exec(line);
      if (leaked) {
        if (this.known[leaked[1]] !== leaked[2]) {
          info(this.ns, `${this.host}'s logs leaked the password of ${leaked[1]}; saved.`);
        }
        remember(this.known, leaked[1], leaked[2], `leaked in ${this.host}'s server logs`);
      }
    }
    return attempts;
  }

  /** Guesses all passwords, returns the parsed feedback entry for each (one heartbleed). */
  async probe(passwords) {
    if (!this.canReadLogs) {
      // Fail early when charisma is too low to read logs
      const result = await this.ns.dnet.heartbleed(this.host, { peek: true });
      if (result.code === 503 || result.code === 351) {
        throw new Gone();
      }
      if (!result.success) {
        throw new Cannot(`cannot read logs: ${result.message}`);
      }
      this.canReadLogs = true;
    }
    const unique = [...new Set(passwords)];
    const found = new Map();
    for (let round = 0; round < 3 && found.size < unique.length; round++) {
      const pending = unique.filter((password) => !found.has(password));
      if (round > 0) {
        info(this.ns, `${this.host}: ${pending.length} feedback line(s) scrolled out of the logs, re-sending.`);
      }
      for (const password of pending) {
        await this.guess(password);
      }
      detail(this.ns, `${this.host}: sent ${pending.length} guesses (${pending.slice(0, 3).join(", ")}...), reading feedback.`);
      const attempts = await this.capture();
      for (const password of pending) {
        if (attempts.has(password)) {
          found.set(password, attempts.get(password));
        }
      }
    }
    if (found.size < unique.length) {
      throw new Cannot("feedback logs were lost");
    }
    return passwords.map((password) => found.get(password));
  }

  /** probe() in batches that fit the log window. */
  async probeAll(passwords) {
    const results = [];
    for (const batch of chunks(passwords, options.batch)) {
      results.push(...(await this.probe(batch)));
    }
    return results;
  }
}
// ---------------------------------------------------------------------------------------------------------------
// Password solvers, one per model id. Success: Target.guess() throws Solved. Returning means out of ideas.
// ---------------------------------------------------------------------------------------------------------------

export const exactMatchesOf = (t) => async (guesses) =>
  (await t.probeAll(guesses)).map((entry) => Number(entry.data.split(",")[0]));
export const peppersOf = (t) => async (guesses) => (await t.probeAll(guesses)).map((entry) => countPeppers(entry.data));
export const SOLVERS = {
  ZeroLogon: (t) => t.tryAll([""]),
  // The password is the hint's last word
  "DeskMemo_3.1": (t) => t.tryAll([t.hint.trim().split(/\s+/).pop()]),
  "PHP 5.4": (t) => solveSortedDigits(t),
  // The data is the password digits mixed with non-digit filler
  "CloudBlare(tm)": (t) => t.tryAll([t.data.replace(/\D/g, "")]),
  "FreshInstall_1.0": (t) => t.tryAll(withLength(DEFAULT_PASSWORDS, t.length)),
  // Input longer than the buffer overwrites the expected half, so it matches
  "Pr0verFl0": (t) => t.tryAll(["0".repeat(t.length * 2)]),
  DeepGreen: (t) => solveByExactCounts(t, exactMatchesOf(t)),
  "2G_cellular": (t) => solveTimingAttack(t),
  "PrimeTime 2": (t) => t.tryAll([String(largestPrimeFactor(Number(t.data)))]),
  BellaCuore: (t) => solveRomanNumeral(t),
  Laika4: (t) => t.tryAll(withLength(DOG_NAMES, t.length)),
  "AccountsManager_4.2": (t) => solveGuessNumber(t),
  TopPass: (t) => t.tryAll(withLength(COMMON_PASSWORDS, t.length)),
  "EuroZone Free": (t) => t.tryAll(withLength(EU_COUNTRIES, t.length)),
  NIL: (t) => solveYesnt(t),
  // The data is space-separated 8-bit binary
  "110100100": (t) => t.tryAll([t.data.split(" ").map((bits) => String.fromCharCode(parseInt(bits, 2))).join("")]),
  "RateMyPix.Auth": (t) => solveByExactCounts(t, peppersOf(t)),
  OctantVoxel: (t) => t.tryAll([String(Math.round(parseBaseN(...t.data.split(","))))]),
  MathML: (t) => t.tryAll([String(evaluateExpression(t.data))]),
  "Factori-Os": (t) => solveDivisibility(t),
  "BigMo%od": (t) => solveTripleModulo(t),
  KingOfTheHill: (t) => solveKingOfTheHill(t),
  OpenWebAccessPoint: (t) => solveSniffer(t),
  // The data is "<xor-ed password>;<8-bit mask per character>"
  OrdoXenos: (t) => t.tryAll([decodeXorMask(t.data)]),
};
/** The password is a permutation of the hint digits; from 5 digits the log reports the RMS deviation. */
export const solveSortedDigits = async (t) => {
  const digits = t.data.split("");
  const arrangements = () => distinctPermutations(digits).filter((p) => p.length === 1 || p[0] !== "0");
  if (digits.length < 5) {
    return t.tryAll(arrangements());
  }
  let candidates = null;
  let guess = digits.join("");
  for (let round = 0; round < 12; round++) {
    const [entry] = await t.probe([guess]);
    const reported = /RMS Deviation:(\S+)/.exec(entry.data)?.[1];
    const previous = guess;
    candidates = (candidates ?? arrangements()).filter((p) => rmsDeviation(p, previous) === reported);
    if (candidates.length === 0) {
      return;
    }
    guess = candidates[Math.floor(candidates.length / 2)];
  }
};
/** For exact-match feedback (Mastermind, Spice Level): count each symbol with "ccc..c", then binary-split positions using an absent filler. */
export const solveByExactCounts = async (t, exactCounts) => {
  const length = t.length;
  const counts = new Map();
  let total = 0;
  for (const symbols of chunks([...t.alphabet], options.batch)) {
    if (total >= length) {
      break;
    }
    const results = await exactCounts(symbols.map((symbol) => symbol.repeat(length)));
    symbols.forEach((symbol, i) => {
      counts.set(symbol, results[i]);
      total += results[i];
    });
  }
  if (total !== length) {
    throw new Cannot("symbol counts do not add up");
  }
  const filler = [...t.alphabet].find((symbol) => !counts.get(symbol));
  if (filler === undefined) {
    throw new Cannot("every symbol is used, no spare filler");
  }

  const present = [...counts].filter(([, n]) => n > 0).sort((a, b) => a[1] - b[1]);
  const password = Array(length).fill(null);
  const leftover = present.pop(); // most frequent symbol fills the remaining positions
  let tasks = present.map(([symbol, n]) => ({ symbol, cells: [...Array(length).keys()], n }));

  while (tasks.length > 0) {
    const open = [];
    for (const task of tasks) {
      if (task.n === task.cells.length) {
        task.cells.forEach((cell) => (password[cell] = task.symbol));
      } else {
        open.push(task);
      }
    }
    const halves = open.map((task) => task.cells.slice(0, Math.ceil(task.cells.length / 2)));
    const guesses = open.map((task, i) => {
      const guess = Array(length).fill(filler);
      halves[i].forEach((cell) => (guess[cell] = task.symbol));
      return guess.join("");
    });
    const results = guesses.length > 0 ? await exactCounts(guesses) : [];
    tasks = open.flatMap((task, i) => {
      const rest = task.cells.filter((cell) => !halves[i].includes(cell));
      return [
        { symbol: task.symbol, cells: halves[i], n: results[i] },
        { symbol: task.symbol, cells: rest, n: task.n - results[i] },
      ].filter((next) => next.n > 0);
    });
  }
  password.forEach((symbol, i) => (password[i] = symbol ?? leftover[0]));
  await t.tryAll([password.join("")]);
};
/** The log gives the first wrong position, so the password resolves one character at a time. */
export const solveTimingAttack = async (t) => {
  let prefix = "";
  for (let position = 0; position < t.length; position++) {
    let next = null;
    for (const symbols of chunks([...t.alphabet], options.batch)) {
      const results = await t.probe(symbols.map((symbol) => prefix + symbol)); // the last position ends in Solved
      const hit = results.findIndex((r) => Number(/\((\d+)\)/.exec(r.message)?.[1] ?? -1) > position);
      if (hit >= 0) {
        next = symbols[hit];
        break;
      }
    }
    if (next === null) {
      throw new Cannot("timing attack found no matching symbol");
    }
    prefix += next;
  }
  await t.tryAll([prefix]);
};
/** Binary search on too-high/too-low feedback; resumes after a retry. */
export const searchByFeedback = async (t, low, high, isTooHigh, isTooLow) => {
  const range = `${low}-${high}`;
  const saved = t.progress.get(t.host);
  if (saved?.range === range) {
    ({ low, high } = saved);
    info(t.ns, `${t.host}: resuming the search at ${low}-${high}.`);
  }
  while (low <= high) {
    t.progress.set(t.host, { range, low, high });
    const middle = Math.floor((low + high) / 2);
    const [entry] = await t.probe([String(middle)]);
    if (isTooHigh(entry.data)) {
      high = middle - 1;
    } else if (isTooLow(entry.data)) {
      low = middle + 1;
    } else {
      throw new Cannot(`unexpected feedback "${entry.data}"`);
    }
    detail(t.ns, `${t.host}: ${middle} is ${entry.data}, now searching ${low}-${high}.`);
  }
  t.progress.delete(t.host); // contradictory feedback (e.g. password changed): restart next time
};
export const solveRomanNumeral = async (t) => {
  if (!t.data.includes(",")) {
    return t.tryAll([String(decodeRoman(t.data))]);
  }
  const [low, high] = t.data.split(",").map(decodeRoman);
  await searchByFeedback(t, low, high, (data) => data === "ALTUS NIMIS", (data) => data === "PARUM BREVIS");
};
export const solveGuessNumber = (t) => {
  // Length bounds the number; "between A and B" (inclusive) narrows it
  let low = t.length === 1 ? 0 : 10 ** (t.length - 1);
  let high = 10 ** t.length - 1;
  const between = /between\s+(\d+)\s+and\s+(\d+)/i.exec(t.hint);
  if (between && Number(between[1]) <= high && Number(between[2]) >= low) {
    low = Math.max(low, Number(between[1]));
    high = Math.min(high, Number(between[2]));
  }
  return searchByFeedback(t, low, high, (data) => data === "Lower", (data) => data === "Higher");
};
/** "ccc..c" returns yes/yesn't per position, revealing all positions of that symbol. */
export const solveYesnt = async (t) => {
  const password = Array(t.length).fill(null);
  for (const symbols of chunks([...t.alphabet], options.batch)) {
    const results = await t.probe(symbols.map((symbol) => symbol.repeat(t.length)));
    results.forEach((entry, i) =>
      entry.data.split(",").forEach((answer, position) => {
        if (answer === "yes" && password[position] === null) {
          password[position] = symbols[i];
        }
      }),
    );
    if (!password.includes(null)) {
      break;
    }
  }
  await t.tryAll([password.map((symbol) => symbol ?? "0").join("")]);
};
/** The log says whether the attempt divides the password, a product of known primes. */
export const solveDivisibility = async (t) => {
  const divides = async (divisors) => (await t.probeAll(divisors.map(String))).map((entry) => entry.data === "true");
  let password = 1n; // BigInt: high difficulty exceeds 2^53
  const factorise = async (primes) => {
    const flags = await divides(primes);
    let found = 0;
    for (const prime of primes.filter((_, i) => flags[i])) {
      let power = prime;
      password *= BigInt(prime);
      found++;
      while (power * prime <= Number.MAX_SAFE_INTEGER && (await divides([power * prime]))[0]) {
        power *= prime;
        password *= BigInt(prime);
        found++;
      }
    }
    return found;
  };

  await factorise(SMALL_PRIMES);
  const largeFactors = t.difficulty > 24 ? 2 : t.difficulty > 12 ? 1 : 0;
  let large = 0;
  for (const primes of chunks(LARGE_PRIMES, options.batch)) {
    if (large >= largeFactors) {
      break;
    }
    large += await factorise(primes);
  }
  await t.tryAll([String(password)]);
};
/** The log gives (password % n) % (n % 32); n = 32k + m above the password yields password mod m. CRT over LCM_MODULI rebuilds passwords below 1.4e14. */
export const solveTripleModulo = async (t) => {
  const base = 32 * Math.ceil(10 ** t.length / 32);
  const results = await t.probeAll(LCM_MODULI.map((m) => String(m === 32 ? base : base + m)));
  let value = 0n;
  let modulus = 1n;
  LCM_MODULI.forEach((m, i) => {
    const wanted = BigInt(results[i].data) % BigInt(m);
    let k = 0n;
    while ((value + modulus * k) % BigInt(m) !== wanted) {
      k++;
    }
    value += modulus * k;
    modulus *= BigInt(m);
  });
  await t.tryAll([value.toString()]);
};
/** Altitude is 10000 * exp(-((x - password) / width)^2) plus side hills: scan a grid, then invert the formula to jump to the peak candidates. */
export const solveKingOfTheHill = async (t) => {
  const length = t.length;
  if (length === 1) {
    return t.tryAll([...DIGITS]);
  }
  const low = 10 ** (length - 1);
  const high = 10 ** length - 1;
  const width = 10 ** Math.max(length - 2, 0) + 1;
  const altitudes = async (xs) => (await t.probeAll(xs.map(String))).map((entry) => Number(entry.data));
  const highest = (values) => values.indexOf(Math.max(...values));

  const grid = [];
  for (let x = low; x < high; x += width) {
    grid.push(x);
  }
  grid.push(high); // every password lies within half a hill width of a sample
  let readings = await altitudes(grid);
  let best = highest(readings);
  let x = grid[best];
  let altitude = readings[best];
  for (let round = 0; round < 12; round++) {
    const distance = width * Math.sqrt(Math.max(Math.log(10000 / Math.max(altitude, 1e-300)), 0));
    const candidates = [...new Set([Math.round(x - distance), Math.round(x + distance)])].filter(
      (candidate) => candidate >= low && candidate <= high,
    );
    if (candidates.length === 0) {
      return;
    }
    readings = await altitudes(candidates);
    best = highest(readings);
    x = candidates[best];
    altitude = readings[best];
  }
};
/** Each failed attempt returns a packet containing the password; the substring common to all captures is the password. */
export const solveSniffer = async (t) => {
  const length = t.length;
  const isValid = (text) => [...text].every((symbol) => t.alphabet.includes(symbol));
  for (let round = 0; round < 3; round++) {
    const decoys = [0, 1, 2].map((i) => `${"x".repeat(length)}${round}${i}`);
    const packets = (await t.probe(decoys)).map((entry) => entry.data);
    const scores = new Map();
    const add = (text, weight) => {
      if (text.length === length && isValid(text)) {
        scores.set(text, (scores.get(text) ?? 0) + weight);
      }
    };
    for (const line of t.noise) {
      const leaked = /^Logging in with passcode: (.*) \.\.\.$/.exec(line);
      if (leaked) {
        add(leaked[1], 100);
      }
    }
    for (const packet of packets) {
      const seen = new Set();
      for (let i = 0; i + length <= packet.length; i++) {
        seen.add(packet.slice(i, i + length));
      }
      seen.forEach((text) => add(text, 1));
      const marker = `${t.host}:`;
      for (let at = packet.indexOf(marker); at >= 0; at = packet.indexOf(marker, at + 1)) {
        add(packet.slice(at + marker.length, at + marker.length + length), 10);
      }
    }
    const ranked = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 30);
    await t.tryAll(ranked.map(([text]) => text));
  }
};
// ---------------------------------------------------------------------------------------------------------------
// Labyrinth: move with authenticate(lab, direction), map with labreport(). Moves span two cells; positions are per pid, so progress stays in memory.
// ---------------------------------------------------------------------------------------------------------------

/** Walks the maze depth first for a bounded number of steps. Returns true at the exit. */
export const stepLabyrinth = async (ns, state, hostname) => {
  if (!state.labs.has(hostname)) {
    info(ns, `${hostname}: the labyrinth - walking the maze depth first (south/east first, the exit is bottom-right).`);
  }
  const lab = state.labs.get(hostname) ?? { cells: new Map(), visited: new Set(), path: [], position: null };
  state.labs.set(hostname, lab);

  const report = async () => {
    const result = await ns.dnet.labreport();
    if (!result.success) {
      throw new Cannot(result.message ?? "lost in the labyrinth");
    }
    return result;
  };
  /** Returns {done: true} at the exit, else the new position (null if refused). */
  const move = async (direction) => {
    const result = await ns.dnet.authenticate(hostname, direction);
    if (result.success) {
      return { done: true };
    }
    if (/charism|moxie|charming/i.test(result.message ?? "")) {
      throw new Cannot(result.message);
    }
    const arrived = /moved to (\d+),(\d+)/.exec(result.message ?? "");
    return { done: false, position: arrived ? [Number(arrived[1]), Number(arrived[2])] : null };
  };

  try {
    for (let step = 0; step < options["lab-steps-per-pass"]; step++) {
      if (lab.position === null) {
        const here = await report();
        lab.position = here.coords;
        lab.visited.add(here.coords.join(","));
        lab.cells.set(here.coords.join(","), here);
      }
      const [x, y] = lab.position;
      const cell = lab.cells.get(`${x},${y}`);
      const next = LAB_DIRECTIONS.find(
        ([name, dx, dy]) => cell[name] && !lab.visited.has(`${x + 2 * dx},${y + 2 * dy}`),
      );

      if (next) {
        const result = await move(next[0]);
        if (result.done) {
          return true;
        }
        if (!result.position) {
          cell[next[0]] = false; // refused: stale report
          continue;
        }
        lab.position = result.position;
        lab.visited.add(result.position.join(","));
        lab.path.push(next);
        if (!lab.cells.has(result.position.join(","))) {
          lab.cells.set(result.position.join(","), await report());
        }
        continue;
      }

      const previous = lab.path.pop();
      if (!previous) {
        throw new Cannot("labyrinth fully explored without an exit");
      }
      const result = await move(previous[3]);
      if (result.done) {
        return true;
      }
      lab.position = result.position ?? [x - 2 * previous[1], y - 2 * previous[2]];
    }
  } catch (error) {
    state.labs.delete(hostname);
    if (error instanceof Cannot) {
      const retry = options["retry-cannot-ms"];
      state.retryAt.set(hostname, Date.now() + retry);
      info(ns, `${hostname}: labyrinth not passable yet - ${error.message}; ${retryIn(retry)}.`);
      return false;
    }
    throw error;
  }
  info(
    ns,
    `${hostname}: labyrinth at (${lab.position}), ${lab.visited.size} cells explored, ${lab.path.length} deep. ` +
      `Continuing next pass (other neighbours get a turn).`,
  );
  return false;
};
/** Asks `processes` to stop; they exit after their current call (ns.kill costs too much RAM). */
export const stopProcesses = (ns, host, processes, running = ns.ps(host)) => {
  if (processes.length > 0) {
    requestStop(ns, running, processes);
  }
  return processes.length;
};
/** Asks all running copies of `scripts` to stop. Returns the count. */
export const stopWorkers = (ns, host, scripts) => {
  const running = ns.ps(host);
  return stopProcesses(ns, host, running.filter((process) => scripts.some((script) => samePath(process.filename, script))), running);
};
/** Copies newer scripts to a neighbour on an older build; it restarts itself in place (updateSelf). */
export const pushUpdate = (ns, state, hostname, theirs) => {
  const password = state.known[hostname];
  const hasSession = ns.dnet.getServerDetails(hostname).hasSession ||
    (password !== undefined && ns.dnet.connectToSession(hostname, password).success);
  const was = buildOf(theirs) || "pre-build";
  if (!hasSession) {
    logChanged(ns, state, `push-${hostname}`, `INFO: ${hostname} runs build ${was} (ours: ${state.build}), but we have no session there to update it.`);
    return;
  }
  if (ns.scp(CHILD_FILES.filter((file) => ns.fileExists(file)), hostname)) {
    logChanged(ns, state, `push-${hostname}`, `INFO: ${hostname} runs build ${was}: copied build ${state.build} there; it restarts itself with it.`);
  } else {
    logChanged(ns, state, `push-${hostname}`, `WARNING: ${hostname} runs build ${was}: couldn't copy build ${state.build} there.`);
  }
};
/** Copies scripts and config to an authenticated neighbour and starts an instance. */
export const spreadTo = async (ns, state, hostname) => {
  const self = WORM;
  const knownCount = writeKnown(ns, state.known);
  if (!ns.scp([...CHILD_FILES.filter((file) => ns.fileExists(file)), KNOWN_FILE], hostname)) {
    toast(ns, "warning", `DN: Spread failed: ${hostname}.`, `${hostname}: couldn't copy the scripts (lost the session?).`);
    return;
  }
  const needed = ns.getScriptRam(self);
  if (freeRam(ns, hostname) < needed) {
    makeRoom(ns, state, hostname, needed);
    return;
  }
  const pid = ns.exec(self, hostname, { preventDuplicates: true }, "--build", state.build);
  if (pid !== 0) {
    info(ns, `Spread to ${hostname}: started ${self} (pid ${pid}) with ${knownCount} known passwords (${KNOWN_FILE}). It cracks its own neighbours.`);
  } else {
    toast(ns, "warning", `DN: Spread failed: ${hostname}.`, `${hostname}: couldn't start ${self}.`);
  }
};
/** Frees a neighbour's blocked RAM via the RAM worker (more threads free more per call), on the neighbour if it has room, else from here (pausing phishing). Spread retries later. */
export const makeRoom = (ns, state, hostname, needed) => {
  const host = ns.getHostname();
  const self = WORM;
  const blocked = ns.dnet.getBlockedRam(hostname);
  const retry = options["retry-ram-ms"];
  if (blocked <= 0 || freeRam(ns, hostname) + blocked < needed) {
    info(
      ns,
      `${hostname}: ${formatRam(freeRam(ns, hostname))} free (+${formatRam(blocked)} blocked), ` +
        `${self} needs ${formatRam(needed)}; ${retryIn(retry)}.`,
    );
    state.retryAt.set(hostname, Date.now() + retry);
    return;
  }
  const freeing = (h, process) => samePath(process.filename, RAM_WORKER) && String(process.args[0] ?? h) === hostname;
  if ([hostname, host].some((h) => ns.ps(h).some((process) => freeing(h, process)))) {
    logChanged(ns, state, `room-${hostname}`, `INFO: ${hostname}: still freeing blocked RAM (${formatRam(blocked)} left) for ${self}...`);
    return;
  }
  const workerRam = ns.getScriptRam(RAM_WORKER, host);
  const why = `${hostname}: freeing blocked RAM (${formatRam(blocked)}) for ${self} (${formatRam(needed)})`;
  const threadsThere = Math.floor(freeRam(ns, hostname) / workerRam);
  if (threadsThere >= 1 && ns.exec(RAM_WORKER, hostname, { threads: threadsThere }) !== 0) {
    info(ns, `${why}: started ${RAM_WORKER} x${threadsThere} there.`);
    return;
  }
  if (host === "home") {
    state.retryAt.set(hostname, Date.now() + retry);
    return;
  }
  const threadsHere = Math.floor(freeRam(ns, host) / workerRam);
  if (threadsHere >= 1 && ns.exec(RAM_WORKER, host, { threads: threadsHere }, hostname) !== 0) {
    state.roomFor = null;
    info(ns, `${why}: no room there, so ${RAM_WORKER} x${threadsHere} works on it from ${host}.`);
    return;
  }
  if (stopWorkers(ns, host, [PHISH_WORKER])) {
    state.roomFor = { host: hostname, until: Date.now() + retry };
    info(ns, `${why}: no room there; pausing phishing on ${host} to do it from here.`);
    return;
  }
  info(ns, `${why}: no room for ${RAM_WORKER} there or on ${host}; ${retryIn(retry)}.`);
  state.retryAt.set(hostname, Date.now() + retry);
};
// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

export const freeRam = (ns, hostname) => ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
export const isRunningOn = (ns, hostname, script) => {
  try {
    return ns.ps(hostname).some((process) => samePath(process.filename, script));
  } catch {
    return false;
  }
};
/** Our crawler process on a server, or undefined. */
export const runningCrawler = (ns, hostname) => {
  try {
    return ns.ps(hostname).find((process) => samePath(process.filename, WORM));
  } catch {
    return undefined; // the server went offline
  }
};
export const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
};
export const withLength = (words, length) => {
  const matching = words.filter((word) => word.length === length);
  return matching.length > 0 ? matching : words;
};
export const alphabetFor = (format) => (format === "numeric" ? DIGITS : format === "alphabetic" ? LETTERS : DIGITS + LETTERS);
export const FORMAT_PATTERNS = { numeric: /^[0-9]*$/, alphabetic: /^[a-zA-Z]*$/, alphanumeric: /^[a-zA-Z0-9]*$/ };
/** False when the advertised length/format rules the password out. */
export const couldBePassword = (password, details) =>
  password.length === details.passwordLength && (FORMAT_PATTERNS[details.passwordFormat]?.test(password) ?? true);
export const parseAttemptLog = (line) => {
  if (!line.startsWith("{")) {
    return null;
  }
  try {
    const entry = JSON.parse(line);
    return typeof entry.passwordAttempted === "string" ? entry : null;
  } catch {
    return null;
  }
};
export const remember = (known, hostname, password, via) => {
  delete known[hostname];
  known[hostname] = password;
  if (via) passwordSources.set(hostname, via);
  const keys = Object.keys(known);
  keys.slice(0, Math.max(keys.length - options["max-known-passwords"], 0)).forEach((key) => delete known[key]);
};
export const trimKnown = (known) => Object.fromEntries(Object.entries(known).slice(-options["max-known-passwords"]));
export const parseKnown = (json) => {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
};
/** Writes the trimmed KNOWN_FILE for the next worm; returns the password count. */
export const writeKnown = (ns, known) => {
  const trimmed = trimKnown(known);
  ns.write(KNOWN_FILE, JSON.stringify(trimmed), "w");
  return Object.keys(trimmed).length;
};
export const countPeppers = (data) => (data.split("/")[0].match(/\u{1F336}/gu) ?? []).length;
export const rmsDeviation = (a, b) => {
  let squares = 0;
  for (let i = 0; i < a.length; i++) {
    squares += (Number(a[i]) - Number(b[i])) ** 2;
  }
  return Math.sqrt(squares / a.length).toFixed(3);
};
export const distinctPermutations = (symbols) => {
  const remaining = new Map();
  symbols.forEach((symbol) => remaining.set(symbol, (remaining.get(symbol) ?? 0) + 1));
  const out = [];
  const current = [];
  const walk = () => {
    if (current.length === symbols.length) {
      out.push(current.join(""));
      return;
    }
    for (const [symbol, count] of remaining) {
      if (count > 0) {
        remaining.set(symbol, count - 1);
        current.push(symbol);
        walk();
        current.pop();
        remaining.set(symbol, count);
      }
    }
  };
  walk();
  return out;
};
export const largestPrimeFactor = (n) => {
  let largest = 1;
  for (let factor = 2; factor * factor <= n; factor += factor === 2 ? 1 : 2) {
    while (n % factor === 0) {
      largest = factor;
      n /= factor;
    }
  }
  return n > 1 ? n : largest;
};
export const decodeRoman = (text) => {
  if (text.toLowerCase() === "nulla") {
    return 0;
  }
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  let previous = 0;
  for (const symbol of [...text].reverse()) {
    const value = values[symbol];
    total += value < previous ? -value : value;
    previous = value;
  }
  return total;
};
/** Parses a number in `base`, possibly fractional ("." in the digits). */
export const parseBaseN = (base, digits) => {
  const symbols = DIGITS + "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let exponent = digits.split(".")[0].length - 1;
  let value = 0;
  for (const symbol of digits) {
    if (symbol !== ".") {
      value += symbols.indexOf(symbol) * Number(base) ** exponent;
      exponent--;
    }
  }
  return value;
};
export const decodeXorMask = (data) => {
  const split = data.indexOf(";");
  const masks = data.slice(split + 1).split(" ");
  let password = "";
  for (let i = 0; i < split; i++) {
    password += String.fromCharCode(data.charCodeAt(i) ^ parseInt(masks[i], 2));
  }
  return password;
};
/** Evaluates the MathML expression with a small parser (eval would run injected code), after the game's own cleanup. */
export const evaluateExpression = (raw) => {
  const text = raw
    .replaceAll("ҳ", "*")
    .replaceAll("÷", "/")
    .replaceAll("➕", "+")
    .replaceAll("➖", "-")
    .replaceAll("ns.exit(),", "")
    .split(",")[0];
  let i = 0;
  const peek = () => {
    while (text[i] === " ") {
      i++;
    }
    return text[i];
  };
  const factor = () => {
    const symbol = peek();
    if (symbol === "-") {
      i++;
      return -factor();
    }
    if (symbol === "(") {
      i++;
      const inner = sum();
      peek();
      i++; // ")"
      return inner;
    }
    const match = /^\d*\.?\d+/.exec(text.slice(i));
    if (!match) {
      throw new Cannot(`cannot parse expression at "${text.slice(i)}"`);
    }
    i += match[0].length;
    return parseFloat(match[0]);
  };
  const product = () => {
    let value = factor();
    for (let symbol = peek(); symbol === "*" || symbol === "/"; symbol = peek()) {
      i++;
      value = symbol === "*" ? value * factor() : value / factor();
    }
    return value;
  };
  const sum = () => {
    let value = product();
    for (let symbol = peek(); symbol === "+" || symbol === "-"; symbol = peek()) {
      i++;
      value = symbol === "+" ? value + product() : value - product();
    }
    return value;
  };
  return sum();
};