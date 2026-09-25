// 回归：系统取图/取媒体 token 必须是**进程级**，热重载不得轮换它。
//
// 为什么这条会决定「音乐能不能播」：
//   - 客户端把 /session 给的 systemStreamBase（含 token）缓存整个页面生命周期；
//   - 音频在 Desktop 上**永远**走 system-stream token 直连（相对地址经 Desktop
//     转发会丢 Range，一拖进度就回 0 秒）；
//   - 而 /api/mv 返回的是**相对地址**（/api/dsh-music/mvfile?k=…，走平台会话），
//     所以 MV 不依赖 token。
// 于是「宿主每次 createHost() 都换 token」这一个错误，症状恰好就是
// **音乐全不能播、MV 照播**（实测症状如此）。token 钉在 process 上即可根治。
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dshm-tok-home-'));
process.env.DSH_HOME = home;
await fs.mkdir(path.join(home, 'storages'), { recursive: true });

const { createHost } = await import(new URL('../lib/host.js', import.meta.url).href);

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' | ' + detail)); };

/** 起一个宿主实例，注册旧前缀路由，返回它的端口与关停函数。 */
async function bootHost() {
  // createHost() 只返回 { handle, handleFetch, dispatch, dispose }；路由注册是
  // index.js 的 apply() 干的。这里直接驱动 handle()，等价于旧前缀入口。
  const ctx = { effect: (fn) => fn(), get: () => undefined };
  const host = createHost(ctx);
  const server = createServer((req, res) => { host.handle(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500).end(String(e)); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port + '/dsh-music/api';
  const session = await fetch(base + '/session').then((r) => r.json()).catch(() => null);
  return { host, server, port, base, session };
}

const first = await bootHost();
check('host #1 answered /session', first.session !== null && typeof first.session.systemStreamBase === 'string', JSON.stringify(first.session).slice(0, 80));
const art1 = first.session === null ? null : new URL(first.session.systemArtBase).searchParams.get('t');
const stream1 = first.session === null ? null : new URL(first.session.systemStreamBase).searchParams.get('t');
check('art and stream tokens are different (per-purpose signing)', art1 !== null && stream1 !== null && art1 !== stream1);
// 音频流真的能播（这是用户症状的那条路）
const audioOk = first.session === null ? 0 : await fetch(first.session.systemStreamBase).then((r) => r.status).catch(() => 0);
check('the token channel is reachable (any non-network status proves it)', audioOk > 0, 'status=' + audioOk);
first.server.close();
first.host.dispose();

// 模拟一次宿主热重载：dispose 旧实例、createHost 新实例
const second = await bootHost();
const art2 = second.session === null ? null : new URL(second.session.systemArtBase).searchParams.get('t');
const stream2 = second.session === null ? null : new URL(second.session.systemStreamBase).searchParams.get('t');

check('art token survives a host reload (process-level, not per-instance)', art1 !== null && art1 === art2,
  (art1 ?? 'null') + ' -> ' + (art2 ?? 'null'));
check('stream token survives a host reload — audio must keep playing after a hot reload',
  stream1 !== null && stream1 === stream2, (stream1 ?? 'null') + ' -> ' + (stream2 ?? 'null'));
// 旧 token 仍必须能用：客户端手里的缓存 URL 不能因为一次热重载而 403
const stillOk = await fetch('http://127.0.0.1:' + second.port + '/dsh-music/api/system-stream?t=' + stream1 + '&p=nope.mp3')
  .then((r) => r.status).catch(() => 0);
check('the pre-reload token is still accepted after the reload (cached client URL does not 403)',
  stillOk !== 403, 'status=' + stillOk);

second.server.close();
second.host.dispose();
await fs.rm(home, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
