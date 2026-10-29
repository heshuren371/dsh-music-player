// 在线补全的封面替换开关（客户端）。
//
// 契约：宿主只在请求里显式带 `replaceCover: true` 时才替换已有的内嵌封面（否则只补缺失）。
// 因此「已有封面的歌改不了」这类现象总是客户端的责任 —— 它必须把用户的意图如实传下去：
//   - 逐首手动应用：用户已经看着候选封面点选，默认替换（可取消勾选）；
//   - 一键补全：默认不动已有封面，勾选「覆盖已有封面」后才替换，且此后**不得**再把
//     「标签与文件名都已正确」的歌当成无需处理（封面正是要写的东西）。
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

const COVER = 'https://is1-ssl.mzstatic.com/image/thumb/Music/300x300bb.jpg';
// ok.mp3：标签与文件名都已正确（默认批量会跳过它）；need.mp3：需要补全；
// nocover.mp3：需要补全，但候选没有封面（此时没有「已有封面」可替换）。
let tracks = [
  { id: 'Real A - Alpha.mp3', name: 'Real A - Alpha.mp3', title: 'Alpha', artist: 'Real A', duration: 300, tagged: true },
  { id: 'need.mp3', name: 'need.mp3', title: 'Beta', artist: null, duration: 300, tagged: false },
  { id: 'nocover.mp3', name: 'nocover.mp3', title: 'Gamma', artist: null, duration: 300, tagged: false },
];
const library = (scannedAt) => ({ dir: '/music', tracks, scanning: false, scanParsed: tracks.length, scanTotal: tracks.length, truncated: false, skippedPackages: 0, scannedAt });
// 候选按**当前**曲目派生（改名后仍稳定），这样同一首歌无论 id 怎么变都拿到同一份元数据。
const TARGETS = { Beta: { title: 'Beta Real', artist: 'Real B' }, Gamma: { title: 'Gamma Real', artist: 'Real G' } };
const NO_COVER_TITLES = new Set(['Gamma Real']);
const applyCalls = [];
const mockFetch = async (url, options) => {
  const target = String(url);
  const parsed = new URL(target, 'http://127.0.0.1');
  if (target.includes('/api/dsh-music/match')) {
    const id = parsed.searchParams.get('p');
    const current = tracks.find((track) => track.id === id);
    const spec = TARGETS[current?.title ?? ''] ?? { title: current?.title ?? id, artist: current?.artist ?? 'A' };
    const cover = NO_COVER_TITLES.has(spec.title) ? undefined : COVER;
    const candidate = { id: 1, title: spec.title, artist: spec.artist, album: 'Album', cover, duration: 301, score: 0.95, auto: true, source: 'qq', sources: ['qq'] };
    return { ok: true, json: async () => ({ term: spec.title, terms: [spec.title], best: candidate, auto: true, candidates: [candidate], errors: [] }) };
  }
  if (target.includes('/api/dsh-music/apply')) {
    const body = JSON.parse(options.body);
    applyCalls.push(body);
    const newName = body.artist + ' - ' + body.title + '.mp3';
    tracks = tracks.map((track) => (track.id === body.id
      ? { ...track, id: newName, name: newName, title: body.title, artist: body.artist, tagged: true }
      : track));
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
  effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
  locale: {
    register: () => {},
    bind: () => (key) => {
      const dict = {
        stats: (n) => n + ' songs',
        'scan.progress': (a, b) => a + '/' + b,
        'complete.progress': (d, tt) => d + '/' + tt,
        'confirm.complete': (n) => 'complete ' + n,
        'complete.replaceCover': 'replace covers',
        'match.replaceCover': 'replace cover',
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
const settle = async (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
await act(async () => { root.render(React.createElement(ViewComponent)); });
await settle(300);

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };
const rows = () => container.querySelectorAll('.dshm-row');
const rowOf = (id) => Array.from(rows()).find((row) => row.title === id);
const openDialog = async (id) => {
  const row = rowOf(id);
  await act(async () => { row.querySelector('.dshm-rowMenuBtn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await settle(40);
  const item = container.querySelector('.dshm-menuMatch');
  if (item !== null) {
    await act(async () => { item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle(80);
  }
};
const applyFirstCandidate = async () => {
  await act(async () => { container.querySelector('.dshm-cand').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await settle(140);
};

// ── D. 一键补全默认不动已有封面 ─────────────────────────────────────────────
// 放在最前：此时 need/nocover 还没被补全，ok 已经是「标签+文件名都正确」的状态。
const runBatch = async (toggleOn) => {
  const before = applyCalls.length;
  await act(async () => { container.querySelector('.dshm-complete').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await settle(60);
  const toggle = container.querySelector('.dshm-coverToggle input');
  if (toggleOn) {
    // React 受控复选框：直接写 .checked 再派发 change 会被 value tracker 吞掉，必须 .click()。
    await act(async () => { toggle.click(); });
    await settle(20);
  }
  await act(async () => { container.querySelector('.dshm-completeGo').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await settle(4000);
  return applyCalls.slice(before);
};
{
  const batch = await runBatch(false);
  check('D1 默认批量一律 replaceCover:false', batch.length > 0 && batch.every((call) => call.replaceCover === false), JSON.stringify(batch.map((c) => [c.id, c.replaceCover])));
  check('D2 标签与文件名都已正确的歌默认被跳过', !batch.some((call) => call.id.includes('Alpha')), JSON.stringify(batch.map((c) => c.id)));
}

// ── E. 勾选「覆盖已有封面」后，已有封面的歌必须轮到 ─────────────────────────
{
  const batch = await runBatch(true);
  check('E1 勾选后批量一律 replaceCover:true', batch.length > 0 && batch.every((call) => call.replaceCover === true), JSON.stringify(batch.map((c) => [c.id, c.replaceCover])));
  check('E2 勾选后「标签已正确但有封面」的歌也会被处理', batch.some((call) => call.id.includes('Alpha')), JSON.stringify(batch.map((c) => c.id)));
}

// ── A. 手动应用默认替换封面 ─────────────────────────────────────────────────
// ── B. 取消勾选 → 不替换 ────────────────────────────────────────────────────
// ── C. 候选没有封面 → 不得声称替换 ──────────────────────────────────────────
await openDialog('Real A - Alpha.mp3');
{
  const boxes = Array.from(container.querySelectorAll('.dshm-dialogFoot .dshm-check input'));
  check('A1 手动对话框有「替换已有封面」开关且默认勾选', boxes.length === 2 && boxes[1].checked === true, 'boxes=' + boxes.length + ' cover=' + (boxes[1] === undefined ? 'missing' : boxes[1].checked));
  await applyFirstCandidate();
  check('A2 手动应用带 replaceCover:true（候选有封面）', applyCalls.at(-1).replaceCover === true, JSON.stringify(applyCalls.at(-1)));
}
{
  await openDialog('Real A - Alpha.mp3');
  const boxes = Array.from(container.querySelectorAll('.dshm-dialogFoot .dshm-check input'));
  await act(async () => { boxes[1].click(); });
  await settle(20);
  const before = applyCalls.length;
  await applyFirstCandidate();
  check('B1 取消勾选后 replaceCover:false（两个方向都断言，恒 true 的接线会红）',
    applyCalls.length === before + 1 && applyCalls[before].replaceCover === false, JSON.stringify(applyCalls[before]));
}
{
  await openDialog('Real G - Gamma Real.mp3');
  const before = applyCalls.length;
  await applyFirstCandidate();
  check('C1 候选无封面时 replaceCover:false（没有可替换的东西）',
    applyCalls.length === before + 1 && applyCalls[before].replaceCover === false, JSON.stringify(applyCalls[before]));
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
