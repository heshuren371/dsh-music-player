# Repository instructions

本文件是**强制约定**。改代码、写功能模块、动 manifest 之前先读它。

## 0. 给 agent 的快速上手（先读这一节）

> 为「第一次接手本仓库的模型」准备的自检入口：读完它就能安全改代码，不必先通读全文。
> 每条都给出**能被机械抓住**的门禁名 —— 违反时不需要靠人发现。

### 0.1 这是什么

DSH 的本地音乐播放器插件，**Web + Desktop 同一份包**。`src/*.ts` 是唯一真源；
`lib/*.js` 是 tsc 产物**且提交进仓库**（`dsh plugin add` 不跑构建）。

### 0.2 三条命令就是全部验证

```bash
pnpm run build && pnpm run typecheck   # 编译 + 类型棘轮（基线 0，含死代码开关）
npm test                               # 产物新鲜度 + 逐文件严格 + 30 套回归
pnpm run check:manifest                # 只在动了 dsh-plugin.json 时必跑
```

**全绿才算改完。顺序不能颠倒：先 build 再跑测试** —— 门禁读 `lib/`，不 build 就是在验旧产物
（第 15 轮真踩过：负向对照因此是空的，差点误判「断言没有判别力」）。

### 0.3 五个文件各管什么（不要改错地方）

| 文件 | 职责 | 改动生效 |
| --- | --- | --- |
| `src/index.ts` | 入口薄壳：注册 `/api/dsh-music/*` Fetch 路由、按 mtime 热重载 host | **重启进程** |
| `src/host.ts` | 宿主：扫描 / 标签解析 / Range 流 / 多源匹配 / 封面代理 / 写入与重命名 | 刷新页面 |
| `src/client.ts` | 客户端「音乐」视图（React）。**必须零 import/export** | 刷新页面 |
| `src/http-bridge.ts` | Fetch ⇄ node:http 适配（背压 / abort 释放 fd / HEAD） | 刷新页面 |
| `src/tagwriter.ts` | 标签写入 worker 入口 | 刷新页面 |

### 0.4 改动的完成定义（DoD）

1. 改了 `src/` → 跑过 `pnpm run build`
2. `pnpm run typecheck` 0 错误（含 `noUnusedLocals`/`noUnusedParameters`：死代码直接红）
3. `npm test` 30 套全绿
4. 新增功能/修复 → **在 `scripts/run-all.mjs` 注册了回归套件**（没注册等于没门禁）
5. 新增断言 → **做过对照**：把缺陷改回去，断言必须变红（§6.1 第 7 条）
6. 改了文档 → README ≤ 220 行，深度材料进 `docs/`（§7.2）
7. **收口 = 提交 + 推送 + `git status --short` 为空 + CI 绿。** 只跑门禁**不算**完成 ——
   门禁验的是**工作区**，`git status` 才验**仓库**（§6.1 第 9 条、台账 §5.24）

### 0.5 最先该知道的 6 条不变量（完整清单见 §8）

| 不变量 | 违反症状 | 抓住它的门禁 |
| --- | --- | --- |
| 端点面四处逐字一致 | 端点在某个宿主形态**不可达** | `test-route-consistency` |
| 媒体源必须是 token 直连的**绝对地址** | 进度条**一拖就回 0 秒** | `test-mv-seek` |
| 能力 token **进程级** + **按用途分签** | 音乐全不能播 / MV 照播 | `test-token-lifetime`、`test-security` |
| 每个副作用位置过 `authorize(action, scope)` | 越界读写 | `test-audit` |
| teardown 后不得再启动（timer / 在飞 await / 子进程） | 卸载后请求风暴、孤儿 ffmpeg | `test-poll-teardown`、`test-teardown-race`、`test-mv-teardown` |
| 凭据不进任何日志或落盘 | 同机任意进程可读库内文件 | `test-audit` 凭据扫描 |

### 0.6 想做新功能？按这个顺序

1. 先查 §10「明确接受的设计取舍」—— **别修**那些是故意的
2. 端点类改动 → 同步四处（§2.7）并加进 `FETCH_ROUTES`，否则不可达
3. 碰文件系统 → 在副作用位置加 `authorize()` 并同步 manifest 的 `permissions`（§2.4）
4. 新门禁必须打在**生产真正用的传输面**（默认 `connection.fetch`）上，并做对照
5. 若属**通用形态**（不是一次性 bug）→ 补进 §2；否则只进台账


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

- **一个 activation instance 的资源不得被下一个复用**（`lifecycle.zh.md:125`、`:127`）：**禁止**用
  `window.*` 这类全局槽位把上一代的 player / timer / handler 交给下一代。确有必要时必须**显式声明
  为跨 activation 共享资源**，且每代的 disposer 只作用于**自己那一代**。→ `window.__dshMusicPlayer`
  是未声明的隐式转移（`A3-03`）。
- **disposer 必须作用于「自己的」实例**：对共享对象调 `dispose()`/`halt()` 会停掉新实例仍在使用的东西。
- **`await` 挂起后恢复的代码路径必须检查 `disposed` 状态位**：只把引用置 `null` **不够** —— 挂起的异步分支会把它重新赋值。本仓库有两条这样的路径：`lib/index.js:98-127`（`ensureHost` 两个挂起点，第 8 轮已修）与 `lib/client.js:934-957`（轮询回调，第 8 轮已修）。→ `A3-02`。
- **「清 timer」与「阻止再武装」是两件事**：teardown 里 `clearTimeout` 只能清掉**当前**那个句柄；若回调在飞期间句柄已被置 null，`clearTimeout` 落空，回调的 `catch` 会再武装。守卫若依赖 `set()` 未复位的状态（如 `scanning`），teardown 必须**显式复位该状态**。→ `A3-01`（历史 bug 的同族复发形态）。
- **自建 DOM 与全局键必须释放**：挂在 `document.body` 上的节点、`window.*` 上的键，都要在 teardown 里 `remove()` / `delete`（`lifecycle.zh.md:107`）。→ `A3-04`（`.dshm-mvPark` + `<audio>`）。
- **不得读取未在 manifest 声明的 context API**（`lifecycle.zh.md:82`）：`ctx.get('X')` / `ctx.X` / `ctx.inject(['X'])` 里的**每个服务名**都必须能在 `requires.contracts` 或 `permissions` 里找到对应声明。→ 目前 `directoryPicker`（`lib/host.js:1886`）、`ctx.locale`（`lib/client.js:3186`）、`connection.fetch`（`lib/index.js:240`）**三者都没有声明**（`A3-05`）。

### 2.11 契约坐标必须真实可解析（第 4 轮沉淀）

**这是本轮最重要的一条**：`requires.contracts` 里的每个 `apiVersion + kind` 都必须是**真实存在、可被 definition 解析**的坐标，不能凭印象编。

- **禁止发明坐标**：写进 manifest 前必须实测。实测（第 7 轮，搜索面已用真实存在的
  `conversation.view` 校准）：`webserver.dsh/v1alpha1`、`browser.ui.dsh/v1alpha1` 与基线里
  真实存在的 `ui.dsh/v1alpha1` / `web.ui.dsh/v1alpha1` 在 **DSH 运行时全部 0 命中**（宿主只用
  字符串 slot `conversation.view`）⇒ 本插件**不消费**任何 Community 契约，`requires.contracts`
  为空是**诚实状态**（`A4-03`）。
- **`fallback` 不能把不存在的坐标洗成合规声明**：补 `fallback` 只是让声明「看起来完整」，
  协商层永远拿不到 definition（`D-05` 曾如此误处置）。
- **声明无 definition 的扩展 ≠ 声明能力**（`manifest.zh.md:62`）：pinned 投影只给
  `unknown-extension` warning。本仓库的做法是**不声明**而不是假声明，真实绑定记在
  `x-dsh-music-player.ui`（`A4-02`）。
- **extension id 必须有运行时对应**：声明 id 与运行时注册 id（`package.json` 的
  `exports["./client"]` + `ctx.slots.register`）**对不上就是死声明**。
- **`prefix` 与精确路由不能混用**：声明 prefix 必须等于 `webServer.register` 的 path
  （本仓库声明过 `prefix=/api/dsh-music` 而实际是 16 条精确路由 —— `A4-05` 仍待修）。
- **`requires.contracts` 至少一条 `required`**：否则 preflight 永不阻塞，插件能在**没注册任何
  端点**的情况下「激活成功」（`A4-03`）。

### 2.12 自建 bearer token 三律（第 5 轮沉淀）

本插件不走 DSH 的 permission grant，而是**自建路径凭证**（`?t=<randomUUID>`）。自建 bearer token 必须满足三条，缺一即等于把读能力挂在一个不该挂的入口上：

1. **按用途分签**：一个 token **不得**同时授权两类权限。第 9 轮已拆成 `systemArtToken` /
   `systemStreamToken` 两个独立随机值，交叉使用 403（`A5-02` 已修）。**仍待修**：token 不过期、
   无轮换、不按 session 区分，唯一撤销边界仍是 `createHost()` 闭包销毁。
2. **基址钉回环字面量，不得回显请求 Host**：原来 `lib/host.js` 的 `/session` 直接用请求 Host 拼基址 —— 第 9 轮改为 `loopbackAuthority(req)`：只取 Host 的**端口**，主机名固定 `127.0.0.1`（`A5-03` 已修）。
3. **被豁免 Host/Origin 栅栏的端点**（`lib/host.js` 的 `system-*`）**不得承担读能力**，且其凭证**不得进入任何持久通道**（日志、文件、localStorage）。豁免必须**只到 Origin / Sec-Fetch 为止** —— 第 9 轮新增 `isLoopbackHostRequest`，Host 非回环一律 403（`A5-03` 已修）。

> `A5-03` 的教训：token 通道**既不走平台鉴权、也不走插件栅栏**，唯一防线是 token 保密性。
> 所以 token **不得**进入任何世界可读的位置（`A2-01` 就是把它写进了 `/tmp`）。

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

**类型档位是棘轮，不是一步到位**

| 编译器选项 | 当前 | 理由 |
| --- | --- | --- |
| `strictNullChecks` | **开** | 零额外代价（实测：关掉它一处错误都不少），而且它正是能防住本仓库两个真实线上故障的那一项 —— token 缓存可能为 null（音频全 403）、媒体基址未就绪（MV 拼出相对地址、丢 Range、进度条一拖就回 0） |
| `noImplicitAny` | **暂关** | TS 7 默认开启；全开仍多 **343** 处（305 处是未标注参数），一次性补完风险大。改由下面的**逐文件允许清单**单向收严 |
| `noImplicitThis` / `strictBindCallApply` / `useUnknownInCatchVariables` / `noFallthroughCasesInSwitch` / `alwaysStrict` | **开** | 都是零/极低代价项 |

- 类型棘轮：基线在 `scripts/typecheck-baseline.json`，**第 12 轮已降到 0 并锁死**，此后任何新增
  类型错误直接变红。**禁止为了让棘轮变绿而放宽档位或上调基线**（同 §6.2）—— 只有把类型补对一条路。

**逐文件收严允许清单（第 12 轮）**

- `tsconfig.strict.json` 的 `include` 是一份**允许清单**，清单里的文件必须在 `noImplicitAny: true` 下零错误；
- 门禁 `scripts/check-strict.mjs` 已接进 `npm test` 与 CI。当前名单：`src/http-bridge.ts`、`src/tagwriter.ts`。
- **规则**：清理干净一个文件就把它加进名单，严格度**单向增长**；**禁止**为了让门禁变绿从名单里删文件；名单为空会被门禁自己拒绝（空名单 = 恒绿，比没门禁更坏）。

**静态断言的四个坑**（第 12 轮起反复踩，**每条都付过代价**）：① 先剥注释（注释里会出现被断言的
名字 → 恒红/恒绿）；② 按行号而非字符偏移（`clientPortion` 剥掉了 CSS，行号与源文件不一致）；
③ 别依赖字面缩进（`tsc` 把 8 空格重排成 16 后正则**静默返回 0 个方法** → 本该报警反而变绿）；
④ 按**角色**而非创建顺序选节点（第 22 轮：均衡器插进链后，RG 套件按索引取的「RG 节点」变成 EQ
前级，B3–B12 集体变红）。**检验方法本身也需要被检验**（§6.1 第 3 条）。

**`client.ts` 必须保持零 import**：客户端 bundle 由宿主在浏览器里 `eval`（`window.__ModuleLoader__`），
**它的 import 无法解析** —— 类型只能就地声明在 `client.ts` 内；宿主侧的共享类型同理不要新建模块。

### 2.16 平台栅栏在**路由之前**拒答 —— 回落判据不能只认 404（第 13 轮沉淀）

第 12 轮的 A1-02 用「**404** 且该端点属于「不该 404」的那一类」作为「宿主是旧入口」的判据；
第 13 轮的真机故障证明它**过窄**（Electron 宿主 :19387 实测：插件旧前缀 200，平台 `/api`
分别答 **401** / 加 `Origin: dsh-app://app` 后 **403** —— 平台 `admit()` 在**路由之前**判
Host/Origin 与浏览器会话）。**「宿主没有这个端点」（404）与「这道栅栏不让这个请求过」
（401/403）是两件事**，把后者当前者会让回落在 Desktop 上永不触发。

- **回落判据必须覆盖全部「这道传输送不到」的状态码**（401 / 403 / 404），而且仍然要配
  **正向识别**（必须真的解析出目标数据才算采纳）+ **显式报告降级**（§2.8）。
- **例外只给「其存在意义就是绕开这道栅栏」的端点**：本仓库只有 `/session`
  （它的产物就是回环 token 基址）。其余端点**不得**享受这条 —— 把一次普通的 403 洗成
  信任边界降级是违规。
- **降级成不可 seek 的源比等待更糟**：`ensureStreamBase()` 拿不到基址时必须**重取**，
  不能「超时就算了」——相对地址在 Desktop 上丢 Range，等于把功能做废。
- **按可观测症状兜底自愈**：成因修好了也要留一层。判据是「源不是 token 直连 + 时长已知 +
  `seekable=[0,0]`」，自愈必须**有界**且**成功才停** —— **禁止**一次失败就置永久标志。
- **诊断日志必须无歧义且不带凭据**：不得把空串 / `blob:` / 自定义协议一起归成「相对」；按 §2.9 剥 `t=`。
- **夹具保真度也是判别力**：假元素缺 `currentSrc`/`seekable` 会让被测路径失真甚至恒绿（§9 陷阱 4）。

> **通用形态**：修**症状**时，修法必须按**当前这条源是什么类型**推导，不能按期望的播放模式
> （`track.kind`）猜；且**只在出问题时记日志不够**，要在**行为发生的那一刻**记。

### 2.17 视图局部状态活不过 `conversation.view` 的卸载（第 16 轮沉淀）

DSH 的 `conversation.view` **只在被选中时挂载**（切到「对话」即卸载，切回来是一次全新挂载）。
这条接缝有三个必须一起记住的后果：

- **要跨视图切换保留的 UI 状态，禁止放视图局部 `useState`**。全屏播放器三态 `playerPhase`、
  MV 放大 `mvBig`、封面预览 `zoomOpen` 修复前全是局部 state，切走再回来就回到列表页
  （用户报的直接症状）。它们现在放进 **player 单例 store**（`src/client.ts` 的 `PlayerState`）。
- **视图驱动的定时器必须归资源所有者，不能归视图的 effect**。收起动画那 200ms 若挂在视图里，
  卸载会把它 cleanup 掉，`phase` 永远停在 `closing`；定时器因此移进 `createPlayer()`
  （`playerCloseTimer`），并在 `halt()` 里清句柄 + 复位状态（同 §2.10）。
- **重挂载后要把外部资源搬回来**：MV 的 `<video>` 卸载时停在 body 停靠位（离开文档即暂停），
  回来时必须按**恢复后的** `playerPhase` 搬进新舞台；断言要覆盖「同一个元素、不是新建第二个」。
- **UI 过渡的定时器禁止用 `disposed` 早退**：`halt()` 已经清掉句柄，所以回调能跑到，唯一可能是
  「teardown 之后又被显式打开过」；而 player 是 window 级单例、下一代 activation 继续用它
  （A3-03），`disposed` 置位后**永不复位** ⇒ 早退会把 `phase` 永久钉在 `closing`
  （覆盖层关不掉，`closePlayer` 又拒绝从 closing 出发 = 死锁）。判据改成「还在 closing 才收口」。
  同理**禁止**给 `openPlayer` 加 `disposed` 守卫：那会让插件重载后的全屏播放器再也打不开
  （比死锁更坏）。teardown 语义由 `halt()` 自己完成，不靠拦 UI 操作。

> 门禁 `test-view-persistence.mjs`：挂载 → 开全屏（含 MV 放大）→ 卸载 → store 仍 `open`
> 且媒体停在 body → 重挂载 → 全屏 / 放大布局 / 同一个 `<video>` 全回来；收起动画跨卸载仍走完；
> `halt()` 复位；**外加**「teardown 之后 open→close 仍收口」与「真实第二次 activation 能开能关」
> 两条（防 `disposed` 死锁回归）。夹具用**真实 `<video>` DOM 节点**（假元素没有 `nodeType`，
> 搬运路径会整体跳过 ⇒ 断言恒绿，§9 第 4 条）。细节与负向对照见台账 §5.22。

### 2.18 过渡必须淡入淡出，且时长要够长（第 18 轮起；第 20 轮按 fooyin 校准）

**fooyin**（开源本地音乐播放器）的引擎默认值是权威参考（`include/core/engine/fadingdefs.h`）：
manualChange `{in=300,out=300}` · autoChange `{in=700,out=700}` · **seek `{in=120,out=120}`** ·
pause `{in=120,out=120}` · stop `{in=120,out=300}`。**本仓库采用同一组数值**，不自行调小。

- **常驻输出流与过渡淡入淡出不是二选一，两个都要。** fooyin 同时做：输出会话常驻 +「terminal
  resampling for output compatibility」（`audiopipeline.h:228`，**默认开**，master output format +
  SoX 重采样器），**并且**每次过渡都淡入淡出（含 seek）。第 18 轮只做了淡出淡入（且太短）、
  第 19 轮只做了常驻流 —— 各是一半。
- **时长决定遮蔽力**：70ms 与 300ms 是完全不同的效果（设备重协商的瞬态可持续几十毫秒，短淡入
  盖不住）。**禁止**为了「手感更脆」把过渡调到 200ms 以下 —— 门禁 H1/H2 会红。
- **拖动进度也要淡**（fooyin 120ms）。本仓库**只在常驻音频图接管增益时**做：图未启用时用元素
  音量延迟 seek 会让拖动发粘、且没有采样级保证；那条路径保持既有的**同步** seek 语义。
- **要消失先淡出，起播后淡入。** `state.volume` 始终是**用户设定值**，渐变只改**瞬时值**。
- **渐变必须可取消，取消时要结算 promise**（只清定时器不 settle 会让 `await` 它的调用方
  **永久挂住**，与 §2.10 同族）。快速连点/连拖时**最后一次赢**。
- **「没有声音要淡出」的路径必须保持同步**，判据是「**确定正在出声**」：
  `paused === false && volume > 0.001`。**禁止**写成 `paused || volume <= 0.001` —— 属性缺失时
  两个分支都是 false，会把「暂停中」误判成「正在播」而走异步路径，起播时序整体后移。
- **用户拖动音量优先于任何在飞渐变**；**卸载路径不等渐变**（§2.10；stop 的 300ms 淡出在这里
  刻意不等待）。

### 2.19 「电流声」的真因是**设备被反复重建**，必须常驻同一条输出流（第 19 轮沉淀）

第 18 轮的判断被实测**推翻**：音量淡入淡出做完，用户实测**电流声依旧**。真因在**增益级之外**。

- **机制**：Chromium 为**每一条媒体源**单独建一条音频输出流；换 `src` = 「销毁旧流 + 按新文件的
  采样率与位深建新流」⇒ macOS 必须重协商输出设备格式 = **那一声电流声**。
  本机曲库实测 44.1k/48k/96k 与 16/24bit **混排**，所以几乎每次切歌都会触发。
- **修法必须与系统播放器一致**：一个**常驻 `AudioContext`**（`createMediaElementSource` +
  `GainNode`）只有一条流、一个固定采样率，所有媒体重采样进去，设备格式不再变。
- **跨源是前提**：桌面版页面 origin 是 `dsh-app://app`、媒体在 `127.0.0.1` ⇒ Web Audio
  **必须有 CORS**，否则输出**静音**。宿主只对**窄名单**回显 ACAO（不用 `*`，见 §2.12），
  并对媒体端点应答 `OPTIONS` 预检（`Range` 不是 CORS 安全列表头）。
- **降级不许变成故障**：建图失败 → **永久退回元素音量**；跨源且未确认 CORS → **先直连、后台探一次**，
  确认后下一首才建图；另有兜底开关 `?musicGraph=0` / `window.__dshMusicNoGraph`。
- **建图后必须把元素音量置中性**：建图前写的是元素音量（首播时是 0），建图后增益在图里 ——
  不置中性就是「元素 0 × 增益」= **第一次起播静音**（比电流声严重，被本轮门禁抓到）。
- **音频图 `halt()` 只 suspend 不 close** —— close 之后这个媒体元素再也接不回音频图。
- **`AudioContext` 的 `sampleRate` 创建时即固定**（howler.js 为此专门 close 重建 ctx）：所以 ctx
  必须在**第一次播放时**才建，并把 `sampleRate`/`state` 打进诊断（§2.16），否则「打开页面之后才
  插耳机」这类场景无法从外部判断。诊断**只记数字与状态**，绝不记 URL/token（§2.9，门禁 B13 钉死）。
- **`location` 一律写 `window.location`**：bundle 由宿主 eval，裸 `location` 的解析取决于宿主作用域。

### 2.20 ReplayGain：标签是**不可信输入**，增益必须走**独立节点**（第 21 轮沉淀）

本仓库**只读标准标签**（`REPLAYGAIN_TRACK_GAIN` / `_ALBUM_GAIN` / `_PEAK`），**不改文件**，
也不自己扫描测量。做法与 fooyin 一致（它是 GPL-3.0、本仓库 MIT：**只借鉴做法，不抄代码**）。

- **未测量 ≠ 0dB**。`REPLAYGAIN_*` 缺失时增益必须是 **1（不做任何增益）**：把它当 0dB 等于
  「声称已测量且无需调整」。`Track` 的四个字段未测量时一律 `null`，客户端见到 `null` 直接跳过。
- **增益必须走独立节点**：`source → rgGain → volumeGain → destination`。否则淡入淡出（写音量
  节点）与响度归一化（写 RG 节点）会**互相覆盖** —— 门禁 B8 钉死这条。
- **回退路径要把 RG 折进元素音量**（图不可用时只有一个旋钮），并且 `readVolume()` 要把它
  **除回去**，否则渐变会从被 RG 缩过的值起步。
- **防削波默认恒开**：增益后峰值可能越过满刻度，按 `peak` **收窄**增益（fooyin 的
  `PreventClipping`）。**禁止**为了「响一点」去掉它 —— 门禁 B6 会红。
- **标签是文件里来的，必须先收窄**：`typeof v !== 'number' || !Number.isFinite(v)`。
  注意 `Number.isFinite` **不做类型收窄**，`strictNullChecks` 下必须显式判类型。
- **范围要夹住**：增益 ±40dB、前级 ±15dB、峰值 ≤4（超出当损坏）。荒谬值只会变成刺耳或静音。
- **`null` 标签在 payload 里也要是 `null`**（不是 undefined）：客户端据此区分「未测量」与「字段缺失」。
- **只读标签不够**：本机曲库实测 **0/40 首**带 `REPLAYGAIN_*` 标签 ⇒ 必须有**测量**这条兜底。
  测法用 ffmpeg 的 `ebur128=peak=true`（只读，**绝不写回音频文件**），增益 = `-18 LUFS` − 实测积分
  响度（ReplayGain 2.0 参考电平，与 `loudgain` 一致）。结果存插件自己的缓存
  （`$DSH_HOME/storages/dsh-music-player-rg.json`），带 `size`+`mtimeMs` 做失效判断。
- **优先级是标签 > 测量**。两者都在时用标签（标签是权威，测量只是兜底）；负向对照实测：
  把顺序反过来 B12 立刻变红。
- **全静音 ≠ 测量失败**：真峰值是 `-inf`（读不出有限值）时**不做增益、也不猜**，计入 `skipped`
  而不是 `failed`（当 0dB 用会得出 +52dB 的荒谬增益 —— 对照⑧实测）。
- **测量必须可取消、且随实例停止**：ffmpeg 子进程要在 `dispose()` 里 `SIGKILL`，否则热重载后
  它会继续跑到结束（I-06 孤儿进程）；`rgJob` 状态必须放在 **createHost 内**（module 级可变状态
  在热重载下会被不可回收的 ESM 条目永久钉住，§2.2）。
- **失败原因要分类且不含路径**（`ffmpeg-not-found` / `spawn-error` / `timeout` /
  `loudness-not-readable:exit=N,len=N` / `silent-track`）：全失败时这才是可诊断的信息（§2.8 脱敏）。

> **§2.7 的「四个副本」实际是五个**：`Track` 类型 → **`PayloadTrack` 白名单投影** →
> `lib/index.js` 的 `FETCH_ROUTES`（仅端点）→ `dsh-plugin.json` → 客户端 `MusicTrack`。
> 本轮就栽在这里：字段在宿主解析出来了、类型也加了，但 **`payloadTracksFor()` 的 map 没加**
> ⇒ 下发永远是 undefined，而门禁 A1–A3 立刻变红（负向对照①正是把投影删掉验证的）。
> **给 `Track` 加字段时，必须同时改 `PayloadTrack` 与客户端 `MusicTrack`。**

### 2.21 预取 + 交叉淡化：消除切歌「缝」，但**默认关闭**（第 22 轮沉淀）

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
- **默认关闭**（`?crossfade=1` / `window.__dshMusicCrossfade`）：300ms 淡出是对设备瞬态的保险，而
  用户**尚未确认**噪声已消失。确认后再默认开启，届时 H1/H2 的「先淡出再换源」语义要同步改成重叠。
- **默认路径零影响由门禁 D0 保证**：未开启时不创建第二个元素、不预取。

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

## 3. 可跑门禁

改完**必须**跑，全绿才算完成：

```bash
pnpm run build                # src/*.ts → lib/*.js（改了 src 必须跑）
pnpm run typecheck            # 类型棘轮：错误数只许变少（基线 0）
npm test                      # 产物新鲜度 + 逐文件严格 + 30 套回归
                              # = check-build-fresh && check-strict && run-all
pnpm run check:manifest       # dsh-plugin.json 对 pinned Community v0.15 校验
node scripts/check-whitespace.mjs   # 空白/冲突标记（`npm test` 已包含）
                              # ⚠️ 它**排除 `lib/`**：tsc 的 JSX 输出会在部分行尾留空格（HEAD 实测 16 处），
                              #    而手改 `lib/` 违反 §2.15 ⇒ 那个失败按规则**无法修复**。产物的
                              #    质量由 `check-build-fresh`（逐字节比对）保证，不由空白门禁保证。
```

`.github/workflows/ci.yml` 在每次 push / PR 上跑同一组门禁（`pnpm install --frozen-lockfile` → `typecheck` → 全部 `lib/*.js` 与 `scripts/*.mjs` 的 `node --check` → `npm test`（= 新鲜度 + 逐文件严格 + 30 套）→ manifest 校验 → 冲突标记扫描）。**CI 故意不先 build**：新鲜度门禁只在 `lib/` 未被就地覆盖时才有判别力。**CI 绿不等于 manifest 校验过**：CI 里没有 vendor 基线，`check:manifest` 会走 SKIP 分支并打 `::warning::` —— SKIP 不是通过（见上）。

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
- **不留死代码**：**第 15 轮起 `noUnusedLocals` + `noUnusedParameters` 已永久开启**（开启前实测全仓仅 5 处，已全部清掉）—— 新增未使用的局部变量 / 参数 / 死声明会让 `typecheck` 直接变红。另有 `scripts/test-audit.mjs` 的死方法 / 死字典键 / 死 CSS class 检查作为补充。（`A2-15` 原记录「无 typescript / 无 tsconfig」已在第 11 轮推翻。）
- 文案与注释以中文为主；新增 UI 文案必须同时补中英字典键。
- 交付说明里**区分「已验证」与「未验证」**：写清用什么命令、在哪个运行时、什么结果；别把「没跑」写成「通过」。

## 5. 审计台账（完整证据 → [`docs/audit-ledger.md`](docs/audit-ledger.md)）

> **台账正文在 `docs/audit-ledger.md`，只追加不删。** 本节只留索引与当前状态 ——
> `AGENTS.md` 有 **64 KiB 注入预算**，撞上后**尾部会被静默截断**（已实测），
> 所以细节一律放 `docs/`（§7.2、§11）。

**一句话历史**：13 条高危（`A1-01…A1-03`、`A2-01…A2-03`、`A3-01`、`A4-02`/`A4-03`/`A4-06`、
`A5-02…A5-04`）**已于第 8/9 轮清零**；此后转入「线上故障」轮次。

**逐轮要点见台账**（第 7–19 轮的维度、证据与结论都在 `docs/audit-ledger.md` 的 §5.11–§5.25）。

**当前状态（第 20 轮）**：高危 **13 → 0**，只剩中/低与**明确接受项**（§10）；套件 18 → **30**
（全绿、每条新门禁都做过对照）；类型错误 **243 → 0** 且基线锁 0；审计维度全覆。
自推翻的记录（**不得覆盖，只能新写**）：`D-05` 误标「已修」、`A1-02` 的冷却设计、第 13 轮自愈的修法。


## 6. 审计与迭代协议

### 6.1 每轮固定动作

1. **选定维度**：一次只审一个（manifest/声明面 · lifecycle/释放面 · composition/协商面 · permission+storage/数据面 · 门禁有效性）。
2. **禁止把 README / 注释的自我描述当事实**：任何「已有防线 / 已有约定 / 已有测试」的说法，**引用前必须实测存在**（`glob`/`grep`/实跑）。本条第 1 轮被违反，代价见台账 [`docs/audit-ledger.md`](docs/audit-ledger.md) 里的 `E-01`…`E-04`。
3. **取证**：只能报**真读过并给出 `文件:行号`** 的条目。静态推断必须显式标注为推断，不能混进「违规」。
   - **「0 命中」的结论必须先用一个已知为真的样本校准同一搜索面。** 第 7 轮实测教训：我曾用 `grep -c <pattern> bin.js` 得到 `webserver.dsh`/`browser.ui.dsh`/`HttpPrefixRoutes` 全为 `0`，**但同一命令对宿主确实在用的 `conversation.view` 也是 `0`** —— 说明搜错了产物（`bin.js` 是 CLI 入口，不是 client bundle），那个 `0` **不含任何信息**。纠正方法：先在候选产物里搜一个已知为真的字符串（`conversation.view` → 命中 `cordis-client-runner/lib/client.js` 等），再在同一批产物里搜待证字符串。
   - 这与「按动词搜日志」（台账 §5.7.5）同族：**检验方法本身也需要被检验。**
4. **登记**：按台账 [`docs/audit-ledger.md`](docs/audit-ledger.md) 的字段（严重度 / 位置 / 规范依据 / 判定 / 门禁 / 状态）写入，**只追加**。
5. **复核**：基线跑 `node scripts/run-all.mjs`，明确写出该条**是否被现有门禁拦住** —— 拦不住就是门禁盲点。
6. **沉淀规则**：若发现的是**通用形态**（不是一次性 bug），把规则补进 §2，而不是只在台账里记个例。
7. **升级门禁**：判定为「违规」且**可机械校验**的条目，必须补一个 `scripts/test-*.mjs` 断言并在 `run-all.mjs` 注册。
   - 若补了断言会让套件变红（缺陷真实存在），**先登记为待修并报告，不要为了绿而放宽断言** —— 恒绿测试比没测试更坏。
   - 新断言必须打在**生产真正使用的传输面**上（默认 `connection.fetch`），否则是 `A2-03` 式误导性绿灯。
8. **记录轮次**：在 §5 追加「第 N 轮」小节，写清维度、基线、结论。
9. **收口**：提交 + 推送 + `git status --short` **为空** + CI 绿。**「验证通过」与「已交付」是两个
   断言**，各有各的证据来源 —— 拿门禁（验工作区）的绿灯去说「已进仓库」，就是台账 §5.24 的失误。
   **上一轮的结论同样是待证事实，不是这一轮的前提。**

### 6.2 硬约束

- 台账条目**不得删除**；判定推翻要新写一条说明理由。
- 报告中**必须同时列出「符合」的证据**（哪些规范条款已落实、落在哪个文件哪一行）—— 只列问题会让后续迭代误判覆盖度。
- **禁止**为了让门禁变绿而删除断言、放宽阈值、或把 `assert` 改成 `console.log`。
- 「规范未覆盖」是合法判定：写清规范没管这件事，以及本仓库自定的处理方式。

### 6.3 门禁总表（按轮次）

**第 8 轮已实现 4 条**：`声明面一致性`（`test-route-consistency.mjs`）、`凭据不进日志`（`test-audit.mjs` ⑦）、`停止后无自续期定时器`（`test-poll-teardown.mjs`）、`teardown 优先于在飞重载`（`test-teardown-race.mjs`）。其余仍待建；按 §6.1 第 7 条实现后**会先变红**，届时按 §6.2 登记待修、**不得放宽断言**。

| 轮次 | 已实现的门禁（详细断言见 [`docs/gates.md`](docs/gates.md)） |
| --- | --- |
| 8–15 | 声明面一致性 · 传输面覆盖 · 释放面完整性 · 死代码（`noUnusedLocals`/`noUnusedParameters`）· 停止后无自续期定时器 · teardown 优先于在飞重载 · 客户端 release 面 · 恒绿断言扫描 · 门禁诊断可用 |
| 16 / 18–22 | 视图卸载不丢全屏播放器 · 音频不得硬切换（时长按 fooyin 校准）· 音频常驻输出流 + 媒体 CORS · **ReplayGain 响度归一化** |
| 待建 | `ctx 读取面一致性` · `契约坐标可解析` · `prefix 语义一致` · `凭据不进日志`（落盘面已覆盖）· `错误面脱敏` · `声明面覆盖实际调用` · `副作用前置授权` · `存储失败不得报成功`（`A5-09`） |

**逐条断言、覆盖的审计条目与负向对照证据 → [`docs/gates.md`](docs/gates.md)。**


## 7. 文档分层与关系

### 7.1 分层地图

| 文件 | 面向谁 | 放什么 | **不放**什么 |
| --- | --- | --- | --- |
| `README.md` | 使用者 / 市场复核 | 定位、截图、兼容性状态、安装与从源码运行、功能（短条目）、权限表、开发与测试命令、排查、文档索引 | 逐条技术论证、实现叙事、历史沿革、术语表、**完整端点表**（在 `docs/compatibility.md`）、**结构树**、死代码/门禁细节（在 §6.3） |
| `docs/desktop.md` | 改宿主接缝 / 排查 Desktop 问题的人 | 两代宿主形态差异、macOS 通知与「正在播放」的能力边界与验证方法、官方组件与图标命名演变、媒体直连（token 通道）的原因、技术名称表 | 与 Desktop 无关的内容 |
| `docs/compatibility.md` | DSH STORE 收录 / 供应链与权限审查 | 声明位置与取值、逐版本依据、尚未提供的证据、已知断点、依赖、权限与代码信号的对应关系、外部服务、失败边界、**端点面与信任边界**（README 在这里链接） | 使用说明 |
| `AGENTS.md`（本文件） | 改代码的人与 agent | 规范基线、不可协商的规则（§2）、可跑门禁（§3）、既有约定（§4）、审计与迭代协议（§6） | 台账正文（已移出） |
| `docs/gates.md` | 改代码 / 查门禁的人 | **门禁总表**（逐条断言、覆盖的审计条目、负向对照证据）。第 21 轮从 `AGENTS.md` §6.3 移出 | 规则本身（在 `AGENTS.md`） |
| `docs/audit-ledger.md` | 审计者 | 逐轮台账全文（证据、复现、符合项清单、编号裁定） | 规则本身 |
| `docs/images/` | README 读者 | 真机截图（音乐标签页 / 全屏 MV）。**README 顶部引用**；新增截图请降采样到 1600px 宽再入库 | —— |
| `dsh-plugin.json` `x-dsh-transition` | 跨版本核对者 | 接缝的实测记录。**升级 DSH 后按运行中的应用核对，不要按本地 checkout。** | —— |
| `src/*.ts` → `lib/*.js` | 改代码的人 | 源码在 `src/`，产物在 `lib/`；两者都提交，由 `check-build-fresh.mjs` 保证一致。见 §2.15 | 手改 `lib/` |
| `tsconfig.json` + `scripts/typecheck-baseline.json` | 改代码的人 | 类型档位与棘轮基线（当前 **0**）。**禁止为了让门禁变绿而放宽档位或上调基线** | —— |
| `tsconfig.strict.json` + `scripts/check-strict.mjs` | 改代码的人 | 逐文件收严的**允许清单**：名单里的文件必须在 `noImplicitAny: true` 下零错误。清干净一个就加一个，**禁止删**（见 §2.15） | —— |

### 7.2 分层规则（改文档前先读）

- **README 的写法对齐 DSH 官方 [`README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md)**：纯中文标题、无 emoji、每节 2–4 句 + 链接到 `docs/`、装/跑命令用 ```sh 围栏、需要被外部引用的节加 `<a id="..."></a>` 锚点。**不要在 README 里做功能堆砌**——功能列表保持短条目，细节留给截图与 `docs/`。
- **README 只放「怎么用」与「一张表」**。任何超过 3 行的论证、因果叙事、历史沿革、术语解释，**一律放 `docs/`**，README 只留一句结论 + 链接。目标：**≤ 220 行**，超出就要把内容下移。
- **深度材料不得因为「README 要短」而被删掉**。搬家时保留全部事实与数字；本仓库的 `docs/` 就是这些材料的位置。删事实需要单独的理由与记录。
- **不新增同义文档**。要写「关于 X」之前先查 §7.1 是否已有归属；有就并进去，不要开第三个讲同一件事的文件。
- **README 里不许出现未验证的数字与不在仓库里的防线**。实测数字要标注是否纳入门禁（例：性能数字标注「未纳入门禁」）；曾出现过的「headless Chrome + CDP 布局门禁」是**不实主张**，已删除，不得再写回。
- **与 README 冲突时以本文件的规范条目为准，并同步修 README。**

---

## 8. 不变量索引（不可破坏清单）

> 让接手者**不读完全文也能自检**。某条若找不到门禁，那本身就是缺口（§6.1 第 7 条要求补上）。

| # | 不变量 | 违反症状 | 门禁 | 详情 |
| --- | --- | --- | --- | --- |
| I-01 | 端点面四处逐字一致 | 端点在某个宿主形态不可达 | `test-route-consistency` | §2.7 |
| I-02 | 媒体源是 token 直连的绝对地址 | 进度条一拖就回 0 秒 | `test-mv-seek` | §2.14 §2.16 |
| I-03 | 能力 token 进程级 + 按用途分签 | 音乐全不能播 / 交叉越权 | `test-token-lifetime`、`test-security` | §2.12 §2.14 |
| I-04 | 栅栏豁免只到 Origin/Sec-Fetch，Host 必须回环 | 局域网可读库内任意文件 | `test-security` | §2.12 |
| I-05 | 每个副作用位置过 `authorize(action, scope)` | 越界读写 | `test-audit` | §2.4 |
| I-06 | teardown 后不得再启动（timer / 在飞 await / 子进程 / 全局键 / DOM） | 卸载后请求风暴、孤儿进程 | `test-poll-teardown`、`test-teardown-race`、`test-mv-teardown`、`test-teardown` | §2.2 §2.10 |
| I-07 | 凭据不进日志 / 落盘 / 持久通道 | 同机可读库内文件 | `test-audit` 凭据扫描 | §2.9 |
| I-08 | 偏离 plan、降级信任边界必须**显式报告** | 静默降级 | `test-audit` 降级上报 | §2.8 |
| I-09 | 失败不得被报告为成功 | 以为保存了其实没写 | **待建**（`A5-09`） | §2.13 |
| I-10 | `src/` 与 `lib/` 一致；`lib/` 不得手改 | 发出去的还是旧行为 | `check-build-fresh` | §2.15 |
| I-11 | 类型错误只许变少；允许清单只许加 | 类型质量倒退 | `typecheck-ratchet`、`check-strict` | §2.15 |
| I-12 | 不留死代码 | 维护成本与误读 | `noUnusedLocals` / `noUnusedParameters` | §2.15 |
| I-13 | 每个断言都必须**能变红**（禁恒绿） | 门禁形同虚设 | 人工对照 + §9 | §6.1 §6.2 |
| I-14 | 跨视图切换要保留的 UI 状态只在 player store；视图驱动的定时器归资源所有者 | 切回音乐页看到列表页 / 卡在 closing | `test-view-persistence` | §2.17 |
| I-15 | 每次过渡都淡入淡出（换源 / 启播 / 暂停 / **seek**），时长取 fooyin 默认（300/700/120ms）；无声音可淡时必须保持同步 | 耳机里的「电流声」/ 起播时序整体后移 | `test-audio-fade`、`test-audio-graph` | §2.18 |
| I-16 | 音频必须有**常驻固定采样率**的输出流；跨源接 Web Audio 必须先确认 CORS；建图后元素音量置中性 | 切歌/起播的「电流声」/ 静音 / 首次起播无声 | `test-audio-graph` | §2.19 |
| I-17 | ReplayGain 走**独立节点**；未测量 → 不做增益（≠0dB）；增益按峰值收窄；标签先收窄再夹范围 | 响度跳变 / 互相覆盖 / 削波失真 / NaN 静音 | `test-replaygain` | §2.20 |
| I-18 | 交叉淡化：两元素接进**同一**常驻 AudioContext；电平**每元素独立**；teardown 停两个 | 切歌有缝 / 用户音量被过渡压掉 / 卸载后仍出声 | `test-audio-graph`（D 段） | §2.21 |
| I-19 | 均衡器：0dB 即直通；自动前级按最大提升补偿；曲线夹 ±12dB（两处）；非法输入不动现状；缺 `createBiquadFilter` 只跳过 EQ | 削波失真 / 脏数据变刺耳 / 连常驻输出流一起丢 | `test-audio-graph`（E 段） | §2.22 |

## 9. 已知陷阱速查

> 按「写代码 / 写测试时最容易被骗的地方」排序。**每一条我都犯过并付了代价。**

1. **静态断言先剥注释** —— 说明性文字里会出现被断言的名字。我为此写出过**恒红**与**恒绿**两种坏断言。
2. **按行号判断，不要按字符偏移** —— `clientPortion` 是剥掉 CSS 块的文本，行号与源文件不一致。
3. **断言不要依赖字面缩进** —— tsc 把 8 空格重排成 16 后会**静默返回 0 个方法**。
4. **夹具保真度 = 断言判别力** —— 假媒体元素缺 `currentSrc`/`seekable`、`play()` 不模拟 `AbortError`，被测路径就失真甚至恒绿。
5. **负向对照必须重建产物** —— 门禁读 `lib/`，改了 `src/` 不 build，控制组是空的。
6. **「0 命中」先校准搜索面** —— 先用已知为真的样本（如 `conversation.view`）验证命令本身有效。
7. **一次性标志 / 冷却窗口是同一类错误** —— 任何让「无关失败」影响「真实重试」的机制都会静默失效。
8. **「清 timer」≠「阻止再武装」** —— 清句柄清不掉在飞回调的自我续期。
9. **修 bug 会点亮下游从未执行过的代码** —— 修好基址后才暴露出 cue 路径的 `AbortError` 误报。
10. **「只在出问题时记日志」不够** —— 要在**行为发生的那一刻**记（挂源时记「挂的是不是 token 源」）。
11. **「本地全绿」≠「已进仓库」** —— 第 16 轮的修复在工作区放了两轮没提交，而文档已在声称完成，
    第 17 轮推出去的代码里没有它（台账 §5.24）。**每轮收口必须看 `git status --short`**；
    `git add -A` 之后只列出少数文件，本身就是异常信号。
13. **GC 时机敏感的断言测的不是「保留量」** —— 第 24 轮 CI 实测：`arrayBuffers` 在**单次**
    `gc()` 后读到的增长，随 GC 时机漂移（同一个 commit：本地 60.0MB / CI 83.9MB，cap 64MB ⇒
    「本地绿、CI 红」）。修法是**改测量**而不是放宽阈值：① 测量进程自己别留大临时对象
    （24×6MB 的 `await r.arrayBuffer()` = 144MB 噪声源 → 改流式排空）；② 反复强制 GC 取**稳态最小值**；
    ③ 没有 `--expose-gc` 时**明说 SKIP**，不冒充通过。对照仍必须红（关掉宿主上限 → 144MB → FAIL）。
12. **禁止用 `git checkout <路径>` 撤销「临时改坏文件做对照」** —— 索引里是上一次 commit 的版本，
    这条命令会**连未提交的真改动一起回滚**。第 21 轮就这么丢掉过整个 `src/client.ts` 的
    ReplayGain 实现（台账 §5.30）。**做对照前后一律 `cp 文件 /tmp/xxx.bak` 再还原**。

## 10. 明确接受的设计取舍（**不要「顺手修好」**）

| 项 | 为什么这样 | 详情 |
| --- | --- | --- |
| `system-art` / `system-stream` 不在 `connection.fetch` 上 | 服务 Chromium 内部请求，平台 `/api` 的 `admit()` 必然拒绝。**代价**：无 `webServer` 的宿主形态不可达 | §2.7 |
| 保留 `/dsh-music` 旧前缀 | 0.1.6 形态唯一可达通路，且 `system-*` 只能挂它 | §2.7 |
| `lib/*.js` 提交进仓库 | `dsh plugin add github:` 不跑构建；显式不声明生命周期脚本 | §2.15 |
| `/library` payload 里 `mime` 为 `null` | 只有 `streamTrack` 需要 mime，客户端从不读它 | 台账 |
| 不做随机播放 / 歌词页 | 刻意保持简单 | README |
| 封面只补缺失、不覆盖已有 | 覆盖用户文件里的封面是不可逆破坏 | README |
| `noImplicitAny` 暂关 | 全开仍多 343 处；改为**逐文件允许清单**单向收严 | §2.15 |
| 客户端套件跑 jsdom，无真实盒模型测量 | 本仓库**没有**布局测量能力，相关结论一律标「未验证」 | §4 |
| token 在进程生命周期内不过期 | 唯一撤销边界是进程退出；已知代价 | §2.12 |

## 11. 扩展本文件的三条硬约束

- **64 KiB 注入预算，撞上后尾部会被静默截断**（已实测）。改完必须 `wc -c AGENTS.md`；接近 60 KiB 就把细节移进 `docs/`，这里只留结论 + 链接。
- **一条规则 = 一个失败类别**。不要为一次性 bug 加规则；先加台账条目，确认是通用形态再进 §2。
- **新增不变量必须同时加进 §8 索引并给出门禁名**；没有门禁的条目标注「待建」。推翻既有判定要**新写条目**，不得覆盖（§6.2）。
