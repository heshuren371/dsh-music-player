// MV（音乐视频）支持回归：扫描视频文件 → 判定出画方式 → ffmpeg 转封装 → 缓存文件 Range 服务。
// 没有 ffmpeg 的机器上，前半段（扫描 + 判定 + 参数）仍然全跑，转封装部分改用占位文件验证失败路径。
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-mv-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-mv-music-'));
process.env.DSH_HOME = home;
await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => existsSync(p)) ?? null;
const run = (args) => FFMPEG === null ? 1 : spawnSync(FFMPEG, args, { stdio: 'ignore' }).status ?? 1;

// 最小 WAV（音频轨，用来验证非视频文件被 /mv 拒绝）
const rate = 8000, n = rate;
const wav = Buffer.alloc(44 + n * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
wav.writeUInt32LE(n * 2, 40);
await fs.writeFile(path.join(music, 'song.wav'), wav);

let generated = false;
if (FFMPEG !== null) {
  const clip = path.join(music, 'clip.mp4');
  generated = run(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]) === 0;
  if (generated) {
    run(['-hide_banner', '-y', '-i', clip, '-c', 'copy', path.join(music, 'clip.mkv')]);
    run(['-hide_banner', '-y', '-i', clip, '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'pcm_s16le', path.join(music, 'clip.avi')]);
    run(['-hide_banner', '-y', '-i', clip, '-c:v', 'libx265', '-tag:v', 'hvc1', '-c:a', 'aac', path.join(music, 'clip-hevc.mp4')]);
    // 用户实际踩到的那个：MPEG-4 Part 2 (Simple Profile) 的 MP4 —— Chromium 没这个解码器，
    // 播出来只有声音没画面、而且不报 error，所以必须靠判定拦住（走转码）。
    run(['-hide_banner', '-y', '-i', clip, '-c:v', 'mpeg4', '-vtag', 'mp4v', '-c:a', 'aac', path.join(music, 'clip-mpeg4.mp4')]);
  }
}
if (!generated) {
  // 没有 ffmpeg：写占位文件，至少验证「扫得到 + 按容器保守判定」。
  await fs.writeFile(path.join(music, 'clip.mp4'), Buffer.from('not a real mp4'));
  await fs.writeFile(path.join(music, 'clip.mkv'), Buffer.from('not a real mkv'));
  await fs.writeFile(path.join(music, 'clip.avi'), Buffer.from('not a real avi'));
}

let handler = null;
const ctx = { effect: (fn) => fn(), get: () => undefined, webServer: { register: (route) => { handler = route.handler; return () => {}; } } };
const { apply } = await import('../lib/index.js');
apply(ctx);
const server = createServer((req, res) => { handler(req, res).catch((error) => { res.writeHead(500).end(String(error)); }); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';
const json = async (url, options) => { const r = await fetch(url, options); return { status: r.status, body: await r.json().catch(() => null) }; };
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

await json(base + '/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: music }) });
let library = null;
for (let i = 0; i < 60; i += 1) {
  const r = await json(base + '/api/library');
  if (r.body?.scanning !== true && (r.body?.tracks ?? []).length > 0) { library = r.body; break; }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const tracks = library?.tracks ?? [];
const byName = (name) => tracks.find((t) => t.name === name);
check('library scan finds audio + video files', tracks.length >= 3, tracks.map((t) => t.name).join(', '));
check('audio track is kind=audio', byName('song.wav')?.kind === 'audio', JSON.stringify(byName('song.wav') ?? null));
check('video tracks are kind=video', byName('clip.mp4')?.kind === 'video' && byName('clip.mkv')?.kind === 'video', JSON.stringify(tracks.filter((t) => t.kind === 'video').map((t) => t.name)));
check('video codec is detected from the container', generated ? byName('clip.mp4')?.videoCodec === 'h264' && byName('clip.mkv')?.videoCodec === 'h264' : byName('clip.mp4')?.videoCodec === null, 'mp4=' + byName('clip.mp4')?.videoCodec + ' mkv=' + byName('clip.mkv')?.videoCodec);

const mv = async (name, force) => json(base + '/api/mv?id=' + encodeURIComponent(name) + (force === true ? '&force=1' : ''));
const mp4 = await mv('clip.mp4');
check('mp4 plans to direct play', mp4.status === 200 && mp4.body.mode === 'direct' && String(mp4.body.url).includes('/api/dsh-music/stream'), JSON.stringify(mp4.body));
const mkv = await mv('clip.mkv');
check('mkv also plans to direct play (Chromium demuxes Matroska)', mkv.status === 200 && mkv.body.mode === 'direct', JSON.stringify(mkv.body));
const avi = await mv('clip.avi');
check('avi plans to remux (Chromium cannot open the container)', avi.status === 200 && avi.body.mode === 'remux', JSON.stringify(avi.body));
check('non-video tracks are rejected', (await mv('song.wav')).status === 400);
const missing = await json(base + '/api/mv?id=nope.mp4');
check('unknown track → 404', missing.status === 404, 'status=' + missing.status);
check('bad cache key is rejected', (await json(base + '/api/mvfile?k=../etc/passwd')).status === 400);

if (generated && existsSync(path.join(music, 'clip-mpeg4.mp4'))) {
  const mpeg4 = await mv('clip-mpeg4.mp4');
  check('MPEG-4 Part 2 is planned as transcode (no silent black screen)', mpeg4.body.mode === 'transcode', JSON.stringify({ mode: mpeg4.body.mode, codec: byName('clip-mpeg4.mp4')?.videoCodec }));
} else {
  check('mpeg4 detection test skipped (no ffmpeg)', true, 'skipped');
}

if (generated && existsSync(path.join(music, 'clip-hevc.mp4'))) {
  const conservative = await mv('clip-hevc.mp4');
  check('hevc plans to transcode when the client cannot decode it', conservative.body.mode === 'transcode', JSON.stringify(conservative.body));
  await json(base + '/api/caps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hevc: true }) });
  const capable = await mv('clip-hevc.mp4');
  check('hevc plans to direct play once the client reports HEVC support', capable.body.mode === 'direct', JSON.stringify(capable.body));
  await json(base + '/api/caps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hevc: false }) });
} else {
  check('hevc capability test skipped (no ffmpeg / libx265)', true, 'skipped');
}

if (FFMPEG === null || !generated) {
  const none = await mv('clip.avi');
  check('without ffmpeg the remux path fails cleanly with a reason', none.body.state === 'failed' && String(none.body.error).includes('ffmpeg'), JSON.stringify(none.body));
} else {
  let status = avi.body;
  for (let i = 0; i < 80 && status.state !== 'ready' && status.state !== 'failed'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    status = (await mv('clip.avi')).body;
  }
  check('ffmpeg remux finishes and hands back a cache URL', status.state === 'ready' && String(status.url).includes('/api/dsh-music/mvfile?k='), JSON.stringify({ state: status.state, progress: status.progress, error: status.error }));
  if (status.state === 'ready') {
    const origin = base.replace('/dsh-music', '');   // status.url 已是 /api/dsh-music/... 规范形态
    const whole = await fetch(origin + status.url);
    const bytes = Buffer.from(await whole.arrayBuffer());
    check('mv cache file is served as MP4 with byte ranges', whole.status === 200 && whole.headers.get('accept-ranges') === 'bytes' && bytes.length > 1000 && bytes.subarray(4, 8).toString() === 'ftyp', 'status=' + whole.status + ' bytes=' + bytes.length + ' head=' + bytes.subarray(4, 8).toString());
    const ranged = await fetch(origin + status.url, { headers: { range: 'bytes=0-99' } });
    check('mv cache supports Range (seeking works)', ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 100, 'status=' + ranged.status);
    const cached = await mv('clip.avi');
    check('second request hits the cache (no re-encode)', cached.body.state === 'ready' && cached.body.progress === 1, JSON.stringify({ state: cached.body.state, progress: cached.body.progress }));
  }
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED');
server.close();
process.exit(failures === 0 ? 0 : 1);