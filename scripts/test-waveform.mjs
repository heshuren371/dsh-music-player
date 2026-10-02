// 门禁：波形进度条（宿主只读解码取包络 → 缓存 → 客户端两层柱子按进度裁开）。
//
// 为什么需要它：
//   进度条只是一条线时，你无法一眼看出「哪儿是副歌、哪儿是静音」，拖动全凭猜。
//   做法与 fooyin 的 waveform seekbar 同源（GPL-3.0 项目：**只借鉴做法，不抄代码**）：
//     ① 用 ffmpeg **只读**解码成单声道，按固定时长聚合峰值 —— **内存与曲长无关**
//        （绝不缓冲整段 PCM：一小时 8kHz 单声道就是 56MB）；
//     ② 只读、不改任何音频文件；结果存插件自己的缓存（size+mtime 失效）；
//     ③ 每首各自归一化到 0..1，安静的歌也看得见；全静音保持全 0；
//     ④ 拿不到就**静默降级**回原来的细轨 —— 波形是锦上添花，不该变成红字。
//
// ⚠️ 真实观感（柱子形状好不好看）测不到；这里测的是**包络是否忠实**与**降级是否干净**。
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ Part A 会把 `globalThis.fetch` 换成 mock（客户端要用假宿主）。先捕获真身，
// 否则 Part B 会拿假 fetch 去打真宿主 —— 症状是「路由明明存在，却返回 {}」（第 21 轮踩过）。
const nodeFetch = globalThis.fetch;

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail));
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const ORIGIN = 'http://127.0.0.1:3080';

const TRACKS = [
  { index: 0, id: 'a.flac', name: 'a.flac', title: 'a', artist: 'x', duration: 200, kind: 'audio' },
  { index: 1, id: 'b.flac', name: 'b.flac', title: 'b', artist: 'x', duration: 200, kind: 'audio' },
];

/**
 * 夹具 peaks 必须是宿主真实会下发的**长度 400**：给 8 个的话客户端抽样路径根本不会被走到，
 * 「400 桶 → 120 根柱子」这条最该验的逻辑就成了空断言（第一版就是这么写错的）。
 * a.flac = 前 200 桶静音 + 后 200 桶满幅；b.flac = 全程 0.5（与 a 截然不同，便于验「迟到结果被丢弃」）。
 */
const PEAKS_A = Array.from({ length: 400 }, (_, i) => (i < 200 ? 0 : 1));
const PEAKS_B = Array.from({ length: 400 }, () => 0.5);

async function boot({ wave = 'ok', delayFor = null } = {}) {
  const log = [];
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: ORIGIN + '/', pretendToBeVisual: true });
  const win = dom.window;
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.localStorage = win.localStorage;
  globalThis.location = win.location;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  win.Element.prototype.scrollIntoView = function () {};

  const el = {
    _src: '', _volume: 1, _t: 0, paused: true, duration: 200, readyState: 4, error: null, preload: '',
    get src() { return this._src; },
    set src(v) { this._src = v; },
    get currentSrc() { return this._src; },
    get currentTime() { return this._t; },
    set currentTime(v) { this._t = v; },
    get volume() { return this._volume; },
    set volume(v) { this._volume = v; },
    setAttribute: () => {}, removeAttribute: () => {},
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    load() {},
    addEventListener: () => {},
  };
  win.__dshMusicMedia = () => el;

  const okJson = (body) => ({ ok: true, status: 200, json: async () => body, clone() { return okJson(body); } });
  const mockFetch = async (url) => {
    const t = String(url);
    if (t.includes('/session')) return okJson({ systemArtBase: ORIGIN + '/dsh-music/api/system-art?t=x', systemStreamBase: ORIGIN + '/dsh-music/api/system-stream?t=x' });
    if (t.includes('/library') || t.includes('/refresh')) return okJson({ dir: '/music', tracks: TRACKS, scanning: false, scannedAt: 1, truncated: false });
    if (t.includes('/waveform')) {
      log.push({ op: 'waveform', url: t });
      const id = decodeURIComponent((t.split('p=')[1] ?? '').split('&')[0]);
      const wait = delayFor === null ? 0 : delayFor(id);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (wave === 'empty') return okJson({ peaks: [], cached: false, reason: 'ffmpeg-not-found' });
      if (wave === 'error') return { ok: false, status: 500, json: async () => ({}), clone() { return okJson({}); } };
      return okJson({ peaks: id === 'a.flac' ? PEAKS_A : PEAKS_B, cached: false, reason: null });
    }
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
    get: () => undefined,
    // 桩要和 RG 套件一致：`locale.register` 是必需品（少给一个方法，视图渲染直接崩）。
    locale: { register: () => {}, bind: () => (key) => (({ stats: (n) => String(n) })[key] ?? key) },
    slots: { inject: (_n, fn) => fn(), register: (_m, c) => { View = c; return () => {}; } },
  });
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(View, { ctx: { get: () => undefined } })); });
  const player = win.__dshMusicPlayer ?? plugin.player;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeout = 2000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (fn()) return true; await sleep(10); }
    return false;
  };
  const bars = () => container.querySelectorAll('.dshm-wave__bar');
  return { log, player, win, container, bars, sleep, waitFor };
}

// ─────────────────────── Part A：客户端（jsdom + 假宿主）───────────────────────
{
  const b = await boot();
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'waveform'));
  });
  const reqs0 = b.log.filter((o) => o.op === 'waveform').map((o) => o.url);
  check('A1: 起播取当前曲目的包络，并**顺带预取下一首**（切歌时柱子不必等往返）',
    reqs0.length === 2 && reqs0.some((u) => u.includes('p=a.flac')) && reqs0.some((u) => u.includes('p=b.flac')),
    reqs0.join(' '));

  await b.waitFor(() => b.bars().length > 0);
  // 两层同样的柱子（底层暗、上层亮），上层用 clip-path 按进度裁开
  const all = b.bars();
  const rows = b.container.querySelectorAll('.dshm-wave__row');
  const onRow = b.container.querySelector('.dshm-wave__row--on');
  check('A2: 常驻底栏渲染 60 根柱子 ×2 层（节点数 = 2×柱子数，底栏刻意减半）',
    all.length === 120 && rows.length === 2 && onRow !== null,
    'bars=' + all.length + ' rows=' + rows.length);

  // 400 桶 → 60 根：a.flac 是「前 200 桶静音 + 后 200 桶满幅」⇒ 前 30 根 6%、后 30 根 100%
  const heights = Array.from(all).slice(0, 60).map((n) => n.style.height);
  check('A3: 柱子高度跟随包络且抽样正确（前 30 根 6% 底线，后 30 根 100%）',
    heights[0] === '6%' && heights[29] === '6%' && heights[59] === '100%',
    'first=' + heights[0] + ' mid=' + heights[29] + ' last=' + heights[59]);

  const trackEl = b.container.querySelector('.dshm-progressTrack');
  const played = trackEl?.style.getPropertyValue('--dshm-played');
  check('A4: 播放进度通过 CSS 变量传给遮罩（拖动时不必触发 React 重渲染）',
    typeof played === 'string' && played.endsWith('%'), '--dshm-played=' + String(played));

  // 换歌：b.flac 的包络**已经预取好了** ⇒ 不再请求，且立刻出图（本轮优化的效果）
  await act(async () => {
    b.player.play(1);
    await b.sleep(100);
  });
  const reqs1 = b.log.filter((o) => o.op === 'waveform').map((o) => o.url);
  const bHeights = Array.from(b.bars()).slice(0, 2).map((n) => n.style.height);
  check('A5: 换歌命中预取缓存 —— **不再请求**，且立刻显示新曲目的包络',
    reqs1.length === 2 && bHeights[0] === '50%' && bHeights[1] === '50%',
    'requests=' + reqs1.length + ' first=' + bHeights[0]);

  // 回到上一首：也命中客户端缓存（有界 Map），同样不再请求
  await act(async () => {
    b.player.play(0);
    await b.sleep(100);
  });
  const reqs2 = b.log.filter((o) => o.op === 'waveform').map((o) => o.url);
  const aHeights = Array.from(b.bars()).slice(0, 2).map((n) => n.style.height);
  check('A6: 回到上一首命中客户端缓存 —— 三次切歌总共只请求两次',
    reqs2.length === 2 && aHeights[0] === '6%', 'requests=' + reqs2.length + ' first=' + aHeights[0]);

  // 全屏播放器给更多细节：120 根柱子（底栏 60 根）
  await act(async () => {
    b.player.openPlayer();
    await b.sleep(60);
  });
  const stacked = b.container.querySelector('.dshm-progress--stacked');
  const stackedBars = stacked === null ? 0 : stacked.querySelectorAll('.dshm-wave__bar').length;
  check('A7: 全屏播放器用 120 根柱子（细节更多），常驻底栏 60 根',
    stackedBars === 240, 'stacked bars=' + stackedBars);
}

// A8：拿不到波形时必须**静默降级**（回到原来的细轨），不是报错
{
  const b = await boot({ wave: 'empty' });
  await act(async () => {
    b.player.play(0);
    await b.waitFor(() => b.log.some((o) => o.op === 'waveform'));
    await b.sleep(60);
  });
  check('A8: 宿主拿不到波形时不渲染柱子，但进度条照旧工作（静默降级，不报红字）',
    b.bars().length === 0 && b.container.querySelector('.dshm-progressTrack') !== null
      && b.player.getState().error === null,
    'bars=' + b.bars().length + ' error=' + String(b.player.getState().error));
}

// A9：**迟到结果必须丢弃** —— 快速连切时先发的那首会晚回来，画上去就与正在播的歌对不上。
// ⚠️ 必须让**先发的那首慢、后发的快**：两边一样慢时，迟到的先写上、正确的后写上，
// 反而「看起来正确」—— 第一版就是这么写的，做对照时**照样全绿**（没有判别力）。
{
  const b = await boot({ delayFor: (id) => (id === 'a.flac' ? 200 : 10) });
  await act(async () => {
    b.player.play(0);
    await b.sleep(5);
    b.player.play(1);
    await b.sleep(200);
  });
  const heights = Array.from(b.bars()).slice(0, 4).map((n) => n.style.height);
  // b.flac 是全程 0.5 → 50%；a.flac 是「前静音后满幅」→ 首根 6%。拿到 6% 就说明迟到结果被画上了。
  check('A9: 快速连切时丢弃上一首的迟到包络（画上去的必须与正在播的歌一致）',
    heights[0] === '50%' && heights[3] === '50%', heights.join(','));
}

// ─────────────────────── Part B：宿主（真实传输面 + ffmpeg）───────────────────────
// 夹具 wave.flac 是**独立量过**的已知包络：前 4 秒静音、后 4 秒 440Hz 满幅。
// 期望值不是从实现里算出来的：前 1/4 桶必须是 0、后 1/4 桶必须是 1（各自归一化）。
{
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-wf-home-'));
  const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-wf-music-'));
  process.env.DSH_HOME = home;
  await fs.mkdir(path.join(home, 'storages'), { recursive: true });
  await fs.copyFile(path.join(HERE, 'fixtures', 'wave.flac'), path.join(music, 'wave.flac'));
  // 非音频文件：ffmpeg 解不出音频流 —— 端点必须**优雅降级**而不是 500
  await fs.writeFile(path.join(music, 'broken.mp3'), Buffer.from('not audio at all'));

  let handler = null;
  const mod = await import(new URL('../lib/index.js', import.meta.url).href + '?waveform');
  const cleanups = [];
  mod.apply({
    effect: (fn, label) => { const d = fn(); if (typeof d === 'function') cleanups.push({ label, disposer: d }); return d; },
    get: () => undefined,
    webServer: { register: (route) => { handler = route.handler; return () => {}; } },
  });
  const server = createServer((req, res) => handler(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500).end(String(e)); }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';
  await nodeFetch(base + '/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: music }) });
  let lib = null;
  for (let i = 0; i < 600; i += 1) {
    const body = await (await nodeFetch(base + '/api/library')).json().catch(() => null);
    if (body && Array.isArray(body.tracks) && body.tracks.length >= 2 && !body.scanning) { lib = body; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  check('B0: 波形夹具的库扫描完成', lib !== null && lib.tracks.length === 2, lib === null ? 'timeout' : 'tracks=' + lib.tracks.length);
  if (lib === null) { server.close(); process.exit(1); }
  const waveId = lib.tracks.find((t) => t.name === 'wave.flac').id;
  const brokenId = lib.tracks.find((t) => t.name === 'broken.mp3').id;

  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
  if (!hasFfmpeg) {
    console.log('SKIP Part B 的包络断言：本机没有 ffmpeg（**SKIP ≠ 通过**）。端点形状与降级仍已断言。');
  } else {
    const first = await (await nodeFetch(base + '/api/waveform?p=' + encodeURIComponent(waveId))).json();
    const peaks = first.peaks;
    const quarter = Math.max(1, Math.floor(peaks.length / 4));
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    check('B1: 端点下发 0..1 的峰值数组', Array.isArray(peaks) && peaks.length > 8
      && peaks.every((v) => typeof v === 'number' && v >= 0 && v <= 1),
      'peaks=' + peaks.length + (peaks.length > 0 ? ' 首尾=' + peaks[0] + '/' + peaks[peaks.length - 1] : ''));

    const head = avg(peaks.slice(0, quarter));
    const tail = avg(peaks.slice(peaks.length - quarter));
    check('B2: 包络忠实 —— 前半静音 ≈ 0、后半满幅 ≈ 1（夹具是独立量过的已知包络）',
      head < 0.02 && tail > 0.95, 'head=' + head.toFixed(4) + ' tail=' + tail.toFixed(4));
    check('B3: 静音/有声的**分界**落在中点上（不是整体被平滑掉）',
      peaks[quarter - 1] < 0.02 && peaks[peaks.length - quarter] > 0.95,
      '边界两侧=' + peaks[quarter - 1] + '/' + peaks[peaks.length - quarter]);

    const second = await (await nodeFetch(base + '/api/waveform?p=' + encodeURIComponent(waveId))).json();
    check('B4: 第二次请求命中缓存（cached=true），不重跑 ffmpeg',
      second.cached === true && second.peaks.length === peaks.length, 'cached=' + String(second.cached));

    // 文件变了 → 必须重算（否则波形永远停在旧内容上）
    await fs.appendFile(path.join(music, 'wave.flac'), Buffer.alloc(16));
    const third = await (await nodeFetch(base + '/api/waveform?p=' + encodeURIComponent(waveId))).json();
    check('B5: 文件被改动后重新计算（size/mtime 失效，不吃旧缓存）',
      third.cached === false && Array.isArray(third.peaks), 'cached=' + String(third.cached));
  }

  const unknown = await (await nodeFetch(base + '/api/waveform?p=nope')).json();
  check('B6: 未知曲目回空波形 + 稳定原因，**不是 500**（客户端据此静默降级）',
    unknown.peaks.length === 0 && unknown.reason === 'unknown-track', 'reason=' + String(unknown.reason));

  const broken = await (await nodeFetch(base + '/api/waveform?p=' + encodeURIComponent(brokenId))).json();
  check('B7: 非音频文件优雅降级（空峰值 + 分类原因，不是 500）',
    Array.isArray(broken.peaks) && broken.peaks.length === 0 && typeof broken.reason === 'string' && broken.reason.length > 0,
    'reason=' + String(broken.reason));

  // teardown：停止后端点必须不再服务（否则热重载后旧实例还在跑 ffmpeg）
  for (const { disposer } of cleanups.reverse()) { try { await disposer(); } catch { /* 单个失败不阻止其余 */ } }
  let afterStatus = 0;
  try { afterStatus = (await nodeFetch(base + '/api/waveform?p=' + encodeURIComponent(waveId))).status; } catch { afterStatus = -1; }
  check('B8: teardown 后波形端点不再服务（子进程已随实例停止）',
    afterStatus !== 200, 'status=' + afterStatus);
  server.close();
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
