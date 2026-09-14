// Regression test for POST /api/apply: it must write the matched title/artist/
// album into the audio file, rename the file to "Artist - Title.ext" with
// collision handling, update the library in place, and keep the traversal guard.
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFile } from 'music-metadata';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-apply-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-apply-music-'));
process.env.DSH_HOME = home;
await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');

/** Minimal valid 1s 8kHz mono WAV. */
function wav(seconds = 1) {
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
await fs.writeFile(path.join(music, 'bad name.wav'), wav());
await fs.writeFile(path.join(music, 'other.wav'), wav());
await fs.mkdir(path.join(music, 'sub'));
await fs.writeFile(path.join(music, 'sub', 'nested.wav'), wav());

let handler = null;
const ctx = {
  effect: (fn) => fn(),
  get: () => undefined,
  webServer: { register: (route) => { handler = route.handler; return () => {}; } },
};
const { apply } = await import('../lib/index.js');
apply(ctx);
if (handler === null) throw new Error('route not registered');
const server = createServer((req, res) => { handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';
const json = async (url, options) => { const r = await fetch(url, options); return { status: r.status, body: await r.json() }; };
const post = (p, body) => json(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

await post('/api/dir', { dir: music });
let library = null;
for (let i = 0; i < 60; i += 1) {
  const r = await json(base + '/api/library');
  if (r.body.scanning !== true && (r.body.tracks ?? []).length === 3) { library = r.body; break; }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check('scan finds three untagged tracks', library !== null && library.tracks.every((t) => t.tagged === false), JSON.stringify(library?.tracks?.map((t) => [t.id, t.tagged])));

const first = await post('/api/apply', { id: 'bad name.wav', title: 'Real Title', artist: 'Real Artist', album: 'Real Album', rename: true });
check('apply → 200', first.status === 200, 'status=' + first.status);
check('apply reports tagged + renamed', first.body.tagged === true && first.body.renamed === true, JSON.stringify({ tagged: first.body.tagged, renamed: first.body.renamed, warning: first.body.warning }));
check('renamed to "Artist - Title.wav"', first.body.newId === 'Real Artist - Real Title.wav', 'newId=' + first.body.newId);
check('old file is gone', await fs.access(path.join(music, 'bad name.wav')).then(() => false, () => true));
const parsed = await parseFile(path.join(music, 'Real Artist - Real Title.wav'), { duration: false });
check('tags were written to the file', parsed.common.title === 'Real Title' && parsed.common.artist === 'Real Artist' && parsed.common.album === 'Real Album', JSON.stringify({ t: parsed.common.title, a: parsed.common.artist, al: parsed.common.album }));
check('library entry updated in place', first.body.library.tracks.some((t) => t.id === 'Real Artist - Real Title.wav' && t.title === 'Real Title' && t.tagged === true), JSON.stringify(first.body.library.tracks));

const second = await post('/api/apply', { id: 'other.wav', title: 'Real Title', artist: 'Real Artist', rename: true });
check('name collision gets a " (2)" suffix', second.body.newId === 'Real Artist - Real Title (2).wav', 'newId=' + second.body.newId);

const nested = await post('/api/apply', { id: 'sub/nested.wav', title: 'Nested', artist: 'Person', rename: true });
check('rename stays inside its subdirectory', nested.body.newId === 'sub/Person - Nested.wav', 'newId=' + nested.body.newId);
check('renamed file exists in the subdirectory', await fs.access(path.join(music, 'sub', 'Person - Nested.wav')).then(() => true, () => false));

const noRename = await post('/api/apply', { id: 'Real Artist - Real Title (2).wav', title: 'Later', artist: 'Someone', rename: false });
check('rename:false updates tags without moving the file', noRename.body.renamed === false && noRename.body.newId === 'Real Artist - Real Title (2).wav', 'newId=' + noRename.body.newId);

const escape = await post('/api/apply', { id: '../outside.wav', title: 'x' });
check('path escape → 403', escape.status === 403, 'status=' + escape.status);
const unknown = await post('/api/apply', { id: 'nope.wav', title: 'x' });
check('unknown id → 404', unknown.status === 404, 'status=' + unknown.status);
const noId = await post('/api/apply', { title: 'x' });
check('missing id → 403', noId.status === 403, 'status=' + noId.status);

server.close();
await fs.rm(home, { recursive: true, force: true });
await fs.rm(music, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
