/**
 * Fetch ⇄ node:http 适配层。
 *
 * 背景：DSH Desktop（Electron）不开监听端口，宿主请求一律经 `dsh-app://` 自定义协议
 * 转给 desktop-host 子进程，再交给 `ctx.connection.createSharedFetchHandler('/api')`。
 * 该通路上只有标准 Fetch 的 Request/Response，而本插件的宿主实现是 node:http 形状
 * （历史原因：`ctx.webServer.register` 直接给的就是 IncomingMessage/ServerResponse）。
 *
 * 这个模块把两个世界接起来，让同一份路由代码同时服务：
 *  - Web：`webServer.register` 的 node:http 前缀路由（保留 /dsh-music 兼容入口）；
 *  - Desktop / Web 统一新入口：`connection.fetch.register` 的 /api/dsh-music/*。
 *
 * 只依赖 node:stream 与 WHATWG 全局对象，不引入任何 DSH 内部模块。
 */
import { Readable, Writable } from 'node:stream';
/**
 * 路由层用 `statusError(code, message)` 抛出带 statusCode 的错误对象。
 *
 * 这里把 catch 绑定的 `unknown` 收窄成「确实带 statusCode」的形状（含原型链上的），
 * 语义等价于原来的 `error?.statusCode`，但不把 unknown 当逃生舱。
 */
function isStatusError(value) {
    if (typeof value !== 'object' && typeof value !== 'function')
        return false;
    if (value === null)
        return false;
    if (!('statusCode' in value))
        return false;
    return typeof value.statusCode === 'number';
}
/**
 * 把 Fetch Request 包成 node:http IncomingMessage 的形状。
 * 宿主代码只用到 method / url / headers / 异步迭代 / signal，因此这里手工补齐这些面。
 */
function requestToNode(request) {
    const url = new URL(request.url);
    const headers = {};
    for (const [headerName, value] of request.headers)
        headers[headerName.toLowerCase()] = value;
    // Electron 自定义协议不带 Host；补上 URL 自身的 authority，方便任何读 Host 的代码。
    if (headers.host === undefined)
        headers.host = url.host;
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;
    // DOM 的 ReadableStream 与 node:stream/web 的 ReadableStream 是同一份运行时对象的两份
    // 结构声明（Node 里全局 ReadableStream 就是 stream/web 的那个构造函数），
    // 但两份声明互不可赋值，所以这里按实际运行时类型做一次窄化断言（不是 any 逃逸）。
    const body = hasBody && request.body !== null
        ? Readable.fromWeb(request.body)
        : Readable.from([]);
    // HEAD 复用 GET 的路由实现；body 由 fetchFromNodeHandler 统一丢弃。
    body.method = request.method === 'HEAD' ? 'GET' : request.method;
    body.url = url.pathname + url.search;
    body.headers = headers;
    body.signal = request.signal;
    return body;
}
/**
 * 收集 node:http ServerResponse 形状的写入，并暴露成 ReadableStream。
 *
 * 关键点：
 *  - `stream.pipe(res)` 依赖真正的 Writable（背压、'close'、destroy 语义都要对），
 *    所以这里继承 Writable 而不是手写鸭子类型；否则音频 Range 流会出现 fd 泄漏。
 *  - 客户端 abort（seek / 关页）会通过 ReadableStream 的 cancel 传回来，必须立刻
 *    释放挂起的 _write 回调并让上层 destroy 掉读取流。
 */
function createResponseSink() {
    let controller = null;
    let cancelled = false;
    let pendingWrite = null;
    /** 创建顺序上的前向引用：cancel 回调可能在 res 赋值后才触发。 */
    let sink = null;
    const releasePending = () => {
        if (pendingWrite === null)
            return;
        const callback = pendingWrite;
        pendingWrite = null;
        callback();
    };
    const stream = new ReadableStream({
        start(controllerRef) {
            controller = controllerRef;
        },
        pull() {
            releasePending();
        },
        cancel() {
            cancelled = true;
            releasePending();
            // 消费者取消（客户端 abort、或 HEAD 主动丢弃 body）：立刻拆掉 Writable，
            // 让 pipeFile 监听的 'close' 触发、读取流被 destroy —— 否则 seek 风暴
            // 或大量 HEAD 探测会按住一堆文件描述符直到 GC。
            sink?.destroy();
        },
    });
    const res = new Writable({
        write(chunk, _encoding, callback) {
            if (cancelled || controller === null) {
                callback();
                return;
            }
            try {
                // 复制一份：Buffer 池会被复用，直接给视图会在下游读到被覆盖的数据。
                controller.enqueue(new Uint8Array(chunk));
            }
            catch {
                cancelled = true;
                callback();
                return;
            }
            if ((controller.desiredSize ?? 1) > 0)
                callback();
            else
                pendingWrite = callback;
        },
        final(callback) {
            if (!cancelled && controller !== null) {
                try {
                    controller.close();
                }
                catch {
                    // 已经 cancel/close 过：关闭是幂等的，忽略。
                }
            }
            callback();
        },
        destroy(error, callback) {
            cancelled = true;
            releasePending();
            if (controller !== null) {
                try {
                    controller.error(error ?? undefined);
                }
                catch {
                    // 流已关闭：忽略重复 error。
                }
            }
            callback(error);
        },
    });
    sink = res;
    res.statusCode = 200;
    res.statusMessage = 'OK';
    res.headersSent = false;
    /** 响应头小写化存储，值先转成字符串（pipeFile/writeHead 都按 node 习惯传数字）。 */
    const headers = {};
    res.writeHead = (statusCode, statusOrHeaders, maybeHeaders) => {
        res.statusCode = statusCode;
        const source = typeof statusOrHeaders === 'string' ? maybeHeaders : statusOrHeaders;
        if (source !== undefined && source !== null) {
            for (const [headerName, value] of Object.entries(source)) {
                if (value === undefined)
                    continue;
                headers[headerName.toLowerCase()] = String(value);
            }
        }
        res.headersSent = true;
        return res;
    };
    res.setHeader = (headerName, value) => {
        headers[headerName.toLowerCase()] = String(value);
        return res;
    };
    res.getHeader = (headerName) => headers[headerName.toLowerCase()];
    res.removeHeader = (headerName) => { delete headers[headerName.toLowerCase()]; };
    res.getHeaders = () => ({ ...headers });
    return { res, stream, headers, isCancelled: () => cancelled };
}
/**
 * 用 Fetch Request 驱动一段 node:http 形状的处理器，并把结果还原成 Response。
 *
 * @param request - 连接层/Electron 传来的标准请求。
 * @param dispatch - `(req, res) => Promise<void>`，node:http 形状的路由实现。
 * @returns 与 node 响应等价的 Fetch Response；HEAD 保留响应头但丢弃 body。
 */
export async function fetchFromNodeHandler(request, dispatch) {
    const req = requestToNode(request);
    const sink = createResponseSink();
    const { res, stream, headers } = sink;
    try {
        await dispatch(req, res);
        // 处理器正常返回但没写任何响应：给一个明确的 200 空 JSON，而不是悬挂的流。
        if (!res.headersSent) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end('{}');
        }
    }
    catch (error) {
        // 读两次 statusCode 与原来的 `Number.isSafeInteger(error?.statusCode) ? error.statusCode : 500` 同形。
        const statusCode = isStatusError(error) && Number.isSafeInteger(error.statusCode) ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
            res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ error: message }));
        }
        else {
            // 头已发出：只能中断 body，让客户端看到截断而不是静默的成功。
            res.destroy(error instanceof Error ? error : new Error(message));
        }
    }
    if (request.method === 'HEAD') {
        // HEAD 只要响应头：主动取消 body 流，让上游 pipe 立即收尾并释放 fd。
        await stream.cancel().catch(() => undefined);
        return new Response(null, { status: res.statusCode, headers });
    }
    return new Response(stream, {
        status: res.statusCode,
        headers,
    });
}
