/**
 * Local voice configuration for Sparky.
 *
 * Sparky speaks through Piper, a small open-source neural TTS engine that runs
 * entirely on this machine. There is no API key, no account, and no network
 * request at speech time — the only network access happens once, when the user
 * explicitly runs "sparkiee voice setup" to download the models.
 *
 * Two voices ship by default:
 *   hi  hi_IN-priyamvada-medium  (Hindi, female)
 *   en  en_US-lessac-medium      (English, female)
 *
 * The language is picked from the text itself (Devanagari → Hindi, else
 * English), so a Hinglish reply is spoken by the Hindi voice.
 *
 * Pure Node: no dependencies. Filesystem access is injectable for tests.
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const VOICE_CONFIG_FILENAME = 'voice.json';
export const DEFAULT_TTS_ENGINE = 'piper';
export const SUPPORTED_TTS_ENGINES = Object.freeze(['piper']);
export const SUPPORTED_LANGUAGES = Object.freeze(['hi', 'en']);

const PIPER_VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

/**
 * Curated catalogue. Every entry is ungated on the Hugging Face Hub, so setup
 * never asks for a token. Licences are recorded so the dashboard can be honest
 * about what is being downloaded.
 */
export const VOICE_CATALOG = Object.freeze({
  'hi_IN-priyamvada-medium': Object.freeze({
    id: 'hi_IN-priyamvada-medium',
    language: 'hi',
    label: 'Priyamvada (Hindi, female)',
    quality: 'medium',
    sampleRate: 22050,
    license: 'CC BY-NC-SA 4.0',
    sizeBytes: 63_700_000,
    files: Object.freeze([
      `${PIPER_VOICE_BASE}/hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx`,
      `${PIPER_VOICE_BASE}/hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx.json`,
    ]),
  }),
  'en_US-lessac-medium': Object.freeze({
    id: 'en_US-lessac-medium',
    language: 'en',
    label: 'Lessac (English, female)',
    quality: 'medium',
    sampleRate: 22050,
    license: 'see rhasspy/piper-voices',
    sizeBytes: 63_700_000,
    files: Object.freeze([
      `${PIPER_VOICE_BASE}/en/en_US/lessac/medium/en_US-lessac-medium.onnx`,
      `${PIPER_VOICE_BASE}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json`,
    ]),
  }),
});

export const DEFAULT_VOICES = Object.freeze({
  hi: 'hi_IN-priyamvada-medium',
  en: 'en_US-lessac-medium',
});

export const DEFAULT_SPEED = 1.0;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2.0;

function homeDir(env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** Config directory: $XDG_CONFIG_HOME/sparkiee or ~/.config/sparkiee. */
export function resolveVoiceConfigDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim().length > 0
    ? env.XDG_CONFIG_HOME
    : path.join(homeDir(env), '.config');
  return path.join(base, 'sparkiee');
}

export function resolveVoiceConfigPath(env = process.env) {
  return path.join(resolveVoiceConfigDir(env), VOICE_CONFIG_FILENAME);
}

/** Generated-clip cache: $XDG_CACHE_HOME/sparkiee/voice. */
export function resolveVoiceCacheDir(env = process.env) {
  const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim().length > 0
    ? env.XDG_CACHE_HOME
    : path.join(homeDir(env), '.cache');
  return path.join(base, 'sparkiee', 'voice');
}

/** App data: $XDG_DATA_HOME/sparkiee, or ~/.local/share/sparkiee. */
export function resolveTtsDataDir(env = process.env) {
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim().length > 0
    ? env.XDG_DATA_HOME
    : path.join(homeDir(env), '.local', 'share');
  return path.join(base, 'sparkiee', 'tts');
}

export function resolveTtsVenvPython(env = process.env) {
  if (env.SPARKIEE_TTS_PYTHON) return env.SPARKIEE_TTS_PYTHON;
  return path.join(resolveTtsDataDir(env), 'venv', 'bin', 'python');
}

export function resolveTtsVoiceDir(env = process.env, voiceId) {
  return path.join(resolveTtsDataDir(env), 'voices', voiceId);
}

export function resolveTtsVoiceModelPath(env = process.env, voiceId) {
  return path.join(resolveTtsVoiceDir(env, voiceId), `${voiceId}.onnx`);
}

export function resolveTtsVoiceConfigPath(env = process.env, voiceId) {
  return `${resolveTtsVoiceModelPath(env, voiceId)}.json`;
}

/**
 * Which voice should speak this text? Any Devanagari codepoint means Hindi;
 * everything else (including Hinglish written in Latin letters) uses English.
 */
export function detectSpeechLanguage(text) {
  return typeof text === 'string' && /[\u0900-\u097F]/.test(text) ? 'hi' : 'en';
}

export function isValidVoiceId(voiceId) {
  return typeof voiceId === 'string' && Object.hasOwn(VOICE_CATALOG, voiceId);
}

export function isValidSpeed(speed) {
  return typeof speed === 'number' && Number.isFinite(speed) && speed >= MIN_SPEED && speed <= MAX_SPEED;
}

/** Validate a full config object. Returns a list of errors (empty = valid). */
export function validateVoiceConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['config must be a JSON object'];
  if (raw.engine !== undefined && !SUPPORTED_TTS_ENGINES.includes(raw.engine)) {
    errors.push(`engine must be one of: ${SUPPORTED_TTS_ENGINES.join(', ')}`);
  }
  if (raw.voices !== undefined) {
    if (!raw.voices || typeof raw.voices !== 'object' || Array.isArray(raw.voices)) {
      errors.push('voices must be an object of language → voice id');
    } else {
      for (const [language, voiceId] of Object.entries(raw.voices)) {
        if (!SUPPORTED_LANGUAGES.includes(language)) errors.push(`unknown language "${language}"`);
        else if (!isValidVoiceId(voiceId)) errors.push(`unknown voice "${voiceId}" for ${language}`);
      }
    }
  }
  if (raw.speed !== undefined && !isValidSpeed(raw.speed)) {
    errors.push(`speed must be a number from ${MIN_SPEED} to ${MAX_SPEED}`);
  }
  return errors;
}

/** Effective configuration: file values, validated, with catalogue defaults. */
export function mergeVoiceConfig({ fileConfig = null, env = process.env } = {}) {
  const file = fileConfig && typeof fileConfig === 'object' && !Array.isArray(fileConfig) ? fileConfig : {};
  const voices = {};
  for (const language of SUPPORTED_LANGUAGES) {
    const fromFile = file.voices && typeof file.voices === 'object' ? file.voices[language] : null;
    voices[language] = isValidVoiceId(fromFile) ? fromFile : DEFAULT_VOICES[language];
  }
  const envSpeed = Number(env.SPARKIEE_TTS_SPEED);
  const speed = isValidSpeed(envSpeed)
    ? envSpeed
    : (isValidSpeed(file.speed) ? file.speed : DEFAULT_SPEED);
  return {
    engine: SUPPORTED_TTS_ENGINES.includes(file.engine) ? file.engine : DEFAULT_TTS_ENGINE,
    voices,
    speed,
  };
}

/**
 * Load the effective configuration. Never throws for missing files.
 *
 * @returns {Promise<{configured: boolean, config: object, warnings: string[], source: string|null}>}
 */
export async function loadVoiceConfig({ env = process.env, read = readFile, checkStat = stat } = {}) {
  const warnings = [];
  const configPath = resolveVoiceConfigPath(env);
  let fileConfig = null;
  let source = null;

  try {
    await checkStat(configPath);
    fileConfig = JSON.parse(await read(configPath, 'utf8'));
    source = 'file';
  } catch (error) {
    if (error && error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      warnings.push(`could not read ${configPath}: ${error.message}`);
    }
    if (error instanceof SyntaxError) {
      warnings.push(`${configPath} is not valid JSON; using the defaults.`);
    }
  }

  const merged = mergeVoiceConfig({ fileConfig, env });
  return {
    configured: SUPPORTED_TTS_ENGINES.includes(merged.engine),
    config: merged,
    warnings,
    source,
  };
}

/** Persist a patch (engine, voices, speed) with owner-only permissions. */
export async function writeVoiceConfig({
  env = process.env,
  patch = {},
  write = writeFile,
  makeDir = mkdir,
  fixMode = chmod,
  read = readFile,
} = {}) {
  const file = resolveVoiceConfigPath(env);
  let existing = {};
  try {
    const parsed = JSON.parse(await read(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch {
    existing = {};
  }

  const merged = mergeVoiceConfig({ fileConfig: existing, env });
  const doc = {
    version: 2,
    engine: patch.engine !== undefined ? patch.engine : merged.engine,
    voices: { ...merged.voices },
    speed: patch.speed !== undefined ? patch.speed : merged.speed,
  };
  if (patch.voices && typeof patch.voices === 'object') {
    for (const [language, voiceId] of Object.entries(patch.voices)) {
      if (voiceId === null) {
        doc.voices[language] = DEFAULT_VOICES[language];
      } else {
        doc.voices[language] = voiceId;
      }
    }
  }

  const errors = validateVoiceConfig(doc);
  if (errors.length > 0) {
    const error = new Error(`Invalid voice configuration: ${errors.join('; ')}.`);
    error.code = 'INVALID_VOICE_CONFIG';
    throw error;
  }

  const dir = resolveVoiceConfigDir(env);
  await makeDir(dir, { recursive: true, mode: 0o700 });
  await write(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  await fixMode(file, 0o600);
  await fixMode(dir, 0o700);
  return file;
}

export async function deleteVoiceConfig({ env = process.env, remove = unlink } = {}) {
  try {
    await remove(resolveVoiceConfigPath(env));
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Status object safe to print or send to the dashboard. */
export function describeVoiceConfig(loaded) {
  return {
    configured: Boolean(loaded?.configured),
    engine: loaded?.config?.engine ?? DEFAULT_TTS_ENGINE,
    voices: loaded?.config?.voices ?? { ...DEFAULT_VOICES },
    speed: loaded?.config?.speed ?? DEFAULT_SPEED,
    source: loaded?.source ?? null,
    warnings: Array.isArray(loaded?.warnings) ? loaded.warnings : [],
  };
}

/** Content type for a generated clip. Piper emits PCM WAV. */
export function mimeForOutputFormat(format) {
  const value = typeof format === 'string' ? format : '';
  if (value.startsWith('mp3_')) return 'audio/mpeg';
  if (value.startsWith('opus_')) return 'audio/ogg';
  if (value.startsWith('pcm_')) return 'audio/wav';
  return 'audio/wav';
}

/**
 * Stable cache key for a synthesis request: text + engine + voice + speed.
 * Only hex characters, so it is path-safe by construction.
 */
export function synthesisCacheKey({ text, voiceId, modelId, outputFormat, settings }) {
  return createHash('sha256')
    .update(JSON.stringify([text, voiceId, modelId, outputFormat, settings ?? null]))
    .digest('hex');
}
