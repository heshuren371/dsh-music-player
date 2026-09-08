// Regression test for the streaming endpoint: Range handling must stay intact
// after the pipeFile change, and an aborted stream (what every seek does) must
// not crash the host or leak the read stream.
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-music-'));
process.env.DSH_HOME = home;
// Seed the state file so loadState() never falls back to the package's legacy
// lib/state.json (which points at the developer's real music folder).
await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');

/** Minimal valid 2s 8kHz mono WAV. */
function wav(seconds = 2) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), 44 + i * 2);
  return buf;
}
const audio = wav();
await fs.writeFile(path.join(music, 'song.wav'), audio);
await fs.mkdir(path.join(music, 'sub'));
await fs.writeFile(path.join(music, 'sub', 'nested.wav'), audio);

let handler = null;
const ctx = {
  effect: (fn) => fn(),
  get: () => undefined,
  webServer: { register: (route) => { handler = route.handler; return () => {}; } },
};
const { apply } = await import('../lib/index.js');
apply(ctx);
if (handler === null) throw new Error('route not registered');

const server = createServer((req, res) => { handler(req, res).catch((error) => { res.writeHead(500).end(String(error)); }); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';
const json = async (url, options) => { const r = await fetch(url, options); return { status: r.status, body: await r.json() }; };

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

const setDir = await json(base + '/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: music }) });
check('POST /api/dir accepts the folder', setDir.status === 200, 'status=' + setDir.status);

let library = null;
for (let i = 0; i < 40; i += 1) {
  const r = await json(base + '/api/library');
  if (r.body.scanning !== true && (r.body.tracks ?? []).length > 0) { library = r.body; break; }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check('library scan finds both tracks', library !== null && library.tracks.length === 2, 'tracks=' + (library?.tracks?.length ?? 'none'));

// full body
const full = await fetch(base + '/api/stream?p=song.wav');
const fullBody = Buffer.from(await full.arrayBuffer());
check('GET stream → 200 + exact length', full.status === 200 && fullBody.length === audio.length,
  'status=' + full.status + ' bytes=' + fullBody.length + '/' + audio.length);
check('GET stream advertises byte ranges', full.headers.get('accept-ranges') === 'bytes', 'accept-ranges=' + full.headers.get('accept-ranges'));

// ranged body
const ranged = await fetch(base + '/api/stream?p=song.wav', { headers: { range: 'bytes=100-199' } });
const rangedBody = Buffer.from(await ranged.arrayBuffer());
check('GET stream Range → 206 + 100 bytes', ranged.status === 206 && rangedBody.length === 100,
  'status=' + ranged.status + ' bytes=' + rangedBody.length);
check('Range bytes match the file', rangedBody.equals(audio.subarray(100, 200)), 'content-range=' + ranged.headers.get('content-range'));

// suffix range
const suffix = await fetch(base + '/api/stream?p=sub/nested.wav', { headers: { range: 'bytes=-50' } });
check('suffix Range on a nested track → 206 + 50 bytes', suffix.status === 206 && (await suffix.arrayBuffer()).byteLength === 50, 'status=' + suffix.status);

// An out-of-range Range is deliberately ignored (full 200 body): returning 416
// would make a browser seek past EOF abort playback with a media error.
const bad = await fetch(base + '/api/stream?p=song.wav', { headers: { range: 'bytes=' + (audio.length + 10) + '-' } });
const badBody = Buffer.from(await bad.arrayBuffer());
check('out-of-range Range falls back to the full body', bad.status === 200 && badBody.length === audio.length,
  'status=' + bad.status + ' bytes=' + badBody.length);

// abort mid-stream, then confirm the server still serves and the fd is released
for (let i = 0; i < 30; i += 1) {
  const controller = new AbortController();
  const pending = fetch(base + '/api/stream?p=song.wav', { signal: controller.signal }).then((r) => r.body.getReader().read()).catch(() => {});
  setTimeout(() => controller.abort(), 0);
  await pending;
}
const afterAbort = await fetch(base + '/api/stream?p=song.wav');
check('stream still works after 30 aborted requests', afterAbort.status === 200 && (await afterAbort.arrayBuffer()).byteLength === audio.length, 'status=' + afterAbort.status);
check('process survived the aborts (no unhandled stream error)', true);

// traversal guard untouched
const escape = await fetch(base + '/api/stream?p=../outside.wav');
check('path escape → 403', escape.status === 403, 'status=' + escape.status);
await escape.arrayBuffer();

server.close();
await fs.rm(home, { recursive: true, force: true });
await fs.rm(music, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
