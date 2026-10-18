/**
 * Secure voice-provider configuration for Sparky's spoken voice.
 *
 * The ElevenLabs API key is loaded from the environment
 * (ELEVENLABS_API_KEY) or from a protected per-user config file under
 * $XDG_CONFIG_HOME/sparkiee/voice.json (0600). It must never reach the
 * renderer, the dashboard, logs, or git.
 *
 * Pure Node: no dependencies. Filesystem access is injectable for tests.
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Sparky's initial default voice (project decision, Phase 3). */
export const DEFAULT_VOICE_ID = 'k7uh1RfFIE9Dn75CNvuX';
/** Low-latency candidate; verified against the official model list at setup. */
export const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
export const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
export const API_BASE_URL = 'https://api.elevenlabs.io';

const SUPPORTED_FORMATS = Object.freeze([
  'mp3_44100_128', 'mp3_44100_96', 'mp3_44100_64', 'mp3_44100_32',
  'mp3_24000_48', 'mp3_22050_32', 'opus_48000_128', 'pcm_16000', 'wav_22050',
]);

function homeDir(env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/**
 * Config directory: $XDG_CONFIG_HOME/sparkiee or ~/.config/sparkiee.
 */
export function resolveVoiceConfigDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim().length > 0
    ? env.XDG_CONFIG_HOME
    : path.join(homeDir(env), '.config');
  return path.join(base, 'sparkiee');
}

export function resolveVoiceConfigPath(env = process.env) {
  return path.join(resolveVoiceConfigDir(env), 'voice.json');
}

/**
 * Cache directory for generated speech: $XDG_CACHE_HOME/sparkiee/voice
 * or ~/.cache/sparkiee/voice. Never inside the repository.
 */
export function resolveVoiceCacheDir(env = process.env) {
  const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim().length > 0
    ? env.XDG_CACHE_HOME
    : path.join(homeDir(env), '.cache');
  return path.join(base, 'sparkiee', 'voice');
}

/**
 * Validate a raw API key string. ElevenLabs keys are long opaque tokens
 * (commonly sk_...). We only enforce shape, not a specific prefix, so
 * future key formats keep working.
 */
export function isValidApiKey(key) {
  return typeof key === 'string'
    && key.length >= 20
    && key.length <= 256
    && /^[A-Za-z0-9_-]+$/.test(key);
}

export function isValidVoiceId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9]{10,64}$/.test(id);
}

/**
 * Validate a full config object. Returns a list of errors (empty = valid).
 */
export function validateVoiceConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['config must be a JSON object'];
  }
  if (!isValidApiKey(raw.apiKey)) {
    errors.push('apiKey must be an opaque token of 20-256 characters (letters, digits, - and _)');
  }
  if (raw.voiceId !== undefined && !isValidVoiceId(raw.voiceId)) {
    errors.push('voiceId must be 10-64 alphanumeric characters');
  }
  if (raw.modelId !== undefined && (typeof raw.modelId !== 'string' || !/^[a-z0-9_]{3,64}$/.test(raw.modelId))) {
    errors.push('modelId must be a lowercase model identifier like eleven_flash_v2_5');
  }
  if (raw.outputFormat !== undefined && !SUPPORTED_FORMATS.includes(raw.outputFormat)) {
    errors.push(`outputFormat must be one of: ${SUPPORTED_FORMATS.join(', ')}`);
  }
  return errors;
}

/**
 * Effective configuration after merging file + environment. The API key
 * from the environment wins over the file (12-factor precedence).
 */
export function mergeVoiceConfig({ fileConfig = null, env = process.env } = {}) {
  const envKey = typeof env.ELEVENLABS_API_KEY === 'string' && env.ELEVENLABS_API_KEY.trim().length > 0
    ? env.ELEVENLABS_API_KEY.trim()
    : null;
  const file = fileConfig && typeof fileConfig === 'object' && !Array.isArray(fileConfig) ? fileConfig : {};
  return {
    apiKey: envKey ?? (isValidApiKey(file.apiKey) ? file.apiKey : null),
    voiceId: isValidVoiceId(file.voiceId) ? file.voiceId : DEFAULT_VOICE_ID,
    modelId: typeof file.modelId === 'string' && /^[a-z0-9_]{3,64}$/.test(file.modelId) ? file.modelId : DEFAULT_MODEL_ID,
    outputFormat: SUPPORTED_FORMATS.includes(file.outputFormat) ? file.outputFormat : DEFAULT_OUTPUT_FORMAT,
  };
}

/**
 * Load the effective configuration. Never throws for missing files; a
 * missing or unreadable file simply means "unconfigured" unless the
 * environment provides the key.
 *
 * @returns {Promise<{configured: boolean, config: object, warnings: string[], source: string|null}>}
 */
export async function loadVoiceConfig({ env = process.env, read = readFile, checkStat = stat } = {}) {
  const warnings = [];
  const configPath = resolveVoiceConfigPath(env);
  let fileConfig = null;
  let source = null;

  try {
    const info = await checkStat(configPath);
    // Defence in depth: warn (and repair on next write) if the secret file
    // is readable by anyone but the owner.
    if ((info.mode & 0o077) !== 0) {
      warnings.push(`${configPath} is readable by other users; run "sparkiee voice setup" to reset it to 0600.`);
    }
    fileConfig = JSON.parse(await read(configPath, 'utf8'));
    source = 'file';
  } catch (error) {
    if (error && error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      warnings.push(`could not read ${configPath}: ${error.message}`);
    }
    if (error instanceof SyntaxError) {
      warnings.push(`${configPath} is not valid JSON; ignoring it.`);
    }
  }

  const merged = mergeVoiceConfig({ fileConfig, env });
  if (env.ELEVENLABS_API_KEY && merged.apiKey === env.ELEVENLABS_API_KEY.trim()) source = 'env';
  const configured = isValidApiKey(merged.apiKey);
  return { configured, config: merged, warnings, source };
}

/**
 * Persist the configuration with owner-only permissions. Refuses to write
 * an invalid key. Returns the path; the key is never echoed by callers.
 */
export async function writeVoiceConfig({
  env = process.env,
  apiKey,
  voiceId,
  modelId,
  outputFormat,
  write = writeFile,
  makeDir = mkdir,
  fixMode = chmod,
} = {}) {
  if (!isValidApiKey(apiKey)) {
    const error = new Error('apiKey must be an opaque token of 20-256 characters (letters, digits, - and _).');
    error.code = 'INVALID_API_KEY';
    throw error;
  }
  const record = { apiKey };
  if (voiceId !== undefined) record.voiceId = voiceId;
  if (modelId !== undefined) record.modelId = modelId;
  if (outputFormat !== undefined) record.outputFormat = outputFormat;

  const dir = resolveVoiceConfigDir(env);
  const file = resolveVoiceConfigPath(env);
  await makeDir(dir, { recursive: true, mode: 0o700 });
  // Write privately even if the file already exists with looser rights.
  await write(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
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

/**
 * Status object that is safe to send to the dashboard or print in the
 * CLI: it never contains the key itself.
 */
export function describeVoiceConfig(loaded) {
  return {
    configured: loaded.configured,
    source: loaded.source,
    voiceId: loaded.config.voiceId,
    modelId: loaded.config.modelId,
    outputFormat: loaded.config.outputFormat,
    warnings: loaded.warnings,
  };
}

/**
 * Stable cache key for a synthesis request: text + voice + model + format
 * + voice settings. Only hex characters, so it is path-safe by
 * construction.
 */
export function synthesisCacheKey({ text, voiceId, modelId, outputFormat, settings }) {
  return createHash('sha256')
    .update(JSON.stringify([text, voiceId, modelId, outputFormat, settings ?? null]))
    .digest('hex');
}
