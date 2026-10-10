# 门禁总表（按轮次）

> 本表原在 `AGENTS.md` §6.3。：`AGENTS.md` 有 64 KiB 注入预算，撞上后
> 尾部会被静默截断（已实测，见 AGENTS.md §11）。规则与判据留在 `AGENTS.md`，**逐条门禁的
> 覆盖面**放这里。新增门禁时同时更新本表与 `AGENTS.md` §8 的不变量索引。

"必建" 的含义：该门禁已判定为可机械校验但尚未实现；实现后按 §6.1 第 7 条会先变红，
届时按 §6.2 登记待修，**不得放宽断言**。

| 门禁 | 断言 | 归属轮次 | 覆盖 |
| --- | --- | --- | --- |
| `声明面一致性` | `dsh-plugin.json` 的 `endpoints`、`lib/index.js` 的 `FETCH_ROUTES`、`lib/host.js` 的分派表三向集合相等（不是单向 `expected.every()`）；`expected` 必须从分派表推导而非手工抄 | 1/2/4 | `A1-01`/`A2-03`/`A4-01` |
| `传输面覆盖` | 每个功能套件至少有一个用例打生产使用的传输面（默认 `connection.fetch`），不得只打旧前缀 | 2 | `A2-03` |
| `释放面完整性` | （`test-leak.mjs`）：8 次热重载后 ① fd 不增长 ② 无孤儿子进程 ③ `dispose()` 后 1.5s 内 CPU≈0 ④ heap 增长有界（阈值由正对照标定） | 1/3/15 | `A1-03` |
| `死代码` |：`tsconfig.json` 永久开启 `noUnusedLocals` + `noUnusedParameters`（开启前全仓仅 5 处，已清）。新增未使用声明会直接让 `typecheck` 变红 | 15 | `A2-15` |
| `停止后无自续期定时器` | teardown 后 3 s 内 fetch 次数不增；`getState().scanning === false` | 3 | `A3-01` |
| `teardown 优先于在飞重载` | 挂起 `import()` 期间触发 disposer，断言不再创建 host（`fs.stat`/`import` 计数不增、tag worker 未启动、有回滚或明确降级而非静默空窗） | 1/3 | `A1-04`/`A3-02` |
| `客户端 release 面` | teardown 后 `window.__dshMusicPlayer === undefined` 且 `.dshm-mvPark` 不在 DOM；二次 activation 不复用第一次的媒体元素 | 3 | `A3-03`/`A3-04` |
| `ctx 读取面一致性` | `ctx.get('X')` / `ctx.<svc>` / `ctx.inject([...])` 的服务名集合 ⊆ manifest `requires.contracts` + `permissions`（静态，建议并入 `test-audit.mjs`） | 3/4/5 | `A3-05`/`A4-03`/`A5-05` |
| `契约坐标可解析` | 每个 `requires.contracts` 的 `{apiVersion,kind}` 能在 pinned definition catalog 解析；且至少一条 `required` | 4 | `A4-02`/`A4-03`/`A4-06` |
| `prefix 语义一致` | `HttpPrefixRoutes` 声明的 `prefix` 必须等于 `webServer.register` 的 path | 4 | `A4-05` |
| `凭据不进日志` | 触发一次带 `?t=` 的请求，断言任何落盘文件都不含该 token 值；且 `lib/` 无未声明的写盘点（搜索面见 §2.9） | 2/5 | `A2-01`/`A5-01` |
| `自建 token 三律` | ①同一 token 不得同时通过 `art` 与 `stream` ②基址 hostname 恒为回环字面量 ③无 `isSystemPath` 式栅栏豁免 | 5 | `A5-02`/`A5-03` |
| `错误面脱敏` | 触发 `fs` 错误与「文件不存在」路径，断言响应体不含绝对路径与文件名 | 1/5 | `A1-05`/`A5-09` |
| `声明面覆盖实际调用` | 从 `lib/` 抽取的 fs / net / host 面 ⊆ manifest 声明面；新增写盘路径必须落在已声明 scope 内 | 5 | `A5-06`/`A5-08` |
| `副作用前置授权` | 每个 `fs.unlink` / `fs.rename` / tagwriter 投递的调用链上先经同一 `authorize(action, scope)` | 5 | `A5-04` |
| `存储失败不得报成功` | 只读 `$DSH_HOME` 时，断言响应含稳定未持久化错误码，而不是 `200 + 数据` | 5 | `A5-09` |
| `恒绿断言扫描` | 静态禁止 `check(…, true)` 字面真断言；「跳过」必须能与「通过」区分（非零退出或显式 skip 计数） | 2 | `A2-10`/`A2-11`/`A2-13` |
| `空白与冲突标记` | （`scripts/check-whitespace.mjs`，接入 `npm test` 与 CI）：全树扫行尾空白与冲突标记，排除产物 `lib/`（tsc 会在 JSX 行尾留空格，而改 `lib/` 违反 §2.15 ⇒ 该失败按规则无法修复），并带非空护栏（扫描文件数 <20 判失败，防「0 命中」不含信息）。负向对照：塞行尾空格 → 红 · 塞冲突标记 → 红 | 21 | §3 §9 |
| `门禁诊断可用` | `run-all.mjs` 失败时必须打印失败套件的 stderr | 2 | `A2-12` |
| `视图卸载不丢全屏播放器` | （`test-view-persistence.mjs`）：开全屏（含 MV 放大）→ 卸载视图 → store 仍 `open` 且媒体停在 body → 重新挂载 → 全屏播放器 / 放大布局 / 同一个 `<video>` 全部回来；收起动画跨卸载仍走完；`halt()` 复位 | 16 | §2.17 |
| `音频不得硬切换` | （`test-audio-fade.mjs`）：首播 30ms 内挂源（不等淡出）；换源前必须多步淡到 ~0；换源后淡回用户值；暂停前先淡出；淡入途中改音量不被覆盖；连切后渐变已结算；`halt()` 后不再写 `audio.volume`；H1 手动切歌淡出 ≥200ms（fooyin 300）· H2 曲末自动 ≥500ms（fooyin 700）· seek 淡出→seek→淡回（`test-audio-graph` B14/B15） | 18/20 | §2.18 |
| `波形进度条` | 第 24–25 轮（`test-waveform.mjs`，16 条）：起播按曲目 id 取包络；400 桶→120 根两层柱子且高度跟随包络（静音段 6% 底线）；进度经 CSS 变量给遮罩；换歌重新取；拿不到波形静默降级（不渲染柱子、进度条照旧、无 error）；丢弃迟到的包络（连切场景）；宿主：峰值 0..1、夹具独立量过的包络忠实（前 1/4≈0 / 后 1/4≈1、分界在中点）、缓存命中、改文件后重算、未知曲目/非音频优雅降级不是 500、teardown 后不再服务。第 25 轮新增（性能）：预取下一首的包络（起播即取当前+下一首）、客户端有界缓存（30 条） 第 27 轮新增 B9：同时 5 个请求时超出并发闸门的立即得到 `busy`（去掉闸门 → ok=5 busy=0 红） |
常驻底栏柱子 120→60 根（节点 240→120，全屏仍 120 根）。负向对照：不按峰值归一化 → B2/B3 红 ·
缓存永不失效 → B5 红 · 客户端不丢弃迟到结果 → A9 红（第一版对照恒绿，改成「先发慢、后发快」才红）·
不做预取 → A1 红 · 不查客户端缓存 → A5/A6 红（请求数 2 → 4） · 底栏不减半 → A2/A3 红 ·
dispose 不停波形 → `test-audit` 静态接线检查红 | 24–25 | §2.23 §2.24 |
| `均衡器（10 段 + 预设，曲线按入耳式可听频段）` | （`test-audio-graph.mjs` E 段，10 条）：建出 10 段 peaking 且频点为十段 ISO 中心频率；链条顺序 源→RG→f1…f10→前级→音量→destination；默认 flat 全 0dB；预设逐段生效；自动前级按最大提升衰减（+5dB→×0.5623）；自定义曲线夹 ±12dB；非法输入不动现状；音量/RG/EQ 三条互不覆盖；曲线持久化；缺 `createBiquadFilter` 只跳过 EQ、音频图照建。负向对照：不建链 → 8 条红（含非空护栏）· 增益不落地 → E4/E6/E8 红 · 两处夹范围都删 → E6/E8/E9 红 · 无自动前级 → E5 红 · 非法输入不拒绝 → E7/E8/E9 红 | 23 | §2.22 |
| `预取 + 交叉淡化（默认开启，`?crossfade=0` 关闭）` | 第 22 轮已实现（`test-audio-graph.mjs` D 段，7 条）：起播后把下一首预取到空闲元素（只加载不出声）；切换时两个电平节点同刻起算地重叠 ramp（0↔1）；交叉期间不写用户音量节点；交接后活跃元素换成预取的那个（旧元素已停）；链式预取继续；交叉进行中 teardown 会停掉两个元素；默认关闭时零影响（不创建第二个元素）。第 25 轮翻转默认值并同步门禁语义：D0a 断言「不带参数就走交叉淡化」（对照：把默认改回去 → 立刻红） 第 27 轮新增 D9a/D9b（新切歌即时结算在飞交接 → 去掉守卫 D9a 红）、D10（`MEDIA_ERR_SRC_NOT_SUPPORTED` 不做徒劳重试/跳区 → 短路失效红）、D11（ctx 被系统挂起且元素仍在放时新增一次 resume → 处理器变 no-op 红） |
D0b 断言「`?crossfade=0` 仍可回到旧路径」；RG / 均衡器 / CORS 等套件一律显式固定
`?crossfade=0` 做隔离（否则默认值变成每个套件的隐藏变量）。负向对照：不预取 → D1–D4 红 ·
不交换绑定 → D4/D6 红 · 退化成串行 → D2 红 · halt 不停空闲元素 → D6 红 | 22 / 25 | §2.21 |
| `封面替换（在线补全）` | `test-cover-replace.mjs`（8 条）：手动应用默认 `replaceCover:true`、取消勾选后 `false`、候选无封面时 `false`；一键补全默认一律 `false` 且跳过已正确的歌，勾选后一律 `true` 且那些歌也轮到。对照：字段缺失 → A2/B1/C1 或 D1/E1 红 · 去掉跳过例外 → E1/E2 红 · 复选框恒 true → 只红 B1 | 31 | AGENTS「封面写入」 |
| `ReplayGain 响度归一化` | （`test-replaygain.mjs`，24 条）：读标签部分 —— 宿主下发四项标签且未测量为 null；客户端 `off` 默认不干预；track/album 增益数学；前级叠加；防削波按峰值收窄；未测量曲目不做增益；两个增益互不覆盖（源→RG→音量）；回退路径折进元素音量；模式持久化。测量部分（Part C）—— 端点形状（GET 只报状态）；测量值随 payload 下发且等于独立量出的 响度换算值（+15.10dB）；全静音 → 保持 null（不算失败）；重复测量走缓存；teardown 后端点不再服务；新实例状态干净；客户端标签优先于测量、无标签时用测量兜底。负向对照：删投影白名单 → A1–A5 红 · 关防削波 → B6 红 · 不建独立节点 → B1 红 · 回退丢弃 RG → B9 红 · 去掉测量兜底 → B11 红 · 测量压过标签 → B12 红 · payload 不下发测量值 → C4–C7 红 · 静音不特判 → C6 红（得出 +52dB 的荒谬增益）。覆盖缺口（如实记录）：teardown 杀子进程没有行为断言（删掉 `stopRgMeasure` 调用 C8 仍会通过）—— 该接线由 `test-audit` 的静态检查覆盖 | 21 | §2.20 |
| `音频常驻输出流 + 媒体 CORS` | （`test-audio-graph.mjs`）：起播建一个常驻 AudioContext 且换歌不重建；元素音量置中性、增益在图里；同源不设 crossOrigin / 跨源必须带；未确认 CORS 前不建图；建图失败与 `?musicGraph=0` 均回退；`halt()` 只 suspend。宿主侧：窄名单回显 ACAO（非名单一个头都不给）、媒体端点应答 `OPTIONS` 预检、平台路由拒绝跨源预检 | 19 | §2.19 |
| `客户端 activation 归属（设备页级 / 租约 / 释放面）` | `test-client-activation.mjs`（21 条）：`halt()` 摘 window 键、撤监听、移自建 DOM、只 suspend 设备；二次 activation 与热重载后**起播必须出声**；`toggle()` 唤醒被挂起的设备；换歌不跳满幅。负向对照与失败细节见台账对应小节 | 32 | AGENTS「客户端 activation 归属」 |
| `MV 音轨判定与任务生命周期` | `test-mv-jobs.mjs`（8 条 + 无 ffmpeg 时显式 skipped）+ `test-mv-client.mjs`（7 条）：mkv 不豁免音轨判定（真 `h264+mp2` 夹具）、档位从 `audio` 起、失败记录 10 分钟粘住且 `retry=1` 真重跑、音轨看门狗正反向、direct 档挂 token 绝对地址、WASM 旁路的音轨前提（静态） | 32 | AGENTS「错误面与降级」 |
