window.__ModuleLoader__.load({
  id: "@local/dsh-music-player",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useRef, useState, useSyncExternalStore } = React;

    const NS = "dsh-music-player";
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
      "artist.unknown": "未知歌手",
      "stats": (count) => `${count} 首歌曲`,
      "stats.truncated": "已达扫描上限",
      "scan.progress": (parsed, total) => total > 0 ? `正在扫描… ${parsed}/${total}` : `正在扫描… ${parsed}`,
      "error.prefix": "出错了：",
      "error.unsupported": "无法播放该文件（格式不受支持或文件已移动）",
      "a11y.progress": "播放进度",
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
      "artist.unknown": "Unknown Artist",
      "stats": (count) => `${count} songs`,
      "stats.truncated": "scan limit reached",
      "scan.progress": (parsed, total) => total > 0 ? `Scanning… ${parsed}/${total}` : `Scanning… ${parsed}`,
      "error.prefix": "Error: ",
      "error.unsupported": "Cannot play this file (unsupported format or file moved)",
      "a11y.progress": "Playback position",
    };

    const CSS = `
.dshm-root{box-sizing:border-box;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xs-13);flex-direction:column;display:flex;overflow:hidden}
/* 不启用 composer 悬浮（避免底部留白空隙）：恢复原布局，仅用 :has() 在音乐页隐藏两侧宽度条 */
body:has(.dshm-root) [data-width-handle]{display:none}
.dshm-root *{box-sizing:border-box}
.dshm-header{border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex:none;align-items:center;gap:10px;min-height:44px;padding:0 14px;display:flex}
.dshm-title{font-size:14px;font-weight:600;flex:none}
.dshm-dir{min-width:0;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px;text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}
.dshm-stats{color:var(--dsw-alias-label-tertiary);flex:none;font-size:11px}
.dshm-search{border:1px solid var(--dsw-alias-border-l2);height:24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-radius:6px;flex:0 1 180px;min-width:80px;padding:0 8px;font:inherit;font-size:12px;outline:none}
.dshm-search:focus{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}
.dshm-search::placeholder{color:var(--dsw-alias-label-caption)}
.dshm-btn{cursor:pointer;height:26px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1);border-radius:7px;flex:none;align-items:center;gap:5px;padding:0 10px;font:inherit;font-size:12px;display:inline-flex}
.dshm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshm-btn:disabled{cursor:not-allowed;opacity:.45}
.dshm-error{border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-tertiary);flex:none;padding:6px 14px;font-size:12px}
.dshm-confirmBar{border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-state-error-tertiary);flex:none;align-items:center;gap:10px;padding:8px 14px;display:flex}
.dshm-confirmText{min-width:0;flex:1;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5}
.dshm-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dshm-dirEditor{border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex:none;align-items:center;gap:8px;padding:8px 14px;display:flex}
.dshm-dirInput{border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-radius:7px;flex:1;min-width:0;padding:0 10px;font:inherit;font-size:12px;font-family:var(--ds-font-family-code);outline:none}
.dshm-dirInput:focus{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}
.dshm-dirInput::placeholder{color:var(--dsw-alias-label-caption)}
.dshm-tableWrap{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.dshm-table{border-spacing:0;table-layout:fixed;width:100%;font-size:12px}
.dshm-table th{z-index:2;border-bottom:1px solid var(--dsw-alias-border-l2);height:30px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-specific-sidebar-fill);text-align:left;font-weight:500;padding:0 10px;position:sticky;top:0;user-select:none;white-space:nowrap}
.dshm-table th.dshm-sortable{cursor:pointer}
.dshm-table th.dshm-sortable:hover{color:var(--dsw-alias-label-primary)}
.dshm-table th.dshm-sorted{color:var(--dsw-alias-state-business-primary)}
.dshm-table td{border-bottom:1px solid var(--dsw-alias-border-l1);height:32px;text-overflow:ellipsis;white-space:nowrap;padding:0 10px;overflow:hidden}
.dshm-colDelete{width:40px;text-align:center!important}
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
.dshm-bar{border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-sidebar-fill);flex:none;align-items:center;gap:14px;min-height:64px;padding:8px 16px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) minmax(0,1fr)}
.dshm-nowPlaying{min-width:0;align-items:center;gap:10px;display:flex}
.dshm-noteIcon{width:34px;height:34px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;flex:none;justify-content:center;align-items:center;display:flex}
.dshm-cover{width:34px;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;flex:none;object-fit:cover;background:var(--dsw-alias-bg-layer-2)}
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
`;

    const ICONS = {
      play: h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M4.5 2.7v10.6c0 .8.9 1.3 1.6.9l8-5.3c.6-.4.6-1.4 0-1.8l-8-5.3c-.7-.4-1.6.1-1.6.9z" })),
      pause: h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor" }, h("rect", { x: 3.5, y: 2.5, width: 3.2, height: 11, rx: 1 }), h("rect", { x: 9.3, y: 2.5, width: 3.2, height: 11, rx: 1 })),
      prev: h("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M3 3.2v9.6c0 .4.3.7.7.7s.7-.3.7-.7V3.2c0-.4-.3-.7-.7-.7s-.7.3-.7.7z" }), h("path", { d: "M13.4 3.1v9.8c0 .8-.9 1.2-1.5.8l-6.9-4.9c-.6-.4-.6-1.2 0-1.6l6.9-4.9c.6-.4 1.5 0 1.5.8z" })),
      next: h("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M12.3 3.2v9.6c0 .4.3.7.7.7s.7-.3.7-.7V3.2c0-.4-.3-.7-.7-.7s-.7.3-.7.7z" }), h("path", { d: "M2.6 3.1v9.8c0 .8.9 1.2 1.5.8l6.9-4.9c.6-.4.6-1.2 0-1.6l-6.9-4.9c-.6-.4-1.5 0-1.5.8z" })),
      repeat: h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M11 1.8 13 3.8l-2 2" }), h("path", { d: "M3.5 7.2V6.4a2.6 2.6 0 0 1 2.6-2.6H13" }), h("path", { d: "m5 14.2-2-2 2-2" }), h("path", { d: "M12.5 8.8v.8a2.6 2.6 0 0 1-2.6 2.6H3" })),
      repeatOne: h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M11 1.8 13 3.8l-2 2" }), h("path", { d: "M3.5 7.2V6.4a2.6 2.6 0 0 1 2.6-2.6H13" }), h("path", { d: "m5 14.2-2-2 2-2" }), h("path", { d: "M12.5 8.8v.8a2.6 2.6 0 0 1-2.6 2.6H3" }), h("text", { x: 8, y: 10.6, fontSize: 6.5, fill: "currentColor", stroke: "none", textAnchor: "middle", fontWeight: 700 }, "1")),
      note: h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M12.9 1.3 5.9 2.9c-.5.1-.9.6-.9 1.1v6.9c-.3-.1-.7-.2-1-.2-1.2 0-2.2.8-2.2 1.9s1 1.9 2.2 1.9 2.2-.8 2.2-1.9V5.4c0-.3.2-.6.5-.6l5.7-1.3c.3-.1.6.2.6.5v5.3c-.3-.1-.7-.2-1-.2-1.2 0-2.2.8-2.2 1.9s1 1.9 2.2 1.9 2.2-.8 2.2-1.9V2.2c0-.5-.4-1-1.3-.9z" })),
      volume: h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M8.6 2.6 5.1 5.4H2.7c-.4 0-.7.3-.7.7v3.8c0 .4.3.7.7.7h2.4l3.5 2.8c.5.4 1.4.1 1.4-.6V3.2c0-.7-.9-1-1.4-.6z" }), h("path", { d: "M11.4 5.4c.8.9.8 2.3 0 3.2", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })),
      folder: h("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "currentColor" }, h("path", { d: "M1.8 3.4c0-.7.5-1.2 1.2-1.2h3c.4 0 .8.2 1 .5l.8 1.1c.1.2.3.3.5.3H13c.7 0 1.2.5 1.2 1.2v7.3c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V3.4z" })),
    };

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
      const response = await fetch("/dsh-music" + path, options);
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
        error: null,
        current: -1,
        playing: false,
        mode: prefs.mode === "one" ? "one" : "loop",
        time: 0,
        duration: 0,
        volume: typeof prefs.volume === "number" && prefs.volume >= 0 && prefs.volume <= 1 ? prefs.volume : 1,
        query: "",
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
      /** Same-track resume retries after a mid-playback stream cut (per track). */
      let resumeAttempts = 0;

      /** Stop playback and detach the stream (used before library replacement). */
      const stopAudio = () => {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      };

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
        const previousTracks = state.tracks;
        const previousCurrent = state.current;
        set({
          dir: payload.dir,
          tracks: payload.tracks ?? [],
          scannedAt: payload.scannedAt ?? null,
          scanning: payload.scanning === true,
          scanParsed: payload.scanParsed ?? 0,
          scanTotal: payload.scanTotal ?? 0,
          truncated: payload.truncated === true,
          error: null,
        });
        if (payload.scanning === true) {
          // Keep the current playback untouched while the new scan runs.
          schedulePoll();
          return;
        }
        remapCurrent(previousTracks, previousCurrent);
        restoreLastPlayed();
      };

      /** After a fresh library arrives, re-map the playing track by stable id. */
      const remapCurrent = (previousTracks, previousCurrent) => {
        const previous = previousCurrent >= 0 ? previousTracks[previousCurrent] : undefined;
        if (previous === undefined) return;
        const nextIndex = state.tracks.findIndex((track) => track.id === previous.id);
        if (nextIndex >= 0) {
          if (nextIndex !== previousCurrent) set({ current: nextIndex });
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
        audio.src = "/dsh-music/api/stream?p=" + encodeURIComponent(track.id) + "&v=" + (state.scannedAt ?? 0);
        set({ current: index, duration: typeof track.duration === "number" ? track.duration : 0 });
        updateMediaSession();
        if (typeof last.time === "number" && last.time > 0) {
          audio.addEventListener("loadedmetadata", () => {
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
        audio.src = "/dsh-music/api/stream?p=" + encodeURIComponent(track.id) + "&v=" + (state.scannedAt ?? 0);
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
      let rowsCache = null;
      const visibleRows = () => {
        const cache = rowsCache;
        if (cache !== null && cache.tracks === state.tracks && cache.query === state.query
          && cache.sortKey === state.sortKey && cache.sortDir === state.sortDir) {
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
            const haystack = (track.title + " " + (track.artist ?? "") + " " + track.name).toLowerCase();
            if (haystack.includes(query)) rows.push({ track, index });
          }
        }
        if (state.sortKey !== "none") {
          rows = [...rows].sort((a, b) => {
            const dir = state.sortDir === "asc" ? 1 : -1;
            const va = a.track[state.sortKey];
            const vb = b.track[state.sortKey];
            if (va == null && vb == null) return a.index - b.index;
            if (va == null) return 1;
            if (vb == null) return -1;
            const order = typeof va === "number" && typeof vb === "number"
              ? va - vb
              : String(va).localeCompare(String(vb), "zh-Hans-CN", { numeric: true, sensitivity: "base" });
            return dir * (order || (a.index - b.index));
          });
        }
        rowsCache = { tracks: state.tracks, query: state.query, sortKey: state.sortKey, sortDir: state.sortDir, rows };
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
        const liveDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration;
        // The progress bar follows the audio clock itself (rAF), so publishing
        // every ~4Hz timeupdate would only re-render the track list: publish on
        // the whole second, or immediately when the duration finally arrives.
        if (liveDuration !== state.duration || Math.floor(live) !== Math.floor(state.time)) {
          set({ time: live, duration: liveDuration });
        }
        savePosition(false);
      });
      /** System media keys / OS now-playing integration (macOS Control Center…). */
      const updateMediaSession = () => {
        if (!("mediaSession" in navigator)) return;
        try {
          const track = state.current >= 0 ? state.tracks[state.current] : undefined;
          navigator.mediaSession.metadata = track === undefined ? null : new MediaMetadata({
            title: track.title,
            artist: track.artist ?? "",
            album: typeof state.dir === "string" ? state.dir.split(/[\\/]/).pop() : "",
            artwork: [{ src: "/dsh-music/api/cover?p=" + encodeURIComponent(track.id) + "&v=" + (state.scannedAt ?? 0) }],
          });
          navigator.mediaSession.playbackState = state.current < 0 ? "none" : state.playing ? "playing" : "paused";
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
      audio.addEventListener("error", () => {
        if (state.current < 0) return;
        const failedIndex = state.current;
        const failedTrack = state.tracks[failedIndex];
        const resumeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        errorStreak += 1;
        // 流中途被切断（宿主 requestTimeout 截断长连接、瞬时网络错误等）时不跳曲：
        // 从断点重新拉流续播，最多重试 2 次；解码级损坏的文件仍按原逻辑跳过。
        // resumeAttempts 不随 "play" 复位，同一位置反复损坏时重试 2 次后照常跳过。
        const mayResume = failedTrack !== undefined && resumeAt > 0 && resumeAttempts < 2
          && (!Number.isFinite(audio.duration) || resumeAt < audio.duration - 2);
        if (mayResume) {
          resumeAttempts += 1;
          setTimeout(() => {
            // 用户在宽限期内切了歌：尊重用户选择，不再续播。
            if (state.current !== failedIndex) return;
            audio.src = "/dsh-music/api/stream?p=" + encodeURIComponent(failedTrack.id) + "&v=" + (state.scannedAt ?? 0);
            audio.addEventListener("loadedmetadata", () => {
              if (Number.isFinite(audio.duration)) {
                audio.currentTime = Math.min(resumeAt, Math.max(0, audio.duration - 1));
              }
            }, { once: true });
            const promise = audio.play();
            if (promise !== undefined) promise.catch(() => {});
          }, 400);
          return;
        }
        set({ playing: false, error: translate("error.unsupported") });
        // In repeat-all mode skip past broken files; give up when every visible
        // row failed. Re-check the index inside the timer: the user may have
        // picked another song during the grace period, and that choice must win.
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
          stopAudio();
          set({ playing: false, pendingDelete: -1 });
        },
        next,
        prev,
        seek: (value) => {
          if (state.current < 0 || !Number.isFinite(value)) return;
          set({ time: seekAudio(value) });
        },
        /** Scrub preview: move the audio clock without publishing UI state
         *  (the slider paints itself from the clock while the user drags). */
        previewSeek: (value) => {
          if (state.current < 0) return;
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

    /** Track list. Memoised so the playback clock never re-renders the rows. */
    const TrackTable = React.memo(function TrackTable({ rows, current, sortKey, sortDir, player, t, activeRowRef }) {
      const sortHeader = (key, labelKey, className) => h("th", {
        className: (className ?? "") + " dshm-sortable" + (sortKey === key ? " dshm-sorted" : ""),
        onClick: () => player.toggleSort(key),
      }, t(labelKey), sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");
      return h("div", { className: "dshm-tableWrap" },
        h("table", { className: "dshm-table" },
          h("thead", null, h("tr", null,
            h("th", { className: "dshm-colDelete" }, ""),
            sortHeader("title", "col.title"),
            sortHeader("artist", "col.artist", "dshm-colArtist"),
            sortHeader("duration", "col.duration", "dshm-colDuration"),
          )),
          h("tbody", null, rows.map(({ track, index }) => h("tr", {
            key: index + ":" + track.name,
            className: "dshm-row" + (index === current ? " dshm-row--active" : ""),
            ref: index === current ? activeRowRef : undefined,
            onClick: () => player.play(index),
            title: track.name,
          },
            h("td", { className: "dshm-colDelete" }, h("button", {
              type: "button",
              className: "dshm-del",
              title: t("action.delete"),
              "aria-label": t("action.delete") + " " + track.title,
              onClick: (event) => {
                // 行点击是播放；删除按钮必须拦住冒泡，避免误触播放
                event.stopPropagation();
                player.remove(index);
              },
            }, "−")),
            h("td", { className: "dshm-cellTitle" }, track.title),
            h("td", { className: "dshm-cellArtist" }, track.artist ?? t("artist.unknown")),
            h("td", { className: "dshm-colDuration" }, formatTime(track.duration)),
          ))),
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

      // 底部条专辑封面：无内嵌封面时回退音符图标
      const [coverFailed, setCoverFailed] = useState(false);
      useEffect(() => setCoverFailed(false), [currentTrack?.id]);

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
        h("span", { className: "dshm-dir", title: state.dir ?? "" }, state.dir ?? t("empty.title")),
        state.tracks.length > 0 && h("input", {
          type: "search",
          className: "dshm-search",
          placeholder: t("action.search.placeholder"),
          value: state.query,
          onChange: (event) => player.setQuery(event.target.value),
        }),
        state.scanning
          ? h("span", { className: "dshm-stats" }, t("scan.progress")(state.scanParsed, state.scanTotal))
          : state.tracks.length > 0 && h("span", { className: "dshm-stats" },
              t("stats")(visibleTracks.length === state.tracks.length ? state.tracks.length : visibleTracks.length + "/" + state.tracks.length),
              state.truncated ? " · " + t("stats.truncated") : ""),
        h("button", {
          type: "button",
          className: "dshm-btn",
          disabled: state.tracks.length === 0 || busy,
          onClick: () => player.refresh(),
        }, t("action.refresh")),
        h("button", {
          type: "button",
          className: "dshm-btn",
          disabled: busy,
          onClick: () => player.pick(),
        }, ICONS.folder, busy ? (state.picking ? t("action.picking") : t("action.loading")) : t("action.chooseDir")),
        h("button", {
          type: "button",
          className: "dshm-btn",
          title: t("action.inputDir"),
          disabled: busy,
          onClick: () => {
            setDirInputValue(state.dir ?? "");
            setDirInputOpen(!dirInputOpen);
          },
        }, "⌨", dirInputOpen ? "×" : ""),
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
          activeRowRef,
        });
      }

      const bar = h("div", { className: "dshm-bar" },
        h("div", { className: "dshm-nowPlaying" },
          currentTrack !== undefined && !coverFailed
            ? h("img", {
                className: "dshm-cover",
                src: "/dsh-music/api/cover?p=" + encodeURIComponent(currentTrack.id) + "&v=" + (state.scannedAt ?? 0),
                alt: "",
                onError: () => setCoverFailed(true),
              })
            : h("span", { className: "dshm-noteIcon" }, ICONS.note),
          h("div", { className: "dshm-nowText" },
            h("div", { className: "dshm-nowTitle" }, currentTrack?.title ?? "—"),
            h("div", { className: "dshm-nowArtist" }, currentTrack ? (currentTrack.artist ?? t("artist.unknown")) : ""),
          ),
        ),
        h("div", { className: "dshm-center" },
          h("div", { className: "dshm-transport" },
            h("button", { type: "button", className: "dshm-tbtn", disabled: state.tracks.length === 0, onClick: () => player.prev(), "aria-label": "previous" }, ICONS.prev),
            h("button", { type: "button", className: "dshm-tbtn dshm-tbtn--play", disabled: state.tracks.length === 0, onClick: () => player.toggle(), "aria-label": "play/pause" }, state.playing ? ICONS.pause : ICONS.play),
            h("button", { type: "button", className: "dshm-tbtn", disabled: state.tracks.length === 0, onClick: () => player.next(), "aria-label": "next" }, ICONS.next),
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
          h("button", {
            type: "button",
            className: "dshm-mode",
            onClick: () => player.toggleMode(),
            title: state.mode === "loop" ? t("mode.loop") : t("mode.one"),
          }, state.mode === "loop" ? ICONS.repeat : ICONS.repeatOne, state.mode === "loop" ? t("mode.loop") : t("mode.one")),
          ICONS.volume,
          h("input", {
            type: "range",
            className: "dshm-slider dshm-volume",
            ref: volumeWheelRef,
            style: { "--p": volumePct + "%" },
            min: 0,
            max: 1,
            step: 0.01,
            value: state.volume,
            onChange: (event) => player.setVolume(Number(event.target.value)),
          }),
        ),
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
        confirmBar,
        state.error !== null && h("div", { className: "dshm-error" }, t("error.prefix"), state.error),
        body,
        bar,
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
