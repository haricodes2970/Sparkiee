import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantService } from '../packages/server/src/assistant-service.mjs';

/**
 * Hearing-lifecycle regressions for the real capture pipeline:
 * adaptive voice detection with calibration, sustained-silence submission,
 * NO premature submit, honest manual-stop-without-speech, timeout submit,
 * single-flight transcription, first-PCM hearing transition, and level
 * metrics derived from real PCM. Only the mic session and the clock are
 * doubled; PCM data is real. This file never substitutes for the live
 * hardware capture check — that stays marked separately.
 */

/** 16 kHz s16le mono sine at an approximate RMS level. Zero rms = silence. */
function pcm({ rms = 0, seconds = 0.12, freqHz = 220 } = {}) {
  const rate = 16_000;
  const samples = Math.max(1, Math.round(rate * seconds));
  const buffer = Buffer.alloc(samples * 2);
  const amplitude = rms * Math.SQRT2;
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / rate));
    buffer.writeInt16LE(Math.max(-32_767, Math.min(32_767, value)), i * 2);
  }
  return buffer;
}

function manualClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function world({ transcribeResult = { status: 'ok', text: 'play madira' } } = {}) {
  const mic = makeMic();
  const clock = manualClock();
  const timers = [];
  const transcribes = [];
  const runTexts = [];
  const svc = createAssistantService({
    now: clock.now,
    micSessionManager: mic,
    setIntervalImpl: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearIntervalImpl: (id) => { if (id) id.cleared = true; },
    runIntent: async (text) => {
      runTexts.push(text);
      return { handled: true, executed: true, intent: 'play', reply: 'Okay! Playing Madira.' };
    },
  });
  const executor = {
    transcribe: async ({ pcm: bytes }) => {
      transcribes.push({ bytes: bytes.length });
      return transcribeResult;
    },
    cancelTranscribe: () => {},
    runText: svc.runIntentHook ?? null,
  };
  svc.attachExecutor(executor);
  return {
    svc, mic, clock, timers, transcribes, runTexts,
    status: () => svc.status(), // async — tests await it
    feed: (chunk) => { mic.current?.onAudio?.(chunk); },
    advance: clock.advance,
    tick() { for (const timer of timers) if (!timer.cleared) timer.fn(); },
    silenceMs(ms = 200, count = 12) {
      for (let i = 0; i < count; i += 1) { mic.pushSilentChunk(clock); }
      clock.advance(ms * count);
      this.tick();
    },
  };

  function makeMic() {
    let current = null;
    let resolveDone = null;
    const self = {
      get current() { return current; },
      active: () => (current ? { id: current.id, label: current.label, device: 'default', startedAt: new Date().toISOString(), elapsedMs: 0 } : null),
      listDevices: async () => [{ id: 'test-mic', description: 'Test Microphone' }],
      start: async ({ label, onAudio }) => {
        if (current) throw Object.assign(new Error('MIC_BUSY'), { code: 'MIC_BUSY' });
        current = { id: `mic-${label}`, label, onAudio, stopped: false };
        const done = new Promise((resolve) => { resolveDone = resolve; });
        return { id: current.id, done };
      },
      stop: (reason) => {
        const ended = {
          id: current?.id ?? 'mic-none', label: current?.label ?? 'ptt', device: 'default',
          durationMs: 800, bytes: 32_000, peakRms: 900, avgRms: 700, reason, error: null,
        };
        current = null;
        resolveDone?.(ended);
        return ended;
      },
      end(summary) { current = null; resolveDone?.(summary); },
      dispose: () => { current = null; },
    };
    self.pushSilentChunk = (clockHandle) => {
      self.feedSilent();
      clockHandle.advance(150);
    };
    self.feedSilent = () => {
      const chunk = pcm({ rms: 60 });
      current?.onAudio?.(chunk);
    };
    return self;
  }
}

test('listening → hearing at first real PCM; ambient never trips voice', async () => {
  const env = world();
  await env.svc.startPtt({ silenceMs: 1600, durationMs: 15_000 });
  assert.equal((await env.status()).state, 'listening');
  env.feed(pcm({ rms: 0 })); // first chunk: silent but REAL delivery
  assert.equal((await env.status()).state, 'hearing');
  // One minute of ambient hum can never become speech nor submit.
  for (let i = 0; i < 60; i += 1) {
    env.feed(pcm({ rms: 60 }));
    env.advance(150);
    env.tick();
  }
  assert.equal((await env.status()).state, 'hearing', 'ambient-only capture stays live');
  const lastAction = (await env.status()).lastAction;
  assert.ok(!lastAction || lastAction.transcript === undefined || lastAction.transcript === null, 'nothing was submitted');
});

test('voice over the calibrated floor sets speechSeen and drives the level metric', async () => {
  const env = world();
  await env.svc.startPtt({ silenceMs: 1600, durationMs: 15_000 });
  for (let i = 0; i < 4; i += 1) { env.feed(pcm({ rms: 80, seconds: 0.1 })); env.advance(120); }
  env.advance(500); // leave the calibration window
  const snap = await env.status();
  assert.equal(snap.state, 'hearing');
  assert.ok(snap.hearLevel < 0.05, `ambient floor reads near zero (got ${snap.hearLevel})`);
  // Three voiced chunks: the EMA settles upward instead of jumping once.
  env.feed(pcm({ rms: 1000, seconds: 0.12 }));
  env.advance(150);
  env.feed(pcm({ rms: 1100, seconds: 0.12 }));
  env.advance(150);
  env.feed(pcm({ rms: 1000, seconds: 0.12 }));
  env.advance(150);
  const loud = await env.status();
  assert.ok(loud.hearLevel > 0.3, `loud chunks raise the level (got ${loud.hearLevel})`);
  // Ambient-like quiet chunks settle the level back down naturally.
  for (let i = 0; i < 6; i += 1) { env.feed(pcm({ rms: 60, seconds: 0.12 })); env.advance(150); }
  const settled = await env.status();
  assert.ok(settled.hearLevel < 0.1, `quiet settles the visualizer (got ${settled.hearLevel})`);
  await env.svc.stopPtt();
});

test('speech then sustained silence submits ONCE and routes the transcript', async () => {
  const env = world();
  await env.svc.startPtt({ silenceMs: 1600, durationMs: 15_000 });
  for (let i = 0; i < 4; i += 1) { env.feed(pcm({ rms: 80, seconds: 0.1 })); env.advance(120); }
  env.advance(500);
  env.feed(pcm({ rms: 1000, seconds: 0.12 }));
  env.advance(150);
  env.feed(pcm({ rms: 1100, seconds: 0.12 }));
  env.advance(150);
  assert.equal((await env.status()).state, 'hearing');
  // Sustained silence after voice: 1.6s → watchdog submits.
  for (let i = 0; i < 14; i += 1) {
    env.feed(pcm({ rms: 60, seconds: 0.12 }));
    env.advance(150);
    env.tick();
  }
  // Submission is async: let the STT + router microtasks settle first.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.transcribes.length, 1, 'single-flight: exactly one STT request');
  assert.equal(env.runTexts.join(' '), 'play madira');
  assert.equal((await env.status()).state, 'disabled');
});

test('manual stop without speech never executes a command', async () => {
  const env = world({ transcribeResult: { status: 'silence', text: '' } });
  await env.svc.startPtt({ silenceMs: 1600, durationMs: 15_000 });
  for (let i = 0; i < 6; i += 1) { env.feed(pcm({ rms: 70, seconds: 0.1 })); env.advance(120); }
  const result = await env.svc.stopPtt();
  assert.equal(env.transcribes.length, 1, 'manual stop still verifies via STT once');
  assert.equal(result.executed, false);
  assert.equal(env.runTexts.length, 0, 'no router run on empty speech');
  assert.match(String(result.reply ?? ''), /hear|recognise|ambient|loud/i);
  assert.equal((await env.status()).state, 'disabled');
});

test('max duration with observed speech still submits the recording', async () => {
  const env = world();
  await env.svc.startPtt({ silenceMs: 1600, durationMs: 15_000 });
  for (let i = 0; i < 4; i += 1) { env.feed(pcm({ rms: 80, seconds: 0.1 })); env.advance(120); }
  env.advance(500);
  env.feed(pcm({ rms: 1000, seconds: 0.12 }));
  env.advance(150);
  env.feed(pcm({ rms: 1100, seconds: 0.12 }));
  env.advance(150);
  const summary = { durationMs: 15_000, bytes: 96_000, peakRms: 1100, avgRms: 400, reason: 'max-duration', error: null };
  env.mic.end(summary);
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.transcribes.length, 1, 'real speech at timeout is transcribed, not dropped');
  assert.equal(env.runTexts.length, 1);
});

test('max duration without speech reports a clear timeout and nothing executes', async () => {
  const env = world();
  await env.svc.startPtt({ silenceMs: 1600, durationMs: 15_000 });
  for (let i = 0; i < 8; i += 1) { env.feed(pcm({ rms: 80, seconds: 0.1 })); env.advance(120); }
  const summary = { durationMs: 15_000, bytes: 32_000, peakRms: 90, avgRms: 80, reason: 'max-duration', error: null };
  env.mic.end(summary);
  await new Promise((resolve) => setImmediate(resolve));
  const snap = await env.status();
  assert.equal(env.runTexts.length, 0);
  assert.match(String(snap.lastAction.note ?? ''), /[Tt]imed out before any speech/);
  assert.equal(snap.state, 'disabled');
});

test('double stop runs the transcriber once (duplicate press protection)', async () => {
  const env = world();
  await env.svc.startPtt({ silenceMs: 1600, durationMs: 15_000 });
  for (let i = 0; i < 5; i += 1) { env.feed(pcm({ rms: 1000, seconds: 0.1 })); env.advance(120); }
  const [a, b] = [env.svc.stopPtt(), env.svc.stopPtt()];
  await Promise.resolve();
  await Promise.all([a, b]);
  assert.equal(env.transcribes.length, 1);
});

test('cancellation empties the buffer and never submits', async () => {
  const env = world();
  await env.svc.startPtt({ silenceMs: 1600, durationMs: 15_000 });
  for (let i = 0; i < 5; i += 1) { env.feed(pcm({ rms: 1000, seconds: 0.1 })); env.advance(120); }
  await env.svc.cancelPtt();
  assert.equal(env.transcribes.length, 0);
  assert.equal(env.runTexts.length, 0);
  assert.equal((await env.status()).state, 'disabled');
  assert.equal((await env.status()).lastAction.kind, 'ptt-cancelled');
});

test('slow transcription keeps waiting — no fake idle mid-flight', async () => {
  const env = world({ transcribeResult: { status: 'silence', text: '' } });
  const slowSvc = env.svc;
  // Replace the executor with a slow transcribe mid-flight.
  let releaseTranscribe;
  env.svc.attachExecutor({
    transcribe: () => new Promise((resolve) => { releaseTranscribe = () => resolve({ status: 'ok', text: 'pause' }); }),
    cancelTranscribe: () => {},
  });
  await slowSvc.startPtt({ silenceMs: 1600, durationMs: 15_000 });
  for (let i = 0; i < 5; i += 1) { env.feed(pcm({ rms: 1000, seconds: 0.1 })); env.advance(120); }
  const pending = slowSvc.stopPtt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await env.status()).state, 'transcribing', 'stays thinking while STT runs');
  releaseTranscribe();
  await pending;
  assert.equal((await env.status()).state, 'disabled');
});
