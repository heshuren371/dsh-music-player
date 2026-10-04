#!/usr/bin/env node
// 闸门：常设文档的字数上限 + 强调标记上限（对照 dsh-anti-slop-kit 的 verify-doc-budgets 思路）。
//
// 计数单位是**确定性**的：CJK 字符各算 1，拉丁词各算 1，代码块与围栏不计入
// （预算是给散文设的，代码是契约本身）。强调标记（`**`）单独设上限：到处都是粗体等于没有重点。
//
// 超限时的顺序：**先搬家**（内容属于别的层级就移过去，留一行链接）→ **再压缩** →
// 最后才允许上调额度，并在提交说明里论证。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'doc-budgets.manifest.json'), 'utf8'));

/** 去掉围栏代码块（预算只管散文），再按 CJK 字符 + 拉丁词计数。 */
function words(text) {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const cjk = (prose.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  const latin = (prose.match(/[A-Za-z][A-Za-z0-9'’_-]*/g) ?? []).length;
  return cjk + latin;
}
function bold(text) {
  return (text.match(/\*\*/g) ?? []).length / 2;
}

const failures = [];
const missing = [];
for (const [rel, limit] of Object.entries(manifest.files)) {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) { missing.push(rel); continue; }
  const text = readFileSync(p, 'utf8');
  const w = words(text);
  const b = bold(text);
  const over = [];
  if (w > limit.words) over.push(`词数 ${w} > ${limit.words}`);
  if (limit.bold !== undefined && b > limit.bold) over.push(`粗体 ${b} > ${limit.bold}`);
  if (over.length > 0) failures.push(`${rel}: ${over.join('，')}`);
}
if (missing.length > 0) {
  console.error('❌ 预算清单里的文件不存在（清单过期）：' + missing.join(', '));
  process.exit(1);
}
if (failures.length > 0) {
  console.error('❌ 常设文档超预算：');
  for (const f of failures) console.error('   ' + f);
  console.error('   先搬家（内容属于别的层级就移过去，留一行链接），再压缩；不得为让门禁变绿而放宽清单。');
  process.exit(1);
}
const rows = Object.entries(manifest.files)
  .map(([rel, l]) => {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    return `${rel} ${words(text)}/${l.words}${l.bold === undefined ? '' : ' 粗体' + bold(text) + '/' + l.bold}`;
  });
console.log('PASS 文档预算（词数/上限）：' + rows.join(' · '));
