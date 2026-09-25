// 逐文件严格门禁：tsconfig.strict.json 的 include 列表里每个文件，都必须在
// `noImplicitAny: true` 下零错误。
//
// 为什么需要它：全仓的 noImplicitAny 是关的（历史 JS 有 300+ 处隐式 any），
// 所以「棘轮只许变少」管不住**新写的隐式 any**。允许清单把已经干净的文件钉死：
// 谁把 http-bridge.ts / tagwriter.ts 写回隐式 any，这条立刻红。
//
// 用法：
//   node scripts/check-strict.mjs            # 校验（CI 与 npm test 用）
// 新增文件进 tsconfig.strict.json 的 include 前，先确认它真的干净。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
const configPath = path.join(root, 'tsconfig.strict.json');

if (!existsSync(tsc)) {
  console.error('找不到 typescript。先 `pnpm install`。');
  process.exit(1);
}
if (!existsSync(configPath)) {
  console.error('缺少 tsconfig.strict.json —— 那是逐文件严格门禁的名单，不要删。');
  process.exit(1);
}

// 名单不能为空：空名单会让这条门禁恒绿（比没有门禁更坏）。
const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
const files = config.include ?? [];
if (files.length === 0) {
  console.error('❌ tsconfig.strict.json 的 include 是空的 —— 恒绿的门禁等于没有门禁。');
  process.exit(1);
}

let output = '';
try {
  output = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.strict.json', '--noEmit'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  output = String(error.stdout ?? '') + String(error.stderr ?? '');
}

const errors = output.split('\n').filter((line) => line.includes('error TS'));
if (errors.length > 0) {
  console.error(`❌ 名单里的文件在 noImplicitAny: true 下有 ${errors.length} 个错误。`);
  for (const line of errors.slice(0, 20)) console.error('  ' + line);
  console.error('\n修掉它们；不要为了让这条变绿而把文件从 tsconfig.strict.json 里删掉。');
  process.exit(1);
}
console.log(`✅ 逐文件严格门禁通过（${files.length} 个文件在 noImplicitAny: true 下零错误：${files.join(', ')}）。`);
