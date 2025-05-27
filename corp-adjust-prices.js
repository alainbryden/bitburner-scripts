import {
    log, disableLogs, instanceCount, getConfiguration, getNsDataThroughFile, getActiveSourceFiles,
    getStocksValue, formatNumberShort, formatMoney, getFilePath
} from './helpers.js'

/**
 * 自动价格调整脚本 - 修复API调用
 * 需要已解锁Corporation API
 */
async function manageMaterialPrices(ns) {
    // 配置参数
    const checkInterval = 5 * 1000; // 检查间隔（毫秒）
    const highStockThreshold = 0.15;  // 高库存阈值（仓库容量百分比）
    const lowStockThreshold = 0.05;   // 低库存阈值（仓库容量百分比）
    const priceAdjustmentFactor = 0.95; // 价格调整因子（降低1%）

    // 日志函数
    function log(message) {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
        ns.print(`[${timestamp}] [价格管理] ${message}`);
    }

    log("启动材料价格自动调整脚本...");

    // 主循环
    while (true) {
        try {
            const corporation = ns.corporation.getCorporation();
            const divisions = corporation.divisions;

            for (const division of divisions) {
                // 只处理Agriculture部门，可根据需要修改
                if (division !== "Agriculture") continue;
                log(`======================${division}============================`)
                const cities = ns.corporation.getDivision(division).cities;

                for (const city of cities) {
                    log(`---------------------${city}---------------------------`)
                    // 获取仓库信息
                    const warehouse = ns.corporation.getWarehouse(division, city);
                    const maxCapacity = warehouse.size;

                    // 获取该部门生产的材料列表
                    const materials = getMaterialsForDivision(division);

                    for (const material of materials) {
                        // 获取当前材料信息
                        const matInfo = ns.corporation.getMaterial(division, city, material.Name);
                        const stock = (matInfo.stored*material.Size)
                        const marketPrice = matInfo.marketPrice;

                        // 解析当前价格设置
                        const nowPrice = evaluatePriceExpression(matInfo.desiredSellPrice, marketPrice);
                        const maxPrice = marketPrice * 100
                        const minPrice = marketPrice / 100
                        // 计算库存百分比
                        const stockPercentage = stock / maxCapacity;

                        // 根据库存水平调整价格
                        let newPriceFactor = nowPrice;
                        let adjustmentReason = '';

                        // 高库存处理策略
                        if (stockPercentage > highStockThreshold) {
                            newPriceFactor = Math.max(nowPrice * priceAdjustmentFactor, minPrice);
                            adjustmentReason = `高库存[${formatNumberShort(stock)}/${formatNumberShort(maxCapacity)}](${formatNumberShort(stockPercentage)}): 当前价格：${formatMoney(nowPrice)}，降低价格`;
                        }
                        // 低库存处理策略
                        else if (stockPercentage < lowStockThreshold) {
                            newPriceFactor = Math.min(nowPrice * (1 + (1 - priceAdjustmentFactor)), maxPrice);
                            adjustmentReason = `低库存[${formatNumberShort(stock)}/${formatNumberShort(maxCapacity)}](${formatNumberShort(stockPercentage)}): 当前价格：${formatMoney(nowPrice)}，提高价格`;
                        } else {
                            adjustmentReason = `正常库存[${formatNumberShort(stock)}/${formatNumberShort(maxCapacity)}](${formatNumberShort(stockPercentage)})，正在运行:当前价格: ${formatMoney(nowPrice)}`;
                        }

                        // 如果价格需要调整
                        try {
                            // 计算新价格设置
                            const newPriceSetting = newPriceFactor

                            // 设置新价格 - 使用正确的API方法
                            ns.corporation.sellMaterial(division, city, material.Name, "MAX", newPriceSetting);

                            log(`✅ ${adjustmentReason}: ${division} - ${city} - ${material.Name} 价格调整为 ${formatMoney(newPriceSetting)} (${formatMoney(newPriceSetting)})`);
                        } catch (error) {
                            log(`❌ 更新价格失败: ${division} - ${city} - ${material.Name} - ${error.message}`);
                        }
                    }
                }
            }
        } catch (error) {
            log(`❌ 主循环错误: ${error.message}`);
            log(error.stack);
        }

        // 等待下一个检查周期
        await ns.sleep(checkInterval);
    }
}
/**
 * 解析并计算包含"MP"的数学表达式
 * @param {string} expression - 包含"MP"的表达式，如 "MP+2*3"
 * @param {number} marketPrice - 市场价格(MP)的值
 * @returns {number} 计算结果
 */
function evaluatePriceExpression(expression, marketPrice) {
    // 替换MP为市场价格
    const sanitizedExpression = expression
        .replace("MP", `(${marketPrice})`)
        .replace(/\s+/g, ''); // 移除空格

    // 使用安全的表达式计算器
    try {
        // 定义一个安全的表达式计算器
        const result = Function('"use strict";return (' + sanitizedExpression + ')')();

        // 验证结果是否为有效数字
        if (isNaN(result) || !isFinite(result)) {
            throw new Error("计算结果不是有效数字");
        }

        return result;
    } catch (error) {
        throw new Error(`表达式解析错误: ${error.message}, 表达式: ${expression}`);
    }
}

// 根据部门获取销售的材料列表
function getMaterialsForDivision(division) {
    // 根据你的公司设置调整此函数
    // 这里列出了Agriculture部门通常销售的材料
    // return ['Food', 'Plants'];
    return [
        {"Name":"Food","Size":0.03},
        {"Name":"Plants","Size":0.05},
    ]
}

// 主入口点
export async function main(ns) {
    ns.disableLog("ALL");
    ns.enableLog("print");

    try {
        await manageMaterialPrices(ns);
    } catch (error) {
        ns.print(`FATAL ERROR: ${error.message}`);
        ns.print(error.stack);
    }
}