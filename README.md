# dsh-music-player

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的本地音乐播放器插件，**Web 与 Desktop 同一份包**。在会话视图标签环里加一个「音乐」标签页，交互与视觉参考 macOS 的 Music 应用。

**TypeScript 源码 → 提交编译产物**：`src/*.ts` 是唯一真源，`lib/*.js` 是 `tsc` 产物（**也提交进仓库**，因为 `dsh plugin add` 不跑构建）。有门禁保证二者一致。

A local music player plugin for DeepSeek Harness — one package for both the Web GUI and DSH Desktop.

---

## 功能 / Features

**库与扫描**
- 原生目录选择器（macOS / Windows / Linux）；也可手动粘贴路径（`D:\Music`、`~/Music`）。递归扫描 flac / mp3 / m4a / aac / ogg / opus / wav / mp4 / mov / webm / mkv / avi 等
- 扫描进度实时回报（`n/m`），超 5000 首截断并显式提示；列表显示歌名 / 歌手 / 时长（内嵌标签解析，缺省回退「歌手 - 歌名」文件名约定），支持列头排序、搜索过滤（n/N 计数），排序与偏好刷新后记忆
- Apple 离线包（`.movpkg`）是 FairPlay 加密的 HLS，**任何第三方播放器都无法解密**；扫描时整体跳过并在统计里说明原因

**播放**
- 单曲循环 / 列表循环（刻意不做随机与歌词页）；**播放顺序 = 可见列表顺序**——排序或搜索后「下一首」就是你看到的下一行
- macOS Music 风格进度条与音量条：填充式进度、拖拽松手才 seek、滚轮 ±5s（Shift ±1s）、音量滚轮 ±5%
- 全屏播放器：大封面 + 封面取色模糊背景、歌名跑马灯、⭐ 收藏 + ⋯、细轨进度条、三键传输、**「接下来播放」队列**；`Esc` 或收起键关闭
- 系统集成：MediaSession（媒体键、macOS 控制中心 / 锁屏「正在播放」）+ 桌面换曲原生通知（`silent`、同曲去重）
- MV（音乐视频）：三档判定 **direct / remux / transcode**（参考 Jellyfin），后两档用 ffmpeg，产物缓存在临时目录（缓存键含路径+大小+mtime）。**没有 ffmpeg 也能用**：直出格式照常播，其余给安装提示
- `<audio>` 驻留全局单例，切换标签页不中断播放；刷新后曲目以暂停态 cue 在原位置

**元数据补全**
- 每行「✦」打开搜索弹层，宿主并行查 **QQ 音乐 + iTunes + 网易云**，置信不足时用 **MusicBrainz** 兜底。打分 = 标题相似度 55% + 歌手 30% + 时长一致性 15%（缺项自动重分配权重），叠加多源印证与 Live/翻唱/DJ 版惩罚；简繁歌手自动归并，文件名序号与噪声在搜索前清洗
- **写回文件**：默认勾选「写入标签并重命名文件」（按「歌手 - 原名」重命名）。**封面只补缺失、绝不覆盖已有封面**；只把 jpeg/png 写进文件（webp/avif/bmp 仅用于显示），补缺取高清规格而非缩略图
- **一键补全全部**：逐首限速、进度可见、可随时停止，执行前先弹确认条

**工程约束（长期维护的部分）**
- 🔒 仅接受回环同源请求：跨站简单请求 / DNS rebinding 一律 403；封面走主机白名单 + 逐跳校验重定向；仅放行栅格格式（`image/svg+xml` 等一律 404）并按字节数封顶
- 🛡️ `/api/apply` 串行锁消除「探测目标名 → rename」竞态；文件名过滤 Windows 保留设备名与结尾点/空格；越界路径与库外文件一律拒绝
- ⚡ 标签写入在 worker 线程（53MB 文件主线程阻塞实测 90ms → 1ms，**该数字未纳入门禁**）；库轮询复用同一份 payload；单个数据源连续失败 2 次熔断 60s；匹配并发上限 2
- 🎨 全量使用 DSH 设计变量（`--dsw-alias-*`），明暗主题自适应；官方 `Tooltip` / `Input` / 图标来自 `@deepseek-ai/dsh-client-ui-primitives`

---

## 安装 / Install

前置：已安装 DSH 并能打开界面；`pnpm` 在 PATH 上（`dsh plugin` 内部调用它）。

```bash
# Web
dsh plugin --profile web add github:heshuren371/dsh-music-player

# 更新
dsh plugin --profile web remove @local/dsh-music-player
dsh plugin --profile web add github:heshuren371/dsh-music-player

# 卸载（不会动你的音乐文件）
dsh plugin --profile web remove @local/dsh-music-player
```

装完**重启 `dsh web`** 并刷新浏览器，会话顶部标签环出现「音乐」即成功。锁版本用 `#v0.8.5` 之类的后缀。

**DSH Desktop**：桌面 profile 由 Electron 应用独占，CLI 会拒绝写入（`profile "desktop" is managed exclusively by the Electron application`）。请用**应用菜单里的插件管理窗口**安装同一个 GitHub 源，装完重启应用。

**改代码开发**：走 `link`，见「开发 / Development」。

---

## 兼容性 / Compatibility

| 项 | 位置 | 值 |
| --- | --- | --- |
| Node.js | `package.json` → `engines.node` | `^22.19.0 \|\| >=24.0.0`（与 DSH 根包声明一致） |
| DSH 范围（描述性） | `package.json` → `dsh.compatibility.dsh` | `>=0.1.6-alpha.1 <0.2.0` |
| DSH 精确记录（证据） | `package.json` → `dsh.compatibility.dshReleases` | `0.1.7-rc.2: compatible`；`0.1.7-rc.1` / `0.1.7-alpha.2`: `unknown` |

**范围 ≠ 证据。** 没跑过验收的版本一律写 `unknown`，不写 `compatible`。`install` / `start` / `uninstall` / `rollback` 四项一次性 Profile 证据**尚未提供**。

三条跨版本接缝变过（`dsh.client.platform`、`ctx.webServer` 是否存在、官方图标导出名），插件用**运行时探测 + 双形态回落**处理；`dsh-plugin.json` 的 `x-dsh-transition` 逐条记录。**升级 DSH 后请以运行中的应用为准，不要以本地 checkout 为准。**

> 依据、已知断点、逐条技术细节见 [docs/compatibility.md](docs/compatibility.md) 与 [docs/desktop.md](docs/desktop.md)。

---

## 权限与依赖 / Permissions & dependencies

权威值是 `dsh-plugin.json` 的 `permissions` 与 `lib/` 的运行时代码。**权限等级保守偏高是能力实情，不是漏报。**

| 权限 | 什么时候才会发生 |
| --- | --- |
| `fs.read` | 选定音乐目录后的递归扫描与 Range 流式读取 |
| `fs.write` | 只在「写入标签并重命名文件」流程里（写标签、写封面、重命名）；且 `node:child_process` 只用于调 ffmpeg/ffprobe，**参数数组直传、不经过 shell** |
| `fs.delete` | 只在删除确认条里点「删除」后，`fs.unlink` **永久删除**（不进废纸篓），仅限当前库内曲目 |
| `net.fetch` | 点「✦」/「一键补全全部」，或需要取封面时。全部 HTTPS，**没有任何上传** |
| `transport.api` | 插件激活时注册 `connection.fetch` 上的精确 `/api/dsh-music/*` 路由 |
| `storage.local` | `$DSH_HOME/storages/dsh-music-player.json` + `localStorage`（`dsh-music:*` 前缀） |

出网主机只有元数据搜索（`c.y.qq.com` / `itunes.apple.com` / `music.163.com` / `musicbrainz.org`）与封面取图（`mzstatic.com` / `*.gtimg.cn` / `*.music.126.net` / `coverartarchive.org`）。读取的环境变量只有 `DSH_HOME`、`DSH_MUSIC_FFMPEG`、`DSH_MUSIC_ITUNES_COUNTRY`、`PATH`。

失败边界、逐权限的代码信号与触发条件见 [docs/compatibility.md](docs/compatibility.md)。

---

## HTTP API

宿主把每个端点注册为 `ctx.connection.fetch` 上的**精确 `/api` Fetch 路由**（Web 与 Desktop 共用同一条接缝）。Web 侧旧 `/dsh-music` 前缀保留作向后兼容。

**18 个端点**，与 `lib/host.js` 分派表、`lib/index.js` 的 `FETCH_ROUTES`、`dsh-plugin.json` 登记表由 `scripts/test-route-consistency.mjs` 强制**三向一致**。

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/library` | GET | 当前目录 + 曲目列表（含 `scanning`/`scanParsed`/`scanTotal`/`truncated`） |
| `/refresh`、`/dir`、`/pick` | POST | 重扫 / 设目录 / 弹原生选择器（`/dir` 体：`{ "dir": "..." }`） |
| `/session` | GET | 下发系统取图用的能力 token 与回环基址 |
| `/stream?p=<id>` | GET | 音频流（Range / 206，越界 403） |
| `/cover?p=<id>` | GET | 内嵌封面（内存缓存，无封面 404） |
| `/match?p=<id>` | GET | 多源匹配候选（`q` 可覆盖搜索词） |
| `/art?u=<url>` | GET | 封面代理（白名单 + 逐跳校验 + 字节封顶 + 缓存） |
| `/apply` | POST | `{ id, title?, artist?, album?, cover?, rename? }` 写标签并按「歌手 - 原名」重命名 |
| `/delete` | POST | `{ "id": "..." }` 删除曲目**含本地文件**（仅限库内） |
| `/caps` | POST | 上报客户端视频解码能力 |
| `/mv?id=<id>` | GET | MV 播放计划（direct / remux / transcode） |
| `/mvconvert`、`/mvlib`、`/mvfile` | — | 触发转换 / MV 库视图 / MV 文件流（Range） |
| `/system-art?t=<token>`、`/system-stream?t=<token>` | GET | **仅旧前缀可达**：Chromium 内部取封面 / 取媒体，凭证是 URL 里的 token |

> **最后两个为什么不在 `connection.fetch` 上**：它们服务 Chromium **内部**发起的请求（带 `Origin: dsh-app://app`、不带会话 cookie），而平台的 `/api` 路由会先判 Host/Origin 栅栏、再要求浏览器会话（`admit()`），这类请求必然 401/403。它们只能挂插件自建的 `/dsh-music` 旧前缀。**代价**：宿主没有 `webServer` 时（0.1.6 形态 desktop-host）这两个端点不可达——已知限制。
>
> **信任边界**：Web 与 0.1.7+ Desktop 都经连接层的 `/api` 握手统一鉴权（Host/Origin 栅栏 + 浏览器会话）；旧 `/dsh-music` 前缀另有一道同构检查。`system-*` 是这条栅栏的**显式例外**（靠 token 而非会话），因此 token 的保密性是唯一防线，且它**按用途分签**（art / stream 各一个）。

---

## 结构 / Structure

```
src/*.ts           源码（唯一真源）
  index.ts         插件入口（薄壳）：注册 /api/dsh-music/* Fetch 路由 + host 热重载
  http-bridge.ts   Fetch ⇄ node:http 适配层（含流式背压与 HEAD 语义）
  host.ts          宿主：目录扫描 + 标签解析 + Range 流媒体 + 多源匹配 / 封面代理 + 写入与重命名
  client.ts        客户端：conversation.view 槽位注册「音乐」视图（React）
  tagwriter.ts     标签写入 worker 入口（node-taglib-sharp）
lib/*.js           上面 5 个文件的 tsc 产物（提交进仓库；DSH 加载的就是这里）
tsconfig.json      编译与类型档位（见 AGENTS.md §2.15）
scripts/           26 套回归 + 静态审计 + 类型棘轮 + 产物新鲜度 + 预览工具
```

---

## 开发 / Development

```bash
git clone https://github.com/heshuren371/dsh-music-player.git
cd dsh-music-player && npm install
cd .. && dsh plugin --profile web add link:./dsh-music-player
```

- `npm install` 必须做（`link` 不会自动装依赖）
- 装配后**不要移动或删除克隆目录**，profile 通过链接指向它
- **改代码改的是 `src/*.ts`，不是 `lib/*.js`**（后者是产物，会被下次构建覆盖）。开一个 watch 让它随存随编译：

  ```bash
  pnpm run dev     # = tsc --watch：保存 src/*.ts 即重新编译 lib/*.js
  ```

- 改动生效路径：`src/client.ts` → 刷新页面；`src/host.ts` → **也是刷新页面**（入口薄壳按 `lib/host.js` 的 mtime 重载，watch 已经把它更新了）；**只有改 `src/index.ts` 才需要重启进程**
- Desktop 端做 link 开发要走开发模式构建（`pnpm run dev:desktop`，带 `--allow-linked-profile`）；正式版应用会拒绝 profile 外的链接包

## 测试 / Tests

```bash
pnpm run build         # src/*.ts → lib/*.js
pnpm run typecheck     # 类型棘轮：错误数只许变少（当前基线 0 —— 已经清到零）
npm test               # 产物新鲜度 + 逐文件严格 + 26 套回归
pnpm run check:manifest # dsh-plugin.json 对 pinned dsh-std Community v0.15 校验
```

CI（`.github/workflows/ci.yml`）在每次 push / PR 上跑同一组。**CI 故意不先 build** —— 新鲜度门禁只在 `lib/` 未被就地覆盖时才有判别力。

除了功能与安全套件，还有几处专门防「**写了但不生效**」的静默失效：

| 门禁 | 覆盖什么 |
| --- | --- |
| `test-route-consistency.mjs` | `host.js` 分派表 == `FETCH_ROUTES` ∪ 具名旧前缀例外 == `dsh-plugin.json` 端点表，**三向集合相等**且 methods 对齐。手工抄的期望值曾让「MV 端点在 Desktop 上不可达」在 18/18 全绿下活了很久 |
| `test-audit.mjs` | CSS class / `@keyframes` 双向引用、BEM 修饰类不被基类规则顶掉、中英字典键一致、无死 player API、`api()` 调用都有宿主路由；**每个写盘目标必须在已审计白名单内、凭据不得进写盘、每个 mutation 必须过 `authorize()`** |
| 按钮接线检查 | 读 `__reactProps$*`，断言**每个 `<button>` 都挂了处理函数或处于 disabled** |
| `test-poll-teardown.mjs` | 停用后库轮询定时器不得自我续期（清句柄 ≠ 阻止再武装） |
| `test-teardown-race.mjs` | 停用优先于在飞热重载：挂起的 `import()` 恢复后不得再创建宿主实例 |
| `test-mv-teardown.mjs` | 停用必须终止在飞 ffmpeg 子进程（假 ffmpeg 自报 PID 验证） |
| `test-token-lifetime.mjs` | 能力 token 必须是**进程级**：`createHost()` 重跑不得轮换，否则音频全 403 |
| `test-entry-fallback.mjs` | 入口回落必须**正向识别**（不是「404 即信号」）且降级对用户可见 |
| `test-security.mjs` | 越界路径、跨站请求、SSRF、封面 MIME 白名单、token 分签与栅栏收窄 |
| `test-mv-seek.mjs` | **MV / 音频进度条必须能快进**：媒体源必须是 token 直连的**绝对地址**。带 18 条断言，含「平台 `/session` 答 401 时靠回环前缀拿到基址」与「源不可 seek 时按症状自愈」两个真机故障场景。相对地址在 Desktop 上经 Electron 转发会丢 Range/206，症状就是一拖就从头 |
| `check-build-fresh.mjs` | `lib/*.js` 必须逐字节等于 `src/*.ts` 的编译结果（防「改了 src 忘了 build」） |
| `test-leak.mjs` | 释放面/泄漏：8 次热重载后 fd 不增长、无孤儿子进程、`dispose()` 后 CPU≈0、heap 增长有界（阈值用正对照标定：无泄漏 3.0MB vs 注入 1MB/次泄漏 11.0MB） |
| `typecheck-ratchet.mjs` | 类型错误数只许变少不许变多（基线已收紧到 **0**） |
| `check-strict.mjs` | 逐文件收严：名单里的文件（`http-bridge` / `tagwriter`）必须在 `noImplicitAny: true` 下零错误，且**名单不许为空**（空名单=恒绿）。清干净一个文件就加一个 |

> ⚠️ **没有布局测量能力。** 客户端套件全部跑 jsdom，涉及「位置 / 宽度 / 是否溢出」的结论是靠**伪造 `scrollWidth`/`clientWidth`** 得出的。凡涉及真实盒模型的判断请标注为**未验证**。（早期 README 曾声称有 headless Chromium + CDP 门禁，那是不实主张。）

## 排查 / Troubleshooting

**看不到「音乐」标签**：① 刷新页面 ② `dsh plugin --profile web ls` 里有 `@local/dsh-music-player` ③ profile 的 `dsh.profile.bundles` 里有包名 ④（link 方式）克隆目录里有 `node_modules/` ⑤ Desktop：装好后重启过应用。

**Desktop 上改了插件看不到效果 / `Cmd+R` 没反应**：Desktop 主窗口**没有绑定任何重新加载快捷键**（应用菜单里只注册了 `toggleDevTools`，没有 `reload` 角色）。按 **`F12`** 打开 DevTools，在 Console 里执行 **`location.reload()`**；或直接重启应用。注意：`src/host.ts` 的改动会热重载自动生效，**`src/client.ts` 的改动必须重载渲染进程** —— 否则会出现「Web 上修好了、Desktop 上还是坏的」。详见 [docs/desktop.md](docs/desktop.md) §7。

**换歌不出声 / 播放异常**：先看是不是 `/dsh-music/api` 那条 token 通路——`curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:<端口>/dsh-music/api/session"`。能力 token **按用途分签且是进程级**，正常应与宿主实例同寿命。

**通知不弹**：系统设置 → 通知 → DeepSeek Harness 允许通知；关掉专注模式。

**已经用旧的手动方式装过**（改 JSON + 软链）：可以保留，也可以 remove 后用上面的快速安装重装。目录记录在 `$DSH_HOME/storages/dsh-music-player.json`（旧版本在克隆目录的 `lib/state.json`，首次启动自动迁移）。

---

## 文档 / Docs

| 文档 | 内容 |
| --- | --- |
| [docs/desktop.md](docs/desktop.md) | Desktop 两代宿主形态差异、macOS「通知 / 正在播放」能到什么程度、官方 UI 组件与图标命名演变、技术名称表 |
| [docs/compatibility.md](docs/compatibility.md) | 兼容性逐条依据、尚未提供的证据、已知兼容断点、依赖与权限信号、失败边界 |
| [AGENTS.md](AGENTS.md) | 改代码前必读的强制约定：规范基线、不可协商的规则、可跑门禁、审计与迭代协议 |
| [docs/audit-ledger.md](docs/audit-ledger.md) | 10 轮审计台账（只追加不删）：每条发现的证据、复现、门禁与状态 |

## License

[MIT](./LICENSE)
