import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CHAT_PROVIDERS,
  DEFAULT_CHAT_PROVIDER,
  isValidChatApiKey,
  isValidChatModel,
  loadChatConfig,
  mergeChatConfig,
  resolveChatConfigPath,
  writeChatConfig,
  describeChatConfig,
} from '../packages/core/src/chat-config.mjs';

const GROQ_KEY = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789';
const GOOGLE_KEY = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';
const GOOGLE_AQ_KEY = 'AQ.Ab8RN6LioS7k0I1x2y3z4a5b6c7d8e9f0g1h2i3j4k5l6m7n8o9p';

async function tempEnv() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-chat-'));
  return { env: { ...process.env, XDG_CONFIG_HOME: dir, HOME: dir }, dir };
}

test('chat config supports exactly Groq and Google AI Studio, Groq is the default', () => {
  assert.deepEqual([...CHAT_PROVIDERS].sort(), ['google', 'groq']);
  assert.equal(DEFAULT_CHAT_PROVIDER, 'groq');
});

test('provider key shapes are validated per provider (and no obvious secret is accepted as a model)', () => {
  assert.equal(isValidChatApiKey('groq', GROQ_KEY), true);
  assert.equal(isValidChatApiKey('google', GOOGLE_KEY), true);
  assert.equal(isValidChatApiKey('google', GOOGLE_AQ_KEY), true);
  assert.equal(isValidChatApiKey('groq', 'short'), false);
  assert.equal(isValidChatApiKey('google', 'not-a-google-key'), false);
  assert.equal(isValidChatApiKey('unknown', GROQ_KEY), false);
  assert.equal(isValidChatModel('llama-3.3-70b-versatile'), true);
  assert.equal(isValidChatModel('gemini-2.5-flash'), true);
  assert.equal(isValidChatModel('bad model with spaces'), false);
});

test('environment keys override the file without being written back', async () => {
  const { env, dir } = await tempEnv();
  try {
    await writeChatConfig({ env, patch: { provider: 'groq', apiKey: GROQ_KEY, model: 'llama-3.3-70b-versatile' } });
    const loaded = await loadChatConfig({ env: { ...env, GROQ_API_KEY: GROQ_KEY } });
    assert.equal(loaded.configured, true);
    assert.equal(loaded.provider, 'groq');
    assert.equal(loaded.config.providers.groq.apiKey, GROQ_KEY);
    assert.equal(loaded.source, 'env');
    const onDisk = JSON.parse(await readFile(resolveChatConfigPath(env), 'utf8'));
    assert.equal(onDisk.providers.groq.apiKey, GROQ_KEY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('google accepts GEMINI_API_KEY as an alias and is configurable independently', async () => {
  const { env, dir } = await tempEnv();
  try {
    await writeChatConfig({ env, patch: { provider: 'google', apiKey: GOOGLE_KEY, model: 'gemini-2.5-flash' } });
    const loaded = await loadChatConfig({ env });
    assert.equal(loaded.configured, true);
    assert.equal(loaded.provider, 'google');
    assert.equal(loaded.config.providers.google.model, 'gemini-2.5-flash');
    assert.equal(loaded.config.providers.groq, null);

    const aliased = await loadChatConfig({ env: { ...env, GEMINI_API_KEY: GOOGLE_KEY } });
    assert.equal(aliased.config.providers.google.apiKey, GOOGLE_KEY);
    assert.equal(aliased.source, 'env');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('switching provider keeps both keys so failover needs no re-entry', async () => {
  const { env, dir } = await tempEnv();
  try {
    await writeChatConfig({ env, patch: { provider: 'groq', apiKey: GROQ_KEY, model: 'llama-3.3-70b-versatile' } });
    await writeChatConfig({ env, patch: { provider: 'google', apiKey: GOOGLE_KEY, model: 'gemini-2.5-flash' } });
    const loaded = await loadChatConfig({ env });
    assert.equal(loaded.provider, 'google');
    assert.equal(loaded.config.providers.groq.model, 'llama-3.3-70b-versatile');
    assert.equal(loaded.config.providers.google.model, 'gemini-2.5-flash');
    assert.equal(describeChatConfig(loaded).providers.groq.configured, true);
    assert.equal(describeChatConfig(loaded).providers.google.configured, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the stored file is 0600 inside a 0700 directory', async () => {
  const { env, dir } = await tempEnv();
  try {
    const file = await writeChatConfig({ env, patch: { provider: 'groq', apiKey: GROQ_KEY, model: 'llama-3.3-70b-versatile' } });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('local-only is stored, and makes the provider unready for egress', async () => {
  const { env, dir } = await tempEnv();
  try {
    await writeChatConfig({
      env,
      patch: { provider: 'groq', apiKey: GROQ_KEY, model: 'llama-3.3-70b-versatile', localOnly: true },
    });
    const loaded = await loadChatConfig({ env });
    assert.equal(loaded.config.localOnly, true);
    assert.equal(loaded.configured, true);
    assert.equal(describeChatConfig(loaded).localOnly, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removing a provider clears only that provider', async () => {
  const { env, dir } = await tempEnv();
  try {
    await writeChatConfig({ env, patch: { provider: 'groq', apiKey: GROQ_KEY, model: 'llama-3.3-70b-versatile' } });
    await writeChatConfig({ env, patch: { provider: 'google', apiKey: GOOGLE_KEY, model: 'gemini-2.5-flash' } });
    await writeChatConfig({ env, patch: { provider: 'groq', clearProvider: true } });
    const loaded = await loadChatConfig({ env });
    assert.equal(loaded.config.providers.groq, null);
    assert.equal(loaded.config.providers.google.model, 'gemini-2.5-flash');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt file never throws and reports an honest warning', async () => {
  const { env, dir } = await tempEnv();
  try {
    await writeChatConfig({ env, patch: { provider: 'groq', apiKey: GROQ_KEY, model: 'llama-3.3-70b-versatile' } });
    await writeFile(resolveChatConfigPath(env), '{not json');
    const loaded = await loadChatConfig({ env });
    assert.equal(loaded.configured, false);
    assert.ok(loaded.warnings.some((warning) => /not valid JSON/i.test(warning)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mergeChatConfig ignores malformed model ids and unknown providers', () => {
  const merged = mergeChatConfig({
    fileConfig: {
      provider: 'unknown',
      providers: {
        groq: { apiKey: GROQ_KEY, model: 'bad model' },
        google: { apiKey: GOOGLE_KEY, model: 'gemini-2.5-flash' },
      },
    },
    env: {},
  });
  assert.equal(merged.provider, DEFAULT_CHAT_PROVIDER);
  assert.equal(merged.providers.groq.model, null);
  assert.equal(merged.providers.google.model, 'gemini-2.5-flash');
});
