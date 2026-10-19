import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAssistantService } from '../packages/server/src/assistant-service.mjs';

function fakeMic() {
  let activeSession = null;
  let resolveDone = null;
  const donePromise = new Promise((r) => { resolveDone = r; });
  return {
    active: () => activeSession ? { id: activeSession.id, label: activeSession.label, device: 'default', startedAt: new Date().toISOString(), elapsedMs: 0 } : null,
    listDevices: async () => [{ id: 'test-mic', description: 'Test Microphone' }],
    start: async ({ label, durationMs }) => {
      if (activeSession) throw Object.assign(new Error('MIC_BUSY'), { code: 'MIC_BUSY' });
      activeSession = { id: `mic-${Date.now()}`, label, device: 'default', startedAt: Date.now() };
      return { id: activeSession.id, done: donePromise };
    },
    stop: (reason) => {
      if (!activeSession) return null;
      const s = { id: activeSession.id, label: activeSession.label, device: 'default', durationMs: 123, bytes: 4000, peakRms: 800, avgRms: 400, reason, error: null };
      activeSession = null;
      resolveDone(s);
      // recreate for next call
      const newPromise = new Promise((r) => { resolveDone = r; });
      return s;
    },
    dispose: () => { activeSession = null; },
  };
}

test('assistant service: status shape with wake needs-setup', async () => {
  const wakeProbe = async () => ({
    phrase: 'Yo Spark',
    provider: 'porcupine',
    status: 'needs-setup',
    missing: ['node-module'],
    accessKeyPresent: false,
    keywordModel: { present: false, name: null },
    detail: 'test',
  });
  const svc = createAssistantService({ micSessionManager: fakeMic(), wakeProbe });
  const snap = await svc.status();
  assert.ok(snap.state);
  assert.ok(snap.since);
  assert.equal(typeof snap.micActive, 'boolean');
  assert.equal(snap.listening, false);
  assert.equal(snap.wake.status, 'needs-setup');
  assert.ok(snap.wake.missing.includes('node-module'));
  assert.equal(typeof snap.mic.devices, 'object');
  assert.equal(snap.lastAction, null);
});

test('assistant service: setListening(true) without setup → WAKE_NEEDS_SETUP', async () => {
  const svc = createAssistantService({ micSessionManager: fakeMic() });
  await assert.rejects(svc.setListening(true), (e) => e.code === 'WAKE_NEEDS_SETUP');
});

test('assistant service: setListening(false) always works', async () => {
  const svc = createAssistantService({ micSessionManager: fakeMic() });
  await svc.setListening(true).catch(() => {}); // ignore error
  const snap = await svc.setListening(false);
  assert.equal(snap.state, 'disabled');
});

test('assistant service: PTT start/stop with fake mic', async () => {
  const mic = fakeMic();
  const svc = createAssistantService({ micSessionManager: mic });
  const { sessionId } = await svc.startPtt();
  assert.ok(sessionId);
  const stopSummary = await svc.stopPtt();
  assert.ok(stopSummary);
  assert.equal(stopSummary.reason, 'ptt-stopped');
});

test('assistant service: PTT busy throws MIC_BUSY', async () => {
  const mic = fakeMic();
  const svc = createAssistantService({ micSessionManager: mic });
  await svc.startPtt();
  await assert.rejects(svc.startPtt(), (e) => e.code === 'MIC_BUSY');
});

test('assistant service: diagnostic returns ok=true with fake mic', async () => {
  // Diagnostic runs a bounded capture — fake mic resolves immediately for this label.
  const diagMic = {
    ...fakeMic(),
    start: async ({ label, durationMs }) => {
      if (label === 'diagnostic') {
        const donePromise = Promise.resolve({
          id: 'diag-1',
          durationMs: 1500,
          bytes: 48000,
          peakRms: 800,
          avgRms: 400,
          reason: 'completed',
          error: null,
        });
        return { id: 'diag-1', done: donePromise };
      }
      return fakeMic().start({ label, durationMs });
    },
  };
  const svc = createAssistantService({ micSessionManager: diagMic });
  const diag = await svc.runDiagnostic();
  assert.equal(diag.ok, true);
  assert.ok(diag.peakRms > 0);
  assert.ok(diag.durationMs >= 1000);
});

test('assistant service: status never leaks access key or internals', async () => {
  const wakeProbe = async () => ({
    phrase: 'Yo Spark',
    provider: 'porcupine',
    status: 'ready',
    missing: [],
    accessKeyPresent: true,
    keywordModel: { present: true, name: 'yo-spark_linux_x86_64.ppn' },
    detail: 'ready',
    _internals: { module: '@picovoice/porcupine-node', accessKey: 'SUPER-SECRET-KEY', keywordPath: '/secret/path.ppn' },
  });
  const svc = createAssistantService({ micSessionManager: fakeMic(), wakeProbe });
  const snap = await svc.status();
  assert.equal(snap.wake._internals, undefined);
  assert.ok(!JSON.stringify(snap).includes('SUPER-SECRET-KEY'));
  assert.ok(!JSON.stringify(snap).includes('/secret/path.ppn'));
});

test('assistant service: recordAction persists in status', async () => {  const svc = createAssistantService({ micSessionManager: fakeMic() });
  svc.recordAction({ kind: 'command', text: 'play madira', reply: 'Okay!', executed: true });
  const snap = await svc.status();
  assert.ok(snap.lastAction);
  assert.equal(snap.lastAction.kind, 'command');
  assert.equal(snap.lastAction.text, 'play madira');
});

test('assistant service: dispose cleans up', async () => {
  const mic = fakeMic();
  const svc = createAssistantService({ micSessionManager: mic });
  await svc.startPtt().catch(() => {});
  svc.dispose();
  // no throw = ok
});