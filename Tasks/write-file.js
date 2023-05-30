/** @param {NS} ns
 * A way to write a new file from some args data **/
export function main(ns) {
    if (ns.args.length == 0) return ns.tprint("You must run this script with the arguments to pass to ns.write")
    if (ns.args.length == 2) // Default to "w" (overwrite mode)
        ns.args.push("w")
    return ns.write(...ns.args);
}