import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Cordis plugin identity used by Loader diagnostics. */
const name = 'music-player';
/** The route owner needs the Web HTTP registry; directoryPicker is optional (ctx.get). */
const inject = ['webServer'];

/** 真正的宿主实现在 host.js：入口只做“热重载壳”。 */
const HOST_FILE = fileURLToPath(new URL('./host.js', import.meta.url));

/**
 * DSH 启动时只 import 一次插件入口，改 lib/ 不会生效，过去每次都要重启
 * dsh web（客户端 bundle 反而会自动更新，于是出现“新界面 + 旧路由”）。
 * 这里把入口变成薄壳：路由只注册一次，每个请求按 mtime 判断 host.js 是否
 * 变化，变了就 dispose 旧实例并 import 新实例。改完宿主代码刷新页面即生效，
 * 不再需要重启进程；读失败或载入失败会以 500 JSON 返回，不会静默失效。
 */
function apply(ctx) {
  let host = null;
  let hostMtimeMs = -1;
  let loading = null;

  async function ensureHost() {
    const stat = await fs.stat(HOST_FILE);
    if (host !== null && stat.mtimeMs === hostMtimeMs) return host;
    if (loading !== null) return loading;
    loading = (async () => {
      if (host !== null) {
        try {
          host.dispose();
        } catch {
          // 旧实例清理失败不应阻塞新实例。
        }
        host = null;
      }
      // 带 mtime 的查询串绕过 ESM 模块缓存：文件一变，下次请求就是新代码。
      const module = await import(pathToFileURL(HOST_FILE).href + '?v=' + stat.mtimeMs);
      host = module.createHost(ctx);
      hostMtimeMs = stat.mtimeMs;
      return host;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  const handleRequest = async (req, res) => {
    try {
      const current = await ensureHost();
      await current.handle(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const statusCode = Number.isSafeInteger(error?.statusCode) ? error.statusCode : 500;
      res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  };

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-music',
      handler: handleRequest,
    });
    return () => {
      disposeRoute();
      if (host !== null) {
        try {
          host.dispose();
        } catch {
          // teardown is best-effort
        }
        host = null;
      }
    };
  }, 'music-player: local music API');
}

export { apply, inject, name };
