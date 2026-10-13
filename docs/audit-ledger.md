# 审计台账（完整证据）

> 本文件是 `AGENTS.md` §5 的完整版，只追加不删。规则、门禁、迭代协议在 [`AGENTS.md`](../AGENTS.md)。
> 拆出原因：`AGENTS.md` 是 workspace 指令文件，有 64 KiB 注入预算上限（撞上后尾部会被静默截断）。
# 审计台账（只追加，不删）

### 5.1 台账约定

每条登记项固定字段：

| 字段 | 含义 |
| --- | --- |
| `ID` | `D-xx`＝规范落盘时已知的偏差；`A<轮次>-xx`＝某轮审计新发现 |
| `严重度` | 高 / 中 / 低。越权、凭据泄漏、路径逃逸、孤儿进程一律高 |
| `位置` | `文件:行号`，必须实测得到 |
| `规范依据` | `文件名:行号` + 原文关键措辞 |
| `判定` | 违规 / 符合 / 规范未覆盖 |
| `门禁` | 现有套件是否拦得住；拦不住就是门禁盲点，必须记下来 |
| `状态` | 待修 / 已修 / 接受（附理由） / 待定 |

只追加不改判。已修项保留原始记录并补 `已修` 与修复 commit；判定被推翻的写新的 `A<轮>-xx` 说明推翻理由，不覆盖旧条目。

### 5.2 第 0 轮 —— 规范落盘时记录的既有偏差

改到这些地方时不要扩大偏差，要收窄或按「处置方向」修：

| ID | 严重度 | 偏差 | 规范依据 | 处置方向 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `D-01` | 中 | `requires.contracts` 未声明 `storage.dsh/v1alpha1` / `LocalStorage`；插件自己往 `$DSH_HOME/storages/dsh-music-player.json` 写文件（消耗 `fs.write`） | `storage.zh.md:20` consumer 通过 protocol requirement 声明 | 要么改走协议 provider，要么在 manifest/README 显式说明这是自建文件存储而非协议消费 | 接受（已在 README 声明为自建存储） |
| `D-02` | 低 | 权限名 `storage.local` 不是规范动作名 `storage.local.read` / `storage.local.write` | `storage.zh.md:75` | 若改用 LocalStorage 协议，拆成 `.read` / `.write` | 待定 |
| `D-03` | 中 | 自建「能力 token」（`/api/dsh-music/system-art?t=…`）把 URL 里的 token 当凭证 | `permission.zh.md:82` grant record 不是可重放 bearer token、不能用 grant id 构造权限 | 不走 grant 而是自建路径凭证。必须保证：token 随机、只随鉴权过的 session 下发、不进日志（`lifecycle.zh.md:133`、`storage.zh.md:101`） | 待定（见 `A1-02`） |
| `D-04` | 低 | 封面代理用主机后缀匹配（`.mzstatic.com` 等）判断资源范围 | `permission.zh.md:119` 不得用字符串前缀等未规定方法判断域名 scope | 产品侧尚无该机制时的插件内补偿栅栏；上游提供标准 scope 后迁移 | 接受 |
| `D-05` | 低 | `contributes["x-dev.dsh-std.extensions"]` / 顶层 `x-dsh-transition` 是自定义扩展 | `manifest.zh.md:64` 扩展不得暗含 required 行为 | ~~已把 `browser.ui.dsh/v1alpha1` 标 `optional: true` 并补 `fallback`~~ → 判定推翻，见 `A4-02`/`A4-03`：该坐标在基线与宿主都是 0 命中（编造的），补 `fallback` 不构成修复，只让空壳声明看起来完整 | 待修（原标「已修」有误，`§5.10` 记录更正） |
| `D-06` | — | `dsh-plugin.json` 不被 DSH 运行读取（0.1.7-rc.2 全仓 0 处引用） | —— | 它是生态/市场侧产物。改它不影响运行时，但改了仍必须跑 `check:manifest` | 接受（事实记录） |

### 5.3 第 1 轮 —— Lead 自审：路由注册面 + lifecycle 释放面

基线：`node scripts/run-all.mjs` → 18/18 PASS。下列 6 条没有任何一条被现有门禁拦住。

| ID | 严重度 | 一句话 | 规范依据 | 门禁 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `A1-01` | 高 | `host.js` 实现 18 个端点，`connection.fetch` 只注册 11 个，`manifest` 只声明 10 个 —— 三方漂移，7 个端点在无 `webServer` 的宿主形态下不可达 | `manifest.zh.md:64`、`composition.zh.md:82`、`:143` | ❌ 盲点 | 待修 |
| `A1-02` | 高 | 客户端「一次性回落探测」用 404 作「宿主是旧入口」的信号，而 404 在本插件是正常业务语义（无封面 / MV 缓存未命中），会被无关 404 提前烧掉；探测成功则永久降级到旧前缀，丢掉 `/api` 连接层信任栅栏 | `composition.zh.md:143`、`permission.zh.md:86` | ❌ 盲点 | 待修 |
| `A1-03` | 高 | `mvJobs` 永不删除且 `dispose()` 不终止在飞 ffmpeg 子进程 —— 卸载/热重载后孤儿进程继续跑；Map 无界增长；module 级状态随 ESM 注册表每次热重载永久泄漏一份 | `lifecycle.zh.md:107`、`:105`、`:118` | ❌ 盲点 | 待修 |
| `A1-04` | 中 | 热重载先 `dispose()` 旧实例再 `import()` 新实例；新实例创建失败时旧实例已销毁，无回滚/降级（仅下一次请求重试） | `composition.zh.md:143` | ❌ 盲点 | 待修 |
| `A1-05` | 中 | HTTP 错误响应把 `error.message` 原样返回，泄漏本地文件名/绝对路径（如 `文件不存在：<歌名>`、Node `ENOENT ... '/Users/...'`） | `storage.zh.md:95`、`permission.zh.md:111`、`lifecycle.zh.md:133` | ❌ 盲点 | 待修 |
| `A1-06` | 低 | `registerLegacyRoute` 有被双次注册的边界（`connection` 在但 `connection.fetch.register` 不可用时会与 `webServer` 回调各注册一次） | `composition.zh.md:118` 无通用「最后注册者覆盖」 | ❌ 盲点 | 待定（防御性缺口，真实 DSH 走不到） |

### 5.4 第 1 轮证据与复现

`A1-01` —— 三方漂移（实测，非静态推断）

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
- `connection.fetch` 是精确路径匹配，不是前缀：`dsh 0.1.7-rc.2` 的 `packages/client/connection/lib/index.js:625-634` 用 `fetchRoutes` Map 按 `route.path` 精确查表，重复路径直接抛 `exact Fetch route … is already registered`
- 后果：`x-dsh-transition` 明确声明支持「0.1.6 形态的 desktop-host」（`webServer` 行被 `disabled: true`，只有 `connection`）。在该形态下这 7 个端点全部 404 → MV 播放、MV 进度拖动、Desktop 封面（`system-art`/`system-stream`）全断。这与 `lib/index.js:139-141` 自述的「Desktop 上这是唯一可达的通路」直接矛盾
- 门禁盲点：`scripts/test-desktop-routes.mjs:104-118` 的 `expected` 列表是手工硬编码的同一份 11 条，断言写成 `expected.every(p => routes.has(p))` —— 只查单向包含，且期望值来自注册面而非分派面，结构上无法发现这次漂移

`A1-02` —— 404 当信号 + 静默降级

- `lib/client.js:664-673`：`if (response.status === 404 && !endpointProbed) { endpointProbed = true; … }`，且 `endpointProbed = true` 写在探测之前（`:667`）
- 正常业务 404 的来源：`lib/host.js:1696`/`:1715` `no embedded cover`、`:2042`/`:2094` `mv cache miss`、`:1472`/`:1474` `文件不存在：`、`:1370`/`:1466` `track not in current library`
- 后果一：Web/Desktop 上第一次碰到无封面的曲目或 MV 缓存未命中，就把唯一一次回落窗口烧掉 —— `A1-01` 那 7 个端点在需要回落时救不回来
- 后果二：若探测成功，`endpointBase` 被永久切成 `LEGACY_API_BASE`（`/dsh-music/api`），而 `x-dsh-transition` 自己写明「信任边界交给连接层：Web/0.1.7 Desktop 走 `/api` 的 Host/Origin 栅栏 + 浏览器会话」—— 切成旧前缀等于放弃连接层栅栏，降级为插件自建检查。这属于 `composition.zh.md:143` 说的「悄悄把降级当正常」

`A1-03` —— 孤儿 ffmpeg + 无界增长 + 每次热重载永久泄漏

- `lib/host.js:157` `const mvJobs = new Map()` 是 module 级；全文只有 `:235` `get` 与 `:241` `set` —— `mvJobs.delete` / `.clear` / 容量上限全都没有（已 grep 确认）
- `lib/host.js:2176-2192` `dispose()` 清了 `library`、封面/art/match 缓存、tag worker，完全没有触碰 `mvJobs` 或 `job.child`（已 grep 确认无 `mv`/`child`/`kill` 字样）
- `:199-200` 把 `spawn()` 出的 `ChildProcess` 存进 `job.child`，无 `AbortController`、无 `kill` 路径
- 后果：(a) 卸载/热重载后 ffmpeg 继续跑到结束，往 `os.tmpdir()/dsh-music-mv` 写 `.part`；(b) `mvJobs` 每首视频一条记录，每条持 `ChildProcess` 引用 + 最多 4000 字符 `job.log`，无上限；(c) `lib/index.js:54-58` 自己说明「每次 import 都会在 ESM 注册表里留下一个无法卸载的模块条目」，而 module 级 `mvJobs` 随该条目被永久持有 —— 每次热重载永久泄漏一份
- 对照（说明这是同一模式漏了一处，不是设计取舍）：tag worker 路径做对了 —— `:1281-1287` `failAllTagJobs` 清 timer + resolve + delete 条目，`:2182-2191` dispose 里 `failAllTagJobs()` + `tagWorker.terminate()`，`:1312`/`:1336` 双 `unref()`
- 门禁盲点：`scripts/test-lifecycle.mjs` 覆盖面不弱（`:62` dispose 后路由摘除、`:69` 在飞扫描取消、`:82`/`:83` 5 轮无资源/句柄增长、`:84` dispose 后进程空闲），但它只驱动 `/api/library` 扫描，从不启动 MV 任务，所以测不到

`A1-04` / `A1-05` / `A1-06` 位置

- `A1-04`：`lib/index.js:67-81`（`dispose()` → `host = null` → `await import()` → `createHost()`；后两步任一抛错即 `host` 停在 `null`）
- `A1-05`：`lib/index.js:91`（`failResponse`）与 `:112`（`handleRequest`）都返回 `error.message`；错误文本来自 `lib/host.js:1472`/`:1474`（`'文件不存在：' + track.name`）。Node `fs` 报错本身含绝对路径
- `A1-06`：`lib/index.js:196-202`

### 5.5 第 1 轮结论

- 现有 `npm test`（18 套，全绿）与这 6 条发现完全不相交 —— 门禁的失败面集中在「功能对不对」和「进程句柄有没有涨」，没有一条覆盖「声明面 ↔ 注册面 ↔ 分派面是否一致」。
- 因此第 1 轮最该补的不是功能测试，是一致性门禁：见 §6.3。

### 5.6 第 2 轮 —— 门禁有效性 + 传输面覆盖

基线：`node scripts/run-all.mjs` → 18/18 PASS（Node v24.21.0，DSH 0.1.7-rc.2 / `477b4f42`）。本轮由独立审计员产出，Lead 逐条复核。

| ID | 严重度 | 一句话 | 规范依据 | 门禁 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `A2-01` | 高 | 一个已提交进 HEAD 的 `TEMP DIAGNOSTIC` 探针把每个请求（含 query 里的能力 token）明文落盘到 `/tmp/dshm-probe.log`；该写盘不在任何已声明 permission scope 内，且挡在路由分发之前 | `storage.zh.md:101`、`permission.zh.md:55`/`:111`、`lifecycle.zh.md:133` | ❌ 盲点 | 待修 |
| `A2-02` | 高 | README:270 主张的「真实 Chromium + CDP 量布局」防线在仓库里不存在；8 个客户端套件全走 jsdom | 文档与代码不符 | ❌ 盲点 | 待修 |
| `A2-03` | 高 | 传输面覆盖 1/10：只有 `test-desktop-routes` 驱动 `connection.fetch`；`test-mv` 只注入 `webServer` → 「MV PASS」验证的是旧前缀通路，Desktop 的 `connection.fetch` 通路零覆盖且 5 个 MV 端点在该通路不可达 | `composition.zh.md:143` | ❌ 误导性绿灯 | 待修 |
| `A2-04` | 中 | README:195「匹配套件会真实联网」与代码相反：`test-match.mjs:5` 自述 hermetic，`:45-108` stub `globalThis.fetch` | 文档与代码不符 | ❌ | 待修 |
| `A2-05` | 中 | README:163「macOS 走 `~/.Trash`」与实际不符：`/api/delete` 是 `fs.unlink`（`lib/host.js:2133`）永久删除；`~/.Trash` 只在 MV 的 `deleteOriginal` 路径（`:1990-1996`） | 文档与代码不符 | ❌ | 待修 |
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
| `A2-17` | 低 | 文件名序号清洗只断言「合法前导数字被保留」，清洗行为本身未断言 | 门禁缺失（部分） | ❌ | 待修 |
| `A2-18` | 低 | `lib/host.js:327` 注释「差 >10s 一律不自动写入」与实现不符：`delta == 10` 时 `durationScore` 返回 `0.55` 仍放行（`:494-496`、`:555-556`） | 文档与代码不符（注释） | ❌ | 待修 |
| `A2-19` | 低 | 本仓库无 `typescript`、无 `tsconfig.json`，`tsc --noUnusedLocals` 无法执行 | 约定不可执行 | — | 已修（§4） |

#### 5.6.1 `A2-01` 证据（凭据落盘，实测）

- 代码：`lib/host.js:1736-1757`，注释自称「TEMP DIAGNOSTIC（排查完删掉）」，`await fs.appendFile('/tmp/dshm-probe.log', JSON.stringify({ …, url: req.url, host, origin, referer, cookie: !!cookie, ua }) + '\n')`，位于 `dispatch()` 开头、路由分发之前
- 已提交：`git show HEAD:lib/host.js | grep dshm-probe` → 命中 `:1740`；`git status --porcelain lib/host.js` 为空（工作树 == HEAD `389b6e5`）
- 实机文件：`/tmp/dshm-probe.log` 549842 字节 / 2620 行，`grep -c 'system-\(art\|stream\)?t='` → 5 行含能力 token；`"via"` 分布 `legacy=2495 / fetch=120 / system-art=5`
- scope 越界：`dsh-plugin.json` 的 `fs.write` scope 是「当前音乐目录内、且在播放列表中的音频文件」，`storage.local` scope 是 `$DSH_HOME/storages/…` + localStorage —— `/tmp` 两者都不是 → 违反 `permission.zh.md:55`
- 安全属性：文件权限 `-rw-r--r--`（同机其他用户可读）

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

`test-mv.mjs:50` 只注入 `webServer: { register }`，没有 `connection` → 它验的是旧前缀通路。而 `mv`/`mvfile`/`caps`/`mvlib`/`mvconvert` 不在 `FETCH_ROUTES` 里，`connection.fetch` 又是精确匹配 → Desktop 走的那条通路既不可达、又零覆盖。客户端确实在调它们（`lib/client.js:1136-1138`、`api("/api/mv?id=")`）。这解释了 `A1-01` 为什么能在「MV 套件 PASS」的同时为真。

#### 5.6.3 Lead 自身错误（本轮建立，必须单列）

| ID | 我做了什么 | 为什么错 | 已修 |
| --- | --- | --- | --- |
| `E-01` | 在 README「依赖、权限与失败边界」里写「`fs.delete`：删除曲目（macOS 走 `~/.Trash`）」 | 我看到 `host.js:1992` 有 `~/.Trash` 字符串就当成删除路径，没核实它属于 MV 的 `deleteOriginal` 分支；实际 `/api/delete` 是 `fs.unlink` 永久删除（且与 README:17 自相矛盾） | README 待修（`A2-05`） |
| `E-02` | 在 README 里写「`npm test` 中的匹配套件会真实联网……不是离线测试」 | 我只看了套件名字（"online metadata match"）就下结论，没读 `test-match.mjs:5` 的 `hermetic` 自述与 `globalThis.fetch` 桩 | README 待修（`A2-04`） |
| `E-03` | 在 AGENTS.md §4 把 README:270 的「真实 Chromium + CDP 量布局」写成既有防线 | 把 README 的自我描述当成事实，没验证仓库里有没有浏览器启动器 | ✅ 已修 §4（标注为 ❌ 不存在） |
| `E-04` | 在 AGENTS.md §4 写「改完用 `tsc --noUnusedLocals --noUnusedParameters` 扫一遍」 | 抄自 `.jspace/WORKSPACE.md` 的历史条目，没核实 `typescript`/`tsconfig.json` 是否存在 | ✅ 已修 §4（标注为不可执行） |

> 教训（已沉淀为 §6.1 第 2 条）：README 的自我描述不是事实来源。 任何「本仓库已有 X 防线 / 已有 Y 约定」的说法，引用前必须实测存在（`glob`/`grep`/实跑）。

#### 5.6.4 第 2 轮结论

现有门禁的骨架真实有效（18/18 实跑通过；失败能真的非零 —— 负向对照 `DSH_MUSIC_HOST=/dev/null node scripts/test-perf.mjs` → exit 1；18 个 `test-*.mjs` 与 `run-all.mjs` 的 `suites` 集合完全一致；静态审计 6 项与按钮接线防线均落地；封面策略 / 安全栅栏 / 生命周期有硬断言）。但它强在「功能对不对」与「句柄涨不涨」，在三个面是空的：

1. 声明面 ↔ 注册面 ↔ 分派面一致性（`A1-01`）
2. 传输面覆盖 —— 1/10 套件打在生产使用的通路上（`A2-03`），这使第 1 类缺陷表现为绿灯
3. module 级容器与子进程的释放（`A1-03`）

### 5.7 第 3 轮 —— Lifecycle 释放面（客户端 + 宿主）

基线沿用 §5.3 的 18/18 PASS（本轮只读，未重跑）。独立审计员逐行读 `lib/index.js` / `lib/host.js` / `lib/client.js` / `lib/tagwriter.js` / `lib/http-bridge.js` 及 cordis、`dsh-client-runtime` 的 vendored 实现。

| ID | 严重度 | 一句话 | 规范依据 | 门禁 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `A3-01` | 高 | 客户端库轮询定时器在停用后自我续期：`halt()` 只在 `pollTimer !== null` 时能清；若 teardown 撞上某次轮询在飞（回调开头已把 `pollTimer` 置 null），该请求 404 → `catch { schedulePoll(); }` 再武装，而 `halt()` 的 `set()` 不重置 `scanning` → `if (!state.scanning) return` 永不成立 → 永久 1.5s 请求风暴 | `lifecycle.zh.md:107`、`:29` | ❌ 盲点 | 待修 |
| `A3-02` | 中 | 卸载与在飞 `ensureHost` 竞态：`ensureHost` 有两个 await 挂起点，teardown effect 只把 `host = null`，无 `disposed` 标志；挂起的 IIFE 恢复后照样 `host = module.createHost(ctx)` → 产生无人持有的新 host（会 `startScan` + 可能拉起 tag worker），此后再也没人 `dispose()` 它 | `lifecycle.zh.md:29`、`:107` | ❌ 盲点 | 待修 |
| `A3-03` | 中 | 客户端 player 经 `window.__dshMusicPlayer` 跨 activation 复用：bundle HMR 换代后新 module 不再 `createPlayer()`，直接接管旧 closure 的全部 handler / timer / `playingId`；新旧 activation 的 disposer 操作同一个 player → 旧 disposer 会对新实例仍在用的对象调 `halt()` | `lifecycle.zh.md:125`、`:127` | ❌ 盲点 | 待修 |
| `A3-04` | 中 | 停用后 `document.body` 上的自建 DOM（`.dshm-mvPark` + `<video>`）与 `window.__dshMusicPlayer` 从不释放；`halt()` 既不 `remove()` 也不清 window 键 | `lifecycle.zh.md:107` | ❌ 盲点 | 待修 |
| `A3-05` | 中 | Activation context 读取未在 manifest 声明的产品 API：`ctx.get('directoryPicker')`（`lib/host.js:1907`）、`ctx.locale`（`lib/client.js:3169`）、`connection.fetch`（`lib/index.js:145`）都不是 `requires.contracts` 条目 —— `dsh-plugin.json` 全文 grep `directoryPicker` 0 处，`connection.fetch` 只出现在权限 scope 文本与扩展 `spec.transport` 里 | `lifecycle.zh.md:82` | ❌ 盲点 | 待修 |
| `A3-06` | 低 | `registerFetchRoutes` 组内按注册正序摘除（11 条路由在一个 `ctx.effect` 里注册，对 coordinator 只有 1 个 disposer；逆序条款绑定 scope 的 disposer 序列，不绑定插件自建数组次序）→ 规范未覆盖 | `lifecycle.zh.md:105` | ❌ 盲点 | 接受 |
| `A3-07` | 低 | `mvconvert` 用 `spawnSync(ffmpeg, …, { timeout: 30 * 60 * 1000 })`（`lib/host.js:1983`）→ 事件循环被独占至多 30 分钟，deactivation 无法推进，且无句柄可 `kill`、无 timeout 诊断 → 规范 L121 义务主体是 coordinator，但 L145 描述的风险真实存在 | `lifecycle.zh.md:121`、`:145` | ❌ 盲点 | 待定 |
| `A3-08` | 低 | `matchWaiters`（`lib/host.js:378`）无 `clear`/`delete` 路径 —— 但会随任务完成自行 `shift` 排空，上游请求都带 `AbortSignal.timeout`，不是真实泄漏；不满足新增 §2.2「容器必须留 clear 路径」的字面要求 | 仓库自定 §2.2 | ❌ 盲点 | 接受（非泄漏） |

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

历史 bug 复核（确已修好）：自动续播 `recoverAt`（`:1591-1602`）与自动跳曲（`:1668-1670`）经 `halt()` → `stopAudio()`（`:857-862`，`playingId = null`）+ `set({current:-1})` 使三处延迟回调的守卫全部落空，且 `test-teardown.mjs:74-83` 有回归断言。但修复是逐路径的、不是结构性的 —— 轮询这条同类路径漏了。
`test-teardown.mjs:44` 的假 payload 写死 `scanning: false`，结构上测不到。

#### 5.7.2 本轮推翻的怀疑（必须记录，避免后续重复怀疑）

- `ctx.slots.inject(...)` 未显式包 `ctx.effect` → 不是违规。 读 vendored `@deepseek-ai/dsh-client-runtime` 实现确认：它内部调用调用者的 `ctx.effect`（`lib/client.js:55-113`，`:57` `const disposeController = ctx.effect(...)`、`:81` `const disposeEffect = ctx.effect(callback, ...)`；`:15` 文档写明「declaration injection through the caller's ctx.effect (fiber unload collects both)」）。→ `lib/client.js:3183` 符合 L29。
- 插件内部路由已在该换新 module 后重新解析：`handleFetch`/`handleRequest` 每次 `await ensureHost()`（`lib/index.js:98-124`），路由不随实例重复注册 → 宿主侧不存在「旧路由被转移到新实例」。L125/L127 的违规面只在客户端（`A3-03`）。

#### 5.7.3 第 3 轮符合项（逐条款证据）

| 规范条目 | 判定 | 证据 |
| --- | --- | --- |
| L29 激活期注册绑 cleanup scope | ✅ 符合 | 宿主 `lib/index.js:146-162`/`:170-177`/`:182-191`；客户端 `lib/client.js:3169`/`:3174`/`:3175-3182`；`ctx.slots.inject` 见 §5.7.2 |
| L107 自建资源由 deactivate 释放 | ⚠️ 大部分符合 | ✅ `lib/host.js:2182-2191`（`failAllTagJobs` + `terminate` + 置 null）、`:1281-1287`（逐 job 清 timer/resolve/delete）、`:2179-2181`（清三类缓存）、`:2177`+`:1543`（`scanGeneration` 协作取消在飞扫描）、`:1312`/`:1336` 双 `unref()`；客户端 `lib/client.js:1770-1799`（`halt()` 清 `pollTimer`、`matchSeq += 1` 作废在途 match、`stopAudio`、清 MediaSession）。缺口见 `A3-01`/`A3-02`/`A3-04`/`A1-03` |
| L105 关闭顺序/至多一次/失败不阻塞 | ✅ 符合 | vendored cordis `lib/index.js:1168-1184`：`:1175` `if (disposing) return disposalTask`（幂等）、`:1178` `disposables.splice(0).reverse()`（逆序）。插件侧 `lib/index.js:154-160` 逐条 try/catch；`host.dispose()` 两处调用点都 try/catch（`:69-73`、`:184-189`） |
| L133 不持久化 context/凭据/异常对象 | ✅ 符合 | 持久化面仅 `lib/host.js:1035-1043`（只写 `{dir}`，temp+rename 原子）与 `lib/client.js:680-702`（只写音量/循环/排序/上次 id 与秒数）。能力 token `:1520` `randomUUID()` 每实例新生成，只出现在 `:2110-2113` 的 `/session` 响应里；`grep console.* lib/host.js` = 0 处 |
| L165 / L22 不得依赖 module 卸载完成清理 | ✅ 设计符合 | `lib/index.js:54-58` 注释主动承认 ESM 注册表条目无法卸载，并用 `RELOAD_MIN_INTERVAL_MS` 限流；清理靠显式 `host.dispose()`（`:68-75`、`:182-191`）而非 GC；`dispose()` 主动清 module 级缓存（`lib/host.js:2179-2181`）避免被不可回收的 module 钉住 |
| L139 Observer 不得改变状态机 | 规范未覆盖 | `grep ctx.on/ctx.emit/ctx.before/ctx.after lib/` = 0 处，无监听面 |
| L5 / L58 纯声明 facet 无 activation instance | 规范未覆盖 | `dsh-plugin.json:7-12` 只有可执行 `facets.host`；客户端 UI 走 `contributes["x-dev.dsh-std.extensions"]` 由宿主装配 |
| L118 停止后验证 support/owner 移除 | 规范未覆盖（coordinator 职责） | 外部机械验证：`test-lifecycle.mjs:62`（route unregistered on dispose）、`:69`（在飞扫描取消）、`:82`/`:83`（5 轮无资源/handle 增长）、`:84`（idle CPU） |
| L121 超 deadline 留 timeout 诊断 | 规范未覆盖（无 deadline 机制） | 仅 tag worker `TAG_WORKER_TIMEOUT_MS`（`:1275`、`:1325-1335`）超时后 resolve 带 `'标签写入超时'` 而非报告成功 —— 符合该条精神。风险面见 `A3-07` |

#### 5.7.4 第 3 轮结论

生命周期维度的结构性事实：宿主侧（`lib/index.js` + `lib/host.js`）对 L29/L105/L133 落实得比较扎实，且作者主动承认了 module 不可卸载；缺口集中在两类：

1. 「teardown 之后还能再启动」 —— `A3-01`（客户端轮询自我续期）、`A3-02`（宿主再创建孤儿 host），两者都缺同一个状态位（`disposed`）。这是 §2.2 高危区的真实复发形态，只是换了个入口。
2. 客户端 activation 的 instance 归属 —— `A3-03`/`A3-04`：`window` 全局复用让 instance 边界消失，disposer 变成共享对象上的操作。

#### 5.7.5 本轮判定撤回（`§6.2` 要求：判定推翻必须新写一条，不覆盖旧条目）

审计员在补读完 `lib/host.js:1710-1930`（首轮漏读的区间，正含 `A2-01` 探针）后主动撤回自己先前的判定：

| 条款 | 原判定 | 改判 | 原因 |
| --- | --- | --- | --- |
| `L133` 不持久化 context / 凭据 / 异常对象 | 符合（并把「token 不进日志」列为证据） | 违规 | 反例即 `A2-01`：`lib/host.js:1740` 把 `req.url`（含 `?t=<能力token>`）落盘。该条已由 `A2-01` 登记，此处只更正判定 |

**方法错误（必须沉淀，这是本轮最有价值的一条）**：审计员用 `grep "console\.\(log\|error\|warn\|info\)"` 来证明「凭据不进日志」，得出「`lib/host.js` 0 处 → 符合」。但落盘型诊断走的是 `fs.appendFile`，代码里根本没有 "log" 这个词。

→ **核查「是否把凭据写进日志/诊断」必须按「写盘 / 输出动词」搜索，不能按 "log" 这个词搜索。** 最小搜索面：

```
console.log|error|warn|info|debug   appendFile|writeFile|createWriteStream|writeFileSync
process.stdout|process.stderr       第三方 logger（pino/winston/bunyan/…）
```

已沉淀为 §6.1 第 3 条。

### 5.8 第 4 轮 —— Manifest 声明与契约一致性（manifest + composition）

基线：`check-manifest.mjs` → PASS（只证 schema 结构，不证可激活）。独立审计员产出。

| ID | 严重度 | 一句话 | 规范依据 | 门禁 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `A4-01` | 高 | `endpoints` 三方漂移（= `A1-01` 的独立复核，不再单列） | 同 `A1-01` | ❌ | 待修 |
| `A4-02` | 高 | 插件主功能在 manifest 上是未声明的：会话视图 + 宿主传输只以「无 definition 扩展」声明；三个扩展 id 在 `lib/` 下逐个 grep 均 0 命中；pinned 投影把三条扩展并入 host facet，对无 definition 扩展只产出 `unknown-extension` warning | `manifest.zh.md:64`、`:62`、`composition.zh.md:110` | ❌ 盲点 | 待修 |
| `A4-03` | 高 | 两条契约坐标是编造的：`webserver.dsh/v1alpha1` 与 `browser.ui.dsh/v1alpha1` 在整个 references 树 0 命中、在 DSH 0.1.7-rc.2 app.asar 里也 0 命中；真实坐标是 `ui.dsh/v1alpha1`/`ContributionHost`（基线）与 `web.ui.dsh/v1alpha1`（adapter）。且 `requires.contracts` 无任何 required → preflight 永不阻塞，可在零端点注册下「激活成功」（`lib/index.js:193-206`） | `manifest.zh.md:56`、`:64`、`composition.zh.md:80`、`:82`、`:143` | ❌ 盲点 | 待修 |
| `A4-04` | 中 | `fallback` 文案方向写错且夸大：`webserver` 那条说「宿主没有 webServer 时…端点改挂 connection.fetch」——实际 `/api` 路由是无条件优先注册的，`webServer` 只注册 `/dsh-music` 旧前缀；「照常激活」掩盖了 7 个端点在无 webServer 形态下不可达 | `manifest.zh.md:98-101` | ❌ | 待修 |
| `A4-05` | 中 | `prefix` 与精确路由语义冲突：声明 `HttpPrefixRoutes` 的 `prefix=/api/dsh-music` + `transport: connection.fetch`，代码注册 11 条精确路径，`webServer` 上注册的是另一个前缀 `/dsh-music` → 三处对不上 | `composition.zh.md:65`、`:143` | ❌ | 待修 |
| `A4-06` | 中 | `ContributionHost` 无 surface 列表 → 结构上永远形成不了 agreement（Community v0.15 的 contract 引用字段只有 apiVersion/kind/optional/fallback，装不下 surfaces） | `ui-contribution.zh.md:58`、`:115`、`composition.zh.md:80` | ❌ | 待修 |
| `A4-07` | 低 | 顶层 `x-dsh-transition` 被 pinned 投影整段丢弃 → 跨版本声明不进入 provenance/composition（规范未覆盖：pinned validator 行为） | `manifest.zh.md:128` | ❌ | 接受 |
| `A4-08` | 低 | `package.json dsh.compatibility` 范围宽于精确证据（0.1.6 线零记录，与 `x-dsh-transition` 的 0.1.6 实测叙述不对称） | `manifest.zh.md:113`（同原则） | ❌ | 待定 |
| `A4-09` | — | 符合：`dsh-plugin.json` ↔ `package.json` 重复项一致（version/license/source/entry/exports/files 全对得上）；`files` 无运行时必需文件缺口 | — | ✅ | — |
| `A4-10` | 低 | `facets.host.apiVersion` 被 pinned 投影忽略（实现缺口，非本仓库违规） | `manifest.zh.md:107-108` | ❌ | 接受 |

### 5.9 第 5 轮 —— Permission + 敏感数据泄漏

基线沿用 18/18 PASS。独立审计员产出（只读，含对运行中 DSH 0.1.7-rc.2 asar 的只读核对）。

| ID | 严重度 | 一句话 | 规范依据 | 门禁 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `A5-01` | 高 | = `A2-01` 独立复核（凭据落盘）。新增实测：`/private/tmp/dshm-probe.log` 含 3 行 `system-art?t=` + 2 行 `system-stream?t=`，token 为 36 字符完整 UUID | `permission.zh.md:105`/`:111`、`storage.zh.md:101` | ❌ 盲点 | 待修 |
| `A5-02` | 高 | 单一 token 同时授权 `art` 与 `stream`（后者=任意曲目全量读），进程生命周期内不过期、无轮换、不按 session 区分；唯一撤销边界是 `createHost` 闭包销毁 | `permission.zh.md:82`/`:74-80`/`:99` | ❌ 盲点 | 待修 |
| `A5-03` | 高 | `A2-01` 的升级：token 通道被永久钉在豁免栅栏的旧前缀（`lib/host.js:2109-2113` 基址硬编码 `/dsh-music`；`:2157-2159` system-* 显式豁免 `isUntrustedRequest`）。该通道既不走平台会话鉴权、也不走插件栅栏，唯一防线是 token 保密性 —— 而 token 已在世界可读文件里 ⇒ 同机任意进程可 `GET /dsh-music/api/system-stream?t=…&p=<任意曲目>` 读库内任意文件，无 cookie / 无 Origin | `permission.zh.md:86`、`:119` | ❌ 盲点 | 待修 |
| `A5-04` | 高 | 受保护操作在副作用位置无 grant 检查；`manifest.permissions` 运行期零次读取（`lib/` 全目录无 permission/grant 调用）。实际只有三道自建门：Host/Origin 栅栏、平台 `/api` 栅栏+会话、库成员 allowlist。且「用户确认」只在客户端 UI，服务端无确认凭证 | `permission.zh.md:86`/`:55`/`:68` | ❌ 盲点 | 待修 |
| `A5-05` | 中 | `ctx.get('directoryPicker')` 字符串查询未声明 Host service（已核实是真实服务 `@deepseek-ai/dsh-host-directory-picker`；服务层无授权闸门，靠 OS 对话框） | `permission.zh.md:32`/`:55` | ❌ | 待修 |
| `A5-06` | 中 | `net.fetch` 声明 scope 漏 `archive.org`（`lib/host.js:345-356` 白名单 + `:897-900` 逐跳跟随实际请求），`dsh-plugin.json:47` 未列 | `permission.zh.md:55`/`:119` | ❌ | 待修 |
| `A5-07` | 中 | 前缀/后缀判定 scope：新增 `lib/host.js:2011-2012`（mvlib 白名单前缀）、`:1048-1050`（expandHome `~/`）。未发现可利用路径逃逸（mvlib 后有 `path.resolve`+`rootWithSep`；扫描用 `readdir(withFileTypes)` 整体跳过符号链接） | `permission.zh.md:119` | ❌ | 待修 |
| `A5-08` | 中 | 三条 fs scope 都小于实际调用面：`fs.write` 最严重（`/tmp` 探针 `:1740`、`/tmp` MV 缓存 `:238`/`:248`、`~/.Trash` `:1993-1995`、非播放列表新文件 `:1978-1983`）；`fs.read` 另读 `$DSH_HOME`（`:1040`）与 `node_modules`（`:2015-2029`）；`fs.delete` 含 `rm /tmp`（`:1986`） | `permission.zh.md:55` | ❌ | 待修 |
| `A5-09` | 中 | 自建存储无任何稳定错误码（`PERMISSION_NOT_GRANTED`/`INVALID_KEY`/`INVALID_VALUE`/`QUOTA_EXCEEDED`/`STORAGE_UNAVAILABLE` 全缺）；`saveState` 全量吞错（`:1042-1044`）后 `/dir` 仍返回 200 + dir（`:1793-1795`）⇒ 持久化失败被报告为成功 | `storage.zh.md:87-93`、`:83` | ❌ 盲点 | 待修 |
| `A5-10` | 低 | uninstall 保留规则未声明：README:81 只声明不动音乐文件，未声明 `$DSH_HOME/storages/dsh-music-player.json` 的保留/清理 | `storage.zh.md:81` | ❌ | 待修 |
| `A5-11` | 低 | 包内 `lib/state.json` 被当状态来源（`:942`、`:1024-1032`），工作区该文件含开发机绝对路径；但 `.gitignore` 与 `files` 白名单均排除它 ⇒ 不进 git / 不进 npm 包，风险仅限本机 | — | ❌ | 接受 |

第 5 轮最重要的结构性发现：`A5-03` + `A5-04` 合起来说明 —— 插件的实际信任模型与它自己声称的不一致。`x-dsh-transition` 写「信任边界交给连接层」，但（a）`createSharedFetchHandler` 自身不含栅栏与鉴权（栅栏只在 `webServer` 存在时挂外层路由），（b）token 通道显式豁免栅栏并钉在旧前缀。审计员对「无 webServer 形态下谁在鉴权」标注为推断（0.1.6 desktop-host 源码不可得）。

#### 5.9.1 第 5 轮符合项（这批是真做对的）

封面 XSS 面系统性关闭（MIME allowlist `:301-308` + 读取再校验 `:1704-1709` + nosniff + 8MB 上限 `:310`/`:917`/`:924`）；封面代理非任意跳板（仅 https `:882`、主机白名单 `:883`、redirect manual 每跳重校验 ≤4 跳 `:888-906`）；请求体 64KB 上限 + 413（`:1008-1021`）；路径包含判定 + 库成员 allowlist 双重且 stream/delete/match/apply 共用（`:1361-1373`、`:1454-1477`、`:2124-2131`）；故意不泄漏 cwd（自造中文错误 `:1586-1589` + 回归断言）；token 随机源合格（`randomUUID` `:1520`）+ 精确等值比较；状态写入原子 tmp+rename（`:1038-1041`）；客户端只写 3 个 `dsh-music:*` 键、token 只存模块变量不落 localStorage；`lib/host.js` 零 console / 零 logger / 零遥测。

### 5.10 编号裁定与更正记录（第 6 轮 · 收口）

编号裁定：5 轮审计并行产出时出现过 ID 冲突。现按「先写好者占号，后到者让号」一次性裁定，此后不再改号：

| 轮次 | 维度 | ID 段 | 状态 |
| --- | --- | --- | --- |
| 第 0 轮 | 规范落盘时既有偏差 | `D-01`…`D-06` | 已登记 |
| 第 1 轮 | Lead 自审：路由注册面 + lifecycle | `A1-01`…`A1-06` | 已登记 |
| 第 2 轮 | 门禁有效性 + 传输面覆盖 | `A2-01`…`A2-19` | 已登记 |
| 第 3 轮 | Lifecycle 释放面 | `A3-01`…`A3-08` | 已登记 |
| 第 4 轮 | Manifest + composition | `A4-01`…`A4-10` | 已登记 |
| 第 5 轮 | Permission + 敏感数据泄漏 | `A5-01`…`A5-11` | 已登记 |
| 第 6 轮 | 收口：编号裁定 + 更正记录 | 本节 | — |

> 审计员各自报告里的临时编号（如 permission 轮的 `A4-01…A4-09`、lifecycle 轮的 `A2-01…A2-08`）一律以上表为准；被去重的条目已在其原轮次注明「= `Axx-xx` 独立复核」。

更正记录 1 —— `D-05` 状态由「已修」改为「待修」

我（Lead）在第 0 轮把 `D-05` 标为「已修」，理由是「给 `browser.ui.dsh/v1alpha1` 补了 `optional: true` + `fallback`」。该判定错误，第 4 轮 `A4-03` 证明：

- `browser.ui.dsh/v1alpha1` 与 `webserver.dsh/v1alpha1` 在 references 全树 0 命中、在 DSH 0.1.7-rc.2 app.asar 里也 0 命中 —— 坐标是编造的；
- 给编造的坐标补 `fallback`，只是让空壳声明看起来完整，协商层永远拿不到 definition；
- 真正的修复是改用真实坐标（`ui.dsh/v1alpha1` / `web.ui.dsh/v1alpha1`）或删掉这两条声明并在 README 说明插件走自建栅栏。

→ 教训（已进 §2.11）：`fallback` 不能把不存在的坐标洗成合规声明。"补了个字段"不等于"修好了"。

更正记录 2 —— 第 3 轮 `L133` 判定由「符合」改为「违规」

见 §5.7.5。根因是审计员按 `"log"` 这个词搜索日志面，而落盘型诊断走 `fs.appendFile`。已沉淀为 §6.1 第 3 条。

第 6 轮结论：AGENTS.md 现在与代码实际状态一致（含 5 处明确标注的编造/不实声明），但代码本身一行未改 —— 41 条台账条目中 0 条已修，其中 12 条为高。下一步不是继续审计，是修。


---

## 5.11 第 7 轮 —— 独立复核（Lead 亲自实测，不采信审计员转述）

动机：`§6.1` 第 2 条禁止把描述当事实。前 6 轮中部分载荷性主张来自审计员报告，我未亲自验证。本轮逐条实测，结果全部成立；并纠正了我自己的一个无效检验方法。

| 被复核主张 | 我的检验 | 结果 |
| --- | --- | --- |
| `A4-03` 两条坐标是编造的 | `grep -rn "webserver\.dsh\|browser\.ui\.dsh\|HttpPrefixRoutes" references/` → 0 命中；同时在 DSH 0.1.7-rc.2 运行时搜 `webserver.dsh` / `browser.ui.dsh` → 0 个文件 | ✅ 成立 |
| `A4-03` 真实坐标存在 | `ui-contribution.zh.md:55` 实测有 `ui.dsh/v1alpha1` + `ContributionHost` | ✅ 成立 |
| `A5-03` 基址硬编码旧前缀 + 回显 Host | `lib/host.js:2111-2112` 实测 `'http://' + host + '/dsh-music/api/system-art?t=' + …`，`host` 取自 `req.headers.host` | ✅ 成立（逐字） |
| `A5-03` `system-*` 豁免栅栏 | `lib/host.js:2157-2160` 实测 `isSystemPath` 含 4 条 system-art/system-stream 路径，`if (!isSystemPath && isUntrustedRequest(req)) throw 403` | ✅ 成立（逐字） |
| `A3-01` 轮询自我续期 + `halt()` 不复位 `scanning` | `lib/client.js:934-946` 实测 `catch { schedulePoll(); }`；`scanning:` 全文只出现在 `:790` 初值，未出现在 `halt()` 的 `set({…})` 里 | ✅ 成立 |
| `A2-04` 匹配套件是离线测试 | `scripts/test-match.mjs:5` 实测原文「All upstream traffic is stubbed, so the suite is hermetic.」；`:45` `globalThis.fetch = async …` | ✅ 成立 |
| `A5-09` 吞错后仍报成功 | `lib/host.js:1042-1044` 实测 `catch { /* best-effort */ }` 无重抛；`:1795` `sendJson(res, 200, libraryPayload(library))` 无条件 200 | ✅ 成立 |
| `A1-05` 错误文本含文件名 | `lib/host.js:1472` / `:1474` 实测 `'文件不存在：' + track.name` | ✅ 成立 |

### 5.11.1 我自己的无效检验方法（必须记录）

首次检验 `A4-03` 的 asar 主张时，我用了 `grep -c <pattern> bin.js`，对 `webserver.dsh` / `browser.ui.dsh` / `HttpPrefixRoutes` 全部得到 `0` —— 但同一个命令对宿主确实在用的 `conversation.view` 也得到 `0`。

（`conversation.view` 由 `lib/client.js:3183-3190` 注册，宿主必然认识。）

→ 说明检验方法本身无效（搜错了产物：`bin.js` 是 CLI 入口，不是 client bundle）。若我当时不跑这个对照，就会用一个无信息的 `0` 去「证实」一条主张。

纠正后的方法：先用一个已知为真的字符串校准搜索面（`conversation.view` → 命中 `cordis-client-runner/lib/client.js`、`ui-chat/lib/client.js` 等），再在同一批产物里搜待证字符串。

结论：`webserver.dsh` / `browser.ui.dsh` / `HttpPrefixRoutes` 在整个 DSH 运行时 0 个文件，而 `conversation.view` 命中 —— 方法有效后结论仍成立。

> 教训（应并入 `§6.1`）：**任何「0 命中」的结论，必须先用一个已知为真的样本校准同一搜索面。** 否则 `0` 可能只是「搜错了地方」。这条与前两轮的「按动词搜日志」「不把描述当事实」是同一族错误：检验方法本身也需要被检验。

### 5.11.2 本轮附带发现（比台账原文更精确）

`ContributionHost` 与 `ui.dsh/v1alpha1` 在 DSH 0.1.7-rc.2 运行时同样是 0 命中 —— 即 DSH 宿主根本没有实现 Community 的 `ContributionHost` 契约，它只用字符串 slot（`conversation.view`）。

因此 `A4-06`（`ContributionHost` 无 surface 列表 → 永远形成不了 agreement）的真实严重度高于原文：不只是「manifest 写不下列 surfaces」，而是该契约在 DSH 侧根本没有对端实现。→ `A4-06` 严重度由「中」上调为「高」，并新增说明（按 `§6.2`，这是判定变更，新写一条而非覆盖）。

### 5.11.3 第 7 轮结论

- 前 6 轮的载荷性主张经 Lead 亲自实测，无一条被推翻；台账与代码状态一致。
- 新增 1 条判定变更（`A4-06` 中 → 高）与 1 条方法学教训（校准搜索面）。
- 审计维度已全部覆盖：manifest+composition（第 4 轮）、lifecycle（第 3 轮）、permission+storage（第 5 轮）、门禁有效性（第 2 轮）、声明面/注册面（第 1 轮）—— 5 个维度各有独立审计员 + Lead 复核。
- 仍未做的事：47 条台账 0 条已修；`§6.3` 的 17 条门禁规格尚未实现。这两项不属于本目标（目标是「审计 + 迭代 AGENTS.md」），属于后续修复目标。

---

## 5.12 第 8 轮 —— 修复（按 Lead 提出的顺序执行）

基线：`node scripts/run-all.mjs` → 21/21 PASS（新增 3 套）。每条修复都补了门禁，且每条门禁都做了负向对照（把修复回退 → 门禁必须变红）。

| 条目 | 修复内容 | 新增门禁 | 负向对照结果 |
| --- | --- | --- | --- |
| `A2-01` | 删除 `lib/host.js` 的 `TEMP DIAGNOSTIC` 探针（21 行）；删除随之成为死代码的 `dispatch(req,res,entry)` 的 `entry` 参数（3 处调用点同步）；清掉实机上已长到 641,835 B 的 `/tmp/dshm-probe.log` | `test-audit.mjs` ⑦「写盘目标白名单」+「凭据不得进入写盘调用」 | 注入探针 → 2 项 FAIL / exit 1（`'/tmp/dshm-probe.log'` 不在白名单 + 凭据进写盘） |
| `A1-01` | `FETCH_ROUTES` 11 → 16 条（补 `mv`/`mvconvert`/`mvlib`/`mvfile`/`caps`）；`system-art`/`system-stream` 记为具名例外 `LEGACY_ONLY_ROUTES` | 新建 `test-route-consistency.mjs`：`host.js` 分派表 == `FETCH_ROUTES ∪ LEGACY_ONLY_ROUTES` == manifest 登记表（三向相等 + methods 对齐） | 删 `FETCH_ROUTES` 一条 → FAIL `mvfile`；删 manifest 一条 → FAIL `mvlib` |
| `A2-03` | `test-desktop-routes.mjs` 的 `expected` 改为从 `lib/host.js` 分派表推导（不再手工抄），并加「注册面不得超出推导集合」的反向断言 | 同上 | 手工抄的旧列表结构上无法发现漂移 → 推导版本能（见 `A1-01` 对照） |
| `A2-06` | README 端点表 10 → 18 条（补 `session`/`caps`/`mv`/`mvconvert`/`mvlib`/`mvfile`/`system-art`/`system-stream`），并写明 `system-*` 仅旧前缀可达及其代价 | 三方一致门禁已覆盖 manifest 面 | — |
| `A2-02` | README 删掉不实的「真实浏览器量布局（headless Chrome + CDP）」防线主张，改为显式没有布局测量能力的警告；同时清掉该节一个无配对开启的孤立代码围栏 | — | — |
| `A3-01` | `lib/client.js`：加 `disposed` 闸门（`schedulePoll` 三处守卫）+ `halt()` 显式复位 `scanning: false` | 新建 `test-poll-teardown.mjs`：挂载→刷新进入扫描态→轮询在飞→teardown→释放在飞请求，断言此后 fetch 次数不增 | 回退 4 处修复 → FAIL `before=2 after=3`（请求风暴复现） |
| `A3-02` | `lib/index.js`：加 `disposed`；`ensureHost` 的两个 await 之后、赋值之前复查；teardown effect 先置位再 dispose | 新建 `test-teardown-race.mjs`：用顶层延迟 400 ms 的 stub `host.js` 精确制造在飞 import 窗口，在窗口内 teardown，断言 `createHost` 调用数为 0 | 回退 4 处修复 → FAIL `createHost calls=1`（孤儿 host 复现） |
| `A4-03` | `requires.contracts` 两条编造坐标删除 → `[]`；`contributes` 扩展的 `browser.ui.dsh/v1alpha1` 换成基线里真实的 `ui.dsh/v1alpha1` / `UiContribution`；路由登记表移到顶层插件自有键 `x-dsh-music-player.transport` | 三方一致门禁新增：结构位置上的 `apiVersion` 值不得是已知编造坐标；非空 `contracts` 必须至少一条 `required` | 塞回编造坐标 → 2 项 FAIL；只加一条纯 `optional` 契约 → 1 项 FAIL |
| `D-05` | 状态由「待修」改为已修：这次是真的删/换，不是补 `fallback` | 同上 | — |

### 5.12.1 修复过程中新发现的两条事实（必须记录）

1. `system-art`/`system-stream` 不能注册到 `connection.fetch` —— 原计划「7 个端点全部补注册」是错的。实测平台实现：`/api` 路由挂在 `webServer` 上，`admit()` 先判 `isTrustedApiRequest`（Host/Origin）再要求 `browserAuth.isAuthenticated`；而 `createSharedFetchHandler` 自身不含栅栏与鉴权（`packages/client/connection/lib/index.js:608-623` 只做精确查表，栅栏在 `:830-843` 的 `webServer` 路由里）。Chromium 内部取图带 `Origin: dsh-app://app`、不带会话 cookie ⇒ 走 `/api` 必然 403/401。**这两个端点必须留在插件自建的旧前缀上**，这是设计约束不是漏改。代价（无 `webServer` 时不可达）已写入 manifest 与 README。
2. `api()` 的 404 回落探测会污染端到端测试 —— 设计 `A3-01` 门禁时，我先后两版误判：第一版挂错了请求；第二版用 404 释放，结果 `api()` 自带的旧前缀回落探测（`lib/client.js:664-673`）凭空多打一次请求，被误读成「轮询再武装」。**在飞请求必须用非 404 状态码释放**，否则会把 `A1-02` 的行为混进 `A3-01` 的断言。这条已写进该套件的文件头注释。

### 5.12.2 第 8 轮结论

- 8 条台账条目已修（`A2-01`/`A1-01`/`A2-03`/`A2-06`/`A2-02`/`A3-01`/`A3-02`/`A4-03`）+ `D-05` 状态更正。
- 新增 3 套门禁、扩写 1 套，套件总数 18 → 21，全部 PASS。
- 每条门禁都通过负向对照：把修复回退后门禁确实变红，不是恒绿测试。
- 仍未修：`A1-02`（404 当信号 + 静默降级）、`A1-03`（孤儿 ffmpeg + 无界 Map）、`A1-04`、`A1-05`（错误面脱敏）、`A2-04`/`A2-05`（README 另外两处不实）、`A3-03`/`A3-04`（window 复用 + DOM 释放）、`A4-02`（扩展 id 无运行时对应）、`A5-02`/`A5-03`（token 三律）、`A5-04`（副作用前置授权）、`A5-06`/`A5-08`（scope 小于实际）、`A5-09`（失败不得报成功）等。

---

## 5.13 第 9 轮 —— 修复剩余 7 条高危

基线：`node scripts/run-all.mjs` → 23/23 PASS（新增 2 套）。每条都配门禁，每条门禁都做过负向对照。

| 条目 | 修复内容 | 门禁 | 负向对照 |
| --- | --- | --- | --- |
| `A5-03` | ①基址钉回环字面量：新增 `loopbackAuthority(req)` 只从请求 Host 取端口，主机名固定 `127.0.0.1`（不再回显 Host）；②栅栏豁免收窄：`system-*` 仍豁免 Origin/Sec-Fetch（Chromium 内部发起必须豁免），但新增 `isLoopbackHostRequest(req)` 要求 Host 仍是回环 | `test-security.mjs` 新增 8 条断言 | 回显 Host → FAIL「host is the loopback literal」；去掉回环要求 → 2 条 FAIL |
| `A5-02` | token 按用途分签：`systemArtToken` / `systemStreamToken` 两个独立 `randomUUID()`；art 端点只认 art token、stream 端点只认 stream token | 同上（交叉使用必须 403） | 复用同一 token → 3 条 FAIL |
| `A1-03` | ①`mvJobs` 有界：`MV_JOBS_MAX = 32` + `MV_JOB_TTL_MS`，新增 `pruneMvJobs()`（终态条目 TTL 淘汰、**运行中的永不淘汰**）；②终态盖 `finishedAt`；③`dispose()` 调 `killAllMvJobs()`，对每个在飞子进程 `SIGKILL` 并清空容器 | 新建 `test-mv-teardown.mjs`（假 ffmpeg 自报 PID → dispose → 断言 PID 已消失）+ `test-audit.mjs` 4 条结构断言 | dispose 不 kill → FAIL「child alive=true」（孤儿进程复现） |
| `A5-04` | 新增 `authorize(action, targetPath, scopes)`，在7 个副作用位置逐一校验目标路径落在已声明 scope 内（库目录 / 状态目录 / MV 缓存 / 回收站） | `test-audit.mjs`：每个 `fs.<mutator>` 必须包 `authorize(...)` 或引用 `authorize` 赋值出的变量 | 去掉一处 → FAIL `fs.unlink(` |
| `A1-02` | ①判据改为端点语义 + 正向识别：只有「本来不该 404」的端点回 404 才算路由缺失信号（新增 `ROUTE_MISSING_404_ENDPOINTS`）；②旧前缀必须答出宿主数据对象（`looksLikeHostPayload`）才采纳；③`entryResolved` 只在采纳成功时置位（可重入）；④降级写进 `state.hostEntry` 并渲染成可见提示（新增 `.dshm-notice` 类 + 中英文案） | 新建 `test-entry-fallback.mjs`（6 条）+ `test-audit.mjs` 5 条静态断言 | 去掉端点语义判据 → FAIL（静态断言） |
| `A4-02` / `A4-06` | 删除 `contributes["x-dev.dsh-std.extensions"]` 两条无 definition 的条目（pinned 投影只产出 `unknown-extension` warning，`manifest.zh.md:62` 明确不能声称功能已生效）；真实绑定记录到顶层 `x-dsh-music-player.ui`（`package.json` 的 `exports["./client"]` + `dsh.client.platform` + 字符串 slot `conversation.view`） | `test-route-consistency.mjs`：不得声明 `x-*` 扩展行 + 记录的 slot 必须在 `lib/client.js` 里找得到 + `./client` 导出必须一致 | — |

### 5.13.1 本轮推翻了我自己的一个设计（必须记录）

`A1-02` 我第一版修复用了「5 秒探测冷却」来避免「每个 404 都探一次」。这是错的，被既有套件 `test-client-shell.mjs` 抓住：该套件模拟「宿主入口未重启」时，前面的 `/api/dsh-music/cover` 业务 404 已经启动了冷却，150 ms 后真正需要回落的 `/refresh` 被冷却跳过 → UI 出现错误条。

→ 「冷却窗口」与原来的「一次性标志」是同一类错误：都让无关的业务 404 影响真实回落机会。正确判据是端点语义（这个端点的 404 到底意味什么），不是时间窗。改成 `ROUTE_MISSING_404_ENDPOINTS` 后，`cover`/`mv`/`stream` 这类业务 404 完全不参与入口判定。

### 5.13.2 本轮删掉了一条没有判别力的断言

`test-entry-fallback.mjs` 里我曾用「`/cover` 的业务 404 不得触发探测」做断言，但负向对照没有变红 —— 因为 jsdom 不加载 `<img>`，客户端根本不会请求 `/cover`。没有判别力的断言等于没断言，已删除，改由 `test-audit.mjs` 的精确静态断言（grep 条件表达式本身）把守，并验证该静态断言能被回退触发。

### 5.13.3 第 9 轮结论

- 13 条台账条目已修（`D-05` + 12 条），高危从 13 条降到 0 条（`A4-06` 已通过「不声明」解决）。
- 套件 18 → 23，全部 PASS。
- 存量未修项从「7 条高危」变为「若干中/低 + 明确接受项」，逐条见 §5.1 与各轮小节。

---

## 5.14 第 10 轮 —— 线上故障：音乐不能播、MV 能播

报告：桌面客户端里音频全不能播，MV 正常。

实测定位（对运行中的真机实例 `127.0.0.1:19387` + `dsh-desktop-host`）：

| 检查 | 结果 |
| --- | --- |
| `/dsh-music/api/session` | 200，两个 token 不同（第 9 轮的 `A5-02` 已生效） |
| `/dsh-music/api/stream?p=<真实曲目>` | 200 `audio/flac` 37,946,235 B |
| `/dsh-music/api/system-stream?t=<streamToken>&p=…` | 200 `audio/flac` |
| 同上 + `Range: bytes=0-1023` | 206 + `content-range` + `accept-ranges: bytes` |
| 交叉 token（art 用去 stream） | 403 ✅ |
| `/dsh-music/api/mv?id=<真实视频>` | 200，返回 `"url":"/api/dsh-music/mvfile?k=…"`（相对地址） |

⇒ 宿主侧音频通路完全正常。真正的不对称在这里：

- MV：`/api/mv` 返回相对地址，走平台 `/api` + 浏览器会话，不经 token；
- 音频：Desktop 上永远走 `system-stream` token 直连（相对地址经 Desktop 转发会丢 Range）。

所以「token 失效」的症状必然是 音乐死、MV 活。

根因：`systemArtToken` / `systemStreamToken` 原本是 `createHost()` 里的 `randomUUID()` —— 每次宿主热重载都轮换；而客户端把 `/session` 的基址缓存整个页面生命周期（`systemArtBasePromise` 从不重置）。于是任何一次 `lib/host.js` 保存（开发期频繁发生）都会让页面手里的媒体 URL 变成废纸，直到刷新页面。

修复（两条）：

1. 宿主：token 钉到进程级（新增 `processTokens()`，用 `Symbol.for` 挂在 `globalThis` 上）。热重载产生新 module 实例，但符号注册表与 `globalThis` 是同一个 ⇒ 重载不再轮换 token，客户端缓存的 URL 持续有效。
2. 客户端：基址加 TTL + 失败自愈。`loadSystemArtBase(force)` 带 60s TTL；新增 `invalidateSessionBase()`；音频 `error` 事件里若失败源是 `system-stream`（且未自愈过），丢掉缓存放并当场用新基址重放本曲，而不是退化成「跳过一首」。

新增门禁 `scripts/test-token-lifetime.mjs`：两次 `createHost()` 的 token 必须相同；旧 token 在新实例上不得 403。
负向对照：把 token 退回实例级 → 两条断言 FAIL（`…->dec2ffd6…`），exit 1。

运维要求：`lib/index.js` 改过（第 8 轮的 `FETCH_ROUTES` / `disposed`），**必须重启 DSH 应用**；`lib/client.js` 与 `lib/host.js` 改过，**必须刷新页面**（或重启应用）。

---

## 5.15 第 11 轮 —— TypeScript 迁移 + MV 快进修复

### 5.15.1 MV 进度条一拖就从头（线上故障）

定位：`mvCacheUrl()` 在 `systemStreamBase` 为空时退回相对地址 `/api/dsh-music/mvfile?k=…`，而 Desktop 上相对地址经 Electron `forwardWebRequest` 会丢 Range/206 → `<video>` 判定流不可 seek → 一拖就回 0 秒。`prepareVideo()` 的 5 个调用点里有 4 个没有先 await 基址（`restoreLastPlayed`、两处 error→转码升级、手动转换），刷新页面后 cue 上一首正好命中。

修法：把 `await ensureStreamBase()` 放进 `prepareVideo()` 内部（一处覆盖全部调用点），并把 `restoreLastPlayed` 的音频分支同样包起来。

门禁 `scripts/test-mv-seek.mjs`：在 `/session` 故意延迟 1.2 s 的时序下，断言挂上去的媒体源必须是绝对 token 地址。
负向对照：去掉那句 await → 三条断言 FAIL，报出的正是 `/api/dsh-music/mvfile?k=…`，exit 1。

### 5.15.2 TypeScript 迁移

规模实测（先用 scratch 副本量，不动工作树）：`strict: true` → 667 个类型错误（其中 455 是隐式 any，TS 7 默认开启）。`noImplicitAny: false` → 243；再加 `strictNullChecks: true` 零额外代价。

取舍：不追求一次到位的 strict（6133 行历史 JS 的回归风险不可控），改用分层 + 棘轮：
- `strictNullChecks` 开 —— 它正是能防住本轮与第 10 轮两个真实故障的那一项（缓存/基址可能为 null）；
- `noImplicitAny` 暂关，由 `scripts/typecheck-ratchet.mjs` 守住：基线 `scripts/typecheck-baseline.json` = 243，只许变少。

真源与产物：`src/*.ts` 是唯一真源，`lib/*.js` 是 `tsc` 产物。产物也提交（`dsh plugin add` 不跑构建，且本仓库显式无生命周期脚本），由 `scripts/check-build-fresh.mjs` 把关（编译到临时目录逐字节比对）。
- 新增 `tsconfig.json`、`package.json` 的 `build` / `dev`（`tsc --watch`）/ `typecheck` 脚本。
- 依赖从 npm 锁文件切到 pnpm（`pnpm-lock.yaml` + `packageManager: pnpm@11.7.0`）—— 因为 `dsh plugin` 内部本来就用 pnpm，此前的 `package-lock.json` 是残留且与实际依赖不一致。CI 同步改为 `pnpm install --frozen-lockfile`。

本轮自己犯的一个错，已沉淀为规则：`test-audit.mjs` 用 `/^        ([a-zA-Z][\w]*):/gm`（写死 8 空格缩进）找 player API 方法；tsc 重新排版成 16 空格后这条断言静默返回 0 个方法 —— 本该报警的地方反而变绿。改成「取该块里缩进最小的键」后恢复 29 个方法。已写入 AGENTS.md §2.15：静态断言要按结构推导，不要按空白字符写死。

验证：`ALL 25 SUITES PASS` · `typecheck` 未倒退 · `check-build-fresh` 一致 · `check:manifest` PASS · CI 在 GitHub 上 `completed/success`。

---

## 5.16 第 12 轮 —— 类型错误清零（243 → 0）与两个真实缺陷

维度：类型系统有效性（第 11 轮迁移的收尾）。
基线：TS 7.0.2，`strictNullChecks` 开、`noImplicitAny` 关。

### 5.16.1 `A5-12`（新发现，已修）—— MV「重试」按钮是坏的

`MusicView` 的 MV 重试按钮 onClick 引用了 `mvEscalated.delete(...)` 与 `set({mv:…})`，
而这两个名字都声明在 `createPlayer()` 内部（`mvEscalated` 在 client.ts:1419，`set` 在 :1138），
`MusicView` 在 `createPlayer()` 外面。⇒ 运行时抛 `ReferenceError`，**且抛在
`player.retryVideo()` 之前**，所以那个按钮点了完全没反应（只有控制台报错）。

- 迁移前就存在：`git show 032e333:lib/client.js` 的对应位置有同样两行。
- 门禁盲点：既有 25 套没有任何一条覆盖「转码失败 → 点重试」。jsdom 套件渲染了视图，
  但没人点那个按钮（`test-client-shell.mjs` 只断言每个 `<button>` 挂了处理函数，
  不断言处理函数能跑通 —— 这是结构断言，抓不到引用错误）。
- 修法：把「重置 `mvEscalated` + 置 `preparing`」移进 `createPlayer` 的 `retryVideo` 内部。
  放在那里而不是视图里，理由与 `prepareVideo` 那处相同：调用者会忘。
- 门禁：`test-audit.mjs` 新增「`MusicView` 不得引用 `createPlayer` 局部量」。
  负向对照：把代码引用挪回 MusicView → 变红并报出源文件行号 3160。

### 5.16.2 `A5-13`（新发现，已修）—— `setDirectory` 未等 `ready`，目录会被 `loadState()` 清掉

`ready` 是个 async IIFE（host.ts:1845），里面 `currentDir = await loadState()`。
它在 `await` 恢复时会覆盖期间被设好的 `currentDir`。

- 只有部分路由 `await ready`：`/library`(:2027)、`/refresh`(:2034)、`/delete`(:2393)、`ensureLibrary`(:1876)。
  `/api/dsh-music/dir`(:2046) 与 `/pick`(:2166) 的成功分支都没有。
- 后果：激活后第一个请求若是 `POST /dir`，`loadState()` 落地时把目录清回 `null` →
  「选了目录，列表一直是空的」。真实客户端先 `GET /library`（有 await）所以碰不到，
  但那是运气，不是设计。由类型修复 agent 的隔离冒烟测试（`/tmp/smoke`）撞出。
- 修法：把 `await ready` 放进 `setDirectory` 自己，一次覆盖全部调用者（现在与将来）。
- 门禁：`test-audit.mjs` 新增「`setDirectory` 必须在任何 `currentDir` 赋值前 `await ready`」。
  负向对照：去掉那句 await → 变红。

### 5.16.3 类型错误 243 → 0

四个并行 agent 分工（文件互不相交）：`client.ts` 127→0、`host.ts` 73→0、
`http-bridge.ts` 33→0、`index.ts` 7→0、`tagwriter.ts` 3→0。

根因高度集中：最大的两簇是
①`let x = null` 没标注 → 下游全成 `never`（`Property 'x' does not exist on type 'never'`，约 90 处）；
②`const arr = []` → `never[]`。
补上真实类型（`PlayerState`、`LibraryResult`、`Track`、`MvJob`、`MusicPlayerApi` 等 26 个就地 interface）后一次性消掉大半。

约束执行情况（这是本轮最该被复核的部分）：
- 全仓 `as any` / `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`：0
- 全仓 `!` 非空断言：2，均在 `client.ts` 并带可证性注释
  （`:1495` `canvas.getContext("2d")!` —— 加判空会把「drawImage 抛错被 catch 吞掉」
  改成「startWasmVideo 返回 false 从而改走转码」，那是行为变更；
  `:2765` `player.t!` —— `apply()` 在 `ctx.slots.register` 之前赋值）
- 每份交付都要求 agent 做行为等价证明（node 类型剥离后与旧产物 diff / 等价性实测），
  而不是只报「0 错误」。`http-bridge.ts` 那份把「改前 vs 改后」的运行期 JS 逐字 diff 到 `IDENTICAL`。

棘轮收紧到 0：`scripts/typecheck-baseline.json` 由 243 下调为 0，此后任何新增类型错误直接变红。

### 5.16.4 逐文件收严允许清单（新增门禁）

全量开 `noImplicitAny` 仍会多出 343 处（305 处是未标注的函数参数），不能一次开。
但实测 `http-bridge.ts` 与 `tagwriter.ts` 在该档位下已经是 0，于是新增：

- `tsconfig.strict.json`：`extends` 主配置 + `noImplicitAny: true` + `include` 允许清单；
- `scripts/check-strict.mjs`：名单里的文件必须零错误，且名单为空要拒绝
  （空名单 = 恒绿门禁，比没有更坏 —— 这条自身也做了负向对照）。
- 已接进 `npm test` 与 CI。严格度单向增长：清干净一个文件就加一个。

### 5.16.5 本轮我自己犯的三个错（同一族：静态断言被文本骗到）

1. `test-audit.mjs` 的 `setDirectory` 断言：`indexOf('currentDir =')` 命中的是我自己注释里的
   `currentDir = await loadState()` → 恒红。
2. 同一条的 `MusicView` 断言：被 `MusicView` 内部注释里的 `mvEscalated` 命中 → 恒红。
3. 改用字符偏移比较先后：`clientPortion` 是剥掉 CSS 块后的文本，偏移与源文件行号不一致 → 错位。

沉淀为规则（AGENTS.md §2.15）：静态断言①先剥注释；②按行号判断、不要按字符偏移。
这与 §6.1 第 3 条、以及第 11 轮「缩进不可写死」是同一族：检验方法本身也需要被检验。
三条断言最终都做了负向对照并确认会变红。

### 5.16.6 验证

- `node scripts/run-all.mjs` → ALL 25 SUITES PASS
- `node scripts/typecheck-ratchet.mjs` → 0 错误（基线 0）
- `node scripts/check-build-fresh.mjs` → lib/ 与 src/ 一致
- `node scripts/check-strict.mjs` → 2 个文件在全严格下零错误
- `node scripts/check-manifest.mjs` → PASS；`git diff --check` → clean
- CI（GitHub Actions，pnpm）：见本次 push 的 run

### 5.16.7 符合项（本轮确认落地）

- `permission.zh.md:86`「在产生副作用的位置检查授权」：类型修复期间 **6 个 `authorize()` 副作用点
  一行未改**（agent 用 `git diff -U0 | grep` 逐符号核对，并跑冒烟测试确认 saveState / delete / apply 三条路径的授权仍放行）。
- `lifecycle.zh.md:29/:107`：`dispose` 的 kill 路径、`disposed` 状态位、两个 post-await 复查
  在类型修复中全部保持（`src/index.ts` 的 diff 只含 5 个 hunk，且 `FETCH_ROUTES` /
  `LEGACY_ONLY_ROUTES` / `disposed` / `RELOAD_MIN_INTERVAL_MS` 均 0 命中）。
- `permission.zh.md:111` / `storage.zh.md:101`：`mvEscalated` 的 reset 迁移没有引入任何新的
  日志/落盘点（`test-audit.mjs` 的写盘白名单与凭据扫描仍全绿）。

---

## 5.17 第 13 轮 —— Desktop MV 仍不能快进（A1-02 回落判据过窄）

真机证据（用户提供）：
```
[dsh-music] seek asked=108.4 now=0.3 dur=260.4 seekable=1(0.0..0.0) src=rel err=0
```
`seekable=[0,0]` ⇒ 媒体元素完全不能 seek，所以 `currentTime = 108.4` 只会从 0 重来。
`src=rel` ⇒ 挂的是相对地址。

### 5.17.1 根因：A1-02 的回落只在 404 触发，而 Desktop 上答的是 401/403

真机实测（Electron 宿主 :19387）：

| 请求 | 结果 |
| --- | --- |
| `/dsh-music/api/session`（插件自建回环前缀） | 200 |
| `/api/dsh-music/session`（平台 `/api`） | 401 `unauthorized` |
| `/api/dsh-music/session` + `Origin: dsh-app://app` | 403 `forbidden` |

平台 `/api` 的 `admit()` 在路由之前判 Host/Origin 栅栏与浏览器会话，所以 Desktop 渲染进程
拿到的是 401/403，不是 404。而 A1-02 的通用降级条件是
`response.status === 404 && ROUTE_MISSING_404_ENDPOINTS.has(endpoint)` —— 永远不成立
（`session` 虽然在那个集合里，但状态码是 401）。于是 `/session` 永远失败 ⇒ 基址恒为空
⇒ `mvCacheUrl()` / `streamUrl()` 退回相对地址 ⇒ Desktop 转发丢 Range ⇒ `seekable=[0,0]`
⇒ 一拖就回 0 秒。

这是设计缺陷，不是编码疏漏：A1-02 把「宿主没有这个端点」与「这道栅栏不让这个请求过」
当成了同一件事，而它们的可观测状态码不同。

### 5.17.2 修法（三层）

1. `/session` 自己的回环回落（`loadSystemArtBase`）。理由是它**唯一**以下发回环 token 基址
   为目的 —— 那个基址存在的意义就是绕开平台栅栏，所以它有资格走插件自建的回环路由。
   只给 `/session`：其余端点不享受（避免把一次普通的 403 洗成信任边界降级，§2.8）。
   仍是正向识别（必须真的解析出 `systemStreamBase` 才算采纳）+ 通过 `onDowngrade()` 报告。
2. `ensureStreamBase()` 拿不到就强制重取一次（不再「2 秒超时就按相对地址播」）。
   相对地址在 Desktop 上等于不可 seek，那个降级比等待更糟。
3. 按可观测症状自愈（`healUnseekableSource`）：源不是 token 直连 + 时长已知 +
   `seekable=[0,0]` ⇒ 作废基址、重取、用 token 地址重挂同一媒体并回到原位。
   窗口 20 秒、成功即停、换源重开窗口 —— 有界，不是无限重试。

诊断也一并修了：原来的分类
`includes("system-stream") ? token : includes("mvfile") ? mvfile : startsWith("http") ? abs : rel`
把空串 / `blob:` / `dsh-app://` 全归成 `rel`，且 `mvfile` 的判定在 `http` 之前（相对 mvfile 会记成
`mvfile` 而非 `rel`）—— 看不出到底哪一路。现在输出 `src=`（无歧义分类）+ `base=`（是否有 token 基址）
+ `ep=`（当前端点前缀）+ `url=`（剥掉 token，§2.9）。

### 5.17.3 门禁 `scripts/test-mv-seek.mjs` 扩到 15 条

| 场景 | 断言 |
| --- | --- |
| A 视频轨（正常） | 绝对 token 地址 + `&k=<cacheKey>` |
| B 音频轨（正常） | 绝对 token 地址 + `&p=<trackId>` |
| C 平台 `/session` 答 401 | 必须靠回环前缀拿到基址，仍是绝对 token 地址，且从未挂过相对地址 |
| D 基址在重试预算内一直拿不到 | 先真的挂上相对地址（D1 主动断言这一点），再自愈成 token 地址；重挂次数有界 |

负向对照（都确认会变红）：
- 关掉 `/session` 回环回落 → C2/C3/C4 红，报出的正是 `/api/dsh-music/mvfile?k=…`（= 用户机器上的 URL）；
- 关掉不可 seek 自愈 → D2 红，报出 `/api/dsh-music/stream?p=…`。

场景 D 两次被我自己做废，都记在这里：
- 第一版让 `/session` 正常成功 ⇒ 源本来就是 token 地址，自愈不触发，恒绿；
- 第二版按「前 N 次失败」写 ⇒ 与 `ensureStreamBase` 的 2s+4s 重试预算耦合，重试就已成功，
  仍走不到相对地址。最终改用时间窗（7.5s，长于那个预算），并把 D1 写成主动断言
  「fixture 真的产生了相对地址」——没有这一条，D 会再次静默失去判别力。

### 5.17.4 本轮我自己的三个错，都被门禁抓住了

1. 替换时删掉了 `let unseekableTimer` 的声明行 → 7 个 TS2552。**由第 12 轮刚收紧到 0 的
   类型棘轮当场抓住**（基线 0 的价值就在这里）。
2. 自愈第一版是「一次就放弃」：`unseekableHealed = true` 在第一次尝试前就置位，而第一次尝试
   恰好压在宿主还没准备好的时刻上 ⇒ 真机上等于自愈从未生效。改成窗口内退避重试。
   → 这个形态与第 9 轮被推翻的「一次性标志」、以及 §2.10 的「清 timer ≠ 阻止再武装」是同一族。
3. deadline 初始化漏了首次：`if (src !== unseekableSrc)` 在 `src` 与初值同为 `""` 时不成立，
   deadline 停在 0 → 首行 `Date.now() > 0` 直接 return。同时夹具也不真实
   （假媒体元素没有 `currentSrc`，真实元素一定有）。代码与夹具都修了。
   → 教训：夹具的保真度也是断言判别力的一部分（同 §6.1 第 3 条「检验方法本身也要被检验」）。

### 5.17.5 验证

- `scripts/test-mv-seek.mjs` → 15 条全过；两条负向对照确认变红
- `node scripts/run-all.mjs` → ALL 25 SUITES PASS
- `typecheck` 0（基线 0）· `check-build-fresh` 一致 · `check-strict` 通过 · manifest PASS

### 5.17.6 符合项

- `composition.zh.md:143`（偏离 plan 必须报告）：`/session` 走回环前缀时仍调用 `onDowngrade()`，
  降级在 UI 上可见（沿用第 8 轮的 `.dshm-notice`），不是静默发生。
- `permission.zh.md:111` / `storage.zh.md:101`（凭据不得进日志）：新的 `url=` 字段经
  `redactSrc()` 把 `t=<token>` 替换为 `t=***`；`test-audit.mjs` 的凭据扫描仍全绿。
- `lifecycle.zh.md:29/:107`：新定时器 `unseekableTimer` 在 `halt()` 里先 `clearTimeout`
  再置 null，且 `scheduleUnseekableHeal` 在 `disposed` 后直接返回 —— 清句柄与阻止再武装分开做（§2.10）。

---

## 5.18 第 14 轮 —— Desktop MV 仍拖不动：自愈修错了对象

用户第二份真机日志（比第一份更有信息量）：
```
seekable=1(0.0..0.0) src=rel err=0 base=token ep=/api/dsh-music
url=dsh-app://app/api/dsh-music/stream?p=ONE%20OK%20ROCK%20-%20We%20Are.mov&v=1790345439794
```
四次 seek，`url` 一次都没变。

### 5.18.1 第 13 轮的修复是有效的，故障点已经移了

`base=token` —— `/session` 的回环回落确实生效，token 基址已经拿到（第 13 轮 §5.17 的目标达成）。
但 `url` 是 `dsh-app://app/api/dsh-music/stream?p=…`：相对路径被页面解析后的结果。
⇒ 挂源发生在基址到达之前，之后基址到了、源却没被换掉。

三个未等基址的挂源点（第 12/13 轮只修了其中一部分）：
`recoverAt()`（播放中断后的恢复）、改名重映射、以及自愈本身。

### 5.18.2 根因：自愈按 `track.kind` 猜修法，而该模式是 WASM 旁路

`ONE OK ROCK - We Are.mov` 走的是 WASM 旁路：画面由 WASM 解码，**媒体元素播的是
`/stream?p=<视频文件>`（音轨）**，而 `track.kind` 仍是 `"video"`。

第 13 轮的自愈写的是：
```js
const next = track.kind === "video" ? await prepareVideo(track) : streamUrl(track);
```
对这条路径它会去 `prepareVideo()` —— 问 `/api/mv` 拿转码缓存键，可能等几分钟。
于是自愈永远卡在等待里，源从未被换掉 —— 与「四次 seek，`url` 完全没变」精确吻合。

修法：按「当前这条源是什么类型」重建，而不是按 `track.kind` 猜。
```js
const wasMvCache = src.includes("/mvfile") || src.includes("&k=");
const next = wasMvCache ? await prepareVideo(track) : streamUrl(track);
if (next === null) { scheduleUnseekableHeal(1200); return; }   // 还没就绪：窗口内再试
```

### 5.18.3 一并修的

- `recoverAt()` 与改名重映射：两处 `audio.src = streamUrl(...)` 原来没有 `await ensureStreamBase()`
  （§2.16「降级成不可 seek 的源比等待更糟」）。
- 挂源时的诊断：新增 `logAttach()` —— 挂非 token 源时记一行
  （`attach kind=… base=… ep=… url=…`），正常路径不刷屏。第 13 轮只在 seek 时记录，
  所以「挂源那一刻基址是什么状态」看不到；这条日志下一次能直接把问题钉死。

### 5.18.4 门禁扩到 18 条

- 场景 E（真机形态）：视频轨 + 基址迟到 → 必须先真的挂上相对源，再自愈成 token 地址。
  E1 报出的正是 `/api/dsh-music/mvfile?k=…`。
- 结构断言 F1：自愈必须按源的类型决定修法，**不得**出现
  `track.kind === "video" ? await prepareVideo`。负向对照：把代码退回那个写法 → F1 红。
- 对照②（关掉自愈）→ D2 + E2 红。

### 5.18.5 我自己在本轮的错

- 改 `recoverAt`/改名重映射时漏了 async IIFE 的闭合括号 → 13 个语法/类型错误。
  又一次被基线 0 的棘轮当场抓住。
- 场景 E 的等待时长第一次给少了（16s 才够），说明时间窗类夹具必须比被测窗口留足余量。

### 5.18.6 验证

- `test-mv-seek.mjs` → 18 条全过；两组负向对照确认变红
- `ALL 25 SUITES PASS` · typecheck 0（基线 0）· build-fresh 一致 · check-strict 通过 · manifest PASS

---

## 5.19 第 15 轮 —— 刷新后误报「无法播放该文件」+ 死代码/泄漏/进程审计

### 5.19.1 `A5-14`（已修）—— 每次打开音乐页面都弹红字

用户报告：MV 快进修好了 ✅，但每次打开音乐页面，上方弹红字
「出错了：无法播放该文件（格式不受支持或文件已移动）」。

根因（`restoreLastPlayed` 的视频分支）：
```js
attachSource(url);   // 内部调 audio.play() 并挂 .catch
audio.pause();       // 紧接着同步 pause
```
`play()` 被紧随的 `pause()` 打断 ⇒ 那个 promise 以 `AbortError` 拒绝，而 `.catch` 里只放行
`NotAllowedError` ⇒ 落到最后一行 `set({ error: translate("error.unsupported") })` ⇒ 弹红字。

这是第 13/14 轮修复暴露出来的潜伏 bug：在此之前这条路根本走不到（基址拿不到 / MV 准备失败），
基址与自愈修好之后它才真正执行。修 bug 会把下游从未执行过的代码路径首次点亮 —— 审计时要预期这一点。

修法（两层独立防线，各自充分）：
1. `restoreLastPlayed` 的视频分支改用新增的 `cueSource()` —— 只挂源、不调 `play()`。
   该分支的意图本来就是「cue 成暂停态」，不是「播了再赶紧停」。
2. `attachSource` 与 `toggle` 的 `.catch` 放行 `AbortError`（快速切歌 / 立刻暂停都会触发它，
   它不是「格式不支持」）。

门禁：`test-mv-seek.mjs` 新增场景 G（刷新后 cue 上一首不得弹红字），断言口径是
DOM 里没有 `.dshm-error` 节点（可观测面，不是读内部状态）。
**夹具必须同步变真实**：假媒体元素的 `play()` 原来直接 `return Promise.resolve()`，
于是「play 后被 pause 打断」这条路径永远不会产生 AbortError。改成真实语义
（`pause()` 会让在飞的 `play()` promise 以 AbortError 拒绝）后，这条才可能变红
（§2.16「夹具的保真度也是判别力的一部分」）。

对照：两层都退回 → G2 红，报出的正是 `error.prefixerror.unsupported`（= 用户看到的红字）；
只退回任一层 → 仍绿（证明两层各自充分）。

### 5.19.2 死代码：5 处清理 + 永久开启死代码门禁

类型清零后实测 `noUnusedLocals` / `noUnusedParameters` 全仓只有 5 处，于是全部清掉并永久开启：

| 位置 | 死因 |
| --- | --- |
| `client.ts` `downgradedToLegacy` | 只写不读（降级状态由 `hostEntry` 表达、由 `onDowngrade()` 上报） |
| `client.ts` `wasmCanvas` | 只赋值不读 |
| `host.ts` `name` / `inject` | 未导出且无人 import（入口只调 `createHost()`；Cordis 模块约定残留） |
| `host.ts` `scoreCandidate(…, pool)` | 形参无人使用（调用点只传 2 个实参） |

代价：一条测试断言引用了被删的 `downgradedToLegacy`，门禁当场报红 —— 这是门禁在做它该做的事。
把它改写成更强的形状：剥注释后逐条降级路径断言（`/session` 回落路径 + 通用 A1-02 路径各需一次
`onDowngrade()`）。两条对照各自精确变红。

### 5.19.3 泄漏 / 进程 / CPU 门禁（补上 §6.3 一直空着的那条）

新增 `scripts/test-leak.mjs`（注册进 run-all，带 `--expose-gc`）：8 次热重载后

| 信号 | 类型 | 实测 |
| --- | --- | --- |
| fd 数不增长 | 脆 | 16 → 16 |
| 无孤儿子进程 | 脆 | 0 → 0 |
| `dispose()` 后 1.5s 内 CPU ≈ 0 | 脆 | 6 ms |
| heap 增长有界 | 噪（辅助） | +3.01 MB / 8 次（0.38 MB 每次） |

heap 阈值是用正对照标定的，不是拍的：注入「每次 `createHost` 往 module 级数组塞 1MB」
的泄漏 → +11.00 MB（1.38 MB 每次）。阈值第一版写了 12MB，正对照暴露了它放过了那个泄漏；
收紧到 6MB / 0.8MB-per-reload 后，基线有 2x 余量、真实泄漏有 1.8x 余量。
**改这个阈值前必须重跑正对照**，否则会把它放宽成恒绿。

### 5.19.4 本轮我自己的两个方法错误

1. 负向对照改了 `src/` 却没 build —— 门禁读的是 `lib/`（产物），控制组因此是空的，
   差点让我误判「断言没有判别力」。**凡门禁读产物，控制组必须重建**。
2. 重复犯了 §2.15 明明写着的坑：新断言用 `/onDowngrade\(\)/g` 计数，被我自己写的注释
   （`由 onDowngrade() 上报`）算进去一次 ⇒ 阈值 `>=2` 恒真。改成剥注释 + 逐路径断言。
   规则写在文件里不等于会遵守，所以这类断言要一次写成结构化的形状。

### 5.19.5 验证

- `ALL 26 SUITES PASS`（新增 `test-leak.mjs`）
- `typecheck` 0（基线 0，且现在含 `noUnusedLocals`/`noUnusedParameters`）
- `check-build-fresh` 一致 · `check-strict` 通过 · manifest PASS · `git diff --check` clean
- 正/负对照：泄漏注入 → `test-leak` 红；红字两层退回 → 场景 G 红；降级上报逐条退回 → 断言红

---

## 5.20 第 16 轮 —— README 精炼 + 真机截图 + AGENTS 结构升级

性质：文档工程轮（无代码改动）。

### 5.20.1 README 精炼：218 → 182 行

- 17,160 B → 13,459 B；功能节从 40 行长 bullet 压成 12 条分组条目
- 删掉「测试门禁」的长表格，改成「专门防『写了但不生效』的那几条」精选表（细节本就在
  AGENTS.md §6.3 与 `docs/`）
- HTTP API 的两段长 blockquote 合并为一段
- 事实零丢失：搬家后逐条 grep 复查 12 个关键事实（`movpkg`/FairPlay/5000/MusicBrainz/
  `node-taglib-sharp`/90ms/白名单/`system-stream`/26 套/18 个端点/`authorize`…）全部仍在
- 无未验证数字与不实主张（`grep -n "Chromium.*CDP\|headless"` → 0 命中）

### 5.20.2 真机截图入库

用户提供了两张实际运行截图（音乐标签页 + 全屏 MV 播放），放入
`docs/images/music-tab.jpg`、`docs/images/mv-fullscreen.jpg`（2558×1639 → 降到 1600×1025，
140 KB / 122 KB），并在 README 顶部引用。

### 5.20.3 AGENTS.md 结构升级：为更强的模型准备自检入口

`AGENTS.md` 原为 50,606 B，无「先读什么」的入口 —— 新模型必须通读 §2 的 16 条规则
才能知道该做什么。本轮做了三件事：

1. 新增 §0「给 agent 的快速上手」（前置）：这是什么 / 三条命令 / 五个文件各管什么 /
   DoD 六条 / 最该知道的 6 条不变量 / 新功能的操作顺序。读完 §0 就能安全改代码。
2. 新增 §8「不变量索引」：13 条不变量 × 「违反症状」× 「抓住它的门禁名」。
   某条若没有门禁，索引里直接标 待建（`I-09` 就是）—— 缺口暴露在明面上。
3. 新增 §9 陷阱速查 / §10 明确接受的设计取舍 / §11 扩展本文件的三条硬约束。
   其中 §10 的用途是防止未来的模型「顺手修好」本来故意的设计
   （`system-*` 不在 `connection.fetch`、保留旧前缀、提交产物、`mime` 为 null、
   不做随机播放、封面不覆盖…）。

同时按 §11 自己的规则做了体积治理：新增 §0/§8–§11 后一度到 **59,233 B = 64 KiB 预算的
90.4%（危险 —— 这个文件曾被静默截断过）。于是把 §5 台账从 4,569 B 压成 2,175 B 的索引**
（详细表本就在 `docs/audit-ledger.md`），最终 53,978 B = 82.1%，留出余量。

压缩后自检发现并修掉 3 处悬空交叉引用（`§5.6.3`、`§5.1` 已随压缩消失）——
把 `grep -n "§5\.[0-9]"` 当作压缩后的必跑检查。另逐条验证 §8/§0 里点名的 **13 个门禁脚本
全部真实存在**（纸面引用不算数，§6.1 第 2 条）。

### 5.20.4 验证

`typecheck` 0（基线 0）· `ALL 26 SUITES PASS` · `check-build-fresh` 一致 · `check-strict` 通过 ·
manifest PASS · `git diff --check` clean · AGENTS.md 53,978 B（82.1%）· README 182 行

---

## 5.21 第 17 轮 —— README 改写为 DSH 官方体例

性质：文档工程轮（无代码改动）。要求：参考 DSH 官方
[`README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md) 的写法。

### 5.21.1 官方体例的五个特征（逐条对齐）

逐字读了官方 `README.zh.md`（98 行）后提取出的形态，我们逐条照做：

| 特征 | 官方做法 | 我们的做法 |
| --- | --- | --- |
| 标题 | 只有项目名 | `# dsh-music-player` |
| 首段 | 2 段：是什么 + 怎么嵌进宿主 | 同样 2 段（`facets.host.entry` 激活 + `ctx.connection.fetch` / `ctx.slots.register` 注册面） |
| 状态节 | `## 开发者预览`，明说「未来将出现破坏兼容性的变更」 | `## 兼容性状态` + 同口径的警告 + `范围不等于证据` |
| 命令 | ```sh 围栏、最小步骤、`<a id="...">` 锚点 | 同 |
| 无 emoji | 全篇 0 个 | 从旧 README 去掉了 `⚠️` 与 `↔`，现在 0 个 |
| 链接出去 | 每节 2–4 句就把细节交给 `docs/` | 端点表、结构树、门禁表全部移出 README |
| agent 指针 | 「面向 agent：请遵循 [AGENTS.md](AGENTS.md)。」 | 保留同句，并指向 §0 |

### 5.21.2 移出 README 的内容（不删除，只换位置）

- 完整的 18 条端点表 → [`docs/compatibility.md`](docs/compatibility.md) 新增 §9「端点面」
  （含 §9.1「为什么 system-* 不在 connection.fetch 上」与 §9.2「三种通道的信任边界」）
- 结构树 → 删除（`docs/desktop.md` 与 §0.3 的「五个文件各管什么」已覆盖同样信息）
- 门禁台账表 → 只留一句 + 指向 §6.3

结果：137 行 / 8,563 B（旧版 182 行 / 13,459 B），且事实零丢失 ——
用脚本复查 12 个关键事实（Node 范围 / `0.1.7-rc.2` / 安装命令 / `pnpm run dev` / 26 套 /
18 个端点 / `fs.delete` / `.movpkg` / transcode / MusicBrainz / AGENTS.md / MIT）全部仍在，
9 个相对链接全部可解析，2 张截图全部存在。

### 5.21.3 未做的一件事（如实说明）

官方 README.zh.md 首行是 `[English](README.md) | 中文` 语言切换器 —— 那是因为它有
`README.md`（英文）与 `README.zh.md`（中文）两份。本仓库只有一份 `README.md`，
没有伪造这个切换器（指向不存在的文件比没有更坏）。若将来需要英文版，再补
`README.en.md` 并加上切换器。

### 5.21.4 把体例沉淀成规则

`AGENTS.md §7.2` 新增一条，避免下一轮又被写回散乱形态：

> README 的写法对齐 DSH 官方 `README.zh.md`：纯中文标题、无 emoji、每节 2–4 句 +
> 链接到 `docs/`、装/跑命令用 ```sh 围栏、需要被外部引用的节加 `<a id="..."></a>` 锚点。
> 不要在 README 里做功能堆砌。

同时按「文档与代码一致」的要求同步了 §7.1 分层地图里 `README.md` 与 `docs/compatibility.md`
两行的「放什么 / 不放什么」——它们描述的是版面事实，README 变了就必须跟着变。

### 5.21.5 验证

`typecheck` 0（基线 0）· `ALL 26 SUITES PASS` · `check-build-fresh` 一致 · `check-strict` 通过 ·
manifest PASS · `git diff --check` clean · README 137 行 / 8,563 B / 0 emoji ·
AGENTS.md 54,719 B（83.5% of 64 KiB）

---

## 5.22 第 16 轮：切到对话再切回音乐，全屏播放器不留存

### 5.22.1 用户报的症状（线上体验问题）

全屏播放器开着时切到「对话」（或切走再切回音乐标签），回来看到的是音乐列表页，
全屏播放器没了；MV 的画面也不在舞台上。

### 5.22.2 成因（这次不是猜的）

DSH 的 `conversation.view` 只在被选中时挂载（`cordis-client-runner` 的 slot 目录注释：
"it exists while that entry is mounted"；`apps/web/tests/built-boot.expected.e2e.ts:184` 也断言
未选中时 `[data-slot="conversation.view"]` 为 null）。插件的视图因此在切换时整体卸载，
局部 `useState` 随之丢失：

- `playerPhase`（全屏播放器三态）→ 回来是 `closed`，渲染成列表页
- `mvBig` / `zoomOpen` → 一起丢
- 退出动画的 200ms 定时器挂在视图 `useEffect` 里 → 若在 closing 期间卸载，
  cleanup 会清掉它，回来卡在 closing（既收不拢也打不开）

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
3. 重新挂载 → 全屏播放器 / `--mvbig` 布局 / 同一个 `<video>` 回到新舞台（且全页只有 1 个 video）
4. 收起动画跨卸载仍走完（`closing` → 卸载 → 260ms 后 `closed`）
5. `halt()` 把三态复位

夹具保真度：媒体元素用真实 `<video>` DOM 节点（只补 jsdom 未实现的 `play/pause/load`）。
用 `FakeAudio`（没有 `nodeType`）会让搬运路径整体跳过 —— 那种夹具下第 3 条断言恒绿。

负向对照：`git stash push -- src/client.ts`（回到第 15 轮的视图局部 `useState` 版本）→
`pnpm run build` → 该套件 5 条 FAIL 后在第 151 行抛未捕获 TypeError 中断（当时套件没有
空值保护，`.dshm-playerTop ...` 取到 null 就断，故没打印总账）。这 5 条含三条用户症状：
`coming back restores the full player instead of the list page`、
`the restored player still shows the track that was playing`、
`the same media element is moved back into the new stage`。
§5.22.6 已更正此处的「6 条」并给套件补了空值保护，现在对照能跑完并打印总账。
`git stash pop` + 重建产物后全绿。对照必须重建产物（§9 第 5 条）。

### 5.22.5 验证

静态与套件（本机 Node v24，仓库根）：`pnpm run build` + `typecheck` 0（基线 0）·
`npm test` = `check-build-fresh` 一致 + `check-strict` 通过 + `ALL 27 SUITES PASS` ·
`check:manifest` PASS（未动 manifest，仍跑）· `git diff --check` clean。

真机 GUI 复核（ego-browser 打开 `http://127.0.0.1:3080`，即用户正在用的 DSH Web GUI，
152 首曲库；先 `setVolume(0)` 静音再操作，结束时已暂停）：

| 操作 | 读数 |
| --- | --- |
| 播「11」→ 点底部封面 | `phase=open`，`.dshm-player` 在，标题「11」 |
| 切「对话」（视图卸载） | `.dshm-root=false`、`.dshm-player=false`，但 `phase=open`、`playing=true`（声音没断） |
| 切回「音乐」 | `.dshm-player` 回来，标题仍是「11」，进度从 0:02 走到 0:04（截图可证） |
| 收起 | `phase=closing` + `.dshm-player--closing` → 400ms 后 `closed` 且卸载 |
| 收起动画期间切走再回来 | `phase=closed`、无残留 `--closing` 覆盖层（定时器归 player 生效） |
| 播 MV「东风破」→ 点画面放大 → 切走再回来 | `mvBig=true`、`.dshm-player--mvbig` 在、`mediaInStage=true`（同一个 `<video>` 回到新舞台） |

未验证的部分（如实说明）：没有做页面刷新后的持久化 —— 刷新会重开 player 单例，
全屏态按设计复位为 `closed`（本轮只解决「视图卸载/重挂载」，不解决「整页重载」）；
Desktop（Electron）宿主形态未实测，只在 Web GUI 上跑过。

### 5.22.6 第 16 轮的对抗复核与自纠（先修 #1 再交付）

第 16 轮改完后做了一次独立对抗复核（另一个 agent，只读；探针在 `/tmp/negcheck/`）。
它证伪了「可以直接交付」：同一改动引入了一个新的高severity 回归，已修复并补门禁。

#### #1【高｜本改动新增】`disposed` 守卫把 `phase` 永久钉在 `closing`

- 机理：退出动画定时器回调原来写成 `if (disposed) return;` —— 而 `halt()` 已经把句柄
  清掉，回调能跑到只可能是「teardown 之后又被显式打开过」；`disposed` 一旦置位**永不复位**，
  而 player 是 window 级单例、下一代 activation 继续复用它（A3-03）。于是
  `openPlayer → closePlayer` 之后 `closing` 再也出不去（`closePlayer` 又只在 `phase === "open"`
  时才动手）⇒ 覆盖层 `dshm-player dshm-player--closing` 常驻、Esc 也救不回来。
- 复现：复核者的 `probe3.mjs`（真实第二次 `plugin.apply()`）与 `probe-old.mjs`
  （同 activation 先 `halt()` 再 open→close）都复现；HEAD 版本全 PASS ⇒ 是本轮新增。
  现有套件当时是绿的，因为它在 `halt()` 之后只断言 `phase === 'closed'`，从未再走一次 open→close。
- 修法：回调判据从 `disposed` 改成「还在 closing 才收口」
  （`if (state.playerPhase !== "closing") return;`；`openPlayer` 撤销定时器的路径自然不触发）。
  明确不采纳「给 `openPlayer` 补 `disposed` 守卫」的建议 —— 那会让插件热重载后
  全屏播放器再也打不开（`disposed` 永不复位），比死锁更坏；teardown 语义由 `halt()`
  自己完成（停播 / 清句柄 / 复位三态），不靠拦 UI 操作。两处都写了代码注释防复发。
- 门禁：套件补两条 —— ① `teardown.dispose()` → `openPlayer()` → `closePlayer()` →
  300ms 后必须 `closed`；② 真实第二次 activation（第二次 `plugin.apply()` + 重挂载）
  开全屏后必须能收口（`overlay=false && phase==='closed'`）。
  负向对照：把 `if (disposed) return;` 写回去 → `pnpm run build` →
  这两条恰好变红（`phase=closing`、`overlay=true`，`2 CHECK(S) FAILED`），其余全绿；
  恢复后 `ALL PASS`（23 项）。顺带给套件加了点击前判空，负向对照不再抛未捕获异常、
  能打印总账（§5.22.4 的「6 条」更正为「5 条 + 中断」即由此而来）。

#### #2【中｜推断，非本轮引入】媒体「离开文档即暂停」的窗口 —— 真机实测未能复现

复核者指出：视图挂载期间媒体停在 React 树内的 park，卸载时先随子树离开文档、passive cleanup
才搬到 body park，理论上存在暂停窗口（jsdom 观察不到）。本仓库没有布局测量能力，但有真实浏览器：
ego-browser 播 MV「东风破」→ 开全屏 → 放大 → 切「对话」→ 1.8s / 3.3s 两次采样 →
切回来采样，结果 `playing=true`、`paused=false` 全程成立，`currentTime` 4.7 → 6.6 → 8.1 → 9.7
（未归零、未中断），且同一个 `<video>` 回到新舞台。⇒ 在 Web GUI 上该窗口不产生暂停
（cleanup 与删除在同一任务内完成，规范要求「稳定状态」才判离文档）。
Desktop（Electron）未实测，仍标注未验证。

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

用户报告：戴入耳式耳机听本插件的音乐，每次切歌或起播都有一声电流声 / 爆音；
系统 Apple Music 怎么切都不会有。

### 5.23.1 根因：音频通路全是硬切换，没有任何淡入淡出

`grep -n "fade\|ramp\|gain" src/client.ts` ⇒ 0 命中（只命中无关英文文本）。逐个看音频状态
改动点，全是瞬间跳变：

| 位置 | 硬切换 |
| --- | --- |
| `attachSource` | `audio.src = <新流>` + `audio.volume = state.volume` + `play()`：旧流在任意采样处被掐断，新流以满幅起播 |
| `cueSource` | 同上（不含 play） |
| `toggle` | `audio.pause()`：全幅一步归零 |
| `stopAudio` | `pause()` + `load()`：双重硬停 |

爆音的物理成因是波形的瞬间不连续：输出从满幅一步跨到 0（或反过来）。
Apple Music 之所以不会，是因为它做淡入淡出（且音频图常驻）。这不是解码质量问题。

### 5.23.2 修法：音量短渐变（淡出 → 换源/暂停 → 淡入）

- `rampVolume(to, ms)`：16ms 步进线性推 `audio.volume`；`state.volume` 始终是用户设定值，
  渐变只改瞬时值，不写 state / prefs。
- `cancelFade()`：取消在飞渐变，并把它的 promise 以 `false` 结算。
- `attachSource`：正在出声 → 先淡出 70ms → 换源 → `play()` → 起播后淡入 90ms；
  没有声音可淡 → 完全同步起播（见下）。
- `toggle` 的暂停路径：先淡出再 `pause()`；被后续动作取消时（`ok === false`）不暂停。
- `setVolume`：先 `cancelFade()` 再设值（用户拖动优先）。
- `stopAudio` / `halt()`：先 `cancelFade()` + 瞬时音量落 0，然后立刻断开（不等渐变）。

### 5.23.3 三条实测教训（都留了代价）

1. 把起播塞进 `await` 之后 → 6 套既有回归当场变红。 第一版无论是否在播都走
   `await fadeOutBeforeCut()`，起播时序整体后移一个微任务；`progress bar` / `resume after cut` /
   `refresh remap` / `restore race` / `teardown` / `delete flow` 六个套件报
   `playCount=0` / `src=`。修法：没在播时完全同步起播（与引入渐变之前逐字一致）。
2. 判据写错会一直走错分支。 我最初写 `audio.paused || audio.volume <= 0.001` ——
   夹具的假元素没有 `paused` / `volume` 属性时 `undefined || (undefined <= 0.001)` 两个分支
   都是 false，于是「暂停中」被判成「正在播」，异步路径永远生效。
   改成「确定正在出声才淡出」：`paused === false && Number.isFinite(volume) && volume > 0.001`。
3. 我自己的断言也可能是假的。 第一版 A1 断言「`play()` 之后 src 必须同一 tick 挂上」，
   它红了 —— 一查才发现本仓库的起播路径本来就不是同步挂源（先 await session/库）。
   改成有判别力的形式：「30ms 内必须挂上，且之前不得有多步淡出」。

### 5.23.4 门禁 `scripts/test-audio-fade.mjs`（15 条断言）

夹具是记录操作顺序的假媒体元素（`paused` / `volume` 都是真属性，每次写入记 `{op, v}`），
因为要断言的正是谁先谁后。覆盖：A 首播不等淡出（30ms 内挂源 + 之前最多一次归零写入）·
B 播放中换源前必须多步淡到 ~0 且单调 · C 换源后淡回用户值 · D 暂停前先淡出 ·
E 淡入进行中改音量不被覆盖 · F 连切后音量正确且渐变已结算（不挂住）·
G `halt()` 后不得再写 `audio.volume` 且已静音。

三条负向对照，各自精确变红（每次都 `tsc` 重建产物，§9 第 5 条）：

| 对照 | 结果 |
| --- | --- |
| `attachSource` 永不淡出（`audible = false`） | `FAIL B2 … steps=1` |
| 暂停退回直接 `audio.pause()` | `FAIL D1 … pause@0 fade=[]` |
| `setVolume` 不取消在飞渐变 | `FAIL E1 … volume=1.000 want=0.33` |

> E 的第一版没有判别力：我把「改音量」和「换源」放在同一刻，那次淡入的目标本来就是新音量，
> 取不取消 `cancelFade` 都能过（对照 C 一度 ALL PASS）。改成在淡入途中（t≈120ms）改音量
> 之后，对照才精确变红。这正是 §6.1 第 7 条要求做对照的原因 —— 不做对照我不会发现它。

### 5.23.5 验证边界（必须如实说）

jsdom 没有音频输出。本套件验的是「不产生瞬间跳变」的机制与时序，
不代表真实听感已经验证。真实结论需要戴耳机人工确认 —— 这一条写进了 `AGENTS.md §2.18`。

### 5.23.6 验证

`typecheck` 0（基线 0）· `ALL 28 SUITES PASS`（新增 `test-audio-fade`，已注册进 `run-all`）·
`check-build-fresh` 一致 · `check-strict` 通过 · manifest PASS · `git diff --check` clean ·
AGENTS.md 59,828 B（91.3%）· README 同步为 28 套

---

## 5.24 过程失误 —— 第 16 轮的代码两轮没进仓库，而文档已在声称「完成」

发现方式：第 18 轮收口时 `git status --short` 里 `scripts/test-view-persistence.mjs` 显示为
`A`（新增） —— 一个我在第 16 轮就写好、`run-all.mjs` 里也注册了、AGENTS 与台账都记了「已完成」
的套件，在 git 里从来不存在。

实际影响：第 17 轮推出去的 `cc5a9a9` 不含第 16 轮的修复。任何在那段时间从 GitHub 安装的人
拿到的是「切到「对话」再切回「音乐」就退回列表页」的旧行为 —— 而仓库文档、`AGENTS.md §2.17`、
台账 §5.22 都在说这个 bug 已修。文档与仓库实际状态不一致，持续了两轮。

为什么没被发现：

1. 第 16 轮我跑了全套门禁（本地 `lib/` 全绿），就据此写了「完成」——
   但门禁读的是工作区，不是 git 索引。工作区绿 ≠ 已提交。
2. 第 17/18 轮开头我没检查 `git status`，直接基于「上一轮已完成」的假设继续。
3. 第 17 轮那次 `git add -A` 提交（`cc5a9a9`）只显示了 `AGENTS.md` / `README.md` /
   `docs/audit-ledger.md` / `docs/compatibility.md` 四个文件 —— 这个信号就在眼前（第 16 轮的
   `src/client.ts` 和测试文件都不在里面），但我当时没有把「少了文件」当成异常。

这与 §6.1 第 2 条是同一类错误：「禁止把 README / 注释的自我描述当事实」——
只不多这次的「自我描述」是我自己上一轮的结论。上一轮的结论同样是待证事实，不是前提。

处置：`c69dabe` 已把第 16 轮的全部改动（`src/client.ts` / `lib/client.js` /
`scripts/test-view-persistence.mjs` / `run-all.mjs` 注册）与第 18 轮的淡入淡出一起提交并推送，
CI 绿。此后 `AGENTS.md` 的「已完成」才等于仓库里的状态。

新增判据（已写进 `AGENTS.md §0.4` 第 7 条与 §6.1 第 9 条）：

> 收口 = 提交 + 推送 + `git status --short` 为空 + CI 绿。 只跑门禁不算完成 ——
> 门禁验的是工作区，`git status` 才验仓库。文档里写「已完成」之前，先确认它在 HEAD 里。

同族教训（可以推广的形态）：「验证通过」与「已交付」是两个不同的断言，
各有各的证据来源。把前者的证据拿来说后者，就是这一轮的失误。

---

## 5.25 第 19 轮 —— 「电流声」真因：输出设备被反复重建（第 18 轮的判断被推翻）

### 5.25.1 第 18 轮的结论被用户实测推翻（按 §6.2 新写条目，不覆盖）

第 18 轮我按「波形瞬间跳变」做了音量淡入淡出，并把 §2.18 写成规则。用户实测：电流声依旧。
⇒ 「音量跳变」这个假设不足以解释症状。按 §6.2，判定推翻新写一条，不修改 §5.23。

我的方法错误：第 18 轮我没有任何指向该成因的证据，只是「这个解释听起来合理」就动手了，
并在交付里写了「已修复」。没有证据的成因假设，不管多合理，都不该以「已修」交付。

### 5.25.2 取证：从用户机器上取，而不是继续猜

| 证据 | 结果 |
| --- | --- |
| 曲库采样率分布（ffprobe 全库实测） | 44.1kHz 133 首 · 48kHz 10 首 · 96kHz 5 首 |
| 位深分布 | 16bit 与 24bit 混排（63 + 53 首 16bit、17 首 44.1k/24bit、9 首 48k/24bit） |
| 宿主响应头（运行中的 :3080 实测） | 媒体 206 + `content-type: audio/flac`，无 `access-control-allow-origin` |
| 正常切歌路径 | `playIndex` 不调 `stopAudio`，只换 `src`（排除「多余拆管线」） |

机制：Chromium 为每一条媒体源单独建一条音频输出流；换 `src` = 「销毁旧流 + 按新文件的
采样率与位深建新流」⇒ macOS 必须重协商输出设备格式。设备重建就是那一声电流声，
而它发生在增益级之外 —— 所以第 18 轮的音量渐变原理上消不掉。Apple Music 不会，
是因为它用一条固定采样率的混音总线。

### 5.25.3 修法：常驻音频图（与系统播放器一致）+ 媒体窄名单 CORS

- `src/client.ts`：常驻 `AudioContext` + `createMediaElementSource` + `GainNode`。
  一条输出流、一个固定采样率，所有媒体重采样进去 → 设备格式不再变。
- 渐变改走 `linearRampToValueAtTime`（采样级），比 16ms 定时器写元素音量更平滑。
- `src/host.ts`：`mediaCorsHeaders` 只对窄名单（`dsh-app://app` + 回环 origin）回显 ACAO；
  `mediaPreflight` 应答 `OPTIONS`（`Range` 不是 CORS 安全列表头），媒体端点三个都放行
  （含 `system-stream` —— 桌面版实际走的就是它）。
- 三级降级：拿不到 AudioContext/建图失败 → 永久退回元素音量；跨源且未确认 CORS →
  先直连 + 后台探一次，确认后下一首才建图；兜底开关 `?musicGraph=0`。

### 5.25.4 门禁抓到的静音 bug（比电流声严重）

`test-audio-graph.mjs` 的 B2 断言「建图后元素音量必须置中性」，第一次跑就红了：

> 建图之前 `applyVolume(0)` 写的是元素音量；建图之后真正的增益才在图里。
> 不把元素音量置中性 = 「元素 0 × 增益」= 第一次起播完全没声音。

这是本轮最值钱的一条：如果没有这条断言，我会带着一个「改成静音」的修复交付，
比原来的电流声糟糕得多。断言写在「机制是否正确」上，才会连我自己没想到的后果一起抓住。

### 5.25.5 我在这套新门禁上踩的四个坑（全部是自伤）

1. 忘了 rebuild 就断言 host CORS —— 门禁读 `lib/`，控制组/被测组都是旧产物（§9 第 5 条）。
2. 夹具写成 `{...media, get src(){}}` —— 这是拷贝，`play()` 改外层、断言读副本，
   `ctx=0` 的假象由此而来（§9 第 4 条，本套件第三次栽在夹具保真度上）。
3. `dsh-app://app` 当 jsdom 的 URL → opaque origin → `localStorage` 抛 `SecurityError`。
   跨源要用「页面端口 ≠ 媒体端口」构造。
4. `crossOrigin` 没做成反射属性 → 断言读 attribute 恒 undefined。
5. 断言写错三处：A8 期望「平台路由放行跨源预检」（事实相反，栅栏先 403）、
   A9 用 app origin（测到的是栅栏不是调度）、B9 用 opaque origin。

### 5.25.6 顺带发现的产品代码脆弱点

`sameOriginAsPage` 原来用裸 `location`。bundle 由宿主 `eval`，「裸 `location` 能否解析」
取决于宿主作用域 —— 本轮真机/夹具的差异正出在这里（夹具里 `location` 未定义 → 抛错 →
catch → 一律判「跨源」）。改成 `window.location` 后两条路都对。已写进 §2.19。

### 5.25.7 验证

`typecheck` 0 · `ALL 29 SUITES PASS`（新增 `test-audio-graph.mjs`，19 条断言）·
四条负向对照各自精确变红（不置中性→B2 · 无 CORS→A1/A2 · ACAO=*→A1/A2 · 跨源不设
crossOrigin→B11）· `check-build-fresh` 一致 · `check-strict` 通过 · manifest PASS · `diff --check` clean。

验证边界：jsdom 没有音频设备。门禁验的是「常驻一条流 / 跨源前提 / 分级回退」的机制，
**真实听感必须人工确认** —— 这一条写进了 §2.19，不再声称「已验证无电流声」。

---

## 5.26 一次原因未能确定的 CI 失败（如实登记）

### 5.26.1 现象

| 提交 | CI | 产品代码 |
| --- | --- | --- |
| `9a21c72`（第 17 轮文档） | success | — |
| `a4e6e92`（第 19 轮：常驻音频图 + CORS + 新门禁） | failure | 改 |
| `827602c`（只改 run-all / 新门禁 / ci.yml 的诊断能力） | success | 与 a4e6e92 逐字节相同 |

`827602c` 的 `lib/` 与失败那次完全一致，却绿了。⇒ 那次红不是产品代码引起的
（否则同样的 `lib/` 必然再红）。推断指向新加的门禁套件自身抖动。

### 5.26.2 为什么我拿不到日志（两层缺陷，都已修）

1. `run-all.mjs` 把 stderr 整个吞掉了（运算符优先级）：
   `console.log(run.stdout ?? '' + run.stderr ?? '')` ≡ `stdout ?? ('' + stderr)` —— stdout 永远
   非 null，所以 stderr 从没被打印过。崩溃/未捕获异常都走 stderr ⇒「失败但零信息」。
2. CI 日志对无 token 的 API 不可读：`/actions/jobs/<id>/logs` 返回 403，所以从外部
   只剩 annotation 可读。

修法：`run-all` 分别打印 stdout / stderr / spawn error / 被杀信号；`ci.yml` 在失败时把输出尾部
以 `::error::` 输出（annotation 可读）；新套件注册 `uncaughtException` / `unhandledRejection`
→ 打成一条 FAIL 再退出，并加「A0: 库扫描在 30s 内完成」守卫。

### 5.26.3 我做了什么（不能声称「已修复」）

- 如实说明：失败的具体套件与原因我没能确定，因为当时没有可读的诊断输出。
- 可用的证据只有「耗时」（125s vs 119s）—— 但 `run-all` 失败也继续跑完所有套件，
  所以耗时无法区分是哪一套挂的。这一步我判断错了方向，浪费了一轮。
- 在本机把最可能受负载影响的 5 套各跑 5 遍：全部 5/5 通过，本机不可复现。
- 决定性动作：把新套件里的固定 `sleep` 全部换成有界轮询 `waitFor`。断言口径未变
  （仍断言最终值与机制），只是不再赌「固定 sleep 够长」。改后连跑 8/8 通过。

### 5.26.4 沉淀

- **失败必须留下可外部读取的原因**。日志不可达时，annotation 是唯一的出口 —— 门禁的
  「诊断可用」不只是打印 stderr，还包括让失败能被不在现场的人定位。
- 判断「哪一套挂了」不能靠总耗时：`run-all` 失败后仍继续，总时长不随失败位置变化。
  这也是我在 §5.26.3 里说的方向性错误。
- 「修好了」需要证据。本轮我只做到「更稳 + 下次可诊断」，没有找到根因；
  台账如实标注状态为未定因，不写成「已修」。

---

## 5.27 第 20 轮 —— 调研 Musish（结论：帮不到）+ 补 sampleRate 诊断

### 5.27.1 用户提供的线索：`github.com/Musish/Musish`

Musish 是知名的开源 Apple Music Web 客户端，正好也是「在浏览器里放 Apple Music」的场景，
所以值得查它有没有处理设备协商的代码。结论：没有，而且原因很说明问题。

实测（`git clone --depth 1`，HEAD `9846878`，最后提交 2020-08-30）：

| 在 Musish 里搜 | 结果 |
| --- | --- |
| `AudioContext` | 0 处 |
| `createMediaElementSource` | 0 处 |
| 自建 `<audio>` / `<video>` / `new Audio(` | 0 处 |
| 媒体 `crossOrigin` | 0 处（唯一命中是 Font Awesome 的 `<link crossorigin>`） |
| `fade` | 16 处 —— 全是 CSS `@keyframes fadein` 的 UI 动画，与音频无关 |
| 它自己的音频 API 面 | 只有 `music.player.play()` / `player.volume` / `player.seekToTime()` |
| 音频相关配置 | 仅 `bitrate: MusicKit.PlaybackBitrate.HIGH` |

⇒ 它把全部播放委托给闭源的 MusicKit JS。**Apple 那套「不爆音」的管线就在 MusicKit JS
内部，而它是闭源的；Musish 只是 UI 外壳。所以这个方向拿不到我们想要的东西**（记在这里，
避免以后重复调研）。

### 5.27.2 但调查带来一个独立确认：我们的修法就是 Web 音频的标准做法

对照 howler.js（Web 音频播放器的事实标准库，本地音乐 Web 客户端普遍使用）：

- `Howler.ctx = new AudioContext()` —— 进程级一个常驻 ctx，不是每个声音一个
- `Howler.masterGain = ctx.createGain()` + `connect(ctx.destination)` —— 一个总增益
- 每个声音 `connect(Howler.masterGain)`；音量走 `masterGain.gain.setValueAtTime(vol, ctx.currentTime)`
  —— 采样级调度
- 源码注释明确写了采样率的坑：*"Bugs in the browser … can cause the sampleRate to change from
  44100 to 48000. By calling Howler.unload(), we create a new AudioContext with the correct sampleRate."*

⇒ 常驻 ctx + 总增益 + 采样级渐变正是第 19 轮实现的架构，不是猜的。

### 5.27.3 由此补的一条诊断（本轮唯一代码改动）

`AudioContext.sampleRate` 在创建时就固定（howler 为此专门 close 重建 ctx）。这意味着
「设备在页面打开之后才换（插上耳机）」的场景，ctx 可能钉在旧设备/旧采样率上 ——
而正是这位用户的使用方式。

以前这个数字没有暴露，外部无法判断。现在建图时留一行无凭据诊断：

```
[dsh-music-player] 常驻音频图已启用：sampleRate=48000Hz state=running（所有媒体重采样到这条流，输出设备格式不再变）
```

回退路径同样各留一行（无 AudioContext / 建图失败 / 跨源 CORS 探测结果）。这符合 §2.16
「在行为发生的那一刻记」——只看失败是不够的，成功那一刻的状态也要能看到。

门禁 `test-audio-graph` 新增两条把它们钉死：
B12 建图时必须留下含 `sampleRate` 的诊断；B13 诊断行**不得含 URL 或 `t=`**
（§2.9：能力 token 就在 query 里）。

### 5.27.4 类型棘轮当场抓到一处

`catch (error)` 里 `error.name` 报 `TS2339` —— `useUnknownInCatchVariables` 是打开的
（§2.15），catch 变量必须先收窄（`error instanceof Error`）。类型基线 0 让它立刻变红。

### 5.27.5 验证

`typecheck` 0 · `ALL 29 SUITES PASS` · `check-build-fresh` 一致 · `check-strict` 通过 ·
manifest PASS · `diff --check` clean。真实听感仍未验证（jsdom 没有音频设备），
诊断的目的正是让用户与我能从外部判断机制是否生效。

---

## 5.28 第 20 轮 —— fooyin（Qt/C++ 本地播放器）给了决定性对照，并校准了过渡时长

### 5.28.1 调研对象

用户给的第二个仓库：`github.com/fooyin/fooyin`（HEAD `ef118e3`，2026-09-30，815 cpp / 861 h）。
它与 Musish 完全不同：Musish 只是调用闭源 SDK 的外壳，而 fooyin 有真正的播放器内核
（`src/core/engine/`：pipeline / DSP 链 / 解码 / 输出插件 / 过渡编排）。

### 5.28.2 它同时做了我们分两轮才各做一半的两件事（这是本轮最重要的发现）

| fooyin 的做法 | 出处 | 对应我们 |
| --- | --- | --- |
| 输出设备是一个长会话，被管线持续喂数据：`negotiateFormat()` → `init(format)` → `start()` → `write()`… → `uninit()` | `include/core/engine/audiooutput.h` 的 lifecycle 注释 | 第 19 轮的常驻 AudioContext |
| 「terminal resampling for output compatibility」，默认开（`createSetting<OutputAutoResample>(true,…)`）；有 master output format 与可选重采样器（默认首选 SoX） | `include/core/engine/pipeline/audiopipeline.h:228`、`src/core/internalcoresettings.cpp:169`、`pipelinerenderer.cpp` 的 `m_outputResampler` / `m_masterOutputFormat` | 第 19 轮「所有媒体重采样进同一条固定采样率输出流」 |
| 每一次过渡都淡入淡出，含 seek | `include/core/engine/fadingdefs.h`、`output/outputfader.cpp`（逐样本 `data[i] *= gain`，按 sampleRate 换算包络） | 第 18 轮的淡入淡出 |

⇒ 结论修正：第 18 轮（淡入淡出）与第 19 轮（常驻输出流）不是互相替代，而是两个都要；
而且 fooyin 的时长比我原来的长 3–4 倍，还多了 seek 也要淡。

### 5.28.3 按 fooyin 默认值校准（本轮代码改动）

`fadingdefs.h` 的默认值 → 直接采用：
`manualChange{300/300}` · `autoChange{700/700}` · `seek{120/120}` · `pause{120/120}` · `stop{120/300}`。

| 项 | 改前 | 改后 | 依据 |
| --- | --- | --- | --- |
| 手动切歌淡出/淡入 | 70 / 90ms | 300 / 300ms | `CrossfadingValues::manualChange` |
| 曲末自动接下一首 | 同上 | 700 / 700ms | `CrossfadingValues::autoChange`（`ended` → `advanceIsAuto`） |
| 暂停 / 恢复 | 70 / 90ms | 120 / 120ms | `FadingValues::pause` |
| 拖动进度 | 无 | 120ms 淡出 → seek → 120ms 淡回 | `CrossfadingValues::seek` |

seek 的淡入淡出只在常驻音频图接管增益时启用：图未启用时用元素音量做延迟会让拖动发粘、
且没有采样级保证，那条路径保持既有的同步 seek 语义（既有套件也因此不受影响）。

### 5.28.4 门禁（把「够长」与「seek 也要淡」钉死）

- `test-audio-fade.mjs` H1：手动切歌 `src` 距调用 ≥200ms（实测 301–313ms）；
  H2：`ended` 触发的自动切歌 ≥500ms（实测 707–712ms）。
  没有这两条，把时长改回 70ms 不会有任何门禁变红。
- `test-audio-graph.mjs` B14/B15：seek 必须「淡出 → seek → 淡回」且顺序正确。
- 三条负向对照各自精确变红：时长 70ms→H1 红（84ms）· 自动不区分→H2 红（302ms）·
  seek 立即执行→B14/B15 红。

### 5.28.5 本轮我自己的四个错（都记下来）

1. 锚点缩进靠「带缩进前缀的显示」判断，结果两处都写错（`sed 's/^/  /'` 会加 2 空格）。
   → 教训：取锚点要用 `⟦` 之类的中性标记，或直接看 `grep -n` 的原始行。
2. `clear()` 之后索引算错：B 段开头清空过 `ops`，所以「第二首的 src」是索引 0 而不是 1。
3. 把 H2 放在 `halt()` 之后：teardown 之后 `ended` 不会再换源 → 断言必然拿不到新 src（崩）。
   → 教训：**涉及事件的断言必须放在 teardown 之前**。
4. H2 只等「挂源」没等「淡入完成」，导致后续段落读到半途音量（C1/D1 误红）。

### 5.28.6 验证

`typecheck` 0 · `ALL 29 SUITES PASS` · 三条对照精确变红 · `check-build-fresh` 一致 ·
`check-strict` 通过 · manifest PASS · `diff --check` clean。
真实听感仍未验证（jsdom 没有音频设备）—— 这一条继续如实标注。

---

## 5.29 第 21 轮 —— ReplayGain 响度归一化（推荐顺序的第 1 项）

### 5.29.1 维度与依据

用户要求「按推荐顺序来做」：ReplayGain → 预取 → 均衡器 → 波形。本轮做第 1 项。

依据（fooyin，GPL-3.0；本仓库 MIT ⇒ 只借鉴做法、不抄代码）：
- 只读标准标签 `REPLAYGAIN_TRACK_GAIN` / `_TRACK_PEAK` / `_ALBUM_GAIN` / `_ALBUM_PEAK`
  （`include/core/constants.h:87-92`）；
- 模式 `Off / Track / Album`，两套 preamp（有标签 / 无标签）；
- `PreventClipping`：增益后按峰值收窄（`enginedefs.h` 的 `RGProcess`）。

本仓库的天然适配点：第 19 轮已经有常驻 `GainNode`，标签本来就用 `music-metadata` 读
（它已把 `"-6.50 dB"` 归一化为 `{dB, ratio}` —— 实测确认后才动手）。

### 5.29.2 实现

- 宿主：`Track` 加 4 个字段（未测量时 `null`）；`readFiniteDb` / `readFinitePeak` 只接受有限数
  （标签来自文件，是不可信输入）。
- 客户端：`source → rgGain → volumeGain → destination` —— 两个增益节点分离，否则淡入淡出
  与响度归一化会互相覆盖。`rgForTrack()` 做增益数学 + 防削波；`applyReplayGain()` 在切曲前应用。
  回退路径（无音频图）把 RG 折进元素音量，且 `readVolume()` 把它除回去（否则渐变起点错）。
- UI：播放器里一个 `RG` 按钮循环 `off → track → album`（前级不进 UI，走 API）。
- 门禁：`scripts/test-replaygain.mjs`（15 条）+ 注册进 `run-all`（30 套）。

### 5.29.3 本轮抓到的真缺陷：§2.7 的「四个副本」其实是五个

字段在宿主解析出来了、`Track` 类型也加了，**但 `payloadTracksFor()` 的 `Track → PayloadTrack`
白名单投影没加 ⇒ 下发永远是 `undefined`。门禁 A1–A3 当场变红；负向对照①**就是把投影删掉，
结果 A1–A5 全红 —— 证明这条断言真的有判别力。

⇒ 已写进 §2.20 的引用块：**给 `Track` 加字段必须同时改 `PayloadTrack` 与客户端 `MusicTrack`。**

### 5.29.4 负向对照（每条都重建产物）

| 对照 | 结果 |
| --- | --- |
| 删掉投影白名单里的 RG 字段 | A1–A5 红（`rgTrackGainDb=undefined`） |
| `RG_PREVENT_CLIPPING = false` | B6 红（`rgGain=2.66` 而不是收窄到 `1.012`） |
| 不建独立 RG 节点（源直接接音量） | B1 红（顺序错），且暴露我的套件缺节点时会崩 → 已加 NaN 替身守卫 |
| 回退路径不折 RG 进元素音量 | B9 红（`elementVolume=1` 而不是 `0.473`） |

### 5.29.5 连带修复（不是放宽断言）

- `test-audio-fade` A2 因为 `applyReplayGain` 多写了一次「值没变」的音量而红 ⇒ 改实现：
  RG 未变时不再重复写（冗余写入会让断言失去分辨力）。
- `test-audio-graph` B3 红 ⇒ 发现它的假 `createGain()` 每次返回同一个节点（真实 API 每次是新
  节点）。这是夹具不保真（§9 陷阱 4），改夹具；新增第二个增益后才暴露出来。

---

## 5.30 第 21 轮的数据丢失事故：`git checkout <路径>` 回滚了未提交的实现

### 5.30.1 发生了什么

跑「往源码塞一个行尾空格」的负向对照时，我用

```bash
printf 'const x = 1; \n' >> src/client.ts && node scripts/check-whitespace.mjs | head -3
git checkout src/client.ts          # ← 想「还原」
```

`git checkout <路径>` 从索引恢复文件，而索引里是上一次 commit的版本 ⇒ 它把整个
`src/client.ts` 的 ReplayGain 实现（约 120 行）连未提交的真改动一起回滚了。
`rgForTrack` / `rgGainNode` / `RG_PREVENT_CLIPPING` 全部变成 0 命中。

### 5.30.2 怎么恢复的（可复现的恢复路径）

关键：`lib/client.js` 是那次丢失源码编译出来的产物，还在磁盘上（只是 `src` 被回滚）。

1. `cp lib/client.js /tmp/lost-client.js` —— 先备份「丢失源码的产物」；
2. 重放 `Patch A`（10 处编辑）与 `Patch B`（10 处编辑）—— 都是本轮真实执行过的补丁；
3. `tsc` 重新编译；
4. `diff /tmp/lost-client.js lib/client.js` ⇒ 逐字节一致（唯一差异是我随后清理的那一个
   行尾空格）⇒ 恢复逐字忠实，不是「看起来差不多」。

### 5.30.3 沉淀（已进 §9 陷阱 12）

- **禁止**用 `git checkout <路径>` 撤销「临时改坏文件做对照」。
- 做对照前后一律 `cp 文件 /tmp/xxx.bak` 再 `cp` 回来；对照脚本里也不要出现任何
  「从仓库恢复」的命令。
- 附带教训：产物不只是产物 —— 在源丢失时，它是唯一能证明「恢复是否忠实」的参照物。
  这也让「提交 `lib/`」这条既有取舍多了一个理由。

---

## 5.31 门禁设计缺陷：`git diff --check` 在产物上给出无法修复的失败

### 5.31.1 问题

`AGENTS.md` §3 一直写着「跑 `git diff --check`」，但它是人工纪律、不是门禁，而且：

- `lib/client.js` 里 tsc 的 JSX 输出会在部分行尾留空格 —— HEAD 实测就有 16 处；
- 而手改 `lib/` 违反 §2.15（`check-build-fresh` 逐字节比对会立刻判红）。

⇒ 「产物有行尾空白」在现行规则下无解。本轮我改到其中一行（加 `rgButton`），
`git diff --check` 就把那个先前就存在的空格报成新增问题。

### 5.31.2 修法：把纪律变成门禁，并明确排除产物

新增 `scripts/check-whitespace.mjs`，接入 `npm test` 与 CI：

- 扫全树（不依赖 diff 基，CI 里同样有效）；
- 排除 `lib/` 与 `pnpm-lock.yaml`，理由写在脚本文件头（产物质量由 `check-build-fresh` 保证）；
- 带非空护栏：扫描到的文本文件数 < 20 就判失败 —— 防止「0 命中」其实是因为遍历坏了
  （§6.1 第 3 条：0 命中必须先校准搜索面）。

CI 的「Whitespace and conflict markers」步骤改为调用同一脚本（原先只查冲突标记），
本地与 CI 判据现在完全一致。

### 5.31.3 对照

塞行尾空格 → 红（定位到 `src/client.ts:4288`）· 塞冲突标记 → 红（`scripts/run-all.mjs:58`）。
全树（排除产物）存量行尾空白实测 0，所以门禁从第一天起就是干净的。

---

## 5.32 第 21 轮（续）—— ReplayGain 测量：让「只读标签」不再等于空操作

### 5.32.1 为什么必须做

用户要求「按推荐顺序来做」，①读标签落地后**我实测了用户曲库：抽查 40 首，0 首带
`REPLAYGAIN_*` 标签。⇒ 对一个真实曲库，只读标签的 ReplayGain 是空操作**。
测量不是加分项，是这个功能能不能用的前提。

### 5.32.2 做法（与参考实现一致，但绝不改用户文件）

- 用 ffmpeg `ebur128=peak=true` 只读扫描；增益 = `-18 LUFS` − 实测积分响度
  （ReplayGain 2.0 参考电平，与 `loudgain` 一致）。
- 结果存插件自己的缓存 `$DSH_HOME/storages/dsh-music-player-rg.json`，带 `size`+`mtimeMs`
  做失效判断（文件没变就跳过，重复点按几乎零成本）。
- **绝不写回音频文件**（改用户文件是不可逆副作用，§2.20）。
- 新端点 `GET|POST /api/dsh-music/measure`（四处同步 + manifest 校验）。
- 客户端标签优先、测量兜底；打开归一化时若当前曲目两份数据都没有，自动开始测量并轮询进度。

### 5.32.3 门禁（Part C，8 条）+ 五组负向对照

`test-replaygain.mjs` 的 Part C 断言：端点形状（GET 只报状态，不顺手启动测量）、
测量值等于独立量出的换算值（夹具 tone.flac 实测 `-33.1 LUFS` → `+15.10 dB`，误差 ≤0.5dB）、
全静音保持 `null`（不算失败）、重复测量走缓存、teardown 后端点不再服务、新实例状态干净、
客户端测量兜底与「标签优先」。

| 对照 | 结果 |
| --- | --- |
| 客户端去掉测量兜底 | B11 红（rgGain=1 而不是 ×5.69） |
| 让测量压过标签 | B12 红（用了 +15.1 而不是标签的 -6.5） |
| payload 不下发测量值 | C4–C7 红 |
| 静音不特判（`-inf` 峰值当 0dB） | C6 红（得出 +52dB 的荒谬增益） |
| 删掉 `dispose()` 里的 `stopRgMeasure` | C8 仍绿（见下） |

### 5.32.4 诚实记录一个覆盖缺口（以及补法）

对照⑨证明：C8 不能证明子进程被杀 —— 它只证明了「teardown 后宿主实例被摘除、端点不再服务」。
删掉 `dispose()` 里的 `stopRgMeasure('插件已停用')`，C8 照样通过。

两件事都做了：
1. C8 的标签改成如实描述（说清它证明什么、不证明什么，§2.20 与 `docs/gates.md` 同步）；
2. `test-audit.mjs` 补一条静态接线检查：`dispose()` 必须同时调用 `killAllMvJobs(` 与
   `stopRgMeasure(`（对照实测：删掉即红）。行为不可稳定观测时，用静态检查守接线 —— 两者合起来
   才是完整覆盖（«关禁不能只是看起来存在»）。

### 5.32.5 本轮踩到的三个新坑（都是「检验方法本身」类）

1. `DSH_HOME` 在模块加载时就固化为 `const`：测试里改 `process.env.DSH_HOME` 对已加载的模块
   无效，Part C 因此测的是 Part A 目录里的两个静音文件（症状：`lufs=-70`）。
   ⇒ 修法是走真实传输面 `POST /dir` 切目录 —— 顺带也更接近真实用法。
2. Part B 的 boot 会把 `globalThis.fetch` 换成 mock，而 Part C 要打真宿主 ⇒ 全部请求返回 `{}`。
   ⇒ 在文件顶部先捕获真身 `const nodeFetch = globalThis.fetch;`，Part C 专用。
   教训：**一个进程里混用「真实传输面」与「mock 传输面」时必须显式区分**。
3. 路由一致性门禁的方法推断只支持单方法写法：写成 `&& (req.method === 'POST' || req.method === 'GET')`
   时它只认出 0/1 个方法并误报。⇒ 加强推断能力（收集同一条件里所有 `req.method`），
   并做对照：给只处理 GET 的路由声明 POST → 立刻红（判别力没退化）。

### 5.32.6 验证

`typecheck` 0 · `ALL 30 SUITES PASS`（`test-replaygain` 现 24 条）· `check-build-fresh` 一致 ·
`check-strict` 通过 · `check-whitespace` PASS · manifest PASS（新增端点后重跑）·
空白/冲突标记干净。真实听感与「测量是否让响度变匀」仍需人工确认 —— jsdom 没有音频设备。

---

## 5.33 第 22 轮 —— 预取 + 交叉淡化（推荐顺序的第 2 项，默认关闭）

### 5.33.1 要解决的问题

第 20 轮按 fooyin 把过渡校准到 300/700ms：遮蔽力上去了，但手动切歌多出约 300ms 淡出缝。
fooyin 没有这个代价，因为它的 300ms 是重叠的交叉淡化（`nexttrackpreparer` + crossfade）。
本轮补上浏览器里的等价物：两个媒体元素 + 每元素一个电平节点。

### 5.33.2 为什么默认关闭

300ms 淡出是对「设备格式重协商瞬态」的保险，而用户尚未确认噪声已消失（§2.19 的验证边界）。
把它默认打开等于在未确认的前提下换掉一条已验证的路径。因此本轮：
默认路径逐字不变（门禁 D0 保证未开启时不创建第二个元素、不预取），
用 `?crossfade=1` / `window.__dshMusicCrossfade` 可选开启；确认噪声消失后再默认开启 ——
届时 H1/H2 的「先淡出再换源」语义要同步改成「重叠」语义。

### 5.33.3 实现要点

- 图：`sourceX → levelX → rg → volume → dest`（两个元素接进同一个常驻 AudioContext，
  设备流仍只开一条 ⇒ §2.19 的前提不变）。
- `audio` 由 `const` 改 `let`：交接时交换绑定（`audio = inEl`），90+ 处引用自动跟随；
  活跃元素查询走 `player.media()`（调用时才读 `audio`）。这是把「交换活跃元素」的成本从
  「改 90 处引用」降到「改 1 行」的关键。
- 预取：起播后把下一首挂到空闲元素上（只加载、不出声），切换时直接 `play()`
  —— 省掉加载等待（fooyin 的 `preferredPrefillMs` 在浏览器里的对应物）。
- 交接：320ms 后停旧元素、清它的 `src`、交换角色、继续为新空闲元素预取（链式）。

### 5.33.4 门禁（`test-audio-graph` D 段，7 条）+ 四组负向对照

| 对照 | 结果 |
| --- | --- |
| 不预取 | D1/D2/D3/D4 红 |
| 交接后不交换绑定 | D4/D6 红 |
| 退化成串行（先淡出再淡入） | D2 红 |
| halt 不停空闲元素 | D6 红（改写后；见下） |

### 5.33.5 本轮第三次踩「断言看着强、其实不判别」——两条都改了

1. D2 一开始只断言「两条 ramp 落在不同节点」：串行实现（先淡出、再淡入）也会满足。
   改成断言「两条 ramp 同刻起算」后，对照⑫才变红。
2. D6 第一版写成「交叉后再 halt」：那时空闲元素已被交接逻辑 pause 过，删掉 `halt()` 里的
   停止调用照样通过。改成「等新元素真的开始播放（交叉已启动）再 halt」，对照⑬才变红。
   顺带发现：切歌是异步的，直接 `play(1); halt();` 会让 halt 抢跑 —— 断言必须等 `play` 事件。

两条都是「先做负向对照，才发现断言不判别」—— §6.1 第 7 条不是形式主义。

### 5.33.6 验证

`typecheck` 0 · `ALL 30 SUITES PASS`（默认路径零影响 + D 段 7 条）· `check-build-fresh` 一致 ·
`check-strict` 通过 · `check-whitespace` PASS · manifest PASS · 工作区干净。
交叉淡化的真实听感仍未验证（jsdom 没有音频设备，且默认关闭）。

---

## 5.34 第 23 轮 —— 均衡器（推荐顺序的第 3 项）

### 5.34.1 实现

10 段 ISO 中心频率（31…16k）的 peaking 滤波器串成一条链，插在 RG 与音量之间：
`源 → RG → f1 → … → f10 → 自动前级 → 音量 → destination`。8 个内置预设
（原声 / 流行 / 摇滚 / 古典 / 爵士 / 低音增强 / 人声 / 电子）+ `setEqualizer([...])` 自定义曲线。
UI 是播放器里一个 `EQ` 按钮在预设间循环（曲线与预设都持久化）。

- 0dB 的 peaking 滤波器就是直通 ⇒ 「关闭」不需要旁路开关，也就没有「开关状态与曲线状态
  不同步」这类 bug。默认 `flat`（不动音色）。
- 自动前级 `10^(-max(0, 最大提升)/20)`：只提升某几段会把峰值推过满刻度，这个补偿与 RG 的
  防削波同一思路。
- 缺 `createBiquadFilter` 时只跳过 EQ：绝不能因此把整条音频图判为失败 —— 那会连 §2.19 的
  常驻输出流一起丢掉（门禁 E10 钉死这条降级路径）。

### 5.34.2 门禁（`test-audio-graph` E 段，10 条）+ 五组负向对照

| 对照 | 结果 |
| --- | --- |
| 不建滤波器链 | 8 条红（E1–E8） |
| 增益不写到滤波器上 | E4/E6/E8 红 |
| 两处夹范围都删 | E6/E8/E9 红 |
| 不设自动前级 | E5 红 |
| 非法输入不拒绝 | E7/E8/E9 红 |

### 5.34.3 本轮第四次踩「断言看着强、其实不判别」

1. 夹范围写了两处（API 边界 + 应用层，纵深防御）：只删一处的对照仍然通过 —— 于是把对照
   改成「两处都删」才变红。对照要删到断言真正依赖的那一层。
2. `[].every()` 恒真：不建链时 E3/E4/E8 本来会空过（比恒绿更隐蔽）。全部补上
   `filters.length === 10` 非空护栏后才如实变红。
3. `check()` 的 detail 是无条件求值的：没有滤波器时 `filters[0].gain` 在 detail 里崩，
   把 E6–E10 一起掩盖 —— 护栏要同时加在条件与 detail 上。

### 5.34.4 连带修复：门禁按角色选节点，不按创建顺序

均衡器插进链后，`test-replaygain` 里 `store[1]` 拿到的已经不是 RG 节点而是 EQ 前级
（B3–B12 集体变红）。改成按角色选取：音量节点 = 接 `destination` 的那个、
RG 节点 = 被 media source 接进去的那个。这比索引更稳（索引只是实现的偶然顺序）——
已并入 §2.15 的「静态断言的四个坑」。

### 5.34.5 验证

`typecheck` 0 · `ALL 30 SUITES PASS` · `check-build-fresh` 一致 · `check-strict` 通过 ·
`check-whitespace` PASS · 均衡器的真实听感未验证（jsdom 没有音频设备）。

> `AGENTS.md` 预算警告：本轮后又到 64,377 B（64 KiB 的 98.2%）。已连续三轮靠临时压缩维持，
> 下一次必须做结构性下移（把 §2.11–§2.14 的历史规则整段移到 `docs/`），否则迟早撞上
> 静默截断（§11）。

---

## 5.35 第 24 轮 —— CI 让一条临界抖动断言翻红（改测量，不放宽阈值）

### 5.35.1 现象

均衡器的 commit（`34b8791`）本地 30 套全绿，CI 红：

```
FAIL cover cache byte cap bounds retained buffers (< 64MB) | arrayBuffers growth=83.9MB
1/30 SUITES FAILED   （失败套件：perf / memory / fd）
```

与均衡器无关（该套件驱动的是宿主 HTTP 面；均衡器全在客户端）。同一个 commit 本地读数是
60.0MB、cap 64MB —— 余量只有 4MB：这是一条本来就临界的断言，CI 的 GC 时机把它推过了线。

### 5.35.2 根因：测的不是「保留量」

```js
gc(); const before = process.memoryUsage().arrayBuffers;
for (const t of covLib.tracks) { const r = await fetch(...); await r.arrayBuffer(); }   // 24×6MB
gc(); const growth = (usage.arrayBuffers - before) / 1024 / 1024;
```

`await r.arrayBuffer()` 在测量进程自己留下 24 个 6MB ArrayBuffer（144MB 临时占用）。单次 `gc()`
收不干净 ⇒ 读数 = 「宿主真实保留量」+「GC 没来得及收的垃圾」，随 GC 时机漂移。

### 5.35.3 修法（测量改了，cap 没动）

1. 流式排空响应（`for await (const chunk of r.body)`），不留大临时对象；
2. 反复强制 GC 取稳态最小值（最多 12 轮）——断言对象是「保留量」；
3. 没有 `--expose-gc` 时明说 SKIP，不冒充通过。

结果：30.0MB，连跑三次完全一致（= 宿主 32MB 上限的真实保留量，`COVER_CACHE_BYTES_LIMIT`），
cap 仍是 64MB（2× 余量）。

### 5.35.4 对照（证明断言没被放宽）

| 对照 | 结果 |
| --- | --- |
| 把宿主 `COVER_CACHE_BYTES_LIMIT` 抬到 4GB（等于取消上限） | 144.0MB → FAIL ✅ |
| 恢复 | 30.0MB → PASS ✅ |
| 不加 `--expose-gc` 运行 | 明确 `SKIP`（并说明需要该开关）✅ |

### 5.35.5 沉淀

新增 §9 陷阱 13：GC 时机敏感的断言测的不是保留量；修法是改测量（排除自身噪声 + 取稳态 +
缺测量能力时明说 SKIP），不是放宽阈值（§6.2）。

---

## 5.36 第 24 轮（续）—— `AGENTS.md` 结构性裁剪（不再靠临时压缩硬撑）

连续四轮都在「加规则 → 临时压缩」，本轮已到 64,999 B（64 KiB 的 99.2%），离静默截断只差
537 B。按 §11 的硬约束做了一次结构性下移（不是再压一两句）：

- §2.11 / §2.12 / §2.19 / §2.20：把历史叙述压成规范结论（每条规则一条不少，删的是「第几轮
  怎么误处置」的叙事——那些本来就在台账里）。
- §9：新增陷阱 13（GC 时机敏感的断言），并修掉插入时错位到 11 与 12 之间的顺序问题。
- 结果：63,954 B（97.6%，余量 1,582 B）。

> 教训：下一轮开始前先看 `wc -c AGENTS.md`，接近 60 KiB 就当场下移，不要等它涨到 99%。

---

## 5.37 第 24 轮 —— 波形进度条（推荐顺序的第 4 项，也是最后一项）

### 5.37.1 实现

宿主 `GET /api/dsh-music/waveform?p=<id>`：ffmpeg 只读解码成 8kHz 单声道，按 0.25s 流式聚合
取峰值（内存与曲长无关 —— 绝不缓冲整段 PCM，一小时就是 56MB），每首各自归一化到 0..1，
缓存到 `$DSH_HOME/storages/dsh-music-player-waveform.json`（`size`+`mtimeMs` 失效）。
客户端把 400 桶抽样成 ~120 根，渲染两层柱子（底层暗 / 上层亮），上层用
`clip-path: inset(0 calc(100% - var(--dshm-played)) 0 0)` 按播放进度裁开 —— 进度经 CSS 变量传入，
拖动的 rAF 循环不必触发 React 重渲染。

新增第 31 套回归（`test-waveform.mjs`，16 条）：
客户端 A1–A7（取包络 / 两层柱子 / 高度跟随 / CSS 变量 / 换歌重取 / 静默降级 / 丢弃迟到结果）、
宿主 B0–B8（端点形状 / 包络忠实 / 分界在中点 / 缓存命中 / 改文件重算 / 未知曲目 / 非音频 / teardown）。

### 5.37.2 夹具与期望值是独立的

`scripts/fixtures/wave.flac`：前 4 秒静音 + 后 4 秒 440Hz（ffmpeg 生成，22.05kHz/8s，137KB）。
实测包络：前 1/4 平均 0.0000 / 后 1/4 平均 1.0000 / 边界两侧 0→1 —— 期望不是从实现里算出来的。

### 5.37.3 负向对照（四组，全部精确变红）

| 对照 | 结果 |
| --- | --- |
| 不按峰值归一化（按满刻度除） | B2/B3 红（后半 0.80） |
| 缓存永不失效（不看 size/mtime） | B5 红（cached=true） |
| 客户端不丢弃迟到结果 | A7 红（第一版恒绿，见下） |
| `dispose()` 不调用 `stopWaveform` | `test-audit` 静态接线检查 红（B8 仍绿 —— 如实记录） |

### 5.37.4 本轮第 5 次踩「断言看着强、其实不判别」

A7（快速连切丢弃迟到结果）第一版给两个请求同样的延迟：迟到的先写上、正确的后写上，
最终状态「看起来正确」⇒ 删掉守卫照样全绿。改成「先发的慢（200ms）、后发的快（10ms）」
之后才真正有判别力（无守卫 → 柱子变成上一首的 6% → 红）。

### 5.37.5 两个夹具/结构错误（都靠机械门禁发现）

1. 夹具只有 8 个峰值 ⇒ 客户端「400 桶 → 120 根」的抽样路径根本没被执行（断言恒真）。
   改成真实的 400 桶后，抽样与高度断言才落地。
2. 桶太粗：0.5s/桶时 8 秒夹具只有 4 个桶 —— 改成 0.25s/桶（短曲也有分辨率，内存仍 O(1)）。

### 5.37.6 验证

`typecheck` 0 · `ALL 31 SUITES PASS` · `check-build-fresh` 一致 · `check-strict` 通过 ·
`check-whitespace` PASS · `check:manifest` PASS（新增端点后重跑，指向 pinned 基线）·
route-consistency ALL PASS（新端点四处一致）· 工作区干净 · CI 绿。
波形的真实观感未验证（jsdom 没有布局/绘制能力，柱子的视觉效果只能人眼看）。

---

## 5.38 第 25 轮 —— 交叉淡化默认开启 + 一轮性能优化（用户实测反馈驱动）

### 5.38.1 用户的实测反馈（本轮的全部输入）

1. 噪声：开了交叉淡化后，切页面与切歌仍有电流声 —— 但用户判断「可能 DSH 这个平台就是这样」。
2. 均衡器：听起来还行，但耳机几乎听不出差别。
3. 要求：继续做一轮优化。

### 5.38.2 ① 交叉淡化翻转为默认开启（并同步门禁语义）

第 22 轮把它做成默认关闭，理由是「300ms 淡出是对设备瞬态的保险，而用户尚未确认噪声消失」。
现在用户确认换页面时也出现噪声 ⇒ 与平台/其它来源有关，不再是本插件的设备重协商，
那条「保险」理由不成立，而交叉淡化能实打实消掉切歌缝。故：默认开启，`?crossfade=0` /
`window.__dshMusicCrossfade = false` 显式关闭。

翻转默认值不是改一行：H1/H2 断言的是单元素淡出路径（只在 `?crossfade=0` 下成立），
所以 RG / 均衡器 / CORS 三个套件的启动一律显式固定 `?crossfade=0` 做隔离 —— 否则「默认值」
会变成每个套件的隐藏变量（本轮实测：不隔离时 RG 的 B3–B12 与图的 B1/B10 立刻红，
因为交叉淡化模式多了电平节点与第二个 media source）。
D 段改为两条：D0a 默认开启（对照：把默认改回去 → 立刻红）+ D0b 显式关闭仍可回旧路径。

### 5.38.3 ② 性能优化（可量化，写进了门禁）

| 优化 | 之前 | 之后 | 门禁 |
| --- | --- | --- | --- |
| 波形预取下一首 | 切歌时才请求 | 起播即预取（当前+下一首各一次） | A1 |
| 波形客户端有界缓存（30 条） | 3 次切歌 = 4 次请求 | 3 次切歌 = 2 次请求 | A5/A6 |
| 常驻底栏柱子 | 120 根（240 节点） | 60 根（120 节点）；全屏仍 120 根 | A2/A7 |

设计要点：预取与功能开关解耦（关掉交叉淡化也照预取，否则一个优化被另一个开关悄悄关掉）；
预取只填缓存、不动 UI（预取的包络绝不能写进 `state.wavePeaks`）。

### 5.38.4 ③ 均衡器按「入耳式真能重放的频段」重调

用户说听不出差别 —— 一部分是物理原因：小动圈对 31/62Hz 几乎没有输出，而原「低音增强」把
能量（+5/+4.5/+3.5dB）全堆在那里，结果是自动前级白白压低整体音量、却听不到低音。
本轮把曲线整体重排：低音落在 62–250Hz，其余预设也加大到 ±3~5dB 的可听幅度。

### 5.38.5 负向对照（四组，全部精确变红）

| 对照 | 结果 |
| --- | --- |
| 默认值改回「关闭」 | D0a 红 |
| 不做波形预取 | A1 红 |
| 客户端不查缓存 | A5/A6 红（请求数 2 → 4） |
| 底栏不减半 | A2/A3 红 |

### 5.38.6 `AGENTS.md` 预算：这次做了结构性外移（不再微调）

前两轮靠临时压缩，两度撞上 64 KiB 被静默截断（65,902 → 65,244）。本轮按 §11 的原文要求
把 §2.10–§2.12、§2.16–§2.17 的完整正文移到 [`docs/rules-detail.md`](rules-detail.md)，
AGENTS §2 只留结论 + 指针（规则编号与判定一条不少，细则可查）。
结果：62,358 B（95.2%，余量 3,178 B）。§7.1 的分层地图已登记这个新文档。

### 5.38.7 验证

`typecheck` 0 · `ALL 31 SUITES PASS` · `check-build-fresh` 一致 · `check-strict` 通过 ·
`check-whitespace` PASS · 工作区干净 · CI 绿。**听感与观感仍只能由用户确认**
（切歌缝是否消失、EQ 是否可闻）。

---

## 5.39 第 26 轮 —— 压掉剩余「一丝丝杂音」+ `AGENTS.md` 按 DSH 写法重写

### 5.39.1 用户反馈（本轮输入）

交叉淡化开启后电流声小了很多（功能确实有用），但「切换时仔细听还是有一丝丝杂音」；
「低音增强」现在能听出来；EQ 自定义频段滑条暂不做（留给以后）；并要求 `AGENTS.md`
参考 DeepSeek Harness 的 AGENTS.md 写法。

### 5.39.2 ① 杂音：找到两个在重叠期间产生不连续的地方

1. RG 增益瞬时跳变（主因）：交叉淡化时新旧两首同时出声，而 RG 节点是共享的 ——
   `applyReplayGain()` 用 `.value = X` 瞬时写值，等于在重叠中间给两首一起做了个阶跃。
   本机曲库的测量增益跨度可达十几 dB ⇒ 一声轻「嗒」。修法：按过渡时长斜坡
   （`setValueAtTime(当前值) → linearRampToValueAtTime(新值, now + 300ms)`）；顺序播放路径
   （旧曲已静音）保持瞬时写值——那里没有可听的不连续。
2. 交接时又拆一次媒体管线：`outEl.pause(); outEl.removeAttribute('src'); outEl.load()` ——
   设备侧因此看到两次事件（换源 + 拆除）而不是一次。修法：不清旧源，让它等下一次预取
   直接覆盖（交换后它就是空闲元素，紧接着会被 `schedulePrefetch` 换上下一首）。

### 5.39.3 门禁（D 段新增两条）+ 对照

| 断言 | 内容 | 对照 |
| --- | --- | --- |
| D5 | 交叉淡化时 RG 节点走 ramp（不是瞬时写值），且从当前值起算 | 改回瞬时写值 → 只红 D5 |
| D6 | 交接时不清旧元素的 `src`（`removeAttr src` 次数 = 0） | 恢复清旧源 → 只红 D6 |

### 5.39.4 本轮第 6 次踩「断言/对照本身不精确」（两条都改了）

1. D2 的角色可能被 RG 冒充：原断言只按「一条 ramp 到 0、另一条到 1」找节点 —— 新增的 RG 斜坡
   也满足这个形状，于是「两个电平节点重叠」可能测的是 RG + 电平。改成显式取两个
   `connectSource` 的目标（levelA / levelB）再断言。
2. 角色取自错误的作用域：D5/D2 的 `srcTargets` 第一版从 `tail`（play(1) 之后的日志）里取，
   而 `connectSource` 发生在起播时 ⇒ 两个角色都是 `undefined`，断言变成恒红，
   对照看起来也红 = 什么都没测。改成从整段日志取。

### 5.39.5 ② `AGENTS.md` 按 DeepSeek Harness 的写法重写（用户明确要求）

读了 `deepseek-harness/AGENTS.md`（17.4 KB）后提取其写法：**一条规则一到两句祈使句、理由压进
括号或外链、历史与实测放 `docs/notes/` 而不写在规则里、命令用 ```sh 块**。

- §2 的完整措辞与逐轮证据整体外移到 [`docs/rules-detail.md`](rules-detail.md)（42 KB，规则编号
  一条不少），`AGENTS.md` 只留结论 + 指针。
- 结果：62,358 B → 19,503 B（64 KiB 的 29.7%），且不再贴上限 —— 之前连续两轮撞预算被
  静默截断（65,902 → 65,244）的结构性原因被消除。
- 顺带把悬空的章节编号引用（`§2.15` / `§6`）改成「见 `docs/rules-detail.md`」与「见审计协议第 7 条」。

### 5.39.6 验证

`typecheck` 0 · `ALL 31 SUITES PASS` · `check-build-fresh` 一致 · `check-strict` 通过 ·
`check-whitespace` PASS · `AGENTS.md` 19,503 B。杂音是否彻底消失仍需用户耳朵确认（jsdom
没有音频设备）。

---

## 5.40 第 27 轮 —— 向开源播放器学「想不到的失败模式」（防御性编程）

### 5.40.1 方法

读高质量开源实现的源码（不是 README），逐条对照本插件，只登记实测过的差异。
参考：[feishin](https://github.com/jeffvli/feishin)（Electron + Web Audio）、
[navidrome](https://github.com/navidrome/navidrome)（`core/stream/limiter.go`、`token.go`）、
[fooyin](https://github.com/fooyin/fooyin)（已在 §2.18/§2.21 用过）、
[mutagen 的原子保存讨论](https://github.com/quodlibet/mutagen/issues/241)。
完整对照表与待办清单见 [`docs/defensive-audit.md`](defensive-audit.md)。

### 5.40.2 本轮落地 4 项（都有门禁 + 对照）

| # | 失败模式 | 来源 | 实现 | 对照 |
| --- | --- | --- | --- | --- |
| H1 | 快速连切时并发 spawn 波形 ffmpeg 打满 CPU | navidrome `TranscodeLimiter` | 并发闸门（上限 2），超额立即 `busy` 不排队 | 去掉闸门 → `ok=5 busy=0` 红（B9） |
| H2 | 交叉淡化的迟到交接在下一段过渡后才跑，会换错元素 | §2.10 同族 | `settlePending` + 新切歌即时结算 | 去掉 → D9a 红（D9b 仍绿，见下） |
| H3 | 源根本不可用仍烧 3 次徒劳尝试（400ms×3） | feishin `MediaError` 分派 | `MEDIA_ERR_SRC_NOT_SUPPORTED` 短路到「放弃 + 下一首」 | 短路失效 → D10 红 |
| H4 | 系统单方面挂起 ctx →「界面在放、耳机没声」，无从判断 | 本仓库独有症状 | `ctx.onstatechange` 自愈（按元素判断 + 只含状态诊断） | 处理器 no-op → D11 红 |

### 5.40.3 本轮第 7/8 次踩「断言或对照本身不判别」——四条，全部改强

1. D9 只查 pause 状态：去掉守卫时迟到的交接把角色换到另一首，pause 状态看起来一样正常 ⇒ 恒绿。
   改成断言正在放的是最后一首（src 含 `p=c.mp3`）。
2. D9 证明不了守卫的必要性：现有时长配置下迟到交接恰好落在 `startNow` 赋 src 之前，
   最终状态碰巧也对（D9b 在对照下仍绿）。⇒ 拆出 D9a（150ms 时刻角色就该换好 = 即时结算）
   才有判别力，并把 D9b 的标签改成「最终状态一致（回归保护）」——不谎称它证明了必要性。
3. D10 测到了别的分支：夹具 src 含 `system-stream` ⇒ 先命中「token 基址自愈」那条分支，
   它一定会重新 attachSource。改成把 src 换成普通流地址，并等 500ms（小于「放弃后 600ms
   自动下一首」）才测到真正的行为。
4. D11 只看「有没有 resume」：起播路径本身就会 resume 一次 ⇒ no-op 处理器照样绿。
   改成比增量（+1）。顺带发现实现缺陷：判据用 `state.playing`（UI 标志会滞后，夹具里
   永远是 false）⇒ 改用媒体元素（元素仍在放）作权威判据。

### 5.40.4 一个更危险的坑：对照在旧产物上跑

有两轮对照「没变红」，原因不是断言弱，而是 `tsc` 构建失败：把变异写成「删掉调用」会让
`noUnusedLocals` 报错 ⇒ `lib/` 没更新 ⇒ 对照跑的是修好的旧产物。而我当时把 `tsc` 输出
重定向到了 `/dev/null`，错误被完全掩盖。
⇒ 新增纪律：**对照前必须确认构建成功**（保留输出、非零退出即判「对照无效」），并且变异要
保留标识符的引用（`void f;`）以免被死代码开关挡住。

### 5.40.5 核查后确认已经做了的（避免重复造轮子）

媒体错误恢复链（比 feishin 更强：token 自愈 → 原位置重试 → 跳坏区 → 放弃 + 自动下一首，带上限）、
MediaSession（`setPositionState` + play/pause/prev/next/seekto）、跨源 `crossOrigin`,
缓存按 `size`+`mtimeMs` 失效。

### 5.40.6 待办（已取证、本轮未改，按风险排序）

① 标签写入/改名的原子性与回滚（不可逆操作，参考 mutagen 的讨论；本轮未逐行核实那段流程）；
② 大小写不敏感文件系统（APFS）上的改名碰撞；③ Unicode NFD/NFC 覆盖范围（实测各 1 处 `normalize(`）；
④ 磁盘满/只读文件系统（与 `A5-09` 同族）；⑤ 客户端 seek 风暴下的并发 Range 上限（H1 只覆盖波形）；
⑥ `stalled`/`waiting` 的缓冲反馈。明确不做：页面隐藏时停 rAF（Chromium 本就节流且循环随视图卸载）。

### 5.40.7 验证

`typecheck` 0 · `ALL 31 SUITES PASS`（连跑 3 次稳定）· `check-build-fresh` 一致 ·
`check-strict` 通过 · `check-whitespace` PASS。听感仍需用户确认。

---

## 5.41 第 28 轮 —— 去 AI 味（按 dsh-anti-slop-kit 的判据）

### 5.41.1 判据来源

`dsh-anti-slop-kit` 及其指向的 `dsh-prose-standard`、`dsh-trim-cot-leakage`，加上 kit 内
`standards/docs-AGENTS.md` 的 slop checklist 与 Wordcount Budgets。核心判据：AI 味来自三个未受约束的
默认值 —— 话多、交代推导过程、换地方重复同一件事；HEAD 处的读者在不看任何会话记录的前提下能否
解析每个引用、验证每个断言。

### 5.41.2 审计（只读先行，探针自带正/负样本校准）

| 类别 | 命中 |
| --- | --- |
| 死的会话引用（`第 N 轮` / 审计编号 / 已失效的内部 `§2.x`） | 台账 102+192、`rules-detail` 34+30、`gates` 15+32、`src/client.ts` 23、`src/host.ts` 10+12 |
| 变更叙事（不再 / 原本 / 第一版） | client 11、test-audio-graph 7、test-waveform 5 |
| 强调膨胀（`**`） | 台账 1905、`rules-detail` 734、client 521、host 250、gates 146、AGENTS 214 |

`§2.x` 是已经失效的引用：AGENTS 在上一轮改成 DSH 写法后不再有编号小节，所以代码与文档里的
`§2.20` 全指向不存在的位置 —— 这正是「HEAD 处解析不了」的教科书例子。

### 5.41.3 本轮落地

1. 两道机器闸门（kit 推荐的第 1、3、5 步）：
   - `scripts/check-prose.mjs`：四条探针（会话引用 / 变更叙事 / 评审编排 / 状态注解），**每条自带
     正样本与近失负样本**，探针不判别就拒绝运行（`exit 2`）；计数按 `scripts/prose-baseline.json`
     只许下降。豁免面各带理由：台账是历史层、`lib/` 是产物、探针文件本身必须包含被猎的词。
   - `scripts/doc-budgets.mjs` + `scripts/doc-budgets.manifest.json`：字数（CJK 字符 + 拉丁词，围栏
     代码不计）与强调标记双上限；上限取「实测 / 0.95」，即留 ≥5% 余量。超限顺序：先搬家 → 再压缩
     → 最后才允许上调并论证。两者已接进 `npm test` 与 CI。
2. 探针校准抓到两处误报：`已完成` 出现在契约句「失败不得报告为已完成」里、`负向对照` 是本仓库
   的必备实践术语 —— 都移出模式并写进近失负样本（误报的探针比没有探针更坏）。
3. 文档清理：纯引用型括号（`（第 N 轮…）`/`（对照⑬…）`/`（§2.x…）`）与状态印记删除；失效的
   内部 `§` 引用改成指向真实文档；强调按「只给改变行为的措辞」收敛（去标记 1602 处、保留 149 处）。
4. 搬家：AGENTS 的「已知陷阱」明细移进本文档（AGENTS 留 6 条 + 链接），腾出空间给新的写作规则节。
5. 棘轮基线 352 → 247。

### 5.41.4 回退：机械清理源码注释把宿主改坏了（本轮最贵的教训）

同一套机械替换也跑在 `src/*.ts` 上，结果把一处 `/** … */` 的界定符改成了 `/ `，于是宿主在构造
正则时抛 `Invalid regular expression: … Nothing to repeat` —— 28/31 套回归失败。已用
`git show HEAD:src/host.ts > src/host.ts` 整文件回退（不用 `git checkout <路径>`：那会连未提交的
真改动一起回滚），重建后 31/31 通过。
教训：正则在注释上跑不可靠；跨行 JSDoc 的界定符与语义是耦合的，行级替换无法安全处理文本与
代码的边界。源码注释的清理因此降级为待办：必须逐句人工改，且每改一处都要验界定符完好 + 跑全量
套件。棘轮基线相应地回升到 247，并在 `scripts/prose-baseline.note.md` 里写明原因。

残留（棘轮兜着，不会倒退）：247 处集中在 `src/client.ts`（48）与测试注释，以及需要逐句重写才能保义
的嵌入型引用（如"与某条规则「…」同族"）。机械替换会把这类句子改坏（实测产出过
`（AGENTS.md （见 AGENTS.md）。`），所以留给人工。

### 5.41.5 验证

`typecheck` 0 · `ALL 31 SUITES PASS` · `check-build-fresh` 一致 · `check-strict` 通过 ·
`check-whitespace` PASS · `check-prose` PASS（247/247，含回退后的基线重设）· `doc-budgets` PASS（8 个文件全部留 ≥5%）。

---

## 5.42 第 31 轮 —— 修复「补全改不了已有封面的歌」

### 5.42.1 根因（实测，非推断）

宿主与 worker 早就支持按调用方要求替换封面（`/api/apply` 读 `body.replaceCover === true`，
worker 据此决定是否覆盖 `tag.pictures`），但客户端从来没有发送过这个字段 —— `grep replaceCover src/client.ts`
零命中。于是：已有内嵌封面的文件无论怎么应用补全，写回时都保留原封面；用户看到的现象就是
「有封面的歌改不了」。

### 5.42.2 修法（把用户意图如实传下去）

- 逐首应用：对话框新增「替换已有封面」复选框，默认勾选（用户已经看着候选封面主动点选）；
  取消勾选则 `replaceCover:false`。候选没有封面时一律 `false`（没有可替换的东西）。
- 一键补全：确认条新增「覆盖已有封面」开关，默认关闭（批量替换是破坏性的）；
  勾选后请求一律带 `replaceCover:true`，并且不再把「标签与文件名都已正确」的歌当成无需处理
  —— 封面正是要写的东西，否则这类歌在批量里永远轮不到。
- 确认文案（中英）同步改成与真实行为一致（原先承诺「已有封面不会被覆盖」，而勾选项存在后必须说清）。

### 5.42.3 门禁（新增第 32 套 `scripts/test-cover-replace.mjs`，8 条断言）

| 断言 | 内容 |
| --- | --- |
| A1/A2 | 手动对话框有开关且默认勾选；候选带封面时请求带 `replaceCover:true` |
| B1 | 取消勾选后请求为 `false`（两个方向都断言，接线成恒 true 会红） |
| C1 | 候选没有封面时为 `false` |
| D1/D2 | 一键补全默认一律 `false`，且标签+文件名都已正确的歌被跳过 |
| E1/E2 | 勾选后一律 `true`，且上述「已正确」的歌也轮到 |

负向对照（四组，全部精确变红）：请求字段缺失 → A2/B1/C1 或 D1/E1 红；去掉跳过例外 → E1/E2 红
（批量变空）；复选框恒 true → 只红 B1。两次对照的变异让 `noUnusedLocals` 报错导致构建失败，
按纪律判为对照无效并改成保留引用的变异后重做。

### 5.42.4 顺带被既有门禁抓住的两处回归

1. `test-client-shell` 的断言守的是「确认条的复选框只能是破坏性转换项」——新开关用了 `.dshm-check`
   撞名。不改既有断言（那会削弱它），改为新类名 `.dshm-coverToggle` + 一条真实 CSS 规则。
2. `test-audit`「JS 用到的类必须有 CSS 规则」直接抓出未定义类名 —— 与上一条同一处修复。

### 5.42.5 验证

`typecheck` 0 · `ALL 32 SUITES PASS`（含新套件）· `check-build-fresh` 一致 · `check-strict` 通过 ·
`check-whitespace` PASS · `check-prose` PASS（247）· `doc-budgets` PASS。
真实文件的封面替换结果仍需用户确认（夹具只验请求契约与宿主既有行为；宿主侧覆盖行为由
`test-apply` 独立覆盖）。

---

## 5.43 收口失误：把「预算门禁红」的状态推上去了

第 31 轮提交 `6019070` 推送时 `doc-budgets` 已红（`docs/gates.md` 1952 > 1944 词），成因是我把门禁
输出用 `cut` 截断后只看了前半行就当通过。修复：按标准先压缩（新增的封面替换行从 ~250 词压到
~110 词，保留全部判别性事实），`npm test` 全绿后再推一次。
纪律补强：**门禁输出不得截断着读**；每条门禁的结论以退出码为准（`npm test` 的退出码），不以肉眼前缀为准。

---

## 5.44 第 32 轮 —— MV 偶尔没声音（刷新才好）+ 借用独立审计补 MV 缺口

### 5.44.1 用户反馈

「有时候播放 MV 歌曲时会无声音，刷新之后就有声音了」。这条症状给了两个方向：刷新能修好
说明是页面内可变状态（不是文件/编码本身不能播）；而 `mvPlan` 的静态判定又能让「本就不能播的
音轨」走直出。两者各查一遍，不互相替代。

### 5.44.2 客户端根因（三条，都能在夹具里复现）

1. 跨代复用已立闸门的实例：player 挂在 `window.__dshMusicPlayer` 上跨 activation 复用，
   而 `halt()` 把 `disposed` 置成终态且不复位。下一代拿到同一份实例后，起播回调里的
   `if (!disposed) rampVolume(state.volume, …)` 被跳过 ⇒ 增益停在 `stopAudio()` 留下的 0。
   对照实测的失败细节就是静音签名：音量节点被写两次 0、从未 ramp 到用户音量。
2. 只在 `startNow` 里 resume 设备：`toggle()`（暂停→播放）与交叉淡化进入都不 resume；
   而 `onstatechange` 只在状态变化时触发 —— 系统在暂停期间挂起 ctx 之后，按播放就是
   「界面在放、耳机没声」，且没有任何自愈路径。
3. 瞬时音量从元素音量读：建图之后元素音量恒为中性 1，于是每一首起播都先跳到满幅再淡到
   用户值（用户音量 40% 时是实打实的爆音）。对照实测：`value:1` + `setValue:1`。

### 5.44.3 修法（架构层）

设备与代际分离：`AudioContext` + 增益/均衡链 + CORS 探测结果搬进页级设备（`Symbol.for` 挂
`window`，跨 bundle 重求值存活）；媒体元素、每元素电平节点与监听仍归本代。`halt()` 变成一次真正
的释放：停两个元素、disconnect 本代节点、移除自建 DOM（`.dshm-mvPark` 与 `<video>`）、撤
`device.watcher`、只 suspend 设备、摘掉 window 键；`takePlayer()` 只接管未释放的实例，
否则新建。`acquire()/lease()` 是比较并释放的租约：热重载的旧 disposer 晚于新 bundle 求值时
不得停掉新一代。播放起点统一 `resumeGraph()`；瞬时音量统一 `readVolume()`。

### 5.44.4 MV 侧：独立审计取证 + 修法

独立子代理只读取证（真实 ffmpeg + ffprobe 夹具，`/tmp` 内）报了 11 条，与本轮相关的 5 条：

| 审计条 | 证据 | 修法 |
| --- | --- | --- |
| `file:line` `mvPlan` 对 `.mkv` 豁免音轨判定 | 实测 `h264+dts` 的 mkv → `mode:"direct"`，同编码 `.mov` → `transcode` | 去掉容器豁免；音轨编码不在直出名单里一律 `remux` |
| 未识别编码被吞成 `null` | 实测 `truehd`/`wmav2`/`prores` 都映射不到 → 判定被整段跳过 | `recognizeCodec()`：认不出就原样保留小写名（`null` 只表示「没有这条轨」） |
| 无音轨看门狗 | 客户端零命中 `webkitAudioDecodedByteCount` | 新增 `guardAudioTrack()`：已知有音轨却 3.5s 零解码字节 → 升级转码 |
| 档位只换壳 | `copy` 档把原音轨原样搬进 MP4，Chromium 照旧解不了 | 音轨已知解不了时档位从 `audio` 起 |
| 停用后仍会再起 ffmpeg | 旧夹具用 `sh` + `sleep`，`close` 永不到达 ⇒ 该路径恒绿 | `job.cancelled` + 档位循环前后双闸门；夹具改 `exec sleep` |

另修：MV 单档超时（30min，原来卡住就永久 `preparing`，UI 没有出口）；`/api/mvconvert` 失败清理
的授权面写成缓存目录（403 被吞 ⇒ 半成品留在音乐目录被扫成曲目）；ffprobe 探测从
music-metadata 的 `try` 里搬出来（avi/ts 恰恰在那一步抛错，探测永远跑不到）。

### 5.44.5 门禁（新增 2 套，31 → 33）与负向对照

- `scripts/test-client-activation.mjs`（21 条）：释放面（window 键、自建 DOM）、设备页级 +
  租约、**停用→再 activation 与热重载之后起播必须出声**、`toggle()` 唤醒被挂起的设备、
  换歌不跳到满幅。
- `scripts/test-mv-jobs.mjs`（8 条；无 ffmpeg 时后半段显式 skipped）：payload 下发 `audioCodec`、mkv 不豁免音轨判定（真实
  `h264+mp2` 夹具）、真实音轨转码成功、失败缓存与 `retry=1` 的语义。
- `scripts/test-mv-client.mjs`（7 条）：direct 档必须挂 token 绝对地址、音轨看门狗（正/反向）、
  升级预算每次播放各一份、WASM 旁路的音轨前提（静态，jsdom 跑不了动态 `import()`）。
- 扩写 `scripts/test-mv-teardown.mjs`：一共只许起过一个 ffmpeg（原断言只查第一个 PID）。

| 对照（逐条回退） | 实测变红 |
| --- | --- |
| 复用已释放实例 + 不摘 window 键（旧行为） | B1/C1/C3/D1/D2/E3；C3/D2 的细节正是静音签名（音量节点两次写 0、从未 ramp） |
| 设备不跨代（`Symbol()`） | D3（`ctxs=2`） |
| `toggle()` 不 resume | F1 |
| 瞬时音量读元素音量 | G1（`value:1` + `setValue:1`） |
| 音轨看门狗失效 | B1/B2/D1 |
| 换歌不复位升级预算 | D1（`asks=1`） |
| `mvPlan` 恢复 mkv 豁免 + 档位恢复 `copy` | A3（实测 `{"mode":"direct","audioCodec":"mp2"}`）/A4/B1 |
| 只撤 `retry=1` | B3（`state=failed`，spawn 不变 = 空操作） |
| 去掉 `job.cancelled` | 「只起过一个 ffmpeg」红（`spawns=2`） |
| direct 用宿主相对地址 | A1/A2（`/api/dsh-music/stream?...`） |
| WASM 不检查音轨 | E1（`gated=false`） |

### 5.44.6 验证与未修登记

`typecheck` 0 · `check-strict` · `check-build-fresh` · `check-whitespace` · `check-prose` ·
`doc-budgets` 全绿；`npm test` 33 套全绿；听感仍需用户确认（jsdom 没有音频设备）。

未修（本轮已取证，按风险排序）：① `/api/mvconvert` 用 `spawnSync` 阻塞宿主最长 30 分钟
（客户端当前不调用该端点）；② MV 缓存目录无清理，`os.tmpdir()` 里的转码产物只增不减；
③ 自动升级（画面看门狗 / error 升级）不带 `retry=1`（有意保留：不在用户没要求时反复跑重活），
失败缓存已存在时它们会立刻拿到那条记录并报失败；④ `retry=1` 清不掉已存在的缓存文件
（`existsSync` 在 map 检查之前短路），需要改源文件 mtime 或手删；⑤ WASM 旁路的 libav 版本路径
在客户端硬编码，依赖升级后只会静默降级到转码；⑥ `/api/mvlib` 与 WASM 旁路仍无行为门禁。

### 5.44.7 预算调整（按「先搬家 → 再压缩 → 才上调」的顺序）

两条新规则正文只能进 `docs/rules-detail.md`（`AGENTS.md` 只留结论 + 指针），两条门禁行只能进
`docs/gates.md`（逐条门禁表），都不存在可搬去的层级。压缩三轮后仍差 117 与 17 词，故上调：
`docs/rules-detail.md` 9064 → 9400（实测 9181，余量 ≥2%），`docs/gates.md` 1944 → 2230
（实测 2037）。明细证据不进这两份文档，留在本轮台账 §5.44.5 与套件头注释里。

本轮命令按 `AGENTS.md` 的写法执行时，`pnpm run typecheck` 触发了 pnpm 的依赖自检安装并在
`ERR_PNPM_IGNORED_BUILDS` 处失败（与本次改动无关的环境问题）；改用等价命令
`node scripts/typecheck-ratchet.mjs` 与 `./node_modules/.bin/tsc -p tsconfig.json`。

### 5.44.8 第一次推送 CI 红：新断言依赖了本机才有的 ffmpeg 夹具

`ed6d1ac` 推送后 CI 在 `test-mv.mjs` 红：新增的「avi（mpeg4）应判 transcode」只在「生成了真实夹具」时成立；CI 没有 ffmpeg，夹具是占位文件、编码全是 `null`，于是 avi 按容器保守判 `remux`。

修法：把判据拆成两层 —— 与夹具无关的那条（avi/ts 绝不允许 direct，容器 Chromium 解不开）
两种环境都断言；编码级判定放进 `if (generated)`，否则显式 `skipped`（跳过必须能与通过区分）。
本地用一份临时把 `FFMPEG` 置 null 的拷贝复现了 CI 分支并通过，临时文件已删。

教训：新断言依赖「本机装了某个工具」时，必须同时跑一遍「没有那个工具」的分支；CI 就是那个分支。

### 5.44.9 用户听感确认（第 32 轮收口）

用户戴耳机实测：「听不出来残留爆音」。这一半 jsdom 断言覆盖不到 —— §5.44.5 的负向对照只证明机制
（换歌不跳到满幅、起播必有 ramp、设备被挂起必被唤醒、停用后新一代仍出声），听感由用户确认。

仍属未验证：MV「偶尔没声音」的原始症状要靠时间积累才能证伪（触发条件是宿主热重载或系统在暂停期间
挂起 ctx）。套件覆盖的是它的机制面；若再次遇到，控制台会留下 `AudioContext state=suspended → 恢复输出`
或 `常驻音频图已启用：sampleRate=… state=…` 这两行只含状态的诊断。

---

## 5.44 第 32 轮 —— 标签写入原子化（面向「给所有人用」的第一道加固）

### 5.44.1 起因与取证

准备把插件投给插件市场（awesome-dsh-plugin）时，先按「别人装上会不会被弄坏数据」自查。
实测结论：`node-taglib-sharp@6.0.3` 的 `File.save()` 是就地改写 —— `dist/stream.js:41` 用
`fs.openSync(path, "r+")` 打开原文件、`:110` 用 `fs.writeSync` 往里写；整个库里没有临时文件、
没有 `rename`、没有备份，我们也没有写后回读。写入过程中被杀 / 断电 / 磁盘满都会在原文件上留下
半个标签甚至损坏的音频流 —— 而这是本插件**唯一**会碰用户原始文件的动作。

### 5.44.2 修法：副本替换（原件全程不变）

`writeTagsAtomic`：① `copyFile` 出同目录隐藏副本（同文件系统 ⇒ rename 原子，点开头 ⇒ 扫描器跳过）；
② 在副本上写（仍走 worker，失败退回进程内）；③ 回读校验（标题/歌手/专辑 + 写入封面时图片存在）；
④ 校验通过才 `fs.rename` 替换原件。任何一步失败都 `tagged:false`（失败不得报成成功）、清掉副本、原件不动。
每一步 fs 操作都过 `authorize('fs.write', …, [lib.dir])`。另加崩溃残留清理：超过 1 小时的同前缀副本在
下次写入前清掉。

### 5.44.3 门禁与对照（`test-apply.mjs` 新增 4 条）

| 断言 | 内容 |
| --- | --- |
| A | 成功写入后目录里不留 `.dshm-tagwrite-*` 副本 |
| B | 目录改为不可写（建不出副本）时报失败：`tagged:false` + warning |
| C | 同场景下原件字节不变（sha256 比对）且标签仍是旧值 |
| D | 失败后同样不留副本 |

负向对照（退回就地写入）：B 变成 `tagged:true`、C 变成 `hash=CHANGED title=Nope Title`
—— 同一场景下旧实现默默改写了用户文件并报成功。这正是这条加固要消除的风险。

### 5.44.4 上线前的其余准备（本轮一并做掉）

- 收录硬门槛：给仓库加 `dsh-plugin` topic（原先 `topics: []`，不加会被 CI 直接打回）。
- 包名从 `@local/dsh-music-player` 改为 `@heshuren/dsh-music-player` —— npm 上 `dsh-music-player`
  已被 `kendu76/dsh-music-player`（另一作者）占用，用独立作用域避免混淆；`cordis.patch.yml`、README、
  `repository`/`bugs`/`homepage` 同步更新。
- 两个开发脚本里硬编码的作者绝对路径改为必填 `DSH_MUSIC_DIR`（原先默认 `/Users/heshuren/…`）。
- 新增 `screenshots.json`（市场详情页用，相对路径指向 `docs/images/` 内已有截图）。
- 文档预算：AGENTS 被注入块与新增规则顶超上限 ⇒ 按标准先搬家——五份上游平台标准的正文移入
  `docs/rules-detail.md`，GraphFlow 的 MCP 配置移到 `docs/graphflow.md`，AGENTS 只留摘要与链接。

### 5.44.5 验证

`typecheck` 0 · `ALL 35 SUITES PASS` · `check-build-fresh` 一致 · 严格/空白/会话视角痕迹/文档预算
四道门禁退出码全 0。

## 5.45 又一次把红门禁推上去了（第 32 轮内）

提交 `093ec33` 推送时 `doc-budgets` 已经红了（台账粗体 63 > 53）—— 与 §5.43 同一类失误：我在
同一条命令里先跑门禁、再提交推送，但只看了 `check-prose` 的退出码（0），把紧随其后的
`doc-budgets` 的 1 当成噪声放过了。修复：台账强调按「只给改变行为的措辞加粗」收敛（63 → 43），
并按其 0.95 留出余量；`npm test` 退出码 0 后重推。
纪律补强（写进检查清单）：每条门禁的退出码都要单独确认；在一次命令里串多个门禁时，
任一非零就必须停下来，不得凭「前一条绿了」继续。

## 5.46 第 33 轮 —— MV 转码缓存持久化（「转过一次就不再转」）

### 5.46.1 用户症状与根因

用户反馈：以前转过的 MV 下次播放要重新转一遍。根因一行代码：`MV_CACHE_DIR` 是
`path.join(os.tmpdir(), 'dsh-music-mv')` —— 系统会清理临时目录，于是缓存键（路径+大小+mtime+模式）
虽然正确，产物却先消失了。同一目录下 `mvconvert`（用户主动转格式）的产物落在音乐目录里，
不受影响；受影响的是自动播放时的转封装/转码。

### 5.46.2 改法

- 目录改为插件数据区 `$DSH_HOME/storages/dsh-music-mv`（惰性取路径：`STATE_DIR` 在文件后面才定义）。
- 持久化就必须有界：条目数 ≤ 24、总字节 ≤ 4 GiB；按 mtime 从旧到新淘汰，`keep` 保护本次产物；
  命中时 `utimes` 把 mtime 推新，于是淘汰表现为 LRU（否则常播的会被新转的挤掉）。
- `.part` 半成品只清超过一次尝试超时（10 分钟）的：清扫是 `void` 异步发起的，无条件删会把正在
  写入的那个删掉，ffmpeg 随即失败 —— 这正是本轮我自己引入、被既有 `test-mv` 抓到并修掉的竞态。
- `deleteOriginal` 的回收站改为平台感知：macOS `~/.Trash`、Linux XDG `~/.local/share/Trash/files`，
  Windows 没有可移植回收站 ⇒ 保留原件并在响应里返回 `trashError`，不再在用户家目录凭空建 `.Trash`。

### 5.46.3 门禁（`test-mv.mjs` 新增 5 条，全部不依赖 ffmpeg）

| 断言 | 内容 |
| --- | --- |
| A | 缓存目录 == `$DSH_HOME/storages/dsh-music-mv`（且不是裸临时目录） |
| B | 预置产物被直接以 `ready` 命中（不再重转） |
| C | `/mvfile` 返回的字节与预置产物完全一致 |
| D | 预置 30 个旧条目后仍 ≤ 24，且刚命中的那份保留 |
| E | 过期 `.part` 被清、新写的 `.part` 保留 |

负向对照（三组全红）：缓存退回系统临时目录 → A/B/C/D 红；去掉淘汰 → D/E 红；`.part` 无条件删 →
B 之外连真实 ffmpeg 转码那条也红（竞态复现）。

### 5.46.4 验证

`typecheck` 0 · `ALL 35 SUITES PASS` · `check-build-fresh` 一致 · 空白/会话视角痕迹/文档预算三闸退出码 0。

## 5.47 本轮的两个「门禁自身」修正

1. 静态审计的凭据窗口误报：`test-audit` 用「写调用起始 + 400 字符」判断凭据是否进写盘，
   而 MV 缓存淘汰那段的窗口正好落到相邻函数的注释「进程级的 token 仓库」上 ⇒ 误报。
   修法是让窗口忽略注释，且必须同长度遮蔽（先替换再切片对「结尾在窗口外」的块注释无效，
   该写法实测误报仍在）。正向对照：故意把 `req.url` 写进 `fs.rm` ⇒ 审计立刻报红（没被削弱）。
2. `.part` 清除的竞态（见 §5.46.2）：无条件删半成品会把正在写入的那个删掉，ffmpeg 随即失败；
   改为只清超过一次尝试超时的。既有 `test-mv` 抓到了它，对照把它复现成「真实转码失败」。

## 5.48 包名改名引发的启动失败（DSH 重启后插件未激活）

### 5.48.1 现象与根因

DSH 重启后 web 端插件未激活（boot 图里那条 entry 注册不上）。根因：第 32 轮把包名从
`@local/dsh-music-player` 改成 `@heshuren/dsh-music-player` 时，`package.json` 与
`cordis.patch.yml` 都同步了，漏了客户端 bundle 的注册 id（`window.__ModuleLoader__.load({ id })`）。

宿主契约（在 DSH 检出里核实，不是推断）：`packages/client/modules/lib/index.js:884` 用
包名建 boot 图行（`graphRow(packageName, rev, source.meta)`），而
`packages/client/modules/lib/client.js:744` 按 `__ModuleLoader__.load` 传进来的 id 查
`factories`；查不到就抛 `bundle ... loaded without registering "<id>"`。两处必须逐字相等。

### 5.48.2 改了什么

| 面 | 改动 |
| --- | --- |
| 注册 id | `src/client.ts` 的 `id` 与 `lib/client.js` 产物改为新包名（本目录已改） |
| 门禁（身份三向一致） | `test-route-consistency` 新增：`package.json name == cordis.patch.yml name == __ModuleLoader__ id` |
| 门禁（旧 id 不得残留） | 同一套件新增：`src/`、`lib/`、`scripts/` 里不得出现旧名字面量（本轮实测的第二种漏改就是它） |
| 样式表 id 与套件选择器 | `dataset.plugin` 改名；`test-client-shell` 的三处 `style[data-plugin=…]` 改为从 package.json 读（硬编码字面量正是漏改的来源） |
| 兼容范围 | `dsh.compatibility.dsh` 原来写 `>=0.1.6-alpha.1 <0.2.0`，当前 DSH 0.2.x 被排除在外 ⇒ 补 `\|\| >=0.2.0-0 <0.3.0-0` |
| 本机 profile | `~/.dsh/profiles/{web,desktop}/package.json` 的依赖键与 `dsh.profile.bundles` 由旧名改为新名；`pnpm install` 重建链接与锁文件；清掉 pnpm 留下的旧名陈旧软链（删除前确认软链目标就是本仓库） |

### 5.48.3 验证链

1. 宿主契约：`index.js:884`（行 id = 包名）与 `client.js:744`（按 id 查 factories）—— 读源码核实。
2. 身份一致：新门禁 PASS；负向对照把注册 id 改回旧名 → 立刻红。
3. 旧名残留：新门禁 PASS；负向对照把 `dataset.plugin` 改回旧名 → 红灯并列出 `src/client.ts, lib/client.js`。
4. 宿主侧真实解析：`dsh --profile web --dump-config` 输出
   `- id: music-player / name: '@heshuren/dsh-music-player' / disabled: false` —— 与注册 id 一致。
5. `dsh plugin --profile web ls` 显示 `@heshuren/dsh-music-player@link:…`。
6. 未验证：浏览器里真正挂载完成（boot 端点 401 需要会话 token，无法从命令行取；这一步要用户重启 DSH 后确认）。

### 5.48.4 教训

改身份（包名/id）时要一次收敛：注册 id、cordis patch、样式表 id、测试选择器、profile 依赖与
bundles、兼容声明。本轮把其中三处做成了机械门禁（身份三向一致、旧 id 不得残留、套件从
package.json 读 id），其余靠清单核对。另外：改名后**必须**跑一次 `--dump-config` 看宿主的真实解析结果。

## 5.49 用户确认：重启后「音乐」标签正常（§5.48.3 第 6 条结案）

§5.48.3 的第 6 条原本是「未验证：浏览器里真正挂载完成」。用户重启 DSH 后确认「音乐」标签仍在、
插件正常工作 —— 该条从未验证转为已验证，第 48 节的两处修复（身份三向一致 + 本机 profile
按新名依赖/bundles）都被端到端走通。

结论：改名后「宿主的 boot 行 id（包名）」与「客户端注册 id」必须一致，**且 profile 的依赖键与
bundles 也必须用新名** —— 缺任何一处都表现为「插件未激活」。发布检查清单因此固定为两条机械动作：
跑 `test-route-consistency`（两条新门禁）+ 跑一次 `dsh --profile <p> --dump-config` 看宿主实际解析出的
`name` 与 `disabled`。
