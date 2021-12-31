import {
    formatMoney, formatNumberShort, formatDuration,
    getNsDataThroughFile, runCommand, getActiveSourceFiles, tryGetBitNodeMultipliers
} from './helpers.js'

let disableShorts = false;
let commission = 100000; // Buy/sell commission. Expected profit must exceed this to buy anything.
let totalProfit = 0.0; // We can keep track of how much we've earned since start.
let lastLog = ""; // We update faster than the stock-market ticks, but we don't log anything unless there's been a change
let allStockSymbols = []; // Stores the set of all symbols collected at start
let mock = false; // If set to true, will "mock" buy/sell but not actually buy/sell anythingorecast
let noisy = false; // If set to true, tprints and announces each time stocks are bought/sold
// Pre-4S configuration (influences how we play the stock market before we have 4S data, after which everything's fool-proof)
let showMarketSummary = false;  // If set to true, will always generate and display the pre-4s forecast table in a separate tail window
let minTickHistory; // This much history must be gathered before we will offer a stock forecast.
let longTermForecastWindowLength; // This much history will be used to determine the historical probability of the stock (so long as no inversions are detected)
let nearTermForecastWindowLength; // This much history will be used to detect recent negative trends and act on them immediately.
// The following pre-4s constants are hard-coded (not configurable via command line) but may require tweaking
const marketCycleLength = 75; // Every this many ticks, all stocks have a 45% chance of "reversing" their probability. Something we must detect and act on quick to not lose profits.
const maxTickHistory = 151; // This much history will be kept for purposes of detemining volatility and perhaps one day pinpointing the market cycle tick
const inversionDetectionTolerance = 0.10; // If the near-term forecast is within this distance of (1 - long-term forecast), consider it a potential "inversion"
const inversionLagTolerance = 5; // An inversion is "trusted" up to this many ticks after the normal nearTermForecastWindowLength expected detection time
// (Note: 33 total stocks * 45% inversion chance each cycle = ~15 expected inversions per cycle)
// The following pre-4s values are set during the lifetime of the program
let marketCycleDetected = false; // We should not make risky purchasing decisions until the stock market cycle is detected. This can take a long time, but we'll be thanked
let detectedCycleTick = 0; // This will be reset to zero once we've detected the market cycle point.
let inversionAgreementThreshold = 6; // If this many stocks are detected as being in an "inversion", consider this the stock market cycle point
const expectedTickTime = 6000;
const catchUpTickTime = 4000;
let lastTick = 0;
let sleepInterval = 1000;


const argsSchema = [
    ['l', false], // Stop any other running stockmaster.js instances and sell all stocks
    ['liquidate', false],
    ['mock', false], // If set to true, will "mock" buy/sell but not actually buy/sell anything
    ['noisy', false], // If set to true, tprints and announces each time stocks are bought/soldgetHostnames
    ['disable-shorts', false], // If set to true, will "mock" buy/sell but not actually buy/sell anything
    ['reserve', 0], // A fixed amount of money to not spend
    ['fracB', 0.4], // Fraction of assets to have as liquid before we consider buying more stock
    ['fracH', 0.2], // Fraction of assets to retain as cash in hand when buying
    ['buy-threshold', 0.0001], // Buy only stocks forecasted to earn better than a 0.01% return (1 Basis Point)
    ['sell-threshold', 0], // Sell stocks forecasted to earn less than this return (default 0% - which happens when prob hits 50% or worse)
    ['diversification', 0.34], // Before we have 4S data, we will not hold more than this fraction of our portfolio as a single stock
    ['disableHud', false], // Disable showing stock value in the HUD panel
    // The following settings are related only to tweaking pre-4s stock-market logic
    ['show-pre-4s-forecast', false], // If set to true, will always generate and display the pre-4s forecast (if false, it's only shown while we hold no stocks)
    ['show-market-summary', false], // Same effect as "show-pre-4s-forecast", this market summary has become so informative, it's valuable even with 4s
    ['pre-4s-buy-threshold-probability', 0.15], // Before we have 4S data, only buy stocks whose probability is more than this far away from 0.5, to account for imprecision
    ['pre-4s-buy-threshold-return', 0.0015], // Before we have 4S data, Buy only stocks forecasted to earn better than this return (default 0.25% or 25 Basis Points)
    ['pre-4s-sell-threshold-return', 0.0005], // Before we have 4S data, Sell stocks forecasted to earn less than this return (default 0.15% or 15 Basis Points)
    ['pre-4s-min-tick-history', 21], // This much history must be gathered before we will use pre-4s stock forecasts to make buy/sell decisions. (Default 21)
    ['pre-4s-forecast-window', 51], // This much history will be used to determine the historical probability of the stock (so long as no inversions are detected) (Default 76)
    ['pre-4s-inversion-detection-window', 10], // This much history will be used to detect recent negative trends and act on them immediately. (Default 10)
    ['pre-4s-min-blackout-window', 10], // Do not make any new purchases this many ticks before the detected stock market cycle tick, to avoid buying a position that reverses soon after
    ['pre-4s-minimum-hold-time', 10], // A recently bought position must be held for this long before selling, to avoid rash decisions due to noise after a fresh market cycle. (Default 10)
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** Requires access to the TIX API. Purchases access to the 4S Mkt Data API as soon as it can 
 * @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    // Extract various options from the args (globals, purchasing decision factors, pre-4s factors)
    const options = ns.flags(argsSchema);
    mock = options.mock;
    noisy = options.noisy;
    const fracB = options.fracB;
    const fracH = options.fracH;
    const diversification = options.diversification;
    const disableHud = options.disableHud || options.liquidate || options.mock;
    disableShorts = options['disable-shorts'];
    const pre4sBuyThresholdProbability = options['pre-4s-buy-threshold-probability'];
    const pre4sMinBlackoutWindow = options['pre-4s-min-blackout-window'] || 1;
    const pre4sMinHoldTime = options['pre-4s-minimum-hold-time'] || 0;
    minTickHistory = options['pre-4s-min-tick-history'] || 21;
    nearTermForecastWindowLength = options['pre-4s-inversion-detection-window'] || 10;
    longTermForecastWindowLength = options['pre-4s-forecast-window'] || (marketCycleLength + 1);
    showMarketSummary = options['show-pre-4s-forecast'] || options['show-market-summary'];
    // Other global values must be reset at start lest they be left in memory from a prior run
    lastTick = 0, totalProfit = 0, lastLog = "", marketCycleDetected = false, detectedCycleTick = 0, inversionAgreementThreshold = 6;
    let corpus = 0, myStocks = [], allStocks = [];

    if (!ns.getPlayer().hasTixApiAccess) // You cannot use the stockmaster until you have API access
        return log(ns, "ERROR: You have to buy stock market access and API access before you can run this script!", true);

    if (options.l || options.liquidate) // If given the "liquidate" command, try to kill the version of ourself trading in stocks
        await runCommand(ns, `ns.ps().filter(proc => proc.filename == '${ns.getScriptName()}' && !proc.args.includes('-l') && !proc.args.includes('--liquidate'))` +
            `.forEach(proc => ns.kill(proc.pid))`, '/Temp/kill-script.js');

    let dictSourceFiles = await getActiveSourceFiles(ns); // Find out what source files the user has unlocked
    if (!disableShorts && (!(8 in dictSourceFiles) || dictSourceFiles[8] < 2)) {
        log(ns, "INFO: Shorting stocks has been disabled (you have not yet unlocked access to shorting)");
        disableShorts = true;
    }

    allStockSymbols = await getNsDataThroughFile(ns, 'ns.stock.getSymbols()', '/Temp/stock-symbols.txt');
    allStocks = await initAllStocks(ns, allStockSymbols);

    if (options.l || options.liquidate) {
        await liquidate(ns, allStockSymbols); // Sell all stocks
        return;
    } else if (!options.mock) { // If we're not liquidating or in mock mode, we MUST not run two stockmasters at once, or chaos will ensue
        let otherStockmasters = (await getNsDataThroughFile(ns, `ns.ps()`, '/Temp/process-list.txt')).filter(p => p.filename == ns.getScriptName()); // TODO: For bonus points, check all servers
        otherStockmasters = otherStockmasters.filter(p => JSON.stringify(ns.args) != JSON.stringify(p.args)); // Don't detect ourselves of course.
        if (otherStockmasters.some(p => !p.args.includes("--mock"))) // Exception, feel free to run multiple stockmasters in mock mode
            return log(ns, `ERROR: Another version of ${ns.getScriptName()} is already running with different args. Running twice is a bad idea!`, true, 'error');
    }

    // Assume bitnode mults are 1 if user doesn't have this API access yet
    let bitnodeMults = (await tryGetBitNodeMultipliers(ns)) ?? { FourSigmaMarketDataCost: 1, FourSigmaMarketDataApiCost: 1 };

    if (showMarketSummary) await launchSummaryTail(ns); // Opens a separate script / window to continuously display the Pre4S forecast

    let hudElement = null;
    if (!disableHud) {
        hudElement = initializeHud();
        ns.atExit(() => hudElement.parentElement.parentElement.parentElement.removeChild(hudElement.parentElement.parentElement));
    }

    log(ns, `Welcome! Please note: all stock purchases will initially result in a Net (unrealized) Loss. This is not only due to commission, but because each stock has a 'spread' (difference in buy price and sell price). ` +
        `This script is designed to buy stocks that are most likely to surpass that loss and turn a profit, but it will take a few minutes to see the progress.\n\n` +
        `If you choose to stop the script, make sure you SELL all your stocks (can go 'run ${ns.getScriptName()} --liquidate') to get your money back.\n\nGood luck!\n~ Insight\n\n`)

    while (true) {
        const playerStats = ns.getPlayer();
        const pre4s = !playerStats.has4SDataTixApi;
        corpus = await refresh(ns, playerStats, allStocks, myStocks);
        if (pre4s && !mock && await tryGet4SApi(ns, playerStats, bitnodeMults, corpus, allStockSymbols))
            continue; // Start the loop over if we just bought 4S API access
        // Be more conservative with our decisions if we don't have 4S data
        const thresholdToBuy = pre4s ? options['pre-4s-buy-threshold-return'] : options['buy-threshold'];
        const thresholdToSell = pre4s ? options['pre-4s-sell-threshold-return'] : options['sell-threshold'];
        if (myStocks.length > 0)
            doStatusUpdate(ns, allStocks, myStocks, hudElement);
        if (pre4s && allStocks[0].priceHistory.length < minTickHistory) {
            log(ns, `Building a history of stock prices (${allStocks[0].priceHistory.length}/${minTickHistory})...`);
            await ns.sleep(sleepInterval);
            continue;
        }

        // Sell forecasted-to-underperform shares (worse than some expected return threshold)
        let sales = 0;
        for (let stk of myStocks) {
            if (stk.absReturn() <= thresholdToSell || stk.bullish() && stk.sharesShort > 0 || stk.bearish() && stk.sharesLong > 0) {
                if (pre4s && stk.ticksHeld < pre4sMinHoldTime) {
                    if (!stk.warnedBadPurchase) log(ns, `WARNING: Thinking of selling ${stk.sym} with ER ${formatBP(stk.absReturn())}, but holding out as it was purchased just ${stk.ticksHeld} ticks ago...`);
                    stk.warnedBadPurchase = true; // Hack to ensure we don't spam this warning
                } else {
                    sales += await doSellAll(ns, stk);
                    stk.warnedBadPurchase = false;
                }
            }
        }
        if (sales > 0) continue; // If we sold anything, loop immediately (no need to sleep) and refresh stats immediately before making purchasing decisions.

        let cash = playerStats.money - options['reserve'] - Number(ns.read("reserve.txt") || 0);
        let liquidity = cash / corpus;
        // If we haven't gone above a certain liquidity threshold, don't attempt to buy more stock
        // Avoids death-by-a-thousand-commissions before we get super-rich, stocks are capped, and this is no longer an issue
        // BUT may mean we miss striking while the iron is hot while waiting to build up more funds.
        if (liquidity > fracB) {
            // If we haven't detected the market cycle (or haven't detected it reliably), assume it might be quite soon and restrict bets to those that can turn a profit in the very-near term.
            const estTick = Math.max(detectedCycleTick, marketCycleLength - (!marketCycleDetected ? 5 : inversionAgreementThreshold <= 8 ? 15 : inversionAgreementThreshold <= 10 ? 30 : marketCycleLength));
            // Buy shares with cash remaining in hand if exceeding some buy threshold. Prioritize targets whose expected return will cover the ask/bit spread the soonest
            for (const stk of allStocks.sort(purchaseOrder)) {
                // Do not purchase a stock if it is not forecasted to recover from the ask/bid spread before the next market cycle and potential probability inversion
                if (stk.blackoutWindow() >= marketCycleLength - estTick) continue;
                if (pre4s && (Math.max(pre4sMinHoldTime, pre4sMinBlackoutWindow) >= marketCycleLength - estTick)) continue;
                // Compute the cash we have to spend (such that spending it all on stock would bring us down to a liquidity of fracH)
                let budget = cash - (fracH * corpus);
                if (budget <= 0) break; // Break if we are out of money (i.e. from prior purchases)
                // Skip if we already own all possible shares in this stock, or if the expected return is below our threshold, or if shorts are disabled and stock is bearish
                if (stk.ownedShares() == stk.maxShares || stk.absReturn() <= thresholdToBuy || (disableShorts && stk.bearish())) continue;
                // If pre-4s, do not purchase any stock whose last inversion was too recent, or whose probability is too close to 0.5
                if (pre4s && (stk.lastInversion < minTickHistory || Math.abs(stk.prob - 0.5) < pre4sBuyThresholdProbability)) continue;

                // Enforce diversification - don't hold more than x% of our portfolio as a single stock (as corpus increases, this naturally stops being a limiter)
                budget = Math.min(budget, (1 - fracH) * corpus * diversification - stk.positionValue())
                let purchasePrice = stk.bullish() ? stk.ask_price : stk.bid_price; // Depends on whether we will be buying a long or short position
                let affordableShares = Math.floor((budget - commission) / purchasePrice);
                let numShares = Math.min(stk.maxShares - stk.ownedShares(), affordableShares);
                if (numShares <= 0) continue;
                // Don't buy fewer shares than can beat the comission before the next stock market cycle (after covering the spread), lest the position reverse before we break-even.
                let ticksBeforeCycleEnd = marketCycleLength - estTick - stk.timeToCoverTheSpread();
                if (ticksBeforeCycleEnd < 1) continue; // We're cutting it too close to the market cycle, position might reverse before we break-even on commission
                let estEndOfCycleValue = numShares * purchasePrice * ((stk.absReturn() + 1) ** ticksBeforeCycleEnd - 1); // Expected difference in purchase price and value at next market cycle end
                if (estEndOfCycleValue <= 2 * commission)
                    log(ns, `Despite attractive ER of ${formatBP(stk.absReturn())}, ${stk.sym} was not bought. Budget: ${formatMoney(budget)} can only buy ${numShares} shares @ ${formatMoney(purchasePrice)}. ` +
                        `Given an estimated ${marketCycleLength - estTick} ticks left in market cycle, less ${stk.timeToCoverTheSpread().toFixed(1)} ticks to cover the spread (${(stk.spread_pct * 100).toFixed(2)}%), ` +
                        `remaining ${ticksBeforeCycleEnd.toFixed(1)} ticks would only generate ${formatMoney(estEndOfCycleValue)}, which is less than 2x commission (${formatMoney(2 * commission, 3)})`);
                else
                    cash -= await doBuy(ns, stk, numShares);
            }
        }
        await ns.sleep(sleepInterval);
    }
}

/* A sorting function to put stocks in the order we should prioritize investing in them */
let purchaseOrder = (a, b) => (Math.ceil(a.timeToCoverTheSpread()) - Math.ceil(b.timeToCoverTheSpread())) || (b.absReturn() - a.absReturn());

/* Generic helper for dodging the hefty RAM requirements of stock functions by spawning a temporary script to collect info for us. */
let getStockInfoDict = async (ns, stockFuncion) => await getNsDataThroughFile(ns,
    `Object.fromEntries(${JSON.stringify(allStockSymbols)}.map(sym => [sym, ns.stock.${stockFuncion}(sym)]))`, `/Temp/stock-${stockFuncion}.txt`);

/** @param {NS} ns **/
async function initAllStocks(ns, allStockSymbols) {
    let dictMaxShares = await getStockInfoDict(ns, 'getMaxShares'); // Only need to get this once, it never changes
    return allStockSymbols.map(s => ({
        sym: s,
        maxShares: dictMaxShares[s], // Value never changes once retrieved
        expectedReturn: function () { // How much holdings are expected to appreciate (or depreciate) in the future
            // To add conservatism to pre-4s estimates, we reduce the probability by 1 standard deviation without crossing the midpoint
            let normalizedProb = (this.prob - 0.5);
            let conservativeProb = normalizedProb < 0 ? Math.min(0, normalizedProb + this.probStdDev) : Math.max(0, normalizedProb - this.probStdDev);
            return this.vol * conservativeProb;
        },
        absReturn: function () { return Math.abs(this.expectedReturn()); }, // Appropriate to use when can just as well buy a short position as a long position
        bullish: function () { return this.prob > 0.5 },
        bearish: function () { return !this.bullish(); },
        ownedShares: function () { return this.sharesLong + this.sharesShort; },
        owned: function () { return this.ownedShares() > 0; },
        positionValueLong: function () { return this.sharesLong * this.bid_price; },
        positionValueShort: function () { return this.sharesShort * (2 * this.boughtPriceShort - this.ask_price); }, // Shorts work a bit weird
        positionValue: function () { return this.positionValueLong() + this.positionValueShort(); },
        // How many stock market ticks must occur at the current expected return before we regain the value lost by the spread between buy and sell prices.
        // This can be derived by taking the compound interest formula (future = current * (1 + expected_return) ^ n) and solving for n
        timeToCoverTheSpread: function () { return Math.log(this.ask_price / this.bid_price) / Math.log(1 + this.absReturn()); },
        // We should not buy this stock within this many ticks of a Market cycle, or we risk being forced to sell due to a probability inversion, and losing money due to the spread
        blackoutWindow: function () { return Math.ceil(this.timeToCoverTheSpread()); },
        // Pre-4s properties used for forecasting
        priceHistory: [],
        lastInversion: 0,
    }));
}

/** @param {NS} ns **/
async function refresh(ns, playerStats, allStocks, myStocks) {
    const has4s = playerStats.has4SDataTixApi;
    let corpus = playerStats.money;

    // Dodge hefty RAM requirements by spawning a sequence of temporary scripts to collect info for us one function at a time
    const dictAskPrices = await getStockInfoDict(ns, 'getAskPrice');
    const dictBidPrices = await getStockInfoDict(ns, 'getBidPrice');
    const dictVolatilities = !has4s ? null : await getStockInfoDict(ns, 'getVolatility');
    const dictForecasts = !has4s ? null : await getStockInfoDict(ns, 'getForecast');
    const dictPositions = mock ? null : await getStockInfoDict(ns, 'getPosition');
    const ticked = allStocks.some(stk => stk.ask_price != dictAskPrices[stk.sym]); // If any price has changed since our last update, the stock market has "ticked"

    if (ticked) {
        if (Date.now() - lastTick < expectedTickTime - sleepInterval) {
            if (Date.now() - lastTick < catchUpTickTime - sleepInterval) {
                let changedPrices = allStocks.filter(stk => stk.ask_price != dictAskPrices[stk.sym]);
                log(ns, `WARNING: Detected a stock market tick after only ${formatDuration(Date.now() - lastTick)}, but expected ~${formatDuration(expectedTickTime)}. ` +
                    (changedPrices.length >= 33 ? '(All stocks updated)' : `The following ${changedPrices.length} stock prices changed: ${changedPrices.map(stk =>
                        `${stk.sym} ${formatMoney(stk.ask_price)} -> ${formatMoney(dictAskPrices[stk.sym])}`).join(", ")}`), false, 'warning');
            } else
                log(ns, `INFO: Detected a rapid stock market tick (${formatDuration(Date.now() - lastTick)}), likely to make up for lag / offline time.`)
        }
        lastTick = Date.now()
    }

    myStocks.length = 0;
    for (const stk of allStocks) {
        const sym = stk.sym;
        stk.ask_price = dictAskPrices[sym]; // The amount we would pay if we bought the stock (higher than 'price')
        stk.bid_price = dictBidPrices[sym]; // The amount we would recieve if we sold the stock (lower than 'price')
        stk.spread = stk.ask_price - stk.bid_price;
        stk.spread_pct = stk.spread / stk.ask_price; // The percentage of value we lose just by buying the stock
        stk.price = (stk.ask_price + stk.bid_price) / 2; // = ns.stock.getPrice(sym);
        stk.vol = has4s ? dictVolatilities[sym] : stk.vol;
        stk.prob = has4s ? dictForecasts[sym] : stk.prob;
        stk.probStdDev = has4s ? 0 : stk.probStdDev; // Standard deviation around the est. probability
        // Update our current portfolio of owned stock
        let [priorLong, priorShort] = [stk.sharesLong, stk.sharesShort];
        stk.position = mock ? null : dictPositions[sym];
        stk.sharesLong = mock ? (stk.sharesLong || 0) : stk.position[0];
        stk.boughtPrice = mock ? (stk.boughtPrice || 0) : stk.position[1];
        stk.sharesShort = mock ? (stk.shares_short || 0) : stk.position[2];
        stk.boughtPriceShort = mock ? (stk.boughtPrice_short || 0) : stk.position[3];
        corpus += stk.positionValue();
        if (stk.owned()) myStocks.push(stk); else stk.ticksHeld = 0;
        if (ticked) // Increment ticksHeld, or reset it if we have no position in this stock or reversed our position last tick.
            stk.ticksHeld = !stk.owned() || (priorLong > 0 && stk.sharesLong == 0) || (priorShort > 0 && stk.sharesShort == 0) ? 0 : 1 + (stk.ticksHeld || 0);
    }
    if (ticked) await updateForecast(ns, allStocks, has4s); // Logic below only required on market tick
    return corpus;
}

// Historical probability can be inferred from the number of times the stock was recently observed increasing over the total number of observations
const forecast = history => history.reduce((ups, price, idx) => idx == 0 ? 0 : (history[idx - 1] > price ? ups + 1 : ups), 0) / (history.length - 1);
// An "inversion" can be detected if two probabilities are far enough apart and are within "tolerance" of p1 being equal to 1-p2
const tol2 = inversionDetectionTolerance / 2;
const detectInversion = (p1, p2) => ((p1 >= 0.5 + tol2) && (p2 <= 0.5 - tol2) && p2 <= (1 - p1) + inversionDetectionTolerance)
        /* Reverse Condition: */ || ((p1 <= 0.5 - tol2) && (p2 >= 0.5 + tol2) && p2 >= (1 - p1) - inversionDetectionTolerance);

/** @param {NS} ns **/
async function updateForecast(ns, allStocks, has4s) {
    const currentHistory = allStocks[0].priceHistory.length;
    const prepSummary = showMarketSummary || mock || (!has4s && (currentHistory < minTickHistory || allStocks.filter(stk => stk.owned()).length == 0)); // Decide whether to display the market summary table.
    const inversionsDetected = []; // Keep track of individual stocks whose probability has inverted (45% chance of happening each "cycle")
    detectedCycleTick = (detectedCycleTick + 1) % marketCycleLength; // Keep track of stock market cycle (which occurs every 75 ticks)
    for (const stk of allStocks) {
        stk.priceHistory.unshift(stk.price);
        if (stk.priceHistory.length > maxTickHistory) // Limit the rolling window size
            stk.priceHistory.splice(maxTickHistory, 1);
        // Volatility is easy - the largest observed % movement in a single tick
        if (!has4s) stk.vol = stk.priceHistory.reduce((max, price, idx) => Math.max(max, idx == 0 ? 0 : Math.abs(stk.priceHistory[idx - 1] - price) / price), 0);
        // We want stocks that have the best expected return, averaged over a long window for greater precision, but the game will occasionally invert probabilities
        // (45% chance every 75 updates), so we also compute a near-term forecast window to allow for early-detection of inversions so we can ditch our position.
        stk.nearTermForecast = forecast(stk.priceHistory.slice(0, nearTermForecastWindowLength));
        let preNearTermWindowProb = forecast(stk.priceHistory.slice(nearTermForecastWindowLength)); // Used to detect the probability before the potential inversion event.
        // Detect whether it appears as though the probability of this stock has recently undergone an inversion (i.e. prob => 1 - prob)
        stk.possibleInversionDetected = has4s ? detectInversion(stk.prob, stk.lastTickProbability || stk.prob) : detectInversion(preNearTermWindowProb, stk.nearTermForecast);
        stk.lastTickProbability = stk.prob;
        if (stk.possibleInversionDetected) inversionsDetected.push(stk);
    }
    // Detect whether our auto-detected "stock market cycle" timing should be adjusted based on the number of potential inversions observed
    let summary = "";
    if (inversionsDetected.length > 0) {
        summary += `${inversionsDetected.length} Stocks appear to be reversing their outlook: ${inversionsDetected.map(s => s.sym).join(', ')} (threshold: ${inversionAgreementThreshold})\n`;
        if (inversionsDetected.length >= inversionAgreementThreshold && (has4s || currentHistory >= minTickHistory)) { // We believe we have detected the stock market cycle!
            const newPredictedCycleTick = has4s ? 0 : nearTermForecastWindowLength; // By the time we've detected it, we're this many ticks past the cycle start
            if (detectedCycleTick != newPredictedCycleTick)
                log(ns, `Threshold for changing predicted market cycle met (${inversionsDetected.length} >= ${inversionAgreementThreshold}). ` +
                    `Changing current market tick from ${detectedCycleTick} to ${newPredictedCycleTick}.`);
            marketCycleDetected = true;
            detectedCycleTick = newPredictedCycleTick;
            // Don't adjust this in the future unless we see another day with as much or even more agreement (capped at 14, it seems sometimes our cycles get out of sync with
            // actual cycles and we need to reset our clock even after previously determining the cycle with great certainty.)
            inversionAgreementThreshold = Math.max(14, inversionsDetected.length);
        }
    }
    // Act on any inversions (if trusted), compute the probability, and prepare the stock summary
    for (const stk of allStocks) {
        // Don't "trust" (act on) a detected inversion unless it's near the time when we're capable of detecting market cycle start. Avoids most false-positives.
        if (stk.possibleInversionDetected && (has4s && detectedCycleTick == 0 ||
            (!has4s && (detectedCycleTick > nearTermForecastWindowLength / 2 - 1) && (detectedCycleTick <= nearTermForecastWindowLength + inversionLagTolerance))))
            stk.lastInversion = detectedCycleTick; // If we "trust" a probability inversion has occurred, probability will be calculated based on only history since the last inversion.
        else
            stk.lastInversion++;
        // Only take the stock history since after the last inversion to compute the probability of the stock.
        const probWindowLength = Math.min(longTermForecastWindowLength, stk.lastInversion);
        stk.longTermForecast = forecast(stk.priceHistory.slice(0, probWindowLength));
        if (!has4s) {
            stk.prob = stk.longTermForecast;
            stk.probStdDev = Math.sqrt((stk.prob * (1 - stk.prob)) / probWindowLength);
        }
        const signalStrength = 1 + (stk.bullish() ? (stk.nearTermForecast > stk.prob ? 1 : 0) + (stk.prob > 0.8 ? 1 : 0) : (stk.nearTermForecast < stk.prob ? 1 : 0) + (stk.prob < 0.2 ? 1 : 0));
        if (prepSummary) { // Example: AERO  ++   Prob: 54% (t51: 54%, t10: 67%) tLast⇄:190 Vol:0.640% ER: 2.778BP Spread:1.784% ttProfit: 65 Pos: 14.7M long  (held 189 ticks)
            stk.debugLog = `${stk.sym.padEnd(5, ' ')} ${(stk.bullish() ? '+' : '-').repeat(signalStrength).padEnd(3)} ` +
                `Prob:${(stk.prob * 100).toFixed(0).padStart(3)}% (t${probWindowLength.toFixed(0).padStart(2)}:${(stk.longTermForecast * 100).toFixed(0).padStart(3)}%, ` +
                `t${Math.min(stk.priceHistory.length, nearTermForecastWindowLength).toFixed(0).padStart(2)}:${(stk.nearTermForecast * 100).toFixed(0).padStart(3)}%) ` +
                `tLast⇄:${(stk.lastInversion + 1).toFixed(0).padStart(3)} Vol:${(stk.vol * 100).toFixed(2)}% ER:${formatBP(stk.expectedReturn()).padStart(8)} ` +
                `Spread:${(stk.spread_pct * 100).toFixed(2)}% ttProfit:${stk.blackoutWindow().toFixed(0).padStart(3)}`;
            if (stk.owned()) stk.debugLog += ` Pos: ${formatNumberShort(stk.ownedShares(), 3, 1)} (${stk.ownedShares() == stk.maxShares ? 'max' :
                ((100 * stk.ownedShares() / stk.maxShares).toFixed(0).padStart(2) + '%')}) ${stk.sharesLong > 0 ? 'long ' : 'short'} (held ${stk.ticksHeld} ticks)`;
            if (stk.possibleInversionDetected) stk.debugLog += ' ⇄⇄⇄';
        }
    }
    // Print a summary of stocks as of this most recent tick (if enabled)
    if (prepSummary) {
        summary += `Market day ${detectedCycleTick + 1}${marketCycleDetected ? '' : '?'} of ${marketCycleLength} (${marketCycleDetected ? (100 * inversionAgreementThreshold / 19).toPrecision(2) : '0'}% certain) ` +
            `Current Stock Summary and Pre-4S Forecasts (by best payoff-time):\n` + allStocks.sort(purchaseOrder).map(s => s.debugLog).join("\n")
        if (showMarketSummary) await updateForecastFile(ns, summary); else log(ns, summary);
    }
    // Write out a file of stock probabilities so that other scripts can make use of this (e.g. hack orchestrator can manipulate the stock market)
    await ns.write('/Temp/stock-probabilities.txt', JSON.stringify(Object.fromEntries(
        allStocks.map(stk => [stk.sym, { prob: stk.prob, sharesLong: stk.sharesLong, sharesShort: stk.sharesShort }]))), "w");
}

// Helpers to display the stock market summary in a separate window.
let summaryFile = '/Temp/stockmarket-summary.txt';
let updateForecastFile = async (ns, summary) => await ns.write(summaryFile, summary, 'w');
let launchSummaryTail = async ns => {
    let summaryTailScript = summaryFile.replace('.txt', '-tail.js');
    if (await getNsDataThroughFile(ns, `ns.scriptRunning('${summaryTailScript}', ns.getHostname())`, '/Temp/stockmarket-summary-is-running.txt'))
        return;
    //await getNsDataThroughFile(ns, `ns.scriptKill('${summaryTailScript}', ns.getHostname())`, summaryTailScript.replace('.js', '-kill.js')); // Only needed if we're changing the script below
    await runCommand(ns, `ns.disableLog('sleep'); ns.tail(); let lastRead = '';
        while (true) { 
            let read = ns.read('${summaryFile}');
            if (lastRead != read) ns.print(lastRead = read);
            await ns.sleep(1000); 
        }`, summaryTailScript);
}

// Ram-dodging helpers that spawn temporary scripts to buy/sell rather than pay 2.5GB ram per variant
let buyStockWrapper = async (ns, sym, numShares) => await transactStock(ns, sym, numShares, 'buy'); // ns.stock.buy(sym, numShares);
let buyShortWrapper = async (ns, sym, numShares) => await transactStock(ns, sym, numShares, 'short'); // ns.stock.short(sym, numShares);
let sellStockWrapper = async (ns, sym, numShares) => await transactStock(ns, sym, numShares, 'sell'); // ns.stock.sell(sym, numShares);
let sellShortWrapper = async (ns, sym, numShares) => await transactStock(ns, sym, numShares, 'sellShort'); // ns.stock.sellShort(sym, numShares);
let transactStock = async (ns, sym, numShares, action) => await getNsDataThroughFile(ns, `ns.stock.${action}('${sym}', ${numShares})`, '/Temp/transact-stock.txt'); // ns.stock.sellShort(sym, numShares);

/** @param {NS} ns 
 * Automatically buys either a short or long position depending on the outlook of the stock. */
async function doBuy(ns, stk, sharesBought) {
    // We include -2*commission in the "holdings value" of our stock, but if we make repeated purchases of the same stock, we have to track
    // the additional commission somewhere. So only subtract it from our running profit if this isn't our first purchase of this symbol
    if (stk.owned())
        totalProfit -= commission;
    let long = stk.bullish();
    let expectedPrice = long ? stk.ask_price : stk.bid_price; // Depends on whether we will be buying a long or short position
    let price;
    try {
        price = mock ? expectedPrice : Number(await transactStock(ns, stk.sym, sharesBought, long ? 'buy' : 'short'));
    } catch (err) {
        if (long) throw err;
        disableShorts = true;
        log(ns, `WARN: Failed to short ${stk.sym} (Shorts not available?). Disabling shorts...`, true, 'warning');
        return 0;
    }

    log(ns, `INFO: ${long ? 'Bought ' : 'Shorted'} ${formatNumberShort(sharesBought, 3, 3).padStart(5)}${stk.maxShares == sharesBought + stk.ownedShares() ? ' (max shares)' : ''} ` +
        `${stk.sym.padEnd(5)} @ ${formatMoney(price).padStart(9)} for ${formatMoney(sharesBought * price).padStart(9)} (Spread:${(stk.spread_pct * 100).toFixed(2)}% ` +
        `ER:${formatBP(stk.expectedReturn()).padStart(8)}) Ticks to Profit: ${stk.timeToCoverTheSpread().toFixed(2)}`, noisy, 'info');
    // The rest of this work is for troubleshooting / mock-mode purposes
    if (price == 0) {
        log(ns, `ERROR: Failed to ${long ? 'buy' : 'short'} ${stk.sym} @ ${formatMoney(expectedPrice)} - 0 was returned.`, true, 'error');
        return 0;
    } else if (price != expectedPrice) {
        log(ns, `WARNING: ${long ? 'Bought' : 'Shorted'} ${stk.sym} @ ${formatMoney(price)} but expected ${formatMoney(expectedPrice)} (spread: ${formatMoney(stk.spread)})`, false, 'warning');
        price = expectedPrice; // Known Bitburner bug for now, short returns "price" instead of "bit_price". Correct this so running profit calcs are correct.
    }
    if (mock && long) stk.boughtPrice = (stk.boughtPrice * stk.sharesLong + price * sharesBought) / (stk.sharesLong + sharesBought);
    if (mock && !long) stk.boughtPriceShort = (stk.boughtPriceShort * stk.sharesShort + price * sharesBought) / (stk.sharesShort + sharesBought);
    if (long) stk.sharesLong += sharesBought; else stk.sharesShort += sharesBought; // Maintained for mock mode, otherwise, redundant (overwritten at next refresh)
    return sharesBought * price + commission; // Return the amount spent on the transaction so it can be subtracted from our cash on hand
}

/** @param {NS} ns 
 * Sell our current position in this stock. */
async function doSellAll(ns, stk) {
    let long = stk.sharesLong > 0;
    if (long && stk.sharesShort > 0) // Detect any issues here - we should always sell one before buying the other.
        log(ns, `ERROR: Somehow ended up both ${stk.sharesShort} short and ${stk.sharesLong} long on ${stk.sym}`, true, 'error');
    let expectedPrice = long ? stk.bid_price : stk.ask_price; // Depends on whether we will be selling a long or short position
    let sharesSold = long ? stk.sharesLong : stk.sharesShort;
    let price = mock ? expectedPrice : await transactStock(ns, stk.sym, sharesSold, long ? 'sell' : 'sellShort');
    const profit = (long ? stk.sharesLong * (price - stk.boughtPrice) : stk.sharesShort * (stk.boughtPriceShort - price)) - 2 * commission;
    log(ns, `${profit > 0 ? 'SUCCESS' : 'WARNING'}: Sold all ${formatNumberShort(sharesSold, 3, 3).padStart(5)} ${stk.sym.padEnd(5)} ${long ? ' long' : 'short'} positions ` +
        `@ ${formatMoney(price).padStart(9)} for a ` + (profit > 0 ? `PROFIT of ${formatMoney(profit).padStart(9)}` : ` LOSS  of ${formatMoney(-profit).padStart(9)}`) + ` after ${stk.ticksHeld} ticks`,
        noisy, noisy ? (profit > 0 ? 'success' : 'error') : undefined);
    if (price == 0) {
        log(ns, `ERROR: Failed to sell ${sharesSold} ${stk.sym} ${long ? 'shares' : 'shorts'} @ ${formatMoney(expectedPrice)} - 0 was returned.`, true, 'error');
        return 0;
    } else if (price != expectedPrice) {
        log(ns, `WARNING: Sold ${stk.sym} ${long ? 'shares' : 'shorts'} @ ${formatMoney(price)} but expected ${formatMoney(expectedPrice)} (spread: ${formatMoney(stk.spread)})`, false, 'warning');
        price = expectedPrice; // Known Bitburner bug for now, sellSort returns "price" instead of "ask_price". Correct this so running profit calcs are correct.
    }
    if (long) stk.sharesLong -= sharesSold; else stk.sharesShort -= sharesSold; // Maintained for mock mode, otherwise, redundant (overwritten at next refresh)
    totalProfit += profit;
    return price * sharesSold - commission; // Return the amount of money recieved from the transaction
}

let formatBP = fraction => formatNumberShort(fraction * 100 * 100, 3, 2) + " BP";

/** Log / tprint / toast helper.
 * @param {NS} ns */
let log = (ns, message, tprint = false, toastStyle = "") => {
    if (message == lastLog) return;
    ns.print(message);
    if (tprint) ns.tprint(message);
    if (toastStyle) ns.toast(message, toastStyle);
    return lastLog = message;
}

function doStatusUpdate(ns, stocks, myStocks, hudElement = null) {
    let maxReturnBP = 10000 * Math.max(...myStocks.map(s => s.absReturn())); // The largest return (in basis points) in our portfolio
    let minReturnBP = 10000 * Math.min(...myStocks.map(s => s.absReturn())); // The smallest return (in basis points) in our portfolio
    let est_holdings_cost = myStocks.reduce((sum, stk) => sum + (stk.owned() ? commission : 0) +
        stk.sharesLong * stk.boughtPrice + stk.sharesShort * stk.boughtPriceShort, 0);
    let liquidation_value = myStocks.reduce((sum, stk) => sum - (stk.owned() ? commission : 0) + stk.positionValue(), 0);
    let status = `Long ${myStocks.filter(s => s.sharesLong > 0).length}, Short ${myStocks.filter(s => s.sharesShort > 0).length} of ${stocks.length} stocks ` +
        (myStocks.length == 0 ? '' : `(ER ${minReturnBP.toFixed(1)}-${maxReturnBP.toFixed(1)} BP) `) +
        `Profit: ${formatMoney(totalProfit, 3)} Holdings: ${formatMoney(liquidation_value, 3)} (Cost: ${formatMoney(est_holdings_cost, 3)}) ` +
        `Net: ${formatMoney(totalProfit + liquidation_value - est_holdings_cost, 3)}`
    log(ns, status);
    if (hudElement) hudElement.innerText = formatMoney(liquidation_value, 6, 3);
}

/** @param {NS} ns **/
async function liquidate(ns, allStockSymbols) {
    let totalStocks = 0, totalSharesLong = 0, totalSharesShort = 0, totalRevenue = 0;
    const dictPositions = mock ? null : await getStockInfoDict(ns, 'getPosition');
    for (const sym of allStockSymbols) {
        var [sharesLong, , sharesShort, avgShortCost] = dictPositions[sym];
        if (sharesLong + sharesShort == 0) continue;
        totalStocks++, totalSharesLong += sharesLong, totalSharesShort += sharesShort;
        if (sharesLong > 0) totalRevenue += (await sellStockWrapper(ns, sym, sharesLong)) * sharesLong - commission;
        if (sharesShort > 0) totalRevenue += (2 * avgShortCost - (await sellShortWrapper(ns, sym, sharesShort))) * sharesShort - commission;
    }
    log(ns, `Sold ${totalSharesLong.toLocaleString()} long shares and ${totalSharesShort.toLocaleString()} short shares ` +
        `in ${totalStocks} stocks for ${formatMoney(totalRevenue, 3)}`, true, 'success');
}

/** @param {NS} ns **/
/** @param {Player} playerStats **/
async function tryGet4SApi(ns, playerStats, bitnodeMults, corpus, allStockSymbols) {
    if (playerStats.has4SDataTixApi) return false; // Only return true if we just bought it
    const cost4sData = bitnodeMults.FourSigmaMarketDataCost * 5000000000;
    const cost4sApi = bitnodeMults.FourSigmaMarketDataApiCost * 25000000000;
    const totalCost = (playerStats.has4SData ? 0 : cost4sData) + cost4sApi;
    // Liquidate shares if it would allow us to afford 4S API data
    if (totalCost > corpus * 0.9 /* Need to reserve some money to invest */) return false;
    if (playerStats.money < totalCost)
        await liquidate(ns, allStockSymbols);
    if (!playerStats.has4SData) {
        if (await getNsDataThroughFile(ns, 'ns.stock.purchase4SMarketData()', '/Temp/purchase-4s.txt'))
            log(ns, `Purchased 4SMarketData for ${formatMoney(cost4sData)}!`, true, 'success');
        else
            log(ns, 'Error attempting to purchase 4SMarketData!', true, 'error');
    }
    if (await getNsDataThroughFile(ns, 'ns.stock.purchase4SMarketDataTixApi()', '/Temp/purchase-4s-api.txt')) {
        log(ns, `Purchased 4SMarketDataTixApi for ${formatMoney(cost4sApi)}!`, true, 'success');
        return true;
    } else
        log(ns, 'Error attempting to purchase 4SMarketDataTixApi!', true, 'error');
    return false;
}

function initializeHud() {
    const d = eval("document");
    let htmlDisplay = d.getElementById("stock-display-1");
    if (htmlDisplay !== null) return htmlDisplay;
    // Get the custom display elements in HUD.
    let customElements = d.getElementById("overview-extra-hook-0").parentElement.parentElement;
    // Make a clone - in case other scripts are using them
    let stockValueTracker = customElements.cloneNode(true);
    // Clear id since duplicate id's are invalid
    stockValueTracker.querySelectorAll("p").forEach((el, i) => el.id = "stock-display-" + i);
    // Get out output element
    htmlDisplay = stockValueTracker.querySelector("#stock-display-1");
    // Display label and default value
    stockValueTracker.querySelectorAll("p")[0].innerText = "Stock";
    htmlDisplay.innerText = "$0.000"
    // Insert our element right after Money
    customElements.parentElement.insertBefore(stockValueTracker, customElements.parentElement.childNodes[2]);
    return htmlDisplay;
}