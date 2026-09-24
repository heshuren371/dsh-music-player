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
    } catch {
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
        if (typeof Component === "function") return h(Component, { size });
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
    let endpointProbed = false;
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
    let systemArtBasePromise = null;
    const loadSystemArtBase = () => {
      if (systemArtBasePromise !== null) return systemArtBasePromise;
      systemArtBasePromise = (async () => {
        try {
          const payload = await api("/api/session");
          if (payload !== null && typeof payload.systemArtBase === "string" && payload.systemArtBase.length > 0) {
            systemArtBase = payload.systemArtBase;
          }
        } catch {
          // 老宿主没有 /session：退回页面的同源绝对地址。
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
      "action.completeAll": "一键补全全部",
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
      "error.unsupported": "无法播放该文件（格式不受支持或文件已移动）",
      "error.staleHost": "宿主插件仍是旧版（没有重载）：请在终端重启 dsh web，然后刷新本页",
      "a11y.progress": "播放进度",
      "action.prev": "上一首",
      "action.next": "下一首",
      "action.play": "播放",
      "action.pause": "暂停",
      "action.volume": "音量",
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
      "error.unsupported": "Cannot play this file (unsupported format or file moved)",
      "error.staleHost": "Host plugin is still the old build (not reloaded): restart dsh web, then refresh this page",
      "a11y.progress": "Playback position",
      "action.prev": "Previous",
      "action.next": "Next",
      "action.play": "Play",
      "action.pause": "Pause",
      "action.volume": "Volume",
    };

    const CSS = `
/* 透明毛玻璃：与 DSH 自己（ui-dockkit .dockScrim / --dsw-mask-blur）同款配方 ——
   color-mix 半透明底色 + backdrop-filter。根容器留一点透明度，桌面端窗口/外壳的
   背景才能透上来，否则模糊的是自己的纯色底，等于没做。 */
.dshm-root{box-sizing:border-box;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 88%, transparent);font:var(--dsw-font-xs-13);flex-direction:column;display:flex;overflow:hidden}
/* 悬停提示包装层：官方 Tooltip 会 clone 唯一子元素，disabled 的按钮不派发鼠标
   事件，所以由这层 inline-flex 容器收 hover；自身不占额外空间。 */
.dshm-tip{display:inline-flex;min-width:0;align-items:center;flex:none}
.dshm-glyph{line-height:1}
.dshm-volIcon{flex:none;color:var(--dsw-alias-label-tertiary);align-items:center;display:inline-flex}
/* 不启用 composer 悬浮（避免底部留白空隙）：恢复原布局，仅用 :has() 在音乐页隐藏两侧宽度条 */
body:has(.dshm-root) [data-width-handle]{display:none}
.dshm-root *{box-sizing:border-box}
.dshm-header{border-bottom:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);flex:none;align-items:center;gap:10px;min-height:44px;padding:0 14px;display:flex}
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
.dshm-confirmBar{border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-state-error-tertiary);flex:none;align-items:center;gap:10px;padding:8px 14px;display:flex}
.dshm-confirmText{min-width:0;flex:1;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5}
.dshm-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dshm-dirEditor{border-bottom:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);flex:none;align-items:center;gap:8px;padding:8px 14px;display:flex}
.dshm-dirInput{border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-radius:7px;flex:1;min-width:0;padding:0 10px;font:inherit;font-size:12px;font-family:var(--ds-font-family-code);outline:none}
.dshm-dirInput:focus{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}
.dshm-dirInput::placeholder{color:var(--dsw-alias-label-caption)}
.dshm-tableWrap{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.dshm-table{border-spacing:0;table-layout:fixed;width:100%;font-size:12px}
/* 列头是真正的毛玻璃：它在滚动容器内 position:sticky，列表从它下面滑过——
   这里能实打实看到模糊，而不是对着纯色底做无用功。 */
.dshm-table th{z-index:2;border-bottom:1px solid var(--dsw-alias-border-l2);height:30px;color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb, var(--dsw-specific-sidebar-fill) 78%, transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);text-align:left;font-weight:500;padding:0 10px;position:sticky;top:0;user-select:none;white-space:nowrap}
.dshm-table th.dshm-sortable{cursor:pointer}
.dshm-table th.dshm-sortable:hover{color:var(--dsw-alias-label-primary)}
.dshm-table th.dshm-sorted{color:var(--dsw-alias-state-business-primary)}
.dshm-table td{border-bottom:1px solid var(--dsw-alias-border-l1);height:32px;text-overflow:ellipsis;white-space:nowrap;padding:0 10px;overflow:hidden}
/* No cell padding here: the shared td padding (10px) left only 20px of content
   box for the 22px delete button, so the td clipped it and painted a "…". */
.dshm-colDelete{width:40px;text-align:center!important;padding:0!important;text-overflow:clip!important}
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
.dshm-bar{border-top:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-specific-sidebar-fill) 82%, transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);flex:none;align-items:center;gap:14px;min-height:64px;padding:8px 16px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) minmax(0,1fr)}
.dshm-nowPlaying{min-width:0;align-items:center;gap:10px;display:flex}
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
.dshm-progress{width:100%;max-width:520px;align-items:center;gap:8px;display:flex}
.dshm-time{color:var(--dsw-alias-label-tertiary);flex:none;width:38px;font-size:10px;font-variant-numeric:tabular-nums;text-align:center;user-select:none}
/* macOS Music style slider: filled elapsed portion, thin track that thickens on hover, knob scales up */
.dshm-slider{-webkit-appearance:none;appearance:none;cursor:pointer;height:14px;background:linear-gradient(to right, var(--dshm-fill, var(--dsw-alias-label-secondary)) 0 var(--p, 0%), var(--dsw-alias-border-l2) var(--p, 0%) 100%) center/100% 4px no-repeat;border-radius:3px;flex:1;min-width:0;margin:0;outline:none;transition:background-size .12s var(--ds-ease-in-out)}
.dshm-slider:hover:not(:disabled){background-size:100% 6px;--dshm-fill:var(--dsw-alias-state-business-primary)}
.dshm-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;background:var(--dsw-alias-label-primary);border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.35);transition:transform .12s var(--ds-ease-in-out)}
.dshm-slider:hover:not(:disabled)::-webkit-slider-thumb{transform:scale(1.3)}
.dshm-slider::-moz-range-thumb{width:12px;height:12px;background:var(--dsw-alias-label-primary);border:0;border-radius:50%}
.dshm-slider:disabled{cursor:not-allowed;opacity:.45}
.dshm-right{min-width:0;justify-content:flex-end;align-items:center;gap:10px;display:flex}
.dshm-mode{cursor:pointer;height:26px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:7px;flex:none;align-items:center;gap:5px;padding:0 9px;font:inherit;font-size:11px;display:inline-flex}
.dshm-mode:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshm-volume{width:88px;flex:none}
.dshm-volume::-webkit-slider-thumb{width:10px;height:10px}
/* 在线补全：行内封面列 / 匹配按钮 / 候选弹层 */
.dshm-colCover{width:44px;text-align:center!important;padding:0 4px!important;text-overflow:clip!important}
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
.dshm-dialogNote{color:var(--dsw-alias-label-caption);font-size:11px}
.dshm-check{color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;align-items:center;gap:6px;font-size:11px;display:inline-flex}
.dshm-check input{cursor:pointer;accent-color:var(--dsw-alias-state-business-primary);margin:0}
`;

    const ICONS = {
      play: officialIcon(["IconPlayOutlineRegular", "IconPlayOutlineMedium", "IconPlayOutline16"], 16, h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M4.5 2.7v10.6c0 .8.9 1.3 1.6.9l8-5.3c.6-.4.6-1.4 0-1.8l-8-5.3c-.7-.4-1.6.1-1.6.9z" }))),
      pause: officialIcon(["IconPauseOutlineRegular", "IconPauseOutlineMedium", "IconPauseOutline16"], 16, h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor" }, h("rect", { x: 3.5, y: 2.5, width: 3.2, height: 11, rx: 1 }), h("rect", { x: 9.3, y: 2.5, width: 3.2, height: 11, rx: 1 }))),
      prev: h("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M3 3.2v9.6c0 .4.3.7.7.7s.7-.3.7-.7V3.2c0-.4-.3-.7-.7-.7s-.7.3-.7.7z" }), h("path", { d: "M13.4 3.1v9.8c0 .8-.9 1.2-1.5.8l-6.9-4.9c-.6-.4-.6-1.2 0-1.6l6.9-4.9c.6-.4 1.5 0 1.5.8z" })),
      next: h("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M12.3 3.2v9.6c0 .4.3.7.7.7s.7-.3.7-.7V3.2c0-.4-.3-.7-.7-.7s-.7.3-.7.7z" }), h("path", { d: "M2.6 3.1v9.8c0 .8.9 1.2 1.5.8l6.9-4.9c.6-.4.6-1.2 0-1.6l-6.9-4.9c-.6-.4-1.5 0-1.5.8z" })),
      repeat: h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M11 1.8 13 3.8l-2 2" }), h("path", { d: "M3.5 7.2V6.4a2.6 2.6 0 0 1 2.6-2.6H13" }), h("path", { d: "m5 14.2-2-2 2-2" }), h("path", { d: "M12.5 8.8v.8a2.6 2.6 0 0 1-2.6 2.6H3" })),
      repeatOne: h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M11 1.8 13 3.8l-2 2" }), h("path", { d: "M3.5 7.2V6.4a2.6 2.6 0 0 1 2.6-2.6H13" }), h("path", { d: "m5 14.2-2-2 2-2" }), h("path", { d: "M12.5 8.8v.8a2.6 2.6 0 0 1-2.6 2.6H3" }), h("text", { x: 8, y: 10.6, fontSize: 6.5, fill: "currentColor", stroke: "none", textAnchor: "middle", fontWeight: 700 }, "1")),
      note: h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M12.9 1.3 5.9 2.9c-.5.1-.9.6-.9 1.1v6.9c-.3-.1-.7-.2-1-.2-1.2 0-2.2.8-2.2 1.9s1 1.9 2.2 1.9 2.2-.8 2.2-1.9V5.4c0-.3.2-.6.5-.6l5.7-1.3c.3-.1.6.2.6.5v5.3c-.3-.1-.7-.2-1-.2-1.2 0-2.2.8-2.2 1.9s1 1.9 2.2 1.9 2.2-.8 2.2-1.9V2.2c0-.5-.4-1-1.3-.9z" })),
      volume: h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M8.6 2.6 5.1 5.4H2.7c-.4 0-.7.3-.7.7v3.8c0 .4.3.7.7.7h2.4l3.5 2.8c.5.4 1.4.1 1.4-.6V3.2c0-.7-.9-1-1.4-.6z" }), h("path", { d: "M11.4 5.4c.8.9.8 2.3 0 3.2", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })),
      folder: officialIcon(["IconFolderOpenRegular", "IconFolderOpenOutlineRegular", "IconFolderOpen16"], 14, h("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M1.8 3.4c0-.7.5-1.2 1.2-1.2h3c.4 0 .8.2 1 .5l.8 1.1c.1.2.3.3.5.3H13c.7 0 1.2.5 1.2 1.2v7.3c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V3.4z" }))),
      refresh: officialIcon(["IconRefreshOutlineRegular", "IconRefreshOutlineMedium", "IconRefreshOutline16"], 14, h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M21 12a9 9 0 1 1-2.6-6.4" }), h("path", { d: "M21 3.5V10h-6.5" }))),
      edit: officialIcon(["IconEditOutlineRegular", "IconEditOutlineMedium", "IconEditOutline16"], 13, h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M17 3.5a2.6 2.6 0 0 1 3.7 3.7L8.4 19.5 3 21l1.5-5.4L17 3.5z" }))),
      search: officialIcon(["IconSearchOutlineRegular", "IconSearchOutlineMedium", "IconSearchOutline16"], 14,
        h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M11.9 6.65a5.27 5.27 0 1 1-10.54 0 5.27 5.27 0 0 1 10.54 0zm1.35 0a6.62 6.62 0 1 1-13.24 0 6.62 6.62 0 0 1 13.24 0z" }), h("path", { d: "M16 15.04l-.96.96-3.51-3.53.95-.96z" }))),
      // 原先用「✦ / − / ×」文字充当的按钮，改用官方 ic_ds_* 图标。
      sparkle: officialIcon(["IconSparkleRegular", "IconSparkleMedium", "IconSparkle16"], 12, h("span", { className: "dshm-glyph" }, "✦")),
      trash: officialIcon(["IconTrashOutlineRegular", "IconTrashOutlineMedium", "IconTrashOutline16"], 13, h("span", { className: "dshm-glyph" }, "−")),
      close: officialIcon(["IconCloseOutlineRegular", "IconCloseOutlineMedium", "IconCloseOutline16"], 12, h("span", { className: "dshm-glyph" }, "×")),
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
      if (typeof label !== "string" || label.length === 0) return element;
      if (Tooltip === null) return React.cloneElement(element, { title: label });
      return h(Tooltip, { label, side, portal: TIP_PORTAL }, element);
    };
    const withTipWrapped = (element, label, side = "top") => {
      if (typeof label !== "string" || label.length === 0) return element;
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

    /** Locale translator for module-scope code; bound in apply() after locale registers. */
    let translate = (key) => key;

    function formatTime(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "--:--";
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
      // 一次性回落：宿主入口没重启时只有旧前缀能回话。
      if (response.status === 404 && !endpointProbed) {
        endpointProbed = true;
        const legacy = await fetch(LEGACY_API_BASE + suffix, options);
        if (legacy.status !== 404) {
          endpointBase = LEGACY_API_BASE;
          response = legacy;
        }
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "HTTP " + response.status);
      return data;
    }

    /** Client playback prefs persisted across page reloads. */
    const PREFS_KEY = "dsh-music:prefs";
    /** Parsed-once cache: playback position is saved while audio plays, and a
     *  JSON.parse + stringify per save would land on the audio thread's path. */
    let prefsCache = null;
    function loadPrefs() {
      if (prefsCache !== null) return prefsCache;
      try {
        const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
        prefsCache = parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        prefsCache = {};
      }
      return prefsCache;
    }
    function savePrefs(patch) {
      const next = { ...loadPrefs(), ...patch };
      prefsCache = next;
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
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
      } catch {
        return {};
      }
    }
    function persistMeta(meta) {
      try {
        localStorage.setItem(META_KEY, JSON.stringify(meta));
      } catch {
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
      const audio = new Audio();
      audio.preload = "auto";
      const prefs = loadPrefs();
      let state = {
        dir: null,
        tracks: [],
        scannedAt: null,
        loading: false,
        picking: false,
        scanning: false,
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
        sortKey: ["title", "artist", "duration"].includes(prefs.sortKey) ? prefs.sortKey : "none",
        sortDir: prefs.sortDir === "desc" ? "desc" : "asc",
        /** 待确认删除的曲目下标（-1 = 无）。替代 window.confirm 的应用内确认。 */
        pendingDelete: -1,
      };
      audio.volume = state.volume;
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener();
      };
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
      const streamUrl = (track) => endpointBase + "/stream?p=" + encodeURIComponent(track.id) + "&v=" + (state.scannedAt ?? 0);

      /** Move the audio clock (clamped to the track) without touching store state. */
      const seekAudio = (value) => {
        if (!Number.isFinite(value)) return 0;
        const known = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration;
        const at = known > 0 ? Math.max(0, Math.min(known, value)) : Math.max(0, value);
        // Re-assigning the position we are already at would abort and re-issue
        // the range request (the native change event lands after pointerup).
        if (!Number.isFinite(audio.currentTime) || Math.abs(audio.currentTime - at) > 0.01) audio.currentTime = at;
        return at;
      };

      /** Remember the resume position. localStorage writes are synchronous, so
       *  timeupdate only persists every ~5s; pause/pagehide flush exactly. */
      let lastSavedAt = -1;
      const savePosition = (force) => {
        if (state.current < 0) return;
        const track = state.tracks[state.current];
        if (track === undefined) return;
        const at = Math.max(0, Math.floor(audio.currentTime));
        if (!force && Math.abs(at - lastSavedAt) < 5) return;
        lastSavedAt = at;
        savePrefs({ last: { id: track.id, time: at } });
      };

      /** One outstanding library poll while a host-side scan is running. */
      let pollTimer = null;
      const schedulePoll = () => {
        if (pollTimer !== null) return;
        pollTimer = setTimeout(async () => {
          pollTimer = null;
          if (!state.scanning) return;
          try {
            applyLibrary(await api("/api/library"));
          } catch {
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
            if (!liveIds.has(id)) { stale = true; break; }
          }
          if (stale) {
            const pruned = {};
            for (const track of nextTracks) {
              if (state.meta[track.id] !== undefined) pruned[track.id] = state.meta[track.id];
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
          if (!liveIds.has(id)) coverKnown.delete(id);
        }
        remapCurrent();
        restoreLastPlayed();
      };

      /** After a fresh library arrives, re-map the playing track by stable id. */
      const remapCurrent = () => {
        if (playingId === null) return;
        const nextIndex = state.tracks.findIndex((track) => track.id === playingId);
        if (nextIndex >= 0) {
          if (nextIndex !== state.current) set({ current: nextIndex });
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
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) });
        } finally {
          set({ loading: false });
        }
      };

      /** Cue the last played track (paused, at the remembered position). */
      let lastPlayedRestored = false;
      const restoreLastPlayed = () => {
        if (lastPlayedRestored || state.current >= 0) return;
        const last = loadPrefs().last;
        if (last === undefined || typeof last.id !== "string") {
          // 从未保存过曲目：这次库无论大小都无回补对象，标记完成。
          lastPlayedRestored = true;
          return;
        }
        const index = state.tracks.findIndex((track) => track.id === last.id);
        // 保存过的曲目不在当前库：先不标记完成，等下一次（换目录/刷新）
        // 载入包含该曲目的库时再回补。
        if (index < 0) return;
        lastPlayedRestored = true;
        const track = state.tracks[index];
        playingId = track.id;
        audio.src = streamUrl(track);
        set({ current: index, duration: typeof track.duration === "number" ? track.duration : 0 });
        updateMediaSession();
        if (typeof last.time === "number" && last.time > 0) {
          audio.addEventListener("loadedmetadata", () => {
            // The user may have picked another track before metadata landed:
            // the stale resume position must not hijack that track.
            if (state.current !== index || playingId !== track.id) return;
            if (Number.isFinite(audio.duration) && last.time < audio.duration - 1) {
              audio.currentTime = last.time;
              set({ time: last.time });
            }
          }, { once: true });
        }
      };

      const playIndex = (index) => {
        const track = state.tracks[index];
        if (track === undefined) return;
        resumeAttempts = 0;
        skipAttempts = 0;
        lastFailureAt = 0;
        playingId = track.id;
        audio.src = streamUrl(track);
        audio.volume = state.volume;
        set({ current: index, time: 0, duration: typeof track.duration === "number" ? track.duration : 0 });
        savePrefs({ last: { id: track.id, time: 0 } });
        updateMediaSession();
        const promise = audio.play();
        if (promise !== undefined) promise.catch((error) => {
          // NotAllowedError = no user activation yet (autoplay policy): stay
          // paused silently; the next real click resumes. Decode failures
          // also surface through the "error" event with a friendly message.
          if (error?.name === "NotAllowedError") {
            set({ playing: false });
            return;
          }
          set({ playing: false, error: translate("error.unsupported") });
        });
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
        if (track === undefined) return undefined;
        const meta = state.meta[track.id];
        if (meta === undefined) return track;
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
        if (meta !== undefined && typeof meta.cover === "string" && meta.cover.length > 0) return artUrl(meta.cover);
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
        } else {
          rows = [];
          for (let index = 0; index < state.tracks.length; index += 1) {
            const track = state.tracks[index];
            const item = effective(track);
            const haystack = (item.title + " " + (item.artist ?? "") + " " + track.name).toLowerCase();
            if (haystack.includes(query)) rows.push({ track, index });
          }
        }
        if (state.sortKey !== "none") {
          rows = [...rows].sort((a, b) => {
            const dir = state.sortDir === "asc" ? 1 : -1;
            const va = effective(a.track)[state.sortKey];
            const vb = effective(b.track)[state.sortKey];
            if (va == null && vb == null) return a.index - b.index;
            if (va == null) return 1;
            if (vb == null) return -1;
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
        if (rows.length === 0) return;
        // 当前曲目不在可见列表里（被筛选掉）时，从第一行开始。
        const pos = rows.findIndex((row) => row.index === state.current);
        playIndex(rows[(pos + 1) % rows.length].index);
      };
      const prev = () => {
        const rows = visibleRows();
        if (rows.length === 0) return;
        // macOS Music behavior: beyond 3s into the song, "previous" restarts it.
        if (audio.currentTime > 3 && state.current >= 0) {
          audio.currentTime = 0;
          return;
        }
        const pos = rows.findIndex((row) => row.index === state.current);
        playIndex(rows[pos <= 0 ? rows.length - 1 : pos - 1].index);
      };

      audio.addEventListener("timeupdate", () => {
        if (state.current < 0) return;
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
        if (fallbackArtwork !== undefined) return fallbackArtwork;
        try {
          const size = 256;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          if (ctx === null) return (fallbackArtwork = null);
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
        } catch {
          // No canvas (or Path2D): fall back to the cover URL as before.
          fallbackArtwork = null;
        }
        return fallbackArtwork;
      };

      /** id → true | false (has embedded cover); absent = not probed yet. */
      const coverKnown = new Map();
      const probeCover = (track) => {
        if (coverKnown.has(track.id)) return;
        coverKnown.set(track.id, null); // in-flight
        const image = new Image();
        image.onload = () => {
          coverKnown.set(track.id, true);
          if (state.current >= 0 && state.tracks[state.current]?.id === track.id) updateMediaSession();
        };
        image.onerror = () => {
          coverKnown.set(track.id, false);
          if (state.current >= 0 && state.tracks[state.current]?.id === track.id) updateMediaSession();
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
        } catch {
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
        if (!("mediaSession" in navigator)) return;
        if (typeof navigator.mediaSession.setPositionState !== "function") return;
        if (state.current < 0) return;
        try {
          const live = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration;
          if (!Number.isFinite(live) || live <= 0) return;
          const position = Math.min(Math.max(audio.currentTime, 0), live);
          navigator.mediaSession.setPositionState({
            duration: live,
            playbackRate: Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1,
            position,
          });
        } catch {
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
        if (!DESKTOP || track === undefined) return;
        if (lastNoticeId === track.id) return;
        if (playing !== true) return;
        // 焦点策略：默认每次换曲都提示（静音横幅），窗口失焦时当然也提示。
        // 想安静一点就把 NOTIFY_ALWAYS 改成 false，只在窗口失焦时提示。
        if (!NOTIFY_ALWAYS && document.visibilityState === "visible" && document.hasFocus()) return;
        lastNoticeId = track.id;
        if (typeof Notification !== "function") return;
        try {
          if (Notification.permission === "denied") return;
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
            } catch {
              // 无窗口句柄：忽略。
            }
            notification.close();
          };
        } catch {
          // 通知是增强项：任何平台差异都不影响播放。
        }
      };

      /** System media keys / OS now-playing integration (macOS Control Center…). */
      const updateMediaSession = () => {
        if (!("mediaSession" in navigator)) return;
        try {
          const raw = state.current >= 0 ? state.tracks[state.current] : undefined;
          if (raw !== undefined) probeCover(raw);
          const track = effective(raw);
          // 补全的远端封面优先；没有补全才回退内嵌封面 / Apple Music 图标。
          const meta = raw === undefined ? undefined : state.meta[raw.id];
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
              : coverKnown.get(raw.id) === false && fallback !== null
                // canvas 兜底图本身就是 data: URL，Chromium 明确允许。
                ? [{ src: fallback, sizes: "256x256", type: "image/png" }]
                : [{ src: systemMediaUrl("/cover", "p=" + encodeURIComponent(raw.id) + "&v=" + (state.scannedAt ?? 0)) }];
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
            } catch {
              // 部分引擎不接受空参数：忽略。
            }
          } else {
            updatePositionState();
          }
          notifyTrack(raw, track, artwork.length > 0 ? artwork[0].src : undefined, state.playing);
        } catch {
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
            if (typeof details.seekTime === "number") api0.seek(details.seekTime);
          });
        } catch {
          // Some handlers may be unsupported; register what we can.
        }
        // 拿到带 token 的系统取图基址后重发一次 metadata，保证第一首就有封面。
        loadSystemArtBase().then((base) => {
          if (typeof base === "string" && base.length > 0) updateMediaSession();
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
          if (promise !== undefined) promise.catch(() => {});
        } else {
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
          if (state.current !== failedIndex || playingId !== failedTrack.id) return;
          audio.src = streamUrl(failedTrack);
          audio.addEventListener("loadedmetadata", () => {
            if (state.current !== failedIndex || playingId !== failedTrack.id) return;
            if (Number.isFinite(audio.duration)) {
              audio.currentTime = Math.min(target, Math.max(0, audio.duration - 1));
            }
          }, { once: true });
          const promise = audio.play();
          if (promise !== undefined) promise.catch(() => {});
        }, delay);
      };

      audio.addEventListener("error", () => {
        if (state.current < 0) return;
        const failedIndex = state.current;
        const failedTrack = state.tracks[failedIndex];
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
            if (state.error !== null && state.current === failedIndex && !state.playing) next();
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
          } catch (error) {
            set({ error: error instanceof Error ? error.message : String(error) });
          } finally {
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
          } catch (error) {
            set({ error: error instanceof Error ? error.message : String(error) });
          } finally {
            set({ picking: false });
          }
        },
        setDir: async (dir) => {
          if (typeof dir !== "string" || dir.trim().length === 0) return;
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
          } catch (error) {
            set({ error: error instanceof Error ? error.message : String(error) });
            throw error;
          } finally {
            set({ loading: false });
          }
        },
        play: playIndex,
        /** 删除曲目（含本地文件）：先在应用内弹确认条，用户同意才删。 */
        remove: (index) => {
          if (state.tracks[index] === undefined) return;
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
            if (last !== undefined && last.id === track.id) savePrefs({ last: undefined });
            applyLibrary(payload);
          } catch (error) {
            set({ error: error instanceof Error ? error.message : String(error) });
          }
        },
        toggle: () => {
          if (state.current < 0) {
            const rows = visibleRows();
            if (rows.length > 0) playIndex(rows[0].index);
            return;
          }
          if (audio.paused) {
            const promise = audio.play();
            if (promise !== undefined) promise.catch((error) => {
              if (error?.name === "NotAllowedError") return;
              set({ playing: false, error: translate("error.unsupported") });
            });
          } else {
            audio.pause();
          }
        },
        /** 插件停用/卸载时停止播放并断开流（lifecycle 清理语义）。 */
        halt: () => {
          if (pollTimer !== null) {
            clearTimeout(pollTimer);
            pollTimer = null;
          }
          // 作废在途的 match/apply，并停掉批量循环：否则卸载后它还会继续
          // 逐首打接口、写文件（实测每 600ms 一次，停不下来的后台任务）。
          matchSeq += 1;
          stopAudio();
          // Reset current/error too: the deferred auto-skip and resume timers
          // test those fields, and must not restart audio after teardown.
          set({
            playing: false,
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
            } catch {
              // MediaSession is cosmetic; teardown must not fail on it.
            }
          }
        },
        next,
        prev,
        seek: (value) => {
          if (state.current < 0 || !Number.isFinite(value)) return;
          resumeAttempts = 0;
          skipAttempts = 0;
          lastFailureAt = 0;
          set({ time: seekAudio(value) });
        },
        /** Scrub preview: move the audio clock without publishing UI state
         *  (the slider paints itself from the clock while the user drags). */
        previewSeek: (value) => {
          if (state.current < 0) return;
          resumeAttempts = 0;
          skipAttempts = 0;
          lastFailureAt = 0;
          seekAudio(value);
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
          if (track === undefined) return;
          const override = typeof query === "string" && query.trim().length > 0 ? query.trim() : "";
          const seq = ++matchSeq;
          set({ match: { id, loading: true, error: null, candidates: [], term: override } });
          try {
            const suffix = override.length > 0 ? "&q=" + encodeURIComponent(override) : "";
            const payload = await api("/api/match?p=" + encodeURIComponent(id) + suffix);
            if (seq !== matchSeq) return;
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
          } catch (error) {
            if (seq !== matchSeq) return;
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
          if (picker === null || candidate === null || typeof candidate !== "object") return;
          const seq = ++matchSeq;
          const id = picker.id;
          const entry = {};
          if (typeof candidate.title === "string" && candidate.title.length > 0) entry.title = candidate.title;
          if (typeof candidate.artist === "string" && candidate.artist.length > 0) entry.artist = candidate.artist;
          if (typeof candidate.album === "string" && candidate.album.length > 0) entry.album = candidate.album;
          if (typeof candidate.cover === "string" && candidate.cover.length > 0) entry.cover = candidate.cover;

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
            if (seq !== matchSeq) return;
            const oldId = typeof payload.oldId === "string" ? payload.oldId : id;
            const newId = typeof payload.newId === "string" ? payload.newId : oldId;
            if (oldId !== newId) {
              const last = loadPrefs().last;
              if (last !== undefined && last.id === oldId) savePrefs({ last: { ...last, id: newId } });
              if (playingId === oldId) playingId = newId;
            }
            if (payload.library !== undefined) applyLibrary(payload.library);
            // 被重命名的文件旧流地址已失效：重新指向新 id 并恢复播放位置。
            if (wasLoaded) {
              const index = state.tracks.findIndex((track) => track.id === newId);
              if (index >= 0) {
                const track = state.tracks[index];
                audio.src = streamUrl(track);
                audio.addEventListener("loadedmetadata", () => {
                  if (playingId !== newId) return;
                  if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(position, Math.max(0, audio.duration - 1));
                }, { once: true });
                set({ current: index, time: position, duration: typeof track.duration === "number" ? track.duration : 0 });
                if (wasPlaying) {
                  const promise = audio.play();
                  if (promise !== undefined) promise.catch(() => {});
                }
                updateMediaSession();
              }
            }
            const nextMeta = { ...state.meta };
            delete nextMeta[oldId];
            delete nextMeta[newId];
            // 标签写入失败时保留显示覆盖，至少列表里的原名是对的。
            if (payload.tagged !== true) nextMeta[newId] = entry;
            persistMeta(nextMeta);
            set({
              meta: nextMeta,
              match: null,
              error: payload.tagged === true
                ? null
                : (typeof payload.warning === "string" ? payload.warning : null),
            });
          } catch (error) {
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
          if (state.completing) return;
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
            if (!state.completing) break;
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
              } else if (payload.auto !== true) {
                // 置信不足：只统计、跳过，绝不把错误信息写进文件
                skipped += 1;
              } else if (track.tagged === true
                && sameKey(candidate.title) === sameKey(track.title)
                && sameKey(candidate.artist ?? "") === sameKey(track.artist ?? "")
                && track.name === expectedFileName(candidate.title, candidate.artist, track.name)) {
                // 标签与文件名都已规范：不重写、不重命名，算“已正确”
                skipped += 1;
              } else {
                const entry = {};
                if (typeof candidate.title === "string" && candidate.title.length > 0) entry.title = candidate.title;
                if (typeof candidate.artist === "string" && candidate.artist.length > 0) entry.artist = candidate.artist;
                if (typeof candidate.album === "string" && candidate.album.length > 0) entry.album = candidate.album;
                if (typeof candidate.cover === "string" && candidate.cover.length > 0) entry.cover = candidate.cover;
                await api("/api/apply", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ id: track.id, ...entry, rename: true }),
                });
              }
            } catch {
              failed += 1;
            }
            done += 1;
            set({ completeDone: done, completeFailed: failed, completeSkipped: skipped });
            await new Promise((resolve) => setTimeout(resolve, 600));
          }
          try {
            applyLibrary(await api("/api/library"));
          } catch {
            // 列表刷新失败不影响已完成的补全。
          }
          set({ completing: false, completeTotal: targets.length, completeDone: done, completeFailed: failed, completeSkipped: skipped });
        },
        /** 清除某曲目的在线补全，恢复文件内嵌标签/文件名回退。 */
        clearMeta: (id) => {
          if (state.meta[id] === undefined) return;
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
        if (el === null) return undefined;
        const onWheel = (event) => {
          // A disabled slider must not swallow the gesture — let the list scroll.
          if (el.disabled) return;
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
    const ProgressBar = React.memo(function ProgressBar({ player, trackId, duration, time, playing, t }) {
      const sliderRef = useWheelHandler((event) => {
        if (trackId < 0 || !(duration > 0)) return;
        const step = event.shiftKey ? 1 : 5;
        const delta = event.deltaY < 0 ? step : -step;
        player.seek(Math.max(0, Math.min(duration, player.now() + delta)));
      });
      const clockRef = useRef(null);
      const draggingRef = useRef(false);
      const movedRef = useRef(false);
      const pendingRef = useRef(0);
      const previewAtRef = useRef(0);
      const paintRef = useRef(null);

      paintRef.current = (value) => {
        const slider = sliderRef.current;
        const clock = clockRef.current;
        const total = duration > 0 ? duration : 0;
        const at = Number.isFinite(value) ? Math.max(0, total > 0 ? Math.min(total, value) : value) : 0;
        if (slider !== null) {
          // Never fight the user's drag: the browser owns value while dragging.
          if (!draggingRef.current) slider.value = String(at);
          // --p is a gradient stop (not a background-size), so the fill follows
          // the pointer instantly and the .12s track-thickness transition on
          // hover stays independent of it.
          slider.style.setProperty("--p", String(total > 0 ? (at / total) * 100 : 0) + "%");
        }
        if (clock !== null) {
          const label = formatTime(at);
          if (clock.textContent !== label) clock.textContent = label;
        }
      };

      // Repaint on external changes (track switch, pause, keyboard seek). While
      // playing the loop below owns the paint, so the 1Hz state.time update must
      // not snap the fill back to a stale whole-second value.
      React.useLayoutEffect(() => {
        if (playing) return;
        paintRef.current(player.now());
      }, [playing, trackId, duration, time]);

      useEffect(() => {
        if (!playing) return undefined;
        let raf = 0;
        const tick = () => {
          if (!draggingRef.current) paintRef.current(player.now());
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      }, [playing, trackId]);

      const beginDrag = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const slider = sliderRef.current;
        draggingRef.current = true;
        movedRef.current = false;
        pendingRef.current = slider !== null ? Number(slider.value) : 0;
        previewAtRef.current = 0;
        if (slider !== null) {
          // Keep receiving moves once the pointer leaves the (narrow) track.
          try { slider.setPointerCapture(event.pointerId); } catch { /* jsdom/unsupported */ }
        }
      };
      const endDrag = (event) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        const slider = sliderRef.current;
        if (slider !== null) {
          try {
            if (typeof event?.pointerId === "number") slider.releasePointerCapture(event.pointerId);
          } catch { /* capture already released */ }
        }
        // Exact final position (a throttled preview may have landed elsewhere).
        player.seek(pendingRef.current);
        paintRef.current(pendingRef.current);
      };
      const onInput = (event) => {
        const value = Number(event.target.value);
        if (!Number.isFinite(value)) return;
        if (!draggingRef.current) {
          // Keyboard arrows / wheel: commit straight away.
          player.seek(value);
          paintRef.current(value);
          return;
        }
        pendingRef.current = value;
        paintRef.current(value);
        if (!movedRef.current) return;
        // Live scrub preview, throttled: every seek aborts the pending range
        // request, so ~7/s keeps the audio near the knob without thrashing.
        const stamp = Date.now();
        if (stamp - previewAtRef.current < 150) return;
        previewAtRef.current = stamp;
        player.previewSeek(value);
      };

      return h(React.Fragment, null,
        h("span", { className: "dshm-time", ref: clockRef }),
        h("input", {
          type: "range",
          className: "dshm-slider",
          ref: sliderRef,
          min: 0,
          max: duration > 0 ? duration : 1,
          step: 0.1,
          defaultValue: 0,
          disabled: trackId < 0,
          "aria-label": t("a11y.progress"),
          onPointerDown: beginDrag,
          onPointerMove: () => { if (draggingRef.current) movedRef.current = true; },
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          onLostPointerCapture: endDrag,
          onChange: onInput,
        }),
        h("span", { className: "dshm-time" }, formatTime(duration)),
      );
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
      const innerRef = useRef(null);
      const [state, setState] = useState({ on: false, duration: 12 });
      useEffect(() => {
        const host = hostRef.current;
        const inner = innerRef.current;
        if (host === null || inner === null) return undefined;
        const sync = () => {
          // 单份文本宽度：内容总宽减去 gap 后再折半。
          const copy = Math.max(0, (inner.scrollWidth - MARQUEE_GAP_PX) / 2);
          const box = host.clientWidth;
          const overflows = copy > box + 4;
          const duration = Math.max(6, Math.round((copy + MARQUEE_GAP_PX) / MARQUEE_SPEED_PX_PER_S));
          setState((previous) => (
            previous.on === overflows && previous.duration === duration
              ? previous
              : { on: overflows, duration }
          ));
        };
        sync();
        const observer = new ResizeObserver(sync);
        observer.observe(host);
        observer.observe(inner);
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
      },
        h("div", { className: "dshm-marqueeInner", ref: innerRef },
          h("span", { className: "dshm-marqueeText" }, text),
          // 只有需要滚动时才插第二份，避免常态下多一份重复文本被读屏念两遍。
          state.on ? h("span", { className: "dshm-marqueeText", "aria-hidden": "true" }, text) : null,
        ),
      );
    });

    /** 行内封面：加载失败（无内嵌封面且未补全）时回退音符图标。 */
    const RowCover = React.memo(function RowCover({ src }) {
      const [failed, setFailed] = useState(false);
      useEffect(() => { setFailed(false); }, [src]);
      if (src === null || failed) return h("span", { className: "dshm-rowNote" }, ICONS.note);
      return h("img", { className: "dshm-rowCover", src, alt: "", loading: "lazy", onError: () => setFailed(true) });
    });

    /** Track list. Memoised so the playback clock never re-renders the rows. */
    const TrackTable = React.memo(function TrackTable({ rows, current, sortKey, sortDir, player, t, meta, effective, coverFor, activeRowRef }) {
      const sortHeader = (key, labelKey, className) => h("th", {
        className: (className ?? "") + " dshm-sortable" + (sortKey === key ? " dshm-sorted" : ""),
        onClick: () => player.toggleSort(key),
      }, t(labelKey), sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");
      return h("div", { className: "dshm-tableWrap" },
        h("table", { className: "dshm-table" },
          h("thead", null, h("tr", null,
            h("th", { className: "dshm-colCover" }, ""),
            sortHeader("title", "col.title"),
            sortHeader("artist", "col.artist", "dshm-colArtist"),
            sortHeader("duration", "col.duration", "dshm-colDuration"),
            h("th", { className: "dshm-colActions" }, ""),
          )),
          h("tbody", null, rows.map(({ track, index }) => {
            const item = effective(track);
            const matched = meta[track.id] !== undefined;
            // 行悬停也用官方气泡（原来是原生 title，和 DSH 观感不一致）；
            // Tooltip 会合并 ref，所以 activeRowRef 的滚动定位不受影响。
            // key 必须落在 map 返回的最外层元素上，所以这里先组装再用 cloneElement 挂 key。
            const rowElement = h("tr", {
              className: "dshm-row" + (index === current ? " dshm-row--active" : ""),
              ref: index === current ? activeRowRef : undefined,
              onClick: () => player.play(index),
            },
              h("td", { className: "dshm-colCover" }, h(RowCover, { src: coverFor(track) })),
              h("td", { className: "dshm-cellTitle" }, item.title),
              h("td", { className: "dshm-cellArtist" }, item.artist ?? ""),
              h("td", { className: "dshm-colDuration" }, formatTime(track.duration)),
              h("td", { className: "dshm-colActions" },
                withTipWrapped(h("button", {
                  type: "button",
                  className: "dshm-match" + (matched ? " dshm-match--done" : ""),
                  "aria-label": t("action.match.tip"),
                  onClick: (event) => {
                    // 行点击是播放；匹配按钮必须拦住冒泡，避免误触播放
                    event.stopPropagation();
                    player.match(track.id);
                  },
                }, ICONS.sparkle), t("action.match.tip")),
                withTipWrapped(h("button", {
                  type: "button",
                  className: "dshm-del",
                  "aria-label": t("action.delete") + " " + item.title,
                  onClick: (event) => {
                    // 行点击是播放；删除按钮必须拦住冒泡，避免误触播放
                    event.stopPropagation();
                    player.remove(index);
                  },
                }, ICONS.trash), t("action.delete")),
              ),
            );
            return React.cloneElement(withTip(rowElement, track.name), { key: index + ":" + track.name });
          })),
        ),
      );
    });

    function MusicView() {
      const state = useSyncExternalStore(player.subscribe, player.getState);
      const activeRowRef = useRef(null);
      const t = player.t;

      useEffect(() => {
        if (state.dir === null && state.tracks.length === 0 && !state.loading && state.scannedAt === null) player.load();
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
        if (root === null) return undefined;
        const scrollport = root.closest("[data-conversation-scroll]") ?? root.parentElement;
        if (scrollport === null) return undefined;
        const sync = () => {
          // The composer floats over the scrollport's lower edge; keep the
          // player bar above it (shell publishes --dsh-composer-height).
          const raw = getComputedStyle(scrollport).getPropertyValue("--dsh-composer-height");
          const composer = Number.parseFloat(raw);
          const height = scrollport.clientHeight - (Number.isFinite(composer) ? composer : 0);
          if (height > 0) root.style.height = height + "px";
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

      const header = h("div", { className: "dshm-header" },
        h("span", { className: "dshm-title" }, t("view.music")),
        // 目录名经常长到溢出：悬停给出完整路径（官方 Tooltip，贴着 header 下沿弹出）
        withTip(h("span", { className: "dshm-dir" }, state.dir ?? t("empty.title")), state.dir ?? "", "bottom"),
        // 搜索框用官方 Input 组件（与 DSH 自己的搜索框同源）：组件自带 32px wrap、
        // 前置图标位、focus-within 主题色描边。取不到官方组件时退回原输入框。
        state.tracks.length > 0 && searchField({
          placeholder: t("action.search.placeholder"),
          value: state.query,
          onChange: (event) => player.setQuery(event.target.value),
        }),
        state.completing
          ? h("span", { className: "dshm-stats" }, t("complete.progress")(state.completeDone, state.completeTotal, state.completeFailed, state.completeSkipped))
          : state.scanning
            ? h("span", { className: "dshm-stats" }, t("scan.progress")(state.scanParsed, state.scanTotal))
            : state.tracks.length > 0 && withTip(h("span", { className: "dshm-stats" },
                t("stats")(visibleTracks.length === state.tracks.length ? state.tracks.length : visibleTracks.length + "/" + state.tracks.length),
                state.truncated ? " · " + t("stats.truncated") : "",
                state.skippedPackages > 0 ? " · " + t("stats.drm")(state.skippedPackages) : ""),
              state.skippedPackages > 0 ? t("stats.drmTip") : "", "bottom"),
        state.completing
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
            }, ICONS.sparkle), t("action.completeAll"), "bottom"),
        withTipWrapped(h("button", {
          type: "button",
          className: "dshm-btn",
          "aria-label": t("action.refresh"),
          disabled: state.tracks.length === 0 || busy,
          onClick: () => player.refresh(),
        }, ICONS.refresh), t("action.refresh"), "bottom"),
        withTipWrapped(h("button", {
          type: "button",
          className: "dshm-btn",
          // 只保留图标：文案移到官方悬停提示 / aria-label，忙碌时提示跟着变
          "aria-label": t("action.chooseDir"),
          disabled: busy,
          onClick: () => player.pick(),
        }, ICONS.folder), busy ? (state.picking ? t("action.picking") : t("action.loading")) : t("action.chooseDir"), "bottom"),
        withTipWrapped(h("button", {
          type: "button",
          className: "dshm-btn",
          "aria-label": t("action.inputDir"),
          disabled: busy,
          onClick: () => {
            setDirInputValue(state.dir ?? "");
            setDirInputOpen(!dirInputOpen);
          },
        }, ICONS.edit, dirInputOpen ? ICONS.close : ""), t("action.inputDir"), "bottom"),
      );

      const dirEditor = dirInputOpen && h("div", { className: "dshm-dirEditor" },
        h("input", {
          type: "text",
          className: "dshm-dirInput",
          value: dirInputValue,
          placeholder: t("action.inputDir.placeholder"),
          autoFocus: true,
          spellCheck: false,
          onChange: (event) => setDirInputValue(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Escape") setDirInputOpen(false);
            if (event.key === "Enter") {
              const value = dirInputValue.trim();
              if (value.length === 0) return;
              player.setDir(value).then(() => setDirInputOpen(false)).catch(() => {});
            }
          },
        }),
        h("button", {
          type: "button",
          className: "dshm-btn",
          disabled: busy || dirInputValue.trim().length === 0,
          onClick: () => {
            player.setDir(dirInputValue).then(() => setDirInputOpen(false)).catch(() => {});
          },
        }, t("action.confirm")),
      );

      let body;
      if (state.dir === null) {
        body = h("div", { className: "dshm-empty" },
          h("div", { className: "dshm-emptyIcon" }, "♪"),
          h("div", null, t("empty.title")),
          h("div", { className: "dshm-emptyHint" }, t("empty.hint")),
          h("button", { type: "button", className: "dshm-btn", disabled: busy, onClick: () => player.pick() }, ICONS.folder, t("action.chooseDir")),
        );
      } else if (state.tracks.length === 0 && state.scanning) {
        body = h("div", { className: "dshm-empty" },
          h("div", { className: "dshm-emptyIcon" }, "♪"),
          h("div", null, t("scan.progress")(state.scanParsed, state.scanTotal)),
        );
      } else if (state.tracks.length === 0 && !state.loading) {
        body = h("div", { className: "dshm-empty" },
          h("div", { className: "dshm-emptyIcon" }, "♪"),
          h("div", null, t("empty.tracks")),
        );
      } else {
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
        });
      }

      const bar = h("div", { className: "dshm-bar" },
        h("div", { className: "dshm-nowPlaying" },
          currentTrack !== undefined && !coverFailed
            ? h("img", {
                className: "dshm-cover",
                src: player.coverFor(currentTrack),
                alt: "",
                onError: () => setCoverFailed(true),
              })
            : h("span", { className: "dshm-noteIcon" }, ICONS.note),
          h("div", { className: "dshm-nowText" },
            // 歌名/歌手溢出时右→左跑马灯（放得下就完全不动）
            h(Marquee, {
              className: "dshm-nowTitle",
              text: currentView?.title ?? "—",
              title: currentView?.title ?? "—",
            }),
            h(Marquee, {
              className: "dshm-nowArtist",
              text: currentView?.artist ?? "",
              title: currentView?.artist ?? "",
            }),
          ),
        ),
        h("div", { className: "dshm-center" },
          h("div", { className: "dshm-transport" },
            withTipWrapped(h("button", { type: "button", className: "dshm-tbtn", disabled: state.tracks.length === 0, onClick: () => player.prev(), "aria-label": t("action.prev") }, ICONS.prev), t("action.prev")),
            withTipWrapped(h("button", { type: "button", className: "dshm-tbtn dshm-tbtn--play", disabled: state.tracks.length === 0, onClick: () => player.toggle(), "aria-label": t("action.play") + "/" + t("action.pause") }, state.playing ? ICONS.pause : ICONS.play), state.playing ? t("action.pause") : t("action.play")),
            withTipWrapped(h("button", { type: "button", className: "dshm-tbtn", disabled: state.tracks.length === 0, onClick: () => player.next(), "aria-label": t("action.next") }, ICONS.next), t("action.next")),
          ),
          h("div", { className: "dshm-progress" },
            h(ProgressBar, {
              player,
              trackId: state.current,
              duration: state.duration,
              time: state.time,
              playing: state.playing,
              t,
            }),
          ),
        ),
        h("div", { className: "dshm-right" },
          withTipWrapped(h("button", {
            type: "button",
            className: "dshm-mode",
            onClick: () => player.toggleMode(),
            "aria-label": state.mode === "loop" ? t("mode.loop") : t("mode.one"),
          }, state.mode === "loop" ? ICONS.repeat : ICONS.repeatOne), state.mode === "loop" ? t("mode.loop") : t("mode.one")),
          h("span", { className: "dshm-volIcon", "aria-hidden": "true" }, ICONS.volume),
          withTipWrapped(h("input", {
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
          }), t("action.volume") + " " + volumePct + "%"),
        ),
      );

      // 在线补全弹层：点选候选即写入本地覆盖，音频文件与标签不动
      const picker = state.match;
      const matchOverlay = picker !== null && h("div", {
        className: "dshm-modal",
        onClick: () => player.closeMatch(),
      },
        h("div", { className: "dshm-dialog", onClick: (event) => event.stopPropagation() },
          h("div", { className: "dshm-dialogHead" },
            t("match.title"),
            h("div", { className: "dshm-matchRow" },
              h("input", {
                type: "text",
                className: "dshm-matchInput",
                value: matchTerm,
                placeholder: t("action.search.placeholder"),
                spellCheck: false,
                onChange: (event) => setMatchTerm(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter" && matchTerm.trim().length > 0) player.match(picker.id, matchTerm);
                },
              }),
              h("button", {
                type: "button",
                className: "dshm-btn",
                disabled: picker.loading || matchTerm.trim().length === 0,
                onClick: () => player.match(picker.id, matchTerm),
              }, t("action.search")),
            ),
          ),
          picker.applying || picker.loading
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
                  },
                    candidate.cover
                      ? h("img", {
                          className: "dshm-candCover",
                          src: artUrl(candidate.cover),
                          alt: "",
                          onError: (event) => { event.currentTarget.style.visibility = "hidden"; },
                        })
                      : h("span", { className: "dshm-candCover dshm-noteIcon" }, ICONS.note),
                    h("span", { className: "dshm-candText" },
                      h("span", { className: "dshm-candTitle" },
                        index === 0 && h("span", { className: "dshm-candBest" }, "✦"),
                        candidate.title || "—"),
                      h("span", { className: "dshm-candArtist" }, [candidate.artist, candidate.album]
                        .filter((value) => typeof value === "string" && value.length > 0).join(" · ")),
                      h("span", { className: "dshm-candMeta" }, [
                        (Array.isArray(candidate.sources) ? candidate.sources : [candidate.source])
                          .filter((value) => typeof value === "string" && value.length > 0).join(" + "),
                        typeof candidate.score === "number" ? Math.round(candidate.score * 100) + "%" : "",
                        candidate.auto === true ? "✓" : "",
                      ].filter(Boolean).join(" · ")),
                    ),
                  ))),
          h("div", { className: "dshm-dialogFoot" },
            withTip(h("label", { className: "dshm-check" },
              h("input", {
                type: "checkbox",
                checked: writeFile,
                disabled: picker.applying,
                onChange: (event) => setWriteFile(event.target.checked),
              }),
              t("match.writeFile"),
            ), t("match.source")),
            h("span", { style: { display: "flex", gap: "8px" } },
              state.meta[picker.id] !== undefined && h("button", {
                type: "button",
                className: "dshm-btn",
                disabled: picker.applying,
                onClick: () => player.clearMeta(picker.id),
              }, t("match.clear")),
              h("button", {
                type: "button",
                className: "dshm-btn",
                disabled: picker.applying,
                onClick: () => player.closeMatch(),
              }, t("action.cancel")),
            ),
          ),
        ),
      );

      // 一键补全确认条（会改本地文件：写标签 + 重命名）
      const completeCount = state.tracks.filter((track) => state.meta[track.id] === undefined).length;
      const completeBar = state.pendingComplete && h("div", { className: "dshm-confirmBar" },
        h("span", { className: "dshm-confirmText" }, t("confirm.complete")(completeCount)),
        h("button", { type: "button", className: "dshm-btn dshm-completeGo", onClick: () => player.completeAll() }, t("action.confirm")),
        h("button", { type: "button", className: "dshm-btn dshm-completeCancel", onClick: () => player.cancelComplete() }, t("action.cancel")),
      );

      // 删除确认条（替代 window.confirm 的应用内结构化确认）
      const pendingTrack = state.pendingDelete >= 0 ? state.tracks[state.pendingDelete] : undefined;
      const confirmBar = pendingTrack !== undefined && h("div", { className: "dshm-confirmBar" },
        h("span", { className: "dshm-confirmText" }, t("confirm.delete")(pendingTrack.title)),
        h("button", { type: "button", className: "dshm-btn dshm-btn--danger", onClick: () => player.confirmRemove() }, t("action.delete")),
        h("button", { type: "button", className: "dshm-btn", onClick: () => player.cancelRemove() }, t("action.cancel")),
      );

      return h("div", { className: "dshm-root", ref: rootRef },
        header,
        dirEditor,
        completeBar,
        confirmBar,
        state.error !== null && h("div", { className: "dshm-error" }, t("error.prefix"), state.error),
        body,
        bar,
        matchOverlay,
      );
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
          return h("div", { className: "dshm-root" },
            h("div", { className: "dshm-error" }, "界面渲染出错了：", this.state.error instanceof Error ? this.state.error.message : String(this.state.error)),
          );
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
