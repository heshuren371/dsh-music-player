// A1-01 / A2-03 / A4-01：端点声明面必须三向一致。
//
// 为什么要有这条套件：曾经 host.js 实现 18 个端点、index.js 只注册 11 个、
// manifest 只声明 10 个，而 test-desktop-routes.mjs 的 expected 是**手工抄的同一份
// 11 条**、断言写成单向后含 —— 三方漂移在 18/18 全绿的套件下活了很久，7 个端点
// 在无 webServer 的宿主形态下不可达却没人知道。
//
// 这条断言**从 host.js 的分派表推导**，不抄任何一侧：
//   host.js 分派表  ==  FETCH_ROUTES  ∪  LEGACY_ONLY_ROUTES（具名例外）
//   manifest endpoints  ==  host.js 分派表
//   FETCH_ROUTES 的 methods  ==  分派表的 method（GET 额外允许 HEAD）
//
// 新增端点时必须同时改 host.js + index.js 的 FETCH_ROUTES + dsh-plugin.json，
// 否则本套件变红。（AGENTS.md §2.7）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FETCH_ROUTES, LEGACY_ONLY_ROUTES } from '../lib/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const host = readFileSync(root + 'lib/host.js', 'utf8');
const manifest = JSON.parse(readFileSync(root + 'dsh-plugin.json', 'utf8'));

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail));
};

// ── 1. 从 host.js 分派表推导（唯一事实来源）────────────────────────────
const AWAY = 'pathname === ';
const dispatch = new Map();
for (const m of host.matchAll(/pathname === '(\/api\/dsh-music\/[a-z-]+)'(?:\s*&&\s*req\.method === '([A-Z]+)')?/g)) {
  dispatch.set(m[1], m[2] ?? 'GET');
}
check('host.js dispatch table is non-trivial', dispatch.size >= 15, dispatch.size + ' endpoints');

// ── 2. host 分派 == FETCH_ROUTES ∪ LEGACY_ONLY ────────────────────────
const registered = new Set(FETCH_ROUTES.map(([path]) => path));
const legacyOnly = new Set(LEGACY_ONLY_ROUTES);
const covered = new Set([...registered, ...legacyOnly]);

const unimplemented = [...covered].filter((p) => !dispatch.has(p));
check('every declared route has a host.js handler', unimplemented.length === 0, unimplemented.join(', '));

const unregistered = [...dispatch.keys()].filter((p) => !covered.has(p));
check(
  'every host.js endpoint is either registered on connection.fetch or a named legacy-only exception',
  unregistered.length === 0,
  unregistered.join(', ') || dispatch.size + ' endpoints = ' + registered.size + ' registered + ' + legacyOnly.size + ' legacy-only',
);

// ── 3. manifest endpoints == host 分派 ────────────────────────────────
const transport = manifest['x-dsh-music-player']?.transport;
check('manifest declares the endpoint registry', transport !== undefined && Array.isArray(transport.endpoints));
const declared = new Set((transport?.endpoints ?? []).map((line) => '/api/dsh-music' + line.split(' ').pop()));
const missingInManifest = [...dispatch.keys()].filter((p) => !declared.has(p));
const extraInManifest = [...declared].filter((p) => !dispatch.has(p));
check('manifest endpoints match the host dispatch table exactly', missingInManifest.length === 0 && extraInManifest.length === 0,
  [missingInManifest.length ? 'missing: ' + missingInManifest.join(', ') : '', extraInManifest.length ? 'extra: ' + extraInManifest.join(', ') : ''].filter(Boolean).join(' ; ') || declared.size + ' declared');

// ── 4. methods 一致（GET 额外允许 HEAD，因为 host.js 把 HEAD 改写成 GET）──
const methodProblems = [];
for (const [path, methods] of FETCH_ROUTES) {
  const dispatched = dispatch.get(path);
  if (dispatched === undefined) { methodProblems.push(path + ': no handler'); continue; }
  const allowed = new Set([dispatched, ...(dispatched === 'GET' ? ['HEAD'] : [])]);
  if (methods.length === 0 || methods.some((m) => !allowed.has(m))) {
    methodProblems.push(path + ': registered [' + methods.join(',') + '] vs handler ' + dispatched);
  }
}
check('registered methods match the host handler method', methodProblems.length === 0, methodProblems.join(' ; '));

// ── 5. 例外必须仍然只有那两个（防止有人靠加白名单把漂移洗绿）──────────
const EXPECTED_LEGACY_ONLY = ['/api/dsh-music/system-art', '/api/dsh-music/system-stream'];
check(
  'the legacy-only exception list is exactly the two token endpoints',
  LEGACY_ONLY_ROUTES.length === EXPECTED_LEGACY_ONLY.length && EXPECTED_LEGACY_ONLY.every((p) => legacyOnly.has(p)),
  LEGACY_ONLY_ROUTES.join(', '),
);
check('no legacy-only endpoint is also registered on connection.fetch', EXPECTED_LEGACY_ONLY.every((p) => !registered.has(p)), '');

// ── 6. A4-03：禁止重新引入编造坐标 ─────────────────────────────────────
// 这两个坐标在 references 全树与 DSH 0.1.7-rc.2 运行时**均 0 命中**（实测，校准过
// 搜索面：同一命令对宿主确实在用的 conversation.view 命中 104 个文件）。它们曾经
// 出现在 requires.contracts 里，让协商层永远拿不到 definition。补 fallback 不算修复
// （AGENTS.md §2.11），所以这里直接把它们设为不可回归。
const FABRICATED = ['webserver.dsh/v1alpha1', 'browser.ui.dsh/v1alpha1'];
// 只查**结构位置**上的 apiVersion 值，不查散文说明 —— 台账/注释里必须能引用这两个
// 字符串作为证据（"曾经声明的坐标"），否则等于把事实记录也一起禁掉。
const declaredApiVersions = [];
(function walk(node) {
  if (Array.isArray(node)) { for (const item of node) walk(item); return; }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'apiVersion' && typeof value === 'string') declaredApiVersions.push(value);
    else walk(value);
  }
})(manifest);
const reintroduced = declaredApiVersions.filter((v) => FABRICATED.includes(v));
check('no fabricated contract coordinate is reintroduced as a declared apiVersion',
  reintroduced.length === 0, reintroduced.join(', ') || declaredApiVersions.length + ' declared apiVersions, all real');

// requires.contracts 为空是**诚实状态**：本插件依赖的是 DSH host service
// （connection / webServer），Community v0.15 没有对应 protocol 坐标。
// 一旦有人加回条目，必须同时满足「可解析」与「至少一条 required」。
const contracts = manifest.requires?.contracts;
check('requires.contracts is an array', Array.isArray(contracts));
if (Array.isArray(contracts) && contracts.length > 0) {
  const incomplete = contracts.filter((c) => typeof c.apiVersion !== 'string' || typeof c.kind !== 'string');
  check('every contract entry has apiVersion + kind', incomplete.length === 0, JSON.stringify(incomplete));
  check('a non-empty contract list includes at least one required entry (or preflight is vacuously true)',
    contracts.some((c) => c.optional !== true), 'all ' + contracts.length + ' entries are optional');
}

// ── 7. A4-02 / A4-06：不得声明无 definition 的扩展 ────────────────────
// `x-dev.dsh-std.extensions` 里那两条条目（browser / music-view）没有 definition：
// pinned 投影只会把它们变成 `unknown-extension` warning，而 `manifest.zh.md:62`
// 明确「Host 不理解某项扩展时不能声称对应功能已经生效」。所以正确做法是
// **不声明**而不是**假声明** —— 真实绑定记录在 `x-dsh-music-player.ui` 里，
// 并由下面两条断言保证「记录的东西在代码里真能找到」。
const contributes = manifest.contributes ?? {};
const undeclaredExtensions = Object.entries(contributes)
  .filter(([point]) => point.startsWith('x-'))
  .flatMap(([point, rows]) => (Array.isArray(rows) ? rows.map((row) => point + ':' + (row?.id ?? '?')) : []));
check('no definition-less extension is declared as a capability',
  undeclaredExtensions.length === 0,
  undeclaredExtensions.join(', ') || 'contributes has no x-* extension rows');

const ui = manifest['x-dsh-music-player']?.ui;
check('the real UI binding is documented', ui !== undefined && typeof ui.slot === 'string' && ui.slot.length > 0);
const clientSource = readFileSync(root + 'lib/client.js', 'utf8');
check('the documented slot actually appears in the client source',
  ui !== undefined && clientSource.includes('"' + ui.slot + '"'),
  ui === undefined ? 'no ui binding' : 'slot=' + ui.slot);
const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
check('the documented client module is the one package.json exports',
  pkg.exports?.['./client'] === './lib/client.js' && pkg.dsh?.client?.platform === 'web',
  'exports["./client"]=' + pkg.exports?.['./client']);

console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
