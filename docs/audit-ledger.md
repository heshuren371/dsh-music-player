# 审计台账（完整证据）

> 本文件是 `AGENTS.md` §5 的完整版，只追加不删。规则、门禁、迭代协议在 [`AGENTS.md`](../AGENTS.md)。
> 拆出原因：`AGENTS.md` 是 workspace 指令文件，有 64 KiB 注入预算上限（撞上后尾部会被静默截断）。
# 审计台账（只追加，不删）

### 5.1 台账约定

每条登记项固定字段：

| 字段 | 含义 |
| --- | --- |
| `ID` | `D-xx`＝规范落盘时已知的偏差；`A<轮次>-xx`＝某轮审计新发现 |
| `严重度` | 高 / 中 / 低。**越权、凭据泄漏、路径逃逸、孤儿进程一律高** |
| `位置` | `文件:行号`，必须实测得到 |
| `规范依据` | `文件名:行号` + 原文关键措辞 |
| `判定` | **违规** / **符合** / **规范未覆盖** |
| `门禁` | 现有套件是否拦得住；拦不住就是**门禁盲点**，必须记下来 |
| `状态` | 待修 / 已修 / 接受（附理由） / 待定 |

**只追加不改判**。已修项保留原始记录并补 `已修` 与修复 commit；判定被推翻的写新的 `A<轮>-xx` 说明推翻理由，不覆盖旧条目。

### 5.2 第 0 轮 —— 规范落盘时记录的既有偏差

改到这些地方时**不要扩大偏差**，要收窄或按「处置方向」修：

| ID | 严重度 | 偏差 | 规范依据 | 处置方向 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `D-01` | 中 | `requires.contracts` 未声明 `storage.dsh/v1alpha1` / `LocalStorage`；插件自己往 `$DSH_HOME/storages/dsh-music-player.json` 写文件（消耗 `fs.write`） | `storage.zh.md:20` consumer 通过 protocol requirement 声明 | 要么改走协议 provider，要么在 manifest/README 显式说明这是自建文件存储而非协议消费 | 接受（已在 README 声明为自建存储） |
| `D-02` | 低 | 权限名 `storage.local` 不是规范动作名 `storage.local.read` / `storage.local.write` | `storage.zh.md:75` | 若改用 LocalStorage 协议，拆成 `.read` / `.write` | 待定 |
| `D-03` | 中 | 自建「能力 token」（`/api/dsh-music/system-art?t=…`）把 URL 里的 token 当凭证 | `permission.zh.md:82` grant record 不是可重放 bearer token、不能用 grant id 构造权限 | 不走 grant 而是自建路径凭证。必须保证：token 随机、只随鉴权过的 session 下发、**不进日志**（`lifecycle.zh.md:133`、`storage.zh.md:101`） | 待定（见 `A1-02`） |
| `D-04` | 低 | 封面代理用主机后缀匹配（`.mzstatic.com` 等）判断资源范围 | `permission.zh.md:119` 不得用字符串前缀等未规定方法判断域名 scope | 产品侧尚无该机制时的插件内补偿栅栏；上游提供标准 scope 后迁移 | 接受 |
| `D-05` | 低 | `contributes["x-dev.dsh-std.extensions"]` / 顶层 `x-dsh-transition` 是自定义扩展 | `manifest.zh.md:64` 扩展不得暗含 required 行为 | ~~已把 `browser.ui.dsh/v1alpha1` 标 `optional: true` 并补 `fallback`~~ → **判定推翻，见 `A4-02`/`A4-03`**：该坐标在基线与宿主都是 0 命中（编造的），**补 `fallback` 不构成修复**，只让空壳声明看起来完整 | **待修**（原标「已修」有误，`§5.10` 记录更正） |
| `D-06` | — | `dsh-plugin.json` 不被 DSH 运行读取（0.1.7-rc.2 全仓 0 处引用） | —— | 它是生态/市场侧产物。改它**不影响运行时**，但改了仍必须跑 `check:manifest` | 接受（事实记录） |

### 5.3 第 1 轮 —— Lead 自审：路由注册面 + lifecycle 释放面

基线：`node scripts/run-all.mjs` → **18/18 PASS**。**下列 6 条没有任何一条被现有门禁拦住。**

| ID | 严重度 | 一句话 | 规范依据 | 门禁 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `A1-01` | 高 | `host.js` 实现 18 个端点，`connection.fetch` 只注册 11 个，`manifest` 只声明 10 个 —— 三方漂移，7 个端点在无 `webServer` 的宿主形态下不可达 | `manifest.zh.md:64`、`composition.zh.md:82`、`:143` | ❌ 盲点 | 待修 |
| `A1-02` | 高 | 客户端「一次性回落探测」用 **404** 作「宿主是旧入口」的信号，而 404 在本插件是正常业务语义（无封面 / MV 缓存未命中），会被无关 404 提前烧掉；探测成功则永久降级到旧前缀，**丢掉 `/api` 连接层信任栅栏** | `composition.zh.md:143`、`permission.zh.md:86` | ❌ 盲点 | 待修 |
| `A1-03` | 高 | `mvJobs` 永不删除且 `dispose()` 不终止在飞 ffmpeg 子进程 —— 卸载/热重载后孤儿进程继续跑；Map 无界增长；module 级状态随 ESM 注册表**每次热重载永久泄漏一份** | `lifecycle.zh.md:107`、`:105`、`:118` | ❌ 盲点 | 待修 |
| `A1-04` | 中 | 热重载先 `dispose()` 旧实例再 `import()` 新实例；新实例创建失败时旧实例已销毁，无回滚/降级（仅下一次请求重试） | `composition.zh.md:143` | ❌ 盲点 | 待修 |
| `A1-05` | 中 | HTTP 错误响应把 `error.message` 原样返回，泄漏本地文件名/绝对路径（如 `文件不存在：<歌名>`、Node `ENOENT ... '/Users/...'`） | `storage.zh.md:95`、`permission.zh.md:111`、`lifecycle.zh.md:133` | ❌ 盲点 | 待修 |
| `A1-06` | 低 | `registerLegacyRoute` 有被双次注册的边界（`connection` 在但 `connection.fetch.register` 不可用时会与 `webServer` 回调各注册一次） | `composition.zh.md:118` 无通用「最后注册者覆盖」 | ❌ 盲点 | 待定（防御性缺口，真实 DSH 走不到） |

### 5.4 第 1 轮证据与复现

**`A1-01` —— 三方漂移（实测，非静态推断）**

用真实 `apply()` 抓注册面，与 `host.js` 的分派表、`dsh-plugin.json` 的 `endpoints` 对照：

```
host.js 实现     : 18
connection.fetch : 11
manifest 声明：10

❌ 实现了但没注册到 connection.fetch (7)：
   /api/dsh-music/caps        /api/dsh-music/mv        /api/dsh-music/mvconvert
   /api/dsh-music/mvfile      /api/dsh-music/mvlib
   /api/dsh-music/system-art  /api/dsh-music/system-stream
❌ 实现了但 manifest 没声明 (8)：上述 7 个 + /api/dsh-music/session
⚠️  注册了但 host.js 没有对应分派：无
```

- 注册面：`lib/index.js:25-37`（`FETCH_ROUTES`）；分派面：`lib/host.js:1769-2117`（18 条 `pathname === …`）
- **`connection.fetch` 是精确路径匹配，不是前缀**：`dsh 0.1.7-rc.2` 的 `packages/client/connection/lib/index.js:625-634` 用 `fetchRoutes` Map 按 `route.path` 精确查表，重复路径直接抛 `exact Fetch route … is already registered`
- 后果：`x-dsh-transition` 明确声明支持「0.1.6 形态的 desktop-host」（`webServer` 行被 `disabled: true`，**只有 `connection`**）。在该形态下这 7 个端点全部 404 → **MV 播放、MV 进度拖动、Desktop 封面（`system-art`/`system-stream`）全断**。这与 `lib/index.js:139-141` 自述的「Desktop 上这是唯一可达的通路」直接矛盾
- 门禁盲点：`scripts/test-desktop-routes.mjs:104-118` 的 `expected` 列表是**手工硬编码的同一份 11 条**，断言写成 `expected.every(p => routes.has(p))` —— 只查单向包含，且期望值来自注册面而非分派面，**结构上无法发现这次漂移**

**`A1-02` —— 404 当信号 + 静默降级**

- `lib/client.js:664-673`：`if (response.status === 404 && !endpointProbed) { endpointProbed = true; … }`，且 `endpointProbed = true` 写在探测**之前**（`:667`）
- 正常业务 404 的来源：`lib/host.js:1696`/`:1715` `no embedded cover`、`:2042`/`:2094` `mv cache miss`、`:1472`/`:1474` `文件不存在：`、`:1370`/`:1466` `track not in current library`
- 后果一：Web/Desktop 上第一次碰到**无封面的曲目**或 **MV 缓存未命中**，就把唯一一次回落窗口烧掉 —— `A1-01` 那 7 个端点在需要回落时救不回来
- 后果二：若探测**成功**，`endpointBase` 被永久切成 `LEGACY_API_BASE`（`/dsh-music/api`），而 `x-dsh-transition` 自己写明「信任边界交给连接层：Web/0.1.7 Desktop 走 `/api` 的 Host/Origin 栅栏 + 浏览器会话」—— 切成旧前缀等于**放弃连接层栅栏**，降级为插件自建检查。这属于 `composition.zh.md:143` 说的「悄悄把降级当正常」

**`A1-03` —— 孤儿 ffmpeg + 无界增长 + 每次热重载永久泄漏**

- `lib/host.js:157` `const mvJobs = new Map()` 是 **module 级**；全文只有 `:235` `get` 与 `:241` `set` —— **`mvJobs.delete` / `.clear` / 容量上限全都没有**（已 grep 确认）
- `lib/host.js:2176-2192` `dispose()` 清了 `library`、封面/art/match 缓存、tag worker，**完全没有触碰 `mvJobs` 或 `job.child`**（已 grep 确认无 `mv`/`child`/`kill` 字样）
- `:199-200` 把 `spawn()` 出的 `ChildProcess` 存进 `job.child`，无 `AbortController`、无 `kill` 路径
- 后果：(a) 卸载/热重载后 ffmpeg 继续跑到结束，往 `os.tmpdir()/dsh-music-mv` 写 `.part`；(b) `mvJobs` 每首视频一条记录，每条持 `ChildProcess` 引用 + 最多 4000 字符 `job.log`，**无上限**；(c) `lib/index.js:54-58` 自己说明「每次 import 都会在 ESM 注册表里留下一个无法卸载的模块条目」，而 module 级 `mvJobs` 随该条目被永久持有 —— **每次热重载永久泄漏一份**
- 对照（说明这是同一模式漏了一处，不是设计取舍）：tag worker 路径**做对了** —— `:1281-1287` `failAllTagJobs` 清 timer + resolve + delete 条目，`:2182-2191` dispose 里 `failAllTagJobs()` + `tagWorker.terminate()`，`:1312`/`:1336` 双 `unref()`
- 门禁盲点：`scripts/test-lifecycle.mjs` 覆盖面不弱（`:62` dispose 后路由摘除、`:69` 在飞扫描取消、`:82`/`:83` 5 轮无资源/句柄增长、`:84` dispose 后进程空闲），但它只驱动 `/api/library` 扫描，**从不启动 MV 任务**，所以测不到

**`A1-04` / `A1-05` / `A1-06` 位置**

- `A1-04`：`lib/index.js:67-81`（`dispose()` → `host = null` → `await import()` → `createHost()`；后两步任一抛错即 `host` 停在 `null`）
- `A1-05`：`lib/index.js:91`（`failResponse`）与 `:112`（`handleRequest`）都返回 `error.message`；错误文本来自 `lib/host.js:1472`/`:1474`（`'文件不存在：' + track.name`）。Node `fs` 报错本身含绝对路径
- `A1-06`：`lib/index.js:196-202`

### 5.5 第 1 轮结论

- 现有 `npm test`（18 套，全绿）**与这 6 条发现完全不相交** —— 门禁的失败面集中在「功能对不对」和「进程句柄有没有涨」，**没有一条覆盖「声明面 ↔ 注册面 ↔ 分派面是否一致」**。
- 因此第 1 轮最该补的不是功能测试，是**一致性门禁**：见 §6.3。

### 5.6 第 2 轮 —— 门禁有效性 + 传输面覆盖

基线：`node scripts/run-all.mjs` → **18/18 PASS**（Node v24.21.0，DSH 0.1.7-rc.2 / `477b4f42`）。本轮由独立审计员产出，Lead 逐条复核。

| ID | 严重度 | 一句话 | 规范依据 | 门禁 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `A2-01` | 高 | 一个已提交进 HEAD 的 `TEMP DIAGNOSTIC` 探针把**每个请求（含 query 里的能力 token）**明文落盘到 `/tmp/dshm-probe.log`；该写盘不在任何已声明 permission scope 内，且挡在路由分发之前 | `storage.zh.md:101`、`permission.zh.md:55`/`:111`、`lifecycle.zh.md:133` | ❌ 盲点 | 待修 |
| `A2-02` | 高 | README:270 主张的「真实 Chromium + CDP 量布局」防线**在仓库里不存在**；8 个客户端套件全走 jsdom | 文档与代码不符 | ❌ 盲点 | 待修 |
| `A2-03` | 高 | **传输面覆盖 1/10**：只有 `test-desktop-routes` 驱动 `connection.fetch`；`test-mv` 只注入 `webServer` → 「MV PASS」验证的是**旧前缀通路**，Desktop 的 `connection.fetch` 通路零覆盖且 5 个 MV 端点在该通路不可达 | `composition.zh.md:143` | ❌ **误导性绿灯** | 待修 |
| `A2-04` | 中 | README:195「匹配套件会真实联网」与代码相反：`test-match.mjs:5` 自述 hermetic，`:45-108` stub `globalThis.fetch` | 文档与代码不符 | ❌ | 待修 |
| `A2-05` | 中 | README:163「macOS 走 `~/.Trash`」与实际不符：`/api/delete` 是 `fs.unlink`（`lib/host.js:2133`）**永久删除**；`~/.Trash` 只在 MV 的 `deleteOriginal` 路径（`:1990-1996`） | 文档与代码不符 | ❌ | 待修 |
| `A2-06` | 中 | README HTTP API 表只列 10 条，实际 18 条 —— 属 `A1-01` 在文档面的投影 | `manifest.zh.md:64` | ❌ | 待修 |
| `A2-07` | 中 | 宿主侧删除流程无门禁：无套件断言一次成功删除真的删了文件 / 更新了库；`/api/delete` 越界 403 未测 | `permission.zh.md:86` | ❌ 盲点 | 待修 |
| `A2-08` | 中 | 列头排序 / 搜索过滤（n/N）/ 排序记忆有代码无门禁（`sortKey`/`toggleSort`/`dshm-sorted` 在 `scripts/` 零命中） | 门禁缺失 | ❌ | 待修 |
| `A2-09` | 中 | README:41 的性能数字（53MB 主线程阻塞 90ms→1ms）无门禁；`test-perf` 量的是扫描/缓存/fd/idle | 门禁缺失 | ❌ | 待修 |
| `A2-10` | 低 | `test-stream.mjs:101` 断言体是字面 `true` | 恒真断言 | 该行恒绿 | 待修 |
| `A2-11` | 低 | `test-mv.mjs:90`/`:101` 无 ffmpeg 时退化为 `check(…, true, 'skipped')`，门禁无法区分「跳过」与「通过」 | 条件恒绿 | 本机否 / 无 ffmpeg 时是 | 待修 |
| `A2-12` | 低 | `run-all.mjs:34` 优先级 bug 吞掉 stderr（`stdout ?? '' + stderr ?? ''`），导入期崩溃的套件只显示 `FAIL <name>` 无诊断 | 门禁可用性 | — | 待修 |
| `A2-13` | 低 | `test-audit.mjs:76` BEM 检查是唯一无非空护栏的检查，CSS 解析器失配即恒绿 | 潜在恒绿 | 本机否 | 待修 |
| `A2-14` | 低 | Windows 保留设备名 / 结尾点空格过滤（`lib/host.js:1190-1201`）无测试，README:42 明确主张 | 门禁缺失 | ❌ | 待修 |
| `A2-15` | 低 | `/api/apply` 串行锁（`lib/host.js:1720-1727`）无并发用例，README:42 主张消除竞态 | 门禁缺失 | ❌ | 待修 |
| `A2-16` | 低 | 旧 `lib/state.json` 迁移（`lib/host.js:933-942`）无测试 | 门禁缺失 | ❌ | 待修 |
| `A2-17` | 低 | 文件名序号清洗只断言「合法前导数字被保留」，**清洗行为本身未断言** | 门禁缺失（部分） | ❌ | 待修 |
| `A2-18` | 低 | `lib/host.js:327` 注释「差 >10s 一律不自动写入」与实现不符：`delta == 10` 时 `durationScore` 返回 `0.55` 仍放行（`:494-496`、`:555-556`） | 文档与代码不符（注释） | ❌ | 待修 |
| `A2-19` | 低 | 本仓库无 `typescript`、无 `tsconfig.json`，`tsc --noUnusedLocals` **无法执行** | 约定不可执行 | — | 已修（§4） |

#### 5.6.1 `A2-01` 证据（凭据落盘，实测）

- 代码：`lib/host.js:1736-1757`，注释自称「TEMP DIAGNOSTIC（排查完删掉）」，`await fs.appendFile('/tmp/dshm-probe.log', JSON.stringify({ …, url: req.url, host, origin, referer, cookie: !!cookie, ua }) + '\n')`，位于 `dispatch()` 开头、**路由分发之前**
- 已提交：`git show HEAD:lib/host.js | grep dshm-probe` → 命中 `:1740`；`git status --porcelain lib/host.js` 为空（工作树 == HEAD `389b6e5`）
- 实机文件：`/tmp/dshm-probe.log` **549842 字节 / 2620 行**，`grep -c 'system-\(art\|stream\)?t='` → **5 行含能力 token**；`"via"` 分布 `legacy=2495 / fetch=120 / system-art=5`
- scope 越界：`dsh-plugin.json` 的 `fs.write` scope 是「当前音乐目录内、且在播放列表中的音频文件」，`storage.local` scope 是 `$DSH_HOME/storages/…` + localStorage —— **`/tmp` 两者都不是** → 违反 `permission.zh.md:55`
- 安全属性：文件权限 `-rw-r--r--`（**同机其他用户可读**）

#### 5.6.2 `A2-03` 证据（为什么 18/18 全绿却仍漏掉 `A1-01`）

逐套件统计「驱动哪条传输面」（`grep -c connection` / `grep -c webServer`）：

```
test-desktop-routes.mjs                  connection=10  webServer=5   ← 唯一驱动 connection.fetch
test-stream/security/perf/lifecycle/
     match/apply/mv/hot-reload           connection=0   webServer=1   ← 全靠旧 /dsh-music 前缀
test-progress/resume/refresh-remap/
     restore-race/teardown/delete/
     client-shell/match-client/audit     connection=0   webServer=0   ← 纯 jsdom，打桩 fetch
```

`test-mv.mjs:50` 只注入 `webServer: { register }`，**没有 `connection`** → 它验的是旧前缀通路。而 `mv`/`mvfile`/`caps`/`mvlib`/`mvconvert` **不在 `FETCH_ROUTES`** 里，`connection.fetch` 又是精确匹配 → **Desktop 走的那条通路既不可达、又零覆盖**。客户端确实在调它们（`lib/client.js:1136-1138`、`api("/api/mv?id=")`）。这解释了 `A1-01` 为什么能在「MV 套件 PASS」的同时为真。

#### 5.6.3 Lead 自身错误（本轮建立，必须单列）

| ID | 我做了什么 | 为什么错 | 已修 |
| --- | --- | --- | --- |
| `E-01` | 在 README「依赖、权限与失败边界」里写「`fs.delete`：删除曲目（**macOS 走 `~/.Trash`**）」 | 我看到 `host.js:1992` 有 `~/.Trash` 字符串就当成删除路径，**没核实它属于 MV 的 `deleteOriginal` 分支**；实际 `/api/delete` 是 `fs.unlink` 永久删除（且与 README:17 自相矛盾） | README 待修（`A2-05`） |
| `E-02` | 在 README 里写「`npm test` 中的匹配套件会真实联网……**不是离线测试**」 | 我**只看了套件名字**（"online metadata match"）就下结论，没读 `test-match.mjs:5` 的 `hermetic` 自述与 `globalThis.fetch` 桩 | README 待修（`A2-04`） |
| `E-03` | 在 AGENTS.md §4 把 README:270 的「真实 Chromium + CDP 量布局」写成既有防线 | 把 **README 的自我描述当成事实**，没验证仓库里有没有浏览器启动器 | ✅ 已修 §4（标注为 ❌ 不存在） |
| `E-04` | 在 AGENTS.md §4 写「改完用 `tsc --noUnusedLocals --noUnusedParameters` 扫一遍」 | 抄自 `.jspace/WORKSPACE.md` 的历史条目，没核实 `typescript`/`tsconfig.json` 是否存在 | ✅ 已修 §4（标注为不可执行） |

> **教训（已沉淀为 §6.1 第 2 条）**：**README 的自我描述不是事实来源。** 任何「本仓库已有 X 防线 / 已有 Y 约定」的说法，引用前必须实测存在（`glob`/`grep`/实跑）。

#### 5.6.4 第 2 轮结论

现有门禁的**骨架真实有效**（18/18 实跑通过；失败能真的非零 —— 负向对照 `DSH_MUSIC_HOST=/dev/null node scripts/test-perf.mjs` → exit 1；18 个 `test-*.mjs` 与 `run-all.mjs` 的 `suites` 集合完全一致；静态审计 6 项与按钮接线防线均落地；封面策略 / 安全栅栏 / 生命周期有硬断言）。**但**它强在「功能对不对」与「句柄涨不涨」，在三个面是空的：

1. **声明面 ↔ 注册面 ↔ 分派面一致性**（`A1-01`）
2. **传输面覆盖** —— 1/10 套件打在生产使用的通路上（`A2-03`），这使第 1 类缺陷**表现为绿灯**
3. **module 级容器与子进程的释放**（`A1-03`）

### 5.7 第 3 轮 —— Lifecycle 释放面（客户端 + 宿主）

基线沿用 §5.3 的 18/18 PASS（本轮只读，未重跑）。独立审计员逐行读 `lib/index.js` / `lib/host.js` / `lib/client.js` / `lib/tagwriter.js` / `lib/http-bridge.js` 及 cordis、`dsh-client-runtime` 的 vendored 实现。

| ID | 严重度 | 一句话 | 规范依据 | 门禁 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `A3-01` | 高 | **客户端库轮询定时器在停用后自我续期**：`halt()` 只在 `pollTimer !== null` 时能清；若 teardown 撞上某次轮询在飞（回调开头已把 `pollTimer` 置 null），该请求 404 → `catch { schedulePoll(); }` 再武装，而 `halt()` 的 `set()` **不重置 `scanning`** → `if (!state.scanning) return` 永不成立 → **永久 1.5s 请求风暴** | `lifecycle.zh.md:107`、`:29` | ❌ 盲点 | 待修 |
| `A3-02` | 中 | **卸载与在飞 `ensureHost` 竞态**：`ensureHost` 有两个 await 挂起点，teardown effect 只把 `host = null`，**无 `disposed` 标志**；挂起的 IIFE 恢复后照样 `host = module.createHost(ctx)` → 产生**无人持有的新 host**（会 `startScan` + 可能拉起 tag worker），此后再也没人 `dispose()` 它 | `lifecycle.zh.md:29`、`:107` | ❌ 盲点 | 待修 |
| `A3-03` | 中 | **客户端 player 经 `window.__dshMusicPlayer` 跨 activation 复用**：bundle HMR 换代后新 module 不再 `createPlayer()`，直接接管旧 closure 的全部 handler / timer / `playingId`；新旧 activation 的 disposer 操作**同一个 player** → 旧 disposer 会对新实例仍在用的对象调 `halt()` | `lifecycle.zh.md:125`、`:127` | ❌ 盲点 | 待修 |
| `A3-04` | 中 | 停用后 `document.body` 上的自建 DOM（`.dshm-mvPark` + `<video>`）与 `window.__dshMusicPlayer` **从不释放**；`halt()` 既不 `remove()` 也不清 window 键 | `lifecycle.zh.md:107` | ❌ 盲点 | 待修 |
| `A3-05` | 中 | **Activation context 读取未在 manifest 声明的产品 API**：`ctx.get('directoryPicker')`（`lib/host.js:1907`）、`ctx.locale`（`lib/client.js:3169`）、`connection.fetch`（`lib/index.js:145`）都**不是** `requires.contracts` 条目 —— `dsh-plugin.json` 全文 grep `directoryPicker` **0 处**，`connection.fetch` 只出现在权限 scope 文本与扩展 `spec.transport` 里 | `lifecycle.zh.md:82` | ❌ 盲点 | 待修 |
| `A3-06` | 低 | `registerFetchRoutes` 组内按**注册正序**摘除（11 条路由在一个 `ctx.effect` 里注册，对 coordinator 只有 1 个 disposer；逆序条款绑定 scope 的 disposer 序列，不绑定插件自建数组次序）→ **规范未覆盖** | `lifecycle.zh.md:105` | ❌ 盲点 | 接受 |
| `A3-07` | 低 | `mvconvert` 用 `spawnSync(ffmpeg, …, { timeout: 30 * 60 * 1000 })`（`lib/host.js:1983`）→ 事件循环被独占至多 **30 分钟**，deactivation 无法推进，且无句柄可 `kill`、无 timeout 诊断 → 规范 L121 义务主体是 coordinator，但 **L145 描述的风险真实存在** | `lifecycle.zh.md:121`、`:145` | ❌ 盲点 | 待定 |
| `A3-08` | 低 | `matchWaiters`（`lib/host.js:378`）无 `clear`/`delete` 路径 —— 但会随任务完成自行 `shift` 排空，上游请求都带 `AbortSignal.timeout`，**不是真实泄漏**；不满足新增 §2.2「容器必须留 clear 路径」的字面要求 | 仓库自定 §2.2 | ❌ 盲点 | 接受（非泄漏） |

#### 5.7.1 `A3-01` 证据（与历史 bug 同族，但修复是逐路径的）

```
lib/client.js:934-946   pollTimer = setTimeout(async () => { pollTimer = null;
                          if (!state.scanning) return;          ← 唯一守卫
                          try { applyLibrary(await api("/api/library")); }
                          catch { schedulePoll(); }             ← 失败即再武装
lib/client.js:989       schedulePoll();                          ← 成功路径也再武装
lib/client.js:1771-1799 halt: clearTimeout(pollTimer); … set({ playing: false,
                          pendingDelete: -1, current: -1, error: null, … })
                                                     ← set() 里没有 scanning
lib/client.js:790       scanning 初值
```

历史 bug 复核（**确已修好**）：自动续播 `recoverAt`（`:1591-1602`）与自动跳曲（`:1668-1670`）经 `halt()` → `stopAudio()`（`:857-862`，`playingId = null`）+ `set({current:-1})` 使三处延迟回调的守卫全部落空，且 `test-teardown.mjs:74-83` 有回归断言。**但修复是逐路径的、不是结构性的** —— 轮询这条同类路径漏了。
`test-teardown.mjs:44` 的假 payload 写死 `scanning: false`，**结构上测不到**。

#### 5.7.2 本轮推翻的怀疑（必须记录，避免后续重复怀疑）

- **`ctx.slots.inject(...)` 未显式包 `ctx.effect` → 不是违规。** 读 vendored `@deepseek-ai/dsh-client-runtime` 实现确认：它**内部调用调用者的 `ctx.effect`**（`lib/client.js:55-113`，`:57` `const disposeController = ctx.effect(...)`、`:81` `const disposeEffect = ctx.effect(callback, ...)`；`:15` 文档写明「declaration injection through the caller's ctx.effect (fiber unload collects both)」）。→ `lib/client.js:3183` **符合** L29。
- **插件内部路由已在该换新 module 后重新解析**：`handleFetch`/`handleRequest` 每次 `await ensureHost()`（`lib/index.js:98-124`），路由**不**随实例重复注册 → 宿主侧**不存在**「旧路由被转移到新实例」。L125/L127 的违规面只在客户端（`A3-03`）。

#### 5.7.3 第 3 轮符合项（逐条款证据）

| 规范条目 | 判定 | 证据 |
| --- | --- | --- |
| L29 激活期注册绑 cleanup scope | ✅ 符合 | 宿主 `lib/index.js:146-162`/`:170-177`/`:182-191`；客户端 `lib/client.js:3169`/`:3174`/`:3175-3182`；`ctx.slots.inject` 见 §5.7.2 |
| L107 自建资源由 deactivate 释放 | ⚠️ 大部分符合 | ✅ `lib/host.js:2182-2191`（`failAllTagJobs` + `terminate` + 置 null）、`:1281-1287`（逐 job 清 timer/resolve/delete）、`:2179-2181`（清三类缓存）、`:2177`+`:1543`（`scanGeneration` 协作取消在飞扫描）、`:1312`/`:1336` 双 `unref()`；客户端 `lib/client.js:1770-1799`（`halt()` 清 `pollTimer`、`matchSeq += 1` 作废在途 match、`stopAudio`、清 MediaSession）。缺口见 `A3-01`/`A3-02`/`A3-04`/`A1-03` |
| L105 关闭顺序/至多一次/失败不阻塞 | ✅ 符合 | vendored cordis `lib/index.js:1168-1184`：`:1175` `if (disposing) return disposalTask`（幂等）、`:1178` `disposables.splice(0).reverse()`（逆序）。插件侧 `lib/index.js:154-160` 逐条 try/catch；`host.dispose()` 两处调用点都 try/catch（`:69-73`、`:184-189`） |
| L133 不持久化 context/凭据/异常对象 | ✅ 符合 | 持久化面仅 `lib/host.js:1035-1043`（只写 `{dir}`，temp+rename 原子）与 `lib/client.js:680-702`（只写音量/循环/排序/上次 id 与秒数）。能力 token `:1520` `randomUUID()` 每实例新生成，只出现在 `:2110-2113` 的 `/session` 响应里；`grep console.* lib/host.js` = **0 处** |
| L165 / L22 不得依赖 module 卸载完成清理 | ✅ 设计符合 | `lib/index.js:54-58` 注释**主动承认** ESM 注册表条目无法卸载，并用 `RELOAD_MIN_INTERVAL_MS` 限流；清理靠显式 `host.dispose()`（`:68-75`、`:182-191`）而非 GC；`dispose()` 主动清 module 级缓存（`lib/host.js:2179-2181`）避免被不可回收的 module 钉住 |
| L139 Observer 不得改变状态机 | 规范未覆盖 | `grep ctx.on/ctx.emit/ctx.before/ctx.after lib/` = **0 处**，无监听面 |
| L5 / L58 纯声明 facet 无 activation instance | 规范未覆盖 | `dsh-plugin.json:7-12` 只有可执行 `facets.host`；客户端 UI 走 `contributes["x-dev.dsh-std.extensions"]` 由宿主装配 |
| L118 停止后验证 support/owner 移除 | 规范未覆盖（coordinator 职责） | 外部机械验证：`test-lifecycle.mjs:62`（route unregistered on dispose）、`:69`（在飞扫描取消）、`:82`/`:83`（5 轮无资源/handle 增长）、`:84`（idle CPU） |
| L121 超 deadline 留 timeout 诊断 | 规范未覆盖（无 deadline 机制） | 仅 tag worker `TAG_WORKER_TIMEOUT_MS`（`:1275`、`:1325-1335`）超时后 resolve 带 `'标签写入超时'` 而非报告成功 —— 符合该条**精神**。风险面见 `A3-07` |

#### 5.7.4 第 3 轮结论

生命周期维度的**结构性事实**：宿主侧（`lib/index.js` + `lib/host.js`）对 L29/L105/L133 落实得比较扎实，且作者**主动承认**了 module 不可卸载；**缺口集中在两类**：

1. **「teardown 之后还能再启动」** —— `A3-01`（客户端轮询自我续期）、`A3-02`（宿主再创建孤儿 host），两者都缺同一个状态位（`disposed`）。这是 §2.2 高危区的**真实复发形态**，只是换了个入口。
2. **客户端 activation 的 instance 归属** —— `A3-03`/`A3-04`：`window` 全局复用让 instance 边界消失，disposer 变成共享对象上的操作。

#### 5.7.5 本轮判定撤回（`§6.2` 要求：判定推翻必须新写一条，不覆盖旧条目）

审计员在补读完 `lib/host.js:1710-1930`（首轮漏读的区间，正含 `A2-01` 探针）后**主动撤回**自己先前的判定：

| 条款 | 原判定 | 改判 | 原因 |
| --- | --- | --- | --- |
| `L133` 不持久化 context / 凭据 / 异常对象 | 符合（并把「token 不进日志」列为证据） | **违规** | 反例即 `A2-01`：`lib/host.js:1740` 把 `req.url`（含 `?t=<能力token>`）落盘。该条已由 `A2-01` 登记，此处只更正判定 |

**方法错误（必须沉淀，这是本轮最有价值的一条）**：审计员用 `grep "console\.\(log\|error\|warn\|info\)"` 来证明「凭据不进日志」，得出「`lib/host.js` 0 处 → 符合」。**但落盘型诊断走的是 `fs.appendFile`，代码里根本没有 "log" 这个词。**

→ **核查「是否把凭据写进日志/诊断」必须按「写盘 / 输出动词」搜索，不能按 "log" 这个词搜索。** 最小搜索面：

```
console.log|error|warn|info|debug   appendFile|writeFile|createWriteStream|writeFileSync
process.stdout|process.stderr       第三方 logger（pino/winston/bunyan/…）
```

已沉淀为 §6.1 第 3 条。

### 5.8 第 4 轮 —— Manifest 声明与契约一致性（manifest + composition）

基线：`check-manifest.mjs` → **PASS**（只证 schema 结构，不证可激活）。独立审计员产出。

| ID | 严重度 | 一句话 | 规范依据 | 门禁 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `A4-01` | 高 | `endpoints` 三方漂移（= `A1-01` 的独立复核，不再单列） | 同 `A1-01` | ❌ | 待修 |
| `A4-02` | 高 | **插件主功能在 manifest 上是未声明的**：会话视图 + 宿主传输只以「无 definition 扩展」声明；三个扩展 id 在 `lib/` 下**逐个 grep 均 0 命中**；pinned 投影把三条扩展并入 host facet，对无 definition 扩展只产出 `unknown-extension` **warning** | `manifest.zh.md:64`、`:62`、`composition.zh.md:110` | ❌ 盲点 | 待修 |
| `A4-03` | 高 | **两条契约坐标是编造的**：`webserver.dsh/v1alpha1` 与 `browser.ui.dsh/v1alpha1` 在**整个 references 树 0 命中**、在 **DSH 0.1.7-rc.2 app.asar 里也 0 命中**；真实坐标是 `ui.dsh/v1alpha1`/`ContributionHost`（基线）与 `web.ui.dsh/v1alpha1`（adapter）。且 `requires.contracts` **无任何 required** → preflight 永不阻塞，可在**零端点注册**下「激活成功」（`lib/index.js:193-206`） | `manifest.zh.md:56`、`:64`、`composition.zh.md:80`、`:82`、`:143` | ❌ 盲点 | 待修 |
| `A4-04` | 中 | `fallback` 文案方向写错且夸大：`webserver` 那条说「宿主没有 webServer 时…端点改挂 connection.fetch」——实际 `/api` 路由是**无条件优先注册**的，`webServer` 只注册 `/dsh-music` 旧前缀；「照常激活」掩盖了 7 个端点在无 webServer 形态下不可达 | `manifest.zh.md:98-101` | ❌ | 待修 |
| `A4-05` | 中 | `prefix` 与精确路由语义冲突：声明 `HttpPrefixRoutes` 的 `prefix=/api/dsh-music` + `transport: connection.fetch`，代码注册 11 条**精确**路径，`webServer` 上注册的是另一个前缀 `/dsh-music` → 三处对不上 | `composition.zh.md:65`、`:143` | ❌ | 待修 |
| `A4-06` | 中 | `ContributionHost` 无 surface 列表 → **结构上永远形成不了 agreement**（Community v0.15 的 contract 引用字段只有 apiVersion/kind/optional/fallback，装不下 surfaces） | `ui-contribution.zh.md:58`、`:115`、`composition.zh.md:80` | ❌ | 待修 |
| `A4-07` | 低 | 顶层 `x-dsh-transition` 被 pinned 投影整段丢弃 → 跨版本声明不进入 provenance/composition（规范未覆盖：pinned validator 行为） | `manifest.zh.md:128` | ❌ | 接受 |
| `A4-08` | 低 | `package.json dsh.compatibility` 范围宽于精确证据（0.1.6 线零记录，与 `x-dsh-transition` 的 0.1.6 实测叙述不对称） | `manifest.zh.md:113`（同原则） | ❌ | 待定 |
| `A4-09` | — | **符合**：`dsh-plugin.json` ↔ `package.json` 重复项一致（version/license/source/entry/exports/files 全对得上）；`files` 无运行时必需文件缺口 | — | ✅ | — |
| `A4-10` | 低 | `facets.host.apiVersion` 被 pinned 投影忽略（实现缺口，非本仓库违规） | `manifest.zh.md:107-108` | ❌ | 接受 |

### 5.9 第 5 轮 —— Permission + 敏感数据泄漏

基线沿用 18/18 PASS。独立审计员产出（只读，含对运行中 DSH 0.1.7-rc.2 asar 的只读核对）。

| ID | 严重度 | 一句话 | 规范依据 | 门禁 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `A5-01` | 高 | = `A2-01` 独立复核（凭据落盘）。新增实测：`/private/tmp/dshm-probe.log` 含 3 行 `system-art?t=` + 2 行 `system-stream?t=`，token 为 36 字符完整 UUID | `permission.zh.md:105`/`:111`、`storage.zh.md:101` | ❌ 盲点 | 待修 |
| `A5-02` | 高 | **单一 token 同时授权 `art` 与 `stream`**（后者=任意曲目全量读），进程生命周期内**不过期、无轮换、不按 session 区分**；唯一撤销边界是 `createHost` 闭包销毁 | `permission.zh.md:82`/`:74-80`/`:99` | ❌ 盲点 | 待修 |
| `A5-03` | 高 | **`A2-01` 的升级**：token 通道被**永久钉在豁免栅栏的旧前缀**（`lib/host.js:2109-2113` 基址硬编码 `/dsh-music`；`:2157-2159` system-* 显式豁免 `isUntrustedRequest`）。该通道**既不走平台会话鉴权、也不走插件栅栏**，唯一防线是 token 保密性 —— 而 token 已在**世界可读**文件里 ⇒ 同机任意进程可 `GET /dsh-music/api/system-stream?t=…&p=<任意曲目>` 读库内任意文件，无 cookie / 无 Origin | `permission.zh.md:86`、`:119` | ❌ 盲点 | 待修 |
| `A5-04` | 高 | **受保护操作在副作用位置无 grant 检查**；`manifest.permissions` 运行期**零次读取**（`lib/` 全目录无 permission/grant 调用）。实际只有三道自建门：Host/Origin 栅栏、平台 `/api` 栅栏+会话、库成员 allowlist。且「用户确认」只在客户端 UI，**服务端无确认凭证** | `permission.zh.md:86`/`:55`/`:68` | ❌ 盲点 | 待修 |
| `A5-05` | 中 | `ctx.get('directoryPicker')` 字符串查询未声明 Host service（已核实是**真实服务** `@deepseek-ai/dsh-host-directory-picker`；服务层无授权闸门，靠 OS 对话框） | `permission.zh.md:32`/`:55` | ❌ | 待修 |
| `A5-06` | 中 | `net.fetch` 声明 scope **漏 `archive.org`**（`lib/host.js:345-356` 白名单 + `:897-900` 逐跳跟随实际请求），`dsh-plugin.json:47` 未列 | `permission.zh.md:55`/`:119` | ❌ | 待修 |
| `A5-07` | 中 | 前缀/后缀判定 scope：新增 `lib/host.js:2011-2012`（mvlib 白名单前缀）、`:1048-1050`（expandHome `~/`）。**未发现可利用路径逃逸**（mvlib 后有 `path.resolve`+`rootWithSep`；扫描用 `readdir(withFileTypes)` 整体跳过符号链接） | `permission.zh.md:119` | ❌ | 待修 |
| `A5-08` | 中 | **三条 fs scope 都小于实际调用面**：`fs.write` 最严重（`/tmp` 探针 `:1740`、`/tmp` MV 缓存 `:238`/`:248`、`~/.Trash` `:1993-1995`、非播放列表新文件 `:1978-1983`）；`fs.read` 另读 `$DSH_HOME`（`:1040`）与 `node_modules`（`:2015-2029`）；`fs.delete` 含 `rm /tmp`（`:1986`） | `permission.zh.md:55` | ❌ | 待修 |
| `A5-09` | 中 | 自建存储**无任何稳定错误码**（`PERMISSION_NOT_GRANTED`/`INVALID_KEY`/`INVALID_VALUE`/`QUOTA_EXCEEDED`/`STORAGE_UNAVAILABLE` 全缺）；`saveState` 全量吞错（`:1042-1044`）后 `/dir` 仍返回 200 + dir（`:1793-1795`）⇒ **持久化失败被报告为成功** | `storage.zh.md:87-93`、`:83` | ❌ 盲点 | 待修 |
| `A5-10` | 低 | uninstall 保留规则未声明：README:81 只声明不动音乐文件，未声明 `$DSH_HOME/storages/dsh-music-player.json` 的保留/清理 | `storage.zh.md:81` | ❌ | 待修 |
| `A5-11` | 低 | 包内 `lib/state.json` 被当状态来源（`:942`、`:1024-1032`），工作区该文件含开发机绝对路径；但 `.gitignore` 与 `files` 白名单均排除它 ⇒ 不进 git / 不进 npm 包，风险仅限本机 | — | ❌ | 接受 |

**第 5 轮最重要的结构性发现**：`A5-03` + `A5-04` 合起来说明 —— **插件的实际信任模型与它自己声称的不一致**。`x-dsh-transition` 写「信任边界交给连接层」，但（a）`createSharedFetchHandler` **自身不含栅栏与鉴权**（栅栏只在 `webServer` 存在时挂外层路由），（b）token 通道显式豁免栅栏并钉在旧前缀。审计员对「无 webServer 形态下谁在鉴权」标注为**推断**（0.1.6 desktop-host 源码不可得）。

#### 5.9.1 第 5 轮符合项（这批是真做对的）

封面 XSS 面系统性关闭（MIME allowlist `:301-308` + 读取再校验 `:1704-1709` + nosniff + 8MB 上限 `:310`/`:917`/`:924`）；封面代理非任意跳板（仅 https `:882`、主机白名单 `:883`、redirect manual 每跳重校验 ≤4 跳 `:888-906`）；请求体 64KB 上限 + 413（`:1008-1021`）；路径包含判定 + 库成员 allowlist **双重**且 stream/delete/match/apply 共用（`:1361-1373`、`:1454-1477`、`:2124-2131`）；**故意不泄漏 cwd**（自造中文错误 `:1586-1589` + 回归断言）；token 随机源合格（`randomUUID` `:1520`）+ 精确等值比较；状态写入原子 tmp+rename（`:1038-1041`）；客户端只写 3 个 `dsh-music:*` 键、**token 只存模块变量不落 localStorage**；`lib/host.js` **零 console / 零 logger / 零遥测**。

### 5.10 编号裁定与更正记录（第 6 轮 · 收口）

**编号裁定**：5 轮审计并行产出时出现过 ID 冲突。现按「**先写好者占号，后到者让号**」一次性裁定，此后不再改号：

| 轮次 | 维度 | ID 段 | 状态 |
| --- | --- | --- | --- |
| 第 0 轮 | 规范落盘时既有偏差 | `D-01`…`D-06` | 已登记 |
| 第 1 轮 | Lead 自审：路由注册面 + lifecycle | `A1-01`…`A1-06` | 已登记 |
| 第 2 轮 | 门禁有效性 + 传输面覆盖 | `A2-01`…`A2-19` | 已登记 |
| 第 3 轮 | Lifecycle 释放面 | `A3-01`…`A3-08` | 已登记 |
| 第 4 轮 | Manifest + composition | `A4-01`…`A4-10` | 已登记 |
| 第 5 轮 | Permission + 敏感数据泄漏 | `A5-01`…`A5-11` | 已登记 |
| 第 6 轮 | 收口：编号裁定 + 更正记录 | 本节 | — |

> 审计员各自报告里的临时编号（如 permission 轮的 `A4-01…A4-09`、lifecycle 轮的 `A2-01…A2-08`）**一律以上表为准**；被去重的条目已在其原轮次注明「= `Axx-xx` 独立复核」。

**更正记录 1 —— `D-05` 状态由「已修」改为「待修」**

我（Lead）在第 0 轮把 `D-05` 标为「已修」，理由是「给 `browser.ui.dsh/v1alpha1` 补了 `optional: true` + `fallback`」。**该判定错误**，第 4 轮 `A4-03` 证明：

- `browser.ui.dsh/v1alpha1` 与 `webserver.dsh/v1alpha1` 在 **references 全树 0 命中**、在 **DSH 0.1.7-rc.2 app.asar 里也 0 命中** —— 坐标是**编造的**；
- 给编造的坐标补 `fallback`，只是让**空壳声明看起来完整**，协商层永远拿不到 definition；
- 真正的修复是**改用真实坐标**（`ui.dsh/v1alpha1` / `web.ui.dsh/v1alpha1`）或**删掉这两条声明**并在 README 说明插件走自建栅栏。

→ **教训（已进 §2.11）**：`fallback` 不能把不存在的坐标洗成合规声明。**"补了个字段"不等于"修好了"。**

**更正记录 2 —— 第 3 轮 `L133` 判定由「符合」改为「违规」**

见 §5.7.5。根因是审计员按 `"log"` 这个词搜索日志面，而落盘型诊断走 `fs.appendFile`。已沉淀为 §6.1 第 3 条。

**第 6 轮结论**：AGENTS.md 现在与代码实际状态一致（含 5 处**明确标注的编造/不实声明**），但**代码本身一行未改** —— 41 条台账条目中 **0 条已修**，其中 **12 条为高**。下一步不是继续审计，是**修**。


---

## 5.11 第 7 轮 —— 独立复核（Lead 亲自实测，不采信审计员转述）

**动机**：`§6.1` 第 2 条禁止把描述当事实。前 6 轮中部分载荷性主张来自审计员报告，我未亲自验证。本轮逐条实测，**结果全部成立**；并**纠正了我自己的一个无效检验方法**。

| 被复核主张 | 我的检验 | 结果 |
| --- | --- | --- |
| `A4-03` 两条坐标是编造的 | `grep -rn "webserver\.dsh\|browser\.ui\.dsh\|HttpPrefixRoutes" references/` → **0 命中**；同时在 DSH 0.1.7-rc.2 运行时搜 `webserver.dsh` / `browser.ui.dsh` → **0 个文件** | ✅ **成立** |
| `A4-03` 真实坐标存在 | `ui-contribution.zh.md:55` 实测有 `ui.dsh/v1alpha1` + `ContributionHost` | ✅ **成立** |
| `A5-03` 基址硬编码旧前缀 + 回显 Host | `lib/host.js:2111-2112` 实测 `'http://' + host + '/dsh-music/api/system-art?t=' + …`，`host` 取自 `req.headers.host` | ✅ **成立**（逐字） |
| `A5-03` `system-*` 豁免栅栏 | `lib/host.js:2157-2160` 实测 `isSystemPath` 含 4 条 system-art/system-stream 路径，`if (!isSystemPath && isUntrustedRequest(req)) throw 403` | ✅ **成立**（逐字） |
| `A3-01` 轮询自我续期 + `halt()` 不复位 `scanning` | `lib/client.js:934-946` 实测 `catch { schedulePoll(); }`；`scanning:` 全文**只出现在 `:790` 初值**，未出现在 `halt()` 的 `set({…})` 里 | ✅ **成立** |
| `A2-04` 匹配套件是离线测试 | `scripts/test-match.mjs:5` 实测原文「All upstream traffic is stubbed, so the suite is hermetic.」；`:45` `globalThis.fetch = async …` | ✅ **成立** |
| `A5-09` 吞错后仍报成功 | `lib/host.js:1042-1044` 实测 `catch { /* best-effort */ }` 无重抛；`:1795` `sendJson(res, 200, libraryPayload(library))` 无条件 200 | ✅ **成立** |
| `A1-05` 错误文本含文件名 | `lib/host.js:1472` / `:1474` 实测 `'文件不存在：' + track.name` | ✅ **成立** |

### 5.11.1 我自己的无效检验方法（必须记录）

**首次检验 `A4-03` 的 asar 主张时，我用了 `grep -c <pattern> bin.js`，对 `webserver.dsh` / `browser.ui.dsh` / `HttpPrefixRoutes` 全部得到 `0` —— 但同一个命令对宿主**确实在用**的 `conversation.view` 也得到 `0`。**

（`conversation.view` 由 `lib/client.js:3183-3190` 注册，宿主必然认识。）

→ 说明**检验方法本身无效**（搜错了产物：`bin.js` 是 CLI 入口，不是 client bundle）。**若我当时不跑这个对照，就会用一个无信息的 `0` 去「证实」一条主张。**

**纠正后的方法**：先用一个**已知为真**的字符串校准搜索面（`conversation.view` → 命中 `cordis-client-runner/lib/client.js`、`ui-chat/lib/client.js` 等），再在同一批产物里搜待证字符串。

**结论**：`webserver.dsh` / `browser.ui.dsh` / `HttpPrefixRoutes` 在**整个 DSH 运行时 0 个文件**，而 `conversation.view` 命中 —— 方法有效后结论仍成立。

> **教训（应并入 `§6.1`）**：**任何「0 命中」的结论，必须先用一个已知为真的样本校准同一搜索面。** 否则 `0` 可能只是「搜错了地方」。这条与前两轮的「按动词搜日志」「不把描述当事实」是同一族错误：**检验方法本身也需要被检验。**

### 5.11.2 本轮附带发现（比台账原文更精确）

`ContributionHost` 与 `ui.dsh/v1alpha1` 在 **DSH 0.1.7-rc.2 运行时同样是 0 命中** —— 即 **DSH 宿主根本没有实现 Community 的 `ContributionHost` 契约**，它只用字符串 slot（`conversation.view`）。

因此 `A4-06`（`ContributionHost` 无 surface 列表 → 永远形成不了 agreement）的真实严重度**高于**原文：不只是「manifest 写不下列 surfaces」，而是**该契约在 DSH 侧根本没有对端实现**。→ `A4-06` 严重度由「中」**上调为「高」**，并新增说明（按 `§6.2`，这是判定变更，新写一条而非覆盖）。

### 5.11.3 第 7 轮结论

- 前 6 轮的载荷性主张**经 Lead 亲自实测，无一条被推翻**；台账与代码状态一致。
- 新增 1 条判定变更（`A4-06` 中 → 高）与 1 条方法学教训（校准搜索面）。
- **审计维度已全部覆盖**：manifest+composition（第 4 轮）、lifecycle（第 3 轮）、permission+storage（第 5 轮）、门禁有效性（第 2 轮）、声明面/注册面（第 1 轮）—— 5 个维度各有独立审计员 + Lead 复核。
- **仍未做的事**：47 条台账 **0 条已修**；`§6.3` 的 17 条门禁规格**尚未实现**。这两项不属于本目标（目标是「审计 + 迭代 AGENTS.md」），属于后续修复目标。

---

## 5.12 第 8 轮 —— 修复（按 Lead 提出的顺序执行）

基线：`node scripts/run-all.mjs` → **21/21 PASS**（新增 3 套）。每条修复都补了门禁，且**每条门禁都做了负向对照**（把修复回退 → 门禁必须变红）。

| 条目 | 修复内容 | 新增门禁 | 负向对照结果 |
| --- | --- | --- | --- |
| `A2-01` | 删除 `lib/host.js` 的 `TEMP DIAGNOSTIC` 探针（21 行）；删除随之成为死代码的 `dispatch(req,res,entry)` 的 `entry` 参数（3 处调用点同步）；清掉实机上已长到 **641,835 B** 的 `/tmp/dshm-probe.log` | `test-audit.mjs` ⑦「写盘目标白名单」+「凭据不得进入写盘调用」 | 注入探针 → **2 项 FAIL / exit 1**（`'/tmp/dshm-probe.log'` 不在白名单 + 凭据进写盘） |
| `A1-01` | `FETCH_ROUTES` 11 → 16 条（补 `mv`/`mvconvert`/`mvlib`/`mvfile`/`caps`）；`system-art`/`system-stream` 记为**具名例外** `LEGACY_ONLY_ROUTES` | 新建 `test-route-consistency.mjs`：`host.js` 分派表 == `FETCH_ROUTES ∪ LEGACY_ONLY_ROUTES` == manifest 登记表（三向相等 + methods 对齐） | 删 `FETCH_ROUTES` 一条 → **FAIL `mvfile`**；删 manifest 一条 → **FAIL `mvlib`** |
| `A2-03` | `test-desktop-routes.mjs` 的 `expected` 改为**从 `lib/host.js` 分派表推导**（不再手工抄），并加「注册面不得超出推导集合」的反向断言 | 同上 | 手工抄的旧列表结构上无法发现漂移 → 推导版本能（见 `A1-01` 对照） |
| `A2-06` | README 端点表 10 → **18 条**（补 `session`/`caps`/`mv`/`mvconvert`/`mvlib`/`mvfile`/`system-art`/`system-stream`），并写明 `system-*` 仅旧前缀可达及其代价 | 三方一致门禁已覆盖 manifest 面 | — |
| `A2-02` | README 删掉不实的「真实浏览器量布局（headless Chrome + CDP）」防线主张，改为显式**没有布局测量能力**的警告；同时清掉该节一个**无配对开启的孤立代码围栏** | — | — |
| `A3-01` | `lib/client.js`：加 `disposed` 闸门（`schedulePoll` 三处守卫）+ `halt()` 显式复位 `scanning: false` | 新建 `test-poll-teardown.mjs`：挂载→刷新进入扫描态→轮询在飞→teardown→释放在飞请求，断言此后 fetch 次数不增 | 回退 4 处修复 → **FAIL `before=2 after=3`**（请求风暴复现） |
| `A3-02` | `lib/index.js`：加 `disposed`；`ensureHost` 的两个 await 之后、**赋值之前**复查；teardown effect 先置位再 dispose | 新建 `test-teardown-race.mjs`：用顶层延迟 400 ms 的 stub `host.js` 精确制造在飞 import 窗口，在窗口内 teardown，断言 `createHost` 调用数为 0 | 回退 4 处修复 → **FAIL `createHost calls=1`**（孤儿 host 复现） |
| `A4-03` | `requires.contracts` 两条编造坐标**删除** → `[]`；`contributes` 扩展的 `browser.ui.dsh/v1alpha1` 换成基线里真实的 `ui.dsh/v1alpha1` / `UiContribution`；路由登记表移到顶层插件自有键 `x-dsh-music-player.transport` | 三方一致门禁新增：结构位置上的 `apiVersion` 值不得是已知编造坐标；非空 `contracts` 必须至少一条 `required` | 塞回编造坐标 → **2 项 FAIL**；只加一条纯 `optional` 契约 → **1 项 FAIL** |
| `D-05` | 状态由「待修」改为**已修**：这次是真的删/换，不是补 `fallback` | 同上 | — |

### 5.12.1 修复过程中新发现的两条事实（必须记录）

1. **`system-art`/`system-stream` 不能注册到 `connection.fetch`** —— 原计划「7 个端点全部补注册」是**错的**。实测平台实现：`/api` 路由挂在 `webServer` 上，`admit()` 先判 `isTrustedApiRequest`（Host/Origin）**再要求 `browserAuth.isAuthenticated`**；而 `createSharedFetchHandler` 自身**不含栅栏与鉴权**（`packages/client/connection/lib/index.js:608-623` 只做精确查表，栅栏在 `:830-843` 的 `webServer` 路由里）。Chromium 内部取图带 `Origin: dsh-app://app`、不带会话 cookie ⇒ 走 `/api` 必然 403/401。**这两个端点必须留在插件自建的旧前缀上**，这是设计约束不是漏改。代价（无 `webServer` 时不可达）已写入 manifest 与 README。
2. **`api()` 的 404 回落探测会污染端到端测试** —— 设计 `A3-01` 门禁时，我先后两版误判：第一版挂错了请求；第二版用 404 释放，结果 `api()` 自带的旧前缀回落探测（`lib/client.js:664-673`）凭空多打一次请求，被误读成「轮询再武装」。**在飞请求必须用非 404 状态码释放**，否则会把 `A1-02` 的行为混进 `A3-01` 的断言。这条已写进该套件的文件头注释。

### 5.12.2 第 8 轮结论

- **8 条台账条目已修**（`A2-01`/`A1-01`/`A2-03`/`A2-06`/`A2-02`/`A3-01`/`A3-02`/`A4-03`）+ `D-05` 状态更正。
- **新增 3 套门禁、扩写 1 套**，套件总数 18 → **21**，全部 PASS。
- **每条门禁都通过负向对照**：把修复回退后门禁确实变红，不是恒绿测试。
- **仍未修**：`A1-02`（404 当信号 + 静默降级）、`A1-03`（孤儿 ffmpeg + 无界 Map）、`A1-04`、`A1-05`（错误面脱敏）、`A2-04`/`A2-05`（README 另外两处不实）、`A3-03`/`A3-04`（window 复用 + DOM 释放）、`A4-02`（扩展 id 无运行时对应）、`A5-02`/`A5-03`（token 三律）、`A5-04`（副作用前置授权）、`A5-06`/`A5-08`（scope 小于实际）、`A5-09`（失败不得报成功）等。

---

## 5.13 第 9 轮 —— 修复剩余 7 条高危

基线：`node scripts/run-all.mjs` → **23/23 PASS**（新增 2 套）。每条都配门禁，**每条门禁都做过负向对照**。

| 条目 | 修复内容 | 门禁 | 负向对照 |
| --- | --- | --- | --- |
| `A5-03` | ①基址**钉回环字面量**：新增 `loopbackAuthority(req)` 只从请求 Host 取**端口**，主机名固定 `127.0.0.1`（不再回显 Host）；②栅栏豁免**收窄**：`system-*` 仍豁免 Origin/Sec-Fetch（Chromium 内部发起必须豁免），但新增 `isLoopbackHostRequest(req)` 要求 Host 仍是回环 | `test-security.mjs` 新增 8 条断言 | 回显 Host → FAIL「host is the loopback literal」；去掉回环要求 → 2 条 FAIL |
| `A5-02` | token **按用途分签**：`systemArtToken` / `systemStreamToken` 两个独立 `randomUUID()`；art 端点只认 art token、stream 端点只认 stream token | 同上（交叉使用必须 403） | 复用同一 token → 3 条 FAIL |
| `A1-03` | ①`mvJobs` **有界**：`MV_JOBS_MAX = 32` + `MV_JOB_TTL_MS`，新增 `pruneMvJobs()`（终态条目 TTL 淘汰、**运行中的永不淘汰**）；②终态盖 `finishedAt`；③`dispose()` 调 `killAllMvJobs()`，对每个在飞子进程 `SIGKILL` 并清空容器 | 新建 `test-mv-teardown.mjs`（假 ffmpeg 自报 PID → dispose → 断言 PID 已消失）+ `test-audit.mjs` 4 条结构断言 | dispose 不 kill → **FAIL「child alive=true」**（孤儿进程复现） |
| `A5-04` | 新增 `authorize(action, targetPath, scopes)`，在**7 个副作用位置**逐一校验目标路径落在已声明 scope 内（库目录 / 状态目录 / MV 缓存 / 回收站） | `test-audit.mjs`：每个 `fs.<mutator>` 必须包 `authorize(...)` 或引用 `authorize` 赋值出的变量 | 去掉一处 → **FAIL `fs.unlink(`** |
| `A1-02` | ①判据改为**端点语义 + 正向识别**：只有「本来不该 404」的端点回 404 才算路由缺失信号（新增 `ROUTE_MISSING_404_ENDPOINTS`）；②旧前缀必须答出宿主数据对象（`looksLikeHostPayload`）才采纳；③`entryResolved` **只在采纳成功时置位**（可重入）；④降级写进 `state.hostEntry` 并渲染成可见提示（新增 `.dshm-notice` 类 + 中英文案） | 新建 `test-entry-fallback.mjs`（6 条）+ `test-audit.mjs` 5 条静态断言 | 去掉端点语义判据 → **FAIL**（静态断言） |
| `A4-02` / `A4-06` | 删除 `contributes["x-dev.dsh-std.extensions"]` 两条**无 definition** 的条目（pinned 投影只产出 `unknown-extension` warning，`manifest.zh.md:62` 明确不能声称功能已生效）；真实绑定记录到顶层 `x-dsh-music-player.ui`（`package.json` 的 `exports["./client"]` + `dsh.client.platform` + 字符串 slot `conversation.view`） | `test-route-consistency.mjs`：不得声明 `x-*` 扩展行 + 记录的 slot 必须在 `lib/client.js` 里找得到 + `./client` 导出必须一致 | — |

### 5.13.1 本轮推翻了我自己的一个设计（必须记录）

`A1-02` 我第一版修复用了「5 秒探测冷却」来避免「每个 404 都探一次」。**这是错的**，被既有套件 `test-client-shell.mjs` 抓住：该套件模拟「宿主入口未重启」时，前面的 `/api/dsh-music/cover` 业务 404 已经启动了冷却，150 ms 后真正需要回落的 `/refresh` 被冷却跳过 → UI 出现错误条。

→ **「冷却窗口」与原来的「一次性标志」是同一类错误**：都让**无关的业务 404** 影响真实回落机会。正确判据是**端点语义**（这个端点的 404 到底意味什么），不是时间窗。改成 `ROUTE_MISSING_404_ENDPOINTS` 后，`cover`/`mv`/`stream` 这类业务 404 完全不参与入口判定。

### 5.13.2 本轮删掉了一条没有判别力的断言

`test-entry-fallback.mjs` 里我曾用「`/cover` 的业务 404 不得触发探测」做断言，但负向对照**没有变红** —— 因为 jsdom 不加载 `<img>`，客户端根本不会请求 `/cover`。**没有判别力的断言等于没断言**，已删除，改由 `test-audit.mjs` 的精确静态断言（grep 条件表达式本身）把守，并验证该静态断言能被回退触发。

### 5.13.3 第 9 轮结论

- **13 条台账条目已修**（`D-05` + 12 条），**高危从 13 条降到 0 条**（`A4-06` 已通过「不声明」解决）。
- 套件 18 → **23**，全部 PASS。
- 存量未修项从「7 条高危」变为「若干中/低 + 明确接受项」，逐条见 §5.1 与各轮小节。

---

## 5.14 第 10 轮 —— 线上故障：音乐不能播、MV 能播

**报告**：桌面客户端里音频全不能播，MV 正常。

**实测定位**（对运行中的真机实例 `127.0.0.1:19387` + `dsh-desktop-host`）：

| 检查 | 结果 |
| --- | --- |
| `/dsh-music/api/session` | 200，两个 token **不同**（第 9 轮的 `A5-02` 已生效） |
| `/dsh-music/api/stream?p=<真实曲目>` | **200 `audio/flac` 37,946,235 B** |
| `/dsh-music/api/system-stream?t=<streamToken>&p=…` | **200 `audio/flac`** |
| 同上 + `Range: bytes=0-1023` | **206 + `content-range` + `accept-ranges: bytes`** |
| 交叉 token（art 用去 stream） | 403 ✅ |
| `/dsh-music/api/mv?id=<真实视频>` | 200，返回 **`"url":"/api/dsh-music/mvfile?k=…"`（相对地址）** |

⇒ **宿主侧音频通路完全正常**。真正的不对称在这里：

- **MV**：`/api/mv` 返回**相对地址**，走平台 `/api` + 浏览器会话，**不经 token**；
- **音频**：Desktop 上**永远**走 `system-stream` token 直连（相对地址经 Desktop 转发会丢 Range）。

所以「token 失效」的症状必然是 **音乐死、MV 活**。

**根因**：`systemArtToken` / `systemStreamToken` 原本是 `createHost()` 里的 `randomUUID()` —— **每次宿主热重载都轮换**；而客户端把 `/session` 的基址**缓存整个页面生命周期**（`systemArtBasePromise` 从不重置）。于是任何一次 `lib/host.js` 保存（开发期频繁发生）都会让页面手里的媒体 URL 变成废纸，直到刷新页面。

**修复（两条）**：

1. **宿主：token 钉到进程级**（新增 `processTokens()`，用 `Symbol.for` 挂在 `globalThis` 上）。热重载产生新 module 实例，但符号注册表与 `globalThis` 是同一个 ⇒ **重载不再轮换 token**，客户端缓存的 URL 持续有效。
2. **客户端：基址加 TTL + 失败自愈**。`loadSystemArtBase(force)` 带 60s TTL；新增 `invalidateSessionBase()`；音频 `error` 事件里若失败源是 `system-stream`（且未自愈过），丢掉缓存放并**当场用新基址重放本曲**，而不是退化成「跳过一首」。

**新增门禁** `scripts/test-token-lifetime.mjs`：两次 `createHost()` 的 token 必须相同；旧 token 在新实例上不得 403。
**负向对照**：把 token 退回实例级 → 两条断言 FAIL（`…->dec2ffd6…`），exit 1。

**运维要求**：`lib/index.js` 改过（第 8 轮的 `FETCH_ROUTES` / `disposed`），**必须重启 DSH 应用**；`lib/client.js` 与 `lib/host.js` 改过，**必须刷新页面**（或重启应用）。

---

## 5.15 第 11 轮 —— TypeScript 迁移 + MV 快进修复

### 5.15.1 MV 进度条一拖就从头（线上故障）

**定位**：`mvCacheUrl()` 在 `systemStreamBase` 为空时退回**相对**地址 `/api/dsh-music/mvfile?k=…`，而 Desktop 上相对地址经 Electron `forwardWebRequest` **会丢 Range/206** → `<video>` 判定流不可 seek → 一拖就回 0 秒。`prepareVideo()` 的 **5 个调用点里有 4 个没有先 await 基址**（`restoreLastPlayed`、两处 error→转码升级、手动转换），刷新页面后 cue 上一首正好命中。

**修法**：把 `await ensureStreamBase()` 放进 `prepareVideo()` 内部（一处覆盖全部调用点），并把 `restoreLastPlayed` 的音频分支同样包起来。

**门禁** `scripts/test-mv-seek.mjs`：在 `/session` 故意延迟 1.2 s 的时序下，断言挂上去的媒体源必须是**绝对 token 地址**。
**负向对照**：去掉那句 await → 三条断言 FAIL，报出的正是 `/api/dsh-music/mvfile?k=…`，exit 1。

### 5.15.2 TypeScript 迁移

**规模实测**（先用 scratch 副本量，不动工作树）：`strict: true` → **667** 个类型错误（其中 455 是隐式 any，TS 7 默认开启）。`noImplicitAny: false` → **243**；再加 `strictNullChecks: true` **零额外代价**。

**取舍**：不追求一次到位的 strict（6133 行历史 JS 的回归风险不可控），改用**分层 + 棘轮**：
- `strictNullChecks` **开** —— 它正是能防住本轮与第 10 轮两个真实故障的那一项（缓存/基址可能为 null）；
- `noImplicitAny` **暂关**，由 `scripts/typecheck-ratchet.mjs` 守住：基线 `scripts/typecheck-baseline.json` = **243**，**只许变少**。

**真源与产物**：`src/*.ts` 是唯一真源，`lib/*.js` 是 `tsc` 产物。**产物也提交**（`dsh plugin add` 不跑构建，且本仓库显式无生命周期脚本），由 `scripts/check-build-fresh.mjs` 把关（编译到临时目录逐字节比对）。
- 新增 `tsconfig.json`、`package.json` 的 `build` / `dev`（`tsc --watch`）/ `typecheck` 脚本。
- 依赖从 npm 锁文件切到 **pnpm**（`pnpm-lock.yaml` + `packageManager: pnpm@11.7.0`）—— 因为 `dsh plugin` 内部本来就用 pnpm，此前的 `package-lock.json` 是残留且与实际依赖不一致。CI 同步改为 `pnpm install --frozen-lockfile`。

**本轮自己犯的一个错，已沉淀为规则**：`test-audit.mjs` 用 `/^        ([a-zA-Z][\w]*):/gm`（写死 8 空格缩进）找 player API 方法；tsc 重新排版成 16 空格后这条断言**静默返回 0 个方法** —— 本该报警的地方反而变绿。改成「取该块里缩进最小的键」后恢复 29 个方法。已写入 AGENTS.md §2.15：**静态断言要按结构推导，不要按空白字符写死。**

**验证**：`ALL 25 SUITES PASS` · `typecheck` 未倒退 · `check-build-fresh` 一致 · `check:manifest` PASS · CI 在 GitHub 上 `completed/success`。

---

## 5.16 第 12 轮 —— 类型错误清零（243 → 0）与两个真实缺陷

**维度**：类型系统有效性（第 11 轮迁移的收尾）。
**基线**：TS 7.0.2，`strictNullChecks` 开、`noImplicitAny` 关。

### 5.16.1 `A5-12`（新发现，已修）—— MV「重试」按钮是坏的

`MusicView` 的 MV 重试按钮 onClick 引用了 `mvEscalated.delete(...)` 与 `set({mv:…})`，
而这两个名字都声明在 `createPlayer()` **内部**（`mvEscalated` 在 client.ts:1419，`set` 在 :1138），
`MusicView` 在 `createPlayer()` **外面**。⇒ 运行时抛 `ReferenceError`，**且抛在
`player.retryVideo()` 之前**，所以那个按钮点了完全没反应（只有控制台报错）。

- **迁移前就存在**：`git show 032e333:lib/client.js` 的对应位置有同样两行。
- **门禁盲点**：既有 25 套没有任何一条覆盖「转码失败 → 点重试」。jsdom 套件渲染了视图，
  但没人点那个按钮（`test-client-shell.mjs` 只断言每个 `<button>` **挂了**处理函数，
  不断言处理函数**能跑通** —— 这是结构断言，抓不到引用错误）。
- **修法**：把「重置 `mvEscalated` + 置 `preparing`」移进 `createPlayer` 的 `retryVideo` 内部。
  放在那里而不是视图里，理由与 `prepareVideo` 那处相同：**调用者会忘**。
- **门禁**：`test-audit.mjs` 新增「`MusicView` 不得引用 `createPlayer` 局部量」。
  负向对照：把代码引用挪回 MusicView → 变红并报出源文件行号 3160。

### 5.16.2 `A5-13`（新发现，已修）—— `setDirectory` 未等 `ready`，目录会被 `loadState()` 清掉

`ready` 是个 async IIFE（host.ts:1845），里面 `currentDir = await loadState()`。
它在 `await` 恢复时会**覆盖**期间被设好的 `currentDir`。

- **只有部分路由 `await ready`**：`/library`(:2027)、`/refresh`(:2034)、`/delete`(:2393)、`ensureLibrary`(:1876)。
  **`/api/dsh-music/dir`(:2046) 与 `/pick`(:2166) 的成功分支都没有。**
- **后果**：激活后第一个请求若是 `POST /dir`，`loadState()` 落地时把目录清回 `null` →
  「选了目录，列表一直是空的」。真实客户端先 `GET /library`（有 await）所以碰不到，
  但那是**运气**，不是设计。由类型修复 agent 的隔离冒烟测试（`/tmp/smoke`）撞出。
- **修法**：把 `await ready` 放进 `setDirectory` 自己，一次覆盖全部调用者（现在与将来）。
- **门禁**：`test-audit.mjs` 新增「`setDirectory` 必须在任何 `currentDir` 赋值前 `await ready`」。
  负向对照：去掉那句 await → 变红。

### 5.16.3 类型错误 243 → 0

四个并行 agent 分工（文件互不相交）：`client.ts` 127→0、`host.ts` 73→0、
`http-bridge.ts` 33→0、`index.ts` 7→0、`tagwriter.ts` 3→0。

**根因高度集中**：最大的两簇是
①`let x = null` 没标注 → 下游全成 `never`（`Property 'x' does not exist on type 'never'`，约 90 处）；
②`const arr = []` → `never[]`。
补上真实类型（`PlayerState`、`LibraryResult`、`Track`、`MvJob`、`MusicPlayerApi` 等 26 个就地 interface）后一次性消掉大半。

**约束执行情况（这是本轮最该被复核的部分）**：
- 全仓 `as any` / `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`：**0**
- 全仓 `!` 非空断言：**2**，均在 `client.ts` 并带可证性注释
  （`:1495` `canvas.getContext("2d")!` —— 加判空会把「drawImage 抛错被 catch 吞掉」
  改成「startWasmVideo 返回 false 从而改走转码」，那是行为变更；
  `:2765` `player.t!` —— `apply()` 在 `ctx.slots.register` 之前赋值）
- 每份交付都要求 agent 做**行为等价证明**（node 类型剥离后与旧产物 diff / 等价性实测），
  而不是只报「0 错误」。`http-bridge.ts` 那份把「改前 vs 改后」的运行期 JS 逐字 diff 到 `IDENTICAL`。

**棘轮收紧到 0**：`scripts/typecheck-baseline.json` 由 243 下调为 **0**，此后任何新增类型错误直接变红。

### 5.16.4 逐文件收严允许清单（新增门禁）

全量开 `noImplicitAny` 仍会多出 **343** 处（305 处是未标注的函数参数），不能一次开。
但实测 `http-bridge.ts` 与 `tagwriter.ts` 在该档位下**已经是 0**，于是新增：

- `tsconfig.strict.json`：`extends` 主配置 + `noImplicitAny: true` + `include` 允许清单；
- `scripts/check-strict.mjs`：名单里的文件必须零错误，且**名单为空要拒绝**
  （空名单 = 恒绿门禁，比没有更坏 —— 这条自身也做了负向对照）。
- 已接进 `npm test` 与 CI。严格度**单向增长**：清干净一个文件就加一个。

### 5.16.5 本轮我自己犯的三个错（同一族：**静态断言被文本骗到**）

1. `test-audit.mjs` 的 `setDirectory` 断言：`indexOf('currentDir =')` 命中的是**我自己注释里**的
   `currentDir = await loadState()` → 恒红。
2. 同一条的 `MusicView` 断言：被 `MusicView` 内部**注释里**的 `mvEscalated` 命中 → 恒红。
3. 改用字符偏移比较先后：`clientPortion` 是**剥掉 CSS 块后**的文本，偏移与源文件行号不一致 → 错位。

**沉淀为规则（AGENTS.md §2.15）**：静态断言①先剥注释；②按行号判断、不要按字符偏移。
这与 §6.1 第 3 条、以及第 11 轮「缩进不可写死」是同一族：**检验方法本身也需要被检验。**
三条断言最终都做了负向对照并确认会变红。

### 5.16.6 验证

- `node scripts/run-all.mjs` → **ALL 25 SUITES PASS**
- `node scripts/typecheck-ratchet.mjs` → 0 错误（基线 0）
- `node scripts/check-build-fresh.mjs` → lib/ 与 src/ 一致
- `node scripts/check-strict.mjs` → 2 个文件在全严格下零错误
- `node scripts/check-manifest.mjs` → PASS；`git diff --check` → clean
- CI（GitHub Actions，pnpm）：见本次 push 的 run

### 5.16.7 符合项（本轮确认落地）

- `permission.zh.md:86`「在产生副作用的位置检查授权」：类型修复期间 **6 个 `authorize()` 副作用点
  一行未改**（agent 用 `git diff -U0 | grep` 逐符号核对，并跑冒烟测试确认 saveState / delete / apply 三条路径的授权仍放行）。
- `lifecycle.zh.md:29/:107`：`dispose` 的 kill 路径、`disposed` 状态位、两个 post-await 复查
  在类型修复中**全部保持**（`src/index.ts` 的 diff 只含 5 个 hunk，且 `FETCH_ROUTES` /
  `LEGACY_ONLY_ROUTES` / `disposed` / `RELOAD_MIN_INTERVAL_MS` 均 0 命中）。
- `permission.zh.md:111` / `storage.zh.md:101`：`mvEscalated` 的 reset 迁移**没有**引入任何新的
  日志/落盘点（`test-audit.mjs` 的写盘白名单与凭据扫描仍全绿）。

---

## 5.17 第 13 轮 —— Desktop MV 仍不能快进（A1-02 回落判据过窄）

**真机证据（用户提供）**：
```
[dsh-music] seek asked=108.4 now=0.3 dur=260.4 seekable=1(0.0..0.0) src=rel err=0
```
`seekable=[0,0]` ⇒ 媒体元素**完全不能 seek**，所以 `currentTime = 108.4` 只会从 0 重来。
`src=rel` ⇒ 挂的是相对地址。

### 5.17.1 根因：A1-02 的回落只在 404 触发，而 Desktop 上答的是 401/403

真机实测（Electron 宿主 :19387）：

| 请求 | 结果 |
| --- | --- |
| `/dsh-music/api/session`（插件自建回环前缀） | **200** |
| `/api/dsh-music/session`（平台 `/api`） | **401** `unauthorized` |
| `/api/dsh-music/session` + `Origin: dsh-app://app` | **403** `forbidden` |

平台 `/api` 的 `admit()` 在**路由之前**判 Host/Origin 栅栏与浏览器会话，所以 Desktop 渲染进程
拿到的是 401/403，**不是 404**。而 A1-02 的通用降级条件是
`response.status === 404 && ROUTE_MISSING_404_ENDPOINTS.has(endpoint)` —— **永远不成立**
（`session` 虽然在那个集合里，但状态码是 401）。于是 `/session` 永远失败 ⇒ 基址恒为空
⇒ `mvCacheUrl()` / `streamUrl()` 退回相对地址 ⇒ Desktop 转发丢 Range ⇒ `seekable=[0,0]`
⇒ 一拖就回 0 秒。

**这是设计缺陷，不是编码疏漏**：A1-02 把「宿主没有这个端点」与「这道栅栏不让这个请求过」
当成了同一件事，而它们的可观测状态码不同。

### 5.17.2 修法（三层）

1. **`/session` 自己的回环回落**（`loadSystemArtBase`）。理由是它**唯一**以下发回环 token 基址
   为目的 —— 那个基址存在的意义就是绕开平台栅栏，所以它有资格走插件自建的回环路由。
   **只给 `/session`**：其余端点不享受（避免把一次普通的 403 洗成信任边界降级，§2.8）。
   仍是**正向识别**（必须真的解析出 `systemStreamBase` 才算采纳）+ 通过 `onDowngrade()` 报告。
2. **`ensureStreamBase()` 拿不到就强制重取一次**（不再「2 秒超时就按相对地址播」）。
   相对地址在 Desktop 上等于不可 seek，那个降级比等待更糟。
3. **按可观测症状自愈**（`healUnseekableSource`）：源不是 token 直连 + 时长已知 +
   `seekable=[0,0]` ⇒ 作废基址、重取、用 token 地址重挂同一媒体并回到原位。
   窗口 20 秒、成功即停、换源重开窗口 —— **有界**，不是无限重试。

**诊断也一并修了**：原来的分类
`includes("system-stream") ? token : includes("mvfile") ? mvfile : startsWith("http") ? abs : rel`
把空串 / `blob:` / `dsh-app://` 全归成 `rel`，且 `mvfile` 的判定在 `http` 之前（相对 mvfile 会记成
`mvfile` 而非 `rel`）—— 看不出到底哪一路。现在输出 `src=`（无歧义分类）+ `base=`（是否有 token 基址）
+ `ep=`（当前端点前缀）+ `url=`（**剥掉 token**，§2.9）。

### 5.17.3 门禁 `scripts/test-mv-seek.mjs` 扩到 15 条

| 场景 | 断言 |
| --- | --- |
| A 视频轨（正常） | 绝对 token 地址 + `&k=<cacheKey>` |
| B 音频轨（正常） | 绝对 token 地址 + `&p=<trackId>` |
| C 平台 `/session` 答 401 | 必须靠回环前缀拿到基址，仍是绝对 token 地址，**且从未挂过相对地址** |
| D 基址在重试预算内一直拿不到 | 先真的挂上相对地址（D1 主动断言这一点），再自愈成 token 地址；重挂次数有界 |

**负向对照**（都确认会变红）：
- 关掉 `/session` 回环回落 → C2/C3/C4 红，**报出的正是 `/api/dsh-music/mvfile?k=…`**（= 用户机器上的 URL）；
- 关掉不可 seek 自愈 → D2 红，报出 `/api/dsh-music/stream?p=…`。

**场景 D 两次被我自己做废，都记在这里**：
- 第一版让 `/session` 正常成功 ⇒ 源本来就是 token 地址，自愈不触发，**恒绿**；
- 第二版按「前 N 次失败」写 ⇒ 与 `ensureStreamBase` 的 2s+4s 重试预算耦合，重试就已成功，
  仍走不到相对地址。最终改用**时间窗**（7.5s，长于那个预算），并把 D1 写成主动断言
  「fixture 真的产生了相对地址」——没有这一条，D 会再次静默失去判别力。

### 5.17.4 本轮我自己的三个错，都被门禁抓住了

1. **替换时删掉了 `let unseekableTimer` 的声明行** → 7 个 TS2552。**由第 12 轮刚收紧到 0 的
   类型棘轮当场抓住**（基线 0 的价值就在这里）。
2. **自愈第一版是「一次就放弃」**：`unseekableHealed = true` 在第一次尝试前就置位，而第一次尝试
   恰好压在宿主还没准备好的时刻上 ⇒ 真机上等于自愈从未生效。改成窗口内退避重试。
   → 这个形态与第 9 轮被推翻的「一次性标志」、以及 §2.10 的「清 timer ≠ 阻止再武装」是同一族。
3. **deadline 初始化漏了首次**：`if (src !== unseekableSrc)` 在 `src` 与初值同为 `""` 时不成立，
   deadline 停在 0 → 首行 `Date.now() > 0` 直接 return。同时**夹具也不真实**
   （假媒体元素没有 `currentSrc`，真实元素一定有）。代码与夹具都修了。
   → 教训：**夹具的保真度也是断言判别力的一部分**（同 §6.1 第 3 条「检验方法本身也要被检验」）。

### 5.17.5 验证

- `scripts/test-mv-seek.mjs` → 15 条全过；两条负向对照确认变红
- `node scripts/run-all.mjs` → **ALL 25 SUITES PASS**
- `typecheck` 0（基线 0）· `check-build-fresh` 一致 · `check-strict` 通过 · manifest PASS

### 5.17.6 符合项

- `composition.zh.md:143`（偏离 plan 必须报告）：`/session` 走回环前缀时仍调用 `onDowngrade()`，
  降级在 UI 上可见（沿用第 8 轮的 `.dshm-notice`），不是静默发生。
- `permission.zh.md:111` / `storage.zh.md:101`（凭据不得进日志）：新的 `url=` 字段经
  `redactSrc()` 把 `t=<token>` 替换为 `t=***`；`test-audit.mjs` 的凭据扫描仍全绿。
- `lifecycle.zh.md:29/:107`：新定时器 `unseekableTimer` 在 `halt()` 里先 `clearTimeout`
  再置 null，且 `scheduleUnseekableHeal` 在 `disposed` 后直接返回 —— **清句柄与阻止再武装分开做**（§2.10）。

---

## 5.18 第 14 轮 —— Desktop MV 仍拖不动：自愈修错了对象

**用户第二份真机日志（比第一份更有信息量）**：
```
seekable=1(0.0..0.0) src=rel err=0 base=token ep=/api/dsh-music
url=dsh-app://app/api/dsh-music/stream?p=ONE%20OK%20ROCK%20-%20We%20Are.mov&v=1790345439794
```
四次 seek，`url` **一次都没变**。

### 5.18.1 第 13 轮的修复**是有效的**，故障点已经移了

`base=token` —— `/session` 的回环回落**确实生效**，token 基址已经拿到（第 13 轮 §5.17 的目标达成）。
但 `url` 是 `dsh-app://app/api/dsh-music/stream?p=…`：**相对路径**被页面解析后的结果。
⇒ **挂源发生在基址到达之前**，之后基址到了、源却没被换掉。

三个未等基址的挂源点（第 12/13 轮只修了其中一部分）：
`recoverAt()`（播放中断后的恢复）、改名重映射、以及**自愈本身**。

### 5.18.2 根因：自愈按 `track.kind` 猜修法，而该模式是 WASM 旁路

`ONE OK ROCK - We Are.mov` 走的是 **WASM 旁路**：画面由 WASM 解码，**媒体元素播的是
`/stream?p=<视频文件>`（音轨）**，而 `track.kind` 仍是 `"video"`。

第 13 轮的自愈写的是：
```js
const next = track.kind === "video" ? await prepareVideo(track) : streamUrl(track);
```
对这条路径它会去 `prepareVideo()` —— 问 `/api/mv` 拿**转码缓存键**，可能等几分钟。
于是自愈**永远卡在等待里**，源从未被换掉 —— 与「四次 seek，`url` 完全没变」精确吻合。

**修法：按「当前这条源是什么类型」重建，而不是按 `track.kind` 猜。**
```js
const wasMvCache = src.includes("/mvfile") || src.includes("&k=");
const next = wasMvCache ? await prepareVideo(track) : streamUrl(track);
if (next === null) { scheduleUnseekableHeal(1200); return; }   // 还没就绪：窗口内再试
```

### 5.18.3 一并修的

- `recoverAt()` 与改名重映射：两处 `audio.src = streamUrl(...)` 原来**没有** `await ensureStreamBase()`
  （§2.16「降级成不可 seek 的源比等待更糟」）。
- **挂源时的诊断**：新增 `logAttach()` —— 挂**非 token** 源时记一行
  （`attach kind=… base=… ep=… url=…`），正常路径不刷屏。第 13 轮只在 seek 时记录，
  所以「挂源那一刻基址是什么状态」看不到；这条日志下一次能直接把问题钉死。

### 5.18.4 门禁扩到 18 条

- **场景 E（真机形态）**：视频轨 + 基址迟到 → 必须先真的挂上相对源，再自愈成 token 地址。
  E1 报出的正是 `/api/dsh-music/mvfile?k=…`。
- **结构断言 F1**：自愈必须按**源的类型**决定修法，**不得**出现
  `track.kind === "video" ? await prepareVideo`。负向对照：把代码退回那个写法 → F1 红。
- 对照②（关掉自愈）→ D2 + E2 红。

### 5.18.5 我自己在本轮的错

- **改 `recoverAt`/改名重映射时漏了 async IIFE 的闭合括号** → 13 个语法/类型错误。
  又一次被**基线 0 的棘轮**当场抓住。
- 场景 E 的**等待时长**第一次给少了（16s 才够），说明时间窗类夹具必须比被测窗口留足余量。

### 5.18.6 验证

- `test-mv-seek.mjs` → 18 条全过；两组负向对照确认变红
- `ALL 25 SUITES PASS` · typecheck 0（基线 0）· build-fresh 一致 · check-strict 通过 · manifest PASS

---

## 5.19 第 15 轮 —— 刷新后误报「无法播放该文件」+ 死代码/泄漏/进程审计

### 5.19.1 `A5-14`（已修）—— 每次打开音乐页面都弹红字

**用户报告**：MV 快进修好了 ✅，但每次打开音乐页面，上方弹红字
「出错了：无法播放该文件（格式不受支持或文件已移动）」。

**根因**（`restoreLastPlayed` 的视频分支）：
```js
attachSource(url);   // 内部调 audio.play() 并挂 .catch
audio.pause();       // 紧接着同步 pause
```
`play()` 被紧随的 `pause()` 打断 ⇒ 那个 promise 以 **`AbortError`** 拒绝，而 `.catch` 里只放行
`NotAllowedError` ⇒ 落到最后一行 `set({ error: translate("error.unsupported") })` ⇒ 弹红字。

**这是第 13/14 轮修复暴露出来的潜伏 bug**：在此之前这条路根本走不到（基址拿不到 / MV 准备失败），
基址与自愈修好之后它才真正执行。**修 bug 会把下游从未执行过的代码路径首次点亮** —— 审计时要预期这一点。

**修法（两层独立防线，各自充分）**：
1. `restoreLastPlayed` 的视频分支改用新增的 **`cueSource()`** —— 只挂源、**不调 `play()`**。
   该分支的意图本来就是「cue 成暂停态」，不是「播了再赶紧停」。
2. `attachSource` 与 `toggle` 的 `.catch` **放行 `AbortError`**（快速切歌 / 立刻暂停都会触发它，
   它不是「格式不支持」）。

**门禁**：`test-mv-seek.mjs` 新增场景 G（刷新后 cue 上一首不得弹红字），断言口径是
**DOM 里没有 `.dshm-error` 节点**（可观测面，不是读内部状态）。
**夹具必须同步变真实**：假媒体元素的 `play()` 原来直接 `return Promise.resolve()`，
于是「play 后被 pause 打断」这条路径**永远不会产生 AbortError**。改成真实语义
（`pause()` 会让在飞的 `play()` promise 以 AbortError 拒绝）后，这条才可能变红
（§2.16「夹具的保真度也是判别力的一部分」）。

**对照**：两层都退回 → G2 红，报出的正是 `error.prefixerror.unsupported`（= 用户看到的红字）；
只退回任一层 → 仍绿（证明两层各自充分）。

### 5.19.2 死代码：5 处清理 + **永久开启死代码门禁**

类型清零后实测 `noUnusedLocals` / `noUnusedParameters` 全仓**只有 5 处**，于是全部清掉并**永久开启**：

| 位置 | 死因 |
| --- | --- |
| `client.ts` `downgradedToLegacy` | 只写不读（降级状态由 `hostEntry` 表达、由 `onDowngrade()` 上报） |
| `client.ts` `wasmCanvas` | 只赋值不读 |
| `host.ts` `name` / `inject` | 未导出且无人 import（入口只调 `createHost()`；Cordis 模块约定残留） |
| `host.ts` `scoreCandidate(…, pool)` | 形参无人使用（调用点只传 2 个实参） |

代价：一条测试断言引用了被删的 `downgradedToLegacy`，门禁当场报红 —— **这是门禁在做它该做的事**。
把它改写成**更强**的形状：剥注释后逐条降级路径断言（`/session` 回落路径 + 通用 A1-02 路径各需一次
`onDowngrade()`）。两条对照各自精确变红。

### 5.19.3 泄漏 / 进程 / CPU 门禁（补上 §6.3 一直空着的那条）

新增 `scripts/test-leak.mjs`（注册进 run-all，带 `--expose-gc`）：8 次热重载后

| 信号 | 类型 | 实测 |
| --- | --- | --- |
| fd 数不增长 | **脆** | 16 → 16 |
| 无孤儿子进程 | **脆** | 0 → 0 |
| `dispose()` 后 1.5s 内 CPU ≈ 0 | **脆** | 6 ms |
| heap 增长有界 | 噪（辅助） | +3.01 MB / 8 次（0.38 MB 每次） |

**heap 阈值是用正对照标定的，不是拍的**：注入「每次 `createHost` 往 module 级数组塞 1MB」
的泄漏 → +11.00 MB（1.38 MB 每次）。阈值第一版写了 12MB，**正对照暴露了它放过了那个泄漏**；
收紧到 6MB / 0.8MB-per-reload 后，基线有 2x 余量、真实泄漏有 1.8x 余量。
**改这个阈值前必须重跑正对照**，否则会把它放宽成恒绿。

### 5.19.4 本轮我自己的两个方法错误

1. **负向对照改了 `src/` 却没 build** —— 门禁读的是 `lib/`（产物），控制组因此是空的，
   差点让我误判「断言没有判别力」。**凡门禁读产物，控制组必须重建**。
2. **重复犯了 §2.15 明明写着的坑**：新断言用 `/onDowngrade\(\)/g` 计数，被**我自己写的注释**
   （`由 onDowngrade() 上报`）算进去一次 ⇒ 阈值 `>=2` 恒真。改成剥注释 + 逐路径断言。
   **规则写在文件里不等于会遵守，所以这类断言要一次写成结构化的形状。**

### 5.19.5 验证

- `ALL 26 SUITES PASS`（新增 `test-leak.mjs`）
- `typecheck` 0（基线 0，且现在含 `noUnusedLocals`/`noUnusedParameters`）
- `check-build-fresh` 一致 · `check-strict` 通过 · manifest PASS · `git diff --check` clean
- 正/负对照：泄漏注入 → `test-leak` 红；红字两层退回 → 场景 G 红；降级上报逐条退回 → 断言红

---

## 5.20 第 16 轮 —— README 精炼 + 真机截图 + AGENTS 结构升级

**性质**：文档工程轮（无代码改动）。

### 5.20.1 README 精炼：218 → 182 行

- 17,160 B → 13,459 B；功能节从 40 行长 bullet 压成 12 条分组条目
- 删掉「测试门禁」的长表格，改成「专门防『写了但不生效』的那几条」精选表（细节本就在
  AGENTS.md §6.3 与 `docs/`）
- HTTP API 的两段长 blockquote 合并为一段
- **事实零丢失**：搬家后逐条 grep 复查 12 个关键事实（`movpkg`/FairPlay/5000/MusicBrainz/
  `node-taglib-sharp`/90ms/白名单/`system-stream`/26 套/18 个端点/`authorize`…）全部仍在
- **无未验证数字与不实主张**（`grep -n "Chromium.*CDP\|headless"` → 0 命中）

### 5.20.2 真机截图入库

用户提供了两张**实际运行截图**（音乐标签页 + 全屏 MV 播放），放入
`docs/images/music-tab.jpg`、`docs/images/mv-fullscreen.jpg`（2558×1639 → 降到 1600×1025，
140 KB / 122 KB），并在 README 顶部引用。

### 5.20.3 AGENTS.md 结构升级：为更强的模型准备自检入口

`AGENTS.md` 原为 50,606 B，**无「先读什么」的入口** —— 新模型必须通读 §2 的 16 条规则
才能知道该做什么。本轮做了三件事：

1. **新增 §0「给 agent 的快速上手」**（前置）：这是什么 / 三条命令 / 五个文件各管什么 /
   **DoD 六条** / 最该知道的 6 条不变量 / 新功能的操作顺序。读完 §0 就能安全改代码。
2. **新增 §8「不变量索引」**：13 条不变量 × 「违反症状」× **「抓住它的门禁名」**。
   某条若没有门禁，索引里直接标 **待建**（`I-09` 就是）—— 缺口暴露在明面上。
3. **新增 §9 陷阱速查 / §10 明确接受的设计取舍 / §11 扩展本文件的三条硬约束**。
   其中 §10 的用途是**防止未来的模型「顺手修好」本来故意的设计**
   （`system-*` 不在 `connection.fetch`、保留旧前缀、提交产物、`mime` 为 null、
   不做随机播放、封面不覆盖…）。

**同时按 §11 自己的规则做了体积治理**：新增 §0/§8–§11 后一度到 **59,233 B = 64 KiB 预算的
90.4%**（危险 —— 这个文件曾被静默截断过）。于是把 §5 台账从 4,569 B 压成 2,175 B 的**索引**
（详细表本就在 `docs/audit-ledger.md`），最终 **53,978 B = 82.1%**，留出余量。

**压缩后自检发现并修掉 3 处悬空交叉引用**（`§5.6.3`、`§5.1` 已随压缩消失）——
把 `grep -n "§5\.[0-9]"` 当作压缩后的必跑检查。另逐条验证 §8/§0 里点名的 **13 个门禁脚本
全部真实存在**（纸面引用不算数，§6.1 第 2 条）。

### 5.20.4 验证

`typecheck` 0（基线 0）· `ALL 26 SUITES PASS` · `check-build-fresh` 一致 · `check-strict` 通过 ·
manifest PASS · `git diff --check` clean · AGENTS.md 53,978 B（82.1%）· README 182 行

---

## 5.21 第 17 轮 —— README 改写为 DSH 官方体例

**性质**：文档工程轮（无代码改动）。**要求**：参考 DSH 官方
[`README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md) 的写法。

### 5.21.1 官方体例的五个特征（逐条对齐）

逐字读了官方 `README.zh.md`（98 行）后提取出的形态，我们逐条照做：

| 特征 | 官方做法 | 我们的做法 |
| --- | --- | --- |
| 标题 | 只有项目名 | `# dsh-music-player` |
| 首段 | 2 段：是什么 + 怎么嵌进宿主 | 同样 2 段（`facets.host.entry` 激活 + `ctx.connection.fetch` / `ctx.slots.register` 注册面） |
| 状态节 | `## 开发者预览`，明说「未来将出现破坏兼容性的变更」 | `## 兼容性状态` + 同口径的警告 + `范围不等于证据` |
| 命令 | ```sh 围栏、最小步骤、`<a id="...">` 锚点 | 同 |
| **无 emoji** | 全篇 0 个 | 从旧 README 去掉了 `⚠️` 与 `↔`，现在 0 个 |
| 链接出去 | 每节 2–4 句就把细节交给 `docs/` | 端点表、结构树、门禁表全部移出 README |
| agent 指针 | 「面向 agent：请遵循 [AGENTS.md](AGENTS.md)。」 | 保留同句，并指向 §0 |

### 5.21.2 移出 README 的内容（不删除，只换位置）

- **完整的 18 条端点表** → [`docs/compatibility.md`](docs/compatibility.md) 新增 §9「端点面」
  （含 §9.1「为什么 system-* 不在 connection.fetch 上」与 §9.2「三种通道的信任边界」）
- **结构树** → 删除（`docs/desktop.md` 与 §0.3 的「五个文件各管什么」已覆盖同样信息）
- **门禁台账表** → 只留一句 + 指向 §6.3

结果：**137 行 / 8,563 B**（旧版 182 行 / 13,459 B），且**事实零丢失** ——
用脚本复查 12 个关键事实（Node 范围 / `0.1.7-rc.2` / 安装命令 / `pnpm run dev` / 26 套 /
18 个端点 / `fs.delete` / `.movpkg` / transcode / MusicBrainz / AGENTS.md / MIT）全部仍在，
9 个相对链接全部可解析，2 张截图全部存在。

### 5.21.3 未做的一件事（如实说明）

官方 README.zh.md 首行是 `[English](README.md) | 中文` 语言切换器 —— 那是因为它有
`README.md`（英文）与 `README.zh.md`（中文）**两份**。本仓库只有一份 `README.md`，
**没有伪造这个切换器**（指向不存在的文件比没有更坏）。若将来需要英文版，再补
`README.en.md` 并加上切换器。

### 5.21.4 把体例沉淀成规则

`AGENTS.md §7.2` 新增一条，避免下一轮又被写回散乱形态：

> **README 的写法对齐 DSH 官方 `README.zh.md`**：纯中文标题、无 emoji、每节 2–4 句 +
> 链接到 `docs/`、装/跑命令用 ```sh 围栏、需要被外部引用的节加 `<a id="..."></a>` 锚点。
> **不要在 README 里做功能堆砌**。

同时按「文档与代码一致」的要求同步了 §7.1 分层地图里 `README.md` 与 `docs/compatibility.md`
两行的「放什么 / 不放什么」——它们描述的是版面事实，README 变了就必须跟着变。

### 5.21.5 验证

`typecheck` 0（基线 0）· `ALL 26 SUITES PASS` · `check-build-fresh` 一致 · `check-strict` 通过 ·
manifest PASS · `git diff --check` clean · README 137 行 / 8,563 B / 0 emoji ·
AGENTS.md 54,719 B（83.5% of 64 KiB）

---

## 5.22 第 16 轮：切到对话再切回音乐，全屏播放器不留存

### 5.22.1 用户报的症状（线上体验问题）

全屏播放器开着时切到「对话」（或切走再切回音乐标签），回来看到的是**音乐列表页**，
全屏播放器没了；MV 的画面也不在舞台上。

### 5.22.2 成因（这次不是猜的）

DSH 的 `conversation.view` **只在被选中时挂载**（`cordis-client-runner` 的 slot 目录注释：
"it exists while that entry is mounted"；`apps/web/tests/built-boot.expected.e2e.ts:184` 也断言
未选中时 `[data-slot="conversation.view"]` 为 null）。插件的视图因此在切换时**整体卸载**，
局部 `useState` 随之丢失：

- `playerPhase`（全屏播放器三态）→ 回来是 `closed`，渲染成列表页
- `mvBig` / `zoomOpen` → 一起丢
- 退出动画的 200ms 定时器挂在视图 `useEffect` 里 → 若在 closing 期间卸载，
  cleanup 会清掉它，回来**卡在 closing**（既收不拢也打不开）

注意：媒体元素本身没问题 —— 卸载时的 cleanup 已把它停到 `document.body` 的
`.dshm-mvPark`（否则离开文档即暂停，这是仓库已有的设计）。缺的是**回来时把它搬回舞台的
状态依据**。

### 5.22.3 修法

| 位置 | 改动 |
| --- | --- |
| `src/client.ts` `PlayerState` | 新增 `playerPhase` / `mvBig` / `zoomOpen` 三个字段（跨视图挂载保留） |
| `src/client.ts` `createPlayer()` | 新增 `openPlayer()` / `closePlayer()` / `toggleMvBig()` / `setZoomOpen()`；退出动画定时器改为 `playerCloseTimer`（归 player） |
| `src/client.ts` `halt()` | 清 `playerCloseTimer` 句柄，并把三个字段复位（不跨 activation 转移） |
| `src/client.ts` `MusicView` | 三个局部 `useState` 改为读 store；Esc 改为现场读 `player.getState()`（原来闭包只依赖 `playerOpen`，`mvBig`/`zoomOpen` 读到的是旧值） |
| `src/client.ts` `toggleMvBig` | 删掉「顺手 toggle DOM class」的补丁：类名改为由 `state.mvBig` 一处渲染（重挂载才会自动恢复） |

### 5.22.4 门禁与负向对照

新增 `scripts/test-view-persistence.mjs`（已注册进 `scripts/run-all.mjs`，套件 26 → 27）：

1. 挂载 → 播视频轨 → 开全屏 → 点画面放大
2. `root.unmount()`（模拟切到对话）→ store 仍 `open`；媒体停在 body 的 `.dshm-mvPark`
3. 重新挂载 → 全屏播放器 / `--mvbig` 布局 / **同一个 `<video>` 回到新舞台**（且全页只有 1 个 video）
4. 收起动画跨卸载仍走完（`closing` → 卸载 → 260ms 后 `closed`）
5. `halt()` 把三态复位

**夹具保真度**：媒体元素用**真实 `<video>` DOM 节点**（只补 jsdom 未实现的 `play/pause/load`）。
用 `FakeAudio`（没有 `nodeType`）会让搬运路径整体跳过 —— 那种夹具下第 3 条断言恒绿。

**负向对照**：`git stash push -- src/client.ts`（回到第 15 轮的视图局部 `useState` 版本）→
`pnpm run build` → 该套件 **5 条 FAIL 后在第 151 行抛未捕获 TypeError 中断**（当时套件没有
空值保护，`.dshm-playerTop ...` 取到 null 就断，故没打印总账）。这 5 条含三条用户症状：
`coming back restores the full player instead of the list page`、
`the restored player still shows the track that was playing`、
`the same media element is moved back into the new stage`。
**§5.22.6 已更正此处的「6 条」并给套件补了空值保护**，现在对照能跑完并打印总账。
`git stash pop` + 重建产物后全绿。对照必须重建产物（§9 第 5 条）。

### 5.22.5 验证

**静态与套件**（本机 Node v24，仓库根）：`pnpm run build` + `typecheck` 0（基线 0）·
`npm test` = `check-build-fresh` 一致 + `check-strict` 通过 + `ALL 27 SUITES PASS` ·
`check:manifest` PASS（未动 manifest，仍跑）· `git diff --check` clean。

**真机 GUI 复核**（ego-browser 打开 `http://127.0.0.1:3080`，即用户正在用的 DSH Web GUI，
152 首曲库；先 `setVolume(0)` 静音再操作，结束时已暂停）：

| 操作 | 读数 |
| --- | --- |
| 播「11」→ 点底部封面 | `phase=open`，`.dshm-player` 在，标题「11」 |
| 切「对话」（视图卸载） | `.dshm-root=false`、`.dshm-player=false`，但 `phase=open`、**`playing=true`**（声音没断） |
| 切回「音乐」 | `.dshm-player` **回来**，标题仍是「11」，进度从 0:02 走到 0:04（截图可证） |
| 收起 | `phase=closing` + `.dshm-player--closing` → 400ms 后 `closed` 且卸载 |
| 收起动画期间切走再回来 | `phase=closed`、无残留 `--closing` 覆盖层（定时器归 player 生效） |
| 播 MV「东风破」→ 点画面放大 → 切走再回来 | `mvBig=true`、`.dshm-player--mvbig` 在、`mediaInStage=true`（同一个 `<video>` 回到新舞台） |

**未验证的部分**（如实说明）：**没有**做页面刷新后的持久化 —— 刷新会重开 player 单例，
全屏态按设计复位为 `closed`（本轮只解决「视图卸载/重挂载」，不解决「整页重载」）；
Desktop（Electron）宿主形态未实测，只在 Web GUI 上跑过。

### 5.22.6 第 16 轮的对抗复核与自纠（先修 #1 再交付）

第 16 轮改完后做了一次**独立对抗复核**（另一个 agent，只读；探针在 `/tmp/negcheck/`）。
它证伪了「可以直接交付」：同一改动**引入了一个新的高severity 回归**，已修复并补门禁。

#### #1【高｜本改动新增】`disposed` 守卫把 `phase` 永久钉在 `closing`

- **机理**：退出动画定时器回调原来写成 `if (disposed) return;` —— 而 `halt()` 已经把句柄
  清掉，回调能跑到**只可能**是「teardown 之后又被显式打开过」；`disposed` 一旦置位**永不复位**，
  而 player 是 window 级单例、下一代 activation 继续复用它（A3-03）。于是
  `openPlayer → closePlayer` 之后 `closing` 再也出不去（`closePlayer` 又只在 `phase === "open"`
  时才动手）⇒ 覆盖层 `dshm-player dshm-player--closing` 常驻、Esc 也救不回来。
- **复现**：复核者的 `probe3.mjs`（真实第二次 `plugin.apply()`）与 `probe-old.mjs`
  （同 activation 先 `halt()` 再 open→close）都复现；HEAD 版本全 PASS ⇒ 是**本轮新增**。
  现有套件当时是绿的，因为它在 `halt()` 之后只断言 `phase === 'closed'`，**从未再走一次 open→close**。
- **修法**：回调判据从 `disposed` 改成「**还在 closing 才收口**」
  （`if (state.playerPhase !== "closing") return;`；`openPlayer` 撤销定时器的路径自然不触发）。
  **明确不采纳**「给 `openPlayer` 补 `disposed` 守卫」的建议 —— 那会让插件热重载后
  全屏播放器**再也打不开**（`disposed` 永不复位），比死锁更坏；teardown 语义由 `halt()`
  自己完成（停播 / 清句柄 / 复位三态），不靠拦 UI 操作。两处都写了代码注释防复发。
- **门禁**：套件补两条 —— ① `teardown.dispose()` → `openPlayer()` → `closePlayer()` →
  300ms 后必须 `closed`；② **真实第二次 activation**（第二次 `plugin.apply()` + 重挂载）
  开全屏后必须能收口（`overlay=false && phase==='closed'`）。
  **负向对照**：把 `if (disposed) return;` 写回去 → `pnpm run build` →
  这两条**恰好变红**（`phase=closing`、`overlay=true`，`2 CHECK(S) FAILED`），其余全绿；
  恢复后 `ALL PASS`（23 项）。顺带给套件加了点击前判空，负向对照不再抛未捕获异常、
  能打印总账（§5.22.4 的「6 条」更正为「5 条 + 中断」即由此而来）。

#### #2【中｜推断，非本轮引入】媒体「离开文档即暂停」的窗口 —— 真机实测**未能复现**

复核者指出：视图挂载期间媒体停在 React 树内的 park，卸载时先随子树离开文档、passive cleanup
才搬到 body park，理论上存在暂停窗口（jsdom 观察不到）。本仓库没有布局测量能力，但**有真实浏览器**：
ego-browser 播 MV「东风破」→ 开全屏 → 放大 → 切「对话」→ 1.8s / 3.3s 两次采样 →
切回来采样，结果 `playing=true`、`paused=false` 全程成立，`currentTime` 4.7 → 6.6 → 8.1 → 9.7
（未归零、未中断），且同一个 `<video>` 回到新舞台。⇒ 在 Web GUI 上该窗口不产生暂停
（cleanup 与删除在同一任务内完成，规范要求「稳定状态」才判离文档）。
**Desktop（Electron）未实测**，仍标注未验证。

#### #3【低｜已修】文档路径写错

`AGENTS.md §2.17` 原写「`lib/client.ts` 的 `PlayerState`」——`lib/` 下只有 `.js`，真源是
`src/client.ts`。已改，并同步把「`disposed` 死锁」沉淀成 §2.17 的第四条规则。

#### #4【低｜已修】本节 5.22.4 的负向对照读数不实

复核者独立重做后指出「6 条 FAIL」不可复现（实为 5 条后中断）。已按实际读数更正（见上）。

#### 复核确认「未能证伪」的项

死代码 / 未使用变量（`typecheck` 0 + `test-audit` 33 methods all used）· `playerCloseTimer`
守卫除 #1 外无第二处漏网 · closing 期间再点封面能撤销定时器 · closing 期间 `pendingDelete`
自动收起不卡死 · 200ms 内重挂载能正常收口 · Esc 三分支顺序保持 · 删掉「顺手 toggle DOM class」
不影响（HEAD 的 className 本就由 `mvBig` 推导）· 不存在「留在 body 回不到舞台」的顺序。

---

## 5.23 第 18 轮 —— 入耳式耳机里的「电流声」（切歌 / 起播爆音）

**用户报告**：戴入耳式耳机听本插件的音乐，**每次切歌或起播都有一声电流声 / 爆音**；
系统 Apple Music 怎么切都不会有。

### 5.23.1 根因：音频通路全是硬切换，没有任何淡入淡出

`grep -n "fade\|ramp\|gain" src/client.ts` ⇒ **0 命中**（只命中无关英文文本）。逐个看音频状态
改动点，全是瞬间跳变：

| 位置 | 硬切换 |
| --- | --- |
| `attachSource` | `audio.src = <新流>` + `audio.volume = state.volume` + `play()`：旧流在**任意采样处**被掐断，新流以**满幅**起播 |
| `cueSource` | 同上（不含 play） |
| `toggle` | `audio.pause()`：全幅一步归零 |
| `stopAudio` | `pause()` + `load()`：双重硬停 |

爆音的物理成因是**波形的瞬间不连续**：输出从满幅一步跨到 0（或反过来）。
Apple Music 之所以不会，是因为它做淡入淡出（且音频图常驻）。**这不是解码质量问题。**

### 5.23.2 修法：音量短渐变（淡出 → 换源/暂停 → 淡入）

- `rampVolume(to, ms)`：16ms 步进线性推 `audio.volume`；**`state.volume` 始终是用户设定值**，
  渐变只改**瞬时值**，不写 state / prefs。
- `cancelFade()`：取消在飞渐变，**并把它的 promise 以 `false` 结算**。
- `attachSource`：正在出声 → 先淡出 70ms → 换源 → `play()` → 起播后淡入 90ms；
  **没有声音可淡 → 完全同步起播**（见下）。
- `toggle` 的暂停路径：先淡出再 `pause()`；被后续动作取消时（`ok === false`）**不暂停**。
- `setVolume`：先 `cancelFade()` 再设值（用户拖动优先）。
- `stopAudio` / `halt()`：先 `cancelFade()` + 瞬时音量落 0，然后**立刻**断开（不等渐变）。

### 5.23.3 三条实测教训（都留了代价）

1. **把起播塞进 `await` 之后 → 6 套既有回归当场变红。** 第一版无论是否在播都走
   `await fadeOutBeforeCut()`，起播时序整体后移一个微任务；`progress bar` / `resume after cut` /
   `refresh remap` / `restore race` / `teardown` / `delete flow` 六个套件报
   `playCount=0` / `src=`。**修法：没在播时完全同步起播**（与引入渐变之前逐字一致）。
2. **判据写错会一直走错分支。** 我最初写 `audio.paused || audio.volume <= 0.001` ——
   夹具的假元素**没有** `paused` / `volume` 属性时 `undefined || (undefined <= 0.001)` 两个分支
   都是 false，于是「暂停中」被判成「正在播」，异步路径永远生效。
   改成「**确定正在出声**才淡出」：`paused === false && Number.isFinite(volume) && volume > 0.001`。
3. **我自己的断言也可能是假的。** 第一版 A1 断言「`play()` 之后 src 必须**同一 tick** 挂上」，
   它红了 —— 一查才发现本仓库的起播路径**本来就不是同步挂源**（先 await session/库）。
   改成有判别力的形式：「30ms 内必须挂上，且之前不得有**多步**淡出」。

### 5.23.4 门禁 `scripts/test-audio-fade.mjs`（15 条断言）

夹具是**记录操作顺序**的假媒体元素（`paused` / `volume` 都是真属性，每次写入记 `{op, v}`），
因为要断言的正是**谁先谁后**。覆盖：A 首播不等淡出（30ms 内挂源 + 之前最多一次归零写入）·
B 播放中换源前必须**多步**淡到 ~0 且单调 · C 换源后淡回用户值 · D 暂停前先淡出 ·
E **淡入进行中**改音量不被覆盖 · F 连切后音量正确且渐变已结算（不挂住）·
G `halt()` 后不得再写 `audio.volume` 且已静音。

**三条负向对照，各自精确变红**（每次都 `tsc` 重建产物，§9 第 5 条）：

| 对照 | 结果 |
| --- | --- |
| `attachSource` 永不淡出（`audible = false`） | `FAIL B2 … steps=1` |
| 暂停退回直接 `audio.pause()` | `FAIL D1 … pause@0 fade=[]` |
| `setVolume` 不取消在飞渐变 | `FAIL E1 … volume=1.000 want=0.33` |

> **E 的第一版没有判别力**：我把「改音量」和「换源」放在同一刻，那次淡入的目标本来就是新音量，
> 取不取消 `cancelFade` 都能过（对照 C 一度 **ALL PASS**）。改成在**淡入途中**（t≈120ms）改音量
> 之后，对照才精确变红。**这正是 §6.1 第 7 条要求做对照的原因 —— 不做对照我不会发现它。**

### 5.23.5 验证边界（必须如实说）

jsdom **没有音频输出**。本套件验的是「**不产生瞬间跳变**」的**机制与时序**，
**不代表真实听感已经验证**。真实结论需要戴耳机人工确认 —— 这一条写进了 `AGENTS.md §2.18`。

### 5.23.6 验证

`typecheck` 0（基线 0）· **`ALL 28 SUITES PASS`**（新增 `test-audio-fade`，已注册进 `run-all`）·
`check-build-fresh` 一致 · `check-strict` 通过 · manifest PASS · `git diff --check` clean ·
AGENTS.md 59,828 B（91.3%）· README 同步为 28 套

---

## 5.24 过程失误 —— 第 16 轮的代码两轮没进仓库，而文档已在声称「完成」

**发现方式**：第 18 轮收口时 `git status --short` 里 `scripts/test-view-persistence.mjs` 显示为
**`A`（新增）** —— 一个我在第 16 轮就写好、`run-all.mjs` 里也注册了、AGENTS 与台账都记了「已完成」
的套件，**在 git 里从来不存在**。

**实际影响**：第 17 轮推出去的 `cc5a9a9` **不含第 16 轮的修复**。任何在那段时间从 GitHub 安装的人
拿到的是「切到「对话」再切回「音乐」就退回列表页」的旧行为 —— 而仓库文档、`AGENTS.md §2.17`、
台账 §5.22 都在说这个 bug 已修。**文档与仓库实际状态不一致，持续了两轮。**

**为什么没被发现**：

1. 第 16 轮我跑了全套门禁（本地 `lib/` 全绿），就据此写了「完成」——
   但**门禁读的是工作区，不是 git 索引**。工作区绿 ≠ 已提交。
2. 第 17/18 轮开头我没检查 `git status`，直接基于「上一轮已完成」的假设继续。
3. 第 17 轮那次 `git add -A` 提交（`cc5a9a9`）**只**显示了 `AGENTS.md` / `README.md` /
   `docs/audit-ledger.md` / `docs/compatibility.md` 四个文件 —— 这个信号就在眼前（第 16 轮的
   `src/client.ts` 和测试文件都不在里面），但我当时**没有把「少了文件」当成异常**。

**这与 §6.1 第 2 条是同一类错误**：「禁止把 README / 注释的自我描述当事实」——
只不多这次的「自我描述」是**我自己上一轮的结论**。**上一轮的结论同样是待证事实，不是前提。**

**处置**：`c69dabe` 已把第 16 轮的全部改动（`src/client.ts` / `lib/client.js` /
`scripts/test-view-persistence.mjs` / `run-all.mjs` 注册）与第 18 轮的淡入淡出一起提交并推送，
CI 绿。此后 `AGENTS.md` 的「已完成」才等于仓库里的状态。

**新增判据（已写进 `AGENTS.md §0.4` 第 7 条与 §6.1 第 9 条）**：

> **收口 = 提交 + 推送 + `git status --short` 为空 + CI 绿。** 只跑门禁不算完成 ——
> 门禁验的是**工作区**，`git status` 才验**仓库**。文档里写「已完成」之前，先确认它在 HEAD 里。

**同族教训**（可以推广的形态）：**「验证通过」与「已交付」是两个不同的断言**，
各有各的证据来源。把前者的证据拿来说后者，就是这一轮的失误。

---

## 5.25 第 19 轮 —— 「电流声」真因：输出设备被反复重建（第 18 轮的判断被推翻）

### 5.25.1 第 18 轮的结论被用户实测推翻（按 §6.2 新写条目，不覆盖）

第 18 轮我按「波形瞬间跳变」做了音量淡入淡出，并把 §2.18 写成规则。**用户实测：电流声依旧。**
⇒ 「音量跳变」这个假设**不足以解释症状**。按 §6.2，判定推翻**新写一条**，不修改 §5.23。

**我的方法错误**：第 18 轮我没有**任何**指向该成因的证据，只是「这个解释听起来合理」就动手了，
并在交付里写了「已修复」。**没有证据的成因假设，不管多合理，都不该以「已修」交付。**

### 5.25.2 取证：从用户机器上取，而不是继续猜

| 证据 | 结果 |
| --- | --- |
| 曲库采样率分布（ffprobe 全库实测） | **44.1kHz 133 首 · 48kHz 10 首 · 96kHz 5 首** |
| 位深分布 | **16bit 与 24bit 混排**（63 + 53 首 16bit、17 首 44.1k/24bit、9 首 48k/24bit） |
| 宿主响应头（运行中的 :3080 实测） | 媒体 206 + `content-type: audio/flac`，**无 `access-control-allow-origin`** |
| 正常切歌路径 | `playIndex` **不**调 `stopAudio`，只换 `src`（排除「多余拆管线」） |

**机制**：Chromium 为**每一条媒体源**单独建一条音频输出流；换 `src` = 「销毁旧流 + 按新文件的
采样率与位深建新流」⇒ macOS 必须重协商输出设备格式。**设备重建就是那一声电流声**，
而它发生在**增益级之外** —— 所以第 18 轮的音量渐变**原理上**消不掉。Apple Music 不会，
是因为它用**一条固定采样率的混音总线**。

### 5.25.3 修法：常驻音频图（与系统播放器一致）+ 媒体窄名单 CORS

- `src/client.ts`：常驻 `AudioContext` + `createMediaElementSource` + `GainNode`。
  一条输出流、一个固定采样率，所有媒体重采样进去 → 设备格式不再变。
- 渐变改走 `linearRampToValueAtTime`（**采样级**），比 16ms 定时器写元素音量更平滑。
- `src/host.ts`：`mediaCorsHeaders` 只对**窄名单**（`dsh-app://app` + 回环 origin）回显 ACAO；
  `mediaPreflight` 应答 `OPTIONS`（`Range` 不是 CORS 安全列表头），媒体端点三个都放行
  （**含 `system-stream`** —— 桌面版实际走的就是它）。
- **三级降级**：拿不到 AudioContext/建图失败 → 永久退回元素音量；跨源且未确认 CORS →
  先直连 + 后台探一次，确认后下一首才建图；兜底开关 `?musicGraph=0`。

### 5.25.4 门禁抓到的**静音 bug**（比电流声严重）

`test-audio-graph.mjs` 的 B2 断言「建图后元素音量必须置中性」，第一次跑就**红了**：

> 建图**之前** `applyVolume(0)` 写的是**元素音量**；建图**之后**真正的增益才在图里。
> 不把元素音量置中性 = 「元素 0 × 增益」= **第一次起播完全没声音**。

**这是本轮最值钱的一条**：如果没有这条断言，我会带着一个「改成静音」的修复交付，
比原来的电流声糟糕得多。**断言写在「机制是否正确」上，才会连我自己没想到的后果一起抓住。**

### 5.25.5 我在这套新门禁上踩的四个坑（全部是自伤）

1. **忘了 rebuild** 就断言 host CORS —— 门禁读 `lib/`，控制组/被测组都是旧产物（§9 第 5 条）。
2. **夹具写成 `{...media, get src(){}}`** —— 这是**拷贝**，`play()` 改外层、断言读副本，
   `ctx=0` 的假象由此而来（§9 第 4 条，本套件第三次栽在夹具保真度上）。
3. **`dsh-app://app` 当 jsdom 的 URL** → opaque origin → `localStorage` 抛 `SecurityError`。
   跨源要用「页面端口 ≠ 媒体端口」构造。
4. **`crossOrigin` 没做成反射属性** → 断言读 attribute 恒 undefined。
5. **断言写错三处**：A8 期望「平台路由放行跨源预检」（事实相反，栅栏先 403）、
   A9 用 app origin（测到的是栅栏不是调度）、B9 用 opaque origin。

### 5.25.6 顺带发现的产品代码脆弱点

`sameOriginAsPage` 原来用**裸 `location`**。bundle 由宿主 `eval`，「裸 `location` 能否解析」
取决于宿主作用域 —— 本轮真机/夹具的差异正出在这里（夹具里 `location` 未定义 → 抛错 →
catch → 一律判「跨源」）。改成 **`window.location`** 后两条路都对。已写进 §2.19。

### 5.25.7 验证

`typecheck` 0 · **`ALL 29 SUITES PASS`**（新增 `test-audio-graph.mjs`，19 条断言）·
四条负向对照各自精确变红（不置中性→B2 · 无 CORS→A1/A2 · ACAO=*→A1/A2 · 跨源不设
crossOrigin→B11）· `check-build-fresh` 一致 · `check-strict` 通过 · manifest PASS · `diff --check` clean。

**验证边界**：jsdom 没有音频设备。门禁验的是「常驻一条流 / 跨源前提 / 分级回退」的**机制**，
**真实听感必须人工确认** —— 这一条写进了 §2.19，不再声称「已验证无电流声」。

---

## 5.26 一次**原因未能确定**的 CI 失败（如实登记）

### 5.26.1 现象

| 提交 | CI | 产品代码 |
| --- | --- | --- |
| `9a21c72`（第 17 轮文档） | **success** | — |
| `a4e6e92`（第 19 轮：常驻音频图 + CORS + 新门禁） | **failure** | 改 |
| `827602c`（只改 run-all / 新门禁 / ci.yml 的**诊断**能力） | **success** | **与 a4e6e92 逐字节相同** |

`827602c` 的 `lib/` 与失败那次**完全一致**，却绿了。⇒ **那次红不是产品代码引起的**
（否则同样的 `lib/` 必然再红）。推断指向**新加的门禁套件自身抖动**。

### 5.26.2 为什么我拿不到日志（两层缺陷，都已修）

1. **`run-all.mjs` 把 stderr 整个吞掉了**（运算符优先级）：
   `console.log(run.stdout ?? '' + run.stderr ?? '')` ≡ `stdout ?? ('' + stderr)` —— stdout 永远
   非 null，所以 **stderr 从没被打印过**。崩溃/未捕获异常都走 stderr ⇒「失败但零信息」。
2. **CI 日志对无 token 的 API 不可读**：`/actions/jobs/<id>/logs` 返回 403，所以从外部
   只剩 annotation 可读。

修法：`run-all` 分别打印 stdout / stderr / spawn error / 被杀信号；`ci.yml` 在失败时把输出尾部
以 `::error::` 输出（annotation 可读）；新套件注册 `uncaughtException` / `unhandledRejection`
→ 打成一条 FAIL 再退出，并加「A0: 库扫描在 30s 内完成」守卫。

### 5.26.3 我做了什么（**不能声称「已修复」**）

- **如实说明：失败的具体套件与原因我没能确定**，因为当时没有可读的诊断输出。
- 可用的证据只有「耗时」（125s vs 119s）—— 但 `run-all` **失败也继续跑完**所有套件，
  所以耗时**无法**区分是哪一套挂的。这一步我判断错了方向，浪费了一轮。
- 在本机把最可能受负载影响的 5 套各跑 5 遍：**全部 5/5 通过**，本机不可复现。
- 决定性动作：**把新套件里的固定 `sleep` 全部换成有界轮询 `waitFor`**。断言口径**未变**
  （仍断言最终值与机制），只是不再赌「固定 sleep 够长」。改后连跑 **8/8** 通过。

### 5.26.4 沉淀

- **失败必须留下可外部读取的原因**。日志不可达时，annotation 是唯一的出口 —— 门禁的
  「诊断可用」不只是打印 stderr，还包括**让失败能被不在现场的人定位**。
- **判断「哪一套挂了」不能靠总耗时**：`run-all` 失败后仍继续，总时长不随失败位置变化。
  这也是我在 §5.26.3 里说的方向性错误。
- **「修好了」需要证据**。本轮我只做到「更稳 + 下次可诊断」，**没有**找到根因；
  台账如实标注状态为**未定因**，不写成「已修」。

---

## 5.27 第 20 轮 —— 调研 Musish（结论：**帮不到**）+ 补 sampleRate 诊断

### 5.27.1 用户提供的线索：`github.com/Musish/Musish`

Musish 是知名的开源 Apple Music **Web 客户端**，正好也是「在浏览器里放 Apple Music」的场景，
所以值得查它有没有处理设备协商的代码。**结论：没有，而且原因很说明问题。**

实测（`git clone --depth 1`，HEAD `9846878`，最后提交 2020-08-30）：

| 在 Musish 里搜 | 结果 |
| --- | --- |
| `AudioContext` | **0 处** |
| `createMediaElementSource` | **0 处** |
| 自建 `<audio>` / `<video>` / `new Audio(` | **0 处** |
| 媒体 `crossOrigin` | 0 处（唯一命中是 Font Awesome 的 `<link crossorigin>`） |
| `fade` | 16 处 —— **全是 CSS `@keyframes fadein` 的 UI 动画**，与音频无关 |
| 它自己的音频 API 面 | 只有 `music.player.play()` / `player.volume` / `player.seekToTime()` |
| 音频相关配置 | 仅 `bitrate: MusicKit.PlaybackBitrate.HIGH` |

⇒ 它把**全部播放**委托给闭源的 **MusicKit JS**。**Apple 那套「不爆音」的管线就在 MusicKit JS
内部，而它是闭源的**；Musish 只是 UI 外壳。**所以这个方向拿不到我们想要的东西**（记在这里，
避免以后重复调研）。

### 5.27.2 但调查带来一个**独立确认**：我们的修法就是 Web 音频的标准做法

对照 **howler.js**（Web 音频播放器的事实标准库，本地音乐 Web 客户端普遍使用）：

- `Howler.ctx = new AudioContext()` —— **进程级一个常驻 ctx**，不是每个声音一个
- `Howler.masterGain = ctx.createGain()` + `connect(ctx.destination)` —— 一个总增益
- 每个声音 `connect(Howler.masterGain)`；音量走 `masterGain.gain.setValueAtTime(vol, ctx.currentTime)`
  —— **采样级调度**
- 源码注释明确写了采样率的坑：*"Bugs in the browser … can cause the sampleRate to change from
  44100 to 48000. By calling Howler.unload(), we create a new AudioContext with the correct sampleRate."*

⇒ **常驻 ctx + 总增益 + 采样级渐变**正是第 19 轮实现的架构，不是猜的。

### 5.27.3 由此补的一条诊断（本轮唯一代码改动）

**`AudioContext.sampleRate` 在创建时就固定**（howler 为此专门 close 重建 ctx）。这意味着
「**设备在页面打开之后才换**（插上耳机）」的场景，ctx 可能钉在旧设备/旧采样率上 ——
而正是这位用户的使用方式。

以前这个数字**没有暴露**，外部无法判断。现在建图时留一行**无凭据**诊断：

```
[dsh-music-player] 常驻音频图已启用：sampleRate=48000Hz state=running（所有媒体重采样到这条流，输出设备格式不再变）
```

回退路径同样各留一行（无 AudioContext / 建图失败 / 跨源 CORS 探测结果）。这符合 §2.16
「在行为发生的那一刻记」——**只看失败是不够的，成功那一刻的状态也要能看到**。

门禁 `test-audio-graph` 新增两条把它们钉死：
**B12** 建图时必须留下含 `sampleRate` 的诊断；**B13** 诊断行**不得含 URL 或 `t=`**
（§2.9：能力 token 就在 query 里）。

### 5.27.4 类型棘轮当场抓到一处

`catch (error)` 里 `error.name` 报 `TS2339` —— `useUnknownInCatchVariables` 是打开的
（§2.15），catch 变量必须**先收窄**（`error instanceof Error`）。类型基线 0 让它立刻变红。

### 5.27.5 验证

`typecheck` 0 · **`ALL 29 SUITES PASS`** · `check-build-fresh` 一致 · `check-strict` 通过 ·
manifest PASS · `diff --check` clean。**真实听感仍未验证**（jsdom 没有音频设备），
诊断的目的正是让用户与我能从外部判断机制是否生效。
