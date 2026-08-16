# dsh-music-player

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 界面的本地音乐播放器插件。在会话视图标签环（对话 / 轨迹 / …）中注册「音乐」标签页（位于「轨迹」之后），UI 参考 macOS 自带 Music 应用。

A local music player plugin for the DeepSeek Harness Web GUI — adds a **音乐 (Music)** tab to the conversation view ring, styled after the macOS Music app.

## 功能 / Features

- 📁 选择本地目录（macOS 原生目录选择器），递归扫描常见音频格式：**flac / mp3 / m4a / aac / ogg / opus / wav**
- 🎵 列表展示：歌曲名、歌手（内嵌标签解析，缺省回退「歌手 - 歌名」文件名约定）、时长
- 🔁 播放模式：单曲循环 / 列表循环（无随机播放、无歌词页——刻意保持简单）
- 🎚️ macOS Music 风格进度条：填充式进度、rAF 逐帧平滑走动、悬停加粗变色、拖拽松手才 seek
- ⏯️ 切换标签页音乐不中断（`<audio>` 元素驻留模块级单例）
- 💾 目录选择持久化（`lib/state.json`），重启自动恢复并后台扫描
- 🎨 全量使用 DSH 设计变量（`--dsw-alias-*`），明暗主题自适应
- 🌊 Range 流式传输，大文件拖动进度条秒跳
- 🧩 标准 bundle 插件：进插件清单、可热重载、卸载即净

## 安装 / Install

```bash
git clone https://github.com/heshuren371/dsh-music-player.git
cd dsh-music-player
npm install
```

然后装配到 DSH web profile（二选一）：

**方式一：dsh-super-injector（推荐，免重启）**

在 DSH 会话中让 Agent 调用：

```
dev_install_package(dir="<本仓库绝对路径>", profile="web")
```

**方式二：手动装配**

1. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 中加入：
   `"@local/dsh-music-player": "link:<本仓库绝对路径>"`
2. 同文件 `bundles` 数组加入 `"@local/dsh-music-player"`
3. 在 `~/.dsh/profiles/web/node_modules/` 建立指向本仓库的软链接
4. 重启 `dsh web`

刷新 http://127.0.0.1:3080 ，打开任意会话即可看到「音乐」标签。

## HTTP API

宿主端在 Web 服务器注册 `/dsh-music` 前缀路由：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/dsh-music/api/library` | GET | 当前目录 + 曲目列表 |
| `/dsh-music/api/refresh` | POST | 重新扫描当前目录 |
| `/dsh-music/api/dir` | POST | `{ "dir": "..." }` 设置目录并扫描 |
| `/dsh-music/api/pick` | POST | 弹原生目录选择器，选定后扫描 |
| `/dsh-music/api/stream?i=N` | GET | 按索引流式传输曲目（支持 Range / 206） |

## 结构 / Structure

```
lib/index.js   宿主端：目录扫描 + music-metadata 标签解析 + Range 流媒体路由
lib/client.js  客户端：conversation.view 槽位注册「音乐」视图（React via __ModuleLoader__）
```

## License

[MIT](./LICENSE)
