// A3-02 回归：teardown 之后**不得再创建宿主实例**。
//
// 为什么需要这条：lib/index.js 的 ensureHost 有两个 await 挂起点（fs.stat 与动态
// import）。只把 host 置 null 挡不住它们 —— 挂起的异步分支恢复后照样
// `host = module.createHost(ctx)`，产生一个**不归任何 scope 的孤儿实例**：它会
// startScan、可能拉起 tag worker，而此后再也没有 teardown 来 dispose 它。
// 修法是在每次 await 之后、赋值之前复查 disposed（AGENTS.md §2.10）。
//
// 手法：把 lib/index.js 拷进临时树，配一个**顶层 await 延迟**的 stub host.js，
// 用它精确制造「import 还在飞」的窗口，然后在窗口内触发 teardown，
// 最后数 createHost 被调了几次。
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-race-'));

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

// stub host.js：顶层延迟 400ms，createHost 计数并回报
await fs.writeFile(path.join(tree, 'host.js'), [
  'await new Promise((resolve) => setTimeout(resolve, 400));',
  'globalThis.__hostCreations = (globalThis.__hostCreations ?? 0) + 1;',
  'export function createHost() {',
  '  return { handle: async () => {}, handleFetch: async () => new Response("ok"), dispose() {} };',
  '}',
].join('\n'), 'utf8');
await fs.writeFile(path.join(tree, 'index.js'), await fs.readFile(path.join(root, 'lib', 'index.js'), 'utf8'), 'utf8');

globalThis.__hostCreations = 0;

const mod = await import(pathToFileURL(path.join(tree, 'index.js')).href);
let handler = null;
const disposers = [];
const ctx = {
  effect: (fn, label) => { const d = fn(); if (typeof d === 'function') disposers.push({ label, d }); return d; },
  get: () => undefined,
  webServer: { register: (route) => { handler = route.handler; return () => {}; } },
};
mod.apply(ctx);
check('webServer prefix route registered', handler !== null);

const fakeRes = { headersSent: false, writeHead() {}, end() {}, destroy() {} };
const fakeReq = { method: 'GET', url: '/dsh-music/api/library', headers: { host: '127.0.0.1:3080' }, on() {} };

// 触发 ensureHost（不 await：让它停在 import 的挂起点上）
const inFlight = Promise.resolve(handler(fakeReq, fakeRes)).catch(() => {});

// 在窗口内 teardown
const teardownEntry = disposers.find((e) => String(e.label).includes('host teardown'));
check('host teardown effect captured', teardownEntry !== undefined, 'effects=' + disposers.map((e) => e.label).join(','));
if (teardownEntry === undefined) { console.log('1 FAILURE(S)'); process.exit(1); }
teardownEntry.d();

// 等在飞 import 完全落地（400ms 延迟 + 余量）
await inFlight;
await new Promise((r) => setTimeout(r, 700));

check('no host instance is created after teardown', globalThis.__hostCreations === 0,
  'createHost calls=' + globalThis.__hostCreations);

await fs.rm(tree, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
