/**
 * Local cache for generated speech clips.
 *
 * Clips live under $XDG_CACHE_HOME/sparkiee/voice (never in the repo or
 * git). Keys are sha256 hex from synthesisCacheKey, so filenames are
 * path-safe by construction and traversal is impossible.
 *
 * A size cap triggers LRU-style pruning (oldest mtime first) on write.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_CACHE_BYTES = 25 * 1024 * 1024; // 25 MB
const KEY_PATTERN = /^[a-f0-9]{64}$/;

const EXTENSIONS = Object.freeze({
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/pcm': 'pcm',
});

function assertKey(key) {
  if (!KEY_PATTERN.test(String(key ?? ''))) {
    const error = new Error('cache key must be a 64-character hex digest');
    error.code = 'INVALID_CACHE_KEY';
    throw error;
  }
}

function extensionFor(mime) {
  return EXTENSIONS[mime] ?? 'bin';
}

/**
 * @param {object} options
 * @param {string} options.dir Absolute cache directory.
 * @param {number} [options.maxBytes]
 */
export function createAudioCache({ dir, maxBytes = DEFAULT_MAX_CACHE_BYTES } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new Error('audio cache requires a directory');
  }
  const root = path.resolve(dir);

  function clipPath(key, mime = 'audio/mpeg') {
    assertKey(key);
    const resolved = path.join(root, `${key}.${extensionFor(mime)}`);
    // Defence in depth even though keys are hex-only.
    if (!resolved.startsWith(root + path.sep)) {
      const error = new Error('resolved clip path escapes the cache directory');
      error.code = 'CACHE_PATH_ESCAPE';
      throw error;
    }
    return resolved;
  }

  async function ensureDir() {
    await mkdir(root, { recursive: true, mode: 0o700 });
  }

  async function totalBytes() {
    let entries;
    try {
      entries = await readdir(root);
    } catch {
      return { bytes: 0, files: 0 };
    }
    let bytes = 0;
    let files = 0;
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(entry)) continue;
      try {
        const info = await stat(path.join(root, entry));
        if (info.isFile()) {
          bytes += info.size;
          files += 1;
        }
      } catch {
        // raced with pruning; ignore
      }
    }
    return { bytes, files };
  }

  async function prune() {
    const { bytes } = await totalBytes();
    if (bytes <= maxBytes) return;
    let entries;
    try {
      entries = await readdir(root);
    } catch {
      return;
    }
    const clips = [];
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(entry)) continue;
      try {
        const info = await stat(path.join(root, entry));
        clips.push({ file: path.join(root, entry), mtime: info.mtimeMs, size: info.size });
      } catch {
        // ignore
      }
    }
    clips.sort((a, b) => a.mtime - b.mtime); // oldest first
    let current = bytes;
    for (const clip of clips) {
      if (current <= maxBytes) break;
      await rm(clip.file, { force: true });
      current -= clip.size;
    }
  }

  return Object.freeze({
    dir: root,
    async get(key, mime = 'audio/mpeg') {
      const file = clipPath(key, mime);
      try {
        const audio = await readFile(file);
        // Refresh mtime so frequently used phrases survive pruning.
        await writeFile(file, audio, { mode: 0o600 }).catch(() => {});
        return audio;
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async put(key, audio, mime = 'audio/mpeg') {
      assertKey(key);
      if (!Buffer.isBuffer(audio) || audio.length === 0) return null;
      await ensureDir();
      const file = clipPath(key, mime);
      await writeFile(file, audio, { mode: 0o600 });
      await prune();
      return file;
    },
    async stats() {
      return totalBytes();
    },
    async clear() {
      await rm(root, { recursive: true, force: true });
    },
  });
}
