# dsh-music-player

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 界面的本地音乐播放器插件。在会话视图标签环（对话 / 轨迹 / …）中注册「音乐」标签页（位于「轨迹」之后），UI 参考 macOS 自带 Music 应用。

A local music player plugin for the DeepSeek Harness Web GUI — adds a **音乐 (Music)** tab to the conversation view ring, styled after the macOS Music app.

## 功能 / Features

- 📁 选择本地目录（原生目录选择器，**macOS / Windows / Linux 均支持**；也可点标题栏 ⌨ 按钮手动粘贴路径，如 `D:\Music`），递归扫描常见音频格式：**flac / mp3 / m4a / aac / ogg / opus / wav**
- 🎵 列表展示：歌曲名、歌手（内嵌标签解析，缺省回退「歌手 - 歌名」文件名约定）、时长
- 🔁 播放模式：单曲循环 / 列表循环（无随机播放、无歌词页——刻意保持简单）
- 🔀 列头排序：歌名 / 歌手 / 时长，升降序切换，刷新后记忆
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

## 安装 / Install

```bash
git clone https://github.com/heshuren371/dsh-music-player.git
cd dsh-music-player
npm install
```

然后装配到 DSH web profile（二选一）：

**方式一：dsh-super-injector（推荐，免重启）**

先克隆到本地，然后在 DSH 会话中让 Agent 调用（`dir` 为**本地克隆路径**）：

```
git clone https://github.com/heshuren371/dsh-music-player.git
# 在 DSH 会话中：
dev_install_package(dir="<本地克隆绝对路径，如 ~/dev/dsh-music-player>", profile="web")
```

**方式二：手动装配**

1. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 中加入：
   `"@local/dsh-music-player": "link:<本地克隆绝对路径>"`（link 协议只支持本地路径）
2. 同文件 `bundles` 数组加入 `"@local/dsh-music-player"`
3. 在 `~/.dsh/profiles/web/node_modules/` 建立指向本地克隆目录的软链接（Windows 用目录联接 `mklink /J`）
4. 重启 `dsh web`

刷新 http://127.0.0.1:3080 ，打开任意会话即可看到「音乐」标签。

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
