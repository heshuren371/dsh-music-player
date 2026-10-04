#!/usr/bin/env node
// 闸门：去掉「会话视角」的痕迹（AI 味最大的一号破绽）。
//
// 判据来自 dsh-anti-slop-kit：**HEAD 处的读者**在不看任何会话记录、PR 线程或未提交草稿的前提下，
// 能否解析每个引用、验证每个断言。不能，就改写成仓库视角（现在时的事实/契约）并删掉推导过程。
//
// 为什么用「棘轮」而不是一次清零：基线记在 scripts/prose-baseline.json，**只许下降**
// （与 scripts/typecheck-baseline.json 同一套纪律）。清理一个文件就把它的基线调低。
//
// 豁免面（有依据，不是偷懒）：
//   - docs/audit-ledger.md：**历史层**。审计编号与「第 N 轮」在这里是合法证据（kit 的 keep 规则：
//     记录层里的合并 PR / issue 引用与变更故事是被认可的）。
//   - lib/**：tsc 产物，真源在 src/*.ts（改产物会违反 §2.15，由 check-build-fresh 守）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ALLOW = [
  /^docs\/audit-ledger\.md$/,   // 历史层：审计编号与轮次在这里是合法证据
  /^scripts\/check-prose\.mjs$/, // 探针文件本身必须包含它要猎的词（含校准样本）
  /^lib\//,                       // tsc 产物，真源在 src/*.ts
  /^node_modules\//,
  /^references\//,
  /^pnpm-lock\.yaml$/,
];
const SCAN = /\.(ts|mjs|md|json)$/;

/** 每条探针都自带 正样本 / 近失负样本：探针本身不判别就当场报错（检验方法也要被检验）。 */
const PROBES = [
  {
    id: 'session-citation',
    why: '死的会话引用（第 N 轮 / 审计编号 / 内部 § 号）：HEAD 处解析不了',
    re: /第\s*\d+\s*轮|\b[AD]-\d{2}\b|§\s*\d+(\.\d+)?/g,
    pos: '第 18 轮实测踩到（对照⑬），见 A5-09 与 §2.20。',
    neg: '这条规则要求 Host 为回环地址；媒体元素离开文档即暂停。',
  },
  {
    id: 'change-narration',
    why: '变更叙事（不再 / 原本 / 第一版）：状态陈述应写成现在时',
    re: /不再|原本|以前是|改成了|曾经是|此前|上一版|第一版|上次/g,
    pos: '这里不再硬切换；原本是第一版留下的写法。',
    neg: '该端点返回相对地址；音频始终走 token 直连。',
  },
  {
    id: 'review-choreography',
    why: '评审编排 / 对照编号：把「谁在什么时候验过」写进了正文',
    // 只抓**会话内编号**的对照（对照⑬/（对照实测））。「负向对照」在本仓库是必备实践术语，
    // 不是评审编排 —— 误报的探针比没有探针更坏，所以把它移出模式并写进近失负样本。
    re: /对照[①-⑳]|（对照|对照实测/g,
    pos: '（对照⑬）对照实测显示它会变红。',
    neg: '负向对照必须重建产物；夹具保真度决定判别力。',
  },
  {
    id: 'status-annotation',
    why: '实现状态注解（已实现 / 待建）：状态会腐烂，仓库布局与 manifest 才是权威',
    // 只抓「实现了」类状态宣告。「失败不得报告为已完成」「先登记待修」是契约与流程规则，
    // 出现在近失负样本里 —— 它们不许被判成状态注解。
    re: /已实现|已修复/g,
    pos: '该端点已实现，另一条已修复。',
    neg: '失败不得报告为已完成；缺口先登记待修，没有门禁的要标出来。',
  },
];

function selfTest() {
  const bad = [];
  for (const p of PROBES) {
    const posHit = new RegExp(p.re.source, 'g').test(p.pos);
    const negHit = new RegExp(p.re.source, 'g').test(p.neg);
    if (!posHit || negHit) bad.push(`${p.id}(正=${posHit} 负=${negHit})`);
  }
  if (bad.length > 0) {
    console.error('❌ 探针自身不判别，拒绝用它们判定代码：' + bad.join(' '));
    process.exit(2);
  }
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    const rel = path.relative(ROOT, p);
    if (ALLOW.some((re) => re.test(rel))) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SCAN.test(e)) out.push(rel);
  }
  return out;
}

selfTest();
const files = walk(ROOT).sort();
const counts = {};
const hits = {};
for (const rel of files) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  let n = 0;
  for (const p of PROBES) {
    const m = text.match(new RegExp(p.re.source, 'g'));
    if (m !== null) {
      n += m.length;
      if (hits[rel] === undefined) hits[rel] = [];
      hits[rel].push(`${p.id}×${m.length}`);
    }
  }
  if (n > 0) counts[rel] = n;
}

const baselinePath = path.join(ROOT, 'scripts', 'prose-baseline.json');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};

if (process.argv.includes('--write-baseline')) {
  const out = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(baselinePath, JSON.stringify(out, null, 2) + '\n');
  console.log(`✅ 基线已写入 scripts/prose-baseline.json：${Object.keys(out).length} 个文件，合计 ${Object.values(out).reduce((s, v) => s + v, 0)} 处`);
  process.exit(0);
}

const regressions = [];
const improved = [];
let total = 0;
for (const [rel, n] of Object.entries(counts)) {
  total += n;
  const was = baseline[rel] ?? 0;
  if (n > was) regressions.push(`${rel}: ${was} → ${n}`);
  else if (n < was) improved.push(`${rel}: ${was} → ${n}`);
}
for (const rel of Object.keys(baseline)) {
  if (counts[rel] === undefined && rel !== '' && (baseline[rel] ?? 0) > 0) improved.push(`${rel}: ${baseline[rel]} → 0`);
}

if (regressions.length > 0) {
  console.error('❌ 会话视角的痕迹增加了（只许下降）：');
  for (const r of regressions) console.error('   ' + r);
  console.error('   改写成仓库视角（现在时的事实/契约），或把推导过程删掉；历史进 docs/audit-ledger.md。');
  for (const [rel, list] of Object.entries(hits)) if (regressions.some((r) => r.startsWith(rel + ':'))) console.error(`   ${rel}: ${list.join(' ')}`);
  process.exit(1);
}
console.log(`PASS 会话视角痕迹棘轮（${files.length} 个文件，合计 ${total} 处${improved.length > 0 ? '；本轮下降 ' + improved.length + ' 个文件' : ''}）`);
if (improved.length > 0) console.log('   可下调基线：' + improved.slice(0, 8).join('  '));
