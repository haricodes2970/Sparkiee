/**
 * Secure chat-provider configuration: Groq and Google AI Studio.
 *
 * Keys live in $XDG_CONFIG_HOME/sparkiee/chat.json (file 0600, directory
 * 0700) or in the environment. They never reach the renderer, the dashboard,
 * logs, or git; only the daemon reads them, and only when it is about to make
 * an outbound request.
 *
 * Both providers are stored independently so switching or failing over never
 * asks the user to re-enter a key.
 *
 * Pure Node: no dependencies. Filesystem access is injectable for tests.
 */

import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveVoiceConfigDir } from './voice-config.mjs';

export const CHAT_PROVIDERS = Object.freeze(['groq', 'google']);
export const DEFAULT_CHAT_PROVIDER = 'groq';
export const CHAT_CONFIG_FILENAME = 'chat.json';

export const CHAT_PROVIDER_INFO = Object.freeze({
  groq: Object.freeze({
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKeys: Object.freeze(['GROQ_API_KEY']),
    modelHint: 'llama-3.3-70b-versatile',
  }),
  google: Object.freeze({
    id: 'google',
    label: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    envKeys: Object.freeze(['GOOGLE_AI_API_KEY', 'GEMINI_API_KEY']),
    modelHint: 'gemini-2.5-flash',
  }),
});

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export function resolveChatConfigDir(env = process.env) {
  return resolveVoiceConfigDir(env);
}

export function resolveChatConfigPath(env = process.env) {
  return path.join(resolveChatConfigDir(env), CHAT_CONFIG_FILENAME);
}

/** Key shape per provider; generic long tokens keep future formats working. */
export function isValidChatApiKey(provider, key) {
  if (!CHAT_PROVIDERS.includes(provider)) return false;
  if (typeof key !== 'string') return false;
  const trimmed = key.trim();
  if (provider === 'groq') {
    if (/^gsk_[A-Za-z0-9_-]{20,220}$/.test(trimmed)) return true;
    return trimmed.length >= 40 && trimmed.length <= 256 && TOKEN_PATTERN.test(trimmed);
  }
  if (/^AIza[0-9A-Za-z_-]{30,220}$/.test(trimmed)) return true;
  return trimmed.length >= 35 && trimmed.length <= 256 && TOKEN_PATTERN.test(trimmed);
}

export function isValidChatModel(model) {
  return typeof model === 'string' && MODEL_PATTERN.test(model.trim());
}

export function isValidChatBaseUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  if (/^https:\/\/[a-z0-9.-]+(:\d{2,5})?(\/[A-Za-z0-9._~/-]*)?$/i.test(trimmed)) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d{2,5})?(\/[A-Za-z0-9._~/-]*)?$/i.test(trimmed);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function envKeyFor(provider, env) {
  for (const name of CHAT_PROVIDER_INFO[provider].envKeys) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function normaliseProvider(provider) {
  return CHAT_PROVIDERS.includes(provider) ? provider : DEFAULT_CHAT_PROVIDER;
}

function normaliseProviderEntry(raw, envKey) {
  const source = plainObject(raw) ? raw : {};
  const fileKey = isValidChatApiKey('groq', source.apiKey) || isValidChatApiKey('google', source.apiKey)
    ? String(source.apiKey).trim()
    : null;
  const apiKey = envKey ?? fileKey;
  const model = isValidChatModel(source.model) ? String(source.model).trim() : null;
  return { apiKey, model };
}

/**
 * Effective config after merging file + environment. Environment keys win
 * (12-factor precedence) and are never written back to disk.
 */
export function mergeChatConfig({ fileConfig = null, env = process.env } = {}) {
  const file = plainObject(fileConfig) ? fileConfig : {};
  const provider = normaliseProvider(file.provider);
  const fileProviders = plainObject(file.providers) ? file.providers : {};
  const providers = {};
  let usedEnv = false;
  for (const id of CHAT_PROVIDERS) {
    const envKey = envKeyFor(id, env);
    if (envKey) usedEnv = true;
    const entry = normaliseProviderEntry(fileProviders[id], envKey);
    providers[id] = entry.apiKey || entry.model ? entry : null;
  }
  return {
    provider,
    providers,
    localOnly: file.localOnly === true,
    _usedEnv: usedEnv,
  };
}

export async function loadChatConfig({ env = process.env, read = readFile, checkStat = stat } = {}) {
  const warnings = [];
  const configPath = resolveChatConfigPath(env);
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

  const merged = mergeChatConfig({ fileConfig, env });
  if (merged._usedEnv) source = 'env';
  const active = merged.providers[merged.provider] ?? null;
  const configured = isValidChatApiKey(merged.provider, active?.apiKey) && isValidChatModel(active?.model);
  return {
    configured,
    provider: merged.provider,
    config: {
      provider: merged.provider,
      providers: merged.providers,
      localOnly: merged.localOnly,
    },
    warnings,
    source,
  };
}

/**
 * Write a patch, preserving unrelated providers and settings.
 *
 * patch:
 *   provider      switch the active provider
 *   apiKey        set (validated) or null to remove the active provider's key
 *   model         set (validated) or null to remove the active provider's model
 *   localOnly     boolean
 *   clearProvider true to remove the active provider entirely
 */
export async function writeChatConfig({
  env = process.env,
  patch = {},
  write = writeFile,
  makeDir = mkdir,
  fixMode = chmod,
  read = readFile,
} = {}) {
  const file = resolveChatConfigPath(env);
  let existing = {};
  try {
    const parsed = JSON.parse(await read(file, 'utf8'));
    if (plainObject(parsed)) existing = parsed;
  } catch {
    existing = {};
  }

  const doc = {
    version: 1,
    provider: normaliseProvider(existing.provider),
    localOnly: existing.localOnly === true,
    providers: plainObject(existing.providers) ? { ...existing.providers } : {},
  };
  if (CHAT_PROVIDERS.includes(patch.provider)) doc.provider = patch.provider;
  const active = doc.provider;

  if (patch.clearProvider === true) {
    delete doc.providers[active];
  }

  if ('apiKey' in patch) {
    const entry = plainObject(doc.providers[active]) ? { ...doc.providers[active] } : {};
    if (patch.apiKey === null) delete entry.apiKey;
    else if (!isValidChatApiKey(active, patch.apiKey)) {
      const error = new Error(`That does not look like a ${CHAT_PROVIDER_INFO[active].label} API key.`);
      error.code = 'INVALID_API_KEY';
      throw error;
    } else entry.apiKey = String(patch.apiKey).trim();
    doc.providers[active] = entry;
  }

  if ('model' in patch) {
    const entry = plainObject(doc.providers[active]) ? { ...doc.providers[active] } : {};
    if (patch.model === null) delete entry.model;
    else if (!isValidChatModel(patch.model)) {
      const error = new Error('The model id must match the id returned by the provider\'s model list.');
      error.code = 'INVALID_MODEL';
      throw error;
    } else entry.model = String(patch.model).trim();
    doc.providers[active] = entry;
  }

  if ('localOnly' in patch) doc.localOnly = patch.localOnly === true;

  for (const id of Object.keys(doc.providers)) {
    if (!CHAT_PROVIDERS.includes(id)) delete doc.providers[id];
    else if (!plainObject(doc.providers[id]) || Object.keys(doc.providers[id]).length === 0) delete doc.providers[id];
  }

  const dir = resolveChatConfigDir(env);
  await makeDir(dir, { recursive: true, mode: 0o700 });
  await write(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  await fixMode(file, 0o600);
  await fixMode(dir, 0o700);
  return file;
}

export async function removeChatConfigFile({ env = process.env, remove = unlink } = {}) {
  try {
    await remove(resolveChatConfigPath(env));
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Status object safe to print or send to the dashboard: never the keys. */
export function describeChatConfig(loaded) {
  const provider = loaded?.provider ?? DEFAULT_CHAT_PROVIDER;
  const providers = loaded?.config?.providers ?? {};
  const describeEntry = (id) => {
    const entry = providers[id] ?? null;
    const info = CHAT_PROVIDER_INFO[id];
    return {
      label: info.label,
      configured: isValidChatApiKey(id, entry?.apiKey) && isValidChatModel(entry?.model),
      model: entry?.model ?? null,
      baseUrl: info.baseUrl,
    };
  };
  const active = providers[provider] ?? null;
  return {
    configured: Boolean(loaded?.configured),
    provider,
    label: CHAT_PROVIDER_INFO[provider].label,
    model: active?.model ?? null,
    baseUrl: CHAT_PROVIDER_INFO[provider].baseUrl,
    localOnly: loaded?.config?.localOnly === true,
    source: loaded?.source ?? null,
    warnings: Array.isArray(loaded?.warnings) ? loaded.warnings : [],
    providers: Object.fromEntries(CHAT_PROVIDERS.map((id) => [id, describeEntry(id)])),
  };
}
