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
function makeFakeAudioContext(log, store, { throwOnSource = false, state = 'running', noBiquad = false } = {}) {
  return class FakeAudioContext {
    constructor() {
      log.push({ op: 'ctx' });
      this.state = state;
      this.sampleRate = 48000;   // 固定采样率就是常驻音频图的全部意义，夹具必须给出来
      this.currentTime = 1;
      this.destination = { id: 'destination' };
      this._n = 0;
    }
    // ⚠️ 每次必须是**新节点**：真实 createGain() 就是这样。先前返回同一个对象，
    // 两个增益（音量 / ReplayGain）会互相覆盖 —— 夹具不保真，断言就没有判别力（§9 陷阱 4）。
    createGain() {
      const id = 'gain' + (++this._n);
      const node = {
        id,
        gain: {
          value: 0,
          cancelScheduledValues: (t) => log.push({ op: 'cancel', t, id }),
          setValueAtTime: (v, t) => { node.gain.value = v; log.push({ op: 'setValue', v, t, id }); },
          linearRampToValueAtTime: (v, t) => { node.gain.value = v; log.push({ op: 'ramp', v, t, id }); },
        },
        // `from` 也要记：E 段要按边遍历链条（只有 `to` 的话无法判断「谁接进谁」）。
        connect: (to) => log.push({ op: 'connect', from: id, to: to && to.id }),
      };
      store.push(node);
      log.push({ op: 'createGain', id });
      return node;
    }
    /** 假的 peaking 滤波器：E 段要逐段读频点与增益。 */
    createBiquadFilter() {
      const id = 'filter' + (++this._n);
      const node = {
        id,
        type: 'lowpass',
        frequency: { value: 0 },
        Q: { value: 0 },
        gain: { value: 0 },
        connect: (to) => log.push({ op: 'connect', from: id, to: to && to.id }),
        disconnect: () => {},
      };
      store.push(node);
      log.push({ op: 'createFilter', id });
      return node;
    }
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
  const store = [];
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
  if (fakeCtx !== null) {
    const Ctor = makeFakeAudioContext(log, store, fakeCtx);
    if (fakeCtx.noBiquad) delete Ctor.prototype.createBiquadFilter;   // 模拟老实现：只跳过 EQ
    win.AudioContext = Ctor;
  }

  // ⚠️ 夹具必须是一个**活对象**：早先写成 `{...media, get src(){}}` 是**拷贝**，
  // 于是 play() 改的是外层、断言读的是副本（§9 陷阱 4：夹具保真度 = 断言判别力）。
  // 元素工厂：交叉淡化需要**两个**元素，日志必须能区分是谁做的（el: 'A' | 'B'）。
  const makeEl = (tag) => {
    const attrs = {};
    return {
      _tag: tag, _attrs: attrs, _src: '', _volume: 1, _t: 0, paused: true, duration: 200, readyState: 4,
      error: null, preload: '',
      get src() { return this._src; },
      set src(v) { log.push({ op: 'src', v, el: tag }); this._src = v; },
      get currentSrc() { return this._src; },
      get currentTime() { return this._t; },
      set currentTime(v) { log.push({ op: 'seek', v, el: tag }); this._t = v; },
      // 真实元素的 `crossOrigin` 是**反射 IDL 属性**：赋值即写 attribute。夹具必须照做，
      // 否则断言读 attribute 恒为 undefined（本套件第三次栽在夹具保真度上，§9 陷阱 4）。
      get crossOrigin() { return attrs.crossorigin ?? null; },
      set crossOrigin(v) { attrs.crossorigin = v; },
      get volume() { return this._volume; },
      set volume(v) { this._volume = v; log.push({ op: 'volume', v, el: tag }); },
      setAttribute: (n, v) => { attrs[n] = v; },
      removeAttribute: (n) => { log.push({ op: 'removeAttr', name: n, el: tag }); if (n === 'crossorigin') delete attrs.crossorigin; },
      play() { this.paused = false; log.push({ op: 'play', el: tag }); return Promise.resolve(); },
      pause() { this.paused = true; log.push({ op: 'pause', el: tag }); },
      load() { log.push({ op: 'load', el: tag }); },
      addEventListener: () => {},
    };
  };
  const el = makeEl('A');
  const el2 = makeEl('B');
  win.__dshMusicMedia = () => el;
  win.__dshMusicMedia2 = () => el2;

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
  return { log, store, win, player, media: el, media2: el2, attrs: () => el._attrs, sleep, waitFor, origin, infoLines, restoreInfo, state: () => player.getState() };
}

// B1/B2/B3：建图一次、常驻、增益接管音量
{
  const b = await boot({ fakeCtx: {}, search: '?crossfade=0' });
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
  const b = await boot({ fakeCtx: {}, search: '?musicGraph=0&crossfade=0' });
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
  const b = await boot({ fakeCtx: { throwOnSource: true }, search: '?crossfade=0' });
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
  const b = await boot({ fakeCtx: {}, search: '?crossfade=0', origin: 'http://127.0.0.1:3080', pageOrigin: 'http://127.0.0.1:3999' });
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
  const b = await boot({ fakeCtx: {}, search: '?crossfade=0' });
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

// ── D. 预取 + 交叉淡化（`?crossfade=1`；默认关闭，见 §2.21）───────────────────────
// 为什么要有 D 段：默认路径断言（A–C）在关闭时**不该有任何变化**；开启后要保证
// ① 下一首真的被预取、② 两个元素**重叠**（不是「淡出→加载→淡入」的缝隙）、
// ③ 电平与用户音量分离、④ 角色交换后各处引用指向新元素、⑤ teardown 两个都停。
{
  const b = await boot({ fakeCtx: {}, search: '?crossfade=1' });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'src' && o.el === 'A'));
  });
  // 预取：下一首的 URL 挂到**空闲**元素上，且它没有被播放（只加载、不出声）
  const prefetched = b.log.filter((o) => o.op === 'src' && o.el === 'B');
  check('D1: 起播后把下一首预取到空闲元素（只加载不出声）',
    prefetched.length === 1 && String(prefetched[0].v).includes('b.mp3')
      && !b.log.some((o) => o.op === 'play' && o.el === 'B'),
    'prefetched=' + prefetched.length + ' src=' + String(prefetched[0]?.v).slice(-24));

  // 交叉：两个电平节点**同时**被调度（一个降、一个升），这才是「重叠」而不是「先淡出再淡入」
  const mark = b.log.length;
  await act(async () => {
    b.player.play(1);
    await b.waitFor(() => b.player.media() === b.media2, 2000);
  });
  const tail = b.log.slice(mark);
  const ramps = tail.filter((o) => o.op === 'ramp' || o.op === 'setValue');
  // 必须是**两条 ramp**（采样级渐变）落在**两个不同**节点上：一条降到 0（旧元素）、
  // 一条升到 1（新元素）—— 这才叫重叠。写成 `find(v===1)` 会误命中 setValue（本轮踩到）。
  // ⚠️ 角色必须**显式**取：交叉淡化里除两个电平节点外，RG 节点也在 ramp，
  // 只按「v===1」找会拿 RG 冒充电平节点（那样即便电平没重叠也照样绿）。
  // ⚠️ 从**整段日志**取（`connectSource` 发生在起播时，不在 `tail` 里 —— 第一版就是从 tail 取的，
  // 结果两个角色都是 undefined，D2/D5 变成「恒红」，而对照看起来也红，等于什么都没测）。
  const srcTargets = b.log.filter((o) => o.op === 'connectSource').map((o) => o.to);
  const levelA = srcTargets[0];
  const levelB = srcTargets[1];
  const down = ramps.find((o) => o.op === 'ramp' && o.v === 0 && o.id === levelA);
  const up = ramps.find((o) => o.op === 'ramp' && o.v === 1 && o.id === levelB);
  // 「重叠」= 两条 ramp 在**同一时刻起算**（都以同一个 now 为基准）。若实现退化成
  // 「先淡出、再淡入」（有缝隙），新元素那条 ramp 会晚 `changeFadeOutMs` —— 所以这条
  // 时间断言才是 D2 的判别力所在（只看「节点不同」的话，串行实现也会通过）。
  const sameStart = down !== undefined && up !== undefined && Math.abs(up.t - down.t) < 0.05;
  check('D2: 交叉是**重叠**的 —— 两条**电平** ramp 同刻起算（串行的「先淡出再淡入」会红）',
    down !== undefined && up !== undefined && levelA !== levelB && sameStart,
    'levelA=' + String(levelA) + ' levelB=' + String(levelB) + ' ' + JSON.stringify(ramps.slice(0, 4)));

  // 电平与**用户音量**分离：音量节点（gain1）在交叉期间不得被写
  const volumeTouched = ramps.filter((o) => o.id === 'gain1');
  check('D3: 交叉走的是每元素电平，**不写用户音量节点**（否则用户音量会被过渡吃掉）',
    volumeTouched.length === 0, 'volume-node ops=' + volumeTouched.length);

  check('D4: 交接后活跃元素换成预取的那个（引用自动跟随，旧元素已停）',
    b.player.media() === b.media2 && b.media.paused === true,
    'activeIsB=' + (b.player.media() === b.media2) + ' oldPaused=' + b.media.paused);

  // D5：交叉淡化期间两首**同时在响**，而 RG 节点是**共享**的 —— 瞬时写值等于给两首一起做阶跃，
  // 听感就是那「一丝丝杂音」。必须按过渡时长**斜坡**过去（且从当前值起算）。
  // 节点角色：媒体源接进去的那个是**电平节点**，电平节点接进去的那个才是 **RG 节点**。
  // 角色：媒体源接进去的是**电平节点**（本曲目那一个），电平节点接进去的才是 **RG 节点**。
  const levelId = srcTargets[0];
  const rgId = b.log.find((o) => o.op === 'connect' && o.from === levelId)?.to;
  const rgOps = tail.filter((o) => o.id === rgId);
  const rgRamp = rgOps.find((o) => o.op === 'ramp');
  const rgStart = rgOps.find((o) => o.op === 'setValue');
  check('D5: 交叉淡化时 RG 增益走**斜坡**（不是瞬时写值），并从当前值起算',
    rgId !== undefined && rgRamp !== undefined && rgStart !== undefined
      && rgRamp.t - rgStart.t > 0.05,
    'rg=' + String(rgId) + ' ops=' + JSON.stringify(rgOps.slice(0, 3)));

  // D6：交接时**不得**清掉旧元素的 src / load() —— 那会再触发一次媒体管线拆除
  //（设备侧看到两次事件而不是一次）。让它等下一次预取直接覆盖。
  check('D6: 交接时不清旧元素的 src（一次过渡 = 一次换源，少一次媒体管线拆除）',
    !b.log.some((o) => o.op === 'removeAttr' && o.name === 'src'),
    'removeAttr src 次数=' + b.log.filter((o) => o.op === 'removeAttr' && o.name === 'src').length);

  // 预取是**链式**的：交接后立刻为新空闲元素预取再下一首
  check('D8: 交接后继续链式预取（下一首挂到新的空闲元素上）',
    b.log.filter((o) => o.op === 'src' && o.el === 'A').length >= 2,
    'A src ops=' + b.log.filter((o) => o.op === 'src' && o.el === 'A').length);

}

// D7 单独跑：**在交叉进行中** halt —— 那一刻「活跃」仍是旧元素，正在淡入的新元素是空闲元素，
// 只有 `halt()` 主动停空闲元素才能让它不继续出声（否则 teardown 后它还在播，I-06）。
// 不这么写的话，交接已经 pause 过空闲元素，断言恒绿（本轮实测：删掉 halt 里的停止调用，旧写法照样通过）。
{
  const b = await boot({ fakeCtx: {}, search: '?crossfade=1' });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'src' && o.el === 'B'));
    b.player.play(1);
    // ⚠️ 切歌是**异步**的（要先拿流基址）。必须等新元素真的**开始播放**（交叉已启动）
    // 再 teardown，否则 halt 抢在交叉开始之前赢，断言恒绿 —— 本轮实测踩到过。
    await b.waitFor(() => b.log.some((o) => o.op === 'play' && o.el === 'B'), 1000);
    b.player.halt();                   // 交接（320ms 后）之前 teardown
  });
  check('D7: 交叉进行中 halt() 会停掉空闲元素（只停当前那个会留下它继续出声）',
    b.media.paused === true && b.media2.paused === true,
    'A=' + b.media.paused + ' B=' + b.media2.paused);
}

// D0：**默认开启**（第 25 轮用户确认噪声与平台相关后翻转）—— 不带参数就该走交叉淡化；
// 想回到旧路径必须**显式** `?crossfade=0`。两条都要断言，否则「默认值」本身就没人守。
{
  const b = await boot({ fakeCtx: {} });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'src' && o.el === 'B'), 1500);
  });
  check('D0a: **默认**（不带参数）就走交叉淡化：创建空闲元素并预取下一首',
    typeof b.media2.src === 'string' && b.media2.src.length > 0 && b.log.some((o) => o.op === 'src' && o.el === 'B'),
    'el2 src=' + JSON.stringify(b.media2.src).slice(0, 60));
}
{
  const b = await boot({ fakeCtx: {}, search: '?crossfade=0' });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'src'));
  });
  check('D0b: 显式 ?crossfade=0 时不碰第二个元素（旧路径仍可复现、可排查）',
    b.media2.src === '' && !b.log.some((o) => o.el === 'B'), 'el2 src=' + JSON.stringify(b.media2.src));
}

// ── E. 均衡器（10 段 peaking + 预设 + 自动前级；见 §2.22）─────────────────────────
{
  const b = await boot({ fakeCtx: {}, search: '?crossfade=0' });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'src'));
  });
  const filters = b.store.filter((n) => n.id.startsWith('filter'));
  check('E1: 建出 10 段 peaking 滤波器，频点就是十段 ISO 中心频率',
    filters.length === 10 && filters.every((f) => f.type === 'peaking')
      && filters.map((f) => f.frequency.value).join(',') === '31,62,125,250,500,1000,2000,4000,8000,16000',
    'n=' + filters.length + ' freq=' + filters.map((f) => f.frequency.value).join(','));

  const idToDest = (b.log.find((o) => o.op === 'connect' && o.to === 'destination') ?? {}).from;
  const sourceTo = (b.log.find((o) => o.op === 'connectSource') ?? {}).to;
  const edge = (from) => (b.log.find((o) => o.op === 'connect' && o.from === from) ?? {}).to;
  const walk = [];
  let cursor = sourceTo;
  for (let i = 0; i < 20 && cursor !== undefined; i += 1) { walk.push(cursor); cursor = edge(cursor); }
  const f1 = filters[0]; const f10 = filters[filters.length - 1];
  check('E2: 链条顺序 —— 源 → RG → f1…f10 → 前级 → 音量 → destination',
    sourceTo !== undefined && f1 !== undefined && f10 !== undefined
      && walk.includes(f1.id) && walk.includes(f10.id)
      && walk.indexOf(f1.id) < walk.indexOf(f10.id) && walk[walk.length - 1] === 'destination',
    walk.join('→'));

  // ⚠️ 一律带 `filters.length === 10` 护栏：`[].every()` 恒真，缺了它会「空过」
  //（对照⑭实测：不建链时 E3/E4/E8 全绿，只有 E1/E2 红 —— 这就是恒绿断言）。
  check('E3: 默认 flat —— 每段 0dB（不动用户听到的音色）',
    filters.length === 10 && filters.every((f) => f.gain.value === 0) && b.state().eqPreset === 'flat',
    'gains=' + filters.map((f) => f.gain.value).join(',') + ' preset=' + b.state().eqPreset);

  await act(async () => { b.player.setEqualizer('bass'); });
  // 预设曲线在源码里（§2.22）；这里写死是为了「改了预设必须回来同步断言」——本轮就把能量
  // 从 31/62Hz（小动圈几乎无输出）挪到了 62–250Hz，期望值随之更新。
  const bass = [2, 4, 5, 4, 2, 0, 0, 0, 0, 0];
  check('E4: 切到预设后每段增益等于预设值',
    filters.length === 10 && filters.every((f, i) => Math.abs(f.gain.value - bass[i]) < 0.001),
    'gains=' + filters.map((f) => f.gain.value).join(','));

  const preamp = b.store.find((n) => edge(n.id) === idToDest && !n.id.startsWith('filter') && n.id !== sourceTo);
  const wantPreamp = Math.pow(10, -5 / 20);
  check('E5: 自动前级按最大提升量衰减（+5dB → ×' + wantPreamp.toFixed(4) + '），不让 EQ 造成削波',
    preamp !== undefined && Math.abs(preamp.gain.value - wantPreamp) < 0.005,
    'preamp=' + String(preamp?.gain.value));

  await act(async () => { b.player.setEqualizer([99, -99, 3, 0, 0, 0, 0, 0, 0, 0]); });
  check('E6: 自定义曲线被夹到 ±12dB（脏数据不该变成刺耳的声音）',
    filters.length === 10 && filters[0].gain.value === 12 && filters[1].gain.value === -12 && b.state().eqPreset === 'custom',
    // ⚠️ `check` 的 detail 是**无条件求值**的：没有滤波器时 `filters[0].gain` 会崩，
    // 从而掩盖 E7–E10（对照⑭实测）。细节表达式也必须自己防住。
    filters.length === 10
      ? ('g0=' + filters[0].gain.value + ' g1=' + filters[1].gain.value + ' preset=' + b.state().eqPreset)
      : 'filters=' + filters.length);

  const before = filters.map((f) => f.gain.value).join(',');
  await act(async () => {
    b.player.setEqualizer('不存在的预设');
    b.player.setEqualizer([1, 2, 3]);
  });
  check('E7: 非法输入**不动**现状（未知预设 / 长度不对都不猜）',
    filters.length === 10 && filters.map((f) => f.gain.value).join(',') === before,
    'before=' + before + ' after=' + filters.map((f) => f.gain.value).join(','));

  const rgNode = b.store.find((n) => n.id === sourceTo);
  const volNode = b.store.find((n) => n.id === idToDest);
  const rgBefore = rgNode.gain.value;
  await act(async () => { b.player.setVolume(0.4); });
  check('E8: 改用户音量不动 EQ、不动 RG（音量 / RG / EQ 三条互不覆盖）',
    filters.length === 10 && filters[0].gain.value === 12 && rgNode.gain.value === rgBefore && Math.abs(volNode.gain.value - 0.4) < 0.001,
    filters.length === 10
      ? JSON.stringify({ eq0: filters[0].gain.value, rg: rgNode.gain.value, vol: volNode.gain.value })
      : 'filters=' + filters.length);

  const storedPrefs = JSON.parse(b.win.localStorage.getItem('dsh-music:prefs') ?? '{}');
  check('E9: 曲线持久化（刷新后保留，不会回到默认）',
    storedPrefs.eqPreset === 'custom' && Array.isArray(storedPrefs.eqBands) && storedPrefs.eqBands[0] === 12,
    String(storedPrefs.eqPreset) + ' bands=' + JSON.stringify(storedPrefs.eqBands));
}

// E10：没有 createBiquadFilter 的环境**只跳过 EQ**，音频图必须照建（不能连常驻输出流一起丢）
{
  const b = await boot({ fakeCtx: { noBiquad: true }, search: '?crossfade=0' });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'src'));
  });
  check('E10: 缺 createBiquadFilter 时只跳过均衡器，音频图照建（§2.19 的常驻流不能丢）',
    b.log.filter((o) => o.op === 'ctx').length === 1 && b.log.filter((o) => o.op === 'createFilter').length === 0
      && b.media.volume === 1,
    'ctx=' + b.log.filter((o) => o.op === 'ctx').length + ' filters=' + b.log.filter((o) => o.op === 'createFilter').length);
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
