import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { createSparkieeServer } from '../packages/server/src/server.mjs';
import { createVoiceService } from '../packages/server/src/voice-service.mjs';
import { createAudioCache } from '../packages/core/src/audio-cache.mjs';
import { createPetController } from '../packages/core/src/pet-state.mjs';
import { mimeForOutputFormat } from '../packages/core/src/voice-config.mjs';
import { COMMAND_SPEECH_EVENTS, SPEECH_EVENT_COOLDOWN_MS, VOICE_LINES } from '../packages/core/src/voice-lines.mjs';
import { withoutSecrets } from '../packages/core/src/env-safety.mjs';
import {
  readSpeechSettings,
  shouldFallbackChirp,
  shouldPlayEventChirp,
  speechCaptionDuration,
  speechCarriesReactions,
} from '../packages/pet-host/renderer/lib/speech-policy.mjs';

const TOKEN = 'd'.repeat(64);
const HIDDEN_KEY = 'sk_supersecret_key_0000000000000000';

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer(options = {}) {
  const port = await freePort();
  let shutdownRequested = false;
  const server = createSparkieeServer({
    port,
    token: TOKEN,
    startedAt: Date.now() - 1500,
    onShutdown: () => { shutdownRequested = true; },
    ...options,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, port, shutdownWasRequested: () => shutdownRequested };
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

/** Voice service double that records calls and returns canned results. */
function fakeVoiceService({ failRate = false } = {}) {
  const calls = { speak: [], speakEvent: [], test: 0, status: 0 };
  const speech = (text, { clipId = 'a'.repeat(64), error = null, source = 'api', id = calls.speak.length + calls.test + 1 } = {}) => ({
    id, text, clipId, error, voiceEvent: null, source, at: new Date().toISOString(),
  });
  return {
    calls,
    async speak(text, options = {}) {
      calls.speak.push({ text, options });
      if (failRate) throw Object.assign(new Error('Too many voice test requests.'), { code: 'RATE_LIMITED' });
      if (text === 'GENERATION_FAILS') return { speech: speech(text, { clipId: null, error: 'quota' }) };
      return { speech: speech(text) };
    },
    async speakEvent(voiceEvent, options = {}) {
      calls.speakEvent.push({ voiceEvent, options });
      return { speech: speech(VOICE_LINES[voiceEvent]?.[0] ?? voiceEvent) };
    },
    async test() {
      calls.test += 1;
      if (failRate) throw Object.assign(new Error('Too many voice test requests.'), { code: 'RATE_LIMITED' });
      return { speech: speech("Hi! I'm Sparky, your desktop companion.", { source: 'test' }) };
    },
    async status() {
      calls.status += 1;
      return { configured: true, voiceId: 'k7uh1RfFIE9Dn75CNvuX', modelId: 'eleven_flash_v2_5', outputFormat: 'mp3_44100_128', cacheFiles: 0, cacheBytes: 0, lastError: null, lastSpokenAt: null, maxSpeechLength: 220, apiKey: HIDDEN_KEY };
    },
    async getClip(key) {
      if (!/^[a-f0-9]{64}$/.test(key)) return { status: 'invalid' };
      if (key === 'f'.repeat(64)) return { status: 'missing' };
      return { status: 'ok', audio: Buffer.from('mp3-bytes'), mime: 'audio/mpeg' };
    },
  };
}

// ---------------------------------------------------------------------------
// Speech policy (renderer, pure)
// ---------------------------------------------------------------------------

const speechState = (speech, speechReady = true) => ({
  settings: { speech },
  speechReady,
});

test('speech policy: chirps yield only when spoken voice is active, enabled, and ready', () => {
  assert.equal(shouldPlayEventChirp(speechState({ enabled: true, provider: 'elevenlabs', style: 'speech' }, true)), false);
  assert.equal(shouldPlayEventChirp(speechState({ enabled: true, provider: 'elevenlabs', style: 'both' }, true)), true, 'both keeps chirps');
  assert.equal(shouldPlayEventChirp(speechState({ enabled: true, provider: 'elevenlabs', style: 'chirps' }, true)), true);
  assert.equal(shouldPlayEventChirp(speechState({ enabled: false, provider: 'elevenlabs', style: 'speech' }, true)), true, 'speech disabled');
  assert.equal(shouldPlayEventChirp(speechState({ enabled: true, provider: 'chirps', style: 'speech' }, true)), true, 'chirp provider');
  assert.equal(shouldPlayEventChirp(speechState({ enabled: true, provider: 'elevenlabs', style: 'speech' }, false)), true, 'not ready');
  assert.equal(shouldPlayEventChirp(speechState(undefined, false)), true, 'missing settings default to chirps');
  assert.equal(speechCarriesReactions(speechState({ enabled: true, provider: 'elevenlabs', style: 'speech' }, true)), true);
  assert.equal(readSpeechSettings(speechState({ style: 'nonsense' })).style, 'speech');
});

test('speech policy: failed speech restores the chirp only where it was suppressed, tests never silent', () => {
  const failure = { error: 'quota', source: 'command' };
  const now = 10_000;
  assert.equal(shouldFallbackChirp(failure, { suppressedAt: 9_500, now, windowMs: 3000 }), true, 'recent suppression restored');
  assert.equal(shouldFallbackChirp(failure, { suppressedAt: 6_000, now, windowMs: 3000 }), false, 'stale suppression ignored');
  assert.equal(shouldFallbackChirp(failure, { suppressedAt: 0, now }), false, 'chirp already played');
  assert.equal(shouldFallbackChirp({ error: 'auth', source: 'test' }, { suppressedAt: 0, now }), true, 'explicit test never silent');
  assert.equal(shouldFallbackChirp({ error: null, source: 'command' }, { suppressedAt: 9_500, now }), false, 'success needs no fallback');
  assert.equal(shouldFallbackChirp(null, { suppressedAt: 9_500, now }), false);
});

test('speech caption duration: configured duration is the floor, audio keeps the line up', () => {
  assert.equal(speechCaptionDuration({ configuredMs: 2600 }), 2600, 'no audio yet');
  assert.equal(speechCaptionDuration({ audioDurationSeconds: 1.2, configuredMs: 2600 }), 2600, 'short speech uses floor');
  assert.equal(speechCaptionDuration({ audioDurationSeconds: 4, configuredMs: 2600 }), 4700, 'long speech tracked');
  assert.equal(speechCaptionDuration({ audioDurationSeconds: 0, configuredMs: 1500 }), 1500);
  assert.equal(speechCaptionDuration({ configuredMs: -5 }), 2600, 'invalid config falls back');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('mimeForOutputFormat maps every supported format', () => {
  assert.equal(mimeForOutputFormat('mp3_44100_128'), 'audio/mpeg');
  assert.equal(mimeForOutputFormat('opus_48000_128'), 'audio/ogg');
  assert.equal(mimeForOutputFormat('wav_22050'), 'audio/wav');
  assert.equal(mimeForOutputFormat('pcm_16000'), 'application/octet-stream');
  assert.equal(mimeForOutputFormat(undefined), 'audio/mpeg');
});

test('command speech map: reactions only, every target line exists, movement never talks', () => {
  for (const [command, voiceEvent] of Object.entries(COMMAND_SPEECH_EVENTS)) {
    assert.ok(Array.isArray(VOICE_LINES[voiceEvent]), `${command} -> ${voiceEvent} has lines`);
  }
  for (const silent of ['walk', 'run', 'idle', 'hide', 'show']) {
    assert.equal(COMMAND_SPEECH_EVENTS[silent], undefined, `${silent} must not speak (roam chatter)`);
  }
  assert.ok(SPEECH_EVENT_COOLDOWN_MS >= 3000, 'cooldown is meaningful');
});

test('withoutSecrets strips daemon-only credentials without mutating the source', () => {
  const source = { HOME: '/home/u', ELEVENLABS_API_KEY: HIDDEN_KEY, SPARKIEE_PORT: '2005' };
  const safe = withoutSecrets(source);
  assert.equal('ELEVENLABS_API_KEY' in safe, false);
  assert.equal(safe.HOME, '/home/u');
  assert.equal(safe.SPARKIEE_PORT, '2005');
  assert.equal(source.ELEVENLABS_API_KEY, HIDDEN_KEY, 'original untouched');
  assert.deepEqual(withoutSecrets({ A: '1' }, []), { A: '1' });
});

// ---------------------------------------------------------------------------
// Real voice service clip delivery
// ---------------------------------------------------------------------------

test('voice service serves cached clips and refuses hostile ids', async (t) => {
  const dir = `${process.env.TMPDIR || '/tmp'}/sparkiee-clip-${process.pid}-${Date.now()}`;
  const cache = createAudioCache({ dir });
  const pet = createPetController();
  const service = createVoiceService({
    getConfig: () => ({ configured: true, config: { apiKey: HIDDEN_KEY, voiceId: 'k7uh1RfFIE9Dn75CNvuX', modelId: 'eleven_flash_v2_5', outputFormat: 'mp3_44100_128' } }),
    getClient: () => ({ synthesize: async () => ({ ok: true, audio: Buffer.from('clip-bytes'), mime: 'audio/mpeg' }) }),
    cache,
    petController: pet,
  });
  t.after(async () => { await cache.clear().catch(() => {}); });
  const snapshot = await service.speak('Hi there!');
  assert.ok(snapshot.speech.clipId);
  const clip = await service.getClip(snapshot.speech.clipId);
  assert.equal(clip.status, 'ok');
  assert.equal(clip.mime, 'audio/mpeg');
  assert.equal(clip.audio.toString(), 'clip-bytes');
  assert.equal((await service.getClip('../escape')).status, 'invalid');
  assert.equal((await service.getClip('not-hex-'.padEnd(64, 'z'))).status, 'invalid');
  assert.equal((await service.getClip('e'.repeat(64))).status, 'missing');
  assert.ok(!JSON.stringify(await service.status()).includes(HIDDEN_KEY), 'service status hides the key');
});

// ---------------------------------------------------------------------------
// HTTP voice endpoints
// ---------------------------------------------------------------------------

test('voice status is readable, secret-free, and refreshes configuration', async () => {
  const voice = fakeVoiceService();
  let refreshed = 0;
  const instance = await startServer({
    voiceService: voice,
    refreshVoiceConfig: async () => { refreshed += 1; return { configured: true, warnings: ['note'] }; },
    isVoiceReady: () => true,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/voice/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.voice.configured, true);
    assert.deepEqual(body.warnings, ['note']);
    assert.equal(refreshed, 1, 'config refreshed for status');
    assert.ok(!JSON.stringify(body).includes(HIDDEN_KEY), 'no key in status');
  } finally {
    await close(instance.server);
  }
});

test('voice speak requires local auth and never echoes secrets', async () => {
  const voice = fakeVoiceService();
  const instance = await startServer({ voiceService: voice, refreshVoiceConfig: async () => ({ configured: true, warnings: [] }), isVoiceReady: () => true });
  const base = `http://127.0.0.1:${instance.port}`;
  try {
    const anon = await fetch(`${base}/api/v1/voice/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hey!' }),
    });
    assert.equal(anon.status, 403, 'no token, no origin');

    const badText = await fetch(`${base}/api/v1/voice/speak`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    });
    assert.equal(badText.status, 400);

    const badEvent = await fetch(`${base}/api/v1/voice/speak`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ voiceEvent: 'not_an_event' }),
    });
    assert.equal(badEvent.status, 400);

    const ok = await fetch(`${base}/api/v1/voice/speak`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ voiceEvent: 'task_complete' }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.generated, true);
    assert.equal(body.speech.text, VOICE_LINES.task_complete[0], 'predefined line spoken');
    assert.ok(!JSON.stringify(body).includes(HIDDEN_KEY));

    const failed = await fetch(`${base}/api/v1/voice/speak`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ text: 'GENERATION_FAILS' }),
    });
    const failedBody = await failed.json();
    assert.equal(failed.ok, true, 'request succeeded');
    assert.equal(failedBody.generated, false, 'but speech generation honestly reported as failed');
    assert.equal(failedBody.speech.error, 'quota');
  } finally {
    await close(instance.server);
  }
});

test('voice test accepts same-origin dashboard requests and reports rate limits', async () => {
  const voice = fakeVoiceService();
  const instance = await startServer({ voiceService: voice, refreshVoiceConfig: async () => ({ configured: true, warnings: [] }), isVoiceReady: () => true });
  const base = `http://127.0.0.1:${instance.port}`;
  const origin = { origin: `http://127.0.0.1:${instance.port}`, host: `127.0.0.1:${instance.port}`, 'content-type': 'application/json' };
  try {
    const ok = await fetch(`${base}/api/v1/voice/test`, { method: 'POST', headers: origin });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.speech.source, 'test');
    assert.equal(body.generated, true);

    const crossSite = await fetch(`${base}/api/v1/voice/test`, {
      method: 'POST',
      headers: { origin: 'http://evil.example', host: `127.0.0.1:${instance.port}` },
    });
    assert.equal(crossSite.status, 403, 'cross-origin rejected');

    // A rate-limited service result maps to HTTP 429, not a fake success.
    const limited = fakeVoiceService({ failRate: true });
    const limitedInstance = await startServer({ voiceService: limited, refreshVoiceConfig: async () => ({ configured: true, warnings: [] }), isVoiceReady: () => true });
    try {
      const response = await fetch(`http://127.0.0.1:${limitedInstance.port}/api/v1/voice/test`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
      });
      assert.equal(response.status, 429);
    } finally {
      await close(limitedInstance.server);
    }
  } finally {
    await close(instance.server);
  }
});

test('clip delivery is token-only and validates ids', async () => {
  const voice = fakeVoiceService();
  const instance = await startServer({ voiceService: voice });
  const base = `http://127.0.0.1:${instance.port}`;
  try {
    const goodId = 'a'.repeat(64);
    const noAuth = await fetch(`${base}/api/v1/voice/clip/${goodId}`);
    assert.equal(noAuth.status, 401, 'same-origin is not enough for raw audio');

    const badId = await fetch(`${base}/api/v1/voice/clip/not-a-key`, { headers: authHeaders() });
    assert.equal(badId.status, 400);

    const missing = await fetch(`${base}/api/v1/voice/clip/${'f'.repeat(64)}`, { headers: authHeaders() });
    assert.equal(missing.status, 404);

    const ok = await fetch(`${base}/api/v1/voice/clip/${goodId}`, { headers: authHeaders() });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'audio/mpeg');
    assert.match(ok.headers.get('cache-control') ?? '', /private/);
    assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'mp3-bytes');
  } finally {
    await close(instance.server);
  }
});

// ---------------------------------------------------------------------------
// Command lifecycle speech
// ---------------------------------------------------------------------------

test('reactions speak predefined lines, gated by readiness, settings, and cooldowns', async () => {
  const voice = fakeVoiceService();
  const petController = createPetController();
  const instance = await startServer({
    petController,
    voiceService: voice,
    refreshVoiceConfig: async () => ({ configured: true, warnings: [] }),
    isVoiceReady: () => true,
  });
  const base = `http://127.0.0.1:${instance.port}`;
  const send = (command) => fetch(`${base}/api/v1/pet/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}`, host: `127.0.0.1:${instance.port}` },
    body: JSON.stringify({ command }),
  });
  try {
    await send('wave');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(voice.calls.speakEvent.map((c) => c.voiceEvent), ['greet'], 'wave greets');
    assert.equal(voice.calls.speakEvent[0].options.source, 'command');

    await send('wave'); // within cooldown
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(voice.calls.speakEvent.length, 1, 'cooldown stops repeats');

    await send('walk');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(voice.calls.speakEvent.length, 1, 'movement never speaks');

    await send('celebrate');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(voice.calls.speakEvent.at(-1).voiceEvent, 'celebration', 'celebrate speaks after cooldown boundary');

    // Speech disabled: silence, chirps alone.
    await fetch(`${base}/api/v1/pet/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}`, host: `127.0.0.1:${instance.port}` },
      body: JSON.stringify({ speech: { enabled: false } }),
    });
    const before = voice.calls.speakEvent.length;
    await send('confused');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(voice.calls.speakEvent.length, before, 'disabled speech stays quiet');

    // Style 'chirps': same silence even when enabled.
    await fetch(`${base}/api/v1/pet/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}`, host: `127.0.0.1:${instance.port}` },
      body: JSON.stringify({ speech: { enabled: true, style: 'chirps' } }),
    });
    await send('confused');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(voice.calls.speakEvent.length, before, 'chirp-only style never speaks');
  } finally {
    await close(instance.server);
  }
});

test('unconfigured provider: commands stay silent instead of announcing failures', async () => {
  const voice = fakeVoiceService();
  const instance = await startServer({
    voiceService: voice,
    refreshVoiceConfig: async () => ({ configured: false, warnings: [] }),
    isVoiceReady: () => false,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}`, host: `127.0.0.1:${instance.port}` },
      body: JSON.stringify({ command: 'wave' }),
    });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(voice.calls.speakEvent.length, 0, 'no announcements without a configured provider');
  } finally {
    await close(instance.server);
  }
});

test('no voice endpoint response ever contains an API key', async () => {
  const voice = fakeVoiceService();
  const instance = await startServer({ voiceService: voice, refreshVoiceConfig: async () => ({ configured: true, warnings: [] }), isVoiceReady: () => true });
  const base = `http://127.0.0.1:${instance.port}`;
  try {
    const responses = await Promise.all([
      fetch(`${base}/api/v1/voice/status`),
      fetch(`${base}/api/v1/voice/speak`, { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ text: 'hi' }) }),
      fetch(`${base}/api/v1/voice/test`, { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }) }),
      fetch(`${base}/api/v1/voice/clip/${'a'.repeat(64)}`, { headers: authHeaders() }),
      fetch(`${base}/api/v1/pet/state`),
    ]);
    for (const response of responses) {
      const text = await response.text();
      assert.ok(!text.includes(HIDDEN_KEY), `key leaked in ${response.url} (${response.status})`);
      assert.ok(!text.includes('sk_supersecret'), 'no partial key either');
    }
  } finally {
    await close(instance.server);
  }
});
