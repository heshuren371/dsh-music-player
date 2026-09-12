// Performance / resource regression (host half):
//  1. rapid refreshes share one scan instead of N concurrent metadata passes
//  2. the cover cache is bounded by bytes, not just entry count
//  3. aborted range streams release their file descriptors
//  4. an idle host process burns no CPU
// A/B hook: DSH_MUSIC_HOST=/abs/path/to/index.js runs the same suite against
// another build (e.g. the pre-fix revision from git).
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hostUrl = process.env.DSH_MUSIC_HOST
  ? pathToFileURL(path.resolve(process.env.DSH_MUSIC_HOST))
  : new URL('../lib/index.js', import.meta.url);

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-perf-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-perf-music-'));
process.env.DSH_HOME = home;
await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');

function wav(n = 2000) {
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}
function id3WithCover(mime, payload) {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(mime + '\u0000', 'latin1'), Buffer.from([3]), Buffer.from([0]), payload]);
  const fh = Buffer.alloc(10); fh.write('APIC', 0, 'latin1'); fh.writeUInt32BE(body.length, 4);
  const frames = Buffer.concat([fh, body]);
  const size = frames.length;
  const header = Buffer.alloc(10); header.write('ID3', 0, 'latin1'); header[3] = 3;
  header[6] = (size >> 21) & 0x7f; header[7] = (size >> 14) & 0x7f; header[8] = (size >> 7) & 0x7f; header[9] = size & 0x7f;
  return Buffer.concat([header, frames, Buffer.alloc(417)]);
}
const gc = globalThis.gc ?? (() => {});

const N = 600;
const audio = wav();
await Promise.all(Array.from({ length: N }, (_, i) => fs.writeFile(path.join(music, 't' + String(i).padStart(4, '0') + '.wav'), audio)));

let handler = null;
const ctx = { effect: (fn) => fn(), get: () => undefined, webServer: { register: (route) => { handler = route.handler; return () => {}; } } };
const { apply } = await import(hostUrl.href);
apply(ctx);
const server = createServer((req, res) => { handler(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500).end(String(e)); }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';
const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json().catch(() => null) }; };
const waitScan = async () => { for (let i = 0; i < 1200; i++) { const r = await j('/api/library'); if (r.body && r.body.scanning !== true && r.body.tracks.length > 0) return r.body; await new Promise((r) => setTimeout(r, 25)); } throw new Error('scan timeout'); };
const cpuMs = (usage) => (usage.user + usage.system) / 1000;
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

await j('/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: music }) });
await waitScan();
console.log('-- ' + N + ' tracks --');

// ── 1. scan de-duplication under refresh bursts ──────────────────────────────
const measure = async (label, run) => { gc(); const before = process.cpuUsage(); await run(); const cpu = cpuMs(process.cpuUsage(before)); console.log(label + ': ' + cpu.toFixed(0) + ' ms cpu'); return cpu; };
await j('/api/refresh', { method: 'POST' }); await waitScan();
const singleCpu = await measure('single refresh', async () => { await j('/api/refresh', { method: 'POST' }); await waitScan(); });
const burstCpu = await measure('burst of 4 refreshes', async () => { await Promise.all(Array.from({ length: 4 }, () => j('/api/refresh', { method: 'POST' }))); await waitScan(); });
const ratio = burstCpu / singleCpu;
check('burst shares the running scan (cpu ratio < 2x)', ratio < 2, 'ratio=' + ratio.toFixed(2) + 'x (' + burstCpu.toFixed(0) + '/' + singleCpu.toFixed(0) + ' ms)');

// ── 2. cover cache memory bound ──────────────────────────────────────────────
const covDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-perf-cov-'));
const COVERS = 24;
const bigCover = Buffer.alloc(6 * 1024 * 1024, 0xab);
for (let i = 0; i < COVERS; i += 1) await fs.writeFile(path.join(covDir, 'c' + i + '.mp3'), id3WithCover('image/jpeg', bigCover));
await j('/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: covDir }) });
const covLib = await waitScan();
gc();
const buffersBefore = process.memoryUsage().arrayBuffers;
for (const t of covLib.tracks) { const r = await fetch(base + '/api/cover?p=' + encodeURIComponent(t.id)); await r.arrayBuffer(); }
gc();
const growth = (process.memoryUsage().arrayBuffers - buffersBefore) / 1024 / 1024;
console.log('-- ' + COVERS + ' x 6MB covers requested (raw payload ' + (COVERS * 6) + 'MB) --');
check('cover cache byte cap bounds retained buffers (< 64MB)', growth < 64, 'arrayBuffers growth=' + growth.toFixed(1) + 'MB');

// ── 3. aborted streams must not leak descriptors ─────────────────────────────
const fdCount = async () => { try { return (await fs.readdir('/dev/fd')).length; } catch { return -1; } };
await j('/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: music }) });
await waitScan();
const trackId = (await waitScan()).tracks[0].id;
const fdsBefore = await fdCount();
for (let i = 0; i < 200; i += 1) {
  const controller = new AbortController();
  const pending = fetch(base + '/api/stream?p=' + encodeURIComponent(trackId), { signal: controller.signal })
    .then((r) => r.body.getReader().read())
    .catch(() => {});
  setTimeout(() => controller.abort(), 0);
  await pending;
}
await new Promise((r) => setTimeout(r, 300));
gc();
const fdsAfter = await fdCount();
check('no fd leak after 200 aborted range requests', fdsBefore < 0 || fdsAfter - fdsBefore <= 10, 'fds ' + fdsBefore + ' -> ' + fdsAfter);

// ── 4. idle CPU ──────────────────────────────────────────────────────────────
const idleBefore = process.cpuUsage();
await new Promise((r) => setTimeout(r, 1500));
const idle = cpuMs(process.cpuUsage(idleBefore));
check('idle host stays under 100ms cpu/1.5s', idle < 100, 'idle cpu=' + idle.toFixed(0) + 'ms');

server.close();
await fs.rm(home, { recursive: true, force: true });
await fs.rm(music, { recursive: true, force: true });
await fs.rm(covDir, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
