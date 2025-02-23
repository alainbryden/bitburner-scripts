/** 
 * 量化交易系统 - 增强型日志版本
 * 实现自动化股票交易策略，包含多空双向操作和可视化日志系统
 * @param {NS} ns Bitburner游戏API对象
 */
export async function main(ns) {
    // *************** 初始化配置 ***************
    ns.disableLog('ALL');    // 禁用所有默认日志
    ns.tail();               // 打开独立显示窗口
    ns.clearLog();           // 清空初始日志

    // *************** 全局常量配置 ***************
    const CONFIG = {
        SCRIPT_INTERVAL: ns.stock.getConstants().msPerStockUpdate, // 市场数据更新间隔（毫秒）
        TRANSACTION_FEE: ns.stock.getConstants().StockMarketCommission, // 单次交易手续费
        RESERVE_FUNDS: 100e9,            // 保留现金（防止全仓）
        LONG_THRESHOLD: 0.60,            // 做多预测阈值（高于此值触发买入）
        SHORT_THRESHOLD: 0.40,           // 做空预测阈值（低于此值触发卖出）
        MAX_VOLATILITY: 0.05,            // 允许的最大波动率（过滤高风险股票）
        MAX_POSITION_RATIO: 0.10,        // 单只股票最大持仓比例（总股本的10%）
        SELL_LONG_THRESHOLD: 0.55,       // 平多仓阈值（预测低于此值时卖出）
        SELL_SHORT_THRESHOLD: 0.45,      // 平空仓阈值（预测高于此值时卖出）
        SHORT_ENABLED: true,             // 是否启用做空功能
        LOG_LIMIT: 5,                    // 显示最近交易记录条数
        TOAST_DURATION: 6000,            // 桌面通知显示时长（毫秒）
        DECIMAL_PRECISION: 2,            // 金额显示小数位数
        RISK_LEVEL: "MODERATE"           // 风险控制等级（MODERATE/AGGRESSIVE）
    };

    // *************** 运行时状态 ***************
    let netWorthHistory = ns.getPlayer().money; // 初始净资产（用于计算增长率）
    const transactionLog = [];                  // 交易记录队列（最新在前）
    let cycleCount = 0;                         // 策略执行周期计数器
    let totalProfit = 0;                        // 累计总利润（扣除手续费）

    // *************** 可视化工具函数 ***************
    const symbols = ["", "k", "m", "b", "t", "q", "Q", "s", "S", "o", "n", "e33", "e36", "e39"];
    /**
 * 返回带单位缩写的金额格式化字符串（例如 $6.50M）
 * @param {number} num - 要格式化的数字
 * @param {number=} maxSignificantFigures - (默认: 6) 最大有效数字位数（例如 123, 12.3, 1.23 均为3位有效数字）
 * @param {number=} maxDecimalPlaces - (默认: 3) 最大小数位数（例如 12.3, 1.2, 0.1 均为1位小数）
 **/
    function formatMoney(num, maxSignificantFigures = 6, maxDecimalPlaces = 2) {
        let numberShort = formatNumberShort(num, maxSignificantFigures, maxDecimalPlaces);
        return num >= 0 ? "¥" + numberShort : numberShort.replace("-", "-¥");
    }
    /**
 * 返回带单位缩写的数字格式化字符串（例如 6.50M）
 * @param {number} num - 要格式化的数字
 * @param {number=} maxSignificantFigures - (默认: 6) 最大有效数字位数
 * @param {number=} maxDecimalPlaces - (默认: 3) 最大小数位数
 **/
    function formatNumberShort(num, maxSignificantFigures = 6, maxDecimalPlaces = 2) {
        if (Math.abs(num) > 10 ** (3 * symbols.length)) // If we've exceeded our max symbol, switch to exponential notation
            return num.toExponential(Math.min(maxDecimalPlaces, maxSignificantFigures - 1));
        for (var i = 0, sign = Math.sign(num), num = Math.abs(num); num >= 1000 && i < symbols.length; i++) num /= 1000;
        // TODO: A number like 9.999 once rounded to show 3 sig figs, will become 10.00, which is now 4 sig figs.
        return ((sign < 0) ? "-" : "") + num.toFixed(Math.max(0, Math.min(maxDecimalPlaces, maxSignificantFigures - Math.floor(1 + Math.log10(num))))) + symbols[i];
    }

    /** Format a duration (in milliseconds) as e.g. '1h 21m 6s' for big durations or e.g '12.5s' / '23ms' for small durations */
    function formatDuration(duration) {
        if (duration < 1000) return `${duration.toFixed(0)}毫秒`
        if (!isFinite(duration)) return 'forever (Infinity)'
        const portions = [];
        const msInHour = 1000 * 60 * 60;
        const hours = Math.trunc(duration / msInHour);
        if (hours > 0) {
            portions.push(hours + '时');
            duration -= (hours * msInHour);
        }
        const msInMinute = 1000 * 60;
        const minutes = Math.trunc(duration / msInMinute);
        if (minutes > 0) {
            portions.push(minutes + '分');
            duration -= (minutes * msInMinute);
        }
        let seconds = (duration / 1000.0)
        // Include millisecond precision if we're on the order of seconds
        seconds = (hours == 0 && minutes == 0) ? seconds.toPrecision(3) : seconds.toFixed(0);
        if (seconds > 0) {
            portions.push(seconds + '秒');
            duration -= (minutes * 1000);
        }
        return portions.join(' ');
    }

    /**
     * 生成进度条可视化效果
     * @param {number} percentage 当前进度百分比（0-1）
     * @param {number} length 进度条总长度（字符数）
     * @returns {string} 可视化进度条字符串
     */
    function progressBar(percentage, length = 10) {
        const filled = '■'.repeat(Math.round(percentage * length)); // 实心部分
        const empty = '□'.repeat(length - filled.length);          // 空心部分
        return `${filled}${empty} ${(percentage * 100).toFixed(1)}%`; // 组合显示
    }



    // *************** 交易核心逻辑 ***************

    /**
     * 执行买入操作（包含做多和做空逻辑）
     * @param {string} stock 股票代码
     */
    function processBuyOrder(stock) {
        // 获取当前持仓：[多仓数量, 多仓均价, 空仓数量, 空仓均价]
        const [longPos, , shortPos] = ns.stock.getPosition(stock);
        const maxShares = ns.stock.getMaxShares(stock) * CONFIG.MAX_POSITION_RATIO; // 计算最大允许持仓
        const askPrice = ns.stock.getAskPrice(stock);    // 当前买入价
        const forecast = ns.stock.getForecast(stock);    // 预测值（0-1）
        const volatility = ns.stock.getVolatility(stock);// 波动率（0-1）
        const availableFunds = ns.getPlayer().money - CONFIG.RESERVE_FUNDS - CONFIG.TRANSACTION_FEE; // 可用资金

        // 做多逻辑：预测值高于阈值 且 波动率在安全范围
        if (forecast >= CONFIG.LONG_THRESHOLD && volatility <= CONFIG.MAX_VOLATILITY) {
            // 计算可买数量（考虑可用资金和最大持仓限制）
            const buyCapacity = Math.min(
                (availableFunds / askPrice) * 0.95,  // 保留5%缓冲
                maxShares - longPos                  // 不超过最大持仓
            );
            if (buyCapacity > 10) { // 过滤小量交易
                const cost = ns.stock.buyStock(stock, buyCapacity);
                if (cost > 0) { // 交易成功时记录
                    const logEntry = `🟢 ${stock} 做多 ×${formatNumberShort(buyCapacity, 1)} @ ${formatNumberShort(askPrice)} 成本:${formatMoney(cost)}`;
                    transactionLog.unshift(logEntry); // 添加到交易记录开头
                    ns.toast(`↑ ${stock} 做多建仓`, "success", CONFIG.TOAST_DURATION);
                }
            }
        }

        // 做空逻辑（需要启用且满足条件）
        if (CONFIG.SHORT_ENABLED && forecast <= CONFIG.SHORT_THRESHOLD && volatility <= CONFIG.MAX_VOLATILITY) {
            const shortCapacity = Math.min(
                (availableFunds / askPrice) * 0.95,
                maxShares - shortPos
            );
            if (shortCapacity > 10) {
                const cost = ns.stock.buyShort(stock, shortCapacity);
                if (cost > 0) {
                    const logEntry = `🔴 ${stock} 做空 ×${formatNumberShort(shortCapacity, 1)} @ ${formatNumberShort(askPrice)} 成本:${formatMoney(cost)}`;
                    transactionLog.unshift(logEntry);
                    ns.toast(`↓ ${stock} 做空建仓`, "warning", CONFIG.TOAST_DURATION);
                }
            }
        }
    }

    /**
     * 执行卖出操作（平仓逻辑）
     * @param {string} stock 股票代码
     */
    function processSellOrder(stock) {
        // 获取持仓数据：[多仓数量, 多仓均价, 空仓数量, 空仓均价]
        const [longPos, longAvg, shortPos, shortAvg] = ns.stock.getPosition(stock);
        const bidPrice = ns.stock.getBidPrice(stock); // 当前卖出价
        const forecast = ns.stock.getForecast(stock); // 当前预测值

        // 平多仓逻辑：预测低于平仓阈值时卖出
        if (longPos > 0 && forecast < CONFIG.SELL_LONG_THRESHOLD) {
            // 计算利润：（现价 - 成本价）* 数量 - 2次手续费（买入和卖出）
            const profit = (bidPrice - longAvg) * longPos - 2 * CONFIG.TRANSACTION_FEE;
            ns.stock.sellStock(stock, longPos); // 执行卖出
            totalProfit += profit; // 累加到总利润
            const logEntry = `🔵 ${stock} 平多 ×${formatNumberShort(longPos, 1)} 盈利:${formatMoney(profit)} (${profit >= 0 ? '↑' : '↓'}${ns.formatPercent(Math.abs(profit) / (longAvg * longPos))})`;
            transactionLog.unshift(logEntry);
            ns.toast(`◼ ${stock} 多单平仓`, "info", CONFIG.TOAST_DURATION);
        }

        // 平空仓逻辑（需要启用做空）
        if (CONFIG.SHORT_ENABLED && shortPos > 0 && forecast > CONFIG.SELL_SHORT_THRESHOLD) {
            // 空头利润计算：（成本价 - 现价）* 数量 - 手续费
            const profit = (shortAvg - bidPrice) * shortPos - 2 * CONFIG.TRANSACTION_FEE;
            totalProfit += profit;
            ns.stock.sellShort(stock, shortPos);
            const logEntry = `🟣 ${stock} 平空 ×${formatNumberShort(shortPos, 1)} 盈利:${formatMoney(profit)} (${profit >= 0 ? '↑' : '↓'}${ns.formatPercent(Math.abs(profit) / (shortAvg * shortPos))})`;
            transactionLog.unshift(logEntry);
            ns.toast(`◼ ${stock} 空单平仓`, "info", CONFIG.TOAST_DURATION);
        }
    }

    // *************** 市场分析报告 ***************

    /**
     * 生成实时市场分析报告
     * @param {Array} stocks 股票代码列表
     * @returns {string} 格式化后的市场报告
     */
    function generateMarketReport(stocks) {
        let report = "";
        stocks.forEach((stock) => {
            const forecast = ns.stock.getForecast(stock);    // 预测趋势
            const volatility = ns.stock.getVolatility(stock);// 波动率
            const [longPos, , shortPos] = ns.stock.getPosition(stock); // 持仓情况

            // 构建每行显示内容：代码 + 预测条 + 波动条 + 多空持仓
            report += `${stock.padEnd(5)} ${progressBar(forecast, 8)}  ${progressBar(volatility, 1)}  `;
            report += `📈${longPos > 0 ? formatNumberShort(longPos, 1).padEnd(6) : '0'.padEnd(6)} `;
            report += `📉${shortPos > 0 ? formatNumberShort(shortPos, 1).padEnd(6) : '0'.padEnd(6)}\n`;
        });
        return report;
    }

    // *************** 主循环 ***************
    while (true) {
        ns.clearLog(); // 每周期清空日志
        cycleCount++;  // 周期计数器递增

        // 获取所有股票并按预测强度排序（最可能上涨/下跌的在前）
        const allStocks = ns.stock.getSymbols().sort((a, b) =>
            Math.abs(0.5 - ns.stock.getForecast(b)) - Math.abs(0.5 - ns.stock.getForecast(a))
        );

        // 交易执行阶段
        let portfolioValue = 0; // 当前持仓总价值
        allStocks.forEach(stock => {
            processSellOrder(stock); // 先处理卖出
            processBuyOrder(stock);  // 再处理买入

            // 计算持仓价值（多仓按现价，空仓按差价）
            const [long, , short] = ns.stock.getPosition(stock);
            const bid = ns.stock.getBidPrice(stock);
            portfolioValue += long * bid + short * (ns.stock.getPosition(stock)[3] - bid);
        });

        // *************** 资产计算 ***************
        const currentNetWorth = ns.getPlayer().money + portfolioValue; // 当前总资产
        const growthRate = ((currentNetWorth - netWorthHistory) / netWorthHistory * 100 || 0).toFixed(2); // 增长率


        // *************** 日志输出 ***************
        ns.print(`🔄 第 ${cycleCount} 次刷新 | 运行时长: ${formatDuration(cycleCount * CONFIG.SCRIPT_INTERVAL)} | 间隔: ${formatDuration(CONFIG.SCRIPT_INTERVAL)}`);
        ns.print("=".repeat(70)); // 分隔线

        // 市场热力榜（显示前5只股票）
        ns.print("🔥 实时市场热力榜（预测强度排序）：");
        ns.print("代码   预测趋势         波动率    多仓持仓    空仓持仓");
        ns.print(generateMarketReport(allStocks.slice(0, 5)));

        // 资产面板
        ns.print("\n📊 资产概览：");
        ns.print(`│ 总资产 ${formatMoney(currentNetWorth)} │ 现金 ${formatMoney(ns.getPlayer().money)} │ 持仓 ${formatMoney(portfolioValue)} │ 收益 ${formatMoney(totalProfit)} │`);
        ns.print(`\n📈 净值变化: ${growthRate >= 0 ? '+' : ''}${growthRate}% | 风险等级: ${CONFIG.RISK_LEVEL} | 做空状态: ${CONFIG.SHORT_ENABLED ? '🟢' : '🔴'}`);

        // 交易记录（显示最近5条）
        ns.print("\n📜 最近交易记录：");
        transactionLog.slice(0, CONFIG.LOG_LIMIT).forEach(entry => ns.print(entry));

        // 策略参数展示
        ns.print("\n⚙️ 策略配置：");
        ns.print(`做多阈值: ${ns.formatPercent(CONFIG.LONG_THRESHOLD.toFixed(2))} 平多: ${ns.formatPercent(CONFIG.SELL_LONG_THRESHOLD.toFixed(2))}`);
        ns.print(`做空阈值: ${ns.formatPercent(CONFIG.SHORT_THRESHOLD.toFixed(2))} 平空: ${ns.formatPercent(CONFIG.SELL_SHORT_THRESHOLD.toFixed(2))}`);
        ns.print(`最大波动: ${ns.formatPercent(CONFIG.MAX_VOLATILITY)} 仓位限制: ${ns.formatPercent(CONFIG.MAX_POSITION_RATIO)}`);

        // 等待下一个更新周期
        await ns.sleep(CONFIG.SCRIPT_INTERVAL);
    }
}
