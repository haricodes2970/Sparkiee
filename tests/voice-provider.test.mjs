import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiperTts, isValidUtterance, MAX_UTTERANCE_LENGTH, normaliseSpeechText } from '../packages/core/src/piper-tts.mjs';
import { DEFAULT_VOICES } from '../packages/core/src/voice-config.mjs';
import { createAudioCache } from '../packages/core/src/audio-cache.mjs';
import { AGENT_EVENT_REACTIONS, AGENT_EVENT_TYPES, pickLine, VOICE_LINES, VOICE_TEST_PHRASE } from '../packages/core/src/voice-lines.mjs';
import { createVoiceService, describeSpeechError } from '../packages/server/src/voice-service.mjs';
import { createPetController } from '../packages/core/src/pet-state.mjs';

const CONFIG = { engine: 'piper', voices: { ...DEFAULT_VOICES }, speed: 1 };

/** A real (tiny) PCM WAV so duration parsing is exercised, not stubbed. */
export function makeWav({ dataBytes = 4410 } = {}) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22050, 24);
  header.writeUInt32LE(44100, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

/**
 * Fake Piper worker: records the JSON request, writes a WAV to the requested
 * output path, and replies on stdout exactly like the Python worker does.
 */
function fakeWorker({ behavior = 'ok', onRequest = null } = {}) {
  const calls = [];
  const children = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('close', 0); };
    child.stdin = {
      write(line) {
        const request = JSON.parse(line);
        calls.push({ command, args, options, request });
        onRequest?.(request);
        if (behavior === 'silent') return;
        setTimeout(async () => {
          if (behavior === 'error') {
            child.stdout.emit('data', `${JSON.stringify({ id: request.id, ok: false, error: 'synthesis exploded' })}\n`);
            return;
          }
          if (behavior === 'empty') {
            await writeFile(request.out, Buffer.alloc(0));
          } else {
            await writeFile(request.out, makeWav());
          }
          child.stdout.emit('data', `${JSON.stringify({ id: request.id, ok: true })}\n`);
        }, 5);
      },
      end() {},
    };
    children.push(child);
    return child;
  };
  return { spawnImpl, calls, children };
}

function engineFor({ env = {}, config = CONFIG, exists = () => true, worker = fakeWorker(), timeoutMs = 2_000 } = {}) {
  const engine = createPiperTts({
    env: { HOME: '/home/u', XDG_DATA_HOME: '/home/u/.local/share', ...env },
    spawnImpl: worker.spawnImpl,
    existsSyncImpl: exists,
    getConfig: () => config,
    timeoutMs,
    idleUnloadMs: 0,
  });
  return { engine, worker };
}

// ---------------------------------------------------------------------------
// Piper engine
// ---------------------------------------------------------------------------

test('synth speaks through the resident worker and returns real WAV audio', async () => {
  const { engine, worker } = engineFor();
  try {
    const result = await engine.synthesize('Your task is complete!');
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'piper');
    assert.equal(result.mime, 'audio/wav');
    assert.equal(result.voiceId, DEFAULT_VOICES.en);
    assert.ok(result.audio.length > 44, 'real WAV bytes');
    assert.ok(result.durationMs > 0, 'duration derived from the WAV header');
    assert.equal(worker.calls.length, 1);
    assert.match(worker.calls[0].request.model, /en_US-lessac-medium\.onnx$/);
    assert.equal(worker.calls[0].request.text, 'Your task is complete!');
    assert.equal(worker.calls[0].options.stdio[0], 'pipe', 'text goes over stdin, never a shell');
  } finally {
    await engine.close();
  }
});

test('Devanagari text selects the Hindi voice and Latin text the English one', async () => {
  const { engine, worker } = engineFor();
  try {
    await engine.synthesize('नमस्ते, मैं स्पार्की हूँ।');
    await engine.synthesize('Hello, I am Sparky.');
    assert.match(worker.calls[0].request.model, /hi_IN-priyamvada-medium\.onnx$/);
    assert.match(worker.calls[1].request.model, /en_US-lessac-medium\.onnx$/);
  } finally {
    await engine.close();
  }
});

test('the configured speed reaches the worker', async () => {
  const { engine, worker } = engineFor({ config: { ...CONFIG, speed: 1.4 } });
  try {
    await engine.synthesize('faster please');
    assert.equal(worker.calls[0].request.speed, 1.4);
  } finally {
    await engine.close();
  }
});

test('a missing voice model fails honestly before anything is spawned', async () => {
  const { engine, worker } = engineFor({ exists: (file) => !file.includes(`${path.sep}voices${path.sep}`) });
  try {
    const result = await engine.synthesize('hello');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'voice_missing');
    assert.match(result.message, /voice setup/);
    assert.equal(worker.calls.length, 0, 'no wasted process');
  } finally {
    await engine.close();
  }
});

test('a missing runtime fails with an install instruction', async () => {
  const { engine, worker } = engineFor({ exists: () => false });
  try {
    const result = await engine.synthesize('hello');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_installed');
    assert.match(result.message, /sparkiee voice setup/);
    assert.equal(worker.calls.length, 0);
  } finally {
    await engine.close();
  }
});

test('a spawn failure (ENOENT) is reported, never thrown', async () => {
  const engine = createPiperTts({
    env: { HOME: '/home/u', XDG_DATA_HOME: '/home/u/.local/share' },
    spawnImpl: () => { const error = new Error('spawn ENOENT'); error.code = 'ENOENT'; throw error; },
    existsSyncImpl: () => true,
    getConfig: () => CONFIG,
  });
  try {
    const result = await engine.synthesize('hello');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_installed');
    assert.match(result.message, /voice setup/);
  } finally {
    await engine.close();
  }
});

test('a worker-side synthesis error becomes a stable failure code', async () => {
  const { engine } = engineFor({ worker: fakeWorker({ behavior: 'error' }) });
  try {
    const result = await engine.synthesize('hello');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'failed');
    assert.match(result.message, /synthesis exploded/);
  } finally {
    await engine.close();
  }
});

test('a silent worker times out instead of hanging forever', async () => {
  const { engine } = engineFor({ worker: fakeWorker({ behavior: 'silent' }), timeoutMs: 80 });
  try {
    const result = await engine.synthesize('hello');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'timeout');
  } finally {
    await engine.close();
  }
});

test('invalid utterances are rejected before any process work', async () => {
  const { engine, worker } = engineFor();
  try {
    for (const bad of ['', '   ', 'x'.repeat(MAX_UTTERANCE_LENGTH + 1), 42, null, 'bad\u0000control']) {
      const result = await engine.synthesize(bad);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'validation');
    }
    assert.equal(worker.calls.length, 0);
  } finally {
    await engine.close();
  }
});

test('probe reports ready, voices_missing, and not_installed without loading a model', async () => {
  const ready = engineFor();
  assert.equal((await ready.engine.probe()).status, 'ready');
  await ready.engine.close();

  const missingVoices = engineFor({ exists: (file) => !file.includes(`${path.sep}voices${path.sep}`) });
  const voices = await missingVoices.engine.probe();
  assert.equal(voices.status, 'voices_missing');
  assert.match(voices.detail, /voice setup/);
  await missingVoices.engine.close();

  const noRuntime = engineFor({ exists: () => false });
  const notInstalled = await noRuntime.engine.probe();
  assert.equal(notInstalled.status, 'not_installed');
  assert.equal(notInstalled.installed, false);
  await noRuntime.engine.close();
});

test('utterance validation and normalisation match the contract', () => {
  assert.equal(isValidUtterance('Your task is complete!'), true);
  assert.equal(isValidUtterance(''), false);
  assert.equal(isValidUtterance('x'.repeat(MAX_UTTERANCE_LENGTH + 1)), false);
  assert.equal(isValidUtterance('ok\u0007bell'), false);
  assert.equal(normaliseSpeechText('  hello\n\nworld  '), 'hello world');
});

// ---------------------------------------------------------------------------
// Audio cache
// ---------------------------------------------------------------------------

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

async function tempCache(maxBytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-audio-'));
  const dir = path.join(root, 'voice');
  return { root, dir, cache: createAudioCache({ dir, maxBytes }) };
}

test('cache round-trips clips and refuses hostile keys', async () => {
  const { root, cache } = await tempCache();
  try {
    assert.equal(await cache.get(KEY_A), null, 'miss before write');
    await cache.put(KEY_A, Buffer.from('clip-a'));
    assert.equal((await cache.get(KEY_A)).toString(), 'clip-a');
    const stats = await cache.stats();
    assert.equal(stats.files, 1);
    assert.ok(stats.bytes > 0);
    for (const bad of ['../escape', 'not-hex', 'A'.repeat(64), '', undefined, 'a'.repeat(63)]) {
      await assert.rejects(() => cache.put(bad, Buffer.from('x')), /hex digest/);
      await assert.rejects(() => cache.get(bad), /hex digest/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cache stays under its size cap by pruning oldest clips', async () => {
  const { root, cache } = await tempCache(1024);
  try {
    const blob = Buffer.alloc(400);
    await cache.put(KEY_A, blob);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cache.put(KEY_B, blob);
    const third = 'c'.repeat(64);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cache.put(third, blob);
    const { bytes } = await cache.stats();
    assert.ok(bytes <= 1024, `cache trimmed to cap (was ${bytes})`);
    assert.equal(await cache.get(KEY_A), null, 'oldest evicted');
    assert.ok(await cache.get(third), 'newest kept');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cache writes owner-only files inside its own directory', async () => {
  const { root, dir, cache } = await tempCache();
  try {
    const file = await cache.put(KEY_A, Buffer.from('secret-voice'));
    assert.ok(file.startsWith(path.resolve(dir) + path.sep), 'file inside cache dir');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(path.resolve(file).startsWith(path.resolve(dir) + path.sep), 'never outside its directory');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Voice lines and agent reactions (unchanged contract)
// ---------------------------------------------------------------------------

test('voice lines cover the required events and stay short', () => {
  for (const event of ['greet', 'curiosity', 'task_start', 'task_progress', 'task_complete', 'task_error', 'attention', 'permission_required', 'celebration', 'error', 'confused', 'nap']) {
    assert.ok(Array.isArray(VOICE_LINES[event]) && VOICE_LINES[event].length > 0, `${event} has lines`);
  }
  for (const lines of Object.values(VOICE_LINES)) {
    for (const line of lines) assert.ok(line.length <= 220, 'line within TTS limit');
  }
  assert.ok(VOICE_TEST_PHRASE.includes('Sparky'));
});

test('pickLine is deterministic and wraps safely', () => {
  assert.equal(pickLine('greet', 0), VOICE_LINES.greet[0]);
  assert.equal(pickLine('greet', 1), VOICE_LINES.greet[1]);
  assert.equal(pickLine('greet', VOICE_LINES.greet.length), VOICE_LINES.greet[0], 'wraps');
  assert.equal(pickLine('greet', -1), VOICE_LINES.greet.at(-1), 'negative wraps');
  assert.equal(pickLine('nope'), null);
});

test('agent reactions: only confirmed events announce; idle never claims success', () => {
  assert.deepEqual(AGENT_EVENT_REACTIONS.task_complete, { command: 'celebrate', voiceEvent: 'task_complete' });
  assert.deepEqual(AGENT_EVENT_REACTIONS.task_error, { command: 'task_error', voiceEvent: 'error' });
  assert.deepEqual(AGENT_EVENT_REACTIONS.permission_request, { command: 'permission_required', voiceEvent: 'permission_required' });
  assert.equal(AGENT_EVENT_REACTIONS.session_idle.command, null, 'idle is not completion');
  assert.equal(AGENT_EVENT_REACTIONS.session_idle.voiceEvent, null);
  for (const type of AGENT_EVENT_TYPES) {
    assert.ok(pickLine(AGENT_EVENT_REACTIONS[type].voiceEvent ?? '') !== null || type === 'session_idle');
  }
});

// ---------------------------------------------------------------------------
// Voice service
// ---------------------------------------------------------------------------

function makeService({ configured = true, synthesizeImpl = null } = {}) {
  const dir = path.join(os.tmpdir(), `sparkiee-vs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cache = createAudioCache({ dir });
  const pet = createPetController();
  const calls = [];
  const engine = {
    provider: 'piper',
    probe: async () => ({ engine: 'piper', status: 'ready', installed: true, voices: {}, detail: 'ready' }),
    synthesize: synthesizeImpl ?? (async (text, { language }) => {
      calls.push({ text, language });
      return { ok: true, audio: Buffer.from(makeWav()), mime: 'audio/wav', provider: 'piper' };
    }),
  };
  const service = createVoiceService({
    getConfig: () => ({ configured, config: CONFIG }),
    getEngine: () => (configured ? engine : null),
    cache,
    petController: pet,
  });
  return { service, pet, calls, dir, cache };
}

test('speak publishes a clip announcement and caches the audio', async () => {
  const { service, calls, dir } = makeService();
  try {
    const snapshot = await service.speak('Your task is complete!');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].language, 'en');
    assert.ok(snapshot.speech.clipId, 'clip id published');
    assert.equal(snapshot.speech.text, 'Your task is complete!');
    assert.equal(snapshot.speech.error, null);
    assert.equal(snapshot.provider, 'piper');
    // second identical phrase is served from cache: no new synthesis
    await service.speak('Your task is complete!');
    assert.equal(calls.length, 1, 'cache hit, no duplicate work');
    const status = await service.status();
    assert.equal(status.cacheFiles, 1);
    assert.equal(status.provider, 'piper');
    assert.equal(status.configured, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an old espeak-ng cache entry never shadows a newly configured Piper', async () => {
  const dir = path.join(os.tmpdir(), `sparkiee-vs-shadow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cache = createAudioCache({ dir });
  const pet = createPetController();
  let configured = false;
  let engineCalls = 0;
  let localCalls = 0;
  const engine = {
    probe: async () => ({ engine: 'piper', status: 'ready', installed: true, voices: {}, detail: 'ready' }),
    synthesize: async () => {
      engineCalls += 1;
      return { ok: true, audio: Buffer.from(makeWav()), mime: 'audio/wav' };
    },
  };
  const service = createVoiceService({
    getConfig: () => ({ configured, config: CONFIG }),
    getEngine: () => (configured ? engine : null),
    cache,
    petController: pet,
    localTts: {
      voice: 'en-us',
      speed: 165,
      synthesize: async () => {
        localCalls += 1;
        return { ok: true, audio: Buffer.from(makeWav()), mime: 'audio/wav' };
      },
    },
  });
  try {
    // First run: Piper absent, so the phrase is cached from the fallback.
    const fallback = await service.speak('A phrase spoken before Piper existed.');
    assert.equal(fallback.provider, 'espeak-ng');
    assert.equal(localCalls, 1);

    // Piper is installed later. The fallback cache entry must not win.
    configured = true;
    const spoken = await service.speak('A phrase spoken before Piper existed.');
    assert.equal(spoken.provider, 'piper');
    assert.equal(engineCalls, 1, 'the configured primary engine is used');
    assert.equal(localCalls, 1, 'the fallback is not asked again');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Hindi text reaches the engine with the Hindi language hint', async () => {
  const { service, calls, dir } = makeService();
  try {
    await service.speak('नमस्ते! मैं स्पार्की हूँ।');
    assert.equal(calls[0].language, 'hi');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unconfigured speak still announces the caption with an honest error', async () => {
  const { service, dir } = makeService({ configured: false });
  try {
    const snapshot = await service.speak('Hi there!');
    assert.equal(snapshot.speech.clipId, null);
    assert.equal(snapshot.speech.error, 'not_configured');
    assert.equal(snapshot.speech.text, 'Hi there!', 'caption survives without audio');
    const status = await service.status();
    assert.equal(status.configured, false);
    assert.equal(status.lastError, 'not_configured');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('engine failures become honest speech errors, not fake success', async () => {
  const { service, dir } = makeService({
    synthesizeImpl: async () => ({ ok: false, code: 'voice_missing', message: 'Hindi voice is not downloaded' }),
  });
  try {
    const snapshot = await service.speak('Yay!');
    assert.equal(snapshot.speech.clipId, null);
    assert.equal(snapshot.speech.error, 'voice_missing');
    assert.match(describeSpeechError('voice_missing'), /voice setup/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('in-flight requests for the same phrase share one engine call', async () => {
  let invocations = 0;
  const { service, dir } = makeService({
    synthesizeImpl: async () => {
      invocations += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true, audio: Buffer.from(makeWav()), mime: 'audio/wav' };
    },
  });
  try {
    await Promise.all([service.speak('Still working on it!'), service.speak('Still working on it!')]);
    assert.equal(invocations, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('user-triggered tests are rate limited while events are not', async () => {
  const { service, dir } = makeService();
  try {
    for (let index = 0; index < 5; index += 1) await service.test();
    await assert.rejects(() => service.test(), /Too many voice test/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('speech announcements increment ids so stale clips can be discarded', async () => {
  const { service, pet, dir } = makeService();
  try {
    const first = await service.speak('Hey! I am Sparky!');
    const second = await service.speak('Something went wrong. Let us take a look.');
    assert.ok(second.speech.id > first.speech.id);
    assert.equal(pet.snapshot().speech.text, 'Something went wrong. Let us take a look.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
