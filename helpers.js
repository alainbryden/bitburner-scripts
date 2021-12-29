/**
 * Return a formatted representation of the monetary amount using scale sympols (e.g. $6.50M)
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
    for (var i = 0, sign = Math.sign(num), num = Math.abs(num); num >= 1000 && i < symbols.length; i++) num /= 1000;
    // TODO: A number like 9.999 once rounted to show 3 sig figs, will become 10.00, which is now 4 sig figs.
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
 * Return a number formatted with the specified number of significatnt figures or decimal places, whichever is more limiting.
 * @param {number} num - The number to format
 * @param {number=} minSignificantFigures - (default: 6) The minimum significant figures you wish to see (e.g. 123, 12.3 and 1.23 all have 3 significant figures)
 * @param {number=} minDecimalPlaces - (default: 3) The minimum decimal places you wish to see, regardless of significant figures. (e.g. 12.3, 1.2, 0.1 all have 1 decimal)
 **/
export function formatNumber(num, minSignificantFigures = 3, minDecimalPlaces = 1) {
    return num == 0.0 ? num : num.toFixed(Math.max(minDecimalPlaces, Math.max(0, minSignificantFigures - Math.ceil(Math.log10(num)))));
}

/** Formats some RAM amount as a round number of GB with thousands separators e.g. `1,028 GB` */
export function formatRam(num) { return `${Math.round(num).toLocaleString()} GB`; }

/** Return a datatime in ISO format */
export function formatDateTime(datetime) { return datetime.toISOString(); }

/** Format a duration (in milliseconds) as e.g. '1h 21m 6s' for big durations or e.g '12.5s' / '23ms' for small durations */
export function formatDuration(duration) {
    if (duration < 1000) return `${duration.toFixed(0)}ms`
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
 *  Use where a function is required to run a script and you have already referenced ns.exec in your script  */
export function getFnIsAliveViaNsPs(ns) {
    checkNsInstance(ns, '"getFnIsAliveViaNsPs"');
    return function (pid, host) { return ns.ps(host).some(process => process.pid === pid); }
}

/**
 * Retrieve the result of an ns command by executing it in a temporary .js script, writing the result to a file, then shuting it down
 * Importing incurs a maximum of 1.1 GB RAM (0 GB for ns.read, 1 GB for ns.run, 0.1 GB for ns.isRunning).
 * Has the capacity to retry if there is a failure (e.g. due to lack of RAM available). Not recommended for performance-critical code.
 * @param {NS} ns - The nestcript instance passed to your script's main entry point
 * @param {string} command - The ns command that should be invoked to get the desired data (e.g. "ns.getServer('home')" )
 * @param {string=} fName - (default "/Temp/{commandhash}-data.txt") The name of the file to which data will be written to disk by a temporary process
 * @param {bool=} verbose - (default false) If set to true, pid and result of command are logged.
 **/
export async function getNsDataThroughFile(ns, command, fName, verbose = false, maxRetries = 5, retryDelayMs = 50) {
    checkNsInstance(ns, '"getNsDataThroughFile"');
    if (!verbose) disableLogs(ns, ['run', 'isRunning']);
    return await getNsDataThroughFile_Custom(ns, ns.run, ns.isRunning, command, fName, verbose, maxRetries, retryDelayMs);
}

/**
 * An advanced version of getNsDataThroughFile that lets you pass your own "fnRun" and "fnIsAlive" implementations to reduce RAM requirements
 * Importing incurs no RAM (now that ns.read is free) plus whatever fnRun / fnIsAlive you provide it
 * Has the capacity to retry if there is a failure (e.g. due to lack of RAM available). Not recommended for performance-critical code.
 * @param {NS} ns - The nestcript instance passed to your script's main entry point
 * @param {function} fnRun - A single-argument function used to start the new sript, e.g. `ns.run` or `(f,...args) => ns.exec(f, "home", ...args)`
 * @param {function} fnIsAlive - A single-argument function used to start the new sript, e.g. `ns.isRunning` or `pid => ns.ps("home").some(process => process.pid === pid)`
 **/
export async function getNsDataThroughFile_Custom(ns, fnRun, fnIsAlive, command, fName, verbose = false, maxRetries = 5, retryDelayMs = 50) {
    checkNsInstance(ns, '"getNsDataThroughFile_Custom"');
    if (!verbose) disableLogs(ns, ['read']);
    const commandHash = hashCode(command);
    fName = fName || `/Temp/${commandHash}-data.txt`;
    const fNameCommand = (fName || `/Temp/${commandHash}-command`) + '.js'
    // Prepare a command that will write out a new file containing the results of the command
    // unless it already exists with the same contents (saves time/ram to check first)
    // If an error occurs, it will write an empty file to avoid old results being misread.
    const commandToFile = `let result = ""; try { result = JSON.stringify(${command}); } catch { }
        if (ns.read("${fName}") != result) await ns.write("${fName}", result, 'w')`;
    // Run the command with auto-retries if it fails
    const pid = await runCommand_Custom(ns, fnRun, commandToFile, fNameCommand, false, maxRetries, retryDelayMs);
    // Wait for the process to complete
    await waitForProcessToComplete_Custom(ns, fnIsAlive, pid, verbose);
    if (verbose) ns.print(`Process ${pid} is done. Reading the contents of ${fName}...`);
    // Read the file, with auto-retries if it fails
    const fileData = await autoRetry(ns, () => ns.read(fName), f => f !== undefined && f !== "",
        () => `ns.read('${fName}') somehow returned undefined or an empty string`,
        maxRetries, retryDelayMs, undefined, verbose);
    if (verbose) ns.print(`Read the following data for command ${command}:\n${fileData}`);
    return JSON.parse(fileData); // Deserialize it back into an object/array and return
}

/** Evaluate an arbitrary ns command by writing it to a new script and then running or executing it.
 * @param {NS} ns - The nestcript instance passed to your script's main entry point
 * @param {string} command - The ns command that should be invoked to get the desired data (e.g. "ns.getServer('home')" )
 * @param {string=} fileName - (default "/Temp/{commandhash}-data.txt") The name of the file to which data will be written to disk by a temporary process
 * @param {bool=} verbose - (default false) If set to true, the evaluation result of the command is printed to the terminal
 * @param {...args} args - args to be passed in as arguments to command being run as a new script.
 */
export async function runCommand(ns, command, fileName, verbose = false, maxRetries = 5, retryDelayMs = 50, ...args) {
    checkNsInstance(ns, '"runCommand"');
    if (!verbose) disableLogs(ns, ['run', 'sleep']);
    return await runCommand_Custom(ns, ns.run, command, fileName, verbose, maxRetries, retryDelayMs, ...args);
}

/**
 * An advanced version of runCommand that lets you pass your own "isAlive" test to reduce RAM requirements (e.g. to avoid referencing ns.isRunning)
 * Importing incurs 0 GB RAM (assuming fnRun, fnWrite are implemented using another ns function you already reference elsewhere like ns.exec)
 * @param {NS} ns - The nestcript instance passed to your script's main entry point
 * @param {function} fnRun - A single-argument function used to start the new sript, e.g. `ns.run` or `(f,...args) => ns.exec(f, "home", ...args)`
 **/
export async function runCommand_Custom(ns, fnRun, command, fileName, verbose = false, maxRetries = 5, retryDelayMs = 50, ...args) {
    checkNsInstance(ns, '"runCommand_Custom"');
    let script = `import { formatMoney, formatNumberShort, formatDuration, parseShortNumber, scanAllServers } fr` + `om "helpers.js"\n` +
        `export async function main(ns) { try { ` +
        (verbose ? `let output = ${command}; ns.tprint(output)` : command) +
        `; } catch(err) { ns.tprint(String(err)); throw(err); } }`;
    fileName = fileName || `/Temp/${hashCode(command)}-command.js`;
    // To improve performance and save on garbage collection, we can skip writing this exact same script was previously written (common for repeatedly-queried data)
    if (ns.read(fileName) != script) await ns.write(fileName, script, "w");
    return await autoRetry(ns, () => fnRun(fileName, ...args), temp_pid => temp_pid !== 0,
        () => `Run command returned no pid. Destination: ${fileName} Command: ${command}\nEnsure you have sufficient free RAM to run this temporary script.`,
        maxRetries, retryDelayMs, undefined, verbose);
}

/**
 * Wait for a process id to complete running
 * Importing incurs a maximum of 0.1 GB RAM (for ns.isRunning) 
 * @param {NS} ns - The nestcript instance passed to your script's main entry point
 * @param {int} pid - The process id to monitor
 * @param {bool=} verbose - (default false) If set to true, pid and result of command are logged.
 **/
export async function waitForProcessToComplete(ns, pid, verbose) {
    checkNsInstance(ns, '"waitForProcessToComplete"');
    if (!verbose) disableLogs(ns, ['isRunning']);
    return await waitForProcessToComplete_Custom(ns, ns.isRunning, pid, verbose);
}
/**
 * An advanced version of waitForProcessToComplete that lets you pass your own "isAlive" test to reduce RAM requirements (e.g. to avoid referencing ns.isRunning)
 * Importing incurs 0 GB RAM (assuming fnIsAlive is implemented using another ns function you already reference elsewhere like ns.ps) 
 * @param {NS} ns - The nestcript instance passed to your script's main entry point
 * @param {function} fnIsAlive - A single-argument function used to start the new sript, e.g. `ns.isRunning` or `pid => ns.ps("home").some(process => process.pid === pid)`
 **/
export async function waitForProcessToComplete_Custom(ns, fnIsAlive, pid, verbose) {
    checkNsInstance(ns, '"waitForProcessToComplete_Custom"');
    if (!verbose) disableLogs(ns, ['sleep']);
    // Wait for the PID to stop running (cheaper than e.g. deleting (rm) a possibly pre-existing file and waiting for it to be recreated)
    for (var retries = 0; retries < 1000; retries++) {
        if (!fnIsAlive(pid)) break; // Script is done running
        if (verbose && retries % 100 === 0) ns.print(`Waiting for pid ${pid} to complete... (${retries})`);
        await ns.sleep(10);
    }
    // Make sure that the process has shut down and we haven't just stopped retrying
    if (fnIsAlive(pid)) {
        let errorMessage = `run-command pid ${pid} is running much longer than expected. Max retries exceeded.`;
        ns.print(errorMessage);
        throw errorMessage;
    }
}

/** Helper to retry something that failed temporarily (can happen when e.g. we temporarily don't have enough RAM to run)
 * @param {NS} ns - The nestcript instance passed to your script's main entry point */
export async function autoRetry(ns, fnFunctionThatMayFail, fnSuccessCondition, errorContext = "Success condition not met",
    maxRetries = 5, initialRetryDelayMs = 50, backoffRate = 3, verbose = false) {
    checkNsInstance(ns, '"autoRetry"');
    let retryDelayMs = initialRetryDelayMs;
    while (maxRetries-- > 0) {
        try {
            const result = await fnFunctionThatMayFail()
            if (!fnSuccessCondition(result)) throw typeof errorContext === 'string' ? errorContext : errorContext();
            return result;
        }
        catch (error) {
            const fatal = maxRetries === 0;
            const errorLog = `${fatal ? 'FAIL' : 'WARN'}: (${maxRetries} retries remaining): ${String(error)}`
            log(ns, errorLog, fatal, !verbose ? undefined : (fatal ? 'error' : 'warning'))
            if (fatal) throw error;
            await ns.sleep(retryDelayMs);
            retryDelayMs *= backoffRate;
        }
    }
}

/** Helper to log a message, and optionally also tprint it and toast it
 * @param {NS} ns - The nestcript instance passed to your script's main entry point */
export function log(ns, message = "", alsoPrintToTerminal = false, toastStyle = "", maxToastLength = 100) {
    checkNsInstance(ns, '"log"');
    ns.print(message);
    if (alsoPrintToTerminal) ns.tprint(message);
    if (toastStyle) ns.toast(message.length <= maxToastLength ? message : message.substring(0, maxToastLength - 3) + "...", toastStyle);
    return message;
}

/** Helper to get a list of all hostnames on the network
 * @param {NS} ns - The nestcript instance passed to your script's main entry point */
export function scanAllServers(ns) {
    checkNsInstance(ns, '"scanAllServers"');
    let discoveredHosts = []; // Hosts (a.k.a. servers) we have scanned
    let hostsToScan = ["home"]; // Hosts we know about, but have no yet scanned
    let infiniteLoopProtection = 9999; // In case you mess with this code, this should save you from getting stuck
    while (hostsToScan.length > 0 && infiniteLoopProtection-- > 0) { // Loop until the list of hosts to scan is empty
        let hostName = hostsToScan.pop(); // Get the next host to be scanned
        for (const connectedHost of ns.scan(hostName)) // "scan" (list all hosts connected to this one)
            if (!discoveredHosts.includes(connectedHost)) // If we haven't already scanned this host
                hostsToScan.push(connectedHost); // Add it to the queue of hosts to be scanned
        discoveredHosts.push(hostName); // Mark this host as "scanned"
    }
    return discoveredHosts; // The list of scanned hosts should now be the set of all hosts in the game!
}

/** @param {NS} ns 
 * Get a dictionary of active source files, taking into account the current active bitnode as well. **/
export async function getActiveSourceFiles(ns) {
    return await getActiveSourceFiles_Custom(ns, getNsDataThroughFile);
}

/** @param {NS} ns 
 * getActiveSourceFiles Helper that allows the user to pass in their chosen implementation of getNsDataThroughFile to minimize RAM usage **/
export async function getActiveSourceFiles_Custom(ns, fnGetNsDataThroughFile) {
    checkNsInstance(ns, '"getActiveSourceFiles"');
    let tempFile = '/Temp/owned-source-files.txt';
    // Find out what source files the user has unlocked
    let dictSourceFiles = await fnGetNsDataThroughFile(ns, `Object.fromEntries(ns.getOwnedSourceFiles().map(sf => [sf.n, sf.lvl]))`, tempFile);
    if (!dictSourceFiles) { // Bit of a hack, but if RAM is so low that this fails, we can fallback to using an older version of this file, and even assuming we have no source files.
        dictSourceFiles = ns.read(tempFile)
        dictSourceFiles = dictSourceFiles ? JSON.parse(dictSourceFiles) : {};
    }
    // If the user is currently in a given bitnode, they will have its features unlocked
    dictSourceFiles[(await fnGetNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/player-info.txt')).bitNodeN] = 3;
    return dictSourceFiles;
}

/** @param {NS} ns 
 * Return bitnode multiplers, or null if they cannot be accessed. **/
export async function tryGetBitNodeMultipliers(ns) {
    return await tryGetBitNodeMultipliers_Custom(ns, getNsDataThroughFile);
}

/** @param {NS} ns
 * tryGetBitNodeMultipliers Helper that allows the user to pass in their chosen implementation of getNsDataThroughFile to minimize RAM usage **/
export async function tryGetBitNodeMultipliers_Custom(ns, fnGetNsDataThroughFile) {
    checkNsInstance(ns, '"tryGetBitNodeMultipliers"');
    let canGetBitNodeMultipliers = false;
    try { canGetBitNodeMultipliers = 5 in (await getActiveSourceFiles_Custom(ns, fnGetNsDataThroughFile)); } catch { }
    if (!canGetBitNodeMultipliers) return null;
    try { return await fnGetNsDataThroughFile(ns, 'ns.getBitNodeMultipliers()', '/Temp/bitnode-multipliers.txt'); } catch { }
    return null;
}

/** @param {NS} ns 
 * Returns a helpful error message if we forgot to pass the ns instance to a function */
export function checkNsInstance(ns, fnName = "this function") { if (!ns.print) throw `The first argument to ${fnName} should be a 'ns' instance.`; return ns; }