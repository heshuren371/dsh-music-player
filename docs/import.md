# 从链接导入音频 / 视频

把公开的视频页面链接（B 站、YouTube、Vimeo、SoundCloud）下载到**当前音乐目录**，随后由普通扫描进入播放列表。音频是 MP3；视频是 MP4，作为 `kind=video` 的 MV 曲目交给现有的 MV 播放/转码链路。

## 前提

需要 `yt-dlp` 与 `ffmpeg` 都在 `PATH` 上（或通过环境变量指定）：

```sh
# macOS
brew install yt-dlp ffmpeg

# 或在启动 dsh 前显式指定
export DSH_MUSIC_YTDLP=/path/to/yt-dlp
export DSH_MUSIC_FFMPEG=/path/to/ffmpeg
```

界面的「从链接导入」按钮会先报告缺哪个工具；缺工具时不会启动任务。

## 使用

1. 选定音乐目录（导入只写这个目录）。
2. 点工具栏的「从链接导入」。
3. 粘贴链接，选「音频」或「视频」，点「开始导入」。
4. 进度条显示下载百分比与速度；完成后曲目自动出现在列表里。视频会显示 MV 标识。

同一时间只允许一个导入任务。任务运行中可以取消；关闭弹层/切走视图不会中断宿主任务，重新打开弹层会恢复最近任务状态。

## 输出与标签

- 临时文件使用音乐目录内的 `.dshm-import-<uuid>.*` 前缀；成功或失败都会清理。
- 最终文件名为 `作者 - 标题.<ext>`（作者未知时只留标题），重名时自动加序号。
- 作者取 `uploader` / `channel` / `creator` 的第一个非空值，标题取 `title`；时长来自 `yt-dlp` 元数据。
- 封面来自 `--write-thumbnail --convert-thumbnails jpg`，经现有原子标签写入嵌入文件；标签/封面写入失败时**文件仍保留**并报告 warning，不把失败说成成功。
- 下载完成后设置 `library = null` 并重新扫描当前目录，列表随下一次 `/library` 刷新。

## 边界与安全

- 只接受 `https`、无凭据、标准端口的链接；主机白名单见 `lib/host.js` 的 `IMPORT_HOSTS`（youtube.com / youtu.be / bilibili.com / b23.tv / vimeo.com / soundcloud.com 及其常见子域）。
- 不读取浏览器 cookie、不调用登录态、不处理付费墙或 DRM，也不使用 yt-dlp 的 `--cookies-from-browser` / `--username` / `--password`。受保护内容会以 yt-dlp 的错误返回，不会静默绕过。
- 文件只写当前音乐目录；所有写入路径都经过 `authorize('fs.write', …, [currentDir])`。错误文本会去掉本地目录，不下发绝对路径。
- 单文件上限 2 GiB，单任务超时 20 分钟；`yt-dlp` 以 `--ignore-config` 启动，避免用户级 yt-dlp 配置注入额外参数。
- 停用/热重载时杀掉在飞的 `yt-dlp` 子进程并清理临时前缀，避免孤儿进程。
- 任务快照只含标题/作者/文件名/进度/错误等展示字段，不含本地绝对路径；完成任务在宿主内存保留 1 小时。

**只下载你拥有版权或已获授权的内容，并遵守对应平台的服务条款。** 本功能是通用下载入口，不替用户判断授权。

## 端点

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/dsh-music/import` | 能力探测（yt-dlp/ffmpeg/白名单）+ 最近任务；`?id=` 查指定任务 |
| `POST` | `/api/dsh-music/import` | 启动任务：`{ url, kind: "audio" \| "video" }` |
| `POST` | `/api/dsh-music/import-cancel` | 取消任务：`{ id }` |

## 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `yt-dlp 未安装` | 按上面的 brew 命令安装，或设置 `DSH_MUSIC_YTDLP` |
| `ffmpeg 未安装` | 音频转 MP3、视频合并、封面转 jpg 都需要它 |
| 链接被拒 | 只支持公开平台白名单与 https；短链先展开成 `https://` |
| 403 / Forbidden | 先升级 yt-dlp（`brew upgrade yt-dlp`）并确认 `yt-dlp --version` 是期望版本（多来源安装可用 `brew link --overwrite yt-dlp`）；若仍失败，多为需要登录/会员/地区限制，本功能不绕过 |
| 下载完成但标签未写入 | 容器/编码不支持标签；文件保留，warning 会说明原因 |
| 列表暂时没出现 | 等下一次扫描完成，或点刷新按钮 |

回归门禁：`scripts/test-import.mjs`（注册在 `scripts/run-all.mjs`）。
