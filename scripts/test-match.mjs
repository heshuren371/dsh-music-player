// Regression test for the multi-source matching engine:
//  QQ + iTunes + NetEase merged, traditional/simplified artists fuzzy-merged,
//  track-number prefixes stripped from queries, duration/version guards,
//  MusicBrainz only as fallback, and artwork-host allowlist incl. redirects.
// All upstream traffic is stubbed, so the suite is hermetic.
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-match2-home-'));
const music = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-match2-music-'));
process.env.DSH_HOME = home;
await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: music }), 'utf8');

/** Minimal valid 1s 8kHz mono WAV (so local duration == stubbed candidate duration). */
function wav(seconds = 1) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), 44 + i * 2);
  return buf;
}
await fs.writeFile(path.join(music, '周杰伦 - 晴天.wav'), wav());
await fs.writeFile(path.join(music, 'Green Day - 21 Guns.wav'), wav());
await fs.writeFile(path.join(music, 'Mystery.wav'), wav());
await fs.writeFile(path.join(music, 'Unknown.wav'), wav());
await fs.writeFile(path.join(music, 'Great Artist - Strong Match.wav'), wav());
await fs.writeFile(path.join(music, 'Solo Song.wav'), wav());

const realFetch = globalThis.fetch;
const qqQueries = [];
const mbQueries = [];
const neteaseCalls = [];
let neteaseDown = false;
const upstreamHosts = [];
const jpeg = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
const image = () => new Response(new Uint8Array(jpeg), { status: 200, headers: { 'content-type': 'image/jpeg' } });

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return realFetch(input, init);
  upstreamHosts.push(new URL(url).host);
  if (url.startsWith('https://c.y.qq.com/')) {
    const term = new URL(url).searchParams.get('w') ?? '';
    qqQueries.push(term);
    const list = [];
    if (term.includes('晴天')) {
      list.push({ songname: '晴天', singer: [{ name: '周杰伦' }], albumname: '叶惠美', interval: 1, albummid: 'MID1', songmid: 'S1' });
      list.push({ songname: '晴天 (Live)', singer: [{ name: '周杰伦' }], albumname: '演唱会', interval: 1, albummid: 'MID2', songmid: 'S2' });
    }
    if (term.toLowerCase().includes('21 guns')) {
      list.push({ songname: '21 Guns', singer: [{ name: 'Green Day' }], albumname: '21st Century Breakdown', interval: 1, albummid: 'MID3', songmid: 'S3' });
    }
    if (term.toLowerCase().includes('strong match')) {
      // 时长与本地差得远：只有标题/歌手都强匹配时才允许自动写入。
      list.push({ songname: 'Strong Match', singer: [{ name: 'Great Artist' }], albumname: 'Album', interval: 300, albummid: 'MID4', songmid: 'S4' });
    }
    if (term.toLowerCase().includes('solo song')) {
      // 本地无歌手 + 时长冲突：证据不足，必须拒绝自动写入。
      list.push({ songname: 'Solo Song', singer: [{ name: 'Solo Artist' }], albumname: 'Album', interval: 300, albummid: 'MID5', songmid: 'S5' });
    }
    return new Response(JSON.stringify({ code: 0, data: { song: { list } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://itunes.apple.com/')) {
    const term = new URL(url).searchParams.get('term') ?? '';
    const results = [];
    if (term.includes('晴天')) {
      results.push({ trackId: 11, trackName: '晴天', artistName: '周杰倫', collectionName: '葉惠美', trackTimeMillis: 1000, artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg' });
    }
    if (term.toLowerCase().includes('21 guns')) {
      results.push({ trackId: 12, trackName: '21 Guns', artistName: 'Green Day', collectionName: '21st Century Breakdown', trackTimeMillis: 1000, artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music2/100x100bb.jpg' });
    }
    return new Response(JSON.stringify({ resultCount: results.length, results }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://music.163.com/')) {
    const term = new URLSearchParams(String(init?.body ?? '')).get('s') ?? '';
    neteaseCalls.push(term);
    if (neteaseDown) throw new Error('netease down');
    const songs = term.includes('晴天')
      ? [{ id: 9, name: '晴天', ar: [{ name: 'RyaVocal' }], al: { name: '晴天', picUrl: 'http://p1.music.126.net/cover.jpg' }, dt: 1000 }]
      : [];
    return new Response(JSON.stringify({ result: { songs } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://musicbrainz.org/')) {
    mbQueries.push(new URL(url).searchParams.get('query') ?? '');
    return new Response(JSON.stringify({
      recordings: [{
        id: 'mb-1',
        title: 'Mystery Song',
        'artist-credit': [{ name: 'Someone' }],
        length: 1000,
        releases: [{ id: 'rel-1', title: 'Mystery Album' }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://coverartarchive.org/')) {
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/cover.jpg' } });
  }
  if (url.includes('gtimg.cn') || url.includes('mzstatic.com') || url.includes('music.126.net')) return image();
  if (url.startsWith('https://evil.example/')) return image();
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

let handler = null;
const ctx = {
  effect: (fn) => fn(),
  get: () => undefined,
  webServer: { register: (route) => { handler = route.handler; return () => {}; } },
};
const { apply } = await import('../lib/index.js');
apply(ctx);
const server = createServer((req, res) => { handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';
const json = async (url, options) => { const r = await realFetch(url, options); return { status: r.status, body: await r.json() }; };

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

await json(base + '/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: music }) });
let library = null;
for (let i = 0; i < 80; i += 1) {
  const r = await json(base + '/api/library');
  if (r.body.scanning !== true && (r.body.tracks ?? []).length === 6) { library = r.body; break; }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check('scan finds six tracks', library !== null, 'tracks=' + (library?.tracks?.length ?? 'none'));

// Covered track: QQ + iTunes agree (fuzzy traditional/simplified merge), NetEase cover loses.
const qing = await json(base + '/api/match?p=' + encodeURIComponent('周杰伦 - 晴天.wav'));
const bestQing = qing.body.best;
check('晴天: high-confidence match', bestQing !== null && bestQing.score >= 0.78 && bestQing.auto === true, JSON.stringify({ score: bestQing?.score, auto: bestQing?.auto }));
check('晴天: cover uses the high-res asset', bestQing?.cover === 'https://y.gtimg.cn/music/photo_new/T002R500x500M000MID1.jpg', 'cover=' + bestQing?.cover);
check('晴天: chose the original artist/album', bestQing?.title === '晴天' && bestQing?.artist === '周杰伦' && bestQing?.album === '叶惠美', JSON.stringify(bestQing && { t: bestQing.title, a: bestQing.artist, al: bestQing.album }));
check('晴天: QQ + iTunes agreements merged into one candidate', Array.isArray(bestQing?.sources) && bestQing.sources.includes('qq') && bestQing.sources.includes('itunes'), JSON.stringify(bestQing?.sources));
const live = (qing.body.candidates ?? []).find((c) => /live/i.test(c.title));
check('晴天: Live version is ranked below the original', live !== undefined && live.score < bestQing.score, live && (live.title + ' ' + live.score));
check('晴天: NetEase-only cover is ranked below the original', (qing.body.candidates ?? []).find((c) => c.artist === 'RyaVocal')?.score < bestQing.score);
check('晴天: MusicBrainz is not called when primaries are confident', mbQueries.length === 0, 'mb=' + mbQueries.length);

// Track-number prefix must not poison the query (but "21 Guns" must survive).
const guns = await json(base + '/api/match?p=' + encodeURIComponent('Green Day - 21 Guns.wav'));
check('21 Guns: title keeps its number', guns.body.best?.title === '21 Guns' && guns.body.best?.artist === 'Green Day', JSON.stringify(guns.body.best && { t: guns.body.best.title, a: guns.body.best.artist }));
check('21 Guns: query sent is "21 guns ...", never "guns"', qqQueries.some((q) => q.toLowerCase().includes('21 guns')) && !qqQueries.some((q) => /^guns/.test(q.toLowerCase())), JSON.stringify(qqQueries));

// MusicBrainz fallback when primaries return nothing.
const mystery = await json(base + '/api/match?p=Mystery.wav');
check('Mystery: falls back to MusicBrainz', mbQueries.length > 0 && mystery.body.best?.title === 'Mystery Song', JSON.stringify({ mb: mbQueries.length, best: mystery.body.best?.title }));

// Duration conflict must NOT block a strong title+artist match (same song,
// different edition) — otherwise "wrong name" files stay unfixed forever.
const strong = await json(base + '/api/match?p=' + encodeURIComponent('Great Artist - Strong Match.wav'));
check('duration conflict + exact title/artist → still auto-writable', strong.body.best?.auto === true && strong.body.best?.title === 'Strong Match', JSON.stringify({ auto: strong.body.best?.auto, score: strong.body.best?.score, d: strong.body.best?.duration }));

const solo = await json(base + '/api/match?p=' + encodeURIComponent('Solo Song.wav'));
check('duration conflict without a known artist → auto=false', solo.body.auto === false && solo.body.best?.auto === false, JSON.stringify({ auto: solo.body.auto, score: solo.body.best?.score }));

// Low confidence must not be auto-writable.
const unknown = await json(base + '/api/match?p=Unknown.wav');
check('Unknown: no confident match → auto=false', unknown.body.auto === false && unknown.body.best?.auto === false, JSON.stringify({ auto: unknown.body.auto, score: unknown.body.best?.score }));

// A dead source must be tripped out of the fan-out instead of costing a
// timeout on every single track of a batch. Fresh q= probes bypass the cache.
neteaseDown = true;
await json(base + '/api/match?p=Unknown.wav&q=probe-one');
await json(base + '/api/match?p=Unknown.wav&q=probe-two');
const callsBeforeThird = neteaseCalls.length;
const third = await json(base + '/api/match?p=Unknown.wav&q=probe-three');
const probes = neteaseCalls.filter((t) => t.startsWith('probe-'));
check('dead source called twice, then tripped out of the fan-out', neteaseCalls.length === callsBeforeThird && probes.length === 2, 'probes=' + JSON.stringify(probes));
check('match still answers after a source trips', third.status === 200, 'status=' + third.status);

// Artwork proxy allowlist + redirect validation.
const qqArt = await realFetch(base + '/api/art?u=' + encodeURIComponent('https://y.gtimg.cn/music/photo_new/T002R300x300M000MID1.jpg'));
check('art: QQ cover proxied', qqArt.status === 200 && qqArt.headers.get('content-type') === 'image/jpeg', 'status=' + qqArt.status);
const neArt = await realFetch(base + '/api/art?u=' + encodeURIComponent('https://p1.music.126.net/cover.jpg'));
check('art: NetEase cover proxied', neArt.status === 200, 'status=' + neArt.status);
const evilArt = await realFetch(base + '/api/art?u=' + encodeURIComponent('https://evil.example/cover.jpg'));
check('art: non-allowlisted host → 403', evilArt.status === 403, 'status=' + evilArt.status);
const caaArt = await realFetch(base + '/api/art?u=' + encodeURIComponent('https://coverartarchive.org/release/rel-1/front-500'));
check('art: redirect to a foreign host is refused', caaArt.status === 403, 'status=' + caaArt.status);

globalThis.fetch = realFetch;
server.close();
await fs.rm(home, { recursive: true, force: true });
await fs.rm(music, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
