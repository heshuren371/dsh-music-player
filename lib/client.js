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
      "action.refresh": "刷新",
      "action.picking": "正在选择…",
      "action.loading": "正在扫描…",
      "col.index": "#",
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
      "error.prefix": "出错了：",
      "error.unsupported": "无法播放该文件（格式不受支持或文件已移动）",
    };
    const en = {
      "view.music": "Music",
      "action.chooseDir": "Choose Folder",
      "action.refresh": "Refresh",
      "action.picking": "Picking…",
      "action.loading": "Scanning…",
      "col.index": "#",
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
      "error.prefix": "Error: ",
      "error.unsupported": "Cannot play this file (unsupported format or file moved)",
    };

    const CSS = `
.dshm-root{box-sizing:border-box;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xs-13);flex-direction:column;display:flex;overflow:hidden}
.dshm-root *{box-sizing:border-box}
.dshm-header{border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex:none;align-items:center;gap:10px;min-height:44px;padding:0 14px;display:flex}
.dshm-title{font-size:14px;font-weight:600;flex:none}
.dshm-dir{min-width:0;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px;text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}
.dshm-stats{color:var(--dsw-alias-label-tertiary);flex:none;font-size:11px}
.dshm-btn{cursor:pointer;height:26px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1);border-radius:7px;flex:none;align-items:center;gap:5px;padding:0 10px;font:inherit;font-size:12px;display:inline-flex}
.dshm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshm-btn:disabled{cursor:not-allowed;opacity:.45}
.dshm-error{border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-tertiary);flex:none;padding:6px 14px;font-size:12px}
.dshm-tableWrap{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.dshm-table{border-spacing:0;table-layout:fixed;width:100%;font-size:12px}
.dshm-table th{z-index:2;border-bottom:1px solid var(--dsw-alias-border-l2);height:30px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-specific-sidebar-fill);text-align:left;font-weight:500;padding:0 10px;position:sticky;top:0;user-select:none;white-space:nowrap}
.dshm-table td{border-bottom:1px solid var(--dsw-alias-border-l1);height:32px;text-overflow:ellipsis;white-space:nowrap;padding:0 10px;overflow:hidden}
.dshm-colIndex{width:44px;text-align:right!important;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshm-colDuration{width:64px;text-align:right!important;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshm-colArtist{width:26%}
.dshm-row{cursor:default;transition:background-color .12s var(--ds-ease-in-out)}
.dshm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshm-row--active{background:var(--dsw-alias-interactive-bg-active)}
.dshm-row--active .dshm-cellTitle{color:var(--dsw-alias-state-business-primary);font-weight:500}
.dshm-cellTitle{color:var(--dsw-alias-label-primary)}
.dshm-cellArtist{color:var(--dsw-alias-label-secondary)}
.dshm-eq{width:12px;height:12px;color:var(--dsw-alias-state-business-primary);display:inline-block;vertical-align:-2px}
.dshm-empty{min-height:0;flex:1;color:var(--dsw-alias-label-tertiary);text-align:center;flex-direction:column;justify-content:center;align-items:center;gap:10px;padding:32px;display:flex}
.dshm-emptyIcon{font-size:44px;line-height:1;opacity:.5}
.dshm-emptyHint{max-width:420px;font-size:12px;line-height:1.7}
.dshm-bar{border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-sidebar-fill);flex:none;align-items:center;gap:14px;min-height:64px;padding:8px 16px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) minmax(0,1fr)}
.dshm-nowPlaying{min-width:0;align-items:center;gap:10px;display:flex}
.dshm-noteIcon{width:34px;height:34px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;flex:none;justify-content:center;align-items:center;display:flex}
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
      eq: h("svg", { width: 12, height: 12, viewBox: "0 0 12 12", fill: "currentColor" }, h("rect", { x: 1, y: 4, width: 2.2, height: 7, rx: .6 }, h("animate", { attributeName: "height", values: "7;3;7", dur: "0.9s", repeatCount: "indefinite" }), h("animate", { attributeName: "y", values: "4;8;4", dur: "0.9s", repeatCount: "indefinite" })), h("rect", { x: 4.9, y: 2, width: 2.2, height: 9, rx: .6 }, h("animate", { attributeName: "height", values: "9;4;9", dur: "0.7s", repeatCount: "indefinite" }), h("animate", { attributeName: "y", values: "2;7;2", dur: "0.7s", repeatCount: "indefinite" })), h("rect", { x: 8.8, y: 5, width: 2.2, height: 6, rx: .6 }, h("animate", { attributeName: "height", values: "6;2;6", dur: "1.1s", repeatCount: "indefinite" }), h("animate", { attributeName: "y", values: "5;9;5", dur: "1.1s", repeatCount: "indefinite" }))),
    };

    /** Locale translator for module-scope code; bound in apply() after locale registers. */
    let translate = (key) => key;

    function formatTime(value) {      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "--:--";
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

    /**
     * Player singleton. The <audio> element lives at module scope (not inside the
     * view tree), so playback keeps running when the user switches to another tab
     * and the Music view unmounts.
     */
    function createPlayer() {
      const audio = new Audio();
      audio.preload = "auto";
      let state = {
        dir: null,
        tracks: [],
        scannedAt: null,
        loading: false,
        picking: false,
        error: null,
        current: -1,
        playing: false,
        mode: "loop",
        time: 0,
        duration: 0,
        volume: 1,
      };
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

      const applyLibrary = (payload) => set({
        dir: payload.dir,
        tracks: payload.tracks ?? [],
        scannedAt: payload.scannedAt ?? null,
        error: null,
      });

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

      const playIndex = (index) => {
        const track = state.tracks[index];
        if (track === undefined) return;
        audio.src = "/dsh-music/api/stream?i=" + index + "&v=" + (state.scannedAt ?? 0);
        audio.volume = state.volume;
        set({ current: index, time: 0, duration: typeof track.duration === "number" ? track.duration : 0 });
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

      const next = () => {
        if (state.tracks.length === 0) return;
        playIndex(state.current < 0 ? 0 : (state.current + 1) % state.tracks.length);
      };
      const prev = () => {
        if (state.tracks.length === 0) return;
        // macOS Music behavior: beyond 3s into the song, "previous" restarts it.
        if (audio.currentTime > 3 && state.current >= 0) {
          audio.currentTime = 0;
          return;
        }
        playIndex(state.current <= 0 ? state.tracks.length - 1 : state.current - 1);
      };

      audio.addEventListener("timeupdate", () => {
        if (state.current < 0) return;
        set({ time: audio.currentTime, duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration });
      });
      audio.addEventListener("play", () => {
        errorStreak = 0;
        set({ playing: true, error: null });
      });
      audio.addEventListener("pause", () => set({ playing: false }));
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
        errorStreak += 1;
        set({ playing: false, error: translate("error.unsupported") });
        // In repeat-all mode skip past broken files; give up when everything failed.
        if (state.mode === "loop" && errorStreak < state.tracks.length) {
          setTimeout(() => {
            if (state.error !== null) next();
          }, 600);
        }
      });

      return {
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
            if (state.current >= state.tracks.length) set({ current: -1, playing: false, time: 0, duration: 0 });
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
              applyLibrary(payload);
              set({ current: -1, playing: false, time: 0, duration: 0 });
              audio.removeAttribute("src");
              audio.load();
            }
          } catch (error) {
            set({ error: error instanceof Error ? error.message : String(error) });
          } finally {
            set({ picking: false });
          }
        },
        play: playIndex,
        toggle: () => {
          if (state.current < 0) {
            if (state.tracks.length > 0) playIndex(0);
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
        next,
        prev,
        seek: (value) => {
          if (state.current < 0 || !Number.isFinite(value)) return;
          audio.currentTime = value;
          set({ time: value });
        },
        setVolume: (value) => {
          audio.volume = value;
          set({ volume: value });
        },
        toggleMode: () => set({ mode: state.mode === "loop" ? "one" : "loop" }),
        /** Live playback clock for the smooth progress fill (rAF consumers). */
        now: () => audio.currentTime,
      };
    }

    /** One shared player per loaded module instance. */
    const player = createPlayer();

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
          event.preventDefault();
          latest.current(event);
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
      }, []);
      return ref;
    }

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

      // Smooth progress: while playing, track the live audio clock with rAF
      // (timeupdate only fires ~4Hz, which makes the fill visibly step).
      const [smoothTime, setSmoothTime] = useState(state.time);
      const [dragValue, setDragValue] = useState(null);
      const draggingRef = useRef(false);
      useEffect(() => {
        setSmoothTime(state.time);
        if (!state.playing) return;
        let raf;
        const tick = () => {
          if (!draggingRef.current) setSmoothTime(player.now());
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      }, [state.playing, state.current, state.time]);

      const displayTime = dragValue ?? smoothTime;
      const progressPct = state.duration > 0 ? Math.min(100, (displayTime / state.duration) * 100) : 0;
      const volumePct = Math.round(state.volume * 100);

      // 滚轮：进度条 ±5s（Shift 微调 ±1s），音量条 ±5%。
      const progressWheelRef = useWheelHandler((event) => {
        if (state.current < 0 || !(state.duration > 0)) return;
        const step = event.shiftKey ? 1 : 5;
        const delta = (event.deltaY < 0 ? step : -step);
        player.seek(Math.max(0, Math.min(state.duration, player.now() + delta)));
      });
      const volumeWheelRef = useWheelHandler((event) => {
        const delta = (event.deltaY < 0 ? 0.05 : -0.05);
        player.setVolume(Math.max(0, Math.min(1, Math.round((state.volume + delta) * 100) / 100)));
      });

      const header = h("div", { className: "dshm-header" },
        h("span", { className: "dshm-title" }, t("view.music")),
        h("span", { className: "dshm-dir", title: state.dir ?? "" }, state.dir ?? t("empty.title")),
        state.tracks.length > 0 && h("span", { className: "dshm-stats" }, t("stats")(state.tracks.length)),
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
      );

      let body;
      if (state.dir === null) {
        body = h("div", { className: "dshm-empty" },
          h("div", { className: "dshm-emptyIcon" }, "♪"),
          h("div", null, t("empty.title")),
          h("div", { className: "dshm-emptyHint" }, t("empty.hint")),
          h("button", { type: "button", className: "dshm-btn", disabled: busy, onClick: () => player.pick() }, ICONS.folder, t("action.chooseDir")),
        );
      } else if (state.tracks.length === 0 && !state.loading) {
        body = h("div", { className: "dshm-empty" },
          h("div", { className: "dshm-emptyIcon" }, "♪"),
          h("div", null, t("empty.tracks")),
        );
      } else {
        body = h("div", { className: "dshm-tableWrap" },
          h("table", { className: "dshm-table" },
            h("thead", null, h("tr", null,
              h("th", { className: "dshm-colIndex" }, t("col.index")),
              h("th", null, t("col.title")),
              h("th", { className: "dshm-colArtist" }, t("col.artist")),
              h("th", { className: "dshm-colDuration" }, t("col.duration")),
            )),
            h("tbody", null, state.tracks.map((track, index) => h("tr", {
              key: index + ":" + track.name,
              className: "dshm-row" + (index === state.current ? " dshm-row--active" : ""),
              ref: index === state.current ? activeRowRef : undefined,
              onClick: () => player.play(index),
              title: track.name,
            },
              h("td", { className: "dshm-colIndex" }, index === state.current && state.playing ? h("span", { className: "dshm-eq" }, ICONS.eq) : String(index + 1)),
              h("td", { className: "dshm-cellTitle" }, track.title),
              h("td", { className: "dshm-cellArtist" }, track.artist ?? t("artist.unknown")),
              h("td", { className: "dshm-colDuration" }, formatTime(track.duration)),
            ))),
          ),
        );
      }

      const bar = h("div", { className: "dshm-bar" },
        h("div", { className: "dshm-nowPlaying" },
          h("span", { className: "dshm-noteIcon" }, ICONS.note),
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
            h("span", { className: "dshm-time" }, formatTime(displayTime)),
            h("input", {
              type: "range",
              className: "dshm-slider",
              ref: progressWheelRef,
              style: { "--p": progressPct + "%" },
              min: 0,
              max: state.duration > 0 ? state.duration : 1,
              step: 0.1,
              value: Math.min(displayTime, state.duration > 0 ? state.duration : 1),
              disabled: state.current < 0,
              onPointerDown: () => {
                draggingRef.current = true;
              },
              onPointerUp: () => {
                draggingRef.current = false;
                // Commit the scrubbed position only when the drag ends.
                if (dragValue !== null) {
                  player.seek(dragValue);
                  setDragValue(null);
                }
              },
              onChange: (event) => {
                const value = Number(event.target.value);
                // Pointer drags preview locally; keyboard arrows seek directly.
                if (draggingRef.current) setDragValue(value);
                else player.seek(value);
              },
            }),
            h("span", { className: "dshm-time" }, formatTime(state.duration)),
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

      return h("div", { className: "dshm-root" },
        header,
        state.error !== null && h("div", { className: "dshm-error" }, t("error.prefix"), state.error),
        body,
        bar,
      );
    }

    const inject = ["slots", "locale"];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "music-player: dictionaries");
      const t = ctx.locale.bind(NS);
      translate = t;
      player.t = t;
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
      }, MusicView));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
