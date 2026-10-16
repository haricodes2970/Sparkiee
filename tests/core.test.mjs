import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PORT,
  ensureAuthToken,
  isAuthorized,
  isPidAlive,
  readAuthToken,
  resolvePort,
  resolveRuntimePaths,
} from '../packages/core/src/index.mjs';

test('default port and paths are predictable', () => {
  assert.equal(resolvePort({}), DEFAULT_PORT);
  const paths = resolveRuntimePaths({ XDG_STATE_HOME: '/tmp/state-root' });
  assert.equal(paths.home, '/tmp/state-root/sparkiee');
  assert.equal(paths.pidFile, '/tmp/state-root/sparkiee/sparkiee.pid');
});

test('invalid ports are rejected instead of silently coerced', () => {
  for (const value of ['0', '-1', '65536', 'abc', '2005.5', '']) {
    assert.throws(() => resolvePort({ SPARKIEE_PORT: value }), /Invalid SPARKIEE_PORT/);
  }
});

test('runtime token is generated once and stored with restrictive permissions', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-core-'));
  const paths = resolveRuntimePaths({ SPARKIEE_HOME: path.join(home, 'state') });
  try {
    const first = await ensureAuthToken(paths);
    const second = await ensureAuthToken(paths);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(second, first);
    assert.equal(await readAuthToken(paths), first);
    if (process.platform !== 'win32') {
      assert.equal((await stat(paths.tokenFile)).mode & 0o777, 0o600);
    }
    assert.equal((await readFile(paths.tokenFile, 'utf8')).trim(), first);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('authorization requires a matching 64-character bearer token', async () => {
  const token = 'a'.repeat(64);
  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${token}` } }, token), true);
  assert.equal(isAuthorized({ headers: {} }, token), false);
  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${'b'.repeat(64)}` } }, token), false);
  assert.equal(isAuthorized({ headers: { authorization: `bearer ${token}` } }, token), false);
});

test('pid liveness rejects invalid process identifiers', () => {
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(Number.NaN), false);
  assert.equal(isPidAlive(process.pid), true);
});
