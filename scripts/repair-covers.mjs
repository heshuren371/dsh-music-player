// 封面修复工具（默认 dry-run，--execute 才写文件）
//   A) 宽度 < 500px 的内嵌封面：用多源匹配结果里的高清封面替换（QQ 500 / iTunes 600）
//   B) 只存在 ID3v2 APIC 的 FLAC：补写原生 PICTURE 块（Finder / Music 才能看到）
// 写文件前会把现有封面备份到 ~/Documents/dsh-cover-backup-<时间戳>/
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { File as TagFile, Picture as TagPicture } from 'node-taglib-sharp';
import { parseFile } from 'music-metadata';

const MUSIC = process.env.DSH_MUSIC_DIR || '/Users/heshuren/Documents/本地音乐';
const EXECUTE = process.argv.includes('--execute');
const MIN_WIDTH = 500;

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-coverfix-home-'));
process.env.DSH_HOME = home;
await fs.mkdir(path.join(home, 'storages'), { recursive: true });
await fs.writeFile(path.join(home, 'storages', 'dsh-music-player.json'), JSON.stringify({ dir: MUSIC }), 'utf8');
let handler = null;
const ctx = { effect: (fn) => fn(), get: () => undefined, webServer: { register: (r) => { handler = r.handler; return () => {}; } } };
const { apply } = await import('../lib/index.js');
apply(ctx);
const server = createServer((req, res) => { handler(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500); res.end(String(e)); }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/dsh-music';
const j = async (u, o) => { const r = await fetch(u, o); return { status: r.status, body: await r.json() }; };

await j(base + '/api/dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: MUSIC }) });
let lib = null;
for (let i = 0; i < 600; i += 1) {
  const r = await j(base + '/api/library');
  if (r.body.scanning !== true && (r.body.tracks ?? []).length > 0) { lib = r.body; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (lib === null) { console.error('扫描失败'); process.exit(1); }

const probeImage = path.join(os.tmpdir(), 'coverfix-probe.jpg');
const dimsOf = (bytes) => {
  spawnSync('bash', ['-c', 'cat > ' + probeImage], { input: Buffer.from(bytes) });
  const out = spawnSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', probeImage], { encoding: 'utf8' });
  const [w, h] = (out.stdout ?? '').trim().split(',').map(Number);
  return w && h ? { w, h } : null;
};
const nativePictureCount = (file) => {
  const res = spawnSync('/opt/homebrew/bin/metaflac', ['--list', '--block-type=PICTURE', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return res.status === 0 ? (res.stdout.match(/type: 6 \(PICTURE\)/g) ?? []).length : -1;
};

const lowRes = [];
const id3Only = [];
for (const track of lib.tracks) {
  const r = await fetch(base + '/api/cover?p=' + encodeURIComponent(track.id));
  if (r.status !== 200) continue;
  const bytes = Buffer.from(await r.arrayBuffer());
  const dims = dimsOf(bytes);
  if (dims && dims.w < MIN_WIDTH) lowRes.push({ id: track.id, dims: dims.w + 'x' + dims.h, title: track.title, artist: track.artist });
  if (track.id.toLowerCase().endsWith('.flac')) {
    const filePath = path.join(MUSIC, track.id);
    if (nativePictureCount(filePath) === 0) {
      let taglibPics = 0;
      try { const f = TagFile.createFromPath(filePath); taglibPics = f.tag.pictures.length; f.dispose(); } catch { taglibPics = 0; }
      if (taglibPics > 0) id3Only.push({ id: track.id, pictures: taglibPics });
    }
  }
}
console.log('MUSIC =', MUSIC);
console.log('低清封面(<' + MIN_WIDTH + 'px) 待升级:', lowRes.length);
console.log('仅 ID3v2 封面待补原生块:', id3Only.length, id3Only.map((x) => x.id).join(', '));
if (!EXECUTE) { console.log('（dry-run，未写任何文件；加 --execute 执行）'); server.close(); await fs.rm(home, { recursive: true, force: true }); process.exit(0); }

const backupDir = path.join(os.homedir(), 'Documents', 'dsh-cover-backup-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
await fs.mkdir(backupDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), music: MUSIC, backupDir, upgraded: [], skipped: [], failed: [], nativeFixed: [] };
const saveReport = async () => fs.writeFile(path.join(backupDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

let done = 0;
for (const item of lowRes) {
  done += 1;
  const r = await fetch(base + '/api/cover?p=' + encodeURIComponent(item.id));
  if (r.status === 200) {
    const safe = item.id.replace(/[\\/:*?"<>|]/g, '_');
    await fs.writeFile(path.join(backupDir, safe + '.cover.jpg'), Buffer.from(await r.arrayBuffer()));
  }
  try {
    const match = await j(base + '/api/match?p=' + encodeURIComponent(item.id));
    const best = match.body.best;
    if (best === undefined || best === null || match.body.auto !== true || typeof best.cover !== 'string' || best.cover.length === 0) {
      report.skipped.push({ id: item.id, reason: 'no confident match with cover' });
    } else {
      const res = await j(base + '/api/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, title: item.title, artist: item.artist, cover: best.cover, rename: false, replaceCover: true }),
      });
      if (res.status === 200 && res.body.tagged === true) report.upgraded.push({ id: item.id, from: item.dims, cover: best.cover, source: best.sources });
      else report.failed.push({ id: item.id, detail: JSON.stringify(res.body).slice(0, 160) });
    }
  } catch (error) {
    report.failed.push({ id: item.id, detail: String(error).slice(0, 120) });
  }
  if (done % 10 === 0) { console.log('进度', done + '/' + lowRes.length, 'upgraded=' + report.upgraded.length, 'skipped=' + report.skipped.length, 'failed=' + report.failed.length); await saveReport(); }
}

for (const item of id3Only) {
  const filePath = path.join(MUSIC, item.id);
  try {
    const f = TagFile.createFromPath(filePath);
    const pics = f.tag.pictures;
    f.tag.pictures = pics.map((p) => TagPicture.fromFullData(p.data, p.type, p.mimeType, p.description));
    f.save();
    f.dispose();
    report.nativeFixed.push({ id: item.id, nativeBefore: 0, nativeAfter: nativePictureCount(filePath) });
  } catch (error) {
    report.failed.push({ id: item.id, detail: 'native fix: ' + String(error).slice(0, 120) });
  }
}
await saveReport();
console.log('=== 完成 ===');
console.log('升级成功', report.upgraded.length, '| 跳过（无高置信封面）', report.skipped.length, '| 失败', report.failed.length, '| 原生块修复', report.nativeFixed.length);
console.log('备份与报告:', backupDir);
server.close();
await fs.rm(home, { recursive: true, force: true });
