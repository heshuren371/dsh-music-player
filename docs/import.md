# 从链接导入音频 / 视频

把公开的视频页面链接（B 站、YouTube、Vimeo、SoundCloud）下载到**当前音乐目录**，随后由普通扫描进入播放列表。音频是 MP3；视频是 MP4，作为 `kind=video` 的 MV 曲目交给现有的 MV 播放/转码链路。视频可在下载前选择清晰度；B 站 1080P 通常需要登录，可在弹层里用手机扫码登录。

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

B 站登录是可选的：不登录也能下载公开的较低清晰度；登录只走 B 站官方二维码，不在本插件里输入密码。

## 使用

1. 选定音乐目录（导入只写这个目录）。
2. 点工具栏的「从链接导入」。
3. 粘贴链接，选「音频」或「视频」。视频会先解析可用清晰度（约 0.7s 防抖）。
4. 选清晰度（默认推荐 1080P，可改自动最佳或更高档）；B 站可点「扫码登录」提升可见档位。
5. 点「开始导入」；进度条显示百分比与速度，完成后曲目自动进入列表。视频会显示 MV 标识。

同一时间只允许一个导入任务。任务运行中可以取消；关闭弹层/切走视图不会中断宿主任务，重新打开弹层会恢复最近任务状态。

## 清晰度与 B 站登录

- 「清晰度」下拉列出 `yt-dlp -J` 解析到的每个高度（同一高度只保留最好的一条格式），带 fps 与预估体积。默认推荐 **1080P**，避免一上来就下 4K；「自动（最佳可用）」仍可选。
- 下载格式是 `bestvideo[height<=H]+bestaudio/best[height<=H]`；选了某一档但该视频没有这一档时，yt-dlp 会取不超过它的最高档。
- B 站 1080P 以上通常要求登录。点「扫码登录」会生成**本地绘制**的二维码（B 站官方 QR 端点，不经过第三方图床）；用 B 站 App 扫码并在手机上确认。
- 登录成功后 cookie 写到 `$DSH_HOME/storages/dsh-music-bilibili.cookies`，权限 `0600`，只交给 B 站的 yt-dlp 调用；**不会下发到页面、不会写日志、不会上传**。点「退出登录」立即删除。
- 登录只代表用**你自己的账号**访问你有权访问的清晰度；会员/付费墙/DRM 内容不会因此被绕过。

## 输出与标签

- 临时文件使用音乐目录内的 `.dshm-import-<uuid>.*` 前缀；成功或失败都会清理。
- 最终文件名为 `作者 - 标题.<ext>`（作者未知时只留标题），重名时自动加序号。
- 作者取 `uploader` / `channel` / `creator` 的第一个非空值，标题取 `title`；时长来自 `yt-dlp` 元数据。
- 封面来自 `--write-thumbnail --convert-thumbnails jpg`，经现有原子标签写入嵌入文件；标签/封面写入失败时**文件仍保留**并报告 warning，不把失败说成成功。
- 下载完成后设置 `library = null` 并重新扫描当前目录，列表随下一次 `/library` 刷新。

## 边界与安全

- 只接受 `https`、无凭据、标准端口的链接；主机白名单见 `lib/host.js` 的 `IMPORT_HOSTS`（youtube.com / youtu.be / bilibili.com / b23.tv / vimeo.com / soundcloud.com 及其常见子域）。
- 不读取浏览器 cookie、不导入账号密码，也不使用 `--cookies-from-browser` / `--username` / `--password`。B 站只支持官方扫码登录，cookie 保存在本机并只用于 B 站；会员/付费墙/DRM 内容不绕过，受保护内容会以 yt-dlp 的错误返回。
- 文件只写当前音乐目录；所有写入路径都经过 `authorize('fs.write', …, [currentDir])`。错误文本会去掉本地目录，不下发绝对路径。
- 单文件上限 2 GiB，单任务超时 20 分钟；`yt-dlp` 以 `--ignore-config` 启动，避免用户级 yt-dlp 配置注入额外参数。
- 停用/热重载时杀掉在飞的 `yt-dlp` 子进程并清理临时前缀，避免孤儿进程。
- 任务快照只含标题/作者/文件名/进度/错误等展示字段，不含本地绝对路径；完成任务在宿主内存保留 1 小时。

**只下载你拥有版权或已获授权的内容，并遵守对应平台的服务条款。** 本功能是通用下载入口，不替用户判断授权。

## 端点

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/dsh-music/import` | 能力探测（yt-dlp/ffmpeg/白名单）+ 最近任务；`?id=` 查指定任务 |
| `POST` | `/api/dsh-music/import` | 启动任务：`{ url, kind: "audio" \| "video", height?: number }` |
| `POST` | `/api/dsh-music/import-cancel` | 取消任务：`{ id }` |
| `POST` | `/api/dsh-music/import-probe` | 解析标题/作者/可用清晰度与推荐档（`{ url }`） |
| `GET` | `/api/dsh-music/import-auth` | B 站登录状态 |
| `POST` | `/api/dsh-music/import-auth` | `{ action: "qr" \| "poll" \| "logout", key? }` |

## 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `yt-dlp 未安装` | 按上面的 brew 命令安装，或设置 `DSH_MUSIC_YTDLP` |
| `ffmpeg 未安装` | 音频转 MP3、视频合并、封面转 jpg 都需要它 |
| 链接被拒 | 只支持公开平台白名单与 https；短链先展开成 `https://` |
| B 站看不到 1080P | 先扫码登录；仍没有则是账号权限/地区/会员限制，不绕过 |
| 二维码过期 | 点「刷新二维码」重新生成；二维码 3 分钟内有效 |
| 403 / Forbidden | 先升级 yt-dlp（`brew upgrade yt-dlp`）并确认 `yt-dlp --version` 是期望版本（多来源安装可用 `brew link --overwrite yt-dlp`）；若仍失败，多为需要登录/会员/地区限制，本功能不绕过 |
| 下载完成但标签未写入 | 容器/编码不支持标签；文件保留，warning 会说明原因 |
| 列表暂时没出现 | 等下一次扫描完成，或点刷新按钮 |

回归门禁：`scripts/test-import.mjs`（注册在 `scripts/run-all.mjs`）。
