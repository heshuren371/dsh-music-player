// A3-01 回归：teardown 之后库轮询定时器**不得自我续期**。
//
// 为什么单独一套：test-teardown.mjs 的假 payload 写死 `scanning: false`，结构上
// 进不了轮询分支。而这条 bug 只在「扫描中 + teardown 撞上轮询在飞」时出现：
//   轮询回调开头已把 pollTimer 置 null → halt() 里的 clearTimeout 落空
//   → 在飞请求失败 → catch 里再武装 → 若 state.scanning 没被复位，
//   守卫 `if (!state.scanning) return` 永不成立 → 永久 1.5s 请求风暴。
// 修法是「清句柄」与「阻止再武装」分开：disposed 状态位 + halt() 显式复位 scanning
// （AGENTS.md §2.10）。
//
// 场景要点（前两版都栽在这里，留痕以免再犯）：
//   ① 挂载必须给**完整** payload（有 dir、有曲目、scanning:false），否则
//      applyLibrary 的 scanning 早退分支不落 dir，会触发 client.js:2408 那个
//      「dir 为空就补载」的 mount effect 循环 —— 那是另一条路径，与轮询无关。
//   ② 在飞请求必须用 **500** 释放，不能用 404：api() 对 404 会做一次旧前缀回落
//      探测（client.js:664-673），会凭空多一次 fetch，把 A1-02 的行为混进来。
//   ③ 只有 /api/library 的轮询计数才有意义，/session 与 /refresh 要排除。
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { promises as fs } from 'node:fs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:3080/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
dom.window.Element.prototype.scrollIntoView = function () {};

const FakeAudio = class extends dom.window.EventTarget {
  constructor() { super(); this.src = ''; this.currentTime = 0; this.duration = NaN; this.volume = 1; this.preload = ''; }
  play() { return Promise.resolve(); }
  pause() {}
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
};
Object.defineProperty(dom.window, 'Audio', { value: FakeAudio, configurable: true, writable: true });
globalThis.Audio = FakeAudio;
window.__dshMusicMedia = () => new FakeAudio();

let pluginFactory = null;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { pluginFactory = factory; } };
dom.window.eval(await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8'));
if (pluginFactory === null) throw new Error('factory not captured');

// ── fetch 桩 ──────────────────────────────────────────────────────────
const TRACK = { index: 0, id: 'a.mp3', name: 'a.mp3', title: 'A', artist: 'x', duration: 300, mime: 'audio/mpeg' };
const settled = { dir: '/music', tracks: [TRACK], scanning: false, scanParsed: 1, scanTotal: 1, truncated: false, scannedAt: 1 };
const scanningNow = { dir: '/music', tracks: [], scanning: true, scanParsed: 1, scanTotal: 10, truncated: false, scannedAt: 1 };

let libraryPolls = 0;      // 只数 /api/library
let holdPoll = false;      // 下一次 /library 是否挂住
let released = null;       // 释放句柄
let heldPromise = null;
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

const mockFetch = async (input) => {
  const url = String(input);
  if (url.includes('/session')) return okJson({ systemArtBase: 'http://127.0.0.1/x', systemStreamBase: 'http://127.0.0.1/y' });
  if (url.includes('/refresh')) return okJson(scanningNow);          // 刷新 → 进入扫描态 → 排期轮询
  if (url.includes('/library')) {
    libraryPolls += 1;
    if (holdPoll) {
      holdPoll = false;
      heldPromise = new Promise((resolve) => { released = resolve; });
      await heldPromise;
      // 用 500：api() 只在 404 时做旧前缀回落探测，500 不会多打一次请求
      return { ok: false, status: 500, json: async () => ({ error: 'host route gone' }) };
    }
    return okJson(settled);
  }
  return okJson({});
};
globalThis.fetch = mockFetch;
dom.window.fetch = mockFetch;

const plugin = pluginFactory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
let ViewComponent = null;
const teardown = [];
const ctx = {
  effect: (fn, label) => { const d = fn(); if (typeof d === 'function') teardown.push({ label, d }); return d; },
  locale: {
    register: () => {},
    // 参数化文案（stats / scan.progress）必须返回**函数**，否则界面渲染直接抛错。
    bind: () => (key) => {
      const dict = { stats: (n) => n + ' songs', 'scan.progress': (a, b) => a + '/' + b };
      return dict[key] ?? key;
    },
  },
  slots: { inject: (_name, fn) => fn(), register: (_meta, component) => { ViewComponent = component; return () => {}; } },
};
plugin.apply(ctx);
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };
const settle = async (ms) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

await act(async () => { root.render(React.createElement(ViewComponent)); });
await settle(250);
check('mount loaded a settled library', libraryPolls === 1, 'libraryPolls=' + libraryPolls);
const rows = container.querySelectorAll('.dshm-row');
check('settled payload rendered rows', rows.length === 1, 'rows=' + rows.length);

// 通过刷新按钮进入扫描态（apples: only applyLibrary(scanning:true) arms the poll）
const refreshBtn = container.querySelector('button[aria-label="action.refresh"]');
check('refresh button present and enabled', refreshBtn !== null && refreshBtn.disabled !== true, refreshBtn === null ? 'missing' : 'disabled=' + refreshBtn.disabled);
if (refreshBtn === null) { console.log('1 FAILURE(S)'); process.exit(1); }
await act(async () => { refreshBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(120);
check('refresh put the library into the scanning state', libraryPolls === 1, 'libraryPolls=' + libraryPolls + ' (poll armed, not fired yet)');

// 等轮询到点并挂住它
holdPoll = true;
await settle(1700);
check('the polling request is in flight', released !== null, 'released=' + (released !== null));

// teardown 撞上轮询在飞
const haltEntry = teardown.find((e) => String(e.label).includes('audio teardown'));
check('audio teardown effect captured', haltEntry !== undefined, 'effects=' + teardown.map((e) => e.label).join(','));
if (haltEntry === undefined) { console.log('1 FAILURE(S)'); process.exit(1); }
haltEntry.d();

// 释放在飞请求（走失败分支 —— 修复前正是在这里再武装）
if (released !== null) released();
const atTeardown = libraryPolls;
await settle(3400);

check('no further library polls after teardown (the timer must not re-arm)',
  libraryPolls === atTeardown, 'before=' + atTeardown + ' after=' + libraryPolls);

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
