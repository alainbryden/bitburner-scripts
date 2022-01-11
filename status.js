import { scanAllServers } from "./helpers.js";
/** @typedef{import('.').NS} NS */

// status.js
//
// We need a fancy status dashboard. Let's start with a static picture of what's
// going on, then maybe evolve later.

// -- CONSTANTS --
const argsSchema = [
    ["help", false],
    ["console", true], // Display status to the console (tprint)?
    ["log", false], // Display to the script log (print)?
    ["fileOutput", ""], // Output to a file
    ["c", false],
    ["continuous", false],
];

// --OTHER GLOBALS --
/** @type{NS} */
let _ns = null;

// -- MAIN --
/**
 * Handle arguments and dispatch
 *
 * @param {NS} ns
 **/
export async function main(ns) {
    _ns = ns;
    let options = ns.flags(argsSchema);

    // start with  console output, so any help messages or errors about the command line go there.
    let p = [ns.tprint];

    // Print help message.
    if (options.help) {
        let msg = [];
        msg.push(`Bitburner Status Script.`);
        msg.push(`Usage:`);
        msg.push(`    run ${ns.getScriptName()}`);
        msg.push(`Options:`);
        for (const arg of argsSchema) {
            msg.push(`    --${arg[0]}: ${JSON.stringify(arg[1])}`);
        }
        msg.push(``);
        log(p, msg);
        return;
    }
    // Set up what loggers we want.
    p = [];
    if (options.console) p.push(ns.tprint);
    if (options.log) p.push(ns.print);

    // File output needs to be done differently.
    // TODO: File handling

    let keepRunning = options.c || options["run-continuously"];
    if (keepRunning) await runStatusLoop(ns, p);
    else await runStatusOnce(ns, p);
}

/**
 * Log a message
 * @param {function(string)|function(string)[]} printfns - How to log. Defaults to the script log, or pass in an an array of print functions.
 * @param {string|string[]} message - The message(s) to log
 */
function log(printfns = [], message = "") {
    // Default to the global ns.print
    if (printfns.length === 0) {
        printfns = [_ns.print];
    }
    if (typeof message === "string") message = [message];

    for (const printf of printfns) {
        let isTerminal = printf === _ns.tprint;
        if (isTerminal) {
            // Colors!
        }
        for (const line of message) {
            printf(line);
        }
    }
}

async function runStatusLoop(ns, p) {
    while (true) {
        runStatusOnce(ns, p);
        await ns.asleep(500);
    }
}

async function runStatusOnce(ns, p) {
	// Gather some information about the start of the world.
	let servers = scanAllServers(ns);
	
	
}

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}
