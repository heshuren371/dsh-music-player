// 回归：客户端 activation 归属 + 「有时没声音、刷新才好」。
//
// 症状与成因（用户实测：MV 偶尔没声音，刷新页面就恢复）：
//   ① player 单例挂在 `window.__dshMusicPlayer` 上跨 activation 复用，而 `halt()` 把
//      `disposed` 置成**终态**且不复位：下一代拿到的是同一份已经立闸门的实例，起播后
//      那句 `if (!disposed) rampVolume(…)` 被跳过，增益停在 0 ⇒ 界面在放、耳机没声。
//   ② 常驻 AudioContext 也跟着实例走：设备被 suspend 后没有任何「播放起点」把它 resume
//      回来（`onstatechange` 只在状态**变化**时触发，暂停期间被挂起就永远没人管）。
// 修法：设备（ctx + 增益链 + 探测结果）归**页面**（Symbol.for 挂 window），媒体元素与
// 监听归**本代 activation**；`halt()` 摘掉 window 键、撤掉监听、移除自建 DOM、只 suspend
// 设备；下一代 `takePlayer()` 新建实例并接管同一个设备；每个播放起点都 resume。
//
// 本套件用真 jsdom `<video>` 元素（自建 DOM 释放面必须有真的 DOM 才测得到）+ 假 AudioContext。
import { JSDOM, VirtualConsole } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { promises as fs } from 'node:fs';

const SOURCE = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const TRACKS = ['a.mp3', 'b.mp3'].map((name, index) => ({
  index, id: name, name, title: name, artist: 'x', duration: 200, kind: 'audio', mime: 'audio/mpeg',
}));

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 AudioParam：**直写 `.value` 也要进日志** —— 「起播跳到满幅」正是直写出来的。 */
function makeParam(log, id, initial) {
  let value = initial;
  return {
    get value() { return value; },
    set value(next) { value = next; log.push({ op: 'value', v: next, id }); },
    cancelScheduledValues: (t) => log.push({ op: 'cancel', t, id }),
    setValueAtTime: (v, t) => { value = v; log.push({ op: 'setValue', v, t, id }); },
    linearRampToValueAtTime: (v, t) => { value = v; log.push({ op: 'ramp', v, t, id }); },
  };
}

/** 假 AudioContext：记录建图、调度与 resume/suspend/close。 */
function makeFakeAudioContext(log, ctxs) {
  return class FakeAudioContext {
    constructor() {
      this.state = 'suspended';      // 真实 Chromium 新建的 ctx 就是 suspended，须靠 play 起点唤醒
      this.sampleRate = 48000;
      this.currentTime = 1;
      this.destination = { id: 'destination' };
      this._n = 0;
      this.onstatechange = null;
      ctxs.push(this);
    }
    createGain() {
      const id = 'gain' + (++this._n);
      const node = {
        id,
        gain: makeParam(log, id, 0),
        connect: (to) => log.push({ op: 'connect', from: id, to: to && to.id }),
        disconnect: () => log.push({ op: 'disconnect', id }),
      };
      log.push({ op: 'createGain', id });
      return node;
    }
    createBiquadFilter() {
      const id = 'filter' + (++this._n);
      const node = {
        id, type: 'lowpass',
        frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 },
        connect: (to) => log.push({ op: 'connect', from: id, to: to && to.id }),
        disconnect: () => log.push({ op: 'disconnect', id }),
      };
      log.push({ op: 'createFilter', id });
      return node;
    }
    createMediaElementSource(el) {
      const id = 'source' + (++this._n);
      log.push({ op: 'createSource', el: el?.__tag });
      return { id, connect: (to) => log.push({ op: 'connectSource', id, to: to && to.id }), disconnect: () => log.push({ op: 'disconnect', id }) };
    }
    resume() { log.push({ op: 'resume' }); this.state = 'running'; return Promise.resolve(); }
    suspend() { log.push({ op: 'suspend' }); this.state = 'suspended'; return Promise.resolve(); }
    close() { log.push({ op: 'close' }); this.state = 'closed'; return Promise.resolve(); }
  };
}

/** 真 jsdom `<video>` + 真实媒体语义（play() 必须返回 promise：沉默 bug 就藏在它的回调里）。 */
function installMedia(win, log) {
  const created = [];
  const make = () => {
    const el = win.document.createElement('video');
    el.__tag = 'el' + (created.length + 1);
    el.__paused = true;
    Object.defineProperty(el, 'paused', { get: () => el.__paused, configurable: true });
    for (const [name, value] of [['duration', 200], ['readyState', 4], ['videoWidth', 640], ['error', null]]) {
      Object.defineProperty(el, name, { value, writable: true, configurable: true });
    }
    Object.defineProperty(el, 'seekable', { value: { length: 1, start: () => 0, end: () => 200 }, configurable: true });
    Object.defineProperty(el, 'currentSrc', { get: () => String(el.getAttribute('src') ?? ''), configurable: true });
    el.play = () => { el.__paused = false; log.push({ op: 'play', el: el.__tag }); return Promise.resolve(); };
    el.pause = () => { el.__paused = true; log.push({ op: 'pause', el: el.__tag }); };
    el.load = () => { log.push({ op: 'load', el: el.__tag }); };
    created.push(el);
    return el;
  };
  win.__dshMusicMedia = make;
  win.__dshMusicMedia2 = make;
  return created;
}

async function boot({ search = '' } = {}) {
  const log = [];
  const ctxs = [];
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://127.0.0.1:3080/' + search,
    pretendToBeVisual: true,
    // jsdom 没实现 HTMLMediaElement.load()：不让它把「未实现」当异常刷屏。
    virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.localStorage = win.localStorage;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  win.Element.prototype.scrollIntoView = function () {};
  const media = installMedia(win, log);
  win.AudioContext = makeFakeAudioContext(log, ctxs);

  const okJson = (body) => ({ ok: true, status: 200, json: async () => body, clone() { return okJson(body); } });
  const mockFetch = async (url) => {
    const target = String(url);
    // 同源基址（页面与媒体同端口）：建图不需要先探 CORS，第一条就接进常驻音频图。
    if (target.includes('/session')) return okJson({ systemArtBase: 'http://127.0.0.1:3080/dsh-music/api/system-art?t=x', systemStreamBase: 'http://127.0.0.1:3080/dsh-music/api/system-stream?t=x' });
    if (target.includes('/library') || target.includes('/refresh')) return okJson({ dir: '/music', tracks: TRACKS, scanning: false, scannedAt: 1, truncated: false });
    return okJson({});
  };
  globalThis.fetch = mockFetch;
  win.fetch = mockFetch;

  const disposers = [];
  const effects = [];
  const activate = () => {
    const ctx = {
      effect: (fn, label) => { effects.push(label); const d = fn(); if (typeof d === 'function') disposers.push({ label, d }); return d; },
      locale: { register: () => {}, bind: () => (key) => (({ stats: (n) => String(n), 'scan.progress': (a, b) => a + '/' + b, 'confirm.delete': (n) => n })[key] ?? key) },
      slots: { inject: (_n, fn) => fn(), register: (_m, c) => { ViewComponent = c; return () => {}; } },
    };
    plugin.apply(ctx);
  };
  let factory = null;
  let plugin = null;
  let ViewComponent = null;
  /** 重新求值整个 bundle（插件热重载的等价物：新 module、同一个 window）。 */
  const reloadModule = () => {
    win.__ModuleLoader__ = { load: ({ factory: f }) => { factory = f; } };
    win.eval(SOURCE);
    plugin = factory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
  };
  reloadModule();

  let root = null;
  const mountView = async () => {
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(React.createElement(ViewComponent)); });
    await act(async () => { await sleep(60); });
  };
  const unmountView = async () => { if (root !== null) { const r = root; root = null; await act(async () => { r.unmount(); }); } };
  activate();
  await mountView();
  const player = win.__dshMusicPlayer;
  for (let i = 0; i < 80 && player.getState().tracks.length < 2; i += 1) await act(async () => { await sleep(25); });
  const waitFor = async (pred, timeoutMs = 2500) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (pred()) return true; await act(async () => { await sleep(10); }); }
    return pred();
  };
  const volumeNode = () => log.find((o) => o.op === 'connect' && o.to === 'destination')?.from;
  return {
    win, log, ctxs, media, player, disposers, effects, activate, reloadModule, mountView, unmountView,
    getPlayer: () => win.__dshMusicPlayer, waitFor, volumeNode,
    state: () => (win.__dshMusicPlayer ?? player).getState(),
  };
}

/** 取某次 activation 的 audio teardown disposer（disposers 里还混着 styles 等其它 effect）。 */
const teardownOf = (b, nth = 0) => b.disposers.filter((entry) => String(entry.label).includes('audio teardown'))[nth];

const playTrack = async (b, index) => {
  await act(async () => {
    b.player.play(index);
    await b.waitFor(() => b.player.media().currentSrc !== '', 3000);
    await b.waitFor(() => b.volumeNode() !== undefined && Math.abs((b.log.filter((o) => o.id === b.volumeNode()).slice(-1)[0]?.v ?? -1) - b.state().volume) < 1e-6, 3000);
  });
};

// ── A. 首次 activation：起播就出声 ────────────────────────────────────────────
{
  const b = await boot();
  await act(async () => { b.player.setVolume(0.4); });
  await playTrack(b, 0);
  const volId = b.volumeNode();
  const lastVolume = b.log.filter((o) => o.id === volId && (o.op === 'value' || o.op === 'setValue' || o.op === 'ramp')).slice(-1)[0];
  check('A1: 起播建了一个常驻 AudioContext 并把媒体接进去',
    b.ctxs.length === 1 && b.log.some((o) => o.op === 'createSource'), 'ctx=' + b.ctxs.length);
  check('A2: 淡入落在音量节点的图上，终值等于用户音量',
    lastVolume !== undefined && Math.abs(lastVolume.v - 0.4) < 1e-6,
    'last=' + JSON.stringify(lastVolume) + ' state=' + b.state().volume);
  check('A3: 元素音量置中性（真正的增益在图里）', b.media[0].volume === 1, 'volume=' + b.media[0].volume);
}

// ── B/C. halt 的释放面 + 再 activation 必须还能出声（本轮的主回归）─────────────
{
  const b = await boot();
  await act(async () => { b.player.setVolume(0.4); });
  await playTrack(b, 0);
  const first = b.player;
  const firstEl = b.media[0];
  const firstCtx = b.ctxs[0];
  await act(async () => { teardownOf(b).d(); });           // 插件停用

  check('B1: halt() 摘掉 window 上的 player 引用（已释放的实例不交给下一代）',
    b.getPlayer() === undefined, 'key=' + String(b.getPlayer() && 'player'));
  check('B2: halt() 只 suspend 设备，不 close（设备是页级的，下一代还要接管它）',
    b.log.some((o) => o.op === 'suspend') && !b.log.some((o) => o.op === 'close'));
  // 设备级处理器会留给下一代（它转发给 device.watcher），要断言的是**上一代收不到回调**。
  const resumesBeforeHalt = b.log.filter((o) => o.op === 'resume').length;
  firstCtx.state = 'suspended';
  firstCtx.onstatechange?.();
  check('B3: halt() 之后设备的状态变化不会回调上一代（本代的监听已撤销）',
    b.log.filter((o) => o.op === 'resume').length === resumesBeforeHalt,
    'resume ' + resumesBeforeHalt + ' → ' + b.log.filter((o) => o.op === 'resume').length);
  check('B4: halt() 停掉媒体元素', firstEl.paused === true, 'paused=' + firstEl.paused);
  await b.unmountView();
  check('B5: 停用 + 视图卸载后文档里不留插件的 DOM 与 <video>',
    b.win.document.querySelectorAll('.dshm-mvPark').length === 0 && b.win.document.querySelectorAll('video').length === 0,
    'parks=' + b.win.document.querySelectorAll('.dshm-mvPark').length + ' videos=' + b.win.document.querySelectorAll('video').length);

  // 再 activation（**不**重新求值 bundle）：必须拿到一份全新的、能干活的实例。
  b.activate();
  await b.mountView();
  const second = b.getPlayer();
  check('C1: 第二次 activation 拿到**新**实例（旧实例已释放：状态被复位、window 键已摘）',
    second !== undefined && second !== first && first.getState().current === -1,
    'same=' + String(second === first) + ' oldCurrent=' + first.getState().current);
  check('C2: 第二次 activation 用**新**媒体元素（不接管上一代被释放的那个）',
    b.media.length >= 2 && b.media[1] !== firstEl, 'elements=' + b.media.length);

  // ⛔ 主回归：这里必须**真的有声音**。旧行为是「play 成功但增益停在 0」。
  const resumesBefore = b.log.filter((o) => o.op === 'resume').length;
  await act(async () => { second.play(0); });
  const sounded = await b.waitFor(() => {
    const volId = b.volumeNode();
    const last = b.log.filter((o) => o.id === volId).slice(-1)[0];
    return last !== undefined && Math.abs(last.v - 0.4) < 1e-6;
  }, 3000);
  check('C3: 停用→再 activation 之后起播仍然出声（增益到达用户音量，而不是停在 0）',
    sounded && b.log.filter((o) => o.op === 'resume').length > resumesBefore,
    'volume-node=' + JSON.stringify(b.log.filter((o) => o.id === b.volumeNode()).slice(-2)));
  // ⚠️ 断言必须放在**新一代真的播过之后**：设备是惰性建的，播之前 ctx 计数恒为 1，
  // 那样「设备不跨代」的对照也是绿的（本轮踩到）。
  check('C4: 新一代起播**没有**建第二个 AudioContext（设备跨代存活，输出流只有一条）',
    b.ctxs.length === 1, 'ctxs=' + b.ctxs.length);
}

// ── D. 插件热重载（重新求值 bundle）：新实例 + 同一个设备 + 仍然出声 ─────────────
{
  const b = await boot();
  await act(async () => { b.player.setVolume(0.4); });
  await playTrack(b, 0);
  const first = b.player;
  await act(async () => { teardownOf(b).d(); });
  await b.unmountView();
  b.reloadModule();                 // 新 module：`takePlayer()` 必须新建
  b.activate();
  await b.mountView();
  const second = b.getPlayer();
  check('D1: 热重载后是**新**实例，不是接管上一代的终态实例',
    second !== undefined && second !== first && first.getState().current === -1, 'same=' + String(second === first));
  await act(async () => { second.play(0); });
  const heard = await b.waitFor(() => {
    const volId = b.volumeNode();
    const last = b.log.filter((o) => o.id === volId).slice(-1)[0];
    return last !== undefined && Math.abs(last.v - 0.4) < 1e-6;
  }, 3000);
  check('D2: 热重载后起播仍然出声', heard, 'last=' + JSON.stringify(b.log.filter((o) => o.id === b.volumeNode()).slice(-2)));
  check('D3: 热重载不重建 AudioContext（页面级设备跨代存活，输出流仍只有一条）',
    b.ctxs.length === 1, 'ctxs=' + b.ctxs.length);
}

// ── E. 租约：同一实例上的两代 activation，旧 disposer 不得停掉新一代 ────────────
// 顺序不定是真实存在的：新 bundle 先求值并 apply，旧 activation 的 disposer 后跑。
{
  const b = await boot();
  await playTrack(b, 0);
  const player = b.player;
  const firstDisposer = teardownOf(b);
  b.activate();                                     // 第二代（同一个实例：window 键还在）
  check('E1: 同一个实例上第二次 activation 仍复用（未释放前不新建）',
    b.getPlayer() === player && player.lease() === 2, 'lease=' + player.lease());
  await act(async () => { firstDisposer.d(); });    // 迟到的旧 disposer
  check('E2: 旧一代的 disposer 不得停掉新一代（比较并释放）',
    b.getPlayer() === player && player.lease() === 2, 'key=' + String(b.getPlayer() === player) + ' lease=' + player.lease());
  await act(async () => { player.play(0); });
  const alive = await b.waitFor(() => String(player.media().currentSrc ?? '') !== '', 3000);
  check('E2b: 新一代仍然能起播（旧 disposer 没有把它的闸门关上）', alive,
    'src=' + String(player.media().currentSrc ?? '').slice(0, 44));
  await act(async () => { teardownOf(b, 1).d(); });
  check('E3: 当前代的 disposer 正常释放', b.getPlayer() === undefined,
    'key=' + String(b.getPlayer() !== undefined));
}

// ── F. 从暂停回到播放也必须唤醒被挂起的设备 ───────────────────────────────────
// 系统在**暂停期间**挂起 ctx 时 `onstatechange` 不会再来（状态没变），而 toggle() 这条
// 路径不经过 attachSource —— 旧实现里它一声不响地播，耳机里没有声音。
{
  const b = await boot();
  await act(async () => { b.player.setVolume(0.4); });
  await playTrack(b, 0);
  const ctx = b.ctxs[0];
  await act(async () => {
    b.player.toggle();                              // 暂停
    await b.waitFor(() => b.player.media().paused === true);
    ctx.state = 'suspended';                        // 系统挂起（不是我们调的）
    b.player.toggle();                              // 用户按播放
  });
  const resumed = await b.waitFor(() => ctx.state === 'running', 2000);
  const volId = b.volumeNode();
  const last = b.log.filter((o) => o.id === volId).slice(-1)[0];
  check('F1: 暂停期间被挂起的设备，在 toggle() 播放时被唤醒（界面在放、耳机没声的自愈）',
    resumed && last !== undefined && Math.abs(last.v - 0.4) < 1e-6,
    'state=' + ctx.state + ' last=' + JSON.stringify(last));
}

// ── G. 换歌不得先跳到满幅 ─────────────────────────────────────────────────────
// 旧实现在建图之后仍从**元素音量**（恒为中性 1）取「瞬时音量」，于是每一首的起播都先
// 跳到 100% 再淡到用户值 —— 用户音量 40% 时是一记实打实的爆音。
{
  // ⚠️ 必须关掉交叉淡化：开着的时候换歌走的是「重叠进入」（不经过 startNow），
  // 而这里要测的正是 startNow 里取瞬时音量那一步。
  const b = await boot({ search: '?crossfade=0' });
  await act(async () => { b.player.setVolume(0.4); });
  await playTrack(b, 0);
  const volId = b.volumeNode();
  const mark = b.log.length;
  await playTrack(b, 1);
  const jumped = b.log.slice(mark).filter((o) => o.id === volId && (o.op === 'value' || o.op === 'setValue' || o.op === 'ramp') && o.v > 0.5);
  const last = b.log.filter((o) => o.id === volId).slice(-1)[0];
  check('G1: 换歌全程音量节点都没有跳到用户音量之上（瞬时值从图上读，不从元素音量读）',
    jumped.length === 0, 'jumps=' + JSON.stringify(jumped) + ' last=' + JSON.stringify(last));
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED');
// 视图里的 rAF 循环把事件循环一直占着：显式退出（与其它客户端套件同一做法）。
process.exit(failures === 0 ? 0 : 1);
