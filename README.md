# dsh-music-player

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 界面的本地音乐播放器插件。在会话视图标签环（对话 / 轨迹 / …）中注册「音乐」标签页（位于「轨迹」之后），UI 参考 macOS 自带 Music 应用。

A local music player plugin for the DeepSeek Harness Web GUI — adds a **音乐 (Music)** tab to the conversation view ring, styled after the macOS Music app.

## 功能 / Features

- 📁 选择本地目录（原生目录选择器，**macOS / Windows / Linux 均支持**；也可点标题栏 ⌨ 按钮手动粘贴路径，如 `D:\Music`），递归扫描常见音频格式：**flac / mp3 / m4a / aac / ogg / opus / wav**
- 🎵 列表展示：歌曲名、歌手（内嵌标签解析，缺省回退「歌手 - 歌名」文件名约定）、时长
- 🔁 播放模式：单曲循环 / 列表循环（无随机播放、无歌词页——刻意保持简单）
- 🔀 列头排序：歌名 / 歌手 / 时长，升降序切换，刷新后记忆；**播放顺序 = 可见列表顺序**（排序/搜索后，「下一首」就是你看到的下一行）
- 🔍 搜索过滤：歌名 / 歌手 / 文件名，n/N 计数
- 🖼️ 专辑封面：底部播放条缩略图（内嵌封面提取，无封面回退音符图标）
- 🎛️ MediaSession：系统媒体键（播放/暂停/上一首/下一首/seek）、macOS 控制中心显示歌名/歌手/封面
- ⏳ 扫描进度实时回报（正在扫描… n/m），超 5000 截断有提示
- 🎚️ macOS Music 风格进度条：填充式进度、rAF 逐帧平滑走动、悬停加粗变色、拖拽松手才 seek、滚轮 ±5s（Shift ±1s）、音量条滚轮 ±5%
- 🖱️ 歌曲列表独立内滚（顶栏与播放条固定），滚轮全程可用
- ⏯️ 切换标签页音乐不中断（`<audio>` 元素驻留全局单例，HMR 也不双开）
- 💾 状态持久化：目录（服务端 `lib/state.json`）+ 音量 / 循环模式 / 排序 / 最后播放曲目与进度（localStorage），刷新后曲目以暂停态 cue 在原位置
- 🎨 全量使用 DSH 设计变量（`--dsw-alias-*`），明暗主题自适应
- 🌊 Range 流式传输（稳定 ID 寻址 + 越界 403），大文件拖动进度条秒跳
- 🧩 标准 bundle 插件：进插件清单、可热重载、卸载即净

---

## 快速安装 / Quick Install

前置条件：已安装 DSH 并能打开 Web 界面（<http://127.0.0.1:3080>）；`pnpm` 在 PATH 上（`dsh plugin` 内部调用它）。

```bash
dsh plugin --profile web add github:heshuren371/dsh-music-player
```

重启 `dsh web`，刷新浏览器——会话顶部标签环出现「音乐」即成功。

- 这一条命令完成全部装配：下载插件、安装依赖（music-metadata）、把插件注册进 profile 的 bundles 装配层——**无需克隆仓库、无需手动改 JSON、无需建软链**
- 想锁定版本：`github:heshuren371/dsh-music-player#v0.3.2`
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

重启 `dsh web` 即彻底移除（装配层自动清理）。卸载不会动你的任何音乐文件——插件从头到尾只读。

---

## 开发者安装（克隆 + link）

要改插件代码、让改动随重启/热重载生效，用 link 方式：

```bash
git clone https://github.com/heshuren371/dsh-music-player.git
cd dsh-music-player && npm install
cd ..
dsh plugin --profile web add link:./dsh-music-player
```

- link 方式不会自动安装插件依赖，克隆目录里的 `npm install` 必须做（会安装唯一的运行时依赖 `music-metadata`，看到 `node_modules/` 出现即成功）
- 装配后**不要移动或删除克隆目录**——profile 通过链接指向这个位置，移动后插件失效
- 改完代码让改动生效（二选一）：装有 [dsh-super-injector](https://github.com/deepseek-harness/dsh-external) 时在对话里说 `调用 dev_reload_package，packageName 填 dsh-music-player`，然后刷新浏览器页面；否则重启 `dsh web`

### 看不到「音乐」标签？

按顺序排查：

1. 浏览器有没有刷新
2. `dsh plugin --profile web ls` 输出里有没有 `@local/dsh-music-player`
3. profile 的 `package.json` 里 `dsh.profile.bundles` 数组有没有包名（`dsh plugin add` 会自动写入，正常不需要手改）
4. （仅 link 方式）克隆目录里有没有 `node_modules/`

> 已经用旧的手动方式（改 JSON + 软链）装过？可以保留不动，也可以 `dsh plugin --profile web remove @local/dsh-music-player` 后用上面的快速安装重装。克隆目录里的 `lib/state.json` 记录着你选择的音乐目录，删除克隆目录即清空最后痕迹。

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

## 结构 / Structure

```
lib/index.js   宿主端：目录扫描 + music-metadata 标签解析 + Range 流媒体路由
lib/client.js  客户端：conversation.view 槽位注册「音乐」视图（React via __ModuleLoader__）
```

## License

[MIT](./LICENSE)
