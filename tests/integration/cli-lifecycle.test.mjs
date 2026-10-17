import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

function runCli(args, env, timeout = 10_000) {
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

function makeEnv(home, port) {
  return { ...process.env, SPARKIEE_HOME: home, SPARKIEE_PORT: String(port), SPARKIEE_DISABLE_PET: '1' };
}

test('CLI help and version work without starting the daemon', async () => {
  const help = await runCli(['--help'], process.env);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /start\s+Start the local runtime/);
  assert.match(help.stdout, /http:\/\/127\.0\.0\.1:2005/);

  const version = await runCli(['--version'], process.env);
  assert.equal(version.code, 0, version.stderr);
  assert.match(version.stdout.trim(), /^0\.1\.0$/);
});

test('CLI starts the daemon, serves the dashboard, reports status, and stops cleanly', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-lifecycle-'));
  const port = await reservePort();
  const env = makeEnv(path.join(scratch, 'state'), port);
  try {
    const started = await runCli(['start'], env);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    assert.match(started.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}`));

    const runtimeResponse = await fetch(`http://127.0.0.1:${port}/api/v1/runtime`);
    assert.equal(runtimeResponse.status, 200);
    const runtime = await runtimeResponse.json();
    assert.equal(runtime.name, 'Sparkiee');

    const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /Your first companion is on its way/);

    const status = await runCli(['status'], env);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Sparkiee is running/);

    const stopped = await runCli(['stop'], env);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.match(stopped.stdout, /Sparkiee stopped/);

    const afterStop = await runCli(['status'], env);
    assert.equal(afterStop.code, 0, afterStop.stderr);
    assert.match(afterStop.stdout, /Sparkiee is not running/);
    const log = await readFile(path.join(env.SPARKIEE_HOME, 'daemon.log'), 'utf8');
    assert.match(log, /Sparkiee ready/);
    assert.match(log, /Shutting down/);
  } finally {
    await runCli(['stop'], env).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});

test('CLI gives a useful error when the port is already in use', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-port-conflict-'));
  const port = await reservePort();
  const blocker = createNetServer();
  blocker.on('connection', (socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', resolve);
  });
  const env = makeEnv(path.join(scratch, 'state'), port);
  try {
    const started = await runCli(['start'], env);
    assert.notEqual(started.code, 0);
    assert.match(started.stderr, /already in use/);
    const log = await readFile(path.join(env.SPARKIEE_HOME, 'daemon.log'), 'utf8');
    assert.match(log, /EADDRINUSE/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
