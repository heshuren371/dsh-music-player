// 回归：切到「对话」再切回「音乐」，全屏播放器必须还在（而不是回到列表页）。
//
// 用户报的症状：全屏播放器开着时切走再切回来，回来看到的是音乐列表页。
// 成因：DSH 的 conversation.view 只在被选中时挂载 —— 切到对话会让本插件的视图
// **卸载**，切回来**重新挂载**。修复前 playerPhase / mvBig / zoomOpen 是视图局部
// useState，随卸载一起丢；MV 的媒体元素被搬回 body 停靠位，回来也不会自动回到舞台。
// 修复后三个 UI 状态放进 player 单例 store（跨视图挂载保留），退出动画的定时器
// 也归 player —— 视图卸载不会把它清掉、留下永远收不拢的 closing。
//
// 夹具保真度（AGENTS §9 第 4 条）：媒体元素用**真实 <video> DOM 节点**，只补
// jsdom 没实现的 play/pause/load。这样「元素被搬进 / 搬出文档」才是可观察的真实
// 行为（假元素没有 nodeType，搬运路径会整体跳过 —— 那样断言会恒绿）。
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
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

/** 真实 <video> 节点 + 补上 jsdom 未实现的媒体方法（其余属性 jsdom 已按规范给）。 */
const makeMedia = () => {
  const el = document.createElement('video');
  el.play = () => { el.dispatchEvent(new dom.window.Event('play')); return Promise.resolve(); };
  el.pause = () => { el.dispatchEvent(new dom.window.Event('pause')); };
  el.load = () => {};
  return el;
};
const media = makeMedia();
window.__dshMusicMedia = () => media;

const SYSTEM_STREAM_BASE = 'http://127.0.0.1:19387/dsh-music/api/system-stream?t=test-token';
const SYSTEM_ART_BASE = 'http://127.0.0.1:19387/dsh-music/api/system-art?t=test-token';
const tracks = [
  { id: 'a.mp3', name: 'a.mp3', title: 'Alpha', artist: 'Artist X', duration: 120, tagged: true, kind: 'audio', videoCodec: null },
  { id: 'v.mp4', name: 'v.mp4', title: 'Movie Song', artist: 'Artist V', duration: 200, tagged: true, kind: 'video', videoCodec: 'h264' },
];
const library = { dir: '/music', tracks, scanning: false, scanParsed: tracks.length, scanTotal: tracks.length, truncated: false, skippedPackages: 0, scannedAt: 1 };
const calls = [];
const mockFetch = async (url) => {
  const target = String(url);
  calls.push(target);
  const suffix = target.replace('/dsh-music/api', '/api/dsh-music');
  if (suffix.includes('/api/dsh-music/session')) {
    return new dom.window.Response(JSON.stringify({ systemArtBase: SYSTEM_ART_BASE, systemStreamBase: SYSTEM_STREAM_BASE }), { headers: { 'content-type': 'application/json' } });
  }
  if (suffix.includes('/api/dsh-music/library') || suffix.includes('/api/dsh-music/refresh')) {
    return new dom.window.Response(JSON.stringify(library), { headers: { 'content-type': 'application/json' } });
  }
  if (suffix.includes('/api/dsh-music/cover')) return new dom.window.Response('', { status: 404 });
  if (suffix.includes('/api/dsh-music/mv')) {
    return new dom.window.Response(JSON.stringify({ mode: 'direct', state: 'ready', progress: 1, url: SYSTEM_STREAM_BASE + '&p=v.mp4' }), { headers: { 'content-type': 'application/json' } });
  }
  return new dom.window.Response('{}', { headers: { 'content-type': 'application/json' } });
};
dom.window.Response = dom.window.Response ?? globalThis.Response;
globalThis.fetch = mockFetch;
dom.window.fetch = mockFetch;

let pluginFactory = null;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { pluginFactory = factory; } };
dom.window.eval(await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8'));
if (pluginFactory === null) throw new Error('factory not captured');

const plugin = pluginFactory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
const disposers = [];
let ViewComponent = null;
const ctx = {
  effect: (fn, label) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push({ label, dispose }); return dispose; },
  locale: {
    register: () => {},
    bind: () => (key) => {
      // 字典里这几个键是「返回字符串的函数」（复数 / 占位符），其余是纯字符串。
      const dict = {
        stats: (n) => n + ' songs',
        'scan.progress': (a, b) => a + '/' + b,
        'confirm.delete': (title) => 'delete ' + title + '?',
        'complete.progress': (d, total) => d + '/' + total,
        'confirm.complete': (n) => 'complete ' + n,
        'stats.drm': (n) => n + ' drm skipped',
      };
      return dict[key] ?? key;
    },
  },
  slots: { inject: (_name, fn) => fn(), register: (_meta, component) => { ViewComponent = component; return () => {}; } },
};
plugin.apply(ctx);
if (ViewComponent === null) throw new Error('view component not registered');
const player = window.__dshMusicPlayer;
if (player === undefined || player === null) throw new Error('player singleton missing');

const settle = async (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
/** 模拟「切回音乐页」：DSH 重新挂载 conversation.view。 */
const mountView = async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(ViewComponent)); });
  await settle(300);
  return { container, root };
};
const click = async (node) => { await act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }); };
const phase = () => player.getState().playerPhase;
const parkOf = () => player.mediaPark();

let { container, root } = await mountView();
check('the library renders its rows', container.querySelectorAll('.dshm-row').length === 2, 'rows=' + container.querySelectorAll('.dshm-row').length);

// 播视频轨 → 全屏播放器 → MV 就地放大
const videoRow = Array.from(container.querySelectorAll('.dshm-row')).find((row) => row.textContent.includes('Movie Song'));
await click(videoRow.querySelector('.dshm-cellTitle'));
await settle(200);
check('playing a video row asks the host how to show it', calls.some((c) => c.includes('/api/dsh-music/mv?id=v.mp4')), calls.filter((c) => c.includes('/mv')).join(','));
await click(container.querySelector('.dshm-nowCoverBtn'));
await settle(80);
check('clicking the bottom cover opens the full player', container.querySelector('.dshm-player') !== null);
check('the MV picture sits in the full player stage', media.parentElement !== null && media.parentElement.classList.contains('dshm-mvStage'), 'parent=' + String(media.parentElement?.className));
await click(container.querySelector('.dshm-mvStage'));
await settle(60);
check('the MV surface is enlarged in place', container.querySelector('.dshm-player--mvbig') !== null);

// ── 切到对话：视图卸载 ──────────────────────────────────────────────────────
await act(async () => { root.unmount(); });
await settle(40);
check('the store keeps the full player open while the view is unmounted (switch to chat)', phase() === 'open', 'phase=' + phase());
check('the media element is parked on body so playback is not cut', media.parentElement === parkOf() && media.isConnected === true, 'parent=' + String(media.parentElement?.className));

// ── 切回音乐：视图重新挂载（关键回归断言）──────────────────────────────────
({ container, root } = await mountView());
check('coming back restores the full player instead of the list page', container.querySelector('.dshm-player') !== null, 'player=' + String(container.querySelector('.dshm-player') !== null));
check('the restored player still shows the track that was playing', String(container.querySelector('.dshm-playerTitle')?.textContent ?? '').includes('Movie Song'), String(container.querySelector('.dshm-playerTitle')?.textContent ?? ''));
check('the enlarged MV layout survives the remount', container.querySelector('.dshm-player--mvbig') !== null);
check('the same media element is moved back into the new stage (no second <video>)', media.parentElement !== null && media.parentElement.classList.contains('dshm-mvStage') && document.querySelectorAll('video').length === 1, 'videos=' + document.querySelectorAll('video').length);
check('the view did not create a second player singleton', window.__dshMusicPlayer === player);

// ── 收起动画跨卸载：定时器归 player，卸载后仍必须走完 ────────────────────────
// 节点可能不存在（缺陷版本会回到列表页）：点击前判空，让后面的断言照常报红、
// 而不是抛未捕获 TypeError 把整份对照打断（那样看不到总账）。
const collapseButton = container.querySelector('.dshm-playerTop .dshm-playerRound');
check('the restored player still offers its collapse control', collapseButton !== null);
if (collapseButton !== null) await click(collapseButton);
await settle(50);
check('collapse plays the exit animation first', container.querySelector('.dshm-player--closing') !== null);
await act(async () => { root.unmount(); });
await settle(260);
check('the closing timer runs in the player and finishes while the view is away', phase() === 'closed', 'phase=' + phase());
({ container, root } = await mountView());
check('coming back after collapsing shows the list page (no stuck closing overlay)', container.querySelector('.dshm-player') === null, 'player=' + String(container.querySelector('.dshm-player') !== null));

// ── 停用：全屏态必须复位（不得跨 activation 转移）──────────────────────────
await click(container.querySelector('.dshm-nowCoverBtn'));
await settle(60);
check('the full player is open again before teardown', phase() === 'open', 'phase=' + phase());
const teardown = disposers.find((entry) => String(entry.label).includes('audio teardown'));
check('plugin teardown effect captured', teardown !== undefined, 'effects=' + disposers.map((e) => e.label).join(','));
if (teardown !== undefined) await act(async () => { teardown.dispose(); });
check('halt resets the full player state (no stale open overlay for the next activation)', phase() === 'closed', 'phase=' + phase());
await act(async () => { root.unmount(); });

// ── 第 16 轮回归：teardown 之后 open→close 仍必须能走完 ─────────────────────
// 背景：退出动画定时器最初写成 `if (disposed) return;`。halt() 已经把句柄清掉，
// 所以回调能跑 = 「teardown 之后又被显式打开过」；而 player 是 window 级单例、
// 下一次 activation 继续用它（A3-03），disposed 永不复位 ⇒ phase 被永久钉在
// `closing`，覆盖层关不掉、也再打不开。这条断言在修回旧写法时必须变红。
if (teardown !== undefined) {
  player.openPlayer();
  check('the full player can be opened after teardown (shared singleton, A3-03)', phase() === 'open', 'phase=' + phase());
  player.closePlayer();
  await settle(300);
  check('the exit animation still finishes after teardown (disposed must not pin closing)', phase() === 'closed', 'phase=' + phase());
}

// ── 真实第二次 activation：插件重载后复用同一个 player 单例 ─────────────────
{
  let SecondView = null;
  const ctx2 = {
    effect: (fn) => fn(),
    locale: ctx.locale,
    slots: { inject: (_name, fn) => fn(), register: (_meta, component) => { SecondView = component; return () => {}; } },
  };
  pluginFactory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); }).apply(ctx2);
  const container2 = document.createElement('div');
  document.body.appendChild(container2);
  const root2 = createRoot(container2);
  await act(async () => { root2.render(React.createElement(SecondView)); });
  await settle(250);
  await click(container2.querySelector('.dshm-nowCoverBtn'));
  await settle(80);
  check('a second activation reusing the player opens the full player', container2.querySelector('.dshm-player') !== null);
  const close2 = container2.querySelector('.dshm-playerTop .dshm-playerRound');
  if (close2 !== null) await click(close2);
  await settle(300);
  check('a second activation can still collapse it (no stuck closing overlay)', container2.querySelector('.dshm-player') === null && phase() === 'closed', 'phase=' + phase() + ' overlay=' + String(container2.querySelector('.dshm-player') !== null));
  await act(async () => { root2.unmount(); });
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
