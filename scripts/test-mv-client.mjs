// MV 客户端的三个决策面：音轨编码该不该直出、画面旁路会不会把音轨弄哑、失败升级能不能重来。
//
//   ① direct 直出：宿主给的 url 是**相对**地址（`/api/dsh-music/stream?p=…`），Desktop 上
//      相对地址经转发会丢 Range（I-02），所以客户端必须自己拼 token 绝对地址。
//   ② 音轨看门狗：图面对得上、音轨解不了时 Chromium 不报 error（只是丢掉那条流）——
//      症状是「有画面、没声音」，刷新也好不了。判据是 `webkitAudioDecodedByteCount`。
//   ③ 升级预算：`mvEscalated` 只防「一次播放里失败→升级→再失败」的死循环；用户重新播这一首
//      必须能再升级一次，否则「回去再播还是没声音，只有刷新才好」。
//   ④ WASM 画面旁路只补画面，元素仍要自己解音轨：音轨编码不在直出名单里时不能走这条路
//      （那是「有画面、没声音」的另一条生产路径）。
import { JSDOM, VirtualConsole } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { promises as fs } from 'node:fs';

const SOURCE = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const STREAM_BASE = 'http://127.0.0.1:3080/dsh-music/api/system-stream?t=stream-token-x';
const FILM = { index: 0, id: 'film.mp4', name: 'film.mp4', title: 'Film', artist: 'x', duration: 300, kind: 'video', mime: 'video/mp4', videoCodec: 'h264', audioCodec: 'dts' };
const SONGS = [FILM, { index: 1, id: 'a.mp3', name: 'a.mp3', title: 'A', artist: 'x', duration: 200, kind: 'audio', mime: 'audio/mpeg' }];

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真 jsdom `<video>` + 真实媒体语义；`webkitAudioDecodedByteCount` 由用例设定。 */
function installMedia(win, log, seed) {
  const created = [];
  const make = () => {
    const el = win.document.createElement('video');
    el.__paused = true;
    Object.defineProperty(el, 'paused', { get: () => el.__paused, configurable: true });
    for (const [name, value] of [['duration', 300], ['readyState', 4], ['videoWidth', 640], ['error', null]]) {
      Object.defineProperty(el, name, { value, writable: true, configurable: true });
    }
    Object.defineProperty(el, 'seekable', { value: { length: 1, start: () => 0, end: () => 300 }, configurable: true });
    Object.defineProperty(el, 'currentSrc', { get: () => String(el.getAttribute('src') ?? ''), configurable: true });
    Object.defineProperty(el, 'webkitAudioDecodedByteCount', { value: seed, writable: true, configurable: true });
    el.play = () => { el.__paused = false; log.push({ op: 'play' }); return Promise.resolve(); };
    el.pause = () => { el.__paused = true; log.push({ op: 'pause' }); };
    el.load = () => {};
    created.push(el);
    return el;
  };
  win.__dshMusicMedia = make;
  win.__dshMusicMedia2 = make;
  return created;
}

function makeFakeAudioContext(log) {
  return class {
    constructor() { this.state = 'suspended'; this.sampleRate = 48000; this.currentTime = 1; this.destination = { id: 'destination' }; this._n = 0; this.onstatechange = null; }
    createGain() { const id = 'gain' + (++this._n); return { id, gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect: (to) => log.push({ op: 'connect', from: id, to: to && to.id }), disconnect() {} }; }
    createBiquadFilter() { const id = 'filter' + (++this._n); return { id, type: 'lowpass', frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, connect() {}, disconnect() {} }; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    resume() { log.push({ op: 'resume' }); this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
  };
}

async function boot({ decodedBytes = undefined } = {}) {
  const log = [];
  const requested = [];
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:3080/', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const win = dom.window;
  globalThis.window = win; globalThis.document = win.document; globalThis.localStorage = win.localStorage;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  win.Element.prototype.scrollIntoView = function () {};
  const media = installMedia(win, log, decodedBytes);
  win.AudioContext = makeFakeAudioContext(log);
  win.localStorage.setItem('dsh-music:prefs', JSON.stringify({ last: { id: FILM.id, time: 0 } }));

  const okJson = (body) => ({ ok: true, status: 200, json: async () => body, clone() { return okJson(body); } });
  const mockFetch = async (url) => {
    const target = String(url);
    requested.push(target);
    if (target.includes('/session')) return okJson({ systemArtBase: STREAM_BASE.replace('system-stream', 'system-art'), systemStreamBase: STREAM_BASE });
    if (target.includes('/library') || target.includes('/refresh')) return okJson({ dir: '/music', tracks: SONGS, scanning: false, scannedAt: 1, truncated: false });
    if (target.includes('/mv')) {
      // 宿主对直出档给的是**相对**地址；转码档一律失败（专门用来观察升级）。
      if (target.includes('mode=transcode')) return okJson({ mode: 'transcode', state: 'failed', progress: 0, error: 'boom', url: null });
      return okJson({ mode: 'direct', state: 'ready', progress: 1, error: null, url: '/api/dsh-music/stream?p=' + encodeURIComponent(FILM.id) + '&v=1', ffmpeg: true });
    }
    return okJson({});
  };
  globalThis.fetch = mockFetch;
  win.fetch = mockFetch;

  let factory = null;
  win.__ModuleLoader__ = { load: ({ factory: f }) => { factory = f; } };
  win.eval(SOURCE);
  const plugin = factory((name) => { if (name === 'react') return React; throw new Error('require: ' + name); });
  let View = null;
  plugin.apply({
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (key) => (({ stats: (n) => String(n), 'scan.progress': (a, b) => a + '/' + b })[key] ?? key) },
    slots: { inject: (_n, fn) => fn(), register: (_m, c) => { View = c; return () => {}; } },
  });
  const root = createRoot(win.document.createElement('div'));
  await act(async () => { root.render(React.createElement(View)); });
  const player = win.__dshMusicPlayer;
  for (let i = 0; i < 80 && player.getState().tracks.length < 2; i += 1) await act(async () => { await sleep(25); });
  return {
    win, log, requested, player, media,
    srcs: () => media.map((el) => String(el.getAttribute('src') ?? '')).filter((s) => s.length > 0),
    transcodeAsks: () => requested.filter((u) => u.includes('mode=transcode')).length,
    waitFor: async (pred, timeoutMs) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (pred()) return true; await act(async () => { await sleep(50); }); } return pred(); },
  };
}

// ── A. 直出档必须是 token 绝对地址（宿主的相对地址在 Desktop 上丢 Range）────────
{
  const b = await boot();
  await act(async () => { b.player.play(0); });
  await b.waitFor(() => b.srcs().length > 0, 3000);
  const srcs = b.srcs();
  const relative = srcs.filter((s) => !s.startsWith('http'));
  check('A1: direct 档挂的是绝对地址，不是宿主给的相对地址',
    relative.length === 0, 'srcs=' + JSON.stringify(srcs));
  check('A2: 绝对地址就是 token 直连地址（带 &p=<曲目 id>）',
    srcs.some((s) => s.startsWith('http://127.0.0.1:') && s.includes('system-stream?t=') && s.includes('&p=' + encodeURIComponent(FILM.id))),
    srcs.join(' '));
}

// ── B/D. 音轨看门狗：解不出音频字节就升级，且重新播这一首还能再升级一次 ──────────
{
  const b = await boot({ decodedBytes: 0 });
  await act(async () => { b.player.play(0); });
  await b.waitFor(() => b.transcodeAsks() > 0, 6000);
  check('B1: 播了 3.5 秒音频字节仍为 0 → 升级成转码（有画面、没声音的自愈）',
    b.transcodeAsks() === 1, 'asks=' + b.transcodeAsks() + ' requests=' + JSON.stringify(b.requested.filter((u) => u.includes('/mv'))));
  await b.waitFor(() => b.player.getState().mv?.state === 'failed', 4000);
  check('B2: 升级失败时状态如实落到 failed（不是停在 preparing）',
    b.player.getState().mv?.state === 'failed', JSON.stringify(b.player.getState().mv));

  // 重新播这一首：升级预算必须**每次播放各一份**，否则只能刷新页面才好。
  await act(async () => { b.player.play(0); });
  const again = await b.waitFor(() => b.transcodeAsks() >= 2, 6000);
  check('D1: 重新播放同一首时升级预算已复位（第二次仍能升级，不必刷新页面）',
    again && b.transcodeAsks() === 2, 'asks=' + b.transcodeAsks());
}

// ── C. 反向对照：音频字节在涨就不该升级（免得把好端端的 MV 送去转码）───────────
{
  const b = await boot({ decodedBytes: 4096 });
  await act(async () => { b.player.play(0); });
  await b.waitFor(() => b.srcs().length > 0, 3000);
  await act(async () => { await sleep(4200); });
  check('C1: 音频解码字节在增长时不升级（惰性判定，别把好的 MV 送去转码）',
    b.transcodeAsks() === 0, 'asks=' + b.transcodeAsks());
}

// ── E. WASM 画面旁路的前提：音轨元素自己解得出来 ───────────────────────────────
// jsdom 里跑不了 `import()` 动态加载 libav，所以这条只能静态断言产物：注释先剥掉
// （注释里会出现同样的名字 —— 那是恒绿断言的老坑），断言的是**同一条判断里**的与条件。
{
  const stripped = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const gated = /WASM_CODECS\.has\([^)]*\)\s*&&\s*wasmAudioPlayable\(/.test(stripped);
  const predicate = /const wasmAudioPlayable = \(track\) =>[\s\S]{0,200}MV_DIRECT_AUDIO\.has\(track\.audioCodec\)/.test(stripped);
  check('E1: WASM 画面旁路要求音轨编码也在直出名单里（否则有画面没声音）',
    gated && predicate, 'gated=' + gated + ' predicate=' + predicate);
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
