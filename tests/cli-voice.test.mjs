import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/sparkiee.mjs', import.meta.url));
const SAMPLE_KEY = 'sk_cli_test_key_0123456789abcdefghij';

async function tempEnv(extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-clivoice-'));
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return {
    root,
    port,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, '.config'),
      XDG_STATE_HOME: path.join(root, '.state'),
      XDG_CACHE_HOME: path.join(root, '.cache'),
      SPARKIEE_PORT: String(port),
      ELEVENLABS_API_KEY: '',
      ...extra,
    },
  };
}

function run(env, args, input = undefined) {
  return spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: 'utf8', timeout: 20_000 });
}

test('voice status reports unconfigured state without secrets', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(env, ['voice', 'status']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configured: no — original chirps are in use/);
  assert.match(result.stdout, /k7uh1RfFIE9Dn75CNvuX \(Sparky default\)/);
  assert.match(result.stdout, /eleven_flash_v2_5/);
  assert.match(result.stdout, /Runtime: not running/);
  assert.ok(!result.stdout.includes('sk_'), 'no key material printed');
});

test('voice setup accepts a piped key, never echoes it, stores 0600', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(env, ['voice', 'setup', '--no-verify'], `${SAMPLE_KEY}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(SAMPLE_KEY), 'key never echoed');
  assert.ok(!result.stderr.includes(SAMPLE_KEY), 'key never echoed to stderr');
  assert.match(result.stdout, new RegExp(`Key saved \\(${SAMPLE_KEY.length} characters`));
  const file = path.join(root, '.config', 'sparkiee', 'voice.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'secret file is owner-only');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.apiKey, SAMPLE_KEY);
  assert.equal(stored.voiceId, 'k7uh1RfFIE9Dn75CNvuX');
  assert.equal(stored.modelId, 'eleven_flash_v2_5');

  const status = run(env, ['voice', 'status']);
  assert.match(status.stdout, /Configured: yes \(from file\)/);
});

test('voice setup rejects malformed keys and saves nothing', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(env, ['voice', 'setup', '--no-verify'], 'not-a-key\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not look like an ElevenLabs API key/);
  await assert.rejects(() => readFile(path.join(root, '.config', 'sparkiee', 'voice.json')), /ENOENT/);
});

test('voice setup --key-file reads the key from a file and handles unknown flags', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = path.join(root, 'key.txt');
  await writeFile(keyFile, `${SAMPLE_KEY}`, { mode: 0o600 });
  const result = run(env, ['voice', 'setup', '--key-file', keyFile, '--no-verify']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(SAMPLE_KEY));
  const bad = run(env, ['voice', 'setup', '--frobnicate']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unknown option/);
});

test('env var key wins over the file in status output', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.config', 'sparkiee', 'voice.json');
  await run(env, ['voice', 'setup', '--no-verify'], `${SAMPLE_KEY}\n`);
  const envKey = 'sk_environment_key_9876543210zyxwvutsrq';
  const status = run({ ...env, ELEVENLABS_API_KEY: envKey }, ['voice', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Configured: yes \(from env\)/);
  assert.ok(!status.stdout.includes(envKey), 'env key not printed either');
  assert.ok(!status.stdout.includes(SAMPLE_KEY));
  void file;
});

test('voice test and mute fail clearly when the daemon is not running', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [['voice', 'test'], ['voice', 'mute'], ['voice', 'unmute']]) {
    const result = run(env, args);
    assert.notEqual(result.status, 0, `${args.join(' ')} fails without daemon`);
    assert.match(result.stderr, /not running/);
  }
});

test('unknown voice subcommands list the valid ones; help documents voice', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const bad = run(env, ['voice', 'shout']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /voice status \| setup \| test \| mute \| unmute/);
  const help = run(env, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /voice setup {2}Store the ElevenLabs API key/);
  assert.match(help.stdout, /ELEVENLABS_API_KEY/);
});

test('single-command guard still rejects stray arguments for other commands', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(env, ['status', 'extra']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected arguments/);
});
