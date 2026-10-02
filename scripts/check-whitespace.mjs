// 门禁：行尾空白 + 冲突标记。
//
// ## 为什么需要（第 21 轮）
//
// 原先只在 `AGENTS.md` §3 里写「跑 `git diff --check`」——那是**人工纪律**，不是门禁；
// 而且它在 `lib/` 上会给出一个**按规则无法修复**的失败：
//
//   * `lib/*.js` 是 tsc 产物，**手改它就违反 §2.15**（`check-build-fresh` 会立刻判红）；
//   * 而 tsc 的 JSX 输出本身会在部分行尾留下空格 —— `HEAD` 的 `lib/client.js` 里**实测有 16 处**
//     （不是我引入的：`git show HEAD:lib/client.js | grep -c '[[:space:]]$'` = 16）。
//
// 也就是说「产物有行尾空白」在现行规则下**无解**。所以本门禁：
//
//   ① 扫**全树**（不依赖 diff 基，CI 里同样有效）；
//   ② **排除 `lib/`** —— 产物质量由「src → tsc → 逐字节比对」保证，不由空白门禁保证；
//   ③ 用**非空护栏**证明扫描面本身有效（扫描文件数过少就判失败）——「0 命中」必须先校准搜索面
//      （AGENTS.md §6.1 第 3 条：第 7 轮那个 0 命中因为搜错了产物而**不含任何信息**）。
//
// 本地与 CI 都跑这个脚本；`npm test` 已包含它。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** 不扫的目录：产物 / 依赖 / VCS。`lib` 见文件头说明。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'lib', 'dist', 'coverage', '.turbo']);
/** 只扫这些扩展名（二进制夹具如 .flac/.jpg 自然跳过）。 */
const TEXT_EXT = new Set(['.ts', '.mjs', '.cjs', '.js', '.jsx', '.json', '.md', '.yml', '.yaml', '.html', '.css', '.txt']);
/** 生成物：格式由工具决定，不参与空白门禁。 */
const SKIP_FILES = new Set(['pnpm-lock.yaml']);
/** 扫描面护栏：低于这个文件数说明遍历本身坏了（排除掉自己之后仍有几十个）。 */
const MIN_FILES = 20;

const trailing = [];
const conflicts = [];
let scanned = 0;

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    if (!TEXT_EXT.has(path.extname(entry.name))) continue;
    const text = await fs.readFile(full, 'utf8');
    scanned += 1;
    const rel = path.relative(root, full);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line !== line.replace(/[ \t]+$/, '')) trailing.push(rel + ':' + (i + 1));
      if (/^(<{7} |={7}$|>{7} )/.test(line)) conflicts.push(rel + ':' + (i + 1));
    }
  }
}

await walk(root);

let failures = 0;
// 护栏：扫描面必须是有效的，否则下面的「0 命中」没有信息量。
if (scanned < MIN_FILES) {
  failures += 1;
  console.log('FAIL 扫描面无效：只扫到 ' + scanned + ' 个文本文件（应 ≥ ' + MIN_FILES + '）—— 门禁本身坏了');
}
if (conflicts.length > 0) {
  failures += 1;
  console.log('FAIL 发现冲突标记残留：\n  ' + conflicts.slice(0, 20).join('\n  '));
}
if (trailing.length > 0) {
  failures += 1;
  console.log('FAIL 行尾空白（`lib/` 已排除：产物由 check-build-fresh 保证）：\n  ' + trailing.slice(0, 20).join('\n  '));
}
if (failures === 0) {
  console.log('PASS 空白与冲突标记（扫描 ' + scanned + ' 个文本文件，排除 lib/ 与 pnpm-lock.yaml）');
} else {
  console.log(failures + ' FAILURE(S)');
}
process.exit(failures === 0 ? 0 : 1);
