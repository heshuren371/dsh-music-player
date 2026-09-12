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
  locale: {
    register: () => {},
    bind: () => (key) => {
      const dict = { stats: (n) => n + ' 首', 'scan.progress': (a, b) => a + '/' + b, 'confirm.delete': (title) => '删除 ' + title, 'view.music': '音乐', 'action.chooseDir': '选择目录' };
      return dict[key] ?? key;
    },
  },
  slots: { inject: (_name, fn) => fn(), register: (_meta, component) => { ViewComponent = component; return () => {}; } },
};
plugin.apply(ctx);
if (ViewComponent === null) throw new Error('music view not registered');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
await act(async () => { root.render(React.createElement(ViewComponent)); });
await act(async () => { await new Promise((r) => setTimeout(r, 300)); });

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

const audio = audioInstances[0];
if (!audio) { console.log('FATAL: no audio instance'); process.exit(1); }
const rows = container.querySelectorAll('.dshm-row');
check('two rows rendered', rows.length === 2, 'rows=' + rows.length);
if (rows.length < 2) { console.log('FATAL: tracks not rendered'); process.exit(1); }

// A1: clicking a row starts playback of that row's track.
await act(async () => { rows[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
check('A1 click plays a.mp3', audio.playCount === 1 && audio.src.includes('a.mp3'), 'playCount=' + audio.playCount + ' src=' + audio.src);

// A2: mid-play cut at 120s -> resume the SAME track from the cut position.
audio.currentTime = 120; audio.duration = 300;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
check('A2 mid-play cut resumes a.mp3', audio.playCount === 2 && audio.src.includes('a.mp3'), 'playCount=' + audio.playCount);

// A3: a second cut at the same spot -> one more resume allowed.
audio.currentTime = 122; audio.duration = 300;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
check('A3 second cut resumes once more', audio.playCount === 3 && audio.src.includes('a.mp3'), 'playCount=' + audio.playCount);

// A4: third cut -> retries exhausted; loop mode with 2 tracks, errorStreak(3)
// >= rows(2) so the give-up path skips to b.mp3 instead of stopping on a.mp3.
audio.currentTime = 124; audio.duration = 300;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
check('A4 third cut gives up and skips to b.mp3', audio.playCount === 4 && audio.src.includes('b.mp3'), 'playCount=' + audio.playCount + ' src=' + audio.src);

// B1: a load-time error (position 0) must still skip rather than resume.
audio.currentTime = 0;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
check('B1 position-0 error skips to a.mp3', audio.playCount === 5 && audio.src.includes('a.mp3'), 'playCount=' + audio.playCount + ' src=' + audio.src);

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
