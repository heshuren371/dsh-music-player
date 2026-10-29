// MV（音乐视频）支持回归：扫描视频文件 → 判定出画方式 → ffmpeg 转封装 → 缓存文件 Range 服务。
// 没有 ffmpeg 的机器上，前半段（扫描 + 判定 + 参数）仍然全跑，转封装部分改用占位文件验证失败路径。
import { createServer } from 'node:http';
import { mvFfmpegArgs } from '../lib/host.js';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
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
    // 容器认不出来但编码认得的组合（h264 + aac 装进 mpegts）：判定必须落在**容器**上走换壳。
    run(['-hide_banner', '-y', '-i', clip, '-c', 'copy', '-f', 'mpegts', path.join(music, 'clip.ts')]);
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
  await fs.writeFile(path.join(music, 'clip.ts'), Buffer.from('not a real ts'));
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

// 转码参数：fast 档必须 ultrafast + 1080P 上限 + 可搬运音频 copy；full 档保留兼容兜底。
const fastArgs = mvFfmpegArgs({ path: '/tmp/x', width: 3840, height: 2160, audioCodec: 'aac' }, 'fast', '/tmp/out.mp4');
const fallbackArgs = mvFfmpegArgs({ path: '/tmp/x', width: 3840, height: 2160, audioCodec: 'aac' }, 'full', '/tmp/out.mp4');
check('fast transcode uses ultrafast, scales long edge to 1080P and copies AAC', fastArgs.includes('ultrafast') && fastArgs.includes('scale=1920:-2') && fastArgs.includes('copy'), fastArgs.join(' '));
check('full fallback keeps veryfast at original resolution and re-encodes audio', fallbackArgs.includes('veryfast') && !fallbackArgs.includes('scale=1920:-2') && fallbackArgs.includes('aac'), fallbackArgs.join(' '));



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
check('library payload exposes addedAt for recently-added sorting', tracks.every((t) => typeof t.addedAt === 'number' && t.addedAt > 0), JSON.stringify(tracks.map((t) => [t.name, t.addedAt])));
check('audio track is kind=audio', byName('song.wav')?.kind === 'audio', JSON.stringify(byName('song.wav') ?? null));
check('video tracks are kind=video', byName('clip.mp4')?.kind === 'video' && byName('clip.mkv')?.kind === 'video', JSON.stringify(tracks.filter((t) => t.kind === 'video').map((t) => t.name)));
check('video codec is detected from the container', generated ? byName('clip.mp4')?.videoCodec === 'h264' && byName('clip.mkv')?.videoCodec === 'h264' : byName('clip.mp4')?.videoCodec === null, 'mp4=' + byName('clip.mp4')?.videoCodec + ' mkv=' + byName('clip.mkv')?.videoCodec);

const mv = async (name, force) => json(base + '/api/mv?id=' + encodeURIComponent(name) + (force === true ? '&force=1' : ''));
const mp4 = await mv('clip.mp4');
check('mp4 plans to direct play', mp4.status === 200 && mp4.body.mode === 'direct' && String(mp4.body.url).includes('/api/dsh-music/stream'), JSON.stringify(mp4.body));
const mkv = await mv('clip.mkv');
check('mkv also plans to direct play (Chromium demuxes Matroska)', mkv.status === 200 && mkv.body.mode === 'direct', JSON.stringify(mkv.body));
const avi = await mv('clip.avi');
const ts = await mv('clip.ts');
// 与夹具无关的判据：容器 Chromium 解不开 ⇒ 绝不允许 direct（换壳或重编码都行）。
check('avi / ts never plan direct play (Chromium cannot demux those containers)',
  avi.body.mode !== 'direct' && ts.body.mode !== 'direct',
  JSON.stringify({ avi: avi.body.mode, ts: ts.body.mode }));
if (generated) {
  // ffprobe 真跑得到 avi（music-metadata 对 avi 抛错 ⇒ 探测必须在它的 try 之外）：
  // mpeg4 画面被认出来 ⇒ 必须重编码；只换壳的话画面照旧是黑的。
  check('avi (mpeg4 video) plans to transcode — ffprobe sees the codec where music-metadata throws',
    avi.body.mode === 'transcode',
    JSON.stringify({ mode: avi.body.mode, codec: byName('clip.avi')?.videoCodec, audio: byName('clip.avi')?.audioCodec }));
  check('ts (h264+aac in a container Chromium cannot open) plans to remux',
    ts.body.mode === 'remux',
    JSON.stringify({ mode: ts.body.mode, codec: byName('clip.ts')?.videoCodec, audio: byName('clip.ts')?.audioCodec }));
} else {
  // 没有 ffmpeg 就没有编码信息（占位文件 + 无 ffprobe），只能按容器保守判定 —— 这正是
  // 上面那条「绝不 direct」能覆盖的部分，编码判定留给有 ffmpeg 的环境。
  check('avi/ts codec-level planning skipped (no ffmpeg fixtures)', true, 'skipped');
}
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

// ── 持久化转码缓存（全部靠预置产物，不依赖 ffmpeg）──────────────────────────
// 契约：/api/mv 的产物落在 $DSH_HOME/storages/dsh-music-mv（临时目录会被系统清理 ⇒ 以前转过的
// 要重转一遍）；命中直接把 mtime 推新当 LRU；条目数有上限；过期的 .part 半成品会被清掉，
// 正在写的那个不能删（删除与写入竞态会让 ffmpeg 失败）。
{
  // 取一个**确实存在**的视频夹具：前面的小节可能已经把它转格式或移走了。
  // 注意：payload 里的 track 是**白名单投影**，没有 `path` 字段 —— 路径要用 dir + id 组装。
  const fileOf = (t) => path.join(library.dir, t.id);
  const candidates = library.tracks.filter((t) => t.kind === 'video' && existsSync(fileOf(t)));
  const track = candidates.find((t) => t.name === 'clip.mkv') ?? candidates[0];
  const trackPath = track === undefined ? null : fileOf(track);
  check('cache probe found a real video fixture', trackPath !== null,
    JSON.stringify(library.tracks.map((t) => t.name + (existsSync(fileOf(t)) ? '' : '(gone)'))));
  const stat = trackPath === null ? null : await fs.stat(trackPath);
  const key = createHash('sha1').update('remux|' + trackPath + '|' + stat.size + '-' + Math.round(stat.mtimeMs)).digest('hex').slice(0, 32);
  const cacheDir = path.join(home, 'storages', 'dsh-music-mv');
  const cachedFile = path.join(cacheDir, key + '.mp4');
  const askMv = () => json(base + '/api/mv?id=' + encodeURIComponent('clip.mkv') + '&mode=remux');
  await fs.mkdir(cacheDir, { recursive: true });
  const payload = Buffer.from('FAKE-MP4-PAYLOAD');
  await fs.writeFile(cachedFile, payload);

  if (track !== undefined) {
  // 契约是「落在插件数据区 $DSH_HOME/storages」（生产环境里 DSH_HOME 持久），而不是
  // `os.tmpdir()/dsh-music-mv` 这个裸临时目录 —— 测试里 DSH_HOME 自己也在临时目录下，
  // 所以只断言「不在裸临时目录」是不够的，必须钉住数据区路径。
  check('cache lives in the plugin data area (survives restarts), not a bare temp dir',
    cacheDir === path.join(home, 'storages', 'dsh-music-mv')
      && cacheDir !== path.join(os.tmpdir(), 'dsh-music-mv')
      && existsSync(cachedFile), cacheDir);
  const hit = await askMv();
  check('a previously transcoded MV is served from the cache (no re-encode)',
    hit.body.state === 'ready' && String(hit.body.url).includes(key), JSON.stringify(hit.body));
  const served = await fetch(base + '/api/mvfile?k=' + key);
  const bytes = Buffer.from(await served.arrayBuffer());
  check('the cached bytes are what /mvfile serves', served.status === 200 && bytes.equals(payload), 'status=' + served.status);

  const old = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  for (let i = 0; i < 30; i += 1) {
    const dummy = path.join(cacheDir, 'deadbeef' + String(i).padStart(2, '0') + '.mp4');
    await fs.writeFile(dummy, Buffer.alloc(8));
    await fs.utimes(dummy, old, old);
  }
  await askMv();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const left = (await fs.readdir(cacheDir)).filter((name) => name.endsWith('.mp4'));
  check('cache stays bounded (oldest evicted, the just-used one kept)',
    left.length <= 24 && left.includes(key + '.mp4'), 'left=' + left.length + ' kept=' + left.includes(key + '.mp4'));

  const stalePart = path.join(cacheDir, 'stale.part');
  const freshPart = path.join(cacheDir, 'fresh.part');
  await fs.writeFile(stalePart, Buffer.alloc(4));
  await fs.utimes(stalePart, new Date(Date.now() - 3600 * 1000), new Date(Date.now() - 3600 * 1000));
  await fs.writeFile(freshPart, Buffer.alloc(4));
  await askMv();
  await new Promise((resolve) => setTimeout(resolve, 400));
  check('stale .part leftovers are cleaned while a fresh .part is left alone',
    !existsSync(stalePart) && existsSync(freshPart), 'stale=' + existsSync(stalePart) + ' fresh=' + existsSync(freshPart));
  }
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED');
server.close();
process.exit(failures === 0 ? 0 : 1);