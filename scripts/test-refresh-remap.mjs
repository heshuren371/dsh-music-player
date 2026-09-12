// Regression: refreshing the same library must (a) keep the rows visible while
// the host scans and (b) re-map the playing track by stable id when the new
// list lands — never leave state.current pointing at a stale array index.
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
};
Object.defineProperty(dom.window, 'Audio', { value: FakeAudio, configurable: true, writable: true });
globalThis.Audio = FakeAudio;

let pluginFactory = null;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { pluginFactory = factory; } };
dom.window.eval(await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8'));
if (pluginFactory === null) throw new Error('factory not captured');

const A = { index: 0, id: 'a.mp3', name: 'a.mp3', title: 'A', artist: 'x', duration: 300, mime: 'audio/mpeg' };
const B = { index: 1, id: 'b.mp3', name: 'b.mp3', title: 'B', artist: 'y', duration: 300, mime: 'audio/mpeg' };
let phase = 'initial';
const payload = () => {
  if (phase === 'initial') return { dir: '/music', tracks: [A, B], scanning: false, scanParsed: 2, scanTotal: 2, truncated: false, scannedAt: 1 };
  if (phase === 'scanning') return { dir: '/music', tracks: [], scanning: true, scanParsed: 0, scanTotal: 0, truncated: false, scannedAt: null };
  return { dir: '/music', tracks: [B, A], scanning: false, scanParsed: 2, scanTotal: 2, truncated: false, scannedAt: 2 };
};
const mockFetch = async (url) => {
  if (String(url).includes('/api/refresh')) { phase = 'scanning'; return { ok: true, json: async () => payload() }; }
  return { ok: true, json: async () => payload() };
};
globalThis.fetch = mockFetch;
dom.window.fetch = mockFetch;

const plugin = pluginFactory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
let ViewComponent = null;
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: () => {},
    bind: () => (key) => {
      const dict = {
        stats: (n) => n + ' songs',
        'scan.progress': (a, b) => a + '/' + b,
        'confirm.delete': (title) => 'delete ' + title,
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
const activeIndex = () => Array.from(rows()).findIndex((r) => r.className.includes('dshm-row--active'));
const audio = audioInstances[0];

check('rows rendered initially', rows().length === 2, 'rows=' + rows().length);
await act(async () => { rows()[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
check('A plays a.mp3', audio.src.includes('a.mp3') && activeIndex() === 0, 'src=' + audio.src + ' active=' + activeIndex());

// Refresh: same dir, host starts a scan and returns an empty track list.
const refreshBtn = container.querySelector('button[aria-label="action.refresh"]');
await act(async () => { refreshBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(250);
check('rows survive the scanning phase (no blank table)', rows().length === 2, 'rows=' + rows().length);

// Scan completes; the new order is [B, A] so the playing track moved to index 1.
phase = 'done';
await settle(1900);
check('rows loaded after scan', rows().length === 2, 'rows=' + rows().length);
check('playing track re-mapped by id (active row = 1)', activeIndex() === 1, 'active=' + activeIndex());
check('audio still on a.mp3', audio.src.includes('a.mp3'), 'src=' + audio.src);

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
