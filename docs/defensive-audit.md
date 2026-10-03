# 防御性审计：向开源播放器学「想不到的失败模式」

> 第 27 轮的产出。方法：读**高质量开源实现的源码**，把它们的防御性做法逐条对照本插件，
> 只登记**实测过**的差异；每条都给出证据、影响与落点。**不是**功能对比，也不抄代码
> （参考项目多为 GPL-3.0，本仓库 MIT：只借鉴做法与数字）。

## 1. 参考实现与它们的防御点

| 项目 | 语言/形态 | 与本插件最相关的做法 |
| --- | --- | --- |
| [feishin](https://github.com/jeffvli/feishin) | Electron + React + Web Audio | 按 `MediaError.code` **分派**：网络/源不可用 → 有界重试；解码失败 → 跳过本曲；其它 → 暂停。`crossOrigin: 'anonymous'` |
| [navidrome](https://github.com/navidrome/navidrome) | Go 服务端 | `core/stream/limiter.go`：给 **ffmpeg 子进程**做并发闸门（全局上限 + 每用户上限），超额**立即**返回 429 + `Retry-After`，**绝不排队**；`token.go`：流地址凭证 |
| [fooyin](https://github.com/fooyin/fooyin) | C++/Qt | 引擎默认淡入淡出时长、`nexttrackpreparer` + crossfade、terminal resampling（已用于 §2.18/§2.21） |
| [mutagen / Quod Libet](https://github.com/quodlibet/mutagen/issues/241) | Python 标签库 | **原子保存**的讨论：就地改写标签文件存在「写一半断电 = 文件损坏」的风险 |

## 2. 本轮已落地（4 项，都有门禁 + 对照）

| # | 失败模式 | 做法来源 | 实现 | 门禁 | 对照 |
| --- | --- | --- | --- | --- | --- |
| H1 | 用户快速连点/连切时**并发 spawn 波形 ffmpeg**，CPU 打满 | navidrome `TranscodeLimiter` | `WAVEFORM_MAX_CONCURRENT = 2`，超额**立即** `reason: 'busy'`（不排队） | `test-waveform` **B9** | 去掉闸门 → `ok=5 busy=0` **红** |
| H2 | 交叉淡化的**迟到交接**在下一段过渡开始后才跑，可能换错元素 | 本仓库 §2.10「清 timer ≠ 阻止再武装」 | 新增 `settlePending` + `commitPendingCrossfade()`：**任何新切歌先即时结算在飞交接** | `test-audio-graph` **D9a/D9b** | 去掉结算 → D9a **红** |
| H3 | 源根本不可用（`MEDIA_ERR_SRC_NOT_SUPPORTED`）仍烧 3 次徒劳尝试（1 次重试 + 2 次跳区，各 400ms） | feishin 的 `MediaError` 分派 | `hopelessSource` 短路：直接进「放弃 + 自动下一首」 | `test-audio-graph` **D10** | 短路失效 → **红** |
| H4 | 系统单方面挂起 `AudioContext`（设备切换/休眠/iOS 中断）→「界面在放、耳机没声」且无从判断 | 无（本仓库独有症状） | `ctx.onstatechange`：**该出声却没在跑**时 resume + 只含状态的诊断 | `test-audio-graph` **D11** | 处理器变 no-op → **红** |

## 3. 核查后确认**已经做了**的（避免重复造轮子）

| 做法 | 来源 | 我们的现状（实测） |
| --- | --- | --- |
| 媒体错误恢复链 | feishin 只做「重试 → 跳过本曲」 | **更强**：`error` 监听里先自愈 token 基址 → 原位置重试 → 跳过坏区（1.5s/6s）→ 放弃 + 循环下自动下一首（每行一次上限） |
| OS 媒体面板 | feishin 有 MediaSession | 已有 `setPositionState`（带参数校验）+ play/pause/prev/next/**seekto** 处理器 |
| 跨源媒体 | feishin `crossOrigin: 'anonymous'` | 已有（且只对窄名单回显 ACAO，不用 `*`） |
| 流地址凭证 | navidrome `token.go`（按请求签名） | 自建**进程级** token（按用途分签）；不过期/不轮换是**明确接受**项 |
| 缓存失效 | —— | RG 测量与波形缓存都按 `size`+`mtimeMs` 失效（各自有门禁） |

## 4. 待办（**已取证但本轮未改**，按风险排序）

1. **标签写入与改名是不可逆操作**（Risk: 高）。我们确实会写标签与重命名用户文件；参考项目
   （mutagen/Quod Libet）明确讨论「就地改写 → 写坏就没了」。**待核实**：写入是否走
   临时文件 + 原子替换、失败是否回滚、是否有「写前备份」。
   → 证据：`src/host.ts` 有 13 处 `rename`、3 处 `existsSync`；具体在 `applyTags`/rename 流程里
   是否具备原子性与回滚尚未逐行核实（本轮未读到那一段，**不得当作已确认的缺陷**）。
2. **大小写不敏感文件系统上的重命名碰撞**（macOS APFS/HFS+）。若把 `A.mp3` 改成 `a.mp3`，
   `existsSync` 会认为目标已存在 —— 需要实测我们的改名分支在这种情况下是「拒绝」还是「覆盖」。
3. **Unicode 规范化（macOS 存 NFD、输入常是 NFC）**。实测 `normalize(` 在 `src/host.ts` 与
   `src/client.ts` **各 1 处** ⇒ 部分覆盖，但覆盖范围（扫描匹配 / 改名 / 去重）未逐处核实。
4. **磁盘满 / 只读文件系统**下的写入失败目前与 `A5-09` 同族（失败可能被报告成成功）——已在
   不变量 I-09 标为**待建门禁**。
5. **客户端 seek 风暴**：连拖会产生多条并发 Range 请求；宿主侧有 abort 释放 fd 的门禁，
   但**没有**对并发流请求设上限（H1 只覆盖了波形 ffmpeg）。
6. **`stalled` / `waiting` 的「缓冲中」反馈**：网络卡顿时 UI 无提示（本地文件少见，优先级低）。

**明确不做**：页面隐藏时停 rAF —— Chromium 对隐藏页的 `requestAnimationFrame` **本来就节流**，
且该循环属于进度条组件（随视图卸载即停），收益不足以加复杂度。

## 5. 参考链接

- [feishin](https://github.com/jeffvli/feishin)（`src/renderer/features/player/audio-player/engine/web-player-engine.tsx`）
- [navidrome](https://github.com/navidrome/navidrome)（`core/stream/limiter.go`、`core/stream/token.go`）
- [fooyin](https://github.com/fooyin/fooyin)（`include/core/engine/fadingdefs.h`）
- [mutagen 原子保存讨论](https://github.com/quodlibet/mutagen/issues/241)
