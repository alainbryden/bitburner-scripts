import { runCommand } from './helpers.js'

const escapeChars = ['"', "'", "`"];

/** @param {NS} ns 
 * The argument can consist of multiple commands to run. The output of the first command will automatically be printed
 * unless a subsequent command includes '; output = ...' - in which case that result will be printed instead. **/
export async function main(ns) {
    let args = ns.args;
    if (args.length == 0)
        return ns.tprint("You must run this script with an argument that is the code to test.")
    // Special first argument of -s will result in "silent" mode - do not output the result in the success case
    let silent = false;
    if (args.includes('-s')) {
        silent = true;
        args = args.slice(args.indexOf('-s'), 1);
    }
    const firstArg = String(args[0]);
    const escaped = escapeChars.some(c => firstArg.startsWith(c) && firstArg.endsWith(c));
    let command = args == escaped ? args[0] : args.join(" "); // If args weren't escaped, join them together
    // To avoid confusion, strip out any trailing spaces / semicolons
    command = command.trim();
    if (command.endsWith(';')) command = command.slice(0, -1);
    // If the command appears to contian multiple statements, cleverly (and perhaps perilously)
    // see if we can inject a return statement so that we can get the return value of the last statement
    if (command.includes(';')) {
        const lastStatement = command.lastIndexOf(';');
        if (!command.slice(lastStatement + 1).trim().startsWith('return'))
            command = command.slice(0, lastStatement + 1) + `return ` + command.slice(lastStatement + 1);
        // Create a scope around multi-statement commands so they can be used in a lambda
        command = `{ ${command} }`;
    }
    // Wrapping the command in a lambda that can capture and print its output.
    command = `ns.tprint(JSON.stringify(await (async () => ${command})() ?? "(no output)", null, 2))`;
    await ns.write(`/Temp/terminal-command.js`, "", "w"); // Clear the previous command file to avoid a warning about re-using temp script names. This is the one exception.
    return await runCommand(ns, command, `/Temp/terminal-command.js`, (escaped ? args.slice(1) : undefined), !silent);
}