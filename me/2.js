/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog('ALL');
  let tmp; let psPer; let psRam; let hnPer; let hnRam; let hnName;
  const reserve = Number(ns.read("reserve.txt") || 0);
  const checkM = (c, d) => eval(c < (ns.getPlayer().money / d));
  const hash = [ns.hacknet.numHashes(), ns.hacknet.hashCapacity()];

  function info(t, s) {
    if (t == 'MR') { return ns.getServerMaxRam(s) };
    if (t == 'UR') { return ns.getServerUsedRam(s) };
    if (t == 'HUR') { return ns.hacknet.getNodeStats(s).ramUsed };
    if (t == 'HR') { return ns.hacknet.getNodeStats(s).ram };
    if (t == 'HN') { return ns.hacknet.getNodeStats(s).name }
  };

  function barOutput(s) {
    const progress = Math.max(Math.min(ns.getServerUsedRam(s) / ns.getServerMaxRam(s), 1), 0);
    const bars = Math.max(Math.floor(progress / (1 / 15)), 0);
    const dashes = Math.max(15 - bars, 0);
    return ' [' + "|".repeat(bars) + "-".repeat(dashes) + "]";
  }

  async function hnManager() {
    let part = [
      ['getLevelUpgradeCost', 'upgradeLevel'],
      ['getRamUpgradeCost', 'upgradeRam'],
      ['getCoreUpgradeCost', 'upgradeCore'],
      ['getCacheUpgradeCost', 'upgradeCache']
    ];

    if (checkM(ns.hacknet.getPurchaseNodeCost(), 20)) { ns.hacknet.purchaseNode() }
    for (let i = 0; i < ns.hacknet.numNodes(); i++) {
      if (checkM(ns.hacknet[part[0][0]](i), 100)) { ns.hacknet[part[0][1]](i) } // Level
      if (checkM(ns.hacknet[part[1][0]](i), 20)) { ns.hacknet[part[1][1]](i) } // Ram    
      if (checkM(ns.hacknet[part[2][0]](i), 100)) { ns.hacknet[part[2][1]](i) } // Core
      if ((hash[0] / hash[1]) >= 0.98 && checkM(ns.hacknet[part[3][0]](i), 5)) { ns.hacknet[part[3][1]](i) } // Cache 
      hnRam = ns.formatRam(info('HR', i), 0);
      hnPer = ns.formatPercent(info('HUR', i) / info('HR', i), 0);
      ns.print(
        `║ ${info('HN', i)} `.padEnd(21, '·') + barOutput(info('HN', i)) + `${hnRam}`.padStart(5, '_') + ` ║`)
    };
  };

  async function pServerManager() {
    let ram = 0; let ramList = [8]; for (let num of ramList) {
      if (num <= 2 ** 20 && checkM(ns.getPurchasedServerCost(num), 20)) {
        ramList.push(num * 2); ram = num;
      } else { break };
    }
    function buyServer(r) { ns.purchaseServer('daemon', r) }
    if (ns.getPurchasedServers().length < 25 && ram > 0) { buyServer(ram) }
    for (let i = 0; i < ns.getPurchasedServers().length; i++) {
      tmp = ns.getPurchasedServers()[i];
      psRam = ns.formatRam(info('MR', tmp), 0);
      psPer = ns.formatPercent(info('UR', tmp) / info('MR', tmp), 0);
      if (info('MR', tmp) < ram && checkM(ns.getPurchasedServerCost(ram), 20)) {
        ns.killall(tmp); ns.deleteServer(tmp); buyServer(ram);
      };
      ns.print(`║ ${tmp} `.padEnd(21, '·') + barOutput(tmp) + `${psRam}`.padStart(5, '_') + ` ║`)
    };
  };

  ns.tail();
  while (1) {
    ns.clearLog();
    ns.print('╔' + '╗'.padStart(45, '═'));
    await hnManager();
    await pServerManager();
    ns.print('╚' + '╝'.padStart(45, '═'));
    await ns.sleep(1000);
  }

}
