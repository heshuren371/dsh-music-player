# AGENTS.md

DSH 的本地音乐播放器插件，Web + Desktop 同一份包。**改代码前读本文件**；规则的完整措辞、逐轮
实测与编号裁定在 [docs/rules-detail.md](docs/rules-detail.md) 与 [docs/audit-ledger.md](docs/audit-ledger.md)。
本文件只写**可执行结论**——一条规则一句，理由压进括号或链接。

## 命令

```sh
pnpm run build          # src/*.ts → lib/*.js（产物**提交进仓库**，改了 src 必须重建）
pnpm run typecheck      # 类型棘轮：错误数只许变少（基线 0）
npm test                # 产物新鲜度 + 逐文件严格 + 31 套回归（= check-build-fresh && check-strict && run-all）
pnpm run check:manifest # 只有动了 dsh-plugin.json 时才必跑；基线缺失时它 SKIP，**SKIP ≠ 通过**
node scripts/check-whitespace.mjs  # 空白/冲突标记（npm test 已含；**排除 lib/**，理由见 docs/rules-detail.md）
pnpm run dev            # tsc --watch：保存即重编，宿主按 lib/host.js 的 mtime 热重载
```

**顺序不能颠倒：先 build 再跑测试**（门禁读 `lib/`；不 build 就是在验旧产物）。新增回归套件必须
在 [scripts/run-all.mjs](scripts/run-all.mjs) 注册——没注册等于没门禁。逐条门禁表见 [docs/gates.md](docs/gates.md)。

## 目录与改动生效路径

| 文件 | 职责 | 改动生效 |
| --- | --- | --- |
| `src/index.ts` | 入口薄壳：注册 `/api/dsh-music/*` Fetch 路由、按 mtime 热重载 host | **重启进程** |
| `src/host.ts` | 宿主：扫描 / 标签解析 / Range 流 / 多源匹配 / 封面代理 / 写入与重命名 | 刷新页面 |
| `src/client.ts` | 客户端「音乐」视图（React）。**必须零 import/export** | 刷新页面 |
| `src/http-bridge.ts` | Fetch ⇄ node:http 适配（背压 / abort 释放 fd / HEAD） | 刷新页面 |
| `src/tagwriter.ts` | 标签写入 worker 入口 | 刷新页面 |

## 完成定义（DoD）

1. 改了 `src/` → 跑过 `pnpm run build`。
2. `pnpm run typecheck` 0 错误（`noUnusedLocals`/`noUnusedParameters` 已开：死代码直接红）。
3. `npm test` 31 套全绿。
4. 新增功能/修复 → 在 `run-all.mjs` 注册了回归套件。
5. 新增断言 → **做过对照**：把缺陷改回去，断言必须变红（见「审计与迭代协议」第 7 条）。
6. 改了文档 → README ≤ 220 行，深度材料进 `docs/`。
7. **收口 = 提交 + 推送 + `git status --short` 为空 + CI 绿。** 只跑门禁不算完成——门禁验工作区，
   `git status` 才验仓库。

## 不可协商的规则

> 每条给出**能机械抓住**的门禁或审计条目；完整论证见 [docs/rules-detail.md](docs/rules-detail.md)。

**Manifest**（`manifest.zh.md`）。包根至多一个 `dsh-plugin.json`，必须是静态 JSON，不联网执行
schema/validator；未知版本不得回退旧 schema。扩展字段不得暗含 required 行为；`optional` 必须写
`fallback`；`compat`/`overrides` 不产生 live support；schema 通过 ≠ 能激活，digest ≠ 发布者身份。

**Lifecycle**（`lifecycle.zh.md`）。`activate` 里注册的一切必须绑定当前 activation 的 cleanup
scope；scope 关闭先 abort 再**逆序**执行 disposer，每个至多一次，单个失败不阻止其余；停止后要
验证 support 与 owner record 已移除；超 deadline 必须留 timeout 诊断。**不得依赖 module 卸载完成
清理**：热重载下旧 module 被 ESM 注册表永久持有，旧实例的 handler/timer/子进程/module 级容器
必须自己撤销并设上限。

**Composition**（`composition.zh.md`）。facet 名称与发现顺序**不是**选择条件；未被选中的 facet 不
带入 requirements；preflight 成功 ≠ agreement，运行时不符必须失败/回滚/重组；同坐标冲突不得靠
注册顺序解决；没有「最后注册者覆盖」；实际激活偏离 plan 必须报告 activation failure。

**Permission**（`permission.zh.md`）。静态请求是 facet 的**上限**：缩小 scope 不必改 manifest，
**扩大必须新增声明**。每个产生副作用的位置都要 `authorize(action, scope)`——validator、report、
UI 上的「已允许」都不能替代运行时检查。审计记录前移除凭据/文件内容/工具输入；不得用字符串前缀
判断路径或 scope。

**Storage**（`storage.zh.md`）。`LocalStorage` 通过 protocol requirement 声明；读需
`storage.local.read`，写/删需 `storage.local.write`；value 必须是 JSON value；同命名空间同 key
串行化，**不得**假设 transaction/CAS/enumeration/watch；`deactivate` 不删数据；cleanup 可重复执行，
**失败不得报告为已完成**；禁止把 value/凭据/secret 写进普通日志。

**声明面五副本**。`host.ts` 分派表 ←→ `index.ts` 的 `FETCH_ROUTES` ←→ `dsh-plugin.json` 的
endpoints ←→ `Track`→`PayloadTrack` 白名单投影 ←→ 客户端 `MusicTrack`——**给 `Track` 加字段必须
同时改后两处**，否则下发永远是 undefined。`connection.fetch.register` 是**精确匹配**，新端点必须
同步加进 `FETCH_ROUTES` 才可达。

**错误面与降级**。404 在本插件是正常语义，**不得**用它当「宿主是不是新入口」的唯一判据（平台
栅栏在路由前答 401/403）；探测必须可重入（禁止一次性标志）；降级信任边界必须显式报告；错误响应
必须脱敏（不得回显路径/文件名）。媒体元素 `error` 按 `MediaError.code` **分派**：源不可用(4) 直接
放弃 + 下一首（不做徒劳重试/跳区）；解码(3) 跳坏区；网络(2) 有界重试（借鉴 feishin）。

**诊断与日志**。禁止把凭据写进任何日志或落盘（`req.url` 的 query 就带 token，落盘前必须剥
`t=`/`token`/`authorization`/`cookie`）；诊断代码不得进 HEAD；写盘路径必须在已声明 scope 内；
禁止在请求关键路径同步落盘。

**客户端 activation 归属**。禁止用 `window.*` 把上一代 player/timer/handler 交给下一代；
`await` 挂起后恢复必须检查 `disposed`；**「清 timer」≠「阻止再武装」**，teardown 要显式复位守卫
依赖的状态；自建 DOM 与全局键必须释放；不得读取未在 manifest 声明的 context API。
→ [细则](docs/rules-detail.md#210)

**契约坐标必须真实可解析**。禁止发明 `apiVersion + kind`，写进 manifest 前必须实测；`fallback`
不能洗白不存在的坐标；无 definition 的扩展 ≠ 能力声明；extension id 必须有运行时对应；声明的
`prefix` 必须等于 `webServer.register` 的 path；`requires.contracts` 至少一条 `required`。
→ [细则](docs/rules-detail.md#211)

**自建 bearer token 三律**。① 按用途分签（art/stream 不得互换）；② 基址钉回环字面量，不回显
请求 Host；③ 被豁免栅栏的端点不得承担读能力，凭证不得进入任何持久通道。token 通道既不走平台
鉴权也不走插件栅栏，**唯一防线是保密性**。 → [细则](docs/rules-detail.md#212)

**失败不得报告为成功**。吞掉写失败仍返回 200 是违规（现 `A5-09`：`saveState` 全量吞错后 `/dir`
仍 200）；持久化层需要有稳定错误码。

**能力 token 与 activation 生命周期对齐**。token 必须钉在**进程**上（`Symbol.for` + `globalThis`），
不得随 `createHost()` 轮换；消费者缓存要带 TTL 且失败时作废重取。判断症状归属：`/api/mv` 是相对
地址、**音频永远走 token 直连**——「音乐不能播、MV 能播」几乎总是 token 通道问题。

**TypeScript 真源与棘轮**。`src/*.ts` 是**唯一真源**，`lib/*.js` 是 tsc 产物且提交进仓库
（`dsh plugin add` 不跑构建）——**禁止手改 `lib/`**（`check-build-fresh` 逐字节比对）。
`strictNullChecks` 等全开、`noImplicitAny` 暂关但由 `tsconfig.strict.json` 的**允许清单**单向收严；
**禁止**为让门禁变绿而放宽档位、上调基线或删名单项。`client.ts` 必须零 import（bundle 由宿主
`eval`，import 无法解析）。静态断言的四个坑：先剥注释、按行号而非偏移、别依赖字面缩进、
按**角色**而非创建顺序选节点。

**平台栅栏在路由之前拒答**。回落判据必须覆盖 401/403/404 全部「送不到」的状态码 + 正向识别 +
显式报告降级；例外只给 `/session`；拿不到基址必须**重取**（降级成不可 seek 比等待更糟）；
按可观测症状兜底自愈要有界、成功才停；夹具保真度就是判别力。 → [细则](docs/rules-detail.md#216)

**视图卸载**。`conversation.view` 切走即卸载：要跨视图保留的 UI 状态禁止放视图局部 `useState`；
视图驱动的定时器归资源所有者；重挂载要把外部资源搬回来且断言「同一个元素」；UI 过渡定时器禁止
用 `disposed` 早退，也禁止给 `openPlayer` 加 `disposed` 守卫（会让全屏播放器再也打不开）。
→ [细则](docs/rules-detail.md#217)

**过渡时长**。淡入淡出时长取 fooyin 默认值（manual 300/300 · auto 700/700 · seek 120/120 ·
pause 120/120 · stop 120/300 ms），**禁止**调到 200ms 以下；拖动进度也要淡（只在常驻音频图接管
增益时）；`state.volume` 始终是用户设定值，渐变只改瞬时值；渐变必须可取消且取消时结算 promise；
「没有声音要淡出」的路径必须**同步**（判据 `paused === false && volume > 0.001`）。

**电流声 = 设备被反复重建**。Chromium 为每条媒体源建一条输出流 ⇒ 换 `src` 会重协商设备格式。
修法是**常驻 `AudioContext`**（一条流、固定采样率）；跨源接 Web Audio 必须先确认 CORS（否则静音）；
建图失败永久退回元素音量；**建图后元素音量必须置中性**；`halt()` 只 suspend 不 close；
`sampleRate` 创建即固定所以 ctx 必须首播时才建；`location` 一律写 `window.location`。
**系统挂起 ctx 必须自愈**：`onstatechange` 里按**媒体元素**判断（元素仍在放 + ctx 非 running）才
`resume()`，否则症状是「界面在放、耳机没声」且无从判断。

**ReplayGain**。只读标准标签、不改文件；**未测量 ≠ 0dB**（缺标签必须不做增益）；增益走**独立
节点**；回退路径把 RG 折进元素音量且 `readVolume()` 要除回去；防削波恒开（按 `peak` 收窄）；
标签先收窄再夹范围（±40dB / 前级 ±15dB / 峰值 ≤4）；`null` 要**原样下发**；标签缺失时用 ffmpeg
`ebur128` **只读**测量兜底（本机实测 0/40 首带标签）；优先级**标签 > 测量**；全静音计入 skipped
而非 failed；测量子进程必须可取消且在 `dispose()` 里杀掉；失败原因分类且不含路径。

**交叉淡化**。两个媒体元素 + 每元素一个电平节点，接进**同一个**常驻 AudioContext；`audio` 必须是
`let`（交接时交换绑定，90+ 处引用自动跟随）；电平必须每元素独立（共享音量节点会连新元素一起压掉）；
「重叠」的判据是两条 ramp **同刻起算**；**任何新切歌先即时结算在飞的交接**（`commitPendingCrossfade`）——
只 guard `disposed` 不够，迟到交接会换错元素；teardown 要停两个元素，且断言必须等新元素真的 `play()`
之后（切歌是异步的，否则 halt 抢跑）；**默认开启**，`?crossfade=0` 显式关闭；翻转默认值必须同时
断言「默认走新路径」与「显式关闭可回旧路径」，并让其它套件**显式固定**模式做隔离。

**均衡器**。10 段 ISO peaking 串在 RG 与音量之间；**0dB 即直通**（所以不需要旁路开关），默认
`flat`；自动前级 `10^(-max(0,最大提升)/20)` 不得去掉；曲线夹 ±12dB 且**两处都夹**（API 边界 +
应用层）；非法输入一律**不动现状**；缺 `createBiquadFilter` 时只跳过 EQ，绝不因此丢掉常驻音频图；
参数常量必须在模块级（视图与 player 是两个作用域）。曲线按**入耳式真能重放的频段**分布——小动圈
对 31/62Hz 几乎无输出，把能量堆在那里只会让自动前级压低整体音量。

**波形**。ffmpeg 只读解码后**流式**聚合（内存与曲长无关，绝不缓冲整段 PCM）；**并发闸门**
（同时最多 2 个，超额**立即** `reason: busy`，不排队——借鉴 navidrome `TranscodeLimiter`）；每首各自归一化到
0..1、全静音保持全 0；缓存按 `size`+`mtimeMs` 失效；取不到就**静默降级**（空波形 + 稳定原因，
不是 500）；客户端必须丢弃**迟到**的结果；进度经 CSS 变量给遮罩（拖动不触发 React 重渲染）。

**性能：客户端也要缓存/预取，常驻 UI 有节点预算**。预取与功能开关**解耦**；预取**只填缓存、
不动 UI**；客户端缓存必须有界；常驻底栏柱子减半（全屏 120 根 / 底栏 60 根）；可量化收益要写进
门禁（切歌 3 次 4→2 次请求）。

## 不变量

| # | 不变量 | 违反症状 | 门禁 |
| --- | --- | --- | --- |
| I-01 | 声明面五副本逐字一致 | 端点在某个宿主形态**不可达** | `test-route-consistency` |
| I-02 | 媒体源是 token 直连的**绝对地址** | 进度条一拖就回 0 秒 | `test-mv-seek` |
| I-03 | 能力 token 进程级 + 按用途分签 | 音乐全不能播 / 交叉越权 | `test-token-lifetime`、`test-security` |
| I-04 | 栅栏豁免只到 Origin/Sec-Fetch，Host 必须回环 | 局域网可读库内任意文件 | `test-security` |
| I-05 | 每个副作用位置过 `authorize(action, scope)` | 越界读写 | `test-audit` |
| I-06 | teardown 后不得再启动（timer / 在飞 await / 子进程 / 全局键 / DOM） | 卸载后请求风暴、孤儿进程 | `test-poll-teardown`、`test-teardown-race`、`test-mv-teardown`、`test-teardown` |
| I-07 | 凭据不进日志 / 落盘 / 持久通道 | 同机可读库内文件 | `test-audit` 凭据扫描 |
| I-08 | 偏离 plan、降级信任边界必须显式报告 | 静默降级 | `test-audit` |
| I-09 | 失败不得被报告为成功 | 以为保存了其实没写 | **待建**（`A5-09`） |
| I-10 | `src/` 与 `lib/` 一致；`lib/` 不得手改 | 发出去的还是旧行为 | `check-build-fresh` |
| I-11 | 类型错误只许变少；允许清单只许加 | 类型质量倒退 | `typecheck-ratchet`、`check-strict` |
| I-12 | 不留死代码 | 维护成本与误读 | `noUnusedLocals` / `noUnusedParameters` |
| I-13 | 每个断言都必须**能变红** | 门禁形同虚设 | 人工对照 + §陷阱 |
| I-14 | 跨视图保留的状态只在 player store；视图定时器归资源所有者 | 切回音乐页看到列表页 / 卡在 closing | `test-view-persistence` |
| I-15 | 每次过渡都淡入淡出，时长取 fooyin 默认；无声音可淡时必须同步 | 电流声 / 起播时序后移 | `test-audio-fade`、`test-audio-graph` |
| I-16 | 音频必须有**常驻固定采样率**输出流；跨源先确认 CORS；建图后元素音量置中性 | 切歌电流声 / 静音 / 首播无声 | `test-audio-graph` |
| I-17 | ReplayGain 走独立节点；未测量不做增益；按峰值收窄；标签先收窄再夹范围 | 响度跳变 / 互相覆盖 / 削波 / NaN | `test-replaygain` |
| I-18 | 交叉淡化：同一常驻 AudioContext；电平每元素独立；teardown 停两个 | 切歌有缝 / 音量被压 / 卸载后仍出声 | `test-audio-graph`（D 段） |
| I-19 | 均衡器：0dB 即直通；自动前级；曲线夹 ±12dB（两处）；非法输入不动；缺 API 只跳过 EQ | 削波 / 脏数据刺耳 / 丢常驻流 | `test-audio-graph`（E 段） |
| I-20 | 波形：内存与曲长无关；包络忠实；缓存按 size+mtime 失效；取不到静默降级；丢弃迟到结果 | 长曲目吃内存 / 波形不更新 / 报错 / 画错歌 | `test-waveform` |
| I-21 | 客户端缓存/预取解耦、只填缓存、有界；默认值有断言；常驻 UI 有节点预算 | 优化被开关关掉 / 画错歌 / 默认无人守 | `test-waveform`、D0a/D0b |

## 已知陷阱

1. 静态断言先剥注释（注释里会出现被断言的名字 → 恒红/恒绿）。
2. 按行号判断，不要按字符偏移（`clientPortion` 剥掉了 CSS）。
3. 断言不要依赖字面缩进（tsc 重排后正则静默返回 0 个方法）。
4. **夹具保真度 = 判别力**（假元素缺 `currentSrc`/`seekable`、`[].every()` 恒真 ⇒ 空过）。
5. **负向对照必须重建产物**（门禁读 `lib/`；不 build 控制组是空的）。
6. 「0 命中」先校准搜索面（用已知为真的样本验证命令本身）。
7. 一次性标志 / 冷却窗口是同一类错误。
8. 「清 timer」≠「阻止再武装」。
9. 修 bug 会点亮下游从未执行过的代码。
10. 「只在出问题时记日志」不够——要在**行为发生的那一刻**记。
11. **「本地全绿」≠「已进仓库」**：每轮收口看 `git status --short`。
12. **禁止 `git checkout <路径>` 撤销临时改坏的文件**（会连未提交的真改动一起回滚）——用 `cp 备份`。
13. **GC 时机敏感的断言测的不是保留量**：改**测量**（排除自身噪声 + 取稳态最小值 + 缺能力时明说
    SKIP），不是放宽阈值。
14. **对照要能真的变红**：波形的「丢弃迟到结果」在两边同样慢时删掉守卫**照样全绿**——得让
    「先发慢、后发快」；均衡器的双处夹范围只删一处也照样绿——对照要删到断言真正依赖的那层。

## 明确接受的取舍（不要「顺手修好」）

`system-art`/`system-stream` 不在 `connection.fetch` 上；保留 `/dsh-music` 旧前缀；`lib/*.js` 提交
进仓库；`/library` payload 的 `mime` 为 `null`；不做随机播放/歌词页；封面只补缺失不覆盖已有；
`noImplicitAny` 暂关；客户端套件跑 jsdom（**没有**布局测量能力，相关结论一律标「未验证」）；
token 在进程生命周期内不过期。

## 审计与迭代协议

1. 一次只审一个维度：声明面 · lifecycle/释放面 · composition/协商面 · permission+storage · 门禁有效性。
2. **不得把 README / 注释的自我描述当事实**：引用前必须实测存在。
3. 取证只能报真读过并给出 `文件:行号` 的条目；静态推断要标注为推断。「0 命中」先用已知为真的样本校准。
4. 登记进 [docs/audit-ledger.md](docs/audit-ledger.md)（**只追加**；判定推翻要新写条目，不得覆盖）。
5. 复核：明确写出该条**是否被现有门禁拦住**——拦不住就是门禁盲点。
6. 通用形态才进本文件；一次性 bug 只进台账。
7. 可机械校验的违规必须补断言并在 `run-all.mjs` 注册；会让套件变红时**先登记待修并报告，不得放宽断言**
   （**恒绿测试比没测试更坏**）。新断言必须打在**生产真正使用的传输面**上。
8. 每轮在台账追加小节：维度、基线、结论。
9. 收口 = 提交 + 推送 + `git status --short` 为空 + CI 绿；「验证通过」与「已交付」是两个断言。
   上一轮的结论是待证事实，不是这一轮的前提。

## 文档分层

`README.md` 只放「怎么用」与一张表（≤220 行）；深度材料进 `docs/`：`docs/desktop.md`（Desktop 接缝）、
`docs/compatibility.md`（STORE 收录与信任边界）、`docs/gates.md`（逐条门禁断言与负向对照）、
`docs/rules-detail.md`（规则完整措辞）、`docs/defensive-audit.md`（对开源播放器的防御性对照与待办）、
`docs/audit-ledger.md`（逐轮台账）、`docs/images/`（截图）。
**不新增同义文档**；README 里不得出现未验证的数字或不存在的防线。

## 改本文件的硬约束

- **64 KiB 注入预算**：撞上后**尾部会被静默截断**（实测两次）。改完必须 `wc -c AGENTS.md`；
  接近上限就把细节移进 `docs/rules-detail.md`，这里只留结论 + 指针。
- 一条规则 = 一个失败类别；**一条一句**，理由压进括号或链接（对齐 DeepSeek Harness 的 AGENTS.md 写法）。
- 新增不变量必须同时加进 §不变量表并给出门禁名；没有门禁的标「待建」。推翻判定要新写条目。
