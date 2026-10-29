// 链接导入：URL/命名/参数/信息解析的纯函数，加上一个假 yt-dlp 的端到端流程。
// 没有 ffmpeg 时纯函数仍全跑，端到端部分显式 skipped（本套件不假装验证过）。
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  biliCookieFileContent, biliCookieHeader, biliQrDataUrl, buildYtdlpArgs, importErrorText,
  importFailureMessage, importFileName, importFormatHeights, parseBiliSetCookie, parseImportProgress, parseYtdlpInfo, recommendedImportHeight, sanitizeImportName, validateImportUrl,
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
check('403 becomes an actionable message (no login bypass claim)', /403/u.test(importFailureMessage('ERROR: unable to download video data: HTTP Error 403: Forbidden', '/tmp/music')) && /yt-dlp/u.test(importFailureMessage('HTTP Error 403: Forbidden', '/tmp/music')) && /不提供/u.test(importFailureMessage('HTTP Error 403: Forbidden', '/tmp/music')), importFailureMessage('HTTP Error 403: Forbidden', '/tmp/music'));

// ── B 站 cookie / 二维码纯函数 ───────────────────────────────────────────────
const cookieHeaders = [
  'SESSDATA=abc%2C123; Path=/; Domain=.bilibili.com; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly',
  'bili_jct=csrf; Path=/; Domain=.bilibili.com',
  'other=no; Path=/; Domain=example.com',
];
const parsedCookies = parseBiliSetCookie(cookieHeaders);
check('Bilibili Set-Cookie parsing keeps only bilibili domains', parsedCookies.length === 2 && parsedCookies.every((c) => c.domain.endsWith('bilibili.com')), JSON.stringify(parsedCookies));
const cookieFile = biliCookieFileContent(parsedCookies);
check('cookie file is Netscape format and keeps SESSDATA', cookieFile.startsWith('# Netscape HTTP Cookie File') && cookieFile.includes('SESSDATA\tabc%2C123') && cookieFile.includes('\tTRUE\t'), cookieFile);
const cookieHeader = biliCookieHeader(cookieFile);
check('cookie header can be rebuilt for nav verification', cookieHeader.includes('SESSDATA=abc%2C123') && cookieHeader.includes('bili_jct=csrf'), cookieHeader);
const qrData = biliQrDataUrl('https://account.bilibili.com/scan?qrcode_key=test');
check('QR is rendered locally as an SVG data URL', qrData.startsWith('data:image/svg+xml;base64,') && qrData.length > 500, String(qrData.length));

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
  console.log(JSON.stringify({ id:'fake1', title:process.env.FAKE_TITLE || '测试曲目', uploader:process.env.FAKE_ARTIST || '测试作者', duration:61, webpage_url:args[args.length-1],
    formats: [
      { height: 2160, vcodec: 'avc1', ext: 'mp4', fps: 60, tbr: 8000, filesize: 24000000, format_note: '2160P' },
      { height: 1080, vcodec: 'avc1', ext: 'mp4', fps: 60, tbr: 4000, filesize: 12000000, format_note: '1080P' },
      { height: 720, vcodec: 'avc1', ext: 'mp4', fps: 30, tbr: 2000, filesize: 6000000, format_note: '720P' },
      { vcodec: 'none', acodec: 'mp4a', ext: 'm4a', abr: 128 },
    ] }));
  process.exit(0);
}
if (process.env.FAKE_ARGS_FILE) fs.appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args)+'\\n');
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
    process.env.FAKE_ARGS_FILE = path.join(fixtures, 'args.jsonl');

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

    const probe = await json(base + '/api/import-probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=audio1' }) });
    check('probe lists heights and recommends 1080', probe.status === 200 && JSON.stringify(probe.body?.heights?.map((h) => h.height)) === '[2160,1080,720]' && probe.body?.recommended === 1080, JSON.stringify(probe.body));
    const biliProbe = await json(base + '/api/import-probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.bilibili.com/video/BV1xx411c7mD' }) });
    check('Bilibili probe flags login requirement without cookies', biliProbe.status === 200 && biliProbe.body?.needsLogin === true && biliProbe.body?.loggedIn === false, JSON.stringify(biliProbe.body));
    const auth = await json(base + '/api/import-auth');
    check('auth status starts logged out', auth.status === 200 && auth.body?.bilibili?.loggedIn === false, JSON.stringify(auth.body));

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
      const videoStarted = await post({ url: 'https://www.bilibili.com/video/BV1xx', kind: 'video', height: 720 });
      const videoJob = await waitJob(videoStarted.body.job.id);
      check('video import finishes', videoJob?.phase === 'done', JSON.stringify(videoJob));
      check('video is a video track in the playlist', videoJob?.tagged === true && (await waitTrack(videoJob.file))?.kind === 'video', JSON.stringify(videoJob));
      check('video job records the chosen height', videoJob?.height === 720, JSON.stringify(videoJob));
      const argLines = (await fs.readFile(process.env.FAKE_ARGS_FILE, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const lastArgs = argLines.at(-1) ?? [];
      check('the download format honours the chosen height', lastArgs.includes('bestvideo[height<=720]+bestaudio/best[height<=720]'), lastArgs.join(' '));
    } else {
      skip('video import (libx264 fixture unavailable)');
    }

    // 并行 / 取消：慢速 fake 让两个下载同时挂着；第二个必须被接受，取消一个不拖死另一个。
    process.env.FAKE_SLOW_MS = '2000';
    const slow = await post({ url: 'https://www.youtube.com/watch?v=slow', kind: 'audio' });
    const second = await post({ url: 'https://www.youtube.com/watch?v=slow2', kind: 'audio' });
    check('a second import starts in parallel', second.status === 200 && second.body?.job?.id !== slow.body?.job?.id, 'status=' + second.status + ' ids=' + slow.body?.job?.id + ',' + second.body?.job?.id);
    const active = await json(base + '/api/import');
    const activeIds = (active.body?.jobs ?? []).filter((job) => ['queued', 'starting', 'metadata', 'download', 'finalize'].includes(job.phase)).map((job) => job.id);
    check('both running jobs are visible in the status list', activeIds.includes(slow.body.job.id) && activeIds.includes(second.body.job.id), JSON.stringify(activeIds));
    const secondPhase = (active.body?.jobs ?? []).find((job) => job.id === second.body.job.id)?.phase;
    check('the second job is actually running, not queued behind the first', secondPhase !== 'queued', String(secondPhase));
    const cancelled = await json(base + '/api/import-cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: slow.body.job.id }) });
    check('cancel reports cancelled', cancelled.status === 200 && cancelled.body?.job?.phase === 'cancelled', JSON.stringify(cancelled.body?.job));
    const survivor = await waitJob(second.body.job.id);
    check('cancelling one import does not stop the other', survivor?.phase === 'done', JSON.stringify(survivor));
    await waitJob(slow.body.job.id);
    // 批量提交：一次 POST 的 urls 全部建任务并并行跑完。
    process.env.FAKE_SLOW_MS = '0';
    const batch = await post({ urls: ['https://www.youtube.com/watch?v=batch1', 'https://www.youtube.com/watch?v=batch2'], kind: 'audio' });
    check('a batch creates one job per link', batch.status === 200 && batch.body?.jobs?.length === 2, JSON.stringify(batch.body?.jobs?.map((job) => job.id)));
    const batchDone = await Promise.all((batch.body?.jobs ?? []).map((job) => waitJob(job.id)));
    check('all batch jobs finish', batchDone.length === 2 && batchDone.every((job) => job?.phase === 'done'), JSON.stringify(batchDone.map((job) => job?.phase)));
    await new Promise((resolve) => setTimeout(resolve, 200));
    check('parallel imports leave no temp files', (await fs.readdir(music)).every((name) => !name.startsWith('.dshm-import-')), (await fs.readdir(music)).join(', '));

    // ── B 站扫码登录：mock 官方接口，绝不登录真实账号 ─────────────────────────
    {
      const realFetch = globalThis.fetch;
      let polls = 0;
      globalThis.fetch = async (input, init) => {
        const target = String(input);
        if (target.includes('/x/passport-login/web/qrcode/generate')) {
          return new Response(JSON.stringify({ code: 0, data: { url: 'https://account.bilibili.com/test-scan', qrcode_key: 'test-key' } }), { headers: { 'content-type': 'application/json' } });
        }
        if (target.includes('/x/passport-login/web/qrcode/poll')) {
          polls += 1;
          if (polls === 1) return new Response(JSON.stringify({ data: { code: 86101 } }), { headers: { 'content-type': 'application/json' } });
          return new Response(JSON.stringify({ data: { code: 0 } }), { headers: { 'content-type': 'application/json', 'set-cookie': 'SESSDATA=test-auth; Path=/; Domain=.bilibili.com; HttpOnly' } });
        }
        if (target.includes('/x/web-interface/nav')) {
          return new Response(JSON.stringify({ code: 0, data: { isLogin: true, uname: '测试账号', mid: 42, vipStatus: 1 } }), { headers: { 'content-type': 'application/json' } });
        }
        return realFetch(input, init);
      };
      try {
        const qr = await json(base + '/api/import-auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'qr' }) });
        check('QR login generates a local SVG data URL', qr.status === 200 && qr.body?.key === 'test-key' && String(qr.body?.qr).startsWith('data:image/svg+xml;base64,'), JSON.stringify({ key: qr.body?.key, qr: String(qr.body?.qr).slice(0, 40) }));
        const waiting = await json(base + '/api/import-auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'poll', key: 'test-key' }) });
        check('QR poll reports waiting before a scan', waiting.status === 200 && waiting.body?.status === 'waiting', JSON.stringify(waiting.body));
        const ok = await json(base + '/api/import-auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'poll', key: 'test-key' }) });
        check('QR poll stores the login and reports the account', ok.status === 200 && ok.body?.status === 'ok' && ok.body?.auth?.uname === '测试账号' && ok.body?.auth?.vip === true, JSON.stringify(ok.body));
        const cookiePath = path.join(home, 'storages', 'dsh-music-bilibili.cookies');
        const cookieStat = await fs.stat(cookiePath);
        check('Bilibili cookie file is private (0600)', (cookieStat.mode & 0o777) === 0o600, String(cookieStat.mode & 0o777));
        const logged = await json(base + '/api/import-auth');
        check('auth status reports the logged-in account', logged.body?.bilibili?.loggedIn === true && logged.body?.bilibili?.uname === '测试账号', JSON.stringify(logged.body));
        const logout = await json(base + '/api/import-auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) });
        check('logout removes the cookie file', logout.status === 200 && logout.body?.loggedIn === false && !existsSync(cookiePath), JSON.stringify(logout.body));
      } finally {
        globalThis.fetch = realFetch;
      }
    }

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
