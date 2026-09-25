// A1-03 回归：停用必须**终止在飞的 MV 子进程**，并清空 module 级 `mvJobs`。
//
// 为什么需要这条：`mvJobs` 是 module 级 Map，而每次热重载都会在 ESM 注册表里
// 留下一个无法卸载的条目，旧 Map 被永久钉住。修复前 dispose() 完全不碰它，
// 后果是 (a) ffmpeg 继续跑到结束、继续往临时目录写 .part，(b) 容器无界增长，
// (c) 每次热重载永久泄漏一份。做法：先 pruneMvJobs() 收敛、终态条目带 TTL，
// dispose() 里 killAllMvJobs() 显式 SIGKILL 每个子进程。
//
// 手法：把 DSH_MUSIC_FFMPEG 指向一个「自报 PID 然后长睡」的假 ffmpeg，
// 起一个 MV 任务，在它跑着的时候 dispose，然后断言那个 PID 已经不在了。
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-mvt-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-mvt-music-'));
process.env.DSH_HOME = home;
await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');

// 假 ffmpeg：把自己的 PID 写进文件，然后长睡（被 kill 时才退出）。
const pidFile = path.join(home, 'fake-ffmpeg.pid');
const fakeFfmpeg = path.join(home, 'fake-ffmpeg.sh');
await fs.writeFile(fakeFfmpeg, '#!/bin/sh\necho $$ > "' + pidFile + '"\nsleep 300\n', 'utf8');
await fs.chmod(fakeFfmpeg, 0o755);
process.env.DSH_MUSIC_FFMPEG = fakeFfmpeg;

// .avi 不在 MV_DIRECT_CONTAINERS 里 → mvPlan 给 remux → 会真的起一个任务
await fs.writeFile(path.join(music, 'film.avi'), Buffer.alloc(2048, 7));

let handler = null;
const disposers = [];
const ctx = {
  effect: (fn, label) => { const d = fn(); if (typeof d === 'function') disposers.push({ label, d }); return d; },
  get: () => undefined,
  webServer: { register: (route) => { handler = route.handler; return () => {}; } },
};
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href);
apply(ctx);
const server = createServer((req, res) => { handler(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500).end(String(e)); }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = 'http://127.0.0.1:' + port + '/dsh-music';

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 先让库扫出来
await fetch(base + '/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: music }) });
let lib = null;
for (let i = 0; i < 200 && lib === null; i += 1) {
  const payload = await fetch(base + '/api/library').then((r) => r.json()).catch(() => null);
  if (payload && payload.scanning !== true && payload.tracks.length > 0) lib = payload;
  else await sleep(50);
}
check('library scanned the fake video', lib !== null && lib.tracks.length === 1, 'tracks=' + (lib?.tracks?.length ?? '?'));

// 强制走 remux 档，确保真的 spawn（默认档位对 .avi 本来就是 remux）
const mv = await fetch(base + '/api/mv?id=' + encodeURIComponent('film.avi') + '&mode=remux').then((r) => r.json()).catch(() => null);
check('MV plan started a job', mv !== null && mv.state !== 'direct', 'state=' + (mv?.state ?? '?'));

// 等假 ffmpeg 自报 PID
let pid = 0;
for (let i = 0; i < 100 && pid === 0; i += 1) {
  try { pid = Number((await fs.readFile(pidFile, 'utf8')).trim()); } catch { /* 还没写 */ }
  if (pid === 0) await sleep(50);
}
check('a real ffmpeg child process is running', pid > 0 && alive(pid), 'pid=' + pid);

// 停用
const teardownEntry = disposers.find((e) => String(e.label).includes('host teardown'));
check('host teardown effect captured', teardownEntry !== undefined, 'effects=' + disposers.map((e) => e.label).join(','));
if (teardownEntry !== undefined) teardownEntry.d();
await sleep(600);

check('A1-03 dispose terminates the in-flight ffmpeg child', pid > 0 && !alive(pid), 'pid=' + pid + ' alive=' + (pid > 0 && alive(pid)));

server.close();
await fs.rm(home, { recursive: true, force: true });
await fs.rm(music, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
