import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(ROOT, 'bin/sparkiee.mjs');

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runCli(args, env, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: sparkiee ${args.join(' ')}`));
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function makeEnv(extra = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-host-'));
  const port = await reservePort();
  const home = path.join(scratch, 'state');
  await mkdir(home, { recursive: true, mode: 0o700 });
  return {
    scratch,
    port,
    home,
    env: { ...process.env, SPARKIEE_HOME: home, SPARKIEE_PORT: String(port), SPARKIEE_DISABLE_PET: '1', ...extra },
  };
}

async function fetchRuntime(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/runtime`);
  return response.json();
}

async function readToken(env) {
  return (await readFile(path.join(env.SPARKIEE_HOME, 'runtime.token'), 'utf8')).trim();
}

test('a missing Electron binary is reported honestly and does not break the daemon', async () => {
  const { scratch, port, home, env } = await makeEnv({ SPARKIEE_ELECTRON_DIR: '/nonexistent-electron-dir' });
  delete env.SPARKIEE_DISABLE_PET;
  try {
    const started = await runCli(['start'], env);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    assert.match(started.stdout, /Pet host: FAILED/);
    assert.match(started.stdout, /npm install/);

    const runtime = await fetchRuntime(port);
    assert.equal(runtime.petHost.phase, 'failed');
    assert.match(runtime.petHost.lastError, /Electron|electron/);

    const status = await runCli(['status'], env);
    assert.match(status.stdout, /Daemon: healthy/);
    assert.match(status.stdout, /Pet host: FAILED/);

    const token = await readToken(env);
    const restarted = await fetch(`http://127.0.0.1:${port}/api/v1/host/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    });
    assert.equal(restarted.status, 202);
    assert.equal((await restarted.json()).host.phase, 'failed', 'restart must not pretend success');

    const stopped = await runCli(['stop'], env);
    assert.equal(stopped.code, 0, stopped.stderr);
  } finally {
    await runCli(['stop'], env).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});

test('repeated start commands do not create duplicate daemons', async () => {
  const { scratch, port, env } = await makeEnv();
  try {
    const first = await runCli(['start'], env);
    assert.equal(first.code, 0, first.stderr);
    const second = await runCli(['start'], env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /already running/);
    const runtime = await fetchRuntime(port);
    const third = await runCli(['start'], env);
    assert.match(third.stdout, new RegExp(`pid ${runtime.pid}`), 'same daemon pid reported');
  } finally {
    await runCli(['stop'], env).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a live-but-unresponsive pid file blocks spawning a duplicate and explains itself', async () => {
  const { scratch, env } = await makeEnv();
  try {
    await writeFile(path.join(env.SPARKIEE_HOME, 'sparkiee.pid'), `${process.pid}\n`, { mode: 0o600 });
    const started = await runCli(['start'], env);
    assert.notEqual(started.code, 0);
    assert.match(started.stderr, /not answering/);
    assert.match(started.stderr, /sparkiee stop/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a stale dead pid file does not block startup', async () => {
  const { scratch, env } = await makeEnv();
  try {
    const ghost = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => ghost.once('close', resolve));
    await writeFile(path.join(env.SPARKIEE_HOME, 'sparkiee.pid'), `${ghost.pid}\n`, { mode: 0o600 });
    const started = await runCli(['start'], env);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
  } finally {
    await runCli(['stop'], env).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});

test('rapid pet commands are all accepted and hide/show transitions work', async () => {
  const { scratch, port, env } = await makeEnv();
  try {
    const started = await runCli(['start'], env);
    assert.equal(started.code, 0, started.stderr);

    const commands = ['wave', 'dance', 'celebrate', 'walk', 'idle'];
    const responses = await Promise.all(commands.map((command) => fetch(`http://127.0.0.1:${port}/api/v1/pet/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ command }),
    })));
    for (const response of responses) assert.equal(response.status, 200);
    const finalState = await (await fetch(`http://127.0.0.1:${port}/api/v1/pet/state`)).json();
    assert.ok(commands.includes(finalState.animation), `final animation ${finalState.animation} is one of the commands sent`);

    const hidden = await fetch(`http://127.0.0.1:${port}/api/v1/pet/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ command: 'hide' }),
    });
    assert.equal((await hidden.json()).pet.visible, false);
    const shown = await fetch(`http://127.0.0.1:${port}/api/v1/pet/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ command: 'show' }),
    });
    assert.equal((await shown.json()).pet.visible, true);
  } finally {
    await runCli(['stop'], env).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});

test('host restart in disabled mode reports the reason instead of launching', async () => {
  const { scratch, port, env } = await makeEnv();
  try {
    const started = await runCli(['start'], env);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /Pet host: disabled/);
    const token = await readToken(env);
    const restarted = await fetch(`http://127.0.0.1:${port}/api/v1/host/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    });
    assert.equal(restarted.status, 202);
    const payload = await restarted.json();
    assert.equal(payload.host.phase, 'failed');
    assert.match(payload.host.lastError, /SPARKIEE_DISABLE_PET/);
  } finally {
    await runCli(['stop'], env).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});

test('daemon log records launch, host lifecycle, and shutdown without leaking the token', async () => {
  const { scratch, env } = await makeEnv();
  try {
    await runCli(['start'], env);
    await runCli(['stop'], env);
    const log = await readFile(path.join(env.SPARKIEE_HOME, 'daemon.log'), 'utf8');
    assert.match(log, /Sparkiee ready/);
    assert.match(log, /Shutting down/);
    assert.doesNotMatch(log, /[a-f0-9]{64}/, 'no bearer token material must appear in logs');
  } finally {
    await runCli(['stop'], env).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});
