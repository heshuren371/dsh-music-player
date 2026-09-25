// 静态审计套件：把「写了但不生效」这一类问题固化成断言。
// 由来：曾经踩过三次同族事故 ——
//   1) .dshm-progress--stacked 的 align-items 被靠后的 .dshm-progress 顶掉（同特异性）
//   2) 跑马灯阈值算成「2 倍容器宽」，导致长歌名既不滚也被切掉
//   3) 组件属性（playing）没传进去，整块 UI 直接渲染失败
// 这套断言覆盖：class 使用一致性、@keyframes 是否真被引用、BEM 修饰类是否被顶掉、
// 字典键一致性、player API 有没有没人调的方法。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const client = readFileSync(root + 'lib/client.js', 'utf8');
const host = readFileSync(root + 'lib/host.js', 'utf8');
const count = (hay, needle) => hay.split(needle).length - 1;
const Q = String.fromCharCode(96);
const cssStart = client.indexOf('const CSS = ' + Q) + 12;
const cssEnd = client.indexOf(Q + ';', cssStart);
const css = client.slice(cssStart, cssEnd);
const js = client.slice(0, cssStart) + client.slice(cssEnd);
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail));
};

// ── 1. class 使用一致性 ──────────────────────────────────────────────────
const cssClasses = new Set([...css.matchAll(/\.(dshm-[A-Za-z0-9-]+)/g)].map((m) => m[1]));
const jsClasses = new Set();
for (const m of js.matchAll(/dshm-[A-Za-z0-9-]+/g)) {
  if (js[m.index - 1] === '-' || js[m.index - 2] === '-') continue;   // CSS 变量 --dshm-*
  jsClasses.add(m[0]);
}
const cssOnly = [...cssClasses].filter((c) => !jsClasses.has(c));
check('every CSS class is referenced from JS (no dead styles)', cssOnly.length === 0, cssOnly.join(', '));
// 这几个是给测试当锚点的语义 hook，样式由同元素的 .dshm-btn 提供，不需要自己的规则。
const UNSTYLED_HOOKS = new Set(['dshm-completeGo', 'dshm-completeCancel', 'dshm-completeStop']);
const jsOnly = [...jsClasses].filter((c) => !cssClasses.has(c) && !UNSTYLED_HOOKS.has(c));
check('every class used in JS has a CSS rule', jsOnly.length === 0, jsOnly.join(', '));

// ── 2. @keyframes 必须真的被 animation 引用 ──────────────────────────────
const kf = [...css.matchAll(/@keyframes ([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
const animated = new Set([...css.matchAll(/animation:\s*([^;}]+)/g)].flatMap((m) => [...m[1].matchAll(/[a-zA-Z][\w-]*/g)].map((x) => x[0])));
const deadKf = kf.filter((k) => !animated.has(k));
check('no unused @keyframes (an animation nobody plays)', deadKf.length === 0 && kf.length > 0, deadKf.join(', ') || kf.length + ' keyframes all used');

// ── 3. BEM 修饰类不能被「靠后的基类规则」顶掉 ────────────────────────────
const rules = [];
const cssNoMedia = css.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
for (const m of cssNoMedia.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const decls = {};
  for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
  for (const sel of m[1].split(',')) {
    const s = sel.trim();
    if (s[0] !== '.') continue;
    const cls = [...s.matchAll(/\.(dshm-[A-Za-z0-9-]+)/g)].map((x) => x[1]);
    if (cls.length === 0) continue;
    const pseudo = (s.match(/::?[a-z-]+/g) ?? []).length;
    rules.push({ cls, decls, index: m.index, spec: cls.length + pseudo });
  }
}
const combos = new Map();
for (const r of rules) for (const c of r.cls) {
  const base = c.split('--')[0];
  if (c.includes('--') && base !== c) combos.set(base + '|' + c, { base, mod: c });
}
const shadowed = [];
for (const { base, mod } of combos.values()) {
  const combo = new Set([base, mod]);
  const modRules = rules.filter((r) => r.cls.includes(mod) && r.cls.every((c) => combo.has(c)));
  const baseRules = rules.filter((r) => r.cls.includes(base) && !r.cls.includes(mod) && r.cls.every((c) => combo.has(c)));
  for (const mr of modRules) for (const prop of Object.keys(mr.decls)) {
    const killer = baseRules.find((br) => br.index > mr.index && prop in br.decls && br.spec >= mr.spec);
    if (killer) shadowed.push(mod + ' {' + prop + '} <- .' + base + ' {' + prop + '}');
  }
}
check('no BEM modifier declaration is overridden by a later base rule', shadowed.length === 0, shadowed.join(' ; '));

// ── 4. 字典：中英键一致，且所有静态键都存在 ──────────────────────────────
function dict(name) {
  const i = js.indexOf('const ' + name + ' = {');
  if (i < 0) return null;
  let depth = 0, s = js.indexOf('{', i), e = s;
  for (let k = s; k < js.length; k++) { if (js[k] === '{') depth++; else if (js[k] === '}') { depth--; if (!depth) { e = k; break; } } }
  return new Set([...js.slice(s, e).matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
}
const zh = dict('zh'), en = dict('en');
check('both dictionaries exist and are non-trivial', zh !== null && en !== null && zh.size > 20 && en.size > 20, 'zh=' + (zh?.size ?? '?') + ' en=' + (en?.size ?? '?'));
const usedKeys = new Set([...js.matchAll(/(?:^|[^\w.])(?:t|translate)\("([^"]+)"\)/g)].map((m) => m[1]));
const missingZh = [...usedKeys].filter((k) => !zh.has(k));
const missingEn = [...usedKeys].filter((k) => !en.has(k));
check('every statically used locale key exists in both dictionaries', missingZh.length === 0 && missingEn.length === 0, 'zh missing ' + missingZh.join(',') + ' | en missing ' + missingEn.join(','));
const asym = [...zh].filter((k) => !en.has(k)).concat([...en].filter((k) => !zh.has(k)));
check('zh/en dictionaries have identical key sets', asym.length === 0, asym.join(', '));

// ── 5. player API 不能有「没人调」的方法 ─────────────────────────────────
const apiStart = js.indexOf('const api0 = {');
let depth = 0, apiEnd = apiStart;
for (let k = js.indexOf('{', apiStart); k < js.length; k++) {
  if (js[k] === '{') depth++;
  else if (js[k] === '}') { depth--; if (!depth) { apiEnd = k; break; } }
}
const apiBlock = js.slice(apiStart, apiEnd);
// 缩进**不可作数**：源码是 8 空格，tsc 重新排版后是 16 空格；写死字面缩进会让这条
// 断言在「改了构建方式」时静默返回 0 个方法（本该报警的地方反而变绿）。
// 做法：取该块里**最外层**（缩进最小）的键，这才是 api0 自己的方法名；用正则写死
// 缩进或直接匹配任意缩进都会把 set({...})、fetch 选项这些嵌套键一起吞进来。
const apiKeyLines = [...apiBlock.matchAll(/^(\s+)([a-zA-Z_$][\w$]*):/gm)].map((m) => ({ indent: m[1].length, name: m[2] }));
const apiKeyIndent = apiKeyLines.length === 0 ? 0 : Math.min(...apiKeyLines.map((k) => k.indent));
const methods = [...new Set(apiKeyLines.filter((k) => k.indent === apiKeyIndent).map((k) => k.name))];
// 注意用「属性引用」而不是「调用」判定：subscribe/getState 是传给 useSyncExternalStore 的。
const deadMethods = methods.filter((m) => count(js, 'player.' + m) === 0 && count(js, 'api0.' + m) === 0);
check('every player API method has a call site', methods.length > 10 && deadMethods.length === 0, deadMethods.join(', ') || methods.length + ' methods, all used');

// ── 6. host 路由与 client 调用对得上 ────────────────────────────────────
const hostRoutes = new Set([...host.matchAll(/pathname === '(\/api\/dsh-music\/[a-z-]+)'/g)].map((m) => m[1]));
const clientCalls = new Set([...js.matchAll(/api\(\s*"([^"]+)"/g)].map((m) => m[1]));
const tail = (p) => p.replace(/[?].*$/, '').split('/').pop();
const missingRoutes = [...clientCalls].filter((p) => ![...hostRoutes].some((h) => tail(h) === tail(p)));
check('every client api() call maps to a host route', hostRoutes.size >= 10 && missingRoutes.length === 0, missingRoutes.join(', '));

// ── 7. A2-01 + A5-04：写盘面三条硬约束 ──────────────────────────────────
// 背景：一个已提交的 TEMP DIAGNOSTIC 探针曾把 req.url（含 ?t=<能力 token>）写进
// `/tmp/dshm-probe.log`。核查此类问题必须按「写盘动词」搜索，不能按 "log" 搜
// （AGENTS.md §2.9 / §5.7.5）。
//
// 三条断言：
//   ① 副作用位置授权：每个 mutation 调用要么直接包 `authorize(...)`，要么引用一个
//      由 `authorize(...)` 赋值出来的变量（A5-04 / permission.zh.md:86）。
//   ② 禁止内联路径字面量：参数里不得出现含 `/` 的字符串字面量 —— 探针那类
//      `'/tmp/...'` 会立刻被判失败（A2-01）。
//   ③ 凭据不进写盘。
const MUTATORS = 'appendFile|writeFile|appendFileSync|writeFileSync|createWriteStream|unlink|rename|rm';

/** 从 `(` 下标开始做括号配对，返回调用参数原文。字符串/正则里的括号不在本仓库
 *  的调用点出现，故未做词法分析 —— 这是个针对固定代码形状的 lint，不是解析器。 */
function callArgs(src, openParen) {
  let depth = 0;
  for (let k = openParen; k < src.length; k += 1) {
    if (src[k] === '(') depth += 1;
    else if (src[k] === ')') { depth -= 1; if (depth === 0) return src.slice(openParen + 1, k); }
  }
  return '';
}

const mutationSites = [];
for (const m of host.matchAll(new RegExp('fs\\.(?:' + MUTATORS + ')\\s*\\(', 'g'))) {
  mutationSites.push({ verb: m[0], at: m.index, args: callArgs(host, host.indexOf('(', m.index)) });
}
// 由 authorize(...) 赋值出来的变量名也算已授权
const authorizedVars = new Set([...host.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*authorize\s*\(/g)].map((m) => m[1]));

const unauthorized = mutationSites.filter((site) => {
  if (/\bauthorize\s*\(/.test(site.args)) return false;
  return ![...authorizedVars].some((name) => new RegExp('\\b' + name + '\\b').test(site.args));
});
check('every filesystem mutation is authorized at the side-effect site (authorize(...))',
  mutationSites.length >= 7 && unauthorized.length === 0,
  unauthorized.map((s) => s.verb).join(', ') || mutationSites.length + ' mutation sites, all authorized');

// 含 `/` 的字符串字面量 = 硬编码路径。'utf8' / 'fs.write' 这类不带斜杠的照旧允许。
const literalPaths = mutationSites.flatMap((site) =>
  [...site.args.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]).filter((v) => v.includes('/')));
check('no filesystem mutation uses an inline path literal', literalPaths.length === 0, literalPaths.join(', '));

// 凭据 / 请求元数据不得作为写盘内容。窗口取写调用起始处 400 字符，覆盖整条语句。
const SECRET_BEARING = /\breq\.(?:url|headers)\b|headers\[['"]|\.cookie\b|authorization|\btoken\b/i;
const credentialWrites = mutationSites.filter((s) => SECRET_BEARING.test(host.slice(s.at, s.at + 400)));
check('no request credentials/metadata reach a filesystem write', credentialWrites.length === 0,
  credentialWrites.map((s) => s.verb).join(', '));

// ── 8. A1-03：module 级容器必须有界 + 停用必须收尾 ──────────────────
// module 级 Map 在热重载下会整份被 ESM 注册表钉住：既是每次重载的泄漏源，
// 又是无界增长的载体（AGENTS.md §2.2）。行为面由
// scripts/test-mv-teardown.mjs 覆盖；这里针对结构形状做静态门禁。
check('mvJobs has a capacity cap and a pruning hook',
  /const MV_JOBS_MAX = \d+/.test(host) && /function pruneMvJobs\(/.test(host),
  'MV_JOBS_MAX / pruneMvJobs missing');
check('every mvJobs.set is preceded by a pruned container',
  (host.match(/mvJobs\.set\(/g) ?? []).length > 0 &&
    host.split(/mvJobs\.set\(/).slice(0, -1).every((chunk) => chunk.includes('pruneMvJobs()')),
  'a mvJobs.set has no pruneMvJobs() upstream');
check('dispose kills in-flight MV children and clears the container',
  /function killAllMvJobs\(/.test(host) && /killAllMvJobs\(/.test(host.slice(host.indexOf('function dispose()'))),
  'killAllMvJobs not wired into dispose');
check('final-state MV jobs carry a finishedAt stamp for TTL eviction',
  (host.match(/job\.finishedAt = Date\.now\(\)/g) ?? []).length >= 3,
  'finishedAt stamps=' + (host.match(/job\.finishedAt = Date\.now\(\)/g) ?? []).length);

// ── 9. A1-02：入口回落必须正向识别、可重入、且降级可见 ───────────────────
// 行为面由 scripts/test-entry-fallback.mjs 覆盖；这里钉住结构形状：
const clientPortion = js;
check('the entry fallback is gated on positive identification, not bare 404',
  /looksLikeHostPayload/.test(clientPortion) && /legacy\.ok && looksLikeHostPayload\(/.test(clientPortion),
  'no positive fingerprint');
check('the entry probe is reentrant (resolved only on successful adoption)',
  /let entryResolved = false;/.test(clientPortion) && /entryResolved = true;/.test(clientPortion) && !/endpointProbed/.test(clientPortion),
  'one-shot endpointProbed still present, or entryResolved not gated on adoption');
check('business-404 endpoints are excluded from the entry signal (permission.zh.md-style endpoint semantics)',
  /ROUTE_MISSING_404_ENDPOINTS/.test(clientPortion) && /ROUTE_MISSING_404_ENDPOINTS\.has\(endpoint\)/.test(clientPortion),
  'bare 404 is still the only criterion');
check('the downgrade assigns the base and reports it',
  /endpointBase = LEGACY_API_BASE;/.test(clientPortion) && /downgradedToLegacy = true;/.test(clientPortion) && /onDowngrade()/.test(clientPortion),
  'switch is not reported');
check('the downgrade is surfaced in the UI',
  /hostEntry === "legacy"/.test(clientPortion) && /error.legacyEntry/.test(css + clientPortion),
  'no visible downgrade notice');

// ── 宿主：目录切换必须等 ready（第 12 轮抓出的线上缺陷）───────────────────────
// `ready` 里那句 `currentDir = await loadState()` 会在 await 恢复时**覆盖**刚设好的
// 目录。逐个路由补 `await ready` 会漏（/dir 与 /pick 的成功分支就漏了），所以正确
// 形状是放进 `setDirectory` 自己。这条断言钉的就是「它在 setDirectory 里，且在
// 任何 currentDir 赋值之前」。回退修复 → 必红。
const hostSrc = readFileSync(new URL('../src/host.ts', import.meta.url), 'utf8');
const hostLines = hostSrc.split('\n');
const setDirLine = hostLines.findIndex((line) => line.includes('async function setDirectory('));
// 按**行号**判断，不按字符偏移：跨行剥注释会让偏移量错位（本断言前两版都栽在
// 「注释里也出现了这个名字」上）。逐行剥掉行尾注释后，只看真的代码行。
const codeOf = (line) => line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim();
const setDirEndLine = setDirLine < 0 ? -1 : hostLines.findIndex((line, i) => i > setDirLine && line === '  }');
const setDirBodyLines = setDirLine < 0 ? [] : hostLines.slice(setDirLine, setDirEndLine < 0 ? undefined : setDirEndLine);
const readyLine = setDirBodyLines.findIndex((line) => codeOf(line).includes('await ready;'));
const assignLine = setDirBodyLines.findIndex((line) => /^currentDir\s*=/.test(codeOf(line)));
check('setDirectory awaits ready before touching currentDir (else loadState() clobbers it)',
  readyLine >= 0 && assignLine >= 0 && readyLine < assignLine,
  setDirLine < 0 ? 'setDirectory not found' : 'await ready missing, or placed after the currentDir assignment (ready@line+' + readyLine + ' assign@line+' + assignLine + ')');

// ── 客户端：视图层不得引用 createPlayer 的局部量（第 12 轮的「MV 重试」按钮）────
// `mvEscalated` / `set` 声明在 createPlayer() 内部，而 MusicView 在它外面。从视图里
// 引用会在**运行时抛 ReferenceError**，且抛在 player.retryVideo() 之前 ——
// 表现是「转码失败后点『重试』毫无反应，只有控制台报错」。
// 断言形状：`mvEscalated` 的每一处**代码**引用都必须早于 MusicView 的声明。回退 → 必红。
// ⚠️ 读**源文件本身**而不是上面剥过 CSS 的 clientPortion：那个文本行号与源文件不一致，
// 用它的索引判断先后会错位（本断言前两版就栽在这里）。另外逐行剥注释——说明文字里
// 也会出现 `mvEscalated`。
const clientSrcLines = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8').split('\n');
const mvViewLine = clientSrcLines.findIndex((line) => /function MusicView\(|const MusicView\s*=/.test(line));
const mvRefAfterView = clientSrcLines
  .map((text, i) => ({ i, code: codeOf(text) }))
  .filter(({ i, code }) => code.includes('mvEscalated') && i > mvViewLine);
const mvRefTotal = clientSrcLines.filter((text) => text.includes('mvEscalated')).length;
check('MusicView never references createPlayer locals (retry must not throw ReferenceError)',
  mvViewLine >= 0 && mvRefTotal > 0 && mvRefAfterView.length === 0,
  mvViewLine < 0 ? 'MusicView not found' : 'mvEscalated referenced inside MusicView at source line(s) ' + mvRefAfterView.map((r) => r.i + 1).join(', '));

console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);