// The plugin entry is a hot-reload shell: editing host.js must take effect on
// the NEXT request without re-calling apply() — this is what removes the
// "restart dsh web after every host change" step.
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const plugin = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-hot-plugin-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-hot-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-hot-music-'));
process.env.DSH_HOME = home;

await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');
await fs.writeFile(path.join(music, 'song.wav'), (() => {
  const rate = 8000; const n = rate; const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40); return buf;
})());

// A copy of the plugin tree: host.js resolves music-metadata / node-taglib-sharp
// through a node_modules symlink back to the real workspace.
await fs.mkdir(path.join(plugin, 'lib'), { recursive: true });
await fs.copyFile(path.join(root, 'lib', 'index.js'), path.join(plugin, 'lib', 'index.js'));
await fs.copyFile(path.join(root, 'lib', 'host.js'), path.join(plugin, 'lib', 'host.js'));
// host.js 现在通过 ./http-bridge.js 做 Fetch ⇄ node:http 适配，拷贝树里也要带上。
await fs.copyFile(path.join(root, 'lib', 'http-bridge.js'), path.join(plugin, 'lib', 'http-bridge.js'));
await fs.symlink(path.join(root, 'node_modules'), path.join(plugin, 'node_modules'), 'dir');

let handler = null;
const ctx = { effect: (fn) => fn(), get: () => undefined, webServer: { register: (r) => { handler = r.handler; return () => {}; } } };
const { apply } = await import(pathToFileURL(path.join(plugin, 'lib', 'index.js')).href);
apply(ctx);
const server = createServer((req, res) => { handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';
const json = async (url, options) => { const r = await fetch(url, options); return { status: r.status, body: await r.json() }; };

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

const first = await json(base + '/api/nope');
check('unknown route → old message', first.status === 404 && first.body.error === 'unknown dsh-music endpoint', JSON.stringify(first.body));

// Edit the copied host.js in place, exactly like a developer editing lib/host.js.
const hostPath = path.join(plugin, 'lib', 'host.js');
const source = await fs.readFile(hostPath, 'utf8');
await fs.writeFile(hostPath, source.replace('unknown dsh-music endpoint', 'hot-reloaded endpoint'), 'utf8');
// The loader rate-limits reloads so rapid saves cannot balloon the ESM registry.
await new Promise((resolve) => setTimeout(resolve, 1100));

const second = await json(base + '/api/nope');
check('next request picks up the edited host without apply() again', second.status === 404 && second.body.error === 'hot-reloaded endpoint', JSON.stringify(second.body));

const lib = await json(base + '/api/library');
check('reloaded host still serves the library', lib.status === 200 && Array.isArray(lib.body.tracks), 'status=' + lib.status);

server.close();
await fs.rm(plugin, { recursive: true, force: true });
await fs.rm(home, { recursive: true, force: true });
await fs.rm(music, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
