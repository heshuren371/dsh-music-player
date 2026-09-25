// 类型错误棘轮：只许变少，不许变多。
//
// 为什么用棘轮而不是「要求零错误」：本仓库有 6133 行历史 JavaScript，在功能回归风险
// 不可控的前提下一次性补完 400+ 处隐式 any 不划算。棘轮让类型质量**单向收敛**：
// 今天的错误数是上界，任何新代码都必须自己干净，同时存量可以分批还。
//
// 用法：
//   node scripts/typecheck-ratchet.mjs            # 校验（CI 用）
//   node scripts/typecheck-ratchet.mjs --update   # 把当前错误数写成新基线（只在变少时允许）
//
// 基线存在 scripts/typecheck-baseline.json。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const baselinePath = path.join(root, 'scripts/typecheck-baseline.json');
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');

if (!existsSync(tsc)) {
  console.error('找不到 typescript。先 `pnpm install`（本地无 npm）。');
  process.exit(1);
}

let output = '';
try {
  output = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  output = String(error.stdout ?? '') + String(error.stderr ?? '');
}

const errors = output.split('\n').filter((line) => line.includes('error TS'));
const count = errors.length;
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : { errors: count };

if (process.argv.includes('--update')) {
  if (count > baseline.errors) {
    console.error(`拒绝上调基线：当前 ${count} > 基线 ${baseline.errors}。棘轮只许变少。`);
    process.exit(1);
  }
  writeFileSync(baselinePath, JSON.stringify({ errors: count, updatedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
  console.log(`基线已从 ${baseline.errors} 下调到 ${count}。`);
  process.exit(0);
}

console.log(`类型错误：${count}（基线 ${baseline.errors}）`);
if (count > baseline.errors) {
  console.error(`\n❌ 类型错误增加了 ${count - baseline.errors} 处。棘轮不允许倒退。`);
  console.error('前 15 条：');
  for (const line of errors.slice(0, 15)) console.error('  ' + line);
  console.error('\n修掉它们，或者只改自己新引入的那部分；不要为了过门禁而放宽 tsconfig 的类型档位。');
  process.exit(1);
}
if (count < baseline.errors) {
  console.log(`✅ 比基线少了 ${baseline.errors - count} 处。跑 \`node scripts/typecheck-ratchet.mjs --update\` 把棘轮收紧。`);
} else {
  console.log('✅ 未倒退。');
}
