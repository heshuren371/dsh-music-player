// 用 **pinned** 的 @dsh-std/manifest 校验器跑 Community v0.15 Manifest 契约。
// 见 AGENTS.md「规范基线」与「可跑门禁」。
//
// 为什么不用联网取 schema：Community 基线的权威是**固定 revision** 的
// @dsh-std/manifest，不是 raw.githubusercontent.com 上的 main 分支。main 会漂移
// —— 实测 `main` 的 schema 只 required `facets`，而 pinned 基线还 required
// `requires`/`permissions`/`contributes`/`subscriptions`。照 main 校验会漏判。
//
// 基线解析顺序（先命中先用）：
//   1. $DSH_STD_MANIFEST        —— @dsh-std/manifest 的 lib/index.js，或 package 目录
//   2. node_modules/@dsh-std/manifest
//   3. $DSH_ECOSYSTEM_SPEC/vendor/dsh-std/packages/manifest
//   4. ../references/dsh-ecosystem-spec/vendor/dsh-std/packages/manifest（本机开发布局）
//
// 基线不可用时以 SKIP 退出（exit 0 + 明确警告），**不静默通过**。
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'dsh-plugin.json');

const CANDIDATES = [
  process.env.DSH_STD_MANIFEST,
  join(root, 'node_modules', '@dsh-std', 'manifest', 'lib', 'index.js'),
  process.env.DSH_ECOSYSTEM_SPEC &&
    join(process.env.DSH_ECOSYSTEM_SPEC, 'vendor', 'dsh-std', 'packages', 'manifest'),
  join(root, '..', 'references', 'dsh-ecosystem-spec', 'vendor', 'dsh-std', 'packages', 'manifest'),
].filter((value) => typeof value === 'string' && value.length > 0);

/** 把候选路径归一化成 @dsh-std/manifest 的入口文件路径。 */
function entryOf(candidate) {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  return absolute.endsWith('.js') ? absolute : join(absolute, 'lib', 'index.js');
}

let baseline = null;
for (const candidate of CANDIDATES) {
  const entry = entryOf(candidate);
  try {
    const mod = await import(pathToFileURL(entry).href);
    if (typeof mod.validateManifest === 'function') {
      baseline = { entry, mod };
      break;
    }
  } catch {
    // 候选不可用，继续下一个
  }
}

if (baseline === null) {
  console.warn('SKIP 未找到 pinned @dsh-std/manifest 基线，无法校验 Community v0.15 Manifest 契约。');
  console.warn('     设置 DSH_STD_MANIFEST=/path/to/@dsh-std/manifest/lib/index.js 后重跑。');
  console.warn('     这不是通过，只是没校验。');
  process.exit(0);
}

const raw = readFileSync(manifestPath, 'utf8');
let manifest;
try {
  manifest = JSON.parse(raw);
} catch (error) {
  console.error(`FAIL dsh-plugin.json 不是合法 JSON：${error.message}`);
  process.exit(1);
}

const { validateManifest, parseManifest, projectManifest } = baseline.mod;
const problems = [];

// validateManifest：合法时返回 undefined，违规时抛异常。
try {
  validateManifest(manifest);
} catch (error) {
  problems.push(error.message);
}

// parse + projection：契约能被解析并投影成 Component。
try {
  projectManifest(parseManifest(raw));
} catch (error) {
  problems.push(`parse/projection 失败：${error.message}`);
}

if (problems.length > 0) {
  console.error('FAIL dsh-plugin.json 不满足 Community v0.15 Manifest 契约：');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`\n基线：${baseline.entry}`);
  process.exit(1);
}

console.log('PASS dsh-plugin.json 满足 Community v0.15 Manifest 契约');
console.log(`     基线：${baseline.entry}`);
