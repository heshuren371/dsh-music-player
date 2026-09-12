// Process-level lifecycle test: the host half must load, serve, and fully
// release on dispose. Cycles apply/dispose the real Cordis effect contract and
// assert no handle growth, no unhandled rejection, and no orphaned scan CPU.
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-life-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-life-music-'));
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
const audio = wav();
const FILES = 1500;
await Promise.all(Array.from({ length: FILES }, (_, i) => fs.writeFile(path.join(music, 'f' + String(i).padStart(5, '0') + '.wav'), audio)));

const hostUrl = process.env.DSH_MUSIC_HOST
  ? pathToFileURL(path.resolve(process.env.DSH_MUSIC_HOST))
  : new URL('../lib/index.js', import.meta.url);
const mod = await import(hostUrl.href);
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

check('exports Cordis plugin identity', mod.name === 'music-player' && Array.isArray(mod.inject) && mod.inject.includes('webServer') && typeof mod.apply === 'function', 'name=' + mod.name + ' inject=' + JSON.stringify(mod.inject));

const rejections = [];
process.on('unhandledRejection', (reason) => rejections.push(reason));
const resources = () => process.getActiveResourcesInfo().length;
const handles = () => process._getActiveHandles().length;

/** One complete plugin lifecycle: apply -> serve -> dispose. */
async function cycle(index) {
  let handler = null;
  const routes = [];
  const effects = [];
  const ctx = {
    effect: (fn, label) => { const d = fn(); if (typeof d === 'function') effects.push({ label, d }); return d; },
    get: () => undefined,
    webServer: { register: (route) => { handler = route.handler; routes.push(route); return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1); }; } },
  };
  mod.apply(ctx);
  if (handler === null) throw new Error('cycle ' + index + ': route not registered');
  const server = createServer((req, res) => { handler(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500).end(String(e)); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';
  const lib = await (await fetch(base + '/api/library')).json();
  check('cycle ' + index + ': library served while active', lib.dir === music, 'dir=' + lib.dir);
  // Dispose while the scan is still running: cancellation must stop the work.
  for (const e of effects.reverse()) e.d();
  check('cycle ' + index + ': route unregistered on dispose', routes.length === 0, 'routes=' + routes.length);
  // No request may be issued in this window: /api/library restarts a lazy scan,
  // so polling would mask the orphaned work this check is looking for.
  const cpuAtDispose = process.cpuUsage();
  await new Promise((r) => setTimeout(r, 400));
  const disposeCpu = process.cpuUsage(cpuAtDispose);
  const disposeMs = (disposeCpu.user + disposeCpu.system) / 1000;
  check('cycle ' + index + ': in-flight scan cancelled on dispose', disposeMs < 100, 'cpu after dispose=' + disposeMs.toFixed(0) + 'ms/400ms');
  await new Promise((r) => server.close(r));
}

const baselineResources = resources();
const baselineHandles = handles();
for (let i = 0; i < 5; i += 1) await cycle(i);
await new Promise((r) => setTimeout(r, 500));
const idleBefore = process.cpuUsage();
await new Promise((r) => setTimeout(r, 1000));
const idleDelta = process.cpuUsage(idleBefore);
const idleCpu = (idleDelta.user + idleDelta.system) / 1000;
check('no unhandled rejection across 5 lifecycles', rejections.length === 0, 'rejections=' + rejections.length);
check('no active-resource growth across 5 lifecycles', resources() - baselineResources <= 2, 'resources ' + baselineResources + ' -> ' + resources());
check('no handle growth across 5 lifecycles', handles() - baselineHandles <= 2, 'handles ' + baselineHandles + ' -> ' + handles());
check('process idle after dispose (no orphan scan/poll)', idleCpu < 150, 'idle cpu=' + idleCpu.toFixed(0) + 'ms/s');

await fs.rm(home, { recursive: true, force: true });
await fs.rm(music, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
