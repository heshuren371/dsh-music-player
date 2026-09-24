// DSH Desktop 通路回归：Desktop 没有 webServer 服务（apps/desktop-host 的
// desktop.cordis.patch.yml 明确 disabled 掉 webserver 行），宿主请求经
// dsh-app:// 自定义协议 → desktop-host → ctx.connection.createSharedFetchHandler('/api')。
// 因此插件必须把端点注册在 connection.fetch 的 /api/dsh-music/* 上，并且不能再做
// loopback Host 判定（Electron 不带那个 Host）。这个套件用最小 ctx 复现该通路：
//   - 只提供 connection（没有 webServer），验证插件仍会激活并注册全部精确路由；
//   - 用与平台一致的路径/方法规则校验每条注册；
//   - 直接以 Fetch Request 驱动路由，覆盖 JSON、Range 流、HEAD、错误状态。
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-desktop-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-desktop-music-'));
process.env.DSH_HOME = home;
await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');

/** Minimal valid 2s 8kHz mono WAV. */
function wav(seconds = 2) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), 44 + i * 2);
  return buf;
}
const audio = wav();
await fs.writeFile(path.join(music, 'song.wav'), audio);

// ---- 与 @deepseek-ai/dsh-client-connection 的 assertFetchRoute / endpointFromPath 同规则 ----
const API_PATH = '/api';
const SEGMENT = /^[A-Za-z0-9_$.-]+$/;
const METHODS = new Set(['GET', 'HEAD', 'POST']);
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(channel + '/')) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  const segments = endpoint.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || !SEGMENT.test(s))) return undefined;
  return endpoint;
}

const routes = new Map();
const routeRegistrations = [];
const legacyRoutes = [];
const injectCalls = [];
const services = {
  connection: {
    fetch: {
      register(route) {
        if (endpointFromPath(API_PATH, route.path) === undefined) {
          throw new Error('connection: invalid exact Fetch route ' + JSON.stringify(route.path));
        }
        if (!Array.isArray(route.methods) || route.methods.length === 0) {
          throw new Error('connection: route declares no methods ' + route.path);
        }
        for (const method of route.methods) {
          if (!METHODS.has(method)) throw new Error('connection: unsupported method ' + method);
        }
        if (routes.has(route.path)) throw new Error('connection: duplicate route ' + route.path);
        routes.set(route.path, route);
        routeRegistrations.push(route.path);
        return () => { routes.delete(route.path); };
      },
    },
  },
  // 故意不提供 webServer：这就是 DSH Desktop 的装配形状。
};

const pendingInject = [];
const ctx = {
  effect: (fn) => fn(),
  get: (key) => services[key],
  inject(deps, callback) {
    injectCalls.push(deps.join(','));
    for (const dep of deps) {
      if (services[dep] === undefined) {
        pendingInject.push({ dep, callback });
        return;
      }
    }
    callback(ctx);
  },
};

const { apply, inject } = await import('../lib/index.js');
if (Array.isArray(inject) && inject.length > 0) {
  throw new Error('static inject must stay empty so a missing Web service cannot block Desktop activation');
}
apply(ctx);

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail));
};

// ---- 路由注册面 ----
const expected = [
  '/api/dsh-music/library',
  '/api/dsh-music/session',
  '/api/dsh-music/refresh',
  '/api/dsh-music/dir',
  '/api/dsh-music/cover',
  '/api/dsh-music/match',
  '/api/dsh-music/art',
  '/api/dsh-music/apply',
  '/api/dsh-music/pick',
  '/api/dsh-music/stream',
  '/api/dsh-music/delete',
];
check('only connection is injected (no webServer)', injectCalls.join('|').includes('connection'), 'inject=' + injectCalls.join('|'));
check('webServer inject stays pending (Desktop has no webServer service)', pendingInject.length === 1 && pendingInject[0].dep === 'webServer');
check('every endpoint registered as an exact /api Fetch route', expected.every((p) => routes.has(p)), 'missing=' + expected.filter((p) => !routes.has(p)).join(','));
check('no legacy /dsh-music prefix route on the Desktop composition', legacyRoutes.length === 0);
check('all routes sit under /api (desktop host only forwards /api/*)', routeRegistrations.every((p) => p.startsWith('/api/')), routeRegistrations.join(','));

// ---- 以 Fetch 形态驱动路由（等价 desktop-host 的 url.pathname 分派） ----
function dispatch(request) {
  const url = new URL(request.url);
  const route = routes.get(url.pathname);
  if (route === undefined || !route.methods.includes(request.method)) {
    return Promise.resolve(new Response('not found', { status: 404 }));
  }
  return route.fetch(request);
}

// Electron 的 dsh-app:// 请求不带 loopback Host；Host: app 必须照样放行。
const origin = 'http://app';
const json = async (p, init) => {
  const r = await dispatch(new Request(origin + p, init));
  return { status: r.status, body: await r.json().catch(() => null) };
};

const setDir = await json('/api/dsh-music/dir', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ dir: music }),
});
check('POST /api/dsh-music/dir accepted on the Fetch transport', setDir.status === 200, 'status=' + setDir.status);

let library = null;
for (let i = 0; i < 40; i += 1) {
  const r = await json('/api/dsh-music/library');
  if (r.body?.scanning !== true && (r.body?.tracks ?? []).length > 0) { library = r.body; break; }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check('library scan reached the Fetch transport', library !== null && library.tracks.length === 1, 'tracks=' + (library?.tracks?.length ?? 'none'));

const full = await dispatch(new Request(origin + '/api/dsh-music/stream?p=song.wav'));
const fullBody = Buffer.from(await full.arrayBuffer());
check('GET stream → 200 with the exact bytes', full.status === 200 && fullBody.length === audio.length, 'status=' + full.status + ' bytes=' + fullBody.length + '/' + audio.length);

const ranged = await dispatch(new Request(origin + '/api/dsh-music/stream?p=song.wav', { headers: { range: 'bytes=10-19' } }));
const rangedBody = Buffer.from(await ranged.arrayBuffer());
check('Range → 206 + 10 bytes through the bridge', ranged.status === 206 && rangedBody.length === 10 && ranged.headers.get('content-range') === 'bytes 10-19/' + audio.length, 'status=' + ranged.status + ' range=' + ranged.headers.get('content-range'));

const head = await dispatch(new Request(origin + '/api/dsh-music/stream?p=song.wav', { method: 'HEAD' }));
check('HEAD reuses GET and returns headers with no body', head.status === 200 && head.body === null && head.headers.get('accept-ranges') === 'bytes', 'status=' + head.status + ' body=' + head.body);

const audioBytes = await dispatch(new Request(origin + '/api/dsh-music/stream?p=' + encodeURIComponent('../escape.wav')));
check('path escape still rejected on the Fetch transport', audioBytes.status === 403, 'status=' + audioBytes.status);

const missing = await dispatch(new Request(origin + '/api/dsh-music/nope'));
check('unregistered sibling path 404s (no index.html fallback)', missing.status === 404, 'status=' + missing.status);

const noRoute = await json('/api/dsh-music/library', { method: 'DELETE' });
check('undeclared method 404s (route methods are exact)', noRoute.status === 404, 'status=' + noRoute.status);

// 真实 HTTP 形态再走一遍：验证 node 客户端（fetch/undici）能读这条桥，且不依赖 Host 判定。
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request('http://' + (req.headers.host ?? 'app') + req.url, {
      method: req.method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    dispatch(request).then(async (response) => {
      const out = {};
      response.headers.forEach((value, name) => { out[name] = value; });
      const buffer = response.body === null ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, out);
      res.end(buffer);
    }).catch((error) => { res.writeHead(500).end(String(error)); });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const httpBase = 'http://127.0.0.1:' + server.address().port;
const overHttp = await fetch(httpBase + '/api/dsh-music/library');
const overHttpBody = await overHttp.json();
check('over real HTTP the Fetch route answers without a loopback Host fence', overHttp.status === 200 && overHttpBody.dir === music, 'status=' + overHttp.status);
const overHttpStream = await fetch(httpBase + '/api/dsh-music/stream?p=song.wav', { headers: { range: 'bytes=-32' } });
check('over real HTTP a suffix Range still lands', overHttpStream.status === 206 && (await overHttpStream.arrayBuffer()).byteLength === 32, 'status=' + overHttpStream.status);
server.close();

await fs.rm(music, { recursive: true, force: true });
await fs.rm(home, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
