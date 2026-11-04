/**
 * Secure NVIDIA (conversational AI) configuration.
 *
 * The NVIDIA API key is loaded from the environment (NVIDIA_API_KEY) or from
 * a protected per-user file under $XDG_CONFIG_HOME/sparkiee/nvidia.json
 * (0600, directory 0700). It must never reach the renderer, the dashboard,
 * logs, or git — only the daemon process reads it, and only when it is about
 * to make an outbound request.
 *
 * The file is written read-modify-write so reconfiguring one field preserves
 * every unrelated key already present.
 *
 * Pure Node: no dependencies. Filesystem access is injectable for tests.
 */

import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveVoiceConfigDir } from './voice-config.mjs';

/** NVIDIA's OpenAI-compatible inference gateway. */
export const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const NVIDIA_CONFIG_FILENAME = 'nvidia.json';
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;

export function resolveNvidiaConfigDir(env = process.env) {
  return resolveVoiceConfigDir(env);
}

export function resolveNvidiaConfigPath(env = process.env) {
  return path.join(resolveNvidiaConfigDir(env), NVIDIA_CONFIG_FILENAME);
}

/**
 * NVIDIA keys are `nvapi-...` tokens. We also accept a long opaque token so a
 * future format keeps working, but never anything short enough to be a typo.
 */
export function isValidNvidiaApiKey(key) {
  if (typeof key !== 'string') return false;
  const trimmed = key.trim();
  if (/^nvapi-[A-Za-z0-9_-]{16,220}$/.test(trimmed)) return true;
  return trimmed.length >= 40 && trimmed.length <= 256 && /^[A-Za-z0-9_-]+$/.test(trimmed);
}

export function isValidNvidiaModel(model) {
  return typeof model === 'string' && MODEL_PATTERN.test(model.trim());
}

export function isValidNvidiaBaseUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  if (/^https:\/\/[a-z0-9.-]+(:\d{2,5})?(\/[A-Za-z0-9._~/-]*)?$/i.test(trimmed)) return true;
  // Loopback http is allowed for a local test seam (same rule as the voice
  // provider), so the key still cannot be sent to a remote plaintext host.
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d{2,5})?(\/[A-Za-z0-9._~/-]*)?$/i.test(trimmed);
}

/**
 * Effective configuration after merging file + environment. The environment
 * key wins (12-factor precedence) and is never written back to disk.
 */
export function mergeNvidiaConfig({ fileConfig = null, env = process.env } = {}) {
  const envKey = typeof env.NVIDIA_API_KEY === 'string' && env.NVIDIA_API_KEY.trim().length > 0
    ? env.NVIDIA_API_KEY.trim()
    : null;
  const file = fileConfig && typeof fileConfig === 'object' && !Array.isArray(fileConfig) ? fileConfig : {};
  return {
    apiKey: envKey ?? (isValidNvidiaApiKey(file.apiKey) ? String(file.apiKey).trim() : null),
    // No hardcoded default model: the id must come from the live model list,
    // captured at setup, or the assistant stays unconfigured. Guessing an id
    // would produce 404s the user cannot explain.
    model: isValidNvidiaModel(file.model) ? String(file.model).trim() : null,
    baseUrl: isValidNvidiaBaseUrl(file.baseUrl) ? String(file.baseUrl).trim().replace(/\/+$/, '') : DEFAULT_NVIDIA_BASE_URL,
    localOnly: file.localOnly === true,
  };
}

/**
 * Load the effective configuration. Never throws for a missing file.
 *
 * @returns {Promise<{configured: boolean, config: object, warnings: string[], source: string|null}>}
 */
export async function loadNvidiaConfig({ env = process.env, read = readFile, checkStat = stat } = {}) {
  const warnings = [];
  const configPath = resolveNvidiaConfigPath(env);
  let fileConfig = null;
  let source = null;

  try {
    const info = await checkStat(configPath);
    if ((info.mode & 0o077) !== 0) {
      warnings.push(`${configPath} is readable by other users; run "sparkiee assistant setup" to reset it to 0600.`);
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

  const merged = mergeNvidiaConfig({ fileConfig, env });
  if (typeof env.NVIDIA_API_KEY === 'string' && merged.apiKey === env.NVIDIA_API_KEY.trim()) source = 'env';
  // Ready to answer only when there is a key AND a chosen model.
  const configured = isValidNvidiaApiKey(merged.apiKey) && isValidNvidiaModel(merged.model);
  return { configured, config: merged, warnings, source };
}

/**
 * Write a patch into the config file, preserving any unrelated keys already
 * present. Passing `apiKey: null` removes only the key.
 */
export async function writeNvidiaConfig({
  env = process.env,
  patch = {},
  write = writeFile,
  makeDir = mkdir,
  fixMode = chmod,
  read = readFile,
} = {}) {
  const file = resolveNvidiaConfigPath(env);
  let existing = {};
  try {
    const parsed = JSON.parse(await read(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch {
    existing = {}; // missing or corrupt: start clean rather than fail
  }

  const next = { ...existing };
  if ('apiKey' in patch) {
    if (patch.apiKey === null) delete next.apiKey;
    else if (!isValidNvidiaApiKey(patch.apiKey)) {
      const error = new Error('NVIDIA API keys look like "nvapi-..." (or a 40+ character token).');
      error.code = 'INVALID_API_KEY';
      throw error;
    } else next.apiKey = String(patch.apiKey).trim();
  }
  if ('model' in patch) {
    if (patch.model === null) delete next.model;
    else if (!isValidNvidiaModel(patch.model)) {
      const error = new Error('The model id must match the id returned by GET /v1/models.');
      error.code = 'INVALID_MODEL';
      throw error;
    } else next.model = String(patch.model).trim();
  }
  if ('baseUrl' in patch) {
    if (patch.baseUrl === null) delete next.baseUrl;
    else if (!isValidNvidiaBaseUrl(patch.baseUrl)) {
      const error = new Error('baseUrl must be an https URL.');
      error.code = 'INVALID_BASE_URL';
      throw error;
    } else next.baseUrl = String(patch.baseUrl).trim().replace(/\/+$/, '');
  }
  if ('localOnly' in patch) {
    if (patch.localOnly === true) next.localOnly = true;
    else delete next.localOnly;
  }

  const dir = resolveNvidiaConfigDir(env);
  await makeDir(dir, { recursive: true, mode: 0o700 });
  await write(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fixMode(file, 0o600);
  await fixMode(dir, 0o700);
  return file;
}

/** Remove the stored key (and model) but keep unrelated keys. */
export async function deleteNvidiaConfig({ env = process.env, patch = { apiKey: null, model: null } , ...rest } = {}) {
  return writeNvidiaConfig({ env, patch, ...rest });
}

export async function removeNvidiaConfigFile({ env = process.env, remove = unlink } = {}) {
  try {
    await remove(resolveNvidiaConfigPath(env));
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Status object safe to print or send to the dashboard: never the key. */
export function describeNvidiaConfig(loaded) {
  return {
    configured: loaded.configured,
    source: loaded.source,
    model: loaded.config.model,
    baseUrl: loaded.config.baseUrl,
    localOnly: loaded.config.localOnly,
    warnings: loaded.warnings,
  };
}
