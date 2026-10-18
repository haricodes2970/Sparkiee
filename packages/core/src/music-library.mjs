/**
 * Safe, read-only music library indexer.
 *
 * Boundary rules (enforced, not assumed):
 * - Roots default to ~/Music (explicitly echoed in status so any change is
 *   deliberate); override with SPARKIEE_MUSIC_ROOTS (colon-separated).
 * - Symlinks are never followed — entries are classified with lstat, and
 *   symbolic links are skipped even when they point inside the root. This
 *   keeps the library a plain tree with no escape surface.
 * - Only allowlisted extensions are indexed (MP3 now; the list is the
 *   deliberate extension point for future formats).
 * - Every indexed file is re-verified (realpath containment + regular file)
 *   before its path is handed to a playback backend.
 * - The library never modifies, renames, moves or deletes music files.
 *
 * Metadata comes from ffprobe when available (title/artist/album/duration),
 * falling back to filename stems so untagged files still work. Track ids are
 * opaque sha1 prefixes of the root-relative path — absolute paths never
 * appear in API-facing records.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Default root: the user's Music directory. Explicit and overridable. */
export const DEFAULT_MUSIC_ROOT = path.join(os.homedir(), 'Music');

/** Deliberate format allowlist — extend here when adding formats on purpose. */
export const MUSIC_FORMATS = Object.freeze(['mp3']);

const MAX_FILENAME_STEM = 120;

/** Words stripped from the token tier so "the madira" still matches "Madira". */
const SEARCH_FILLER_WORDS = new Set(['the', 'a', 'an', 'my', 'that', 'this', 'song', 'track', 'by']);

function musicError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Resolve the configured roots, validating each is a non-empty string. */
export function resolveMusicRoots(env = process.env) {
  const raw = typeof env.SPARKIEE_MUSIC_ROOTS === 'string' ? env.SPARKIEE_MUSIC_ROOTS.trim() : '';
  const roots = raw.length > 0
    ? raw.split(':').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [DEFAULT_MUSIC_ROOT];
  if (roots.length === 0) throw musicError('INVALID_MUSIC_ROOTS', 'SPARKIEE_MUSIC_ROOTS resolved to no roots.');
  return Object.freeze(roots.map((root) => path.resolve(root)));
}

/** Filename stem (extension removed) as the display fallback. */
export function filenameStem(filePath) {
  const stem = path.basename(filePath, path.extname(filePath)).trim();
  return stem.length > MAX_FILENAME_STEM ? `${stem.slice(0, MAX_FILENAME_STEM)}…` : stem;
}

/**
 * Normalize text for matching: case- and diacritic-insensitive, punctuation
 * and extra spacing collapsed. "Madira", "madira", "MADÍRA!" all compare
 * equal; "The Madira" still token-matches "Madira".
 */
export function normalizeForMatch(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Levenshtein distance, capped for suggestion scoring. */
function editDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > cap) return cap + 1;
    previous = row;
  }
  return previous[b.length];
}

function trackIdFor(relativePath) {
  return createHash('sha1').update(relativePath).digest('hex').slice(0, 16);
}

/** ffprobe JSON metadata probe with a hard timeout. Null on any failure. */
export function createFfprobeProbe({ spawnImpl = spawn, timeoutMs = 5000 } = {}) {
  return function probe(filePath) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      let child;
      try {
        child = spawnImpl('ffprobe', [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_format',
          filePath,
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        finish(null);
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(null);
      }, timeoutMs);
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', () => { clearTimeout(timer); finish(null); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          // ffprobe exits non-zero for missing/corrupt media (and may still
          // print "{}") — never invent metadata for a file it rejected.
          finish(null);
          return;
        }
        try {
          const parsed = JSON.parse(out);
          const format = parsed?.format ?? {};
          const tags = format.tags ?? {};
          const durationMs = Number.isFinite(Number(format.duration))
            ? Math.round(Number(format.duration) * 1000)
            : null;
          finish({
            title: typeof tags.title === 'string' && tags.title.trim() ? tags.title.trim() : null,
            artist: typeof tags.artist === 'string' && tags.artist.trim() ? tags.artist.trim() : null,
            album: typeof tags.album === 'string' && tags.album.trim() ? tags.album.trim() : null,
            durationMs: durationMs !== null && durationMs > 0 ? durationMs : null,
          });
        } catch {
          finish(null);
        }
      });
    });
  };
}

/** Run tasks with bounded concurrency. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Build a music library over the configured roots.
 *
 * @param {object} [options]
 * @param {string[]} [options.roots] Roots to index (validated + canonicalised).
 * @param {string[]} [options.formats] Extension allowlist (default: mp3).
 * @param {(filePath: string) => Promise<object|null>} [options.probe]
 *   Metadata probe; default ffprobe. Injectable for tests.
 * @param {() => number} [options.now] Clock.
 * @param {number} [options.rescanCooldownMs] Debounce for manual rescans.
 */
export function createMusicLibrary({
  roots = resolveMusicRoots(),
  formats = MUSIC_FORMATS,
  probe = createFfprobeProbe(),
  now = () => Date.now(),
  rescanCooldownMs = 3000,
} = {}) {
  const extensionSet = new Set(formats.map((format) => `.${format.toLowerCase()}`));
  let canonicalRoots = null; // lazily realpath'd; null = not resolvable yet
  let tracks = [];           // { id, relativePath, displayName, title, artist, album, durationMs, sizeBytes, rootIndex }
  let scannedAt = null;
  let lastError = null;
  let scanInFlight = null;
  let lastScanAt = 0;

  async function canonicaliseRoots() {
    const resolved = [];
    for (const root of roots) {
      try {
        const real = await realpath(root);
        const info = await stat(real);
        if (info.isDirectory()) resolved.push({ configured: root, real });
      } catch {
        // Missing/unreadable root: recorded honestly in status, not fatal.
      }
    }
    return resolved;
  }

  /** Depth-first walk collecting regular mp3 files; never follows links. */
  async function walk(dir, rootReal, files) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subdirectory: skip, keep the rest of the scan
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // hard rule: no symlink following
      if (entry.isDirectory()) {
        await walk(absolute, rootReal, files);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensionSet.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(absolute);
    }
  }

  async function scan() {
    if (scanInFlight) return scanInFlight;
    scanInFlight = (async () => {
      lastScanAt = now();
      try {
        const resolvedRoots = await canonicaliseRoots();
        canonicalRoots = resolvedRoots;
        const collected = [];
        for (let rootIndex = 0; rootIndex < resolvedRoots.length; rootIndex += 1) {
          const { real } = resolvedRoots[rootIndex];
          const files = [];
          await walk(real, real, files);
          for (const absolute of files) collected.push({ absolute, rootIndex });
        }
        const scanned = await mapLimit(collected, 4, async ({ absolute, rootIndex }) => {
          const { real } = resolvedRoots[rootIndex];
          // Defence in depth: confirm containment + regular file post-walk.
          let canonical;
          try {
            canonical = await realpath(absolute);
            const info = await lstat(canonical);
            if (!info.isFile()) return null;
          } catch {
            return null;
          }
          const relativePath = path.relative(real, canonical);
          if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
          const meta = await probe(canonical).catch(() => null);
          let sizeBytes = null;
          try {
            sizeBytes = (await stat(canonical)).size;
          } catch {
            return null; // vanished between walk and probe
          }
          const stem = filenameStem(canonical);
          return {
            id: trackIdFor(`${rootIndex}:${relativePath}`),
            relativePath,
            displayName: meta?.title || stem,
            title: meta?.title || null,
            artist: meta?.artist || null,
            album: meta?.album || null,
            durationMs: meta?.durationMs || null,
            sizeBytes,
            rootIndex,
          };
        });
        tracks = scanned.filter(Boolean);
        tracks.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        scannedAt = new Date(now()).toISOString();
        lastError = null;
      } catch (error) {
        lastError = error?.message || String(error);
      } finally {
        scanInFlight = null;
      }
      return status();
    })();
    return scanInFlight;
  }

  /** True when `candidate` sits inside `rootReal` as a regular file. */
  async function containedFile(rootReal, candidate) {
    try {
      const canonical = await realpath(candidate);
      const relative = path.relative(rootReal, canonical);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
      const info = await lstat(canonical);
      if (!info.isFile()) return null;
      return canonical;
    } catch {
      return null;
    }
  }

  /** Live availability check for one track (stat only — no tree walk). */
  async function trackAvailable(track) {
    const root = canonicalRoots?.[track.rootIndex];
    if (!root) return false;
    const canonical = await containedFile(root.real, path.join(root.real, track.relativePath));
    return canonical !== null;
  }

  function publicRecord(track, available) {
    return {
      id: track.id,
      name: track.displayName,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs,
      sizeBytes: track.sizeBytes,
      file: path.basename(track.relativePath),
      available,
    };
  }

  function status() {
    return {
      roots: roots.map((root, index) => ({
        path: root,
        available: Boolean(canonicalRoots?.[index]),
      })),
      formats: [...extensionSet].map((extension) => extension.slice(1)),
      trackCount: tracks.length,
      scannedAt,
      rescanInFlight: Boolean(scanInFlight),
      lastError,
    };
  }

  return {
    status,
    /**
     * Rescan (coalesced). Honours a short cooldown so dashboard buttons and
     * voice commands cannot stampede the filesystem; an in-flight scan is
     * always awaited rather than duplicated.
     */
    async rescan({ force = false } = {}) {
      if (!force && scanInFlight) return scanInFlight;
      if (!force && now() - lastScanAt < rescanCooldownMs) return status();
      return scan();
    },
    /** Kick an initial scan at startup — non-blocking for the caller. */
    prime() {
      return scan();
    },
    /** List tracks (fresh availability), optionally filtered by query. */
    async list({ query = '', limit = 200 } = {}) {
      const cappedLimit = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 200)));
      const ranked = querySearchTracks(query);
      const slice = ranked.slice(0, cappedLimit);
      const records = await Promise.all(
        slice.map(async (track) => publicRecord(track, await trackAvailable(track))),
      );
      return { tracks: records, total: ranked.length, query: String(query ?? '') };
    },
    /**
     * Ranked search over titles, filenames and metadata.
     * Tiers: exact title/filename → prefix/word-boundary → all-tokens
     * contained → near-miss suggestions (edit distance) when nothing matches.
     */
    search(query, { limit = 10 } = {}) {
      const matches = querySearchTracks(query)
        .slice(0, Math.min(50, Math.max(1, Math.trunc(Number(limit) || 10))))
        .map((track) => publicRecord(track, true));
      return matches;
    },
    /** Internal: resolve an opaque id to a validated absolute path. */
    async resolvePath(trackId) {
      if (typeof trackId !== 'string' || !/^[0-9a-f]{16}$/.test(trackId)) return null;
      const track = tracks.find((candidate) => candidate.id === trackId);
      if (!track) return null;
      const root = canonicalRoots?.[track.rootIndex];
      if (!root) return null;
      return containedFile(root.real, path.join(root.real, track.relativePath));
    },
    /** Internal: ordered track records for queue building. */
    orderedTracks() {
      return tracks.map((track) => ({ ...track }));
    },
    async isAvailable(trackId) {
      const track = tracks.find((candidate) => candidate.id === trackId);
      if (!track) return false;
      return trackAvailable(track);
    },
  };

  /** Ranking engine, closed over `tracks` (refreshed by scan). */
  function querySearchTracks(rawQuery) {
    const query = normalizeForMatch(rawQuery);
    if (!query) return tracks;
    const queryTokens = query.split(' ').filter(Boolean);
    const contentTokens = queryTokens.filter((token) => !SEARCH_FILLER_WORDS.has(token));
    const effectiveTokens = contentTokens.length > 0 ? contentTokens : queryTokens;
    const scored = [];
    for (const track of tracks) {
      const title = normalizeForMatch(track.title || '');
      const stem = normalizeForMatch(filenameStem(track.relativePath));
      const haystack = normalizeForMatch([track.title, track.artist, track.album, track.relativePath].filter(Boolean).join(' '));
      let score = 0;
      if (title === query || stem === query) score = 100;
      else if (title.startsWith(`${query} `) || stem.startsWith(`${query} `)) score = 80;
      else if (title.includes(query) || stem.includes(query)) score = 60;
      else if (effectiveTokens.length > 0 && effectiveTokens.every((token) => haystack.includes(token))) score = 40;
      if (score > 0) scored.push({ track, score });
    }
    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score || a.track.relativePath.localeCompare(b.track.relativePath));
      return scored.map((entry) => entry.track);
    }
    // Near-miss suggestions: single content-token queries, small edit distance.
    if (effectiveTokens.length === 1) {
      const token = effectiveTokens[0];
      const suggestions = [];
      for (const track of tracks) {
        for (const candidate of [normalizeForMatch(track.title || ''), normalizeForMatch(filenameStem(track.relativePath))]) {
          if (!candidate) continue;
          const distance = editDistance(token, candidate);
          if (distance <= 2) suggestions.push({ track, distance });
          break;
        }
      }
      suggestions.sort((a, b) => a.distance - b.distance);
      return suggestions.map((entry) => entry.track);
    }
    return [];
  }
}
