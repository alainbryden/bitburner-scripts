import {
    log, disableLogs, instanceCount, getConfiguration, getNsDataThroughFile, getActiveSourceFiles,
    getStocksValue, formatNumberShort, formatMoney, getFilePath
  } from './helpers.js'
  
  /**
   * 带调试日志的员工士气自动管理脚本
   * 需要解锁Office API升级
   */
  async function manageEmployeeMorale(ns) {
    // 配置参数
    const energyThreshold = 98;
    const partyThreshold = 99;
    const teaCostPerEmployee = 500000;
    const partyCostPerEmployee = 100000;
    const cooldown = 10 * 1000; // 10s
    
    // 要管理的部门
    const divisions = ns.corporation.getCorporation().divisions
  
    // 日志函数，统一格式
    function log(message) {
      const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
      ns.print(`[${timestamp}] [士气管理] ${message}`);
    }
  
    log("员工士气管理脚本启动...");
    log(`配置参数: 茶阈值=${energyThreshold}, 派对阈值=${partyThreshold}`);
  
    // 主循环
    while (true) {
      log(`开始新的管理周期。可用资金: ${formatMoney(ns.getPlayer().money)}`);
  
      for (const division of divisions) {
        try {
          log(`正在处理部门: ${division}`);
          const cities = ns.corporation.getDivision(division).cities;
  
          for (const city of cities) {
            log(`正在处理办公室: ${division} - ${city}`);
  
            // 获取办公室详情
            const office = ns.corporation.getOffice(division, city);
            const numEmployees = office.numEmployees;
            const energy = office.avgEnergy;
            const morale = office.avgMorale;
            const currentMoney = ns.corporation.getCorporation().funds
  
            log(`  员工数量: ${numEmployees}, 幸福度: ${formatNumberShort(energy)}, 可用资金: ${formatMoney(currentMoney)}`);
  
            // 茶购买检查
            const teaTotalCost = teaCostPerEmployee * numEmployees;
            if (energy < energyThreshold && currentMoney >= teaTotalCost) {
              log(`  尝试为${numEmployees}名员工购买茶 (成本: ${formatMoney(teaTotalCost)})`);
  
              try {
                const success = ns.corporation.buyTea(division, city);
                if (success) {
                  log(`  ✅ 已成功为 ${division} - ${city} 的员工购买茶`);
                } else {
                  log(`  ❌ 购买茶失败 (未知原因)`);
                }
              } catch (error) {
                log(`  ❌ 购买茶出错: ${error.message}`);
              }
            } else {
              const reason = energy >= energyThreshold
                ? `幸福度 (${energy}) 高于阈值`
                : `资金不足 (需要 ${formatMoney(teaTotalCost)})`;
              log(`  跳过购买茶: ${reason}`);
            }
  
            // 派对检查
            const partyTotalCost = partyCostPerEmployee * numEmployees;
            if (morale < partyThreshold && currentMoney >= partyTotalCost) {
              log(`  尝试为${numEmployees}名员工举办派对 (成本: ${formatMoney(partyTotalCost)})`);
  
              try {
                const moraleMultiplier = ns.corporation.throwParty(division, city, partyCostPerEmployee);
                if (moraleMultiplier > 0) {
                  log(`  ✅ 已成功为 ${division} - ${city} 的员工举办派对 (士气乘数: ${moraleMultiplier})`);
                } else {
                  log(`  ❌ 举办派对失败 (未知原因)`);
                }
              } catch (error) {
                log(`  ❌ 举办派对出错: ${error.message}`);
              }
            } else {
              const reason = morale >= partyThreshold
                ? `幸福度 (${morale}) 高于阈值`
                : `资金不足 (需要 ${formatMoney(partyTotalCost)})`;
              log(`  跳过举办派对: ${reason}`);
            }
          }
        } catch (error) {
          log(`❌ 处理部门 ${division} 时发生严重错误: ${error.message}`);
          log(error.stack);
        }
      }
  
      log(`周期完成。休眠 ${cooldown / 1000} 秒...`);
      await ns.sleep(cooldown);
    }
  }
  
  
  // 主入口点
  export async function main(ns) {
    ns.disableLog("ALL"); // 禁用默认日志以提高性能
    ns.enableLog("print"); // 启用自定义日志
  
    try {
      await manageEmployeeMorale(ns);
    } catch (error) {
      ns.print(`FATAL ERROR: ${error.message}`);
      ns.print(error.stack);
    }
  }