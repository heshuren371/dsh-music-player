# DSH Desktop 适配笔记

面向改宿主接缝 / 排查 Desktop 专属问题的人。全部结论来自**实测**，不是照抄单一版本的源码。

> ⚠️ **版本核对提示**：`dsh.client.platform`、`ctx.webServer` 是否存在、官方图标导出名，这三件事在不同 DSH 版本间都变过。升级 DSH 后请以**运行中的应用**为准，不要以本地仓库 checkout 为准——本仓库工作树曾是 0.1.6-alpha.1，而安装的 Desktop 是 0.1.7-rc.2。

## 1. 平台字只有一个

客户端模块系统硬性要求 `dsh.client.platform === 'web'`（0.1.6 与 0.1.7 的实现都在 `resolveMeta` 里写死这一条），Desktop 也走这条平台字，所以**不存在** `platform: 'desktop'`。`package.json` 里的 `platform` 保持 `web` 才是两端都能加载的正解。

## 2. 两代宿主形态，插件必须都能落

| | 0.1.6 时代（`apps/desktop-host`） | 0.1.7 起（`@deepseek-ai/dsh-desktop-host` = profile 启动器） |
| --- | --- | --- |
| 监听端口 | 不开 | **开**：`runProfile({ …, '--port' })` 起完整 Web 运行时 |
| `ctx.webServer` | 不存在（patch 里 `disabled: true`） | **存在**（本机实测 `127.0.0.1:19387`） |
| `dsh-app://app/*` | 自己按路径分派：`/api/*` → `connection.createSharedFetchHandler('/api')`，其余回落 index.html | 只服务 shell / `/index.html` / `/assets/*`，**其余一律转发给本地回环端口** |

**结论**：`/api` 之下是两代都可达的唯一交集，所以端点注册成 `connection.fetch` 上的**精确 `/api/dsh-music/*` 路由**——0.1.7 里它等价于一等公民（走 `/api` 握手 + 浏览器会话鉴权），0.1.6 形态里它是唯一能到达的通路。Web 侧旧 `/dsh-music` 前缀保留作向后兼容，客户端带一次性正向识别的回落探测（见 `lib/client.js` 的 `ROUTE_MISSING_404_ENDPOINTS`）。

### 2.1 `system-*` 端点的代价

`system-art` / `system-stream` **不能**注册到 `connection.fetch`：它们服务 Chromium 内部请求（带 `Origin: dsh-app://app`、无会话 cookie），而平台的 `/api` 路由会先判 Host/Origin 栅栏、再要求浏览器会话（`admit()`），这类请求必然 401/403。它们只能挂插件自建的 `/dsh-music` 旧前缀。

**代价**：宿主没有 `webServer` 时这两个端点不可达。这是设计约束，不是漏改；`dsh-plugin.json` 的 `legacyOnlyEndpoints` 与 `scripts/test-route-consistency.mjs` 都把它记为**具名例外**。

## 3. 不要重复做 loopback 判定

0.1.7 的 Desktop 请求经 Electron 转发后才落到本地端口，Host 与 Origin 由外壳补齐；0.1.6 形态的请求更是完全不带 loopback Host。插件自己再判一次回环 Host 会把正常请求全部 403。

**信任边界交给连接层**：Web / 0.1.7 Desktop 走 `/api` 的 Host/Origin 栅栏 + 浏览器会话；0.1.6 Desktop 走 Electron 自定义协议。

> 唯一例外是 `system-*`：它们豁免 Origin / Sec-Fetch 判定（Chromium 内部发起必须豁免），但**仍要求 Host 是回环字面量**——否则宿主绑非回环（`trustedHosts` LAN 服务）时，这个拿 URL token 当凭证的读端点就暴露给网络了。

## 4. macOS「通知栏 / 正在播放」能到什么程度

分两层，别混为一谈：

| 想要的效果 | 机制 | 状态 |
| --- | --- | --- |
| 状态栏 / 控制中心「正在播放」的**歌名 / 歌手 / 专辑** | MediaSession（`mediaSession.metadata`）→ Electron 内置的 macOS Now Playing 集成 | ✅ 已生效 |
| 同一处的**专辑封面** | 同上；封面 URL 必须过 Chromium `MediaImage` 的 scheme 白名单（只收 `http`/`https`/`data`/`blob`），且系统取图是**浏览器内部发起**、带 `Origin: dsh-app://app` / `Sec-Fetch-Site: cross-site` | ✅ 已修：宿主提供 `GET /dsh-music/api/system-art?t=<随机 token>`，**只认 token、不看 Host/Origin**；token 只随鉴权过的 `GET /api/dsh-music/session` 发给本页。实测带上述头且无 cookie 仍返回 200 `image/jpeg`（500×500） |
| 换曲弹系统通知横幅 | 渲染进程 Web Notification → Electron 原生通知 | ✅ 已做（`silent`、同曲去重） |
| 通知横幅里的封面 | macOS 通知只用 App 图标，Electron 的 `icon` 在 macOS 被忽略 | ❌ 系统限制：封面只出现在「正在播放」那一侧 |

**怎么确认 Electron 到底发不发「正在播放」信息**：看二进制里有没有引用 MediaPlayer 的符号。

```
nm -u ".../Electron Framework" | grep MP
```

能看到 `_MPMediaItemPropertyTitle` / `_MPMediaItemPropertyArtwork` / `_MPMediaItemPropertyAlbumTitle` / `_OBJC_CLASS_$_MPMediaItemArtwork` / `_OBJC_CLASS_$_MPNowPlayingInfoCenter` —— 说明标题、歌手、专辑、封面都会交给系统；封面缺失只可能是**取图失败**（scheme 被拒 / 地址不可达 / 401），而不是 Electron 不支持。

**通知不弹的排查顺序**：系统设置 → 通知 → DeepSeek Harness 允许通知；关掉专注模式 / 勿扰。

## 5. 官方 UI 组件的导出名会随版本变

0.1.6 的 `@deepseek-ai/dsh-client-ui-primitives` 导出 `IconPlayOutline16` / `IconFolderOpen16` / `IconSparkle16` 这套 `*16` 命名；0.1.7 换成了权重体系 `IconPlayOutlineRegular|Medium` / `IconFolderOpenRegular` / `IconSparkleRegular`。插件按**候选名依次探测**（见 `officialIcon`），两代都命中；名字全对不上才回退自绘 SVG。`Tooltip` 的 `label` / `side` 两代一致。

## 6. 媒体直连（token 通道）为什么必需

Desktop 页面是 `dsh-app://`，媒体 `src` 走 Desktop 转发，实测**转发会让流丢掉 Range/206** —— 浏览器于是认为流不可 seek，表现为「一拖进度条 / 快进就从头播」。让媒体直接连回环 HTTP 就正常了。

因此 `lib/client.js` 在拿到 `systemStreamBase` 后，音频与 MV 缓存文件都走 token 直连；拿不到则退回相对地址（Web 上本来就正常）。

> **token 必须是进程级**：客户端把基址缓存整个页面生命周期，而宿主每次热重载都会 `createHost()`。若 token 随实例轮换，一次「保存文件」就让人手里所有媒体 URL 变成废纸 —— 症状是**音乐全不能播、MV 照播**（`/api/mv` 返回的是相对地址，不经 token）。见 `lib/host.js` 的 `processTokens()` 与 `scripts/test-token-lifetime.mjs`。

## 7. 用到的技术名称

| 技术 | 用在哪 |
| --- | --- |
| Cordis 服务注入（`ctx.inject` / `ctx.effect`） | 运行时按可用服务绑定宿主路由，替代静态 `inject` |
| `connection.fetch.register` 精确 Fetch 路由 | Web 与 Desktop 共用的宿主端点接缝 |
| Fetch ⇄ `node:http` 适配（`Request`/`Response` ↔ `IncomingMessage`/`ServerResponse`） | `lib/http-bridge.js`，复用既有路由实现 |
| Node `Readable` / `Writable` 背压 + `ReadableStream` 控制器 | Range 流式播放的跨载体传输，abort 时释放 fd |
| Electron 自定义协议 `dsh-app://`（`registerSchemesAsPrivileged`：`standard`/`secure`/`stream`/`supportFetchAPI`/`codeCache`） | Desktop 外壳文档与静态资源；其余路径由外壳转发到本地回环宿主（0.1.7） |
| DSH `runProfile` + cordis profile patch | 0.1.7 Desktop 的宿主启动方式（完整 Web 运行时 + `--port`） |
| HTML5 Range 请求（`206 Partial Content` / `Accept-Ranges`） | 拖动进度条秒跳 |
| Media Session API（`MediaMetadata` / `setActionHandler` / `setPositionState`） | macOS 控制中心 / 锁屏「正在播放」与系统媒体键 |
| Web Notifications API（Electron 转原生通知） | Desktop 换曲提示 |
| CSS `backdrop-filter` + `color-mix(in srgb, …)` + `position: sticky` | 透明毛玻璃（与 DSH `ui-dockkit` / `--dsw-mask-blur` 同配方） |
| DSH 平台种子模块 `@deepseek-ai/dsh-client-ui-primitives` | 官方 `Tooltip` / `Input` 与官方产品图标；CSS Module 随 shell 加载，插件零额外样式 |
| 图标优先级：官方 → macOS 原生风格自绘 | DSH 图标集**没有** star / shuffle / 上一首 / 下一首 / 循环 / 音量，这几枚补 Apple 风格自绘（不是内嵌 SF Symbols：受 Apple 授权约束、也不是可嵌入的 web 字体） |
| CSS `filter: blur()` 放大封面 + 半透明薄纱 | 全屏播放器的「封面取色背景」，不额外请求图片 |
| `localStorage`（`dsh-music:fav`） | ☆ 收藏（DSH 无收藏能力，插件自带本地记录） |
| CSS `@keyframes` + `ResizeObserver` 驱动的条件跑马灯 | 只在文本溢出时循环滚动，悬停 `animation-play-state: paused` |
| React `createPortal`（Tooltip 的 `portal: true`） | 把 `position: fixed` 的气泡挂到 `document.body`，绕开 `backdrop-filter` 祖先造成的 fixed 包含块裁剪 |
| React `cloneElement` + 包装层 | 把官方 Tooltip 挂到 `disabled` 按钮上（disabled 元素不派发鼠标事件） |
| Chromium `MediaImage` scheme 白名单 | 系统「正在播放」的封面：URL 只能是绝对 http(s)/data/blob，自定义协议会被丢弃 |
| Electron `forwardWebRequest`（`dsh-app://app/*` → 回环宿主） | 会重写 `Host`、注入会话 cookie、**剥掉 `Origin` 与 `Sec-Fetch-*`** —— 插件端点因此能拿到正确的回环 authority |
| 能力 token（`randomUUID`）+ `GET /api/dsh-music/session` | 系统取图 / 取媒体专用端点：token 即凭证；**按用途分签**且**进程级** |
| 宿主热重载壳（mtime + 带查询串的动态 `import`） | 改 `lib/host.js` 刷新页面即生效 |
