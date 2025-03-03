/** 
 * Bitburner 股票自动交易脚本 v6.1
 * 新增市场预测指标+四因子量化模型
 * @param {NS} ns 
 **/
export async function main(ns) {
  // ===================== 核心配置 =====================
  // const min = ns.stock.getConstants().msPerStockUpdateMin;
  // const max = ns.stock.getConstants().msPerStockUpdate;

  const CONFIG = {
    RISK_PER_TRADE: 0.02,          // 单笔交易风险比例（占账户总资金）
    MAX_EXPOSURE: 0.8,             // 最大持仓比例（总仓位限制）
    TREND_WINDOW: 5,               // 短期均线窗口（趋势判断）
    BASE_WINDOW: 20,               // 长期均线窗口（基线判断）
    RSI_WINDOW: 14,                // RSI计算窗口（超买超卖指标）
    VOLATILITY_FILTER: 0.4,        // 波动率过滤阈值（筛选稳定标的）
    STOP_LOSS: 0.08,               // 动态止损比例（亏损5%平仓）
    TAKE_PROFIT: 0.15,             // 动态止盈比例（盈利15%平仓）
    // REFRESH_INTERVAL: Math.floor(Math.random() * (max - min + 1)) + min,
    ENABLE_SHORT: true,            // 启用做空（允许空头交易）
    MAX_SHARE_RATIO: 0.1,          // 最大持股比例（单标的最大持股比例）
    FORECAST_BUY: 0.60,            // 多头预测阈值（新增配置）
    FORECAST_SELL: 0.40            // 空头预测阈值（新增配置）
  };

  // ===================== 全局状态 =====================
  const STATE = {
    symbols: ns.stock.getSymbols(), // 获取所有股票代码
    history: new Map(),            // 历史价格数据（存储各股票技术指标）
    transactions: [],              // 交易记录（用于统计和显示）
    metrics: {                     // 性能指标（跟踪系统表现）
      totalProfit: 0,
      winRate: 0,
      maxDrawdown: 0,
      peakNetWorth: 0
    }
  };

  // ===================== 初始化 =====================
  ns.disableLog("ALL");
  ns.setTitle("🚀量子交易系统 v6.1")
  ns.tail();                       // 打开独立显示窗口
  ns.resizeTail(680, 500);
  ns.moveTail(1100, 0);
  ns.print("加载中...");

  // 初始化历史数据结构
  for (const sym of STATE.symbols) {
    STATE.history.set(sym, {
      prices: [],                 // 价格序列（用于计算指标）
      maShortSum: 0,              // 短期均线累加值（滑动窗口优化）
      maShortWindow: [],          // 短期均线窗口数据
      maLongSum: 0,               // 长期均线累加值
      maLongWindow: [],           // 长期均线窗口数据
      rsi: 50                     // RSI初始值（中性水平）
    });
    updateHistory(sym); // 同步初始化
  }

  // ===================== 主循环 =====================
  let i = 0
  while (true) {
    i++;
    if (!ns.stock.has4SDataTIXAPI()) {
      ns.print(`等待4S API权限... (${i}次重试)`);
      await ns.sleep(5000);
      continue;
    };
    await ns.stock.nextUpdate()
    // await ns.sleep(CONFIG.REFRESH_INTERVAL);
    ns.clearLog();

    try {
      // 并行更新市场数据
      STATE.symbols.forEach(sym => updateHistory(sym));

      // 执行交易逻辑
      STATE.symbols.forEach(sym => {
        const analysis = analyzeStock(sym);
        managePosition(sym, analysis);
        executeTrades(sym, analysis);
      });

      updateMetrics();
      displayDashboard(ns);

    } catch (e) {
      handleError(ns, e);
    }
  }

  // ===================== 核心功能 =====================
  /** 更新股票历史数据和指标 */
  function updateHistory(sym) {
    const data = STATE.history.get(sym);
    const price = ns.stock.getPrice(sym);

    data.prices.push(price);
    if (data.prices.length > 100) data.prices.shift();

    updateMA(data, 'maShort', CONFIG.TREND_WINDOW, price);
    updateMA(data, 'maLong', CONFIG.BASE_WINDOW, price);
    data.rsi = calculateRSI(data.prices);
  }

  /** 滑动窗口法更新移动平均线 */
  function updateMA(data, type, window, price) {
    const queue = data[`${type}Window`];
    const sumKey = `${type}Sum`;

    queue.push(price);
    data[sumKey] += price;

    if (queue.length > window) {
      const removed = queue.shift();
      data[sumKey] -= removed;
    }

    data[type] = data[sumKey] / queue.length;
  }

  /** 生成股票分析报告 */
  function analyzeStock(sym) {
    const data = STATE.history.get(sym);
    return {
      symbol: sym,
      bidPrice: ns.stock.getBidPrice(sym),
      askPrice: ns.stock.getAskPrice(sym),
      trend: data.maShort > data.maLong ? 'bull' : 'bear',
      rsi: data.rsi,
      volatility: ns.stock.getVolatility(sym),
      momentum: (data.maShort - data.maLong) / data.maLong * 100,
      forecast: ns.stock.getForecast(sym)
    };
  }

  // ===================== 交易逻辑增强 ===================== 
  /** 执行交易决策 */
  function executeTrades(sym, analysis) {
    const [longShares, , shortShares] = ns.stock.getPosition(sym);
    const position = calculatePosition(sym, analysis);

    // 多头开仓四因子验证
    if (analysis.trend === 'bull' && longShares === 0) {
      if (analysis.forecast > CONFIG.FORECAST_BUY &&
        analysis.rsi < 40 &&
        analysis.volatility < CONFIG.VOLATILITY_FILTER) {
        const cost = position * analysis.askPrice;
        if (cost > ns.getServerMoneyAvailable('home')) return;

        const bought = ns.stock.buyStock(sym, position);
        if (bought > 0) logTransaction('📈多', sym, bought, analysis.askPrice);
      }
    }

    // 空头开仓四因子验证
    if (CONFIG.ENABLE_SHORT && analysis.trend === 'bear' && shortShares === 0) {
      if (analysis.forecast < CONFIG.FORECAST_SELL &&
        analysis.rsi > 60 &&
        analysis.volatility < CONFIG.VOLATILITY_FILTER) {
        const sold = ns.stock.buyShort(sym, position);
        if (sold > 0) logTransaction('📉空', sym, sold, analysis.bidPrice);
      }
    }
  }

  /** 仓位管理 */
  function managePosition(sym, analysis) {
    const [long, longAvg, short, shortAvg] = ns.stock.getPosition(sym);

    if (long > 0) {
      const profitRatio = (analysis.bidPrice - longAvg) / longAvg;
      if (profitRatio <= -CONFIG.STOP_LOSS || profitRatio >= CONFIG.TAKE_PROFIT) {
        const sold = ns.stock.sellStock(sym, long);
        if (sold > 0) logTransaction('平多', sym, -long, analysis.bidPrice);
      }
    }

    if (short > 0) {
      const profitRatio = (shortAvg - analysis.askPrice) / shortAvg;
      if (profitRatio <= -CONFIG.STOP_LOSS || profitRatio >= CONFIG.TAKE_PROFIT) {
        const bought = ns.stock.sellShort(sym, short);
        if (bought > 0) logTransaction('平空', sym, -short, analysis.askPrice);
      }
    }
  }

  /** 计算头寸规模 */
  function calculatePosition(sym, analysis) {
    const portfolio = getNetWorth();
    const exposure = getCurrentExposure();
    const available = CONFIG.MAX_EXPOSURE * portfolio - exposure;
    if (available <= 0) return 0;

    const riskCapital = Math.min(available, portfolio * CONFIG.RISK_PER_TRADE);
    const maxShares = Math.min(
      ns.stock.getMaxShares(sym) * CONFIG.MAX_SHARE_RATIO,
      riskCapital / analysis.askPrice
    );

    return Math.floor(maxShares);
  }

  // ===================== 增强仪表盘 =====================
  /** 显示交易控制面板 */
  function displayDashboard(ns) {
    ns.print("╒═══════════════════════════ 量子交易面板 ═══════════════════════════╕");
    ns.print([
      `│ ⏰${formatTime()}`,
      `💰净值 ${fmtMoney(getNetWorth()).padEnd(8)}`,
      `风险 ${fmtPct(getRisk())}`,
      `杠杆 ${getLeverage().toFixed(1)}x │`
    ].join(' │ ').padEnd(62) + '│')
    ns.print("╞══════════════════════════════════════════════════════════════════╡");

    ns.print("├───────────────────────────📦 核心持仓 ────────────────────────────┤");
    getActivePositions().slice(0, 10).forEach((p, i) =>
      ns.print(` ${fmtPos(ns, p, i + 1)} `)
    );

    ns.print("├───────────────────────────🔔 最新交易 ────────────────────────────┤");
    STATE.transactions.slice(-3).forEach(t =>
      ns.print(` ${t.time} ${t.icon} ${t.sym} ${fmtNum(t.shares, 2)}股 @ ${fmtMoney(t.price)} `)
    );

    ns.print("╘══════════════════════════════════════════════════════════════════╛");
  }

  /** 格式化持仓信息 */
  function fmtPos(ns, pos, idx) {
    const icon = pos.trend === 'bull' ? '▲' : '▽';
    const forecastColor = pos.forecast > 0.6 ? '🟢' : pos.forecast < 0.4 ? '🔴' : '⚪';
    return [
      `${idx.toString().padStart(2)}. ${pos.sym.padEnd(5)} ${icon}`,
      `预测${forecastColor} ${fmtPct(pos.forecast).padEnd(5)}`,
      `RSI ${pos.rsi.toFixed(0).padEnd(3)}`,
      `波动 ${fmtPct(pos.volatility).padEnd(4)}`,
      `持仓 ${fmtMoney(pos.value).padEnd(8)}`
    ].join(' │ ').padEnd(61);
  }

  // ===================== 工具函数 =====================
  /** 记录交易日志 */
  function logTransaction(icon, sym, shares, price) {
    STATE.transactions.push({
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 8),
      icon: icon,
      sym: sym,
      shares: shares,
      price: price
    });
  }

  /** 计算总净值 */
  function getNetWorth() {
    let total = ns.getServerMoneyAvailable('home');
    for (const sym of STATE.symbols) {
      const [long, lAvg, short, sAvg] = ns.stock.getPosition(sym);
      total += long * ns.stock.getBidPrice(sym);
      total += short * (sAvg - ns.stock.getAskPrice(sym));
    }
    return total;
  }

  /** 获取当前总持仓市值 */
  function getCurrentExposure() {
    return STATE.symbols.reduce((sum, sym) => {
      const [long] = ns.stock.getPosition(sym);
      return sum + long * ns.stock.getBidPrice(sym);
    }, 0);
  }

  /** 计算当前风险 */
  function getRisk() {
    const current = getNetWorth();
    STATE.metrics.peakNetWorth = Math.max(STATE.metrics.peakNetWorth, current);
    return (STATE.metrics.peakNetWorth - current) / STATE.metrics.peakNetWorth;
  }

  /** 计算杠杆率 */
  function getLeverage() {
    const equity = ns.getServerMoneyAvailable('home');
    return equity > 0 ? (getNetWorth() - equity) / equity : 0;
  }

  /** 获取有效持仓列表 */
  function getActivePositions() {
    return STATE.symbols.map(sym => {
      const [long] = ns.stock.getPosition(sym);
      if (long === 0) return null;
      const analysis = analyzeStock(sym);
      return {
        sym: sym,
        trend: analysis.trend,
        price: analysis.bidPrice,
        rsi: analysis.rsi,
        volatility: analysis.volatility,
        value: long * analysis.bidPrice,
        forecast: analysis.forecast
      };
    }).filter(p => p !== null);
  }

  /** 计算RSI */
  function calculateRSI(prices) {
    if (prices.length < CONFIG.RSI_WINDOW + 1) return 50;

    let gains = 0, losses = 0;
    for (let i = prices.length - CONFIG.RSI_WINDOW; i < prices.length - 1; i++) {
      const delta = prices[i + 1] - prices[i];
      delta > 0 ? gains += delta : losses -= delta;
    }

    const avgGain = gains / CONFIG.RSI_WINDOW;
    const avgLoss = losses / CONFIG.RSI_WINDOW;
    return avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }

  /** 更新胜率指标 */
  function updateMetrics() {
    const wins = STATE.transactions.filter(t =>
      t.shares > 0 ? t.price < ns.stock.getBidPrice(t.sym)
        : t.price > ns.stock.getAskPrice(t.sym)
    ).length;
    STATE.metrics.winRate = wins / (STATE.transactions.length || 1);
  }

  // 格式化工具
  function fmtMoney(num) { return (num < 0 ? '-$' : '$') + ns.formatNumber(Math.abs(num), 2) }
  function fmtNum(num) { return ns.formatNumber(num, 0) }
  function fmtPct(num) { return ns.formatPercent(num, 1) }
  function formatTime() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
  function handleError(ns, error) { ns.print(`⚠️ 错误: ${error}`); }
}
