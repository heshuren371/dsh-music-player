// Security & limits regression for the host half:
//  - cover art: mime allowlist (SVG/HTML must never be served), 8MB cap, nosniff
//  - cross-site POST guard (simple requests bypass preflight; must be rejected)
//  - malformed percent-encoding -> 400 (not 500)
//  - traversal guard stays intact for stream and delete
//  - "~/..." expands; bad paths answer 400 without leaking the process cwd
//  - MAX_TRACKS holds inside a single huge directory and reports truncated
import { createServer, request as httpRequest } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-sec-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-sec-music-'));
process.env.DSH_HOME = home;
await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');

function wav(n = 800) {
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}
/** ID3v2.3 file with one APIC frame; mime and bytes are attacker-controlled. */
function id3WithCover(mime, payload) {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(mime + '\u0000', 'latin1'), Buffer.from([3]), Buffer.from([0]), payload]);
  const fh = Buffer.alloc(10); fh.write('APIC', 0, 'latin1'); fh.writeUInt32BE(body.length, 4);
  const frames = Buffer.concat([fh, body]);
  const size = frames.length;
  const header = Buffer.alloc(10); header.write('ID3', 0, 'latin1'); header[3] = 3;
  header[6] = (size >> 21) & 0x7f; header[7] = (size >> 14) & 0x7f; header[8] = (size >> 7) & 0x7f; header[9] = size & 0x7f;
  return Buffer.concat([header, frames, Buffer.alloc(417)]);
}
const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
await fs.writeFile(path.join(music, 'plain.wav'), wav());
await fs.writeFile(path.join(music, 'victim.wav'), wav());
await fs.writeFile(path.join(music, 'jpeg-cover.mp3'), id3WithCover('image/jpeg', TINY_JPEG));
await fs.writeFile(path.join(music, 'evil-cover.mp3'), id3WithCover('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')));
await fs.writeFile(path.join(music, 'html-cover.mp3'), id3WithCover('text/html', Buffer.from('<script>alert(2)</script>')));
await fs.writeFile(path.join(music, 'huge-cover.mp3'), id3WithCover('image/jpeg', Buffer.alloc(9 * 1024 * 1024, 0xab)));

let handler = null;
const ctx = {
  effect: (fn) => fn(),
  get: () => undefined,
  webServer: { register: (route) => { handler = route.handler; return () => {}; } },
};
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href);
apply(ctx);
const server = createServer((req, res) => { handler(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500).end(String(e)); }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const base = origin + '/dsh-music';
const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json().catch(() => null) }; };
const waitScan = async () => { for (let i = 0; i < 600; i++) { const r = await j('/api/library'); if (r.body && r.body.scanning !== true && r.body.tracks.length > 0) return r.body; await new Promise((r) => setTimeout(r, 50)); } throw new Error('scan timeout'); };
/** Raw HTTP so the Host header can be forged (fetch forbids it). */
const rawGet = (pathname, host) => new Promise((resolve, reject) => {
  const request = httpRequest({ host: '127.0.0.1', port: server.address().port, path: pathname, method: 'GET', headers: { host } }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  request.on('error', reject);
  request.end();
});
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

await j('/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: music }) });
const lib = await waitScan();
check('library scanned', lib.tracks.length >= 6, 'tracks=' + lib.tracks.length);

// ── cover art: allowlist / size cap / nosniff ────────────────────────────────
const jpegCover = await fetch(base + '/api/cover?p=jpeg-cover.mp3');
await jpegCover.arrayBuffer();
check('raster cover is served with its mime', jpegCover.status === 200 && jpegCover.headers.get('content-type') === 'image/jpeg', 'status=' + jpegCover.status + ' type=' + jpegCover.headers.get('content-type'));
check('cover response carries nosniff', jpegCover.headers.get('x-content-type-options') === 'nosniff', 'nosniff=' + jpegCover.headers.get('x-content-type-options'));
const svgCover = await fetch(base + '/api/cover?p=evil-cover.mp3');
await svgCover.text();
check('SVG cover is refused (stored-XSS vector closed)', svgCover.status === 404, 'status=' + svgCover.status);
const htmlCover = await fetch(base + '/api/cover?p=html-cover.mp3');
await htmlCover.text();
check('text/html cover is refused', htmlCover.status === 404, 'status=' + htmlCover.status);
const hugeCover = await fetch(base + '/api/cover?p=huge-cover.mp3');
await hugeCover.text();
check('over-cap cover is refused', hugeCover.status === 404, 'status=' + hugeCover.status);

// ── malformed URI / traversal ────────────────────────────────────────────────
const malformed = await fetch(base + '/%');
check('malformed percent-encoding -> 400', malformed.status === 400, 'status=' + malformed.status);
await malformed.text();
for (const p of ['../outside.wav', '%2e%2e%2foutside.wav', '/etc/passwd', 'a/../../x.mp3']) {
  const r = await fetch(base + '/api/stream?p=' + p);
  await r.arrayBuffer().catch(() => {});
  check('traversal blocked: ' + JSON.stringify(p), r.status === 403, 'status=' + r.status);
}
const dotSlash = await fetch(base + '/api/stream?p=./plain.wav');
await dotSlash.arrayBuffer().catch(() => {});
check('id must match the scan list (./plain.wav -> 404)', dotSlash.status === 404, 'status=' + dotSlash.status);

// ── cross-site guard ─────────────────────────────────────────────────────────
const crossOrigin = { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' };
const r1 = await j('/api/refresh', { method: 'POST', headers: crossOrigin });
check('cross-site refresh rejected', r1.status === 403, 'status=' + r1.status);
const r2 = await j('/api/dir', { method: 'POST', headers: crossOrigin, body: JSON.stringify({ dir: music }) });
check('cross-site dir change rejected', r2.status === 403, 'status=' + r2.status);
const r3 = await j('/api/delete', { method: 'POST', headers: crossOrigin, body: JSON.stringify({ id: 'victim.wav' }) });
check('cross-site delete rejected', r3.status === 403, 'status=' + r3.status);
check('victim file survived the cross-site delete', await fs.stat(path.join(music, 'victim.wav')).then(() => true, () => false));
const r4 = await j('/api/refresh', { method: 'POST', headers: { 'sec-fetch-site': 'same-site' } });
check('same-site (another local origin) is rejected too', r4.status === 403, 'status=' + r4.status);
const r5 = await j('/api/refresh', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin' } });
check('same-origin refresh accepted', r5.status === 200, 'status=' + r5.status);
await waitScan();
const r6 = await j('/api/refresh', { method: 'POST' });
check('non-browser client (no fetch metadata) still accepted', r6.status === 200, 'status=' + r6.status);
await waitScan();
// DNS rebinding: Host names the attacker domain even though the socket lands here.
check('rebound Host (evil.example) rejected', (await rawGet('/dsh-music/api/library', 'evil.example:' + server.address().port)) === 403, 'host=evil.example');
check('loopback Host (localhost) accepted', (await rawGet('/dsh-music/api/library', 'localhost:' + server.address().port)) === 200, 'host=localhost');
check('rebound Host on a POST rejected', (await rawGet('/dsh-music/api/library', 'attacker.test:' + server.address().port)) === 403, 'host=attacker.test');

// ── path ergonomics: ~ expansion + no cwd leak ───────────────────────────────
const missing = await j('/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: '~/__dshm_missing_' + Date.now() + '__' }) });
check('missing ~/ path -> 400', missing.status === 400, 'status=' + missing.status);
check('error message never leaks the process cwd', missing.body !== null && !String(missing.body.error).includes(process.cwd()), 'error=' + JSON.stringify(missing.body?.error));
const tildeDir = path.join(os.homedir(), '.dshm-tilde-' + Date.now());
await fs.mkdir(tildeDir, { recursive: true });
await fs.writeFile(path.join(tildeDir, 'one.wav'), wav());
const tildeSet = await j('/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: '~/' + path.basename(tildeDir) }) });
check('~ expands to the home directory', tildeSet.status === 200 && tildeSet.body.dir === tildeDir, 'status=' + tildeSet.status + ' dir=' + tildeSet.body?.dir);

// ── MAX_TRACKS inside one directory ──────────────────────────────────────────
const big = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-sec-big-'));
await Promise.all(Array.from({ length: 5100 }, (_, i) => fs.writeFile(path.join(big, 'x' + String(i).padStart(5, '0') + '.mp3'), Buffer.alloc(0))));
await j('/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: big }) });
const bigLib = await waitScan();
check('MAX_TRACKS caps a single directory', bigLib.tracks.length === 5000, 'tracks=' + bigLib.tracks.length);
check('a capped scan is reported as truncated', bigLib.truncated === true, 'truncated=' + bigLib.truncated);

server.close();
await fs.rm(home, { recursive: true, force: true });
await fs.rm(music, { recursive: true, force: true });
await fs.rm(tildeDir, { recursive: true, force: true });
await fs.rm(big, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
