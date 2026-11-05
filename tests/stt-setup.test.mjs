import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSttEnvironment, findSystemPython, spawnRun } from '../packages/core/src/stt-setup.mjs';
import { mkdtempSync as mkdtemp, rmSync as rm, readFileSync } from 'node:fs';
const recurse = { recursive: true, force: true };
import { tmpdir } from 'node:os';

/** Fake step runner: scripts matched by argument signature. */
function makeRunner(behaviors) {
  const calls = [];
  const runImpl = async (cmd, args, options = {}) => {
    calls.push({ cmd, args, options });
    for (const match of behaviors) {
      if (match.test({ cmd, args })) return match.result();
    }
    return { ok: true, code: 0 };
  };
  return { calls, runImpl };
}

// Deterministic filesystem seam: a system python is present, but no venv or
// model is installed yet — so the suite never depends on the host machine.
const noPreexistingInstall = (p) => p === '/usr/bin/python3';

const isVenvStep = ({ args }) => args.includes('venv');
const isPipStep = ({ args }) => args.includes('pip');
const isModelStep = ({ args }) => args.includes('-c');

test('setup walks venv → pip → model and reports each failure point', async () => {
  const venvFail = makeRunner([{ test: isVenvStep, result: () => ({ ok: false, code: 1, stderr: 'no venv support' }) }]);
  const step1 = await setupSttEnvironment({ env: {}, fileExists: noPreexistingInstall, runImpl: venvFail.runImpl });
  assert.equal(step1.ok, false);
  assert.deepEqual(step1.missing, ['stt-venv']);
  assert.match(step1.detail, /venv/i);

  const pipFail = makeRunner([
    { test: isVenvStep, result: () => ({ ok: true, code: 0 }) },
    { test: isPipStep, result: () => ({ ok: false, code: 23, stderr: 'No route to host' }) },
  ]);
  const step2 = await setupSttEnvironment({ env: {}, fileExists: noPreexistingInstall, runImpl: pipFail.runImpl });
  assert.equal(step2.ok, false);
  assert.deepEqual(step2.missing, ['stt-venv']);
  assert.match(step2.detail, /23|failed/i);

  const modelFail = makeRunner([
    { test: isVenvStep, result: () => ({ ok: true, code: 0 }) },
    { test: isPipStep, result: () => ({ ok: true, code: 0 }) },
    { test: isModelStep, result: () => ({ ok: false, code: 5, stderr: 'offline' }) },
  ]);
  const step3 = await setupSttEnvironment({ env: { XDG_CONFIG_HOME: '/nonexistent-sparkiee-test-config' }, fileExists: noPreexistingInstall, runImpl: modelFail.runImpl });
  assert.equal(step3.ok, false);
  assert.deepEqual(step3.missing, ['model']);
  assert.match(step3.detail, /offline/i);
});

test('setup passes the model environment to the recogniser script', async () => {
  const runner = makeRunner([
    { test: isVenvStep, result: () => ({ ok: true, code: 0 }) },
    { test: isPipStep, result: () => ({ ok: true, code: 0 }) },
    { test: isModelStep, result: () => ({ ok: true, code: 0, stdout: 'model-ok' }) },
  ]);
  const result = await setupSttEnvironment({ env: { XDG_CONFIG_HOME: '/nonexistent-sparkiee-test-config' }, fileExists: noPreexistingInstall, runImpl: runner.runImpl });
  assert.equal(result.ok, true);
  const modelStep = runner.calls.find(({ args }) => args.includes('-c'));
  assert.ok(modelStep, 'model step ran');
  assert.match(modelStep.args.join(' '), /tiny\.en/);
});

test('setup short-circuits only when the injected filesystem seam reports a healthy install', async () => {
  const probeOk = makeRunner([{ test: ({ args }) => args.includes('-c'), result: () => ({ ok: true, code: 0, stdout: 'ok' }) }]);
  const ready = await setupSttEnvironment({ env: {}, fileExists: () => true, runImpl: probeOk.runImpl });
  assert.equal(ready.ok, true);
  assert.equal(ready.detail, 'already-ready');
  // The recogniser probe ran, and no venv/pip/model step was attempted.
  assert.equal(probeOk.calls.length, 1);
  assert.ok(!probeOk.calls.some(({ args }) => args.includes('venv') || args.includes('pip')));

  // A missing model cache must NOT short-circuit even if the venv exists.
  const venvOnly = (p) => p.endsWith('/bin/python');
  const pipFail = makeRunner([{ test: isPipStep, result: () => ({ ok: false, code: 1, stderr: 'offline' }) }]);
  const rebuilt = await setupSttEnvironment({ env: {}, fileExists: venvOnly, runImpl: pipFail.runImpl });
  assert.equal(rebuilt.ok, false);
  assert.deepEqual(rebuilt.missing, ['stt-venv']);
});

test('findSystemPython only returns real binaries', () => {
  assert.equal(findSystemPython({ fileExists: (p) => p === '/usr/bin/python3' }), '/usr/bin/python3');
  assert.equal(findSystemPython({ fileExists: () => false }), null);
});

test('spawnRun really spawns processes (guards against missing child_process import)', async () => {
  const real = await spawnRun('/usr/bin/true', [], { timeoutMs: 5000 });
  assert.equal(real.ok, true);
  assert.equal(real.code, 0);
  const echo = await spawnRun('/bin/echo', ['hello-sparkiee'], { timeoutMs: 5000 });
  assert.equal(echo.ok, true);
  assert.match(echo.stdout, /hello-sparkiee/);
  const bad = await spawnRun('/bin/false', [], { timeoutMs: 5000 });
  assert.equal(bad.ok, false);
});

// ---------------------------------------------------------------------------
// Model choice: setup honours --model, downloads the right repo, persists it.
// ---------------------------------------------------------------------------

test('setup with model option downloads that repo and persists the choice', async () => {
  const seen = new Map();
  const cmds = [];
  const run = async (cmd, args, opts = {}) => {
    const script = args?.join(' ') ?? '';
    cmds.push(script);
    if (script.includes("'large-v3-turbo'") || script.includes('large-v3-turbo')) {
      seen.downloadScript = script;
      return { ok: true, code: 0, stdout: 'model-ok', stderr: '' };
    }
    return { ok: true, code: 0, stdout: 'ok', stderr: '' };
  };
  const dir = mkdtemp(`${tmpdir()}/sparkiee-setup-model-`);
  const env = { XDG_CONFIG_HOME: dir, XDG_DATA_HOME: `${dir}/data` };
  const fileSeen = [];
  const result = await setupSttEnvironment({
    env,
    onLine: () => {},
    runImpl: run,
    fileExists: (p) => { fileSeen.push(p); return p.startsWith('/usr/bin/python'); },
    model: 'large-v3-turbo',
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'large-v3-turbo');
  assert.ok(seen.downloadScript.includes('deepdml/faster-whisper-large-v3-turbo-ct2'), 'downloads the turbo repo');
  // Choice persisted to stt.json (0600) in the config dir.
  const conf = JSON.parse(readFileSync(`${dir}/sparkiee/stt.json`, 'utf8'));
  assert.equal(conf.model, 'large-v3-turbo');
  rm(dir, recurse);
});

test('setup rejects unknown model names up front', async () => {
  await assert.rejects(
    () => setupSttEnvironment({ runImpl: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }), model: 'skynet-9000' }),
    /UNKNOWN_STT_MODEL/,
  );
});

test('already-healthy check respects the chosen model cache dir', async () => {
  const seenVenv = new Set();
  const dir = mkdtemp(`${tmpdir()}/sparkiee-setup-health-`);
  const env = { XDG_CONFIG_HOME: dir, XDG_DATA_HOME: `${dir}/data` };
  const result = await setupSttEnvironment({
    env,
    onLine: () => {},
    runImpl: async (cmd, args) => {
      seenVenv.add(String(args?.[0] ?? ''));
      return { ok: true, code: 0, stdout: 'ok', stderr: '' };
    },
    fileExists: (p) => p.includes('faster-whisper-large-v3-turbo') || p.startsWith('/usr/bin/python') || p.includes('/stt/venv/bin/python'),
    model: 'large-v3-turbo',
  });
  assert.equal(result.ok, true);
  assert.equal(result.detail, 'already-ready');
  rm(dir, recurse);
});
