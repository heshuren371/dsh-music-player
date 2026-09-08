// Regression test for the progress bar smoothness work:
//  1. playback ticks must NOT re-render the track table (the old code
//     re-rendered it on every rAF frame — the cause of the lag),
//  2. the fill + clock must follow the audio clock / the pointer,
//  3. a drag must commit exactly once on release (and survive leaving the track),
//  4. the resume position must be persisted at most every ~5s, flushed on pause.
import { JSDOM } from 'jsdom';
import { promises as fs } from 'node:fs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:3080/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
dom.window.Element.prototype.scrollIntoView = function () {};

// React snapshots canUseDOM at import time: the DOM globals must exist first,
// otherwise its range-input onChange path degrades to the focusin polyfill.
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');

const audioInstances = [];
const FakeAudio = class extends dom.window.EventTarget {
  constructor() {
    super();
    this.src = ''; this.currentTime = 0; this.duration = NaN; this.volume = 1; this.preload = '';
    this.playCount = 0;
    audioInstances.push(this);
  }
  play() { this.playCount += 1; this.dispatchEvent(new dom.window.Event('play')); return Promise.resolve(); }
  pause() { this.dispatchEvent(new dom.window.Event('pause')); }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  setAttribute(name, value) { if (name === 'src') this.src = value; }
};
Object.defineProperty(dom.window, 'Audio', { value: FakeAudio, configurable: true, writable: true });
globalThis.Audio = FakeAudio;

// Count TrackTable renders by watching how often it builds its <tbody>.
let tbodyRenders = 0;
const spyCreateElement = (type, props, ...children) => {
  if (type === 'tbody') tbodyRenders += 1;
  return React.createElement(type, props, ...children);
};
const reactForPlugin = { ...React, createElement: spyCreateElement };

let pluginFactory = null;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { pluginFactory = factory; } };
// DSH_MUSIC_CLIENT lets the same test run against another build (A/B check).
const clientPath = process.env.DSH_MUSIC_CLIENT ?? new URL('../lib/client.js', import.meta.url);
dom.window.eval(await fs.readFile(clientPath, 'utf8'));
if (pluginFactory === null) throw new Error('factory not captured');

const tracks = [
  { index: 0, id: 'a.mp3', name: 'a.mp3', title: '歌曲甲', artist: '歌手', duration: 300, mime: 'audio/mpeg' },
  { index: 1, id: 'b.mp3', name: 'b.mp3', title: '歌曲乙', artist: '歌手', duration: 240, mime: 'audio/mpeg' },
];
const mockFetch = async () => ({ ok: true, json: async () => ({ dir: '/music', tracks, scanning: false, scanParsed: 2, scanTotal: 2, truncated: false, scannedAt: 1 }) });
globalThis.fetch = mockFetch;
dom.window.fetch = mockFetch;

const plugin = pluginFactory((name) => {
  if (name === 'react') return reactForPlugin;
  throw new Error('require: ' + name);
});
let ViewComponent = null;
const ctx = {
  effect: (fn) => fn(),
  // Faithful to the locale runtime: formatter keys return functions.
  locale: {
    register: () => {},
    bind: () => (key) => {
      const dict = {
        stats: (n) => n + ' 首',
        'scan.progress': (a, b) => a + '/' + b,
        'confirm.delete': (title) => '删除 ' + title,
      };
      return dict[key] ?? key;
    },
  },
  slots: { inject: (name, fn) => fn(), register: (meta, component) => { ViewComponent = component; return () => {}; } },
};
plugin.apply(ctx);
if (ViewComponent === null) throw new Error('music view not registered');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
await act(async () => { root.render(React.createElement(ViewComponent)); });
await act(async () => { await new Promise((r) => setTimeout(r, 300)); });

const audio = audioInstances[0];
if (!audio) { console.log('FATAL: no audio instance'); process.exit(1); }
const rows = container.querySelectorAll('.dshm-row');
if (rows.length !== 2) { console.log('FATAL: tracks not rendered'); process.exit(1); }

const slider = container.querySelector('.dshm-progress .dshm-slider');
const clock = container.querySelector('.dshm-progress .dshm-time');
// --p is a CSS percentage ("40%") in the original slider style.
const fill = () => Number.parseFloat(slider.style.getPropertyValue('--p'));
const prefs = () => JSON.parse(dom.window.localStorage.getItem('dsh-music:prefs') ?? '{}');
const settle = async (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const fire = async (node, event) => act(async () => { node.dispatchEvent(event); });
// React's value tracker swallows a plain `node.value = x`, so drive the native setter.
const setValue = (value) => Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(slider, value);
const tick = async (at) => {
  audio.currentTime = at;
  await fire(audio, new dom.window.Event('timeupdate'));
  await settle(40);
};
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail));
};

// ── A. playback drives the fill without touching the list ───────────────────
await act(async () => { rows[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
audio.duration = 300;
const baseRenders = tbodyRenders; // baseline after the track-switch render
check('A1 click plays track 0', audio.playCount === 1 && audio.src.includes('a.mp3'), 'playCount=' + audio.playCount);
await tick(0.5);
await tick(1.2);
await tick(2.7);
check('A2 fill tracks the audio clock', fill() > 0 && fill() < 2, '--p=' + fill().toFixed(3));
check('A3 clock shows elapsed second', clock.textContent === '0:02', 'clock=' + clock.textContent);
check('A4 slider value follows the clock', Number(slider.value) > 2 && Number(slider.value) < 3, 'value=' + slider.value);
check('A5 playback re-rendered no table rows', tbodyRenders === baseRenders, 'tbody renders=' + tbodyRenders + ' (base ' + baseRenders + ')');

// ── B. dragging follows the pointer and commits once on release ─────────────
const dragStartRenders = tbodyRenders;
await fire(slider, new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
setValue(120);
await fire(slider, new dom.window.Event('input', { bubbles: true }));
check('B1 fill follows the pointer mid-drag', Math.abs(fill() - 40) < 0.01, '--p=' + fill().toFixed(2));
check('B2 clock previews the drag position', clock.textContent === '2:00', 'clock=' + clock.textContent);
check('B3 drag re-rendered no table rows', tbodyRenders === dragStartRenders, 'tbody renders=' + tbodyRenders);
setValue(150);
await fire(slider, new dom.window.MouseEvent('pointermove', { bubbles: true }));
await fire(slider, new dom.window.Event('input', { bubbles: true }));
await fire(slider, new dom.window.MouseEvent('pointerup', { bubbles: true }));
check('B4 release commits the dragged position', Math.abs(audio.currentTime - 150) < 0.001, 'currentTime=' + audio.currentTime);
check('B5 fill stays on the committed value', Math.abs(fill() - 50) < 0.01, '--p=' + fill().toFixed(2));

// ── C. non-pointer changes (keyboard / wheel) seek immediately ──────────────
setValue(30);
await fire(slider, new dom.window.Event('input', { bubbles: true }));
check('C1 keyboard-style input seeks at once', Math.abs(audio.currentTime - 30) < 0.001, 'currentTime=' + audio.currentTime);

// ── D. a track switch still re-renders the list ─────────────────────────────
const switchRenders = tbodyRenders;
await act(async () => { container.querySelectorAll('.dshm-row')[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
check('D1 switching tracks re-renders the rows', tbodyRenders > switchRenders, 'tbody renders=' + tbodyRenders);

// ── E. resume position is throttled, then flushed on pause ──────────────────
audio.duration = 240;
audio.currentTime = 0;
await fire(audio, new dom.window.Event('timeupdate'));
const savedAt0 = prefs().last?.time;
await tick(1);
await tick(2);
await tick(3);
check('E1 position write is throttled (<5s)', prefs().last?.time === savedAt0, 'saved=' + prefs().last?.time);
await fire(audio, new dom.window.Event('pause'));
check('E2 pause flushes the exact position', prefs().last?.time === 3, 'saved=' + prefs().last?.time);

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
