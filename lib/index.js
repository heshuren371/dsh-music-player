import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
/** Cordis plugin identity used by Loader diagnostics. */
const name = 'music-player';
/**
 * 不声明静态 inject：Web 与 DSH Desktop 装配出的宿主服务不同——Desktop 的
 * desktop.cordis.patch.yml 明确 `disabled: true` 掉了 webserver 行，没有
 * `ctx.webServer`。用静态 `inject: ['webServer']` 会让整个宿主半侧在 Desktop
 * 永不激活（fiber 一直等一个不会出现的服务），所以改为运行时按可用服务绑定。
 */
const inject = [];
/** 真正的宿主实现在 host.js：入口只做“热重载壳”。 */
const HOST_FILE = fileURLToPath(new URL('./host.js', import.meta.url));
/**
 * 从抛出物里读 HTTP 状态码，读不到就 500。
 *
 * `catch` 绑定的类型是 `unknown`（`useUnknownInCatchVariables`），这里逐层收窄，
 * 既不用断言也不用 any；判定顺序与原来的 `Number.isSafeInteger(error?.statusCode)`
 * 一致：非对象/函数、没有 `statusCode`、不是安全整数都退回 500。
 */
function statusCodeOf(error) {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function'))
        return 500;
    if (!('statusCode' in error))
        return 500;
    const statusCode = error.statusCode;
    return typeof statusCode === 'number' && Number.isSafeInteger(statusCode) ? statusCode : 500;
}
/**
 * `connection.fetch` 上的精确路由表（path → methods）。
 *
 * 为什么必须是 /api 之下：Desktop 的 desktop-host 只把 `/`、`/.dsh/remote-stream`
 * 和 `/api/*` 分派给宿主，其余一律当静态资源回落到 index.html；Web 侧
 * `@deepseek-ai/dsh-client-connection` 也只挂 `/api` 前缀。`connection.fetch` 是
 * 两端的公共接缝，因此这一张表同时服务 Web 与 Desktop。
 *
 * ⚠️ 与 host.js 分派表的一致性由 `scripts/test-route-consistency.mjs` 强制：
 * 该断言要求「host.js 分派表 == 本表 ∪ LEGACY_ONLY_ROUTES」，任一侧漏改即失败。
 * 新增端点时必须同时改这两处，别只加 host.js 里的 `pathname ===`。
 */
const FETCH_ROUTES = [
    ['/api/dsh-music/library', ['GET', 'HEAD']],
    ['/api/dsh-music/session', ['GET', 'HEAD']],
    ['/api/dsh-music/refresh', ['POST']],
    ['/api/dsh-music/dir', ['POST']],
    ['/api/dsh-music/cover', ['GET', 'HEAD']],
    ['/api/dsh-music/match', ['GET', 'HEAD']],
    ['/api/dsh-music/art', ['GET', 'HEAD']],
    ['/api/dsh-music/apply', ['POST']],
    ['/api/dsh-music/pick', ['POST']],
    ['/api/dsh-music/stream', ['GET', 'HEAD']],
    ['/api/dsh-music/delete', ['POST']],
    // MV 端点：页面 fetch 调用，与上面同属「经平台 /api 栅栏 + 会话」的一类。
    ['/api/dsh-music/mv', ['GET', 'HEAD']],
    ['/api/dsh-music/mvconvert', ['POST']],
    ['/api/dsh-music/mvlib', ['GET', 'HEAD']],
    ['/api/dsh-music/mvfile', ['GET', 'HEAD']],
    ['/api/dsh-music/caps', ['POST']],
];
/**
 * **故意不注册在 `connection.fetch` 上的端点**（唯一两个）。
 *
 * `system-art` / `system-stream` 是给 Chromium **内部**发起的取图/取媒体用的，
 * 请求带 `Origin: dsh-app://app`、且**不带浏览器会话 cookie**。而平台的 `/api`
 * 路由（`@deepseek-ai/dsh-client-connection` 的 `admit()`）会先判
 * `isTrustedApiRequest`（Origin/Host 栅栏）**再要求 `browserAuth.isAuthenticated`**
 * —— 没会话就 401、Origin 不匹配就 403。所以这两个端点**注册到 `connection.fetch`
 * 也到不了**，只会多一条必然失败的通路。
 *
 * 它们只能挂在插件自建的 `/dsh-music` 旧前缀上（由 host.js 的 `isSystemPath`
 * 显式豁免栅栏，凭证是 URL 里的 token）。**代价**：宿主没有 `webServer` 时
 * （0.1.6 形态 desktop-host）旧前缀不存在，这两个端点不可达 —— 这是已知限制，
 * 不是本表漏改。
 */
const LEGACY_ONLY_ROUTES = ['/api/dsh-music/system-art', '/api/dsh-music/system-stream'];
/** 旧版 Web 前缀路由；只作向后兼容（已加载的旧客户端 bundle 仍指向这里）。 */
const LEGACY_PREFIX = '/dsh-music';
/**
 * DSH 启动时只 import 一次插件入口，改 lib/ 不会生效，过去每次都要重启
 * dsh web（客户端 bundle 反而会自动更新，于是出现“新界面 + 旧路由”）。
 * 这里把入口变成薄壳：路由只注册一次，每个请求按 mtime 判断 host.js 是否
 * 变化，变了就 dispose 旧实例并 import 新实例。改完宿主代码刷新页面即生效，
 * 不再需要重启进程；读失败或载入失败会以 JSON 返回，不会静默失效。
 */
function apply(ctx) {
    /** 当前宿主实例；显式声明类型以免 evolving any 把 null 检查收窄成 never。 */
    let host = null;
    let hostMtimeMs = -1;
    /** 在飞的重载：类型与 `host` 同一来源（IIFE 返回宿主实例）。 */
    let loading = null;
    let lastReloadAt = 0;
    /**
     * teardown 之后的闸门（A3-02）。
     *
     * `ensureHost` 有两个 await 挂起点（`fs.stat` 与动态 `import`）。只把 `host` 置
     * null 挡不住它们：挂起的异步分支恢复后照样 `host = module.createHost(ctx)`，
     * 产生一个**不归任何 scope 的孤儿实例** —— 它会 startScan、可能拉起 tag
     * worker，而此后再也没有 teardown 来 dispose 它。所以必须有一个状态位，在
     * 每次 await 之后、**赋值之前**复查。
     */
    let disposed = false;
    /**
     * 每次 import 都会在 ESM 注册表里留下一个无法卸载的模块条目；编辑器
     * 连续保存或有人狂写文件时，逐次重载会把进程内存推高。给重载加最小间隔，
     * 期间继续用旧实例（变更不会丢，下个窗口生效）。
     */
    const RELOAD_MIN_INTERVAL_MS = 1000;
    async function ensureHost() {
        if (disposed)
            throw new Error('插件已停用，不再创建宿主实例');
        const stat = await fs.stat(HOST_FILE);
        if (disposed)
            throw new Error('插件已停用，不再创建宿主实例');
        if (host !== null && stat.mtimeMs === hostMtimeMs)
            return host;
        if (loading !== null)
            return loading;
        if (host !== null && Date.now() - lastReloadAt < RELOAD_MIN_INTERVAL_MS)
            return host;
        lastReloadAt = Date.now();
        loading = (async () => {
            if (host !== null) {
                try {
                    host.dispose();
                }
                catch {
                    // 旧实例清理失败不应阻塞新实例。
                }
                host = null;
            }
            // 带 mtime 的查询串绕过 ESM 模块缓存：文件一变，下次请求就是新代码。
            const module = await import(pathToFileURL(HOST_FILE).href + '?v=' + stat.mtimeMs);
            // 赋值前复查：这一步与上面的 await 之间可能已经发生过 teardown。
            if (disposed)
                throw new Error('插件已停用，不再创建宿主实例');
            host = module.createHost(ctx);
            hostMtimeMs = stat.mtimeMs;
            return host;
        })();
        try {
            return await loading;
        }
        finally {
            loading = null;
        }
    }
    const failResponse = (error) => {
        const statusCode = statusCodeOf(error);
        return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
            status: statusCode,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
    };
    /** Web 旧入口：node:http 形状（webServer.register 的前缀路由）。 */
    const handleRequest = async (req, res) => {
        try {
            const current = await ensureHost();
            await current.handle(req, res);
        }
        catch (error) {
            if (res.headersSent) {
                res.destroy(error instanceof Error ? error : undefined);
                return;
            }
            const statusCode = statusCodeOf(error);
            res.writeHead(statusCode, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
    };
    /** 统一入口：Fetch 进、Fetch 出（connection.fetch 的精确路由）。 */
    const handleFetch = async (request) => {
        try {
            const current = await ensureHost();
            return await current.handleFetch(request);
        }
        catch (error) {
            return failResponse(error);
        }
    };
    /**
     * 取服务：优先用 Cordis 的安全读法 `ctx.get`，再退回直接属性访问，
     * 这样既不会在服务缺失时抛错，也兼容只把服务挂在属性上的最小测试夹具。
     */
    const serviceOf = (scope, key) => {
        if (typeof scope.get === 'function') {
            const viaGet = scope.get(key);
            if (viaGet !== undefined && viaGet !== null)
                return viaGet;
        }
        return scope[key] ?? null;
    };
    /**
     * 注册 /api/dsh-music/* 精确 Fetch 路由。Desktop 上这是唯一可达的通路，
     * Web 上等价于平台 /api 的一等公民（连接层已完成 Host/Origin 栅栏与鉴权）。
     * @returns 是否成功挂载（服务缺失时返回 false，交由旧入口兜底）。
     */
    const registerFetchRoutes = (scope) => {
        const connection = serviceOf(scope, 'connection');
        if (connection === null || typeof connection.fetch?.register !== 'function')
            return false;
        scope.effect(() => {
            const disposers = FETCH_ROUTES.map(([path, methods]) => connection.fetch.register({
                path,
                methods,
                requestBody: 'buffered',
                fetch: handleFetch,
            }));
            return () => {
                for (const dispose of disposers) {
                    try {
                        dispose();
                    }
                    catch {
                        // 摘除路由是尽力而为：卸载流程不能被单条注册的清理失败卡住。
                    }
                }
            };
        }, 'music-player: /api/dsh-music fetch routes');
        return true;
    };
    /** 旧版 /dsh-music 前缀路由（仅当 webServer 存在时）。 */
    const registerLegacyRoute = (scope) => {
        const webServer = serviceOf(scope, 'webServer');
        if (webServer === null || typeof webServer.register !== 'function')
            return false;
        scope.effect(() => {
            const disposeRoute = webServer.register({
                kind: 'prefix',
                path: LEGACY_PREFIX,
                handler: handleRequest,
            });
            return () => disposeRoute();
        }, 'music-player: legacy /dsh-music route');
        return true;
    };
    // 宿主实例的生命周期独立于路由：任一入口卸载都要停掉扫描/标签 worker。
    ctx.effect(() => () => {
        // 闸门先立：在飞的 ensureHost 若在此之后恢复，会看到 disposed 并放弃创建
        // 孤儿实例（A3-02）。顺序很重要 —— 先置位再 dispose。
        disposed = true;
        if (host !== null) {
            try {
                host.dispose();
            }
            catch {
                // teardown is best-effort
            }
            host = null;
        }
    }, 'music-player: host teardown');
    if (typeof ctx.inject === 'function') {
        // 两个服务各自等待，谁先到都行：Desktop 只命中 connection，Web 两个都命中。
        // 1) 统一入口（/api/dsh-music/*）；服务缺失时退回旧前缀路由。
        ctx.inject(['connection'], (scope) => {
            if (!registerFetchRoutes(scope))
                registerLegacyRoute(scope);
        });
        // 2) 旧入口，仅 Web：已经加载的旧客户端 bundle 仍指向 /dsh-music。
        ctx.inject(['webServer'], (scope) => {
            registerLegacyRoute(scope);
        });
    }
    else {
        // 兼容只提供 webServer 的最小夹具（scripts/test-*.mjs）。
        registerLegacyRoute(ctx);
    }
}
export { apply, inject, name, FETCH_ROUTES, LEGACY_ONLY_ROUTES };
