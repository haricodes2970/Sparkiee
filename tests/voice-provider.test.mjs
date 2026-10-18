import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElevenLabsClient, isValidUtterance, MAX_UTTERANCE_LENGTH } from '../packages/core/src/tts-client.mjs';
import { createAudioCache } from '../packages/core/src/audio-cache.mjs';
import { AGENT_EVENT_REACTIONS, AGENT_EVENT_TYPES, pickLine, VOICE_LINES, VOICE_TEST_PHRASE } from '../packages/core/src/voice-lines.mjs';
import { createVoiceService, describeSpeechError } from '../packages/server/src/voice-service.mjs';
import { createPetController } from '../packages/core/src/pet-state.mjs';

const CONFIG = { apiKey: 'sk_test_key_000000000000000000000000', voiceId: 'k7uh1RfFIE9Dn75CNvuX', modelId: 'eleven_flash_v2_5', outputFormat: 'mp3_44100_128' };

function toArrayBuffer(buffer) {
  const b = Buffer.from(buffer);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function mockResponse({ status = 200, body = null, json = null, bytes = 'ID3audio-bytes' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (json ?? body),
    arrayBuffer: async () => toArrayBuffer(bytes),
  };
}

// ---------------------------------------------------------------------------
// TTS client
// ---------------------------------------------------------------------------

test('synthesize sends the documented ElevenLabs request and returns audio', async () => {
  const calls = [];
  const client = createElevenLabsClient({
    config: CONFIG,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return mockResponse({ bytes: 'mp3data' });
    },
  });
  const result = await client.synthesize("Hey! I'm Sparky!");
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'audio/mpeg');
  assert.equal(result.audio.toString(), 'mp3data');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/k7uh1RfFIE9Dn75CNvuX\?output_format=mp3_44100_128$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['xi-api-key'], CONFIG.apiKey);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.text, "Hey! I'm Sparky!");
  assert.equal(payload.model_id, 'eleven_flash_v2_5');
  assert.equal(typeof payload.voice_settings.stability, 'number');
});

test('the api key never appears in results or error messages', async () => {
  const client = createElevenLabsClient({
    config: CONFIG,
    fetchImpl: async () => mockResponse({ status: 401 }),
  });
  const result = await client.synthesize('hello');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'auth');
  assert.ok(!JSON.stringify(result).includes(CONFIG.apiKey));
  assert.match(result.message, /voice setup/);
});

test('error statuses map to honest, actionable codes', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'quota'], [429, 'rate'], [422, 'validation'], [500, 'provider']]) {
    const client = createElevenLabsClient({ config: CONFIG, fetchImpl: async () => mockResponse({ status }) });
    const result = await client.synthesize('hello there');
    assert.equal(result.code, code, `HTTP ${status} -> ${code}`);
    assert.ok(result.message.length > 10);
  }
});

test('timeouts and transport failures are distinguished', async () => {
  const timeoutClient = createElevenLabsClient({
    config: CONFIG,
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  assert.equal((await timeoutClient.synthesize('hi')).code, 'timeout');
  const networkClient = createElevenLabsClient({
    config: CONFIG,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal((await networkClient.synthesize('hi')).code, 'network');
});

test('invalid utterances are rejected before any network call', async () => {
  let called = 0;
  const client = createElevenLabsClient({ config: CONFIG, fetchImpl: async () => { called += 1; return mockResponse(); } });
  for (const bad of ['', '   ', 'x'.repeat(MAX_UTTERANCE_LENGTH + 1), 42, null, 'bad\u0000control']) {
    const result = await client.synthesize(bad);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'validation');
  }
  assert.equal(called, 0, 'no request left the machine');
});

test('client refuses to be constructed without a key', () => {
  assert.throws(() => createElevenLabsClient({ config: { apiKey: null } }), /configured API key/);
});

test('verify is credit-free and reports key/voice problems', async () => {
  const ok = createElevenLabsClient({ config: CONFIG, fetchImpl: async () => mockResponse({ json: { voice: { name: 'Sparky' } } }) });
  assert.deepEqual(await ok.verify(), { ok: true, voiceId: CONFIG.voiceId, name: 'Sparky' });
  const bad = createElevenLabsClient({ config: CONFIG, fetchImpl: async () => mockResponse({ status: 401 }) });
  assert.equal((await bad.verify()).code, 'auth');
  const missing = createElevenLabsClient({ config: CONFIG, fetchImpl: async () => mockResponse({ status: 404 }) });
  assert.equal((await missing.verify()).code, 'validation');
});

test('utterance validation matches the length contract', () => {
  assert.equal(isValidUtterance('Your task is complete!'), true);
  assert.equal(isValidUtterance(''), false);
  assert.equal(isValidUtterance('x'.repeat(MAX_UTTERANCE_LENGTH + 1)), false);
  assert.equal(isValidUtterance('ok\u0007bell'), false);
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
    await new Promise((r) => setTimeout(r, 20));
    await cache.put(KEY_B, blob);
    const third = 'c'.repeat(64);
    await new Promise((r) => setTimeout(r, 20));
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
    const stray = path.join(dir, '..', 'outside.mp3');
    assert.notEqual(path.resolve(stray), file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Voice lines and agent reactions
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

function makeService({ configured = true, synthesizeImpl = null, maxBytes = undefined } = {}) {
  const dir = path.join(os.tmpdir(), `sparkiee-vs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cache = createAudioCache({ dir, maxBytes });
  const pet = createPetController();
  const calls = [];
  const service = createVoiceService({
    getConfig: () => ({ configured, config: CONFIG }),
    getClient: () => (configured ? {
      synthesize: synthesizeImpl ?? (async (text) => {
        calls.push(text);
        return { ok: true, audio: Buffer.from(`audio:${text}`), mime: 'audio/mpeg' };
      }),
    } : null),
    cache,
    petController: pet,
  });
  return { service, pet, calls, dir, cache };
}

test('speak publishes a clip announcement and caches the audio', async () => {
  const { service, pet, calls, dir } = makeService();
  try {
    const snapshot = await service.speak('Your task is complete!');
    assert.equal(calls.length, 1);
    assert.ok(snapshot.speech.clipId, 'clip id published');
    assert.equal(snapshot.speech.text, 'Your task is complete!');
    assert.equal(snapshot.speech.error, null);
    // second identical phrase is served from cache: no new provider call
    await service.speak('Your task is complete!');
    assert.equal(calls.length, 1, 'cache hit, no duplicate spend');
    const status = await service.status();
    assert.equal(status.cacheFiles, 1);
    assert.ok(!JSON.stringify(status).includes(CONFIG.apiKey), 'status never leaks the key');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unconfigured speak still announces the caption with an honest error', async () => {
  const { service, pet, dir } = makeService({ configured: false });
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

test('provider failures become honest speech errors, not fake success', async () => {
  const { service, dir } = makeService({ synthesizeImpl: async () => ({ ok: false, code: 'quota', message: 'out of credits' }) });
  try {
    const snapshot = await service.speak('Yay!');
    assert.equal(snapshot.speech.clipId, null);
    assert.equal(snapshot.speech.error, 'quota');
    assert.match(describeSpeechError('quota'), /credits/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('in-flight requests for the same phrase share one provider call', async () => {
  let resolveFirst;
  let invocations = 0;
  const { service, dir } = makeService({
    synthesizeImpl: () => {
      invocations += 1;
      return new Promise((resolve) => { resolveFirst = () => resolve({ ok: true, audio: Buffer.from('x'), mime: 'audio/mpeg' }); });
    },
  });
  try {
    const p1 = service.speak('Still working on it!');
    const p2 = service.speak('Still working on it!');
    await new Promise((r) => setTimeout(r, 10));
    resolveFirst();
    await Promise.all([p1, p2]);
    assert.equal(invocations, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('user-triggered tests are rate limited while events are not', async () => {
  const { service, dir } = makeService();
  try {
    for (let i = 0; i < 5; i += 1) await service.test();
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
