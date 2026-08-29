// Regression test: mid-play stream cut must RESUME the same track (max 2x);
// a load-time error (position 0) must still SKIP to the next track.
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

const audioInstances = [];
const FakeAudio = class extends dom.window.EventTarget {
  constructor() {
    super();
    this.src = ''; this.currentTime = 0; this.duration = NaN; this.volume = 1; this.preload = '';
    this.playCount = 0;
    audioInstances.push(this);
  }
  play() { this.playCount += 1; this.dispatchEvent(new dom.window.Event('play')); return Promise.resolve(); }
  pause() {}
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  setAttribute(name, value) { if (name === 'src') this.src = value; }
};
Object.defineProperty(dom.window, 'Audio', { value: FakeAudio, configurable: true, writable: true });
globalThis.Audio = FakeAudio; // window.eval executes in the Node realm — globals must be here

let pluginFactory = null;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { pluginFactory = factory; } };
const clientJs = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
dom.window.eval(clientJs);
if (pluginFactory === null) throw new Error('factory not captured');

const tracks = [
  { index: 0, id: 'a.mp3', name: 'a.mp3', title: '歌曲甲', artist: '歌手', duration: 300, mime: 'audio/mpeg' },
  { index: 1, id: 'b.mp3', name: 'b.mp3', title: '歌曲乙', artist: '歌手', duration: 240, mime: 'audio/mpeg' },
];
const mockFetch = async () => ({ ok: true, json: async () => ({ dir: '/music', tracks, scanning: false, scanParsed: 2, scanTotal: 2, truncated: false, scannedAt: 1 }) });
globalThis.fetch = mockFetch;
dom.window.fetch = mockFetch;

const plugin = pluginFactory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
let ViewComponent = null;
const ctx = {
  effect: (fn) => fn(),
  // Faithful to the real locale runtime: t(key) without params returns the raw
  // dict value — including function formatters like stats/scan.progress.
  locale: { register: () => {}, bind: () => (key) => { const dict = { 'stats': (n) => n + ' 首', 'scan.progress': (a, b) => a + '/' + b, 'confirm.delete': (t2) => '删除 ' + t2, 'view.music': '音乐', 'action.chooseDir': '选择目录' }; return dict[key] ?? key; } },
  slots: { inject: (name, fn) => fn(), register: (meta, component) => { ViewComponent = component; return () => {}; } },
};
plugin.apply(ctx);
if (ViewComponent === null) throw new Error('music view not registered');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
await act(async () => { root.render(React.createElement(ViewComponent)); });
await act(async () => { await new Promise(r => setTimeout(r, 300)); });

const audio = audioInstances[0];
if (!audio) { console.log('FATAL: no audio instance'); process.exit(1); }
const rows = container.querySelectorAll('.dshm-row');
console.log('rows rendered:', rows.length);
if (rows.length < 2) { console.log('FATAL: tracks not rendered'); process.exit(1); }

// play track 0
await act(async () => { rows[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
console.log('A1. play count after click:', audio.playCount, '| src has a.mp3:', audio.src.includes('a.mp3'));

// mid-play cut at 120s: must resume the SAME track
audio.currentTime = 120; audio.duration = 300;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
await act(async () => { await new Promise(r => setTimeout(r, 700)); });
console.log('A2. after cut: playCount =', audio.playCount, '(expect 2 = resumed)', '| still a.mp3:', audio.src.includes('a.mp3'));

// second cut at same spot: one more resume allowed
audio.currentTime = 122; audio.duration = 300;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
await act(async () => { await new Promise(r => setTimeout(r, 700)); });
console.log('A3. second cut: playCount =', audio.playCount, '(expect 3)', '| still a.mp3:', audio.src.includes('a.mp3'));

// third cut at same spot: retries exhausted -> falls through to skip path ->
// with loop mode and 2 tracks, errorStreak(3) >= rows(2) so it stops with error
audio.currentTime = 124; audio.duration = 300;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
await act(async () => { await new Promise(r => setTimeout(r, 900)); });
console.log('A4. third cut: playCount =', audio.playCount, '(expect 4 = gave up resuming, skipped to b.mp3)', '| src has b.mp3:', audio.src.includes('b.mp3'));

// load-time error (position 0): must skip to the next track
audio.currentTime = 0;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
await act(async () => { await new Promise(r => setTimeout(r, 900)); });
console.log('B1. pos-0 error on b.mp3: wrapped to a.mp3 (skipped again):', audio.src.includes('a.mp3'), '| playCount =', audio.playCount, '(expect 5)');
process.exit(0);