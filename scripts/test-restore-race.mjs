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
const tracks = [A, B];
const mockFetch = async () => ({ ok: true, json: async () => ({ dir: '/music', tracks, scanning: false, scanParsed: 2, scanTotal: 2, truncated: false, scannedAt: 1 }) });
globalThis.fetch = mockFetch;
dom.window.fetch = mockFetch;
localStorage.setItem('dsh-music:prefs', JSON.stringify({ last: { id: 'b.mp3', time: 100 } }));

const plugin = pluginFactory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
let ViewComponent = null;
const teardown = [];
const ctx = {
  effect: (fn, label) => { const d = fn(); if (typeof d === 'function') teardown.push({ label, d }); return d; },
  locale: {
    register: () => {},
    bind: () => (key) => {
      const dict = { stats: (n) => n + ' songs', 'scan.progress': (a, b) => a + '/' + b, 'confirm.delete': (title) => 'delete ' + title };
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
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };
// ── restoreLastPlayed race: a pending loadedmetadata seek must not hijack a
// track the user picked meanwhile ────────────────────────────────────────────
await act(async () => { root.render(React.createElement(ViewComponent)); });
await settle(300);
const audio = audioInstances[0];
const rows = () => container.querySelectorAll('.dshm-row');
check('restored the last track (b.mp3) paused', audio.src.includes('b.mp3') && audio.playCount === 0, 'src=' + audio.src + ' playCount=' + audio.playCount);
await act(async () => { rows()[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
check('user picked a.mp3', audio.src.includes('a.mp3') && audio.playCount === 1, 'src=' + audio.src);
audio.duration = 300;
await act(async () => { audio.dispatchEvent(new dom.window.Event('loadedmetadata')); });
check('stale metadata seek ignored (currentTime stays 0)', audio.currentTime === 0, 'currentTime=' + audio.currentTime);

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);