/** @param {NS} ns **/
export async function main(ns) {
    let program = ns.args.length > 0 ? ns.args[0] : "DeepscanV1.exe";
    ns.tail();
    while (true) {
        while (ns.isBusy())
            await ns.sleep(1000);
        ns.rm(program);
        ns.createProgram(program);
    }
}