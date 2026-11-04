import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/sparkiee.mjs', import.meta.url));
const SAMPLE_KEY = 'nvapi-cli_test_key_0123456789abcdefghij';
const SAMPLE_MODEL = 'meta/llama-3.1-8b-instruct';

async function tempEnv(extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-cli-assistant-'));
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return {
    root,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, '.config'),
      XDG_STATE_HOME: path.join(root, '.state'),
      XDG_CACHE_HOME: path.join(root, '.cache'),
      SPARKIEE_PORT: String(port),
      NVIDIA_API_KEY: '',
      ELEVENLABS_API_KEY: '',
      ...extra,
    },
  };
}

function run(env, args, input = undefined) {
  return spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: 'utf8', timeout: 20_000 });
}

test('assistant setup stores a piped key without ever echoing it', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = run(env, ['assistant', 'setup', '--no-verify', '--model', SAMPLE_MODEL], `${SAMPLE_KEY}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(SAMPLE_KEY), 'key not echoed to stdout');
  assert.ok(!result.stderr.includes(SAMPLE_KEY), 'key not echoed to stderr');
  assert.match(result.stdout, /Key saved/);
  assert.match(result.stdout, new RegExp(SAMPLE_MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const configPath = path.join(root, '.config', 'sparkiee', 'nvidia.json');
  assert.equal((await stat(configPath)).mode & 0o777, 0o600, 'secret file is owner-only');
  assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700, 'config dir is owner-only');
  const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(onDisk.apiKey, SAMPLE_KEY, 'the exact key was stored (locally, 0600)');
  assert.equal(onDisk.model, SAMPLE_MODEL);
});

test('assistant setup refuses a key that does not look like one, saving nothing', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = run(env, ['assistant', 'setup', '--no-verify', '--model', SAMPLE_MODEL], 'hunter2\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NVIDIA API key/i);
  assert.ok(!result.stderr.includes('hunter2'), 'the rejected input is not echoed back');
});

test('assistant setup --remove forgets the key and says so', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(run(env, ['assistant', 'setup', '--no-verify', '--model', SAMPLE_MODEL], `${SAMPLE_KEY}\n`).status, 0);
  const removed = run(env, ['assistant', 'setup', '--remove']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /removed/i);

  const configPath = path.join(root, '.config', 'sparkiee', 'nvidia.json');
  const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal('apiKey' in onDisk, false, 'key gone');
  assert.equal('model' in onDisk, false, 'model gone with the key');
});

test('assistant status reports each readiness axis separately, without secrets', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  run(env, ['assistant', 'setup', '--no-verify', '--model', SAMPLE_MODEL], `${SAMPLE_KEY}\n`);

  const result = run(env, ['assistant', 'status']);
  assert.equal(result.status, 0, result.stderr);
  for (const row of ['Microphone input', 'Local STT', 'NVIDIA chat', 'ElevenLabs TTS', 'Local TTS fallback', 'Wake word']) {
    assert.match(result.stdout, new RegExp(row), `reports "${row}"`);
  }
  assert.ok(!result.stdout.includes(SAMPLE_KEY), 'status never prints the key');
  assert.ok(!result.stdout.includes(SAMPLE_KEY.slice(0, 12)), 'not even a key prefix');
});

test('a bare "assistant" prints status instead of failing', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(env, ['assistant']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NVIDIA chat/);
});

test('an unknown assistant subcommand fails with the real list, exit non-zero', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(env, ['assistant', 'frobnicate']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown assistant command/);
  assert.match(result.stderr, /assistant status/);
});

test('assistant stt-setup remains reachable under its documented name', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  // --timeout-ms is validated before any network work happens, so a bad value
  // proves the subcommand is dispatched without running a real install.
  const result = run(env, ['assistant', 'stt-setup', '--timeout-ms', '10']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --timeout-ms/);
});
