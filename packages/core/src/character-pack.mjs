import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const SUPPORTED_ANIMATION_IDS = Object.freeze([
  'idle',
  'wave',
  'walk',
  'run',
  'dance',
  'sleep',
  'surprised',
  'confused',
  'thinking',
  'celebrate',
  'task_complete',
  'task_error',
  'permission_required',
]);

export const SUPPORTED_AUDIO_FORMATS = Object.freeze(['.wav', '.ogg', '.mp3']);
const MAX_FRAME_MS = 2_000;
const MIN_FRAME_MS = 16;
const MAX_FRAMES_PER_ANIMATION = 24;

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * Validate a character pack manifest without touching the filesystem.
 * Returns a list of human-readable errors; an empty list means valid.
 *
 * @param {unknown} manifest Parsed manifest.json contents.
 * @returns {string[]}
 */
export function validateCharacterPackManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) {
    return ['manifest must be a JSON object'];
  }
  if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(manifest.id)) {
    errors.push('id must match /^[a-z0-9][a-z0-9-]{1,63}$/');
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0 || manifest.name.length > 48) {
    errors.push('name must be a non-empty string of at most 48 characters');
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    errors.push('version must be a semantic version string like 1.0.0');
  }
  if (typeof manifest.description !== 'string' || manifest.description.length > 300) {
    errors.push('description must be a string of at most 300 characters');
  }
  if (!isPlainObject(manifest.license) || typeof manifest.license.type !== 'string' || manifest.license.type.length === 0) {
    errors.push('license.type must be a non-empty string (for example "original" or "CC0-1.0")');
  }

  const sheet = manifest.spriteSheet;
  if (!isPlainObject(sheet)) {
    errors.push('spriteSheet must be an object');
  } else {
    if (!isSafeRelativePath(sheet.file) || !sheet.file.toLowerCase().endsWith('.png')) {
      errors.push('spriteSheet.file must be a relative .png path inside the pack');
    }
    for (const key of ['frameWidth', 'frameHeight', 'columns']) {
      if (!Number.isInteger(sheet[key]) || sheet[key] < 8 || sheet[key] > 512) {
        errors.push(`spriteSheet.${key} must be an integer from 8 to 512`);
      }
    }
  }

  const animations = manifest.animations;
  if (!isPlainObject(animations)) {
    errors.push('animations must be an object keyed by animation id');
  } else {
    const ids = Object.keys(animations);
    for (const id of SUPPORTED_ANIMATION_IDS) {
      if (!ids.includes(id)) errors.push(`animations.${id} is required`);
    }
    for (const id of ids) {
      if (!SUPPORTED_ANIMATION_IDS.includes(id)) {
        errors.push(`animations.${id} is not a supported animation id`);
        continue;
      }
      const animation = animations[id];
      if (!isPlainObject(animation)) {
        errors.push(`animations.${id} must be an object`);
        continue;
      }
      const frames = animation.frames;
      if (!Array.isArray(frames) || frames.length === 0 || frames.length > MAX_FRAMES_PER_ANIMATION) {
        errors.push(`animations.${id}.frames must be a non-empty array of at most ${MAX_FRAMES_PER_ANIMATION} frames`);
      } else if (frames.some((frame) => !Number.isInteger(frame) || frame < 0 || frame > 2_000)) {
        errors.push(`animations.${id}.frames must contain non-negative integers`);
      }
      if (!Number.isInteger(animation.frameMs) || animation.frameMs < MIN_FRAME_MS || animation.frameMs > MAX_FRAME_MS) {
        errors.push(`animations.${id}.frameMs must be an integer from ${MIN_FRAME_MS} to ${MAX_FRAME_MS}`);
      }
      if (typeof animation.loop !== 'boolean') {
        errors.push(`animations.${id}.loop must be a boolean`);
      }
    }
  }

  const voice = manifest.voice;
  if (!isPlainObject(voice)) {
    errors.push('voice must be an object');
  } else {
    if (!['synth', 'clips'].includes(voice.style)) {
      errors.push('voice.style must be "synth" or "clips"');
    }
    if (!isPlainObject(voice.events) || Object.keys(voice.events).length === 0) {
      errors.push('voice.events must be a non-empty object of event descriptors');
    } else {
      for (const [event, descriptor] of Object.entries(voice.events)) {
        if (!/^[a-z][a-z0-9_]{1,32}$/.test(event)) {
          errors.push(`voice.events key "${event}" is not a valid event id`);
          continue;
        }
        if (voice.style === 'synth') {
          if (!isPlainObject(descriptor) || typeof descriptor.caption !== 'string' || descriptor.caption.length === 0 || descriptor.caption.length > 80) {
            errors.push(`voice.events.${event} must declare a caption of at most 80 characters`);
          }
          if (!isPlainObject(descriptor) || !Number.isFinite(descriptor.baseFrequency) || descriptor.baseFrequency < 200 || descriptor.baseFrequency > 4_000) {
            errors.push(`voice.events.${event}.baseFrequency must be a number from 200 to 4000`);
          }
          if (!isPlainObject(descriptor) || !Number.isFinite(descriptor.durationMs) || descriptor.durationMs < 40 || descriptor.durationMs > 3_000) {
            errors.push(`voice.events.${event}.durationMs must be a number from 40 to 3000`);
          }
        } else if (typeof descriptor !== 'string' || !isSafeRelativePath(descriptor)) {
          errors.push(`voice.events.${event} must be a relative audio path inside the pack`);
        } else if (!SUPPORTED_AUDIO_FORMATS.includes(path.extname(descriptor).toLowerCase())) {
          errors.push(`voice.events.${event} must reference a supported audio format (${SUPPORTED_AUDIO_FORMATS.join(', ')})`);
        }
      }
    }
  }

  const layout = manifest.layout;
  if (!isPlainObject(layout)) {
    errors.push('layout must be an object');
  } else {
    for (const key of ['windowWidth', 'windowHeight']) {
      if (!Number.isInteger(layout[key]) || layout[key] < 32 || layout[key] > 2_000) {
        errors.push(`layout.${key} must be an integer from 32 to 2000`);
      }
    }
    if (!Number.isFinite(layout.spriteScale) || layout.spriteScale < 1 || layout.spriteScale > 16) {
      errors.push('layout.spriteScale must be a number from 1 to 16');
    }
  }

  return errors;
}

/**
 * Resolve a manifest-relative asset path while guaranteeing it stays inside
 * the pack directory (no `..`, absolute paths, or symlink escapes).
 *
 * @param {string} packDir Absolute path of the character pack directory.
 * @param {string} relativePath Manifest-declared relative path.
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function safeResolveAssetPath(packDir, relativePath) {
  if (typeof packDir !== 'string' || packDir.length === 0) {
    return { ok: false, reason: 'packDir must be a non-empty string' };
  }
  if (!isSafeRelativePath(relativePath)) {
    return { ok: false, reason: `"${relativePath}" is not a safe pack-relative path` };
  }
  const root = path.resolve(packDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { ok: false, reason: `"${relativePath}" escapes the pack directory` };
  }
  return { ok: true, path: resolved };
}

/**
 * Load and validate a character pack from disk.
 *
 * @param {string} packDir Absolute path to a pack directory with manifest.json.
 * @returns {Promise<{ok: true, pack: object} | {ok: false, errors: string[]}>}
 */
export async function loadCharacterPack(packDir) {
  let raw;
  try {
    raw = await readFile(path.join(packDir, 'manifest.json'), 'utf8');
  } catch (error) {
    return { ok: false, errors: [`cannot read manifest.json: ${error.message}`] };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`manifest.json is not valid JSON: ${error.message}`] };
  }
  const errors = validateCharacterPackManifest(manifest);
  if (errors.length > 0) return { ok: false, errors };

  const sheet = safeResolveAssetPath(packDir, manifest.spriteSheet.file);
  if (!sheet.ok) return { ok: false, errors: [sheet.reason] };
  try {
    const info = await stat(sheet.path);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    return { ok: false, errors: [`sprite sheet missing at ${manifest.spriteSheet.file}`] };
  }
  return { ok: true, pack: { ...manifest, dir: packDir, spriteSheetPath: sheet.path } };
}

/**
 * Discover character packs inside the given roots (skip invalid packs).
 *
 * @param {string[]} roots Absolute directories that contain pack folders.
 * @returns {Promise<{packs: object[], invalid: object[]}>}
 */
export async function listCharacterPacks(roots) {
  const packs = [];
  const invalid = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // optional root (e.g. user data dir) may not exist yet
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const result = await loadCharacterPack(path.join(root, entry.name));
      if (result.ok) {
        packs.push(result.pack);
      } else {
        invalid.push({ dir: path.join(root, entry.name), errors: result.errors });
      }
    }
  }
  return { packs, invalid };
}
