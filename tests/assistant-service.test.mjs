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
// ---------------------------------------------------------------------------
// Transcript pipeline (Task 3): capture buffer → STT → existing music router.
// ---------------------------------------------------------------------------

/** Mic fake with onAudio chunk feeding + manual silence watchdog tick. */
function fakeMicWithAudio() {
  let active = null;
  const doneWaiters = [];
  const mgr = {
    active: () => active ? { ...active, device: 'default', startedAt: new Date().toISOString(), elapsedMs: 1 } : null,
    listDevices: async () => [],
    start: async ({ label, onAudio }) => {
      if (active) throw Object.assign(new Error('MIC_BUSY'), { code: 'MIC_BUSY' });
      active = { id: 'mic-audio', label };
      return {
        id: active.id,
        done: new Promise((resolve) => doneWaiters.push(resolve)),
        _onAudio: onAudio,
      };
    },
    stop: (reason) => {
      if (!active) return null;
      const s = { id: active.id, label: active.label, device: 'default', durationMs: 2000, bytes: 64000, peakRms: 6000, avgRms: 900, reason, error: null };
      active = null;
      for (const w of doneWaiters.splice(0)) w(s);
      return s;
    },
    dispose: () => { active = null; },
    _feed: (chunk) => mgr._latestOnAudio?.(chunk),
    // helper for tests: capture the onAudio callback handed at start
  };
  // Wrap start to remember onAudio.
  const realStart = mgr.start.bind(mgr);
  mgr.start = async (opts) => {
    mgr._latestOnAudio = opts.onAudio ?? null;
    return realStart(opts);
  };
  return mgr;
}

function sttStub(resultOrError, calls = []) {
  return {
    transcribe: async ({ pcm }) => {
      calls.push({ pcmBytes: pcm?.length ?? 0 });
      if (resultOrError instanceof Error) throw resultOrError;
      return resultOrError;
    },
    cancel: () => true,
  };
}

const STT_OK = { status: 'ok', text: 'play madira', source: 'int16le:16000', segments: [] };

function runIntentStub(outputs, calls = []) {
  // outputs: array of results returned per call, or a function
  return async (text) => {
    calls.push(text);
    if (typeof outputs === 'function') return outputs(text);
    return outputs;
  };
}

const RUN_OK = { handled: true, intent: 'play_track', executed: true, reply: 'Okay! Playing Madira.', speech: { clipId: 'x'.repeat(64) } };
const RUN_UNHANDLED = { handled: false, intent: null, executed: false, reply: 'I did not catch a music command.', speech: null };

function pcmChunk(ms = 100) {
  return Buffer.alloc(Math.trunc((ms / 1000) * 16000) * 2, 0);
}

/** All-0x40 bytes → every s16 sample reads 16448 — as loud as speech needs to be. */
function loudChunk(ms = 100) {
  return Buffer.alloc(Math.trunc((ms / 1000) * 16000) * 2, 0x40);
}

test('assistant pipeline: stop-and-submit → transcript → music router → armed', async () => {
  const mic = fakeMicWithAudio();
  const runCalls = [];
  const svc = createAssistantService({
    micSessionManager: mic,
    stt: sttStub(STT_OK),
    runIntent: runIntentStub(RUN_OK, runCalls),
  });
  const { done } = await svc.startPtt();
  mic._feed(Buffer.concat([pcmChunk(), Buffer.from('\u0001'.repeat(100))])); // loud chunk
  const handle = svc._executorForTest?.(); // not used; call stopPtt directly
  const result = await svc.stopPtt(); // submit
  await done;
  assert.equal(result.transcript, 'play madira');
  assert.equal(result.handled, true);
  assert.equal(result.executed, true);
  assert.equal(result.reply, 'Okay! Playing Madira.');
  assert.deepEqual(runCalls, ['play madira']);
  const snap = await svc.status();
  assert.ok(['armed', 'disabled'].includes(snap.state), snap.state);
});

test('assistant pipeline: STT silence → honest reply, router untouched', async () => {
  const mic = fakeMicWithAudio();
  const runCalls = [];
  const svc = createAssistantService({
    micSessionManager: mic,
    stt: sttStub({ status: 'silence', text: '' }),
    runIntent: runIntentStub(RUN_OK, runCalls),
  });
  await svc.startPtt();
  mic._feed(pcmChunk());
  const result = await svc.stopPtt();
  assert.equal(result.transcript, null);
  assert.equal(result.handled, false);
  assert.match(result.reply, /hear|silence|nothing/i);
  assert.deepEqual(runCalls, []);
});

test('assistant pipeline: unhandled transcript → honest reply, no fake execution', async () => {
  const mic = fakeMicWithAudio();
  const svc = createAssistantService({
    micSessionManager: mic,
    stt: sttStub(STT_OK),
    runIntent: runIntentStub(RUN_UNHANDLED),
  });
  await svc.startPtt();
  mic._feed(pcmChunk());
  const result = await svc.stopPtt();
  assert.equal(result.transcript, 'play madira');
  assert.equal(result.handled, false);
  assert.equal(result.executed, false);
});

test('assistant pipeline: STT failure → error surfaced, state reset, no runIntent', async () => {
  const mic = fakeMicWithAudio();
  const runCalls = [];
  const svc = createAssistantService({
    micSessionManager: mic,
    stt: sttStub(Object.assign(new Error('Transcription timed out after 20s and was stopped.'), { code: 'STT_TIMEOUT' })),
    runIntent: runIntentStub(RUN_OK, runCalls),
  });
  await svc.startPtt();
  mic._feed(pcmChunk());
  const result = await svc.stopPtt();
  assert.equal(result.transcript, null);
  assert.equal(result.error, true);
  assert.match(result.reply, /transcri|hear/i);
  assert.deepEqual(runCalls, []);
  const snap = await svc.status();
  assert.ok(['armed', 'disabled'].includes(snap.state));
});

test('assistant pipeline: cancelPtt discards utterance without transcribing', async () => {
  const mic = fakeMicWithAudio();
  const sttCalls = [];
  const runCalls = [];
  const svc = createAssistantService({
    micSessionManager: mic,
    stt: sttStub(STT_OK, sttCalls),
    runIntent: runIntentStub(RUN_OK, runCalls),
  });
  await svc.startPtt();
  mic._feed(pcmChunk());
  const result = await svc.cancelPtt();
  assert.equal(result.cancelled, true);
  assert.deepEqual(sttCalls, []);
  assert.deepEqual(runCalls, []);
  const snap = await svc.status();
  assert.ok(['armed', 'disabled'].includes(snap.state));
  assert.equal(snap.state !== 'listening' && snap.state !== 'transcribing', true);
});

test('assistant pipeline: silence after speech auto-submits via watchdog', async () => {
  const mic = fakeMicWithAudio();
  const timers = [];
  const setIntervalImpl = (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; };
  const clearIntervalImpl = (id) => { timers[id] = null; };
  const svc = createAssistantService({
    micSessionManager: mic,
    stt: sttStub(STT_OK),
    runIntent: runIntentStub(RUN_OK),
    setIntervalImpl,
    clearIntervalImpl,
  });
  const { done } = await svc.startPtt({ silenceMs: 1000 });
  mic._feed(loudChunk()); // loud chunk → speechSeen
  const before = timers.length;
  assert.ok(before > 0, 'watchdog interval scheduled');
  // Simulate silence: 1.2 s of quiet chunks, ticking the watchdog each 200ms.
  const watch = timers.find(Boolean);
  const quiet = Buffer.alloc(3200, 0); // exactly silence-level
  for (let i = 0; i < 6; i += 1) {
    mic._feed(quiet);
    watch.fn();
  }
  const result = await svc.stopPtt(); // watchdog already stopped the mic
  await done;
  assert.equal(result.transcript, 'play madira');
});

test('assistant pipeline: no speech seen → expiry resets honestly, nothing submitted', async () => {
  const mic = fakeMicWithAudio();
  const sttCalls = [];
  const svc = createAssistantService({
    micSessionManager: mic,
    stt: sttStub(STT_OK, sttCalls),
    runIntent: runIntentStub(RUN_OK),
  });
  const { done } = await svc.startPtt();
  const result = await svc.stopPtt(); // user pressed stop with only silence
  await done;
  assert.deepEqual(sttCalls, []);
  assert.equal(result.transcript, null);
  assert.match(result.reply, /hear|silence/i);
});

test('assistant pipeline: cancelled STT (second cancel) leaves no stuck transcribing', async () => {
  const mic = fakeMicWithAudio();
  const svc = createAssistantService({
    micSessionManager: mic,
    stt: sttStub(Object.assign(new Error('Transcription was cancelled.'), { code: 'STT_CANCELLED' })),
    runIntent: runIntentStub(RUN_OK),
  });
  await svc.startPtt();
  mic._feed(pcmChunk());
  const result = await svc.stopPtt();
  assert.equal(result.transcript, null);
  const snap = await svc.status();
  assert.ok(snap.state !== 'transcribing');
});

test('assistant pipeline: recogniser not installed → honest setup reply, not silence', async () => {
  const mic = fakeMicWithAudio();
  const svc = createAssistantService({
    micSessionManager: mic,
    stt: sttStub({ status: 'unavailable', detail: 'not installed' }),
    runIntent: runIntentStub(RUN_OK),
  });
  await svc.startPtt();
  mic._feed(loudChunk()); // enough bytes to invoke the recogniser
  const result = await svc.stopPtt();
  assert.equal(result.transcript, null);
  assert.equal(result.error, true);
  assert.match(result.reply, /not set up yet|setup/i);
});
