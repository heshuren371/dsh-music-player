// 门禁：ReplayGain 响度归一化（读标准标签 → 独立增益节点 → 防削波）。
//
// 为什么需要它：
//   本地曲库混着不同年代、不同母带的文件，响度差常到 ±10dB，切歌时音量跳。
//   做法与 fooyin 一致（GPL-3.0 项目，**只借鉴做法、不抄代码**）：
//     ① 只读**标准标签**（REPLAYGAIN_TRACK_GAIN / _ALBUM_GAIN / _PEAK），不改文件；
//     ② 未测量过的曲目**不做任何增益** —— 不能当成 0dB 用（那等于没测量也当测过）；
//     ③ Track / Album 两种模式，Album 缺标签回退 Track；
//     ④ 防削波：增益后峰值可能越过满刻度，按 peak **收窄**增益（fooyin 的 PreventClipping）；
//     ⑤ 增益走**独立节点**（source → rgGain → volumeGain → destination），
//        这样淡入淡出（写音量节点）与响度归一化（写 RG 节点）互不覆盖。
//
// ⚠️ 本套件测不到真实听感（jsdom 没有音频设备）。它测标签解析、增益数学、防削波与节点分离。
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

// ⚠️ Part B 的 boot 会把 `globalThis.fetch` 换成 mock（客户端要用假宿主）。这里先**捕获真身**，
// 否则后面的 Part C 会拿假 fetch 去打真宿主 —— 表现是「路由明明存在，却返回空对象 {}」。
const nodeFetch = globalThis.fetch;

let failures = 0;
// 崩溃必须显式变成一条 FAIL：否则进程带着非零码死掉却没有任何输出（CI 上尤其致命）。
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
const near = (a, b, eps = 0.002) => typeof a === 'number' && Math.abs(a - b) <= eps;
const dbToLinear = (db) => Math.pow(10, db / 20);

// ─────────────────────────── Part A：宿主读出标准标签 ───────────────────────────
{
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-rg-home-'));
  const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-rg-music-'));
  process.env.DSH_HOME = home;
  await fs.mkdir(path.join(home, 'storages'), { recursive: true });
  await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');
  const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
  // rg.flac：track -6.50dB / peak 0.988 · album -5.20dB / peak 1.0
  await fs.copyFile(path.join(fixtures, 'rg.flac'), path.join(music, 'measured.flac'));
  // tiny.flac 没有 RG 标签 → 必须是 null（**未测量 ≠ 0dB**）
  await fs.copyFile(path.join(fixtures, 'tiny.flac'), path.join(music, 'unmeasured.flac'));

  let handler = null;
  const { apply } = await import(new URL('../lib/index.js', import.meta.url).href);
  apply({
    effect: (fn) => fn(),
    get: () => undefined,
    webServer: { register: (route) => { handler = route.handler; return () => {}; } },
  });
  const server = createServer((req, res) => { handler(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500).end(String(e)); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';

  let lib = null;
  for (let i = 0; i < 600; i += 1) {
    const r = await fetch(base + '/api/library');
    const body = await r.json().catch(() => null);
    if (body && Array.isArray(body.tracks) && body.tracks.length >= 2 && !body.scanning) { lib = body; break; }
    await new Promise((r2) => setTimeout(r2, 50));
  }
  check('A0: 库扫描在 30s 内完成（否则后面的断言无从谈起）', lib !== null && lib.tracks.length === 2,
    lib === null ? 'scan timeout' : 'tracks=' + lib.tracks.length);
  if (lib === null) { server.close(); process.exit(1); }

  const measured = lib.tracks.find((t) => t.name === 'measured.flac');
  const unmeasured = lib.tracks.find((t) => t.name === 'unmeasured.flac');
  check('A1: 带 RG 标签的文件，单曲增益被下发（dB）', measured !== undefined && near(measured.rgTrackGainDb, -6.5),
    'rgTrackGainDb=' + String(measured?.rgTrackGainDb));
  check('A2: 专辑增益同样下发', measured !== undefined && near(measured.rgAlbumGainDb, -5.2),
    'rgAlbumGainDb=' + String(measured?.rgAlbumGainDb));
  check('A3: 峰值也下发（防削波要用它）',
    measured !== undefined && near(measured.rgTrackPeak, 0.988, 0.002) && near(measured.rgAlbumPeak, 1, 0.002),
    'track=' + String(measured?.rgTrackPeak) + ' album=' + String(measured?.rgAlbumPeak));
  check('A4: **未测量**的曲目四项全 null（不是 0dB —— 0dB 意味着「已测量且无需调整」）',
    unmeasured !== undefined && unmeasured.rgTrackGainDb === null && unmeasured.rgAlbumGainDb === null
      && unmeasured.rgTrackPeak === null && unmeasured.rgAlbumPeak === null,
    JSON.stringify({ g: unmeasured?.rgTrackGainDb, ag: unmeasured?.rgAlbumGainDb, p: unmeasured?.rgTrackPeak }));
  check('A5: 四项只可能是有限数或 null（标签是不可信输入，不允许 NaN/Infinity 进 payload）',
    lib.tracks.every((t) => [t.rgTrackGainDb, t.rgAlbumGainDb, t.rgTrackPeak, t.rgAlbumPeak]
      .every((v) => v === null || (typeof v === 'number' && Number.isFinite(v)))),
    JSON.stringify(lib.tracks.map((t) => t.rgTrackGainDb)));
  server.close();
}

// ─────────────────────────── Part B：客户端增益数学与节点分离 ───────────────────────────
const SOURCE = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const ORIGIN = 'http://127.0.0.1:3080';
// 第 0 首带完整 RG 标签；第 1 首**未测量**（用于断言「不做增益」）。
const TRACKS = [
  {
    index: 0, id: 'measured.flac', name: 'measured.flac', title: 'measured', artist: 'x', duration: 200, kind: 'audio',
    rgTrackGainDb: -6.5, rgTrackPeak: 0.988, rgAlbumGainDb: -5.2, rgAlbumPeak: 1,
  },
  {
    index: 1, id: 'unmeasured.flac', name: 'unmeasured.flac', title: 'unmeasured', artist: 'x', duration: 200, kind: 'audio',
    rgTrackGainDb: null, rgTrackPeak: null, rgAlbumGainDb: null, rgAlbumPeak: null,
  },
  // 第 2 首：**没有标签，只有插件测量出来的值**（与 Part C 实测的 tone.flac 一致）
  {
    index: 2, id: 'tone.flac', name: 'tone.flac', title: 'tone', artist: 'x', duration: 200, kind: 'audio',
    rgTrackGainDb: null, rgTrackPeak: null, rgAlbumGainDb: null, rgAlbumPeak: null,
    rgMeasuredGainDb: 15.1, rgMeasuredPeak: 0.03126,
  },
  // 第 3 首：**标签与测量都有** —— 必须用标签（标签是权威，测量只是兜底）
  {
    index: 3, id: 'both.flac', name: 'both.flac', title: 'both', artist: 'x', duration: 200, kind: 'audio',
    rgTrackGainDb: -6.5, rgTrackPeak: 0.988, rgAlbumGainDb: null, rgAlbumPeak: null,
    rgMeasuredGainDb: 15.1, rgMeasuredPeak: 0.03126,
  },
];

/** 假 AudioContext：**每次 createGain 返回不同节点**（音量节点 / RG 节点必须能分辨）。 */
function makeFakeAudioContext(log, store) {
  return class FakeAudioContext {
    constructor() {
      log.push({ op: 'ctx' });
      this.state = 'running';
      this.sampleRate = 48000;
      this.currentTime = 1;
      this.destination = { id: 'destination' };
      this._n = 0;
    }
    createGain() {
      const id = 'gain' + (++this._n);
      const node = {
        id,
        gain: {
          value: 1,
          cancelScheduledValues: () => {},
          setValueAtTime: (v) => { node.gain.value = v; },
          linearRampToValueAtTime: (v) => { node.gain.value = v; },
        },
        connect: (to) => log.push({ op: 'connect', from: id, to: to && to.id }),
      };
      store.push(node);
      log.push({ op: 'createGain', id });
      return node;
    }
    createMediaElementSource() {
      log.push({ op: 'createSource' });
      return { connect: (to) => log.push({ op: 'sourceTo', to: to && to.id }) };
    }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
  };
}

async function boot({ fakeCtx = false } = {}) {
  const log = [];
  const store = [];
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
  if (fakeCtx) win.AudioContext = makeFakeAudioContext(log, store);

  // 夹具是**活对象**（§9 陷阱 4：夹具保真度 = 断言判别力）。
  const el = {
    _src: '', _volume: 1, _t: 0, paused: true, duration: 200, readyState: 4, error: null, preload: '',
    get src() { return this._src; },
    set src(v) { this._src = v; log.push({ op: 'src' }); },
    get currentSrc() { return this._src; },
    get currentTime() { return this._t; },
    set currentTime(v) { this._t = v; },
    get volume() { return this._volume; },
    set volume(v) { this._volume = v; log.push({ op: 'volume', v }); },
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
    // ⚠️ 参数化键返回的是**函数**（`t("stats")(n)`）；桩里不给函数会让视图渲染直接崩。
    locale: { register: () => {}, bind: () => (key) => (({ stats: (n) => String(n) })[key] ?? key) },
    slots: { inject: (_n, fn) => fn(), register: (_m, c) => { View = c; return () => {}; } },
  });
  const root = createRoot(win.document.createElement('div'));
  await act(async () => { root.render(React.createElement(View)); });
  const player = win.__dshMusicPlayer;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && player.getState().tracks.length < 2; i += 1) await act(async () => { await sleep(25); });
  const waitFor = async (pred, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (pred()) return true; await sleep(10); }
    return pred();
  };
  return { log, store, player, media: el, win, sleep, waitFor, state: () => player.getState() };
}

// B1：节点串联顺序（RG 必须在音量**之前**，否则归一化后的信号又被衰减/放大一次）
{
  const b = await boot({ fakeCtx: true });
  await act(async () => { b.player.play(0); await b.waitFor(() => b.log.some((o) => o.op === 'src')); });
  const volRaw = b.store[0];
  const rgRaw = b.store[1];
  // 缺节点时用「永远 NaN」的替身：让后面每条断言各自报 FAIL，**不要整块崩掉**
  // （崩掉会掩盖其余断言，等于把一次诊断机会丢掉）。负向对照实测踩到过。
  const vol = volRaw ?? { id: '(missing)', gain: { value: NaN } };
  const rg = rgRaw ?? { id: '(missing)', gain: { value: NaN } };
  const link = b.log.find((o) => o.op === 'connect' && o.from === rg?.id);
  const srcTo = b.log.find((o) => o.op === 'sourceTo');
  check('B1: 串联顺序正确 —— 源 → RG → 音量 → 目标', volRaw !== undefined && rgRaw !== undefined
    && link !== undefined && link.to === vol.id && srcTo !== undefined && srcTo.to === rg.id,
    JSON.stringify({ vol: vol?.id, rg: rg?.id, link, srcTo }));

  check('B2: 默认 **off** —— 不偷偷改用户听到的响度', rg.gain.value === 1, 'rgGain=' + rg.gain.value);

  await act(async () => { b.player.setReplayGain('track'); });
  check('B3: track 模式按标签增益（-6.5dB → ×0.4732）', near(rg.gain.value, dbToLinear(-6.5)),
    'rgGain=' + rg.gain.value + ' want=' + dbToLinear(-6.5));

  await act(async () => { b.player.setReplayGain('track', 6); });
  check('B4: 前级增益叠加（+6dB → ×' + dbToLinear(-0.5).toFixed(4) + '）', near(rg.gain.value, dbToLinear(-6.5 + 6)),
    'rgGain=' + rg.gain.value);

  // 显式把前级归零：上一条断言留了 +6dB，专辑峰值 1.0 还会触发防削波，混在一起算不清。
  await act(async () => { b.player.setReplayGain('album', 0); });
  check('B5: album 模式改用专辑增益（-5.2dB → ×0.5495）', near(rg.gain.value, dbToLinear(-5.2)),
    'rgGain=' + rg.gain.value + ' want=' + dbToLinear(-5.2).toFixed(4));

  // 防削波：-6.5dB + 15dB 前级 = +8.5dB → ×2.66；峰值 0.988 → 收窄到 1/0.988
  await act(async () => { b.player.setReplayGain('track', 15); });
  const clamped = Math.min(dbToLinear(-6.5 + 15), 1 / 0.988);
  check('B6: 防削波 —— 增益被峰值收窄，绝不推过满刻度', near(rg.gain.value, clamped, 0.005),
    'rgGain=' + rg.gain.value + ' want=' + clamped.toFixed(4));

  // B8：两个增益**互不覆盖**（这是独立节点的全部意义）
  const rgBefore = rg.gain.value;
  const volBefore = vol.gain.value;
  await act(async () => { b.player.setVolume(0.4); });
  const volumeDidNotTouchRg = near(rg.gain.value, rgBefore);
  await act(async () => { b.player.setReplayGain('album'); });
  check('B8: 改用户音量不动 RG、改 RG 不动用户音量（否则会互相覆盖）',
    volumeDidNotTouchRg && near(vol.gain.value, 0.4) && volBefore !== 0.4,
    JSON.stringify({ rgBefore, after: rg.gain.value, vol: vol.gain.value }));

  // B7：未测量的曲目在 track 模式下必须**不做增益**
  await act(async () => {
    b.player.setReplayGain('track');
    b.player.play(1);
    // ⚠️ `state.current` 在 playIndex 里**同步**就变了，等它等于没等：
    // 必须等 attachSource 真的跑完（第二首挂上源），此时 RG 才被应用。
    await b.waitFor(() => b.log.filter((o) => o.op === 'src').length >= 2);
  });
  check('B7: **未测量**的曲目不做增益（rgGain=1，而不是当 0dB）', near(rg.gain.value, 1),
    'rgGain=' + rg.gain.value + ' rgTrackDb=' + String(b.state().rgTrackDb));

  check('B10: 状态与持久化都记下来（刷新后保留用户选择）',
    b.state().rgMode === 'track' && (() => {
      try { return JSON.parse(b.win.localStorage.getItem('dsh-music:prefs') ?? '{}').rgMode === 'track'; } catch { return false; }
    })(), 'rgMode=' + b.state().rgMode);
}

// B11/B12：标签之外的第二条路（测量），以及两者同时存在时的优先级
{
  const b = await boot({ fakeCtx: true });
  await act(async () => {
    b.player.setReplayGain('track');
    b.player.play(2);                       // 只有测量值的那首
    await b.waitFor(() => b.log.filter((o) => o.op === 'src').length >= 1);
  });
  const rg = b.store[1];
  check('B11: 没有标签时用**测量值**（+15.1dB → ×5.69；不带这个兜底，实测库里 0/40 有标签=空操作）',
    near(rg.gain.value, dbToLinear(15.1), 0.02), 'rgGain=' + rg.gain.value + ' want=' + dbToLinear(15.1).toFixed(4));

  await act(async () => {
    b.player.play(3);                       // 标签与测量都有
    await b.waitFor(() => b.log.filter((o) => o.op === 'src').length >= 2);
  });
  check('B12: 标签与测量同时存在时**标签优先**（-6.5dB，不是测量的 +15.1dB）',
    near(rg.gain.value, dbToLinear(-6.5)), 'rgGain=' + rg.gain.value + ' want=' + dbToLinear(-6.5).toFixed(4));
}

// B9：回退路径（没有 AudioContext）—— RG 必须折进元素音量，否则静默失效
{
  const b = await boot({ fakeCtx: false });
  await act(async () => {
    b.player.setVolume(1);
    b.player.setReplayGain('track');
    b.player.play(0);
    await b.waitFor(() => b.media.src !== '');
    await b.waitFor(() => near(b.media.volume, dbToLinear(-6.5), 0.02));   // 等淡入走完
  });
  check('B9: 图不可用时把 RG 折进元素音量（1 × 0.4732），而不是丢掉',
    near(b.media.volume, dbToLinear(-6.5), 0.02),
    'elementVolume=' + b.media.volume + ' want=' + dbToLinear(-6.5).toFixed(4));
}

// ─────────────────────── Part C：测量（标签之外的第二条路）───────────────────────
// 实测用户曲库 0/40 首带 REPLAYGAIN 标签 ⇒ 只读标签等于空操作。测量是让它真正生效的那一半。
// 夹具 tone.flac 的响度是**独立量过并写死**的：I = -33.1 LUFS → 增益 = -18 - (-33.1) = +15.10 dB。
const EXPECTED_TONE_GAIN_DB = 15.1;
{
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-rgm-home-'));
  const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-rgm-music-'));
  process.env.DSH_HOME = home;
  await fs.mkdir(path.join(home, 'storages'), { recursive: true });
  await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');
  const fixturesC = fileURLToPath(new URL('./fixtures/', import.meta.url));
  // ⚠️ **不能靠改 `process.env.DSH_HOME` 切目录**：`lib/host.js` 在模块加载时就把它固化成了
  // `const DSH_HOME = process.env.DSH_HOME`，本进程早已加载过 ⇒ 改了也没用，宿主仍读旧的
  // 状态文件（实测症状：Part C 测的是 Part A 目录里的两个静音文件，lufs=-70）。
  // 正确做法是走**真实传输面** `POST /dir`（它同时会重扫）。
  await fs.copyFile(path.join(fixturesC, 'tone.flac'), path.join(music, 'tone.flac'));
  await fs.copyFile(path.join(fixturesC, 'tiny.flac'), path.join(music, 'silent.flac'));

  let handlerC = null;
  const mod = await import(new URL('../lib/index.js', import.meta.url).href + '?rg-measure');
  // `effect` 返回的是清理函数（宿主 dispose 挂在它上面）。照 test-teardown.mjs 的做法**收集**它们，
  // 否则 `apply()` 的返回值不是 dispose（第一版就是这么写错的：`mod.dispose is not a function`）。
  const cleanups = [];
  mod.apply({
    effect: (fn, label) => {
      const disposer = fn();
      if (typeof disposer === 'function') cleanups.push({ label, disposer });
      return disposer;
    },
    get: () => undefined,
    webServer: { register: (route) => { handlerC = route.handler; return () => {}; } },
  });
  const serverC = createServer((req, res) => { handlerC(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500).end(String(e)); }); });
  await new Promise((r) => serverC.listen(0, '127.0.0.1', r));
  const baseC = 'http://127.0.0.1:' + serverC.address().port + '/dsh-music';

  // 显式把宿主切到本段的目录（见上面的注释）。
  await nodeFetch(baseC + '/api/dir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: music }),
  });

  let libC = null;
  for (let i = 0; i < 600; i += 1) {
    const body = await (await nodeFetch(baseC + '/api/library')).json().catch(() => null);
    if (body && Array.isArray(body.tracks) && body.tracks.length >= 2 && !body.scanning) { libC = body; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  check('C0: 测量夹具的库扫描完成', libC !== null && libC.tracks.length === 2, libC === null ? 'timeout' : 'tracks=' + libC.tracks.length);
  if (libC === null) { serverC.close(); process.exit(1); }

  // GET 只读状态，**不得**顺手启动一轮测量
  const idleRes = await nodeFetch(baseC + '/api/measure');
  const idleText = await idleRes.text();
  const idle = JSON.parse(idleText || '{}');
  check('C1: GET /measure 只报状态，不启动测量', idleRes.status === 200 && idle.running === false && idle.done === 0,
    idleRes.status + ' ' + idleText.slice(0, 120));

  // ffmpeg 是测量的前提；它不在就明确 SKIP（**不等于通过**）
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  const hasFfmpeg = probe.status === 0;
  if (!hasFfmpeg) {
    console.log('SKIP Part C 的测量断言：本机没有 ffmpeg（**SKIP ≠ 通过**）。端点形状与 teardown 仍已断言。');
  }

  const started = await (await nodeFetch(baseC + '/api/measure', { method: 'POST' })).json();
  // POST **立即**返回，此时异步任务还没扫描出 total —— 断言只要求「已经在跑」，
  // 真实计数由 C3 断言（写死 total===2 是我第一版写错的断言，不是实现的问题）。
  check('C2: POST /measure 立即返回进行中的状态（不阻塞请求）', started.running === true,
    JSON.stringify(started));
  let status = started;
  for (let i = 0; i < 600 && status.running; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    status = await (await nodeFetch(baseC + '/api/measure')).json();
  }
  check('C3: 测量跑完并汇报计数', status.running === false && status.done === 2, JSON.stringify(status));

  libC = await (await nodeFetch(baseC + '/api/library')).json();
  const tone = libC.tracks.find((t) => t.name === 'tone.flac');
  const silent = libC.tracks.find((t) => t.name === 'silent.flac');
  if (hasFfmpeg) {
    check('C4: 测量值随 payload 下发，且等于独立量出的响度换算值（+15.10 dB）',
      tone !== undefined && typeof tone.rgMeasuredGainDb === 'number'
        && Math.abs(tone.rgMeasuredGainDb - EXPECTED_TONE_GAIN_DB) <= 0.5,
      'rgMeasuredGainDb=' + String(tone?.rgMeasuredGainDb));
    check('C5: 测量出的峰值也下发（防削波要用它）',
      tone !== undefined && typeof tone.rgMeasuredPeak === 'number' && tone.rgMeasuredPeak > 0,
      'rgMeasuredPeak=' + String(tone?.rgMeasuredPeak));
    check('C6: 全静音文件不产出测量值（峰值 -inf → 不猜，保持 null）',
      silent !== undefined && silent.rgMeasuredGainDb === null,
      'silent.rgMeasuredGainDb=' + String(silent?.rgMeasuredGainDb));
  }

  // 幂等：已测且文件未变 → 直接跳过（重复点按几乎零成本）
  const again = await (await nodeFetch(baseC + '/api/measure', { method: 'POST' })).json();
  let status2 = again;
  for (let i = 0; i < 600 && status2.running; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    status2 = await (await nodeFetch(baseC + '/api/measure')).json();
  }
  if (hasFfmpeg) {
    check('C7: 重复测量走缓存（skipped ≥ 1），且测量值不变',
      status2.skipped >= 1 && Math.abs((await (await nodeFetch(baseC + '/api/library')).json())
        .tracks.find((t) => t.name === 'tone.flac').rgMeasuredGainDb - EXPECTED_TONE_GAIN_DB) <= 0.5,
      JSON.stringify(status2));
  }

  // teardown：测量任务必须随实例停止（否则热重载后 ffmpeg 继续跑 = 孤儿进程，I-06）
  for (const entry of cleanups) entry.disposer();
  const afterDispose = await (await nodeFetch(baseC + '/api/measure')).json().catch(() => null);
  // teardown 之后宿主实例已被摘除（路由返回 error）—— 判据是「**不再在跑**」，
  // 而不是「必须能读到 running:false」（那时端点可能已不可用）。
  // ⚠️ 如实标注：这条**只证明**「teardown 后宿主实例被摘除、端点不再服务」，
  // **不能**证明子进程被杀（负向对照实测：删掉 dispose 里的 stopRgMeasure，它照样通过）。
  // 子进程 kill 的**接线**由 test-audit 的静态检查覆盖，两者合起来才是完整覆盖。
  check('C8: dispose() 后测量端点不再服务（teardown 摘除实例；子进程 kill 由 test-audit 静态覆盖）',
    afterDispose === null || afterDispose.running !== true, JSON.stringify(afterDispose));
  serverC.close();

  // 新实例必须是干净的：热重载会不断 createHost()，任务状态若跨实例残留，
  // 界面会永远显示「正在测量」。
  let handlerC2 = null;
  const mod2 = await import(new URL('../lib/index.js', import.meta.url).href + '?rg-measure-2');
  mod2.apply({
    effect: (fn) => fn(),
    get: () => undefined,
    webServer: { register: (route) => { handlerC2 = route.handler; return () => {}; } },
  });
  const serverC2 = createServer((req, res) => { handlerC2(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500).end(String(e)); }); });
  await new Promise((r) => serverC2.listen(0, '127.0.0.1', r));
  const fresh = await (await nodeFetch('http://127.0.0.1:' + serverC2.address().port + '/dsh-music/api/measure')).json();
  check('C9: 新宿主实例的任务状态是干净的（不会有残留的「正在测量」）',
    fresh.running === false && fresh.done === 0, JSON.stringify(fresh));
  serverC2.close();
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
