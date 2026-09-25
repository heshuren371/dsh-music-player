// MV 快进回归：媒体源必须是 **token 直连的绝对地址**，不能是相对 `/api/...`。
//
// 现象：MV 能播，但进度条**一拖就从头开始**。
// 根因：`mvCacheUrl()` 在媒体直连基址（来自 `/session`）还没拿到时会退回相对地址
//       `/api/dsh-music/mvfile?k=…`。Desktop 上相对地址要经 Electron
//       `forwardWebRequest`，**那条路会丢 Range/206** → `<video>` 认为流不可 seek。
//       而 `restoreLastPlayed()` 与几处 error→转码升级**都没有先 await 基址**，
//       刷新页面后 cue 上一首正好走这条路。
// 修法：把 `await ensureStreamBase()` 放进 `prepareVideo()`（一处覆盖全部调用点），
//       并把 `restoreLastPlayed` 的音频分支也用同样的方式包起来。
//
// 断言只看可观察结果：挂上去的 src 是不是绝对 token 地址。
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

const srcs = [];
const FakeAudio = class extends dom.window.EventTarget {
  constructor() { super(); this._src = ''; this.currentTime = 0; this.duration = NaN; this.volume = 1; this.preload = ''; this.seekable = { length: 1, start: () => 0, end: () => 100 }; }
  get src() { return this._src; }
  set src(value) { this._src = value; srcs.push(value); }
  play() { return Promise.resolve(); } pause() {} load() {}
  removeAttribute(name) { if (name === 'src') this._src = ''; }
};
Object.defineProperty(dom.window, 'Audio', { value: FakeAudio, configurable: true, writable: true });
globalThis.Audio = FakeAudio;
window.__dshMusicMedia = () => new FakeAudio();

// 刷新后 cue「上次播放的曲目」——正是走 restoreLastPlayed 的那条路
localStorage.setItem('dsh-music:prefs', JSON.stringify({ last: { id: 'film.mp4', time: 0 } }));

const SESSION_STREAM_BASE = 'http://127.0.0.1:3080/dsh-music/api/system-stream?t=stream-token-xyz';
const VIDEO = { index: 0, id: 'film.mp4', name: 'film.mp4', title: 'Film', artist: 'x', duration: 300, kind: 'video', mime: 'video/mp4' };
const library = { dir: '/music', tracks: [VIDEO], scanning: false, scannedAt: 1, truncated: false };
const okJson = (body) => ({ ok: true, status: 200, json: async () => body, clone() { return okJson(body); } });

let sessionDelayMs = 1200;  // 故意让 /session 慢：这才是「基址未就绪」的真实时序
const mockFetch = async (url) => {
  const target = String(url);
  if (target.includes('/session')) {
    if (sessionDelayMs > 0) await new Promise((r) => setTimeout(r, sessionDelayMs));
    return okJson({ systemArtBase: SESSION_STREAM_BASE.replace('system-stream', 'system-art'), systemStreamBase: SESSION_STREAM_BASE });
  }
  if (target.includes('/library') || target.includes('/refresh')) return okJson(library);
  if (target.includes('/mv')) return okJson({ mode: 'remux', state: 'ready', progress: 1, error: null, key: 'ab9f8c9aeef19ab757b6ca52ae94c21b', url: '/api/dsh-music/mvfile?k=ab9f8c9aeef19ab757b6ca52ae94c21b' });
  if (target.includes('/caps')) return okJson({});
  return okJson({});
};
globalThis.fetch = mockFetch;
dom.window.fetch = mockFetch;

let pluginFactory = null;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { pluginFactory = factory; } };
dom.window.eval(await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8'));

const plugin = pluginFactory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
let ViewComponent = null;
const ctx = {
  effect: (fn) => fn(),
  locale: { register: () => {}, bind: () => (key) => (({ stats: (n) => String(n), 'scan.progress': (a, b) => a + '/' + b })[key] ?? key) },
  slots: { inject: (_n, fn) => fn(), register: (_meta, c) => { ViewComponent = c; return () => {}; } },
};
plugin.apply(ctx);
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
await act(async () => { root.render(React.createElement(ViewComponent)); });
await act(async () => { await new Promise((r) => setTimeout(r, 2500)); });

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

const media = srcs.filter((s) => s.length > 0);
check('restore attached a media source', media.length >= 1, JSON.stringify(media).slice(0, 160));
const relative = media.filter((s) => s.startsWith('/api/dsh-music/mvfile') || s.startsWith('/api/dsh-music/stream'));
check('A: MV source is not a relative /api path (relative loses Range on Desktop → no seek)',
  relative.length === 0, relative.join(' '));
const absolute = media.filter((s) => s.startsWith('http://127.0.0.1:') && s.includes('system-stream?t='));
check('B: MV source is the absolute token URL (Range preserved → the progress bar can seek)',
  absolute.some((s) => s.includes('&k=')), media.join(' '));
check('C: the token URL keeps the cache key so it serves the converted file',
  absolute.some((s) => s.includes('&k=ab9f8c9aeef19ab757b6ca52ae94c21b')), media.join(' '));

// 注：这里只保留「/session 慢 1.2s」这一个场景。慢会话才是真正的判别用例——
// 若 prepareVideo 没 await 基址，它就会拼出相对地址并被下面 A 抓住。
// 曾想再加一个「重启后立刻播放」的场景，但同一个 player 实例的 lastPlayedRestored
// 已置位、restore 不会重跑，那条断言没有判别力，已删除。

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
