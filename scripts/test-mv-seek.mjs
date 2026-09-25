// 回归：媒体源必须是 **token 直连的绝对地址**，且基址拿不到时要能自愈。
//
// 现象（真机读数）：`seek asked=108.4 now=0.3 dur=260.4 seekable=1(0.0..0.0) src=rel`
//   —— `seekable=[0,0]` 表示媒体元素**完全不能 seek**，所以一拖就从头播。
// 成因链：
//   ① `mvCacheUrl()` / `streamUrl()` 在媒体直连基址（来自 /session）为空时退回**相对**
//      地址；Desktop 上相对地址经 Electron `forwardWebRequest` 会**丢 Range/206**；
//   ② 而基址之所以拿不到，是因为平台 `/api` 的 `admit()` 在**路由之前**判 Host/Origin
//      栅栏 + 浏览器会话，Desktop 渲染进程拿 `/api/dsh-music/session` 得到的是
//      **401/403 而不是 404** —— A1-02 的通用回落只在 404 触发，于是永远回落不了。
// 修法：
//   A. `/session` 有**自己的**回环回落（它是唯一「以下发回环 token 基址为目的」的端点，
//      那个基址存在的意义就是绕开平台栅栏）；
//   B. `ensureStreamBase()` 拿不到就作废缓存**重取一次**，不再「超时就算了」；
//   C. 按**可观测症状**兜底自愈：非 token 源 + 时长已知 + seekable=[0,0] ⇒ 重取基址后
//      用 token 地址重挂同一媒体并回到原位。
//
// 本套件覆盖三类媒体与三条成因：
//   A. 视频轨（正常）→ 绝对 token 地址 + &k=<cacheKey>
//   B. 音频轨（正常）→ 绝对 token 地址 + &p=<trackId>
//   C. /session 被平台栅栏拒（401）→ 必须靠回环前缀拿到基址，仍是绝对 token 地址
//   D. 源不可 seek（seekable=[0,0]）→ 必须自愈重挂成 token 地址
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { promises as fs } from 'node:fs';

const SOURCE = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const SESSION_DELAY_MS = 1200;   // 让 /session 慢：造出「基址未就绪」的真实时序

const AUDIO = { index: 0, id: 'song.flac', name: 'song.flac', title: 'Song', artist: 'x', duration: 200, kind: 'audio', mime: 'audio/flac' };
const VIDEO = { index: 1, id: 'film.mp4', name: 'film.mp4', title: 'Film', artist: 'x', duration: 300, kind: 'video', mime: 'video/mp4' };
const CACHE_KEY = 'ab9f8c9aeef19ab757b6ca52ae94c21b';
const STREAM_BASE = 'http://127.0.0.1:3080/dsh-music/api/system-stream?t=stream-token-xyz';

/**
 * 起一个隔离的插件实例，cue「上次播放曲目」，返回它挂过的所有媒体 src。
 * opts.gateSession  —— 平台 /api 的 /session 答 401（模拟 Desktop 的 admit() 栅栏）
 * opts.failSessionForMs —— 开头这段时间内 /session 一律失败（用**时间窗**而不是次数：
 *                          客户端在 ensureStreamBase 里有 2s+4s 的重试预算，按次数写死会
 *                          和内部实现耦合、一改就失效）。只有窗口长于那个预算，才能真正
 *                          走到「相对地址 → 不可 seek」那一步，从而验证自愈。
 * opts.unseekable   —— 假媒体元素报告 seekable=[0,0]（模拟丢 Range 的源）
 */
async function bootAndCue(lastId, opts = {}) {
  const { gateSession = false, failSessionForMs = 0, unseekable = false, waitMs } = opts;
  const startedAt = Date.now();
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
  const media = [];
  const FakeMedia = class extends dom.window.EventTarget {
    constructor() {
      super();
      this._src = ''; this.currentTime = 0; this.duration = 260.4; this.volume = 1; this.preload = '';
      this.videoWidth = 0; this.readyState = 4; this.paused = true; this.error = null;
      // 丢 Range 的源：seekable 恒 [0,0]
      this.seekable = unseekable
        ? { length: 1, start: () => 0, end: () => 0 }
        : { length: 1, start: () => 0, end: () => 260.4 };
      media.push(this);
    }
    get src() { return this._src; }
    // 真实媒体元素一定有 currentSrc；夹具少了它会让「不可 seek」的自愈路径失真。
    get currentSrc() { return this._src; }
    set src(value) {
      this._src = value;
      srcs.push(value);
      // 真浏览器在换源并解析到元数据后触发 loadedmetadata —— 自愈逻辑靠它触发。
      setTimeout(() => {
        const event = new dom.window.Event('loadedmetadata');
        this.dispatchEvent(event);
      }, 20);
    }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute(name) { if (name === 'src') this._src = ''; }
  };
  Object.defineProperty(dom.window, 'Audio', { value: FakeMedia, configurable: true, writable: true });
  globalThis.Audio = FakeMedia;
  dom.window.__dshMusicMedia = () => new FakeMedia();

  dom.window.localStorage.setItem('dsh-music:prefs', JSON.stringify({ last: { id: lastId, time: 0 } }));

  const library = { dir: '/music', tracks: [AUDIO, VIDEO], scanning: false, scannedAt: 1, truncated: false };
  const okJson = (body) => ({ ok: true, status: 200, json: async () => body, clone() { return okJson(body); } });
  const fail = (status, text) => ({ ok: false, status, json: async () => ({ error: text }), clone() { return fail(status, text); } });
  const requested = [];
  const mockFetch = async (url) => {
    const target = String(url);
    requested.push(target);
    // 插件自建的回环前缀（旧前缀）—— 必须先于 /session 的通用匹配判断
    if (target.includes('/session')) {
      if (Date.now() - startedAt < failSessionForMs) return fail(401, 'unauthorized');
      if (target.startsWith('/dsh-music/api/session')) {
        await new Promise((r) => setTimeout(r, 30));
        return okJson({ systemArtBase: STREAM_BASE.replace('system-stream', 'system-art'), systemStreamBase: STREAM_BASE });
      }
      if (gateSession) return fail(401, 'unauthorized');   // 平台 admit() 在路由前就拒了
      await new Promise((r) => setTimeout(r, SESSION_DELAY_MS));
      return okJson({ systemArtBase: STREAM_BASE.replace('system-stream', 'system-art'), systemStreamBase: STREAM_BASE });
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
  // 足够久：等 /session（可能延迟 1.2s）+ 自愈的 700ms 定时器 + 重挂
  await act(async () => { await new Promise((r) => setTimeout(r, waitMs ?? (SESSION_DELAY_MS + 3200))); });

  const result = { srcs: srcs.filter((s) => typeof s === 'string' && s.length > 0), media, requested };
  Object.assign(globalThis, saved);
  return result;
}

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };
const isToken = (s, extra) => s.startsWith('http://127.0.0.1:') && s.includes('system-stream?t=') && (extra === undefined || s.includes(extra));
const badRel = (arr) => arr.filter((s) => !s.startsWith('http'));

// ── A. 视频轨（正常）：绝对 token 地址 + &k=<cacheKey> ──────────────────────
{
  const { srcs } = await bootAndCue(VIDEO.id);
  check('A1: MV restore attached a media source', srcs.length >= 1, JSON.stringify(srcs).slice(0, 160));
  check('A2: MV source is not a relative path (relative loses Range on Desktop → no seek)',
    badRel(srcs).length === 0, badRel(srcs).join(' '));
  check('A3: MV source is the absolute token URL carrying the cache key',
    srcs.some((s) => isToken(s, '&k=' + CACHE_KEY)), srcs.join(' '));
}

// ── B. 音频轨：绝对 token 地址 + &p=<trackId>（同一根因的另一半）────────────
{
  const { srcs } = await bootAndCue(AUDIO.id);
  check('B1: audio restore attached a media source', srcs.length >= 1, JSON.stringify(srcs).slice(0, 160));
  check('B2: audio source is not a relative path', badRel(srcs).length === 0, badRel(srcs).join(' '));
  check('B3: audio source is the absolute token URL carrying the track id',
    srcs.some((s) => isToken(s, '&p=' + encodeURIComponent(AUDIO.id))), srcs.join(' '));
}

// ── C. 平台栅栏把 /session 拒了（401）→ 必须靠回环前缀拿到基址 ───────────────
// 这是 Desktop 真机的形态：admit() 在路由前答 401/403，A1-02 的 404 回落永不触发。
{
  const { srcs, requested } = await bootAndCue(VIDEO.id, { gateSession: true });
  check('C1: platform /session was actually gate-rejected (fixture sanity)',
    requested.some((u) => u.includes('/api/dsh-music/session')), requested.filter((u) => u.includes('session')).join(' '));
  check('C2: client fell back to the plugin loopback prefix for the token base',
    requested.some((u) => u.startsWith('/dsh-music/api/session')), requested.filter((u) => u.includes('session')).join(' '));
  check('C3: MV source is still the absolute token URL despite the 401',
    srcs.some((s) => isToken(s, '&k=' + CACHE_KEY)), srcs.join(' '));
  check('C4: no relative source was ever attached', badRel(srcs).length === 0, badRel(srcs).join(' '));
}

// ── D. 基址在「重试预算」内一直拿不到 → 相对地址 → 不可 seek → 状态自愈 ────────
// 真机形态：基址为空 ⇒ 挂相对地址 ⇒ 丢 Range ⇒ seekable=[0,0] ⇒ 一拖回 0。
// 窗口取 7.5s，**长于**客户端 ensureStreamBase 的 2s+4s 重试预算 —— 否则重试就已经
// 拿到基址，根本走不到相对地址那一步（本场景第一版就是这么失去判别力的）。
// 窗口过后放行，让「不可 seek」这条可观测症状触发的自愈有机会重挂成 token 地址。
{
  const { srcs } = await bootAndCue(AUDIO.id, { failSessionForMs: 7500, unseekable: true, waitMs: 15000 });
  const relative = srcs.filter((s) => !s.startsWith('http'));
  check('D1: fixture really produced a relative (unseekable) source first',
    relative.length >= 1, srcs.join(' '));
  check('D2: the unseekable source was healed into a token URL',
    srcs.some((s) => isToken(s, '&p=' + encodeURIComponent(AUDIO.id))), srcs.join(' '));
  check('D3: the heal is bounded (no re-attach storm)', srcs.length <= 4, 'srcs=' + srcs.length);
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
