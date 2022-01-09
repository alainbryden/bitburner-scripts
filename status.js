import {} from "./helpers.js";
/** @typedef{import('.').NS} NS */

// We need a fancy status dashboard. Let's start with a static picture of what's
// going on, then maybe evolve later.

// -- CONSTANTS --
const argsSchema = [
	['help', false],
	['console', true],  // Display status to the console (tprint)?
	['log', false], // Display to the script log (print)?
	['fileOutput', ''], // Output to a file
	
];

// --GLOBALS --

/**@type{NS} */
let _ns = null; // Global reference to our ns object

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
	let printf = ns.tprint();

	
}

/**
 * Log a message
 * @param {string} message - The message to log
 * @param {function(string)[]} printfns - How to log it. Defaults to the script log, or pass in an an array of print functions.
 */
function log(message='', printfns=[]) {
	if (printfns.length === 0) printfns = [_ns.print];
	for (const printf of printfns) {
		printf(message);
	}
}


export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}
