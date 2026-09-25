// 回归：媒体源必须是 **token 直连的绝对地址**，不能是相对 `/api/...`。
//
// 现象：MV 能播，但进度条**一拖就从头开始**（Web 上正常、Desktop 上坏）。
// 根因：`mvCacheUrl()` / `streamUrl()` 在媒体直连基址（来自 `/session`）还没拿到时会
//   退回相对地址 `/api/dsh-music/mvfile?k=…`。Desktop 上相对地址要经 Electron
//   `forwardWebRequest`，**那条路会丢 Range/206** → `<video>` 认为流不可 seek → 一拖回 0。
//   而 `prepareVideo()` 与 `restoreLastPlayed()` 都曾**没有先 await 基址**，
//   刷新页面后 cue 上一首正好走这条路。
// 修法：把 `await ensureStreamBase()` 放进 `prepareVideo()`（一处覆盖全部调用点），
//   并把 `restoreLastPlayed` 的两条分支都用同样的方式包起来。
//
// 本套件把 `/session` 故意延迟 1.2s 造出「基址未就绪」的真实时序，覆盖两类媒体：
//   A. 视频轨 → 必须走 `system-stream?t=…&k=<cacheKey>`（MV 转码产物）
//   B. 音频轨 → 必须走 `system-stream?t=…&p=<trackId>`（音频流）
// 两者是同一根因的两个面；只覆盖 A 会留下「音频那条路」没有门禁。
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { promises as fs } from 'node:fs';

const SOURCE = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const SESSION_DELAY_MS = 1200;   // 故意让 /session 慢：这才是「基址未就绪」的真实时序

const AUDIO = { index: 0, id: 'song.flac', name: 'song.flac', title: 'Song', artist: 'x', duration: 200, kind: 'audio', mime: 'audio/flac' };
const VIDEO = { index: 1, id: 'film.mp4', name: 'film.mp4', title: 'Film', artist: 'x', duration: 300, kind: 'video', mime: 'video/mp4' };
const CACHE_KEY = 'ab9f8c9aeef19ab757b6ca52ae94c21b';

/** 起一个隔离的插件实例，cue 指定的「上次播放曲目」，返回它挂过的所有非空媒体 src。 */
async function bootAndCue(lastId) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:3080/', pretendToBeVisual: true });
  const saved = {
    window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage,
    fetch: globalThis.fetch, Audio: globalThis.Audio, ResizeObserver: globalThis.ResizeObserver,
    MutationObserver: globalThis.MutationObserver, getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };

  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
  const FakeMedia = class extends dom.window.EventTarget {
    constructor() { super(); this._src = ''; this.currentTime = 0; this.duration = NaN; this.volume = 1; this.preload = ''; this.videoWidth = 0; this.readyState = 0; }
    get src() { return this._src; }
    set src(value) { this._src = value; srcs.push(value); }
    play() { return Promise.resolve(); } pause() {} load() {}
    removeAttribute(name) { if (name === 'src') this._src = ''; }
  };
  Object.defineProperty(dom.window, 'Audio', { value: FakeMedia, configurable: true, writable: true });
  globalThis.Audio = FakeMedia;
  dom.window.__dshMusicMedia = () => new FakeMedia();

  dom.window.localStorage.setItem('dsh-music:prefs', JSON.stringify({ last: { id: lastId, time: 0 } }));

  const streamBase = 'http://127.0.0.1:3080/dsh-music/api/system-stream?t=stream-token-xyz';
  const library = { dir: '/music', tracks: [AUDIO, VIDEO], scanning: false, scannedAt: 1, truncated: false };
  const okJson = (body) => ({ ok: true, status: 200, json: async () => body, clone() { return okJson(body); } });
  const mockFetch = async (url) => {
    const target = String(url);
    if (target.includes('/session')) {
      await new Promise((r) => setTimeout(r, SESSION_DELAY_MS));
      return okJson({ systemArtBase: streamBase.replace('system-stream', 'system-art'), systemStreamBase: streamBase });
    }
    if (target.includes('/library') || target.includes('/refresh')) return okJson(library);
    if (target.includes('/mv')) return okJson({ mode: 'remux', state: 'ready', progress: 1, error: null, key: CACHE_KEY, url: '/api/dsh-music/mvfile?k=' + CACHE_KEY });
    return okJson({});
  };
  globalThis.fetch = mockFetch;
  dom.window.fetch = mockFetch;

  let factory = null;
  dom.window.__ModuleLoader__ = { load: ({ factory: f }) => { factory = f; } };
  dom.window.eval(SOURCE);
  const plugin = factory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
  let ViewComponent = null;
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (key) => (({ stats: (n) => String(n), 'scan.progress': (a, b) => a + '/' + b })[key] ?? key) },
    slots: { inject: (_n, fn) => fn(), register: (_meta, c) => { ViewComponent = c; return () => {}; } },
  };
  plugin.apply(ctx);
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(ViewComponent)); });
  await act(async () => { await new Promise((r) => setTimeout(r, SESSION_DELAY_MS + 1400)); });

  Object.assign(globalThis, saved);
  return srcs.filter((s) => typeof s === 'string' && s.length > 0);
}

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

// ── A. 视频轨（MV）：绝对 token 地址 + &k=<cacheKey> ────────────────────────
{
  const srcs = await bootAndCue(VIDEO.id);
  check('A1: MV restore attached a media source', srcs.length >= 1, JSON.stringify(srcs).slice(0, 160));
  check('A2: MV source is not a relative /api path (relative loses Range on Desktop → no seek)',
    !srcs.some((s) => s.startsWith('/api/')), srcs.join(' '));
  check('A3: MV source is the absolute token URL carrying the cache key',
    srcs.some((s) => s.startsWith('http://127.0.0.1:') && s.includes('system-stream?t=') && s.includes('&k=' + CACHE_KEY)),
    srcs.join(' '));
}

// ── B. 音频轨：绝对 token 地址 + &p=<trackId>（同一根因的另一半）────────────
{
  const srcs = await bootAndCue(AUDIO.id);
  check('B1: audio restore attached a media source', srcs.length >= 1, JSON.stringify(srcs).slice(0, 160));
  check('B2: audio source is not a relative /api path (same root cause as MV)',
    !srcs.some((s) => s.startsWith('/api/')), srcs.join(' '));
  check('B3: audio source is the absolute token URL carrying the track id',
    srcs.some((s) => s.startsWith('http://127.0.0.1:') && s.includes('system-stream?t=') && s.includes('&p=' + encodeURIComponent(AUDIO.id))),
    srcs.join(' '));
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
