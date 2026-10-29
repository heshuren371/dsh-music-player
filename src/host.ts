import { promises as fs } from 'node:fs';
import { createReadStream, existsSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';
import { File as TagFile, Picture as TagPicture, ByteVector } from 'node-taglib-sharp';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import qrcode from 'qrcode-generator';
import { fetchFromNodeHandler } from './http-bridge.js';

// ── 就地声明的数据结构 ───────────────────────────────────────────────────────
// 按 AGENTS.md §2.15：client.ts 不能 import，宿主侧类型一律声明在本文件内，
// 不新建只有 host 会 import 的类型模块。这些声明**只是类型**，编译后不产生任何代码。

/** 扫描阶段发现的一个候选文件（mime 与音/视频类别决定它怎么被播放）。 */
interface ScannedFile {
  path: string;
  mime: string | undefined;
  kind: 'audio' | 'video';
}

/**
 * 波形缓存的一条：`peaks` 是 0..1 的 400 个桶（与 UI 宽度解耦，客户端再抽样）。
 * `size`/`mtimeMs` 与 RG 同理：文件变了就重算。
 */
interface WaveEntry {
  peaks: number[];
  size: number;
  mtimeMs: number;
  at: number;
}

/** 一条测量结果。`size`/`mtimeMs` 用于判断文件是否变过（变了要重测）。 */
interface RgEntry {
  trackGainDb: number;
  trackPeak: number;
  size: number;
  mtimeMs: number;
  measuredAt: number;
}

/**
 * ReplayGain 参考电平：**-18 LUFS**（ReplayGain 2.0 规范）。
 * 增益 = 参考 − 实测积分响度（LUFS），与 `loudgain` 的做法一致。
 */
const RG_REFERENCE_LUFS = -18;

/**
 * 解析 `ffmpeg -af ebur128=peak=true` 的摘要输出（纯函数，便于用**真实 ffmpeg 输出**做门禁）。
 * 摘要出现在末尾，所以要取**最后一次**匹配。峰值可能是 `-inf dBFS`（全静音）→ 返回 null，调用方跳过。
 */
function parseEbur128(text: string): { lufs: number; peakDb: number | null } | null {
  const lufsMatches = [...text.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  if (lufsMatches.length === 0) return null;
  const lufs = Number(lufsMatches[lufsMatches.length - 1][1]);
  if (!Number.isFinite(lufs)) return null;
  // 真峰值可能是 `-inf dBFS`（全静音）。那不是「读不出来」，而是「无可测内容」：
  // 返回 peakDb=null 让调用方把它算作**跳过**，而不是失败。
  const peakMatches = [...text.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g)];
  if (peakMatches.length === 0) return { lufs, peakDb: null };
  const peakDb = Number(peakMatches[peakMatches.length - 1][1]);
  return { lufs, peakDb: Number.isFinite(peakDb) ? peakDb : null };
}

/** 深度优先扫描的待访问目录（depth 用于 MAX_SCAN_DEPTH 截断）。 */
interface ScanFrame {
  directory: string;
  depth: number;
}

/**
 * 库内曲目。`id` 是相对库根目录的稳定标识（不是数组下标）：重扫、重排都不会变，
 * 由 scanLibrary 在扫描收尾时回填（readMetadata 先给空串占位）。
 */
interface Track {
  id: string;
  path: string;
  name: string;
  title: string;
  artist: string | null;
  duration: number | null;
  /** 文件 mtime（毫秒）：列表「最近添加/修改」排序用；null = stat 失败。 */
  addedAt: number | null;
  mime: string | undefined;
  kind: 'audio' | 'video';
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  tagged: boolean;
  /**
   * ReplayGain：**标准标签**（`REPLAYGAIN_TRACK_GAIN` 等），由 music-metadata 归一化成
   * `{dB, ratio}`。未测量过就是 null —— 客户端对 null **不做任何增益**（不是当 0dB 用）。
   * dB 用于增益，peak 用于防削波（增益后峰值可能越界）。
   */
  rgTrackGainDb: number | null;
  rgTrackPeak: number | null;
  rgAlbumGainDb: number | null;
  rgAlbumPeak: number | null;
}

/** 一次完整扫描的结果；`scannedAt` 变化即代表库内容已更新（payload 缓存据此失效）。 */
interface LibraryResult {
  dir: string;
  tracks: Track[];
  truncated: boolean;
  skippedPackages: number;
  scannedAt: number;
}

/** /library 下发给 UI 的曲目形状（只含 UI 读的字段，index 由数组顺序隐含）。 */
interface PayloadTrack {
  id: string;
  name: string;
  title: string;
  artist: string | null;
  duration: number | null;
  /** 文件 mtime（毫秒）；仅供客户端排序，不参与播放逻辑。 */
  addedAt: number | null;
  tagged: boolean;
  kind: 'audio' | 'video';
  videoCodec: string | null;
  /**
   * 音轨编码。客户端只用它判断一件事：**WASM 画面旁路**能不能用 —— 那条路元素仍要自己
   * 解音轨，音轨解不了就是「有画面、没声音」，而且会跳过本来能修好音轨的转码。
   */
  audioCodec: string | null;
  /** ReplayGain：Track → PayloadTrack 是**白名单投影**，漏加就永远下发不出去。 */
  rgTrackGainDb: number | null;
  rgTrackPeak: number | null;
  rgAlbumGainDb: number | null;
  rgAlbumPeak: number | null;
  /** 插件**测量**出来的增益/峰值（不是文件里的标签）；标签优先由客户端决定。 */
  rgMeasuredGainDb: number | null;
  rgMeasuredPeak: number | null;
}

/** 封面：只有 mime 过白名单、且未超字节上限的才会走到这里。 */
interface Cover {
  data: Buffer;
  mime: string;
}

/** 一条 MV 转封装/转码任务的状态（cacheKey → job），供轮询端点回报进度。 */
interface MvJob {
  state: 'preparing' | 'ready' | 'failed';
  progress: number;
  error: string | null;
  child: ChildProcess | null;
  attempt: string | null;
  log: string;
  finishedAt: number | null;
  /**
   * 停用/热重载已经放弃这个任务。档位循环每起一档前都要看它：SIGKILL 掉子进程只会让
   * `close` 带着非零码回来，循环若继续就会**再起一个没人管的 ffmpeg**（A1-03 的孤儿进程）。
   */
  cancelled: boolean;
  /** 这一档撞上了超时（已经 SIGKILL）：后续档位直接跳过，把任务判失败。 */
  timedOut: boolean;
}


/** 从视频链接导入的类型：音频（mp3）或视频（mp4，作为 MV 曲目）。 */
type ImportKind = 'audio' | 'video';
type ImportPhase = 'queued' | 'starting' | 'metadata' | 'download' | 'finalize' | 'done' | 'error' | 'cancelled';

interface ImportInfo {
  title: string;
  artist: string;
  duration: number | null;
  id: string;
  source: string;
}

/**
 * 一次链接导入任务。`dir`/`tmpBase` 只在宿主内部使用，`importSnapshot` 不把它们
 * 下发给页面：客户端只需要知道结果在不在、成没成，不需要也不应该拿到本地路径。
 */
interface ImportJob {
  id: string;
  kind: ImportKind;
  /** 用户选择的视频高度上限；null = 自动最佳。 */
  height: number | null;
  url: string;
  phase: ImportPhase;
  progress: number;
  title: string | null;
  artist: string | null;
  file: string | null;
  trackId: string | null;
  tagged: boolean;
  warning: string | null;
  error: string | null;
  speed: string | null;
  eta: string | null;
  startedAt: number;
  finishedAt: number | null;
  child: ChildProcess | null;
  cancelled: boolean;
  timedOut: boolean;
  dir: string;
  tmpBase: string;
}

/** B 站扫码登录后的展示状态；cookie 本身只留在宿主文件里。 */
interface BiliAuth {
  loggedIn: boolean;
  uname?: string;
  mid?: number | null;
  vip?: boolean;
}

/** 一种可用清晰度（同一 height 只保留评分最高的一条格式）。 */
interface ImportFormat {
  height: number;
  fps: number | null;
  ext: string;
  filesize: number | null;
  note: string;
}

/** 清晰度探测的下发形状。 */
interface ImportProbe {
  title: string;
  artist: string;
  duration: number | null;
  heights: ImportFormat[];
  recommended: number | null;
  loggedIn: boolean;
  needsLogin: boolean;
}

/** 下发给页面的任务快照（白名单投影，不含本地路径）。 */
interface ImportSnapshot {
  id: string;
  /** 用户提交的公开链接；用于排队/失败时辨认任务（validateImportUrl 已拒绝凭据）。 */
  url: string;
  kind: ImportKind;
  height: number | null;
  phase: ImportPhase;
  progress: number;
  title: string | null;
  artist: string | null;
  file: string | null;
  trackId: string | null;
  tagged: boolean;
  warning: string | null;
  error: string | null;
  speed: string | null;
  eta: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** 写标签的结果；tagged=false 时 reason 说明原因（worker 不可用 / 超时 / 格式不支持）。 */
interface TagWriteResult {
  tagged: boolean;
  reason?: string;
}

/** 各在线源归一化后的候选曲目（mergeCandidate 合并时会补上 sources）。 */
interface Candidate {
  source: string;
  rank: number;
  id: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
  duration: number | null;
  sources: string[];
  /** 仅在“歌曲搜索没有封面、专辑搜索补到图”时出现：标题/歌手沿用本地。 */
  coverOnly?: boolean;
}

/** 打分后的候选（/match 下发给 UI 的形状）。 */
interface RankedCandidate extends Candidate {
  score: number;
  auto: boolean;
}

/** 带 HTTP 状态码的错误：`statusCode` 不是 Error 的标准字段，路由层按它回响应。 */
interface StatusError extends Error {
  statusCode: number;
}

/** 有 `message` 字段的对象/函数（Error、Node 的 SystemError、普通对象都算）。 */
function isMessageCarrier(value: unknown): value is { message?: unknown } {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * 取抛出物的 `message`，与原来的 `error?.message` **语义完全一致**（值可能不是字符串，
 * 所以返回 unknown，由调用方决定是否 String()）。`useUnknownInCatchVariables` 下
 * catch 绑定是 unknown，这里做一次真实收窄：非对象/函数一律 undefined。
 */
function thrownMessage(error: unknown): unknown {
  if (!isMessageCarrier(error) || !('message' in error)) return undefined;
  return error.message;
}

/**
 * music-metadata 的 `IFormat` 类型里没有 `audioCodec`（旧字段名），但运行时它可能带着
 * 这个字段。不假设、也不说谎：按 `unknown` 读取，只有字符串才采纳，否则返回 null
 * （与原来 `typeof metadata.format.audioCodec === 'string' ? ... : null` 等价）。
 */
function readFormatAudioCodec(format: unknown): string | null {
  if (format === null || typeof format !== 'object' || !('audioCodec' in format)) return null;
  const codec = format.audioCodec;
  return typeof codec === 'string' ? codec : null;
}

/**
 * 注：这里原有两个未导出的 Cordis 模块约定常量（`name` = 'music-player'、
 * `inject` = ['webServer']）。本插件的激活入口是 `facets.host.entry` → `lib/index.js`，
 * 它只调 `createHost()`；那两个常量既不导出也无人 import，属重构残留，已删
 * （见 tsconfig 的 noUnusedLocals）。路由注册面需要 `webServer`（可选）+ `connection.fetch`，
 * 这一事实记录在 AGENTS.md §2.7 与 docs/desktop.md。
 */

/** Browser-playable common audio formats (flac/mp3/m4a/ogg/opus/wav/aac/aiff). */
const AUDIO_EXTENSIONS = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.wave', 'audio/wav'],
]);

/**
 * MV（音乐视频）容器。能不能**直接**播由 Chromium 的解复用器决定，实测（Chromium 131）：
 *   mp4/m4v/mov 可以 ｜ webm 可以 ｜ **mkv 可以**（Matroska 解复用器就在 Chromium 自带的 ffmpeg 里，
 *   H.264+AAC 甚至 H.264+AC3 都能直出画面）
 *   avi / ts / wmv / flv 不行（DEMUXER_ERROR_COULD_NOT_OPEN）
 *   HEVC 在部分构建里没有解码器（只有声音、没有画面）
 * 于是：能直出就直出；容器不认就 remux（-c copy 换壳，几秒钟）；编码不认就 transcode。
 */
const VIDEO_EXTENSIONS = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/x-m4v'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
  ['.avi', 'video/x-msvideo'],
  ['.ts', 'video/mp2t'],
  ['.m2ts', 'video/mp2t'],
  ['.wmv', 'video/x-ms-wmv'],
  ['.flv', 'video/x-flv'],
  ['.mpg', 'video/mpeg'],
  ['.mpeg', 'video/mpeg'],
  ['.3gp', 'video/3gpp'],
]);

/** Chromium 解复用器认的容器（mkv 在列）。 */
const MV_DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);
/** Chromium 有解码器的视频编码。 */
// 注意：不含 mpeg4（MPEG-4 Part 2 / Xvid）与 theora —— Chromium 不带这两个解码器，
// 放进来会导致「只有声音没有画面、而且不报 error」，自动降级也不会触发（实测踩过）。
const MV_DIRECT_VIDEO = new Set(['h264', 'av1', 'vp9', 'vp8']);
/** Chromium 自带的 ffmpeg 基本都认这些音频编码。 */
const MV_DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3', 'pcm', 'alac']);
const VIDEO_CODEC_PATTERNS = [
  [/hvc1|hev1|hevc|h\.?265/i, 'hevc'],
  [/avc1|avc3|\bavc\b|h\.?264|MPEG4\/ISO\/AVC/i, 'h264'],
  [/av01/i, 'av1'],
  [/vp0?9/i, 'vp9'],
  [/vp0?8/i, 'vp8'],
  [/mp4v|MPEG-?4 Visual|MPEG4\/ISO\/ASP|divx|xvid/i, 'mpeg4'],
  [/vc-?1|wmv/i, 'vc1'],
  [/mpeg-?2/i, 'mpeg2'],
  [/theora/i, 'theora'],
];
const AUDIO_CODEC_PATTERNS = [
  [/mp4a|aac|MPEG-?4\/AAC/i, 'aac'],
  [/e-?ac-?3|ec-?3/i, 'eac3'],
  [/\bac-?3\b|ac3/i, 'ac3'],
  [/opus/i, 'opus'],
  [/vorbis/i, 'vorbis'],
  [/flac/i, 'flac'],
  [/dts/i, 'dts'],
  [/alac/i, 'alac'],
  [/pcm/i, 'pcm'],
  [/mp3|MPEG-?1 Layer 3|MPEG-?2 Layer 3/i, 'mp3'],
];

function detectCodec(patterns, text) {
  for (const [pattern, codec] of patterns) if (pattern.test(text)) return codec;
  return null;
}

/**
 * 这条视频该怎么播：direct（直出）/ remux（换壳）/ transcode（重编码）。
 * caps 是客户端上报的解码能力（HEVC/AV1 各构建不一样），默认保守。
 */
function mvPlan(track, caps) {
  const ext = path.extname(track.path).toLowerCase().slice(1);
  const video = track.videoCodec ?? null;
  if (video !== null && !MV_DIRECT_VIDEO.has(video)) {
    // HEVC/AV1 要看客户端有没有解码器（各构建不同），其余不认的编码只能重编码。
    const capable = (video === 'hevc' && caps.hevc === true) || (video === 'av1' && caps.av1 !== false);
    if (!capable) return 'transcode';
  }
  // 音轨解不了就得让 ffmpeg 转一遍音轨（视频原样保留，见 mvPrepare 的档位）。
  // **不按容器豁免**：mkv 里的 DTS/TrueHD 一样解不了，直出就是「有画面、没声音」，
  // 而且不报 error，客户端的画面看门狗也看不见。
  if (typeof track.audioCodec === 'string' && !MV_DIRECT_AUDIO.has(track.audioCodec)) return 'remux';
  return MV_DIRECT_CONTAINERS.has(ext) ? 'direct' : 'remux';
}

/** ffprobe 探测：与 ffmpeg 同目录；没有就返回 null（退回 music-metadata 的启发式）。 */
function findFfprobe() {
  const ffmpeg = findFfmpeg();
  if (ffmpeg === null) return null;
  const candidate = path.join(path.dirname(ffmpeg), 'ffprobe');
  return existsSync(candidate) ? candidate : null;
}

/**
 * 用 ffprobe 读首个视频/音频流的编码名（只在扫描视频文件时同步调一次，带超时）。
 * 失败一律返回 null，让上层退回启发式判定 —— 没装 ffmpeg 的机器也照常工作。
 */
/**
 * 归一化探测到的编码名：认得出就换成表里的规范名，认不出就**原样保留**。
 *
 * 原样保留是必要的：`null` 在 `mvPlan` 里的含义是「没有这条轨」，而「有轨但名字不认识」
 * 是一个**已知不可播**的信号。把 truehd / wmav2 / prores 这类名字吞成 null，等于让它们
 * 走直出 —— 症状就是有画面、没声音（F2）。
 */
function recognizeCodec(patterns, name) {
  const text = String(name ?? '').trim();
  if (text.length === 0) return null;
  return detectCodec(patterns, text) ?? text.toLowerCase();
}

/**
 * /api/mv 的 mp4/mkv/webm 之外的容器（avi/ts）在 music-metadata 那里会直接抛错，
 * 于是 ffprobe 是这些文件**唯一**的编码来源 —— 调用点必须放在 music-metadata 的
 * try 之外，否则它永远跑不到（那正是它被引进来的理由）。
 */
function videoCodecByFfprobe(filePath) {
  const probe = findFfprobe();
  if (probe === null) return { video: null, audio: null };
  try {
    const result = spawnSync(probe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', filePath], { encoding: 'utf8', timeout: 8000, maxBuffer: 1 << 20 });
    if (result.status !== 0 || typeof result.stdout !== 'string') return { video: null, audio: null };
    const streams = JSON.parse(result.stdout).streams ?? [];
    const video = streams.find((entry) => entry.codec_type === 'video');
    const audio = streams.find((entry) => entry.codec_type === 'audio');
    return {
      video: video ? recognizeCodec(VIDEO_CODEC_PATTERNS, video.codec_name) : null,
      audio: audio ? recognizeCodec(AUDIO_CODEC_PATTERNS, audio.codec_name) : null,
    };
  } catch {
    return { video: null, audio: null };
  }
}

/** ffmpeg 探测：环境变量 → Homebrew/MacPorts/系统路径 → PATH。 */
function findFfmpeg() {
  const explicit = process.env.DSH_MUSIC_FFMPEG;
  if (typeof explicit === 'string' && explicit.length > 0 && existsSync(explicit)) return explicit;
  for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(candidate)) return candidate;
  }
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, 'ffmpeg');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}


/**
 * 从链接导入只接受公开页面：https、无凭据、标准端口、平台白名单。
 * 不提供登录/cookie 通道，也不在这里尝试绕过付费墙或 DRM。
 */
export const IMPORT_HOSTS = [
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv',
  'vimeo.com', 'www.vimeo.com', 'player.vimeo.com',
  'soundcloud.com', 'www.soundcloud.com',
];

/** 下载与元数据读取的时间上限。 */
const IMPORT_TIMEOUT_MS = 20 * 60 * 1000;
const IMPORT_METADATA_TIMEOUT_MS = 60 * 1000;
/** 文件大小的硬上限（yt-dlp 自己也会在超过时中止）。 */
const IMPORT_MAX_FILESIZE = '2G';
/** 处理完成后保留任务快照的时长（页面刷新后还能看到结果）。 */
const IMPORT_JOB_TTL_MS = 60 * 60 * 1000;
/** 同时运行的 yt-dlp 数；其余任务排队。3 个足以跑满带宽，又不会把磁盘/CPU 打满。 */
const IMPORT_CONCURRENCY = 3;
/** 一次提交的链接上限，防止误粘整页文本把队列塞爆。 */
const IMPORT_MAX_BATCH = 20;
const IMPORT_TMP_PREFIX = '.dshm-import-';

/** 探测 yt-dlp：显式环境变量优先（测试/自定义安装），其次 Homebrew / 系统 / PATH。 */
export function findYtDlp() {
  const explicit = process.env.DSH_MUSIC_YTDLP;
  if (typeof explicit === 'string') {
    if (explicit.length === 0) return null;
    return existsSync(explicit) ? explicit : null;
  }
  const candidates = [
    '/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp',
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
    path.join(process.env.USERPROFILE ?? '', 'scoop', 'shims', 'yt-dlp.exe'),
  ];
  for (const candidate of candidates) {
    if (candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const name of ['yt-dlp', 'yt-dlp.exe']) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** 校验并归一化用户粘贴的链接；不合法时抛 400。 */
export function validateImportUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw statusError(400, '链接不能为空');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw statusError(400, '链接格式不正确');
  }
  if (url.protocol !== 'https:') throw statusError(400, '只支持 https 链接');
  if (url.username.length > 0 || url.password.length > 0) throw statusError(400, '链接不能包含账号或密码');
  if (url.port.length > 0 && url.port !== '443') throw statusError(400, '链接端口不受支持');
  const host = url.hostname.toLowerCase();
  if (!IMPORT_HOSTS.includes(host)) {
    throw statusError(400, '只支持公开的 B 站 / YouTube / Vimeo / SoundCloud 链接');
  }
  return url.toString();
}

/** 文件名片段：去掉路径分隔符/控制字符/Windows 保留名，保留中文。 */
export function sanitizeImportName(value) {
  let name = String(value)
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  if (name.length === 0) return '未命名';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = '_' + name;
  return name;
}

/** 最终文件名：`作者 - 标题.ext`；作者未知时只留标题。 */
export function importFileName(info, ext) {
  const artist = info.artist === '未知作者' ? '' : sanitizeImportName(info.artist);
  const title = sanitizeImportName(info.title);
  const base = artist.length > 0 ? artist + ' - ' + title : title;
  return base.slice(0, 180) + String(ext).toLowerCase();
}

/** 从 yt-dlp 的 `-J` 输出里取稳定的展示字段。 */
export function parseYtdlpInfo(value) {
  let raw = value;
  if (raw !== null && typeof raw === 'object' && raw._type === 'playlist' && Array.isArray(raw.entries)) raw = raw.entries[0];
  if (raw === null || typeof raw !== 'object') return null;
  const text = (field) => typeof raw[field] === 'string' ? raw[field].trim() : '';
  const title = text('title') || text('fulltitle') || '未命名';
  const artist = text('uploader') || text('channel') || text('creator') || text('artist') || '未知作者';
  const rawDuration = Number(raw.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;
  return {
    title: title.slice(0, 200),
    artist: artist.slice(0, 120),
    duration,
    id: text('id') || 'import',
    source: text('webpage_url') || text('original_url') || '',
  };
}

/** 解析 `--progress-template` 的 `download:xx%|speed|eta` 行。 */
export function parseImportProgress(line) {
  const match = /^download:\s*([\d.]+)%\s*\|\s*(.*?)\s*\|\s*(.*)$/u.exec(String(line).trim());
  if (match === null) return null;
  const percent = Number(match[1]);
  if (!Number.isFinite(percent)) return null;
  return { percent: Math.max(0, Math.min(100, percent)), speed: match[2], eta: match[3] };
}

/** yt-dlp 参数：固定输出模板在临时前缀上，下载完再按标签重命名。 */
export function buildYtdlpArgs(url, kind, tmpBase, ffmpegPath, height: number | null = null, cookiesPath: string | null = null) {
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress-template', 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--write-thumbnail',
    '--convert-thumbnails', 'jpg',
    '--max-filesize', IMPORT_MAX_FILESIZE,
    '-o', tmpBase + '.%(ext)s',
  ];
  if (typeof ffmpegPath === 'string' && ffmpegPath.length > 0) args.push('--ffmpeg-location', ffmpegPath);
  if (typeof cookiesPath === 'string' && cookiesPath.length > 0) args.push('--cookies', cookiesPath);
  if (kind === 'audio') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  else {
    const format = typeof height === 'number'
      ? `bestvideo[height<=${Math.round(height)}]+bestaudio/best[height<=${Math.round(height)}]`
      : 'bv*+ba/b';
    args.push('-f', format, '--merge-output-format', 'mp4');
  }
  args.push(url);
  return args;
}

/** 把 yt-dlp 的 stderr 变成一句可展示的错误，去掉本地路径与 ANSI 控制码。 */
export function importErrorText(stderr, dir) {
  const lines = String(stderr ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errors = lines.filter((line) => /^ERROR:/i.test(line));
  const picked = (errors.length > 0 ? errors : lines).slice(-3).join(' · ');
  const redacted = typeof dir === 'string' && dir.length > 0 ? picked.split(dir).join('<音乐目录>') : picked;
  return redacted.slice(0, 240).trim() || '下载失败';
}

/**
 * 下载失败的展示文本。403 单独给出可行动的说明：它通常不是「代码坏了」，
 * 而是平台风控、内容需要登录/会员/地区权限，或 yt-dlp 过旧。这里不提供任何绕过。
 */
export function importFailureMessage(stderr, dir) {
  if (/HTTP Error 403|Forbidden/iu.test(String(stderr ?? ''))) {
    return '平台拒绝了媒体流（HTTP 403）：请确认链接公开且你有权下载，并升级 yt-dlp（brew upgrade yt-dlp）。若仍失败，通常是需要登录、会员或地区限制；本功能不提供登录/付费墙/DRM 绕过。';
  }
  return importErrorText(stderr, dir);
}

/** 缩略图扩展名 → 可写入标签的 mime；其他格式不写进文件。 */
function importCoverMime(ext) {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  return null;
}

/** MV 转封装/转码的缓存上限：持久化就必须有界，否则只增不减。 */
const MV_CACHE_MAX_ENTRIES = 24;
const MV_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * MV 转封装/转码的缓存目录。放在**用户数据区**（`$DSH_HOME/storages/dsh-music-mv`）而不是系统
 * 临时目录：临时目录会被系统清理，于是「以前转过的 MV」下次播放要重新转一遍。缓存键跟着
 * 「路径 + 大小 + mtime + 模式」走，源文件一改就自动失效。
 *
 * 惰性取路径（`STATE_DIR` 在本文件后面才定义），调用期才求值。
 */
function mvCacheDir() {
  return path.join(STATE_DIR, 'dsh-music-mv');
}

/**
 * 平台回收站目录。没有可移植约定的平台（Windows）返回 null —— 调用方必须**如实报告**，
 * 不得硬删，也不得在用户家目录里凭空造一个 `.Trash`。
 */
function platformTrashDir(): string | null {
  if (process.platform === 'darwin') return path.join(os.homedir(), '.Trash');
  if (process.platform === 'linux') {
    const dataHome = typeof process.env.XDG_DATA_HOME === 'string' && process.env.XDG_DATA_HOME.length > 0
      ? process.env.XDG_DATA_HOME
      : path.join(os.homedir(), '.local', 'share');
    return path.join(dataHome, 'Trash', 'files');
  }
  return null;
}

/**
 * 有界淘汰：按 mtime 从旧到新删，直到条目数与总字节数都回到上限内；`keep` 是本次要用的产物，
 * 永不删。命中缓存时会把 mtime 推到当前时间（LRU），所以常播的 MV 不会被新转的挤掉。
 */
async function sweepMvCache(keep: string | null): Promise<void> {
  const dir = mvCacheDir();
  let rows;
  try {
    rows = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const entries: Array<{ full: string; size: number; at: number }> = [];
  for (const row of rows) {
    if (!row.isFile()) continue;
    const full = path.join(dir, row.name);
    if (row.name.endsWith('.part')) {
      // 崩溃留下的半成品才清。**必须按年龄判断**：清扫是异步发起的，无条件删会把正在写入的
      // 那个 `.part` 删掉，ffmpeg 随即失败（实测踩过）。
      try {
        const stat = await fs.stat(full);
        if (Date.now() - stat.mtimeMs > MV_ATTEMPT_TIMEOUT_MS) {
          await fs.rm(authorize('fs.write', full, [dir]), { force: true });
        }
      } catch { /* 与其它清理者竞态 */ }
      continue;
    }
    try {
      const stat = await fs.stat(full);
      entries.push({ full, size: stat.size, at: stat.mtimeMs });
    } catch { /* 竞态：刚被删 */ }
  }
  entries.sort((a, b) => a.at - b.at);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let totalCount = entries.length;
  for (const entry of entries) {
    if (totalCount <= MV_CACHE_MAX_ENTRIES && totalBytes <= MV_CACHE_MAX_BYTES) break;
    if (entry.full === keep) continue;
    try {
      await fs.rm(authorize('fs.write', entry.full, [dir]), { force: true });
      totalBytes -= entry.size;
      totalCount -= 1;
    } catch { /* 删不掉就留着，下一次再试 */ }
  }
}

/**
 * 进程级的 token 仓库。用 `Symbol.for`（跨 module 实例稳定的注册表符号）挂在
 * `globalThis` 上：宿主热重载会产生新的 module 实例，但 `globalThis` 与符号注册表
 * 是同一个，所以重载**不会**轮换 token —— 客户端缓存的媒体 URL 才不会因为一次
 * 「保存文件」而全部 403（见 createHost 里 systemArtToken 的注释）。
 */
const TOKEN_STORE = Symbol.for('dsh-music-player.process-tokens');
function processTokens() {
  if (globalThis[TOKEN_STORE] === undefined) {
    globalThis[TOKEN_STORE] = { art: randomUUID(), stream: randomUUID() };
  }
  return globalThis[TOKEN_STORE];
}

/** 正在进行的 MV 任务：cacheKey → job（同 key 只跑一个）。 */
const mvJobs = new Map<string, MvJob>();
/** 终态任务的保留时长（够客户端轮询到结果）与容器容量上限。 */
/** 单首测量超时：ebur128 通常远快于实时，超过这个数当卡住（避免任务永久挂着）。 */
const RG_MEASURE_TIMEOUT_MS = 120 * 1000;
const MV_JOB_TTL_MS = 10 * 60 * 1000;
const MV_JOBS_MAX = 32;

/**
 * 收敛 mvJobs：先摘掉过期的终态条目，仍超上限时按「最老的终态优先」淘汰。
 * **运行中的条目永不淘汰** —— 摘掉它等于把在跑的 ffmpeg 变成没有句柄的孤儿。
 */
function pruneMvJobs(now = Date.now()) {
  for (const [key, job] of mvJobs) {
    const finished = job.state === 'ready' || job.state === 'failed';
    if (finished && now - (job.finishedAt ?? now) > MV_JOB_TTL_MS) mvJobs.delete(key);
  }
  if (mvJobs.size <= MV_JOBS_MAX) return;
  const done = [...mvJobs.entries()]
    .filter(([, job]) => job.state === 'ready' || job.state === 'failed')
    .sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0));
  for (const [key] of done) {
    if (mvJobs.size <= MV_JOBS_MAX) break;
    mvJobs.delete(key);
  }
}

/**
 * 停掉所有在飞 MV 子进程并清空容器（停用 / 热重载时调用）。
 *
 * 为什么必须显式做：`mvJobs` 是 **module 级** Map，而每次热重载都会在 ESM
 * 注册表里留下一个无法卸载的模块条目，旧 Map 被永久钉住 —— 既泄漏容器本身，
 * 又让里面的 ffmpeg 继续跑到结束、继续往临时目录写 `.part`（A1-03）。
 * 只清容器不 kill 子进程同样不够：进程还活着。
 */
function killAllMvJobs(reason) {
  for (const job of mvJobs.values()) {
    // 先立「已放弃」标记再杀进程：否则档位循环会把这次 SIGKILL 当成一档失败，接着起下一档
    // —— 新 module 已经不认识那个子进程，于是卸载后还有 ffmpeg 在写临时目录。
    job.cancelled = true;
    if (job.child !== null) {
      try {
        job.child.kill('SIGKILL');
      } catch {
        // 进程可能已经自己退出了。
      }
    }
    if (job.state !== 'ready') {
      job.state = 'failed';
      job.error = reason;
      job.finishedAt = Date.now();
    }
  }
  mvJobs.clear();
}

/** 客户端上报的解码能力（HEVC/AV1 各构建不同）；默认保守。 */
let mvClientCaps = { hevc: false, av1: true };

/** 缓存键跟着「路径 + 大小 + mtime + 模式」走：文件一改就自动失效。 */
async function mvCacheKey(track, mode) {
  let stamp = 'nostat';
  try {
    const stat = await fs.stat(track.path);
    stamp = stat.size + '-' + Math.round(stat.mtimeMs);
  } catch { /* 文件不在也照样给出 key，交给 ffmpeg 报错 */ }
  return createHash('sha1').update(mode + '|' + track.path + '|' + stamp).digest('hex').slice(0, 32);
}

function mvOutputFor(key) {
  return path.join(mvCacheDir(), key + '.mp4');
}

/** MP4/Chromium 可直接搬运的音频编码：full/fast 档优先 copy，省一次音频重编码。 */
const MV_MP4_AUDIO_COPY = new Set(['aac', 'mp3', 'alac']);

/**
 * 快速档的缩放：最长边超过 1080P 才缩，绝不放大。
 * 4K/1440P 源是转码慢的主因；缩到 1080P 后 ultrafast 的实测吞吐提升约 3.5×。
 */
function mvScaleFilter(track) {
  if (typeof track.width !== 'number' || typeof track.height !== 'number') return null;
  if (Math.max(track.width, track.height) <= 1920) return null;
  return track.width >= track.height ? 'scale=1920:-2' : 'scale=-2:1920';
}

/**
 * ffmpeg 参数。档位按「成功率」递进：
 *  copy  = 音视频原样搬进 MP4（最快，但源里只要有 MP4 装不下的编码就会失败，
 *          实测 AVI 里的 PCM 音频就会让 -c copy 直接报错）；
 *  audio = 视频原样 + 音频转 AAC（绝大多数情况够用，视频零损失）；
 *  full  = 视频重编码成 H.264（HEVC 这类没有解码器的编码只能走这条）。
 */
export function mvFfmpegArgs(track, attempt, output) {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', track.path, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn'];
  if (attempt === 'copy') {
    args.push('-c', 'copy');
  } else if (attempt === 'audio') {
    args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k');
  } else {
    // fast：速度优先（ultrafast + 1080P 上限 + 可搬运音频 copy）。
    // full：兼容兜底（veryfast + 原分辨率 + AAC 重编码）。
    const fast = attempt === 'fast';
    const scale = fast ? mvScaleFilter(track) : null;
    if (scale !== null) args.push('-vf', scale);
    args.push('-c:v', 'libx264', '-preset', fast ? 'ultrafast' : 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    if (fast && typeof track.audioCodec === 'string' && MV_MP4_AUDIO_COPY.has(track.audioCodec)) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', '192k');
    }
  }
  // 输出文件名带 .part（写完才原子改名），ffmpeg 没法从后缀猜格式，必须显式 -f mp4。
  args.push('-f', 'mp4', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output);
  return args;
}


/**
 * 单档 ffmpeg 的超时。没有它，卡住的转码会让任务永远停在 `preparing`：客户端只会一直
 * 转圈（重试按钮只在 `failed` 下渲染），重启宿主进程之前没有任何出口。
 */
const MV_ATTEMPT_TIMEOUT_MS = 30 * 60 * 1000;

/** 音轨编码已知解不了：ffmpeg 必须转一遍音轨（`copy` 档只换壳，音轨照旧没声音）。 */
function audioNeedsTranscode(track) {
  return typeof track.audioCodec === 'string' && !MV_DIRECT_AUDIO.has(track.audioCodec);
}

/** 跑一档 ffmpeg，边跑边把进度写回 job（-progress pipe:1 是机器可读的）。 */
function mvRunAttempt(ffmpeg, track, attempt, output, job, lengthSeconds) {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, mvFfmpegArgs(track, attempt, output), { stdio: ['ignore', 'pipe', 'pipe'] });
    job.child = child;
    job.attempt = attempt;
    const timer = setTimeout(() => {
      job.timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch { /* 已经退了 */ }
    }, MV_ATTEMPT_TIMEOUT_MS);
    timer.unref?.();
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const field = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (field === 'out_time_us' && typeof lengthSeconds === 'number' && lengthSeconds > 0) {
          const done = Number(value) / 1e6 / lengthSeconds;
          if (Number.isFinite(done)) job.progress = Math.max(0, Math.min(0.99, done));
        }
        if (field === 'progress' && value === 'end') job.progress = 0.99;
      }
    });
    child.stderr.on('data', (chunk) => { job.log = (job.log + String(chunk)).slice(-4000); });
    child.on('error', () => { clearTimeout(timer); resolve(-1); });
    child.on('close', (code) => { clearTimeout(timer); resolve(typeof code === 'number' ? code : -1); });
  });
}

/**
 * 取（必要时启动）这条视频的 MV 任务状态：缓存命中直接 ready，正在跑回报进度，
 * 否则起一个 ffmpeg 并按档位递进重试，成功后原子改名进缓存。
 *
 * `retry` 表示调用方要**重新开始**：被明确放弃过的失败任务不会因为一条 10 分钟的
 * 缓存条目而让「重试」按钮变成空操作。
 */
async function mvPrepare(track, mode, lengthSeconds, retry = false) {
  const key = await mvCacheKey(track, mode);
  const output = mvOutputFor(key);
  const ffmpeg = findFfmpeg();
  const url = '/api/dsh-music/mvfile?k=' + key;
  if (existsSync(output)) {
    // 命中：把 mtime 推到当前时间当 LRU 记号（best-effort，失败不影响命中）。
    try {
      const now = new Date();
      await fs.utimes(output, now, now);
    } catch { /* utimes 不可用就退回 FIFO 淘汰 */ }
    void sweepMvCache(output);
    return { key, state: 'ready', progress: 1, error: null, url, ffmpeg: ffmpeg !== null };
  }
  const running = mvJobs.get(key);
  if (running !== undefined) {
    // 上一轮已经失败（且不是刚被停用打断）：`retry` 时必须丢掉它重来，否则客户端点了
    // 「重试」也只能拿回同一条失败记录，直到 10 分钟的 TTL 过期为止。
    if (!(retry && running.state === 'failed')) {
      return { key, state: running.state, progress: running.progress, error: running.error, url: null, ffmpeg: ffmpeg !== null };
    }
    mvJobs.delete(key);
  }
  if (ffmpeg === null) return { key, state: 'failed', progress: 0, error: 'ffmpeg-not-found', url: null, ffmpeg: false };
  await fs.mkdir(mvCacheDir(), { recursive: true });
  void sweepMvCache(null);
  const partial = output + '.part';
  pruneMvJobs();
  const job: MvJob = { state: 'preparing', progress: 0, error: null, child: null, log: '', attempt: null, finishedAt: null, cancelled: false, timedOut: false };
  mvJobs.set(key, job);
  // 档位：音轨已知解不了时**从 `audio` 起**——`copy` 档把原音轨原样搬进 MP4，Chromium
  // 照样解不了，等于白跑一遍（而且产物会被当成 ready 缓存下来）。
  const attempts = mode === 'remux'
    ? (audioNeedsTranscode(track) ? ['audio', 'fast', 'full'] : ['copy', 'audio', 'fast', 'full'])
    : ['fast', 'full'];
  void (async () => {
    for (const attempt of attempts) {
      if (job.cancelled) return;
      const code = await mvRunAttempt(ffmpeg, track, attempt, partial, job, lengthSeconds);
      if (job.cancelled) return;
      if (job.timedOut) {
        job.state = 'failed';
        job.error = 'ffmpeg timeout (' + Math.round(MV_ATTEMPT_TIMEOUT_MS / 60000) + 'min, ' + attempt + ')';
        job.finishedAt = Date.now();
        return;
      }
      if (code === 0) {
        try {
          // 副作用位置授权：MV 产物只能落在缓存目录（A5-04）。
          await fs.rename(
            authorize('fs.write', partial, [mvCacheDir()]),
            authorize('fs.write', output, [mvCacheDir()]),
          );
          job.state = 'ready';
          job.progress = 1;
          job.finishedAt = Date.now();
          void sweepMvCache(output);
        } catch (error) {
          job.state = 'failed';
          job.error = String(thrownMessage(error) ?? error);
          job.finishedAt = Date.now();
        }
        return;
      }
      job.log += '\n[' + attempt + ' exited ' + code + ']';
    }
    // 取最后一行 ffmpeg 原文（跳过我自己插的 [attempt exited N] 标记）。
    const tail = job.log.trim().split('\n').filter((line) => !/^\[(copy|audio|full) exited/.test(line.trim())).slice(-1)[0] ?? '';
    job.state = 'failed';
    job.error = 'ffmpeg failed after ' + attempts.join('/') + (tail.length > 0 ? ' — ' + tail.slice(0, 160) : '');
    job.finishedAt = Date.now();
  })();
  return { key, state: job.state, progress: job.progress, error: null, url: null, ffmpeg: true };
}


/**
 * 端点路径归一化：新旧两种写法折算到同一个规范路径。
 *  - 新（Web 与 DSH Desktop 共用）：\`/api/dsh-music/library\`
 *  - 旧（仅 Web 兼容入口）：\`/dsh-music/api/library\`
 * Desktop 的 desktop-host 只把 \`/api/*\` 分派给宿主，所以新写法是唯一
 * 能在桌面端到达的形态；旧前缀仅用于兼容已经加载的旧客户端 bundle。
 */
function canonicalEndpoint(pathname) {
  if (pathname === '/dsh-music' || pathname === '/dsh-music/') return '/api/dsh-music';
  if (pathname.startsWith('/dsh-music/')) {
    return '/api/dsh-music' + pathname.slice('/dsh-music'.length).replace(/^\/api/, '');
  }
  return pathname;
}

const MAX_TRACKS = 5000;
const MAX_SCAN_DEPTH = 6;
const SCAN_VISIT_LIMIT = 20000;
const METADATA_CONCURRENCY = 8;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);
/**
 * Apple 离线媒体包：.movpkg 是 Apple Music/TV 的 HLS 分片目录，内容为
 * FairPlay（SAMPLE-AES + skd://）加密，浏览器无法解密。扫描时整个跳过，
 * 不要走进去空耗访问预算；计数回报给 UI，让“为什么没显示”有明确答案。
 */
const IGNORED_PACKAGE_SUFFIXES = ['.movpkg'];

/**
 * Embedded cover art is attacker-controlled file content: the picture's
 * declared mime type must never become the response content type verbatim
 * (an audio file tagged "image/svg+xml" would be a same-origin script
 * document). Only inert raster formats are served.
 */
const COVER_MIME_ALLOWLIST = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
]);
/** Per-cover byte cap: bigger payloads are never buffered nor cached. */
const COVER_MAX_BYTES = 8 * 1024 * 1024;
/** Cover cache bounds: entries AND total bytes (big covers must not pin RSS). */
const COVER_CACHE_LIMIT = 200;
const COVER_CACHE_BYTES_LIMIT = 32 * 1024 * 1024;

/**
 * 在线元数据补全：多源搜索 + 相似度打分。只取“原名 / 歌手 / 专辑 / 封面”，
 * 不请求也不返回歌词。数据源：QQ 音乐（中文主力）、iTunes（默认 TW 店，
 * 全球曲库且中文歌可搜到）、网易云（补充）、MusicBrainz（欧美/冷门兜底）。
 * 全部免密钥；由宿主代理请求，既规避浏览器 CORS，也绕开页面 CSP。
 */
const SOURCE_TIMEOUT_MS = 8000;
const MATCH_LIMIT = 10;
const MATCH_CACHE_LIMIT = 400;
const MATCH_CACHE_TTL_MS = 10 * 60 * 1000;
/** 批量自动写入的最低置信分：低于此分只给人看，绝不改文件。 */
const MATCH_AUTO_SCORE = 0.78;
/** 时长差 <=2s 满分；差 >10s 一律不自动写入（版本/翻唱保护线）。 */
const MATCH_DURATION_TOLERANCE = 2;
/** MusicBrainz 要求请求间隔 >=1s。 */
const MUSICBRAINZ_INTERVAL_MS = 1100;
const MUSICBRAINZ_TIMEOUT_MS = 10000;
/**
 * iTunes 默认给 100x100 缩略图。/600x600bb/ 是同一张图的 600px 规格
 * （实测 ~80KB），补缺封面时用高清版本，避免把 300px 缩略图写进文件。
 */
const ARTWORK_SIZE_PATTERN = /\/\d+x\d+bb\.(jpg|png)$/i;
/** 远端封面缓存同样同时受条目数与字节数约束。 */
const ART_CACHE_LIMIT = 200;
const ART_CACHE_BYTES_LIMIT = 32 * 1024 * 1024;
/**
 * 封面代理主机白名单：QQ(y.gtimg.cn)、iTunes(mzstatic)、网易云(music.126.net)、
 * Cover Art Archive(coverartarchive.org → archive.org)。代理绝不能变成任意 URL /
 * 内网 SSRF 跳板，因此跳转的每一跳都要重新过一遍白名单。
 */
const ART_HOST_RULES = [
  { exact: 'mzstatic.com' },
  { suffix: '.mzstatic.com' },
  { exact: 'music.126.net' },
  { suffix: '.music.126.net' },
  { exact: 'gtimg.cn' },
  { suffix: '.gtimg.cn' },
  { exact: 'coverartarchive.org' },
  { suffix: '.coverartarchive.org' },
  { exact: 'archive.org' },
  { suffix: '.archive.org' },
];
/** 版本/演绎关键词：本地没有而候选有 → 重罚，避免把 Live/翻唱当成原版。 */
const VERSION_MARKERS = /(live|remix|acoustic|instrumental|karaoke|cover|demo|remaster(?:ed)?|radio edit|dj|piano|伴奏|纯音乐|钢琴|翻唱|现场|演唱会|女声|男声|童声|深情|dj版|加速|减速)/g;

const sourceCache = new Map();
const artCache = new Map();
let artCacheBytes = 0;
let musicBrainzReadyAt = 0;
let musicBrainzQueue = Promise.resolve();

/**
 * 源健康熔断：某个源连续失败 N 次后进入冷却，冷却期内不再请求它。
 * 没有这一层时，一个被墙/宕掉的源会让“批量补全”每首歌都硬吃一次
 * 8 秒超时（125 首 = 十几分钟纯等待）。
 */
const SOURCE_FAILURE_THRESHOLD = 2;
const SOURCE_COOLDOWN_MS = 60 * 1000;
const sourceHealth = new Map();

/** 同时在跑的匹配上限：防止连点 / 多标签页把 3×N 个上游请求同时打出去。 */
const MATCH_CONCURRENCY = 2;
let matchActive = 0;
/** 等待匹配名额的排队者：push 的是 Promise 的 resolve。 */
const matchWaiters: Array<(value?: unknown) => void> = [];

function isSourceCoolingDown(name) {
  const health = sourceHealth.get(name);
  return health !== undefined && health.readyAt > Date.now();
}

function recordSourceResult(name, ok) {
  if (ok) {
    sourceHealth.delete(name);
    return;
  }
  const health = sourceHealth.get(name) ?? { failures: 0, readyAt: 0 };
  health.failures += 1;
  if (health.failures >= SOURCE_FAILURE_THRESHOLD) health.readyAt = Date.now() + SOURCE_COOLDOWN_MS;
  sourceHealth.set(name, health);
}

async function withMatchSlot(task) {
  while (matchActive >= MATCH_CONCURRENCY) {
    await new Promise((resolve) => matchWaiters.push(resolve));
  }
  matchActive += 1;
  try {
    return await task();
  } finally {
    matchActive -= 1;
    const next = matchWaiters.shift();
    if (next !== undefined) next();
  }
}

function clearMatchCache() {
  sourceCache.clear();
  sourceHealth.clear();
}

function isAllowedArtHost(hostname) {
  const host = String(hostname).toLowerCase();
  return ART_HOST_RULES.some((rule) => (rule.exact !== undefined ? host === rule.exact : host.endsWith(rule.suffix)));
}

function clearArtCache() {
  artCache.clear();
  artCacheBytes = 0;
}

function cacheArtwork(url, art) {
  const previous = artCache.get(url);
  if (previous !== undefined) {
    artCache.delete(url);
    artCacheBytes -= previous.data.length;
  }
  while (artCache.size > 0
    && (artCache.size >= ART_CACHE_LIMIT || artCacheBytes + art.data.length > ART_CACHE_BYTES_LIMIT)) {
    const oldestKey = artCache.keys().next().value;
    const oldest = artCache.get(oldestKey);
    artCache.delete(oldestKey);
    artCacheBytes -= oldest.data.length;
  }
  artCache.set(url, art);
  artCacheBytes += art.data.length;
}

// ── 文本归一化与相似度 ──────────────────────────────────────────────────────

/** 全角→半角、去标点、压空白；大小写/标点无关的比较基础。 */
function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去掉括号段（(Live)/【伴奏】等）后的核心文本：搜索命中率更高。 */
function coreText(value) {
  return normalizeText(String(value ?? '').replace(/[\[(（【][^\])）】]*[\])）】]/g, ' '));
}

function tokenSet(text) {
  return new Set(text.split(' ').filter((token) => token.length > 0));
}

function bigramSet(text) {
  const out = new Set();
  if (text.length === 1) out.add(text);
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

function diceCoefficient(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

/** 0..1 相似度：token 重合 + 字符二元组重合 + 包含关系（中文短标题的关键）。 */
function similarity(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const ca = coreText(left);
  const cb = coreText(right);
  const tokenScore = Math.max(diceCoefficient(tokenSet(a), tokenSet(b)), diceCoefficient(tokenSet(ca), tokenSet(cb)));
  const charScore = Math.max(diceCoefficient(bigramSet(a), bigramSet(b)), diceCoefficient(bigramSet(ca), bigramSet(cb)));
  const contained = ca.length > 1 && cb.length > 1 && (ca.includes(cb) || cb.includes(ca)) ? 0.92 : 0;
  return Math.min(1, Math.max(tokenScore, charScore, contained));
}

/** 时长一致性：本地扫描时长 vs 曲库时长；缺数据返回 null（权重转移）。 */
function durationScore(local, candidate) {
  if (!Number.isFinite(local) || !Number.isFinite(candidate) || local <= 0 || candidate <= 0) return null;
  const delta = Math.abs(local - candidate);
  if (delta <= MATCH_DURATION_TOLERANCE) return 1;
  if (delta <= 5) return 0.82;
  if (delta <= 10) return 0.55;
  if (delta <= 20) return 0.2;
  return 0;
}

/** 候选标题出现本地没有的版本标记（Live/翻唱/DJ 版…）→ 重罚。 */
function versionPenalty(track, candidate) {
  const localMarks = versionMarks(stripTrackNumber(track.title), track.album);
  const candidateMarks = versionMarks(candidate.title, candidate.album);
  let penalty = 0;
  for (const mark of candidateMarks) if (!localMarks.has(mark)) penalty += 0.18;
  for (const mark of localMarks) if (!candidateMarks.has(mark)) penalty += 0.05;
  return Math.min(0.4, penalty);
}

const SOURCE_TRUST = { qq: 0.02, itunes: 0.02, netease: 0.01, musicbrainz: 0 };

/** 综合打分：标题 0.55 / 歌手 0.30 / 时长 0.15，缺项自动重分配权重。 */
function scoreCandidate(track, candidate) {
  // 查询词去掉了「01.」序号，打分也必须用同一份：否则带序号的文件会被
  // 自己扣分（实测 18.If Were A Boy 因此被挡在自动线外）。
  const localTitle = stripTrackNumber(track.title);
  const titleScore = Math.max(similarity(track.title, candidate.title), similarity(localTitle, candidate.title));
  const hasArtist = typeof track.artist === 'string' && track.artist.trim().length > 0;
  const artistScore = hasArtist ? similarity(track.artist, candidate.artist) : 0;
  const dScore = durationScore(track.duration, candidate.duration);
  const live = versionIsLive(track);
  const albumScore = typeof track.album === 'string' && track.album.trim().length > 0
    && typeof candidate.album === 'string' && candidate.album.trim().length > 0
    ? similarity(track.album, candidate.album)
    : null;
  let weightTitle = hasArtist ? 0.55 : 0.75;
  let weightArtist = hasArtist ? 0.3 : 0;
  let weightDuration = hasArtist ? 0.15 : 0.25;
  if (dScore === null) {
    const total = weightTitle + weightArtist;
    weightTitle /= total;
    weightArtist /= total;
    weightDuration = 0;
  } else if (live) {
    // 现场版时长天然和录音室版不同：把时长权重让给标题/歌手。
    const shift = weightDuration * 0.5;
    weightDuration -= shift;
    weightTitle += shift * 0.6;
    weightArtist += shift * 0.4;
  }
  let score = weightTitle * titleScore + weightArtist * artistScore + weightDuration * (dScore ?? 0);
  if (normalizeText(localTitle) === normalizeText(candidate.title)) score += 0.06;
  if (hasArtist && normalizeText(track.artist) === normalizeText(candidate.artist)) score += 0.04;
  if (albumScore !== null && albumScore >= 0.55) score += 0.04 * albumScore;
  score -= versionPenalty(track, candidate);
  if (live) {
    const candidateLive = hasLiveMark(versionMarks(candidate.title, candidate.album));
    // 现场版本：现场候选明确加分；录音室候选压到自动线以下（时长/多源都不能反超）。
    score += candidateLive ? 0.1 : -0.15;
  }
  score += SOURCE_TRUST[candidate.source] ?? 0;
  const agreement = Array.isArray(candidate.sources) ? candidate.sources.length : 1;
  if (agreement > 1) score += 0.05 * Math.min(3, agreement - 1);
  // 曲库自己的排序也是信号：同一源里排第一的候选小幅加分。
  const rank = Number.isFinite(candidate.rank) ? candidate.rank : 0;
  score += Math.max(0, 0.03 - rank * 0.01);
  return Math.max(0, Math.min(1, score));
}

/**
 * 是否允许批量自动写文件：
 *  - 总分必须够；
 *  - 时长接近（<=10s）直接放行；
 *  - 时长差得远时，只有“标题强匹配 + 本地有歌手且歌手也强匹配”才放行：
 *    那种情况基本是同一首歌的不同版本（现场/加长/母带差），而用户要修的是
 *    名字，不该被挡。歌手未知（裸文件名）时证据只剩标题 —— 实测会挑中
 *    lullaby 翻唱版，因此宁可不写，留给用户手动确认。
 */
function isAutoApplicable(score, track, candidate) {
  if (score < MATCH_AUTO_SCORE) return false;
  const dScore = durationScore(track.duration, candidate.duration);
  if (dScore === null || dScore >= 0.55) return true;
  const artistKnown = typeof track.artist === 'string' && track.artist.trim().length > 0;
  if (!artistKnown) return false;
  const titleStrong = Math.max(
    similarity(track.title, candidate.title),
    similarity(stripTrackNumber(track.title), candidate.title),
  ) >= 0.9;
  const artistStrong = similarity(track.artist, candidate.artist) >= 0.8;
  return titleStrong && artistStrong;
}

function rankCandidates(track, merged) {
  const ranked: RankedCandidate[] = [];
  for (const candidate of merged.values()) {
    const score = scoreCandidate(track, candidate);
    ranked.push({ ...candidate, score: Math.round(score * 1000) / 1000, auto: isAutoApplicable(score, track, candidate) });
  }
  ranked.sort((left, right) => right.score - left.score
    || (right.sources?.length ?? 1) - (left.sources?.length ?? 1)
    || String(left.title).localeCompare(String(right.title), 'zh-Hans-CN'));
  return ranked;
}

// ── 查询词构造 ──────────────────────────────────────────────────────────────

/**
 * 曲目序号前缀：只认「01 / [01] / 1. / 1-」这类明确写法，
 * 避免把「21 Guns」「7 Years」误伤成「Guns」「Years」。
 */
const TRACK_NUMBER_PREFIX = /^\s*(?:0\d{1,2}[\s._\-]+|[([（【]?\s*\d{1,3}\s*[)\]）】\-_.、．。]\s*)/;

function stripTrackNumber(value) {
  return String(value ?? '').replace(TRACK_NUMBER_PREFIX, '').trim();
}

/** 从文件名拆出「歌手 / 歌名」：标签缺失或写错时的救命信息。 */
function parseFileStem(track) {
  const stem = stripTrackNumber(String(track.name ?? '').replace(/\.[^.]+$/, ''));
  for (const separator of [' - ', ' – ', ' — ', '_', '－']) {
    const at = stem.indexOf(separator);
    if (at > 0) {
      const title = stem.slice(at + separator.length).trim();
      if (title.length > 0) return { artist: stem.slice(0, at).trim(), title };
    }
  }
  return { artist: '', title: stem };
}

/**
 * 生成 1-3 个递降精度的查询词：标签「歌名+歌手」优先，其次裸歌名，
 * 最后用文件名拆出的另一组信息（标签写错时特别有用）。
 */
/** 版本标记集合：标题 + 专辑一起看（Live 往往只写在专辑名上）。 */
function versionMarks(...values) {
  const marks = new Set<string>();
  for (const value of values) {
    const text = String(value ?? '').toLowerCase();
    for (const hit of text.match(VERSION_MARKERS) ?? []) marks.add(hit);
  }
  return marks;
}

const LIVE_MARKS = ['live', '现场', '演唱会'];

function hasLiveMark(marks) {
  return LIVE_MARKS.some((mark) => marks.has(mark));
}

/** 本地曲目是不是现场版（含专辑线索）。 */
function versionIsLive(track) {
  return hasLiveMark(versionMarks(stripTrackNumber(track.title), track.album));
}

function buildMatchQueries(track) {
  const parsed = parseFileStem(track);
  // 标签里的标题同样可能带「01. 」序号；不清掉会直接毁掉搜索质量。
  const taggedTitle = stripTrackNumber(track.title);
  const taggedArtist = typeof track.artist === 'string' ? track.artist.trim() : '';
  const title = taggedTitle.length > 0 ? taggedTitle : parsed.title;
  const artist = taggedArtist.length > 0 ? taggedArtist : parsed.artist;
  const queries: string[] = [];
  const push = (value) => {
    const query = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (query.length >= 2 && !queries.includes(query)) queries.push(query);
  };
  const album = typeof track.album === 'string' ? stripTrackNumber(track.album) : '';
  const coreTitle = coreText(title) || normalizeText(title);
  const coreArtist = coreText(artist) || normalizeText(artist);
  const live = hasLiveMark(versionMarks(title, album));
  // 1) 原始标题（保留 Live/现场/Remaster 等标记）：Live 版本靠它才能被搜到。
  if (title.length > 0) push(coreArtist.length > 0 ? title + ' ' + coreArtist : title);
  // 2) 去标记的基础标题 + 歌手（普通歌曲的主查询）。
  if (coreTitle.length > 0 && coreArtist.length > 0) push(coreTitle + ' ' + coreArtist);
  // 3) 现场版再补 live 关键词：不少源把现场专辑命名成 “Song live”。
  if (live && coreTitle.length > 0) push(coreTitle + (coreArtist.length > 0 ? ' ' + coreArtist : '') + ' live');
  // 4) 专辑 + 歌手：现场专辑/冷门版本的封面几乎只在这里出现。
  if (album.length > 0) push(coreArtist.length > 0 ? album + ' ' + coreArtist : album);
  // 5) 基础标题兜底。
  if (coreTitle.length > 0) push(coreTitle);
  const fileTitle = coreText(parsed.title) || normalizeText(parsed.title);
  const fileArtist = coreText(parsed.artist) || normalizeText(parsed.artist);
  if (fileTitle.length > 0 && fileTitle !== coreTitle && !coreTitle.includes(fileTitle)) {
    push(fileArtist.length > 0 ? fileTitle + ' ' + fileArtist : fileTitle);
  }
  return queries.slice(0, 5);
}

// ── 数据源 ──────────────────────────────────────────────────────────────────

async function fetchJson(url, options, timeoutMs = SOURCE_TIMEOUT_MS) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

function normalizeItunes(item, rank) {
  if (item === null || typeof item !== 'object') return null;
  const title = typeof item.trackName === 'string' ? item.trackName.trim() : '';
  const artist = typeof item.artistName === 'string' ? item.artistName.trim() : '';
  if (title.length === 0 && artist.length === 0) return null;
  const rawCover = typeof item.artworkUrl100 === 'string' ? item.artworkUrl100.trim() : '';
  return {
    source: 'itunes',
    rank: Number.isFinite(rank) ? rank : 0,
    id: item.trackId !== undefined ? String(item.trackId) : '',
    title,
    artist,
    album: typeof item.collectionName === 'string' ? item.collectionName.trim() : '',
    cover: rawCover.length > 0 ? rawCover.replace(ARTWORK_SIZE_PATTERN, '/600x600bb.$1') : '',
    duration: Number.isFinite(item.trackTimeMillis) && item.trackTimeMillis > 0 ? Math.round(item.trackTimeMillis / 1000) : null,
  };
}

function normalizeQq(item, rank) {
  if (item === null || typeof item !== 'object') return null;
  const title = typeof item.songname === 'string' ? item.songname.trim() : '';
  const artist = Array.isArray(item.singer)
    ? item.singer.map((singer) => (typeof singer?.name === 'string' ? singer.name.trim() : '')).filter(Boolean).join(' / ')
    : '';
  if (title.length === 0 && artist.length === 0) return null;
  const albumMid = typeof item.albummid === 'string' ? item.albummid.trim() : '';
  return {
    source: 'qq',
    rank: Number.isFinite(rank) ? rank : 0,
    id: typeof item.songmid === 'string' ? item.songmid : '',
    title,
    artist,
    album: typeof item.albumname === 'string' ? item.albumname.trim() : '',
    // QQ 支持 R300/R500/R800 三档；补缺封面取 500px（实测 ~80KB）。
    cover: albumMid.length > 0 ? 'https://y.gtimg.cn/music/photo_new/T002R500x500M000' + albumMid + '.jpg' : '',
    duration: Number.isFinite(item.interval) && item.interval > 0 ? Math.round(item.interval) : null,
  };
}

function normalizeNetease(item, rank) {
  if (item === null || typeof item !== 'object') return null;
  const title = typeof item.name === 'string' ? item.name.trim() : '';
  const artist = Array.isArray(item.ar)
    ? item.ar.map((singer) => (typeof singer?.name === 'string' ? singer.name.trim() : '')).filter(Boolean).join(' / ')
    : '';
  if (title.length === 0 && artist.length === 0) return null;
  let cover = typeof item.al?.picUrl === 'string' ? item.al.picUrl.trim() : '';
  if (cover.startsWith('http://')) cover = 'https://' + cover.slice(7);
  return {
    source: 'netease',
    rank: Number.isFinite(rank) ? rank : 0,
    id: item.id !== undefined ? String(item.id) : '',
    title,
    artist,
    album: typeof item.al?.name === 'string' ? item.al.name.trim() : '',
    cover,
    duration: Number.isFinite(item.dt) && item.dt > 0 ? Math.round(item.dt / 1000) : null,
  };
}

function normalizeMusicBrainz(item, rank) {
  if (item === null || typeof item !== 'object') return null;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const artist = Array.isArray(item['artist-credit'])
    ? item['artist-credit'].map((credit) => (typeof credit?.name === 'string' ? credit.name.trim() : '')).filter(Boolean).join(' / ')
    : '';
  if (title.length === 0 && artist.length === 0) return null;
  const release = Array.isArray(item.releases) ? item.releases[0] : undefined;
  const releaseId = release !== undefined && typeof release.id === 'string' ? release.id : '';
  return {
    source: 'musicbrainz',
    rank: Number.isFinite(rank) ? rank : 0,
    id: typeof item.id === 'string' ? item.id : '',
    title,
    artist,
    album: release !== undefined && typeof release.title === 'string' ? release.title.trim() : '',
    cover: releaseId.length > 0 ? 'https://coverartarchive.org/release/' + releaseId + '/front-1200' : '',
    duration: Number.isFinite(item.length) && item.length > 0 ? Math.round(item.length / 1000) : null,
  };
}

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
};

function itunesCountry() {
  return typeof process.env.DSH_MUSIC_ITUNES_COUNTRY === 'string'
    && /^[A-Za-z]{2}$/.test(process.env.DSH_MUSIC_ITUNES_COUNTRY)
    ? process.env.DSH_MUSIC_ITUNES_COUNTRY.toUpperCase()
    : 'TW';
}

async function itunesSearch(term, entity, country) {
  const endpoint = new URL('https://itunes.apple.com/search');
  endpoint.searchParams.set('term', term);
  endpoint.searchParams.set('media', 'music');
  endpoint.searchParams.set('entity', entity);
  endpoint.searchParams.set('limit', String(MATCH_LIMIT));
  endpoint.searchParams.set('country', country);
  const payload = await fetchJson(endpoint, { headers: { accept: 'application/json' } });
  return Array.isArray(payload?.results) ? payload.results : [];
}

/** 主区域搜不到时回落 US：现场专辑/冷门版本的地区库差异很大。 */
async function itunesSearchWithRegion(term, entity) {
  const primary = itunesCountry();
  const results = await itunesSearch(term, entity, primary);
  if (results.length > 0 || primary === 'US') return results;
  return itunesSearch(term, entity, 'US');
}

async function searchItunesSource(term) {
  const results = await itunesSearchWithRegion(term, 'song');
  return results.map((item, index) => normalizeItunes(item, index)).filter((item) => item !== null);
}

function normalizeItunesAlbum(item, rank) {
  if (item === null || typeof item !== 'object') return null;
  const album = typeof item.collectionName === 'string' ? item.collectionName.trim() : '';
  const artist = typeof item.artistName === 'string' ? item.artistName.trim() : '';
  if (album.length === 0) return null;
  const rawCover = typeof item.artworkUrl100 === 'string' ? item.artworkUrl100.trim() : '';
  return {
    source: 'itunes',
    rank: Number.isFinite(rank) ? rank : 0,
    id: item.collectionId !== undefined ? String(item.collectionId) : '',
    title: album,
    artist,
    album,
    cover: rawCover.length > 0 ? rawCover.replace(ARTWORK_SIZE_PATTERN, '/600x600bb.$1') : '',
    duration: null,
    sources: [] as string[],
  };
}

async function searchItunesAlbums(term) {
  const results = await itunesSearchWithRegion(term, 'album');
  return results.map((item, index) => normalizeItunesAlbum(item, index)).filter((item) => item !== null);
}

async function searchQqSource(term) {
  const endpoint = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp');
  endpoint.searchParams.set('w', term);
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('n', String(MATCH_LIMIT));
  endpoint.searchParams.set('p', '1');
  const payload = await fetchJson(endpoint, { headers: { ...BROWSER_HEADERS, referer: 'https://y.qq.com/' } });
  const list = payload?.data?.song?.list;
  if (!Array.isArray(list)) return [];
  return list.map((item, index) => normalizeQq(item, index)).filter((item) => item !== null);
}

async function searchNeteaseSource(term) {
  const payload = await fetchJson('https://music.163.com/api/cloudsearch/pc', {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, referer: 'https://music.163.com/', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ s: term, type: '1', limit: String(MATCH_LIMIT), offset: '0' }),
  });
  const list = payload?.result?.songs;
  if (!Array.isArray(list)) return [];
  return list.map((item, index) => normalizeNetease(item, index)).filter((item) => item !== null);
}

/** MusicBrainz 全局限速 1 req/s：调用被排队，互不插队。 */
function searchMusicBrainzSource(term) {
  const run = musicBrainzQueue.then(async () => {
    const wait = Math.max(0, musicBrainzReadyAt - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    musicBrainzReadyAt = Date.now() + MUSICBRAINZ_INTERVAL_MS;
    const endpoint = new URL('https://musicbrainz.org/ws/2/recording');
    endpoint.searchParams.set('query', term);
    endpoint.searchParams.set('limit', String(MATCH_LIMIT));
    endpoint.searchParams.set('fmt', 'json');
    const payload = await fetchJson(endpoint, {
      headers: {
        accept: 'application/json',
        'user-agent': 'dsh-music-player/0.5 (+https://github.com/heshuren371/dsh-music-player)',
      },
    }, MUSICBRAINZ_TIMEOUT_MS);
    const list = Array.isArray(payload?.recordings) ? payload.recordings : [];
    return list.map((item, index) => normalizeMusicBrainz(item, index)).filter((item) => item !== null);
  });
  musicBrainzQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** 主力三源并行；MusicBrainz 只在主力置信不足时兜底。 */
const MATCH_SOURCES = [
  { name: 'qq', search: searchQqSource },
  { name: 'itunes', search: searchItunesSource },
  { name: 'netease', search: searchNeteaseSource },
];
const FALLBACK_SOURCE = { name: 'musicbrainz', search: searchMusicBrainzSource };

async function searchSource(source, term) {
  const key = source.name + '|' + normalizeText(term);
  const cached = sourceCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < MATCH_CACHE_TTL_MS) return cached.candidates;
  try {
    const candidates = await source.search(term);
    recordSourceResult(source.name, true);
    if (sourceCache.size >= MATCH_CACHE_LIMIT && !sourceCache.has(key)) {
      sourceCache.delete(sourceCache.keys().next().value);
    }
    sourceCache.set(key, { at: Date.now(), candidates });
    return candidates;
  } catch (error) {
    recordSourceResult(source.name, false);
    throw error;
  }
}

/**
 * 同一首歌在不同源会重复：标题一致 + 歌手相似（>=0.5，容忍简繁/别名差异）
 * 的候选合并为一组，并记录来源数——这就是“多源互相印证”的依据。
 */
function mergeCandidate(merged, candidate) {
  const titleKey = normalizeText(candidate.title);
  const artistKey = normalizeText(candidate.artist);
  for (const existing of merged.values()) {
    if (normalizeText(existing.title) !== titleKey) continue;
    const existingArtist = normalizeText(existing.artist);
    if (artistKey.length > 0 && existingArtist.length > 0 && similarity(artistKey, existingArtist) < 0.5) continue;
    if (!existing.sources.includes(candidate.source)) existing.sources.push(candidate.source);
    if (Number.isFinite(candidate.rank) && candidate.rank < (existing.rank ?? Infinity)) existing.rank = candidate.rank;
    if (!existing.cover && candidate.cover) existing.cover = candidate.cover;
    if (existing.duration === null && candidate.duration !== null) existing.duration = candidate.duration;
    if (!existing.album && candidate.album) existing.album = candidate.album;
    return;
  }
  merged.set(titleKey + '|' + artistKey + '|' + merged.size, { ...candidate, sources: [candidate.source] });
}

/** 找封面的查询词：优先专辑，其次歌名；Live 版本靠专辑名才能命中封面。 */
function coverQueryTerm(track) {
  const artist = typeof track.artist === 'string' ? track.artist.trim() : '';
  const album = typeof track.album === 'string' ? stripTrackNumber(track.album) : '';
  if (album.length > 0) return artist.length > 0 ? artist + ' ' + album : album;
  const title = coreText(stripTrackNumber(track.title)) || normalizeText(track.title);
  if (title.length > 0) return artist.length > 0 ? artist + ' ' + title : title;
  return String(track.name ?? '').replace(/\.[^.]+$/, '');
}

/**
 * 歌曲搜索没给封面时补一次专辑封面：
 *  - 有最佳候选：把封面挂到同标题/同歌手的候选上（不新增噪声条目）；
 *  - 一个候选都没有：补一条“仅封面”候选（标题/歌手沿用本地，不会改坏标签）。
 */
async function attachAlbumCover(track, merged, errors) {
  const ranked = rankCandidates(track, merged);
  if (ranked.length > 0 && ranked[0].cover.length > 0) return;
  const term = coverQueryTerm(track);
  if (term.length < 2) return;
  try {
    const albums = await searchItunesAlbums(term);
    if (albums.length === 0) return;
    const artist = typeof track.artist === 'string' ? track.artist.trim() : '';
    const localAlbum = typeof track.album === 'string' ? stripTrackNumber(track.album) : '';
    const pick = albums.find((album) => {
      if (album.cover.length === 0) return false;
      const artistOk = artist.length === 0 || similarity(artist, album.artist) >= 0.5;
      const albumOk = localAlbum.length === 0 || similarity(localAlbum, album.album) >= 0.5;
      return artistOk && albumOk;
    }) ?? albums.find((album) => album.cover.length > 0);
    if (pick === undefined) return;
    if (ranked.length > 0) {
      const top = ranked[0];
      for (const candidate of merged.values()) {
        if (normalizeText(candidate.title) === normalizeText(top.title)
          && normalizeText(candidate.artist) === normalizeText(top.artist)) candidate.cover = pick.cover;
      }
      return;
    }
    merged.set('cover-only', {
      source: 'itunes',
      rank: 0,
      id: '',
      title: stripTrackNumber(track.title) || String(track.name ?? ''),
      artist,
      album: pick.album.length > 0 ? pick.album : localAlbum,
      cover: pick.cover,
      duration: Number.isFinite(track.duration) ? track.duration : null,
      sources: ['itunes'],
      coverOnly: true,
    });
  } catch (error) {
    errors.push('album-cover: ' + String(thrownMessage(error) ?? error));
  }
}

/**
 * 多源匹配：主力并行 + 逐级放宽查询；主力仍不够置信才动用 MusicBrainz。
 * 返回按分数排序的候选（含 score / auto / sources），调用方决定是否写文件。
 */
async function matchTrack(track, queries) {
  const merged = new Map();
  const errors: string[] = [];
  // 冷却中的源跳过；但若三个主力全部冷却，仍然照常尝试，避免瞬时故障
  // 被放大成“永久停摆”。
  const healthy = MATCH_SOURCES.filter((source) => !isSourceCoolingDown(source.name));
  const primaries = healthy.length > 0 ? healthy : MATCH_SOURCES;
  for (const query of queries) {
    const results = await Promise.allSettled(primaries.map((source) => searchSource(source, query)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        errors.push(primaries[index].name + ': ' + (result.reason?.message ?? String(result.reason)));
      } else {
        for (const candidate of result.value) mergeCandidate(merged, candidate);
      }
    });
    const current = rankCandidates(track, merged)[0];
    if (current !== undefined && current.score >= MATCH_AUTO_SCORE) break;
  }
  let best = rankCandidates(track, merged)[0];
  if ((best === undefined || best.score < MATCH_AUTO_SCORE) && !isSourceCoolingDown(FALLBACK_SOURCE.name)) {
    for (const query of queries.slice(0, 2)) {
      try {
        const candidates = await searchSource(FALLBACK_SOURCE, query);
        for (const candidate of candidates) mergeCandidate(merged, candidate);
      } catch (error) {
        errors.push('musicbrainz: ' + String(thrownMessage(error) ?? error));
      }
      best = rankCandidates(track, merged)[0];
      if (best !== undefined && best.score >= MATCH_AUTO_SCORE) break;
    }
  }
  await attachAlbumCover(track, merged, errors);
  return { candidates: rankCandidates(track, merged), errors };
}

function validateArtworkUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw statusError(400, 'artwork url is required');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw statusError(400, 'invalid artwork url');
  }
  if (parsed.protocol !== 'https:') throw statusError(403, 'artwork url must be https');
  if (!isAllowedArtHost(parsed.hostname)) throw statusError(403, 'artwork host is not allowed');
  return parsed.toString();
}

/** 手动跟随跳转并逐跳校验主机，杜绝用 302 把代理变成任意 URL 跳板。 */
async function fetchArtworkResponse(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    let response;
    try {
      response = await fetch(current, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS), redirect: 'manual' });
    } catch {
      throw statusError(502, '封面下载失败（网络超时或被拒绝）');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (typeof location !== 'string' || location.length === 0) throw statusError(502, '封面重定向缺少目标地址');
      current = validateArtworkUrl(new URL(location, current).toString());
      continue;
    }
    return response;
  }
  throw statusError(502, '封面重定向次数过多');
}

async function fetchArtwork(rawUrl) {
  const url = validateArtworkUrl(rawUrl);
  const cached = artCache.get(url);
  if (cached !== undefined) return cached;
  const response = await fetchArtworkResponse(url);
  if (!response.ok) throw statusError(502, '封面下载失败：HTTP ' + response.status);
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!COVER_MIME_ALLOWLIST.has(mime)) throw statusError(502, '封面格式不受支持');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > COVER_MAX_BYTES) throw statusError(502, '封面文件过大');
  let data;
  try {
    data = Buffer.from(await response.arrayBuffer());
  } catch {
    throw statusError(502, '封面读取失败');
  }
  if (data.length === 0 || data.length > COVER_MAX_BYTES) throw statusError(502, '封面文件大小异常');
  const art = { data, mime };
  cacheArtwork(url, art);
  return art;
}

/**
 * 状态文件放在用户数据区（$DSH_HOME/storages/，与 DSH 生态的 workspace.json 等同级），
 * 不写包内目录——包安装位置可能只读，且卸载/升级不应清掉用户状态。
 * 兼容：旧版本写在包内 lib/state.json，首次启动时自动迁移。
 */
import os from 'node:os';

const DSH_HOME = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh');
const STATE_DIR = path.join(DSH_HOME, 'storages');
const STATE_FILE = path.join(STATE_DIR, 'dsh-music-player.json');
/**
 * ReplayGain **测量结果**的缓存（与状态分文件：它是可重建的派生数据，丢了只是要重测）。
 * 刻意**不写进音频文件** —— 改用户的文件是不可逆副作用，见 AGENTS.md §2.20。
 */
const RG_STATE_FILE = path.join(STATE_DIR, 'dsh-music-player-rg.json');
/** 波形缓存与 RG 测量缓存分开：一个可重建的展示数据，不该和响度数据混在一个文件里。 */
const WAVEFORM_STATE_FILE = path.join(STATE_DIR, 'dsh-music-player-waveform.json');
/**
 * 波形参数：解码成 8kHz 单声道后**流式**聚合，每 0.5s 取一个峰值 —— 内存与曲长无关
 * （绝不缓冲整段 PCM：一小时 8kHz 单声道是 56MB）。0.5s 的桶足够 400 根柱子的分辨率。
 */
const WAVEFORM_DECODE_RATE = 8000;
const WAVEFORM_SAMPLES_PER_BUCKET = 2000;
/** 桶数上限（4000 × 0.5s = 33 分钟）；超长曲目只保留前半，**有界**优先于完整。 */
const WAVEFORM_BUCKET_CAP = 4000;
/** 下发分辨率：缓存与 UI 宽度解耦，客户端再按需要抽样到 ~120 根。 */
const WAVEFORM_BUCKETS = 400;
const WAVEFORM_TIMEOUT_MS = 60 * 1000;
/** 同时最多几个波形 ffmpeg：超过就**立即拒绝**（`reason: busy`），不排队、不阻塞。 */
const WAVEFORM_MAX_CONCURRENT = 2;
/** 进程内条目上限与落盘条目上限（§2.2：module 级容器必须设上限）。 */
const WAVEFORM_CACHE_MAX = 512;
const WAVEFORM_CACHE_PERSIST_MAX = 200;
const LEGACY_STATE_FILE = fileURLToPath(new URL('./state.json', import.meta.url));

// ── B 站扫码登录 ────────────────────────────────────────────────────────────
// 只使用官方 QR 登录端点；cookie 写进 $DSH_HOME/storages 下的 0600 文件，
// 不返回给页面、不写日志。它只用于用户自己的 B 站账号能访问的清晰度，
// 不处理密码、短信、会员/DRM 绕过。
const BILI_QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const BILI_QR_POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const BILI_NAV = 'https://api.bilibili.com/x/web-interface/nav';
const BILI_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
  accept: 'application/json, text/plain, */*',
};

interface BiliCookie {
  name: string;
  value: string;
  domain: string;
  expires: number;
}

function biliCookieFile() {
  return path.join(STATE_DIR, 'dsh-music-bilibili.cookies');
}

function isBilibiliUrl(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com');
  } catch {
    return false;
  }
}

/** 从 Set-Cookie 头里提取登录 cookie；只保留 bilibili.com 域。 */
export function parseBiliSetCookie(headers: string[]): BiliCookie[] {
  const out = new Map<string, BiliCookie>();
  for (const raw of headers) {
    const first = String(raw).split(';')[0];
    const at = first.indexOf('=');
    if (at <= 0) continue;
    const name = first.slice(0, at).trim();
    const value = first.slice(at + 1).trim();
    if (name.length === 0) continue;
    const domainMatch = /(?:^|;)\s*domain=([^;]+)/iu.exec(String(raw));
    const rawDomain = (domainMatch?.[1] ?? 'bilibili.com').trim().toLowerCase();
    if (rawDomain !== 'bilibili.com' && !rawDomain.endsWith('.bilibili.com')) continue;
    const domain = rawDomain.startsWith('.') ? rawDomain : '.' + rawDomain;
    let expires = 0;
    const expiresMatch = /(?:^|;)\s*expires=([^;]+)/iu.exec(String(raw));
    if (expiresMatch !== null) {
      const atDate = Date.parse(expiresMatch[1]);
      if (Number.isFinite(atDate)) expires = Math.floor(atDate / 1000);
    }
    const maxAge = /(?:^|;)\s*max-age=(\d+)/iu.exec(String(raw));
    if (maxAge !== null) expires = Math.floor(Date.now() / 1000) + Number(maxAge[1]);
    out.set(name, { name, value, domain, expires });
  }
  return [...out.values()];
}

/** 生成 yt-dlp 能读的 Netscape cookie 文件内容。 */
export function biliCookieFileContent(cookies: BiliCookie[]): string {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Generated by dsh-music-player; keep this file private.',
  ];
  for (const cookie of cookies) {
    lines.push([cookie.domain, 'TRUE', '/', 'TRUE', String(cookie.expires || 0), cookie.name, cookie.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** 从 Netscape 文件里还原 Cookie 请求头（只给宿主内部校验用）。 */
export function biliCookieHeader(fileText: string): string {
  const pairs: string[] = [];
  for (const line of String(fileText).split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const name = parts[5].trim();
    const value = parts.slice(6).join('\t').trim();
    if (name.length > 0) pairs.push(name + '=' + value);
  }
  return pairs.join('; ');
}

/** 把二维码内容画成 SVG data URL（不把登录 URL 交给第三方图床）。 */
export function biliQrDataUrl(payload: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

/** 从 yt-dlp 的 formats 归纳「每个高度最好的一条」，用于清晰度下拉。 */
export function importFormatHeights(value: unknown): ImportFormat[] {
  const formats = value !== null && typeof value === 'object' && Array.isArray((value as { formats?: unknown }).formats)
    ? (value as { formats: unknown[] }).formats : [];
  const byHeight = new Map<number, ImportFormat & { score: number }>();
  for (const rawItem of formats) {
    if (rawItem === null || typeof rawItem !== 'object') continue;
    const item = rawItem as Record<string, unknown>;
    if (item.vcodec === 'none') continue;
    const height = Number(item.height);
    if (!Number.isFinite(height) || height < 144) continue;
    const ext = typeof item.ext === 'string' ? item.ext : '';
    const fps = Number(item.fps);
    const tbr = Number(item.tbr);
    const rawSize = Number(item.filesize ?? item.filesize_approx);
    const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : null;
    const score = (Number.isFinite(tbr) ? tbr : 0) * 1000 + (Number.isFinite(fps) ? fps : 0) + (ext === 'mp4' ? 1 : 0);
    const candidate = {
      height: Math.round(height),
      fps: Number.isFinite(fps) ? fps : null,
      ext,
      filesize: size,
      note: typeof item.format_note === 'string' ? item.format_note.slice(0, 40) : '',
      score,
    };
    const previous = byHeight.get(candidate.height);
    if (previous === undefined || candidate.score > previous.score) byHeight.set(candidate.height, candidate);
  }
  return [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .slice(0, 12)
    .map(({ score: _score, ...rest }) => rest);
}

/** 推荐默认清晰度：有 1080 选 1080，否则不高于 1080 的最高，再否则最高。 */
export function recommendedImportHeight(heights: ImportFormat[]): number | null {
  if (heights.length === 0) return null;
  if (heights.some((item) => item.height === 1080)) return 1080;
  const under = heights.find((item) => item.height <= 1080);
  return (under ?? heights[0]).height;
}


function statusError(statusCode: number, message: string): StatusError {
  return Object.assign(new Error(message), { statusCode });
}

/** WHATWG hostname (IPv6 keeps brackets) names the loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Browser requests must not drive the local API from another site. Two
 * confused-deputy paths a browser opens against a loopback HTTP API:
 *  - cross-site "simple" POSTs (no preflight): any page the user visits could
 *    repoint the music directory or delete a file;
 *  - DNS rebinding: the attacker's domain resolves to 127.0.0.1, so Host names
 *    their domain while the socket lands here and their page can read answers.
 * The Web app only binds loopback (dsh web refuses 0.0.0.0), so a loopback
 * Host plus same-origin markers is the exact shape of legitimate traffic.
 * Non-browser clients (no Origin / no Sec-Fetch-* headers, e.g. tests or curl)
 * pass as long as Host is loopback, matching the platform's /api fence.
 */
/**
 * 回环 authority 字面量（只取端口，主机名写死 127.0.0.1）。
 * 用于拼系统取图/取媒体的绝对基址：**不回显请求 Host 的主机名**（A5-03）。
 */
function loopbackAuthority(req) {
  let port = '';
  const host = req.headers?.host;
  if (typeof host === 'string' && host.length > 0) {
    const matched = /:(\d+)$/.exec(host);
    if (matched !== null) port = ':' + matched[1];
  }
  if (port === '' && typeof req.socket?.localPort === 'number') port = ':' + req.socket.localPort;
  return '127.0.0.1' + port;
}

/**
 * 该请求的 Host 是否是回环字面量。system-* 端点用它替代完整栅栏：这些端点
 * 必须豁免 Origin / Sec-Fetch 判定（Chromium 内部发起，带 `Origin: dsh-app://app`），
 * 但**不能豁免「来自回环」** —— 否则宿主绑非回环（trustedHosts LAN 服务）时，
 * 这个拿 URL 里 token 当凭证的读端点就暴露给网络了（A5-03）。
 */
function isLoopbackHostRequest(req) {
  const host = req.headers?.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  try {
    return isLoopbackHostname(new URL('http://' + host).hostname);
  } catch {
    return false;
  }
}

/**
 * 受保护操作在**产生副作用的位置**的授权判定（`permission.zh.md:86`）。
 *
 * 为什么不能只靠上游：栅栏与「库成员」校验发生在路由入口，而真正的
 * `fs.unlink` / `fs.rename` 在几十行之后；上游某次改动放宽了判定，副作用位置
 * 不会知道。这里把「目标路径必须落在已声明的 scope 内」钉在 syscall 旁边。
 *
 * ⚠️ 这是**插件自建**的授权面，不是 DSH 的 permission grant —— 产品侧没有向
 * 插件暴露 grant 查询 API（`lib/` 全文无 permission/grant 调用，`A5-04`）。
 * 一旦上游提供标准 grant API，这里应改为查询该 API，而 `dsh-plugin.json` 的
 * `permissions` scope 文本是这份策略的对外声明，两者必须同步。
 */
function authorize(action, targetPath, scopes) {
  const resolved = path.resolve(targetPath);
  for (const root of scopes) {
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved === root || resolved.startsWith(withSep)) return resolved;
  }
  throw statusError(403, 'authorize: ' + action + ' 的目标不在已声明 scope 内');
}

function isUntrustedRequest(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) return true;
  let hostUrl;
  try {
    hostUrl = new URL('http://' + host);
  } catch {
    return true;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return true;

  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site.length > 0) {
    if (site === 'same-origin') return false;
    // "none" = user-typed URL / bookmark: allow read-only navigation, never a
    // state change.
    if (site === 'none') return req.method !== 'GET' && req.method !== 'HEAD';
    return true;
  }
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return false;
  try {
    // Origin "null" (sandboxed iframe, file://) does not parse → blocked.
    return new URL(origin).host !== hostUrl.host;
  } catch {
    return true;
  }
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw statusError(413, 'request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw statusError(400, 'request body must be valid JSON');
  }
}

async function loadState() {
  for (const candidate of [STATE_FILE, LEGACY_STATE_FILE]) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, 'utf8'));
      if (typeof parsed.dir === 'string' && parsed.dir.length > 0) return parsed.dir;
    } catch {
      // 不存在或损坏：尝试下一个候选。
    }
  }
  return null;
}

async function saveState(dir) {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    // tmp + rename 原子替换，进程崩溃不会留下半写的状态文件。
    // 副作用位置授权：状态文件只能落在 STATE_DIR（A5-04 / `storage.local` scope）。
    const tmp = authorize('storage.local.write', path.join(STATE_DIR, '.dsh-music-player.json.tmp'), [STATE_DIR]);
    await fs.writeFile(tmp, JSON.stringify({ dir }, null, 2), 'utf8');
    await fs.rename(tmp, authorize('storage.local.write', STATE_FILE, [STATE_DIR]));
  } catch {
    // State persistence is best-effort; a read-only data dir must not break playback.
  }
}

/** Expand a leading "~" so the UI placeholder ("~/Music") actually works. */
function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

/**
 * Recursively collect audio files under dir (skip hidden entries and tooling
 * dirs). `isCancelled` is polled between directories so a superseded scan
 * (the user switched libraries mid-scan) stops consuming CPU instead of
 * parsing thousands of files whose result would be discarded.
 */
async function collectAudioFiles(dir, isCancelled) {
  const files: ScannedFile[] = [];
  let truncated = false;
  let skippedPackages = 0;
  const stack: ScanFrame[] = [{ directory: dir, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < SCAN_VISIT_LIMIT) {
    if (typeof isCancelled === 'function' && isCancelled()) return { files, truncated: true, skippedPackages };
    if (files.length >= MAX_TRACKS) {
      truncated = true;
      break;
    }
    const current = stack.pop();
    // 循环条件保证栈非空，这里只是把 `pop()` 的 `| undefined` 收窄掉；
    // 真的落到 break 也不改变行为（栈空时本来就没有可访问的目录）。
    if (current === undefined) break;
    visited += 1;
    let rows;
    try {
      rows = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const row of rows) {
      // The cap must hold inside the inner loop too: one directory holding
      // 100k audio files would otherwise blow past MAX_TRACKS in a single
      // readdir() and pin all of them in memory.
      if (files.length >= MAX_TRACKS) {
        truncated = true;
        break;
      }
      if (row.name.startsWith('.')) continue;
      const absolute = path.join(current.directory, row.name);
      if (row.isDirectory()) {
        const lowerName = row.name.toLowerCase();
        if (IGNORED_PACKAGE_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))) {
          skippedPackages += 1;
          continue;
        }
        if (current.depth < MAX_SCAN_DEPTH && !SKIP_DIRS.has(row.name)) {
          stack.push({ directory: absolute, depth: current.depth + 1 });
        }
        continue;
      }
      if (!row.isFile()) continue;
      const ext = path.extname(row.name).toLowerCase();
      const audioMime = AUDIO_EXTENSIONS.get(ext);
      const videoMime = VIDEO_EXTENSIONS.get(ext);
      if (audioMime === undefined && videoMime === undefined) continue;
      files.push({
        path: absolute,
        mime: audioMime ?? videoMime,
        kind: audioMime === undefined ? 'video' : 'audio',
      });
    }
  }
  // 深度优先扫描因访问上限提前退出时（目录栈仍非空），同样要标记截断，
  // 否则 UI 会把它当成一次完整扫描。
  if (!truncated && visited >= SCAN_VISIT_LIMIT && stack.length > 0) {
    truncated = true;
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'zh-Hans-CN', { numeric: true }));
  return { files, truncated, skippedPackages };
}

function fallbackTitle(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  // Common "Artist - Title" file naming: prefer the title half for the name column.
  const dash = base.indexOf(' - ');
  return dash > 0 ? base.slice(dash + 3).trim() || base : base;
}

function fallbackArtist(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const dash = base.indexOf(' - ');
  return dash > 0 ? base.slice(0, dash).trim() || null : null;
}

async function readMetadata(file: ScannedFile): Promise<Track> {
  const track: Track = {
    path: file.path,
    name: path.basename(file.path),
    title: fallbackTitle(file.path),
    artist: fallbackArtist(file.path),
    duration: null,
    addedAt: null,
    mime: file.mime,
    /** 'audio' | 'video'：MV 只有在视频轨上才显示画面。 */
    kind: file.kind === 'video' ? 'video' : 'audio',
    /** 视频编码/音频编码（用于判断能否直接播，见 mvPlan）。 */
    videoCodec: null,
    audioCodec: null,
    /** 画面尺寸，仅用于展示（例如 MV 标识的提示）。 */
    width: null,
    height: null,
    /** 是否已同时具备标题与歌手标签（“一键补全”据此挑选待补全曲目）。 */
    tagged: false,
    /** 库内稳定 id（相对根目录的路径）；scanLibrary 扫描收尾时回填。 */
    id: '',
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
  };
  try {
    const stat = await fs.stat(file.path);
    // 优先创建时间；文件系统没有 birthtime（部分 Linux）时退回 mtime。
    // 写标签会改 mtime，所以 birthtime 更接近「加入库」的时间。
    const addedAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    if (Number.isFinite(addedAt)) track.addedAt = addedAt;
  } catch {
    // stat 失败不影响播放；排序时按缺失处理。
  }
  try {
    const metadata = await parseFile(file.path, { duration: true, skipCovers: true });
    const common = metadata.common;
    const rawTitle = common.title;
    const hasTitle = typeof rawTitle === 'string' && rawTitle.trim().length > 0;
    if (hasTitle) track.title = rawTitle.trim();
    const artist = common.artist ?? (Array.isArray(common.artists) ? common.artists[0] : undefined);
    const hasArtist = typeof artist === 'string' && artist.trim().length > 0;
    if (hasArtist) track.artist = artist.trim();
    track.tagged = hasTitle && hasArtist;
    // ReplayGain：music-metadata 已把 `"-6.50 dB"` 归一化为 {dB, ratio}。
    // **只接受有限数**：标签来自文件，可能是任何字符串（不可信输入）。
    track.rgTrackGainDb = readFiniteDb(common.replaygain_track_gain);
    track.rgAlbumGainDb = readFiniteDb(common.replaygain_album_gain);
    track.rgTrackPeak = readFinitePeak(common.replaygain_track_peak);
    track.rgAlbumPeak = readFinitePeak(common.replaygain_album_peak);
    if (typeof metadata.format.duration === 'number' && Number.isFinite(metadata.format.duration)) {
      track.duration = Math.round(metadata.format.duration * 10) / 10;
    }
    if (track.kind === 'video') {
      // music-metadata 对 mp4/mkv/webm 能给出每个轨的 codecName；avi/ts 会直接抛错，
      // 那种情况编码留空，mvPlan 会按容器保守判定（走转封装）。
      const info = Array.isArray(metadata.format.trackInfo) ? metadata.format.trackInfo : [];
      const names = info.map((entry) => String(entry?.codecName ?? '')).join(' ');
      track.videoCodec = detectCodec(VIDEO_CODEC_PATTERNS, names);
      track.audioCodec = detectCodec(AUDIO_CODEC_PATTERNS, names) ?? readFormatAudioCodec(metadata.format);
      const videoTrack = info.find((entry) => entry?.video !== undefined);
      if (typeof videoTrack?.video?.pixelWidth === 'number') track.width = videoTrack.video.pixelWidth;
      if (typeof videoTrack?.video?.pixelHeight === 'number') track.height = videoTrack.video.pixelHeight;
    }
  } catch {
    // Unparseable/corrupt tags still list and stream; fall back to filename info.
  }
  if (track.kind === 'video') {
    // ffprobe 是权威来源：music-metadata 对某些 MP4 只给编码箱名、对 avi/ts 直接抛错。
    // **放在这个 try 之外**是必须的 —— 否则 avi/ts 恰好在抛错那一步丢掉探测，
    // 只能退回按容器猜（实测踩过：MPEG-4 Part 2 的 MP4 被误判成「可直出」，黑屏只有声音）。
    const probed = videoCodecByFfprobe(file.path);
    if (probed.video !== null) track.videoCodec = probed.video;
    if (probed.audio !== null) track.audioCodec = probed.audio;
  }
  return track;
}

/** ReplayGain 增益：`{dB}` 有限才采用，否则 null（未测量 / 标签损坏）。 */
function readFiniteDb(value: { dB?: number } | undefined): number | null {
  const db = value?.dB;
  return typeof db === 'number' && Number.isFinite(db) ? db : null;
}

/** ReplayGain 峰值：`{ratio}`，必须为正的有限数（0 与负值无意义）。 */
function readFinitePeak(value: { ratio?: number } | undefined): number | null {
  const ratio = value?.ratio;
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/** Characters illegal (or dangerous) in a cross-platform filename. */
const FILENAME_ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
/** Windows 保留设备名：直接作为文件主干会创建失败。 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeFileName(input) {
  let cleaned = String(input)
    .replace(FILENAME_ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120)
    .trim();
  // Windows 不允许名字以点或空格结尾；保留设备名加下划线规避。
  cleaned = cleaned.replace(/[.\s]+$/, '').trim();
  if (WINDOWS_RESERVED_NAME.test(cleaned)) cleaned = '_' + cleaned;
  return cleaned.length > 0 ? cleaned : 'track';
}

/** 目标文件名：优先「歌手 - 原名」，缺项时退回已有信息。 */
function buildFileName(track, meta) {
  const ext = path.extname(track.path);
  const artist = typeof meta.artist === 'string' ? meta.artist.trim() : '';
  const title = typeof meta.title === 'string' ? meta.title.trim() : '';
  const fallback = path.basename(track.path, ext);
  const stem = artist.length > 0 && title.length > 0
    ? artist + ' - ' + title
    : (title.length > 0 ? title : (artist.length > 0 ? artist : fallback));
  return sanitizeFileName(stem) + ext;
}

async function uniqueTargetPath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let counter = 2;
  for (;;) {
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, stem + ' (' + counter + ')' + ext);
    counter += 1;
    if (counter > 9999) throw statusError(409, '无法生成唯一文件名');
  }
}

/**
 * 主线程兜底实现：node-taglib-sharp 的 file.save() 是同步的、要整文件重写，
 * 大 FLAC 上会阻塞事件循环数百毫秒（播放与流媒体一起卡）。正常路径走 worker，
 * 这里只在 worker 无法启动时兜底。
 */
async function writeTagsInProcess(filePath, meta, cover, replaceCover): Promise<TagWriteResult> {
  let file;
  try {
    file = TagFile.createFromPath(filePath);
  } catch {
    return { tagged: false, reason: '不支持写入该格式的标签' };
  }
  try {
    if (typeof meta.title === 'string' && meta.title.length > 0) file.tag.title = meta.title;
    if (typeof meta.artist === 'string' && meta.artist.length > 0) file.tag.performers = [meta.artist];
    if (typeof meta.album === 'string' && meta.album.length > 0) file.tag.album = meta.album;
    // 补全语义：只补空白封面，已有内嵌封面默认绝不覆盖。
    if (cover !== null && cover !== undefined && cover.data.length > 0
      && (file.tag.pictures.length === 0 || replaceCover === true)) {
      file.tag.pictures = [TagPicture.fromData(ByteVector.fromByteArray(cover.data))];
    }
    file.save();
    return { tagged: true };
  } catch (error) {
    return { tagged: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      file.dispose();
    } catch {
      // dispose is best-effort
    }
  }
}

/**
 * 标签写入 worker 化：写标签是「同步 + 整文件重写」，放在主线程会卡住
 * 事件循环。worker 里串行执行（一次只加载一个文件，避免内存翻倍），
 * 主线程只等消息；超时/异常自动终止并退回主线程兜底实现。
 */
const TAG_WORKER_TIMEOUT_MS = 30 * 1000;
let tagWorker: Worker | null = null;
let tagWorkerBroken = false;
let tagJobSeq = 0;
const tagJobs = new Map();

function failAllTagJobs(reason) {
  for (const [id, job] of tagJobs) {
    clearTimeout(job.timer);
    job.resolve({ tagged: false, reason });
    tagJobs.delete(id);
  }
}

function ensureTagWorker() {
  if (tagWorker !== null || tagWorkerBroken) return tagWorker;
  try {
    const worker = new Worker(new URL('./tagwriter.js', import.meta.url));
    worker.on('message', (message) => {
      const job = tagJobs.get(message?.id);
      if (job === undefined) return;
      tagJobs.delete(message.id);
      clearTimeout(job.timer);
      job.resolve({ tagged: message.tagged === true, reason: message.reason });
    });
    worker.on('error', () => {
      tagWorkerBroken = true;
      failAllTagJobs('标签写入线程异常');
    });
    worker.on('exit', () => {
      if (tagJobs.size > 0) {
        tagWorkerBroken = true;
        failAllTagJobs('标签写入线程已退出');
      }
      if (tagWorker === worker) tagWorker = null;
    });
    // 不 hold 事件循环：服务器/测试退出时不被 worker 拖住。
    worker.unref();
    tagWorker = worker;
  } catch {
    tagWorkerBroken = true;
  }
  return tagWorker;
}

function writeTagsInWorker(filePath, meta, cover, replaceCover): Promise<TagWriteResult> {
  const worker = ensureTagWorker();
  if (worker === null) return Promise.resolve({ tagged: false, reason: 'worker unavailable' });
  return new Promise<TagWriteResult>((resolve) => {
    const id = ++tagJobSeq;
    const timer = setTimeout(() => {
      if (!tagJobs.has(id)) return;
      tagJobs.delete(id);
      tagWorkerBroken = true;
      try {
        worker.terminate();
      } catch {
        // terminate is best-effort
      }
      resolve({ tagged: false, reason: '标签写入超时' });
    }, TAG_WORKER_TIMEOUT_MS);
    timer.unref();
    tagJobs.set(id, { resolve, timer });
    worker.postMessage({
      id,
      path: filePath,
      meta,
      cover: cover === null || cover === undefined ? null : cover.data,
      replaceCover: replaceCover === true,
    });
  });
}

/** 原子写入的副本前缀：同目录（同文件系统 ⇒ rename 原子）、点开头（扫描器跳过）。 */
const TAG_TMP_PREFIX = '.dshm-tagwrite-';
/** 崩溃残留的副本超过这个年龄就清理，避免长期占盘。 */
const TAG_TMP_MAX_AGE_MS = 60 * 60 * 1000;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 回读校验：写进去的必须读得回来。任何一项不符就报失败 —— 此时**原件还没被动过**
 * （见 writeTagsAtomic），所以宁可报失败也不能把「写坏了」当成成功。
 */
async function verifyTagsWritten(filePath, meta, expectCover: boolean): Promise<string | null> {
  try {
    const parsed = await parseFile(filePath, { duration: false });
    const common = parsed.common;
    const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    if (meta.title.length > 0 && text(common.title) !== meta.title) return '回读校验失败：标题不一致';
    if (meta.artist.length > 0) {
      const artist = text(common.artist).length > 0
        ? text(common.artist)
        : (Array.isArray(common.artists) ? text(common.artists[0]) : '');
      if (artist !== meta.artist) return '回读校验失败：歌手不一致';
    }
    if (meta.album.length > 0 && text(common.album) !== meta.album) return '回读校验失败：专辑不一致';
    if (expectCover && !(Array.isArray(common.picture) && common.picture.length > 0)) return '回读校验失败：封面未写入';
    return null;
  } catch (error) {
    return '回读校验失败：' + reasonOf(error);
  }
}

/** 清理崩溃残留的写入副本（只碰自己前缀的、超过 1 小时的老文件）。 */
async function sweepTagTemps(dir, scope: string[]): Promise<void> {
  const cutoff = Date.now() - TAG_TMP_MAX_AGE_MS;
  let rows;
  try {
    rows = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const row of rows) {
    if (!row.isFile() || !row.name.startsWith(TAG_TMP_PREFIX)) continue;
    const full = path.join(dir, row.name);
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) await fs.rm(authorize('fs.write', full, scope), { force: true });
    } catch {
      // 与其他清理者竞态：文件已经不在，忽略。
    }
  }
}

/**
 * 原子写标签：**先把原文件复制到同目录的隐藏副本，在副本上写，回读校验通过后再 rename 替换**。
 *
 * node-taglib-sharp 是**就地改写**（`openSync(path, 'r+')` + `writeSync`），写入过程中被杀、
 * 断电、磁盘满都会在原文件上留下半个标签甚至损坏的音频流 —— 而这是本插件唯一会碰用户原始
 * 文件的动作。副本替换把这段风险窗口变成「原件全程不变」：任何一步失败都只丢副本。
 * 失败一律 `tagged:false`（**不得**报告成功），并清掉副本。
 */
async function writeTagsAtomic(filePath, meta, cover, replaceCover, scope: string[]): Promise<TagWriteResult> {
  const dir = path.dirname(filePath);
  await sweepTagTemps(dir, scope);
  const tmpPath = path.join(dir, TAG_TMP_PREFIX + process.pid + '-' + (++tagJobSeq) + path.extname(filePath));
  try {
    await fs.copyFile(authorize('fs.write', filePath, scope), authorize('fs.write', tmpPath, scope));
  } catch (error) {
    return { tagged: false, reason: '无法创建写入副本：' + reasonOf(error) };
  }
  let replaced = false;
  try {
    const written = await writeTags(tmpPath, meta, cover, replaceCover);
    if (!written.tagged) return written;
    const mismatch = await verifyTagsWritten(tmpPath, meta, cover !== null && cover !== undefined);
    if (mismatch !== null) return { tagged: false, reason: mismatch };
    await fs.rename(authorize('fs.write', tmpPath, scope), authorize('fs.write', filePath, scope));
    replaced = true;
    return { tagged: true };
  } catch (error) {
    return { tagged: false, reason: reasonOf(error) };
  } finally {
    if (!replaced) {
      try {
        await fs.rm(authorize('fs.write', tmpPath, scope), { force: true });
      } catch {
        // 副本清理失败不影响判定：原件未动，下一次写入前还会再扫一遍残留。
      }
    }
  }
}

/**
 * 把匹配到的元数据写回音频文件；封面尽力而为，失败只报告、不中断流程。
 * replaceCover 默认 false：已有内嵌封面不会被曲库封面覆盖。
 */
async function writeTags(filePath, meta, cover, replaceCover): Promise<TagWriteResult> {
  if (!tagWorkerBroken) {
    const result = await writeTagsInWorker(filePath, meta, cover, replaceCover);
    if (result.tagged || result.reason !== 'worker unavailable') return result;
  }
  return writeTagsInProcess(filePath, meta, cover, replaceCover);
}

/** 与流式播放同一套越界校验：id 必须命中当前库且解析路径不逃出根目录。 */
function resolveLibraryTrack(lib, idParam) {
  const id = typeof idParam === 'string' ? idParam : '';
  const resolved = path.resolve(lib.dir, id);
  const rootWithSep = lib.dir.endsWith(path.sep) ? lib.dir : lib.dir + path.sep;
  if (id.length === 0 || (resolved !== lib.dir && !resolved.startsWith(rootWithSep))) {
    throw statusError(403, 'path escapes the music directory');
  }
  const track = lib.tracks.find((item) => item.id === id);
  if (track === undefined || path.resolve(track.path) !== resolved) {
    throw statusError(404, 'track not in current library');
  }
  return track;
}

async function mapLimit(items, limit, worker, isCancelled) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (typeof isCancelled === 'function' && isCancelled()) return;
      const current = next;
      next += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

async function scanLibrary(dir, onProgress, isCancelled): Promise<LibraryResult | null> {
  const { files, truncated, skippedPackages } = await collectAudioFiles(dir, isCancelled);
  if (typeof isCancelled === 'function' && isCancelled()) return null;
  let parsed = 0;
  const tracks = await mapLimit(files, METADATA_CONCURRENCY, async (file) => {
    const track = await readMetadata(file);
    parsed += 1;
    if (typeof onProgress === 'function') onProgress(parsed, files.length);
    return track;
  }, isCancelled);
  if (typeof isCancelled === 'function' && isCancelled()) return null;
  for (const track of tracks) {
    // Stable identity: the path relative to the library root. Survives rescans
    // and reordering, unlike an array index.
    track.id = path.relative(dir, track.path).split(path.sep).join('/');
  }
  return { dir, tracks, truncated, skippedPackages, scannedAt: Date.now() };
}

function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  let start;
  let end;
  if (match[1] === '' && match[2] === '') return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
  }
  if (start >= size) return { unsatisfiable: true };
  end = Math.min(end, size - 1);
  return { start, end };
}

/**
 * Pipe one file to the response, tearing the read stream down when the client
 * aborts. Seeking aborts the in-flight range request, and a leaked ReadStream
 * keeps its file descriptor open until GC — hundreds of seeks in one session
 * would otherwise run the host into EMFILE and kill playback.
 */
function pipeFile(res, filePath, options?) {
  const stream = createReadStream(filePath, options);
  // 竞态：res 可能在这之前就已经关闭（请求被 abort，而我们刚 await 过
  // 目录/文件 stat）。此时再挂 'close' 监听永远等不到事件，读流会一直
  // 握着 fd 直到 GC —— 200 次快速 seek 就能把进程推到 EMFILE。
  if (res.destroyed || res.closed || res.writableEnded) {
    stream.destroy();
    return;
  }
  const destroy = () => stream.destroy();
  res.on('close', destroy);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Stream one track of the current library by its stable id (relative path). */
async function streamTrack(library, idParam, req, res) {
  if (library === null) throw statusError(409, '尚未选择音乐目录');
  const id = typeof idParam === 'string' ? idParam : '';
  // The id must resolve to a file inside the library root and be part of the
  // current scan (which already filters to supported audio extensions).
  const resolved = path.resolve(library.dir, id);
  const rootWithSep = library.dir.endsWith(path.sep) ? library.dir : library.dir + path.sep;
  if (id.length === 0 || (resolved !== library.dir && !resolved.startsWith(rootWithSep))) {
    throw statusError(403, 'path escapes the music directory');
  }
  const track = library.tracks.find((item) => item.id === id);
  if (track === undefined || path.resolve(track.path) !== resolved) {
    throw statusError(404, 'track not in current library');
  }
  let stat;
  try {
    stat = await fs.stat(track.path);
  } catch {
    throw statusError(404, '文件不存在：' + track.name);
  }
  if (!stat.isFile()) throw statusError(404, '文件不存在：' + track.name);

  serveFileRange(track.path, track.mime, stat, req, res);
}

/**
 * 按 Range 语义把一个本地文件喂给响应（/stream 与 MV 缓存文件共用）。
 * 支持 206 分段、416 越界、以及完整 200 —— 播放器拖进度全靠它。
 */
/**
 * 媒体响应的 CORS 头 —— 让**桌面版**能把媒体接进 Web Audio。
 *
 * 为什么需要：桌面渲染进程的页面 origin 是 `dsh-app://app`，而媒体在
 * `http://127.0.0.1:<port>`，属**跨源**。Web Audio 的 `createMediaElementSource`
 * 对跨源媒体只有在 CORS 通过时才出声 —— 否则是**静音**（比电流声更糟）。
 * 常驻音频图是消除切歌「电流声」的唯一办法（原因见 client.ts 的 ensureAudioGraph）。
 *
 * 只回显**窄名单**里的 origin：桌面应用 origin 与回环 origin。**刻意不用 `*`** ——
 * token 通道的唯一防线是 token 保密性（AGENTS.md §2.12），`*` 会让任何一个拿到 token
 * 的网页都能跨源读取库内字节。不在名单里就**一个头都不发**，行为与改动前完全一致。
 */
const MEDIA_ALLOWED_ORIGIN = /^(dsh-app:\/\/app|https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?)$/;

function mediaCorsHeaders(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !MEDIA_ALLOWED_ORIGIN.test(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-expose-headers': 'content-length, content-range, accept-ranges',
    vary: 'origin',
  };
}

/** 跨源媒体预检：`Range` 不是 CORS 安全列表头，Chromium 会先发 OPTIONS。 */
function mediaPreflight(req, res) {
  const cors = mediaCorsHeaders(req);
  if (Object.keys(cors).length === 0) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end();
    return;
  }
  res.writeHead(204, {
    ...cors,
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'range',
    'access-control-max-age': '600',
  });
  res.end();
}

function serveFileRange(filePath, mime, stat, req, res) {
  const cors = mediaCorsHeaders(req);
  const range = parseRange(req.headers.range, stat.size);
  if (range !== null && range.unsatisfiable === true) {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}`, ...cors });
    res.end();
    return;
  }
  if (range !== null) {
    res.writeHead(206, {
      'content-type': mime,
      'content-length': range.end - range.start + 1,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      ...cors,
    });
    pipeFile(res, filePath, { start: range.start, end: range.end });
    return;
  }
  res.writeHead(200, {
    'content-type': mime,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    ...cors,
  });
  pipeFile(res, filePath);
}

function createHost(ctx) {
  /**
   * 系统媒体卡片（macOS 状态栏 / 控制中心）取封面专用的能力 token。
   *
   * 为什么需要它：Chromium 内部取 artwork 时会带上发起页的痕迹（实测
   * `Origin: dsh-app://app` 与 `Sec-Fetch-Site: cross-site` 都会被浏览器栅栏
   * 判成 403），而这条取图请求不是页面可控的，没法给它补齐同源头。于是单开一个
   * 端点：随机 token 即能力凭证，只认 token、不再看 Host/Origin——token 只随
   * 鉴权过的 /session 响应发给本页，跨站页面拿不到。
   */
  /**
   * 系统取图 / 取媒体凭证。两条硬约束：
   *
   * ① **按用途分签**：两个独立随机值，各自只能通过自己的端点。曾经两者共用一个
   *    token，等于让「取封面」的凭证同时授权「读库内任意曲目全量字节」——权限面
   *    被放大（AGENTS.md §2.12 第 1 条 / A5-02）。
   *
   * ② **进程级，不是实例级**（这一条修的是一个真实故障）：客户端把 `/session` 给的
   *    `systemStreamBase` 缓存整个页面生命周期，而宿主**每次热重载 `host.js` 都会
   *    `createHost()`**。若 token 随实例重新生成，重载后客户端手里的旧 URL 立刻 403，
   *    表现为「MV 还能播（`/api/mv` 返回相对地址 `/api/dsh-music/mvfile?k=…`，走平台
   *    会话、不经 token）但**音乐不能播**（音频永远走 `system-stream` token 直连）」。
   *    把 token 钉在 process 上，热重载就不再使它失效。
   *
   * 生成源是 `crypto.randomUUID()`，比较用精确等值、不用前缀。
   */
  const systemArtToken = processTokens().art;
  const systemStreamToken = processTokens().stream;
  /** Current music directory (null = not chosen yet); persisted across restarts. */
  let currentDir: string | null = null;
  /** Scanned library cache; invalidated whenever the directory changes. */
  let library: LibraryResult | null = null;
  /** 当前 / 最近一次链接导入任务；同一时间只允许一个在跑。 */
  const importJobs = new Map<string, ImportJob>();
  const importQueue: ImportJob[] = [];
  let importRunning = 0;
  /** yt-dlp 的 --version 结果按二进制路径缓存（轮询端点不能每次起子进程）。 */
  const ytdlpVersionCache = new Map<string, string | null>();
  /** 扫码登录的待确认二维码（key → 创建时间）；只在宿主内存里。 */
  const biliQrPending = new Map<string, number>();
  /** 登录状态缓存，避免弹层每次渲染都打 B 站 nav。 */
  let biliAuthCache: { at: number; value: BiliAuth } | null = null;
  /** 清晰度探测缓存：同一 URL + 登录状态 5 分钟内复用，避免下拉抖动重复解析。 */
  const importProbeCache = new Map<string, { at: number; value: ImportProbe }>();
  let scanning: Promise<LibraryResult | null> | null = null;
  /** Directory the in-flight scan belongs to (scan reuse key). */
  let scanningDir: string | null = null;
  /** Monotonic scan generation: a stale scan finishing late must not clobber a
   *  newer directory's library (setDirectory A slow, then B fast), and a
   *  superseded scan stops parsing files whose result would be discarded. */
  let scanGeneration = 0;
  /** Live scan progress for the UI (reset at every scan start). */
  const scanProgress = { parsed: 0, total: 0 };

  /**
   * ReplayGain 测量缓存与任务状态。
   * 刻意放在 **createHost 内**（不是 module 级）：module 级可变状态在热重载下会被不可回收的
   * ESM 条目永久钉住（§2.2、A1-03），而这里每次热重载重建、随实例丢弃即可。
   */
  let rgEntries: Map<string, RgEntry> | null = null;
  /** 缓存世代：测量写入就 +1，payload 缓存据此失效（否则测完看不到新值）。 */
  let rgGeneration = 0;
  const rgJob = { running: false, done: 0, total: 0, failed: 0, skipped: 0, error: null as string | null, child: null as ChildProcess | null, cancelled: false };

  async function loadRgEntries(): Promise<Map<string, RgEntry>> {
    if (rgEntries !== null) return rgEntries;
    const map = new Map<string, RgEntry>();
    try {
      const raw = JSON.parse(await fs.readFile(RG_STATE_FILE, 'utf8')) as { entries?: Record<string, RgEntry> };
      for (const [id, entry] of Object.entries(raw.entries ?? {})) {
        if (typeof entry?.trackGainDb === 'number' && Number.isFinite(entry.trackGainDb)) map.set(id, entry);
      }
    } catch {
      // 不存在 / 损坏：测量结果可重建，不是错误（离线或首次运行都走这里）。
    }
    rgEntries = map;
    return map;
  }

  async function saveRgEntries(): Promise<void> {
    if (rgEntries === null) return;
    const payload = JSON.stringify({ version: 1, entries: Object.fromEntries(rgEntries) });
    const tmp = RG_STATE_FILE + '.tmp';
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, authorize('storage.local.write', RG_STATE_FILE, [STATE_DIR]));
    } catch {
      // 写失败不致命：内存里的结果本轮照用，下次重测即可（不要让它打断测量）。
    }
  }

  // ── 波形：按需生成 + 缓存（与 RG 测量同一套纪律：只读、可中止、失败可重建） ──────────
  const waveCache = new Map<string, WaveEntry>();
  let waveLoaded = false;
  /** 在飞的 ffmpeg 子进程。teardown 必须全部杀掉，否则热重载后它们会跑到结束（I-06）。 */
  const waveChildren = new Set<ChildProcess>();
  let waveStopped = false;
  let waveSaveTimer: NodeJS.Timeout | null = null;

  function trimWaveCache(): void {
    while (waveCache.size > WAVEFORM_CACHE_MAX) waveCache.delete(waveCache.keys().next().value as string);
  }

  async function loadWaveCache(): Promise<void> {
    if (waveLoaded) return;
    waveLoaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(WAVEFORM_STATE_FILE, 'utf8')) as { entries?: Record<string, WaveEntry> };
      for (const [id, entry] of Object.entries(raw.entries ?? {})) {
        if (Array.isArray(entry?.peaks) && entry.peaks.length > 0 && typeof entry.size === 'number') waveCache.set(id, entry);
      }
      trimWaveCache();
    } catch {
      // 不存在 / 损坏：波形可重建，不是错误（离线或首次运行都走这里）。
    }
  }

  async function saveWaveCache(): Promise<void> {
    const entries: Record<string, WaveEntry> = {};
    let n = 0;
    for (const [id, entry] of waveCache) {
      if (n >= WAVEFORM_CACHE_PERSIST_MAX) break;
      entries[id] = entry;
      n += 1;
    }
    const tmp = WAVEFORM_STATE_FILE + '.tmp';
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify({ version: 1, entries }), 'utf8');
      await fs.rename(tmp, authorize('storage.local.write', WAVEFORM_STATE_FILE, [STATE_DIR]));
    } catch {
      // 写失败不致命：内存里的结果本轮照用，下次重算即可。
    }
  }

  /** 合并短时间内的多次生成，避免用户快速跳曲时把缓存文件写爆。 */
  function scheduleWaveSave(): void {
    if (waveSaveTimer !== null) return;
    waveSaveTimer = setTimeout(() => {
      waveSaveTimer = null;
      void saveWaveCache();
    }, 2000);
  }

  /** 把长桶数组二次抽样成 WAVEFORM_BUCKETS 个（取每段最大值，不平均：平均值会把瞬态抹平）。 */
  function downsamplePeaks(source: number[], target: number): number[] {
    if (source.length === 0) return [];
    if (source.length <= target) return source.slice();
    const out: number[] = [];
    for (let i = 0; i < target; i += 1) {
      const from = Math.floor((i * source.length) / target);
      const to = Math.max(from + 1, Math.floor(((i + 1) * source.length) / target));
      let max = 0;
      for (let j = from; j < to && j < source.length; j += 1) if (source[j] > max) max = source[j];
      out.push(max);
    }
    return out;
  }

  /** 只读地跑一次 ffmpeg 解码取包络。**不改任何音频文件**，也不写临时目录。 */
  function waveformOne(filePath: string, diag: { reason: string | null }): Promise<number[] | null> {
    return new Promise((resolve) => {
      const bin = findFfmpeg();
      if (bin === null) {
        diag.reason = 'ffmpeg-not-found';
        resolve(null);
        return;
      }
      // **并发闸门**（借鉴 Navidrome 的 TranscodeLimiter）：波形解码是 CPU 密集的子进程，
      // 用户快速连点时不能让它把机器打满。**立即拒绝、不排队**（排队只会把延迟堆到后面），
      // 而客户端本来就允许「拿不到波形」——静默降级，下次进这首再算。
      if (waveChildren.size >= WAVEFORM_MAX_CONCURRENT) {
        diag.reason = 'busy';
        resolve(null);
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const buckets: number[] = [];
      let carry = Buffer.alloc(0);
      let current = 0;
      let count = 0;
      let stderrLen = 0;
      const child = spawn(bin, [
        '-hide_banner', '-nostdin', '-v', 'error', '-i', filePath,
        '-ac', '1', '-ar', String(WAVEFORM_DECODE_RATE), '-f', 's16le', '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      waveChildren.add(child);
      const finish = (value: number[] | null) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        waveChildren.delete(child);
        resolve(value);
      };
      child.stderr?.on('data', (chunk: Buffer) => { stderrLen += chunk.length; });
      child.stdout?.on('data', (chunk: Buffer) => {
        // 半个 int16 要留到下一块（chunk 边界不保证对齐）。
        const buf = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
        const usable = buf.length - (buf.length % 2);
        carry = usable === buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(usable));
        for (let i = 0; i < usable; i += 2) {
          const v = buf.readInt16LE(i);
          const abs = v < 0 ? -v : v;
          if (abs > current) current = abs;
          count += 1;
          if (count >= WAVEFORM_SAMPLES_PER_BUCKET) {
            if (buckets.length < WAVEFORM_BUCKET_CAP) buckets.push(current);
            current = 0;
            count = 0;
          }
        }
      });
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 可能已退出 */ }
        diag.reason = 'timeout';
        finish(null);
      }, WAVEFORM_TIMEOUT_MS);
      child.on('error', () => {
        diag.reason = 'spawn-error';
        finish(null);
      });
      child.on('close', (code) => {
        if (waveStopped) {
          diag.reason = 'cancelled';
          finish(null);
          return;
        }
        // 末尾不足一个桶的尾巴也要算进去，否则长曲目的最后一秒会被丢掉。
        if (count > 0 && buckets.length < WAVEFORM_BUCKET_CAP) buckets.push(current);
        if (buckets.length === 0) {
          // 分类原因**不含路径**（§2.8 脱敏）：退出码 + stderr 长度足以区分「ffmpeg 报错」与「没有音频流」。
          diag.reason = 'no-audio:exit=' + String(code) + ',len=' + String(stderrLen);
          finish(null);
          return;
        }
        const sampled = downsamplePeaks(buckets, WAVEFORM_BUCKETS);
        let max = 0;
        for (const v of sampled) if (v > max) max = v;
        // 每首各自归一化到 0..1（否则安静的歌在 UI 上几乎看不见）；全静音保持全 0。
        finish(max > 0 ? sampled.map((v) => Math.round((v / max) * 1000) / 1000) : sampled.map(() => 0));
      });
    });
  }

  /** 取某首曲目的波形：命中缓存（size+mtime 一致）就直接回，否则算一次并落缓存。 */
  async function waveformFor(track: Track): Promise<{ peaks: number[]; cached: boolean; reason: string | null }> {
    let stat;
    try {
      stat = await fs.stat(track.path);
    } catch {
      return { peaks: [], cached: false, reason: 'file-missing' };
    }
    const hit = waveCache.get(track.id);
    if (hit !== undefined && hit.peaks.length > 0 && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
      return { peaks: hit.peaks, cached: true, reason: null };
    }
    if (waveStopped) return { peaks: [], cached: false, reason: 'stopped' };
    const diag = { reason: null as string | null };
    const peaks = await waveformOne(track.path, diag);
    if (peaks === null) return { peaks: [], cached: false, reason: diag.reason ?? 'waveform-failed' };
    waveCache.set(track.id, { peaks, size: stat.size, mtimeMs: stat.mtimeMs, at: Date.now() });
    trimWaveCache();
    scheduleWaveSave();
    return { peaks, cached: false, reason: null };
  }

  /** teardown / 停用：杀掉所有在飞子进程并阻止再启动（I-06）。 */
  function stopWaveform(reason: string): void {
    waveStopped = true;
    if (waveSaveTimer !== null) {
      clearTimeout(waveSaveTimer);
      waveSaveTimer = null;
    }
    for (const child of waveChildren) {
      try { child.kill('SIGKILL'); } catch { /* 可能已退出 */ }
    }
    waveChildren.clear();
    void saveWaveCache();
    console.info('[dsh-music-player] 波形生成已停止：' + reason);
  }

  /** 只读地跑一次 ebur128。**不改任何音频文件**，也不写临时目录。 */
  function measureOne(filePath: string, diag: { reason: string | null }): Promise<{ trackGainDb: number; trackPeak: number } | { silent: true } | null> {
    return new Promise((resolve) => {
      const bin = findFfmpeg();
      if (bin === null) {
        diag.reason = 'ffmpeg-not-found';
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (value: { trackGainDb: number; trackPeak: number } | { silent: true } | null) => {
        if (settled) return;
        settled = true;
        rgJob.child = null;
        clearTimeout(timer);
        resolve(value);
      };
      const child = spawn(bin, ['-hide_banner', '-nostdin', '-i', filePath, '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      rgJob.child = child;
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        // 摘要很长但只有末尾有用；保留尾部即可，避免整段日志常驻内存。
        stderr = (stderr + String(chunk)).slice(-8192);
      });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 可能已退出
        }
        diag.reason = 'timeout';
        finish(null);
      }, RG_MEASURE_TIMEOUT_MS);
      child.on('error', () => {
        diag.reason = 'spawn-error';
        finish(null);
      });
      child.on('close', (code) => {
        if (rgJob.cancelled) {
          diag.reason = 'cancelled';
          finish(null);
          return;
        }
        const parsed = parseEbur128(stderr);
        if (parsed === null) {
          // 分类原因**不含路径**（§2.8 错误面脱敏），但带上退出码与 stderr 长度：
          // 「全失败」时这两个数字足以区分「ffmpeg 报错」与「输出格式变了」。
          diag.reason = 'loudness-not-readable:exit=' + String(code) + ',len=' + String(stderr.length);
          finish(null);
          return;
        }
        if (parsed.peakDb === null) {
          // 全静音：稳定原因（客户端/UI 可据此区分「跳过」与「失败」）。
          diag.reason = 'silent-track';
          finish({ silent: true });
          return;
        }
        finish({
          trackGainDb: RG_REFERENCE_LUFS - parsed.lufs,
          trackPeak: Math.pow(10, parsed.peakDb / 20),
        });
      });
    });
  }

  /**
   * 启动一轮测量。**顺序执行**（ffmpeg 已多线程，并发只会抢 CPU），
   * 已测且文件未变（size+mtime 一致）的直接跳过，因此重复点按几乎零成本。
   */
  function startRgMeasure(): void {
    if (rgJob.running) return;
    const dir = currentDir;
    if (dir === null) return;
    rgJob.running = true;
    rgJob.done = 0;
    rgJob.total = 0;
    rgJob.failed = 0;
    rgJob.skipped = 0;
    rgJob.error = null;
    rgJob.cancelled = false;
    void (async () => {
      try {
        const result = await startScan(dir);
        const entries = await loadRgEntries();
        const audio = (result?.tracks ?? []).filter((track) => track.kind === 'audio');
        rgJob.total = audio.length;
        for (const track of audio) {
          if (rgJob.cancelled) break;
          const filePath = path.join(dir, track.id);
          let stat: { size: number; mtimeMs: number } | null = null;
          try {
            const info = await fs.stat(filePath);
            stat = { size: info.size, mtimeMs: info.mtimeMs };
          } catch {
            stat = null;
          }
          const cached = entries.get(track.id);
          if (stat !== null && cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
            rgJob.skipped += 1;
            rgJob.done += 1;
            continue;
          }
          const diag: { reason: string | null } = { reason: null };
          const measured = await measureOne(filePath, diag);
          if (measured !== null && 'silent' in measured) {
            // 全静音：没有可测内容，**不算失败**（它本来就该保持「未测量」）。
            rgJob.skipped += 1;
            if (rgJob.error === null) rgJob.error = diag.reason ?? 'silent';
          } else if (measured === null) {
            rgJob.failed += 1;
            // 只记**第一处**失败原因：全失败时最有信息量的是第一个，不是最后一个。
            if (rgJob.error === null) rgJob.error = diag.reason ?? 'measure-failed';
          } else {
            entries.set(track.id, {
              trackGainDb: measured.trackGainDb,
              trackPeak: measured.trackPeak,
              size: stat?.size ?? 0,
              mtimeMs: stat?.mtimeMs ?? 0,
              measuredAt: Date.now(),
            });
            rgGeneration += 1;
          }
          rgJob.done += 1;
          // 边测边存：中途取消/崩溃也不至于全丢（每 10 首落一次盘）。
          if (rgJob.done % 10 === 0) await saveRgEntries();
        }
        await saveRgEntries();
      } catch (error) {
        rgJob.error = error instanceof Error ? error.name : 'measure failed';
      } finally {
        rgJob.running = false;
      }
    })();
  }

  /** 停掉在飞的一次测量（停用 / 热重载 / 用户取消）。 */
  function stopRgMeasure(reason: string): void {
    rgJob.cancelled = true;
    rgJob.running = false;
    rgJob.error = rgJob.error ?? reason;
    const child = rgJob.child;
    if (child !== null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // 可能已退出
      }
    }
    rgJob.child = null;
  }

  function rgJobStatus() {
    return {
      running: rgJob.running,
      done: rgJob.done,
      total: rgJob.total,
      failed: rgJob.failed,
      skipped: rgJob.skipped,
      error: rgJob.error,
      measured: rgEntries?.size ?? 0,
    };
  }

  function startScan(dir) {
    // A scan already running for this exact directory is reused: rapid
    // refreshes must not spin up N concurrent metadata parses (measured ~4x
    // CPU for a burst of 4 before this guard).
    if (scanning !== null && scanningDir === dir) return scanning;
    const generation = ++scanGeneration;
    scanProgress.parsed = 0;
    scanProgress.total = 0;
    const isCancelled = () => generation !== scanGeneration;
    const promise = scanLibrary(dir, (parsed, total) => {
      if (!isCancelled()) {
        scanProgress.parsed = parsed;
        scanProgress.total = total;
      }
    }, isCancelled).then((result) => {
      if (result !== null && !isCancelled() && currentDir === dir) library = result;
      if (scanning === promise) {
        scanning = null;
        scanningDir = null;
      }
      return result !== null && currentDir === dir ? result : null;
    }).catch((error) => {
      if (scanning === promise) {
        scanning = null;
        scanningDir = null;
      }
      throw error;
    });
    scanning = promise;
    scanningDir = dir;
    return promise;
  }

  const ready = (async () => {
    currentDir = await loadState();
    if (currentDir !== null) {
      try {
        const stat = await fs.stat(currentDir);
        if (!stat.isDirectory()) currentDir = null;
      } catch {
        currentDir = null;
      }
    }
    if (currentDir !== null) startScan(currentDir).catch(() => {});
    // 测量缓存也在这里预载：`/library` 要能一次性把标签与测量值都带上（否则首帧没有测量值）。
    await loadRgEntries();
  })();

  async function setDirectory(dir) {
    // ⚠️ 必须先等 `ready`。`ready` 里那句 `currentDir = await loadState()` 会在
    // await 恢复时**覆盖**下面刚设好的目录。原来只有 /library、/refresh、/delete
    // 等路由自己 `await ready`，而 /dir 与 /pick 的成功分支没有 —— 激活后第一个
    // 请求若是 POST /dir，目录会在 loadState() 落地时被清回 null，
    // 表现是「设了目录，但列表一直是空的」。
    // 放在这里而不是逐个路由补：调用者忘了就复发（与 prepareVideo 那次同一类教训）。
    await ready;
    const resolved = path.resolve(expandHome(dir));
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      // Never surface the raw ENOENT (it embeds the process cwd path).
      throw statusError(400, '目录不存在或无法访问：' + dir);
    }
    if (!stat.isDirectory()) throw statusError(400, '路径不是目录：' + dir);
    currentDir = resolved;
    library = null;
    await saveState(resolved);
    startScan(resolved).catch(() => {});
    return library;
  }

  async function ensureLibrary() {
    await ready;
    if (scanning !== null) await scanning.catch(() => {});
    if (currentDir === null) return null;
    if (library === null) await startScan(currentDir);
    return library;
  }

  /**
   * /api/library 在扫描期间每 1.5s 被轮询一次；5000 首的库每次都重新 map
   * 一遍会产生大量临时对象（GC 抖动、CPU 空转）。库对象与 scannedAt 不变时
   * 复用同一份数组；apply/delete 会改 scannedAt，从而自动失效。
   */
  let payloadTracksSource: LibraryResult | null = null;
  let payloadTracksScannedAt: number | null = null;
  let payloadTracks: PayloadTrack[] | null = null;
  /** 生成 payloadTracks 时的测量世代（rgGeneration），用于让测量结果即时可见。 */
  let payloadTracksGeneration = -1;
  function payloadTracksFor(result: LibraryResult) {
    // 世代也要参与缓存键：测完一轮后必须让客户端看到新的测量值（否则 payload 一直是旧的）。
    if (payloadTracksSource === result && payloadTracksScannedAt === result.scannedAt
      && payloadTracksGeneration === rgGeneration && payloadTracks !== null) {
      return payloadTracks;
    }
    payloadTracks = result.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      addedAt: track.addedAt,
      tagged: track.tagged === true,
      // MV 相关：客户端据此显示 MV 标识，并在播放前问 /mv 该怎么出画面。
      kind: track.kind === 'video' ? 'video' : 'audio',
      videoCodec: track.videoCodec ?? null,
      audioCodec: track.audioCodec ?? null,
      rgTrackGainDb: track.rgTrackGainDb,
      rgTrackPeak: track.rgTrackPeak,
      rgAlbumGainDb: track.rgAlbumGainDb,
      rgAlbumPeak: track.rgAlbumPeak,
      // 测量值：**标签优先**在客户端决定；这里只如实下发两套数据，不在这里替它选。
      rgMeasuredGainDb: rgEntries?.get(track.id)?.trackGainDb ?? null,
      rgMeasuredPeak: rgEntries?.get(track.id)?.trackPeak ?? null,
    }));
    payloadTracksGeneration = rgGeneration;
    payloadTracksSource = result;
    payloadTracksScannedAt = result.scannedAt;
    return payloadTracks;
  }

  function libraryPayload(result: LibraryResult | null) {
    const base = {
      dir: currentDir,
      scanning: scanning !== null,
      scanParsed: scanProgress.parsed,
      scanTotal: scanProgress.total,
    };
    if (result === null) return { ...base, tracks: [], scannedAt: null, truncated: false, skippedPackages: 0 };
    return {
      ...base,
      dir: result.dir,
      scannedAt: result.scannedAt,
      truncated: result.truncated === true,
      skippedPackages: result.skippedPackages ?? 0,
      // Only fields the UI reads (id/name/title/artist/duration): index is
      // implied by array order and mime is only needed by streamTrack.
      tracks: payloadTracksFor(result),
    };
  }

  /**
   * In-memory cover art cache: id → { data, mime } | null (null = "no cover").
   * Bounded by BOTH entry count and total bytes, so a library full of huge
   * embedded artwork cannot pin gigabytes of host RSS.
   */
  const coverCache = new Map();
  let coverCacheBytes = 0;

  function clearCoverCache() {
    coverCache.clear();
    coverCacheBytes = 0;
  }

  function cacheCover(id, cover) {
    const previous = coverCache.get(id);
    if (previous !== undefined) {
      coverCache.delete(id);
      if (previous !== null) coverCacheBytes -= previous.data.length;
    }
    if (cover === null) {
      if (coverCache.size >= COVER_CACHE_LIMIT) coverCache.delete(coverCache.keys().next().value);
      coverCache.set(id, null);
      return;
    }
    while (coverCache.size > 0
      && (coverCache.size >= COVER_CACHE_LIMIT || coverCacheBytes + cover.data.length > COVER_CACHE_BYTES_LIMIT)) {
      const oldestKey = coverCache.keys().next().value;
      const oldest = coverCache.get(oldestKey);
      coverCache.delete(oldestKey);
      if (oldest !== null) coverCacheBytes -= oldest.data.length;
    }
    coverCache.set(id, cover);
    coverCacheBytes += cover.data.length;
  }

  async function readCover(library, idParam) {
    if (library === null) throw statusError(409, '尚未选择音乐目录');
    const id = typeof idParam === 'string' ? idParam : '';
    const track = library.tracks.find((item) => item.id === id);
    if (track === undefined) throw statusError(404, 'track not in current library');
    const cached = coverCache.get(id);
    if (cached !== undefined) {
      if (cached === null) throw statusError(404, 'no embedded cover');
      return cached;
    }
    let cover: Cover | null = null;
    try {
      const metadata = await parseFile(track.path, { skipCovers: false, duration: false });
      const picture = Array.isArray(metadata.common.picture) ? metadata.common.picture[0] : undefined;
      if (picture !== undefined && picture.data !== undefined && picture.data.length > 0) {
        const mime = typeof picture.format === 'string' ? picture.format.toLowerCase() : '';
        // Never turn attacker-controlled tag bytes into a script-capable
        // response content type; oversized artwork is ignored outright.
        if (COVER_MIME_ALLOWLIST.has(mime) && picture.data.length <= COVER_MAX_BYTES) {
          cover = { data: Buffer.from(picture.data), mime };
        }
      }
    } catch {
      // Unparseable file → treat as no cover.
    }
    cacheCover(id, cover);
    if (cover === null) throw statusError(404, 'no embedded cover');
    return cover;
  }

  /**
   * apply 串行锁：uniqueTargetPath 的「探测目标名 → rename」之间是竞态窗口，
   * 两个并发 apply（多标签页）可能选中同一个目标名并互相覆盖；串行化消除它。
   */
  let applyChain = Promise.resolve();
  function withApplyLock(task) {
    const run = applyChain.then(task, task);
    applyChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 路由主体，node:http 形状。信任判定故意不在这里：两个入口的信任来源不同。
   *  - Web 旧入口（webServer 前缀路由）走 handle()，保留插件自己的 Host/Origin 栅栏；
   *  - connection.fetch 入口由连接层负责鉴权（Web 是 requestRejection，Desktop 的
   *    dsh-app:// 自定义协议本身可信），且 Electron 不带 loopback Host，重复判定会误杀。
   */

  function ytdlpCapability() {
    const bin = findYtDlp();
    if (bin === null) return { bin: null, version: null };
    if (!ytdlpVersionCache.has(bin)) {
      try {
        const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
        const version = probe.status === 0 && typeof probe.stdout === 'string'
          ? probe.stdout.trim().split('\n')[0].slice(0, 80) : null;
        ytdlpVersionCache.set(bin, version);
      } catch {
        ytdlpVersionCache.set(bin, null);
      }
    }
    return { bin, version: ytdlpVersionCache.get(bin) ?? null };
  }

  function importCapabilityPayload() {
    const yt = ytdlpCapability();
    const ffmpeg = findFfmpeg();
    return {
      available: yt.bin !== null && ffmpeg !== null,
      ytdlp: yt.version,
      ffmpeg: ffmpeg !== null,
      hosts: IMPORT_HOSTS,
      maxFilesize: IMPORT_MAX_FILESIZE,
    };
  }

  function importSnapshot(job: ImportJob): ImportSnapshot {
    return {
      id: job.id,
      url: job.url,
      kind: job.kind,
      height: job.height,
      phase: job.phase,
      progress: Math.max(0, Math.min(100, Math.round(job.progress))),
      title: job.title,
      artist: job.artist,
      file: job.file,
      trackId: job.trackId,
      tagged: job.tagged,
      warning: job.warning,
      error: job.error,
      speed: job.speed,
      eta: job.eta,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  function importIsActive(job: ImportJob): boolean {
    return job.phase === 'queued' || job.phase === 'starting' || job.phase === 'metadata' || job.phase === 'download' || job.phase === 'finalize';
  }

  function pruneImportJobs() {
    const now = Date.now();
    for (const [id, job] of importJobs) {
      if (job.finishedAt !== null && now - job.finishedAt > IMPORT_JOB_TTL_MS) importJobs.delete(id);
    }
  }

  function importStatusPayload(id: string | null) {
    pruneImportJobs();
    const all = [...importJobs.values()].sort((a, b) => a.startedAt - b.startedAt);
    let job: ImportJob | null = null;
    if (typeof id === 'string' && id.length > 0) {
      job = importJobs.get(id) ?? null;
      if (job === null) throw statusError(404, '导入任务不存在或已过期');
    } else {
      job = [...all].reverse().find((item) => importIsActive(item)) ?? all.at(-1) ?? null;
    }
    return {
      ...importCapabilityPayload(),
      jobs: all.map((item) => importSnapshot(item)),
      job: job === null ? null : importSnapshot(job),
    };
  }

  /** 队列泵：最多 IMPORT_CONCURRENCY 个 runImport，完成一个补一个。 */
  function pumpImportQueue() {
    while (importRunning < IMPORT_CONCURRENCY) {
      const job = importQueue.shift();
      if (job === undefined) break;
      if (job.cancelled || job.phase !== 'queued') continue;
      const yt = ytdlpCapability();
      const ffmpeg = findFfmpeg();
      if (yt.bin === null || ffmpeg === null) {
        job.phase = 'error';
        job.error = yt.bin === null ? 'yt-dlp 未安装' : 'ffmpeg 未安装';
        job.finishedAt = Date.now();
        continue;
      }
      job.phase = 'starting';
      job.progress = 1;
      importRunning += 1;
      void runImport(job, yt.bin, ffmpeg).catch((error: unknown) => {
        if (job.cancelled) {
          job.phase = 'cancelled';
        } else {
          job.phase = 'error';
          job.error = importFailureMessage(reasonOf(error), job.dir);
        }
        job.finishedAt = Date.now();
      }).finally(() => {
        importRunning = Math.max(0, importRunning - 1);
        pumpImportQueue();
      });
    }
  }

  async function cleanupImportTemp(job: ImportJob) {
    const prefix = path.basename(job.tmpBase);
    let rows: string[] = [];
    try {
      rows = await fs.readdir(job.dir);
    } catch {
      return;
    }
    for (const name of rows) {
      if (!name.startsWith(prefix)) continue;
      try {
        await fs.rm(authorize('fs.write', path.join(job.dir, name), [job.dir]), { force: true, recursive: true });
      } catch {
        // 清理是尽力而为；下一次导入不会复用这个前缀。
      }
    }
  }

  async function findImportOutput(job: ImportJob): Promise<{ name: string; size: number } | null> {
    const prefix = path.basename(job.tmpBase);
    const allowed = job.kind === 'audio' ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS;
    let rows: string[] = [];
    try {
      rows = await fs.readdir(job.dir);
    } catch {
      return null;
    }
    const candidates: { name: string; size: number }[] = [];
    for (const name of rows) {
      if (!name.startsWith(prefix)) continue;
      if (/\.(info\.json|json|jpe?g|png|webp|part|ytdl)$/iu.test(name)) continue;
      if (!allowed.has(path.extname(name).toLowerCase())) continue;
      try {
        const stat = await fs.stat(path.join(job.dir, name));
        if (stat.isFile()) candidates.push({ name, size: stat.size });
      } catch {
        // 下一项
      }
    }
    candidates.sort((a, b) => b.size - a.size);
    return candidates[0] ?? null;
  }

  async function readImportCover(job: ImportJob): Promise<Cover | null> {
    const prefix = path.basename(job.tmpBase);
    let rows: string[] = [];
    try {
      rows = await fs.readdir(job.dir);
    } catch {
      return null;
    }
    const name = rows
      .filter((row) => row.startsWith(prefix))
      .find((row) => /\.(jpe?g|png)$/iu.test(row));
    if (name === undefined) return null;
    const mime = importCoverMime(path.extname(name).toLowerCase());
    if (mime === null) return null;
    try {
      const data = await fs.readFile(path.join(job.dir, name));
      if (data.length === 0 || data.length > COVER_MAX_BYTES) return null;
      return { data, mime };
    } catch {
      return null;
    }
  }

  function runImportProcess(
    job: ImportJob | null,
    bin: string,
    args: string[],
    timeoutMs: number,
    onLine: ((line: string) => void) | null,
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError: string | null }> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: reasonOf(error) });
        return;
      }
      if (job !== null) job.child = child;
      let stdout = '';
      let stderr = '';
      let pending = '';
      let settled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (job !== null) job.child = null;
        resolve({ code, stdout, stderr, timedOut, spawnError: null });
      };
      timer = setTimeout(() => {
        timedOut = true;
        if (job !== null) job.timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // 进程可能已经退出
        }
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer | string) => {
        const text = String(chunk);
        if (stdout.length < 32 * 1024 * 1024) stdout += text;
        pending += text;
        let index = pending.indexOf('\n');
        while (index >= 0) {
          const line = pending.slice(0, index).replace(/\r$/u, '');
          pending = pending.slice(index + 1);
          if (onLine !== null) onLine(line);
          index = pending.indexOf('\n');
        }
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (stderr.length < 16 * 1024) stderr += String(chunk).slice(0, 16 * 1024 - stderr.length);
      });
      child.on('error', (error) => {
        resolve({ code: null, stdout, stderr, timedOut, spawnError: reasonOf(error) });
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (job !== null) job.child = null;
      });
      child.on('close', (code) => finish(code));
    });
  }


  // ── B 站扫码登录（官方 QR 端点；cookie 只在宿主本地）────────────────────────
  async function biliFetch(url: string, options: any = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      return await fetch(url, {
        ...options,
        headers: { ...BILI_HEADERS, ...(options.headers ?? {}) },
        signal: controller.signal,
      });
    } catch {
      throw statusError(502, 'B 站服务连接失败，请稍后重试');
    } finally {
      clearTimeout(timer);
    }
  }

  async function biliAuthStatus(force = false): Promise<BiliAuth> {
    if (!force && biliAuthCache !== null && Date.now() - biliAuthCache.at < 30_000) return biliAuthCache.value;
    let value: BiliAuth = { loggedIn: false };
    if (existsSync(biliCookieFile())) {
      try {
        const header = biliCookieHeader(await fs.readFile(biliCookieFile(), 'utf8'));
        if (header.length > 0) {
          const response = await biliFetch(BILI_NAV, { headers: { cookie: header } });
          const body: any = await response.json();
          if (body?.code === 0 && body.data?.isLogin === true) {
            value = {
              loggedIn: true,
              uname: typeof body.data.uname === 'string' ? body.data.uname.slice(0, 80) : '',
              mid: Number.isFinite(Number(body.data.mid)) ? Number(body.data.mid) : null,
              vip: body.data.vipStatus === 1,
            };
          }
        }
      } catch {
        value = { loggedIn: false };
      }
    }
    biliAuthCache = { at: Date.now(), value };
    return value;
  }

  async function clearBiliCookies() {
    try {
      await fs.rm(authorize('storage.local.write', biliCookieFile(), [STATE_DIR]), { force: true });
    } catch {
      // 不存在 / 权限失败都不影响退出登录的语义：状态按未登录返回。
    }
    biliAuthCache = { at: Date.now(), value: { loggedIn: false } };
    importProbeCache.clear();
    console.info('[dsh-music-player] B 站登录已退出');
  }

  async function writeBiliCookies(cookies: BiliCookie[]) {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const target = authorize('storage.local.write', biliCookieFile(), [STATE_DIR]);
    const tmp = target + '.tmp';
    await fs.writeFile(tmp, biliCookieFileContent(cookies), { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.chmod(tmp, 0o600);
    } catch {
      // Windows 没有 POSIX 权限位；文件仍写在用户数据区。
    }
    await fs.rename(tmp, target);
    importProbeCache.clear();
  }

  async function biliQrStart() {
    const now = Date.now();
    for (const [key, at] of biliQrPending) if (now - at > 5 * 60_000) biliQrPending.delete(key);
    const response = await biliFetch(BILI_QR_GENERATE);
    const body: any = await response.json();
    const key = typeof body?.data?.qrcode_key === 'string' ? body.data.qrcode_key : '';
    const url = typeof body?.data?.url === 'string' ? body.data.url : '';
    if (body?.code !== 0 || key.length === 0 || url.length === 0) throw statusError(502, 'B 站登录服务返回异常');
    biliQrPending.set(key, now);
    return { key, qr: biliQrDataUrl(url), expiresIn: 180 };
  }

  async function biliQrPoll(key: string) {
    const started = biliQrPending.get(key);
    if (started === undefined) throw statusError(400, '二维码已过期，请刷新');
    if (Date.now() - started > 5 * 60_000) {
      biliQrPending.delete(key);
      return { status: 'expired' as const };
    }
    const response = await biliFetch(BILI_QR_POLL + '?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header');
    const body: any = await response.json();
    const code = Number(body?.data?.code);
    if (code === 86101) return { status: 'waiting' as const };
    if (code === 86090) return { status: 'scanned' as const };
    if (code === 86038) {
      biliQrPending.delete(key);
      return { status: 'expired' as const };
    }
    if (code !== 0) throw statusError(502, 'B 站登录失败：' + String(body?.message ?? '未知错误').slice(0, 80));
    const headers = response.headers as unknown as { getSetCookie?: () => string[] };
    const setCookies = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''].filter((value) => value.length > 0);
    const cookies = parseBiliSetCookie(setCookies);
    if (!cookies.some((cookie) => cookie.name === 'SESSDATA') && typeof body?.data?.url === 'string') {
      try {
        const redirect = new URL(body.data.url);
        for (const name of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
          const value = redirect.searchParams.get(name);
          if (value !== null && !cookies.some((cookie) => cookie.name === name)) {
            cookies.push({ name, value, domain: '.bilibili.com', expires: 0 });
          }
        }
      } catch {
        // 没有回退 URL 也不影响上报失败。
      }
    }
    if (!cookies.some((cookie) => cookie.name === 'SESSDATA')) throw statusError(502, '登录成功但没有拿到 B 站凭证');
    await writeBiliCookies(cookies);
    const auth = await biliAuthStatus(true);
    if (!auth.loggedIn) {
      await clearBiliCookies();
      throw statusError(502, 'B 站登录校验失败，请重试');
    }
    biliQrPending.delete(key);
    console.info('[dsh-music-player] B 站扫码登录成功');
    return { status: 'ok' as const, auth };
  }

  /** 读一次 yt-dlp 的 -J；可带 job 以便取消时杀掉子进程。 */
  async function readYtdlpInfo(url: string, job: ImportJob | null = null): Promise<{ info: ImportInfo; raw: unknown }> {
    const yt = ytdlpCapability();
    if (yt.bin === null) throw statusError(503, 'yt-dlp 未安装：请先安装 yt-dlp（例如 brew install yt-dlp）');
    const cookies = isBilibiliUrl(url) && existsSync(biliCookieFile()) ? biliCookieFile() : null;
    const args = ['--ignore-config', '--no-playlist', '--no-warnings', '--skip-download', '-J'];
    if (cookies !== null) args.push('--cookies', cookies);
    args.push(url);
    const run = await runImportProcess(job, yt.bin, args, IMPORT_METADATA_TIMEOUT_MS, null);
    if (run.spawnError !== null) throw statusError(502, '无法启动 yt-dlp：' + run.spawnError);
    if (run.timedOut) throw statusError(504, '读取链接信息超时');
    if (run.code !== 0) throw statusError(502, importFailureMessage(run.stderr, job?.dir ?? ''));
    let raw: unknown;
    try {
      raw = JSON.parse(run.stdout);
    } catch {
      throw statusError(502, '链接信息解析失败');
    }
    const info = parseYtdlpInfo(raw);
    if (info === null) throw statusError(422, '无法识别该链接的内容');
    return { info, raw };
  }

  async function probeImport(rawUrl: unknown): Promise<ImportProbe> {
    const url = validateImportUrl(rawUrl);
    const bili = isBilibiliUrl(url);
    const loggedIn = bili && existsSync(biliCookieFile());
    const key = url + '|' + (loggedIn ? 'auth' : 'anon');
    const cached = importProbeCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < 5 * 60_000) return cached.value;
    const { info, raw } = await readYtdlpInfo(url);
    const heights = importFormatHeights(raw);
    const value: ImportProbe = {
      title: info.title,
      artist: info.artist,
      duration: info.duration,
      heights,
      recommended: recommendedImportHeight(heights),
      loggedIn,
      needsLogin: bili && !loggedIn,
    };
    if (importProbeCache.size >= 8) importProbeCache.delete(importProbeCache.keys().next().value as string);
    importProbeCache.set(key, { at: Date.now(), value });
    return value;
  }

  async function runImport(job: ImportJob, bin: string, ffmpeg: string) {
    try {
      job.phase = 'metadata';
      job.progress = 3;
      const { info } = await readYtdlpInfo(job.url, job);
      if (job.cancelled) return;
      job.title = info.title;
      job.artist = info.artist;

      job.phase = 'download';
      job.progress = 5;
      const cookiesPath = isBilibiliUrl(job.url) && existsSync(biliCookieFile()) ? biliCookieFile() : null;
      const download = await runImportProcess(
        job, bin,
        buildYtdlpArgs(job.url, job.kind, job.tmpBase, ffmpeg, job.height, cookiesPath),
        IMPORT_TIMEOUT_MS,
        (line) => {
          const progress = parseImportProgress(line);
          if (progress === null) return;
          job.progress = Math.max(5, Math.min(85, 5 + progress.percent * 0.8));
          job.speed = progress.speed.length > 0 ? progress.speed : null;
          job.eta = progress.eta.length > 0 ? progress.eta : null;
        },
      );
      if (job.cancelled) return;
      if (download.spawnError !== null) throw new Error('无法启动 yt-dlp：' + download.spawnError);
      if (download.timedOut) throw new Error('下载超时');
      if (download.code !== 0) throw new Error(importFailureMessage(download.stderr, job.dir));

      job.phase = 'finalize';
      job.progress = 90;
      const output = await findImportOutput(job);
      if (output === null) throw new Error('下载完成但没有找到媒体文件');
      const ext = path.extname(output.name).toLowerCase();
      const target = await uniqueTargetPath(job.dir, importFileName(info, ext));
      await fs.rename(
        authorize('fs.write', path.join(job.dir, output.name), [job.dir]),
        authorize('fs.write', target, [job.dir]),
      );
      const cover = await readImportCover(job);
      let tagResult: TagWriteResult = { tagged: false, reason: '标签写入未执行' };
      try {
        tagResult = await writeTagsAtomic(target, { title: info.title, artist: info.artist, album: '' }, cover, false, [job.dir]);
      } catch (error) {
        tagResult = { tagged: false, reason: '标签写入失败：' + importErrorText(reasonOf(error), job.dir) };
      }
      job.file = path.basename(target);
      job.trackId = path.relative(job.dir, target).split(path.sep).join('/');
      job.tagged = tagResult.tagged;
      job.warning = tagResult.tagged ? null : (tagResult.reason ?? null);
      job.phase = 'done';
      job.progress = 100;
      job.finishedAt = Date.now();
      console.info('[dsh-music-player] 导入完成：' + job.id + ' · ' + (job.tagged ? 'tags' : 'no-tags'));
      library = null;
      clearCoverCache();
      startScan(job.dir).catch(() => {});
    } catch (error) {
      if (job.cancelled) {
        job.phase = 'cancelled';
        job.finishedAt = Date.now();
      } else {
        job.phase = 'error';
        job.error = importErrorText(reasonOf(error), job.dir);
        job.finishedAt = Date.now();
      }
    } finally {
      await cleanupImportTemp(job);
    }
  }

  function startImports(rawUrls: unknown, rawKind: unknown, rawHeight: unknown = null): ImportJob[] {
    const list = Array.isArray(rawUrls) ? rawUrls : [rawUrls];
    if (list.length === 0) throw statusError(400, '至少提供一个链接');
    if (list.length > IMPORT_MAX_BATCH) throw statusError(400, '一次最多导入 ' + IMPORT_MAX_BATCH + ' 个链接');
    const urls: string[] = [];
    for (const raw of list) {
      const url = validateImportUrl(raw);
      if (!urls.includes(url)) urls.push(url);
    }
    if (urls.length === 0) throw statusError(400, '至少提供一个链接');
    const kind: ImportKind | null = rawKind === 'audio' ? 'audio' : rawKind === 'video' ? 'video' : null;
    if (kind === null) throw statusError(400, '下载类型必须是 audio 或 video');
    let height: number | null = null;
    if (rawHeight !== undefined && rawHeight !== null && rawHeight !== '') {
      const parsed = Number(rawHeight);
      if (!Number.isInteger(parsed) || parsed < 144 || parsed > 4320) throw statusError(400, '清晰度必须是 144–4320 之间的整数');
      height = parsed;
    }
    if (currentDir === null) throw statusError(409, '尚未选择音乐目录');
    const dir = currentDir;
    const yt = ytdlpCapability();
    if (yt.bin === null) throw statusError(503, 'yt-dlp 未安装：请先安装 yt-dlp（例如 brew install yt-dlp）');
    if (findFfmpeg() === null) throw statusError(503, 'ffmpeg 未安装：请先安装 ffmpeg（例如 brew install ffmpeg）');

    // 先校验完整个批次再建任务：非法链接不会留下“半批已开始”的状态。
    const jobs = urls.map((url) => {
      const job: ImportJob = {
        id: randomUUID(),
        kind,
        height,
        url,
        phase: 'queued',
        progress: 0,
        title: null,
        artist: null,
        file: null,
        trackId: null,
        tagged: false,
        warning: null,
        error: null,
        speed: null,
        eta: null,
        startedAt: Date.now(),
        finishedAt: null,
        child: null,
        cancelled: false,
        timedOut: false,
        dir,
        tmpBase: path.join(dir, IMPORT_TMP_PREFIX + randomUUID()),
      };
      importJobs.set(job.id, job);
      importQueue.push(job);
      try { console.info('[dsh-music-player] 导入入队：' + kind + ' · ' + new URL(url).hostname + ' · ' + job.id); } catch { /* 日志不能影响导入 */ }
      return job;
    });
    pumpImportQueue();
    return jobs;
  }

  function cancelImportJob(id: unknown): ImportJob {
    const wanted = typeof id === 'string' ? id : '';
    const job = importJobs.get(wanted);
    if (job === undefined) throw statusError(404, '导入任务不存在或已过期');
    if (job.phase === 'queued') {
      const at = importQueue.indexOf(job);
      if (at >= 0) importQueue.splice(at, 1);
    }
    if (importIsActive(job)) {
      job.cancelled = true;
      job.phase = 'cancelled';
      job.finishedAt = Date.now();
      if (job.child !== null) {
        try {
          job.child.kill('SIGKILL');
        } catch {
          // 已经退出
        }
      }
    }
    return job;
  }

  function cancelAllImports(): ImportJob[] {
    const jobs = [...importJobs.values()];
    for (const job of jobs) {
      if (importIsActive(job)) {
        const at = importQueue.indexOf(job);
        if (at >= 0) importQueue.splice(at, 1);
        job.cancelled = true;
        job.phase = 'cancelled';
        job.finishedAt = Date.now();
        if (job.child !== null) {
          try { job.child.kill('SIGKILL'); } catch { /* 已经退出 */ }
        }
      }
    }
    return jobs;
  }

  async function dispatch(req, res) {
    // HEAD 探测（<audio preload>、封面预取）复用 GET 路由；node 对 HEAD 响应自动丢弃 body。
    if (req.method === 'HEAD') req.method = 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw statusError(400, 'malformed request path');
    }
    pathname = canonicalEndpoint(pathname);

    // 跨源媒体预检（Desktop 的媒体接进 Web Audio 时会先发 OPTIONS + Range）。
    // 只对媒体端点应答，其余路径仍然落到下面的 404/405 兜底。
    // `system-stream` 是**桌面版实际走的那条**（token 直连），漏掉它预检会被 404 掉、
    // 浏览器随即拒绝媒体请求 = 静音。三个媒体端点都要应答。
    if (
      req.method === 'OPTIONS' &&
      (pathname === '/api/dsh-music/stream' ||
        pathname === '/api/dsh-music/mvfile' ||
        pathname === '/api/dsh-music/system-stream')
    ) {
      mediaPreflight(req, res);
      return;
    }
    if (pathname === '/api/dsh-music/library' && req.method === 'GET') {
      // Non-blocking: report scan progress instead of waiting for the scan.
      await ready;
      if (currentDir !== null && library === null && scanning === null) startScan(currentDir).catch(() => {});
      sendJson(res, 200, libraryPayload(library));
      return;
    }

    if (pathname === '/api/dsh-music/waveform' && req.method === 'GET') {
      await ready;
      await loadWaveCache();
      const wanted = url.searchParams.get('p') ?? '';
      const track = (library?.tracks ?? []).find((item) => item.id === wanted);
      if (track === undefined) {
        // 未知曲目不是基础设施失败：回空波形 + 稳定原因，客户端静默降级（§2.8）。
        sendJson(res, 200, { peaks: [], cached: false, reason: 'unknown-track' });
        return;
      }
      const result = await waveformFor(track);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/api/dsh-music/measure' && (req.method === 'POST' || req.method === 'GET')) {
      await ready;
      await loadRgEntries();
      if (req.method === 'POST') startRgMeasure();
      sendJson(res, 200, rgJobStatus());
      return;
    }

    if (pathname === '/api/dsh-music/refresh' && req.method === 'POST') {
      await ready;
      if (currentDir === null) {
        sendJson(res, 200, libraryPayload(null));
        return;
      }
      library = null;
      clearCoverCache();
      startScan(currentDir).catch(() => {});
      sendJson(res, 200, libraryPayload(null));
      return;
    }

    if (pathname === '/api/dsh-music/import' && (req.method === 'GET' || req.method === 'POST')) {
      await ready;
      if (req.method === 'GET') {
        sendJson(res, 200, importStatusPayload(url.searchParams.get('id')));
        return;
      }
      const body = await readJson(req);
      const jobs = startImports(Array.isArray(body.urls) ? body.urls : body.url, body.kind, body.height);
      // POST 只回本批新建的任务；GET 才回完整任务列表，便于客户端区分“刚提交的”与“已有的”。
      sendJson(res, 200, { ...importStatusPayload(jobs[0].id), jobs: jobs.map((job) => importSnapshot(job)) });
      return;
    }

    if (pathname === '/api/dsh-music/import-cancel' && req.method === 'POST') {
      await ready;
      const body = await readJson(req);
      if (body.all === true) {
        cancelAllImports();
        sendJson(res, 200, importStatusPayload(null));
        return;
      }
      const job = cancelImportJob(body.id);
      sendJson(res, 200, importStatusPayload(job.id));
      return;
    }

    if (pathname === '/api/dsh-music/import-probe' && req.method === 'POST') {
      await ready;
      const body = await readJson(req);
      sendJson(res, 200, await probeImport(body.url));
      return;
    }

    if (pathname === '/api/dsh-music/import-auth' && (req.method === 'GET' || req.method === 'POST')) {
      await ready;
      if (req.method === 'GET') {
        sendJson(res, 200, { bilibili: await biliAuthStatus() });
        return;
      }
      const body = await readJson(req);
      if (body.action === 'qr') {
        sendJson(res, 200, { action: 'qr', ...(await biliQrStart()) });
        return;
      }
      if (body.action === 'poll') {
        const result = await biliQrPoll(typeof body.key === 'string' ? body.key : '');
        sendJson(res, 200, { action: 'poll', ...result });
        return;
      }
      if (body.action === 'logout') {
        await clearBiliCookies();
        sendJson(res, 200, { action: 'logout', loggedIn: false });
        return;
      }
      throw statusError(400, '登录操作必须是 qr、poll 或 logout');
    }

    if (pathname === '/api/dsh-music/dir' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body.dir !== 'string' || body.dir.trim().length === 0) throw statusError(400, 'dir is required');
      await setDirectory(body.dir.trim());
      clearCoverCache();
      sendJson(res, 200, libraryPayload(library));
      return;
    }

    if (pathname === '/api/dsh-music/cover' && req.method === 'GET') {
      const cover = await readCover(await ensureLibrary(), url.searchParams.get('p'));
      res.writeHead(200, {
        'content-type': cover.mime,
        'content-length': cover.data.length,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      });
      res.end(cover.data);
      return;
    }

    if (pathname === '/api/dsh-music/match' && req.method === 'GET') {
      const lib = await ensureLibrary();
      if (lib === null) throw statusError(409, '尚未选择音乐目录');
      const track = resolveLibraryTrack(lib, url.searchParams.get('p'));
      // q 覆盖自动拼词：标签不准时用户可手动重查。
      const override = url.searchParams.get('q');
      const overrideTerm = typeof override === 'string' ? override.trim() : '';
      const queries = overrideTerm.length > 0 ? [overrideTerm] : buildMatchQueries(track);
      // 限制并发：匹配是「网络 + 打分」，多个标签页/连点会把上游和 CPU 一起打满。
      const result = await withMatchSlot(() => matchTrack(track, queries.length > 0 ? queries : [track.name]));
      sendJson(res, 200, {
        term: queries[0] ?? track.name,
        terms: queries,
        best: result.candidates[0] ?? null,
        auto: result.candidates[0]?.auto === true,
        candidates: result.candidates.slice(0, 12),
        errors: result.errors.slice(0, 4),
      });
      return;
    }

    if (pathname === '/api/dsh-music/art' && req.method === 'GET') {
      const art = await fetchArtwork(url.searchParams.get('u'));
      res.writeHead(200, {
        'content-type': art.mime,
        'content-length': art.data.length,
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
      });
      res.end(art.data);
      return;
    }

    if (pathname === '/api/dsh-music/apply' && req.method === 'POST') {
      const body = await readJson(req);
      const payload = await withApplyLock(async () => {
        const lib = await ensureLibrary();
        if (lib === null) throw statusError(409, '尚未选择音乐目录');
        const track = resolveLibraryTrack(lib, body.id);
        const meta = {
          title: typeof body.title === 'string' ? body.title.trim() : '',
          artist: typeof body.artist === 'string' ? body.artist.trim() : '',
          album: typeof body.album === 'string' ? body.album.trim() : '',
        };
        // 封面是可选增强：下载失败不影响标签写入与重命名。
        let cover: Cover | null = null;
        if (typeof body.cover === 'string' && body.cover.length > 0) {
          try {
            cover = await fetchArtwork(body.cover);
          } catch {
            cover = null;
          }
        }
        // 只有 jpeg/png 能被 taglib 可靠地写进 ID3/Vorbis/MP4 并回读；
        // webp/avif/bmp/gif 只用于界面显示，绝不写进文件（写坏等于丢封面）。
        if (cover !== null && cover.mime !== 'image/jpeg' && cover.mime !== 'image/png') cover = null;
        // 默认只补缺失封面；覆盖已有封面必须由调用方显式要求。
        const tagResult = await writeTagsAtomic(track.path, meta, cover, body.replaceCover === true, [lib.dir]);

        const oldId = track.id;
        let renamed = false;
        if (body.rename === true && (meta.title.length > 0 || meta.artist.length > 0)) {
          const targetPath = await uniqueTargetPath(path.dirname(track.path), buildFileName(track, meta));
          if (path.resolve(targetPath) !== path.resolve(track.path)) {
            try {
              // 副作用位置授权：源与目标都必须落在当前音乐目录（fs.write scope）。
              await fs.rename(
                authorize('fs.write', track.path, [lib.dir]),
                authorize('fs.write', targetPath, [lib.dir]),
              );
            } catch {
              throw statusError(500, '无法重命名文件：' + track.name);
            }
            track.path = targetPath;
            track.name = path.basename(targetPath);
            track.id = path.relative(lib.dir, targetPath).split(path.sep).join('/');
            renamed = true;
          }
        }
        // 立即反映到当前库（下次完整扫描也会从文件读到同样的值）。
        if (meta.title.length > 0) track.title = meta.title;
        if (meta.artist.length > 0) track.artist = meta.artist;
        if (tagResult.tagged) track.tagged = true;
        lib.scannedAt = Date.now();
        coverCache.delete(oldId);
        coverCache.delete(track.id);
        return {
          oldId,
          newId: track.id,
          tagged: tagResult.tagged,
          renamed,
          warning: tagResult.reason ?? null,
          library: libraryPayload(lib),
        };
      });
      sendJson(res, 200, payload);
      return;
    }

    if (pathname === '/api/dsh-music/pick' && req.method === 'POST') {
      const picker = ctx.get('directoryPicker');
      if (picker === undefined || picker === null) throw statusError(501, 'native directory picker unavailable');
      const capability = picker.capability();
      const controller = new AbortController();
      // Abort the native dialog when the page goes away mid-pick. Use the
      // response's close: IncomingMessage 'close' semantics differ across
      // Node versions and can fire as soon as the request body arrives.
      res.on('close', () => controller.abort());
      const picked = await capability.pick(controller.signal);
      if (typeof picked !== 'string' || picked.length === 0) {
        sendJson(res, 200, { cancelled: true, ...libraryPayload(await ensureLibrary()) });
        return;
      }
      sendJson(res, 200, { cancelled: false, ...libraryPayload(await setDirectory(picked)) });
      return;
    }

    if (pathname === '/api/dsh-music/stream' && req.method === 'GET') {
      await streamTrack(await ensureLibrary(), url.searchParams.get('p'), req, res);
      return;
    }

    /**
     * MV 出画方式：direct（直出 /stream）/ remux（换壳）/ transcode（重编码）。
     * 客户端在播放视频轨前先问这里，拿到该用哪个 URL、以及是否还在准备。
     */
    if (pathname === '/api/dsh-music/mv' && req.method === 'GET') {
      const library = await ensureLibrary();
      if (library === null) throw statusError(409, '尚未选择音乐目录');
      const track = library.tracks.find((item) => item.id === (url.searchParams.get('id') ?? ''));
      if (track === undefined) throw statusError(404, 'track not in current library');
      if (track.kind !== 'video') throw statusError(400, 'not a video track');
      // 客户端可以显式指定 mode：直出失败时（比如该构建其实解不了这个编码）
      // 强制走转码，而不是又拿到同一个不能播的直出地址。
      const forced = url.searchParams.get('mode');
      const mode = forced === 'remux' || forced === 'transcode' ? forced : mvPlan(track, mvClientCaps);
      // retry=1：客户端点了「重试」，要丢掉上一次的失败记录重跑（见 mvPrepare）。
      const retry = url.searchParams.get('retry') === '1';
      if (mode === 'direct') {
        sendJson(res, 200, {
          mode,
          state: 'ready',
          progress: 1,
          url: '/api/dsh-music/stream?p=' + encodeURIComponent(track.id) + '&v=' + (library.scannedAt ?? 0),
          ffmpeg: findFfmpeg() !== null,
        });
        return;
      }
      sendJson(res, 200, { mode, ...(await mvPrepare(track, mode, track.duration, retry)) });
      return;
    }

    /**
     * 「补全」顺带转格式：把浏览器播不了的 MV 就地转成 H.264/AAC 的 MP4。
     * 默认**不删原件**（写成「xxx (MV).mp4」并存）；deleteOriginal=true 时把原件丢进废纸篓。
     * 这样转一次就变成普通 MV，之后跟别的 MV 一样直接播（不再依赖 /tmp 缓存）。
     */
    if (pathname === '/api/dsh-music/mvconvert' && req.method === 'POST') {
      const body = await readJson(req);
      const current = await ensureLibrary();
      if (current === null) throw statusError(409, '尚未选择音乐目录');
      const target0 = current.tracks.find((item) => item.id === (typeof body.id === 'string' ? body.id : ''));
      if (target0 === undefined) throw statusError(404, 'track not in current library');
      if (target0.kind !== 'video') throw statusError(400, 'not a video track');
      const mode = mvPlan(target0, mvClientCaps);
      if (mode === 'direct') {
        sendJson(res, 200, { converted: false, reason: 'already-playable' });
        return;
      }
      const ffmpeg = findFfmpeg();
      if (ffmpeg === null) throw statusError(503, 'ffmpeg-not-found');
      const dir = path.dirname(target0.path);
      const base = path.basename(target0.path, path.extname(target0.path));
      const output = await uniqueTargetPath(dir, base + ' (MV).mp4');
      // 与 mvPrepare 同一套档位纪律：音轨已知解不了时从 `audio` 起。
      const attempts = mode === 'remux'
        ? (audioNeedsTranscode(target0) ? ['audio', 'fast', 'full'] : ['copy', 'audio', 'fast', 'full'])
        : ['fast', 'full'];
      let converted = false;
      let lastLog = '';
      const conversionJob: MvJob = { state: 'preparing', progress: 0, error: null, child: null, log: '', attempt: null, finishedAt: null, cancelled: false, timedOut: false };
      for (const attempt of attempts) {
        // 异步 spawn：以前用 spawnSync，整段转码会把整个宿主事件循环钉住，页面其他请求
        // （封面、库轮询、播放流）一起卡住。这里复用 mvRunAttempt，进度/超时也统一。
        const code = await mvRunAttempt(ffmpeg, target0, attempt, output, conversionJob, target0.duration);
        if (code === 0) { converted = true; break; }
        lastLog = conversionJob.log.trim().split('\n').filter((line) => !/^\[(copy|audio|fast|full) exited/.test(line.trim())).slice(-1)[0] ?? '';
        if (conversionJob.timedOut) break;
        try {
          // 失败档留下的半成品**在用户的音乐目录里**（不是缓存目录）：授权面就必须是它
          // （拿缓存目录去授权只会 403，然后被这个 catch 吞掉 —— 半成品会留在库里被扫成曲目）。
          await fs.rm(authorize('fs.write', output, [dir]), { force: true });
        } catch { /* 下一档重来 */ }
      }
      if (!converted) throw statusError(500, 'ffmpeg 转换失败：' + lastLog.slice(0, 200));
      let trashed = false;
      let trashError: string | null = null;
      if (body.deleteOriginal === true) {
        const trash = platformTrashDir();
        if (trash === null) {
          // 没有可移植的回收站：**保留原件**并如实报告（用户勾了却没生效，不能静默）。
          trashError = 'unsupported-platform';
        } else {
          try {
            await fs.mkdir(trash, { recursive: true });
            const trashName = await uniqueTargetPath(trash, path.basename(target0.path));
            // 副作用位置授权：源在音乐目录内、目标在回收站（声明里 fs.write
            // 覆盖库内音频文件；回收站是 mvconvert 的 deleteOriginal 专用面）。
            await fs.rename(
              authorize('fs.write', target0.path, [current.dir]),
              authorize('fs.write', trashName, [trash]),
            );
            trashed = true;
          } catch (error) {
            // 跨卷等失败：保留原件，绝不影响已转好的新文件；但要说明原因。
            trashError = reasonOf(error);
          }
        }
        if (trashError !== null) console.info('[dsh-music-player] deleteOriginal 未生效：' + trashError + '（原件已保留）');
      }
      library = null;   // 下一次 /library 重新扫描，新文件立刻出现
      sendJson(res, 200, {
        converted: true,
        mode,
        file: path.basename(output),
        deletedOriginal: trashed,
        trashError,
      });
      return;
    }

    /**
     * MV 解码库：把插件自带的 mediabunny / WebCodecs polyfill / libav 变体发给页面。
     * 页面只在遇到「浏览器没有解码器」的老编码时才懒加载它们，常规路径零开销。
     * 严格白名单 + 防穿越：只可能读到这三个包目录里的文件。
     */
    if (pathname === '/api/dsh-music/mvlib' && req.method === 'GET') {
      const rel = url.searchParams.get('f') ?? '';
      const ALLOWED = ['mediabunny/', 'libavjs-webcodecs-polyfill/', '@libav.js/'];
      if (!ALLOWED.some((prefix) => rel.startsWith(prefix)) || rel.includes('..')) {
        throw statusError(403, 'mvlib path not allowed');
      }
      const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
      const file = path.resolve(root, rel);
      const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
      if (!file.startsWith(rootWithSep)) throw statusError(403, 'mvlib path escapes node_modules');
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        throw statusError(404, 'mvlib file missing: ' + rel);
      }
      const lower = file.toLowerCase();
      const mime = lower.endsWith('.wasm') ? 'application/wasm'
        : lower.endsWith('.mjs') || lower.endsWith('.js') ? 'text/javascript'
        : 'application/octet-stream';
      serveFileRange(file, mime, stat, req, res);
      return;
    }

    /** MV 缓存文件（转封装/转码产物）：Range 语义与 /stream 完全一致，可自由拖动。 */
    if (pathname === '/api/dsh-music/mvfile' && req.method === 'GET') {
      const key = url.searchParams.get('k') ?? '';
      if (!/^[a-f0-9]{16,64}$/.test(key)) throw statusError(400, 'bad mv cache key');
      const file = mvOutputFor(key);
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        throw statusError(404, 'mv cache miss');
      }
      serveFileRange(file, 'video/mp4', stat, req, res);
      return;
    }

    /** 客户端上报解码能力（HEVC / AV1 各构建不一样），影响 mvPlan 的判定。 */
    if (pathname === '/api/dsh-music/caps' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      if (typeof body.hevc === 'boolean') mvClientCaps.hevc = body.hevc;
      if (typeof body.av1 === 'boolean') mvClientCaps.av1 = body.av1;
      sendJson(res, 200, { hevc: mvClientCaps.hevc, av1: mvClientCaps.av1 });
      return;
    }

    /**
     * 系统媒体卡片取图（token 即凭证，绕过浏览器栅栏）。
     * 支持内嵌封面（p=<曲目 id>）与在线补全封面（u=<远端地址>）。
     */
    if (pathname === '/api/dsh-music/system-art' && req.method === 'GET') {
      if (url.searchParams.get('t') !== systemArtToken) throw statusError(403, 'invalid system-art token');
      const remote = url.searchParams.get('u');
      const art = remote !== null && remote.length > 0
        ? await fetchArtwork(remote)
        : await readCover(await ensureLibrary(), url.searchParams.get('p'));
      res.writeHead(200, {
        'content-type': art.mime,
        'content-length': art.data.length,
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
      });
      res.end(art.data);
      return;
    }

    /**
     * 媒体的"直连"通道：和 system-art 同一套 token 机制。
     * 为什么要它：Desktop 页面是 dsh-app://，媒体 src 走的是 Desktop 转发，
     * 实测转发会让流丢掉 Range/206 —— 浏览器于是认为流不可 seek，
     * 表现为"一拖进度条/快进就从头播"。让媒体直接连回环 HTTP 就正常了。
     */
    if (pathname === '/api/dsh-music/system-stream' && req.method === 'GET') {
      if (url.searchParams.get('t') !== systemStreamToken) throw statusError(403, 'invalid system-stream token');
      const cacheKey = url.searchParams.get('k');
      if (typeof cacheKey === 'string' && cacheKey.length > 0) {
        // MV 的转码缓存文件也走这条直连：相对地址经 Desktop 转发同样会丢 Range。
        if (!/^[a-f0-9]{16,64}$/.test(cacheKey)) throw statusError(400, 'bad mv cache key');
        const file = mvOutputFor(cacheKey);
        let stat;
        try {
          stat = await fs.stat(file);
        } catch {
          throw statusError(404, 'mv cache miss');
        }
        serveFileRange(file, 'video/mp4', stat, req, res);
        return;
      }
      await streamTrack(await ensureLibrary(), url.searchParams.get('p'), req, res);
      return;
    }

    /**
     * 会话信息：告诉客户端系统取图该用哪个**绝对**地址（Chromium 的 artwork
     * 只收 http/https/data/blob，Desktop 页面是 dsh-app://，必须换成回环 http）。
     *
     * ⚠️ 基址的**主机名固定写成回环字面量 `127.0.0.1`**，只从请求 Host 里取端口。
     * 不回显请求 Host 的主机名：Host 是外部输入，回显会让基址跟着 Host 走
     * （A5-03 的放大器路径），而这里要保证的是「客户端拿到的一定是本机回环」。
     * 两个 token **按用途分签**：art 只签发图，stream 只签取媒体（A5-02），
     * 任一 token 都通不过另一个端点。
     */
    if (pathname === '/api/dsh-music/session' && req.method === 'GET') {
      const authority = loopbackAuthority(req);
      sendJson(res, 200, {
        systemArtBase: 'http://' + authority + '/dsh-music/api/system-art?t=' + encodeURIComponent(systemArtToken),
        systemStreamBase: 'http://' + authority + '/dsh-music/api/system-stream?t=' + encodeURIComponent(systemStreamToken),
      });
      return;
    }

    if (pathname === '/api/dsh-music/delete' && req.method === 'POST') {
      const body = await readJson(req);
      const id = typeof body.id === 'string' ? body.id : '';
      await ready;
      if (library === null) throw statusError(409, '尚未选择音乐目录');
      // 只允许删除当前库里的曲目：先按稳定 id 命中扫描列表，再做与
      // streamTrack 相同的越界校验——库外路径根本到不了 unlink。
      const trackIndex = library.tracks.findIndex((item) => item.id === id);
      if (trackIndex < 0) throw statusError(404, 'track not in current library');
      const track = library.tracks[trackIndex];
      const resolved = path.resolve(library.dir, id);
      const rootWithSep = library.dir.endsWith(path.sep) ? library.dir : library.dir + path.sep;
      if (id.length === 0 || (resolved !== library.dir && !resolved.startsWith(rootWithSep)) || path.resolve(track.path) !== resolved) {
        throw statusError(403, 'path escapes the music directory');
      }
      try {
        // 副作用位置授权：删除只能作用于当前库目录内的曲目（fs.delete scope）。
        await fs.unlink(authorize('fs.delete', track.path, [library.dir]));
      } catch {
        throw statusError(500, '无法删除文件：' + track.name);
      }
      library.tracks.splice(trackIndex, 1);
      library.scannedAt = Date.now();
      coverCache.delete(id);
      sendJson(res, 200, libraryPayload(library));
      return;
    }

    sendJson(res, 404, { error: 'unknown dsh-music endpoint' });
  }

  /**
   * Web 旧入口（`/dsh-music` 前缀路由）：插件自己守一道浏览器信任栅栏，
   * 与平台 /api 的 Host/Origin 栅栏同构。
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // token 通道（系统取图 / 媒体直连）的请求来自 Chromium 内部（带
    // `Origin: dsh-app://app` + `Sec-Fetch-Site: cross-site`），页面本身补不了头，
    // 所以必须豁免 **Origin / Sec-Fetch** 判定；凭证是 URL 里的 token。
    //
    // 但豁免**到此为止**：仍然要求 Host 是回环字面量。完整豁免等于把「读库内任意
    // 文件」的能力挂在一个不吃 Host/Origin 的入口上 —— 宿主一旦绑非回环
    // （trustedHosts LAN 服务），该端点就暴露给网络了（A5-03）。
    const isSystemPath = ['/dsh-music/api/system-art', '/api/dsh-music/system-art',
      '/dsh-music/api/system-stream', '/api/dsh-music/system-stream'].includes(url.pathname);
    if (isSystemPath) {
      if (!isLoopbackHostRequest(req)) throw statusError(403, 'system endpoint requires a loopback host');
    } else if (isUntrustedRequest(req)) {
      throw statusError(403, 'untrusted request rejected');
    }
    return dispatch(req, res);
  }

  /**
   * 统一入口：`connection.fetch.register` 注册的 /api/dsh-music/* 用它。
   * 同一份路由实现同时服务 Web 与 DSH Desktop——Desktop 没有 webServer 服务，
   * 旧入口永远不会被装配，只有这条 Fetch 通路能到。
   */
  function handleFetch(request) {
    return fetchFromNodeHandler(request, (req, res) => dispatch(req, res));
  }

  /**
   * 释放这个实例：停止在途扫描（结果已无人消费）并丢掉库与全部缓存。
   * 插件停用/卸载、以及热重载换新实例前都会调用。
   */
  function dispose() {
    scanGeneration += 1;
    library = null;
    clearCoverCache();
    clearArtCache();
    clearMatchCache();
    // 在飞 ffmpeg 与它们的容器：漏掉这一步，停用/热重载后子进程会继续跑到结束
    // 往临时目录写 .part，module 级 Map 也会被不可回收的 ESM 条目永久钉住（A1-03）。
    killAllMvJobs('插件已停用');
    // 测量同样要停：漏掉这一步，热重载/停用后 ffmpeg 会继续跑到结束（I-06 孤儿进程）。
    stopRgMeasure('插件已停用');
    stopWaveform('插件已停用');
    // 导入的 yt-dlp 也可能在写 .part；停用/热重载后不能留孤儿进程。
    for (const job of importJobs.values()) {
      job.cancelled = true;
      if (job.child !== null) {
        try {
          job.child.kill('SIGKILL');
        } catch {
          // 已退出
        }
      }
      void cleanupImportTemp(job);
    }
    importJobs.clear();
    importQueue.length = 0;
    importRunning = 0;
    // 标签 worker 也必须随实例销毁：热重载/停用后不能留着旧线程。
    failAllTagJobs('插件已停用');
    if (tagWorker !== null) {
      try {
        tagWorker.terminate();
      } catch {
        // terminate is best-effort
      }
      tagWorker = null;
    }
  }

  return { handle, handleFetch, dispatch, dispose };
}

export { createHost };
