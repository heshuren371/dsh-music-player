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

---

## 安装教程（详细版）

### 第 0 步：确认前置条件

| 依赖 | 检查命令 | 说明 |
| --- | --- | --- |
| DSH 已安装并能打开 Web 界面 | 浏览器能访问 <http://127.0.0.1:3080> | 还没装 DSH 的话先装：`npm i -g @deepseek-ai/dsh`，然后 `dsh web` |
| git | `git --version` | 用来克隆仓库 |
| Node.js ≥ 22 | `node -v` | 与 DSH 运行要求一致 |

> 下文默认你的 DSH profile 是 **web**（默认就是）。插件文件在磁盘上的位置**任意**，但克隆之后**不要移动或删除**它——profile 通过链接指向这个位置，移动后插件会失效。

### 第 1 步：克隆并安装依赖

```bash
# 选一个你喜欢的位置，例如：
git clone https://github.com/heshuren371/dsh-music-player.git
cd dsh-music-player
npm install
```

`npm install` 会安装唯一的运行时依赖 `music-metadata`（解析歌曲名/歌手/时长用）。看到 `node_modules/` 目录出现即成功。

### 第 2 步：装配到 DSH（二选一）

#### 方式 A：让 DSH 的 Agent 替你装（推荐，免重启）

前提：你的 DSH 里装有 [dsh-super-injector](https://github.com/deepseek-harness/dsh-external)（提供 `dev_*` 装配工具的环境）。

在 DSH 对话框里直接对 Agent 说（把路径换成你**第 1 步的实际克隆路径**）：

```
调用 dev_install_package，dir 填 /你的/实际路径/dsh-music-player，profile 填 web
```

macOS / Linux 路径示例：`/home/you/dev/dsh-music-player`
Windows 路径示例：`C:\Users\you\dev\dsh-music-player`

Agent 会完成：写 profile 依赖 → 建链接 → 热加载。**刷新浏览器页面**即可看到「音乐」标签。

#### 方式 B：手动装配（任何环境都行，需重启一次）

1. 打开 profile 配置文件：
   - macOS / Linux：`~/.dsh/profiles/web/package.json`
   - Windows：`C:\Users\你的用户名\.dsh\profiles\web\package.json`

2. 在 `dependencies` 里加一行（路径是第 1 步的克隆路径；JSON 里 Windows 路径的反斜杠要写成 `\\` 或改用 `/`）：

   ```json
   "dependencies": {
     "@local/dsh-music-player": "link:/home/you/dev/dsh-music-player"
   }
   ```

3. 同一个文件里，把包名加进 bundles 列表（在 `dsh.profile.bundles` 数组中）：

   ```json
   "dsh": { "profile": { "bundles": ["@local/dsh-music-player"] } }
   ```

4. 建立链接（让 profile 的 node_modules 能找到插件）：

   ```bash
   # macOS / Linux：
   ln -s /home/you/dev/dsh-music-player ~/.dsh/profiles/web/node_modules/@local/dsh-music-player

   # Windows（管理员 cmd，用目录联接）：
   mklink /J "C:\Users\你的用户名\.dsh\profiles\web\node_modules\@local\dsh-music-player" "C:\Users\you\dev\dsh-music-player"
   ```

5. 重启 `dsh web`。

### 第 3 步：验证安装

1. 浏览器**刷新** <http://127.0.0.1:3080>
2. 打开任意会话，顶部标签应是：**对话 / 轨迹 / 音乐**
3. 点「音乐」→「选择目录」，选中你放歌的文件夹即可

看不到「音乐」标签？按顺序排查：① 浏览器有没有刷新；② profile package.json 里 `bundles` 数组有没有包名；③ 链接是否建好（`ls ~/.dsh/profiles/web/node_modules/@local/dsh-music-player` 能列出文件）；④ 克隆目录里有没有 `npm install`。

---

## 更新命令

```bash
cd /你的/克隆路径/dsh-music-player
git pull
npm install        # 依赖有变化时才真正需要，执行了也无害
```

然后让改动生效（二选一）：

- **免重启（有 super-injector）**：在 DSH 对话里说 `调用 dev_reload_package，packageName 填 dsh-music-player`，然后刷新浏览器页面
- **重启**：重启 `dsh web`

---

## 卸载命令

### 有 super-injector（先热卸载）

1. 在 DSH 对话里说：`调用 dev_uninject_plugin，match 填 dsh-music-player` —— 立即生效，标签页消失
2. 再做一次「手动卸载」的第 1、2 步清理配置，防止重启后装回

### 手动卸载（彻底清理）

1. 打开 `~/.dsh/profiles/web/package.json`（Windows 见上文路径），**删除两行**：
   - `dependencies` 里的 `"@local/dsh-music-player": "link:..."`
   - `dsh.profile.bundles` 数组里的 `"@local/dsh-music-player"`
2. 删除链接：
   ```bash
   # macOS / Linux：
   rm ~/.dsh/profiles/web/node_modules/@local/dsh-music-player
   # Windows（cmd）：
   rmdir "C:\Users\你的用户名\.dsh\profiles\web\node_modules\@local\dsh-music-player"
   ```
3. 重启 `dsh web`
4. （可选）删除克隆目录。克隆目录里的 `lib/state.json` 记录着你选择的音乐目录，删除即彻底清空痕迹

> 卸载不会动你的任何音乐文件——插件从头到尾只读。

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
