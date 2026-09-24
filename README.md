# dsh-music-player

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的本地音乐播放器插件，**Web 与 DSH Desktop 双端同一份包**。在会话视图标签环（对话 / 轨迹 / …）中注册「音乐」标签页，UI 参考 macOS 自带 Music 应用。

A local music player plugin for DeepSeek Harness — **one package for both the Web GUI and DSH Desktop**. It adds a **音乐 (Music)** tab to the conversation view ring, styled after the macOS Music app.

## 功能 / Features

- 📁 选择本地目录（原生目录选择器，**macOS / Windows / Linux 均支持**；也可点标题栏 ⌨ 按钮手动粘贴路径，如 `D:\Music` 或 `~/Music`），递归扫描常见音频格式：**flac / mp3 / m4a / aac / ogg / opus / wav**
- 🚫 **Apple 离线包（`.movpkg`）**：这是 FairPlay（SAMPLE-AES + `skd://`）加密的 HLS 包，**任何第三方播放器都无法解密**（浏览器、ffmpeg 都不行），只能在 Apple Music / Apple TV 应用内播放。扫描时会整体跳过、不进入其数据目录，并在统计里显示「N 个 DRM 加密包已跳过」说明原因
- 🎵 列表展示：歌曲名、歌手（内嵌标签解析，缺省回退「歌手 - 歌名」文件名约定）、时长
- ✨ **在线补全元数据（多源）**：每行「✦」打开搜索弹层（自动带出「歌名 + 歌手」，可手动改词重查）。宿主并行查 **QQ 音乐 + iTunes(TW) + 网易云**，主力置信不足时用 **MusicBrainz** 兜底；候选按「标题相似度 55% + 歌手相似度 30% + 时长一致性 15%」打分（缺项自动重分配权重），叠加多源印证、曲库排序、Live/翻唱/DJ 版惩罚；简繁歌手（周杰伦/周杰倫）自动归并，文件名序号（`01. ` / `[01]` / `1.`）与「(Live)」等噪声在搜索前清洗。每条候选显示来源与置信度
- 💾 **写回文件**：默认勾选「写入标签并重命名文件」——标签写回音频文件（mp3/flac/m4a/wav…，基于 node-taglib-sharp）并按「歌手 - 原名.扩展名」重命名；取消勾选则只改应用内显示。**封面只补缺失、绝不覆盖文件里已有的封面**（需要替换须显式传 `replaceCover`），且只把 jpeg/png 写进文件（webp/avif/bmp 仅用于显示，避免写坏封面块）；补缺时取高清规格（iTunes 600px / QQ 500px / CAA 1200px），不会写 300px 缩略图。封面经宿主代理缓存（QQ/iTunes/网易云/CAA 白名单，逐跳校验重定向）；暂不做歌词
- ✦ **一键补全全部**：表头只有一个「✦」按钮，逐首检查**全部歌曲**（逐首限速、进度可见、可随时停止）。判定规则：**标签与文件名都已规范**才跳过（文件名不规范也会重命名）；**高置信度且与现状有差异**才写标签/重命名；时长差 >10s 时只有标题与歌手都强匹配（且本地有歌手）才放行——同一首歌的不同版本；歌手未知时证据不足，一律跳过。执行前先弹确认条
- 🔁 播放模式：单曲循环 / 列表循环（无随机播放、无歌词页——刻意保持简单）
- 🔀 列头排序：歌名 / 歌手 / 时长，升降序切换，刷新后记忆；**播放顺序 = 可见列表顺序**（排序/搜索后，「下一首」就是你看到的下一行）
- ➖ 行首删除：每首歌最前面的「−」按钮，点击后弹确认框，同意后**同时删除本地文件（永久删除，不可恢复）**
- 🔍 搜索过滤：歌名 / 歌手 / 文件名，n/N 计数
- 🖼️ 专辑封面：底部播放条缩略图（内嵌封面提取，无封面回退音符图标）
- 🎛️ MediaSession：系统媒体键（播放/暂停/上一首/下一首/seek）、macOS 控制中心 / 锁屏「正在播放」显示歌名/歌手/封面（artwork 用绝对 URL，MediaRemote 才抓得到；`setPositionState` 上报可拖动进度）
- 🖥️ **DSH Desktop 原生通知**：换曲即发一条系统通知（歌名 + 歌手/专辑，`silent` 静音、同一首不重复；默认前后台都发，`NOTIFY_ALWAYS` 一个常量可切回「仅失焦时发」）
- 🪟 **透明毛玻璃**：顶栏 / 播放条 / 列头 / 弹层遮罩复用 DSH 自身的 `color-mix(...) + backdrop-filter` 配方；列头是真毛玻璃——列表从它下面滑过（DSH 侧同款见 `ui-dockkit` 的 `.dockScrim` 与 `--dsw-mask-blur`）
- 🖱️ **官方悬停提示**：按钮 / 曲目行 / 统计信息的悬停气泡直接用 `@deepseek-ai/dsh-client-ui-primitives` 导出的 `Tooltip`，与 DSH 官方同源同款（含贴边翻转算法）。**必须 `portal: true`**：气泡是 `position: fixed`，而毛玻璃的 `backdrop-filter` 会让祖先变成 fixed 的包含块，不 portal 就会被 `overflow:hidden` 裁掉（这正是「悬停什么都没出来」的原因）；disabled 按钮外包一层容器，保证 hover 仍然触发
- 🔎 **官方搜索框**：表头搜索用同一个包导出的 `Input` 组件（wrap + 前置放大镜图标 + input 三件套），字号/描边/聚焦态与 DSH 自己的搜索框一致；取不到官方组件时退回裸 input
- 🎨 **官方图标**：播放 / 暂停 / 文件夹 / 刷新 / 编辑 / 删除 / 关闭 / 星标改用 DSH 内置 `ic_ds_*` 图标；上一首 / 下一首 / 循环 / 音量 / 音符没有对应官方图标，保持原自绘 SVG 不变
- ⏳ 扫描进度实时回报（正在扫描… n/m），超 5000 截断有提示
- 🎚️ macOS Music 风格进度条：填充式进度、rAF 逐帧平滑走动、悬停加粗变色、拖拽松手才 seek、滚轮 ±5s（Shift ±1s）、音量条滚轮 ±5%
- 🖥️ **全屏播放器（macOS Music 风格，点底部封面弹出）**：左侧大封面 + **封面取色模糊背景**；歌名/歌手**跑马灯**；下面一行是 **⭐ 收藏 + ⋯**（对齐 macOS Music 的两枚圆形按钮，⋯ = 当前曲目在线补全）；再往下是**细轨进度条（上方）＋「已播 / -剩余」时间（下方左右分列）**，再往下是传输键（**上一首 / 播放 / 下一首 三键居中**，**循环键单独落在「-剩余」时间正下方**）；右侧是 **「接下来播放」队列**（缩略封面 + 歌名 + 歌手—专辑，当前曲高亮，点行即播）与「一键补全 / 刷新」两个 pill；顶部左收起、右是**喇叭图标 + 长条音量**。**暂不做歌词**，Esc 或收起键关闭，进入删除确认时自动收起
- 🎛️ **播放键 / 音量条 / 进度条按 macOS Music 重做**（两处页面同步）：播放暂停是实心三角与双竖条（不是 DSH 的圆圈套三角）；滑杆是细轨 + 中性色填充，**圆钮默认隐藏、悬停或拖拽才出现**；右侧时间统一显示 **-剩余**；全屏播放器的进度条与封面**同宽**且时间换行到条下方，底部条进度条铺满中间列、时间仍内联
- 📜 **歌名/歌手跑马灯**：底部播放条的歌名与歌手在**放不下时**才从右往左循环滚动（放得下完全不动），速度按内容宽度换算（固定 px/s）、悬停暂停、尊重 `prefers-reduced-motion`；不滚动时不复制第二份文本，避免读屏重复
- 🖱️ 歌曲列表独立内滚（顶栏与播放条固定），滚轮全程可用
- ⏯️ 切换标签页音乐不中断（`<audio>` 元素驻留全局单例，HMR 也不双开）
- 💾 状态持久化：目录（服务端 `$DSH_HOME/storages/dsh-music-player.json`，兼容旧的包内 `lib/state.json`）+ 音量 / 循环模式 / 排序 / 最后播放曲目与进度（localStorage），刷新后曲目以暂停态 cue 在原位置
- 🎨 全量使用 DSH 设计变量（`--dsw-alias-*`），明暗主题自适应
- 🌊 Range 流式传输，大文件拖动进度条秒跳
- 🔒 仅接受回环同源请求：跨站简单请求 / DNS rebinding 一律 403；封面仅放行栅格格式（`image/svg+xml` 等一律 404）并按字节数封顶缓存
- ⚡ **性能**：库轮询复用同一份 payload（不再每次重建 5000 个对象）；标签写入放进 worker 线程——53MB 文件实测主线程阻塞 **90ms → 1ms**；单个数据源连续失败 2 次自动熔断 60s，批量补全不再被挂掉的源拖死；匹配并发上限 2
- 🛡️ **安全**：`/api/apply` 串行锁消除「探测目标名 → rename」竞态；文件名过滤 Windows 保留设备名与结尾点/空格；封面代理白名单 + 逐跳校验重定向；越界路径、跨站请求、SSRF 均有回归测试覆盖
- 🧩 标准 bundle 插件：进插件清单、可热重载、卸载即净

---

## 快速安装 / Quick Install

前置条件：已安装 DSH 并能打开 Web 界面（<http://127.0.0.1:3080>）；`pnpm` 在 PATH 上（`dsh plugin` 内部调用它）。

```bash
# Web
dsh plugin --profile web add github:heshuren371/dsh-music-player
```

重启 `dsh web`，刷新浏览器——会话顶部标签环出现「音乐」即成功。

**DSH Desktop**：桌面端的 profile（`$DSH_HOME/profiles/desktop`）由 Electron 应用独占，CLI 会直接拒绝（`dsh plugin --profile desktop` → `profile "desktop" is managed exclusively by the Electron application`）。请用**应用菜单里的插件管理窗口**安装同一个 GitHub 源，装完重启应用。

> Desktop 正式版会对 profile 里的 bundle 做 realpath 校验（必须落在 profile 目录或随包运行时内），所以「外部目录 `link:`」这种开发用法只在开发模式下可用（`pnpm run dev:desktop` 会带 `--allow-linked-profile`）；正式使用请走应用内插件管理窗口装包。

- 这一条命令完成全部装配：下载插件、安装依赖（music-metadata）、把插件注册进 profile 的 bundles 装配层——**无需克隆仓库、无需手动改 JSON、无需建软链**
- 想锁定版本：`github:heshuren371/dsh-music-player#v0.6.7`
- 还没装 DSH：`npm i -g @deepseek-ai/dsh`，然后 `dsh web`

## 更新 / Update

```bash
dsh plugin --profile web remove @local/dsh-music-player
dsh plugin --profile web add github:heshuren371/dsh-music-player
```

然后重启 `dsh web`。

## 卸载 / Uninstall

```bash
dsh plugin --profile web remove @local/dsh-music-player
```

重启 `dsh web` 即彻底移除（装配层自动清理）。卸载不会动你的任何音乐文件——只有你在删除确认条里点「删除」才会真正删除本地文件。

---

## 开发者安装（克隆 + link）

要改插件代码、让改动随重启/热重载生效，用 link 方式：

```bash
git clone https://github.com/heshuren371/dsh-music-player.git
cd dsh-music-player && npm install
cd ..
dsh plugin --profile web add link:./dsh-music-player
```

- link 方式不会自动安装插件依赖，克隆目录里的 `npm install` 必须做（运行时依赖 `music-metadata` + `node-taglib-sharp`，看到 `node_modules/` 出现即成功）
- 装配后**不要移动或删除克隆目录**——profile 通过链接指向这个位置，移动后插件失效
- Desktop 端要做同样的 link 开发，需要走开发模式的桌面构建（`pnpm run dev:desktop`，它用 `--allow-linked-profile` 放行 profile 外的链接包）；正式版应用会在启动时拒绝这种链接
- 改完代码让改动生效：**客户端**（`lib/client.js`）刷新浏览器页面即可；**宿主**（`lib/host.js`）也已支持热重载——入口 `lib/index.js` 是薄壳，每个请求按 mtime 判断 `host.js` 是否变化并重新载入，改完刷新页面即生效，**不用再重启 `dsh web`**。只有改 `lib/index.js` 本身（极少见）才需要重启进程

### 看不到「音乐」标签？

按顺序排查：

1. 浏览器有没有刷新
2. `dsh plugin --profile web ls` 输出里有没有 `@local/dsh-music-player`
3. profile 的 `package.json` 里 `dsh.profile.bundles` 数组有没有包名（`dsh plugin add` 会自动写入，正常不需要手改）
4. （仅 link 方式）克隆目录里有没有 `node_modules/`
5. Desktop 端：插件管理窗口里装好后有没有重启应用；开发模式下额外确认是用 `--allow-linked-profile` 启动的

> 已经用旧的手动方式（改 JSON + 软链）装过？可以保留不动，也可以 `dsh plugin --profile web remove @local/dsh-music-player` 后用上面的快速安装重装。当前选择目录在 `$DSH_HOME/storages/dsh-music-player.json`（旧版本在克隆目录的 `lib/state.json`，首次启动自动迁移）。

---

## HTTP API

宿主端把每个端点注册为 `ctx.connection.fetch` 上的**精确 `/api` Fetch 路由**（Web 与 DSH Desktop 共用同一条接缝）。
Web 侧旧版 `/dsh-music` 前缀仍保留作向后兼容（已加载的旧客户端 bundle 仍指向它），新客户端一律走下面这张表。

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/dsh-music/library` | GET | 当前目录 + 曲目列表（含 `scanning`/`scanParsed`/`scanTotal`/`truncated` 进度字段，非阻塞） |
| `/api/dsh-music/refresh` | POST | 重新扫描当前目录 |
| `/api/dsh-music/dir` | POST | `{ "dir": "..." }` 设置目录并扫描 |
| `/api/dsh-music/pick` | POST | 弹原生目录选择器，选定后扫描 |
| `/api/dsh-music/stream?p=<id>` | GET | 按稳定 ID（相对路径）流式传输（Range / 206，越界 403） |
| `/api/dsh-music/cover?p=<id>` | GET | 内嵌专辑封面（内存缓存，无封面 404） |
| `/api/dsh-music/match?p=<id>` | GET | 多源在线匹配：返回按置信度排序的候选（含 `score`/`auto`/`sources`）与 `best`（`q` 可覆盖搜索词；单源失败不影响其它源） |
| `/api/dsh-music/art?u=<url>` | GET | 代理封面图（白名单：mzstatic / gtimg / music.126.net / coverartarchive+archive.org；逐跳校验重定向、字节封顶并缓存） |
| `/api/dsh-music/apply` | POST | `{ id, title?, artist?, album?, cover?, rename? }` 写入标签（含封面）并按「歌手 - 原名」重命名；返回 `oldId/newId/tagged/renamed` 与更新后的库 |
| `/api/dsh-music/delete` | POST | `{ "id": "<曲目 id>" }` 删除曲目（**含本地文件**，仅限当前库内、越界拒绝），返回更新后的库 |

> **信任边界**：Web 与 0.1.7 起的 Desktop 都经 `@deepseek-ai/dsh-client-connection` 的 `/api` 握手统一鉴权（Host/Origin 栅栏 + 浏览器会话）；插件的旧 `/dsh-music` 前缀另有一道同构的 Host/Origin 检查，供 0.1.6 形态的 Desktop / 旧客户端使用。

## 结构 / Structure

```
lib/index.js       插件入口（薄壳）：注册 /api/dsh-music/* Fetch 路由 + 宿主代码热重载
lib/http-bridge.js Fetch ⇄ node:http 适配层：把 connection.fetch 的 Request 交给原有路由实现，
                   并把 node 响应还原成 Response（含流式 body 背压与 HEAD 语义）
lib/host.js        宿主实现：目录扫描 + music-metadata 标签解析 + Range 流媒体 + 多源匹配/封面代理 + 标签写入与重命名
lib/client.js      客户端：conversation.view 槽位注册「音乐」视图（React via __ModuleLoader__）
lib/tagwriter.js   标签写入 worker 线程入口（node-taglib-sharp）
```

## DSH Desktop 适配 / Desktop notes

Desktop 与 Web 复用同一份客户端 bundle，差异只在宿主传输。下面按**实测过的两个 Desktop 形态**写，不是照抄单一版本的源码：

**1. 平台字只有一个。** 客户端模块系统硬性要求 `dsh.client.platform === 'web'`（0.1.6 与 0.1.7 的实现都在 `resolveMeta` 里写死这一条），Desktop 也走这条平台字，所以**不存在** `platform: 'desktop'` 这种写法；`package.json` 里的 `platform` 保持 `web` 才是两端都能加载的正解。

**2. Desktop 有前后两代宿主形态，插件必须都能落。**

| | 0.1.6 时代（`apps/desktop-host`） | 0.1.7 起（`@deepseek-ai/dsh-desktop-host` = profile 启动器） |
| --- | --- | --- |
| 监听端口 | 不开 | **开**：`runProfile({ …, '--port' })` 起完整 Web 运行时 |
| `ctx.webServer` | 不存在（patch 里 `disabled: true`） | **存在**（本机实测 `127.0.0.1:19387`） |
| `dsh-app://app/*` | 自己按路径分派：`/api/*` → `connection.createSharedFetchHandler('/api')`，其余回落 index.html | 只服务 shell /`/index.html`/`/assets/*`，**其余一律转发给本地回环端口** |

结论：`/api` 之下是两代都可达的唯一交集，所以插件把端点注册成 `connection.fetch` 上的**精确 `/api/dsh-music/*` 路由**——0.1.7 里它等价于一等公民（走 `/api` 握手 + 浏览器会话鉴权），0.1.6 形态里它是唯一能到达的通路。Web 侧的旧 `/dsh-music` 前缀保留作向后兼容，客户端还带一次性回落探测。

> ⚠️ 版本核对提示：`dsh.client.platform`、`webServer` 是否存在、图标导出名，这三件事在不同 DSH 版本间都变过（见下条）。升级 DSH 后请以**运行中的应用**为准，不要以本地仓库 checkout 为准——本仓库工作树曾是 0.1.6-alpha.1，而安装的 Desktop 是 0.1.7-rc.2。

**3. 不要重复做 loopback 判定。** 0.1.7 的 Desktop 请求经 Electron 转发后才落到本地端口，Host 与 Origin 由外壳补齐；0.1.6 形态的请求更是完全不带 loopback Host。插件自己再判一次回环 Host 会把正常请求全部 403——信任边界交给连接层：Web/0.1.7 Desktop 走 `/api` 的 Host/Origin 栅栏 + 浏览器会话，0.1.6 Desktop 走 Electron 自定义协议。

**4. macOS「通知栏 / 正在播放」能到什么程度。** 分两层，别混为一谈：

| 想要的效果 | 机制 | 状态 |
| --- | --- | --- |
| 状态栏 / 控制中心「正在播放」的**歌名 / 歌手 / 专辑** | MediaSession（`mediaSession.metadata`）→ Electron 内置的 macOS Now Playing 集成 | ✅ 已生效 |
| 同一处的**专辑封面** | 同上；封面 URL 必须过 Chromium `MediaImage` 的 scheme 白名单（只收 `http`/`https`/`data`/`blob`），而且系统取图是**浏览器内部发起**、带着发起页痕迹（`Origin: dsh-app://app` / `Sec-Fetch-Site: cross-site`），会被插件的浏览器栅栏判 403 | ✅ 已修：宿主新开 `GET /dsh-music/api/system-art?t=<随机 token>`，**只认 token、不看 Host/Origin**；token 只随鉴权过的 `GET /api/dsh-music/session` 发给本页。实测带 `Origin: dsh-app://app` + `Sec-Fetch-Site: cross-site` + 无 cookie 仍返回 200 `image/jpeg`（500×500） |
| 换曲弹系统通知横幅（歌名 + 歌手/专辑） | 渲染进程 Web Notification → Electron 原生通知 | ✅ 已做（`silent`、同曲去重） |
| 通知横幅里的封面 | macOS 通知只用 App 图标，Electron 的 `icon` 在 macOS 被忽略 | ❌ 系统限制：封面只出现在「正在播放」那一侧 |

> 怎么确认 Electron 到底发不发「正在播放」信息：看二进制里有没有引用 MediaPlayer 的符号。
> `nm -u ".../Electron Framework" | grep MP` 能看到 `_MPMediaItemPropertyTitle` / `_MPMediaItemPropertyArtwork` /
> `_MPMediaItemPropertyAlbumTitle` / `_OBJC_CLASS_$_MPMediaItemArtwork` / `_OBJC_CLASS_$_MPNowPlayingInfoCenter` ——
> 说明标题、歌手、专辑、封面都会交给系统；封面缺失只可能是**取图失败**（scheme 被拒 / 地址不可达 / 401），而不是 Electron 不支持。

> 通知不弹的排查顺序：系统设置 → 通知 → DeepSeek Harness 允许通知；关掉专注模式/勿扰。

**5. 官方 UI 组件的导出名会随版本变。** 0.1.6 的 `@deepseek-ai/dsh-client-ui-primitives` 导出 `IconPlayOutline16` / `IconFolderOpen16` / `IconSparkle16` 这套 `*16` 命名；0.1.7 换成了权重体系 `IconPlayOutlineRegular|Medium` / `IconFolderOpenRegular` / `IconSparkleRegular`。插件因此按**候选名依次探测**（见 `officialIcon`），两代都命中；名字全对不上才回退自绘 SVG。`Tooltip` 的 `label`/`side` 两代一致。

### 用到的技术名称 / Tech names

| 技术 | 用在哪 |
| --- | --- |
| Cordis 服务注入（`ctx.inject` / `ctx.effect`） | 运行时按可用服务绑定宿主路由，替代静态 `inject` |
| `connection.fetch.register` 精确 Fetch 路由 | Web 与 Desktop 共用的宿主端点接缝 |
| Fetch ⇄ `node:http` 适配（`Request`/`Response` ↔ `IncomingMessage`/`ServerResponse`） | `lib/http-bridge.js`，复用既有路由实现 |
| Node `Readable` / `Writable` 背压 + `ReadableStream` 控制器 | Range 流式播放的跨载体传输，abort 时释放 fd |
| Electron 自定义协议 `dsh-app://`（`registerSchemesAsPrivileged`：`standard`/`secure`/`stream`/`supportFetchAPI`/`codeCache`） | Desktop 外壳文档与静态资源；其余路径由外壳转发到本地回环宿主（0.1.7） |
| DSH `runProfile` + cordis profile patch（`@deepseek-ai/dsh-desktop-host`） | 0.1.7 Desktop 的宿主启动方式（完整 Web 运行时 + `--port`） |
| HTML5 Range 请求（`206 Partial Content` / `Accept-Ranges`） | 拖动进度条秒跳 |
| Media Session API（`MediaMetadata` / `setActionHandler` / `setPositionState`） | macOS 控制中心 / 锁屏「正在播放」与系统媒体键 |
| Web Notifications API（Electron 转原生通知） | Desktop 失焦换曲提示，带封面 icon |
| CSS `backdrop-filter` + `color-mix(in srgb, …)` + `position: sticky` | 透明毛玻璃（与 DSH `ui-dockkit` / `--dsw-mask-blur` 同配方） |
| DSH 平台种子模块 `@deepseek-ai/dsh-client-ui-primitives`（`PLATFORM_MODULES`，含 `ui-slots`/`ui-dockkit`） | 官方 `Tooltip` / `Input` 与官方产品图标（全屏播放器用到 `IconChevronDownOutlineRegular` / `IconEllipsisOutlineRegular`）；CSS Module 随 shell 加载，插件零额外样式 |
| 图标优先级：官方 → macOS 原生风格自绘 | DSH 图标集**没有** star / shuffle / 上一首 / 下一首 / 循环 / 音量，这几枚按要求补 Apple 风格自绘（不是内嵌 SF Symbols：SF Symbols 受 Apple 授权约束、也不是可嵌入的 web 字体；要 1:1 的 SF 形状，把 SVG path 给我即可替换） |
| CSS `filter: blur()` 放大封面 + 半透明薄纱 | 全屏播放器的「封面取色背景」（Apple Music 同款观感），不额外请求图片 |
| CSS Grid 两栏布局 | 全屏播放器左（播放区）/ 右（队列） |
| `localStorage`（`dsh-music:fav`） | ☆ 收藏（DSH 无收藏能力，插件自带本地记录） |
| CSS `@keyframes` + `ResizeObserver` 驱动的条件跑马灯 | 只在文本溢出时循环滚动（`translateX(calc(-50% - gap/2))` 无缝衔接），悬停 `animation-play-state: paused` |
| React `createPortal`（Tooltip 的 `portal: true`） | 把 `position: fixed` 的气泡挂到 `document.body`，绕开 `backdrop-filter` 祖先造成的 fixed 包含块裁剪 |
| Web Notification API → Electron 原生通知 | 换曲横幅（系统通知中心）；macOS 会忽略自定义 `icon` |
| Chromium `MediaImage` scheme 白名单（`http`/`https`/`data`/`blob`）+ macOS `NowPlayingInfoCenterDelegateCocoa` | 系统「正在播放」的封面：Electron 内置了 macOS Now Playing 集成，但封面 URL 只能是绝对 http(s)/data/blob，自定义协议会被丢弃 |
| 能力 token（`randomUUID`）+ `GET /api/dsh-music/session` | 系统取图专用端点：token 即凭证，绕开 Host/Origin 栅栏；其余端点照旧受栅栏保护 |
| Electron `forwardWebRequest`（`dsh-app://app/*` → 回环宿主） | 会重写 `Host`、注入会话 cookie、**剥掉 `Origin` 与 `Sec-Fetch-*`** —— 插件端点因此能拿到正确的回环 authority |
| 图标候选名探测（`IconXxxRegular` → `IconXxxMedium` → `IconXxx16`） | 跨 0.1.6 / 0.1.7 两套官方图标命名体系，取不到才回退自绘 SVG |
| DSH 设计令牌 `--dsw-alias-*` / `--dsw-specific-*` / `--ds-ease-in-out` | 全量配色与动效，明暗主题自适应 |
| React `cloneElement` + 包装层 | 把官方 Tooltip 挂到 `disabled` 按钮上（disabled 元素不派发鼠标事件） |
| 宿主热重载壳（mtime + 带查询串的动态 `import`） | 改 `lib/host.js` 刷新页面即生效 |

## License

[MIT](./LICENSE)
