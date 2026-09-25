// 产物新鲜度门禁：lib/*.js 必须正好是 src/*.ts 编译出来的。
//
// 为什么提交产物还要门禁：`dsh plugin add github:` 只会克隆 + 装依赖，**不会跑构建**
// （本仓库显式不声明任何生命周期脚本，见 docs/compatibility.md §5）。所以 lib/ 必须
// 提交进仓库 —— 而一旦提交，"改了 src 忘了 build" 就会静默发一个旧行为出去。
// 这条门禁把那个失误变成红灯：编译到临时目录，逐字节比对。
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');

if (!existsSync(tsc)) {
  console.error('找不到 typescript。先 `pnpm install`。');
  process.exit(1);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshm-build-'));
try {
  // 类型错误允许存在（由 typecheck-ratchet.mjs 单独守），但输出必须能生成。
  let tscOutput = '';
  try {
    tscOutput = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--outDir', tmp], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    tscOutput = String(error.stdout ?? '') + String(error.stderr ?? '');
  }
  if (/error TS1[0-9]{3}|error TS5[0-9]{3}/.test(tscOutput) && !existsSync(path.join(tmp, 'index.js'))) {
    console.error('tsc 未能产出 JS（不是类型错误，是编译失败）：');
    console.error(tscOutput.split('\n').slice(0, 15).join('\n'));
    process.exit(1);
  }

  const expected = readdirSync(tmp).filter((f) => f.endsWith('.js')).sort();
  const shipped = readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).sort();

  const problems = [];
  if (expected.join(',') !== shipped.join(',')) {
    problems.push(`文件集合不一致：src 产出 [${expected.join(', ')}]，lib 里有 [${shipped.join(', ')}]`);
  }
  for (const file of expected) {
    const built = readFileSync(path.join(tmp, file), 'utf8');
    const onDisk = existsSync(path.join(root, 'lib', file)) ? readFileSync(path.join(root, 'lib', file), 'utf8') : null;
    if (onDisk === null) { problems.push(`lib/${file} 不存在`); continue; }
    if (onDisk !== built) {
      const a = built.split('\n');
      const b = onDisk.split('\n');
      let line = 0;
      while (line < a.length && line < b.length && a[line] === b[line]) line += 1;
      problems.push(`lib/${file} 与 src 编译结果不同（首个差异在第 ${line + 1} 行）`);
    }
  }

  if (problems.length > 0) {
    console.error('❌ 构建产物不是最新的（lib/ 必须由 src/ 编译而来）。');
    for (const p of problems) console.error('  ' + p);
    console.error('\n跑 `npm run build` 后重新提交。');
    process.exit(1);
  }
  console.log(`✅ lib/ 与 src/ 编译结果一致（${expected.length} 个文件）。`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
