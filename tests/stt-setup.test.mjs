import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSttEnvironment, findSystemPython, spawnRun } from '../packages/core/src/stt-setup.mjs';

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

const isVenvStep = ({ args }) => args.includes('venv');
const isPipStep = ({ args }) => args.includes('pip');
const isModelStep = ({ args }) => args.includes('-c');

test('setup walks venv → pip → model and reports each failure point', async () => {
  const venvFail = makeRunner([{ test: isVenvStep, result: () => ({ ok: false, code: 1, stderr: 'no venv support' }) }]);
  const step1 = await setupSttEnvironment({ env: {}, runImpl: venvFail.runImpl });
  assert.equal(step1.ok, false);
  assert.deepEqual(step1.missing, ['stt-venv']);
  assert.match(step1.detail, /venv/i);

  const pipFail = makeRunner([
    { test: isVenvStep, result: () => ({ ok: true, code: 0 }) },
    { test: isPipStep, result: () => ({ ok: false, code: 23, stderr: 'No route to host' }) },
  ]);
  const step2 = await setupSttEnvironment({ env: {}, runImpl: pipFail.runImpl });
  assert.equal(step2.ok, false);
  assert.deepEqual(step2.missing, ['stt-venv']);
  assert.match(step2.detail, /23|failed/i);

  const modelFail = makeRunner([
    { test: isVenvStep, result: () => ({ ok: true, code: 0 }) },
    { test: isPipStep, result: () => ({ ok: true, code: 0 }) },
    { test: isModelStep, result: () => ({ ok: false, code: 5, stderr: 'offline' }) },
  ]);
  const step3 = await setupSttEnvironment({ env: {}, runImpl: modelFail.runImpl });
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
  const result = await setupSttEnvironment({ env: {}, runImpl: runner.runImpl });
  assert.equal(result.ok, true);
  const modelStep = runner.calls.find(({ args }) => args.includes('-c'));
  assert.ok(modelStep, 'model step ran');
  assert.match(modelStep.args.join(' '), /tiny\.en/);
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
