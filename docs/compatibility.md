# 兼容性、依赖与权限边界

面向 DSH STORE 的自动收录 / 人工复核，以及供应链与权限审查。

> 本节声明**只说明插件面向哪条 DSH 线、哪些版本真的跑过验收**，不等于任何真实 Profile 的安装 / 启动 / 运行验收。
> **权威值是 `package.json` 与 `dsh-plugin.json` 的实际字段，以及 `lib/` 的运行时代码**；本文逐条解释它们对应什么行为、什么时候触发。

## 1. 声明位置与取值

| 项 | 位置 | 值 |
| --- | --- | --- |
| Node.js 兼容范围 | `package.json` → `engines.node` | `^22.19.0 \|\| >=24.0.0` |
| DSH 兼容范围（描述性） | `package.json` → `dsh.compatibility.dsh` | `>=0.1.6-alpha.1 <0.2.0` |
| DSH 精确记录（证据） | `package.json` → `dsh.compatibility.dshReleases` | 逐版本 `compatible` / `incompatible` / `unknown` |

```json
"engines": { "node": "^22.19.0 || >=24.0.0" },
"dsh": {
  "compatibility": {
    "dsh": ">=0.1.6-alpha.1 <0.2.0",
    "dshReleases": {
      "0.1.7-alpha.2": "unknown",
      "0.1.7-rc.1": "unknown",
      "0.1.7-rc.2": "compatible"
    }
  }
}
```

**为什么 Node 范围是这个值**：它与 DSH 宿主根包 `@deepseek-ai/dsh-root` 自身声明的 `engines.node` 完全一致（插件只能跑在 DSH 提供的 Node 运行时里，不单独面向通用 Node 环境）；本机随包运行时实测为 **Node v24.21.0**。

## 2. 每条精确记录的依据

| DSH 版本 | 状态 | 依据 |
| --- | --- | --- |
| `0.1.7-rc.2` | `compatible` | 当前开发与实测宿主（本机 `$DSH_HOME/dsh-auto-update/runtime.json` 的 active slot = `0.1.7-rc.2`，commit `477b4f42`）。`npm test` 全部 **24 套**回归在该运行时 + Node v24.21.0 上逐套通过（含 desktop `/api` 路由、声明面三向一致性、插件生命周期、宿主热重载、安全/越界、MV ffmpeg 换壳、客户端 shell）。**不含真实浏览器断言**——客户端套件全部跑 jsdom |
| `0.1.7-rc.1` | `unknown` | 升级路径上的上一格，未单独跑过验收 |
| `0.1.7-alpha.2` | `unknown` | 未单独跑过验收 |

> **范围 ≠ 证据。** 范围允许的版本仍可能是 `unknown`：`0.1.7-alpha.2` / `0.1.7-rc.1` 都落在 `>=0.1.6-alpha.1 <0.2.0` 里，但没跑过验收就不写 `compatible`。DSH STORE 也只把**精确记录**当兼容证据，范围命中仅显示「范围支持·待验证」。
> 只主张一个版本是**有意**的：没验证过的不写 `compatible`。

## 3. 尚未提供的证据

`install` / `start` / `uninstall` / `rollback` 四项**一次性 Profile 证据尚未提供**，因此 `dsh.compatibility.dshOperations` 保持缺省（记为 `unknown`）。

本仓库的回归套件是**进程内**验证，不能替代一次性 Profile 的真实装卸。要补齐需要在一个可丢弃的 profile 里真装、真起、真卸一次，并把记录写进 `dshOperations`。

## 4. 已知的兼容断点

`x-dsh-transition`（`dsh-plugin.json`）逐条记录了跨版本变过的三处接缝。**升级 DSH 后应按运行中的应用核对，而不是按本地 checkout**：

| 接缝 | 0.1.6 时代 | 0.1.7 起 |
| --- | --- | --- |
| `dsh.client.platform` | 写死 `'web'` | 写死 `'web'`（**不存在** `'desktop'`） |
| `ctx.webServer` | 不存在（desktop-host patch 里 `disabled: true`） | 存在（`runProfile` 起完整 Web 运行时） |
| 官方图标导出名 | `IconXxx16` | `IconXxxRegular` / `IconXxxMedium` |

插件对这三处的处理是**运行时探测 + 双形态回落**，不靠静态 `inject` 绑定宿主服务。细节见 [desktop.md](desktop.md)。

## 5. 运行时依赖（npm）

| 依赖 | 用途 | 不可用 / 失败时的行为 |
| --- | --- | --- |
| `music-metadata` | 解析音频标签与时长 | 该文件降级为文件名回退（「歌手 - 歌名」约定） |
| `node-taglib-sharp` | 写入标签（跑在 worker 线程） | 该曲目报错，**不改名、不改文件** |
| `mediabunny` | MV 容器 / 编码探测 | 该曲目按 direct play 处理；探测失败则不播 MV |
| `@libav.js/variant-webcodecs`、`libavjs-webcodecs-polyfill` | 无 ffmpeg 时的浏览器内转码兜底 | 退回「提示安装 ffmpeg」 |

全部是运行时依赖。**没有** `install` / `prepare` / `postinstall` / `prepublish` 等生命周期脚本——`package.json` 的 `scripts` 只声明 `test` 与 `check:manifest`。（`scripts/` 下的 `.mjs` 是开发者手动执行的回归与预览工具，不会被宿主自动执行。）

## 6. 权限 ↔ 代码信号 ↔ 触发条件

| 权限 | 代码信号 | 什么时候才会发生 |
| --- | --- | --- |
| `fs.read` | `lib/host.js`：目录递归扫描、`createReadStream` 做 Range 流式读取 | 你选定音乐目录之后 |
| `fs.write` | `lib/host.js` + `lib/tagwriter.js`：写标签、写封面、按「歌手 - 原名」重命名 | 只在「写入标签并重命名文件」流程里，且需你确认；取消勾选则只改应用内显示 |
| `fs.delete` | `lib/host.js`：`fs.unlink` **永久删除**（不进废纸篓） | 只在删除确认条里点「删除」后，且只作用于**当前库内**曲目，越界一律拒绝 |
| `net.fetch` | 在线补全元数据、封面代理 | 你点「✦」/「一键补全全部」，或需要取封面时 |
| `transport.api` | `connection.fetch` 上的精确 `/api/dsh-music/*` 路由 | 插件激活时注册，供 Web 与 Desktop 共用 |
| `storage.local` | `$DSH_HOME/storages/dsh-music-player.json`（兼容旧的包内 `lib/state.json`）+ `localStorage`（`dsh-music:*` 前缀） | 记住目录、最后播放曲目与进度、音量/循环/排序偏好 |

**关于 `node:child_process`**：`lib/host.js` 确实 `import { spawn, spawnSync } from 'node:child_process'`，但**没有 shell 执行能力**——只用来调 `ffmpeg` / `ffprobe`。可执行文件按 `DSH_MUSIC_FFMPEG` → Homebrew / MacPorts → `PATH` 的顺序探测，参数由插件拼成数组直传（**不经过 shell**），输入是本地已扫描到的媒体文件路径，MV 转码产物写到 `os.tmpdir()/dsh-music-mv`。**没有 ffmpeg 也能用**：直出格式照常播，需要换壳/转码的给安装提示。

**副作用位置的授权检查**：`lib/host.js` 的 `authorize(action, targetPath, scopes)` 在**每个** `fs.unlink` / `fs.rename` / `fs.rm` 调用点校验目标落在已声明 scope 内（音乐目录 / 状态目录 / MV 缓存 / 回收站），不依赖上游栅栏。`scripts/test-audit.mjs` 强制「每个 mutation 都必须过 `authorize`」。

> ⚠️ 这是**插件自建**的授权面。DSH 目前没有向插件暴露 permission grant 查询 API，因此 `dsh-plugin.json` 的 `permissions` 是**对外声明**，运行时由上述自建检查兜底。上游一旦提供标准 grant API，这里应改为查询该 API。

**读取的环境变量**：`DSH_HOME`、`DSH_MUSIC_FFMPEG`、`DSH_MUSIC_ITUNES_COUNTRY`、`PATH`。不读 shell 配置、不读 keychain、不读浏览器 profile。

## 7. 外部服务

全部 HTTPS，**没有任何上传**：出网的只有搜索词与查询参数，本地文件、文件名、标签、目录结构都不出网。

| 用途 | 主机 |
| --- | --- |
| 元数据搜索 | `c.y.qq.com`、`itunes.apple.com`、`music.163.com`、`musicbrainz.org` |
| 封面取图（宿主代理） | `mzstatic.com`（含 `*.mzstatic.com`）、`gtimg.cn`（含 `*.gtimg.cn`）、`music.126.net`（含 `*.music.126.net`）、`coverartarchive.org`、`archive.org`（CAA 会 302 过去） |

封面代理走**主机白名单**并逐跳校验重定向（≤4 跳）；MusicBrainz 全局限速 1 req/s 排队；单个数据源连续失败 2 次自动熔断 60s。

## 8. 失败边界

| 失败情形 | 结果 |
| --- | --- |
| 某个在线源超时 / 报错 / 429 | 该源熔断 60s，其余源照常；匹配并发上限 2 |
| 没有 ffmpeg / ffprobe | MV 直出格式照常播；需要换壳或转码的给出安装提示 |
| 标签写入失败 | 该曲目报错，不改名、不动文件 |
| 目录不可读 / 被移动 | 扫描回报错误，不影响其他端点 |
| 曲库过大 | 扫描超 5000 首截断并显式提示 |
| 非回环 / 跨站请求 | `403`；`system-*` token 端点例外（只认 token，且要求 Host 回环） |
| 库外路径 / `..` 逃逸 | 拒绝（`scripts/test-stream.mjs`、`test-security.mjs` 覆盖） |

> 注明：MV 套件（`scripts/test-mv.mjs`）会真实调用 ffmpeg；**匹配套件是离线测试**——`scripts/test-match.mjs:5` 自述 hermetic，并在 `:45-108` 替换 `globalThis.fetch`（只放行 `127.0.0.1`/`localhost`），`scripts/test-match-client.mjs:80-81` 同样打桩。DSH STORE 的静态检查本身不执行这些脚本。
