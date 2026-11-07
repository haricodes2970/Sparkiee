import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/sparkiee.mjs', import.meta.url));

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
      XDG_DATA_HOME: path.join(root, '.local', 'share'),
      SPARKIEE_PORT: String(port),
      ...extra,
    },
  };
}

function run(env, args, input = undefined) {
  return spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: 'utf8', timeout: 20_000 });
}

test('voice status describes the local engine, both voices, and honest install state', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(env, ['voice', 'status']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Voice engine\s+: piper \(local, free, no account\)/);
  assert.match(result.stdout, /Runtime\s+: not_installed/);
  assert.match(result.stdout, /Hindi voice\s+: Priyamvada \(Hindi, female\)/);
  assert.match(result.stdout, /English voice\s+: Lessac \(English, female\)/);
  assert.match(result.stdout, /sparkiee voice setup/);
  assert.match(result.stdout, /Runtime: not running/);
  assert.ok(!/apikey|gsk_|AIza/.test(result.stdout), 'no key material or cloud provider');
});

test('voice setup rejects an invalid timeout before downloading anything', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(env, ['voice', 'setup', '--timeout-ms', '10']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --timeout-ms/);
});

test('voice setup rejects unknown flags with usage', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(env, ['voice', 'setup', '--frobnicate']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option/);
  assert.match(result.stderr, /voice setup \[--timeout-ms/);
});

test('chat provider keys are ignored by voice status, never echoed', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const status = run({ ...env, GROQ_API_KEY: 'gsk_should_be_ignored_000000000000' }, ['voice', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(!status.stdout.includes('gsk_should_be_ignored'), 'chat key never printed');
  assert.match(status.stdout, /Voice engine\s+: piper/);
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

test('unknown voice subcommands list the valid ones; help documents the local voice', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const bad = run(env, ['voice', 'shout']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /voice status \| setup \| test \| mute \| unmute/);
  const help = run(env, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /voice setup {2}Install the free local voice \(Piper\)/);
  assert.match(help.stdout, /SPARKIEE_TTS_SPEED/);
  assert.ok(!/gsk_|AIza/.test(help.stdout));
});

test('single-command guard still rejects stray arguments for other commands', async (t) => {
  const { root, env } = await tempEnv();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(env, ['status', 'extra']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected arguments/);
});
