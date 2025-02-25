/** @param {NS} ns */
export async function main(ns) {
    // 配置参数（增强动态参数）
    const CONFIG = {
        INTERVAL: 2000,                  // 策略执行间隔
        RESERVE_CAPITAL: 1e9,           // 资金保留量
        LONG_ENTRY: 0.60,               // 多头入场阈值
        SHORT_ENTRY: 0.40,              // 空头入场阈值 
        VOLATILITY_LIMIT: 0.05,         // 最大允许波动率
        POSITION_SIZE: 0.25,            // 头寸规模系数
        DYNAMIC_ADJUST: true,           // 启用动态参数调整
        TOAST_DURATION: 15000           // 通知持续时间
    };

    // 全局状态跟踪（新增统计模块）
    const STATE = {
        peakNetWorth: 0,
        totalTrades: { long: 0, short: 0 },
        drawdown: 0,
        marketSentiment: "neutral"
    };
    
    // 增强格式化工具（包含趋势符号）
    const format = {
        money: n => n >= 0 ? '🟢$' + ns.formatNumber(n, 2) : '🔴$' + ns.formatNumber(Math.abs(n), 2),
        bigNumber: n => n >= 0 ? '🟢$' + ns.formatNumber(n, 2) : '🔴$' + ns.formatNumber(Math.abs(n), 2),
        percent: n => ns.formatPercent(n, 2),
        trend: forecast => {
            if (forecast > 0.7) return "▲▲";
            if (forecast > 0.6) return "▲";
            if (forecast < 0.3) return "▼▼";
            if (forecast < 0.4) return "▼";
            return "─";
        },
        volatility: n => {
            const bars = ''.repeat(Math.ceil(n * 20));
            return n > 0.1 ? `🔴${bars}` : `🟢${bars}`;
        }
    };

    // 初始化环境
    ns.disableLog("ALL");
    ns.tail();
    ns.print("🚀 启动增强型股票交易系统 v3.1");
    ns.print(`📊 初始净值: ${format.bigNumber(ns.getPlayer().money)}`);

    // 主循环
    while (true) {
        await ns.sleep(CONFIG.INTERVAL);
        ns.clearLog();

        try {
            const stocks = analyzeMarket(ns);
            updateState(ns, stocks);
            executeTradingLogic(ns, stocks);
            displayDashboard(ns, stocks);
        } catch (e) {
            handleError(ns, e);
        }
    }

    // 市场分析（增强数据采集）
    function analyzeMarket(ns) {
        return ns.stock.getSymbols().map(symbol => ({
            symbol,
            forecast: ns.stock.getForecast(symbol),
            volatility: ns.stock.getVolatility(symbol),
            position: ns.stock.getPosition(symbol),
            price: ns.stock.getBidPrice(symbol),
            maxShares: ns.stock.getMaxShares(symbol)
        }));
    }

    // 状态更新（新增回撤计算）
    function updateState(ns, stocks) {
        const netWorth = stocks.reduce((acc, s) =>
            acc + s.position[0] * s.price + s.position[2] * s.price, ns.getPlayer().money);

        STATE.peakNetWorth = Math.max(STATE.peakNetWorth, netWorth);
        STATE.drawdown = (STATE.peakNetWorth - netWorth) / STATE.peakNetWorth;
    }

    // 交易逻辑（整合动态调整）
    function executeTradingLogic(ns, stocks) {
        const availableFunds = ns.getPlayer().money - CONFIG.RESERVE_CAPITAL;

        // 动态参数调整
        if (CONFIG.DYNAMIC_ADJUST && STATE.drawdown > 0.15) {
            CONFIG.LONG_ENTRY *= 0.95;
            CONFIG.SHORT_ENTRY *= 1.05;
        }

        stocks.forEach(stock => {
            manageExistingPosition(ns, stock);
            evaluateNewPosition(ns, stock, availableFunds);
        });
    }

    // 持仓管理（增强平仓逻辑）
    function manageExistingPosition(ns, stock) {
        const [longShares, longPrice, shortShares, shortPrice] = stock.position;

        // 多头平仓逻辑
        if (longShares > 0 && (
            stock.forecast < CONFIG.LONG_ENTRY - 0.1 ||
            (stock.price - longPrice) / longPrice < -0.1
        )) {
            ns.stock.sellStock(stock.symbol, longShares);
            STATE.totalTrades.long++;
        }

        // 空头平仓逻辑 
        if (shortShares > 0 && (
            stock.forecast > CONFIG.SHORT_ENTRY + 0.1 ||
            (shortPrice - stock.price) / shortPrice < -0.1
        )) {
            ns.stock.sellShort(stock.symbol, shortShares);
            STATE.totalTrades.short++;
        }
    }

    // 开仓评估（优化资金分配）
    function evaluateNewPosition(ns, stock, funds) {
        const positionValue = stock.position[0] * stock.price + stock.position[2] * stock.price;
        const maxPosition = stock.maxShares * stock.price * CONFIG.POSITION_SIZE;
        const allocatable = Math.min(funds, maxPosition - positionValue);

        if (stock.forecast > CONFIG.LONG_ENTRY && stock.volatility < CONFIG.VOLATILITY_LIMIT) {
            const shares = Math.min(allocatable / stock.price, stock.maxShares - stock.position[0]);
            ns.stock.buyStock(stock.symbol, shares);
            STATE.totalTrades.long++;
        }

        if (stock.forecast < CONFIG.SHORT_ENTRY && stock.volatility < CONFIG.VOLATILITY_LIMIT) {
            const shares = Math.min(allocatable / stock.price, stock.maxShares - stock.position[2]);
            ns.stock.buyShort(stock.symbol, shares);
            STATE.totalTrades.short++;
        }
    }

    // 仪表盘显示（增强可视化）
    function displayDashboard(ns, stocks) {
        const netWorth = ns.getPlayer().money + stocks.reduce((acc, s) =>
            acc + s.position[0] * s.price + s.position[2] * s.price, 0);

        // 头部状态
        ns.print("═".repeat(60));
        ns.print(`📅 ${new Date().toLocaleTimeString()} | 📈 市场情绪: ${getMarketSentiment(stocks)}`);
        ns.print(`📊 当前净值: ${format.bigNumber(netWorth)} | 🏔️ 峰值净值: ${format.bigNumber(STATE.peakNetWorth)}`);
        ns.print(`📉 最大回撤: ${ns.formatPercent(STATE.drawdown)} | 🔄 交易次数: 多 ${STATE.totalTrades.long} 空 ${STATE.totalTrades.short}`);
        ns.print("═".repeat(60));

        // 持仓明细
        stocks.filter(s => s.position[0] + s.position[2] > 0)
            .sort((a, b) => getPositionValue(b) - getPositionValue(a))
            .forEach((s, i) => {
                ns.print([
                    `${i + 1}. ${s.symbol.padEnd(5)}`,
                    `${format.trend(s.forecast)} ${ns.formatPercent(s.forecast).padStart(6)}`,
                    `波动 ${format.volatility(s.volatility)}`,
                    `多头 ${renderPosition(s.position[0], s.price, s.position[1])}`,
                    `空头 ${renderPosition(s.position[2], s.price, s.position[3])}`,
                    `价值 ${format.money(getPositionValue(s))}`
                ].join(" | "));
            });

        // 辅助函数
        function getMarketSentiment(stocks) {
            const bullCount = stocks.filter(s => s.forecast > 0.6).length;
            return bullCount > 10 ? "🔥 牛市" : bullCount < 5 ? "❄️ 熊市" : "🌤️ 震荡";
        }

        function renderPosition(shares, current, entry) {
            if (shares === 0) return "─";
            const pct = ((current - entry) / entry * 100).toFixed(1);
            return `${ns.formatNumber(shares, 1)}K (${pct}%)`;
        }

        function getPositionValue(stock) {
            return stock.position[0] * stock.price + stock.position[2] * stock.price;
        }
    }

    // 错误处理（新增分类记录）
    function handleError(ns, error) {
        ns.print(`⚠️ 错误: ${error.message.split(".")[0]}...`);
        ns.toast(error.message, "error", CONFIG.TOAST_DURATION);
    }
}
