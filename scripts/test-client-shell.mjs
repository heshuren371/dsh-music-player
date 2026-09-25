// 客户端「深度适配」回归：平台探测、官方图标 / 官方 Tooltip、以及系统媒体集成。
// 全部在 jsdom 里用桩件验证，不依赖真实桌面窗口：
//  - window.dshDesktop 存在 → 走 Desktop 分支（原生通知）
//  - MediaSession artwork 必须是绝对 URL（macOS MediaRemote 只吃绝对地址）
//  - setPositionState 只在参数合法时调用
//  - 图标来自 @deepseek-ai/dsh-client-ui-primitives，悬停提示来自其 Tooltip
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
// jsdom 没有 canvas 实现：让兜底封面图走 "ctx === null" 分支，而不是抛 Not implemented。
dom.window.HTMLCanvasElement.prototype.getContext = () => null;
// Desktop 标记：apps/desktop/src/preload-app.ts 给 app 文档注入的形状。
dom.window.dshDesktop = { protocolVersion: 1 };
globalThis.dshDesktop = dom.window.dshDesktop;
// 宿主 /session 返回的「系统取图基址」：带 token 的绝对 http 地址，
// 专供 Chromium 内部取封面（它带 dsh-app://app 的 Origin，走普通栅栏必 403）。
const SYSTEM_ART_BASE = 'http://127.0.0.1:19387/dsh-music/api/system-art?t=test-token';

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail));
};

const FakeAudio = class extends dom.window.EventTarget {
  constructor() { super(); this.src = ''; this.currentTime = 0; this.duration = 120; this.volume = 1; this.playbackRate = 1; this.preload = ''; }
  play() { this.dispatchEvent(new dom.window.Event('play')); return Promise.resolve(); }
  pause() {}
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
};
Object.defineProperty(dom.window, 'Audio', { value: FakeAudio, configurable: true, writable: true });
globalThis.Audio = FakeAudio;

// ── 系统媒体接口桩件 ────────────────────────────────────────────────────────
const mediaSession = {
  metadata: null,
  playbackState: 'none',
  actionHandlers: [],
  positionStates: [],
  setActionHandler(name, handler) { this.actionHandlers.push(name); this[name] = handler; },
  setPositionState(state) {
    if (state !== undefined) {
      if (!(state.duration > 0) || state.position < 0 || state.position > state.duration || !(state.playbackRate > 0)) {
        throw new TypeError('bad position state');
      }
    }
    this.positionStates.push(state);
  },
};
Object.defineProperty(dom.window.navigator, 'mediaSession', { value: mediaSession, configurable: true });
// window.eval 作用域里的裸 navigator 取自 Node 全局（Node ≥21 自带 navigator），
// 不是 jsdom 的那个；测试里统一指向 jsdom 实例，桩件才可见。
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const notifications = [];
class FakeNotification {
  constructor(title, options) {
    this.title = title;
    this.options = options ?? {};
    this.closed = false;
    notifications.push(this);
  }
  close() { this.closed = true; }
}
FakeNotification.permission = 'granted';
dom.window.Notification = FakeNotification;
globalThis.Notification = FakeNotification;
// jsdom 没有 MediaMetadata：插件里是裸 new MediaMetadata(...)，所以两个作用域都要有。
class FakeMediaMetadata {
  constructor(init) { Object.assign(this, init ?? {}); }
}
dom.window.MediaMetadata = FakeMediaMetadata;
globalThis.MediaMetadata = FakeMediaMetadata;
// 窗口焦点/可见性可切换：默认失焦，后面再切到「聚焦且可见」验证通知照样发。
let windowFocused = false;
let windowVisibility = 'hidden';
dom.window.document.hasFocus = () => windowFocused;
Object.defineProperty(dom.window.document, 'visibilityState', { get: () => windowVisibility, configurable: true });

// ── 官方平台种子模块桩件 ────────────────────────────────────────────────────
const tooltipAnchors = [];
const Tooltip = ({ label, side, portal, children }) => {
  tooltipAnchors.push({ label, side, portal });
  return React.cloneElement(children, { 'data-tip': label, 'data-tip-side': side, 'data-tip-portal': portal });
};
/**
 * 两套真实存在的官方命名体系，用来验证插件的"候选名探测"确实按版本命中：
 *  - regular：DSH 0.1.7+ 的 IconXxxRegular / IconXxxMedium（权重体系）
 *  - legacy ：DSH 0.1.6 的 IconXxx16（ic_ds_ 时代的旧名）
 * 只喂一套，就能证明插件在当前宿主上拿到的确实是那一套。
 */
const ICON_SCHEMES = {
  regular: {
    play: 'IconPlayOutlineRegular', pause: 'IconPauseOutlineRegular', folder: 'IconFolderOpenRegular',
    refresh: 'IconRefreshOutlineRegular', edit: 'IconEditOutlineRegular', sparkle: 'IconSparkleRegular',
    trash: 'IconTrashOutlineRegular', close: 'IconCloseOutlineRegular',
    chevronDown: 'IconChevronDownOutlineRegular', ellipsis: 'IconEllipsisOutlineRegular',
    queue: 'IconQueueOutlineRegular',
  },
  legacy: {
    play: 'IconPlayOutline16', pause: 'IconPauseOutline16', folder: 'IconFolderOpen16',
    refresh: 'IconRefreshOutline16', edit: 'IconEditOutline16', sparkle: 'IconSparkle16',
    trash: 'IconTrashOutline16', close: 'IconCloseOutline16',
    chevronDown: 'IconChevronDownOutline16', ellipsis: 'IconEllipsisOutline16',
    queue: 'IconQueueOutline16',
  },
};
/** 官方 Input 组件的桩件：wrap(className) + icon + input 三层，和真实现同构。 */
const InputStub = ({ icon, className, ...rest }) => React.createElement('span', { className },
  icon ?? null,
  React.createElement('input', rest));
const makePrimitives = (scheme) => {
  const stub = { Tooltip, Input: InputStub };
  const names = Object.values(ICON_SCHEMES[scheme]);
  if (scheme === 'regular') names.push('IconSearchOutlineRegular');
  if (scheme === 'legacy') names.push('IconSearchOutline16');
  for (const name of names) {
    stub[name] = ({ size }) => React.createElement('svg', { 'data-icon': name, width: size, height: size });
  }
  return stub;
};
const primitives = makePrimitives('regular');

// ── 宿主响应桩件 ────────────────────────────────────────────────────────────
const tracks = [
  { id: 'a.mp3', name: 'a.mp3', title: 'Alpha', artist: 'Artist X', duration: 120, tagged: true },
  { id: 'b.mp3', name: 'b.mp3', title: 'Beta', artist: 'Artist Y', duration: 90, tagged: true },
];
const library = { dir: '/music', tracks, scanning: false, scanParsed: tracks.length, scanTotal: tracks.length, truncated: false, skippedPackages: 0, scannedAt: 1 };
const calls = [];
/** 模拟「宿主进程仍是旧版入口」：/api/dsh-music/* 一律 404，只有旧前缀会回话。 */
let legacyOnly = false;
const mockFetch = async (url) => {
  const target = String(url);
  calls.push(target);
  if (legacyOnly && target.startsWith('/api/dsh-music/')) return new dom.window.Response('not found', { status: 404 });
  const suffix = target.replace('/dsh-music/api', '/api/dsh-music');
  if (suffix.includes('/api/dsh-music/session')) return new dom.window.Response(JSON.stringify({ systemArtBase: SYSTEM_ART_BASE }), { headers: { 'content-type': 'application/json' } });
  if (suffix.includes('/api/dsh-music/library') || suffix.includes('/api/dsh-music/refresh')) return new dom.window.Response(JSON.stringify(library), { headers: { 'content-type': 'application/json' } });
  if (suffix.includes('/api/dsh-music/cover')) return new dom.window.Response('', { status: 404 });
  return new dom.window.Response('{}', { headers: { 'content-type': 'application/json' } });
};
dom.window.Response = dom.window.Response ?? globalThis.Response;
globalThis.fetch = mockFetch;
dom.window.fetch = mockFetch;

let pluginFactory = null;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { pluginFactory = factory; } };
dom.window.eval(await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8'));

let TooltipRequests = 0;
const plugin = pluginFactory((name) => {
  if (name === 'react') return React;
  if (name === '@deepseek-ai/dsh-client-ui-primitives') { TooltipRequests += 1; return primitives; }
  throw new Error('require: ' + name);
});

let ViewComponent = null;
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: () => {},
    bind: () => (key) => {
      const dict = {
        stats: (n) => n + ' songs',
        'scan.progress': (a, b) => a + '/' + b,
        'confirm.delete': (title) => 'delete ' + title + '?',
        'complete.progress': (d, tt) => d + '/' + tt,
        'confirm.complete': (n) => 'complete ' + n,
        'stats.drm': (n) => n + ' drm skipped',
      };
      return dict[key] ?? key;
    },
  },
  slots: { inject: (_name, fn) => fn(), register: (_meta, component) => { ViewComponent = component; return () => {}; } },
};
plugin.apply(ctx);

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
// ── 「画了但没接行为」检测：每个 button 必须真的挂上事件处理 ────────────────
// React 会把 props 存在 DOM 节点上（__reactProps$xxx），可以据此判断按钮是不是装饰品。
const reactProps = (node) => {
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'));
  return key === undefined ? null : node[key];
};
const wired = (node) => {
  const props = reactProps(node);
  return props !== null && (typeof props.onClick === 'function' || typeof props.onPointerDown === 'function' || typeof props.onChange === 'function' || props.disabled === true);
};
const settle = async (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
await act(async () => { root.render(React.createElement(ViewComponent)); });
await settle(300);

check('platform seed @deepseek-ai/dsh-client-ui-primitives is required once', TooltipRequests === 1, 'calls=' + TooltipRequests);
check('request URL base moved under /api (desktop only forwards /api/*)', calls.some((u) => u.startsWith('/api/dsh-music/library')), calls.join(','));

// ── 官方图标（0.1.7+ 的 Regular 命名） ──────────────────────────────────────
const iconNames = new Set(Array.from(container.querySelectorAll('[data-icon]')).map((el) => el.getAttribute('data-icon')));
const R = ICON_SCHEMES.regular;
check('official 0.1.7 Regular icons render in the toolbar', iconNames.has(R.refresh) && iconNames.has(R.folder) && iconNames.has(R.edit), Array.from(iconNames).join(','));
check('the row delete button uses the official trash icon', iconNames.has(R.trash), Array.from(iconNames).join(','));
check('play/pause use the macOS-native glyph, not the DSH circled icon', container.querySelector('.dshm-tbtn--play svg path[d^="M5.6 3.05"]') !== null && !iconNames.has(R.play) && !iconNames.has(R.pause), container.querySelector('.dshm-tbtn--play svg path')?.getAttribute('d')?.slice(0, 30) ?? 'missing');
check('an icon with no official counterpart keeps the drawn SVG', container.querySelectorAll('svg').length > 0);

// ── 官方悬停提示 ────────────────────────────────────────────────────────────
const tips = Array.from(container.querySelectorAll('[data-tip]')).map((el) => el.getAttribute('data-tip'));
check('buttons carry official Tooltip labels instead of native title', tips.length >= 4, 'tips=' + tips.length);
check('no native title tooltip is left on any button or row', container.querySelectorAll('button[title]').length === 0 && container.querySelectorAll('tr[title]').length === 0);
check('disabled-capable buttons wrap their anchor so hover still fires', container.querySelector('.dshm-tip') !== null);
check('tooltip bubbles are portalled (backdrop-filter ancestors would clip them)', tooltipAnchors.length > 0 && tooltipAnchors.every((entry) => entry.portal === true), JSON.stringify(tooltipAnchors[0] ?? null));

// ── 官方搜索框（Input 组件） ───────────────────────────────────────────────
check('search field renders through the official Input primitive', container.querySelector('.dshm-searchWrap input') !== null && container.querySelector('[data-icon="IconSearchOutlineRegular"]') !== null, container.querySelector('.dshm-searchWrap')?.outerHTML?.slice(0, 120) ?? 'missing');

// ── 歌曲信息跑马灯（溢出才滚） ─────────────────────────────────────────────
const nowTitle = container.querySelector('.dshm-nowTitle.dshm-marquee');
check('now-playing title renders inside the marquee host', nowTitle !== null && String(nowTitle.textContent).length > 0, nowTitle?.outerHTML?.slice(0, 140) ?? 'missing');
check('marquee shows one copy while the text still fits', container.querySelectorAll('.dshm-nowTitle .dshm-marqueeText').length === 1);
check('marquee carries the animation variables', String(nowTitle?.getAttribute('style') ?? '').includes('--dshm-marquee-duration'), nowTitle?.getAttribute('style') ?? '');

// 伪造「文本比容器宽」：jsdom 没有布局，只能覆写量宽属性再触发 resize。
const proto = dom.window.Element.prototype;
const scrollDescriptor = Object.getOwnPropertyDescriptor(proto, 'scrollWidth');
const clientDescriptor = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
Object.defineProperty(proto, 'scrollWidth', { configurable: true, get() { return String(this.className).includes('dshm-marqueeText') ? 400 : 0; } });
Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return String(this.className).includes('dshm-marquee') ? 120 : 0; } });
await act(async () => { dom.window.dispatchEvent(new dom.window.Event('resize')); });
await settle(60);
check('marquee turns on and duplicates the text once it overflows', container.querySelectorAll('.dshm-nowTitle.dshm-marquee--on').length === 1 && container.querySelectorAll('.dshm-nowTitle .dshm-marqueeText').length === 2, container.querySelector('.dshm-nowTitle')?.outerHTML?.slice(0, 160) ?? 'missing');
// 回归：文本只比容器宽一点点（< 2 倍）也必须滚。旧实现从 inner.scrollWidth 折半，
// 阈值被抬成"文本 > 2 倍容器宽"，这个区间就成了既不滚也不省略号、直接切掉。
Object.defineProperty(proto, 'scrollWidth', { configurable: true, get() { return String(this.className).includes('dshm-marqueeText') ? 200 : 0; } });
await act(async () => { dom.window.dispatchEvent(new dom.window.Event('resize')); });
await settle(60);
check('a title only slightly wider than the box still scrolls', container.querySelectorAll('.dshm-nowTitle.dshm-marquee--on').length === 1 && container.querySelectorAll('.dshm-nowTitle .dshm-marqueeText').length === 2, 'threshold is 1x box, not 2x');
Object.defineProperty(proto, 'scrollWidth', { configurable: true, get() { return String(this.className).includes('dshm-marqueeText') ? 400 : 0; } });
await act(async () => { dom.window.dispatchEvent(new dom.window.Event('resize')); });
await settle(40);
if (scrollDescriptor === undefined) delete proto.scrollWidth; else Object.defineProperty(proto, 'scrollWidth', scrollDescriptor);
if (clientDescriptor === undefined) delete proto.clientWidth; else Object.defineProperty(proto, 'clientWidth', clientDescriptor);

// ── 播放：MediaSession + 桌面通知 ────────────────────────────────────────────
await act(async () => { container.querySelector('.dshm-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(200);

const metadata = mediaSession.metadata;
check('MediaSession metadata exposes the track', metadata !== null && metadata.title === 'Alpha' && metadata.artist === 'Artist X', metadata === null ? 'null' : metadata.title + '/' + metadata.artist);
check('now-playing marquee shows the playing track title', String(container.querySelector('.dshm-nowTitle')?.textContent ?? '').includes('Alpha'), String(container.querySelector('.dshm-nowTitle')?.textContent ?? ''));
check('MediaSession artwork uses the token-guarded absolute system-art URL', Array.isArray(metadata?.artwork) && metadata.artwork.length > 0 && String(metadata.artwork[0].src).startsWith(SYSTEM_ART_BASE + '&p='), JSON.stringify(metadata?.artwork));
check('artwork never uses the dsh-app:// page origin (Chromium rejects that scheme)', !String(metadata?.artwork?.[0]?.src ?? '').startsWith('dsh-app:'), String(metadata?.artwork?.[0]?.src));
check('playbackState reflects playback', mediaSession.playbackState === 'playing', mediaSession.playbackState);
check('setPositionState was fed a legal (duration, position, rate)', mediaSession.positionStates.length >= 1 && mediaSession.positionStates.every((s) => s === undefined || (s.duration > 0 && s.position >= 0 && s.position <= s.duration)), JSON.stringify(mediaSession.positionStates));
check('media-key handlers are registered', ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto'].every((n) => mediaSession.actionHandlers.includes(n)), mediaSession.actionHandlers.join(','));

// 正在播放的指示：Apple Music 的 .playing-bars —— 该行封面叠三根跳动条，
// 悬停换成播放/暂停图标（--playButtonOpacity）
const activeCover = container.querySelector('.dshm-row--active .dshm-coverWrap');
check('the playing row overlays the animated equalizer bars', activeCover?.querySelectorAll('.dshm-coverBars i').length === 3 && activeCover.querySelector('.dshm-coverHover') !== null);
check('only the playing row gets the overlay', container.querySelectorAll('.dshm-coverWrap').length === 1, String(container.querySelectorAll('.dshm-coverWrap').length));
check('while playing the hover glyph is the pause icon (two bars)', String(container.querySelector('.dshm-coverHover svg')?.innerHTML ?? '').includes('<rect'), 'pause glyph');

check('desktop + unfocused window raises a native notification', notifications.length === 1 && notifications[0].title === 'Alpha', JSON.stringify(notifications.map((n) => n.title)));
check('notification body carries artist context', notifications[0].options.body === 'Artist X', JSON.stringify(notifications[0]?.options));
check('notification icon is the absolute artwork URL', String(notifications[0].options.icon).startsWith(SYSTEM_ART_BASE), String(notifications[0].options.icon));
check('notification is silent (music is already playing)', notifications[0].options.silent === true);

// 同一首歌不重复通知
await act(async () => { container.querySelector('.dshm-tbtn--play').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(100);
check('re-playing the same track does not spam the notification centre', notifications.length === 1, 'count=' + notifications.length);

// ── 全屏播放器（Apple Music 风格，点底部封面弹出） ────────────────────────
check('bottom-bar cover is the player entry point', container.querySelector('.dshm-nowCoverBtn') !== null);
await act(async () => { container.querySelector('.dshm-nowCoverBtn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(80);
const overlay = container.querySelector('.dshm-player');
check('clicking the cover opens the full player', overlay !== null);
check('full player shows big artwork + the playing title', overlay?.querySelector('.dshm-playerArt') !== null && String(overlay?.querySelector('.dshm-playerTitle')?.textContent ?? '').includes('Alpha'), overlay?.querySelector('.dshm-playerTitle')?.textContent ?? 'missing');
check('full player uses official DSH icons where they exist (chevron / ellipsis)', overlay?.querySelector('[data-icon="IconChevronDownOutlineRegular"]') !== null && overlay?.querySelector('[data-icon="IconEllipsisOutlineRegular"]') !== null, Array.from(overlay?.querySelectorAll('[data-icon]') ?? []).map((el) => el.getAttribute('data-icon')).join(','));
check('full player has transport, progress and volume', overlay?.querySelectorAll('.dshm-playerTransportBtn').length === 4 && overlay?.querySelector('.dshm-progress--stacked') !== null && overlay?.querySelector('.dshm-volume') !== null);
check('prev/play/next sit in the centred group (loop moved out)', (() => {
  const center = overlay?.querySelector('.dshm-playerTransportCenter');
  const end = overlay?.querySelector('.dshm-playerTransportSide--end');
  return center?.querySelectorAll('.dshm-playerTransportBtn').length === 3 && end?.querySelectorAll('.dshm-playerTransportBtn').length === 1;
})(), String(overlay?.querySelector('.dshm-playerTransportCenter')?.querySelectorAll('.dshm-playerTransportBtn').length));
check('the loop button is the row after -remaining (right-aligned cell)', (() => {
  const row = overlay?.querySelector('.dshm-timeRow');
  const remaining = row?.querySelector('.dshm-time--end');
  const loop = overlay?.querySelector('.dshm-playerTransportSide--end .dshm-playerTransportBtn');
  return remaining !== null && loop !== null && row.compareDocumentPosition(loop) === 4;
})(), 'timeRow→loop sibling order');
check('the speaker glyph is drawn (macOS style, not the old one)', String(overlay?.querySelector('.dshm-playerVolume .dshm-volIcon svg')?.innerHTML ?? '').includes('c.47.47 1.27.14 1.27-.53'), 'speaker svg present');
check('full player title/artist use the marquee', overlay?.querySelector('.dshm-playerTitle.dshm-marquee') !== null && overlay?.querySelector('.dshm-playerArtist.dshm-marquee') !== null);
// 全屏播放器同一个 Marquee：容器更窄，长歌名必须真的滚起来（不再是切掉）
const mp = dom.window.Element.prototype;
const sp = Object.getOwnPropertyDescriptor(mp, 'scrollWidth');
const cp = Object.getOwnPropertyDescriptor(mp, 'clientWidth');
Object.defineProperty(mp, 'scrollWidth', { configurable: true, get() { return String(this.className).includes('dshm-marqueeText') ? 240 : 0; } });
Object.defineProperty(mp, 'clientWidth', { configurable: true, get() { return String(this.className).includes('dshm-marquee') ? 150 : 0; } });
await act(async () => { dom.window.dispatchEvent(new dom.window.Event('resize')); });
await settle(60);
check('full player title scrolls when the name is longer than the box', overlay?.querySelector('.dshm-playerTitle.dshm-marquee--on') !== null && overlay?.querySelectorAll('.dshm-playerTitle .dshm-marqueeText').length === 2, 'marquee on in the full player');
if (sp === undefined) delete mp.scrollWidth; else Object.defineProperty(mp, 'scrollWidth', sp);
if (cp === undefined) delete mp.clientWidth; else Object.defineProperty(mp, 'clientWidth', cp);
check('full player keeps the macOS Music ⭐ + ⋯ pair next to the title', (() => {
  const meta = overlay?.querySelector('.dshm-playerMeta');
  const rounds = Array.from(meta?.querySelectorAll('.dshm-playerRound') ?? []);
  const first = rounds[0];
  return rounds.length === 2 && (first?.querySelector('svg') !== null) && (rounds[1]?.querySelector('[data-icon="IconEllipsisOutlineRegular"]') !== null);
})(), String(overlay?.querySelectorAll('.dshm-playerMeta .dshm-playerRound').length));
check('full player progress is stacked: track on top, elapsed / -remaining below', (() => {
  const wrap = overlay?.querySelector('.dshm-progress--stacked');
  const row = wrap?.querySelector('.dshm-timeRow');
  const labels = Array.from(row?.querySelectorAll('.dshm-time') ?? []).map((el) => el.textContent);
  return wrap?.querySelector('.dshm-progressTrack input.dshm-slider') !== null && row !== null && labels.length === 2 && String(labels[1]).startsWith('-');
})(), Array.from(overlay?.querySelectorAll('.dshm-progress--stacked .dshm-time') ?? []).map((el) => el.textContent).join(' / '));
check('stacked time row really spans the track (elapsed left / -remaining right)', (() => {
  const wrap = overlay?.querySelector('.dshm-progress--stacked');
  const row = wrap?.querySelector('.dshm-timeRow');
  return wrap !== null && row !== null
    && wrap.classList.contains('dshm-progress')
    && (container.ownerDocument.querySelector('style[data-plugin="@local/dsh-music-player"]')?.textContent ?? '').includes('.dshm-progress.dshm-progress--stacked{flex-direction:column;gap:6px;align-items:stretch}')
    && (container.ownerDocument.querySelector('style[data-plugin="@local/dsh-music-player"]')?.textContent ?? '').includes('.dshm-progress--stacked .dshm-timeRow{width:100%}');
})(), 'align-items must outrank .dshm-progress{align-items:center}');
check('the seek bar is driven by its own pointer hit area', (() => {
  const track = overlay?.querySelector('.dshm-progress--stacked .dshm-progressTrack');
  return track !== null && String(track.querySelector('input.dshm-slider')?.className ?? '').includes('dshm-slider');
})(), 'progressTrack present');

// 圆钮：macOS 原生白色圆钮（进度条悬停才现、音量条常显）
const pluginCss = document.querySelector('style[data-plugin="@local/dsh-music-player"]')?.textContent ?? '';
check('slider knob is the macOS white capsule (ellipse, not a circle)', pluginCss.includes('width:20px;height:14px;border-radius:999px;background:#ffffff') && pluginCss.includes('box-shadow:0 .5px 2px rgba(0,0,0,.28)'), 'knob rule');
check('the seek slider itself ignores pointer events (hit area owns them)', pluginCss.includes('.dshm-progress .dshm-slider{pointer-events:none'), 'pointer-events rule');

// 动效 / 材质：曲线、关键帧、Apple 的 saturate 毛玻璃、减少动效开关
check('motion tokens carry the Apple Music easing curves', pluginCss.includes('--dshm-ease:cubic-bezier(.215,.61,.355,1)') && pluginCss.includes('--dshm-ease-snap:cubic-bezier(.23,1,.32,1)') && pluginCss.includes('--dshm-ease-spring:cubic-bezier(.76,.665,.37,1.35)'), 'easing tokens');
check('player overlay animates in and out (modalZoomIn/Out style)', pluginCss.includes('@keyframes dshm-playerIn') && pluginCss.includes('@keyframes dshm-playerOut') && pluginCss.includes('.dshm-player--closing{animation:dshm-playerOut .2s var(--dshm-ease)'), 'player motion');
check('artwork crossfades in on every track change', pluginCss.includes('@keyframes dshm-artIn') && pluginCss.includes('.dshm-playerArt,.dshm-playerArtFallback{animation:dshm-artIn'), 'artwork motion');
check('frosted surfaces use Apple material saturation (saturate(180%))', pluginCss.includes('saturate(180%) blur(6px)') && pluginCss.includes('saturate(180%) blur(48px)'), 'material');
check('press feedback is a scale(.92) like the Apple UI', pluginCss.includes('.dshm-playerRound:active:not(:disabled)') && pluginCss.includes('transform:scale(.92)'), 'press');
check('prefers-reduced-motion disables the new animations', pluginCss.includes('@media (prefers-reduced-motion:reduce)') && /@media \(prefers-reduced-motion:reduce\)\{[^}]*\.dshm-player,\.dshm-player--closing/.test(pluginCss), 'reduced motion');
check('the now-playing indicator reuses Apple\'s playing-bars idea', pluginCss.includes('@keyframes dshm-eq') && pluginCss.includes('.dshm-coverBars i{') && pluginCss.includes('.dshm-row:hover .dshm-coverBars,.dshm-queueRow:hover .dshm-coverBars{opacity:0}'), 'equalizer');
check('macOS overlay scrollbars (hidden until hover)', pluginCss.includes('.dshm-tableWrap::-webkit-scrollbar') && pluginCss.includes('.dshm-playerQueue:hover::-webkit-scrollbar-thumb'), 'scrollbars');
check('keyboard focus ring is the Apple 3-4px halo', pluginCss.includes(':focus-visible{outline:none;box-shadow:0 0 0 3px color-mix'), 'focus halo');
check('list rows use the 12px list-row radius token', pluginCss.includes('border-radius:12px'), 'row radius');
check('progress knob is hidden until hover, volume knob is always visible', pluginCss.includes('.dshm-slider::-webkit-slider-thumb') && pluginCss.includes('transform:scale(0)') && pluginCss.includes('.dshm-volume::-webkit-slider-thumb'), 'reveal rules');
check('"一键补全" is back in the pills row next to refresh', (() => {
  const pills = Array.from(overlay?.querySelectorAll('.dshm-playerPills .dshm-pill') ?? []);
  return pills.length === 2 && String(pills[0].textContent).includes('action.completeAll') && String(pills[1].textContent).includes('action.refresh');
})(), String(overlay?.querySelectorAll('.dshm-playerPills .dshm-pill').length));
check('full player lists the upcoming queue', (overlay?.querySelectorAll('.dshm-queueRow').length ?? 0) >= 1, String(overlay?.querySelectorAll('.dshm-queueRow').length));
check('full player carries the frosted artwork backdrop', overlay?.querySelector('.dshm-playerArt-bg') !== null && overlay?.querySelector('.dshm-playerScrim') !== null);

// 收藏（DSH 无星标图标 → 插件自绘，状态存 localStorage）
const favButton = overlay.querySelectorAll('.dshm-playerMeta .dshm-playerRound')[0];
await act(async () => { favButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(50);
check('favorite toggles and persists', JSON.parse(localStorage.getItem('dsh-music:fav') ?? '[]').includes('a.mp3'), localStorage.getItem('dsh-music:fav'));

// 队列行「⋯」菜单
await act(async () => { overlay.querySelector('.dshm-queueMore').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(50);
check('queue row ⋯ opens a two-item action menu', overlay.querySelectorAll('.dshm-queueMenuItem').length === 2, String(overlay.querySelectorAll('.dshm-queueMenuItem').length));
await act(async () => { overlay.querySelector('.dshm-playerBody').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(30);
check('clicking the surface dismisses the ⋯ menu', overlay.querySelectorAll('.dshm-queueMenuItem').length === 0);

// 收起
// 收起：先播 200ms 退出动画，再卸载（Apple Music 弹层的 zoom-out）
await act(async () => { overlay.querySelector('.dshm-playerTop .dshm-playerRound').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(60);
check('every button inside the full player is wired too', Array.from(overlay.querySelectorAll('button')).every(wired), Array.from(overlay.querySelectorAll('button')).filter((b) => !wired(b)).map((b) => b.className || '?').join(' | '));
check('collapse plays the exit animation before unmounting', container.querySelector('.dshm-player--closing') !== null);
await settle(260);
check('collapse button closes the full player', container.querySelector('.dshm-player') === null);

const deadInMain = Array.from(document.querySelectorAll('button')).filter((b) => !wired(b));
check('every rendered button is wired to a handler', deadInMain.length === 0, deadInMain.map((b) => (b.className || b.getAttribute('aria-label') || '?')).join(' | '));

// 窗口在前台（聚焦 + 可见）时换曲也必须提示 —— 这是用户报的「通知栏没适配」场景。
windowFocused = true;
windowVisibility = 'visible';
await act(async () => { container.querySelectorAll('.dshm-row')[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(200);
check('a track change notifies even while the window is focused', notifications.length === 2 && notifications[1].title === 'Beta', JSON.stringify(notifications.map((n) => n.title)));
check('the second notification carries the new track artwork', String(notifications[1]?.options?.icon).startsWith(SYSTEM_ART_BASE), String(notifications[1]?.options?.icon));
// ── 旧宿主回落：客户端已更新、宿主 index.js 未重启的窗口期 ──────────────────
legacyOnly = true;
const beforeFallback = calls.length;
await act(async () => { container.querySelector('button[aria-label="action.refresh"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(150);
const fallbackCalls = calls.slice(beforeFallback);
check('a 404 on /api/dsh-music/* falls back to the legacy /dsh-music prefix once', fallbackCalls.some((u) => u.startsWith('/dsh-music/api/refresh')), fallbackCalls.join(','));
check('the fallback keeps the UI alive (no error bar)', container.querySelector('.dshm-error') === null);

// ── 旧命名体系（0.1.6 的 IconXxx16）同样要命中 ─────────────────────────────
{
  const legacyPrimitives = makePrimitives('legacy');
  let LegacyView = null;
  const legacyCtx = {
    effect: (fn) => fn(),
    locale: ctx.locale,
    slots: { inject: (_name, fn) => fn(), register: (_meta, component) => { LegacyView = component; return () => {}; } },
  };
  pluginFactory((name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return legacyPrimitives;
    throw new Error('require: ' + name);
  }).apply(legacyCtx);
  const legacyContainer = document.createElement('div');
  document.body.appendChild(legacyContainer);
  const legacyRoot = createRoot(legacyContainer);
  await act(async () => { legacyRoot.render(React.createElement(LegacyView)); });
  await settle(200);
  const legacyIcons = new Set(Array.from(legacyContainer.querySelectorAll('[data-icon]')).map((el) => el.getAttribute('data-icon')));
  const L = ICON_SCHEMES.legacy;
  const legacyRows = legacyContainer.querySelectorAll('.dshm-row').length;
  check('0.1.6 IconXxx16 names also resolve (candidate probing is version-tolerant)', legacyIcons.has(L.refresh) && legacyIcons.has(L.folder) && legacyIcons.has(L.trash), 'rows=' + legacyRows + ' icons=' + Array.from(legacyIcons).join(','));
  await act(async () => { legacyRoot.unmount(); });
}

await act(async () => { root.unmount(); });
console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
