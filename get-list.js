const lists = ['FactionName', 'StockSymbol', 'GangName', 'Crime', 'AugmentName', 'BladeburnerOperations', 'BladeburnerBlackOps', 'CodingContractTypes', 'GangEquipment'].sort();
export function autocomplete() { return lists; }
/** @param {NS} ns **/
export async function main(ns) { ns.tprint(await getList(ns.args[0])); }
export async function getList(listName) {
    let definitions = await (await fetch('https://raw.githubusercontent.com/danielyxie/bitburner/dev/src/ScriptEditor/NetscriptDefinitions.d.ts')).text();
    let listStart = `type ${listName} =\n  | "`;
    let listIndex = definitions.indexOf(listStart) + listStart.length;
    let list = definitions.slice(listIndex, definitions.indexOf('";', listIndex)).split('"\n  | "');
    return list;
}