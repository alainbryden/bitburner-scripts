/**
 * @param {NS} ns
 **/
export async function main(ns) {
    for (let file of ns.ls('home', '/Temp/').filter(f => f != '/Temp/cleanup.js'))
        ns.rm(file);
}