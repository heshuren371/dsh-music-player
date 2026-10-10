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

// 假 ffmpeg：把自己的 PID 追加进日志，然后 `exec` 成长睡进程。
// ⚠️ 必须 `exec`：写成 `sh` 再 `sleep 300` 的话，`sh` 被杀掉之后**子进程还握着 stdout/stderr 管道**，
// Node 永远等不到 `close`（实测：exit 305ms 就到、close 5s 后仍不来）—— 于是
// 「SIGKILL 之后档位循环还会不会再起一个」这条路径在夹具里根本走不到，那样断言就是恒绿。
const pidLog = path.join(home, 'fake-ffmpeg.log');
const fakeFfmpeg = path.join(home, 'fake-ffmpeg.sh');
await fs.writeFile(fakeFfmpeg, '#!/bin/sh\necho $$ >> "' + pidLog + '"\nexec sleep 300\n', 'utf8');
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
  try { pid = Number((await fs.readFile(pidLog, 'utf8')).split('\n')[0]); } catch { /* 还没写 */ }
  if (pid === 0) await sleep(50);
}
check('a real ffmpeg child process is running', pid > 0 && alive(pid), 'pid=' + pid);

// 停用
const teardownEntry = disposers.find((e) => String(e.label).includes('host teardown'));
check('host teardown effect captured', teardownEntry !== undefined, 'effects=' + disposers.map((e) => e.label).join(','));
if (teardownEntry !== undefined) teardownEntry.d();
await sleep(900);

check('A1-03 dispose terminates the in-flight ffmpeg child', pid > 0 && !alive(pid), 'pid=' + pid + ' alive=' + (pid > 0 && alive(pid)));

// A1-03 的另一半：SIGKILL 只让 `close` 带着非零码回来，档位循环若没有「已放弃」标记
// 就会接着起下一档 —— 新 module 不认识那个子进程，于是卸载后**还有 ffmpeg 在写临时目录**。
// 判据是「一共只起过一个子进程」（3 档意味着最多 3 次），而不是「第一个 PID 死了」。
let spawned = [];
try { spawned = (await fs.readFile(pidLog, 'utf8')).trim().split('\n').filter((line) => line.length > 0); } catch { /* 没起过 */ }
check('A1-03 dispose leaves no respawned ffmpeg behind (attempt loop stopped, not just the first child killed)',
  spawned.length === 1, 'spawns=' + spawned.length + ' pids=' + spawned.join(','));

server.close();
await fs.rm(home, { recursive: true, force: true });
await fs.rm(music, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
