import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  API_BASE_URL,
  DEFAULT_MODEL_ID,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_VOICE_ID,
  deleteVoiceConfig,
  describeVoiceConfig,
  isValidApiKey,
  loadVoiceConfig,
  mergeVoiceConfig,
  resolveVoiceCacheDir,
  resolveVoiceConfigPath,
  synthesisCacheKey,
  validateVoiceConfig,
  writeVoiceConfig,
} from '../packages/core/src/voice-config.mjs';

const SAMPLE_KEY = 'sk_abcdefghijklmnopqrstuvwxyz0123456789ABCD';

async function tempEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-voice-'));
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, '.config'), XDG_CACHE_HOME: path.join(root, '.cache') };
  return { root, env };
}

test('config path respects XDG_CONFIG_HOME and falls back to ~/.config', () => {
  const xdg = resolveVoiceConfigPath({ XDG_CONFIG_HOME: '/custom/cfg', HOME: '/home/u' });
  assert.equal(xdg, path.join('/custom/cfg', 'sparkiee', 'voice.json'));
  const fallback = resolveVoiceConfigPath({ HOME: '/home/u' });
  assert.equal(fallback, path.join('/home/u', '.config', 'sparkiee', 'voice.json'));
  assert.equal(resolveVoiceCacheDir({ XDG_CACHE_HOME: '/custom/cache' }), path.join('/custom/cache', 'sparkiee', 'voice'));
});

test('api key validation accepts opaque tokens and rejects junk', () => {
  assert.equal(isValidApiKey(SAMPLE_KEY), true);
  for (const bad of ['', 'short', 'has spaces in it definitely long enough', 'x'.repeat(300), 42, null, undefined, 'sk_key/with/slashes/aaaaaaaaaaaaaa']) {
    assert.equal(isValidApiKey(bad), false, `${JSON.stringify(bad)} rejected`);
  }
});

test('env key takes precedence over the file and both are supported', async () => {
  const { root, env } = await tempEnv();
  try {
    // unconfigured with no env and no file
    const empty = await loadVoiceConfig({ env });
    assert.equal(empty.configured, false);
    assert.equal(empty.config.voiceId, DEFAULT_VOICE_ID, 'defaults still resolved');

    // file only
    await writeVoiceConfig({ env, apiKey: SAMPLE_KEY });
    const fromFile = await loadVoiceConfig({ env });
    assert.equal(fromFile.configured, true);
    assert.equal(fromFile.source, 'file');
    assert.equal(fromFile.config.apiKey, SAMPLE_KEY);

    // env wins
    const envKey = 'sk_environmentkey_0000000000000000';
    const fromEnv = await loadVoiceConfig({ env: { ...env, ELEVENLABS_API_KEY: envKey } });
    assert.equal(fromEnv.source, 'env');
    assert.equal(fromEnv.config.apiKey, envKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeVoiceConfig stores 0600 and repairs looser permissions', async () => {
  const { root, env } = await tempEnv();
  try {
    const file = await writeVoiceConfig({ env, apiKey: SAMPLE_KEY, modelId: 'eleven_flash_v2_5' });
    const info = await stat(file);
    assert.equal(info.mode & 0o777, 0o600, 'secret file is owner-only');
    const dirInfo = await stat(path.dirname(file));
    assert.equal(dirInfo.mode & 0o777, 0o700, 'config dir is owner-only');

    // simulate a world-readable secret, then rewrite: rights must be fixed
    await writeFile(file, JSON.stringify({ apiKey: SAMPLE_KEY }), { mode: 0o644 });
    await chmodLoose(file);
    const warned = await loadVoiceConfig({ env });
    assert.ok(warned.warnings.some((w) => w.includes('0600')), 'loose permissions warned about');
    await writeVoiceConfig({ env, apiKey: SAMPLE_KEY });
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'rewritten as 0600');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function chmodLoose(file) {
  const { chmod } = await import('node:fs/promises');
  await chmod(file, 0o644);
}

test('writeVoiceConfig refuses malformed keys and invalid options', async () => {
  const { root, env } = await tempEnv();
  try {
    await assert.rejects(() => writeVoiceConfig({ env, apiKey: 'nope' }), /opaque token/);
    assert.equal(await deleteVoiceConfig({ env }), false, 'nothing written');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('broken or hostile config files degrade with warnings, never crash', async () => {
  const { root, env } = await tempEnv();
  try {
    await mkdir(path.dirname(resolveVoiceConfigPath(env)), { recursive: true });
    await writeFile(resolveVoiceConfigPath(env), '{ not json');
    const broken = await loadVoiceConfig({ env });
    assert.equal(broken.configured, false);
    assert.ok(broken.warnings.some((w) => w.includes('not valid JSON')));

    await writeFile(resolveVoiceConfigPath(env), JSON.stringify({ apiKey: 12345, voiceId: '../etc/passwd', outputFormat: 'wav_999999' }));
    const hostile = await loadVoiceConfig({ env });
    assert.equal(hostile.configured, false, 'invalid key ignored');
    assert.equal(hostile.config.voiceId, DEFAULT_VOICE_ID, 'hostile voiceId ignored');
    assert.equal(hostile.config.outputFormat, DEFAULT_OUTPUT_FORMAT, 'unknown format ignored');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validateVoiceConfig reports every problem with actionable text', () => {
  assert.deepEqual(validateVoiceConfig({ apiKey: SAMPLE_KEY }), []);
  const errors = validateVoiceConfig({ apiKey: 'short', voiceId: 'bad id!', modelId: 'UPPER', outputFormat: 'flac' });
  assert.equal(errors.length, 4);
  assert.ok(errors.every((e) => typeof e === 'string' && e.length > 10));
  assert.ok(validateVoiceConfig(null).length > 0);
  assert.ok(validateVoiceConfig([]).length > 0);
});

test('describeVoiceConfig never exposes the key', () => {
  const loaded = { configured: true, source: 'env', config: { apiKey: SAMPLE_KEY, voiceId: DEFAULT_VOICE_ID, modelId: DEFAULT_MODEL_ID, outputFormat: DEFAULT_OUTPUT_FORMAT }, warnings: [] };
  const described = JSON.stringify(describeVoiceConfig(loaded));
  assert.ok(!described.includes(SAMPLE_KEY), 'key absent from status');
  assert.ok(!described.includes(SAMPLE_KEY.slice(0, 8)), 'no partial key either');
  assert.equal(describeVoiceConfig(loaded).configured, true);
});

test('mergeVoiceConfig honours validated file overrides only', () => {
  const merged = mergeVoiceConfig({
    fileConfig: { apiKey: SAMPLE_KEY, voiceId: 'abcdefghij123', modelId: 'eleven_multilingual_v2', outputFormat: 'mp3_24000_48' },
    env: {},
  });
  assert.equal(merged.voiceId, 'abcdefghij123');
  assert.equal(merged.modelId, 'eleven_multilingual_v2');
  assert.equal(merged.outputFormat, 'mp3_24000_48');
  const defaults = mergeVoiceConfig({ fileConfig: null, env: {} });
  assert.deepEqual(defaults, { apiKey: null, voiceId: DEFAULT_VOICE_ID, modelId: DEFAULT_MODEL_ID, outputFormat: DEFAULT_OUTPUT_FORMAT });
});

test('synthesis cache keys are stable, distinct, and path-safe', () => {
  const base = { text: 'Task complete!', voiceId: DEFAULT_VOICE_ID, modelId: DEFAULT_MODEL_ID, outputFormat: DEFAULT_OUTPUT_FORMAT, settings: { stability: 0.5 } };
  const a = synthesisCacheKey(base);
  const b = synthesisCacheKey({ ...base });
  assert.equal(a, b, 'identical requests share a cache entry');
  assert.match(a, /^[a-f0-9]{64}$/, 'hex only — path safe');
  assert.notEqual(a, synthesisCacheKey({ ...base, text: 'Task complete?' }));
  assert.notEqual(a, synthesisCacheKey({ ...base, voiceId: 'abcdefghij123' }));
  assert.notEqual(a, synthesisCacheKey({ ...base, modelId: 'eleven_multilingual_v2' }));
  assert.notEqual(a, synthesisCacheKey({ ...base, outputFormat: 'mp3_24000_48' }));
  assert.notEqual(a, synthesisCacheKey({ ...base, settings: { stability: 0.8 } }));
});

test('default constants match the Phase 3 decisions', () => {
  assert.equal(DEFAULT_VOICE_ID, 'k7uh1RfFIE9Dn75CNvuX');
  assert.equal(DEFAULT_MODEL_ID, 'eleven_flash_v2_5');
  assert.equal(DEFAULT_OUTPUT_FORMAT, 'mp3_44100_128');
  assert.equal(API_BASE_URL, 'https://api.elevenlabs.io');
});
