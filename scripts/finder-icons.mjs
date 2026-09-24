// 给音频文件设置「Finder 自定义图标 = 内嵌封面」。
//   macOS 的 Finder / Quick Look 不解析 FLAC 内嵌封面（只显示通用音符图标），
//   唯一让 Finder 显示封面的办法是把封面写进文件的自定义图标（resource fork）。
// 用法：
//   node scripts/finder-icons.mjs              # dry-run，只统计
//   node scripts/finder-icons.mjs --apply      # 应用（会加 com.apple.ResourceFork）
//   node scripts/finder-icons.mjs --apply --flac-only   # 只给 FLAC
//   node scripts/finder-icons.mjs --remove     # 还原（删掉 resource fork）
// 注意：自定义图标会存进 resource fork；拷到 exFAT/NTFS/网络盘或部分同步工具会丢失，
//       不影响音频数据与标签，--remove 可完全还原。
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { parseFile } from 'music-metadata';

const MUSIC = process.env.DSH_MUSIC_DIR || '/Users/heshuren/Documents/本地音乐';
const APPLY = process.argv.includes('--apply');
const REMOVE = process.argv.includes('--remove');
const FLAC_ONLY = process.argv.includes('--flac-only');
const ICON_SIZE = 256;

async function walk(dir, out = []) {
  for (const row of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, row.name);
    if (row.isDirectory()) { if (!row.name.startsWith('.')) await walk(p, out); continue; }
    const pattern = FLAC_ONLY ? /\.flac$/i : /\.(flac|mp3|m4a|wav|ogg|opus)$/i;
    if (pattern.test(row.name)) out.push(p);
  }
  return out;
}
const files = (await walk(MUSIC)).sort();
const tmpPng = path.join(os.tmpdir(), 'finder-icon.png');

if (REMOVE) {
  let removed = 0;
  for (const file of files) {
    const res = spawnSync('xattr', ['-d', 'com.apple.ResourceFork', file], { encoding: 'utf8' });
    if (res.status === 0) removed += 1;
  }
  console.log('已移除自定义图标:', removed, '/', files.length);
  process.exit(0);
}

let withCover = 0; let applied = 0; let failed = 0;
for (const file of files) {
  let picture;
  try { picture = (await parseFile(file, { duration: false, skipCovers: false })).common.picture?.[0]; } catch {}
  if (!picture) continue;
  withCover += 1;
  if (!APPLY) { console.log('可设置:', path.basename(file)); continue; }
  try {
    // 压到 256px，避免 resource fork 过大（原图 1MB+ 会让每个文件多出 ~1MB）
    execFileSync('/opt/homebrew/bin/ffmpeg', ['-y', '-i', 'pipe:0', '-vf', 'scale=' + ICON_SIZE + ':' + ICON_SIZE, '-frames:v', '1', tmpPng], { input: Buffer.from(picture.data), stdio: ['pipe', 'ignore', 'ignore'] });
    const script = 'use framework "AppKit"\n'
      + 'set img to current application\'s NSImage\'s alloc()\'s initWithContentsOfFile:"' + tmpPng + '"\n'
      + 'if img is missing value then return "NO_IMAGE"\n'
      + 'set ws to current application\'s NSWorkspace\'s sharedWorkspace()\n'
      + 'set ok to ws\'s setIcon:img forFile:"' + file + '" options:0\n'
      + 'return (ok as text)';
    const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
    if ((res.stdout ?? '').trim() === 'true') applied += 1;
    else { failed += 1; console.log('失败:', file, (res.stderr ?? '').trim().slice(0, 120)); }
  } catch (error) {
    failed += 1;
    console.log('失败:', file, String(error).slice(0, 120));
  }
  if ((applied + failed) % 20 === 0) console.log('进度', applied + failed, '| ok=' + applied, 'failed=' + failed);
}
console.log(APPLY ? ('已设置自定义图标 ' + applied + ' | 失败 ' + failed + ' | 有封面 ' + withCover + ' / ' + files.length) : ('有封面的文件: ' + withCover + ' / ' + files.length + '（dry-run，加 --apply 执行）'));
