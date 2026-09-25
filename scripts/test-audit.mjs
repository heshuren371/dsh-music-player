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
const methods = [...apiBlock.matchAll(/^        ([a-zA-Z][\w]*):/gm)].map((m) => m[1]);
// 注意用「属性引用」而不是「调用」判定：subscribe/getState 是传给 useSyncExternalStore 的。
const deadMethods = methods.filter((m) => count(js, 'player.' + m) === 0 && count(js, 'api0.' + m) === 0);
check('every player API method has a call site', methods.length > 10 && deadMethods.length === 0, deadMethods.join(', ') || methods.length + ' methods, all used');

// ── 6. host 路由与 client 调用对得上 ────────────────────────────────────
const hostRoutes = new Set([...host.matchAll(/pathname === '(\/api\/dsh-music\/[a-z-]+)'/g)].map((m) => m[1]));
const clientCalls = new Set([...js.matchAll(/api\(\s*"([^"]+)"/g)].map((m) => m[1]));
const tail = (p) => p.replace(/[?].*$/, '').split('/').pop();
const missingRoutes = [...clientCalls].filter((p) => ![...hostRoutes].some((h) => tail(h) === tail(p)));
check('every client api() call maps to a host route', hostRoutes.size >= 10 && missingRoutes.length === 0, missingRoutes.join(', '));

console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);