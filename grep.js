// Achievement Unlocked: grep grep.js grep
export function autocomplete(data, args) {
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    return lastFlag ? [] : data.scripts;
}
/** @param {NS} ns */
export async function main(ns) {
    const txt = ns.args.length == 0 ? "" : ns.read(ns.args[0]);
    if (!txt) return ns.tprint("ERROR: The first argument must be a file to search (second argument is the text to search for)");
    const search = ns.args.length < 2 ? "" : ns.args[1];
    if (!search) return ns.tprint("ERROR: Missing second argument (search string).");
    const output = [];
    txt.split("\n").forEach((row, i) => {
        if (row.includes(search))
            output.push(`${i + 1}`.padStart(3) + `: ${row}`);
    })
    ns.tprint(output.length == 0 ? `Search string "${search}" not found in file ${ns.args[0]}` :
        `Found ${output.length} occurrences of the string "${search}" in file ${ns.args[0]}:\n${output.join("\n")}`);
}