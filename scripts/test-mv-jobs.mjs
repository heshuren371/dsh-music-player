// MV 任务生命周期：音轨判定（不按容器豁免）、转码档位顺序、失败任务的「重试」语义。
//
// 为什么需要这三条：
//   ① `mvPlan` 曾经对 `.mkv` 豁免自己的音轨判定，于是「h264 + DTS/TrueHD 的 mkv」被判成直出，
//      元素只解得出画面、音轨被丢掉 —— 症状就是有画面、没声音，且**不报 error**。
//   ② 音轨已知解不了时第一档若是 `copy`（只换壳），产物音轨照旧解不了，白跑一遍还被缓存成 ready。
//   ③ 失败任务在 `mvJobs` 里缓存 10 分钟，不带 `retry=1` 的「重试」只会拿回同一条失败记录。
//
// 需要 ffmpeg 才能造出「h264 + mp2」的 MKV（mp2 不在 MV_DIRECT_AUDIO 里，正是①的形态）；
// 没有 ffmpeg 时前半段仍跑，后半段显式标 skipped。
import { createServer } from 'node:http';
import { promises as fs, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-mvj-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-mvj-music-'));
process.env.DSH_HOME = home;
await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => existsSync(p)) ?? null;
const run = (args) => FFMPEG === null ? 1 : spawnSync(FFMPEG, args, { stdio: 'ignore' }).status ?? 1;

let generated = false;
if (FFMPEG !== null) {
  const clip = path.join(music, 'clip.mp4');
  generated = run(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]) === 0;
  if (generated) {
    // ①的夹具：mkv 容器 + h264 画面 + **mp2** 音轨（mp2 既不在 MV_DIRECT_AUDIO 里，
    // 也不在 AUDIO_CODEC_PATTERNS 里 —— 顺带验证「探测到但认不出」也要走 remux）。
    run(['-hide_banner', '-y', '-i', clip, '-c:v', 'copy', '-c:a', 'mp2', '-b:a', '128k', path.join(music, 'clip-mp2.mkv')]);
  }
}
if (!generated) {
  await fs.writeFile(path.join(music, 'clip.mp4'), Buffer.from('not a real mp4'));
}

let handler = null;
const ctx = { effect: (fn) => fn(), get: () => undefined, webServer: { register: (route) => { handler = route.handler; return () => {}; } } };
const { apply } = await import('../lib/index.js');
apply(ctx);
const server = createServer((req, res) => { handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500).end(String(error)); }); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';
const json = async (url) => { const r = await fetch(url); return { status: r.status, body: await r.json().catch(() => null) }; };
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scan = async () => {
  await fetch(base + '/api/refresh', { method: 'POST' });
  for (let i = 0; i < 300; i += 1) {
    const payload = (await json(base + '/api/library')).body;
    if (payload?.scanning !== true) return payload;
    await sleep(100);
  }
  return null;
};
await fetch(base + '/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: music }) });
let library = await scan();
const byName = (name) => (library?.tracks ?? []).find((t) => t.name === name);
const mv = async (name, extra = '') => (await json(base + '/api/mv?id=' + encodeURIComponent(name) + extra)).body;
const waitState = async (name, extra, want, rounds = 120) => {
  let body = await mv(name, extra);
  for (let i = 0; i < rounds && body?.state !== want; i += 1) {
    await sleep(100);
    body = await mv(name, extra);
  }
  return body;
};

// A1：payload 必须下发音轨编码（客户端要用它判断 WASM 旁路会不会「有画面没声音」）。
check('A1: /library payload carries audioCodec (whitelist projection)',
  library !== null && Object.prototype.hasOwnProperty.call(byName('clip.mp4') ?? {}, 'audioCodec'),
  'track=' + JSON.stringify(byName('clip.mp4') ?? null));

if (!generated || !existsSync(path.join(music, 'clip-mp2.mkv'))) {
  check('A2/A3/B: mp2-in-mkv fixtures skipped (no ffmpeg or no mp2 encoder)', true, 'skipped');
  server.close();
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(music, { recursive: true, force: true });
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
}

const mp2 = byName('clip-mp2.mkv');
check('A2: mkv with an undecodable audio codec is seen as such (not null)',
  mp2?.audioCodec === 'mp2', 'audioCodec=' + JSON.stringify(mp2?.audioCodec));
const plan = await mv('clip-mp2.mkv');
check('A3: mkv is **not** exempt from the audio verdict — h264+mp2 must remux (direct = picture without sound)',
  plan?.mode === 'remux', JSON.stringify({ mode: plan?.mode, audioCodec: mp2?.audioCodec }));

// A4：真实 remux 走 `audio` 档（视频原样 + 音轨转 AAC），产物必须真的能拿到。
const ready = await waitState('clip-mp2.mkv', '', 'ready');
check('A4: the audio attempt succeeds and hands back a cache file (video copied, audio transcoded)',
  ready?.state === 'ready' && typeof ready?.key === 'string', JSON.stringify({ state: ready?.state, error: ready?.error }));

// ── B. 失败任务的「重试」语义 + 档位顺序（用会立刻失败的假 ffmpeg）──────────────
// 抄一份成 bad-audio.mkv：**换路径 = 换缓存键**，否则会命中 A4 的 ready 缓存文件。
const argvLog = path.join(home, 'ffmpeg-argv.log');
const fakeFfmpeg = path.join(home, 'fake-ffmpeg.sh');
await fs.writeFile(fakeFfmpeg, '#!/bin/sh\necho "$@" >> "' + argvLog + '"\nexit 1\n', 'utf8');
await fs.chmod(fakeFfmpeg, 0o755);
await fs.copyFile(path.join(music, 'clip-mp2.mkv'), path.join(music, 'bad-audio.mkv'));
library = await scan();                       // 仍用真 ffprobe 探测编码
check('B0: the retry fixture is an mkv with mp2 audio (fixture sanity)',
  byName('bad-audio.mkv')?.audioCodec === 'mp2', 'audioCodec=' + JSON.stringify(byName('bad-audio.mkv')?.audioCodec));
process.env.DSH_MUSIC_FFMPEG = fakeFfmpeg;
const spawns = async () => { try { return (await fs.readFile(argvLog, 'utf8')).trim().split('\n').filter((l) => l.length > 0); } catch { return []; } };

const failed = await waitState('bad-audio.mkv', '', 'failed');
const firstArgs = (await spawns())[0] ?? '';
check('B1: the mp2 job starts at the `audio` attempt (copy would keep the undecodable track)',
  failed?.state === 'failed' && firstArgs.includes('-c:a') && firstArgs.includes('aac') && !firstArgs.includes('-c copy'),
  'first=' + firstArgs.slice(0, 90));

const countBefore = (await spawns()).length;
const cached = await mv('bad-audio.mkv');
await sleep(250);
check('B2: without retry the failed job is served from the cache (no new ffmpeg run)',
  cached?.state === 'failed' && (await spawns()).length === countBefore,
  'state=' + cached?.state + ' spawns=' + countBefore + '→' + (await spawns()).length);

const retried = await mv('bad-audio.mkv', '&retry=1');
// 新任务的第一档是**下一个 tick** 才 spawn 的：等它真的起来（有界），别赌固定时长。
for (let i = 0; i < 40 && (await spawns()).length === countBefore; i += 1) await sleep(50);
check('B3: `retry=1` really starts a new attempt instead of returning the cached failure',
  retried?.state === 'preparing' && (await spawns()).length > countBefore,
  'state=' + retried?.state + ' spawns=' + countBefore + '→' + (await spawns()).length);

server.close();
await fs.rm(home, { recursive: true, force: true });
await fs.rm(music, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
