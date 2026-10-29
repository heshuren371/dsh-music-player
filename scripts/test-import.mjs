// 链接导入：URL/命名/参数/信息解析的纯函数，加上一个假 yt-dlp 的端到端流程。
// 没有 ffmpeg 时纯函数仍全跑，端到端部分显式 skipped（本套件不假装验证过）。
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  buildYtdlpArgs, importErrorText, importFileName, parseImportProgress, parseYtdlpInfo,
  sanitizeImportName, validateImportUrl,
} from '../lib/host.js';

let failures = 0;
let skipped = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail));
};
const skip = (label, detail) => {
  skipped += 1;
  console.log('SKIP ' + label + (detail === undefined ? '' : ' | ' + detail));
};
const problemOf = (fn) => {
  try { fn(); return null; } catch (error) { return String(error?.message ?? error); }
};

// ── 纯函数：链接白名单 / 凭据 / 端口 / 文件名 / 参数 ─────────────────────────
check('accepts a public YouTube URL', validateImportUrl('https://www.youtube.com/watch?v=abc') === 'https://www.youtube.com/watch?v=abc');
check('accepts a Bilibili short link', problemOf(() => validateImportUrl('https://b23.tv/abc')) === null);
check('rejects http', /https/.test(problemOf(() => validateImportUrl('http://www.youtube.com/watch?v=abc')) ?? ''));
check('rejects a non-platform host', /只支持/.test(problemOf(() => validateImportUrl('https://example.com/video')) ?? ''));
check('rejects URL credentials', /账号|密码/.test(problemOf(() => validateImportUrl('https://user:pass@youtube.com/watch?v=abc')) ?? ''));
check('rejects a non-standard port', /端口/.test(problemOf(() => validateImportUrl('https://youtube.com:8443/watch?v=abc')) ?? ''));

check('sanitizes path separators and control characters', sanitizeImportName('a/b\\c\n:d*e') === 'a b c d e', sanitizeImportName('a/b\\c\n:d*e'));
check('sanitizes Windows reserved names', sanitizeImportName('CON') === '_CON', sanitizeImportName('CON'));
check('uses artist - title when the artist is known', importFileName({ artist: '作者', title: '歌名' }, '.mp3') === '作者 - 歌名.mp3');
check('drops the unknown-author placeholder', importFileName({ artist: '未知作者', title: '歌名' }, '.mp4') === '歌名.mp4');

const info = parseYtdlpInfo({ id: 'x', title: 'T', uploader: 'U', duration: 3, webpage_url: 'https://youtu.be/x' });
check('parses title / uploader / duration / source', info?.title === 'T' && info?.artist === 'U' && info?.duration === 3 && info?.source === 'https://youtu.be/x', JSON.stringify(info));
const channel = parseYtdlpInfo({ title: 'T', channel: 'C', duration: 'NA' });
check('falls back channel, then creator, then artist', channel?.artist === 'C' && channel?.duration === null, JSON.stringify(channel));
const playlist = parseYtdlpInfo({ _type: 'playlist', entries: [{ title: 'First', uploader: 'Up' }] });
check('takes the first entry if the extractor ever returns a playlist', playlist?.title === 'First' && playlist?.artist === 'Up');

const progress = parseImportProgress('download: 42.5%|1.2MiB/s|00:13');
check('parses the progress template', progress?.percent === 42.5 && progress?.speed === '1.2MiB/s' && progress?.eta === '00:13', JSON.stringify(progress));
check('ignores non-progress lines', parseImportProgress('[download] Destination: x') === null);

const audioArgs = buildYtdlpArgs('https://youtu.be/x', 'audio', '/music/.tmp', '/opt/ffmpeg');
const videoArgs = buildYtdlpArgs('https://youtu.be/x', 'video', '/music/.tmp', '/opt/ffmpeg');
check('audio args extract mp3', audioArgs.includes('-x') && audioArgs.includes('--audio-format') && audioArgs.join(' ').includes('--audio-format mp3'));
check('video args merge mp4', videoArgs.includes('-f') && videoArgs.includes('--merge-output-format') && videoArgs.join(' ').includes('--merge-output-format mp4'));
check('args pin config/playlist/thumbnail/ffmpeg and end with the URL',
  audioArgs[0] === '--ignore-config' && audioArgs.includes('--no-playlist') && audioArgs.includes('--write-thumbnail')
  && audioArgs.includes('--convert-thumbnails') && audioArgs.includes('--ffmpeg-location') && audioArgs.at(-1) === 'https://youtu.be/x',
  audioArgs.join(' '));
check('error text strips the local directory', !importErrorText('ERROR: failed in /tmp/music/x\n', '/tmp/music').includes('/tmp/music'), importErrorText('ERROR: failed in /tmp/music/x', '/tmp/music'));

// ── 端到端：假 yt-dlp + 真 ffmpeg + 真 tag writer ───────────────────────────
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => existsSync(p)) ?? null;
if (FFMPEG === null) {
  skip('end-to-end import (ffmpeg not found)');
} else {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-import-'));
  const music = path.join(work, 'music');
  const home = path.join(work, 'home');
  const fixtures = path.join(work, 'fixtures');
  await fs.mkdir(music, { recursive: true });
  await fs.mkdir(path.join(home, 'storages'), { recursive: true });
  await fs.mkdir(fixtures, { recursive: true });
  await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');
  const run = (args) => spawnSync(FFMPEG, args, { stdio: 'ignore' }).status === 0;
  const media = {
    audio: run(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-q:a', '5', path.join(fixtures, 'sample.mp3')]),
    video: run(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(fixtures, 'sample.mp4')]),
    cover: run(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', path.join(fixtures, 'cover.jpg')]),
  };
  if (!media.audio || !media.cover) {
    skip('end-to-end import (audio/cover fixture generation failed)');
  } else {
    const fake = path.join(fixtures, 'fake-ytdlp.cjs');
    await fs.writeFile(fake, `#!/usr/bin/env node
const fs=require('fs'), path=require('path');
const args=process.argv.slice(2);
if (args.includes('--version')) { console.log('2026.07.04-fake'); process.exit(0); }
if (args.includes('-J')) {
  console.log(JSON.stringify({ id:'fake1', title:process.env.FAKE_TITLE || '测试曲目', uploader:process.env.FAKE_ARTIST || '测试作者', duration:1, webpage_url:args[args.length-1] }));
  process.exit(0);
}
const out=args[args.indexOf('-o')+1]; const base=out.replace('.%(ext)s','');
const audio=args.includes('-x');
const delay=Number(process.env.FAKE_SLOW_MS || 0);
if (delay > 0) { const until=Date.now()+delay; while (Date.now()<until) {} }
fs.copyFileSync(path.join(process.env.FAKE_FIXTURES, audio?'sample.mp3':'sample.mp4'), base+(audio?'.mp3':'.mp4'));
fs.copyFileSync(path.join(process.env.FAKE_FIXTURES,'cover.jpg'), base+'.jpg');
console.log('download: 100.0%|1.0MiB/s|00:00');
`);
    await fs.chmod(fake, 0o755);
    process.env.DSH_HOME = home;
    process.env.DSH_MUSIC_YTDLP = fake;
    process.env.FAKE_FIXTURES = fixtures;

    let handler = null;
    const ctx = { effect: (fn) => fn(), get: () => undefined, webServer: { register: (route) => { handler = route.handler; return () => {}; } } };
    const { apply } = await import('../lib/index.js');
    apply(ctx);
    const server = createServer((req, res) => { handler(req, res).catch((error) => { res.writeHead(500).end(String(error)); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';
    const json = async (url, options) => { const res = await fetch(url, options); return { status: res.status, body: await res.json().catch(() => null) }; };
    const post = (payload) => json(base + '/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const waitJob = async (id) => {
      let job = null;
      for (let i = 0; i < 200; i += 1) {
        const res = await json(base + '/api/import?id=' + encodeURIComponent(id));
        job = res.body?.job ?? null;
        if (job !== null && ['done', 'error', 'cancelled'].includes(job.phase)) return job;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return job;
    };
    const waitTrack = async (name) => {
      for (let i = 0; i < 80; i += 1) {
        const res = await json(base + '/api/library');
        const track = (res.body?.tracks ?? []).find((row) => row.name === name);
        if (track !== undefined) return track;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    };

    await json(base + '/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: music }) });
    const caps = await json(base + '/api/import');
    check('capabilities report yt-dlp and ffmpeg', caps.body?.available === true && caps.body?.ytdlp === '2026.07.04-fake', JSON.stringify(caps.body));
    check('capabilities publish the host allowlist', Array.isArray(caps.body?.hosts) && caps.body.hosts.includes('bilibili.com'));

    const started = await post({ url: 'https://www.youtube.com/watch?v=audio1', kind: 'audio' });
    check('start returns a running job', started.status === 200 && started.body?.job?.phase !== 'error', JSON.stringify(started.body?.job));
    const audioJob = await waitJob(started.body.job.id);
    check('audio import finishes', audioJob?.phase === 'done', JSON.stringify(audioJob));
    check('audio job carries title/artist/file', audioJob?.title === '测试曲目' && audioJob?.artist === '测试作者' && /\.mp3$/u.test(audioJob?.file ?? ''), JSON.stringify(audioJob));
    check('audio file is tagged and visible in the library', audioJob?.tagged === true && (await waitTrack(audioJob.file)) !== null);
    const audioTrack = await waitTrack(audioJob.file);
    if (audioTrack !== null) {
      const cover = await fetch(base + '/api/cover?p=' + encodeURIComponent(audioTrack.id));
      check('audio cover is readable', cover.status === 200 && cover.headers.get('content-type') === 'image/jpeg', String(cover.status));
    }
    check('no temp files left after success', (await fs.readdir(music)).every((name) => !name.startsWith('.dshm-import-')), (await fs.readdir(music)).join(', '));

    if (media.video) {
      const videoStarted = await post({ url: 'https://www.bilibili.com/video/BV1xx', kind: 'video' });
      const videoJob = await waitJob(videoStarted.body.job.id);
      check('video import finishes', videoJob?.phase === 'done', JSON.stringify(videoJob));
      check('video is a video track in the playlist', videoJob?.tagged === true && (await waitTrack(videoJob.file))?.kind === 'video', JSON.stringify(videoJob));
    } else {
      skip('video import (libx264 fixture unavailable)');
    }

    // 忙 / 取消：慢速 fake 把下载卡住，第二次导入必须 409，取消后进入 cancelled。
    process.env.FAKE_SLOW_MS = '2000';
    const slow = await post({ url: 'https://www.youtube.com/watch?v=slow', kind: 'audio' });
    const busy = await post({ url: 'https://www.youtube.com/watch?v=slow2', kind: 'audio' });
    check('a second import is refused while one is running', busy.status === 409, 'status=' + busy.status);
    const cancelled = await json(base + '/api/import-cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: slow.body.job.id }) });
    check('cancel reports cancelled', cancelled.status === 200 && cancelled.body?.job?.phase === 'cancelled', JSON.stringify(cancelled.body?.job));
    await waitJob(slow.body.job.id);
    process.env.FAKE_SLOW_MS = '0';
    await new Promise((resolve) => setTimeout(resolve, 200));
    check('cancelled import leaves no temp files', (await fs.readdir(music)).every((name) => !name.startsWith('.dshm-import-')), (await fs.readdir(music)).join(', '));

    const badUrl = await post({ url: 'https://example.com/video', kind: 'audio' });
    check('endpoint rejects a non-allowlisted host', badUrl.status === 400, JSON.stringify(badUrl.body));

    process.env.DSH_MUSIC_YTDLP = '/nonexistent/yt-dlp';
    const missing = await post({ url: 'https://www.youtube.com/watch?v=none', kind: 'audio' });
    check('missing yt-dlp is reported as 503', missing.status === 503, JSON.stringify(missing.body));
    const missingCaps = await json(base + '/api/import');
    check('missing yt-dlp is not reported as available', missingCaps.body?.available === false && missingCaps.body?.ytdlp === null, JSON.stringify(missingCaps.body));

    server.close();
    await fs.rm(work, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
