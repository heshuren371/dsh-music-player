# dsh-music-player

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 界面的本地音乐播放器插件。在会话视图标签环（对话 / 轨迹 / …）中注册「音乐」标签页，UI 参考 macOS 自带 Music 应用。

A local music player plugin for the DeepSeek Harness Web GUI — adds a **音乐 (Music)** tab to the conversation view ring, styled after the macOS Music app.

## 功能 / Features

- 📁 选择本地目录（原生目录选择器，**macOS / Windows / Linux 均支持**；也可点标题栏 ⌨ 按钮手动粘贴路径，如 `D:\Music` 或 `~/Music`），递归扫描常见音频格式：**flac / mp3 / m4a / aac / ogg / opus / wav**
- 🎵 列表展示：歌曲名、歌手（内嵌标签解析，缺省回退「歌手 - 歌名」文件名约定）、时长
- ✨ **在线补全元数据（多源）**：每行「✦」打开搜索弹层（自动带出「歌名 + 歌手」，可手动改词重查）。宿主并行查 **QQ 音乐 + iTunes(TW) + 网易云**，主力置信不足时用 **MusicBrainz** 兜底；候选按「标题相似度 55% + 歌手相似度 30% + 时长一致性 15%」打分（缺项自动重分配权重），叠加多源印证、曲库排序、Live/翻唱/DJ 版惩罚；简繁歌手（周杰伦/周杰倫）自动归并，文件名序号（`01. ` / `[01]` / `1.`）与「(Live)」等噪声在搜索前清洗。每条候选显示来源与置信度
- 💾 **写回文件**：默认勾选「写入标签并重命名文件」——标签写回音频文件（mp3/flac/m4a/wav…，基于 node-taglib-sharp）并按「歌手 - 原名.扩展名」重命名；取消勾选则只改应用内显示。封面经宿主代理缓存（QQ/iTunes/网易云/CAA 白名单，逐跳校验重定向）；暂不做歌词
- ✦ **一键补全全部**：表头只有一个「✦」按钮，逐首检查**全部歌曲**（逐首限速、进度可见、可随时停止）。判定规则：**标签与文件名都已规范**才跳过（文件名不规范也会重命名）；**高置信度且与现状有差异**才写标签/重命名；时长差 >10s 时只有标题与歌手都强匹配（且本地有歌手）才放行——同一首歌的不同版本；歌手未知时证据不足，一律跳过。执行前先弹确认条
- 🔁 播放模式：单曲循环 / 列表循环（无随机播放、无歌词页——刻意保持简单）
- 🔀 列头排序：歌名 / 歌手 / 时长，升降序切换，刷新后记忆；**播放顺序 = 可见列表顺序**（排序/搜索后，「下一首」就是你看到的下一行）
- ➖ 行首删除：每首歌最前面的「−」按钮，点击后弹确认框，同意后**同时删除本地文件（永久删除，不可恢复）**
- 🔍 搜索过滤：歌名 / 歌手 / 文件名，n/N 计数
- 🖼️ 专辑封面：底部播放条缩略图（内嵌封面提取，无封面回退音符图标）
- 🎛️ MediaSession：系统媒体键（播放/暂停/上一首/下一首/seek）、macOS 控制中心显示歌名/歌手/封面
- ⏳ 扫描进度实时回报（正在扫描… n/m），超 5000 截断有提示
- 🎚️ macOS Music 风格进度条：填充式进度、rAF 逐帧平滑走动、悬停加粗变色、拖拽松手才 seek、滚轮 ±5s（Shift ±1s）、音量条滚轮 ±5%
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
dsh plugin --profile web add github:heshuren371/dsh-music-player
```

重启 `dsh web`，刷新浏览器——会话顶部标签环出现「音乐」即成功。

- 这一条命令完成全部装配：下载插件、安装依赖（music-metadata）、把插件注册进 profile 的 bundles 装配层——**无需克隆仓库、无需手动改 JSON、无需建软链**
- 想锁定版本：`github:heshuren371/dsh-music-player#v0.6.4`
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
- 改完代码让改动生效：**客户端**（`lib/client.js`）刷新浏览器页面即可；**宿主**（`lib/host.js`）也已支持热重载——入口 `lib/index.js` 是薄壳，每个请求按 mtime 判断 `host.js` 是否变化并重新载入，改完刷新页面即生效，**不用再重启 `dsh web`**。只有改 `lib/index.js` 本身（极少见）才需要重启进程

### 看不到「音乐」标签？

按顺序排查：

1. 浏览器有没有刷新
2. `dsh plugin --profile web ls` 输出里有没有 `@local/dsh-music-player`
3. profile 的 `package.json` 里 `dsh.profile.bundles` 数组有没有包名（`dsh plugin add` 会自动写入，正常不需要手改）
4. （仅 link 方式）克隆目录里有没有 `node_modules/`

> 已经用旧的手动方式（改 JSON + 软链）装过？可以保留不动，也可以 `dsh plugin --profile web remove @local/dsh-music-player` 后用上面的快速安装重装。当前选择目录在 `$DSH_HOME/storages/dsh-music-player.json`（旧版本在克隆目录的 `lib/state.json`，首次启动自动迁移）。

---

## HTTP API

宿主端在 Web 服务器注册 `/dsh-music` 前缀路由：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/dsh-music/api/library` | GET | 当前目录 + 曲目列表（含 `scanning`/`scanParsed`/`scanTotal`/`truncated` 进度字段，非阻塞） |
| `/dsh-music/api/refresh` | POST | 重新扫描当前目录 |
| `/dsh-music/api/dir` | POST | `{ "dir": "..." }` 设置目录并扫描 |
| `/dsh-music/api/pick` | POST | 弹原生目录选择器，选定后扫描 |
| `/dsh-music/api/stream?p=<id>` | GET | 按稳定 ID（相对路径）流式传输（Range / 206，越界 403） |
| `/dsh-music/api/cover?p=<id>` | GET | 内嵌专辑封面（内存缓存，无封面 404） |
| `/dsh-music/api/match?p=<id>` | GET | 多源在线匹配：返回按置信度排序的候选（含 `score`/`auto`/`sources`）与 `best`（`q` 可覆盖搜索词；单源失败不影响其它源） |
| `/dsh-music/api/art?u=<url>` | GET | 代理封面图（白名单：mzstatic / gtimg / music.126.net / coverartarchive+archive.org；逐跳校验重定向、字节封顶并缓存） |
| `/dsh-music/api/apply` | POST | `{ id, title?, artist?, album?, cover?, rename? }` 写入标签（含封面）并按「歌手 - 原名」重命名；返回 `oldId/newId/tagged/renamed` 与更新后的库 |
| `/dsh-music/api/delete` | POST | `{ "id": "<曲目 id>" }` 删除曲目（**含本地文件**，仅限当前库内、越界拒绝），返回更新后的库 |

> 所有路由仅接受回环（`127.0.0.1` / `::1` / `localhost`）Host 且同源的请求：跨站简单 POST 与 DNS rebinding 返回 403，非浏览器客户端（curl / 测试，Host 为回环）不受影响。

## 结构 / Structure

```
lib/index.js   插件入口（薄壳）：注册 /dsh-music 路由 + 宿主代码热重载
lib/host.js    宿主实现：目录扫描 + music-metadata 标签解析 + Range 流媒体 + 多源匹配/封面代理 + 标签写入与重命名
lib/client.js  客户端：conversation.view 槽位注册「音乐」视图（React via __ModuleLoader__）
```

## License

[MIT](./LICENSE)
