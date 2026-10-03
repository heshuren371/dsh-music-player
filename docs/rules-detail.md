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

---

## 附录：`AGENTS.md` §2 全量正文（第 25 轮整体外移）

> 第 25 轮把 `AGENTS.md` 的规则改写成「一条一句」的摘要（对齐 DeepSeek Harness 的
> `AGENTS.md` 写法），**完整措辞、编号与判定原样保留在下面**。摘要与本节冲突时以本节为准。

## 2. 不可协商的规则

### 2.1 Manifest（`manifest.zh.md`）

- 包根目录**至多一个** `dsh-plugin.json`；不得把 `package.json` 字段或别的文件名当等价 Manifest（L25）。
- Manifest **必须是静态 JSON**。不得根据插件提供的 `$schema` URL 联网下载并执行 schema / definition / validator（L27、L163）。
- `facets.host.entry` 形成 activation；`facets.host.apiVersion` **只约束 activation API，不是领域协议版本**（L108）。
- 未知 Manifest 版本 → `manifest-version-unsupported`，**不得**回退旧 schema 或忽略新版本的 required 字段（L33）。
- **扩展字段不得暗含 required 行为**（L64）。凡是影响兼容性、激活、权限或运行时调用的东西，必须表达为 protocol requirement/support、activation、permission、subscription，或带 definition 的 extension。
- `optional: true` 的契约应写 `fallback`，说明宿主没有该契约时的降级行为（L98–101；TUI profile 用 `invalid-plugin-optional-no-fallback.json` 卡这一条）。
- `compat`、`overrides` 只进 admission / provenance，**不产生 live support**（L113）。
- 通过 schema 只证明文件结构有效，**不等于**能激活（L116）。Artifact digest 证明字节内容，**不证明发布者身份**（L165）。

### 2.2 Lifecycle —— 激活与清理（`lifecycle.zh.md`）

- `activate` 里注册的一切（service、协议 support、event handler、timer、后台任务、UI contribution）**必须绑定当前 activation instance 的 cleanup scope**（L29）。SDK 观察不到的、自己创建的资源由 `deactivate` 负责（L107）。
- Scope 关闭顺序：**先 abort signal，再按注册逆序执行 disposer**；每个 disposer **至多调用一次**；某项清理失败**不能阻止**其余 disposer（L105）。
- 停止后要**验证已发布的 support 与 owner records 都已移除**（L118）。
- 超过 deadline **必须留下 timeout 诊断，不能报告为正常停止**（L121）。
- Reload **创建新 instance、不复用旧 activation scope**；**不允许把旧 handler 隐式转移给新 instance**（L125）。
- Lifecycle record / 诊断**不应持久化 activation context、凭据或未处理的异常对象**（L133）。
- Activation context 不得暴露未在 manifest 声明、未在 plan 接纳、未获 grant 的产品 API（L82）。
- Observer 不能通过监听事件改变状态机（L139）。
- **不得依赖 module 卸载来完成清理**：JavaScript module 通常无法真正卸载，cleanup scope 以 owner 为单位撤销注册与任务（L165、L22）。→ 本仓库的宿主热重载走「mtime + 带查询串的动态 import」，**旧实例的 handler / timer 必须自己撤销**，不能指望旧 module 被回收。
- 纯声明 facet 不执行 module，也不得为它创建可执行 activation instance（L58、L5）。
- **释放面清单必须逐类覆盖**，不能只处理其中一类：SDK 注册项、timer、**子进程**、**worker**、**module 级可变状态（Map / Set / 计数器）**。任何一项漏掉，在「卸载」或「热重载」下都会变成孤儿。→ 子进程必须留 `kill` 路径；module 级容器必须留 `clear`/`delete` 路径**并计入容量上限**。
- **module 级状态在热重载下会整份复制**：本仓库每次重载产生一个新的 module 实例，旧的被 ESM 注册表永久持有。因此 module 级容器**既是每次重载的泄漏源，又是无界增长的载体**，必须显式清理 + 设上限。

> 本仓库有宿主热重载（`lib/index.js` 按 mtime 重载 `host.js`）与自动续播定时器，**是上面第 5、1、2 条的高危区**——历史上出过「卸载后定时器仍跑」的 bug。

### 2.3 Composition —— 契约协商（`composition.zh.md`）

- **Facet 名称与发现顺序不构成选择条件**；不得按 `web` / `server` / `runtime` 等名称推断运行位置（L65）。
- 未被选中的 facet **不把** requirements / extensions / permission requests 带入 plan（L71）。
- **Preflight 成功不是 agreement**；运行时不符必须失败、回滚或重组（L80）。
- 未知 required → 阻止计划；未知 optional → 报告为未满足；**未知 potential support 不作为候选实现**（L82）。
- 同一坐标存在内容不一致的 definitions → 输入无效，**不得用注册/发现顺序解决冲突**（L84）。
- **没有通用「最后注册者覆盖」规则**（L118）。Plan 排序由标识与协议规则确定，**不得把发现顺序当隐式语义**（L135）。
- 每次实际注册都要记录 activation instance owner 且可清理（L141）。
- 实际激活偏离 plan → **必须报告 activation failure**，触发重组/降级/回滚；**不能悄悄把静态声明当 live implementation**（L143）。
- component 的 priority / selector / relationship **不得自行扩大权限**；agreement ≠ 用户授权（L147、L149）。
- 协议 requirement **优先于** component dependency；只有确实依赖实现包而非协议时才用 `depends`/`recommends`/`breaks`/`conflicts`（L106、L99–104）。

### 2.4 Permission（`permission.zh.md`）

- 静态请求是所属 facet 的**上限**。**缩小 scope 不需要改 manifest；扩大 scope 必须新增声明并走 policy 决策**（L55）。→ 改代码时一旦多碰一类资源，同步改 `dsh-plugin.json` 的 `permissions`。
- 插件自带的默认值**只能缩小请求，不能覆盖产品 policy**（L68）。
- 不能通过字符串查询未授予的 Host service（L32）。
- 每项受保护操作都要**在产生副作用的位置**检查授权。validator、composition report、UI 上显示「已允许」**都不能替代运行时检查**（L86）。
- 序列化的 grant record **不是可重放的 bearer token**；**不能用 grant id 构造权限**（L82）。
- Activation instance 停止即撤销其全部 grant（L99）。
- 审计记录前**移除凭据、文件内容、工具输入**（L111）。
- **不得用字符串前缀等未经协议规定的方法判断路径、域名或 resource scope**（L119）。

### 2.5 Storage（`storage.zh.md`）

- 需要 `LocalStorage` 的 consumer **通过 protocol requirement 声明**（`storage.dsh/v1alpha1` / `LocalStorage`）（L20）。多个候选 provider 且组合层未确定选择时，协商**必须失败**（L22）。
- 读需要 `storage.local.read`，写与删除需要 `storage.local.write`（L75）。
- value 必须是 JSON value；不得依赖对象 identity / prototype / key 顺序（L34–36）。
- 同 Component 命名空间内、同一 key 的操作必须串行化；本协议**不提供**多 key transaction、CAS、enumeration、watch，实现不得把这些当兼容前提（L69、L71）。
- `deactivate` **不删除** Component 数据；uninstall 的保留规则必须声明；purge 删整个命名空间（L81）。
- cleanup / purge **必须可重复执行**；**失败的 cleanup 不得报告为已完成**（L83）。
- **禁止把 value、凭据或 secret 写入普通日志**（L101）。
- 协议声明**不是沙箱保证**（L99）。

### 2.6 若新增 `docs/proposals/`（dsh-std `AGENTS.md`）

- 写成 RFC 体例的协议规范：scope、术语、数据模型、必需行为、协商规则、生命周期、错误、安全考虑、兼容性规则。规范级用语统一用 MUST / MUST NOT / SHOULD / SHOULD NOT / MAY（中文用「必须/禁止/应/不应/可以」）。
- **禁止**写实现路线图、任务清单、进度报告、仓库重构计划、自我批评、回顾叙事，或「我接下来要写什么」。
- **禁止**在协议提案里指定某个项目为参考实现。**禁止**把未完成的实现工作写成协议要求。
- **禁止**把实现便利、当前仓库布局、或某个产品的限制变成规范要求。
- 替换重复材料时保留稳定文档路径，改成简洁的规范性引用。

### 2.7 声明面一致性（第 1 轮沉淀）

本插件的能力面有**四个必须逐字一致的副本**，任何一处漏改都是静默失效：

```
lib/host.js 的分派表  ←→  lib/index.js 的 FETCH_ROUTES  ←→  dsh-plugin.json 的 endpoints
                              ↑
                    scripts/test-desktop-routes.mjs 的 expected（必须从分派表推导，不得手工抄）
```

- **门禁必须三向集合相等**，不是单向包含。写成 `expected.every(p => routes.has(p))` 只查一个方向，**结构上发现不了漂移**。
- `connection.fetch.register` 是**精确路径匹配**，没有前缀/通配语义（`dsh 0.1.7-rc.2` 的 `packages/client/connection/lib/index.js:625-634`）。新增端点**必须**同时加进 `FETCH_ROUTES`；只在 `host.js` 加一条 `pathname ===` 是**不可达**的。
- 只有 `webServer` 存在时旧 `/dsh-music` 前缀路由才兜底。因此「只在 `host.js` 实现」的端点，在无 `webServer` 的宿主形态（0.1.6 desktop-host）下必然 404。
- `dsh-plugin.json` 的 `endpoints` 是**对外声明**，不是注释：`manifest.zh.md:64` 要求影响运行时调用的能力必须表达为声明。少声明同样是缺陷。

### 2.8 错误面与降级（第 1 轮沉淀）

- **不得用业务错误码充当基础设施信号**。`404` 在本插件是正常语义（无内嵌封面 `lib/host.js:1696`/`:1715`、MV 缓存未命中 `:2021`/`:2073`、文件不存在 `:1472`/`:1474`）。任何「探测宿主是不是新入口」的逻辑**不能以 404 为唯一判据**，否则会被一次正常业务失败永久带偏。
- **探测/回落必须可重入**：一次性标志位若在探测**之前**置位（`lib/client.js:667`），失败一次就永久失去重试机会。
- **不得静默降级信任边界**：`composition.zh.md:143` 要求偏离 plan 必须报告。从 `/api`（连接层 Host/Origin 栅栏 + 浏览器会话）切到 `/dsh-music` 旧前缀（插件自建栅栏）是**信任模型降级**，必须显式记录，不能顺带发生。
- **错误响应必须脱敏**：`storage.zh.md:95`「不能暴露路径等」、`permission.zh.md:111`「记录前移除文件内容、路径」。把 `error.message` 原样返回（`lib/index.js:132`、`:153`）会把本地绝对路径与文件名单（`'文件不存在：' + track.name`，`lib/host.js:1472`）送到客户端。

### 2.9 诊断与日志（第 2 轮沉淀）

- **禁止把凭据写进任何日志**（`storage.zh.md:101`「禁止把 value、凭据或 secret 写入普通日志」、`permission.zh.md:111`、`lifecycle.zh.md:133`）。**`req.url` 的 query 里就带能力 token** —— 把 `req.url` / `headers` / `cookie` 整体落盘等于泄漏凭证，哪怕文件在 `/tmp`、哪怕只在自己机器上。落盘前必须剥离 `t=` / `token` / `authorization` / `cookie` 等字段。
- **诊断代码不得进默认分支**：临时探针必须有开关、有 TTL、有清理责任人；**不得提交进 HEAD**（见 `A2-01`：一个 `TEMP DIAGNOSTIC` 探针已提交，把 token 写进 `/tmp`）。
- **写盘路径必须落在已声明的 permission scope 内**：`permission.zh.md:55` 静态请求是上限。`dsh-plugin.json` 的 `fs.write` scope 是「当前音乐目录内的音频文件」，往 `/tmp` 写日志**不在**该 scope 内 → 要么改路径，要么补声明。
- **禁止在请求关键路径上同步落盘**：`await fs.appendFile(...)` 放在路由分发**之前**，会让每个请求（含每次 Range 流媒体请求）都被一次磁盘 I/O 阻塞，与 README 的性能叙事直接矛盾。

### 2.10 客户端 activation 归属与「teardown 后不得再启动」（第 3 轮沉淀）

- **一个 activation instance 的资源不得被下一个复用**：**禁止**用 `window.*` 把上一代的
  player / timer / handler 交给下一代（`A3-03`）；disposer 只能作用于**自己那一代**。
- **`await` 挂起后恢复的路径必须检查 `disposed`**（只置 `null` 不够，挂起分支会重新赋值，`A3-02`）。
- **「清 timer」≠「阻止再武装」**：teardown 必须**显式复位**守卫依赖的状态（如 `scanning`，`A3-01`）。
- **自建 DOM 与全局键必须释放**（`remove()` / `delete`，`A3-04`）。
- **不得读取未在 manifest 声明的 context API**（`A3-05`，现状三者未声明）。

→ 细则与证据见 [`docs/rules-detail.md`](docs/rules-detail.md#210)。

### 2.11 契约坐标必须真实可解析（第 4 轮沉淀）

- **禁止发明坐标，写进 manifest 前必须实测**（「0 命中」先用已知为真的样本校准搜索面，§6.1）。
  实测：候选坐标在 DSH 运行时全部 0 命中 ⇒ 本插件**不消费**任何 Community 契约，
  `requires.contracts` 为空是**诚实状态**（`A4-03`）。
- **`fallback` 不能把不存在的坐标洗成合规声明**（`D-05`）；**声明无 definition 的扩展 ≠ 声明能力**
  （`manifest.zh.md:62`，不声明优于假声明，`A4-02`）。
- **extension id 必须有运行时对应**；**`prefix` 必须等于 `webServer.register` 的 path**（`A4-05`）；
  **`requires.contracts` 至少一条 `required`**，否则 preflight 永不阻塞（`A4-03`）。

→ 细则见 [`docs/rules-detail.md`](docs/rules-detail.md#211)。

### 2.12 自建 bearer token 三律（第 5 轮沉淀）

自建路径凭证（`?t=<randomUUID>`）必须：① **按用途分签**（`systemArtToken` / `systemStreamToken`
不得互换）；② **基址钉回环字面量**，不得回显请求 Host（`loopbackAuthority`，只取端口）；
③ **被豁免栅栏的端点**（`system-*`）不得承担读能力，凭证不得进入任何持久通道，Host 非回环一律 403。
**仍待修**：token 不过期、无轮换、不按 session 区分（唯一撤销边界是 `createHost()` 闭包销毁）。

> token 通道**既不走平台鉴权、也不走插件栅栏**，唯一防线是保密性 ⇒ 不得进入任何世界可读位置。

→ 细则（含 `A5-02`/`A5-03` 的实测）见 [`docs/rules-detail.md`](docs/rules-detail.md#212)。

### 2.13 错误不得被报告为成功（第 5 轮沉淀）

`storage.zh.md:83`「失败的 cleanup 不得报告为已完成」是**通用形态**，适用所有持久化/副作用路径：

- **吞掉写失败后仍返回成功是违规**。现状 `A5-09`：`saveState` 全量吞错后 `/dir` 仍返回 `200`。
- **持久化层必须有稳定错误码**（`storage.zh.md:87-93` 的五个码目前**一个都没有**），不能只靠
  「有没有抛异常」表达。

### 2.14 能力 token 必须与 activation 生命周期对齐（第 10 轮沉淀）

客户端会把 `/session` 下发的 token 基址**缓存整个页面生命周期**，而宿主**每次热重载都会 `createHost()`**。因此：

- **token 不得随 activation instance 轮换**。它要钉在**进程**上（`Symbol.for` + `globalThis`），否则一次「保存文件」就会让页面上所有取图/取媒体 URL 变成废纸。
- **消费者必须能自愈**：缓存要带 TTL，并在**失败时**作废重取；否则症状会停在「刷新前一直坏」。
- **判断症状归属的一条经验**：`/api/mv` 返回的是**相对地址**（走平台会话、不经 token），而**音频永远走 token 直连** —— 所以「**音乐不能播、MV 能播**」几乎总是 token 通道的问题，不是流本身的问题。排查时先直接 `curl` 那条 token URL 验证 200/206。

> 第 10 轮线上故障即此条被违反：token 曾是 `createHost()` 里的 `randomUUID()`。

### 2.15 TypeScript：真源、产物与类型棘轮（第 11 轮沉淀）

**真源与产物**

- **唯一真源是 `src/*.ts`**。`lib/*.js` 是 `tsc` 产物 —— **禁止直接改 `lib/`**：下次构建会覆盖它，而门禁 `scripts/check-build-fresh.mjs` 会把「手改了产物」判红。
- **产物也提交进仓库**。`dsh plugin add github:` 只克隆 + 装依赖、**不跑构建**，所以 `lib/` 必须在仓库里。这也是本仓库显式不声明 `prepare` 等生命周期脚本的原因（见 `docs/compatibility.md §5`）。
- 代价是「改了 src 忘了 build」会发旧行为出去 ⇒ 由新鲜度门禁兜住（编译到临时目录，逐字节比对）。
- 改完跑 `pnpm run build`；开发时挂 `pnpm run dev`（= `tsc --watch`），保存即重编，`lib/host.js` 的 mtime 一变热重载就生效。

**类型档位是棘轮**：`strictNullChecks` / `noImplicitThis` / `strictBindCallApply` /
`useUnknownInCatchVariables` / `noFallthroughCasesInSwitch` / `alwaysStrict` **全开**
（零或极低代价；`strictNullChecks` 正是能防住本仓库两个真实线上故障的那一项）；
`noImplicitAny` **暂关**（全开仍多 343 处），改由**逐文件允许清单**单向收严。

- 类型棘轮基线在 `scripts/typecheck-baseline.json`，**已降到 0 并锁死**：新增类型错误直接变红。
  **禁止为了让棘轮变绿而放宽档位或上调基线**（同 §6.2）。
- 逐文件清单：`tsconfig.strict.json` 的 `include` 即允许清单（当前 `src/http-bridge.ts`、
  `src/tagwriter.ts`），由 `check-strict.mjs` 守着（已接进 `npm test` 与 CI）。**清理干净一个就加
  一个，严格度单向增长**；**禁止删名单项**，空名单会被门禁自己拒绝（空名单 = 恒绿）。

**静态断言的四个坑**（第 12 轮起反复踩，**每条都付过代价**）：① 先剥注释（注释里会出现被断言的
名字 → 恒红/恒绿）；② 按行号而非字符偏移（`clientPortion` 剥掉了 CSS，行号与源文件不一致）；
③ 别依赖字面缩进（`tsc` 把 8 空格重排成 16 后正则**静默返回 0 个方法** → 本该报警反而变绿）；
④ 按**角色**而非创建顺序选节点（第 22 轮：均衡器插进链后，RG 套件按索引取的「RG 节点」变成 EQ
前级，B3–B12 集体变红）。**检验方法本身也需要被检验**（§6.1 第 3 条）。

**`client.ts` 必须保持零 import**：客户端 bundle 由宿主在浏览器里 `eval`（`window.__ModuleLoader__`），
**它的 import 无法解析** —— 类型只能就地声明在 `client.ts` 内；宿主侧的共享类型同理不要新建模块。

### 2.16 平台栅栏在**路由之前**拒答 —— 回落判据不能只认 404（第 13 轮沉淀）

平台 `/api` 的 `admit()` 在**路由之前**判 Host/Origin 与浏览器会话 ⇒ 实测答的是 **401/403**，
不是 404。「宿主没有这个端点」与「这道栅栏不让这个请求过」是**两件事**。

- **回落判据必须覆盖全部「这道传输送不到」的状态码**（401/403/404）+ **正向识别** + **显式报告降级**。
- **例外只给 `/session`**（它的存在意义就是绕开这道栅栏）；其余端点不得享受（403 洗成降级是违规）。
- **降级成不可 seek 的源比等待更糟**：拿不到基址必须**重取**。
- **按可观测症状兜底自愈**必须有界、成功才停，**禁止**一次失败就置永久标志。
- **诊断日志无歧义且不带凭据**；**夹具保真度也是判别力**（§9 陷阱 4）。

→ 细则见 [`docs/rules-detail.md`](docs/rules-detail.md#216)。

### 2.17 视图局部状态活不过 `conversation.view` 的卸载（第 16 轮沉淀）

`conversation.view` **只在被选中时挂载** ⇒ 切走再回来是一次全新挂载。因此：

- **要跨视图保留的 UI 状态禁止放视图局部 `useState`**（放进 player 单例 store）。
- **视图驱动的定时器归资源所有者**（否则 `phase` 永久停在 `closing`）。
- **重挂载后把外部资源搬回来**（MV 的 `<video>`），断言覆盖「同一个元素、不是新建第二个」。
- **UI 过渡定时器禁止用 `disposed` 早退**（`disposed` 永不复位 ⇒ 死锁）；**禁止**给 `openPlayer`
  加 `disposed` 守卫（会让插件重载后打不开全屏）。

→ 门禁与细节（含必须用真实 `<video>` 夹具）见 [`docs/rules-detail.md`](docs/rules-detail.md#217)。

### 2.18 过渡必须淡入淡出，且时长要够长（第 18 轮起；第 20 轮按 fooyin 校准）

**fooyin**（开源本地音乐播放器）的引擎默认值是权威参考（`include/core/engine/fadingdefs.h`）：
manualChange `{in=300,out=300}` · autoChange `{in=700,out=700}` · **seek `{in=120,out=120}`** ·
pause `{in=120,out=120}` · stop `{in=120,out=300}`。**本仓库采用同一组数值**，不自行调小。

- **常驻输出流与过渡淡入淡出不是二选一，两个都要**（fooyin 两者都做：输出会话常驻 + terminal
  resampling，**并且**每次过渡都淡入淡出，含 seek；本仓库第 18/19 轮各只做了一半）。
- **时长决定遮蔽力**：70ms 与 300ms 完全是两种效果。**禁止**为了「手感更脆」把过渡调到
  200ms 以下 —— 门禁 H1/H2 会红。
- **拖动进度也要淡**（fooyin 120ms），但**只在常驻音频图接管增益时**做：图未启用时用元素音量
  延迟 seek 会让拖动发粘且没有采样级保证，那条路径保持**同步** seek。
- **要消失先淡出，起播后淡入。** `state.volume` 始终是**用户设定值**，渐变只改**瞬时值**。
- **渐变必须可取消，取消时要结算 promise**（只清定时器不 settle 会让 `await` 它的调用方
  **永久挂住**，与 §2.10 同族）。快速连点/连拖时**最后一次赢**。
- **「没有声音要淡出」的路径必须保持同步**，判据是「**确定正在出声**」：
  `paused === false && volume > 0.001`。**禁止**写成 `paused || volume <= 0.001` —— 属性缺失时
  两个分支都是 false，会把「暂停中」误判成「正在播」而走异步路径，起播时序整体后移。
- **用户拖动音量优先于任何在飞渐变**；**卸载路径不等渐变**（§2.10；stop 的 300ms 淡出在这里
  刻意不等待）。

### 2.19 「电流声」的真因是**设备被反复重建**，必须常驻同一条输出流（第 19 轮沉淀）

第 18 轮的判断被实测**推翻**（音量淡入淡出做完，电流声依旧）—— 真因在**增益级之外**。

- **机制**：Chromium 为**每一条媒体源**单独建一条音频输出流；换 `src` = 销毁旧流 + 按新文件
  采样率/位深建新流 ⇒ macOS 必须重协商设备格式 = **那一声电流声**（本机曲库 44.1k/48k/96k 与
  16/24bit **混排**，几乎每次切歌都触发）。
- **修法**：一个**常驻 `AudioContext`**（`createMediaElementSource` + `GainNode`）只有一条流、
  一个固定采样率，所有媒体重采样进去，设备格式不再变。
- **跨源是前提**：桌面版页面 origin 是 `dsh-app://app`、媒体在 `127.0.0.1` ⇒ Web Audio **必须有
  CORS**，否则输出**静音**。宿主只对**窄名单**回显 ACAO（不用 `*`，§2.12），并对媒体端点应答
  `OPTIONS` 预检（`Range` 不是 CORS 安全列表头）。
- **降级不许变成故障**：建图失败 → **永久退回元素音量**；跨源未确认 CORS → **先直连、后台探一次**；
  兜底开关 `?musicGraph=0` / `window.__dshMusicNoGraph`。
- **建图后必须把元素音量置中性**（否则「元素 0 × 增益」= **第一次起播静音**，比电流声更严重）。
- **音频图 `halt()` 只 suspend 不 close** —— close 之后媒体元素再也接不回音频图。
- **`AudioContext.sampleRate` 创建时即固定** ⇒ ctx 必须在**第一次播放时**才建，并把
  `sampleRate`/`state` 打进诊断（只记数字与状态，绝不记 URL/token；门禁 B13）。
- **`location` 一律写 `window.location`**（bundle 由宿主 eval）。

### 2.20 ReplayGain：标签是**不可信输入**，增益必须走**独立节点**（第 21 轮沉淀）

本仓库**只读标准标签**（`REPLAYGAIN_TRACK_GAIN` / `_ALBUM_GAIN` / `_PEAK`），**不改文件**，
也不自己扫描测量。做法与 fooyin 一致（它是 GPL-3.0、本仓库 MIT：**只借鉴做法，不抄代码**）。

- **未测量 ≠ 0dB**：`REPLAYGAIN_*` 缺失时增益必须是 **1**（当 0dB 等于「声称已测量且无需调整」）。
  `Track` 的四个字段未测量时一律 `null`，客户端见到 `null` 直接跳过。
- **增益必须走独立节点**（`source → rgGain → volumeGain → destination`），否则淡入淡出与响度
  归一化会**互相覆盖**（门禁 B8）。
- **回退路径要把 RG 折进元素音量**，且 `readVolume()` 要**除回去**，否则渐变从被缩过的值起步。
- **防削波默认恒开**：增益后峰值可能越过满刻度，按 `peak` **收窄**增益（fooyin 的
  `PreventClipping`）。**禁止**为了「响一点」去掉它 —— 门禁 B6 会红。
- **标签是文件里来的，必须先收窄**：`typeof v !== 'number' || !Number.isFinite(v)`
  （`Number.isFinite` **不做类型收窄**，`strictNullChecks` 下要显式判类型）；**范围要夹住**：
  增益 ±40dB、前级 ±15dB、峰值 ≤4（超出当损坏）。
- **`null` 标签在 payload 里也要是 `null`**（不是 undefined）：客户端据此区分「未测量」与「字段缺失」。
- **只读标签不够**（本机曲库实测 **0/40 首**带标签 ⇒ 必须有**测量**兜底）：ffmpeg 的
  `ebur128=peak=true` **只读**测量（绝不写回音频文件），增益 = `-18 LUFS` − 实测积分响度；
  结果存 `$DSH_HOME/storages/dsh-music-player-rg.json`，带 `size`+`mtimeMs` 失效判断。
- **优先级是标签 > 测量**（标签是权威，测量只是兜底）—— 反过来的话 B12 立刻红。
- **全静音 ≠ 测量失败**：峰值 `-inf` 时**不做增益、也不猜**，计入 `skipped` 而非 `failed`
  （当 0dB 用会得出 +52dB —— 对照⑧实测）。
- **测量必须可取消、且随实例停止**：ffmpeg 子进程要在 `dispose()` 里 `SIGKILL`，否则热重载后
  它会继续跑到结束（I-06 孤儿进程）；`rgJob` 状态必须放在 **createHost 内**（module 级可变状态
  在热重载下会被不可回收的 ESM 条目永久钉住，§2.2）。
- **失败原因要分类且不含路径**（`ffmpeg-not-found` / `spawn-error` / `timeout` /
  `loudness-not-readable:exit=N,len=N` / `silent-track`，§2.8 脱敏）。

> **§2.7 的「四个副本」实际是五个**：`Track` 类型 → **`PayloadTrack` 白名单投影** →
> `lib/index.js` 的 `FETCH_ROUTES`（仅端点）→ `dsh-plugin.json` → 客户端 `MusicTrack`。
> 本轮就栽在这里：字段在宿主解析出来了、类型也加了，但 **`payloadTracksFor()` 的 map 没加**
> ⇒ 下发永远是 undefined，而门禁 A1–A3 立刻变红（负向对照①正是把投影删掉验证的）。
> **给 `Track` 加字段时，必须同时改 `PayloadTrack` 与客户端 `MusicTrack`。**

### 2.21 预取 + 交叉淡化：消除切歌「缝」（第 22 轮起；第 25 轮**默认开启**）

第 20 轮按 fooyin 把过渡校准到 300/700ms —— 遮蔽力上去了，代价是**手动切歌多出约 300ms 淡出缝**。
fooyin 没有这个代价，因为它的 300ms 是**重叠**的交叉淡化。本轮补上浏览器里的等价物。

- **两个媒体元素 + 每元素一个电平节点**：`sourceX → levelX → rg → volume → dest`。两个元素接进
  **同一个常驻 AudioContext** ⇒ 设备流仍只开一条，§2.19 的前提不变。
- **`audio` 必须是 `let`**：交接时交换绑定（`audio = inEl`），90+ 处引用自动跟随。活跃元素查询走
  `player.media()`（调用时才读 `audio`）。
- **电平必须**每元素**独立**：用共享音量节点做淡出会连新元素一起压掉（门禁 D3：交叉期间音量节点
  **零写入**）。
- **「重叠」的判据是「同刻起算」**：两条电平 ramp 都以同一个 `now` 为基准。只断言「节点不同」时，
  串行的「先淡出再淡入」也会通过（对照⑫实测）—— 本轮第二次踩「断言看着强、其实不判别」。
- **teardown 要停两个元素**：交叉进行中活跃的仍是旧元素，正在淡入的新元素是**空闲**元素，只停当前
  那个会让它卸载后继续出声（对照⑬）。**切歌是异步的**：断言必须等新元素真的 `play()` 后再 teardown，
  否则 halt 抢跑、断言恒绿（本轮实测踩到）。
- **默认开启**（第 25 轮用户实测后翻转）：用户确认**换页面时也有电流声** ⇒ 与平台/其它来源有关，
  不再是本插件的设备重协商，所以 300ms 淡出的「保险」理由不再成立，而交叉淡化能消掉切歌缝。
  显式关闭：`?crossfade=0` 或 `window.__dshMusicCrossfade = false`。
- **翻转默认值必须同时改门禁语义**：H1/H2 断言的是**单元素**淡出路径 —— 现在它只在
  `?crossfade=0` 下成立，其它套件（RG / 均衡器 / CORS）一律**显式固定**模式（`?crossfade=0`）
  做隔离，否则「默认值」会变成每个套件的隐藏变量。D 段同时断言**默认开启（D0a）**与
  **显式关闭（D0b）**两条 —— 只断言一条等于没人守默认值。

### 2.22 均衡器：0dB 即直通，前级必须自动补偿（第 23 轮沉淀）

10 段 ISO 中心频率（31…16k）的 peaking 滤波器串成一条链，**插在 RG 与音量之间**；
频点、Q 值与预设曲线都是本仓库自定（fooyin 是 GPL-3.0：只借鉴「多段 + 预设」这个做法）。

- **0dB 的 peaking 滤波器就是直通** —— 所以「关闭」不需要旁路开关，也就没有「开关状态与曲线
  状态不同步」这类 bug。默认必须是 `flat`：用户没要求就不要偷偷改声音。
- **自动前级 = `10^(-max(0, 最大提升)/20)`**：只提升某几段会把峰值推过满刻度（与 RG 的防削波
  同一思路）。**禁止**去掉它 —— 门禁 E5 会红。
- **曲线要夹范围**（±12dB），**两处都要夹**（API 边界 + 应用层）：对照实测只删一处**仍会通过**，
  所以对照必须按「两处都删」做。
- **非法输入不动现状**：未知预设、长度不对的曲线一律**返回不动**（不猜）—— 对照⑱删掉校验后
  E7/E8/E9 立刻变红。
- **缺 `createBiquadFilter` 时只跳过 EQ**，绝不能因此把整条音频图判为失败 —— 那会连 §2.19 的
  常驻输出流一起丢掉（门禁 E10）。
- **常量必须在模块级**：视图与 player 是两个作用域，放 `createPlayer` 内视图读不到（本轮吃了
  5 个类型错误）。
- **`check()` 的 detail 是无条件求值的**：没有滤波器时 `filters[0].gain` 会在 detail 里崩、掩盖
  后面的断言。**非空护栏要同时加在条件与 detail 上**（`[].every()` 恒真 = 空过）。

### 2.23 波形进度条：包络要**忠实**，取不到就**静默降级**（第 24 轮沉淀）

进度条只有一条线时看不出「哪儿是副歌、哪儿是静音」，拖动全凭猜。做法与 fooyin 的 waveform
seekbar 同源（GPL-3.0：只借鉴做法，不抄代码）。

- **内存必须与曲长无关**：ffmpeg 只读解码成单声道后**按 0.25s 流式聚合**取峰值，绝不缓冲整段
  PCM（一小时 8kHz 单声道就是 56MB）。桶数设上限（超长曲目只保留前半，**有界**优先于完整）。
- **不做低通式的"假波形"**：解码率要够高（8kHz），否则把高频削掉会让鼓点看起来是平的
  （§9 陷阱 4 的同类：夹具/参数不保真，断言就没有判别力）。
- **每首各自归一化到 0..1**：安静的歌在 UI 上才看得见；**全静音保持全 0**（不猜）。
  对照实测：改成按满刻度除 → 前半 0 / 后半 **0.80** → B2/B3 红。
- **缓存要按 `size`+`mtimeMs` 失效**：只判「有没有条目」会让波形永远停在旧内容上
  （对照实测：去掉失效判断 → B5 红）。
- **取不到就静默降级**：没有 ffmpeg / 非音频 / 未知曲目 → 回**空波形 + 稳定原因**（不是 500），
  客户端退回原来的细轨，**不报红字、不影响播放**（门禁 A6/B6/B7）。
- **客户端必须丢弃迟到的结果**：快速连切时先发的那首会晚回来，画上去就与正在播的歌对不上。
  ⚠️ **对照要让它真的能红**：得让「先发的慢、后发的快」，否则迟到的先写、正确的后写，
  看起来反而正确（本轮实测：两边一样慢时，删掉守卫**照样全绿**）。
- **进度用 CSS 变量传给遮罩**（`--dshm-played` + `clip-path`）：拖动的 rAF 循环**不必**触发
  React 重渲染（进度条是刻意非受控的，见 §4）。
- **两层柱子**（底层暗 / 上层亮）而不是「把已播部分重画一遍」：只渲染一次，遮罩裁剪是免费的。

### 2.24 性能：客户端侧也要缓存/预取，常驻 UI 有**节点预算**（第 25 轮沉淀）

宿主侧的缓存（RG / 波形）只解决了「重复计算」；**客户端每一次往返与每一个 DOM 节点**同样要计账。

- **预取要和功能开关解耦**：波形的预取挂在「取下一首」这条已有的预取路径上，但**不依赖**
  交叉淡化开关 —— 关掉淡化也该预取（否则一个优化被另一个开关悄悄关掉）。
- **预取只填缓存、不动 UI**：预取回来的包络绝不能写进 `state.wavePeaks`（那是当前曲目的）。
- **客户端缓存必须有界**（这里是 30 条）：§2.2 的容器上限同样适用于客户端 Map。
- **可量化的收益要写进门禁**：切歌 3 次从 **4 次请求降到 2 次**（起播各取一次当前+下一首），
  底栏柱子 **120→60 根**（节点 240→120）。这两条都不是「感觉快了」，而是断言里的数字。
- **常驻可见的 UI 要单独给预算**：全屏播放器可以给细节（120 根），**常驻底栏减半**（60 根）——
  它在浏览列表时一直可见，节点数是持续成本。
- **默认值本身也要有断言**：翻转默认值（如交叉淡化）时，必须同时断言「默认走新路径」与
  「显式关闭仍能回到旧路径」，否则默认值无人守（对照实测：把默认改回去 → D0a 立刻红）。
