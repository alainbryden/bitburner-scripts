// Achievement Unlocked: grep grep.js grep
const usage = "Usage: run grep.js [<filename.ext>] <search_string>\n" +
    "- If run with one argument, searches all files for occurrences of that text.\n" +
    "- If run with two arguments, the first argument is the name of the file to search.\n" +
    "- If you wish to search all files for text with a space in it, wrap it in quotes.";
export function autocomplete(data, args) {
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    return lastFlag ? [] : data.scripts; // For the first argument, auto-complete a list of all files
}
/** @param {NS} ns */
export async function main(ns) {
    const args = ns.args;
    if (args.length == 0)
        return ns.tprint(`INFO: Searches for text in files.\n${usage}`)
    const search = args.length == 1 ? args[0] : args.slice(1, args.length).join(" ");
    // Two or more arguments, treat the first argument as a file name
    if (args.length > 1) {
        const fileName = args[0];
        const contents = ns.read(fileName);
        if (!contents) return ns.tprint(`ERROR: File not found: "${fileName}".\n${usage}`);
        const output = searchRows(contents, search, fileName);
        return ns.tprint(output.length > 0 ? output.join("\n") :
            `Search string "${search}" not found in file ${fileName}`);
    }
    // Otherwise, search all files
    const files = ns.ls("home");
    const allOutput = files.flatMap(fileName => searchRows(ns.read(fileName), search, fileName));
    ns.tprint(allOutput.length > 0 ? allOutput.join("\n") :
        `Search string "${search}" not found in any of the ${files.length} files on "home".`);
}
/** Helper to search a single file's output */
function searchRows(text, search, fileName) {
    const output = text.split("\n").map((row, i) => [row, i])
        .filter(([row, _]) => row.includes(search))
        .map(([row, i]) => `${i + 1}`.padStart(3) + `: ${row}`)
    if (output.length > 0 && fileName)
        output.unshift(`Found ${output.length} occurrences of the string "${search}" in file ${fileName}:`);
    return output;
}