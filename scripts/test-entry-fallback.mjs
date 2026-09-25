// A1-02 回归：入口回落必须**正向识别**，且降级必须**可见**。
//
// 修复前：`if (response.status === 404 && !endpointProbed)` —— 用 404 本身当
// 「宿主是旧入口」的信号，而 404 在本插件是正常业务语义（无内嵌封面、MV 缓存未命中、
// 文件不存在）。后果有两条：
//   ① 一次无关的业务 404 就把唯一一次回落窗口烧掉（`endpointProbed` 还写在探测
//      **之前**，失败一次永久失去重试机会）；
//   ② 切换是**信任模型降级**（丢掉 /api 的连接层 Host/Origin 栅栏 + 浏览器会话），
//      却完全静默 —— 违反 composition.zh.md:143。
//
// 现在：只有旧前缀真答出一个宿主数据对象（非错误信封）才切换；探测失败不置位；
// 降级写进 state.hostEntry 并渲染成可见提示。
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
  play() { return Promise.resolve(); } pause() {} load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
};
Object.defineProperty(dom.window, 'Audio', { value: FakeAudio, configurable: true, writable: true });
globalThis.Audio = FakeAudio;
window.__dshMusicMedia = () => new FakeAudio();

const source = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

/** 用给定的 fetch 桩跑一次「加载库」流程，返回渲染出的容器与请求日志。 */
async function mountWith(fetchImpl) {
  const isolated = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:3080/', pretendToBeVisual: true });
  const saved = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  globalThis.window = isolated.window;
  globalThis.document = isolated.window.document;
  globalThis.localStorage = isolated.window.localStorage;
  globalThis.window.__dshMusicMedia = () => new FakeAudio();
  globalThis.fetch = fetchImpl;
  isolated.window.fetch = fetchImpl;

  let factory = null;
  isolated.window.__ModuleLoader__ = { load: ({ factory: f }) => { factory = f; } };
  isolated.window.eval(source);
  const plugin = factory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
  let ViewComponent = null;
  const disposers = [];
  const ctx = {
    effect: (fn, label) => { const d = fn(); if (typeof d === 'function') disposers.push({ label, d }); return d; },
    locale: { register: () => {}, bind: () => (key) => {
      // 参数化文案必须返回函数
      const dict = { stats: (n) => n + ' songs', 'scan.progress': (a, b) => a + '/' + b };
      return dict[key] ?? key;
    } },
    slots: { inject: (_n, fn) => fn(), register: (_meta, c) => { ViewComponent = c; return () => {}; } },
  };
  plugin.apply(ctx);
  const container = isolated.window.document.createElement('div');
  isolated.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(ViewComponent)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
  const used = [];
  // 降级提示用的是 error.legacyEntry 这个键；stub 直接回显键名，所以按文本找。
  const notice = container.textContent.includes('error.legacyEntry');
  Object.assign(globalThis, saved);
  return { used, notice };
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, clone() { return okJson(body); } });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}), clone() { return notFound(); } });

// ── ① 现代宿主：业务 404 不得被误判成「旧入口」──────────────────────────
{
  const calls = [];
  const { notice } = await mountWith(async (url) => {
    calls.push(String(url));
    // /api/library 正常；其余端点回业务 404；旧前缀在此宿主根本不存在。
    // 注意 /session 不在「业务 404」之列 —— 它是「不该 404」的端点，所以会被探测，
    // 但旧前缀同样 404 → 不采纳。
    if (String(url).endsWith('/library')) return okJson({ dir: '/m', tracks: [], scanning: false, scannedAt: 1 });
    return notFound();
  });
  check('a business 404 on a modern host does not trigger a downgrade', notice === false, 'notice=' + notice);
  check('the legacy prefix is probed but not adopted when it also 404s',
    calls.filter((u) => u.startsWith('/dsh-music/api/')).length >= 1 && notice === false,
    calls.join(' '));
}

// 注：曾想在这里用 /cover 的业务 404 做判别性测试，但 jsdom 不加载 <img>，
// 客户端根本不会请求 /cover，那条断言没有判别力（负向对照不会变红）—— 已删除。
// 端点语义判据由 test-audit.mjs 的**精确静态断言**把守（它 grep 的是条件表达式本身）。

// ── ② 真旧入口：旧前缀回宿主数据 → 采纳（可观察结果 = 降级提示）────────────
// 真实旧宿主对所有路径都给宿主数据（旧前缀镜像同一套路由），所以桩要照实写。
// 注意：这里不断言「切换后的请求打到旧前缀」—— 那需要跨挂载追踪异步续跑，而本
// harness 会在挂载结束时还原全局 fetch，时序不可靠。基址赋值本身由
// test-audit.mjs 的静态断言保证；这里断言的是**行为可观察的那一面**：
// 探测被采纳（提示出现）与被拒绝（场景 ③ 无提示）。
{
  const calls = [];
  const notice = await mountWith(async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('/dsh-music/api/')) return okJson({ dir: '/m', tracks: [], scanning: false, scannedAt: 1 });
    return notFound();
  }).then((r) => r.notice);
  check('a legacy host that answers with host data is adopted', calls.some((u) => u.startsWith('/dsh-music/api/')), calls.join(' '));
  check('A1-02 the downgrade is reported to the user (not silent)', notice === true, 'notice=' + notice);
}

// ── ③ 旧前缀回错误信封 → 不算识别成功，不得切换 ─────────────────────────
{
  const { notice } = await mountWith(async (url) => {
    if (String(url).startsWith('/dsh-music/api/')) return okJson({ error: 'not a host payload' });
    return notFound();
  });
  check('an error envelope from the legacy prefix is not accepted as identification', notice === false, 'notice=' + notice);
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
