# Repository instructions

本文件是**强制约定**。改代码、写功能模块、动 manifest 之前先读它。

## 1. 规范基线

本仓库遵循 **dsh-std Community v0.15 基线**（`BASE-STD-001`）。权威资产在仓库外，固定 revision、只读引用：

```
references/dsh-ecosystem-spec/vendor/dsh-std/
├── packages/manifest/schema/dsh-plugin-0.15.schema.json   # Manifest schema
├── packages/manifest/lib/index.js                          # validateManifest / parseManifest / projectManifest
└── docs/proposals/{manifest,lifecycle,composition,permission,storage}.zh.md
```

三条元规则：

1. **禁止复制** std schema 或 validator 进本仓库，再以同名维护（治理规则明确禁止「复制旧 schema 后继续以同一名称维护」）。要校验就指向上面那份。
2. **禁止让 `$schema` 指向分支**（如 `.../dsh-std/main/...`）。Manifest 规范（`manifest.zh.md:31`）要求 schema identifier 与 `manifestVersion` 一致，且**已发布的 identifier 不得在原位置改成另一份结构**——分支会漂移。本仓库已改为版本固定的 `https://dsh.community/schemas/dsh-plugin-0.15.json`。
3. **本仓库是 Web + Desktop 插件，不属于 dsh-TUI 生态。** `references/dsh-ecosystem-spec/spec/tui-admission-v0.15.md` 的 `TUI-*` 要求（以及 TUI profile 禁止 `client` facet 等约束）**不适用**，除非明确要把本插件收进 TUI 市场。

> 规范状态为 Draft / Experimental。它**不是** DSH 官方标准，不得声称「官方认证」「已通过官方审核」。

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

- **一个 activation instance 的资源不得被下一个 instance 复用**（`lifecycle.zh.md:125`、`:127`）：**禁止**用 `window.*` 这类全局槽位把上一代的 player / timer / handler 交给下一代。若确有必要（例如避免 HMR 双开 `<audio>`），必须**在 manifest 或 README 显式声明这是跨 activation 共享资源**，并让每代的 disposer 只作用于**自己那一代**。→ 现状：`lib/client.js:2104` 的 `window.__dshMusicPlayer` 属未声明的隐式转移（`A3-03`）。
- **disposer 必须作用于「自己的」实例**：对共享对象调 `dispose()`/`halt()` 会停掉新实例仍在使用的东西。
- **`await` 挂起后恢复的代码路径必须检查 `disposed` 状态位**：只把引用置 `null` **不够** —— 挂起的异步分支会把它重新赋值。本仓库有两条这样的路径：`lib/index.js:98-127`（`ensureHost` 两个挂起点，第 8 轮已修）与 `lib/client.js:934-957`（轮询回调，第 8 轮已修）。→ `A3-02`。
- **「清 timer」与「阻止再武装」是两件事**：teardown 里 `clearTimeout` 只能清掉**当前**那个句柄；若回调在飞期间句柄已被置 null，`clearTimeout` 落空，回调的 `catch` 会再武装。守卫若依赖 `set()` 未复位的状态（如 `scanning`），teardown 必须**显式复位该状态**。→ `A3-01`（历史 bug 的同族复发形态）。
- **自建 DOM 与全局键必须释放**：挂在 `document.body` 上的节点、`window.*` 上的键，都要在 teardown 里 `remove()` / `delete`（`lifecycle.zh.md:107`）。→ `A3-04`（`.dshm-mvPark` + `<audio>`）。
- **不得读取未在 manifest 声明的 context API**（`lifecycle.zh.md:82`）：`ctx.get('X')` / `ctx.X` / `ctx.inject(['X'])` 里的**每个服务名**都必须能在 `requires.contracts` 或 `permissions` 里找到对应声明。→ 目前 `directoryPicker`（`lib/host.js:1886`）、`ctx.locale`（`lib/client.js:3186`）、`connection.fetch`（`lib/index.js:240`）**三者都没有声明**（`A3-05`）。

### 2.11 契约坐标必须真实可解析（第 4 轮沉淀）

**这是本轮最重要的一条**：`requires.contracts` 里的每个 `apiVersion + kind` 都必须是**真实存在、可被 definition 解析**的坐标，不能凭印象编。

- **禁止发明坐标。** 写进 manifest 前必须实测该坐标在 pinned 基线里存在：
  ```
  grep -rn "<apiVersion>" <pinned>/docs/proposals/ <pinned>/packages/
  ```
  当前状态（第 7 轮实测，搜索面已用已知为真的 `conversation.view` 校准）：`webserver.dsh/v1alpha1` 与 `browser.ui.dsh/v1alpha1` 在 **references 全树 0 命中**、在 **DSH 0.1.7-rc.2 运行时 0 个文件命中**。基线里真实存在的 UI 坐标是 `ui.dsh/v1alpha1` / `ContributionHost`（`ui-contribution.zh.md:55`），adapter 的 web surface 是 `web.ui.dsh/v1alpha1`（基线 6 个文件）——**但这两个在 DSH 运行时同样 0 命中**（宿主只用字符串 slot `conversation.view`，104 个文件命中）。⇒ 本插件**不消费**任何 Community 协议契约，`requires.contracts` 为空是诚实状态（`A4-03`）。
- **`fallback` 只是「optional 时的降级说明」，不能把不存在的坐标洗成合规声明。** 给一个不存在的坐标补 `fallback`（`D-05` 曾如此处置）**不构成修复** —— 它让声明看起来完整，实际协商层永远拿不到 definition。
- **声明无 definition 的扩展 ≠ 声明能力**：`manifest.zh.md:62` 明确「Host 不理解某项扩展时…**不能声称对应功能已经生效**」。pinned 投影对无 definition 的扩展只产出 `unknown-extension` **warning**（`A4-02`）。因此 `x-dev.dsh-std.extensions` 里的两个 id **不是**能力声明，插件的主功能（会话视图 + 宿主传输）在 manifest 上是**未声明**的。第 9 轮的做法是**不声明**而不是假声明，并把真实绑定记录进 `x-dsh-music-player.ui`（`A4-02` 已修）。
- **extension id 必须有运行时对应**：两个扩展 id（`local.dsh-music-player.browser` / `.music-view`）在 `lib/` 下**逐个 grep 均 0 命中**；真正的注册点分别是 `package.json` 的 `exports["./client"]` + `dsh.client.platform` 与 `lib/client.js:3200`（`ctx.slots.register`）。声明 id 与运行时注册 id **对不上就是死声明**。（第 8 轮已把原第三个 `.routes` 条目移出，改为顶层的 `x-dsh-music-player.transport` 登记表。）
- **`prefix` 与精确路由不能混用**：声明 `prefix=/api/dsh-music` + `transport: connection.fetch`，而代码注册的是 **16 条精确** `/api/dsh-music/*`，`webServer` 上注册的是**另一个**前缀 `/dsh-music`（`A4-05` 仍待修）—— 三处语义互相冲突。声明 prefix 必须等于 `webServer.register` 的 path。
- **`requires.contracts` 必须至少有一条 `required`**：否则 composition preflight 永不阻塞，插件可以在**没注册任何端点**的情况下「激活成功」（`lib/index.js:240-246`：两个服务都缺时静默跳过）。`composition.zh.md:80` 的「preflight 成功不是 agreement」在此退化成恒真（`A4-03`）。

### 2.12 自建 bearer token 三律（第 5 轮沉淀）

本插件不走 DSH 的 permission grant，而是**自建路径凭证**（`?t=<randomUUID>`）。自建 bearer token 必须满足三条，缺一即等于把读能力挂在一个不该挂的入口上：

1. **按用途分签**：一个 token **不得**同时授权两类权限。原来是同一个 token 既授权取封面（`art`）又授权**任意库内曲目全量读**（`stream`）—— 第 9 轮已拆成 `systemArtToken` / `systemStreamToken` 两个独立随机值，交叉使用 403（`A5-02` 已修）。**仍待修**：token 在进程生命周期内不过期、无轮换、不按 session 区分，唯一撤销边界仍是 `createHost()` 闭包销毁。
2. **基址钉回环字面量，不得回显请求 Host**：原来 `lib/host.js` 的 `/session` 直接用请求 Host 拼基址 —— 第 9 轮改为 `loopbackAuthority(req)`：只取 Host 的**端口**，主机名固定 `127.0.0.1`（`A5-03` 已修）。
3. **被豁免 Host/Origin 栅栏的端点**（`lib/host.js` 的 `system-*`）**不得承担读能力**，且其凭证**不得进入任何持久通道**（日志、文件、localStorage）。豁免必须**只到 Origin / Sec-Fetch 为止** —— 第 9 轮新增 `isLoopbackHostRequest`，Host 非回环一律 403（`A5-03` 已修）。

> 这三条合起来解释 `A5-03`：token 通道**既不走平台会话鉴权、也不走插件栅栏**，唯一防线是 token 保密性 —— 而 token 已在**世界可读**文件里（`A2-01`）⇒ 同机任意进程可 `GET /dsh-music/api/system-stream?t=…&p=<任意曲目>` 读库内任意文件，无 cookie / 无 Origin。

### 2.13 错误不得被报告为成功（第 5 轮沉淀）

`storage.zh.md:83`「失败的 cleanup 不得报告为已完成」是**通用形态**，适用所有持久化/副作用路径：

- **吞掉写失败后仍返回成功是违规**。现状 `A5-09`：`saveState` 全量吞错（`lib/host.js:1042-1044`）后 `/dir` 仍返回 `200 + dir`（`:1769-1776`）。
- **持久化层必须能区分稳定错误码**（`storage.zh.md:87-93` 的 `PERMISSION_NOT_GRANTED` / `INVALID_KEY` / `INVALID_VALUE` / `QUOTA_EXCEEDED` / `STORAGE_UNAVAILABLE` 目前**一个都没有**），不能只靠"有没有抛异常"来表达。

### 2.14 能力 token 必须与 activation 生命周期对齐（第 10 轮沉淀）

客户端会把 `/session` 下发的 token 基址**缓存整个页面生命周期**，而宿主**每次热重载都会 `createHost()`**。因此：

- **token 不得随 activation instance 轮换**。它要钉在**进程**上（`Symbol.for` + `globalThis`），否则一次「保存文件」就会让页面上所有取图/取媒体 URL 变成废纸。
- **消费者必须能自愈**：缓存要带 TTL，并在**失败时**作废重取；否则症状会停在「刷新前一直坏」。
- **判断症状归属的一条经验**：`/api/mv` 返回的是**相对地址**（走平台会话、不经 token），而**音频永远走 token 直连** —— 所以「**音乐不能播、MV 能播**」几乎总是 token 通道的问题，不是流本身的问题。排查时先直接 `curl` 那条 token URL 验证 200/206。

> 第 10 轮的线上故障就是这一条被违反：token 原本是 `createHost()` 里的 `randomUUID()`，开发期每次保存 `lib/host.js` 都轮换一次。

### 2.15 TypeScript：真源、产物与类型棘轮（第 11 轮沉淀）

**真源与产物**

- **唯一真源是 `src/*.ts`**。`lib/*.js` 是 `tsc` 产物 —— **禁止直接改 `lib/`**：下次构建会覆盖它，而门禁 `scripts/check-build-fresh.mjs` 会把「手改了产物」判红。
- **产物也提交进仓库**。`dsh plugin add github:` 只克隆 + 装依赖、**不跑构建**，所以 `lib/` 必须在仓库里。这也是本仓库显式不声明 `prepare` 等生命周期脚本的原因（见 `docs/compatibility.md §5`）。
- 代价是「改了 src 忘了 build」会发旧行为出去 ⇒ 由新鲜度门禁兜住（编译到临时目录，逐字节比对）。
- 改完跑 `pnpm run build`；开发时挂 `pnpm run dev`（= `tsc --watch`），保存即重编，`lib/host.js` 的 mtime 一变热重载就生效。

**类型档位是棘轮，不是一步到位**

| 编译器选项 | 当前 | 理由 |
| --- | --- | --- |
| `strictNullChecks` | **开** | 零额外代价（实测：关掉它一处错误都不少），而且它正是能防住本仓库两个真实线上故障的那一项 —— token 缓存可能为 null（音频全 403）、媒体基址未就绪（MV 拼出相对地址、丢 Range、进度条一拖就回 0） |
| `noImplicitAny` | **暂关** | TS 7 默认开启。第 12 轮把全仓类型错误清到 0 之后，实测再开它仍会多出 **343** 处（305 处是未标注的函数参数）—— 一次性补完的回归风险不值得。改由下面的**逐文件允许清单**分批收严 |
| `noImplicitThis` / `strictBindCallApply` / `useUnknownInCatchVariables` / `noFallthroughCasesInSwitch` / `alwaysStrict` | **开** | 都是零/极低代价项 |

- 剩余类型错误由 `npm run typecheck`（`scripts/typecheck-ratchet.mjs`）守住：基线在 `scripts/typecheck-baseline.json`。**第 12 轮已把全仓降到 0 并把基线收紧到 0** —— 此后任何新增类型错误都会直接变红。
- **禁止为了让棘轮变绿而放宽 `tsconfig.json` 的档位或上调基线**（与 §6.2「禁止放宽断言」同理）。要过门禁只有一条路：把类型补对。

**逐文件收严允许清单（第 12 轮）**

全量开 `noImplicitAny` 还不现实（第 12 轮实测仍剩 **343** 处，其中 305 处是未标注的函数参数），但**已经干净的文件可以单独钉死**：

- `tsconfig.strict.json` 的 `include` 是一份**允许清单**，清单里的文件必须在 `noImplicitAny: true` 下零错误；
- 门禁 `scripts/check-strict.mjs` 已接进 `npm test` 与 CI。当前名单：`src/http-bridge.ts`、`src/tagwriter.ts`。
- **规则**：清理干净一个文件就把它加进名单，严格度**单向增长**；**禁止**为了让门禁变绿从名单里删文件；名单为空会被门禁自己拒绝（空名单 = 恒绿，比没门禁更坏）。

**静态断言的两个坑（都是第 12 轮踩的）**

1. **先剥注释**：说明性注释里会出现被断言的名字（`currentDir =`、`mvEscalated`），直接 `indexOf` 会被注释骗到 —— 表现是**恒红或恒绿**，两者都等于没断言。
2. **按行号判断，不要按字符偏移**：本仓库的 `clientPortion` 是剥掉 CSS 块后的文本，行号与源文件**不一致**；用它的偏移比较先后会错位。要么读源文件本身，要么逐行比较。

> 同族教训见 §6.1 第 3 条（「0 命中」要先用已知为真的样本校准）。**检验方法本身也需要被检验。**

**`client.ts` 必须保持零 import**

客户端 bundle 由宿主在浏览器里 `eval`（`window.__ModuleLoader__`），**它的 import 无法解析**。所以：
- 不得为了共用类型而在 `client.ts` 里写 `import`（包括 `import type`，除非确认编译后完全擦除且宿主不在意 —— 现在的答案是**不冒这个风险**）；
- 类型只能就地声明在 `client.ts` 内；宿主侧的共享类型同理就地声明，不要新建一个只有 host 会 import 的模块。

**门禁不得依赖字面缩进**

第 11 轮的教训：`test-audit.mjs` 用 `/^        ([a-zA-Z][\w]*):/gm`（写死 8 空格）找 player API 方法，tsc 重新排版成 16 空格后这条断言**静默返回 0 个方法**——本该报警的地方反而变绿。改成「取该块里缩进最小的键」后恢复。**写静态断言时要按结构推导，不要按空白字符写死。**

### 2.16 平台栅栏在**路由之前**拒答 —— 回落判据不能只认 404（第 13 轮沉淀）

第 12 轮的 A1-02 用「**404** 且该端点属于「不该 404」的那一类」作为「宿主是旧入口」的判据。
第 13 轮的真机故障证明这条判据**过窄**：

| 请求（Electron 宿主 :19387 实测） | 结果 |
| --- | --- |
| `/dsh-music/api/session`（插件自建回环前缀） | **200** |
| `/api/dsh-music/session`（平台 `/api`） | **401** `unauthorized` |
| `/api/dsh-music/session` + `Origin: dsh-app://app` | **403** `forbidden` |

平台 `/api` 的 `admit()` 在**路由之前**判 Host/Origin 栅栏与浏览器会话，所以答的是 **401/403**。
「宿主没有这个端点」（404）与「这道栅栏不让这个请求过」（401/403）是**两件事**，
把后者当前者会让回落在 Desktop 上永不触发。

- **回落判据必须覆盖全部「这道传输送不到」的状态码**（401 / 403 / 404），而且仍然要配
  **正向识别**（必须真的解析出目标数据才算采纳）+ **显式报告降级**（§2.8）。
- **例外只给「其存在意义就是绕开这道栅栏」的端点**：本仓库只有 `/session`
  （它的产物就是回环 token 基址）。其余端点**不得**享受这条 —— 把一次普通的 403 洗成
  信任边界降级是违规。
- **降级成不可 seek 的源比等待更糟**：`ensureStreamBase()` 拿不到基址时必须**重取**，
  不能「超时就算了」——相对地址在 Desktop 上丢 Range，等于把功能做废。
- **按可观测症状兜底自愈**：成因修好了也要留一层，因为原因可能不止一个。
  本仓库的判据是「源不是 token 直连 + 时长已知 + `seekable=[0,0]`」。
  自愈必须**有界**（窗口 / 退避），且**成功才停** —— **禁止**一次失败就置永久标志
  （与第 9 轮被推翻的「一次性标志」、§2.10「清 timer ≠ 阻止再武装」同族）。
- **诊断日志必须无歧义且不带凭据**：分类函数不能把空串 / `blob:` / 自定义协议一起归成
  「相对」；同时按 §2.9 剥掉 `t=<token>`。
- **夹具的保真度也是判别力的一部分**：假媒体元素若缺了真实元素一定有的属性
  （`currentSrc` / `seekable`），被测路径会失真甚至恒绿。写夹具时先问「真实元素这里长什么样」。

## 3. 可跑门禁

改完**必须**跑，全绿才算完成：

```bash
pnpm run build                # src/*.ts → lib/*.js（改了 src 必须跑）
pnpm run typecheck            # 类型棘轮：错误数只许变少（基线 0）
npm test                      # 产物新鲜度 + 逐文件严格 + 25 套回归
                              # = check-build-fresh && check-strict && run-all
pnpm run check:manifest       # dsh-plugin.json 对 pinned Community v0.15 校验
git diff --check              # 空白/冲突标记
```

`.github/workflows/ci.yml` 在每次 push / PR 上跑同一组门禁（`pnpm install --frozen-lockfile` → `typecheck` → 全部 `lib/*.js` 与 `scripts/*.mjs` 的 `node --check` → `npm test`（= 新鲜度 + 逐文件严格 + 25 套）→ manifest 校验 → 冲突标记扫描）。**CI 故意不先 build**：新鲜度门禁只在 `lib/` 未被就地覆盖时才有判别力。**CI 绿不等于 manifest 校验过**：CI 里没有 vendor 基线，`check:manifest` 会走 SKIP 分支并打 `::warning::` —— SKIP 不是通过（见上）。

- **只要动了 `dsh-plugin.json` 或 manifest 相关字段，`check:manifest` 是必跑项。** 它用固定 revision 的 `@dsh-std/manifest` 校验，不是照 `main` 分支。基线找不到时它以 **SKIP** 退出（exit 0 + 明确警告），**那不是通过**——用 `DSH_STD_MANIFEST=/path/to/@dsh-std/manifest/lib/index.js` 指过去。
- 新增功能**必须**在 `scripts/run-all.mjs` 的 `suites` 里注册回归套件；没注册等于没有门禁。
- 交回改动前**保留工作区中与本任务无关的用户改动**，不要顺手重构。

## 4. 本仓库既有约定

- **改动生效路径**：改的是 `src/*.ts`（`lib/*.js` 是产物，见 §2.15）。挂 `pnpm run dev` 让保存即重编，然后：`src/client.ts` → 刷新页面；`src/host.ts` → **也是刷新页面**（入口薄壳按 `lib/host.js` 的 mtime 重载）；**只有改 `src/index.ts` 才需要重启进程**。
- **测试防线（逐条标注真实状态，第 2 轮核实）**：

  | # | 防线 | 真实状态 |
  | --- | --- | --- |
  | ① | `scripts/test-audit.mjs` 静态审计——CSS class 双向引用、`@keyframes` 必须被引用、BEM 修饰类不被基类规则顶掉、中英字典键一致、无未调用的 player API 方法、client 的 `api()` 调用都有宿主路由 | ✅ **真实存在**，6 项全落地，且多数带非空护栏（`kf.length > 0`、`methods.length > 10`、`hostRoutes.size >= 10`）。BEM 那一项**无护栏**，见 `A2-14` |
  | ② | 按钮接线检查——读 `__reactProps$*`，断言每个 `<button>` 都挂了处理函数或处于 disabled | ✅ **真实存在**（`test-client-shell.mjs:202-209` 定义读取器，`:393`/`:398-399` 断言，`test-match-client.mjs:146-152` 覆盖弹层） |
  | ③ | 「布局结论一律用真实 Chromium 量盒模型（headless Chrome + CDP）」 | ❌ **不存在**。该主张已从 README 删除（原在 `README.md:270`；现改为显式「本仓库没有布局测量能力」的警告），`scripts/` 下无任何浏览器启动器；8 个客户端套件全部走 jsdom，布局类结论实际靠**伪造 `scrollWidth`/`clientWidth`** 得出。见 `A2-02` |

  → **③ 是 README 的错误主张**。本仓库当前**没有**布局测量能力；涉及「位置/宽度/是否溢出」的判断要么补一个真实 Chromium 门禁，要么明确标注为**未验证**。不得再引用这条防线。
- **不留死代码**：本仓库**已有** `typescript`（devDependency）与 `tsconfig.json`（见 §2.15），但**当前没开 `noUnusedLocals` / `noUnusedParameters`** —— 开了会立刻多出上百处历史告警。眼下可用的是 `scripts/test-audit.mjs` 的死方法 / 死字典键 / 死 CSS class 检查；把它们**分批清到零之后**再打开这两个开关，才会是有意义的信号。（`A2-15` 原记录「无 typescript / 无 tsconfig」已被第 11 轮推翻。）
- 文案与注释以中文为主；新增 UI 文案必须同时补中英字典键。
- 交付说明里**区分「已验证」与「未验证」**：写清用什么命令、在哪个运行时、什么结果；别把「没跑」写成「通过」。

## 5. 审计台账（完整证据 → [`docs/audit-ledger.md`](docs/audit-ledger.md)）

> **台账正文已移出本文件**：`AGENTS.md` 是 workspace 指令文件，有 **64 KiB 注入预算**；撞上后**尾部会被静默截断**（已实测）。
> 完整台账（含每条的证据、复现、符合项清单）在 [`docs/audit-ledger.md`](docs/audit-ledger.md)。**只追加不删**。

### 5.1 高危索引（13 条 `高` —— **已于第 8/9 轮全部修复 ✅**）

| ID | 一句话 |
| --- | --- |
| `A1-01` | 三方漂移：`host.js` 18 端点 / `connection.fetch` 11 / manifest 10 → 7 个端点在无 `webServer` 形态不可达 |
| `A1-02` | 客户端用 **404** 当「宿主是旧入口」信号，被正常业务 404 烧掉；成功则**静默降级信任边界** |
| `A1-03` | `mvJobs` 永不删除 + `dispose()` 不终止 ffmpeg → 孤儿进程 + 每次热重载永久泄漏 |
| `A2-01` | **已提交进 HEAD 的 `TEMP DIAGNOSTIC` 探针把能力 token 明文写入世界可读的 `/tmp/dshm-probe.log`** |
| `A2-02` | README/AGENTS 主张的「真实 Chromium + CDP 量布局」防线**在仓库里不存在** |
| `A2-03` | **传输面覆盖 1/10**：`test-mv` 只打旧前缀 → 绿灯与用户路径无关 |
| `A3-01` | 客户端库轮询定时器 teardown 后**自我续期** → 永久 1.5s 请求风暴 |
| `A4-02` | 插件主功能在 manifest 上**未声明**（三个扩展 id 在 `lib/` 下 0 命中，只有 `unknown-extension` warning） |
| `A4-03` | **两条契约坐标是编造的**（`webserver.dsh`/`browser.ui.dsh` 全树 + DSH 运行时均 0 命中）+ 无任何 `required` → preflight 恒真 |
| `A4-06` | `ContributionHost` 无 surface 列表，**且 DSH 侧根本没实现该契约**（`ui.dsh/v1alpha1` 在运行时同样 0 命中，宿主只用字符串 slot `conversation.view`）→ 永远形成不了 agreement。**第 7 轮由「中」上调为「高」** |
| `A5-02` | 单一 token 同时授权取封面与**任意曲目全量读**，无 TTL / 无轮换 / 不按 session 区分 |
| `A5-03` | **`A2-01` 的升级**：token 通道豁免栅栏且钉在旧前缀 → 同机任意进程可读库内任意文件 |
| `A5-04` | 副作用位置**无 grant 检查**，`manifest.permissions` 运行期零次读取 |

#### 5.1.1 第 8 轮已修 ✅

每条都补了门禁，且**每条门禁都做过负向对照**（回退修复 → 门禁必须变红）：

| ID | 修复 |
| --- | --- |
| `A2-01` | 删除已提交的探针（21 行）+ 死代码 `entry` 参数；清掉长到 641,835 B 的 `/tmp/dshm-probe.log`。门禁：`test-audit.mjs` 写盘目标白名单 + 凭据不得进写盘 |
| `A1-01` | `FETCH_ROUTES` 11 → 16 条；`system-art`/`system-stream` 记为具名例外。门禁：`test-route-consistency.mjs` 三向相等 |
| `A2-03` | `test-desktop-routes.mjs` 的 `expected` 改为从 `host.js` 分派表**推导**，并加反向断言 |
| `A2-02` | README 删掉不实的「真实 Chromium + CDP 量布局」防线主张，改为「本仓库没有布局测量能力」的显式警告 |
| `A2-06` | README 端点表 10 → 18 条，并写明 `system-*` 仅旧前缀可达及其代价 |
| `A3-01` | `lib/client.js` 加 `disposed` 闸门 + `halt()` 复位 `scanning`。门禁：`test-poll-teardown.mjs` |
| `A3-02` | `lib/index.js` 加 `disposed`，两个 await 之后赋值之前复查。门禁：`test-teardown-race.mjs` |
| `A4-03` | `requires.contracts` 两条编造坐标**删除** → `[]`；扩展改用真实的 `ui.dsh/v1alpha1`。门禁：编造坐标不得作为 `apiVersion` 回归 |
| `D-05` | 状态由「待修」改为**已修**（这次是真的删/换，不是补 `fallback`） |

> ⚠️ **`system-art`/`system-stream` 不能注册到 `connection.fetch`** —— 它们必须留在插件自建的旧前缀上（平台 `/api` 的 `admit()` 会先判 Origin 栅栏再要求浏览器会话，Chromium 内部取图必然被拒）。见台账 §5.12.1。这是设计约束，不是漏改。

**第 9 轮（剩余 7 条高危，全部修复 ✅）**

| ID | 修复 |
| --- | --- |
| `A5-03` | 基址**钉回环字面量**（只取请求 Host 的端口，主机名固定 `127.0.0.1`，不再回显 Host）+ 栅栏豁免**收窄**到只豁免 Origin/Sec-Fetch（新增 `isLoopbackHostRequest`） |
| `A5-02` | token **按用途分签**：`systemArtToken` / `systemStreamToken` 两个独立随机值，交叉使用 403 |
| `A1-03` | `mvJobs` **有界**（`MV_JOBS_MAX`/`MV_JOB_TTL_MS` + `pruneMvJobs()`，运行中的永不淘汰）+ 终态盖 `finishedAt` + `dispose()` 调 `killAllMvJobs()` 对在飞子进程 `SIGKILL` |
| `A5-04` | 新增 `authorize(action, targetPath, scopes)`，在 **7 个副作用位置**逐一校验目标落在已声明 scope 内 |
| `A1-02` | 判据改为**端点语义 + 正向识别**（`ROUTE_MISSING_404_ENDPOINTS` + `looksLikeHostPayload`）；`entryResolved` 只在采纳成功时置位；降级渲染成可见提示（`.dshm-notice`） |
| `A4-02`/`A4-06` | 删除两条无 definition 的扩展声明；真实绑定记录到 `x-dsh-music-player.ui`，由门禁保证「记录的东西在代码里找得到」 |

> **第 9 轮推翻了我自己的一个设计**：`A1-02` 第一版用「5 秒探测冷却」，被既有套件抓住 —— 前面的业务 404 启动了冷却，真正需要回落时被跳过。**「冷却窗口」与「一次性标志」是同一类错误**：都让无关的业务 404 影响真实回落机会。正确判据是**端点语义**。见台账 §5.13.1。
> 同轮还**删掉了一条没有判别力的断言**（用 `/cover` 测业务 404，但 jsdom 不加载 `<img>`，客户端根本不请求它，负向对照不会变红）。**没有判别力的断言等于没断言。**

### 5.2 其余条目

`D-01`…`D-06`（既有偏差）、`A1-04`…`A1-06`、`A2-04`…`A2-19`、`A3-02`…`A3-08`、`A4-01`/`A4-04`…`A4-10`、`A5-01`/`A5-05`…`A5-11` ——
共 41 条（+ 第 7 轮上调的 `A4-06`），逐条字段（严重度 / 位置 / 规范依据 / 判定 / 门禁 / 状态）、证据与复现、符合项清单见 [`docs/audit-ledger.md`](docs/audit-ledger.md)。

### 5.3 当前状态（第 9 轮收口）

- **13 条已修**（`D-05` + 12 条条目）；**高危 13 → 0**。存量只剩中/低与明确接受项。
- 套件 18 → **24**，`ALL 24 SUITES PASS`；**每条新门禁都通过负向对照**（回退修复后确实变红）。
- **第 12 轮把类型错误从 243 清到 0**，并做**逐文件收严允许清单**（`tsconfig.strict.json` + `check-strict.mjs`）。
  同轮类型检查顺手抓出并修掉两个真实缺陷：MV「重试」按钮因引用 `createPlayer` 局部量而**必然抛 ReferenceError**（`A5-12`）、
  `setDirectory` 未等 `ready` 导致目录被 `loadState()` 清掉（`A5-13`）。见 §2.15 与台账 §5.16。
- **第 10 轮修掉一个线上故障**：能力 token 随 `createHost()` 轮换 → 客户端缓存的媒体基址失效 → 「音乐全不能播、MV 照播」。改为进程级 token + 客户端基址 TTL/失败自愈。见 §2.14 与台账 §5.14。
- 第 7 轮由 Lead 亲自实测载荷性主张；第 8/9 轮各条门禁均做负向对照；两次自我推翻（`D-05` 误标「已修」、`A1-02` 的冷却设计）都按 §6.2 新写条目而非覆盖。
- 判定变更：`D-05` 已修、第 3 轮 `L133` 由「符合」改「违规」、`A4-06` 由「中」上调「高」且已修。见台账 §5.10 / §5.11 / §5.12 / §5.13。
- **审计维度已全部覆盖**：manifest+composition · lifecycle · permission+storage · 门禁有效性 · 声明面/注册面。

---

## 6. 审计与迭代协议

### 6.1 每轮固定动作

1. **选定维度**：一次只审一个（manifest/声明面 · lifecycle/释放面 · composition/协商面 · permission+storage/数据面 · 门禁有效性）。
2. **禁止把 README / 注释的自我描述当事实**：任何「已有防线 / 已有约定 / 已有测试」的说法，**引用前必须实测存在**（`glob`/`grep`/实跑）。本条第 1 轮被违反，代价见 §5.6.3 的 `E-01`…`E-04`。
3. **取证**：只能报**真读过并给出 `文件:行号`** 的条目。静态推断必须显式标注为推断，不能混进「违规」。
   - **「0 命中」的结论必须先用一个已知为真的样本校准同一搜索面。** 第 7 轮实测教训：我曾用 `grep -c <pattern> bin.js` 得到 `webserver.dsh`/`browser.ui.dsh`/`HttpPrefixRoutes` 全为 `0`，**但同一命令对宿主确实在用的 `conversation.view` 也是 `0`** —— 说明搜错了产物（`bin.js` 是 CLI 入口，不是 client bundle），那个 `0` **不含任何信息**。纠正方法：先在候选产物里搜一个已知为真的字符串（`conversation.view` → 命中 `cordis-client-runner/lib/client.js` 等），再在同一批产物里搜待证字符串。
   - 这与「按动词搜日志」（§5.7.5）同族：**检验方法本身也需要被检验。**
4. **登记**：按 §5.1 字段写入台账，**只追加**。
5. **复核**：基线跑 `node scripts/run-all.mjs`，明确写出该条**是否被现有门禁拦住** —— 拦不住就是门禁盲点。
6. **沉淀规则**：若发现的是**通用形态**（不是一次性 bug），把规则补进 §2，而不是只在台账里记个例。
7. **升级门禁**：判定为「违规」且**可机械校验**的条目，必须补一个 `scripts/test-*.mjs` 断言并在 `run-all.mjs` 注册。
   - 若补了断言会让套件变红（缺陷真实存在），**先登记为待修并报告，不要为了绿而放宽断言** —— 恒绿测试比没测试更坏。
   - 新断言必须打在**生产真正使用的传输面**上（默认 `connection.fetch`），否则是 `A2-03` 式误导性绿灯。
8. **记录轮次**：在 §5 追加「第 N 轮」小节，写清维度、基线、结论。

### 6.2 硬约束

- 台账条目**不得删除**；判定推翻要新写一条说明理由。
- 报告中**必须同时列出「符合」的证据**（哪些规范条款已落实、落在哪个文件哪一行）—— 只列问题会让后续迭代误判覆盖度。
- **禁止**为了让门禁变绿而删除断言、放宽阈值、或把 `assert` 改成 `console.log`。
- 「规范未覆盖」是合法判定：写清规范没管这件事，以及本仓库自定的处理方式。

### 6.3 门禁总表（按轮次）

**第 8 轮已实现 4 条**：`声明面一致性`（`test-route-consistency.mjs`）、`凭据不进日志`（`test-audit.mjs` ⑦）、`停止后无自续期定时器`（`test-poll-teardown.mjs`）、`teardown 优先于在飞重载`（`test-teardown-race.mjs`）。其余仍待建；按 §6.1 第 7 条实现后**会先变红**，届时按 §6.2 登记待修、**不得放宽断言**。

| 门禁 | 断言 | 归属轮次 | 覆盖 |
| --- | --- | --- | --- |
| `声明面一致性` | `dsh-plugin.json` 的 `endpoints`、`lib/index.js` 的 `FETCH_ROUTES`、`lib/host.js` 的分派表**三向集合相等**（不是单向 `expected.every()`）；`expected` 必须**从分派表推导**而非手工抄 | 1/2/4 | `A1-01`/`A2-03`/`A4-01` |
| `传输面覆盖` | 每个功能套件至少有一个用例打**生产使用的传输面**（默认 `connection.fetch`），不得只打旧前缀 | 2 | `A2-03` |
| `释放面完整性` | `dispose()` 后：`mvJobs.size === 0`、无存活 `job.child`、无新 `tagJobs`；且热重载 N 次后 module 级容器不增长 | 1/3 | `A1-03` |
| `停止后无自续期定时器` | teardown 后 3 s 内 fetch 次数不增；`getState().scanning === false` | 3 | `A3-01` |
| `teardown 优先于在飞重载` | 挂起 `import()` 期间触发 disposer，断言不再创建 host（`fs.stat`/`import` 计数不增、tag worker 未启动、有回滚或明确降级而非静默空窗） | 1/3 | `A1-04`/`A3-02` |
| `客户端 release 面` | teardown 后 `window.__dshMusicPlayer === undefined` 且 `.dshm-mvPark` 不在 DOM；二次 activation 不复用第一次的媒体元素 | 3 | `A3-03`/`A3-04` |
| `ctx 读取面一致性` | `ctx.get('X')` / `ctx.<svc>` / `ctx.inject([...])` 的服务名集合 ⊆ manifest `requires.contracts` + `permissions`（静态，建议并入 `test-audit.mjs`） | 3/4/5 | `A3-05`/`A4-03`/`A5-05` |
| `契约坐标可解析` | 每个 `requires.contracts` 的 `{apiVersion,kind}` 能在 pinned definition catalog 解析；且**至少一条 `required`** | 4 | `A4-02`/`A4-03`/`A4-06` |
| `prefix 语义一致` | `HttpPrefixRoutes` 声明的 `prefix` 必须等于 `webServer.register` 的 path | 4 | `A4-05` |
| `凭据不进日志` | 触发一次带 `?t=` 的请求，断言**任何落盘文件**都不含该 token 值；且 `lib/` 无未声明的写盘点（搜索面见 §2.9） | 2/5 | `A2-01`/`A5-01` |
| `自建 token 三律` | ①同一 token 不得同时通过 `art` 与 `stream` ②基址 hostname 恒为回环字面量 ③无 `isSystemPath` 式栅栏豁免 | 5 | `A5-02`/`A5-03` |
| `错误面脱敏` | 触发 `fs` 错误与「文件不存在」路径，断言响应体**不含绝对路径与文件名** | 1/5 | `A1-05`/`A5-09` |
| `声明面覆盖实际调用` | 从 `lib/` 抽取的 fs / net / host 面 ⊆ manifest 声明面；新增写盘路径必须落在已声明 scope 内 | 5 | `A5-06`/`A5-08` |
| `副作用前置授权` | 每个 `fs.unlink` / `fs.rename` / tagwriter 投递的调用链上先经同一 `authorize(action, scope)` | 5 | `A5-04` |
| `存储失败不得报成功` | 只读 `$DSH_HOME` 时，断言响应含**稳定未持久化错误码**，而不是 `200 + 数据` | 5 | `A5-09` |
| `恒绿断言扫描` | 静态禁止 `check(…, true)` 字面真断言；「跳过」必须能与「通过」区分（非零退出或显式 skip 计数） | 2 | `A2-10`/`A2-11`/`A2-13` |
| `门禁诊断可用` | `run-all.mjs` 失败时必须打印失败套件的 stderr | 2 | `A2-12` |

## 7. 文档分层与关系

### 7.1 分层地图

| 文件 | 面向谁 | 放什么 | **不放**什么 |
| --- | --- | --- | --- |
| `README.md` | 使用者 / 市场复核 | 定位、功能、安装更新卸载、兼容性**表**、权限**表**、API **表**、结构、开发与测试入口、排查、文档索引 | 逐条技术论证、实现叙事、历史沿革、术语表 |
| `docs/desktop.md` | 改宿主接缝 / 排查 Desktop 问题的人 | 两代宿主形态差异、macOS 通知与「正在播放」的能力边界与验证方法、官方组件与图标命名演变、媒体直连（token 通道）的原因、技术名称表 | 与 Desktop 无关的内容 |
| `docs/compatibility.md` | DSH STORE 收录 / 供应链与权限审查 | 声明位置与取值、逐版本依据、尚未提供的证据、已知断点、依赖、权限↔代码信号↔触发条件、外部服务、失败边界 | 使用说明 |
| `AGENTS.md`（本文件） | 改代码的人与 agent | 规范基线、不可协商的规则（§2）、可跑门禁（§3）、既有约定（§4）、审计与迭代协议（§6） | 台账正文（已移出） |
| `docs/audit-ledger.md` | 审计者 | 逐轮台账全文（证据、复现、符合项清单、编号裁定） | 规则本身 |
| `dsh-plugin.json` `x-dsh-transition` | 跨版本核对者 | 接缝的实测记录。**升级 DSH 后按运行中的应用核对，不要按本地 checkout。** | —— |
| `src/*.ts` → `lib/*.js` | 改代码的人 | 源码在 `src/`，产物在 `lib/`；两者都提交，由 `check-build-fresh.mjs` 保证一致。见 §2.15 | 手改 `lib/` |
| `tsconfig.json` + `scripts/typecheck-baseline.json` | 改代码的人 | 类型档位与棘轮基线（当前 **0**）。**禁止为了让门禁变绿而放宽档位或上调基线** | —— |
| `tsconfig.strict.json` + `scripts/check-strict.mjs` | 改代码的人 | 逐文件收严的**允许清单**：名单里的文件必须在 `noImplicitAny: true` 下零错误。清干净一个就加一个，**禁止删**（见 §2.15） | —— |

### 7.2 分层规则（改文档前先读）

- **README 只放「怎么用」与「一张表」**。任何超过 3 行的论证、因果叙事、历史沿革、术语解释，**一律放 `docs/`**，README 只留一句结论 + 链接。目标：**≤ 220 行**，超出就要把内容下移。
- **深度材料不得因为「README 要短」而被删掉**。搬家时保留全部事实与数字；本仓库的 `docs/` 就是这些材料的位置。删事实需要单独的理由与记录。
- **不新增同义文档**。要写「关于 X」之前先查 §7.1 是否已有归属；有就并进去，不要开第三个讲同一件事的文件。
- **README 里不许出现未验证的数字与不在仓库里的防线**。实测数字要标注是否纳入门禁（例：性能数字标注「未纳入门禁」）；曾出现过的「headless Chrome + CDP 布局门禁」是**不实主张**，已删除，不得再写回。
- **与 README 冲突时以本文件的规范条目为准，并同步修 README。**
