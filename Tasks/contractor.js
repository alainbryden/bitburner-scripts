import { instanceCount, getFilePath, getNsDataThroughFile, disableLogs, log } from '../helpers.js'
const scriptSolver = getFilePath("/Tasks/contractor.js.solver.js");

/** @param {NS} ns **/
export async function main(ns) {
    // Prevent multiple instances of this script from being started
    if (await instanceCount(ns, "home", false, false) > 1)
        return log(ns, 'Another instance is already running. Shutting down...');

    disableLogs(ns, ["scan"]);
    ns.print("Getting server list...");
    const servers = await getNsDataThroughFile(ns, 'scanAllServers(ns)');
    ns.print(`Got ${servers.length} servers. Searching for contracts on each...`);
    // Retrieve all contracts and convert them to objects with the required information to solve
    const contractsDb = servers.map(hostname => ({ hostname, contracts: ns.ls(hostname, '.cct') }))
        .filter(o => o.contracts.length > 0)
        .map(o => o.contracts.map(contract => ({ contract, hostname: o.hostname }))).flat();
    if (contractsDb.length == 0)
        return ns.print("Found no contracts to solve.");

    // Spawn temporary scripts to gather the remainder of contract data required for solving
    ns.print(`Found ${contractsDb.length} contracts to solve. Gathering contract data via separate scripts..."`);
    const serializedContractDb = JSON.stringify(contractsDb);
    let contractsDictCommand = async (command, tempName) => await getNsDataThroughFile(ns,
        `Object.fromEntries(JSON.parse(ns.args[0]).map(c => [c.contract, ${command}]))`, tempName, [serializedContractDb]);
    let dictContractTypes = await contractsDictCommand('ns.codingcontract.getContractType(c.contract, c.hostname)', '/Temp/contract-types.txt');
    let dictContractDataStrings = await contractsDictCommand('JSON.stringify(ns.codingcontract.getData(c.contract, c.hostname), jsonReplacer)', '/Temp/contract-data-stringified.txt');
    contractsDb.forEach(c => c.type = dictContractTypes[c.contract]);
    contractsDb.forEach(c => c.dataJson = dictContractDataStrings[c.contract]);

    // Let this script die to free up ram, and start up a new script (after a delay) that will solve all these contracts using the minimum ram footprint of 11.6 GB
    ns.run(getFilePath('/Tasks/run-with-delay.js'), { temporary: true }, scriptSolver, 1, JSON.stringify(contractsDb));
}