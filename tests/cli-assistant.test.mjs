import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/sparkiee.mjs', import.meta.url));
const GROQ_KEY = 'gsk_cli_test_key_0123456789abcdefghij';
const GOOGLE_KEY = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GOOGLE_MODEL = 'gemini-2.5-flash';

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
      GROQ_API_KEY: '',
      GOOGLE_AI_API_KEY: '',
      GEMINI_API_KEY: '',
      ...extra,
    },
  };
}

function run(env, args, input = undefined) {
  return spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: 'utf8', timeout: 20_000 });
}

test('assistant setup stores a piped Groq key without ever echoing it', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = run(env, ['assistant', 'setup', '--provider', 'groq', '--no-verify', '--model', GROQ_MODEL], `${GROQ_KEY}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(GROQ_KEY), 'key not echoed to stdout');
  assert.ok(!result.stderr.includes(GROQ_KEY), 'key not echoed to stderr');
  assert.match(result.stdout, /Key saved/);
  assert.match(result.stdout, /Groq/);
  assert.match(result.stdout, new RegExp(GROQ_MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const configPath = path.join(root, '.config', 'sparkiee', 'chat.json');
  assert.equal((await stat(configPath)).mode & 0o777, 0o600, 'secret file is owner-only');
  assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700, 'config dir is owner-only');
  const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(onDisk.provider, 'groq');
  assert.equal(onDisk.providers.groq.apiKey, GROQ_KEY, 'the exact key was stored (locally, 0600)');
  assert.equal(onDisk.providers.groq.model, GROQ_MODEL);
});

test('assistant setup refuses a key that does not look like one, saving nothing', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = run(env, ['assistant', 'setup', '--provider', 'groq', '--no-verify', '--model', GROQ_MODEL], 'hunter2\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Groq API key/i);
  assert.ok(!result.stderr.includes('hunter2'), 'the rejected input is not echoed back');
});

test('both providers are stored independently and switching keeps the other key', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(run(env, ['assistant', 'setup', '--provider', 'groq', '--no-verify', '--model', GROQ_MODEL], `${GROQ_KEY}\n`).status, 0);
  assert.equal(run(env, ['assistant', 'setup', '--provider', 'google', '--no-verify', '--model', GOOGLE_MODEL], `${GOOGLE_KEY}\n`).status, 0);

  const configPath = path.join(root, '.config', 'sparkiee', 'chat.json');
  const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(onDisk.provider, 'google');
  assert.equal(onDisk.providers.groq.apiKey, GROQ_KEY);
  assert.equal(onDisk.providers.google.apiKey, GOOGLE_KEY);
});

test('assistant setup --remove forgets only the active provider', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(run(env, ['assistant', 'setup', '--provider', 'groq', '--no-verify', '--model', GROQ_MODEL], `${GROQ_KEY}\n`).status, 0);
  assert.equal(run(env, ['assistant', 'setup', '--provider', 'google', '--no-verify', '--model', GOOGLE_MODEL], `${GOOGLE_KEY}\n`).status, 0);
  const removed = run(env, ['assistant', 'setup', '--remove', '--provider', 'google']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /removed/i);

  const configPath = path.join(root, '.config', 'sparkiee', 'chat.json');
  const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(onDisk.providers.google, undefined, 'active provider gone');
  assert.equal(onDisk.providers.groq.apiKey, GROQ_KEY, 'the other provider is preserved');
});

test('assistant status reports each readiness axis separately, without secrets', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  run(env, ['assistant', 'setup', '--provider', 'groq', '--no-verify', '--model', GROQ_MODEL], `${GROQ_KEY}\n`);

  const result = run(env, ['assistant', 'status']);
  assert.equal(result.status, 0, result.stderr);
  for (const row of ['Microphone input', 'Local STT', 'Groq', 'Google AI Studio', 'Local voice', 'Voice fallback', 'Wake word']) {
    assert.match(result.stdout, new RegExp(row), `reports "${row}"`);
  }
  assert.ok(!result.stdout.includes(GROQ_KEY), 'status never prints the key');
  assert.ok(!result.stdout.includes(GROQ_KEY.slice(0, 12)), 'not even a key prefix');
});

test('a bare "assistant" prints status instead of failing', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(env, ['assistant']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Groq/);
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
