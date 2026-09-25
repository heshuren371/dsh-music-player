// Regression test for mid-track failure recovery:
//   A. a transient cut retries once at the same position;
//   B. repeated failure at the same spot = a locally damaged file: step forward
//      over the bad region (1.5s, then 6s) instead of dropping the whole track;
//   C. once the forward budget is spent, give up -> error + auto-skip;
//   D. a load-time failure (position 0) still skips, and moving 5s past a
//      failure restores the retry budget for a later, independent bad spot.
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
globalThis.Audio = FakeAudio;
window.__dshMusicMedia = () => new FakeAudio();

let pluginFactory = null;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { pluginFactory = factory; } };
dom.window.eval(await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8'));
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
const settle = async (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const audio = audioInstances[0];
if (!audio) { console.log('FATAL: no audio instance'); process.exit(1); }
const rows = container.querySelectorAll('.dshm-row');
check('two rows rendered', rows.length === 2, 'rows=' + rows.length);
if (rows.length < 2) { console.log('FATAL: tracks not rendered'); process.exit(1); }

const failAt = async (at) => {
  audio.currentTime = at;
  await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
  await settle(700);
  audio.duration = 300;
  await act(async () => { audio.dispatchEvent(new dom.window.Event('loadedmetadata')); });
  await settle(50);
};

await act(async () => { rows[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
check('A1 click plays a.mp3', audio.playCount === 1 && audio.src.includes('a.mp3'), 'playCount=' + audio.playCount);

await failAt(120);
check('A2 cut retries at the same position', audio.playCount === 2 && audio.src.includes('a.mp3') && Math.abs(audio.currentTime - 120) < 0.01, 'playCount=' + audio.playCount + ' t=' + audio.currentTime);

audio.currentTime = 120;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
await settle(700);
audio.duration = 300;
await act(async () => { audio.dispatchEvent(new dom.window.Event('loadedmetadata')); });
await settle(50);
check('A3 repeated damage jumps 1.5s forward', audio.playCount === 3 && audio.src.includes('a.mp3') && Math.abs(audio.currentTime - 121.5) < 0.01, 'playCount=' + audio.playCount + ' t=' + audio.currentTime);

audio.currentTime = 121.5;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
await settle(700);
audio.duration = 300;
await act(async () => { audio.dispatchEvent(new dom.window.Event('loadedmetadata')); });
await settle(50);
check('A4 second damage jumps 6s forward', audio.playCount === 4 && audio.src.includes('a.mp3') && Math.abs(audio.currentTime - 127.5) < 0.01, 'playCount=' + audio.playCount + ' t=' + audio.currentTime);

audio.currentTime = 127.5;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
check('A5 exhausted budget surfaces the error', audio.playCount === 4, 'playCount=' + audio.playCount);
await settle(900);
check('A5 then skips to b.mp3', audio.playCount === 5 && audio.src.includes('b.mp3'), 'playCount=' + audio.playCount + ' src=' + audio.src);

audio.currentTime = 0;
await act(async () => { audio.dispatchEvent(new dom.window.Event('error')); });
await settle(900);
check('B1 position-0 error skips back to a.mp3', audio.playCount === 6 && audio.src.includes('a.mp3'), 'playCount=' + audio.playCount + ' src=' + audio.src);

await failAt(50);
check('C1 first failure at 50 retries in place', audio.playCount === 7 && Math.abs(audio.currentTime - 50) < 0.01, 'playCount=' + audio.playCount + ' t=' + audio.currentTime);
audio.currentTime = 60;
await act(async () => { audio.dispatchEvent(new dom.window.Event('timeupdate')); });
await failAt(60);
check('C2 a later independent bad spot retries again', audio.playCount === 8 && audio.src.includes('a.mp3') && Math.abs(audio.currentTime - 60) < 0.01, 'playCount=' + audio.playCount + ' t=' + audio.currentTime);

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
