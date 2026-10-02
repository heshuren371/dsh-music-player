// 门禁：常驻音频图（消除切歌「电流声」的机制）+ 媒体 CORS 窄名单。
//
// 为什么需要这两条：
//   曲库采样率/位深混排（44.1k/48k/96k、16/24bit）。Chromium 为**每条媒体源**单独建一条
//   音频输出流，换 src 就是「销毁旧流 + 按新文件格式建新流」→ macOS 重协商输出设备格式 →
//   那一声电流声。它发生在**增益级之外**，所以淡入淡出消不掉（用户实测证实）。
//   修法与系统播放器一致：一个常驻 AudioContext（一条输出流、一个固定采样率）。
//   桌面版页面 origin 是 dsh-app://app、媒体在 127.0.0.1 → **跨源**，Web Audio 必须有 CORS，
//   否则输出静音。因此宿主只对**窄名单**回显 ACAO —— 这条也在本门禁里钉死。
//
// ⚠️ 本套件测不到真实听感（jsdom 没有音频设备）。它测的是机制、跨源前提与回退路径。
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { createServer, request as httpRequest } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
// 崩溃必须显式变成一条 FAIL：否则进程带着非零码死掉却没有任何输出，
// 「失败但看不到原因」在 CI 上尤其致命（本地/CI 都吃过这个亏）。
const crash = (where, error) => {
  failures += 1;
  console.log('FAIL ' + where + ' crashed | ' + (error && error.stack ? error.stack.split('\n').slice(0, 3).join(' ⏎ ') : String(error)));
};
process.on('uncaughtException', (error) => { crash('uncaughtException', error); process.exit(1); });
process.on('unhandledRejection', (error) => { crash('unhandledRejection', error); process.exit(1); });
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail));
};

// ─────────────────────────── Part A：宿主媒体 CORS 窄名单 ───────────────────────────
{
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-graph-home-'));
  const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-graph-music-'));
  process.env.DSH_HOME = home;
  await fs.mkdir(path.join(home, 'storages'), { recursive: true });
  await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');
  const wav = (n = 4000) => {
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(88200, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    return buf;
  };
  await fs.writeFile(path.join(music, 'plain.wav'), wav());

  let handler = null;
  const { apply } = await import(new URL('../lib/index.js', import.meta.url).href);
  apply({
    effect: (fn) => fn(),
    get: () => undefined,
    webServer: { register: (route) => { handler = route.handler; return () => {}; } },
  });
  const server = createServer((req, res) => { handler(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500).end(String(e)); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const hostHeader = '127.0.0.1:' + port;
  const base = 'http://' + hostHeader + '/dsh-music';
  const raw = (pathname, { method = 'GET', origin } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (origin !== undefined) headers.origin = origin;
    if (method === 'GET') headers.range = 'bytes=0-99';
    const req = httpRequest({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });

  // 等扫描完成 + 拿 token
  let lib = null;
  for (let i = 0; i < 600; i += 1) {
    const r = await fetch(base + '/api/library');
    const body = await r.json().catch(() => null);
    if (body && body.scanning !== true && body.tracks.length > 0) { lib = body; break; }
    await new Promise((r2) => setTimeout(r2, 50));
  }
  check('A0: 库扫描在 30s 内完成（否则后面的断言无从谈起）', lib !== null && lib.tracks.length > 0,
    lib === null ? 'scan timeout' : 'tracks=' + lib.tracks.length);
  if (lib === null || lib.tracks.length === 0) { server.close(); process.exit(1); }
  const trackId = lib.tracks[0].id;
  const session = await (await fetch(base + '/api/session')).json();
  const token = /t=([^&]+)/.exec(session.systemStreamBase)[1];
  const sysPath = '/dsh-music/api/system-stream?t=' + token + '&p=' + encodeURIComponent(trackId);

  const appOrigin = 'dsh-app://app';
  const loopOrigin = 'http://127.0.0.1:9999';
  const evilOrigin = 'https://evil.example';

  const r1 = await raw(sysPath, { origin: appOrigin });
  check('A1: 桌面应用 origin 拿到 ACAO（Web Audio 跨源的前提）',
    r1.headers['access-control-allow-origin'] === appOrigin,
    'status=' + r1.status + ' acao=' + r1.headers['access-control-allow-origin']);
  check('A2: 回环 origin 也拿到 ACAO',
    (await raw(sysPath, { origin: loopOrigin })).headers['access-control-allow-origin'] === loopOrigin);
  const r3 = await raw(sysPath, { origin: evilOrigin });
  check('A3: 非名单 origin **一个 CORS 头都不给**（不用 `*`，token 通道不放大）',
    r3.headers['access-control-allow-origin'] === undefined && r3.headers['access-control-expose-headers'] === undefined,
    'acao=' + r3.headers['access-control-allow-origin']);
  const r4 = await raw(sysPath);
  check('A4: 没有 Origin 时行为与改动前一致（无 CORS 头）',
    r4.headers['access-control-allow-origin'] === undefined && r4.status === 206, 'status=' + r4.status);
  check('A5: CORS 头不影响 Range 语义（仍是 206 + content-range）',
    r1.status === 206 && typeof r1.headers['content-range'] === 'string', 'status=' + r1.status);

  const p1 = await raw(sysPath, { method: 'OPTIONS', origin: appOrigin });
  check('A6: 媒体端点应答 OPTIONS 预检（Range 不是 CORS 安全列表头）',
    p1.status === 204 && String(p1.headers['access-control-allow-headers'] ?? '').includes('range'),
    'status=' + p1.status + ' allow-headers=' + p1.headers['access-control-allow-headers']);
  const p2 = await raw(sysPath, { method: 'OPTIONS', origin: evilOrigin });
  check('A7: token 通道上非名单 origin 的预检被拒（403，不是 204）', p2.status === 403, 'status=' + p2.status);
  // 平台路由（stream）走的是**会话栅栏**：跨源预检由 isUntrustedRequest 直接 403。
  // 这是纵深防御的一部分 —— Web 形态是同源，本来就不需要 CORS。
  const p3 = await raw('/dsh-music/api/stream?p=' + encodeURIComponent(trackId), { method: 'OPTIONS', origin: appOrigin });
  check('A8: 平台路由**拒绝**跨源预检（纵深防御：Web 形态是同源，不需要 CORS）', p3.status === 403, 'status=' + p3.status);
  // 同源 origin（host 与 Host 相同 → 栅栏放行）时，非媒体端点不得被预检应答。
  const p4 = await raw('/dsh-music/api/library', { method: 'OPTIONS', origin: base });
  check('A9: 预检**只**对媒体端点开放（library 不得变 204）', p4.status !== 204, 'status=' + p4.status);

  server.close();
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(music, { recursive: true, force: true });
}

// ─────────────────────────── Part B：客户端常驻音频图 ───────────────────────────
const SOURCE = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const TRACKS = ['a.mp3', 'b.mp3'].map((name, index) => ({
  index, id: name, name, title: name, artist: 'x', duration: 200, kind: 'audio', mime: 'audio/mpeg',
}));

/** 假 AudioContext：记录建图与增益调度，供断言「常驻」「采样级渐变」。 */
function makeFakeAudioContext(log, { throwOnSource = false, state = 'running' } = {}) {
  return class FakeAudioContext {
    constructor() {
      log.push({ op: 'ctx' });
      this.state = state;
      this.sampleRate = 48000;   // 固定采样率就是常驻音频图的全部意义，夹具必须给出来
      this.currentTime = 1;
      this.destination = { id: 'destination' };
      this.gain = {
        gain: {
          value: 0,
          cancelScheduledValues: (t) => log.push({ op: 'cancel', t }),
          setValueAtTime: (v, t) => { this.gain.gain.value = v; log.push({ op: 'setValue', v, t }); },
          linearRampToValueAtTime: (v, t) => { this.gain.gain.value = v; log.push({ op: 'ramp', v, t }); },
        },
        connect: (to) => log.push({ op: 'connect', to: to.id }),
      };
    }
    createGain() { log.push({ op: 'createGain' }); return this.gain; }
    createMediaElementSource() {
      log.push({ op: 'createSource' });
      if (throwOnSource) throw new Error('no media source');
      return { connect: (to) => log.push({ op: 'connectSource', to: to.id }) };
    }
    resume() { log.push({ op: 'resume' }); this.state = 'running'; return Promise.resolve(); }
    suspend() { log.push({ op: 'suspend' }); this.state = 'suspended'; return Promise.resolve(); }
  };
}

async function boot({ fakeCtx = null, search = '', origin = 'http://127.0.0.1:3080', pageOrigin = null } = {}) {
  const log = [];
  // ⚠️ 跨源要用「页面端口 ≠ 媒体端口」来构造，**不能**用 `dsh-app://app` 当 jsdom 的 URL：
  // 非 special scheme 是 opaque origin，jsdom 的 localStorage 会直接抛 SecurityError。
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: (pageOrigin ?? origin) + '/' + search, pretendToBeVisual: true });
  const win = dom.window;
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.localStorage = win.localStorage;
  globalThis.location = win.location;   // 夹具保真：真实客户端一定有 location
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  win.Element.prototype.scrollIntoView = function () {};
  if (fakeCtx !== null) win.AudioContext = makeFakeAudioContext(log, fakeCtx);

  // ⚠️ 夹具必须是一个**活对象**：早先写成 `{...media, get src(){}}` 是**拷贝**，
  // 于是 play() 改的是外层、断言读的是副本（§9 陷阱 4：夹具保真度 = 断言判别力）。
  const attrs = {};
  const el = {
    _src: '', _volume: 1, _t: 0, paused: true, duration: 200, readyState: 4,
    error: null, preload: '',
    get src() { return this._src; },
    set src(v) { log.push({ op: 'src', v }); this._src = v; },
    get currentSrc() { return this._src; },
    get currentTime() { return this._t; },
    set currentTime(v) { log.push({ op: 'seek', v }); this._t = v; },
    // 真实元素的 `crossOrigin` 是**反射 IDL 属性**：赋值即写 attribute。夹具必须照做，
    // 否则断言读 attribute 恒为 undefined（本套件第三次栽在夹具保真度上，§9 陷阱 4）。
    get crossOrigin() { return attrs.crossorigin ?? null; },
    set crossOrigin(v) { attrs.crossorigin = v; },
    get volume() { return this._volume; },
    set volume(v) { this._volume = v; log.push({ op: 'volume', v }); },
    setAttribute: (n, v) => { attrs[n] = v; },
    removeAttribute: (n) => { if (n === 'crossorigin') delete attrs.crossorigin; },
    play() { this.paused = false; log.push({ op: 'play' }); return Promise.resolve(); },
    pause() { this.paused = true; log.push({ op: 'pause' }); },
    load() {},
    addEventListener: () => {},
  };
  win.__dshMusicMedia = () => el;

  const okJson = (body) => ({ ok: true, status: 200, json: async () => body, clone() { return okJson(body); } });
  const mockFetch = async (url) => {
    const t = String(url);
    if (t.includes('/session')) return okJson({ systemArtBase: origin + '/dsh-music/api/system-art?t=x', systemStreamBase: origin + '/dsh-music/api/system-stream?t=x' });
    if (t.includes('/library') || t.includes('/refresh')) return okJson({ dir: '/music', tracks: TRACKS, scanning: false, scannedAt: 1, truncated: false });
    return okJson({});
  };
  globalThis.fetch = mockFetch;
  win.fetch = mockFetch;

  let factory = null;
  win.__ModuleLoader__ = { load: ({ factory: f }) => { factory = f; } };
  win.eval(SOURCE);
  const plugin = factory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
  let View = null;
  plugin.apply({
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (key) => (({ stats: (n) => String(n) })[key] ?? key) },
    slots: { inject: (_n, fn) => fn(), register: (_m, c) => { View = c; return () => {}; } },
  });
  const root = createRoot(win.document.createElement('div'));
  await act(async () => { root.render(React.createElement(View)); });
  const player = win.__dshMusicPlayer;
  // 抓 console.info：常驻音频图的「在行为发生的那一刻」诊断必须可见，且不得含凭据。
  const infoLines = [];
  const realInfo = console.info;
  console.info = (...args) => { infoLines.push(args.map(String).join(' ')); };
  const restoreInfo = () => { console.info = realInfo; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && player.getState().tracks.length < 2; i += 1) await act(async () => { await sleep(25); });
  /** 有界轮询：等到条件成立或超时。**不改变断言口径**，只是不再赌固定 sleep 够长。 */
  const waitFor = async (pred, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await sleep(10);
    }
    return pred();
  };
  return { log, player, media: el, attrs: () => attrs, sleep, waitFor, origin, infoLines, restoreInfo, state: () => player.getState() };
}

// B1/B2/B3：建图一次、常驻、增益接管音量
{
  const b = await boot({ fakeCtx: {} });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'createSource'));      // 建图（最多 2s）
    await b.waitFor(() => Math.abs(b.media.volume - b.state().volume) < 1e-6); // 淡入完成
  });
  const ctxCount = b.log.filter((o) => o.op === 'ctx').length;
  const srcCount = b.log.filter((o) => o.op === 'createSource').length;
  check('B1: 起播时建**一个** AudioContext 并把媒体接进去', ctxCount === 1 && srcCount === 1, 'ctx=' + ctxCount + ' source=' + srcCount);
  check('B2: 图连到 destination，且 media 元素音量置中性（真正的增益在图里）',
    b.log.some((o) => o.op === 'connect' && o.to === 'destination') && b.media.volume === 1,
    'volume=' + b.media.volume);
  const gainAfter = b.log.filter((o) => o.op === 'ramp' || o.op === 'setValue').map((o) => o.v);
  check('B3: 淡入走的是 GainNode（采样级线性渐变），不是 16ms 定时器写元素音量',
    gainAfter.length > 0 && Math.abs(gainAfter[gainAfter.length - 1] - b.state().volume) < 1e-6,
    'gain=' + JSON.stringify(gainAfter) + ' state=' + b.state().volume);

  const before = b.log.filter((o) => o.op === 'ctx').length;
  await act(async () => {
    b.player.play(1);
    await b.waitFor(() => b.log.filter((o) => o.op === 'src').length >= 2);   // 第二首已挂源
    await b.waitFor(() => Math.abs(b.media.volume - b.state().volume) < 1e-6);
  });
  check('B4: 换歌**不重建** AudioContext（常驻才是消除设备重协商的关键）',
    b.log.filter((o) => o.op === 'ctx').length === before, 'ctx 次数 ' + before + ' → ' + b.log.filter((o) => o.op === 'ctx').length);
  check('B5: 同源媒体**不设** crossOrigin（设了反而会因同源无 ACAO 而失败）',
    b.attrs().crossorigin === undefined, 'crossorigin=' + b.attrs().crossorigin);
  check('B6: halt() 释放设备流（suspend，不是 close）',
    (b.player.halt(), b.log.some((o) => o.op === 'suspend')));
  b.restoreInfo();
  const graphInfo = b.infoLines.filter((l) => l.includes('常驻音频图已启用'));
  check('B12: 建图时留下「行为发生那一刻」的诊断（含 ctx 的 sampleRate）',
    graphInfo.length === 1 && graphInfo[0].includes('sampleRate=48000'),
    graphInfo[0] ?? '(无)');
  // §2.9：诊断不得把凭据带出去（URL 里的 t=<token> 是能力凭证）。
  check('B13: 诊断行**不含凭据**（没有 t= / 没有 URL）',
    b.infoLines.every((l) => !/t=|https?:\/\//.test(l)), JSON.stringify(b.infoLines.slice(0, 3)));
}

// B7：兜底开关
{
  const b = await boot({ fakeCtx: {}, search: '?musicGraph=0' });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'play'));              // 已经起播（回退路径）
    await b.waitFor(() => Math.abs(b.media.volume - b.state().volume) < 1e-6);
  });
  check('B7: `?musicGraph=0` 能关掉音频图（出问题时的兜底开关）',
    b.log.filter((o) => o.op === 'ctx').length === 0 && b.media.volume > 0,
    'ctx=' + b.log.filter((o) => o.op === 'ctx').length + ' volume=' + b.media.volume);
}

// B8：建图失败必须自动回退，不能把播放搞坏
{
  const b = await boot({ fakeCtx: { throwOnSource: true } });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'play'));
    await b.waitFor(() => Math.abs(b.media.volume - b.state().volume) < 1e-6);
  });
  check('B8: createMediaElementSource 失败 → 回退到元素音量，播放照常',
    b.media.paused === false && b.media.volume > 0,
    'paused=' + b.media.paused + ' volume=' + b.media.volume);
}

// B9/B10：桌面跨源 —— 先直连（不出声风险为 0），探测确认后再建图
{
  const b = await boot({ fakeCtx: {}, origin: 'http://127.0.0.1:3080', pageOrigin: 'http://127.0.0.1:3999' });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'src'));   // 第一首已挂源（仍走直连）
  });
  check('B9: 跨源且尚未确认 CORS 时**不建图**（先直连，后台探一次再说）',
    b.log.filter((o) => o.op === 'ctx').length === 0, 'ctx=' + b.log.filter((o) => o.op === 'ctx').length);
  await act(async () => {
    b.player.play(1);
    await b.waitFor(() => b.log.some((o) => o.op === 'createSource'));
    await b.waitFor(() => Math.abs(b.media.volume - b.state().volume) < 1e-6);
  });
  check('B10: 探测确认 CORS 后**建图并常驻**（这才是桌面版最终走的路）',
    b.log.filter((o) => o.op === 'ctx').length === 1 && b.log.filter((o) => o.op === 'createSource').length === 1,
    'ctx=' + b.log.filter((o) => o.op === 'ctx').length + ' source=' + b.log.filter((o) => o.op === 'createSource').length);
  check('B11: 跨源媒体**必须**带 crossOrigin=anonymous（否则 Web Audio 静音）',
    b.attrs().crossorigin === 'anonymous', 'crossorigin=' + b.attrs().crossorigin);
}

// B14/B15：拖进度也要淡入淡出（fooyin: seek{in=120,out=120}）——仅当音频图接管增益时
{
  const b = await boot({ fakeCtx: {} });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => Math.abs(b.media.volume - b.state().volume) < 1e-6);
  });
  const mark = b.log.length;
  b.player.seek(120);
  await act(async () => { await b.waitFor(() => b.log.slice(mark).some((o) => o.op === 'seek')); });
  const tail = b.log.slice(mark);
  const iRamp0 = tail.findIndex((o) => o.op === 'ramp' && o.v === 0);
  const iSeek = tail.findIndex((o) => o.op === 'seek');
  const iBack = tail.findIndex((o, i) => i > iSeek && o.op === 'ramp' && o.v > 0);
  check('B14: seek 前先把增益淡到 0（拖动同样是硬跳变）', iRamp0 >= 0 && iRamp0 < iSeek,
    JSON.stringify(tail.slice(0, 4)));
  check('B15: 顺序正确 —— 淡出 → seek → 淡回', iRamp0 >= 0 && iSeek > iRamp0 && iBack > iSeek,
    'ramp0=' + iRamp0 + ' seek=' + iSeek + ' back=' + iBack);
  b.restoreInfo();
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
