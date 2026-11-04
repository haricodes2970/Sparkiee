import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, mkdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_NVIDIA_BASE_URL,
  describeNvidiaConfig,
  isValidNvidiaApiKey,
  isValidNvidiaBaseUrl,
  isValidNvidiaModel,
  loadNvidiaConfig,
  mergeNvidiaConfig,
  removeNvidiaConfigFile,
  resolveNvidiaConfigPath,
  writeNvidiaConfig,
} from '../packages/core/src/nvidia-config.mjs';

const SAMPLE_KEY = 'nvapi-abcdefghijklmnopqrstuvwxyz0123456789';
const SAMPLE_MODEL = 'meta/llama-3.1-8b-instruct';

async function tempEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-nvidia-'));
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, '.config') };
  return { root, env };
}

test('config path lives beside voice.json under the per-user config dir', () => {
  assert.equal(
    resolveNvidiaConfigPath({ XDG_CONFIG_HOME: '/custom/cfg', HOME: '/home/u' }),
    path.join('/custom/cfg', 'sparkiee', 'nvidia.json'),
  );
  assert.equal(
    resolveNvidiaConfigPath({ HOME: '/home/u' }),
    path.join('/home/u', '.config', 'sparkiee', 'nvidia.json'),
  );
});

test('key validation accepts nvapi- tokens and long opaque tokens, rejects junk', () => {
  assert.equal(isValidNvidiaApiKey(SAMPLE_KEY), true);
  assert.equal(isValidNvidiaApiKey('x'.repeat(48)), true, 'long opaque token accepted');
  for (const bad of ['', 'nvapi-short', 'has spaces here and is long enough to look plausible', 'x'.repeat(300), 42, null, undefined]) {
    assert.equal(isValidNvidiaApiKey(bad), false, `${JSON.stringify(bad)} rejected`);
  }
});

test('base url and model validation only allow safe values', () => {
  assert.equal(isValidNvidiaBaseUrl(DEFAULT_NVIDIA_BASE_URL), true);
  assert.equal(isValidNvidiaBaseUrl('http://127.0.0.1:9999/v1'), true, 'loopback test seam');
  assert.equal(isValidNvidiaBaseUrl('http://evil.example.com/v1'), false, 'plaintext remote refused');
  assert.equal(isValidNvidiaBaseUrl('not a url'), false);
  assert.equal(isValidNvidiaModel(SAMPLE_MODEL), true);
  for (const bad of ['', 'has space', 'x'.repeat(200), 7, null]) assert.equal(isValidNvidiaModel(bad), false);
});

test('nothing is configured without BOTH a key and a chosen model', async () => {
  const { root, env } = await tempEnv();
  try {
    const empty = await loadNvidiaConfig({ env });
    assert.equal(empty.configured, false, 'no file, no env');
    assert.equal(empty.config.baseUrl, DEFAULT_NVIDIA_BASE_URL, 'safe default base url');
    assert.equal(empty.config.model, null, 'no hardcoded default model');

    await writeNvidiaConfig({ env, patch: { apiKey: SAMPLE_KEY } });
    const keyOnly = await loadNvidiaConfig({ env });
    assert.equal(keyOnly.configured, false, 'a key with no model cannot answer');

    await writeNvidiaConfig({ env, patch: { model: SAMPLE_MODEL } });
    const ready = await loadNvidiaConfig({ env });
    assert.equal(ready.configured, true);
    assert.equal(ready.source, 'file');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('env key wins over the file and is never written back', async () => {
  const { root, env } = await tempEnv();
  try {
    await writeNvidiaConfig({ env, patch: { apiKey: SAMPLE_KEY, model: SAMPLE_MODEL } });
    const envKey = 'nvapi-environmentkey000000000000000000';
    const loaded = await loadNvidiaConfig({ env: { ...env, NVIDIA_API_KEY: envKey } });
    assert.equal(loaded.source, 'env');
    assert.equal(loaded.config.apiKey, envKey);
    const onDisk = JSON.parse(await (await import('node:fs/promises')).readFile(resolveNvidiaConfigPath(env), 'utf8'));
    assert.equal(onDisk.apiKey, SAMPLE_KEY, 'the file still holds the file key, not the env key');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reconfigure is read-modify-write: unrelated keys survive', async () => {
  const { root, env } = await tempEnv();
  try {
    const file = resolveNvidiaConfigPath(env);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ apiKey: SAMPLE_KEY, model: 'old/model', customNote: 'keep me', nested: { a: 1 } }), { mode: 0o600 });

    await writeNvidiaConfig({ env, patch: { model: SAMPLE_MODEL } });
    const after = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
    assert.equal(after.model, SAMPLE_MODEL, 'model replaced');
    assert.equal(after.apiKey, SAMPLE_KEY, 'unrelated key preserved');
    assert.equal(after.customNote, 'keep me', 'unknown key preserved');
    assert.deepEqual(after.nested, { a: 1 }, 'nested unknown key preserved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('secret file is 0600, dir 0700, and loose permissions are repaired', async () => {
  const { root, env } = await tempEnv();
  try {
    const file = await writeNvidiaConfig({ env, patch: { apiKey: SAMPLE_KEY, model: SAMPLE_MODEL } });
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'owner-only file');
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700, 'owner-only dir');

    await chmod(file, 0o644);
    const warned = await loadNvidiaConfig({ env });
    assert.ok(warned.warnings.some((w) => w.includes('0600')), 'loose permissions are warned about');
    await writeNvidiaConfig({ env, patch: { model: SAMPLE_MODEL } });
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'rewrite repairs permissions');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid keys/models/urls are refused without writing', async () => {
  const { root, env } = await tempEnv();
  try {
    await assert.rejects(() => writeNvidiaConfig({ env, patch: { apiKey: 'nope' } }), /nvapi/);
    await assert.rejects(() => writeNvidiaConfig({ env, patch: { model: 'bad model id' } }), /model id/);
    await assert.rejects(() => writeNvidiaConfig({ env, patch: { baseUrl: 'http://evil.example.com' } }), /https/);
    const loaded = await loadNvidiaConfig({ env });
    assert.equal(loaded.configured, false, 'nothing usable was written');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('broken JSON degrades with a warning and never throws', async () => {
  const { root, env } = await tempEnv();
  try {
    await mkdir(path.dirname(resolveNvidiaConfigPath(env)), { recursive: true });
    await writeFile(resolveNvidiaConfigPath(env), '{ not json');
    const broken = await loadNvidiaConfig({ env });
    assert.equal(broken.configured, false);
    assert.ok(broken.warnings.some((w) => w.includes('not valid JSON')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('removal clears the key and model but keeps unrelated keys', async () => {
  const { root, env } = await tempEnv();
  try {
    const file = resolveNvidiaConfigPath(env);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ apiKey: SAMPLE_KEY, model: SAMPLE_MODEL, customNote: 'keep' }), { mode: 0o600 });
    await writeNvidiaConfig({ env, patch: { apiKey: null, model: null } });
    const after = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
    assert.equal('apiKey' in after, false);
    assert.equal('model' in after, false);
    assert.equal(after.customNote, 'keep');
    assert.equal((await loadNvidiaConfig({ env })).configured, false);

    assert.equal(await removeNvidiaConfigFile({ env }), true, 'file removed');
    assert.equal(await removeNvidiaConfigFile({ env }), false, 'second removal is a no-op');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('localOnly round-trips and describe never exposes the key', async () => {
  const { root, env } = await tempEnv();
  try {
    await writeNvidiaConfig({ env, patch: { apiKey: SAMPLE_KEY, model: SAMPLE_MODEL, localOnly: true } });
    const loaded = await loadNvidiaConfig({ env });
    assert.equal(loaded.config.localOnly, true);
    const described = JSON.stringify(describeNvidiaConfig(loaded));
    assert.ok(!described.includes(SAMPLE_KEY), 'key absent');
    assert.ok(!described.includes(SAMPLE_KEY.slice(0, 10)), 'no partial key');
    assert.equal(describeNvidiaConfig(loaded).localOnly, true);

    await writeNvidiaConfig({ env, patch: { localOnly: null } });
    assert.equal((await loadNvidiaConfig({ env })).config.localOnly, false, 'local-only can be turned off');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mergeNvidiaConfig ignores hostile file values', () => {
  const merged = mergeNvidiaConfig({
    fileConfig: { apiKey: 5, model: 'bad id', baseUrl: 'http://evil.example.com', localOnly: 'yes' },
    env: {},
  });
  assert.equal(merged.apiKey, null);
  assert.equal(merged.model, null);
  assert.equal(merged.baseUrl, DEFAULT_NVIDIA_BASE_URL);
  assert.equal(merged.localOnly, false);
});
