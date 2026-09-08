// Dev-only harness: serves the real plugin client.js plus a real WAV file so
// the progress bar can be exercised in a real browser engine (CSS calc,
// React's range onChange, pointer drags, live audio clock) without the
// authenticated DSH shell. Run: node scripts/preview-server.mjs [port]
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] ?? 4319);

/** 120s 8kHz mono 16-bit sine sweep: long enough to seek around in. */
function makeWav() {
  const rate = 8000;
  const seconds = 120;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    const freq = 220 * Math.pow(2, Math.floor(t / 10) % 4); // 220/440/880/1760 Hz steps
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * t) * 12000), 44 + i * 2);
  }
  return buffer;
}
const wav = makeWav();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/tone.wav') {
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range !== null) {
      const start = range[1] === '' ? Math.max(0, wav.length - Number(range[2])) : Number(range[1]);
      const end = range[2] === '' || range[1] === '' ? wav.length - 1 : Math.min(Number(range[2]), wav.length - 1);
      res.writeHead(206, {
        'content-type': 'audio/wav',
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${wav.length}`,
        'accept-ranges': 'bytes',
      });
      res.end(wav.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'accept-ranges': 'bytes' });
    res.end(wav);
    return;
  }
  const rel = url.pathname === '/' ? '/scripts/preview-progress.html' : url.pathname;
  const file = path.join(root, path.normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-length': stat.size });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel);
  }
});

server.listen(port, '127.0.0.1', () => console.log('preview server on http://127.0.0.1:' + port + '/'));
