import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSystemLauncher } from '../packages/core/src/system-launcher.mjs';

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  return child;
}

test('launcher opens the project in a terminal without daemon secrets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-launch-'));
  try {
    const calls = [];
    const launcher = createSystemLauncher({
      platform: 'linux',
      env: { PATH: '/usr/bin', GROQ_API_KEY: 'secret', HOME: '/home/test' },
      existsImpl: (candidate) => candidate === '/usr/bin/ptyxis',
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return fakeChild();
      },
    });
    const result = await launcher.openProject({ path: dir, command: 'opencode' });
    assert.equal(result.ok, true);
    assert.equal(result.terminal, 'ptyxis');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/usr/bin/ptyxis');
    assert.deepEqual(calls[0].args, ['--new-window', '-d', dir, '--', 'bash', '-lc', 'opencode; exec bash -l']);
    assert.equal(calls[0].options.cwd, dir);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.env.GROQ_API_KEY, undefined, 'API keys never enter the terminal');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('launcher prefers $TERMINAL and reverts to a shell when no command is given', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-launch-'));
  try {
    const calls = [];
    const launcher = createSystemLauncher({
      platform: 'linux',
      env: { PATH: '/usr/bin', TERMINAL: 'myterm' },
      existsImpl: (candidate) => candidate === '/usr/bin/myterm',
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return fakeChild();
      },
    });
    await launcher.openProject({ path: dir });
    assert.equal(calls[0].command, '/usr/bin/myterm');
    assert.equal(calls[0].args.at(-1), 'exec bash -l');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('launcher refuses unsafe commands and missing terminals before spawning', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-launch-'));
  try {
    let spawned = false;
    const launcher = createSystemLauncher({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      existsImpl: () => false,
      spawnImpl: () => { spawned = true; return fakeChild(); },
    });
    await assert.rejects(launcher.openProject({ path: dir, command: 'npm test; rm -rf .' }), /command/i);
    await assert.rejects(launcher.openProject({ path: dir }), /terminal/i);
    assert.equal(spawned, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
