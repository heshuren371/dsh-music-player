# 规则细则（`AGENTS.md` 的外移正文）

> 这个文件是 `AGENTS.md` §2.10–§2.12、§2.16–§2.17 的**完整正文**：`AGENTS.md` 有 64 KiB 注入预算，
> 撞上后**尾部会被静默截断**（实测两次），所以把「读一次就懂、平时不需要背」的论证性内容移到这里，
> §2 只留**结论 + 指针**。**规则没有减少**：编号、判定与证据都在这份文件里原样保留；
> 判定被推翻时要**新写条目**（§6.2），不得覆盖。

### 2.10 客户端 activation 归属与「teardown 后不得再启动」（第 3 轮沉淀）

- **一个 activation instance 的资源不得被下一个复用**（`lifecycle.zh.md:125`、`:127`）：**禁止**用
  `window.*` 这类全局槽位把上一代的 player / timer / handler 交给下一代。确有必要时必须**显式声明
  为跨 activation 共享资源**，且每代的 disposer 只作用于**自己那一代**。→ `window.__dshMusicPlayer`
  是未声明的隐式转移（`A3-03`）。
- **disposer 必须作用于「自己的」实例**：对共享对象调 `dispose()`/`halt()` 会停掉新实例仍在使用的东西。
- **`await` 挂起后恢复的路径必须检查 `disposed`**：只把引用置 `null` **不够** —— 挂起的异步分支会
  把它重新赋值（`A3-02`：`ensureHost` 两个挂起点、客户端轮询回调）。
- **「清 timer」与「阻止再武装」是两件事**：teardown 里 `clearTimeout` 只能清掉**当前**那个句柄；若回调在飞期间句柄已被置 null，`clearTimeout` 落空，回调的 `catch` 会再武装。守卫若依赖 `set()` 未复位的状态（如 `scanning`），teardown 必须**显式复位该状态**。→ `A3-01`（历史 bug 的同族复发形态）。
- **自建 DOM 与全局键必须释放**：挂在 `document.body` 的节点、`window.*` 的键都要 `remove()` /
  `delete`（`lifecycle.zh.md:107`；`A3-04` 是 `.dshm-mvPark` + `<audio>`）。
- **不得读取未在 manifest 声明的 context API**（`lifecycle.zh.md:82`）：`ctx.get('X')` / `ctx.X` / `ctx.inject(['X'])` 里的**每个服务名**都必须能在 `requires.contracts` 或 `permissions` 里找到对应声明。→ 目前 `directoryPicker`（`lib/host.js:1886`）、`ctx.locale`（`lib/client.js:3186`）、`connection.fetch`（`lib/index.js:240`）**三者都没有声明**（`A3-05`）。


### 2.11 契约坐标必须真实可解析（第 4 轮沉淀）

**这是本轮最重要的一条**：`requires.contracts` 里的每个 `apiVersion + kind` 都必须是**真实存在、可被 definition 解析**的坐标，不能凭印象编。

- **禁止发明坐标，写进 manifest 前必须实测**（「0 命中」先用已知为真的样本校准搜索面，§6.1）。
  实测：候选坐标在 DSH 运行时全部 0 命中 ⇒ 本插件**不消费**任何 Community 契约，
  `requires.contracts` 为空是**诚实状态**（`A4-03`）。
- **`fallback` 不能把不存在的坐标洗成合规声明**（`D-05`）。
- **声明无 definition 的扩展 ≠ 声明能力**（`manifest.zh.md:62`）：**不声明**优于假声明（`A4-02`）。
- **extension id 必须有运行时对应**；**`prefix` 必须等于 `webServer.register` 的 path**（`A4-05`）；
  **`requires.contracts` 至少一条 `required`**，否则 preflight 永不阻塞（`A4-03`）。


### 2.12 自建 bearer token 三律（第 5 轮沉淀）

本插件不走 DSH 的 permission grant，而是**自建路径凭证**（`?t=<randomUUID>`）。自建 bearer token 必须满足三条，缺一即等于把读能力挂在一个不该挂的入口上：

1. **按用途分签**：一个 token **不得**同时授权两类权限。第 9 轮已拆成 `systemArtToken` /
   `systemStreamToken` 两个独立随机值，交叉使用 403（`A5-02` 已修）。**仍待修**：token 不过期、
   无轮换、不按 session 区分，唯一撤销边界仍是 `createHost()` 闭包销毁。
2. **基址钉回环字面量，不得回显请求 Host**：`loopbackAuthority(req)` 只取 Host 的**端口**，主机名
   固定 `127.0.0.1`（`A5-03`）。
3. **被豁免栅栏的端点**（`system-*`）**不得承担读能力**，凭证**不得进入任何持久通道**；豁免只到
   Origin / Sec-Fetch 为止，Host 非回环一律 403（`A5-03`）。

> `A5-03` 的教训：token 通道**既不走平台鉴权、也不走插件栅栏**，唯一防线是 token 保密性。
> 所以 token **不得**进入任何世界可读的位置（`A2-01` 就是把它写进了 `/tmp`）。


### 2.16 平台栅栏在**路由之前**拒答 —— 回落判据不能只认 404（第 13 轮沉淀）

平台 `/api` 的 `admit()` 在**路由之前**判 Host/Origin 与浏览器会话 ⇒ 实测答的是 **401/403**，
不是 404。**「宿主没有这个端点」（404）与「这道栅栏不让这个请求过」（401/403）是两件事**。

- **回落判据必须覆盖全部「这道传输送不到」的状态码**（401 / 403 / 404），并配**正向识别**
  （真的解析出目标数据才算采纳）+ **显式报告降级**（§2.8）。
- **例外只给「其存在意义就是绕开这道栅栏」的端点**（本仓库只有 `/session`）—— 把一次普通的
  403 洗成信任边界降级是违规。
- **降级成不可 seek 的源比等待更糟**：拿不到基址必须**重取**，不能「超时就算了」（丢 Range = 功能做废）。
- **按可观测症状兜底自愈**：判据「源不是 token 直连 + 时长已知 + `seekable=[0,0]`」，**有界**且
  **成功才停** —— **禁止**一次失败就置永久标志。
- **诊断日志无歧义且不带凭据**（按 §2.9 剥 `t=`）；**夹具保真度也是判别力**（§9 陷阱 4）。

> **通用形态**：修**症状**时，修法必须按**当前这条源是什么类型**推导，不能按期望的播放模式
> （`track.kind`）猜；且**只在出问题时记日志不够**，要在**行为发生的那一刻**记。


### 2.17 视图局部状态活不过 `conversation.view` 的卸载（第 16 轮沉淀）

DSH 的 `conversation.view` **只在被选中时挂载**（切到「对话」即卸载，切回来是一次全新挂载）。
这条接缝有三个必须一起记住的后果：

- **要跨视图切换保留的 UI 状态，禁止放视图局部 `useState`**（全屏三态 / MV 放大 / 封面预览
  修复前都是局部 state，切走再回来就回到列表页）⇒ 放进 **player 单例 store**。
- **视图驱动的定时器必须归资源所有者**（收起动画的 200ms 挂在视图里会被卸载 cleanup 掉，
  `phase` 永久停在 `closing`）⇒ 移进 `createPlayer()` 并在 `halt()` 里清句柄 + 复位状态（§2.10）。
- **重挂载后要把外部资源搬回来**（MV 的 `<video>` 停在 body 停靠位），断言覆盖「同一个元素、
  不是新建第二个」。
- **UI 过渡的定时器禁止用 `disposed` 早退**：`disposed` 置位后**永不复位**（player 是 window 级
  单例，A3-03）⇒ 早退会把 `phase` 钉死在 `closing`（`closePlayer` 拒绝从 closing 出发 = 死锁）。
  同理**禁止**给 `openPlayer` 加 `disposed` 守卫（会让插件重载后的全屏播放器再也打不开）。

> 门禁 `test-view-persistence.mjs` 覆盖上述全部 + 「teardown 之后 open→close 仍收口」与
> 「真实第二次 activation 能开能关」两条。夹具必须用**真实 `<video>` DOM 节点**（假元素没有
> `nodeType`，搬运路径整体跳过 ⇒ 恒绿）。细节与对照见台账 §5.22。

