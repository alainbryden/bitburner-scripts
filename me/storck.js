/** 
 * 量化交易系统 - 优化增强版（含止损功能）
 * 优化点：API调用缓存/代码结构重组/性能提升/新增止损逻辑
 * @param {NS} ns Bitburner游戏API对象
 */
export async function main(ns) {
    // *************** 初始化配置 ***************
    ns.disableLog('ALL');
    ns.tail();
    ns.clearLog();

    // *************** 全局常量配置 ***************
    const STOCK_CONSTANTS = ns.stock.getConstants(); // API结果缓存
    const CONFIG = {
        SCRIPT_INTERVAL: STOCK_CONSTANTS.msPerStockUpdate,
        TRANSACTION_FEE: STOCK_CONSTANTS.StockMarketCommission,
        RESVERVE: 0.5,   // 保留资金为持仓百分比
        LONG_THRESHOLD: 0.60,
        SHORT_THRESHOLD: 0.40,
        MAX_VOLATILITY: 0.05,
        MAX_POSITION_RATIO: 0.10,
        SELL_LONG_THRESHOLD: 0.50,
        SELL_SHORT_THRESHOLD: 0.50,
        STOP_LOSS_RATIO: 0.05, // 新增止损比例配置
        SHORT_ENABLED: true,
        LOG_LIMIT: 5,
        TOAST_DURATION: 6000,
        DECIMAL_PRECISION: 2,
        RISK_LEVEL: "MODERATE"
    };

    // *************** 运行时状态 ***************
    let netWorthHistory = ns.getPlayer().money;
    const transactionLog = [];
    let cycleCount = 0;
    let totalProfit = 0;

    // *************** 工具函数（保持不变）***************
    const symbols = ["", "k", "m", "b", "t", "q", "Q", "s", "S", "o", "n", "e33", "e36", "e39"];
    function formatMoney(num, maxSF = 6, maxDP = 2) {
        return (num >= 0 ? "¥" : "-¥") + formatNumberShort(Math.abs(num), maxSF, maxDP);
    }

    function formatNumberShort(num, maxSF = 6, maxDP = 2) {
        if (Math.abs(num) > 10 ** (3 * symbols.length))
            return num.toExponential(Math.min(maxDP, maxSF - 1));
        for (var i = 0, num = Math.abs(num); num >= 1000 && i < symbols.length; i++) num /= 1000;
        return (num < 0 ? "-" : "") + num.toFixed(Math.max(0, Math.min(maxDP, maxSF - Math.floor(1 + Math.log10(num))))) + symbols[i];
    }

    function formatDuration(duration) {
        if (duration < 1000) return `${duration.toFixed(0)}ms`;
        const portions = [];
        const hours = Math.trunc(duration / 3.6e6);
        if (hours > 0) portions.push(hours + 'h');
        const minutes = Math.trunc((duration % 3.6e6) / 6e4);
        if (minutes > 0) portions.push(minutes + 'm');
        let seconds = (duration % 6e4) / 1e3;
        portions.push(hours + minutes > 0 ? seconds.toFixed(0) : seconds.toPrecision(3)) + 's';
        return portions.join(' ');
    }

    function progressBar(pct, len = 10) {
        return '■'.repeat(Math.round(pct * len)).padEnd(len, '□') + ` ${(pct * 100).toFixed(1)}%`;
    }

    // *************** 优化交易逻辑（新增止损逻辑）***************
    function getStockData(stock) {
        return {
            pos: ns.stock.getPosition(stock),
            ask: ns.stock.getAskPrice(stock),
            bid: ns.stock.getBidPrice(stock),
            forecast: ns.stock.getForecast(stock),
            vol: ns.stock.getVolatility(stock),
            maxShares: ns.stock.getMaxShares(stock) * CONFIG.MAX_POSITION_RATIO
        };
    }

    function executeOrder(type, stock, amount, price, isShort = false) {
        const action = isShort ? ns.stock.buyShort : ns.stock.buyStock;
        const cost = action(stock, amount);
        if (cost > 0) {
            const logType = isShort ? '做空' : '做多';
            const emoji = isShort ? '🔴' : '🟢';
            transactionLog.unshift(
                `${emoji} ${stock} ${logType} ×${formatNumberShort(amount, 1)} @ ${formatMoney(price)} 成本:${formatMoney(cost)}`
            );
            ns.toast(`${isShort ? '↓' : '↑'} ${stock} ${logType}`, isShort ? "warning" : "success", CONFIG.TOAST_DURATION);
        }
    }

    // 新增止损检测函数
    function checkStopLoss(stock, posData) {
        const [longPos, longAvg, shortPos, shortAvg] = posData;
        const { bid, ask } = getStockData(stock);
        let triggered = false;

        // 多仓止损检查
        if (longPos > 0) {
            const lossRatio = (bid - longAvg) / longAvg;
            if (lossRatio <= -CONFIG.STOP_LOSS_RATIO) {
                ns.stock.sellStock(stock, longPos);
                const loss = (bid - longAvg) * longPos - 2 * CONFIG.TRANSACTION_FEE;
                totalProfit += loss;
                transactionLog.unshift(
                    `🛑 ${stock} 多仓止损 ×${formatNumberShort(longPos, 1)} 亏损:${formatMoney(loss)} (↓${ns.formatPercent(Math.abs(lossRatio))}`
                );
                triggered = true;
            }
        }

        // 空仓止损检查
        if (shortPos > 0) {
            const lossRatio = (shortAvg - ask) / shortAvg;
            if (lossRatio <= -CONFIG.STOP_LOSS_RATIO) {
                ns.stock.sellShort(stock, shortPos);
                const loss = (shortAvg - ask) * shortPos - 2 * CONFIG.TRANSACTION_FEE;
                totalProfit += loss;
                transactionLog.unshift(
                    `🛑 ${stock} 空仓止损 ×${formatNumberShort(shortPos, 1)} 亏损:${formatMoney(loss)} (↓${ns.formatPercent(Math.abs(lossRatio))}`
                );
                triggered = true;
            }
        }
        return triggered;
    }

    function processBuyOptimized(stock, reserveFunds) {
        const { pos, ask, forecast, vol, maxShares } = getStockData(stock);
        const [longPos, , shortPos] = pos;
        const availableFunds = ns.getPlayer().money - reserveFunds - CONFIG.TRANSACTION_FEE;

        if (forecast >= CONFIG.LONG_THRESHOLD && vol <= CONFIG.MAX_VOLATILITY) {
            const buyQty = Math.min((availableFunds / ask) * 0.95, maxShares - longPos);
            if (buyQty > 10) executeOrder('LONG', stock, buyQty, ask);
        }

        if (CONFIG.SHORT_ENABLED && forecast <= CONFIG.SHORT_THRESHOLD && vol <= CONFIG.MAX_VOLATILITY) {
            const shortQty = Math.min((availableFunds / ask) * 0.95, maxShares - shortPos);
            if (shortQty > 10) executeOrder('SHORT', stock, shortQty, ask, true);
        }
    }

    function processSellOptimized(stock) {
        const stockData = getStockData(stock);
        // 优先执行止损检查
        if (checkStopLoss(stock, stockData.pos)) return;

        const { pos, bid, forecast } = stockData;
        const [longPos, longAvg, shortPos, shortAvg] = pos;

        if (longPos > 0 && forecast < CONFIG.SELL_LONG_THRESHOLD) {
            const profit = (bid - longAvg) * longPos - 2 * CONFIG.TRANSACTION_FEE;
            ns.stock.sellStock(stock, longPos);
            totalProfit += profit;
            transactionLog.unshift(
                `🔵 ${stock} 平多 ×${formatNumberShort(longPos, 1)} 盈利:${formatMoney(profit)} (${profit >= 0 ? '↑' : '↓'}${ns.formatPercent(Math.abs(profit) / (longAvg * longPos))}`
            );
        }

        if (CONFIG.SHORT_ENABLED && shortPos > 0 && forecast > CONFIG.SELL_SHORT_THRESHOLD) {
            const profit = (shortAvg - bid) * shortPos - 2 * CONFIG.TRANSACTION_FEE;
            ns.stock.sellShort(stock, shortPos);
            totalProfit += profit;
            transactionLog.unshift(
                `🟣 ${stock} 平空 ×${formatNumberShort(shortPos, 1)} 盈利:${formatMoney(profit)} (${profit >= 0 ? '↑' : '↓'}${ns.formatPercent(Math.abs(profit) / (shortAvg * shortPos))}`
            );
        }
    }

    // *************** 优化报告生成 ***************
    function generateCompactReport(stocks) {
        return stocks.map(stock => {
            const { forecast, vol, pos } = getStockData(stock);
            return `${stock.padEnd(5)} ${progressBar(forecast, 8)} ${progressBar(vol, 0)}  ` +
                `📈${pos[0] > 0 ? formatNumberShort(pos[0], 1).padEnd(6) : '0'.padEnd(6)} ` +
                `📉${pos[2] > 0 ? formatNumberShort(pos[2], 1).padEnd(6) : '0'.padEnd(6)}`;
        }).join('\n');
    }

    // *************** 主循环优化 ***************
    while (true) {
        ns.clearLog();
        cycleCount++;

        const allStocks = ns.stock.getSymbols().map(stock => ({
            symbol: stock,
            ...getStockData(stock)
        })).sort((a, b) => Math.abs(0.5 - b.forecast) - Math.abs(0.5 - a.forecast));

        let portfolioValue = 0;
        allStocks.forEach(({ symbol, pos, bid }) => {
            processSellOptimized(symbol);
            portfolioValue += pos[0] * bid + pos[2] * (pos[3] - bid);
        });

        // 动态计算保留资金（持仓总值的50%）
        const reserveFunds = portfolioValue * CONFIG.RESVERVE;

        // 执行买入操作时传入动态计算的保留资金
        allStocks.forEach(({ symbol }) => {
            processBuyOptimized(symbol, reserveFunds);
        });

        const currentNetWorth = ns.getPlayer().money + portfolioValue;
        const growthRate = ((currentNetWorth - netWorthHistory) / netWorthHistory * 100 || 0).toFixed(2);
        netWorthHistory = currentNetWorth;

        const statusHeader = `🔄 周期 ${cycleCount} | 运行时长: ${formatDuration(cycleCount * CONFIG.SCRIPT_INTERVAL)}`;
        const portfolioInfo = `总资产 ${formatMoney(currentNetWorth)} | 现金 ${formatMoney(ns.getPlayer().money)} | 持仓 ${formatMoney(portfolioValue)}`;

        ns.print([
            statusHeader,
            "=".repeat(70),
            "🔥 市场热力榜（前5）:\n代码   预测趋势         波动   多仓      空仓",
            generateCompactReport(allStocks.slice(0, 5).map(x => x.symbol)),
            `\n📊 ${portfolioInfo} | 累计收益 ${formatMoney(totalProfit)}`,
            `📈 净值变化: ${growthRate >= 0 ? '+' : ''}${growthRate}% | 止损线: ${ns.formatPercent(CONFIG.STOP_LOSS_RATIO)} | 风险等级: ${CONFIG.RISK_LEVEL}`,
            "\n📜 最近交易:",
            ...transactionLog.slice(0, CONFIG.LOG_LIMIT)
        ].join('\n'));

        await ns.sleep(CONFIG.SCRIPT_INTERVAL);
    }
}
