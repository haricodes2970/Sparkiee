import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { probeWakeWordSetup, createDetector, WAKE_PHRASE } from '../packages/core/src/wake-word.mjs';

test('WAKE_PHRASE constant is "Yo Spark"', () => {
  assert.equal(WAKE_PHRASE, 'Yo Spark');
});

test('probeWakeWordSetup: all missing → needs-setup with checklist', async () => {
  const probe = await probeWakeWordSetup({
    env: {},
    resolveModule: () => { throw new Error('not found'); },
    fileStat: () => { throw new Error('ENOENT'); },
  });
  assert.equal(probe.phrase, 'Yo Spark');
  assert.equal(probe.provider, 'porcupine');
  assert.equal(probe.status, 'needs-setup');
  assert.deepEqual(probe.missing.sort(), ['access-key', 'keyword-model', 'node-module'].sort());
  assert.equal(probe.accessKeyPresent, false);
  assert.equal(probe.keywordModel.present, false);
  assert.match(probe.detail, /Missing: node-module, access-key, keyword-model/);
});

test('probeWakeWordSetup: partial (module + key only) → needs-setup', async () => {
  const probe = await probeWakeWordSetup({
    env: { SPARKIEE_PICOVOICE_ACCESS_KEY: 'abc123' },
    resolveModule: (spec) => {
      if (spec === '@picovoice/porcupine-node') return '/fake/node_modules/@picovoice/porcupine-node';
      throw new Error('not found');
    },
    fileStat: () => { throw new Error('ENOENT'); },
  });
  assert.equal(probe.status, 'needs-setup');
  assert.deepEqual(probe.missing, ['keyword-model']);
  assert.equal(probe.accessKeyPresent, true);
  assert.equal(probe.keywordModel.present, false);
});

test('probeWakeWordSetup: all present → ready with internals', async () => {
  const probe = await probeWakeWordSetup({
    env: { SPARKIEE_PICOVOICE_ACCESS_KEY: 'key123' },
    resolveModule: (spec) => {
      if (spec === '@picovoice/porcupine-node') return '/fake/node_modules/@picovoice/porcupine-node';
      throw new Error('not found');
    },
    fileExists: (path) => path.endsWith('.ppn') || path.endsWith('wake.json'),
  });
  assert.equal(probe.status, 'ready');
  assert.deepEqual(probe.missing, []);
  assert.equal(probe.accessKeyPresent, true);
  assert.equal(probe.keywordModel.present, true);
  assert.ok(probe.keywordModel.name.endsWith('.ppn'));
  assert.ok(probe._internals);
  assert.equal(probe._internals.accessKey, 'key123');
  assert.ok(probe._internals.keywordPath);
  assert.equal(probe._internals.module, '@picovoice/porcupine-node');
});

test('createDetector wraps real Porcupine; process returns boolean', () => {
  let disposed = false;
  const fakePorcupine = {
    frameLength: 512,
    sampleRate: 16000,
    process: (frame) => frame[0] > 0.5 ? 0 : -1,
    release: () => { disposed = true; },
  };
  const Porcupine = function(opts) { return fakePorcupine; };
  const det = createDetector({ Porcupine, accessKey: 'x', keywordPath: 'y.ppn' });
  assert.equal(det.frameLength, 512);
  assert.equal(det.sampleRate, 16000);
  // frame with energy > 0.5 triggers
  const hit = new Float32Array(512); hit[0] = 1.0;
  const miss = new Float32Array(512);
  assert.equal(det.process(hit), true);
  assert.equal(det.process(miss), false);
  det.dispose();
  assert.ok(disposed);
});

test('createDetector catches init error and returns safe stub', () => {
  const Porcupine = function() { throw new Error('AccessKey invalid'); };
  const det = createDetector({ Porcupine, accessKey: 'bad', keywordPath: 'y.ppn' });
  assert.equal(det.frameLength, 512); // default
  assert.equal(det.sampleRate, 16000);
  assert.throws(() => det.process(new Float32Array(512)), /AccessKey invalid/);
  // dispose must not throw
  assert.doesNotThrow(() => det.dispose());
});