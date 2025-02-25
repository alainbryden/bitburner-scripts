/** @param {NS} ns */
export async function main(ns) {
    // 增强版配置系统
    const CONFIG = {
        SCRIPT_NAME: "me/5.js",
        CHECK_INTERVAL: 1000,
        ERROR_RETRY_DELAY: 5000,
        MAX_RETRIES: 10,
        API_WAIT_TIMEOUT: 30000  // 新增API等待超时
    };

    ns.disableLog("ALL");
    ns.clearLog();
    ns.print(`[v2.1] 增强型监控脚本启动`);

    // 参数解析增强（带类型校验）
    const args = ns.flags([
        ["script", CONFIG.SCRIPT_NAME, "string"],
        ["interval", CONFIG.CHECK_INTERVAL, "number"],
        ["retry", CONFIG.ERROR_RETRY_DELAY, "number"],
        ["max", CONFIG.MAX_RETRIES, "number"],
        ["api-timeout", CONFIG.API_WAIT_TIMEOUT, "number"]
    ]);

    // 参数有效性验证
    if (!validateParameters(ns, args)) return;

    try {
        // 带超时机制的API等待
        if (!await waitFor4SAPI(ns, args.interval, args.apiTimeout)) {
            ns.tprint("❌ 错误：4S API 等待超时");
            return;
        }

        await executeMainLogic(ns, args);
    } catch (error) {
        handleError(ns, error, args);
    }
}

/** 参数校验函数 */
function validateParameters(ns, args) {
    const validation = {
        "interval": v => v > 100,
        "retry": v => v >= 1000,
        "max": v => v >= 1,
        "api-timeout": v => v >= 5000
    };

    for (const [param, validator] of Object.entries(validation)) {
        if (!validator(args[param])) {
            ns.tprint(`❌ 无效参数值: --${param}=${args[param]}`);
            return false;
        }
    }
    return true;
}

/** 带超时机制的API等待 */
async function waitFor4SAPI(ns, interval, timeout) {
    const startTime = Date.now();
    while (!ns.stock.has4SDataTIXAPI()) {
        if (Date.now() - startTime > timeout) return false;

        ns.print(`等待4S API... 剩余时间: ${Math.round((timeout - (Date.now() - startTime)) / 1000)}s`);
        await ns.sleep(interval);
    }
    return true;
}

/** 主业务逻辑封装 */
async function executeMainLogic(ns, args) {
    if (ns.scriptRunning(args.script, "home")) {
        ns.print("⚠️ 目标脚本已在运行");
        return;
    }

    if (!ns.fileExists(args.script)) {
        throw new Error(`脚本不存在: ${args.script} (路径需包含扩展名)`);
    }

    const requiredRam = ns.getScriptRam(args.script);
    const availableRam = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");

    if (requiredRam > availableRam) {
        throw new Error(`内存不足! 需要: ${requiredRam}GB, 可用: ${availableRam}GB`);
    }

    const pid = ns.run(args.script);
    if (pid === 0) throw new Error("未知启动错误");

    ns.toast(`✅ 成功启动 ${args.script} (PID: ${pid})`, "success");
    ns.print("监控任务完成，退出脚本");
}

/** 增强型错误处理 */
function handleError(ns, error, args) {
    const errorData = {
        message: error.message,
        timestamp: new Date().toISOString(),
        retryCount: (error.retryCount || 0) + 1
    };

    ns.write("error.log.txt", `${JSON.stringify(errorData)}\n`, "a");

    const remainingRetries = args.max - errorData.retryCount;
    const retryMessage = remainingRetries > 0
        ? `${args.retry / 1000}秒后重试 (剩余次数: ${remainingRetries})`
        : "❌ 达到最大重试次数";

    ns.tprint(`错误: ${error.message}\n${retryMessage}`);

    if (remainingRetries > 0) {
        ns.run(ns.getScriptName(), 1,
            "--script", args.script,
            "--interval", args.interval,
            "--retry", args.retry,
            "--max", args.max,
            "--api-timeout", args.apiTimeout
        );
    }
}
