// Delete-flow regression: the in-app confirm bar must gate the destructive
// POST, cancel must not delete, confirm must send the stable id, and deleting
// the playing track must stop playback instead of leaving the highlight stale.
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

const A = { index: 0, id: 'a.mp3', name: 'a.mp3', title: 'Alpha', artist: 'x', duration: 300, mime: 'audio/mpeg' };
const B = { index: 1, id: 'b.mp3', name: 'b.mp3', title: 'Beta', artist: 'y', duration: 300, mime: 'audio/mpeg' };
const deleteCalls = [];
const mockFetch = async (url, options) => {
  const target = String(url);
  if (target.includes('/api/delete')) {
    deleteCalls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ dir: '/music', tracks: [B], scanning: false, scanParsed: 1, scanTotal: 1, truncated: false, scannedAt: 2 }) };
  }
  return { ok: true, json: async () => ({ dir: '/music', tracks: [A, B], scanning: false, scanParsed: 2, scanTotal: 2, truncated: false, scannedAt: 1 }) };
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
      const dict = { stats: (n) => n + ' songs', 'scan.progress': (a, b) => a + '/' + b, 'confirm.delete': (title) => 'delete ' + title + '?' };
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
const audio = audioInstances[0];

check('two rows rendered', rows().length === 2, 'rows=' + rows().length);
await act(async () => { rows()[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
check('row click plays Alpha', audio.src.includes('a.mp3'), 'src=' + audio.src);

// Cancel path first: it must not call the host.
await act(async () => { rows()[0].querySelector('.dshm-del').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(50);
check('confirm bar appears for the right track', container.querySelector('.dshm-confirmBar') !== null && container.querySelector('.dshm-confirmBar').textContent.includes('delete Alpha?'), 'bar=' + container.querySelector('.dshm-confirmBar')?.textContent);
check('delete is not sent before confirmation', deleteCalls.length === 0, 'calls=' + deleteCalls.length);
await act(async () => { container.querySelector('.dshm-confirmBar .dshm-btn:not(.dshm-btn--danger)').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(50);
check('cancel closes the bar without deleting', container.querySelector('.dshm-confirmBar') === null && deleteCalls.length === 0, 'bar=' + container.querySelector('.dshm-confirmBar') + ' calls=' + deleteCalls.length);

// Confirm path: stable id must be sent, playing track stops.
await act(async () => { rows()[0].querySelector('.dshm-del').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(50);
await act(async () => { container.querySelector('.dshm-confirmBar .dshm-btn--danger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await settle(100);
check('confirm sends the stable id', deleteCalls.length === 1 && deleteCalls[0].id === 'a.mp3', JSON.stringify(deleteCalls));
check('list replaced with the server payload', rows().length === 1, 'rows=' + rows().length);
check('deleting the playing track stops playback', audio.src === '' && container.querySelector('.dshm-row--active') === null, 'src=' + JSON.stringify(audio.src));

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
