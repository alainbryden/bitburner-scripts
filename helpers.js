/**
 * Return a formatted representation of the monetary amount using scale symbols (e.g. $6.50M)
 * @param {number} num - The number to format
 * @param {number=} maxSignificantFigures - (default: 6) The maximum significant figures you wish to see (e.g. 123, 12.3 and 1.23 all have 3 significant figures)
 * @param {number=} maxDecimalPlaces - (default: 3) The maximum decimal places you wish to see, regardless of significant figures. (e.g. 12.3, 1.2, 0.1 all have 1 decimal)
 **/
export function formatMoney(num, maxSignificantFigures = 6, maxDecimalPlaces = 3) {
    let numberShort = formatNumberShort(num, maxSignificantFigures, maxDecimalPlaces);
    return num >= 0 ? "$" + numberShort : numberShort.replace("-", "-$");
}

const symbols = ["", "k", "m", "b", "t", "q", "Q", "s", "S", "o", "n", "e33", "e36", "e39"];

/**
 * Return a formatted representation of the monetary amount using scale sympols (e.g. 6.50M)
 * @param {number} num - The number to format
 * @param {number=} maxSignificantFigures - (default: 6) The maximum significant figures you wish to see (e.g. 123, 12.3 and 1.23 all have 3 significant figures)
 * @param {number=} maxDecimalPlaces - (default: 3) The maximum decimal places you wish to see, regardless of significant figures. (e.g. 12.3, 1.2, 0.1 all have 1 decimal)
 **/
export function formatNumberShort(num, maxSignificantFigures = 6, maxDecimalPlaces = 3) {
    if (typeof num !== "number") {
        console.warn(`formatNumberShort called with "num" set to a non-numeric "${typeof num}" value ${JSON.stringify(num)}`);
        num = Number(num);
    }
    if (Math.abs(num) > 10 ** (3 * symbols.length)) // If we've exceeded our max symbol, switch to exponential notation
        return num.toExponential(Math.min(maxDecimalPlaces, maxSignificantFigures - 1));
    for (var i = 0, sign = Math.sign(num), num = Math.abs(num); num >= 1000 && i < symbols.length; i++) num /= 1000;
    // TODO: A number like 9.999 once rounded to show 3 sig figs, will become 10.00, which is now 4 sig figs.
    return ((sign < 0) ? "-" : "") + num.toFixed(Math.max(0, Math.min(maxDecimalPlaces, maxSignificantFigures - Math.floor(1 + Math.log10(num))))) + symbols[i];
}

/** Convert a shortened number back into a value */
export function parseShortNumber(text = "0") {
    let parsed = Number(text);
    if (!isNaN(parsed)) return parsed;
    for (const sym of symbols.slice(1))
        if (text.toLowerCase().endsWith(sym))
            return Number.parseFloat(text.slice(0, text.length - sym.length)) * Math.pow(10, 3 * symbols.indexOf(sym));
    return Number.NaN;
}

/**
 * Return a number formatted with the specified number of significant figures or decimal places, whichever is more limiting.
 * @param {number} num - The number to format
 * @param {number=} minSignificantFigures - (default: 6) The minimum significant figures you wish to see (e.g. 123, 12.3 and 1.23 all have 3 significant figures)
 * @param {number=} minDecimalPlaces - (default: 3) The minimum decimal places you wish to see, regardless of significant figures. (e.g. 12.3, 1.2, 0.1 all have 1 decimal)
 **/
export function formatNumber(num, minSignificantFigures = 3, minDecimalPlaces = 1) {
    return num == 0.0 ? "0" : num.toFixed(Math.max(minDecimalPlaces, Math.max(0, minSignificantFigures - Math.ceil(Math.log10(num)))));
}

const memorySuffixes = ["GB", "TB", "PB", "EB"];

/** Formats some RAM amount as a round number of GB/TB/PB/EB with thousands separators e.g. `1.028 TB` */
export function formatRam(num, printGB) {
    if (printGB) {
        return `${Math.round(num).toLocaleString('en')} GB`;
    }
    let idx = Math.floor(Math.log10(num) / 3) || 0;
    if (idx >= memorySuffixes.length) {
        idx = memorySuffixes.length - 1;
    } else if (idx < 0) {
        idx = 0;
    }
    const scaled = num / 1000 ** idx; // Scale the number to the order of magnitude chosen
    // Only display decimal places if there are any
    const formatted = scaled - Math.round(scaled) == 0 ? Math.round(scaled) : formatNumber(num / 1000 ** idx);
    return formatted.toLocaleString('en') + " " + memorySuffixes[idx];
}

/** Return a datatime in ISO format */
export function formatDateTime(datetime) { return datetime.toISOString(); }

/** Format a duration (in milliseconds) as e.g. '1h 21m 6s' for big durations or e.g '12.5s' / '23ms' for small durations */
export function formatDuration(duration) {
    if (duration < 1000) return `${duration.toFixed(0)}ms`
    if (!isFinite(duration)) return 'forever (Infinity)'
    const portions = [];
    const msInHour = 1000 * 60 * 60;
    const hours = Math.trunc(duration / msInHour);
    if (hours > 0) {
        portions.push(hours + 'h');
        duration -= (hours * msInHour);
    }
    const msInMinute = 1000 * 60;
    const minutes = Math.trunc(duration / msInMinute);
    if (minutes > 0) {
        portions.push(minutes + 'm');
        duration -= (minutes * msInMinute);
    }
    let seconds = (duration / 1000.0)
    // Include millisecond precision if we're on the order of seconds
    seconds = (hours == 0 && minutes == 0) ? seconds.toPrecision(3) : seconds.toFixed(0);
    if (seconds > 0) {
        portions.push(seconds + 's');
        duration -= (minutes * 1000);
    }
    return portions.join(' ');
}

/** Generate a hashCode for a string that is pretty unique most of the time */
export function hashCode(s) { return s.split("").reduce(function (a, b) { a = ((a << 5) - a) + b.charCodeAt(0); return a & a }, 0); }

/** @param {NS} ns **/
export function disableLogs(ns, listOfLogs) { ['disableLog'].concat(...listOfLogs).forEach(log => checkNsInstance(ns, '"disableLogs"').disableLog(log)); }

/** Joins all arguments as components in a path, e.g. pathJoin("foo", "bar", "/baz") = "foo/bar/baz" **/
export function pathJoin(...args) {
    return args.filter(s => !!s).join('/').replace(/\/\/+/g, '/');
}

/** Gets the path for the given local file, taking into account optional subfolder relocation via git-pull.js **/
export function getFilePath(file) {
    const subfolder = '';  // git-pull.js optionally modifies this when downloading
    return pathJoin(subfolder, file);
}

// FUNCTIONS THAT PROVIDE ALTERNATIVE IMPLEMENTATIONS TO EXPENSIVE NS FUNCTIONS
// VARIATIONS ON NS.RUN

/** @param {NS} ns
 *  Use where a function is required to run a script and you have already referenced ns.run in your script **/
export function getFnRunViaNsRun(ns) { return checkNsInstance(ns, '"getFnRunViaNsRun"').run; }

/** @param {NS} ns
 *  Use where a function is required to run a script and you have already referenced ns.exec in your script **/
export function getFnRunViaNsExec(ns, host = "home") {
    checkNsInstance(ns, '"getFnRunViaNsExec"');
    return function (scriptPath, ...args) { return ns.exec(scriptPath, host, ...args); }
}
// VARIATIONS ON NS.ISRUNNING

/** @param {NS} ns
 *  Use where a function is required to run a script and you have already referenced ns.run in your script  */
export function getFnIsAliveViaNsIsRunning(ns) { return checkNsInstance(ns, '"getFnIsAliveViaNsIsRunning"').isRunning; }

/** @param {NS} ns
 *  Use where a function is required to run a script and you have already referenced ns.ps in your script  */
export function getFnIsAliveViaNsPs(ns) {
    checkNsInstance(ns, '"getFnIsAliveViaNsPs"');
    return function (pid, host) { return ns.ps(host).some(process => process.pid === pid); }
}

/**
 * Retrieve the result of an ns command by executing it in a temporary .js script, writing the result to a file, then shuting it down
 * Importing incurs 1.0 GB RAM (uses ns.run), but if you are already using ns.exec in your script for other purposes,
 * you can call getNsDataThroughFile_Custom with fnRun set to the result of `getFnRunViaNsExec(ns)` and incur no additional RAM.
 * Has the capacity to retry if there is a failure (e.g. due to lack of RAM available). Not recommended for performance-critical code.
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {string} command The ns command that should be invoked to get the desired data (e.g. "ns.getServer('home')" )
 * @param {string?} fName (default "/Temp/{command-name}.txt") The name of the file to which data will be written to disk by a temporary process
 * @param {any[]?} args args to be passed in as arguments to command being run as a new script.
 * @param {boolean?} verbose (default false) If set to true, pid and result of command are logged.
 * TODO: Switch to an args object, this is getting ridiculous
 **/
export async function getNsDataThroughFile(ns, command, fName = null, args = [], verbose = false, maxRetries = 5, retryDelayMs = 50, silent = false) {
    checkNsInstance(ns, '"getNsDataThroughFile"');
    if (!verbose) disableLogs(ns, ['run', 'isRunning']);
    return await getNsDataThroughFile_Custom(ns, ns.run, command, fName, args, verbose, maxRetries, retryDelayMs, silent);
}

/** Convert a command name like "ns.namespace.someFunction(args, args)" into
 * a default file path for running that command "/Temp/namespace-someFunction.txt" */
function getDefaultCommandFileName(command, ext = '.txt') {
    // If prefixed with "ns.", strip that out
    let fname = command;
    if (fname.startsWith("await ")) fname = fname.slice(6);
    if (fname.startsWith("ns.")) fname = fname.slice(3);
    // Remove anything between parentheses
    fname = fname.replace(/ *\([^)]*\) */g, "");
    // Replace any dereferencing (dots) with dashes
    fname = fname.replace(".", "-");
    return `/Temp/${fname}${ext}`
}

/**
 * An advanced version of getNsDataThroughFile that lets you pass your own "fnRun" implementation to reduce RAM
 * requirements (if you already reference ns.exec in your script, pass the result of `getFnRunViaNsExec(ns)`)
 * Importing incurs no RAM (now that ns.read is free) plus whatever fnRun you provide it.
 * Has the capacity to retry if there is a failure (e.g. due to lack of RAM available). Not recommended for performance-critical code.
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {function} fnRun A single-argument function used to start the new sript, e.g. `ns.run` or `(f,...args) => ns.exec(f, "home", ...args)`
 * @param {string} command The ns command that should be invoked to get the desired data (e.g. "ns.getServer('home')" )
 * @param {string?} fName (default "/Temp/{command-name}.txt") The name of the file to which data will be written to disk by a temporary process
 * @param {any[]?} args args to be passed in as arguments to command being run as a new script.
 * @param {boolean?} verbose (default false) If set to true, pid and result of command are logged.
 **/
export async function getNsDataThroughFile_Custom(ns, fnRun, command, fName = null, args = [], verbose = false, maxRetries = 5, retryDelayMs = 50, silent = false) {
    checkNsInstance(ns, '"getNsDataThroughFile_Custom"');
    // If any args were skipped by passing null or undefined, set them to the default
    if (args == null) args = []; if (verbose == null) verbose = false;
    if (maxRetries == null) maxRetries = 5; if (retryDelayMs == null) retryDelayMs = 50; if (silent == null) silent = false;
    if (!verbose) disableLogs(ns, ['read']);
    fName = fName || getDefaultCommandFileName(command);
    const fNameCommand = fName + '.js'
    // Pre-write contents to the file that will allow us to detect if our temp script never got run
    const initialContents = "<Insufficient RAM>";
    ns.write(fName, initialContents, 'w');
    // TODO: Workaround for v2.3.0 deprecation. Remove when the warning is gone.
    // Avoid serializing ns.getPlayer() properties that generate warnings
    if (command === "ns.getPlayer()")
        command = `( ()=> { let player = ns.getPlayer();
            const excludeProperties = ['playtimeSinceLastAug', 'playtimeSinceLastBitnode', 'bitNodeN'];
            return Object.keys(player).reduce((pCopy, key) => {
                if (!excludeProperties.includes(key))
                   pCopy[key] = player[key];
                return pCopy;
            }, {});
        })()`;

    // Prepare a command that will write out a new file containing the results of the command
    // unless it already exists with the same contents (saves time/ram to check first)
    // If an error occurs, it will write an empty file to avoid old results being misread.
    const commandToFile = `let r;try{r=JSON.stringify(\n` +
        `    ${command}\n` +
        `, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}\n` +
        `const f="${fName}"; if(ns.read(f)!==r) ns.write(f,r,'w')`;
    // Run the command with auto-retries if it fails
    const pid = await runCommand_Custom(ns, fnRun, commandToFile, fNameCommand, args, verbose, maxRetries, retryDelayMs, silent);
    // Wait for the process to complete. Note, as long as the above returned a pid, we don't actually have to check it, just the file contents
    const fnIsAlive = (ignored_pid) => ns.read(fName) === initialContents;
    await waitForProcessToComplete_Custom(ns, fnIsAlive, pid, verbose);
    if (verbose) log(ns, `Process ${pid} is done. Reading the contents of ${fName}...`);
    // Read the file, with auto-retries if it fails // TODO: Unsure reading a file can fail or needs retrying.
    let lastRead;
    const fileData = await autoRetry(ns, () => ns.read(fName),
        f => (lastRead = f) !== undefined && f !== "" && f !== initialContents && !(typeof f == "string" && f.startsWith("ERROR: ")),
        () => `\nns.read('${fName}') returned a bad result: "${lastRead}".` +
            `\n  Script:  ${fNameCommand}\n  Args:    ${JSON.stringify(args)}\n  Command: ${command}` +
            (lastRead == undefined ? '\nThe developer has no idea how this could have happened. Please post a screenshot of this error on discord.' :
                lastRead == initialContents ? `\nThe script that ran this will likely recover and try again later once you have more free ram.` :
                    lastRead == "" ? `\nThe file appears to have been deleted before a result could be retrieved. Perhaps there is a conflicting script.` :
                        lastRead.includes('API ACCESS ERROR') ? `\nThis script should not have been run until you have the required Source-File upgrades. Sorry about that.` :
                            `\nThe script was likely passed invalid arguments. Please post a screenshot of this error on discord.`),
        maxRetries, retryDelayMs, undefined, verbose, verbose, silent);
    if (verbose) log(ns, `Read the following data for command ${command}:\n${fileData}`);
    return JSON.parse(fileData, jsonReviver); // Deserialize it back into an object/array and return
}

/** Allows us to serialize types not normally supported by JSON.serialize */
export function jsonReplacer(key, val) {
    if (val === Infinity)
        return { $type: 'number', $value: 'Infinity' };
    if (val === -Infinity)
        return { $type: 'number', $value: '-Infinity' };
    if (Number.isNaN(val))
        return { $type: 'number', $value: 'NaN' };
    if (typeof val === 'bigint')
        return { $type: 'bigint', $value: val.toString() };
    if (val instanceof Map)
        return { $type: 'Map', $value: [...val] };
    if (val instanceof Set)
        return { $type: 'Set', $value: [...val] };
    return val;
}

/** Allows us to deserialize special values created by the above jsonReplacer */
export function jsonReviver(key, val) {
    if (val == null || typeof val !== 'object' || val.$type == null)
        return val;
    if (val.$type == 'number')
        return Number.parseFloat(val.$value);
    if (val.$type == 'bigint')
        return BigInt(val.$value);
    if (val.$type === 'Map')
        return new Map(val.$value);
    if (val.$type === 'Set')
        return new Set(val.$value);
    return val;
}

/** Evaluate an arbitrary ns command by writing it to a new script and then running or executing it.
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {string} command The ns command that should be invoked to get the desired data (e.g. "ns.getServer('home')" )
 * @param {string?} fileName (default "/Temp/{command-name}.txt") The name of the file to which data will be written to disk by a temporary process
 * @param {any[]?} args args to be passed in as arguments to command being run as a new script.
 * @param {boolean?} verbose (default false) If set to true, the evaluation result of the command is printed to the terminal
 */
export async function runCommand(ns, command, fileName, args = [], verbose = false, maxRetries = 5, retryDelayMs = 50, silent = false) {
    checkNsInstance(ns, '"runCommand"');
    if (!verbose) disableLogs(ns, ['run']);
    return await runCommand_Custom(ns, ns.run, command, fileName, args, verbose, maxRetries, retryDelayMs, silent);
}

const _cachedExports = []; // A cached list of functions exported by helpers.js. Should be fine as long as we aren't actively editing it.
/** @param {NS} ns The nestcript instance passed to your script's main entry point
 * @returns {string[]} The set of all function names exported by this file. */
function getExports(ns) {
    if (_cachedExports.length > 0) return _cachedExports;
    const scriptHelpersRows = ns.read(getFilePath('helpers.js')).split("\n");
    for (const row of scriptHelpersRows) {
        if (!row.startsWith("export")) continue;
        const funcNameStart = row.indexOf("function") + "function".length + 1;
        const funcNameEnd = row.indexOf("(", funcNameStart);
        _cachedExports.push(row.substring(funcNameStart, funcNameEnd));
    }
    return _cachedExports;
}

/**
 * An advanced version of runCommand that lets you pass your own "isAlive" test to reduce RAM requirements (e.g. to avoid referencing ns.isRunning)
 * Importing incurs 0 GB RAM (assuming fnRun, fnWrite are implemented using another ns function you already reference elsewhere like ns.exec)
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {function} fnRun A single-argument function used to start the new sript, e.g. `ns.run` or `(f,...args) => ns.exec(f, "home", ...args)`
 * @param {string} command The ns command that should be invoked to get the desired data (e.g. "ns.getServer('home')" )
 * @param {string?} fileName (default "/Temp/{commandhash}-data.txt") The name of the file to which data will be written to disk by a temporary process
 * @param {any[]?} args args to be passed in as arguments to command being run as a new script.
 **/
export async function runCommand_Custom(ns, fnRun, command, fileName, args = [], verbose = false, maxRetries = 5, retryDelayMs = 50, silent = false) {
    checkNsInstance(ns, '"runCommand_Custom"');
    if (!Array.isArray(args)) throw new Error(`args specified were a ${typeof args}, but an array is required.`);
    if (!verbose) disableLogs(ns, ['sleep']);
    // Auto-import any helpers that the temp script attempts to use
    let importFunctions = getExports(ns).filter(e => command.includes(`${e}`)) // Check if the script includes the name of any functions
        // To avoid false positives, narrow these to "whole word" matches (no alpha characters on either side)
        .filter(e => new RegExp(`(^|[^\\w])${e}([^\\w]|\$)`).test(command));
    let script = (importFunctions.length > 0 ? `import { ${importFunctions.join(", ")} } from 'helpers.js'\n` : '') +
        `export async function main(ns) { ${command} }`;
    fileName = fileName || getDefaultCommandFileName(command, '.js');
    if (verbose)
        log(ns, `INFO: Using a temporary script (${fileName}) to execute the command:` +
            `\n  ${command}\nWith the following arguments:    ${JSON.stringify(args)}`);
    // It's possible for the file to be deleted while we're trying to execute it, so even wrap writing the file in a retry
    return await autoRetry(ns, async () => {
        // To improve performance, don't re-write the temp script if it's already in place with the correct contents.
        const oldContents = ns.read(fileName);
        if (oldContents != script) {
            if (oldContents) // Create some noise if temp scripts are being created with the same name but different contents
                ns.tprint(`WARNING: Had to overwrite temp script ${fileName}\nOld Contents:\n${oldContents}\nNew Contents:\n${script}` +
                    `\nThis warning is generated as part of an effort to switch over to using only 'immutable' temp scripts. ` +
                    `Please paste a screenshot in Discord at https://discord.com/channels/415207508303544321/935667531111342200`);
            ns.write(fileName, script, "w");
            // Wait for the script to appear and be readable (game can be finicky on actually completing the write)
            await autoRetry(ns, () => ns.read(fileName), c => c == script, () => `Temporary script ${fileName} is not available, ` +
                `despite having written it. (Did a competing process delete or overwrite it?)`, maxRetries, retryDelayMs, undefined, verbose, verbose, silent);
        }
        // NEW! We can inject "RunOptions" as the middle arg (rather than an integer thread count)
        // Run the script, now that we're sure it is in place
        return fnRun(fileName, { temporary: true }, ...args);
    }, pid => pid !== 0,
        async () => {
            if (silent) return `(silent = true)`; // No reason needed in silent mode, messages should all be suppressed
            let reason = " (likely due to insufficient RAM)";
            // Just to be super clear - try to find out how much ram this script requires vs what we have available
            try {
                const reqRam = await getNsDataThroughFile_Custom(ns, fnRun, 'ns.getScriptRam(ns.args[0])', null, [fileName], false, 1, 0, true);
                const homeMaxRam = await getNsDataThroughFile_Custom(ns, fnRun, 'ns.getServerMaxRam(ns.args[0])', null, ["home"], false, 1, 0, true);
                const homeUsedRam = await getNsDataThroughFile_Custom(ns, fnRun, 'ns.getServerUsedRam(ns.args[0])', null, ["home"], false, 1, 0, true);
                if (reqRam > homeMaxRam)
                    reason = ` as it requires ${formatRam(reqRam)} RAM, but home only has ${formatRam(homeMaxRam)}`;
                else if (reqRam > homeMaxRam - homeUsedRam)
                    reason = ` as it requires ${formatRam(reqRam)} RAM, but home only has ${formatRam(homeMaxRam - homeUsedRam)} of ${formatRam(homeMaxRam)} free.`;
                else
                    reason = `, but the reason is unclear. (Perhaps a syntax error?) This script requires ${formatRam(reqRam)} RAM, and ` +
                        `home has ${formatRam(homeMaxRam - homeUsedRam)} of ${formatRam(homeMaxRam)} free, which appears to be sufficient. ` +
                        `If you wish to troubleshoot, you can try manually running the script with the arguments listed below:`;
            } catch (ex) { /* It was worth a shot. Stick with the generic error message. */ }
            return `The temp script was not run${reason}.` +
                `\n  Script:  ${fileName}\n  Args:    ${JSON.stringify(args)}\n  Command: ${command}` +
                `\nThe script that ran this will likely recover and try again later.`
        },
        maxRetries, retryDelayMs, undefined, verbose, verbose, silent);
}

/**
 * Wait for a process id to complete running
 * Importing incurs a maximum of 0.1 GB RAM (for ns.isRunning)
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {number} pid The process id to monitor
 * @param {boolean?} verbose (default false) If set to true, pid and result of command are logged. **/
export async function waitForProcessToComplete(ns, pid, verbose = false) {
    checkNsInstance(ns, '"waitForProcessToComplete"');
    if (!verbose) disableLogs(ns, ['isRunning']);
    return await waitForProcessToComplete_Custom(ns, ns.isRunning, pid, verbose);
}
/**
 * An advanced version of waitForProcessToComplete that lets you pass your own "isAlive" test to reduce RAM requirements (e.g. to avoid referencing ns.isRunning)
 * Importing incurs 0 GB RAM (assuming fnIsAlive is implemented using another ns function you already reference elsewhere like ns.ps)
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {(pid: number) => Promise<boolean>} fnIsAlive A single-argument function used to start the new sript, e.g. `ns.isRunning` or `pid => ns.ps("home").some(process => process.pid === pid)`
 * @param {number} pid The process id to monitor
 * @param {boolean?} verbose (default false) If set to true, pid and result of command are logged. **/
export async function waitForProcessToComplete_Custom(ns, fnIsAlive, pid, verbose = false) {
    checkNsInstance(ns, '"waitForProcessToComplete_Custom"');
    if (!verbose) disableLogs(ns, ['sleep']);
    // Wait for the PID to stop running (cheaper than e.g. deleting (rm) a possibly pre-existing file and waiting for it to be recreated)
    let start = Date.now();
    let sleepMs = 1;
    let done = false;
    for (var retries = 0; retries < 1000; retries++) {
        if (!(await fnIsAlive(pid))) {
            done = true;
            break; // Script is done running
        }
        if (verbose && retries % 100 === 0) ns.print(`Waiting for pid ${pid} to complete... (${formatDuration(Date.now() - start)})`);
        await ns.sleep(sleepMs); // TODO: If we can switch to `await nextPortWrite(pid)` for signalling temp script completion, it would return faster.
        sleepMs = Math.min(sleepMs * 2, 200);
    }
    // Make sure that the process has shut down and we haven't just stopped retrying
    if (!done) {
        let errorMessage = `run-command pid ${pid} is running much longer than expected. Max retries exceeded.`;
        ns.print(errorMessage);
        throw new Error(errorMessage);
    }
}

/** If the argument is an Error instance, returns it as is, otherwise, returns a new Error instance. */
function asError(error) {
    return error instanceof Error ? error :
        new Error(typeof error === 'string' ? error :
            JSON.stringify(error, jsonReplacer)); // TODO: jsonReplacer to support ScriptDeath objects and other custom Bitburner throws
}

/** Helper to retry something that failed temporarily (can happen when e.g. we temporarily don't have enough RAM to run)
 * @param {NS} ns The nestcript instance passed to your script's main entry point */
export async function autoRetry(ns, fnFunctionThatMayFail, fnSuccessCondition, errorContext = "Success condition not met",
    maxRetries = 5, initialRetryDelayMs = 50, backoffRate = 3, verbose = false, tprintFatalErrors = true, silent = false) {
    // If any args were skipped by passing null or undefined, set them to the default
    if (errorContext == null) errorContext = "Success condition not met";
    if (maxRetries == null) maxRetries = 5; if (initialRetryDelayMs == null) initialRetryDelayMs = 50; if (backoffRate == null) backoffRate = 3;
    if (verbose == null) verbose = false; if (tprintFatalErrors == null) tprintFatalErrors = true; if (silent == null) silent = false;
    checkNsInstance(ns, '"autoRetry"');
    let retryDelayMs = initialRetryDelayMs, attempts = 0;
    let sucessConditionMet;
    while (attempts++ <= maxRetries) {
        // Sleep between attempts
        if (attempts > 1) {
            await ns.sleep(retryDelayMs);
            retryDelayMs *= backoffRate;
        }
        try {
            sucessConditionMet = true;
            const result = await fnFunctionThatMayFail()
            // Check if this is considered a successful result
            sucessConditionMet = fnSuccessCondition(result);
            if (sucessConditionMet instanceof Promise)
                sucessConditionMet = await sucessConditionMet; // If fnSuccessCondition was async, await its result
            if (!sucessConditionMet) {
                // If we have not yet reached our maximum number of retries, we can continue, without throwing
                if (attempts < maxRetries) {
                    if (!silent) log(ns, `INFO: Attempt ${attempts} of ${maxRetries} failed. Trying again in ${retryDelayMs}ms...`, false, !verbose ? undefined : 'info');
                    continue;
                }
                // Otherwise, throw an error using the message provided by the errorContext string or function argument
                let errorMessage = typeof errorContext === 'string' ? errorContext : errorContext(result);
                if (errorMessage instanceof Promise)
                    errorMessage = await errorMessage; // If the errorContext function was async, await its result
                throw asError(errorMessage);
            }
            return result;
        }
        catch (error) {
            const fatal = attempts >= maxRetries;
            if (!silent) log(ns, `${fatal ? 'FAIL' : 'INFO'}: Attempt ${attempts} of ${maxRetries} raised an error` +
                (fatal ? `: ${getErrorInfo(error)}` : `. Trying again in ${retryDelayMs}ms...`),
                tprintFatalErrors && fatal, !verbose ? undefined : (fatal ? 'error' : 'info'))
            if (fatal) throw asError(error);
        }
    }
    throw new Error("Unexpected return from autoRetry");
}

/** Helper for extracting the error message from an error thrown by the game.
 * @param {Error|string} err A thrown error message or object
*/
export function getErrorInfo(err) {
    if (err === undefined || err == null) return "(null error)"; // Nothing caught
    if (typeof err === 'string') return err; // Simple string was thrown
    let strErr = null;
    // Add the stack trace below, if available
    if (err instanceof Error) {
        if (err.stack) // Stack is the most useful for debugging an issue. (Remove bitburner source code from the stack though.)
            strErr = '  ' + err.stack.split('\n').filter(s => !s.includes('bitburner-official'))
                .join('\n    '); // While we're here, indent the stack trace to help distinguish it from the rest.
        if (err.cause) // Some errors have a nested "cause" error object - recurse!
            strErr = (strErr ? strErr + '\n' : '') + getErrorInfo(err.cause);
    }
    // Get the default string representation of this object
    let defaultToString = err.toString === undefined ? null : err.toString();
    if (defaultToString && defaultToString != '[object Object]') { // Ensure the string representation is meaningful
        // If we have no error message yet, use this
        if (!strErr)
            strErr = defaultToString
        // Add the error message if the stack didn't already include it (it doesn't always: https://mtsknn.fi/blog/js-error-stack/ )
        else if (!err.stack || !err.stack.includes(defaultToString))
            strErr = `${defaultToString}\n  ${strErr}`;
    }
    if (strErr) return strErr.trimEnd(); // Some stack traces have trailing line breaks.
    // Other types will be serialized
    let typeName = typeof err; // Get the type thrown
    // If the type is an "object", try to get its name from the constructor name (may be minified)
    if (typeName == 'object') typeName = `${typeName} (${err.constructor.name})`;
    return `non-Error type thrown: ${typeName}` +
        ' { ' + Object.keys(err).map(key => `${key}: ${err[key]}`).join(', ') + ' }';
}

/** Helper to log a message, and optionally also tprint it and toast it
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {string} message The message to display
 * @param {boolean} alsoPrintToTerminal Set to true to print not only to the current script's tail file, but to the terminal
 * @param {""|"success"|"warning"|"error"|"info"} toastStyle - If specified, your log will will also become a toast notification
 * @param {int} */
export function log(ns, message = "", alsoPrintToTerminal = false, toastStyle = "", maxToastLength = Number.MAX_SAFE_INTEGER) {
    checkNsInstance(ns, '"log"');
    ns.print(message);
    if (toastStyle) ns.toast(message.length <= maxToastLength ? message : message.substring(0, maxToastLength - 3) + "...", toastStyle);
    if (alsoPrintToTerminal) {
        ns.tprint(message);
        // TODO: Find a way write things logged to the terminal to a "permanent" terminal log file, preferably without this becoming an async function.
        //       Perhaps we copy logs to a port so that a separate script can optionally pop and append them to a file.
        //ns.write("log.terminal.txt", message + '\n', 'a'); // Note: we should get away with not awaiting this promise since it's not a script file
    }
    return message;
}

/** Helper to get a list of all hostnames on the network
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @returns {string[]} **/
export function scanAllServers(ns) {
    checkNsInstance(ns, '"scanAllServers"');
    let discoveredHosts = []; // Hosts (a.k.a. servers) we have scanned
    let hostsToScan = ["home"]; // Hosts we know about, but have no yet scanned
    let infiniteLoopProtection = 9999; // In case you mess with this code, this should save you from getting stuck
    while (hostsToScan.length > 0 && infiniteLoopProtection-- > 0) { // Loop until the list of hosts to scan is empty
        let hostName = hostsToScan.pop(); // Get the next host to be scanned
        discoveredHosts.push(hostName); // Mark this host as "scanned"
        for (const connectedHost of ns.scan(hostName)) // "scan" (list all hosts connected to this one)
            if (!discoveredHosts.includes(connectedHost) && !hostsToScan.includes(connectedHost)) // If we haven't found this host
                hostsToScan.push(connectedHost); // Add it to the queue of hosts to be scanned
    }
    return discoveredHosts; // The list of scanned hosts should now be the set of all hosts in the game!
}

/** Get a dictionary of active source files, taking into account the current active bitNode as well (optionally disabled).
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {bool} includeLevelsFromCurrentBitnode Set to true to use the current bitNode number to infer the effective source code level (for purposes of determining what features are unlocked)
 * @param {bool} silent Set to true if you want to minimize logging errors (e.g. due to not owning singularity or having insufficient RAM)
 * @returns {Promise<{[k: number]: number}>} A dictionary keyed by source file number, where the value is the level (between 1 and 3 for all but BN12) **/
export async function getActiveSourceFiles(ns, includeLevelsFromCurrentBitnode = true, silent = true) {
    return await getActiveSourceFiles_Custom(ns, getNsDataThroughFile, includeLevelsFromCurrentBitnode, silent);
}

/** getActiveSourceFiles Helper that allows the user to pass in their chosen implementation of getNsDataThroughFile to minimize RAM usage
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {(ns: NS, command: string, fName?: string, args?: any, verbose?: any, maxRetries?: number, retryDelayMs?: number, silent?: bool) => Promise<any>} fnGetNsDataThroughFile getActiveSourceFiles Helper that allows the user to pass in their chosen implementation of getNsDataThroughFile to minimize RAM usage
 * @param {bool} includeLevelsFromCurrentBitnode Set to true to use the current bitNode number to infer the effective source code level (for purposes of determining what features are unlocked)
 * @param {bool} silent Set to true if you want to minimize logging errors (e.g. due to not owning singularity or having insufficient RAM)
 * @returns {Promise<{[k: number]: number}>} A dictionary keyed by source file number, where the value is the level (between 1 and 3 for all but BN12) **/
export async function getActiveSourceFiles_Custom(ns, fnGetNsDataThroughFile, includeLevelsFromCurrentBitnode = true, silent = true) {
    checkNsInstance(ns, '"getActiveSourceFiles"');
    // Find out what source files the user has unlocked
    let dictSourceFiles = (/**@returns{{[bitNodeN: number]: number;}}*/() => null)();
    try {
        dictSourceFiles = await fnGetNsDataThroughFile(ns,
            `Object.fromEntries(ns.singularity.getOwnedSourceFiles().map(sf => [sf.n, sf.lvl]))`,
            '/Temp/getOwnedSourceFiles-asDict.txt', null, null, null, null, silent);
    } catch { } // If this fails (e.g. presumably due to low RAM or no singularity access), default to an empty dictionary
    dictSourceFiles ??= {};

    // Try to get reset info
    let resetInfo = (/**@returns{ResetInfo}*/() => null)();
    try {
        resetInfo = await fnGetNsDataThroughFile(ns, 'ns.getResetInfo()', null, null, null, null, null, silent);
    } catch { } // As above, suppress any errors and use a fall-back to survive low ram conditions.
    resetInfo ??= { currentNode: 0 }

    // If the user is currently in a given bitnode, they will have its features unlocked. Include these "effective" levels if requested;
    if (includeLevelsFromCurrentBitnode && resetInfo.currentNode != 0) {
        // In some Bitnodes, we get the *effects* of source file level 3 just by being in the bitnode
        // TODO: This is true of some BNs (BN4), but not others (BN14.2), Check them all!
        let effectiveSfLevel = [4, 8].includes(resetInfo.currentNode) ? 3 : 1;
        dictSourceFiles[resetInfo.currentNode] = Math.max(effectiveSfLevel, dictSourceFiles[resetInfo.currentNode] || 0);
    }

    // If any bitNodeOptions were set, it might reduce our source file levels for gameplay purposes,
    // but the game currently has a bug where getOwnedSourceFiles won't reflect this, so we must do it ourselves.
    if ((resetInfo?.bitNodeOptions?.sourceFileOverrides?.size ?? 0) > 0) {
        resetInfo.bitNodeOptions.sourceFileOverrides.forEach((sfLevel, bn) => dictSourceFiles[bn] = sfLevel);
        // Completely remove keys whose override level is 0
        Object.keys(dictSourceFiles).filter(bn => dictSourceFiles[bn] == 0).forEach(bn => delete dictSourceFiles[bn]);
    }

    return dictSourceFiles;
}

/** Return bitNode multiplers, or a best guess based on hard-coded values if they cannot currently be retrieved (no SF5, or insufficient RAM)
 *  @param {NS} ns The nestcript instance passed to your script's main entry point
 * @returns {Promise<BitNodeMultipliers>} the current bitNode multipliers, or a best guess if we do not currently have access. */
export async function tryGetBitNodeMultipliers(ns) {
    return await tryGetBitNodeMultipliers_Custom(ns, getNsDataThroughFile);
}

/** tryGetBitNodeMultipliers Helper that allows the user to pass in their chosen implementation of getNsDataThroughFile to minimize RAM usage
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {(ns: NS, command: string, fName?: string, args?: any, verbose?: any, maxRetries?: number, retryDelayMs?: number, silent?: bool) => Promise<any>} fnGetNsDataThroughFile getActiveSourceFiles Helper that allows the user to pass in their chosen implementation of getNsDataThroughFile to minimize RAM usage
 * @returns {Promise<BitNodeMultipliers>} the current bitNode multipliers, or a best guess if we do not currently have access. */
export async function tryGetBitNodeMultipliers_Custom(ns, fnGetNsDataThroughFile) {
    checkNsInstance(ns, '"tryGetBitNodeMultipliers"');
    let canGetBitNodeMultipliers = false;
    try { // We use make use of the "silent" parameter in our requests below because we have a fall-back for low-ram conditions, and don't want to confuse the player with warning/error logs
        canGetBitNodeMultipliers = 5 in (await getActiveSourceFiles_Custom(ns, fnGetNsDataThroughFile, /*silent:*/true));
    } catch { }
    if (canGetBitNodeMultipliers) {
        try {
            return await fnGetNsDataThroughFile(ns, 'ns.getBitNodeMultipliers()', '/Temp/bitNode-multipliers.txt', null, null, null, null, /*silent:*/true);
        } catch { }
    }
    return await getHardCodedBitNodeMultipliers(ns, fnGetNsDataThroughFile);
}

/** Cheeky hard-coded values stolen from https://github.com/bitburner-official/bitburner-src/blob/dev/src/BitNode/BitNode.tsx#L456
 *  so that we essentially can provide bitNode multipliers even without SF-5 or sufficient RAM to request them.
 *  We still prefer to use the API though, this is just a a fallback, but it may become stale over time.
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {(ns: NS, command: string, fName?: string, args?: any, verbose?: any, maxRetries?: number, retryDelayMs?: number) => Promise<any>} fnGetNsDataThroughFile getActiveSourceFiles Helper that allows the user to pass in their chosen implementation of getNsDataThroughFile to minimize RAM usage
 * @param {number} bnOverride The bitnode for which to retrieve multipliers. Defaults to the current BN if null.
 * @returns {Promise<BitNodeMultipliers>} a mocked BitNodeMultipliers instance with hard-coded values. */
export async function getHardCodedBitNodeMultipliers(ns, fnGetNsDataThroughFile, bnOverride = null) {
    let bn = bnOverride ?? 1;
    if (!bnOverride) {
        try { bn = (await fnGetNsDataThroughFile(ns, 'ns.getResetInfo()', '/Temp/reset-info.txt')).currentNode; }
        catch { /* We are expected to be fault-tolerant in low-ram conditions */ }
    }
    return Object.fromEntries(Object.entries({
        AgilityLevelMultiplier: /*     */[1, 1, 1, 1, 1, 1, 1, 1, 0.45, 0.4, 1, 1, 0.7, 0.5],
        AugmentationMoneyCost: /*      */[1, 1, 3, 1, 2, 1, 3, 1, 1, 5, 2, 1, 1, 1.5],
        AugmentationRepCost: /*        */[1, 1, 3, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1],
        BladeburnerRank: /*            */[1, 1, 1, 1, 1, 1, 0.6, 0, 0.9, 0.8, 1, 1, 0.45, 0.6],
        BladeburnerSkillCost: /*       */[1, 1, 1, 1, 1, 1, 2, 1, 1.2, 1, 1, 1, 2, 2],
        CharismaLevelMultiplier: /*    */[1, 1, 1, 1, 1, 1, 1, 1, 0.45, 0.4, 1, 1, 1, 1],
        ClassGymExpGain: /*            */[1, 1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 1],
        CodingContractMoney: /*        */[1, 1, 1, 1, 1, 1, 1, 0, 1, 0.5, 0.25, 1, 0.4, 1],
        CompanyWorkExpGain: /*         */[1, 1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 1],
        CompanyWorkMoney: /*           */[1, 1, 0.25, 0.1, 1, 0.5, 0.5, 0, 1, 0.5, 0.5, 1, 0.4, 1],
        CompanyWorkRepGain: /*         */[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.2],
        CorporationDivisions: /*       */[1, 0.9, 1, 1, 0.75, 0.8, 0.8, 0, 0.8, 0.9, 0.9, 0.5, 0.4, 0.8],
        CorporationSoftcap: /*         */[1, 0.9, 1, 1, 1, 0.9, 0.9, 0, 0.75, 0.9, 0.9, 0.8, 0.4, 0.9],
        CorporationValuation: /*       */[1, 1, 1, 1, 0.75, 0.2, 0.2, 0, 0.5, 0.5, 0.1, 1, 0.001, 0.4],
        CrimeExpGain: /*               */[1, 1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 1],
        CrimeMoney: /*                 */[1, 3, 0.25, 0.2, 0.5, 0.75, 0.75, 0, 0.5, 0.5, 3, 1, 0.4, 0.75],
        CrimeSuccessRate: /*           */[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.4],
        DaedalusAugsRequirement: /*    */[30, 30, 30, 30, 30, 35, 35, 30, 30, 30, 30, 31, 30, 30],
        DefenseLevelMultiplier: /*     */[1, 1, 1, 1, 1, 1, 1, 1, 0.45, 0.4, 1, 1, 0.7, 1],
        DexterityLevelMultiplier: /*   */[1, 1, 1, 1, 1, 1, 1, 1, 0.45, 0.4, 1, 1, 0.7, 0.5],
        FactionPassiveRepGain: /*      */[1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        FactionWorkExpGain: /*         */[1, 1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 1],
        FactionWorkRepGain: /*         */[1, 0.5, 1, 0.75, 1, 1, 1, 1, 1, 1, 1, 1, 0.6, 0.2],
        FourSigmaMarketDataApiCost: /* */[1, 1, 1, 1, 1, 1, 2, 1, 4, 1, 4, 1, 10, 1],
        FourSigmaMarketDataCost: /*    */[1, 1, 1, 1, 1, 1, 2, 1, 5, 1, 4, 1, 10, 1],
        GangSoftcap: /*                */[1, 1, 0.9, 1, 1, 0.7, 0.7, 0, 0.8, 0.9, 1, 0.8, 0.3, 0.7],
        GangUniqueAugs: /*             */[1, 1, 0.5, 0.5, 0.5, 0.2, 0.2, 0, 0.25, 0.25, 0.75, 1, 0.1, 0.4],
        GoPower: /*                    */[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4],
        HackExpGain: /*                */[1, 1, 1, 0.4, 0.5, 0.25, 0.25, 1, 0.05, 1, 0.5, 1, 0.1, 1],
        HackingLevelMultiplier: /*     */[1, 0.8, 0.8, 1, 1, 0.35, 0.35, 1, 0.5, 0.35, 0.6, 1, 0.25, 0.4],
        HackingSpeedMultiplier: /*     */[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.3],
        HacknetNodeMoney: /*           */[1, 1, 0.25, 0.05, 0.2, 0.2, 0.2, 0, 1, 0.5, 0.1, 1, 0.4, 0.25],
        HomeComputerRamCost: /*        */[1, 1, 1.5, 1, 1, 1, 1, 1, 5, 1.5, 1, 1, 1, 1],
        InfiltrationMoney: /*          */[1, 3, 1, 1, 1.5, 0.75, 0.75, 0, 1, 0.5, 2.5, 1, 1, 0.75],
        InfiltrationRep: /*            */[1, 1, 1, 1, 1.5, 1, 1, 1, 1, 1, 2.5, 1, 1, 1],
        ManualHackMoney: /*            */[1, 1, 1, 1, 1, 1, 1, 0, 1, 0.5, 1, 1, 1, 1],
        PurchasedServerCost: /*        */[1, 1, 2, 1, 1, 1, 1, 1, 1, 5, 1, 1, 1, 1],
        PurchasedServerSoftcap: /*     */[1, 1.3, 1.3, 1.2, 1.2, 2, 2, 4, 1, 1.1, 2, 1, 1.6, 1],
        PurchasedServerLimit: /*       */[1, 1, 1, 1, 1, 1, 1, 1, 0, 0.6, 1, 1, 1, 1],
        PurchasedServerMaxRam: /*      */[1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 1, 1, 1, 1],
        RepToDonateToFaction: /*       */[1, 1, 0.5, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1],
        ScriptHackMoney: /*            */[1, 1, 0.2, 0.2, 0.15, 0.75, 0.5, 0.3, 0.1, 0.5, 1, 1, 0.2, 0.3],
        ScriptHackMoneyGain: /*        */[1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1],
        ServerGrowthRate: /*           */[1, 0.8, 0.2, 1, 1, 1, 1, 1, 1, 1, 0.2, 1, 1, 1],
        ServerMaxMoney: /*             */[1, 0.08, 0.04, 0.1125, 1, 0.2, 0.2, 1, 0.01, 1, 0.01, 1, 0.3375, 0.7],
        ServerStartingMoney: /*        */[1, 0.4, 0.2, 0.75, 0.5, 0.5, 0.5, 1, 0.1, 1, 0.1, 1, 0.75, 0.5],
        ServerStartingSecurity: /*     */[1, 1, 1, 1, 2, 1.5, 1.5, 1, 2.5, 1, 1, 1.5, 3, 1.5],
        ServerWeakenRate: /*           */[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1],
        StrengthLevelMultiplier: /*    */[1, 1, 1, 1, 1, 1, 1, 1, 0.45, 0.4, 1, 1, 0.7, 0.5],
        StaneksGiftPowerMultiplier: /* */[1, 2, 0.75, 1.5, 1.3, 0.5, 0.9, 1, 0.5, 0.75, 1, 1, 2, 0.5],
        StaneksGiftExtraSize: /*       */[0, -6, -2, 0, 0, 2, -1, -99, 2, -3, 0, 1, 1, -1],
        WorldDaemonDifficulty: /*      */[1, 5, 2, 3, 1.5, 2, 2, 1, 2, 2, 1.5, 1, 3, 5]
    }).map(([mult, values]) => [mult, values[bn - 1]]));
}

/** Returns the number of instances of the current script running on the specified host.
 *  Uses ram-dodging (which costs 1GB for ns.run if you aren't already using it.
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {string} onHost - The host to search for the script on
 * @param {boolean} warn - Whether to automatically log a warning when there are more than other running instances
 * @param {tailOtherInstances} warn - Whether to open the tail window of other running instances so that they can be easily killed
 * @returns {Promise<number>} The number of other instance of this script running on this host. */
export async function instanceCount(ns, onHost = "home", warn = true, tailOtherInstances = true) {
    checkNsInstance(ns, '"alreadyRunning"');
    const scriptName = ns.getScriptName();
    let otherInstancePids = (/**@returns{number[]}*/() => [])();
    try {
        otherInstancePids = await getNsDataThroughFile(ns, 'ns.ps(ns.args[0]).filter(p => p.filename == ns.args[1]).map(p => p.pid)',
            '/Temp/ps-other-instances.txt', [onHost, scriptName]);
    } catch (err) {
        if (err.message?.includes("insufficient RAM") ?? false) {
            log(ns, `ERROR: Not enough free RAM on ${onHost} to run ${scriptName}.` +
                `\nBuy more RAM or kill some other scripts first.` +
                `\nYou can run the 'top' command from the terminal to see what scripts are using RAM.`, true, 'error');
            return 2;
        }
        else throw err;
    }
    if (otherInstancePids.length >= 2) {
        if (warn)
            log(ns, `WARNING: You cannot start multiple versions of this script (${scriptName}). Please shut down the other instance(s) first: ${otherInstancePids}` +
                (tailOtherInstances ? ' (To help with this, a tail window for the other instance will be opened)' : ''), true, 'warning');
        if (tailOtherInstances) // Tail all but the last pid, since it will belong to the current instance (which will be shut down)
            otherInstancePids.slice(0, otherInstancePids.length - 1).forEach(pid => tail(ns, pid));
    }
    //ns.tprint(`instanceCount: ${otherInstancePids.length}\n  ${new Error().stack.replaceAll("@", "   @").replaceAll("\n", "\n  ")}\n\n`)
    return otherInstancePids.length;
}

/** Helper function to get all stock symbols, or null if you do not have TIX api access.
 *  @param {NS} ns The nestcript instance passed to your script's main entry point
 * @returns {Promise<string[]>} array of stock symbols */
export async function getStockSymbols(ns) {
    return await getNsDataThroughFile(ns,
        `(() => { try { return ns.stock.getSymbols(); } catch { return null; } })()`,
        '/Temp/stock-symbols.txt');
}

/** Helper function to get the total value of stocks using as little RAM as possible.
 *  @param {NS} ns The nestcript instance passed to your script's main entry point
 * @returns {Promise<number>} The current total dollar value of all owned stocks */
export async function getStocksValue(ns) {
    let stockSymbols = await getStockSymbols(ns);
    if (stockSymbols == null) return 0; // No TIX API Access
    const stockGetAll = async (fn) => await getNsDataThroughFile(ns,
        `(() => { try { return Object.fromEntries(ns.args.map(sym => [sym, ns.stock.${fn}(sym)])); } catch { return null; } })()`,
        `/Temp/stock-${fn}-all.txt`, stockSymbols);
    const askPrices = await stockGetAll('getAskPrice');
    // Workaround for Bug #304: If we lost TIX access, our cache of stock symbols will still be valid, but we won't be able to get prices.
    if (askPrices == null) return 0; // No TIX API Access
    const bidPrices = await stockGetAll('getBidPrice');
    const positions = await stockGetAll('getPosition');
    return stockSymbols.map(sym => ({ sym, pos: positions[sym], ask: askPrices[sym], bid: bidPrices[sym] }))
        .reduce((total, stk) => total + (stk.pos[0] * stk.bid) /* Long Value */ + stk.pos[2] * (stk.pos[3] * 2 - stk.ask) /* Short Value */
            // Subtract commission only if we have one or more shares (this is money we won't get when we sell our position)
            // If for some crazy reason we have shares both in the short and long position, we'll have to pay the commission twice (two separate sales)
            - 100000 * (Math.sign(stk.pos[0]) + Math.sign(stk.pos[2])), 0);
}

/** Returns a helpful error message if we forgot to pass the ns instance to a function
 *  @param {NS} ns The nestcript instance passed to your script's main entry point */
export function checkNsInstance(ns, fnName = "this function") {
    if (ns === undefined || !ns.print) throw new Error(`The first argument to function ${fnName} should be a 'ns' instance.`);
    return ns;
}

/** A helper to parse the command line arguments with a bunch of extra features, such as
 * - Loading a persistent defaults override from a local config file named after the script.
 * - Rendering "--help" output without all scripts having to explicitly specify it
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {[string, string | number | boolean | string[]][]} argsSchema - Specification of possible command line args. **/
export function getConfiguration(ns, argsSchema) {
    checkNsInstance(ns, '"getConfig"');
    const scriptName = ns.getScriptName();
    // If the user has a local config file, override the defaults in the argsSchema
    const confName = `${scriptName}.config.txt`;
    const overrides = ns.read(confName);
    const overriddenSchema = overrides ? [...argsSchema] : argsSchema; // Clone the original args schema
    const dictArgsSchema = Object.fromEntries(argsSchema);
    if (overrides) {
        try {
            let parsedOverrides = JSON.parse(overrides, jsonReviver); // Expect a parsable dict or array of 2-element arrays like args schema
            if (Array.isArray(parsedOverrides)) parsedOverrides = Object.fromEntries(parsedOverrides);
            log(ns, `INFO: Applying ${Object.keys(parsedOverrides).length} overriding default arguments from "${confName}"...`);
            for (const key in parsedOverrides) {
                const override = parsedOverrides[key];
                const matchIndex = overriddenSchema.findIndex(o => o[0] == key);
                const match = matchIndex === -1 ? null : overriddenSchema[matchIndex];
                const strDefaultValue = match[1] === undefined ? "undefined" : JSON.stringify(match[1], jsonReplacer);
                const strFinalValue = override === undefined ? "undefined" : JSON.stringify(override, jsonReplacer);
                if (!match)
                    throw new Error(`Unrecognized key "${key}" does not match any of this script's options: ` + JSON.stringify(argsSchema.map(a => a[0])));
                else if (override === undefined)
                    throw new Error(`The key "${key}" appeared in the config with no value. Some value must be provided. Try null?`);
                else if (match && strDefaultValue != strFinalValue) {
                    log(ns, `INFO: Overriding "${key}" value: ${strDefaultValue}  ->  ${strFinalValue}`);
                    overriddenSchema[matchIndex] = { ...match }; // Clone the (previously shallow-copied) object at this position of the new argsSchema
                    overriddenSchema[matchIndex][1] = override; // Update the value of the clone.
                }
            }
        } catch (err) {
            log(ns, `ERROR: There's something wrong with your config file "${confName}", it cannot be loaded.` +
                `\nThe error encountered was: ${getErrorInfo(err)}` +
                `\nYour config file should either be a dictionary e.g.: { "string-opt": "value", "num-opt": 123, "array-opt": ["one", "two"] }` +
                `\nor an array of dict entries (2-element arrays) e.g.: [ ["string-opt", "value"], ["num-opt", 123], ["array-opt", ["one", "two"]] ]` +
                `\n"${confName}" contains:\n${overrides}`, true, 'error', 80);
            return null;
        }
    }
    // Return the result of using the in-game args parser to combine the defaults with the command line args provided
    try {
        // TODO: ns.flags will aggressively convert args to the destination type, rather than produce an error.
        // For example, passing in a value of "1m" for a numeric arg will result in a value of Number.NaN being passed,
        // rather than appropriately notifying the user that "1m" is a string, so not a valid value (resulting in Bug #237 )
        // As a result, we may wish to stop using ns.flags below and implement our own arg parsing, as painful as that may be.
        const finalOptions = ns.flags(overriddenSchema);
        // Summarize the final set of settings the script is being run with
        log(ns, `INFO: Running ${scriptName} with the following settings:` +
            Object.keys(finalOptions).filter(a => a != "_").map(key => {
                const defaultValue = dictArgsSchema[key];
                const finalValue = finalOptions[key];
                const strDefaultValue = defaultValue === undefined ? "undefined" : JSON.stringify(defaultValue, jsonReplacer);
                const strFinalValue = finalValue === undefined ? "undefined" : JSON.stringify(finalValue, jsonReplacer);
                // Log a warning to the terminal if an argument was filled in with an different type than the default value.
                if ((typeof finalValue) !== (typeof defaultValue) && defaultValue != null)
                    log(ns, `WARNING: A configuration value provided (${key}=${strFinalValue} - type="${typeof finalValue}") ` +
                        `does not match the expected type "${typeof defaultValue}" based on the default value ` +
                        `(${key}=${strDefaultValue}). The script may behave unpredictably.`, true, 'warning');
                if (finalValue !== defaultValue && (typeof finalValue == 'number') && Number.isNaN(finalValue))
                    log(ns, `WARNING: A numeric configuration value (--${key}) got a value of "NaN" (Not a Number), ` +
                        `which likely indicates it was set to a string value that could not be parsed. ` +
                        `The script may behave unpredictably. Please double-check the script arguments for mistakes or typos.`);
                // Outputs a single config summary row
                return `\n  ${key.length == 1 ? "-" : "--"}${key} = ${strFinalValue}` +
                    // Display the default that was overridden, if it doesn't match the configured value
                    (strDefaultValue == strFinalValue ? '' : ` (changed from default value of ${strDefaultValue})`);
            }).join("") + `\nrun ${scriptName} --help  to get more information about these options.`);
        return finalOptions;
    } catch (err) {
        // Detect if the user passed invalid arguments, and return help text
        // If the user explictly asked for --help, suppress the parsing error
        const error = ns.args.includes("help") || ns.args.includes("--help") ? null : getErrorInfo(err);
        // Try to parse documentation about each argument from the source code's comments
        const source = ns.read(scriptName).split("\n");
        let argsRow = 1 + source.findIndex(row => row.includes("argsSchema ="));
        const optionDescriptions = {}
        while (argsRow && argsRow < source.length) {
            const nextArgRow = source[argsRow++].trim();
            if (nextArgRow.length == 0) continue;
            if (nextArgRow[0] == "]" || nextArgRow.includes(";")) break; // We've reached the end of the args schema
            const commentSplit = nextArgRow.split("//").map(e => e.trim());
            if (commentSplit.length != 2) continue; // This row doesn't appear to be in the format: [option...], // Comment
            const optionSplit = commentSplit[0].split("'"); // Expect something like: ['name', someDefault]. All we need is the name
            if (optionSplit.length < 2) continue;
            optionDescriptions[optionSplit[1]] = commentSplit[1];
        }
        log(ns, (error ? `ERROR: There was an error parsing the script arguments provided: ${error}\n` : 'INFO: ') +
            `${scriptName} possible arguments:` + argsSchema.map(a => `\n  ${a[0].length == 1 ? " -" : "--"}${a[0].padEnd(30)} ` +
                `Default: ${(a[1] === null ? "null" : (JSON.stringify(a[1]) ?? "undefined")).padEnd(10)}` +
                (a[0] in optionDescriptions ? ` // ${optionDescriptions[a[0]]}` : '')).join("") + '\n' +
            `\nTip: All argument names, and some values support auto-complete. Hit the <tab> key to autocomplete or see possible options.` +
            `\nTip: Array arguments are populated by specifying the argument multiple times, e.g.:` +
            `\n       run ${scriptName} --arrayArg first --arrayArg second --arrayArg third  to run the script with arrayArg=[first, second, third]` +
            (!overrides ? `\nTip: You can override the default values by creating a config file named "${confName}" containing e.g.: { "arg-name": "preferredValue" }`
                : overrides && !error ? `\nNote: The default values are being modified by overrides in your local "${confName}":\n${overrides}`
                    : `\nThis error may have been caused by your local overriding "${confName}" (especially if you changed the types of any options):\n${overrides}`), true);
        return null; // Caller should handle null and shut down elegantly.
    }
}

/** In order to pass in args to pass along to the startup/completion script, they may have to be quoted, when given as
 * parameters to this script, but those quotes will have to be stripped when passing these along to a subsequent script as raw strings.
 * @param {string[]} args - The the array-argument passed to the script.
 * @returns {string[]} The the array-argument unescaped (or deserialized if a single argument starting with '[' was supplied]). */
export function unEscapeArrayArgs(args) {
    // For convenience, also support args as a single stringified array
    if (args.length == 1 && args[0].startsWith("[")) return JSON.parse(args[0]);
    // Otherwise, args wrapped in quotes should have those quotes removed.
    const escapeChars = ['"', "'", "`"];
    return args.map(arg => escapeChars.some(c => arg.startsWith(c) && arg.endsWith(c)) ? arg.slice(1, -1) : arg);
}

/**
 * Custom tail function which also applies default resizes and tail window placement.
 * This algorithm is not perfect but for the most part should not generate overlaps of the window's title bar.
 * @param {NS} ns The nestcript instance passed to your script's main entry point
 * @param {number|undefined} processId The id of the process to tail, or null to use the current process id
 */
export function tail(ns, processId = undefined) {
    checkNsInstance(ns, '"tail"');
    processId ??= ns.pid
    ns.ui.openTail(processId);
    // Don't move or resize tail windows that were previously opened and possibly moved by the player
    const tailFile = '/Temp/helpers-tailed-pids.txt'; // Use a file so it can be wiped on reset
    const fileContents = ns.read(tailFile);
    const tailedPids = fileContents.length > 1 ? JSON.parse(fileContents) : [];
    if (tailedPids.includes(processId))
        return //ns.tprint(`PID was previously moved ${processId}`);
    // By default, make all tail windows take up 75% of the width, 25% of the height available
    const [width, height] = ns.ui.windowSize();
    ns.ui.resizeTail(width * 0.60, height * 0.25, processId);
    // Cascade windows: After each tail, shift the window slightly down and over so that they don't overlap
    let offsetPct = ((((tailedPids.length % 30.0) / 30.0) + tailedPids.length) % 6.0) / 6.0;
    ns.print(width, ' ', height, ' ', processId, ' ', offsetPct, ' ', tailedPids)
    ns.ui.moveTail(offsetPct * (width * 0.25 - 300) + 250, offsetPct * (height * 0.75 - 100) + 50, processId);
    tailedPids.push(processId);
    ns.write(tailFile, JSON.stringify(tailedPids), 'w');
}