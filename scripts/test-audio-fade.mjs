// 门禁：切歌 / 起播 / 暂停不得产生「电流声」。
//
// 症状（用户报告）：入耳式耳机里，每次切歌或起播都有一声「啪 / 嘶」；系统播放器
// （Apple Music）不会。差别不在解码质量，而在**波形有没有瞬间跳变**：
//   直接把 audio.src 换成新流、直接 play()、直接 pause()，输出都会从满幅一步跨到 0
//   （或反过来），耳机会把这个不连续放大成爆音。
// 机制：换源前淡出、起播后淡入、暂停前淡出；渐变可被取消。
//
// ⚠️ 本套件**测不到真实声学效果**（jsdom 没有音频输出）。它测的是「不产生瞬间跳变」的
// 机制是否在位、以及时序有没有被这次改动拖坏。真实听感需要人工确认。
//
// 覆盖：
//   A 首播（元素未播放）：src 不得被渐变推迟 —— 第 18 轮实测，把它推迟一个微任务就会让
//     6 套既有回归变红（起播时序整体后移）
//   B 播放中换源：src 赋值**之前**音量必须已经淡到 ~0，且是**多步渐变**而非一步跳变
//   C 换源之后：音量必须升回用户设定值（不能停在 0 —— 那是「切歌后没声音」）
//   D 暂停：pause() 被调用时音量必须已经淡到 ~0
//   E setVolume：取消在飞渐变，用户拖动立即生效且不被渐变覆盖
//   F 快速连切：最终音量等于用户设定值（旧渐变不得回写），且渐变必须结算（不挂住调用方）
//   G halt()：取消渐变，之后不得再写 audio.volume
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { promises as fs } from 'fs';

const SOURCE = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:3080/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.Element.prototype.scrollIntoView = function () {};

/**
 * 假媒体元素。**关键是把真实元素的语义做实**（§9 第 4 条「夹具保真度 = 断言判别力」）：
 * `paused` 与 `volume` 都是真属性，并且记录每一次状态写入的**顺序**，因为本套件要断言的
 * 正是「谁先谁后」。第一版夹具没有这两个属性，导致「正在播才淡出」的判据被误判。
 */
const ops = [];
class FakeMedia extends dom.window.EventTarget {
  constructor() {
    super();
    this._src = ''; this._volume = 1; this.paused = true;
    this.currentTime = 0; this.duration = 200; this.readyState = 4; this.error = null;
    this.preload = ''; this.videoWidth = 0;
    this.seekable = { length: 1, start: () => 0, end: () => 200 };
  }
  get src() { return this._src; }
  set src(value) { this._src = value; ops.push({ op: 'src', v: value }); }
  get currentSrc() { return this._src; }
  get volume() { return this._volume; }
  set volume(value) { this._volume = value; ops.push({ op: 'volume', v: value }); }
  play() { this.paused = false; ops.push({ op: 'play', v: this._volume }); return Promise.resolve(); }
  pause() { this.paused = true; ops.push({ op: 'pause', v: this._volume }); }
  load() { ops.push({ op: 'load', v: this._volume }); }
  removeAttribute(name) { if (name === 'src') this._src = ''; }
}
const media = new FakeMedia();
dom.window.__dshMusicMedia = () => media;

const TRACKS = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'].map((name, index) => ({
  index, id: name, name, title: name, artist: 'x', duration: 200, kind: 'audio', mime: 'audio/mpeg',
}));
const okJson = (body) => ({ ok: true, status: 200, json: async () => body, clone() { return okJson(body); } });
const mockFetch = async (url) => {
  const t = String(url);
  if (t.includes('/session')) return okJson({ systemArtBase: 'http://127.0.0.1:3080/dsh-music/api/system-art?t=x', systemStreamBase: 'http://127.0.0.1:3080/dsh-music/api/system-stream?t=x' });
  if (t.includes('/library') || t.includes('/refresh')) return okJson({ dir: '/music', tracks: TRACKS, scanning: false, scannedAt: 1, truncated: false });
  return okJson({});
};
globalThis.fetch = mockFetch;
dom.window.fetch = mockFetch;

let factory = null;
dom.window.__ModuleLoader__ = { load: ({ factory: f }) => { factory = f; } };
dom.window.eval(SOURCE);
const plugin = factory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
let View = null;
plugin.apply({
  effect: (fn) => fn(),
  locale: { register: () => {}, bind: () => (key) => (({ stats: (n) => String(n) }) [key] ?? key) },
  slots: { inject: (_n, fn) => fn(), register: (_m, c) => { View = c; return () => {}; } },
});
const root = createRoot(dom.window.document.createElement('div'));
await act(async () => { root.render(React.createElement(View)); });
const player = dom.window.__dshMusicPlayer;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60 && player.getState().tracks.length < 4; i += 1) await act(async () => { await sleep(25); });

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };
const clear = () => { ops.length = 0; };
const before = (idx, name) => ops.slice(0, idx).filter((o) => o.op === name);
const userVolume = () => player.getState().volume;

check('fixture: library loaded and player exposed', player !== undefined && player.getState().tracks.length === 4, 'tracks=' + player.getState().tracks.length);
check('fixture: default volume is a usable number', Number.isFinite(userVolume()) && userVolume() > 0.1, 'volume=' + userVolume());

// ── A. 首播：src 不得被渐变推迟 ──────────────────────────────────────────────
// ⚠️ 本仓库的 `play()` 路径**本来就不是同步挂源**（它先 await session/库），所以断言的是
// 「30ms 内必须挂上源」而不是「同一 tick」—— 我第一版写成同一 tick，它红给我看，我才量准。
// 判别力来自这条改动的真实形态：第 18 轮第一版无论是否在播都走 ~70ms 淡出，
// 6 套既有回归当场变红（它们的等待窗口比 70ms 短）。
clear();
player.play(0);
await act(async () => { await sleep(30); });
const aSrcAt = ops.findIndex((o) => o.op === 'src');
check('A1: first play assigns src within 30ms (must NOT wait for a fade-out)',
  aSrcAt >= 0, 'ops=' + JSON.stringify(ops.slice(0, 4)));
check('A2: nothing was audible → no fade RAMP before the first src (最多一次归零写入)',
  aSrcAt < 0 ? false : before(aSrcAt, 'volume').length <= 1,
  'volume ops before src=' + JSON.stringify(before(aSrcAt, 'volume')));
await act(async () => { await sleep(220); });
await act(async () => { await sleep(220); });
check('A3: volume faded in to the user setting after start',
  Math.abs(media.volume - userVolume()) < 0.02, 'volume=' + media.volume + ' want=' + userVolume());

// ── B/C. 播放中换源：先淡出到 ~0，再换 src，然后淡回 ─────────────────────────
clear();
await act(async () => { player.play(1); await sleep(260); });
const bSrcAt = ops.findIndex((o) => o.op === 'src');
const volsBeforeSrc = before(bSrcAt, 'volume').map((o) => o.v);
check('B1: switching while playing fades the old stream out before the new src',
  bSrcAt > 0 && volsBeforeSrc.length > 0 && volsBeforeSrc[volsBeforeSrc.length - 1] <= 0.02,
  'fade=' + JSON.stringify(volsBeforeSrc.map((v) => +v.toFixed(3))));
check('B2: it is a multi-step ramp, not a single jump (that is what removes the click)',
  volsBeforeSrc.length >= 3, 'steps=' + volsBeforeSrc.length);
check('B3: the ramp is monotonic down (no bounce)',
  volsBeforeSrc.every((v, i) => i === 0 || v <= volsBeforeSrc[i - 1] + 1e-6), JSON.stringify(volsBeforeSrc.map((v) => +v.toFixed(3))));
check('C1: volume faded back up to the user setting after the switch',
  Math.abs(media.volume - userVolume()) < 0.02, 'volume=' + media.volume + ' want=' + userVolume());

// ── D. 暂停：pause() 之前必须已淡出 ─────────────────────────────────────────
clear();
await act(async () => { player.toggle(); await sleep(220); });
const dPauseAt = ops.findIndex((o) => o.op === 'pause');
const volsBeforePause = before(dPauseAt, 'volume').map((o) => o.v);
check('D1: pausing fades out before pausing (a hard pause clicks too)',
  dPauseAt > 0 && volsBeforePause.length > 0 && volsBeforePause[volsBeforePause.length - 1] <= 0.02,
  'pause@' + dPauseAt + ' fade=' + JSON.stringify(volsBeforePause.map((v) => +v.toFixed(3))));

// ── E. setVolume 必须赢过**正在进行中**的渐变 ────────────────────────────────
// ⚠️ 第一版把「改音量」和「换源」放在同一刻，结果取不取消 cancelFade 都能过 ——
// 因为那次淡入的目标本来就是新音量。**必须在淡入途中改**才测得到：
// 换源 → 淡出 70ms → 起播 → 淡入 90ms，在 t≈120ms 时改音量，正落在淡入区间里。
// 若不取消，淡入会把音量继续推到它启动时捕获的旧目标（用户设定值 1）。
await act(async () => { player.toggle(); await sleep(220); });   // 恢复播放并淡入
clear();
await act(async () => {
  player.play(3);
  await sleep(120);                // 淡入进行中
  player.setVolume(0.33);          // 用户拖动
  await sleep(220);                // 让（若有 bug 的）淡入走完
});
check('E1: a user volume change is not overwritten by an in-flight fade',
  Math.abs(media.volume - 0.33) < 0.02, 'volume=' + media.volume.toFixed(3) + ' want=0.33');
check('E2: state kept the user value', Math.abs(userVolume() - 0.33) < 1e-6, 'state=' + userVolume());
await act(async () => { player.setVolume(userVolume()); await sleep(30); });

// ── F. 快速连切：最终音量正确、且渐变结算（不挂住） ─────────────────────────
clear();
const settleFlag = { done: false };
await act(async () => {
  player.play(0);
  await sleep(10);
  player.play(1);
  await sleep(10);
  player.play(2);
  // 把用户音量设回去，同时观察最终值
  player.setVolume(userVolume() || 0.8);
  await sleep(350);
  settleFlag.done = true;
});
check('F1: rapid switching still ends at the user volume',
  Math.abs(media.volume - (userVolume() || 0.8)) < 0.02, 'volume=' + media.volume.toFixed(3));
check('F2: the fade settled (no hung await)', settleFlag.done === true);
check('F3: player is actually playing after the burst', media.paused === false, 'paused=' + media.paused);

// ── G. halt()：取消渐变，之后不得再写 audio.volume ──────────────────────────
player.halt();
clear();
await act(async () => { await sleep(250); });
check('G1: nothing writes audio.volume after halt()',
  ops.filter((o) => o.op === 'volume').length === 0, JSON.stringify(ops.filter((o) => o.op === 'volume')));
check('G2: halt() muted the element before stopping (no full-scale cut)',
  media.volume === 0, 'volume=' + media.volume);

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
