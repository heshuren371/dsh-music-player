// 释放面 / 泄漏门禁（宿主半边）—— 补上 §6.3 门禁表里一直空着的那条：
//   「dispose() 后容器为空、无存活子进程；**且热重载 N 次后 module 级容器不增长**」
//
// 为什么这条重要：AGENTS §2.2 记着「module 级状态在热重载下会整份复制，旧的被 ESM
// 注册表永久持有」—— 本仓库每次保存 host.js 都产生一个新 module 实例，因此 module 级
// 容器既是每次重载的泄漏源，又是无界增长的载体。历史上出过「卸载后定时器仍跑」的
// 同类事故（A3-01）。
//
// 判据分成「脆」与「噪」两类，脆信号是主判据：
//   脆 ①  fd 数在 8 次重载后不增长（readdir /dev/fd）
//   脆 ②  活跃子进程句柄为 0（不留下孤儿）
//   脆 ③  dispose() 之后 1.5s 内 CPU ≈ 0（没有自续期定时器）
//   噪 ④  heap 增长有界（GC 后测量，阈值放宽并记录实测值；单靠它不足以证明无泄漏，
//        所以它只作为辅助信号，真正的判据是上面三条）
import { createServer } from 'node:http';
import { promises as fs, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const gc = globalThis.gc ?? (() => {});

const RELOADS = 8;
const plugin = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-leak-plugin-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-leak-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-leak-music-'));
process.env.DSH_HOME = home;

await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');
for (let i = 0; i < 20; i += 1) {
  const n = 2000;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  await fs.writeFile(path.join(music, 't' + String(i).padStart(3, '0') + '.wav'), buf);
}

await fs.mkdir(path.join(plugin, 'lib'), { recursive: true });
for (const file of ['index.js', 'host.js', 'http-bridge.js']) {
  await fs.copyFile(path.join(root, 'lib', file), path.join(plugin, 'lib', file));
}
await fs.symlink(path.join(root, 'node_modules'), path.join(plugin, 'node_modules'), 'dir');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

// 每次 apply() 都新建一套宿主 + 服务器（重载 = 旧实例 dispose + 新实例 create）。
async function startHost() {
  let handler = null;
  let disposed = 0;
  const ctx = {
    effect: (fn) => { fn(); return () => { disposed += 1; }; },
    get: () => undefined,
    webServer: { register: (route) => { handler = route.handler; return () => {}; } },
  };
  const mod = await import(pathToFileURL(path.join(plugin, 'lib', 'index.js')).href + '?n=' + Math.random());
  mod.apply(ctx);
  const server = createServer((req, res) => { handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, disposed: () => disposed };
}

const fdCount = () => { try { return readdirSync('/dev/fd').length; } catch { return -1; } };
const childCount = () => process._getActiveHandles().filter((h) => h?.constructor?.name === 'ChildProcess').length;
const cpuMs = (usage) => (usage.user + usage.system) / 1000;

let current = await startHost();
const base = () => 'http://127.0.0.1:' + current.port + '/dsh-music';
const get = async (p) => { const r = await fetch(base() + p); return { status: r.status, body: await r.json().catch(() => null) }; };

// 先让一次扫描跑完，之后每次重载也会各自扫描（这正是容器最容易被塞满的路径）。
const waitScan = async () => {
  for (let i = 0; i < 400; i += 1) {
    const r = await get('/api/library');
    if (r.body !== null && r.body.scanning !== true && (r.body.tracks ?? []).length > 0) return r.body;
    await new Promise((r2) => setTimeout(r2, 25));
  }
  return null;
};
const first = await waitScan();
check('fixture: library scan completes', first !== null && first.tracks.length === 20, first === null ? 'scan timeout' : 'tracks=' + first.tracks.length);

// 预热两次重载：让 ESM 注册表、模块缓存、JIT 先进入稳态，避免把「首次加载」
// 的一次性分配算成泄漏。
for (let i = 0; i < 2; i += 1) {
  await fs.copyFile(path.join(root, 'lib', 'host.js'), path.join(plugin, 'lib', 'host.js'));
  await new Promise((r) => setTimeout(r, 1100));   // 加载器对重载有速率限制
  await waitScan();
}

gc();
const heapStart = process.memoryUsage().heapUsed;
const fdStart = fdCount();
const childStart = childCount();

for (let i = 0; i < RELOADS; i += 1) {
  // 保存一次 host.js：入口薄壳按 mtime 重载，旧实例应走 dispose 清理。
  await fs.copyFile(path.join(root, 'lib', 'host.js'), path.join(plugin, 'lib', 'host.js'));
  await new Promise((r) => setTimeout(r, 1100));
  const lib = await waitScan();
  if (lib === null) { check('reload ' + (i + 1) + ' serves a library', false, 'scan timeout'); break; }
}

gc();
const heapEnd = process.memoryUsage().heapUsed;
const fdEnd = fdCount();
const childEnd = childCount();

// 脆信号 ①：fd 不增长
check('no fd growth across ' + RELOADS + ' hot reloads',
  fdStart < 0 || fdEnd - fdStart <= 8, 'fds ' + fdStart + ' -> ' + fdEnd);
// 脆信号 ②：不留孤儿子进程
check('no orphan child process after ' + RELOADS + ' hot reloads',
  childEnd === 0, 'children ' + childStart + ' -> ' + childEnd);
// 噪信号 ④：heap 增长有界。阈值是**用正对照标定**出来的，不是拍的：
//   无泄漏基线（本仓库实测）      → +3.01MB / 8 次
//   注入 1MB/次 的 module 级泄漏  → +10.99MB / 8 次
// 第一版阈值写了 12MB **放过了那个泄漏**（正对照暴露了它），改成 6MB：
// 对基线有 2x 余量，对真实泄漏有 1.8x 余量。**改这个阈值前先重跑正对照**，
// 否则会把它放宽成恒绿（§6.2「禁止为了让门禁变绿而放宽阈值」）。
const heapGrowthMb = (heapEnd - heapStart) / (1024 * 1024);
const perReloadMb = heapGrowthMb / RELOADS;
check('heap growth stays bounded across reloads (< 6MB after GC, < 0.8MB/reload)',
  heapGrowthMb < 6 && perReloadMb < 0.8,
  heapGrowthMb.toFixed(2) + 'MB over ' + RELOADS + ' reloads (' + perReloadMb.toFixed(2) + 'MB each)');

// 脆信号 ③：dispose 之后没有自续期定时器在烧 CPU。
await current.server.close();
current.disposed();
gc();
const cpuBefore = process.cpuUsage();
await new Promise((r) => setTimeout(r, 1500));
const idle = cpuMs(process.cpuUsage(cpuBefore));
check('idle CPU after dispose stays ~0 (< 60ms / 1.5s)', idle < 60, 'idle cpu=' + idle.toFixed(0) + 'ms');

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
