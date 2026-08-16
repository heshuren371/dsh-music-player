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

const STATE_FILE = fileURLToPath(new URL('./state.json', import.meta.url));

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return typeof parsed.dir === 'string' && parsed.dir.length > 0 ? parsed.dir : null;
  } catch {
    return null;
  }
}

async function saveState(dir) {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify({ dir }, null, 2), 'utf8');
  } catch {
    // State persistence is best-effort; a read-only plugin dir must not break playback.
  }
}

/** Recursively collect audio files under dir (skip hidden entries and tooling dirs). */
async function collectAudioFiles(dir) {
  const files = [];
  let truncated = false;
  const stack = [{ directory: dir, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < SCAN_VISIT_LIMIT) {
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

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = next;
      next += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

async function scanLibrary(dir, onProgress) {
  const { files, truncated } = await collectAudioFiles(dir);
  let parsed = 0;
  const tracks = await mapLimit(files, METADATA_CONCURRENCY, async (file) => {
    const track = await readMetadata(file);
    parsed += 1;
    if (typeof onProgress === 'function') onProgress(parsed, files.length);
    return track;
  });
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
    createReadStream(track.path, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'content-type': track.mime,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  });
  createReadStream(track.path).pipe(res);
}

function apply(ctx) {
  /** Current music directory (null = not chosen yet); persisted across restarts. */
  let currentDir = null;
  /** Scanned library cache; invalidated whenever the directory changes. */
  let library = null;
  let scanning = null;
  /** Monotonic scan generation: a stale scan finishing late must not clobber a
   *  newer directory's library (setDirectory A slow, then B fast). */
  let scanGeneration = 0;
  /** Live scan progress for the UI (reset at every scan start). */
  const scanProgress = { parsed: 0, total: 0 };

  function startScan(dir) {
    const generation = ++scanGeneration;
    scanProgress.parsed = 0;
    scanProgress.total = 0;
    const promise = scanLibrary(dir, (parsed, total) => {
      if (generation === scanGeneration) {
        scanProgress.parsed = parsed;
        scanProgress.total = total;
      }
    }).then((result) => {
      if (generation === scanGeneration && currentDir === dir) library = result;
      if (scanning === promise) scanning = null;
      return generation === scanGeneration && currentDir === dir ? result : null;
    }).catch((error) => {
      if (scanning === promise) scanning = null;
      throw error;
    });
    scanning = promise;
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
    const resolved = path.resolve(dir);
    const stat = await fs.stat(resolved);
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
      tracks: result.tracks.map((track, index) => ({
        index,
        id: track.id,
        name: track.name,
        title: track.title,
        artist: track.artist,
        duration: track.duration,
        mime: track.mime,
      })),
    };
  }

  /** In-memory cover art cache: id → { data, mime } (bounded, newest wins). */
  const coverCache = new Map();
  const COVER_CACHE_LIMIT = 200;

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
        cover = { data: Buffer.from(picture.data), mime: picture.format || 'image/jpeg' };
      }
    } catch {
      // Unparseable file → treat as no cover.
    }
    if (coverCache.size >= COVER_CACHE_LIMIT) coverCache.delete(coverCache.keys().next().value);
    coverCache.set(id, cover);
    if (cover === null) throw statusError(404, 'no embedded cover');
    return cover;
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

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
      coverCache.clear();
      startScan(currentDir).catch(() => {});
      sendJson(res, 200, libraryPayload(null));
      return;
    }

    if (pathname === '/dsh-music/api/dir' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body.dir !== 'string' || body.dir.trim().length === 0) throw statusError(400, 'dir is required');
      await setDirectory(body.dir.trim());
      coverCache.clear();
      sendJson(res, 200, libraryPayload(library));
      return;
    }

    if (pathname === '/dsh-music/api/cover' && req.method === 'GET') {
      const cover = await readCover(await ensureLibrary(), url.searchParams.get('p'));
      res.writeHead(200, {
        'content-type': cover.mime,
        'content-length': cover.data.length,
        'cache-control': 'private, max-age=3600',
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

    sendJson(res, 404, { error: 'unknown dsh-music endpoint' });
  }

  ctx.effect(() => ctx.webServer.register({
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
  }), 'music-player: local music API');
}

export { apply, inject, name };
