// Client-side regression for online metadata completion:
//  - row ✦ → candidate dialog → apply writes tags + renames via POST /api/apply
//  - unchecking "write file" keeps a local display-only override (and clear)
//  - one-click Complete All skips already-tagged/overridden tracks
import { readFileSync } from 'node:fs';
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
  play() { this.dispatchEvent(new dom.window.Event('play')); return Promise.resolve(); }
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

let tracks = [
  { id: 'a.mp3', name: 'a.mp3', title: 'Alpha', artist: 'x', duration: 300, tagged: false },
  { id: 'b.mp3', name: 'b.mp3', title: 'Beta', artist: 'y', duration: 300, tagged: false },
  { id: 'c.mp3', name: 'c.mp3', title: 'Gamma', artist: null, duration: 300, tagged: false },
  { id: 'd.mp3', name: 'd.mp3', title: 'Delta', artist: null, duration: 300, tagged: false },
  // Tags are already correct but the filename is not "Artist - Title": the
  // batch must still rename it instead of treating it as done.
  { id: 'e.mp3', name: 'e.mp3', title: 'Epsilon', artist: 'Real E', duration: 300, tagged: true },
];
const library = (scannedAt) => ({ dir: '/music', tracks, scanning: false, scanParsed: tracks.length, scanTotal: tracks.length, truncated: false, skippedPackages: 1, scannedAt });
const TITLES = { a: 'Alpha Real', b: 'Beta Real', c: 'Gamma Real', d: 'Delta Maybe' };
const ARTISTS = { a: 'Real X', b: 'Real Y', c: 'Real Z', d: 'Real D' };
const stemOf = (id) => id.replace(/\.[^.]+$/, '');
const matchCalls = [];
const applyCalls = [];
let failRefresh = false;
const mockFetch = async (url, options) => {
  const target = String(url);
  if (failRefresh && target.includes('/api/dsh-music/refresh')) {
    return { ok: false, status: 500, json: async () => ({ error: 'refresh-failed' }) };
  }
  const parsed = new URL(target, 'http://127.0.0.1');
  if (target.includes('/api/dsh-music/match')) {
    matchCalls.push(target);
    const id = parsed.searchParams.get('p');
    const stem = stemOf(id);
    const current = tracks.find((track) => track.id === id);
    // d.mp3 deliberately comes back below the auto-write threshold.
    const confident = stem !== 'd';
    // An already-tagged track resolves to its own metadata (nothing to change).
    const title = current?.tagged === true && TITLES[stem] === undefined ? current.title : (TITLES[stem] ?? id);
    const artist = current?.tagged === true && ARTISTS[stem] === undefined ? current.artist : (ARTISTS[stem] ?? 'A');
    const candidate = { id: 1, title, artist, album: 'Album', cover: 'https://is1-ssl.mzstatic.com/image/thumb/Music/300x300bb.jpg', duration: 301, score: confident ? 0.95 : 0.4, auto: confident, source: 'qq', sources: ['qq', 'itunes'] };
    return { ok: true, json: async () => ({ term: title, best: candidate, auto: confident, candidates: [candidate] }) };
  }
  if (target.includes('/api/dsh-music/apply')) {
    const body = JSON.parse(options.body);
    applyCalls.push(body);
    const index = tracks.findIndex((track) => track.id === body.id);
    const newName = body.artist + ' - ' + body.title + '.mp3';
    tracks = tracks.map((track, i) => (i === index ? { ...track, id: newName, name: newName, title: body.title, artist: body.artist, tagged: true } : track));
    return { ok: true, json: async () => ({ oldId: body.id, newId: newName, tagged: true, renamed: true, warning: null, library: library(2) }) };
  }
  return { ok: true, json: async () => library(1) };
};
globalThis.fetch = mockFetch;
dom.window.fetch = mockFetch;

const plugin = pluginFactory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
let ViewComponent = null;
const cleanups = [];
const ctx = {
  effect: (fn) => { const cleanup = fn(); if (typeof cleanup === "function") cleanups.push(cleanup); },
  locale: {
    register: () => {},
    bind: () => (key) => {
      const dict = { stats: (n) => n + ' songs', 'scan.progress': (a, b) => a + '/' + b, 'confirm.delete': (title) => 'delete ' + title + '?', 'complete.progress': (d, tt) => d + '/' + tt, 'confirm.complete': (n) => 'complete ' + n, 'stats.drm': (n) => n + ' drm skipped' };
      return dict[key] ?? key;
    },
  },
  slots: { inject: (_name, fn) => fn(), register: (_meta, component) => { ViewComponent = component; return () => {}; } },
};
plugin.apply(ctx);
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
const settle = async (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
await act(async () => { root.render(React.createElement(ViewComponent)); });
await settle(300);

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };
const rows = () => container.querySelectorAll('.dshm-row');
const chooseRowAction = async (row, selector) => {
  await act(async () => { row.querySelector('.dshm-rowMenuBtn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await settle(40);
  const menu = container.querySelector('.dshm-rowMenu');
  const item = menu === null ? null : menu.querySelector(selector);
  if (item !== null) {
    await act(async () => { item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle(80);
  }
  return item !== null;
};
const titleOf = (row) => row.querySelector('.dshm-cellTitle').textContent;
const meta = () => JSON.parse(localStorage.getItem('dsh-music:meta') ?? '{}');

check('five rows rendered with a cover cell', rows().length === 5 && rows()[0].querySelector('.dshm-colCover') !== null, 'rows=' + rows().length);
// ── 搜索：放大镜展开 / 防抖 / Esc 收起但保留筛选 ────────────────────────────
{
  const toggle = container.querySelector('.dshm-searchToggle');
  check('search stays collapsed behind the magnifier by default',
    toggle !== null && container.querySelector('.dshm-search') === null,
    'toggle=' + (toggle !== null) + ' input=' + (container.querySelector('.dshm-search') !== null));
  if (toggle !== null) {
    await act(async () => { toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle(40);
    const search = container.querySelector('.dshm-search');
    check('clicking the magnifier opens and focuses the search input',
      search !== null && toggle.getAttribute('aria-expanded') === 'true' && document.activeElement === search,
      'input=' + (search !== null) + ' expanded=' + toggle.getAttribute('aria-expanded') + ' focused=' + (document.activeElement === search));
    const type = async (value) => act(async () => {
      const input = container.querySelector('.dshm-search');
      if (input === null) return;
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await type('gam');
    await settle(20);
    const immediate = rows().length;
    await settle(260);
    const filtered = rows().length;
    check('typing filters after the debounce window (not on every keystroke)',
      immediate === 5 && filtered === 1, 'immediate=' + immediate + ' filtered=' + filtered);
    await act(async () => {
      const input = container.querySelector('.dshm-search');
      if (input !== null) input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(40);
    check('Escape collapses the search but keeps the filter and shows the active dot',
      container.querySelector('.dshm-search') === null && container.querySelector('.dshm-searchBadge') !== null && rows().length === 1
        && container.querySelector('.dshm-searchToggle')?.getAttribute('aria-expanded') === 'false',
      'input=' + (container.querySelector('.dshm-search') !== null) + ' badge=' + (container.querySelector('.dshm-searchBadge') !== null) + ' rows=' + rows().length);
    const toggleAgain = container.querySelector('.dshm-searchToggle');
    if (toggleAgain !== null) {
      await act(async () => { toggleAgain.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      await settle(40);
    }
    const reopened = container.querySelector('.dshm-search');
    check('reopening the search keeps the typed term', reopened !== null && reopened.value === 'gam', 'value=' + (reopened?.value ?? 'missing'));
    await type('zzz');
    await settle(260);
    const emptyState = container.querySelector('.dshm-empty');
    const emptyClear = container.querySelector('.dshm-clearSearch');
    const inlineClear = container.querySelector('.dshm-searchClear');
    check('a no-match search shows an empty state with a clear button',
      rows().length === 0 && emptyState !== null && emptyClear !== null,
      'rows=' + rows().length + ' empty=' + (emptyState !== null) + ' clear=' + (emptyClear !== null));
    check('the expanded search offers an inline clear button', inlineClear !== null, 'clear=' + (inlineClear !== null));
    if (emptyClear !== null) {
      await act(async () => { emptyClear.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      await settle(60);
    }
    check('clearing from the empty state restores all rows', rows().length === 5, 'rows=' + rows().length);
    const finalToggle = container.querySelector('.dshm-searchToggle');
    if (finalToggle !== null) {
      await act(async () => { finalToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      await settle(30);
    }
  }
}

// ── API 表面：接口声明的每个方法都必须真的存在（提取后防漏/防改名）──────────
{
  const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8');
  const ifaceStart = source.indexOf('interface MusicPlayerApi {');
  const iface = source.slice(ifaceStart, source.indexOf('\n}', ifaceStart));
  const declared = [...iface.matchAll(/^  ([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  const live = window.__dshMusicPlayer;
  const missing = declared.filter((name) => typeof live[name] !== 'function');
  check('every declared MusicPlayerApi method exists on the live player',
    declared.length > 30 && missing.length === 0,
    declared.length + ' declared, missing: ' + missing.join(','));
}

// ── 行键盘可达：Tab 到行、Enter 播放 ─────────────────────────────────────────
{
  const row = rows()[2];
  const before = window.__dshMusicPlayer.getState().current;
  await act(async () => { row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await settle(80);
  const after = window.__dshMusicPlayer.getState().current;
  check('a row is focusable and Enter plays it', row.tabIndex === 0 && after !== before,
    'tabIndex=' + row.tabIndex + ' current ' + before + '→' + after);
}

check('DRM-skipped package count is shown', container.querySelector('.dshm-header .dshm-stats')?.textContent.includes('1 drm skipped'), container.querySelector('.dshm-header .dshm-stats')?.textContent);

// ── Per-row apply (writes file) ──────────────────────────────────────────────
check('list rows no longer carry per-row favorite buttons', container.querySelector('.dshm-row .dshm-fav') === null);
window.__dshMusicPlayer.toggleFavorite('a.mp3');
await settle(40);
check('favorites can still be set while applying', window.__dshMusicPlayer.getState().favorites.has('a.mp3'), JSON.stringify([...window.__dshMusicPlayer.getState().favorites]));
await chooseRowAction(rows()[0], '.dshm-menuMatch');
check('match request fired with the stable id', matchCalls.length === 1 && matchCalls[0].includes('p=a.mp3'), matchCalls[0]);
check('search box shows the term the host used', container.querySelector('.dshm-matchInput')?.value === 'Alpha Real', container.querySelector('.dshm-matchInput')?.value);
check('write-file box is checked by default', container.querySelector('.dshm-check input')?.checked === true);
await act(async () => { container.querySelector('.dshm-matchRow .dshm-btn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(80);
check('manual search sends q=', matchCalls.length === 2 && matchCalls[1].includes('q=Alpha%20Real'), matchCalls[1]);

await act(async () => { container.querySelector('.dshm-cand').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(120);
check('apply posts the candidate + rename to the host', applyCalls.length === 1 && applyCalls[0].id === 'a.mp3' && applyCalls[0].rename === true && applyCalls[0].title === 'Alpha Real', JSON.stringify(applyCalls[0]));
// 宿主只在 replaceCover:true 时才替换已有内嵌封面，所以手动应用必须把默认勾选的意图带上。
// 两个方向的完整覆盖（含取消勾选、无封面候选、批量开关）在 test-cover-replace.mjs。
check('apply asks the host to replace an existing embedded cover', applyCalls[0].replaceCover === true, JSON.stringify(applyCalls[0]));
check('dialog closes after applying', container.querySelector('.dshm-modal') === null);
check('row now shows the renamed/host-tagged entry', titleOf(rows()[0]) === 'Alpha Real' && rows()[0].title === 'Real X - Alpha Real.mp3', titleOf(rows()[0]) + ' / ' + rows()[0].title);
check('renaming migrates the favorite id', window.__dshMusicPlayer.getState().favorites.has('Real X - Alpha Real.mp3') && !window.__dshMusicPlayer.getState().favorites.has('a.mp3'), JSON.stringify([...window.__dshMusicPlayer.getState().favorites]));
check('no local override is kept once tags were written', meta()['a.mp3'] === undefined);

// ── 弹层：dialog 语义 / 背景滚动锁 / Escape 关闭 / 焦点进入 ────────────────────
{
  await chooseRowAction(rows()[1], '.dshm-menuMatch');
  await settle(90);
  const overlay = container.querySelector('.dshm-modal');
  const input = container.querySelector('.dshm-matchInput');
  check('match overlay exposes dialog semantics',
    overlay !== null && overlay.getAttribute('role') === 'dialog'
      && overlay.getAttribute('aria-modal') === 'true' && overlay.getAttribute('aria-label') !== null,
    overlay === null ? 'missing' : overlay.getAttribute('role') + '/' + overlay.getAttribute('aria-modal'));
  check('opening the overlay locks background scroll', document.body.style.overflow === 'hidden', 'overflow=' + document.body.style.overflow);
  check('focus moves into the overlay', input !== null && document.activeElement === input, 'active=' + (document.activeElement?.className ?? '?'));
  await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await settle(60);
  check('Escape closes the overlay', container.querySelector('.dshm-modal') === null);
  check('closing the overlay restores background scroll', document.body.style.overflow === '', 'overflow=' + document.body.style.overflow);
}

// ── 错误横幅可关闭 ───────────────────────────────────────────────────────────
{
  failRefresh = true;
  await act(async () => { await window.__dshMusicPlayer.refresh(); });
  await settle(40);
  const banner = container.querySelector('.dshm-error');
  const close = container.querySelector('.dshm-errorClose');
  check('a failed refresh surfaces a dismissible error banner', banner !== null && close !== null,
    'banner=' + (banner !== null) + ' close=' + (close !== null));
  if (close !== null) {
    await act(async () => { close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle(30);
  }
  failRefresh = false;
  check('dismissing the error removes the banner',
    container.querySelector('.dshm-error') === null && window.__dshMusicPlayer.getState().error === null,
    'error=' + String(window.__dshMusicPlayer.getState().error));
}

// ── Display-only fallback (unchecked box) ────────────────────────────────────
await chooseRowAction(rows()[1], '.dshm-menuMatch');
await act(async () => { container.querySelector('.dshm-check input').click(); });
await settle(20);
check('unchecking write-file is reflected', container.querySelector('.dshm-check input')?.checked === false);
await act(async () => { container.querySelector('.dshm-cand').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(80);
check('display-only apply sends no /api/apply', applyCalls.length === 1, 'calls=' + applyCalls.length);
check('display-only apply keeps a local override', meta()['b.mp3']?.title === 'Beta Real' && titleOf(rows()[1]) === 'Beta Real', JSON.stringify(meta()));
check('row cover falls back to the proxied artwork', String(rows()[1].querySelector('.dshm-rowCover')?.getAttribute('src')).startsWith('/api/dsh-music/art?u='), String(rows()[1].querySelector('.dshm-rowCover')?.getAttribute('src')));

await chooseRowAction(rows()[1], '.dshm-menuMatch');
// 弹层里的按钮同样不能是装饰品：读了 React 挂在 DOM 上的 props 才能判断。
const dialogButtonWired = (b) => {
  const key = Object.keys(b).find((k) => k.startsWith('__reactProps$'));
  const p = key === undefined ? null : b[key];
  return p !== null && (typeof p.onClick === 'function' || typeof p.onPointerDown === 'function' || p.disabled === true);
};
const dialogButtons = Array.from(container.querySelectorAll('.dshm-dialog button'));
check('every button in the match dialog is wired', dialogButtons.length > 0 && dialogButtons.every(dialogButtonWired), dialogButtons.filter((b) => !dialogButtonWired(b)).map((b) => b.className || '?').join(' | '));
const footerButtons = container.querySelectorAll('.dshm-dialogFoot .dshm-btn');
await act(async () => { footerButtons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(80);
check('clear removes the override', meta()['b.mp3'] === undefined && titleOf(rows()[1]) === 'Beta', JSON.stringify(meta()) + ' ' + titleOf(rows()[1]));

// ── One-click Complete All ───────────────────────────────────────────────────
const beforeBatch = applyCalls.length;
await act(async () => { container.querySelector('.dshm-complete').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(50);
check('confirm bar announces the batch over all tracks', container.querySelector('.dshm-completeGo') !== null && container.querySelector('.dshm-confirmBar').textContent.includes('complete 5'), container.querySelector('.dshm-confirmBar')?.textContent);
await act(async () => { container.querySelector('.dshm-completeGo').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(4000);
const batch = applyCalls.slice(beforeBatch);
check('batch applied the untagged + misnamed tracks in order', batch.length === 3 && batch[0].id === 'b.mp3' && batch[1].id === 'c.mp3' && batch[2].id === 'e.mp3', JSON.stringify(batch.map((c) => c.id)));
check('tagged-but-misnamed track was renamed', rows()[4].title === 'Real E - Epsilon.mp3', rows()[4].title);
check('batch results reflected in the list', Array.from(rows()).some((row) => titleOf(row) === 'Beta Real') && Array.from(rows()).some((row) => titleOf(row) === 'Gamma Real'), Array.from(rows()).map(titleOf).join(','));
check('already-correct track was not rewritten or renamed', !batch.some((call) => call.id.includes('Alpha Real')), JSON.stringify(batch.map((c) => c.id)));
check('low-confidence track was skipped without touching the file', !batch.some((call) => call.id === 'd.mp3') && titleOf(rows()[3]) === 'Delta' && meta()['d.mp3'] === undefined, JSON.stringify(batch.map((c) => c.id)) + ' | ' + titleOf(rows()[3]));
check('progress reset after finishing', container.querySelector('.dshm-complete') !== null && container.querySelector('.dshm-completeStop') === null);

// ── Unload during a batch ────────────────────────────────────────────────────
// Regression: halt() used to leave completing=true, so the loop kept hitting
// /api/match + /api/apply every 600ms after the plugin was torn down.
tracks.push({ id: 'f.mp3', name: 'f.mp3', title: 'Zeta', artist: null, duration: 300, tagged: false });
await act(async () => { container.querySelector('button[aria-label="action.refresh"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(250);
await act(async () => { container.querySelector('.dshm-complete').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(50);
await act(async () => { container.querySelector('.dshm-completeGo').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(150);
check('batch is running before unload', container.querySelector('.dshm-completeStop') !== null);
await act(async () => { for (const cleanup of cleanups) cleanup(); });
await settle(700);
const afterUnload = applyCalls.length;
await settle(1500);
check('unload stops the batch loop', applyCalls.length === afterUnload && container.querySelector('.dshm-complete') !== null, 'applies=' + afterUnload + '->' + applyCalls.length);

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
