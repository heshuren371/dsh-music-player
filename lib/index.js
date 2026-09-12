import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';

/** Cordis plugin identity used by Loader diagnostics. */
const name = 'music-player';
/** The route owner needs the Web HTTP registry; directoryPicker is optional (ctx.get). */
const inject = ['webServer'];

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

const MAX_TRACKS = 5000;
const MAX_SCAN_DEPTH = 6;
const SCAN_VISIT_LIMIT = 20000;
const METADATA_CONCURRENCY = 8;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

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
const LEGACY_STATE_FILE = fileURLToPath(new URL('./state.json', import.meta.url));

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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
  const chunks = [];
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
    const tmp = path.join(STATE_DIR, '.dsh-music-player.json.tmp');
    await fs.writeFile(tmp, JSON.stringify({ dir }, null, 2), 'utf8');
    await fs.rename(tmp, STATE_FILE);
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
  const files = [];
  let truncated = false;
  const stack = [{ directory: dir, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < SCAN_VISIT_LIMIT) {
    if (typeof isCancelled === 'function' && isCancelled()) return { files, truncated: true };
    if (files.length >= MAX_TRACKS) {
      truncated = true;
      break;
    }
    const current = stack.pop();
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
        if (current.depth < MAX_SCAN_DEPTH && !SKIP_DIRS.has(row.name)) {
          stack.push({ directory: absolute, depth: current.depth + 1 });
        }
        continue;
      }
      if (!row.isFile()) continue;
      const mime = AUDIO_EXTENSIONS.get(path.extname(row.name).toLowerCase());
      if (mime === undefined) continue;
      files.push({ path: absolute, mime });
    }
  }
  // 深度优先扫描因访问上限提前退出时（目录栈仍非空），同样要标记截断，
  // 否则 UI 会把它当成一次完整扫描。
  if (!truncated && visited >= SCAN_VISIT_LIMIT && stack.length > 0) {
    truncated = true;
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'zh-Hans-CN', { numeric: true }));
  return { files, truncated };
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

async function readMetadata(file) {
  const track = {
    path: file.path,
    name: path.basename(file.path),
    title: fallbackTitle(file.path),
    artist: fallbackArtist(file.path),
    duration: null,
    mime: file.mime,
  };
  try {
    const metadata = await parseFile(file.path, { duration: true, skipCovers: true });
    const common = metadata.common;
    if (typeof common.title === 'string' && common.title.trim().length > 0) track.title = common.title.trim();
    const artist = common.artist ?? (Array.isArray(common.artists) ? common.artists[0] : undefined);
    if (typeof artist === 'string' && artist.trim().length > 0) track.artist = artist.trim();
    if (typeof metadata.format.duration === 'number' && Number.isFinite(metadata.format.duration)) {
      track.duration = Math.round(metadata.format.duration * 10) / 10;
    }
  } catch {
    // Unparseable/corrupt tags still list and stream; fall back to filename info.
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

async function scanLibrary(dir, onProgress, isCancelled) {
  const { files, truncated } = await collectAudioFiles(dir, isCancelled);
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
  return { dir, tracks, truncated, scannedAt: Date.now() };
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
function pipeFile(res, filePath, options) {
  const stream = createReadStream(filePath, options);
  res.on('close', () => stream.destroy());
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

  const range = parseRange(req.headers.range, stat.size);
  if (range !== null && range.unsatisfiable === true) {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  if (range !== null) {
    res.writeHead(206, {
      'content-type': track.mime,
      'content-length': range.end - range.start + 1,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    });
    pipeFile(res, track.path, { start: range.start, end: range.end });
    return;
  }
  res.writeHead(200, {
    'content-type': track.mime,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  });
  pipeFile(res, track.path);
}

function apply(ctx) {
  /** Current music directory (null = not chosen yet); persisted across restarts. */
  let currentDir = null;
  /** Scanned library cache; invalidated whenever the directory changes. */
  let library = null;
  let scanning = null;
  /** Directory the in-flight scan belongs to (scan reuse key). */
  let scanningDir = null;
  /** Monotonic scan generation: a stale scan finishing late must not clobber a
   *  newer directory's library (setDirectory A slow, then B fast), and a
   *  superseded scan stops parsing files whose result would be discarded. */
  let scanGeneration = 0;
  /** Live scan progress for the UI (reset at every scan start). */
  const scanProgress = { parsed: 0, total: 0 };

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
  })();

  async function setDirectory(dir) {
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

  function libraryPayload(result) {
    const base = {
      dir: currentDir,
      scanning: scanning !== null,
      scanParsed: scanProgress.parsed,
      scanTotal: scanProgress.total,
    };
    if (result === null) return { ...base, tracks: [], scannedAt: null, truncated: false };
    return {
      ...base,
      dir: result.dir,
      scannedAt: result.scannedAt,
      truncated: result.truncated === true,
      // Only fields the UI reads (id/name/title/artist/duration): index is
      // implied by array order and mime is only needed by streamTrack.
      tracks: result.tracks.map((track) => ({
        id: track.id,
        name: track.name,
        title: track.title,
        artist: track.artist,
        duration: track.duration,
      })),
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
    let cover = null;
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

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw statusError(400, 'malformed request path');
    }

    if (isUntrustedRequest(req)) throw statusError(403, 'untrusted request rejected');

    if (pathname === '/dsh-music/api/library' && req.method === 'GET') {
      // Non-blocking: report scan progress instead of waiting for the scan.
      await ready;
      if (currentDir !== null && library === null && scanning === null) startScan(currentDir).catch(() => {});
      sendJson(res, 200, libraryPayload(library));
      return;
    }

    if (pathname === '/dsh-music/api/refresh' && req.method === 'POST') {
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

    if (pathname === '/dsh-music/api/dir' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body.dir !== 'string' || body.dir.trim().length === 0) throw statusError(400, 'dir is required');
      await setDirectory(body.dir.trim());
      clearCoverCache();
      sendJson(res, 200, libraryPayload(library));
      return;
    }

    if (pathname === '/dsh-music/api/cover' && req.method === 'GET') {
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

    if (pathname === '/dsh-music/api/pick' && req.method === 'POST') {
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

    if (pathname === '/dsh-music/api/stream' && req.method === 'GET') {
      await streamTrack(await ensureLibrary(), url.searchParams.get('p'), req, res);
      return;
    }

    if (pathname === '/dsh-music/api/delete' && req.method === 'POST') {
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
        await fs.unlink(track.path);
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

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-music',
      handler: async (req, res) => {
        try {
          await handle(req, res);
        } catch (error) {
          if (res.headersSent) {
            res.destroy(error instanceof Error ? error : undefined);
            return;
          }
          const statusCode = Number.isSafeInteger(error?.statusCode) ? error.statusCode : 500;
          sendJson(res, statusCode, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    });
    return () => {
      // Plugin disabled/uninstalled: stop an in-flight scan (its result could
      // never be consumed) and release the library + cover buffers right away.
      scanGeneration += 1;
      library = null;
      clearCoverCache();
      disposeRoute();
    };
  }, 'music-player: local music API');
}

export { apply, inject, name };
