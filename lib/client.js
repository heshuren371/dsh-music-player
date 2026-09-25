"use strict";
/**
 * ── 就地类型声明 ────────────────────────────────────────────────────────────
 * 本文件**必须保持零 import**：客户端 bundle 由宿主在浏览器里 eval
 * （`window.__ModuleLoader__`），import 解析不了（AGENTS.md §2.15）。所以宿主
 * 注入的全局对象、payload 形状与 player API 全部就地声明在这里。
 */
window.__ModuleLoader__.load({
    id: "@local/dsh-music-player",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        const React = require("react");
        const h = React.createElement;
        const { useEffect, useRef, useState, useSyncExternalStore } = React;
        /**
         * DSH 内置图标与 Tooltip，来自平台种子模块
         * `@deepseek-ai/dsh-client-ui-primitives`（client/web/src/platform.ts 的
         * PLATFORM_MODULES 之一）：它在 shell 启动时就注入了冻结模块表，所以这里的
         * require 必定命中 shell 的那一份实例——图标 SVG 与 Tooltip 的 CSS Module
         * 都已经随 shell 加载，插件不必再自带一份样式，悬停气泡因此和 DSH 官方
         * 完全同源。
         * 用 try/catch 兜底：万一宿主没有该种子模块，退回自绘图标 + 原生 title，
         * 绝不因为一个装饰性依赖白屏。
         */
        let Tooltip = null;
        let DshInput = null;
        let dsIcons = {};
        try {
            const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
            Tooltip = typeof primitives.Tooltip === "function" ? primitives.Tooltip : null;
            DshInput = typeof primitives.Input === "function" ? primitives.Input : null;
            dsIcons = primitives;
        }
        catch {
            // 老宿主/受限模块表：保持原有图标与 title 提示。
        }
        /**
         * 官方图标在 DSH 0.1.6 与 0.1.7 之间换过整套命名：
         *   0.1.6（ic_ds_* 时代）IconPlayOutline16 / IconFolderOpen16 / IconSparkle16
         *   0.1.7+（权重体系）   IconPlayOutlineRegular|Medium / IconFolderOpenRegular / IconSparkleRegular
         * 名字对不上时必须显式回退，不能静默——之前只写了 0.1.6 的名字，在 0.1.7 上
         * 全部解析失败、悄悄退回自绘 SVG，表现就是「界面什么都没变」。
         * 这里按候选名依次探测，命中即用，全都没有才用自绘 SVG。
         */
        const officialIcon = (candidates, size, fallback) => {
            for (const exportName of candidates) {
                const Component = dsIcons[exportName];
                if (typeof Component === "function")
                    return h(Component, { size });
            }
            return fallback;
        };
        const NS = "dsh-music-player";
        /**
         * 宿主端点基址。必须是 /api 之下：DSH Desktop 的 Electron 自定义协议只把
         * /api/* 转给宿主进程，其余路径按静态资源回落到 index.html；Web 侧
         * @deepseek-ai/dsh-client-connection 也只把 /api 前缀接到连接层。
         * 因此同一个基址在 dsh web 与 dsh desktop 上都是同源的。
         */
        const API_BASE = "/api/dsh-music";
        /** 旧版宿主入口的前缀（`/dsh-music/api/library`），仅用于一次性回落探测。 */
        const LEGACY_API_BASE = "/dsh-music/api";
        /**
         * 当前有效的宿主基址。首选 API_BASE；如果宿主进程还是旧版入口（只注册了
         * /dsh-music 前缀），首次请求会 404 —— 此时自动切到 LEGACY_API_BASE 并只探一次，
         * 避免「客户端 bundle 已随刷新更新、宿主入口却要重启进程」这一窗口期直接报错。
         */
        let endpointBase = API_BASE;
        /**
         * 是否已确认当前入口可用。**只在采纳成功时置位**：探测失败不置位，下一次仍可
         * 重试（原实现在探测**之前**置一次性标志，失败一次就永久失去回落机会）。
         */
        let entryResolved = false;
        /**
         * 是否降级到了旧前缀。这是**信任模型降级**：从 `/api` 的连接层 Host/Origin
         * 栅栏 + 浏览器会话，退到插件自建的栅栏 —— `composition.zh.md:143` 要求偏离
         * 计划必须被报告，不能顺带发生，所以这里留一个可观察的状态位（A1-02）。
         */
        let downgradedToLegacy = false;
        /** 降级发生时的通知槽：状态对象在 api() 之后才创建，所以用晚绑定。 */
        let onDowngrade = null;
        /**
         * 这些端点的 404 **只可能**意味着一件事：路由不存在（宿主入口是旧版）—— 它们
         * 在任何健康宿主上都答 200 或业务错误码（409/400/403/500），**不会答 404**。
         *
         * 反过来，`cover`（无内嵌封面）/ `art`（代理失败）/ `mv`·`mvfile`（缓存未命中）/
         * `stream`（文件不在了）/ `match` 的 404 是**正常业务语义**，绝不能拿它们当
         * 「宿主是旧入口」的信号 —— 否则一次「这首歌没封面」就会被误判成入口降级
         * （AGENTS.md §2.8）。所以判据是**端点语义 + 正向识别**，不是裸状态码。
         */
        const ROUTE_MISSING_404_ENDPOINTS = new Set(['library', 'session', 'refresh', 'dir', 'apply', 'pick', 'delete', 'caps', 'mvconvert']);
        /**
         * 旧入口的**正向指纹**：旧前缀必须真答出一个宿主数据对象（非错误信封）才算
         * 认出来了。「不是 404」不算证据。
         */
        const looksLikeHostPayload = (value) => value !== null && typeof value === "object"
            && !Array.isArray(value) && typeof value.error !== "string";
        /**
         * 系统「正在播放」（macOS 状态栏 / 控制中心 / 锁屏）取封面用的**绝对**地址前缀。
         *
         * 两个硬约束叠在一起，Desktop 才需要这套东西：
         *  1. Chromium 的 MediaImage 只收 http/https/data/blob（二进制原话
         *     "MediaImage src can only be of http/https/data/blob scheme"）——
         *     Desktop 页面是 dsh-app://app，相对路径直接被丢掉；
         *  2. 换成回环 http 之后，系统取图又是**浏览器内部发起**的，带着发起页的痕迹
         *     （实测 `Origin: dsh-app://app` / `Sec-Fetch-Site: cross-site`），
         *     会被插件自己的 Host/Origin 栅栏判 403 —— 页面也补不了这个头。
         *
         * 所以宿主专门开了 token 端点（/dsh-music/api/system-art?t=…）：随机 token 即
         * 能力凭证，只认 token 不看 Host/Origin，token 只随鉴权过的 /session 发给本页。
         * 这里拿到的就是带 token 的绝对基址；Web 端继续用同源地址（本来就正常）。
         */
        let systemArtBase = null;
        /**
         * 媒体直连基址（token 版）。Desktop 页面是 dsh-app://，媒体 src 走 Desktop 转发，
         * 而转发会让流丢掉 Range/206 → 浏览器判定"不可 seek"，拖动/快进就回到 0 秒。
         * 用 token 版的绝对回环地址直连，Range 才是真的（和封面取图同一套机制）。
         */
        let systemStreamBase = null;
        let systemArtBasePromise = null;
        /** 上次成功取到 /session 的时间；超过 TTL 就重取（宿主热重载会轮换 token）。 */
        let sessionBaseFetchedAt = 0;
        const SESSION_BASE_TTL_MS = 60 * 1000;
        /** token 基址自愈只做一次，避免「失败→重取→再失败」的死循环。 */
        let sessionBaseHealed = false;
        /** 丢掉缓存的会话基址，下一次 ensureStreamBase/loadSystemArtBase 会重新取。 */
        const invalidateSessionBase = () => {
            systemArtBasePromise = null;
            systemArtBase = null;
            systemStreamBase = null;
            sessionBaseFetchedAt = 0;
        };
        const loadSystemArtBase = (force = false) => {
            // 缓存带 TTL：宿主每次热重载 createHost() 都会（曾经）轮换 token，而客户端把
            // 基址缓存了整个页面生命周期 —— 过期快照会让音频 403 到刷新页面为止。
            if (force)
                sessionBaseFetchedAt = 0;
            if (systemArtBasePromise !== null && Date.now() - sessionBaseFetchedAt < SESSION_BASE_TTL_MS)
                return systemArtBasePromise;
            systemArtBasePromise = (async () => {
                /** 采纳一份 /session 载荷；只有真的拿到基址才算成功（正向识别）。 */
                const adoptSession = (payload) => {
                    if (payload === null || typeof payload !== "object")
                        return false;
                    const p = payload;
                    let got = false;
                    if (typeof p.systemArtBase === "string" && p.systemArtBase.length > 0) {
                        systemArtBase = p.systemArtBase;
                        got = true;
                    }
                    if (typeof p.systemStreamBase === "string" && p.systemStreamBase.length > 0) {
                        systemStreamBase = p.systemStreamBase;
                        got = true;
                    }
                    return got;
                };
                try {
                    if (adoptSession(await api("/api/session"))) {
                        sessionBaseFetchedAt = Date.now();
                        return systemArtBase;
                    }
                }
                catch {
                    // 落到下面用插件自建的回环路由再试一次。
                }
                // ⚠️ 这条回落**只给 /session**，因为它是唯一「以下发回环 token 基址为目的」的
                // 端点 —— 那个基址存在的意义就是绕开平台 /api 的栅栏，让 Chromium 内部发起的
                // 取图/取媒体能走通。所以它有资格自己走插件自建的回环路由。
                //
                // 为什么需要它：平台 /api 的 admit() 在**路由之前**判 Host/Origin 栅栏与浏览器
                // 会话，Desktop 渲染进程拿 /session 会得到 **401/403，而不是 404**。A1-02 的通用
                // 回落只在 404 触发，于是这里永远回落不了 ⇒ 基址恒为空 ⇒ 媒体只能用相对地址
                // ⇒ Desktop 转发丢 Range ⇒ seekable=[0,0] ⇒ **一拖进度条就回 0 秒**（真机读数）。
                // 其余端点不享受这条：把一次普通的 403 洗成降级会破坏信任边界（§2.8）。
                if (endpointBase !== LEGACY_API_BASE) {
                    try {
                        const legacy = await fetch(LEGACY_API_BASE + "/session");
                        const payload = await legacy.json().catch(() => null);
                        if (legacy.ok && adoptSession(payload)) {
                            downgradedToLegacy = true;
                            if (typeof onDowngrade === "function")
                                onDowngrade();
                            sessionBaseFetchedAt = Date.now();
                            return systemArtBase;
                        }
                    }
                    catch {
                        // 两条路都不通：保持无基址，由 healUnseekableSource 继续尝试。
                    }
                }
                return systemArtBase;
            })();
            return systemArtBasePromise;
        };
        /**
         * 平台探测：Desktop 的 app 文档由 preload-app 注入 window.dshDesktop
         * （只有 { protocolVersion } 标记，不带任何 IPC 能力）；Web 上不存在。
         * 官方判据见 apps/desktop/src/preload-app.ts。
         */
        const DESKTOP = typeof window !== "undefined"
            && typeof window.dshDesktop === "object"
            && window.dshDesktop !== null;
        const zh = {
            "view.music": "音乐",
            "action.chooseDir": "选择目录",
            "action.inputDir": "手动输入路径",
            "action.inputDir.placeholder": "粘贴本地目录路径，如 D:\\Music 或 ~/Music",
            "action.confirm": "确定",
            "action.refresh": "刷新",
            "action.delete": "删除",
            "action.cancel": "取消",
            "confirm.delete": (title) => `确定删除「${title}」吗？将同时删除本地文件，此操作不可恢复。`,
            "action.search.placeholder": "搜索歌曲或歌手",
            "action.match.tip": "在线补全原名 / 歌手 / 封面",
            "action.matching": "正在匹配…",
            "action.search": "搜索",
            "match.title": "在线补全元数据",
            "match.none": "没有找到匹配结果，换个关键词或手动填写标签",
            "match.clear": "清除已补全信息",
            "match.source": "结果来自 QQ 音乐 / iTunes / 网易云 / MusicBrainz；勾选后写回标签并重命名文件",
            "action.completeAll": "一键补全",
            "action.stop": "停止",
            "complete.progress": (done, total, failed, skipped) => `补全中… ${done}/${total}`
                + (failed > 0 ? `（失败 ${failed}）` : "")
                + (skipped > 0 ? `（${skipped} 首已正确或置信不足，跳过）` : ""),
            "confirm.complete": (count) => `将逐首检查 ${count} 首歌曲（多源搜索：QQ 音乐 / iTunes / 网易云 / MusicBrainz）：标签已正确的自动跳过，只把高置信度且有差异的结果写入并重命名，置信不足的一律不动；**已有封面不会被覆盖，只补缺失封面**。是否继续？`,
            "complete.none": "没有需要补全的歌曲",
            "match.writeFile": "写入标签并重命名文件",
            "match.applying": "正在写入文件…",
            "action.picking": "正在选择…",
            "action.loading": "正在扫描…",
            "col.title": "歌曲名",
            "col.artist": "歌手",
            "col.duration": "时长",
            "empty.title": "尚未选择音乐目录",
            "empty.hint": "选择一个本地目录，支持 flac / mp3 / m4a / ogg / wav 等常见格式",
            "empty.tracks": "该目录下没有找到音频文件",
            "mode.loop": "列表循环",
            "mode.one": "单曲循环",
            "stats": (count) => `${count} 首歌曲`,
            "stats.truncated": "已达扫描上限",
            "stats.drm": (count) => `${count} 个 DRM 加密包已跳过`,
            "stats.drmTip": "Apple .movpkg 是 FairPlay 加密的 HLS 离线包，任何第三方播放器都无法解密；请在 Apple Music / Apple TV 应用内播放",
            "scan.progress": (parsed, total) => total > 0 ? `正在扫描… ${parsed}/${total}` : `正在扫描… ${parsed}`,
            "error.prefix": "出错了：",
            "error.legacyEntry": "已回落到旧版宿主入口（/dsh-music 前缀）：请求不再经连接层的 Host/Origin 栅栏与浏览器会话鉴权。请重启 dsh 以恢复。",
            "error.unsupported": "无法播放该文件（格式不受支持或文件已移动）",
            "error.staleHost": "宿主插件仍是旧版（没有重载）：请在终端重启 dsh web，然后刷新本页",
            "a11y.progress": "播放进度",
            "action.prev": "上一首",
            "action.next": "下一首",
            "action.play": "播放",
            "action.pause": "暂停",
            "action.volume": "音量",
            "player.open": "打开播放器",
            "player.close": "收起播放器",
            "player.queue": "接下来播放",
            "player.favorite": "收藏",
            "player.unfavorite": "取消收藏",
            "player.more": "更多操作",
            "player.match": "在线补全元数据",
            "player.delete": "删除本地文件",
            "player.noTrack": "在列表里点一首歌开始播放",
            "mv.remuxing": "正在准备 MV（换封装）…",
            "mv.transcoding": "正在准备 MV（转码）…",
            "mv.failed": "这个 MV 播不了",
            "mv.noFfmpeg": "需要转封装才能播放：装一个 ffmpeg（brew install ffmpeg）再试",
            "mv.retry": "重试",
            "confirm.convert": "（其中 {0} 个 MV 会顺带转成 MP4，重编码那档会掉一点画质）",
            "confirm.deleteOriginal": "转换成功后删除原件（丢进废纸篓）",
        };
        const en = {
            "view.music": "Music",
            "action.chooseDir": "Choose Folder",
            "action.inputDir": "Enter path manually",
            "action.inputDir.placeholder": "Paste a local folder path, e.g. D:\\Music or ~/Music",
            "action.confirm": "OK",
            "action.refresh": "Refresh",
            "action.delete": "Delete",
            "action.cancel": "Cancel",
            "confirm.delete": (title) => `Delete "${title}"? The local file will be permanently removed. This cannot be undone.`,
            "action.search.placeholder": "Search title or artist",
            "action.match.tip": "Fetch title / artist / cover online",
            "action.matching": "Matching…",
            "action.search": "Search",
            "match.title": "Online metadata",
            "match.none": "No matches found — try another keyword",
            "match.clear": "Clear fetched info",
            "match.source": "From QQ / iTunes / NetEase / MusicBrainz; when checked, tags are written and the file renamed",
            "action.completeAll": "Complete All",
            "action.stop": "Stop",
            "complete.progress": (done, total, failed, skipped) => `Completing… ${done}/${total}`
                + (failed > 0 ? ` (${failed} failed)` : "")
                + (skipped > 0 ? ` (${skipped} already correct or low confidence)` : ""),
            "confirm.complete": (count) => `Check all ${count} song(s) against multiple sources (QQ / iTunes / NetEase / MusicBrainz): already-correct tags are skipped, only high-confidence differences are written and renamed, low-confidence ones stay untouched; existing covers are never overwritten, only missing ones are filled. Continue?`,
            "complete.none": "Nothing to complete",
            "match.writeFile": "Write tags & rename file",
            "match.applying": "Writing file…",
            "action.picking": "Picking…",
            "action.loading": "Scanning…",
            "col.title": "Title",
            "col.artist": "Artist",
            "col.duration": "Time",
            "empty.title": "No music folder selected",
            "empty.hint": "Pick a local folder — flac / mp3 / m4a / ogg / wav and more are supported",
            "empty.tracks": "No audio files found in this folder",
            "mode.loop": "Repeat All",
            "mode.one": "Repeat One",
            "stats": (count) => `${count} songs`,
            "stats.truncated": "scan limit reached",
            "stats.drm": (count) => `${count} DRM-protected package(s) skipped`,
            "stats.drmTip": "Apple .movpkg is a FairPlay-encrypted HLS bundle; no third-party player can decrypt it — play it in Apple Music / Apple TV",
            "scan.progress": (parsed, total) => total > 0 ? `Scanning… ${parsed}/${total}` : `Scanning… ${parsed}`,
            "error.prefix": "Error: ",
            "error.legacyEntry": "Fell back to the legacy host entry (/dsh-music prefix): requests no longer go through the connection layer Host/Origin fence and browser-session auth. Restart dsh to recover.",
            "error.unsupported": "Cannot play this file (unsupported format or file moved)",
            "error.staleHost": "Host plugin is still the old build (not reloaded): restart dsh web, then refresh this page",
            "a11y.progress": "Playback position",
            "action.prev": "Previous",
            "action.next": "Next",
            "action.play": "Play",
            "action.pause": "Pause",
            "action.volume": "Volume",
            "player.open": "Open player",
            "player.close": "Collapse player",
            "player.queue": "Continue Playing",
            "player.favorite": "Favorite",
            "player.unfavorite": "Remove favorite",
            "player.more": "More",
            "player.match": "Fetch metadata online",
            "player.delete": "Delete local file",
            "player.noTrack": "Pick a song from the list to start",
            "mv.remuxing": "Preparing the music video (remux)…",
            "mv.transcoding": "Preparing the music video (transcoding)…",
            "mv.failed": "This music video cannot be played",
            "mv.noFfmpeg": "Remuxing is required: install ffmpeg (brew install ffmpeg) and retry",
            "mv.retry": "Retry",
            "confirm.convert": " ({0} MV(s) will also be converted to MP4; re-encoding loses a little quality)",
            "confirm.deleteOriginal": "Delete the original after a successful conversion (moved to Trash)",
        };
        const CSS = `
/* 透明毛玻璃：与 DSH 自己（ui-dockkit .dockScrim / --dsw-mask-blur）同款配方 ——
   color-mix 半透明底色 + backdrop-filter。根容器留一点透明度，桌面端窗口/外壳的
   背景才能透上来，否则模糊的是自己的纯色底，等于没做。 */
.dshm-root{box-sizing:border-box;position:relative;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 88%, transparent);font:var(--dsw-font-xs-13);flex-direction:column;display:flex;overflow:hidden}
/* 悬停提示包装层：官方 Tooltip 会 clone 唯一子元素，disabled 的按钮不派发鼠标
   事件，所以由这层 inline-flex 容器收 hover；自身不占额外空间。 */
.dshm-tip{display:inline-flex;min-width:0;align-items:center;flex:none}
.dshm-glyph{line-height:1}
.dshm-volIcon{flex:none;color:var(--dsw-alias-label-tertiary);align-items:center;display:inline-flex}
/* 不启用 composer 悬浮（避免底部留白空隙）：恢复原布局，仅用 :has() 在音乐页隐藏两侧宽度条 */
body:has(.dshm-root) [data-width-handle]{display:none}
.dshm-root *{box-sizing:border-box}
.dshm-header{border-bottom:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent);-webkit-backdrop-filter:saturate(180%) blur(6px);backdrop-filter:saturate(180%) blur(6px);flex:none;align-items:center;gap:10px;min-height:44px;padding:0 14px;display:flex}
.dshm-title{font-size:14px;font-weight:600;flex:none}
.dshm-dir{min-width:0;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px;text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}
.dshm-stats{color:var(--dsw-alias-label-tertiary);flex:none;font-size:11px}
/* 官方 Input 组件自带 wrap/icon/input 三层样式（高 32、bg-layer-1、border-l4、
   radius-md、focus-within 变主题色），插件只补宽度约束；下面 .dshm-search 是
   拿不到官方组件时的降级输入框。 */
.dshm-searchWrap{flex:0 1 220px;min-width:120px}
.dshm-search{border:1px solid var(--dsw-alias-border-l2);height:24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-radius:6px;flex:0 1 180px;min-width:80px;padding:0 8px;font:inherit;font-size:12px;outline:none}
.dshm-search:focus{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}
.dshm-search::placeholder{color:var(--dsw-alias-label-caption)}
.dshm-btn{cursor:pointer;height:26px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1);border-radius:7px;flex:none;align-items:center;gap:5px;padding:0 10px;font:inherit;font-size:12px;display:inline-flex}
.dshm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshm-btn{transition:background-color .12s var(--ds-ease-in-out),border-color .12s var(--ds-ease-in-out)}
.dshm-btn:disabled{cursor:not-allowed;opacity:.45}
.dshm-error{border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-tertiary);flex:none;padding:6px 14px;font-size:12px}
.dshm-notice{border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-text-secondary);background:var(--dsw-alias-bg-secondary);flex:none;padding:6px 14px;font-size:12px}
.dshm-confirmBar{border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-state-error-tertiary);flex:none;align-items:center;gap:10px;padding:8px 14px;display:flex}
.dshm-confirmText{min-width:0;flex:1;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5}
.dshm-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dshm-dirEditor{border-bottom:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent);-webkit-backdrop-filter:saturate(180%) blur(6px);backdrop-filter:saturate(180%) blur(6px);flex:none;align-items:center;gap:8px;padding:8px 14px;display:flex}
.dshm-dirInput{border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-radius:7px;flex:1;min-width:0;padding:0 10px;font:inherit;font-size:12px;font-family:var(--ds-font-family-code);outline:none}
.dshm-dirInput:focus{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}
.dshm-dirInput::placeholder{color:var(--dsw-alias-label-caption)}
.dshm-tableWrap{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.dshm-table{border-spacing:0;table-layout:fixed;width:100%;font-size:12px}
/* 列头是真正的毛玻璃：它在滚动容器内 position:sticky，列表从它下面滑过——
   这里能实打实看到模糊，而不是对着纯色底做无用功。 */
.dshm-table th{z-index:2;border-bottom:1px solid var(--dsw-alias-border-l2);height:30px;color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb, var(--dsw-specific-sidebar-fill) 78%, transparent);-webkit-backdrop-filter:saturate(180%) blur(6px);backdrop-filter:blur(6px);text-align:left;font-weight:500;padding:0 10px;position:sticky;top:0;user-select:none;white-space:nowrap}
.dshm-table th.dshm-sortable{cursor:pointer}
.dshm-table th.dshm-sortable:hover{color:var(--dsw-alias-label-primary)}
.dshm-table th.dshm-sorted{color:var(--dsw-alias-state-business-primary)}
.dshm-table td{border-bottom:1px solid var(--dsw-alias-border-l1);height:32px;text-overflow:ellipsis;white-space:nowrap;padding:0 10px;overflow:hidden}
/* No cell padding here: the shared td padding (10px) left only 20px of content
   box for the 22px delete button, so the td clipped it and painted a "…". */
.dshm-del{cursor:pointer;width:22px;height:22px;color:var(--dsw-alias-label-tertiary);border:0;background:transparent;border-radius:6px;justify-content:center;align-items:center;padding:0;display:inline-flex;font-size:15px;line-height:1;font-weight:600}
.dshm-del:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-tertiary)}
.dshm-colDuration{width:64px;text-align:right!important;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshm-colArtist{width:26%}
.dshm-row{cursor:default;transition:background-color .12s var(--ds-ease-in-out)}
.dshm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshm-row--active{background:var(--dsw-alias-interactive-bg-active)}
.dshm-row--active .dshm-cellTitle{color:var(--dsw-alias-state-business-primary);font-weight:500}
.dshm-cellTitle{color:var(--dsw-alias-label-primary)}
.dshm-cellArtist{color:var(--dsw-alias-label-secondary)}
.dshm-empty{min-height:0;flex:1;color:var(--dsw-alias-label-tertiary);text-align:center;flex-direction:column;justify-content:center;align-items:center;gap:10px;padding:32px;display:flex}
.dshm-emptyIcon{font-size:44px;line-height:1;opacity:.5}
.dshm-emptyHint{max-width:420px;font-size:12px;line-height:1.7}
.dshm-bar{border-top:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-specific-sidebar-fill) 82%, transparent);-webkit-backdrop-filter:saturate(180%) blur(6px);backdrop-filter:saturate(180%) blur(6px);flex:none;align-items:center;gap:14px;min-height:64px;padding:8px 16px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) minmax(0,1fr)}
.dshm-nowPlaying{min-width:0;align-items:center;gap:10px;display:flex}
/* 底部条的封面变成「打开全屏播放器」的入口（Apple Music 同款交互） */
.dshm-nowCoverBtn{cursor:pointer;border:0;background:transparent;border-radius:8px;flex:none;align-items:center;padding:0;display:inline-flex}
.dshm-nowCoverBtn:hover{opacity:.85}

/* ── 动效（取自 Apple Music 前端 music.apple.com 的 CSS）─────────────────────
   他们的缓动曲线只有三条在反复用：
     cubic-bezier(.215,.61,.355,1)  easeOutCubic  —— 用得最多（16 处）
     cubic-bezier(.23,1,.32,1)      easeOutQuint  —— 弹层/播放器出场（2 处）
     cubic-bezier(.76,.665,.37,1.35) 带过冲       —— 按压回弹（1 处）
   按下反馈是 scale(.88~.92)；材质是 backdrop-filter: saturate(180%) blur(60px)。 */
.dshm-root{
  --dshm-ease:cubic-bezier(.215,.61,.355,1);
  --dshm-ease-snap:cubic-bezier(.23,1,.32,1);
  --dshm-ease-spring:cubic-bezier(.76,.665,.37,1.35);
}
@keyframes dshm-playerIn{from{opacity:0;transform:scale(.965)}to{opacity:1;transform:scale(1)}}
@keyframes dshm-playerOut{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.975)}}
@keyframes dshm-artIn{from{opacity:0;transform:scale(1.035)}to{opacity:1;transform:scale(1)}}
.dshm-player{animation:dshm-playerIn .44s var(--dshm-ease-snap) backwards}
.dshm-player--closing{animation:dshm-playerOut .2s var(--dshm-ease) backwards;pointer-events:none}
.dshm-playerArt,.dshm-playerArtFallback{animation:dshm-artIn .5s var(--dshm-ease) backwards}
/* 按压 / 悬停的微交互（Apple 的按下是 scale(.88~.92)） */
.dshm-playerTransportBtn,.dshm-tbtn,.dshm-playerRound,.dshm-pill,.dshm-queueMore,.dshm-btn{
  transition:transform .16s var(--dshm-ease-spring),background-color .16s var(--dshm-ease),color .16s var(--dshm-ease),opacity .16s var(--dshm-ease);
}
.dshm-playerTransportBtn:active:not(:disabled),.dshm-tbtn:active:not(:disabled),.dshm-playerRound:active:not(:disabled),.dshm-pill:active:not(:disabled),.dshm-queueMore:active,.dshm-btn:active{transform:scale(.92)}
.dshm-queueRow{transition:background-color .18s var(--dshm-ease)}
/* 尊重"减少动态效果"：以上动效全部关掉（跑马灯另有同样处理） */
@media (prefers-reduced-motion:reduce){
  .dshm-player,.dshm-player--closing,.dshm-playerArt,.dshm-playerArtFallback,.dshm-coverBars i{animation:none}
  .dshm-playerTransportBtn,.dshm-tbtn,.dshm-playerRound,.dshm-pill,.dshm-queueMore,.dshm-btn,.dshm-queueRow{transition:none}
  .dshm-playerTransportBtn:active:not(:disabled),.dshm-tbtn:active:not(:disabled),.dshm-playerRound:active:not(:disabled),.dshm-pill:active:not(:disabled),.dshm-queueMore:active,.dshm-btn:active{transform:none}
}

/* ── MV（音乐视频）───────────────────────────────────────────────────────
   媒体元素是 <video>（音频文件也用它播），MV 时被搬进 .dshm-mvStage；
   弹层收起则停到 .dshm-mvPark（移动父节点不会中断播放，实测 t 连续推进）。 */
.dshm-mv{width:100%;height:100%;display:block;object-fit:contain;background:#000;border-radius:10px}
.dshm-mvPark{display:none}
/* WASM 解出来的画面：铺满画面槽，和 <video> 同一套 object-fit 规则 */
.dshm-mvCanvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block}
.dshm-zoomable{cursor:zoom-in}
.dshm-lightbox{position:fixed;inset:0;z-index:80;justify-content:center;align-items:center;background:rgba(0,0,0,.72);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);display:flex}
.dshm-lightboxImg{max-width:min(88vw,900px);max-height:86vh;object-fit:contain;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.55)}
/* MV 放大模式：点画面后视频铺大（右栏队列让位），整套控制条仍在下方 —— 
   尺寸夹在播放器区域内，永远不会超出 desktop。 */
.dshm-player--mvbig .dshm-playerBody{grid-template-columns:minmax(0,1fr);padding:0 26px 22px}
.dshm-player--mvbig .dshm-playerRight{display:none}
.dshm-player--mvbig .dshm-playerStage{--dshm-art:min(98%,1240px)}
.dshm-player--mvbig .dshm-mvStage{aspect-ratio:16/9;max-height:82vh;background:#000}
.dshm-player--mvbig .dshm-playerMeta,.dshm-player--mvbig .dshm-progress,.dshm-player--mvbig .dshm-playerTransport{width:min(92%,1040px)}
.dshm-mvStage{position:relative;width:100%;aspect-ratio:1;background:#000;border-radius:10px;overflow:hidden;box-shadow:0 26px 60px rgba(0,0,0,.45)}
.dshm-mvPrep{position:absolute;inset:0;z-index:2;flex-direction:column;justify-content:center;align-items:center;gap:10px;padding:0 18px;color:#fff;text-align:center;background:rgba(0,0,0,.62);display:flex}
.dshm-mvPrepText{font-size:13px;font-weight:500}
.dshm-mvPrepBar{width:min(70%,220px);height:4px;background:rgba(255,255,255,.25);border-radius:2px;overflow:hidden}
.dshm-mvPrepBar i{display:block;height:100%;background:#fff;border-radius:2px;transition:width .3s var(--dshm-ease)}
.dshm-mvPrepPct{font-size:11px;opacity:.75;font-variant-numeric:tabular-nums}
.dshm-mvPrepHint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:1.5;max-width:300px;word-break:break-word}
.dshm-check{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;align-items:center;gap:6px;flex:none;display:inline-flex}
.dshm-check input{accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;width:13px;height:13px;margin:0}
.dshm-mvPrepRetry{cursor:pointer;color:#fff;border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.14);border-radius:8px;padding:5px 14px;font:inherit;font-size:12px}
.dshm-mvPrepRetry:hover{background:rgba(255,255,255,.24)}
.dshm-mvTag{margin-right:6px;padding:0 5px;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);border-radius:4px;font-size:10px;font-weight:600;line-height:15px;vertical-align:1px;display:inline-block}
.dshm-nowText .dshm-mvTag{margin-right:5px;vertical-align:1px}

/* ── 全屏播放器（Apple Music 风格）：点底部封面弹出 ───────────────────── */
.dshm-player{position:absolute;inset:0;z-index:40;color:var(--dsw-alias-label-primary);flex-direction:column;display:flex;overflow:hidden}
/* 背景＝封面放大 + 高斯模糊 + 一层主题色薄纱，和 Apple Music 的"取色背景"一致 */
.dshm-playerArt-bg{position:absolute;inset:-12%;background-position:center;background-size:cover;filter:blur(64px) saturate(1.7);opacity:.55;pointer-events:none}
.dshm-playerScrim{position:absolute;inset:0;background:color-mix(in srgb, var(--dsw-alias-bg-base) 78%, transparent);-webkit-backdrop-filter:saturate(180%) blur(48px);backdrop-filter:saturate(180%) blur(48px);pointer-events:none}
.dshm-playerTop{position:relative;flex:none;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;display:flex}
.dshm-playerBody{position:relative;flex:1;min-height:0;grid-template-columns:minmax(0,1fr) minmax(300px,400px);gap:36px;padding:0 40px 26px;display:grid}
.dshm-playerStage{--dshm-art:min(42vh,380px,100%);width:var(--dshm-art);min-width:0;min-height:0;flex-direction:column;justify-content:center;align-items:center;gap:16px;display:flex}
.dshm-playerArt{width:100%;aspect-ratio:1;object-fit:cover;background:var(--dsw-alias-bg-layer-2);border-radius:10px;box-shadow:0 26px 60px rgba(0,0,0,.45)}
.dshm-playerArtFallback{width:100%;aspect-ratio:1;background:var(--dsw-alias-bg-layer-2);border-radius:10px;box-shadow:0 26px 60px rgba(0,0,0,.45);color:var(--dsw-alias-label-caption);justify-content:center;align-items:center;display:flex}
.dshm-playerMeta{width:100%;min-width:0;align-items:center;gap:10px;display:flex}
.dshm-playerMetaText{min-width:0;flex:1}
.dshm-playerTitle{font-size:16px;font-weight:600;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dshm-playerArtist{color:var(--dsw-alias-label-tertiary);font-size:12.5px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dshm-playerRound{cursor:pointer;width:30px;height:30px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-alias-fill-l1) 60%, transparent);border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dshm-playerRound:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshm-playerRound:disabled{cursor:not-allowed;opacity:.4}
.dshm-playerRound--on{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
/* 双类选择器：必须压过下面 .dshm-progress{align-items:center}（同特异性时靠后规则赢），
   否则时间行会被压成"内容宽"、space-between 失效，两个时间就挤到中间去了。 */
.dshm-progress.dshm-progress--stacked{flex-direction:column;gap:6px;align-items:stretch}
.dshm-progress--stacked .dshm-timeRow{width:100%}
.dshm-progress--stacked .dshm-progressTrack{width:100%;flex:none;height:18px}
.dshm-timeRow{justify-content:space-between;align-items:center;gap:8px;display:flex}
.dshm-progress--stacked .dshm-time{width:auto;text-align:left}
.dshm-progress--stacked .dshm-time--end{text-align:right}
.dshm-playerTransport{width:100%;grid-template-columns:1fr auto 1fr;align-items:center;display:grid}
.dshm-playerTransportCenter{gap:26px;justify-content:center;align-items:center;display:flex}
.dshm-playerTransportSide{min-width:0;display:flex}
.dshm-playerTransportSide--end{justify-content:flex-end}
.dshm-playerTransportBtn{cursor:pointer;width:34px;height:34px;color:var(--dsw-alias-label-primary);border:0;background:transparent;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dshm-playerTransportBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshm-playerTransportBtn:disabled{cursor:not-allowed;opacity:.35}
.dshm-playerTransportBtn--play{width:44px;height:44px}
.dshm-playerTransportBtn--on{color:var(--dsw-alias-state-business-primary)}
.dshm-playerRight{min-width:0;min-height:0;flex-direction:column;gap:10px;display:flex}
.dshm-playerPills{gap:10px;flex:none;display:flex}
.dshm-pill{cursor:pointer;height:38px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-alias-fill-l1) 55%, transparent);border-radius:10px;flex:1;justify-content:center;align-items:center;gap:6px;padding:0 10px;font:inherit;font-size:12px;display:inline-flex}
.dshm-pill:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshm-pill:disabled{cursor:not-allowed;opacity:.45}
.dshm-playerQueueHead{flex:none;align-items:baseline;gap:8px;padding:2px 2px 4px;display:flex}
.dshm-playerQueueTitle{font-size:15px;font-weight:600}
.dshm-playerQueueCount{color:var(--dsw-alias-label-caption);font-size:11px}
.dshm-playerQueue{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.dshm-queueRow{position:relative;cursor:default;width:100%;color:var(--dsw-alias-label-primary);text-align:left;border:0;background:transparent;border-radius:12px;align-items:center;gap:10px;padding:6px 8px;font:inherit;display:flex}
.dshm-queueRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshm-queueRow--current{background:var(--dsw-alias-interactive-bg-active)}
.dshm-queueRow--current .dshm-queueTitle{color:var(--dsw-alias-state-business-primary);font-weight:500}
.dshm-queueRow .dshm-rowCover,.dshm-queueRow .dshm-rowNote{width:40px;height:40px;border-radius:6px}
.dshm-queueText{min-width:0;flex:1;flex-direction:column;display:flex}
.dshm-queueTitle{font-size:13px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dshm-queueArtist{color:var(--dsw-alias-label-tertiary);font-size:11.5px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dshm-queueFav{flex:none;color:var(--dsw-alias-state-business-primary);display:inline-flex}
.dshm-queueMore{cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-tertiary);border:0;background:transparent;border-radius:6px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dshm-queueMore:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshm-queueMenu{position:absolute;z-index:5;top:calc(100% - 4px);right:8px;min-width:168px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,.35);padding:4px;display:flex;flex-direction:column}
.dshm-queueMenuItem{cursor:pointer;color:var(--dsw-alias-label-primary);text-align:left;border:0;background:transparent;border-radius:7px;align-items:center;gap:8px;padding:7px 9px;font:inherit;font-size:12px;display:flex}
.dshm-queueMenuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshm-queueMenuItem--danger{color:var(--dsw-alias-state-error-primary)}
.dshm-noteIcon{width:34px;height:34px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;flex:none;justify-content:center;align-items:center;display:flex}
.dshm-cover{width:34px;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;flex:none;object-fit:cover;background:var(--dsw-alias-bg-layer-2)}
/* 跑马灯：只在真的放不下时滚动（JS 量宽度后加 --on），悬停暂停，尊重
   prefers-reduced-motion。位移一份文本 + 一个 gap，正好无缝衔接。 */
.dshm-marquee{min-width:0;overflow:hidden;white-space:nowrap}
.dshm-marqueeInner{display:inline-flex;align-items:center;gap:var(--dshm-marquee-gap,36px);white-space:nowrap}
.dshm-marqueeText{white-space:nowrap}
.dshm-marquee--on .dshm-marqueeInner{animation:dshm-marquee-scroll var(--dshm-marquee-duration,12s) linear infinite}
.dshm-marquee:hover .dshm-marqueeInner{animation-play-state:paused}
@keyframes dshm-marquee-scroll{from{transform:translateX(0)}to{transform:translateX(calc(-50% - var(--dshm-marquee-gap,36px) / 2))}}
@media (prefers-reduced-motion:reduce){.dshm-marquee--on .dshm-marqueeInner{animation:none}}
.dshm-nowText{min-width:0}
.dshm-nowTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dshm-nowArtist{color:var(--dsw-alias-label-tertiary);font-size:11px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dshm-center{min-width:0;flex-direction:column;align-items:center;gap:2px;display:flex}
.dshm-transport{align-items:center;gap:6px;display:flex}
.dshm-tbtn{cursor:pointer;width:30px;height:30px;color:var(--dsw-alias-label-secondary);border:0;background:transparent;border-radius:8px;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dshm-tbtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshm-tbtn:disabled{cursor:not-allowed;opacity:.35}
.dshm-tbtn--play{width:36px;height:36px}
.dshm-progress{width:100%;align-items:center;gap:8px;display:flex}
/* 进度条命中区：指针事件在这里处理（滑杆本体 pointer-events:none），
   这样"点哪儿跳哪儿 / 拖多快都跟手"不依赖原生 range 的拇指命中。 */
.dshm-progressTrack{cursor:pointer;flex:1;min-width:0;align-items:center;display:flex}
.dshm-progress .dshm-slider{width:100%}
.dshm-progressTrack:hover .dshm-slider::-webkit-slider-thumb,.dshm-progress--dragging .dshm-slider::-webkit-slider-thumb{transform:scale(1)}
.dshm-progressTrack:hover .dshm-slider::-moz-range-thumb,.dshm-progress--dragging .dshm-slider::-moz-range-thumb{transform:scale(1)}
.dshm-time{color:var(--dsw-alias-label-tertiary);flex:none;width:38px;font-size:10px;font-variant-numeric:tabular-nums;text-align:center;user-select:none}
.dshm-progress--stacked .dshm-time{font-size:11.5px;font-variant-numeric:tabular-nums}
/* macOS Music style slider: filled elapsed portion, thin track that thickens on hover, knob scales up */
.dshm-slider{-webkit-appearance:none;appearance:none;cursor:pointer;height:16px;background:linear-gradient(to right, var(--dsw-alias-label-primary) 0 var(--p, 0%), color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent) var(--p, 0%) 100%) center/100% 4px no-repeat;border-radius:2px;flex:1;min-width:0;margin:0;outline:none;transition:background-size .12s var(--ds-ease-in-out)}
.dshm-slider:hover:not(:disabled){background-size:100% 5px}
/* 圆钮：macOS 原生样式 —— 始终是白色实心圆 + 极细描边 + 柔和投影，
   不跟随主题色；进度条上的钮悬停/拖拽才出现，音量条上的钮常显。 */
.dshm-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:20px;height:14px;border-radius:999px;background:#ffffff;box-shadow:0 .5px 2px rgba(0,0,0,.28),0 0 0 .5px rgba(0,0,0,.08);transform:scale(0);transition:transform .12s var(--ds-ease-in-out)}
.dshm-slider:hover:not(:disabled)::-webkit-slider-thumb,.dshm-slider:active::-webkit-slider-thumb{transform:scale(1)}
.dshm-volume::-webkit-slider-thumb,.dshm-volume:hover:not(:disabled)::-webkit-slider-thumb{transform:scale(1)}
.dshm-slider::-moz-range-thumb{width:20px;height:14px;background:#ffffff;border:0;border-radius:999px;box-shadow:0 .5px 2px rgba(0,0,0,.28),0 0 0 .5px rgba(0,0,0,.08);transform:scale(0);transition:transform .12s var(--ds-ease-in-out)}
.dshm-slider:hover:not(:disabled)::-moz-range-thumb,.dshm-slider:active::-moz-range-thumb{transform:scale(1)}
.dshm-volume::-moz-range-thumb{transform:scale(1)}
.dshm-slider:disabled{cursor:not-allowed;opacity:.45}
.dshm-right{min-width:0;justify-content:flex-end;align-items:center;gap:10px;display:flex}
.dshm-mode{cursor:pointer;height:26px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:7px;flex:none;align-items:center;gap:5px;padding:0 9px;font:inherit;font-size:11px;display:inline-flex}
.dshm-mode:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshm-volume{width:88px;flex:none}
/* 全屏播放器顶部那条音量按 macOS 的长条比例（底部条不变，仍是 88px） */
.dshm-volume--wide{width:180px}
.dshm-playerVolume{align-items:center;gap:8px;display:flex}
/* 音量条的圆钮与进度条同款（macOS 原生白色圆钮），只是常显 */
/* 在线补全：行内封面列 / 匹配按钮 / 候选弹层 */
.dshm-colCover{width:44px;text-align:center!important;padding:0 4px!important;text-overflow:clip!important}
/* ── 列表封面上的「正在播放」指示（Apple Music 的 .playing-bars）─────────────
   正在播放的行：封面上叠三根跳动条；悬停时跳动条淡出、换成播放/暂停图标
   （他们用 --playButtonOpacity + .playing-bars-hover 做同一件事）。 */
.dshm-coverWrap{position:relative;flex:none;align-items:center;justify-content:center;display:inline-flex}
.dshm-coverWrap::after{content:"";position:absolute;inset:0;z-index:1;background:rgba(0,0,0,.42);border-radius:5px;opacity:0;transition:opacity .18s var(--dshm-ease)}
.dshm-row:hover .dshm-coverWrap::after,.dshm-queueRow:hover .dshm-coverWrap::after{opacity:1}
.dshm-queueRow .dshm-coverWrap::after{border-radius:6px}
.dshm-coverBars{position:absolute;z-index:2;height:12px;align-items:flex-end;gap:2px;display:flex;opacity:1;transition:opacity .18s var(--dshm-ease)}
.dshm-coverBars i{width:2.5px;height:100%;background:#fff;border-radius:1px;transform-origin:bottom;animation:dshm-eq .9s ease-in-out infinite alternate}
.dshm-coverBars i:nth-child(1){height:60%;animation-delay:-.5s}
.dshm-coverBars i:nth-child(2){height:100%;animation-delay:-.25s}
.dshm-coverBars i:nth-child(3){height:75%;animation-delay:-.75s}
@keyframes dshm-eq{from{transform:scaleY(.28)}to{transform:scaleY(1)}}
.dshm-coverHover{position:absolute;z-index:2;color:#fff;opacity:0;transition:opacity .18s var(--dshm-ease);display:inline-flex}
.dshm-row:hover .dshm-coverBars,.dshm-queueRow:hover .dshm-coverBars{opacity:0}
.dshm-row:hover .dshm-coverHover,.dshm-queueRow:hover .dshm-coverHover{opacity:1}
/* macOS 的悬浮滚动条：平时隐形，滚动/悬停才浮出来（Apple 干脆 display:none） */
.dshm-tableWrap::-webkit-scrollbar,.dshm-playerQueue::-webkit-scrollbar{width:11px;height:11px}
.dshm-tableWrap::-webkit-scrollbar-track,.dshm-playerQueue::-webkit-scrollbar-track{background:transparent}
.dshm-tableWrap::-webkit-scrollbar-thumb,.dshm-playerQueue::-webkit-scrollbar-thumb{background:transparent;background-clip:padding-box;border:3px solid transparent;border-radius:6px}
.dshm-tableWrap:hover::-webkit-scrollbar-thumb,.dshm-playerQueue:hover::-webkit-scrollbar-thumb{background:color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent);background-clip:padding-box;border:3px solid transparent}
/* 键盘焦点环：Apple 是 4px 主题色光晕（:focus-visible{box-shadow:0 0 0 4px rgba(keyColor,.6)}） */
.dshm-root button:focus-visible,.dshm-root input:focus-visible,.dshm-root [role="button"]:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent)}
.dshm-rowCover{width:28px;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;object-fit:cover;background:var(--dsw-alias-bg-layer-2);vertical-align:middle}
.dshm-rowNote{width:28px;height:28px;color:var(--dsw-alias-label-caption);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:5px;justify-content:center;align-items:center;vertical-align:middle;display:inline-flex}
.dshm-colActions{width:60px;text-align:center!important;padding:0!important;text-overflow:clip!important}
.dshm-match{cursor:pointer;width:22px;height:22px;color:var(--dsw-alias-label-tertiary);border:0;background:transparent;border-radius:6px;justify-content:center;align-items:center;padding:0;display:inline-flex;font-size:12px;line-height:1}
.dshm-match:hover{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshm-match--done{color:var(--dsw-alias-state-business-primary)}
.dshm-complete{font-size:13px;line-height:1;padding:0 9px}
/* 与官方 Modal/ImageLightbox 同款遮罩模糊（--dsw-mask-blur）。 */
.dshm-modal{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.35);-webkit-backdrop-filter:var(--dsw-mask-blur,blur(2px));backdrop-filter:var(--dsw-mask-blur,blur(2px));justify-content:center;align-items:center;display:flex;padding:24px}
.dshm-dialog{width:min(520px,100%);max-height:min(70vh,560px);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.35);flex-direction:column;display:flex;overflow:hidden}
.dshm-dialogHead{border-bottom:1px solid var(--dsw-alias-border-l1);padding:12px 14px;font-size:13px;font-weight:600}
.dshm-matchRow{justify-content:stretch;align-items:center;gap:8px;margin-top:10px;display:flex}
.dshm-matchInput{border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-radius:7px;flex:1;min-width:0;padding:0 10px;font:inherit;font-size:12px;outline:none}
.dshm-matchInput:focus{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}
.dshm-matchInput::placeholder{color:var(--dsw-alias-label-caption)}
.dshm-dialogMsg{color:var(--dsw-alias-label-tertiary);padding:20px 14px;font-size:12px}
.dshm-cands{min-height:0;flex:1;overflow:auto;padding:6px}
.dshm-cand{cursor:pointer;width:100%;color:var(--dsw-alias-label-primary);text-align:left;border:0;background:transparent;border-radius:8px;align-items:center;gap:10px;padding:6px 8px;font:inherit;display:flex}
.dshm-cand:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshm-candCover{width:40px;height:40px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);object-fit:cover;flex:none}
.dshm-candText{min-width:0;flex-direction:column;display:flex;gap:2px}
.dshm-candTitle{font-size:12px;font-weight:500;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dshm-candArtist{color:var(--dsw-alias-label-tertiary);font-size:11px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dshm-candMeta{color:var(--dsw-alias-label-caption);font-size:10px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dshm-candBest{color:var(--dsw-alias-state-business-primary);margin-right:4px}
.dshm-dialogFoot{border-top:1px solid var(--dsw-alias-border-l1);justify-content:space-between;align-items:center;gap:8px;padding:8px 12px;display:flex}
.dshm-check{color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;align-items:center;gap:6px;font-size:11px;display:inline-flex}
.dshm-check input{cursor:pointer;accent-color:var(--dsw-alias-state-business-primary);margin:0}
`;
        /**
         * 播放 / 暂停用 macOS 原生形状（实心三角 / 双圆角竖条）—— 这是用户点名要换的
         * 两枚；DSH 的 IconPlayOutline 是"圆圈里套三角"，和 Apple Music 的传输键观感
         * 不同。其余按钮继续遵守"有官方图标就用官方"。
         */
        const appleTransport = (kind, size) => {
            const paths = kind === "play"
                ? [h("path", { d: "M5.6 3.05c0-.95 1.05-1.52 1.83-.98l7.3 4.62c.72.46.72 1.5 0 1.96l-7.3 4.62c-.78.54-1.83-.03-1.83-.98z" })]
                : [h("rect", { x: 4.3, y: 2.8, width: 2.9, height: 10.4, rx: 1.15 }), h("rect", { x: 8.8, y: 2.8, width: 2.9, height: 10.4, rx: 1.15 })];
            return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor" }, paths);
        };
        const ICONS = {
            play: appleTransport("play", 19),
            pause: appleTransport("pause", 19),
            playBig: appleTransport("play", 27),
            pauseBig: appleTransport("pause", 27),
            prev: h("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M3 3.2v9.6c0 .4.3.7.7.7s.7-.3.7-.7V3.2c0-.4-.3-.7-.7-.7s-.7.3-.7.7z" }), h("path", { d: "M13.4 3.1v9.8c0 .8-.9 1.2-1.5.8l-6.9-4.9c-.6-.4-.6-1.2 0-1.6l6.9-4.9c.6-.4 1.5 0 1.5.8z" })),
            next: h("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M12.3 3.2v9.6c0 .4.3.7.7.7s.7-.3.7-.7V3.2c0-.4-.3-.7-.7-.7s-.7.3-.7.7z" }), h("path", { d: "M2.6 3.1v9.8c0 .8.9 1.2 1.5.8l6.9-4.9c.6-.4.6-1.2 0-1.6l-6.9-4.9c-.6-.4-1.5 0-1.5.8z" })),
            repeat: h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M11 1.8 13 3.8l-2 2" }), h("path", { d: "M3.5 7.2V6.4a2.6 2.6 0 0 1 2.6-2.6H13" }), h("path", { d: "m5 14.2-2-2 2-2" }), h("path", { d: "M12.5 8.8v.8a2.6 2.6 0 0 1-2.6 2.6H3" })),
            repeatOne: h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M11 1.8 13 3.8l-2 2" }), h("path", { d: "M3.5 7.2V6.4a2.6 2.6 0 0 1 2.6-2.6H13" }), h("path", { d: "m5 14.2-2-2 2-2" }), h("path", { d: "M12.5 8.8v.8a2.6 2.6 0 0 1-2.6 2.6H3" }), h("text", { x: 8, y: 10.6, fontSize: 6.5, fill: "currentColor", stroke: "none", textAnchor: "middle", fontWeight: 700 }, "1")),
            note: h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M12.9 1.3 5.9 2.9c-.5.1-.9.6-.9 1.1v6.9c-.3-.1-.7-.2-1-.2-1.2 0-2.2.8-2.2 1.9s1 1.9 2.2 1.9 2.2-.8 2.2-1.9V5.4c0-.3.2-.6.5-.6l5.7-1.3c.3-.1.6.2.6.5v5.3c-.3-.1-.7-.2-1-.2-1.2 0-2.2.8-2.2 1.9s1 1.9 2.2 1.9 2.2-.8 2.2-1.9V2.2c0-.5-.4-1-1.3-.9z" })),
            // 喇叭：macOS 原生样式（SF Symbols 的 speaker.wave.2 形状——实心喇叭 + 两道弧）
            volume: h("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none" }, h("path", { d: "M8.35 2.72c0-.66-.8-1-1.27-.53L4.6 4.68H2.9c-.61 0-1.1.49-1.1 1.1v4.44c0 .61.49 1.1 1.1 1.1h1.7l2.48 2.49c.47.47 1.27.14 1.27-.53z", fill: "currentColor" }), h("path", { d: "M10.5 5.75c.75.75.75 1.97 0 2.72", stroke: "currentColor", strokeWidth: 1.35, strokeLinecap: "round" }), h("path", { d: "M12.55 3.9c1.72 1.72 1.72 4.5 0 6.22", stroke: "currentColor", strokeWidth: 1.35, strokeLinecap: "round" })),
            folder: officialIcon(["IconFolderOpenRegular", "IconFolderOpenOutlineRegular", "IconFolderOpen16"], 14, h("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M1.8 3.4c0-.7.5-1.2 1.2-1.2h3c.4 0 .8.2 1 .5l.8 1.1c.1.2.3.3.5.3H13c.7 0 1.2.5 1.2 1.2v7.3c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V3.4z" }))),
            refresh: officialIcon(["IconRefreshOutlineRegular", "IconRefreshOutlineMedium", "IconRefreshOutline16"], 14, h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M21 12a9 9 0 1 1-2.6-6.4" }), h("path", { d: "M21 3.5V10h-6.5" }))),
            edit: officialIcon(["IconEditOutlineRegular", "IconEditOutlineMedium", "IconEditOutline16"], 13, h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M17 3.5a2.6 2.6 0 0 1 3.7 3.7L8.4 19.5 3 21l1.5-5.4L17 3.5z" }))),
            search: officialIcon(["IconSearchOutlineRegular", "IconSearchOutlineMedium", "IconSearchOutline16"], 14, h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M11.9 6.65a5.27 5.27 0 1 1-10.54 0 5.27 5.27 0 0 1 10.54 0zm1.35 0a6.62 6.62 0 1 1-13.24 0 6.62 6.62 0 0 1 13.24 0z" }), h("path", { d: "M16 15.04l-.96.96-3.51-3.53.95-.96z" }))),
            // 原先用「✦ / − / ×」文字充当的按钮，改用官方 ic_ds_* 图标。
            sparkle: officialIcon(["IconSparkleRegular", "IconSparkleMedium", "IconSparkle16"], 12, h("span", { className: "dshm-glyph" }, "✦")),
            trash: officialIcon(["IconTrashOutlineRegular", "IconTrashOutlineMedium", "IconTrashOutline16"], 13, h("span", { className: "dshm-glyph" }, "−")),
            close: officialIcon(["IconCloseOutlineRegular", "IconCloseOutlineMedium", "IconCloseOutline16"], 12, h("span", { className: "dshm-glyph" }, "×")),
            // 全屏播放器用到的官方图标（有官方的一律用官方）
            chevronDown: officialIcon(["IconChevronDownOutlineRegular", "IconChevronDownOutlineMedium"], 18, h("svg", { width: 18, height: 18, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M3.6 6.2 8 10.4l4.4-4.2" }))),
            ellipsis: officialIcon(["IconEllipsisOutlineRegular", "IconEllipsisOutlineMedium"], 16, h("span", { className: "dshm-glyph" }, "⋯")),
            star: h("svg", { width: 18, height: 18, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinejoin: "round" }, h("path", { d: "M8 1.9l1.85 3.9 4.3.55-3.15 2.95.8 4.25L8 11.5l-3.8 2.05.8-4.25L1.85 6.35l4.3-.55z" })),
            starFill: h("svg", { width: 18, height: 18, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M8 1.9l1.85 3.9 4.3.55-3.15 2.95.8 4.25L8 11.5l-3.8 2.05.8-4.25L1.85 6.35l4.3-.55z" })),
        };
        /**
         * 官方悬停提示（与 DSH 官方完全同源，见 @deepseek-ai/dsh-client-ui-primitives
         * 的 Tooltip）：气泡样式、翻转/贴边算法、动画都由 shell 提供，插件不再自带。
         *  - withTip：把 Tooltip 直接套在目标元素上，元素的布局身份（flex:1 等）不变。
         *  - withTipWrapped：先包一层 inline-flex 的 span——disabled 的 <button> 在浏览器
         *    里根本不派发鼠标事件，只有外层容器能收到 hover。
         * 取不到官方 Tooltip 时降级成原生 title，功能不丢。
         */
        /**
         * portal: true 是必须的，不是可选优化 —— 官方 Tooltip 的气泡默认渲染在锚点同一个
         * 父节点里（同一个 React 子树），而气泡是 position:fixed。只要祖先里有
         * backdrop-filter / filter / transform，就会成为 fixed 后代的包含块，气泡于是被
         * .dshm-root 的 overflow:hidden 裁掉 —— 表现就是「鼠标悬停什么都不出来」。
         * 插件为了毛玻璃恰好给 header / 播放条 / 列头都加了 backdrop-filter，正好踩中。
         * portal 把气泡挂到 document.body（z-index 也升到 1100），彻底绕开裁剪。
         */
        const TIP_PORTAL = true;
        const withTip = (element, label, side = "top") => {
            if (typeof label !== "string" || label.length === 0)
                return element;
            if (Tooltip === null)
                return React.cloneElement(element, { title: label });
            return h(Tooltip, { label, side, portal: TIP_PORTAL }, element);
        };
        const withTipWrapped = (element, label, side = "top") => {
            if (typeof label !== "string" || label.length === 0)
                return element;
            if (Tooltip === null) {
                return h("span", { className: "dshm-tip" }, React.cloneElement(element, { title: label }));
            }
            return h(Tooltip, { label, side, portal: TIP_PORTAL }, h("span", { className: "dshm-tip" }, element));
        };
        /**
         * 搜索框：优先用官方 @deepseek-ai/dsh-client-ui-primitives 的 Input 组件
         * （wrap + 前置图标 + input 三件套，样式与 DSH 自己的搜索框完全一致），
         * 拿不到就退回原来的裸 input，保证老宿主不白屏。
         */
        function searchField(props) {
            if (DshInput !== null) {
                return h(DshInput, {
                    className: "dshm-searchWrap",
                    icon: ICONS.search,
                    type: "search",
                    "aria-label": props.placeholder,
                    spellCheck: false,
                    ...props,
                });
            }
            return h("input", { className: "dshm-search", type: "search", spellCheck: false, ...props });
        }
        /** 收藏：DSH 没有这个能力，插件用 localStorage 记一份（dsh-music:fav）。 */
        const FAV_KEY = "dsh-music:fav";
        function loadFavorites() {
            try {
                const raw = JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]");
                return new Set(Array.isArray(raw) ? raw.filter((value) => typeof value === "string") : []);
            }
            catch {
                return new Set();
            }
        }
        function saveFavorites(set) {
            try {
                localStorage.setItem(FAV_KEY, JSON.stringify([...set]));
            }
            catch {
                // 隐私模式等：收藏是尽力而为。
            }
        }
        /** Locale translator for module-scope code; bound in apply() after locale registers. */
        let translate = (key) => key;
        function formatTime(value) {
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
                return "--:--";
            const total = Math.floor(value);
            const minutes = Math.floor(total / 60);
            const seconds = total % 60;
            return minutes + ":" + String(seconds).padStart(2, "0");
        }
        async function api(path, options) {
            // 调用点写的是宿主端点名（/api/library…），基址本身已经带了 /api，
            // 这里把重复的 /api 段折叠掉，避免出现 /api/dsh-music/api/library。
            const suffix = path.replace(/^\/api/, "");
            let response = await fetch(endpointBase + suffix, options);
            // 回落（A1-02）。判据是**端点语义 + 正向识别**，不是裸状态码：
            //   ① 失败的那个端点必须是「不该 404」的那一类（否则一首没封面的歌就能
            //      把入口判成旧版）；
            //   ② 旧前缀必须真答出宿主数据对象才算认出来；
            //   ③ 只在**采纳成功**时置 entryResolved —— 探测失败下次仍可重试。
            const endpoint = suffix.replace(/^\/|\?.*$/g, '').split('/')[0];
            if (response.status === 404 && !entryResolved && endpointBase === API_BASE
                && ROUTE_MISSING_404_ENDPOINTS.has(endpoint)) {
                const legacy = await fetch(LEGACY_API_BASE + suffix, options);
                const legacyData = await legacy.clone().json().catch(() => null);
                if (legacy.ok && looksLikeHostPayload(legacyData)) {
                    endpointBase = LEGACY_API_BASE;
                    downgradedToLegacy = true;
                    entryResolved = true;
                    // 显式报告降级，不能静默发生（composition.zh.md:143）。
                    if (typeof onDowngrade === "function")
                        onDowngrade();
                    response = legacy;
                }
            }
            const data = await response.json().catch(() => ({}));
            if (!response.ok)
                throw new Error(typeof data.error === "string" ? data.error : "HTTP " + response.status);
            return data;
        }
        /** Client playback prefs persisted across page reloads. */
        const PREFS_KEY = "dsh-music:prefs";
        /** Parsed-once cache: playback position is saved while audio plays, and a
         *  JSON.parse + stringify per save would land on the audio thread's path. */
        let prefsCache = null;
        function loadPrefs() {
            if (prefsCache !== null)
                return prefsCache;
            let next = {};
            try {
                const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
                next = parsed && typeof parsed === "object" ? parsed : {};
            }
            catch {
                // Private mode / 损坏的 JSON：prefs 是尽力而为。
            }
            prefsCache = next;
            return next;
        }
        function savePrefs(patch) {
            const next = { ...loadPrefs(), ...patch };
            prefsCache = next;
            try {
                localStorage.setItem(PREFS_KEY, JSON.stringify(next));
            }
            catch {
                // Private mode etc.: prefs are best-effort.
            }
        }
        /**
         * 在线补全结果（iTunes 匹配的原名/歌手/专辑/封面）按曲目稳定 id 存
         * localStorage：不写回音频文件、不改标签，只覆盖列表与播放条的显示。
         */
        const META_KEY = "dsh-music:meta";
        function loadMeta() {
            try {
                const parsed = JSON.parse(localStorage.getItem(META_KEY) ?? "{}");
                return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
            }
            catch {
                return {};
            }
        }
        function persistMeta(meta) {
            try {
                localStorage.setItem(META_KEY, JSON.stringify(meta));
            }
            catch {
                // Private mode etc.: overrides are best-effort.
            }
        }
        /** 远端封面走宿主代理（限制白名单主机 + 缓存），避免页面 CSP 拦截第三方图片。 */
        const artUrl = (cover) => endpointBase + "/art?u=" + encodeURIComponent(cover);
        /** “匹配结果 == 现有标签”的归一化键：只比较字母/数字/汉字，忽略标点与空白。 */
        const sameKey = (value) => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
        /**
         * 与宿主 buildFileName 一致的“期望文件名”。批量判断“已正确”时必须连
         * 文件名一起比较：标签对但文件名不规范（01.xxx / 裸歌名）也要重命名。
         */
        const FILENAME_ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
        const expectedFileName = (title, artist, name) => {
            const dot = name.lastIndexOf(".");
            const ext = dot > 0 ? name.slice(dot) : "";
            const stem = name.slice(0, dot > 0 ? dot : name.length);
            const wanted = [artist, title]
                .filter((value) => typeof value === "string" && value.trim().length > 0)
                .join(" - ") || stem;
            const cleaned = wanted
                .replace(FILENAME_ILLEGAL, "_")
                .replace(/\s+/g, " ")
                .replace(/^[.\s]+/, "")
                .trim()
                .slice(0, 120)
                .trim();
            return (cleaned.length > 0 ? cleaned : "track") + ext;
        };
        /**
         * Player singleton. The <audio> element lives at module scope (not inside the
         * view tree), so playback keeps running when the user switches to another tab
         * and the Music view unmounts.
         */
        function createPlayer() {
            /**
             * 媒体元素用 <video>：音频文件本来就能播，MV 才有画面可显示（一个元素搞定两种媒体，
             * 进度/seek/MediaSession 全部共用一条路径）。
             * jsdom 没有媒体实现 —— 测试套件通过 window.__dshMusicMedia 注入假元素。
             */
            const audio = typeof window.__dshMusicMedia === "function"
                ? window.__dshMusicMedia()
                : document.createElement("video");
            audio.preload = "auto";
            audio.className = "dshm-mv";
            // 假元素（测试）没有 setAttribute，这里全部可选调用。
            audio.setAttribute?.("playsinline", "");
            audio.setAttribute?.("webkit-playsinline", "");
            /**
             * 媒体元素的停靠位挂在 document.body 上，**不挂在 React 树里**：
             * 切回对话会让插件视图卸载，元素若在 React 树里就会被移出文档，而 HTML 规范
             * 对「媒体元素离开文档」的处理就是暂停 —— 这正是 MV 切走就停的原因。
             */
            let mediaPark = null;
            if (typeof audio.nodeType === "number" && typeof document !== "undefined" && document.body !== null) {
                mediaPark = document.createElement("div");
                mediaPark.className = "dshm-mvPark";
                mediaPark.setAttribute("aria-hidden", "true");
                document.body.appendChild(mediaPark);
                mediaPark.appendChild(audio);
            }
            const prefs = loadPrefs();
            let state = {
                dir: null,
                tracks: [],
                scannedAt: null,
                loading: false,
                picking: false,
                scanning: false,
                /**
                 * 宿主入口：`api`（经连接层 /api 栅栏 + 会话）或 `legacy`（降级到插件
                 * 自建的 /dsh-music 前缀）。降级是信任模型降级，必须让用户看得见。
                 */
                hostEntry: "api",
                /** MV 准备状态：null（非视频）| { id, state, progress, mode, error }。 */
                mv: null,
                /** 补全时顺带转格式：成功后是否把原件丢进废纸篓（默认否，只并存）。 */
                convertDeleteOriginal: false,
                scanParsed: 0,
                scanTotal: 0,
                truncated: false,
                /** 扫描时跳过的 DRM 加密包（.movpkg）数量。 */
                skippedPackages: 0,
                error: null,
                current: -1,
                playing: false,
                mode: prefs.mode === "one" ? "one" : "loop",
                time: 0,
                duration: 0,
                volume: typeof prefs.volume === "number" && prefs.volume >= 0 && prefs.volume <= 1 ? prefs.volume : 1,
                query: "",
                /** 在线补全结果：id → { title?, artist?, album?, cover? }。 */
                meta: loadMeta(),
                /** 补全弹层：null = 关闭，否则 { id, loading, error, candidates }。 */
                match: null,
                /** 一键补全：确认条 + 批处理进度。 */
                pendingComplete: false,
                completing: false,
                completeTotal: 0,
                completeDone: 0,
                completeFailed: 0,
                completeSkipped: 0,
                sortKey: typeof prefs.sortKey === "string" && ["title", "artist", "duration"].includes(prefs.sortKey)
                    ? prefs.sortKey : "none",
                sortDir: prefs.sortDir === "desc" ? "desc" : "asc",
                /** 待确认删除的曲目下标（-1 = 无）。替代 window.confirm 的应用内确认。 */
                pendingDelete: -1,
            };
            audio.volume = state.volume;
            const listeners = new Set();
            const emit = () => {
                for (const listener of listeners)
                    listener();
            };
            // 入口降级 → 落到状态里，由视图渲染成一条可见提示（不静默）。
            onDowngrade = () => set({ hostEntry: "legacy" });
            const set = (patch) => {
                state = { ...state, ...patch };
                emit();
            };
            /** Consecutive decode failures; auto-skip stops once every track failed. */
            let errorStreak = 0;
            /** 单调递增的补全请求序号：同一曲目手动重查时，旧响应不得覆盖新结果。 */
            let matchSeq = 0;
            /** Same-position retries after a mid-playback stream cut (one per failure site). */
            let resumeAttempts = 0;
            /** Forward jumps spent stepping over a locally damaged region (per failure site). */
            let skipAttempts = 0;
            /** Playback position of the last handled failure; cleared once we pass it. */
            let lastFailureAt = 0;
            /**
             * Forward-jump sizes tried in order when a failure repeats at the same
             * spot. A file with a few corrupt frames (bad rip / interrupted download)
             * must not cost the whole track: step over the damage and keep playing.
             */
            const FAILURE_JUMPS = [1.5, 6];
            /**
             * Stable id of the track currently loaded into <audio>, independent of
             * its array index. A rescan can reorder/insert rows; re-mapping by id is
             * the only way the highlighted row keeps matching what is playing.
             */
            let playingId = null;
            /** Stop playback and detach the stream (used before library replacement). */
            const stopAudio = () => {
                playingId = null;
                audio.pause();
                audio.removeAttribute("src");
                audio.load();
            };
            /** Range-stream URL for one track, revisioned by the current scan. */
            /** MV 转码缓存文件的地址：Desktop 下同样走 token 直连（否则拖不动进度）。 */
            const mvCacheUrl = (key) => {
                const encoded = encodeURIComponent(key);
                if (hasStreamBase()) {
                    return systemStreamBase + "&k=" + encoded;
                }
                return endpointBase + "/mvfile?k=" + encoded;
            };
            /**
             * 是否运行在 DSH Desktop。**每次调用现算**，不看模块加载时抓的 window.dshDesktop
             * —— 插件先于产品 API 注入执行时那个值是 undefined，于是媒体一直用相对地址，
             * 经 Desktop 转发后 Range 丢失 → seekable=[0,0] → 一拖就回 0 秒（实测读数如此）。
             */
            const hasStreamBase = () => typeof systemStreamBase === "string" && systemStreamBase.length > 0;
            /**
             * 等一次 /session（媒体直连基址）。返回是否**真的**拿到了。
             *
             * ⚠️ 不能「超时就算了」：拿不到基址就意味着媒体只能用**相对地址**，而相对地址
             * 在 Desktop 上经 Electron 转发会丢 Range（`seekable=[0,0]`）⇒ 一拖进度条就回 0
             * 秒。所以先给一次预算，还没有就**作废缓存强制重取**再来一次 —— 第二次会走
             * `/session` 的回环回落路径（见 loadSystemArtBase），这正是 Desktop 上唯一能走通的路。
             */
            const ensureStreamBase = async () => {
                if (hasStreamBase())
                    return true;
                await Promise.race([loadSystemArtBase(), new Promise((resolve) => setTimeout(resolve, 2000))]);
                if (hasStreamBase())
                    return true;
                invalidateSessionBase();
                await Promise.race([loadSystemArtBase(true), new Promise((resolve) => setTimeout(resolve, 4000))]);
                return hasStreamBase();
            };
            const streamUrl = (track) => {
                const rev = "&v=" + (state.scannedAt ?? 0);
                // Desktop：走 token 直连（保住 Range，拖动/快进才不会回到 0 秒）。
                if (hasStreamBase()) {
                    return systemStreamBase + "&p=" + encodeURIComponent(track.id) + rev;
                }
                return endpointBase + "/stream?p=" + encodeURIComponent(track.id) + rev;
            };
            /** Move the audio clock (clamped to the track) without touching store state. */
            /** 后台日志（不占界面）：排查"拖不动进度"用，DevTools 控制台可见。 */
            /**
             * 媒体源分类 + 是否已有 token 基址。「一拖就回 0」的排查全靠这行，
             * 所以分类必须**无歧义**：空串 / blob: / dsh-app:// / 相对路径原来会被
             * 一起算成 `rel`，等于看不出到底是哪一路。
             */
            const mediaSrcKind = (url) => {
                if (url === "")
                    return "empty";
                if (url.startsWith("http"))
                    return url.includes("system-stream") ? "token" : "abs";
                if (url.includes("/mvfile"))
                    return "mvfile-rel";
                if (url.startsWith("blob:"))
                    return "blob";
                return "rel";
            };
            /** 日志里不得出现能力 token（§2.9 凭据不进日志）。 */
            const redactSrc = (url) => url.replace(/t=[^&]*/g, "t=***");
            const logSeek = (asked) => {
                setTimeout(() => {
                    try {
                        const seekable = audio.seekable ?? null;
                        const bounds = seekable !== null && seekable.length > 0
                            ? seekable.start(0).toFixed(1) + ".." + seekable.end(0).toFixed(1) : "-";
                        const src = typeof audio.currentSrc === "string" ? audio.currentSrc : "";
                        console.info("[dsh-music] seek asked=" + asked.toFixed(1) + " now=" + (Number.isFinite(audio.currentTime) ? audio.currentTime.toFixed(1) : "?")
                            + " dur=" + (Number.isFinite(audio.duration) ? audio.duration.toFixed(1) : String(audio.duration))
                            + " seekable=" + (seekable === null ? "-" : seekable.length) + "(" + bounds + ")"
                            + " src=" + mediaSrcKind(src) + " err=" + (audio.error !== null && audio.error !== undefined ? audio.error.code : 0)
                            + " base=" + (hasStreamBase() ? "token" : "none") + " ep=" + endpointBase
                            + " url=" + redactSrc(src));
                    }
                    catch { /* 日志失败无所谓 */ }
                }, 400);
            };
            /**
             * 「一拖就回 0 秒」的可观测判据自愈（第 13 轮）。
             *
             * 判据是**症状**，不是原因：源不是 token 直连、时长已知、而 `seekable` 是 [0,0]
             * —— 这时媒体元素根本不能 seek，`currentTime = X` 只会让它从 0 重来。真机上
             * 读到的正是 `seekable=1(0.0..0.0) src=rel`。
             *
             * 成因（相对地址在 Desktop 上经 Electron 转发丢 Range）已在 §2.14 记过，
             * 但**只修成因不够**：基址可能因为平台 /api 的 401/403 而一直拿不到。所以这里
             * 按症状兜底 —— 作废基址、重取（含 /session 的回环回落）、用 token 地址重挂同一
             * 媒体并回到原位。只做一次，避免「失败→重取→再失败」的死循环。
             */
            let unseekableSrc = "";
            let unseekableHealDeadline = 0;
            let unseekableTimer = null;
            /** 自愈窗口：只有源真的不可 seek 才会进来，所以在这里等基址是值得的（有界，非无限）。 */
            const UNSEEKABLE_HEAL_WINDOW_MS = 20000;
            const healUnseekableSource = () => {
                if (disposed)
                    return;
                const src = typeof audio.currentSrc === "string" ? audio.currentSrc : "";
                if (src.includes("system-stream"))
                    return; // 已是 token 直连，基址没问题
                if (!(Number.isFinite(audio.duration) && audio.duration > 0))
                    return;
                const range = audio.seekable ?? null;
                if (range === null)
                    return; // 拿不到可寻址信息就不猜（假元素可能没有这个属性）
                if (range.length > 0 && range.end(0) > 0)
                    return; // 能 seek，正常
                const index = state.current;
                const track = index >= 0 ? state.tracks[index] : undefined;
                if (track === undefined)
                    return;
                // 换了源就重新开一个窗口（每首歌各有自己的预算）。
                // ⚠️ 条件必须带 `deadline === 0`：首次调用时 `src` 可能与 `unseekableSrc`
                // 的初值同为 ""（假元素没有 currentSrc 时就是如此），只判「变了」会导致
                // deadline 永远停在 0 → 第一行就 `Date.now() > 0` 直接 return，自愈从不执行。
                if (src !== unseekableSrc || unseekableHealDeadline === 0) {
                    unseekableSrc = src;
                    unseekableHealDeadline = Date.now() + UNSEEKABLE_HEAL_WINDOW_MS;
                }
                if (Date.now() > unseekableHealDeadline)
                    return; // 窗口内一直没成功：放弃，不再打扰
                const wasAt = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
                const wasPlaying = state.playing;
                invalidateSessionBase();
                void (async () => {
                    const usable = await ensureStreamBase();
                    if (disposed || playingId !== track.id)
                        return;
                    if (!usable) {
                        // ⚠️ 基址还没就绪时**不能一次就放弃**。第一版就是一次性的：第一次尝试压在
                        // 宿主还没准备好的时刻上，失败后永久锁死 —— 真机上等于自愈从未生效。
                        // 退回窗口内再试，由 deadline 收口，不会变成无限重试。
                        scheduleUnseekableHeal(1200);
                        return;
                    }
                    // ⚠️ 按**当前这条源是什么类型**决定怎么修，不能按 track.kind 猜：
                    //   含 `/mvfile` 或 `&k=` → MV 转码缓存文件，要重新问一次 /api/mv 拿缓存键；
                    //   否则                  → 音轨 / 音频流，重建 streamUrl 即可。
                    // 真机教训：`.mov` 走 **WASM 旁路**时元素播的是 `/stream?p=<视频文件>`
                    // （画面由 WASM 解，元素只播音轨），而这时 track.kind 仍是 "video" —— 按 kind
                    // 去 prepareVideo 会去等一次可能长达几分钟的转码，自愈于是永远卡住、源从未被换掉
                    // （用户日志里 url 从第一次 seek 到最后一次完全没变，就是这个原因）。
                    const wasMvCache = src.includes("/mvfile") || src.includes("&k=");
                    const next = wasMvCache ? await prepareVideo(track) : streamUrl(track);
                    if (disposed || playingId !== track.id)
                        return;
                    if (next === null) {
                        scheduleUnseekableHeal(1200);
                        return;
                    } // 还没就绪：窗口内再试
                    audio.src = next;
                    audio.addEventListener("loadedmetadata", () => {
                        if (playingId !== track.id)
                            return;
                        if (wasAt > 0 && Number.isFinite(audio.duration) && wasAt < audio.duration - 0.5)
                            audio.currentTime = wasAt;
                        if (wasPlaying) {
                            const promise = audio.play();
                            if (promise !== undefined)
                                promise.catch(() => { });
                        }
                    }, { once: true });
                    audio.load();
                })();
            };
            /** 换源后延迟一点再判：`seekable` 在 loadedmetadata 当场可能还没填好。 */
            const scheduleUnseekableHeal = (delayMs = 700) => {
                if (disposed)
                    return; // 已立闸门：不再排期（§2.10）
                if (unseekableTimer !== null)
                    clearTimeout(unseekableTimer);
                unseekableTimer = setTimeout(() => {
                    unseekableTimer = null;
                    healUnseekableSource();
                }, delayMs);
            };
            /** 挂非 token 源时记一行 —— Desktop 上这就是「之后拖不动」的前兆，正常路径不刷屏。 */
            const logAttach = (url) => {
                const kind = mediaSrcKind(url);
                if (kind === "token")
                    return;
                console.info("[dsh-music] attach kind=" + kind + " base=" + (hasStreamBase() ? "token" : "none")
                    + " ep=" + endpointBase + " url=" + redactSrc(url));
            };
            /** 每次换源都会重新触发 loadedmetadata，在这里统一检查这个源能不能 seek。 */
            audio.addEventListener("loadedmetadata", () => { scheduleUnseekableHeal(); });
            const seekAudio = (value) => {
                if (!Number.isFinite(value))
                    return 0;
                const known = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration;
                const at = known > 0 ? Math.max(0, Math.min(known, value)) : Math.max(0, value);
                // Re-assigning the position we are already at would abort and re-issue
                // the range request (the native change event lands after pointerup).
                if (!Number.isFinite(audio.currentTime) || Math.abs(audio.currentTime - at) > 0.01)
                    audio.currentTime = at;
                return at;
            };
            /** Remember the resume position. localStorage writes are synchronous, so
             *  timeupdate only persists every ~5s; pause/pagehide flush exactly. */
            let lastSavedAt = -1;
            const savePosition = (force) => {
                if (state.current < 0)
                    return;
                const track = state.tracks[state.current];
                if (track === undefined)
                    return;
                const at = Math.max(0, Math.floor(audio.currentTime));
                if (!force && Math.abs(at - lastSavedAt) < 5)
                    return;
                lastSavedAt = at;
                savePrefs({ last: { id: track.id, time: at } });
            };
            /** One outstanding library poll while a host-side scan is running. */
            let pollTimer = null;
            /**
             * Teardown 之后的「不得再武装」闸门（A3-01）。
             *
             * 只清 `pollTimer` 不够：若 teardown 撞上某次轮询**在飞**，回调开头已把
             * `pollTimer` 置 null，`clearTimeout` 落空；该请求又因宿主路由已摘除而 404，
             * 回调的 `catch` 会再武装定时器 —— 之后 `state.scanning` 若没被复位，守卫
             * `if (!state.scanning) return` 永不成立，卸载后就是 1.5s 一次的永久请求风暴。
             * 所以「清句柄」与「阻止再武装」必须分开做：这里加状态位，`halt()` 里复位
             * `scanning`。
             */
            let disposed = false;
            const schedulePoll = () => {
                if (disposed || pollTimer !== null)
                    return;
                pollTimer = setTimeout(async () => {
                    pollTimer = null;
                    if (disposed || !state.scanning)
                        return;
                    try {
                        applyLibrary(await api("/api/library"));
                    }
                    catch {
                        if (!disposed)
                            schedulePoll();
                    }
                }, 1500);
            };
            const applyLibrary = (payload) => {
                const scanning = payload.scanning === true;
                const incoming = payload.tracks ?? [];
                // A host scan reports no rows (library = null while it runs). For a
                // refresh of the SAME directory, keep the current table and the
                // scannedAt cache-busters so the list does not blank out mid-scan.
                const keepRows = scanning && incoming.length === 0 && state.dir !== null && payload.dir === state.dir;
                const nextTracks = keepRows ? state.tracks : incoming;
                // 补全结果按稳定 id 保存：库变化时剔除已不在库内的条目，防止旧目录的
                // 补全串到新目录里的同名文件（id 是相对路径，可能重名）。
                let nextMeta = state.meta;
                if (!scanning) {
                    const liveIds = new Set(nextTracks.map((track) => track.id));
                    let stale = false;
                    for (const id of Object.keys(state.meta)) {
                        if (!liveIds.has(id)) {
                            stale = true;
                            break;
                        }
                    }
                    if (stale) {
                        const pruned = {};
                        for (const track of nextTracks) {
                            if (state.meta[track.id] !== undefined)
                                pruned[track.id] = state.meta[track.id];
                        }
                        nextMeta = pruned;
                        persistMeta(pruned);
                    }
                }
                set({
                    dir: payload.dir,
                    tracks: nextTracks,
                    meta: nextMeta,
                    scannedAt: scanning && payload.scannedAt == null ? state.scannedAt : (payload.scannedAt ?? null),
                    scanning,
                    scanParsed: payload.scanParsed ?? 0,
                    scanTotal: payload.scanTotal ?? 0,
                    truncated: keepRows ? state.truncated : payload.truncated === true,
                    skippedPackages: keepRows ? state.skippedPackages : (payload.skippedPackages ?? 0),
                    error: null,
                    pendingDelete: scanning ? state.pendingDelete : -1,
                });
                if (scanning) {
                    // Keep the current playback untouched while the new scan runs.
                    schedulePoll();
                    return;
                }
                // Cover probes are keyed by id: drop ids that left the library so the
                // map cannot grow across directory switches.
                const liveIds = new Set(state.tracks.map((track) => track.id));
                for (const id of coverKnown.keys()) {
                    if (!liveIds.has(id))
                        coverKnown.delete(id);
                }
                remapCurrent();
                restoreLastPlayed();
            };
            /** After a fresh library arrives, re-map the playing track by stable id. */
            const remapCurrent = () => {
                if (playingId === null)
                    return;
                const nextIndex = state.tracks.findIndex((track) => track.id === playingId);
                if (nextIndex >= 0) {
                    if (nextIndex !== state.current)
                        set({ current: nextIndex });
                    return;
                }
                // The playing track vanished from the library: stop for real, not just UI.
                stopAudio();
                set({ current: -1, playing: false, time: 0, duration: 0 });
            };
            const load = async () => {
                set({ loading: true, error: null });
                try {
                    applyLibrary(await api("/api/library"));
                }
                catch (error) {
                    set({ error: error instanceof Error ? error.message : String(error) });
                }
                finally {
                    set({ loading: false });
                }
            };
            /** Cue the last played track (paused, at the remembered position). */
            let lastPlayedRestored = false;
            const restoreLastPlayed = () => {
                if (lastPlayedRestored || state.current >= 0)
                    return;
                const last = loadPrefs().last;
                if (last === undefined || typeof last.id !== "string") {
                    // 从未保存过曲目：这次库无论大小都无回补对象，标记完成。
                    lastPlayedRestored = true;
                    return;
                }
                const index = state.tracks.findIndex((track) => track.id === last.id);
                // 保存过的曲目不在当前库：先不标记完成，等下一次（换目录/刷新）
                // 载入包含该曲目的库时再回补。
                if (index < 0)
                    return;
                lastPlayedRestored = true;
                const track = state.tracks[index];
                playingId = track.id;
                set({
                    current: index,
                    duration: typeof track.duration === "number" ? track.duration : 0,
                    mv: track.kind === "video" ? { id: track.id, state: "checking", progress: 0, mode: null, error: null } : null,
                });
                updateMediaSession();
                if (track.kind === "video") {
                    // 视频轨：先拿 MV 地址（可能要先转封装），拿到再挂源。
                    void prepareVideo(track).then((url) => {
                        if (url === null || playingId !== track.id)
                            return;
                        attachSource(url);
                        audio.pause();
                    });
                    return;
                }
                // 音频：同样要先等媒体直连基址。用一个 IIFE 包住是因为 streamUrl() 是同步的，
                // 而基址可能是这次才去取的——不等就会拼出相对地址，Desktop 上丢了 Range，
                // cue 出来的这首之后一拖进度就回 0 秒（与 MV 同一个根因）。
                void (async () => {
                    await ensureStreamBase();
                    if (playingId !== track.id)
                        return;
                    audio.src = streamUrl(track);
                    if (typeof last.time === "number" && last.time > 0) {
                        audio.addEventListener("loadedmetadata", () => {
                            // The user may have picked another track before metadata landed:
                            // the stale resume position must not hijack that track.
                            if (state.current !== index || playingId !== track.id)
                                return;
                            if (Number.isFinite(audio.duration) && last.time < audio.duration - 1) {
                                audio.currentTime = last.time;
                                set({ time: last.time });
                            }
                        }, { once: true });
                    }
                })();
            };
            /** 换源并开播（音频与 MV 共用；MV 的 URL 由 /mv 决定）。 */
            const attachSource = (url) => {
                logAttach(url);
                audio.src = url;
                audio.volume = state.volume;
                const promise = audio.play();
                if (promise === undefined)
                    return;
                promise.catch((error) => {
                    if (error?.name === "NotAllowedError") {
                        set({ playing: false });
                        return;
                    }
                    set({ playing: false, error: translate("error.unsupported") });
                });
            };
            /**
             * 视频轨要出画面，先问宿主怎么办：direct 直出 / remux 换壳 / transcode 重编码。
             * 后两种要等 ffmpeg 干活，轮询到 ready 再拿到缓存文件 URL（缓存命中就秒回）。
             */
            /** 已经升级过转码的视频轨（避免失败→升级→再失败的死循环）。 */
            const mvEscalated = new Set();
            const prepareVideo = async (track, forcedMode) => {
                // ⚠️ 必须先拿到媒体直连基址再拼 URL。mvCacheUrl() 在基址为空时会退回**相对**
                // 地址 `/api/dsh-music/mvfile?k=…`，而 Desktop 上相对地址要经 Electron
                // forwardWebRequest —— **那条路会丢 Range/206**，于是 <video> 认为流不可 seek，
                // 症状就是「MV 进度条一拖就从头开始播」。
                // 放在这里而不是每个调用点：5 个调用点里有 4 个不会自己 await
                // （restoreLastPlayed、两处 error→转码升级、手动转换）。
                await ensureStreamBase();
                for (let round = 0; round < 900; round += 1) {
                    if (playingId !== track.id)
                        return null;
                    let payload;
                    try {
                        payload = await api("/api/mv?id=" + encodeURIComponent(track.id)
                            + (typeof forcedMode === "string" ? "&mode=" + forcedMode : ""));
                    }
                    catch (error) {
                        // 与原来 `String(error?.message ?? error)` 逐字等价：catch 变量在
                        // useUnknownInCatchVariables 下是 unknown，用 typeof / in 收窄后取同一个值。
                        const detail = error !== null && (typeof error === "object" || typeof error === "function") && "message" in error
                            ? (error.message ?? error) : error;
                        set({ mv: { id: track.id, state: "failed", progress: 0, mode: null, error: String(detail) } });
                        return null;
                    }
                    if (playingId !== track.id)
                        return null;
                    if (payload.state === "ready" && (typeof payload.key === "string" || typeof payload.url === "string")) {
                        set({ mv: { id: track.id, state: "ready", progress: 1, mode: payload.mode ?? null, error: null } });
                        // 有 key 就自己拼（Desktop 下用 token 直连，保住 Range）；否则退回宿主给的相对地址
                        return typeof payload.key === "string" ? mvCacheUrl(payload.key) : payload.url;
                    }
                    if (payload.state === "failed") {
                        set({ mv: { id: track.id, state: "failed", progress: 0, mode: payload.mode ?? null, error: payload.error ?? null } });
                        return null;
                    }
                    set({ mv: { id: track.id, state: "preparing", progress: typeof payload.progress === "number" ? payload.progress : 0, mode: payload.mode ?? null, error: null } });
                    await new Promise((resolve) => setTimeout(resolve, 700));
                }
                return null;
            };
            /**
             * WASM 画面旁路：浏览器没有的解码器（mpeg4/DivX、老 mpeg2 等）用
             * libav.js 的 WebCodecs polyfill 补上，帧直接画到 canvas。
             * 音频继续由现有 <video> 播 /stream（本来就能播），所以不用碰 A/V 同步最难的那半。
             * 任何一步失败都返回 false，让调用方退回只读缓存转码 —— 绝不改用户的文件。
             */
            let wasmCanvas = null;
            let wasmAbort = null;
            const stopWasmVideo = () => {
                if (wasmAbort !== null)
                    wasmAbort.aborted = true;
                wasmAbort = null;
            };
            const WASM_CODECS = new Set(["mpeg4", "mpeg2", "vc1", "theora", "msmpeg4"]);
            const startWasmVideo = async (track, stage) => {
                if (typeof document === "undefined" || stage === null || stage === undefined)
                    return false;
                try {
                    const libavUrl = endpointBase + "/mvlib?f=" + encodeURIComponent("@libav.js/variant-webcodecs/dist/libav-6.10.9.0-webcodecs.mjs");
                    const polyUrl = endpointBase + "/mvlib?f=" + encodeURIComponent("libavjs-webcodecs-polyfill/dist/libavjs-webcodecs-polyfill.min.mjs");
                    const mbUrl = endpointBase + "/mvlib?f=" + encodeURIComponent("mediabunny/dist/bundles/mediabunny.min.mjs");
                    const [libav, polyfill, mediabunny] = await Promise.all([import(libavUrl), import(polyUrl), import(mbUrl)]);
                    // 这个包的 ESM 导出是具名 load（不是 README 里那个 LibAVWebCodecs.load）
                    const loadPolyfill = polyfill.load ?? polyfill.LibAVWebCodecs?.load;
                    if (typeof loadPolyfill !== "function")
                        return false;
                    await loadPolyfill.call(polyfill, { polyfill: true, libavOptions: { LibAV: libav.LibAV ?? libav.default ?? libav } });
                    const buffer = await (await fetch(streamUrl(track))).arrayBuffer();
                    const input = new mediabunny.Input({ source: new mediabunny.BlobSource(new Blob([buffer])), formats: mediabunny.ALL_FORMATS });
                    const videoTrack = await input.getPrimaryVideoTrack();
                    if (videoTrack === null || videoTrack === undefined)
                        return false;
                    const sink = new mediabunny.CanvasSink(videoTrack, { width: 1280 });
                    const canvas = document.createElement("canvas");
                    canvas.className = "dshm-mvCanvas";
                    stage.querySelector(".dshm-mvCanvas")?.remove();
                    stage.appendChild(canvas);
                    // 这块 canvas 是上面刚 createElement 出来的、且从未请求过别的上下文，
                    // 所以 "2d" 上下文必然拿得到（getContext 只在类型不支持或已请求过其它
                    // 类型时返回 null）；非空断言因此可证，也没有改变任何失败路径的行为
                    // （原来的实现同样不做判空，只在拿不到时于绘制处抛错并静默停住画面）。
                    const ctx = canvas.getContext("2d");
                    wasmCanvas = canvas;
                    const token = { aborted: false };
                    wasmAbort = token;
                    void (async () => {
                        for await (const frame of sink.canvases()) {
                            if (token.aborted || playingId !== track.id)
                                return;
                            // 跟音频时钟对齐：画面快了就等，慢了就丢帧（丢帧比卡顿好看）
                            const at = typeof frame.timestamp === "number" ? frame.timestamp / 1e6 : 0;
                            const drift = at - (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
                            if (drift > 0.15)
                                await new Promise((r) => setTimeout(r, Math.min(200, drift * 500)));
                            if (drift < -0.4)
                                continue;
                            canvas.width = frame.canvas.width;
                            canvas.height = frame.canvas.height;
                            ctx.drawImage(frame.canvas, 0, 0);
                        }
                    })().catch(() => { });
                    return true;
                }
                catch {
                    stopWasmVideo();
                    return false;
                }
            };
            const playIndex = (index) => {
                const track = state.tracks[index];
                if (track === undefined)
                    return;
                resumeAttempts = 0;
                skipAttempts = 0;
                lastFailureAt = 0;
                playingId = track.id;
                stopWasmVideo(); // 换曲：停掉上一条的 WASM 解码循环
                set({
                    current: index,
                    time: 0,
                    duration: typeof track.duration === "number" ? track.duration : 0,
                    mv: track.kind === "video" ? { id: track.id, state: "checking", progress: 0, mode: null, error: null } : null,
                });
                savePrefs({ last: { id: track.id, time: 0 } });
                updateMediaSession();
                if (track.kind === "video") {
                    void (async () => {
                        await ensureStreamBase(); // 先拿到媒体直连基址（拖不动进度就是它没拿到）
                        // 1) 浏览器没有这个解码器 → 先试 WASM 旁路（不碰文件、不用等转码）
                        if (WASM_CODECS.has(track.videoCodec ?? "")) {
                            await new Promise((resolve) => setTimeout(resolve, 30)); // 等 React 把画面槽渲染出来
                            const stage = typeof document === "undefined" ? null : document.querySelector(".dshm-mvStage");
                            const ok = await startWasmVideo(track, stage);
                            if (ok && playingId === track.id) {
                                attachSource(streamUrl(track)); // 音频照旧走 /stream
                                set({ mv: { id: track.id, state: "ready", progress: 1, mode: "wasm", error: null } });
                                return;
                            }
                        }
                        // 2) 退回只读缓存转码（同样不改用户文件）
                        const url = await prepareVideo(track);
                        if (url === null || playingId !== track.id)
                            return;
                        attachSource(url);
                        guardVideoPicture(track);
                    })();
                    return;
                }
                // 音频：先等媒体直连基址再挂源（拿不到就退回相对地址，播放不受影响）。
                void (async () => {
                    await ensureStreamBase();
                    if (playingId !== track.id)
                        return;
                    attachSource(streamUrl(track));
                })();
                return;
            };
            /**
             * 可见列表（筛选 + 排序后的行序）。它就是播放队列：
             * next/prev/播完自动下一首/出错自动跳过，全部按这个顺序走——
             * 用户在表格里看到的上下关系就是实际的播放先后。
             * Cached by (tracks, query, sort) so render + next/prev + error paths
             * share one sorted array instead of re-sorting per call.
             */
            /** 叠加在线补全后的展示信息（不改动 state.tracks 本身）。 */
            const effective = (track) => {
                if (track === undefined)
                    return undefined;
                const meta = state.meta[track.id];
                if (meta === undefined)
                    return track;
                return {
                    ...track,
                    title: typeof meta.title === "string" && meta.title.length > 0 ? meta.title : track.title,
                    artist: typeof meta.artist === "string" && meta.artist.length > 0 ? meta.artist : track.artist,
                    album: typeof meta.album === "string" && meta.album.length > 0 ? meta.album : undefined,
                };
            };
            /** 优先用补全的远端封面，否则回退文件内嵌封面。 */
            const coverFor = (track) => {
                const meta = track === undefined ? undefined : state.meta[track.id];
                if (meta !== undefined && typeof meta.cover === "string" && meta.cover.length > 0)
                    return artUrl(meta.cover);
                return coverUrl(track === undefined ? "" : track.id);
            };
            let rowsCache = null;
            const visibleRows = () => {
                const cache = rowsCache;
                if (cache !== null && cache.tracks === state.tracks && cache.query === state.query
                    && cache.sortKey === state.sortKey && cache.sortDir === state.sortDir
                    && cache.meta === state.meta) {
                    return cache.rows;
                }
                const query = state.query.trim().toLowerCase();
                let rows;
                if (query.length === 0) {
                    rows = state.tracks.map((track, index) => ({ track, index }));
                }
                else {
                    rows = [];
                    for (let index = 0; index < state.tracks.length; index += 1) {
                        const track = state.tracks[index];
                        const item = effective(track);
                        const haystack = (item.title + " " + (item.artist ?? "") + " " + track.name).toLowerCase();
                        if (haystack.includes(query))
                            rows.push({ track, index });
                    }
                }
                if (state.sortKey !== "none") {
                    rows = [...rows].sort((a, b) => {
                        const dir = state.sortDir === "asc" ? 1 : -1;
                        const va = effective(a.track)[state.sortKey];
                        const vb = effective(b.track)[state.sortKey];
                        if (va == null && vb == null)
                            return a.index - b.index;
                        if (va == null)
                            return 1;
                        if (vb == null)
                            return -1;
                        const order = typeof va === "number" && typeof vb === "number"
                            ? va - vb
                            : String(va).localeCompare(String(vb), "zh-Hans-CN", { numeric: true, sensitivity: "base" });
                        return dir * (order || (a.index - b.index));
                    });
                }
                rowsCache = { tracks: state.tracks, query: state.query, sortKey: state.sortKey, sortDir: state.sortDir, meta: state.meta, rows };
                return rows;
            };
            const next = () => {
                const rows = visibleRows();
                if (rows.length === 0)
                    return;
                // 当前曲目不在可见列表里（被筛选掉）时，从第一行开始。
                const pos = rows.findIndex((row) => row.index === state.current);
                playIndex(rows[(pos + 1) % rows.length].index);
            };
            const prev = () => {
                const rows = visibleRows();
                if (rows.length === 0)
                    return;
                // macOS Music behavior: beyond 3s into the song, "previous" restarts it.
                if (audio.currentTime > 3 && state.current >= 0) {
                    audio.currentTime = 0;
                    return;
                }
                const pos = rows.findIndex((row) => row.index === state.current);
                playIndex(rows[pos <= 0 ? rows.length - 1 : pos - 1].index);
            };
            audio.addEventListener("timeupdate", () => {
                if (state.current < 0)
                    return;
                const live = audio.currentTime;
                // Playback moved 5s past the last failure: that failure is behind us,
                // so a later, independent bad spot gets its own retry budget again.
                if (lastFailureAt > 0 && live > lastFailureAt + 5) {
                    resumeAttempts = 0;
                    skipAttempts = 0;
                    lastFailureAt = 0;
                }
                const liveDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration;
                // The progress bar follows the audio clock itself (rAF), so publishing
                // every ~4Hz timeupdate would only re-render the track list: publish on
                // the whole second, or immediately when the duration finally arrives.
                if (liveDuration !== state.duration || Math.floor(live) !== Math.floor(state.time)) {
                    set({ time: live, duration: liveDuration });
                    // 同一处节流（≈1Hz）顺手把进度推给系统 Now Playing 的进度条。
                    updatePositionState();
                }
                savePosition(false);
            });
            const coverUrl = (id) => endpointBase + "/cover?p=" + encodeURIComponent(id) + "&v=" + (state.scannedAt ?? 0);
            /**
             * Apple Music–style placeholder artwork for the OS now-playing widget.
             * MediaSession needs a raster URL, so the icon (pink gradient rounded
             * square + white beamed note) is drawn once on a canvas and cached.
             */
            let fallbackArtwork;
            const mediaArtworkFallback = () => {
                if (fallbackArtwork !== undefined)
                    return fallbackArtwork;
                try {
                    const size = 256;
                    const canvas = document.createElement("canvas");
                    canvas.width = size;
                    canvas.height = size;
                    const ctx = canvas.getContext("2d");
                    if (ctx === null)
                        return (fallbackArtwork = null);
                    const radius = size * 0.225;
                    const gradient = ctx.createLinearGradient(0, 0, size, size);
                    gradient.addColorStop(0, "#fb5c74");
                    gradient.addColorStop(0.55, "#f7415f");
                    gradient.addColorStop(1, "#e0304a");
                    ctx.fillStyle = gradient;
                    ctx.beginPath();
                    ctx.moveTo(radius, 0);
                    ctx.lineTo(size - radius, 0);
                    ctx.arcTo(size, 0, size, radius, radius);
                    ctx.lineTo(size, size - radius);
                    ctx.arcTo(size, size, size - radius, size, radius);
                    ctx.lineTo(radius, size);
                    ctx.arcTo(0, size, 0, size - radius, radius);
                    ctx.lineTo(0, radius);
                    ctx.arcTo(0, 0, radius, 0, radius);
                    ctx.closePath();
                    ctx.fill();
                    // Reuse the sidebar note glyph (16x16 viewBox) as the white note.
                    const note = new Path2D("M12.9 1.3 5.9 2.9c-.5.1-.9.6-.9 1.1v6.9c-.3-.1-.7-.2-1-.2-1.2 0-2.2.8-2.2 1.9s1 1.9 2.2 1.9 2.2-.8 2.2-1.9V5.4c0-.3.2-.6.5-.6l5.7-1.3c.3-.1.6.2.6.5v5.3c-.3-.1-.7-.2-1-.2-1.2 0-2.2.8-2.2 1.9s1 1.9 2.2 1.9 2.2-.8 2.2-1.9V2.2c0-.5-.4-1-1.3-.9z");
                    const scale = (size / 16) * 0.62;
                    ctx.save();
                    ctx.translate(size / 2 - 8 * scale, size / 2 - 8 * scale);
                    ctx.scale(scale, scale);
                    ctx.fillStyle = "#ffffff";
                    ctx.fill(note);
                    ctx.restore();
                    fallbackArtwork = canvas.toDataURL("image/png");
                }
                catch {
                    // No canvas (or Path2D): fall back to the cover URL as before.
                    fallbackArtwork = null;
                }
                return fallbackArtwork;
            };
            /** id → true | false (has embedded cover); absent = not probed yet. */
            const coverKnown = new Map();
            const probeCover = (track) => {
                if (coverKnown.has(track.id))
                    return;
                coverKnown.set(track.id, null); // in-flight
                const image = new Image();
                image.onload = () => {
                    coverKnown.set(track.id, true);
                    if (state.current >= 0 && state.tracks[state.current]?.id === track.id)
                        updateMediaSession();
                };
                image.onerror = () => {
                    coverKnown.set(track.id, false);
                    if (state.current >= 0 && state.tracks[state.current]?.id === track.id)
                        updateMediaSession();
                };
                image.src = coverUrl(track.id);
            };
            /**
             * macOS 的「正在播放」（控制中心 / 锁屏 / 触控栏）由系统 MediaRemote 抓封面，
             * 它只接受能真正解析到的绝对 URL；在 dsh-app:// 自定义协议下相对路径容易
             * 被判成无效资源，于是封面一直是空白。统一转绝对地址。
             */
            const absoluteUrl = (value) => {
                try {
                    return new URL(value, window.location.href).href;
                }
                catch {
                    return value;
                }
            };
            /**
             * 系统媒体卡片（MediaSession artwork）用的封面地址。
             *
             * 必须是绝对 http(s) / data / blob —— Chromium 会直接拒收其它 scheme
             * （"MediaImage src can only be of http/https/data/blob scheme"），
             * Desktop 的 dsh-app:// 就是被拒的那一类，表现是「有歌名没封面」。
             * Desktop 用外壳回环 origin + 免会话 cookie 的旧前缀；Web 用页面同源绝对地址。
             */
            const systemMediaUrl = (path, query) => {
                // Web（DESKTOP=false）保持同源地址不变——那条路本来就正常。
                if (DESKTOP && typeof systemArtBase === "string" && systemArtBase.length > 0) {
                    return systemArtBase + "&" + query;
                }
                return absoluteUrl(endpointBase + path + "?" + query);
            };
            /**
             * 把播放进度同步给系统 Now Playing 的进度条（macOS 控制中心可以直接拖动）。
             * setPositionState 的参数校验很严：duration 必须是有限的正值、position 不得
             * 超过 duration，否则整段调用抛异常；所以先夹紧再调。
             */
            const updatePositionState = () => {
                if (!("mediaSession" in navigator))
                    return;
                if (typeof navigator.mediaSession.setPositionState !== "function")
                    return;
                if (state.current < 0)
                    return;
                try {
                    const live = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration;
                    if (!Number.isFinite(live) || live <= 0)
                        return;
                    const position = Math.min(Math.max(audio.currentTime, 0), live);
                    navigator.mediaSession.setPositionState({
                        duration: live,
                        playbackRate: Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1,
                        position,
                    });
                }
                catch {
                    // 旧引擎 / 越界参数：进度只是装饰，绝不因此打断播放。
                }
            };
            /**
             * Desktop 通知栏：换曲时给一条原生通知（Electron 把它转成 macOS/Windows
             * 系统通知）。策略上只在窗口失焦时发，否则会抢焦点、刷屏。
             * 官方 desktop app 文档只注入 window.dshDesktop 标记（不带 IPC 能力），
             * 所以这里用标准 Web Notification；icon 在支持的平台上直接显示专辑封面。
             */
            /**
             * 只在实际开始播放时提示：页面加载时把上次曲目 cue 成暂停态、或用户手动暂停，
             * 都不该弹通知。'play' 事件里 state.playing 已经为 true，换曲/自动下一首也会
             * 走到同一处，所以一个判据覆盖全部路径。
             */
            const NOTIFY_ALWAYS = true;
            let lastNoticeId = null;
            const notifyTrack = (track, view, artwork, playing) => {
                if (!DESKTOP || track === undefined)
                    return;
                if (lastNoticeId === track.id)
                    return;
                if (playing !== true)
                    return;
                // 焦点策略：默认每次换曲都提示（静音横幅），窗口失焦时当然也提示。
                // 想安静一点就把 NOTIFY_ALWAYS 改成 false，只在窗口失焦时提示。
                if (!NOTIFY_ALWAYS && document.visibilityState === "visible" && document.hasFocus())
                    return;
                lastNoticeId = track.id;
                if (typeof Notification !== "function")
                    return;
                try {
                    if (Notification.permission === "denied")
                        return;
                    // Electron 里默认就是 granted；'default' 时补一次授权请求（首次会走系统弹窗）。
                    if (Notification.permission === "default" && typeof Notification.requestPermission === "function") {
                        Notification.requestPermission().catch(() => undefined);
                    }
                    const body = [view?.artist, view?.album].filter((value) => typeof value === "string" && value.length > 0).join(" · ");
                    const notification = new Notification(view?.title ?? track.title, {
                        body,
                        icon: typeof artwork === "string" ? artwork : undefined,
                        silent: true, // 音乐本身在响，不该再叠一层提示音
                        tag: "dsh-music-now-playing",
                    });
                    notification.onclick = () => {
                        try {
                            window.focus();
                        }
                        catch {
                            // 无窗口句柄：忽略。
                        }
                        notification.close();
                    };
                }
                catch {
                    // 通知是增强项：任何平台差异都不影响播放。
                }
            };
            /** System media keys / OS now-playing integration (macOS Control Center…). */
            const updateMediaSession = () => {
                if (!("mediaSession" in navigator))
                    return;
                try {
                    const raw = state.current >= 0 ? state.tracks[state.current] : undefined;
                    if (raw !== undefined)
                        probeCover(raw);
                    const track = effective(raw);
                    // 补全的远端封面优先；没有补全才回退内嵌封面 / Apple Music 图标。
                    const meta = raw === undefined ? undefined : state.meta[raw.id];
                    /**
                     * `track === undefined` 与 `raw === undefined` 等价（effective 对
                     * undefined 原样返回 undefined），但类型系统看不见这层等价。下面用
                     * 一个收窄过的 id 供 artwork 分支使用 —— 那两个分支里 track 必然存在，
                     * 所以 raw 也必然存在，运行结果与 `raw.id` 完全一致。
                     */
                    const rawId = raw === undefined ? "" : raw.id;
                    const metaCover = meta !== undefined && typeof meta.cover === "string" && meta.cover.length > 0
                        ? systemMediaUrl("/art", "u=" + encodeURIComponent(meta.cover))
                        : null;
                    // While a cover is still being probed, keep the cover URL (tracks
                    // usually have one); swap in the Apple Music icon once a 404 proves
                    // there is none, so the widget never shows a blank square.
                    const fallback = track === undefined ? null : mediaArtworkFallback();
                    // 真实封面不写 sizes：MediaRemote 会按需缩放，写错尺寸反而会被跳过；
                    // canvas 兜底图尺寸是我们自己定的，才标注。
                    const artwork = track === undefined
                        ? []
                        : metaCover !== null
                            ? [{ src: absoluteUrl(metaCover) }]
                            : coverKnown.get(rawId) === false && fallback !== null
                                // canvas 兜底图本身就是 data: URL，Chromium 明确允许。
                                ? [{ src: fallback, sizes: "256x256", type: "image/png" }]
                                : [{ src: systemMediaUrl("/cover", "p=" + encodeURIComponent(rawId) + "&v=" + (state.scannedAt ?? 0)) }];
                    navigator.mediaSession.metadata = track === undefined ? null : new MediaMetadata({
                        title: track.title,
                        artist: track.artist ?? "",
                        album: typeof track.album === "string" && track.album.length > 0
                            ? track.album
                            : (typeof state.dir === "string" ? state.dir.split(/[\\/]/).pop() : ""),
                        artwork,
                    });
                    navigator.mediaSession.playbackState = state.current < 0 ? "none" : state.playing ? "playing" : "paused";
                    if (track === undefined && typeof navigator.mediaSession.setPositionState === "function") {
                        // 没有当前曲目时必须清掉上一首的进度，否则系统控件停在旧位置。
                        try {
                            navigator.mediaSession.setPositionState();
                        }
                        catch {
                            // 部分引擎不接受空参数：忽略。
                        }
                    }
                    else {
                        updatePositionState();
                    }
                    notifyTrack(raw, track, artwork.length > 0 ? artwork[0].src : undefined, state.playing);
                }
                catch {
                    // Older engines: metadata is cosmetic, never break playback over it.
                }
            };
            if ("mediaSession" in navigator) {
                try {
                    navigator.mediaSession.setActionHandler("play", () => api0.toggle());
                    navigator.mediaSession.setActionHandler("pause", () => api0.toggle());
                    navigator.mediaSession.setActionHandler("previoustrack", () => api0.prev());
                    navigator.mediaSession.setActionHandler("nexttrack", () => api0.next());
                    navigator.mediaSession.setActionHandler("seekto", (details) => {
                        if (typeof details.seekTime === "number")
                            api0.seek(details.seekTime);
                    });
                }
                catch {
                    // Some handlers may be unsupported; register what we can.
                }
                // 拿到带 token 的系统取图基址后重发一次 metadata，保证第一首就有封面。
                loadSystemArtBase().then((base) => {
                    if (typeof base === "string" && base.length > 0)
                        updateMediaSession();
                });
            }
            audio.addEventListener("play", () => {
                errorStreak = 0;
                set({ playing: true, error: null });
                updateMediaSession();
            });
            audio.addEventListener("pause", () => {
                set({ playing: false });
                savePosition(true);
                updateMediaSession();
            });
            // Closing the page must not lose up to 5s of position (throttled writer).
            window.addEventListener("pagehide", () => savePosition(true));
            audio.addEventListener("ended", () => {
                if (state.mode === "one") {
                    audio.currentTime = 0;
                    const promise = audio.play();
                    if (promise !== undefined)
                        promise.catch(() => { });
                }
                else {
                    next();
                }
            });
            /**
             * Re-pull the stream and land at `target` (used by both recovery paths).
             * Re-checks the playing track inside the timer: the user may have picked
             * another song during the grace period, and that choice must win.
             */
            const recoverAt = (failedTrack, failedIndex, target, delay) => {
                setTimeout(() => {
                    if (state.current !== failedIndex || playingId !== failedTrack.id)
                        return;
                    // 必须**先等基址**：不等就会拼出相对地址，Desktop 上丢了 Range ⇒ 之后一拖就回 0
                    // （§2.16「降级成不可 seek 的源比等待更糟」）。
                    void (async () => {
                        await ensureStreamBase();
                        if (disposed || state.current !== failedIndex || playingId !== failedTrack.id)
                            return;
                        audio.src = streamUrl(failedTrack);
                        audio.addEventListener("loadedmetadata", () => {
                            if (state.current !== failedIndex || playingId !== failedTrack.id)
                                return;
                            if (Number.isFinite(audio.duration)) {
                                audio.currentTime = Math.min(target, Math.max(0, audio.duration - 1));
                            }
                        }, { once: true });
                        const promise = audio.play();
                        if (promise !== undefined)
                            promise.catch(() => { });
                    })();
                }, delay);
            };
            /**
             * 看门狗：有些编码 Chromium 既不报 error 也不出画面（只有声音，实测 MPEG-4 Part 2
             * 与部分 HEVC 就是这样）。播了 2 秒 videoWidth 仍是 0 就当成失败，升级成转码。
             */
            const guardVideoPicture = (track) => {
                setTimeout(() => {
                    if (playingId !== track.id)
                        return;
                    const current = state.tracks[state.current];
                    if (current === undefined || current.kind !== "video")
                        return;
                    if (Number(audio.videoWidth ?? 1) > 0 || audio.readyState < 2)
                        return;
                    if (mvEscalated.has(track.id))
                        return;
                    mvEscalated.add(track.id);
                    set({ mv: { id: track.id, state: "preparing", progress: 0, mode: "transcode", error: null } });
                    void prepareVideo(track, "transcode").then((url) => {
                        if (url === null || playingId !== track.id)
                            return;
                        attachSource(url);
                    });
                }, 2000);
            };
            audio.addEventListener("error", () => {
                if (state.current < 0)
                    return;
                // ① 优先自愈「token 基址失效」：宿主热重载会换 token（已改为进程级，但历史
                //    快照仍可能过期），而**音频永远走 system-stream token 直连** —— 一旦失效
                //    就是「音乐全不能播、MV 照播（/api/mv 返相对地址）」。丢掉缓存，让下面
                //    的重试路径重新取一次 /session，用新基址重挂。
                const failedSrc = typeof audio.currentSrc === "string" ? audio.currentSrc : "";
                if (failedSrc.includes("system-stream") && !sessionBaseHealed) {
                    sessionBaseHealed = true;
                    invalidateSessionBase();
                    // 立刻用新基址重放本曲（而不是让它退化成「跳过一首」）：
                    // ensureStreamBase 会重新取 /session，streamUrl 于是拿到新 token。
                    const retryTrack = state.tracks[state.current];
                    if (retryTrack !== undefined) {
                        void (async () => {
                            await ensureStreamBase();
                            if (playingId !== retryTrack.id)
                                return;
                            attachSource(streamUrl(retryTrack));
                        })();
                        return;
                    }
                }
                const failedIndex = state.current;
                const failedTrack = state.tracks[failedIndex];
                // MV 直出失败（容器解不了 / 该构建没有这个解码器）：升级成 ffmpeg 转码再试一次。
                if (failedTrack !== undefined && failedTrack.kind === "video" && !mvEscalated.has(failedTrack.id)) {
                    mvEscalated.add(failedTrack.id);
                    set({ mv: { id: failedTrack.id, state: "preparing", progress: 0, mode: "transcode", error: null } });
                    void prepareVideo(failedTrack, "transcode").then((url) => {
                        if (url === null || playingId !== failedTrack.id)
                            return;
                        attachSource(url);
                    });
                    return;
                }
                const resumeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
                errorStreak += 1;
                const knownDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration;
                // 1) 流中途被切断（宿主 requestTimeout 截断长连接、瞬时网络错误等）：
                //    原位置重试一次，恢复后 timeupdate 会把预算清零。
                const mayRetrySame = failedTrack !== undefined && resumeAt > 0 && resumeAttempts < 1
                    && (!Number.isFinite(audio.duration) || resumeAt < audio.duration - 2);
                if (mayRetrySame) {
                    resumeAttempts += 1;
                    lastFailureAt = resumeAt;
                    recoverAt(failedTrack, failedIndex, resumeAt, 400);
                    return;
                }
                // 2) 同一位置再次失败 = 文件局部坏帧（坏源/下载损坏）：
                //    向前跳过坏区继续播放，而不是让几 KB 垃圾废掉整首歌。
                const jump = FAILURE_JUMPS[skipAttempts];
                if (failedTrack !== undefined && resumeAt > 0 && jump !== undefined
                    && (knownDuration === 0 || resumeAt + jump < knownDuration - 1)) {
                    const target = resumeAt + jump;
                    skipAttempts += 1;
                    lastFailureAt = target;
                    set({ time: target });
                    recoverAt(failedTrack, failedIndex, target, 400);
                    return;
                }
                // 3) 放弃本曲：提示 + 列表循环下自动跳下一首（每一行都失败后停手）。
                set({ playing: false, error: translate("error.unsupported") });
                const rowCount = visibleRows().length;
                if (state.mode === "loop" && rowCount > 1 && errorStreak < rowCount) {
                    setTimeout(() => {
                        if (state.error !== null && state.current === failedIndex && !state.playing)
                            next();
                    }, 600);
                }
            });
            const api0 = {
                getState: () => state,
                subscribe: (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                load,
                refresh: async () => {
                    set({ loading: true, error: null });
                    try {
                        applyLibrary(await api("/api/refresh", { method: "POST" }));
                    }
                    catch (error) {
                        set({ error: error instanceof Error ? error.message : String(error) });
                    }
                    finally {
                        set({ loading: false });
                    }
                },
                pick: async () => {
                    set({ picking: true, error: null });
                    try {
                        const payload = await api("/api/pick", { method: "POST" });
                        if (payload.cancelled !== true) {
                            stopAudio();
                            applyLibrary(payload);
                            set({ current: -1, playing: false, time: 0, duration: 0, query: "" });
                        }
                    }
                    catch (error) {
                        set({ error: error instanceof Error ? error.message : String(error) });
                    }
                    finally {
                        set({ picking: false });
                    }
                },
                setDir: async (dir) => {
                    if (typeof dir !== "string" || dir.trim().length === 0)
                        return;
                    set({ loading: true, error: null });
                    try {
                        const payload = await api("/api/dir", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ dir: dir.trim() }),
                        });
                        stopAudio();
                        applyLibrary(payload);
                        set({ current: -1, playing: false, time: 0, duration: 0, query: "" });
                    }
                    catch (error) {
                        set({ error: error instanceof Error ? error.message : String(error) });
                        throw error;
                    }
                    finally {
                        set({ loading: false });
                    }
                },
                play: playIndex,
                /** 删除曲目（含本地文件）：先在应用内弹确认条，用户同意才删。 */
                remove: (index) => {
                    if (state.tracks[index] === undefined)
                        return;
                    set({ pendingDelete: index });
                },
                cancelRemove: () => set({ pendingDelete: -1 }),
                confirmRemove: async () => {
                    const index = state.pendingDelete;
                    const track = state.tracks[index];
                    if (track === undefined) {
                        set({ pendingDelete: -1 });
                        return;
                    }
                    set({ error: null, pendingDelete: -1 });
                    try {
                        const payload = await api("/api/delete", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ id: track.id }),
                        });
                        // 记住的「最后播放」若指向被删曲目，一并清掉
                        const last = loadPrefs().last;
                        if (last !== undefined && last.id === track.id)
                            savePrefs({ last: undefined });
                        applyLibrary(payload);
                    }
                    catch (error) {
                        set({ error: error instanceof Error ? error.message : String(error) });
                    }
                },
                toggle: () => {
                    if (state.current < 0) {
                        const rows = visibleRows();
                        if (rows.length > 0)
                            playIndex(rows[0].index);
                        return;
                    }
                    if (audio.paused) {
                        const promise = audio.play();
                        if (promise !== undefined)
                            promise.catch((error) => {
                                if (error?.name === "NotAllowedError")
                                    return;
                                set({ playing: false, error: translate("error.unsupported") });
                            });
                    }
                    else {
                        audio.pause();
                    }
                },
                /** 插件停用/卸载时停止播放并断开流（lifecycle 清理语义）。 */
                halt: () => {
                    // 先立闸门：清句柄只能清掉「当前」那个定时器，清不掉在飞回调的再武装
                    // （见 schedulePoll 的注释）。disposed 置位后 schedulePoll 永不排期。
                    disposed = true;
                    if (pollTimer !== null) {
                        clearTimeout(pollTimer);
                        pollTimer = null;
                    }
                    // 同一个道理：清句柄 + 阻止再武装。scheduleUnseekableHeal 在 disposed 后
                    // 直接返回，不会重新排期（见 §2.10「清 timer 与阻止再武装是两件事」）。
                    if (unseekableTimer !== null) {
                        clearTimeout(unseekableTimer);
                        unseekableTimer = null;
                    }
                    // 作废在途的 match/apply，并停掉批量循环：否则卸载后它还会继续
                    // 逐首打接口、写文件（实测每 600ms 一次，停不下来的后台任务）。
                    matchSeq += 1;
                    stopAudio();
                    // Reset current/error too: the deferred auto-skip and resume timers
                    // test those fields, and must not restart audio after teardown.
                    // `scanning` 也必须显式复位：它是轮询守卫读的字段，留着 true 会让
                    // 「阻止再武装」失守（A3-01）。
                    set({
                        playing: false,
                        scanning: false,
                        pendingDelete: -1,
                        current: -1,
                        error: null,
                        completing: false,
                        pendingComplete: false,
                        match: null,
                    });
                    if ("mediaSession" in navigator) {
                        try {
                            navigator.mediaSession.metadata = null;
                            navigator.mediaSession.playbackState = "none";
                        }
                        catch {
                            // MediaSession is cosmetic; teardown must not fail on it.
                        }
                    }
                },
                next,
                prev,
                seek: (value) => {
                    if (state.current < 0 || !Number.isFinite(value))
                        return;
                    resumeAttempts = 0;
                    skipAttempts = 0;
                    lastFailureAt = 0;
                    logSeek(value);
                    set({ time: seekAudio(value) });
                },
                /** 预热 /session（媒体直连基址）；页面挂载时调一次即可。 */
                warmSession: () => { void loadSystemArtBase(); },
                /** MV 画面：React 侧把这个媒体元素搬进全屏播放器的舞台（移动父节点不会中断播放）。 */
                media: () => audio,
                /** body 上的停靠位：视图卸载时把媒体元素搬回这里，避免被移出文档而暂停。 */
                mediaPark: () => mediaPark,
                /**
                 * MV 失败后手动重试（重置升级标记 → 进入 preparing → 重走转码并挂源）。
                 *
                 * ⚠️ 这三步**必须**留在这里，不能写在 MusicView 的 onClick 里：
                 * `mvEscalated` 与 `set` 都是 createPlayer() 的局部量，而 MusicView 在它外面，
                 * 从视图里引用会在**运行时抛 ReferenceError**，而且抛在 prepareVideo 之前 ——
                 * 表现就是「转码失败后点『重试』什么都没发生，只有控制台报错」。
                 * 这个缺陷在 TS 迁移前就存在（032e333 及更早），是第 12 轮类型检查顺手抓出来的。
                 */
                retryVideo: (track) => {
                    mvEscalated.delete(track.id);
                    set({ mv: { id: track.id, state: "preparing", progress: 0, mode: "transcode", error: null } });
                    void prepareVideo(track, "transcode").then((url) => {
                        if (url === null || playingId !== track.id)
                            return;
                        attachSource(url);
                    });
                },
                setVolume: (value) => {
                    audio.volume = value;
                    set({ volume: value });
                    savePrefs({ volume: value });
                },
                toggleMode: () => {
                    const mode = state.mode === "loop" ? "one" : "loop";
                    set({ mode });
                    savePrefs({ mode });
                },
                setQuery: (query) => set({ query }),
                toggleSort: (key) => {
                    const sortDir = state.sortKey === key ? (state.sortDir === "asc" ? "desc" : "asc") : "asc";
                    set({ sortKey: key, sortDir });
                    savePrefs({ sortKey: key, sortDir });
                },
                /** 打开在线补全弹层：按曲目原名/歌手查 iTunes；query 为手动搜索词。 */
                match: async (id, query) => {
                    const track = state.tracks.find((item) => item.id === id);
                    if (track === undefined)
                        return;
                    const override = typeof query === "string" && query.trim().length > 0 ? query.trim() : "";
                    const seq = ++matchSeq;
                    set({ match: { id, loading: true, error: null, candidates: [], term: override } });
                    try {
                        const suffix = override.length > 0 ? "&q=" + encodeURIComponent(override) : "";
                        const payload = await api("/api/match?p=" + encodeURIComponent(id) + suffix);
                        if (seq !== matchSeq)
                            return;
                        // 旧宿主只有 iTunes 单源，响应里没有 terms/best：与其显示
                        // “没有匹配结果”，不如直接说明宿主需要重载。
                        if (payload.terms === undefined && payload.best === undefined) {
                            const message = translate("error.staleHost");
                            set({ match: { id, loading: false, error: message, candidates: [], term: override }, error: message });
                            return;
                        }
                        const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
                        const sourceErrors = Array.isArray(payload.errors) && payload.errors.length > 0
                            ? payload.errors.join("；")
                            : null;
                        set({
                            match: {
                                id,
                                loading: false,
                                // 真的没候选时，把各源的具体报错带出来（而不是只给一句“没找到”）。
                                error: candidates.length === 0 && sourceErrors !== null ? sourceErrors : null,
                                candidates,
                                term: typeof payload.term === "string" ? payload.term : override,
                            },
                        });
                    }
                    catch (error) {
                        if (seq !== matchSeq)
                            return;
                        set({
                            match: {
                                id,
                                loading: false,
                                error: error instanceof Error ? error.message : String(error),
                                candidates: [],
                                term: override,
                            },
                        });
                    }
                },
                closeMatch: () => {
                    matchSeq += 1;
                    set({ match: null });
                },
                /**
                 * 应用一条候选。writeFile=true 时调宿主写入标签并重命名本地文件；
                 * 写文件失败或未勾选时退化为本地显示覆盖，功能不会因此不可用。
                 */
                applyMatch: async (candidate, writeFile) => {
                    const picker = state.match;
                    if (picker === null || candidate === null || typeof candidate !== "object")
                        return;
                    const seq = ++matchSeq;
                    const id = picker.id;
                    const entry = {};
                    if (typeof candidate.title === "string" && candidate.title.length > 0)
                        entry.title = candidate.title;
                    if (typeof candidate.artist === "string" && candidate.artist.length > 0)
                        entry.artist = candidate.artist;
                    if (typeof candidate.album === "string" && candidate.album.length > 0)
                        entry.album = candidate.album;
                    if (typeof candidate.cover === "string" && candidate.cover.length > 0)
                        entry.cover = candidate.cover;
                    // 仅改显示：不碰音频文件。
                    if (writeFile !== true) {
                        const meta = { ...state.meta, [id]: entry };
                        persistMeta(meta);
                        set({ meta, match: null });
                        updateMediaSession();
                        return;
                    }
                    const position = audio.currentTime;
                    const wasLoaded = (playingId !== null && playingId === id)
                        || (state.current >= 0 && state.tracks[state.current]?.id === id);
                    const wasPlaying = wasLoaded && !audio.paused;
                    set({ match: { id, loading: true, applying: true, error: null, candidates: [], term: picker.term } });
                    try {
                        const payload = await api("/api/apply", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ id, ...entry, rename: true }),
                        });
                        // 弹层已被关闭 / 插件已停用：这次结果作废，不得再改状态。
                        if (seq !== matchSeq)
                            return;
                        const oldId = typeof payload.oldId === "string" ? payload.oldId : id;
                        const newId = typeof payload.newId === "string" ? payload.newId : oldId;
                        if (oldId !== newId) {
                            const last = loadPrefs().last;
                            if (last !== undefined && last.id === oldId)
                                savePrefs({ last: { ...last, id: newId } });
                            if (playingId === oldId)
                                playingId = newId;
                        }
                        if (payload.library !== undefined)
                            applyLibrary(payload.library);
                        // 被重命名的文件旧流地址已失效：重新指向新 id 并恢复播放位置。
                        if (wasLoaded) {
                            const index = state.tracks.findIndex((track) => track.id === newId);
                            if (index >= 0) {
                                const track = state.tracks[index];
                                set({ current: index, time: position, duration: typeof track.duration === "number" ? track.duration : 0 });
                                // 先等基址再挂源（同 recoverAt：相对地址在 Desktop 上不可 seek）。
                                void (async () => {
                                    await ensureStreamBase();
                                    if (disposed || playingId !== newId)
                                        return;
                                    audio.src = streamUrl(track);
                                    audio.addEventListener("loadedmetadata", () => {
                                        if (playingId !== newId)
                                            return;
                                        if (Number.isFinite(audio.duration))
                                            audio.currentTime = Math.min(position, Math.max(0, audio.duration - 1));
                                    }, { once: true });
                                    if (wasPlaying) {
                                        const promise = audio.play();
                                        if (promise !== undefined)
                                            promise.catch(() => { });
                                    }
                                })();
                                updateMediaSession();
                            }
                        }
                        const nextMeta = { ...state.meta };
                        delete nextMeta[oldId];
                        delete nextMeta[newId];
                        // 标签写入失败时保留显示覆盖，至少列表里的原名是对的。
                        if (payload.tagged !== true)
                            nextMeta[newId] = entry;
                        persistMeta(nextMeta);
                        set({
                            meta: nextMeta,
                            match: null,
                            error: payload.tagged === true
                                ? null
                                : (typeof payload.warning === "string" ? payload.warning : null),
                        });
                    }
                    catch (error) {
                        // 写文件失败不能让“显示修正”一起失败：退回本地覆盖。
                        const meta = { ...state.meta, [id]: entry };
                        persistMeta(meta);
                        set({ meta, match: null, error: error instanceof Error ? error.message : String(error) });
                    }
                },
                /** 一键补全：弹出确认条（会改本地文件，必须先确认）。 */
                completeRequest: () => {
                    const count = state.tracks.filter((track) => state.meta[track.id] === undefined).length;
                    if (count === 0) {
                        set({ error: translate("complete.none") });
                        return;
                    }
                    set({ pendingComplete: true, error: null });
                },
                cancelComplete: () => set({ pendingComplete: false }),
                stopComplete: () => set({ completing: false }),
                /**
                 * 逐首检查全部曲目：多源搜索 → 标签已正确的直接跳过，有差异且高置信度
                 * 才写标签 + 重命名（置信不足的一律不动）。逐首留间隔，用户可随时停止。
                 */
                completeAll: async () => {
                    if (state.completing)
                        return;
                    const targets = state.tracks.filter((track) => state.meta[track.id] === undefined);
                    set({
                        pendingComplete: false,
                        error: null,
                        completing: true,
                        completeTotal: targets.length,
                        completeDone: 0,
                        completeFailed: 0,
                        completeSkipped: 0,
                    });
                    if (targets.length === 0) {
                        set({ completing: false, error: translate("complete.none") });
                        return;
                    }
                    // 正在播放的文件即将被重命名，旧流地址会失效：先停下再改。
                    if (playingId !== null && targets.some((track) => track.id === playingId)) {
                        stopAudio();
                        set({ current: -1, playing: false, time: 0, duration: 0 });
                    }
                    let done = 0;
                    let failed = 0;
                    let skipped = 0;
                    for (const track of targets) {
                        if (!state.completing)
                            break;
                        try {
                            const payload = await api("/api/match?p=" + encodeURIComponent(track.id));
                            // 旧宿主：不要假装“跳过”，直接停下并说明原因。
                            if (payload.terms === undefined && payload.best === undefined) {
                                set({ error: translate("error.staleHost") });
                                break;
                            }
                            const candidate = payload.best !== undefined && payload.best !== null
                                ? payload.best
                                : (Array.isArray(payload.candidates) ? payload.candidates[0] : undefined);
                            if (candidate === undefined) {
                                failed += 1;
                            }
                            else if (payload.auto !== true) {
                                // 置信不足：只统计、跳过，绝不把错误信息写进文件
                                skipped += 1;
                            }
                            else if (track.tagged === true
                                && sameKey(candidate.title) === sameKey(track.title)
                                && sameKey(candidate.artist ?? "") === sameKey(track.artist ?? "")
                                && track.name === expectedFileName(candidate.title, candidate.artist, track.name)) {
                                // 标签与文件名都已规范：不重写、不重命名，算“已正确”
                                skipped += 1;
                            }
                            else {
                                const entry = {};
                                if (typeof candidate.title === "string" && candidate.title.length > 0)
                                    entry.title = candidate.title;
                                if (typeof candidate.artist === "string" && candidate.artist.length > 0)
                                    entry.artist = candidate.artist;
                                if (typeof candidate.album === "string" && candidate.album.length > 0)
                                    entry.album = candidate.album;
                                if (typeof candidate.cover === "string" && candidate.cover.length > 0)
                                    entry.cover = candidate.cover;
                                await api("/api/apply", {
                                    method: "POST",
                                    headers: { "content-type": "application/json" },
                                    body: JSON.stringify({ id: track.id, ...entry, rename: true }),
                                });
                                // 注意：这里**不再**顺手转格式。一键补全只做它本来的事（写标签 + 重命名）。
                                // 之前把「转码 + 丢原件」挂在补全里是设计错误：批量、不可逆、还看不出发生了什么。
                            }
                        }
                        catch {
                            failed += 1;
                        }
                        done += 1;
                        set({ completeDone: done, completeFailed: failed, completeSkipped: skipped });
                        await new Promise((resolve) => setTimeout(resolve, 600));
                    }
                    try {
                        applyLibrary(await api("/api/library"));
                    }
                    catch {
                        // 列表刷新失败不影响已完成的补全。
                    }
                    set({ completing: false, completeTotal: targets.length, completeDone: done, completeFailed: failed, completeSkipped: skipped });
                },
                /** 清除某曲目的在线补全，恢复文件内嵌标签/文件名回退。 */
                clearMeta: (id) => {
                    if (state.meta[id] === undefined)
                        return;
                    matchSeq += 1;
                    const meta = { ...state.meta };
                    delete meta[id];
                    persistMeta(meta);
                    set({ meta, match: null });
                    updateMediaSession();
                },
                effective,
                coverFor,
                /** Live playback clock for the smooth progress fill (rAF consumers). */
                now: () => audio.currentTime,
                /** 可见列表：渲染与播放推进共用的同一顺序（所见即所播）。 */
                visibleRows,
            };
            return api0;
        }
        /**
         * One shared player per page. Parked on window so a client-bundle HMR swap
         * (which re-runs this factory) reuses the live instance instead of spawning
         * a second <audio> that double-plays behind the new UI.
         */
        const player = window.__dshMusicPlayer ?? (window.__dshMusicPlayer = createPlayer());
        // 立刻问一次 /session：拿到 token 版的系统取图/媒体直连基址（Desktop 拖动/快进要靠它）。
        void player.warmSession();
        /**
         * Attach a non-passive wheel listener to an element (React's synthetic
         * onWheel is passive and cannot preventDefault the page scroll).
         * The handler ref always sees the latest render's state.
         */
        function useWheelHandler(getHandler) {
            const ref = useRef(null);
            const latest = useRef(getHandler);
            latest.current = getHandler;
            useEffect(() => {
                const el = ref.current;
                if (el === null)
                    return undefined;
                const onWheel = (event) => {
                    // A disabled slider must not swallow the gesture — let the list scroll.
                    if (el.disabled)
                        return;
                    event.preventDefault();
                    latest.current(event);
                };
                el.addEventListener("wheel", onWheel, { passive: false });
                return () => el.removeEventListener("wheel", onWheel);
            }, []);
            return ref;
        }
        /**
         * Elapsed-time slider. Deliberately uncontrolled: the fill, the knob and the
         * clock are painted straight from the audio clock in a rAF loop, so playback
         * and scrubbing never re-render React. A controlled slider re-rendered the
         * whole view (track list included) on every animation frame, which is what
         * made dragging and seeking feel sluggish.
         */
        const ProgressBar = React.memo(function ProgressBar({ player, trackId, duration, time, playing, t, variant }) {
            // 指针交互挂在命中区（.dshm-progressTrack）上，滚轮快进也挂这里。
            const trackRef = useWheelHandler((event) => {
                if (trackId < 0 || !(duration > 0))
                    return;
                const step = event.shiftKey ? 1 : 5;
                const delta = event.deltaY < 0 ? step : -step;
                player.seek(Math.max(0, Math.min(duration, player.now() + delta)));
            });
            const [dragging, setDragging] = React.useState(false);
            const sliderRef = useRef(null);
            const clockRef = useRef(null);
            const remainingRef = useRef(null);
            const draggingRef = useRef(false);
            const movedRef = useRef(false);
            const pendingRef = useRef(0);
            const paintRef = useRef(null);
            paintRef.current = (value) => {
                const slider = sliderRef.current;
                const clock = clockRef.current;
                const total = duration > 0 ? duration : 0;
                const at = Number.isFinite(value) ? Math.max(0, total > 0 ? Math.min(total, value) : value) : 0;
                if (slider !== null) {
                    // Never fight the user's drag: the browser owns value while dragging.
                    if (!draggingRef.current)
                        slider.value = String(at);
                    // --p is a gradient stop (not a background-size), so the fill follows
                    // the pointer instantly and the .12s track-thickness transition on
                    // hover stays independent of it.
                    slider.style.setProperty("--p", String(total > 0 ? (at / total) * 100 : 0) + "%");
                }
                if (clock !== null) {
                    const label = formatTime(at);
                    if (clock.textContent !== label)
                        clock.textContent = label;
                }
                // 右侧显示「剩余」（macOS Music 是 -4:26 这种带负号的剩余时间）
                const remaining = remainingRef.current;
                if (remaining !== null) {
                    const label = total > 0 ? "-" + formatTime(Math.max(0, total - at)) : "--:--";
                    if (remaining.textContent !== label)
                        remaining.textContent = label;
                }
            };
            // Repaint on external changes (track switch, pause, keyboard seek). While
            // playing the loop below owns the paint, so the 1Hz state.time update must
            // not snap the fill back to a stale whole-second value.
            React.useLayoutEffect(() => {
                if (playing)
                    return;
                paintRef.current(player.now());
            }, [playing, trackId, duration, time]);
            useEffect(() => {
                if (!playing)
                    return undefined;
                let raf = 0;
                const tick = () => {
                    if (!draggingRef.current)
                        paintRef.current(player.now());
                    raf = requestAnimationFrame(tick);
                };
                raf = requestAnimationFrame(tick);
                return () => cancelAnimationFrame(raf);
            }, [playing, trackId]);
            /**
             * 拖动：完全交给滑杆自己的原生事件（Chromium 里按轨道即跳、按住即拖）。
             * 这里只管两件事 —— 拖动期间不动音频（只画界面），松手 seek 一次。
             * 之前自绘过一层 pointerdown/move/up + pointer-events:none，实测在真实环境里
             * 点击和拖动都没反应（jsdom 测不出来），所以退回原生交互。
             */
            const endDrag = () => {
                if (!draggingRef.current)
                    return;
                draggingRef.current = false;
                setDragging(false);
                // 松手才真正 seek（单击 = 快进到该点）。
                player.seek(pendingRef.current);
                paintRef.current(pendingRef.current);
            };
            const onInput = (event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value))
                    return;
                if (!draggingRef.current) {
                    // Keyboard arrows / wheel: commit straight away.
                    player.seek(value);
                    paintRef.current(value);
                    return;
                }
                // 拖动中：只记位置 + 画界面，不动音频（流式文件被反复 seek 会不断中断 Range 请求）。
                pendingRef.current = value;
                paintRef.current(value);
            };
            const elapsedLabel = h("span", { className: "dshm-time", ref: clockRef });
            const remainingLabel = h("span", { className: "dshm-time dshm-time--end", ref: remainingRef }, "--:--");
            const slider = h("input", {
                type: "range",
                className: "dshm-slider",
                ref: sliderRef,
                min: 0,
                max: duration > 0 ? duration : 1,
                step: 0.1,
                defaultValue: 0,
                disabled: trackId < 0,
                "aria-label": t("a11y.progress"),
                onPointerDown: () => { draggingRef.current = true; movedRef.current = false; },
                onPointerMove: () => { if (draggingRef.current)
                    movedRef.current = true; },
                onPointerUp: endDrag,
                onPointerCancel: endDrag,
                onLostPointerCapture: endDrag,
                onChange: onInput,
            });
            // 命中区自己接管指针：点哪儿跳哪儿、拖多快都只画界面，松手才 seek。
            const track = h("div", { className: "dshm-progressTrack" }, slider);
            const stacked = variant === "stacked";
            return h("div", {
                className: "dshm-progress"
                    + (stacked ? " dshm-progress--stacked" : "")
                    + (dragging ? " dshm-progress--dragging" : ""),
                // 指针事件在滑杆本体上（原生交互）；容器这个 ref 只用来挂滚轮快进。
                ref: trackRef,
            }, 
            // macOS Music 的全屏播放器：细轨在上，时间在下左右分列；底部条一行内联
            stacked
                ? [track, h("div", { key: "times", className: "dshm-timeRow" }, elapsedLabel, remainingLabel)]
                : [elapsedLabel, track, remainingLabel]);
        });
        /**
         * 溢出时「从右往左」循环滚动的歌名/歌手（Apple Music 那种跑马灯）。
         *
         * 只在真的放不下时才滚：ResizeObserver 同时盯着容器和内容宽度，窄窗口 / 长标题
         * 都会重新判定；复制一份文本做无缝衔接（[文本][gap][文本]，位移正好一份 + gap），
         * 速度按内容宽度换算成固定 px/s，所以长标题不会滚得离谱；悬停暂停。
         */
        const MARQUEE_GAP_PX = 36;
        const MARQUEE_SPEED_PX_PER_S = 38;
        const Marquee = React.memo(function Marquee({ text, className, title }) {
            const hostRef = useRef(null);
            const sampleRef = useRef(null);
            const [state, setState] = useState({ on: false, duration: 12 });
            useEffect(() => {
                const host = hostRef.current;
                const sample = sampleRef.current;
                if (host === null || sample === null)
                    return undefined;
                const sync = () => {
                    // 单份文本宽度直接量第一份 span。早先是从 inner.scrollWidth 折半推的，
                    // 但"未滚动"时 inner 里只有一份，折半等于把阈值抬成"文本得超过 2 倍
                    // 容器宽才滚"——于是 1~2 倍之间的长歌名既不滚也不显示省略号，直接被切掉。
                    const copy = sample.scrollWidth;
                    const box = host.clientWidth;
                    const overflows = copy > box + 4;
                    const duration = Math.max(6, Math.round((copy + MARQUEE_GAP_PX) / MARQUEE_SPEED_PX_PER_S));
                    setState((previous) => (previous.on === overflows && previous.duration === duration
                        ? previous
                        : { on: overflows, duration }));
                };
                sync();
                const observer = new ResizeObserver(sync);
                observer.observe(host);
                observer.observe(sample);
                window.addEventListener("resize", sync);
                return () => {
                    observer.disconnect();
                    window.removeEventListener("resize", sync);
                };
            }, [text]);
            return h("div", {
                ref: hostRef,
                className: "dshm-marquee" + (state.on ? " dshm-marquee--on" : "") + (className === undefined ? "" : " " + className),
                title: state.on ? undefined : title,
                style: { "--dshm-marquee-gap": MARQUEE_GAP_PX + "px", "--dshm-marquee-duration": state.duration + "s" },
            }, h("div", { className: "dshm-marqueeInner" }, h("span", { className: "dshm-marqueeText", ref: sampleRef }, text), 
            // 只有需要滚动时才插第二份，避免常态下多一份重复文本被读屏念两遍。
            state.on ? h("span", { className: "dshm-marqueeText", "aria-hidden": "true" }, text) : null));
        });
        /** 行内封面：加载失败（无内嵌封面且未补全）时回退音符图标。 */
        /**
         * 列表封面。正在播放的那一行像 Apple Music 一样在封面上叠「跳动条」
         * （他们的 .playing-bars）；鼠标悬停时跳动条淡出、换成播放/暂停图标
         * （他们的 --playButtonOpacity + .playing-bars-hover 那套交互）。
         */
        const RowCover = React.memo(function RowCover({ src, playing, paused }) {
            const [failed, setFailed] = useState(false);
            useEffect(() => { setFailed(false); }, [src]);
            const art = src === null || failed
                ? h("span", { className: "dshm-rowNote" }, ICONS.note)
                : h("img", { className: "dshm-rowCover", src, alt: "", loading: "lazy", onError: () => setFailed(true) });
            if (!playing)
                return art;
            return h("span", { className: "dshm-coverWrap" }, art, h("span", { className: "dshm-coverBars", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("span", { className: "dshm-coverHover", "aria-hidden": "true" }, paused ? ICONS.play : ICONS.pause));
        });
        /** Track list. Memoised so the playback clock never re-renders the rows. */
        const TrackTable = React.memo(function TrackTable({ rows, current, sortKey, sortDir, player, t, meta, effective, coverFor, activeRowRef, playing }) {
            const sortHeader = (key, labelKey, className) => h("th", {
                className: (className ?? "") + " dshm-sortable" + (sortKey === key ? " dshm-sorted" : ""),
                onClick: () => player.toggleSort(key),
            }, t(labelKey), sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");
            return h("div", { className: "dshm-tableWrap" }, h("table", { className: "dshm-table" }, h("thead", null, h("tr", null, h("th", { className: "dshm-colCover" }, ""), sortHeader("title", "col.title"), sortHeader("artist", "col.artist", "dshm-colArtist"), sortHeader("duration", "col.duration", "dshm-colDuration"), h("th", { className: "dshm-colActions" }, ""))), h("tbody", null, rows.map(({ track, index }) => {
                const item = effective(track);
                const matched = meta[track.id] !== undefined;
                // 行悬停也用官方气泡（原来是原生 title，和 DSH 观感不一致）；
                // Tooltip 会合并 ref，所以 activeRowRef 的滚动定位不受影响。
                // key 必须落在 map 返回的最外层元素上，所以这里先组装再用 cloneElement 挂 key。
                const rowElement = h("tr", {
                    className: "dshm-row" + (index === current ? " dshm-row--active" : ""),
                    ref: index === current ? activeRowRef : undefined,
                    onClick: () => player.play(index),
                }, h("td", { className: "dshm-colCover" }, h(RowCover, {
                    src: coverFor(track),
                    playing: index === current,
                    paused: !playing,
                })), h("td", { className: "dshm-cellTitle" }, item.title, track.kind === "video" ? h("span", { className: "dshm-mvTag" }, "MV") : null), h("td", { className: "dshm-cellArtist" }, item.artist ?? ""), h("td", { className: "dshm-colDuration" }, formatTime(track.duration)), h("td", { className: "dshm-colActions" }, withTipWrapped(h("button", {
                    type: "button",
                    className: "dshm-match" + (matched ? " dshm-match--done" : ""),
                    "aria-label": t("action.match.tip"),
                    onClick: (event) => {
                        // 行点击是播放；匹配按钮必须拦住冒泡，避免误触播放
                        event.stopPropagation();
                        player.match(track.id);
                    },
                }, ICONS.sparkle), t("action.match.tip")), withTipWrapped(h("button", {
                    type: "button",
                    className: "dshm-del",
                    "aria-label": t("action.delete") + " " + item.title,
                    onClick: (event) => {
                        // 行点击是播放；删除按钮必须拦住冒泡，避免误触播放
                        event.stopPropagation();
                        player.remove(index);
                    },
                }, ICONS.trash), t("action.delete"))));
                return React.cloneElement(withTip(rowElement, track.name), { key: index + ":" + track.name });
            }))));
        });
        function MusicView() {
            const state = useSyncExternalStore(player.subscribe, player.getState);
            const activeRowRef = useRef(null);
            // player.t 由 apply() 在注册字典之后注入，而本视图只可能在 apply() 里
            // ctx.slots.register 之后被渲染 —— 所以这里必然已经赋值（非空断言可证）。
            const t = player.t;
            useEffect(() => {
                if (state.dir === null && state.tracks.length === 0 && !state.loading && state.scannedAt === null)
                    player.load();
                // eslint-disable-next-line react-hooks/exhaustive-deps
            }, []);
            useEffect(() => {
                activeRowRef.current?.scrollIntoView({ block: "nearest" });
            }, [state.current]);
            const currentTrack = state.current >= 0 ? state.tracks[state.current] : undefined;
            /** 播放条展示的是叠加在线补全后的信息。 */
            const currentView = player.effective(currentTrack);
            const busy = state.loading || state.picking;
            // The conversation shell lets the view area grow with content
            // (flex:1 0 auto) and scrolls it in its own scrollport — which leaves
            // the player bar below the fold and eats wheel gestures over the list.
            // Pin the root to the scrollport's height instead: fixed header/bar,
            // internally scrolling track list (macOS Music layout).
            const rootRef = useRef(null);
            useEffect(() => {
                const root = rootRef.current;
                if (root === null)
                    return undefined;
                const scrollport = root.closest("[data-conversation-scroll]") ?? root.parentElement;
                if (scrollport === null)
                    return undefined;
                const sync = () => {
                    // The composer floats over the scrollport's lower edge; keep the
                    // player bar above it (shell publishes --dsh-composer-height).
                    const raw = getComputedStyle(scrollport).getPropertyValue("--dsh-composer-height");
                    const composer = Number.parseFloat(raw);
                    const height = scrollport.clientHeight - (Number.isFinite(composer) ? composer : 0);
                    if (height > 0)
                        root.style.height = height + "px";
                };
                sync();
                const observer = new ResizeObserver(sync);
                observer.observe(scrollport);
                // The composer height var changes without resizing the scrollport.
                const mutations = new MutationObserver(sync);
                mutations.observe(scrollport, { attributes: true, attributeFilter: ["style"] });
                return () => {
                    observer.disconnect();
                    mutations.disconnect();
                    root.style.height = "";
                };
            }, []);
            // 手动输入目录路径（原生选择器之外的兜底；Windows 可用 D:\Music 之类路径）
            const [dirInputOpen, setDirInputOpen] = useState(false);
            const [dirInputValue, setDirInputValue] = useState("");
            // 底部条专辑封面：无内嵌封面时回退音符图标（补全封面变化也要重试）
            const [coverFailed, setCoverFailed] = useState(false);
            // 全屏播放器（Apple Music 风格）：点底部封面打开，Esc / 收起按钮关闭
            // 弹层三态：closed → open → closing（留 200ms 播完退出动画再卸载，对应
            // Apple Music 弹层的 modalZoomIn / modalZoomOut）。
            const [playerPhase, setPlayerPhase] = useState("closed");
            const playerOpen = playerPhase !== "closed";
            const openPlayer = () => setPlayerPhase("open");
            const closePlayer = () => setPlayerPhase((phase) => (phase === "open" ? "closing" : phase));
            useEffect(() => {
                if (playerPhase !== "closing")
                    return undefined;
                const timer = setTimeout(() => setPlayerPhase("closed"), 200);
                return () => clearTimeout(timer);
            }, [playerPhase]);
            // 收藏（DSH 无此能力，插件自带一份本地记录）
            const [favorites, setFavorites] = useState(loadFavorites);
            // 队列行的「⋯」菜单当前展开在哪首歌上
            const [queueMenu, setQueueMenu] = useState(null);
            /** 封面放大预览（只给音频封面）：纯图片，没有播放状态要照顾。 */
            const [zoomOpen, setZoomOpen] = useState(false);
            /** MV 放大：点 MV 画面就让视频铺大（播放器不退出，控制条还在下面）。 */
            const [mvBig, setMvBig] = useState(false);
            /**
             * 切换 MV 放大：除了 setState，同时直接把类名打到播放器根上 —— 类名是纯展示，
             * 这样即便 React 的批量更新时机和我们预期不一致，画面大小也一定跟着点击走。
             */
            const toggleMvBig = () => {
                setMvBig((value) => {
                    const next = !value;
                    const root = mvStageRef.current?.closest(".dshm-player");
                    if (root !== null && root !== undefined && root.classList !== undefined) {
                        root.classList.toggle("dshm-player--mvbig", next);
                    }
                    return next;
                });
            };
            /** MV 画面槽（媒体元素会被搬进来）与隐藏停靠位（弹层关着时停在这儿）。 */
            const mvStageRef = useRef(null);
            const mvParkRef = useRef(null);
            const isVideo = currentTrack !== undefined && currentTrack.kind === "video";
            const mvState = state.mv;
            useEffect(() => () => {
                // 视图卸载（切回对话/关标签）：把媒体元素搬回 body 停靠位，别让它离开文档。
                const media = player.media();
                const park = player.mediaPark();
                if (media === null || media === undefined || typeof media.nodeType !== "number")
                    return;
                if (park !== null && park !== undefined && media.parentElement !== park)
                    park.appendChild(media);
            }, []);
            useEffect(() => {
                // 移动父节点不会中断 <video> 播放（实测 t 连续推进），所以可以直接搬。
                const media = player.media();
                // 测试里的假元素不是 DOM 节点（没有 nodeType），此时不做搬运。
                if (media === null || media === undefined || typeof media.nodeType !== "number")
                    return;
                const target = isVideo && playerOpen ? mvStageRef.current : mvParkRef.current;
                if (target === null || target === undefined || media.parentElement === target)
                    return;
                target.appendChild(media);
                // zoomOpen 必须在依赖里：放大预览打开时要把画面搬进预览层（漏了它就搬不过去）。
            }, [isVideo, playerOpen, zoomOpen, currentTrack?.id, mvState?.state]);
            useEffect(() => {
                // 封面当 MV 的海报（首帧出来前不闪黑屏）。这里自己取封面，别依赖
                // render 后段才定义的 playerCoverSrc（那会在依赖数组里踩 TDZ）。
                const media = player.media();
                if (media === null || media === undefined)
                    return;
                const poster = isVideo && currentTrack !== undefined && !coverFailed ? player.coverFor(currentTrack) : "";
                if (media.poster !== poster)
                    media.poster = poster;
            }, [isVideo, currentTrack?.id, coverFailed]);
            const toggleFavorite = (id) => {
                setFavorites((previous) => {
                    const next = new Set(previous);
                    if (next.has(id))
                        next.delete(id);
                    else
                        next.add(id);
                    saveFavorites(next);
                    return next;
                });
            };
            useEffect(() => {
                if (!playerOpen)
                    return undefined;
                const onKeyDown = (event) => {
                    if (event.key !== "Escape")
                        return;
                    if (mvBig) {
                        toggleMvBig();
                        return;
                    } // Esc：先还原 MV 大小
                    if (zoomOpen) {
                        setZoomOpen(false);
                        return;
                    } // 再关封面预览，最后才关播放器
                    closePlayer();
                };
                window.addEventListener("keydown", onKeyDown);
                return () => window.removeEventListener("keydown", onKeyDown);
            }, [playerOpen]);
            // 删除确认条在主视图里；弹层开着会把它盖住，所以进入确认态就自动收起弹层
            useEffect(() => {
                if (state.pendingDelete >= 0)
                    closePlayer();
            }, [state.pendingDelete]);
            useEffect(() => setCoverFailed(false), [currentTrack?.id, state.meta]);
            // 补全弹层的搜索框：打开弹层或服务端返回实际搜索词后同步显示
            const [matchTerm, setMatchTerm] = useState("");
            useEffect(() => {
                const current = state.match;
                setMatchTerm(current !== null && typeof current.term === "string" ? current.term : "");
            }, [state.match?.id, state.match?.term]);
            // 是否把补全结果写回文件（写标签 + 重命名），默认开启
            const [writeFile, setWriteFile] = useState(true);
            // 可见列表 = 播放队列：筛选 + 排序统一在 player.visibleRows() 里计算，
            // 这里渲染的顺序就是 next/prev/自动下一首将走的顺序。
            const visibleTracks = player.visibleRows();
            const volumePct = Math.round(state.volume * 100);
            // 滚轮：音量条 ±5%（进度条的滚轮在 ProgressBar 内处理）。
            const volumeWheelRef = useWheelHandler((event) => {
                const delta = (event.deltaY < 0 ? 0.05 : -0.05);
                player.setVolume(Math.max(0, Math.min(1, Math.round((state.volume + delta) * 100) / 100)));
            });
            const header = h("div", { className: "dshm-header" }, h("span", { className: "dshm-title" }, t("view.music")), 
            // 目录名经常长到溢出：悬停给出完整路径（官方 Tooltip，贴着 header 下沿弹出）
            withTip(h("span", { className: "dshm-dir" }, state.dir ?? t("empty.title")), state.dir ?? "", "bottom"), 
            // 搜索框用官方 Input 组件（与 DSH 自己的搜索框同源）：组件自带 32px wrap、
            // 前置图标位、focus-within 主题色描边。取不到官方组件时退回原输入框。
            state.tracks.length > 0 && searchField({
                placeholder: t("action.search.placeholder"),
                value: state.query,
                onChange: (event) => player.setQuery(event.target.value),
            }), state.completing
                ? h("span", { className: "dshm-stats" }, t("complete.progress")(state.completeDone, state.completeTotal, state.completeFailed, state.completeSkipped))
                : state.scanning
                    ? h("span", { className: "dshm-stats" }, t("scan.progress")(state.scanParsed, state.scanTotal))
                    : state.tracks.length > 0 && withTip(h("span", { className: "dshm-stats" }, t("stats")(visibleTracks.length === state.tracks.length ? state.tracks.length : visibleTracks.length + "/" + state.tracks.length), state.truncated ? " · " + t("stats.truncated") : "", state.skippedPackages > 0 ? " · " + t("stats.drm")(state.skippedPackages) : ""), state.skippedPackages > 0 ? t("stats.drmTip") : "", "bottom"), state.completing
                ? withTipWrapped(h("button", {
                    type: "button",
                    className: "dshm-btn dshm-completeStop",
                    "aria-label": t("action.stop"),
                    onClick: () => player.stopComplete(),
                }, t("action.stop")), t("action.stop"), "bottom")
                : state.tracks.length > 0 && withTipWrapped(h("button", {
                    type: "button",
                    className: "dshm-btn dshm-complete",
                    "aria-label": t("action.completeAll"),
                    disabled: busy,
                    onClick: () => player.completeRequest(),
                }, ICONS.sparkle), t("action.completeAll"), "bottom"), withTipWrapped(h("button", {
                type: "button",
                className: "dshm-btn",
                "aria-label": t("action.refresh"),
                disabled: state.tracks.length === 0 || busy,
                onClick: () => player.refresh(),
            }, ICONS.refresh), t("action.refresh"), "bottom"), withTipWrapped(h("button", {
                type: "button",
                className: "dshm-btn",
                // 只保留图标：文案移到官方悬停提示 / aria-label，忙碌时提示跟着变
                "aria-label": t("action.chooseDir"),
                disabled: busy,
                onClick: () => player.pick(),
            }, ICONS.folder), busy ? (state.picking ? t("action.picking") : t("action.loading")) : t("action.chooseDir"), "bottom"), withTipWrapped(h("button", {
                type: "button",
                className: "dshm-btn",
                "aria-label": t("action.inputDir"),
                disabled: busy,
                onClick: () => {
                    setDirInputValue(state.dir ?? "");
                    setDirInputOpen(!dirInputOpen);
                },
            }, ICONS.edit, dirInputOpen ? ICONS.close : ""), t("action.inputDir"), "bottom"));
            const dirEditor = dirInputOpen && h("div", { className: "dshm-dirEditor" }, h("input", {
                type: "text",
                className: "dshm-dirInput",
                value: dirInputValue,
                placeholder: t("action.inputDir.placeholder"),
                autoFocus: true,
                spellCheck: false,
                onChange: (event) => setDirInputValue(event.target.value),
                onKeyDown: (event) => {
                    if (event.key === "Escape")
                        setDirInputOpen(false);
                    if (event.key === "Enter") {
                        const value = dirInputValue.trim();
                        if (value.length === 0)
                            return;
                        player.setDir(value).then(() => setDirInputOpen(false)).catch(() => { });
                    }
                },
            }), h("button", {
                type: "button",
                className: "dshm-btn",
                disabled: busy || dirInputValue.trim().length === 0,
                onClick: () => {
                    player.setDir(dirInputValue).then(() => setDirInputOpen(false)).catch(() => { });
                },
            }, t("action.confirm")));
            let body;
            if (state.dir === null) {
                body = h("div", { className: "dshm-empty" }, h("div", { className: "dshm-emptyIcon" }, "♪"), h("div", null, t("empty.title")), h("div", { className: "dshm-emptyHint" }, t("empty.hint")), h("button", { type: "button", className: "dshm-btn", disabled: busy, onClick: () => player.pick() }, ICONS.folder, t("action.chooseDir")));
            }
            else if (state.tracks.length === 0 && state.scanning) {
                body = h("div", { className: "dshm-empty" }, h("div", { className: "dshm-emptyIcon" }, "♪"), h("div", null, t("scan.progress")(state.scanParsed, state.scanTotal)));
            }
            else if (state.tracks.length === 0 && !state.loading) {
                body = h("div", { className: "dshm-empty" }, h("div", { className: "dshm-emptyIcon" }, "♪"), h("div", null, t("empty.tracks")));
            }
            else {
                body = h(TrackTable, {
                    rows: visibleTracks,
                    current: state.current,
                    sortKey: state.sortKey,
                    sortDir: state.sortDir,
                    player,
                    t,
                    meta: state.meta,
                    effective: player.effective,
                    coverFor: player.coverFor,
                    activeRowRef,
                    playing: state.playing,
                });
            }
            // ── 全屏播放器（Apple Music 风格）：左侧大封面 + 进度 + 传输，右侧播放队列 ──
            // 队列 = 可见列表以当前曲目为首旋转后的前 20 首（和"下一首"的实际顺序一致）
            const queueEntries = (() => {
                const rows = player.visibleRows();
                if (rows.length === 0)
                    return rows;
                const at = rows.findIndex((entry) => entry.index === state.current);
                if (at <= 0)
                    return rows.slice(0, 20);
                return rows.slice(at).concat(rows.slice(0, at)).slice(0, 20);
            })();
            const playerCoverSrc = currentTrack !== undefined && !coverFailed ? player.coverFor(currentTrack) : null;
            const favoriteOn = currentTrack !== undefined && favorites.has(currentTrack.id);
            const transportButton = (icon, label, onClick, extraClass) => withTipWrapped(h("button", {
                type: "button",
                className: "dshm-playerTransportBtn" + (extraClass ?? ""),
                disabled: state.tracks.length === 0,
                "aria-label": label,
                onClick: (event) => {
                    event.stopPropagation();
                    onClick();
                },
            }, icon), label);
            const fullPlayer = playerOpen && h("div", {
                // closing 阶段保留挂载 200ms 播退出动画，期间不接受交互
                className: "dshm-player"
                    + (playerPhase === "closing" ? " dshm-player--closing" : "")
                    + (mvBig && isVideo ? " dshm-player--mvbig" : ""),
                // 点空白处收起「⋯」菜单（菜单与 ⋯ 按钮自己 stopPropagation）
                onClick: () => setQueueMenu(null),
            }, playerCoverSrc !== null && h("div", {
                className: "dshm-playerArt-bg",
                style: { backgroundImage: "url(" + JSON.stringify(playerCoverSrc) + ")" },
            }), h("div", { className: "dshm-playerScrim" }), h("div", { className: "dshm-playerTop" }, withTipWrapped(h("button", {
                type: "button",
                className: "dshm-playerRound",
                "aria-label": t("player.close"),
                onClick: (event) => {
                    event.stopPropagation();
                    closePlayer();
                },
            }, ICONS.chevronDown), t("player.close"), "bottom"), 
            // 参考 macOS Music：右上角是「喇叭图标 + 长条滑杆」
            h("div", { className: "dshm-playerVolume" }, h("span", { className: "dshm-volIcon", "aria-hidden": "true" }, ICONS.volume), withTipWrapped(h("input", {
                type: "range",
                className: "dshm-slider dshm-volume dshm-volume--wide",
                ref: volumeWheelRef,
                style: { "--p": volumePct + "%" },
                min: 0,
                max: 1,
                step: 0.01,
                value: state.volume,
                "aria-label": t("action.volume"),
                onChange: (event) => player.setVolume(Number(event.target.value)),
            }), t("action.volume") + " " + volumePct + "%", "bottom"))), h("div", { className: "dshm-playerBody" }, h("div", { className: "dshm-playerStage" }, 
            // MV：媒体元素会被搬进这个槽位；准备期间盖一层进度（转封装/转码要等 ffmpeg）。
            // 关键：只要是视频轨就必须渲染这个槽位。之前写成「有封面才渲染」，
            // 封面取不到（例如带 MJPEG 封面轨的 mp4）时 <video> 只能留在隐藏停靠位 —— 声音响、画面没有。
            isVideo
                // 点画面 = 就地放大/还原（不另开预览层：视频留在原位，只是铺得更大）
                ? h("div", {
                    className: "dshm-mvStage dshm-zoomable",
                    ref: mvStageRef,
                    onClick: (event) => { event.stopPropagation(); toggleMvBig(); },
                    // 双击进系统全屏（原生 requestFullscreen，插件不自己造全屏）
                    onDoubleClick: (event) => { event.stopPropagation(); const m = player.media(); if (m?.requestFullscreen !== undefined)
                        void m.requestFullscreen(); },
                }, mvState !== null && mvState !== undefined && mvState.state !== "ready"
                    ? h("div", { className: "dshm-mvPrep" }, h("span", { className: "dshm-mvPrepText" }, mvState.state === "failed"
                        ? t("mv.failed")
                        : mvState.mode === "transcode" ? t("mv.transcoding") : t("mv.remuxing")), mvState.state !== "failed" && h("span", { className: "dshm-mvPrepBar" }, h("i", { style: { width: Math.round((mvState.progress ?? 0) * 100) + "%" } })), mvState.state !== "failed" && h("span", { className: "dshm-mvPrepPct" }, Math.round((mvState.progress ?? 0) * 100) + "%"), mvState.state === "failed" && mvState.error === "ffmpeg-not-found"
                        ? h("span", { className: "dshm-mvPrepHint" }, t("mv.noFfmpeg"))
                        : mvState.state === "failed"
                            // 失败原因直接摊开（ffmpeg 的最后一行），否则只能看到黑屏没法查
                            ? h("span", { className: "dshm-mvPrepHint" }, String(mvState.error ?? t("mv.failed")))
                            : null, mvState.state === "failed" && h("button", {
                        type: "button",
                        className: "dshm-mvPrepRetry",
                        onClick: (event) => {
                            event.stopPropagation();
                            if (currentTrack === undefined)
                                return;
                            // 重置 mvEscalated / 置 preparing 都在 player.retryVideo 里做 ——
                            // 那两个是 createPlayer() 的局部量，写在这里会 ReferenceError。
                            void player.retryVideo(currentTrack);
                        },
                    }, t("mv.retry")))
                    : null)
                : playerCoverSrc !== null
                    // key 跟着曲目走：换歌时整块重挂载，封面淡入 + 轻微缩放的入场动画重播
                    ? h("img", {
                        key: "art:" + (currentTrack?.id ?? "none"),
                        className: "dshm-playerArt dshm-zoomable",
                        src: playerCoverSrc,
                        alt: "",
                        onClick: (event) => { event.stopPropagation(); setZoomOpen(true); },
                        onError: () => setCoverFailed(true),
                    })
                    : h("div", { className: "dshm-playerArtFallback" }, ICONS.note), h("div", { className: "dshm-playerMeta" }, h("div", { className: "dshm-playerMetaText" }, 
            // 歌名/歌手同样走右→左跑马灯（放得下就不动）
            h(Marquee, {
                className: "dshm-playerTitle",
                text: currentView?.title ?? t("player.noTrack"),
                title: currentView?.title ?? t("player.noTrack"),
            }), h(Marquee, {
                className: "dshm-playerArtist",
                text: [currentView?.artist, currentView?.album].filter((value) => typeof value === "string" && value.length > 0).join(" — "),
                title: [currentView?.artist, currentView?.album].filter((value) => typeof value === "string" && value.length > 0).join(" — "),
            })), 
            // 收藏：DSH 图标集没有星标 → 补 macOS 原生风格星形（其余按钮一律用官方图标）
            withTipWrapped(h("button", {
                type: "button",
                className: "dshm-playerRound" + (favoriteOn ? " dshm-playerRound--on" : ""),
                disabled: currentTrack === undefined,
                "aria-label": favoriteOn ? t("player.unfavorite") : t("player.favorite"),
                onClick: (event) => {
                    event.stopPropagation();
                    if (currentTrack !== undefined)
                        toggleFavorite(currentTrack.id);
                },
            }, favoriteOn ? ICONS.starFill : ICONS.star), favoriteOn ? t("player.unfavorite") : t("player.favorite")), 
            // ⋯：对齐 macOS Music 的「⭐ + ⋯」两枚圆形按钮（这里是当前曲目的在线补全）
            withTipWrapped(h("button", {
                type: "button",
                className: "dshm-playerRound",
                disabled: currentTrack === undefined,
                "aria-label": t("player.match"),
                onClick: (event) => {
                    event.stopPropagation();
                    if (currentTrack === undefined)
                        return;
                    closePlayer();
                    player.match(currentTrack.id);
                },
            }, ICONS.ellipsis), t("player.match"))), h(ProgressBar, {
                player,
                trackId: state.current,
                duration: state.duration,
                time: state.time,
                playing: state.playing,
                t,
                variant: "stacked",
            }), 
            // 三栏网格：上一首/播放/下一首 永远居中；循环键放到右栏，
            // 正好落在上面「-剩余」时间的正下方（同一右边界对齐）。
            h("div", { className: "dshm-playerTransport" }, h("span", { className: "dshm-playerTransportSide" }), h("div", { className: "dshm-playerTransportCenter" }, transportButton(ICONS.prev, t("action.prev"), () => player.prev()), transportButton(state.playing ? ICONS.pauseBig : ICONS.playBig, state.playing ? t("action.pause") : t("action.play"), () => player.toggle(), " dshm-playerTransportBtn--play"), transportButton(ICONS.next, t("action.next"), () => player.next())), h("div", { className: "dshm-playerTransportSide dshm-playerTransportSide--end" }, transportButton(state.mode === "loop" ? ICONS.repeat : ICONS.repeatOne, state.mode === "loop" ? t("mode.loop") : t("mode.one"), () => player.toggleMode(), state.mode === "one" ? " dshm-playerTransportBtn--on" : "")))), h("div", { className: "dshm-playerRight" }, h("div", { className: "dshm-playerPills" }, withTipWrapped(h("button", {
                type: "button",
                className: "dshm-pill",
                disabled: busy || state.tracks.length === 0,
                onClick: (event) => {
                    event.stopPropagation();
                    closePlayer();
                    player.completeRequest();
                },
            }, ICONS.sparkle, t("action.completeAll")), t("action.completeAll")), withTipWrapped(h("button", {
                type: "button",
                className: "dshm-pill",
                disabled: busy || state.tracks.length === 0,
                onClick: (event) => {
                    event.stopPropagation();
                    player.refresh();
                },
            }, ICONS.refresh, t("action.refresh")), t("action.refresh"))), h("div", { className: "dshm-playerQueueHead" }, h("span", { className: "dshm-playerQueueTitle" }, t("player.queue")), h("span", { className: "dshm-playerQueueCount" }, t("stats")(queueEntries.length))), h("div", { className: "dshm-playerQueue" }, queueEntries.length === 0
                ? h("div", { className: "dshm-dialogMsg" }, t("player.noTrack"))
                : queueEntries.map((entry) => {
                    const view = player.effective(entry.track);
                    const isCurrent = entry.index === state.current;
                    const favorited = favorites.has(entry.track.id);
                    const subtitle = [view?.artist, view?.album]
                        .filter((value) => typeof value === "string" && value.length > 0).join(" — ");
                    return h("div", {
                        key: "queue:" + entry.index + ":" + entry.track.name,
                        className: "dshm-queueRow" + (isCurrent ? " dshm-queueRow--current" : ""),
                        onClick: () => player.play(entry.index),
                    }, h(RowCover, {
                        src: player.coverFor(entry.track),
                        playing: isCurrent,
                        paused: !state.playing,
                    }), h("span", { className: "dshm-queueText" }, h("span", { className: "dshm-queueTitle" }, entry.track.kind === "video" ? h("span", { className: "dshm-mvTag" }, "MV") : null, view?.title ?? entry.track.title), h("span", { className: "dshm-queueArtist" }, subtitle.length > 0 ? subtitle : entry.track.name)), favorited && h("span", { className: "dshm-queueFav" }, ICONS.starFill), withTipWrapped(h("button", {
                        type: "button",
                        className: "dshm-queueMore",
                        "aria-label": t("player.more"),
                        onClick: (event) => {
                            event.stopPropagation();
                            setQueueMenu(queueMenu === entry.track.id ? null : entry.track.id);
                        },
                    }, ICONS.ellipsis), t("player.more")), queueMenu === entry.track.id && h("div", {
                        className: "dshm-queueMenu",
                        onClick: (event) => event.stopPropagation(),
                    }, h("button", {
                        type: "button",
                        className: "dshm-queueMenuItem",
                        onClick: () => {
                            setQueueMenu(null);
                            closePlayer();
                            player.match(entry.track.id);
                        },
                    }, ICONS.sparkle, t("player.match")), h("button", {
                        type: "button",
                        className: "dshm-queueMenuItem dshm-queueMenuItem--danger",
                        onClick: () => {
                            setQueueMenu(null);
                            player.remove(entry.index);
                        },
                    }, ICONS.trash, t("player.delete"))));
                })))));
            const bar = h("div", { className: "dshm-bar" }, h("div", { className: "dshm-nowPlaying" }, 
            // 封面即入口：点开全屏播放器（Apple Music 同款）
            withTipWrapped(h("button", {
                type: "button",
                className: "dshm-nowCoverBtn",
                "aria-label": t("player.open"),
                onClick: () => openPlayer(),
            }, currentTrack !== undefined && !coverFailed
                ? h("img", {
                    className: "dshm-cover",
                    src: player.coverFor(currentTrack),
                    alt: "",
                    onError: () => setCoverFailed(true),
                })
                : h("span", { className: "dshm-noteIcon" }, ICONS.note)), t("player.open")), h("div", { className: "dshm-nowText" }, 
            // 歌名/歌手溢出时右→左跑马灯（放得下就完全不动）
            currentTrack?.kind === "video" ? h("span", { className: "dshm-mvTag" }, "MV") : null, h(Marquee, {
                className: "dshm-nowTitle",
                text: currentView?.title ?? "—",
                title: currentView?.title ?? "—",
            }), h(Marquee, {
                className: "dshm-nowArtist",
                text: currentView?.artist ?? "",
                title: currentView?.artist ?? "",
            }))), h("div", { className: "dshm-center" }, h("div", { className: "dshm-transport" }, withTipWrapped(h("button", { type: "button", className: "dshm-tbtn", disabled: state.tracks.length === 0, onClick: () => player.prev(), "aria-label": t("action.prev") }, ICONS.prev), t("action.prev")), withTipWrapped(h("button", { type: "button", className: "dshm-tbtn dshm-tbtn--play", disabled: state.tracks.length === 0, onClick: () => player.toggle(), "aria-label": t("action.play") + "/" + t("action.pause") }, state.playing ? ICONS.pause : ICONS.play), state.playing ? t("action.pause") : t("action.play")), withTipWrapped(h("button", { type: "button", className: "dshm-tbtn", disabled: state.tracks.length === 0, onClick: () => player.next(), "aria-label": t("action.next") }, ICONS.next), t("action.next"))), h(ProgressBar, {
                player,
                trackId: state.current,
                duration: state.duration,
                time: state.time,
                playing: state.playing,
                t,
            })), h("div", { className: "dshm-right" }, withTipWrapped(h("button", {
                type: "button",
                className: "dshm-mode",
                onClick: () => player.toggleMode(),
                "aria-label": state.mode === "loop" ? t("mode.loop") : t("mode.one"),
            }, state.mode === "loop" ? ICONS.repeat : ICONS.repeatOne), state.mode === "loop" ? t("mode.loop") : t("mode.one")), h("span", { className: "dshm-volIcon", "aria-hidden": "true" }, ICONS.volume), withTipWrapped(h("input", {
                type: "range",
                className: "dshm-slider dshm-volume",
                ref: volumeWheelRef,
                style: { "--p": volumePct + "%" },
                min: 0,
                max: 1,
                step: 0.01,
                value: state.volume,
                "aria-label": t("action.volume"),
                onChange: (event) => player.setVolume(Number(event.target.value)),
            }), t("action.volume") + " " + volumePct + "%")));
            // 在线补全弹层：点选候选即写入本地覆盖，音频文件与标签不动
            const picker = state.match;
            const matchOverlay = picker !== null && h("div", {
                className: "dshm-modal",
                onClick: () => player.closeMatch(),
            }, h("div", { className: "dshm-dialog", onClick: (event) => event.stopPropagation() }, h("div", { className: "dshm-dialogHead" }, t("match.title"), h("div", { className: "dshm-matchRow" }, h("input", {
                type: "text",
                className: "dshm-matchInput",
                value: matchTerm,
                placeholder: t("action.search.placeholder"),
                spellCheck: false,
                onChange: (event) => setMatchTerm(event.target.value),
                onKeyDown: (event) => {
                    if (event.key === "Enter" && matchTerm.trim().length > 0)
                        player.match(picker.id, matchTerm);
                },
            }), h("button", {
                type: "button",
                className: "dshm-btn",
                disabled: picker.loading || matchTerm.trim().length === 0,
                onClick: () => player.match(picker.id, matchTerm),
            }, t("action.search")))), picker.applying || picker.loading
                ? h("div", { className: "dshm-dialogMsg" }, picker.applying ? t("match.applying") : t("action.matching"))
                : picker.error !== null
                    ? h("div", { className: "dshm-dialogMsg" }, t("error.prefix"), picker.error)
                    : picker.candidates.length === 0
                        ? h("div", { className: "dshm-dialogMsg" }, t("match.none"))
                        : h("div", { className: "dshm-cands" }, picker.candidates.map((candidate, index) => h("button", {
                            key: (candidate.id ?? "c") + ":" + index,
                            type: "button",
                            className: "dshm-cand",
                            onClick: () => player.applyMatch(candidate, writeFile),
                        }, candidate.cover
                            ? h("img", {
                                className: "dshm-candCover",
                                src: artUrl(candidate.cover),
                                alt: "",
                                onError: (event) => { event.currentTarget.style.visibility = "hidden"; },
                            })
                            : h("span", { className: "dshm-candCover dshm-noteIcon" }, ICONS.note), h("span", { className: "dshm-candText" }, h("span", { className: "dshm-candTitle" }, index === 0 && h("span", { className: "dshm-candBest" }, "✦"), candidate.title || "—"), h("span", { className: "dshm-candArtist" }, [candidate.artist, candidate.album]
                            .filter((value) => typeof value === "string" && value.length > 0).join(" · ")), h("span", { className: "dshm-candMeta" }, [
                            (Array.isArray(candidate.sources) ? candidate.sources : [candidate.source])
                                .filter((value) => typeof value === "string" && value.length > 0).join(" + "),
                            typeof candidate.score === "number" ? Math.round(candidate.score * 100) + "%" : "",
                            candidate.auto === true ? "✓" : "",
                        ].filter(Boolean).join(" · ")))))), h("div", { className: "dshm-dialogFoot" }, withTip(h("label", { className: "dshm-check" }, h("input", {
                type: "checkbox",
                checked: writeFile,
                disabled: picker.applying,
                onChange: (event) => setWriteFile(event.target.checked),
            }), t("match.writeFile")), t("match.source")), h("span", { style: { display: "flex", gap: "8px" } }, state.meta[picker.id] !== undefined && h("button", {
                type: "button",
                className: "dshm-btn",
                disabled: picker.applying,
                onClick: () => player.clearMeta(picker.id),
            }, t("match.clear")), h("button", {
                type: "button",
                className: "dshm-btn",
                disabled: picker.applying,
                onClick: () => player.closeMatch(),
            }, t("action.cancel"))))));
            // 一键补全确认条（会改本地文件：写标签 + 重命名）
            const completeCount = state.tracks.filter((track) => state.meta[track.id] === undefined).length;
            const completeBar = state.pendingComplete && h("div", { className: "dshm-confirmBar" }, h("span", { className: "dshm-confirmText" }, t("confirm.complete")(completeCount)), h("button", { type: "button", className: "dshm-btn dshm-completeGo", onClick: () => player.completeAll() }, t("action.confirm")), h("button", { type: "button", className: "dshm-btn dshm-completeCancel", onClick: () => player.cancelComplete() }, t("action.cancel")));
            // 删除确认条（替代 window.confirm 的应用内结构化确认）
            const pendingTrack = state.pendingDelete >= 0 ? state.tracks[state.pendingDelete] : undefined;
            const confirmBar = pendingTrack !== undefined && h("div", { className: "dshm-confirmBar" }, h("span", { className: "dshm-confirmText" }, t("confirm.delete")(pendingTrack.title)), h("button", { type: "button", className: "dshm-btn dshm-btn--danger", onClick: () => player.confirmRemove() }, t("action.delete")), h("button", { type: "button", className: "dshm-btn", onClick: () => player.cancelRemove() }, t("action.cancel")));
            return h("div", { className: "dshm-root", ref: rootRef }, 
            // MV 媒体元素的隐藏停靠位：弹层收起时把 <video> 停在这里继续放声音
            h("div", { className: "dshm-mvPark", ref: mvParkRef, "aria-hidden": "true" }), header, dirEditor, completeBar, confirmBar, state.hostEntry === "legacy" && h("div", { className: "dshm-notice" }, t("error.legacyEntry")), state.error !== null && h("div", { className: "dshm-error" }, t("error.prefix"), state.error), body, bar, 
            // 全屏播放器盖在内容之上；matchOverlay 的 z-index 更高，弹层仍在它之上
            fullPlayer, 
            // 放大预览：封面看大图，MV 直接把画面搬进这一层（尺寸夹在窗口内，不超出 desktop）
            zoomOpen && !isVideo && playerCoverSrc !== null
                && h("div", { className: "dshm-lightbox", onClick: () => setZoomOpen(false) }, h("img", { className: "dshm-lightboxImg", src: playerCoverSrc, alt: "" })), matchOverlay);
        }
        /** 渲染错误必须可见，绝不白屏（与 dsh-text-reader 同一模式）。 */
        class ErrorBoundary extends React.Component {
            constructor(props) {
                super(props);
                this.state = { error: null };
            }
            static getDerivedStateFromError(error) {
                return { error };
            }
            componentDidCatch(error) {
                console.error("[dsh-music-player] view render error:", error);
            }
            render() {
                if (this.state.error !== null) {
                    return h("div", { className: "dshm-root" }, h("div", { className: "dshm-error" }, "界面渲染出错了：", this.state.error instanceof Error ? this.state.error.message : String(this.state.error)));
                }
                return h(MusicView);
            }
        }
        const inject = ["slots", "locale"];
        function apply(ctx) {
            ctx.effect(() => ctx.locale.register(NS, { zh, en }), "music-player: dictionaries");
            const t = ctx.locale.bind(NS);
            translate = t;
            player.t = t;
            // lifecycle：插件停用/卸载时停止播放并断开音频流，不留后台声音。
            ctx.effect(() => () => player.halt(), "music-player: audio teardown");
            ctx.effect(() => {
                const tag = document.createElement("style");
                tag.dataset.plugin = "@local/dsh-music-player";
                tag.dataset.pluginCss = NS;
                tag.textContent = CSS;
                document.head.appendChild(tag);
                return () => tag.remove();
            }, "music-player: styles");
            ctx.slots.inject("conversation.view", () => ctx.slots.register({
                name: "conversation.view",
                id: "music",
                order: 20,
                locale: NS,
                label: () => t("view.music"),
                inject: () => ({}),
            }, ErrorBoundary));
        }
        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});
