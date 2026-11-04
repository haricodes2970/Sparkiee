import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { createSparkieeServer } from '../packages/server/src/server.mjs';
import { createVoiceService } from '../packages/server/src/voice-service.mjs';
import { createPetController } from '../packages/core/src/pet-state.mjs';

const TOKEN = 'e'.repeat(64);

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
  const server = createSparkieeServer({ port, token: TOKEN, startedAt: Date.now() - 1500, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, port };
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

/** Chat provider double: records the message lists it is handed. */
function fakeChatProvider({ configured = true, localOnly = false, reply = 'Four.', error = null } = {}) {
  const calls = { chat: [], describe: 0 };
  return {
    calls,
    configured: () => configured,
    describe: () => {
      calls.describe += 1;
      return { configured, source: 'file', model: 'meta/llama-3.1-8b-instruct', baseUrl: 'https://integrate.api.nvidia.com/v1', localOnly };
    },
    async chat(messages) {
      calls.chat.push(messages);
      if (error) return { ok: false, error };
      return { ok: true, text: reply, model: 'meta/llama-3.1-8b-instruct', usage: { total_tokens: 5 } };
    },
  };
}

/** Minimal music service double. */
function musicStub() {
  const events = [];
  return {
    events,
    playbackStatus: () => ({ phase: 'stopped', engine: { backend: 'cvlc' }, track: null }),
    play: async (options) => { events.push(['play', options]); return { phase: 'playing' }; },
    pause: async () => ({ phase: 'paused' }),
    resume: async () => ({ phase: 'playing' }),
    stop: async () => { events.push(['stop']); return { phase: 'stopped' }; },
    next: async () => ({ phase: 'playing' }),
    previous: async () => ({ phase: 'playing' }),
    updateSettings: async () => ({ volume: 0.7 }),
    searchRanked: async () => [],
    duckForSpeech: () => {},
  };
}

function voiceStub() {
  const calls = { speak: [], waitForPlayback: [] };
  let nextId = 1;
  return {
    calls,
    async speak(text, options = {}) {
      const id = nextId++;
      calls.speak.push({ text, options, id });
      return { speech: { id, text, clipId: 'a'.repeat(64), error: null, source: options.source ?? 'api', at: new Date().toISOString() } };
    },
    async waitForPlayback(id) {
      calls.waitForPlayback.push(id);
      return { id, clipId: 'a'.repeat(64), status: 'played', detail: '900ms', at: new Date().toISOString() };
    },
    async status() {
      return { configured: true, provider: 'elevenlabs' };
    },
  };
}

function assistantStub({ startOrder = [] } = {}) {
  return {
    _startOrder: startOrder,
    async status() { return { state: 'disabled', micActive: false, cancellable: false, listening: false, wake: { status: 'ready' } }; },
    async startPtt() { startOrder.push('mic-start'); return { sessionId: 'ptt-1', done: Promise.resolve({ handled: false }) }; },
    async stopPtt() { return { sessionId: 'ptt-1', done: Promise.resolve({ handled: false }) }; },
    recordAction() {},
  };
}

async function postText(port, text) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/assistant/command`, {
    method: 'POST', headers: auth, body: JSON.stringify({ text }),
  });
  return { response, body: await response.json() };
}

test('music commands are parsed first and never reach the chat model', async () => {
  const chat = fakeChatProvider();
  const instance = await startServer({ musicService: musicStub(), chatProvider: chat, assistantThrottleMs: 0, voiceService: voiceStub() });
  try {
    for (const text of ['stop', 'pause', 'play something']) {
      const { body } = await postText(instance.port, text);
      assert.equal(body.intent !== 'chat', true, `"${text}" was routed as a music intent, not chat`);
    }
    assert.equal(chat.calls.chat.length, 0, 'not one simple music command reached the model');
  } finally {
    await close(instance.server);
  }
});

test('a conversational turn reaches the chat model and is spoken back', async () => {
  const chat = fakeChatProvider({ reply: 'Two plus two is four.' });
  const voice = voiceStub();
  const instance = await startServer({ musicService: musicStub(), chatProvider: chat, voiceService: voice, assistantThrottleMs: 0 });
  try {
    const { body } = await postText(instance.port, 'what is two plus two?');
    assert.equal(body.handled, true);
    assert.equal(body.intent, 'chat');
    assert.equal(body.reply, 'Two plus two is four.');
    assert.equal(body.executed, false, 'chat never claims to have executed anything');
    assert.equal(chat.calls.chat.length, 1);
    const messages = chat.calls.chat[0];
    assert.equal(messages[0].role, 'system', 'a system prompt frames the model');
    assert.equal(messages[messages.length - 1].content, 'what is two plus two?');
    assert.equal(voice.calls.speak.length, 1, 'the reply is spoken, not only captioned');
    assert.equal(voice.calls.speak[0].text, 'Two plus two is four.');
    assert.equal(body.speech.clipId, 'a'.repeat(64));
  } finally {
    await close(instance.server);
  }
});

test('with no chat provider the reply is an honest explanation, and nothing is sent anywhere', async () => {
  const instance = await startServer({ musicService: musicStub(), assistantThrottleMs: 0 });
  try {
    const { body } = await postText(instance.port, 'what is the weather?');
    assert.equal(body.handled, false);
    assert.equal(body.executed, false);
    assert.equal(body.chatError, 'not_configured');
    assert.match(body.reply, /not connected to a chat assistant/i);
    assert.match(body.reply, /assistant setup/);
  } finally {
    await close(instance.server);
  }
});

test('local-only mode never sends a transcript and says why', async () => {
  const chat = fakeChatProvider({ configured: false, localOnly: true });
  const instance = await startServer({ musicService: musicStub(), chatProvider: chat, assistantThrottleMs: 0, voiceService: voiceStub() });
  try {
    const { body } = await postText(instance.port, 'summarise my emails');
    assert.equal(body.handled, false);
    assert.equal(body.chatError, 'local_only');
    assert.match(body.reply, /local-only/i);
    assert.equal(chat.calls.chat.length, 0, 'no egress in local-only mode');
  } finally {
    await close(instance.server);
  }
});

test('a provider failure becomes an honest spoken error, never a fabricated answer', async () => {
  const chat = fakeChatProvider({ error: { code: 'rate_limited', message: 'NVIDIA is rate limiting this key. Wait a moment and try again.' } });
  const voice = voiceStub();
  const instance = await startServer({ musicService: musicStub(), chatProvider: chat, voiceService: voice, assistantThrottleMs: 0 });
  try {
    const { body } = await postText(instance.port, 'tell me a joke');
    assert.equal(body.error, true);
    assert.equal(body.executed, false);
    assert.equal(body.chatError, 'rate_limited');
    assert.match(body.reply, /rate limiting/);
    assert.equal(voice.calls.speak[0].text, body.reply, 'the failure is spoken too');
  } finally {
    await close(instance.server);
  }
});

test('conversation history is bounded, and the reset control clears it', async () => {
  const chat = fakeChatProvider();
  const instance = await startServer({ musicService: musicStub(), chatProvider: chat, assistantThrottleMs: 0, chatHistoryLimit: 4, voiceService: voiceStub() });
  try {
    for (let i = 0; i < 6; i += 1) await postText(instance.port, `turn ${i}`);

    const status = await (await fetch(`http://127.0.0.1:${instance.port}/api/v1/assistant/status`)).json();
    assert.ok(status.assistant.conversation, 'status reports conversation readiness');
    assert.ok(status.assistant.conversation.historyMessages <= 4, 'history stays bounded');

    // The last request must not carry the whole session (bounded context).
    const lastMessages = chat.calls.chat[chat.calls.chat.length - 1];
    assert.ok(lastMessages.length <= 6, `history bounded in the request too (got ${lastMessages.length})`);

    const reset = await fetch(`http://127.0.0.1:${instance.port}/api/v1/assistant/conversation/reset`, {
      method: 'POST', headers: auth, body: '{}',
    });
    assert.equal(reset.status, 200);
    const resetBody = await reset.json();
    assert.ok(resetBody.cleared > 0, 'reset reports how much was forgotten');
    assert.equal(resetBody.conversation.historyMessages, 0);

    const unauthorized = await fetch(`http://127.0.0.1:${instance.port}/api/v1/assistant/conversation/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(unauthorized.status, 403, 'reset is auth-gated');
  } finally {
    await close(instance.server);
  }
});

test('assistant status reports conversation readiness separately from mic and STT', async () => {
  const chat = fakeChatProvider();
  const instance = await startServer({ musicService: musicStub(), chatProvider: chat });
  try {
    const status = await (await fetch(`http://127.0.0.1:${instance.port}/api/v1/assistant/status`)).json();
    const conversation = status.assistant.conversation;
    assert.equal(conversation.configured, true);
    assert.equal(conversation.localOnly, false);
    assert.equal(conversation.model, 'meta/llama-3.1-8b-instruct');
    assert.ok(!JSON.stringify(conversation).toLowerCase().includes('apikey'), 'no key field');
    void status.assistant.stt;
    void status.assistant.mic;
  } finally {
    await close(instance.server);
  }
});

test('the summon greeting is spoken before the microphone opens', async () => {
  const order = [];
  const voice = voiceStub();
  const originalSpeak = voice.speak;
  voice.speak = async (text, options) => {
    order.push('greeting-spoken');
    return originalSpeak(text, options);
  };
  const originalWait = voice.waitForPlayback;
  voice.waitForPlayback = async (id) => {
    order.push('playback-confirmed');
    return originalWait(id);
  };
  const instance = await startServer({
    musicService: musicStub(),
    voiceService: voice,
    assistantService: assistantStub({ startOrder: order }),
    isVoiceReady: () => true,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/assistant/ptt/start`, {
      method: 'POST', headers: auth, body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(voice.calls.speak.length, 1, 'exactly one greeting');
    assert.match(voice.calls.speak[0].text, /^Hey, I'm Sparky!/);
    assert.deepEqual(order, ['greeting-spoken', 'playback-confirmed', 'mic-start'], 'greeting finishes before the mic opens');
  } finally {
    await close(instance.server);
  }
});

test('a muted or unconfigured voice still opens the mic (no greeting block)', async () => {
  const order = [];
  const instance = await startServer({
    musicService: musicStub(),
    assistantService: assistantStub({ startOrder: order }),
    isVoiceReady: () => false,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/assistant/ptt/toggle`, {
      method: 'POST', headers: auth, body: '{}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(order, ['mic-start'], 'mic opens immediately when there is nothing to say');
  } finally {
    await close(instance.server);
  }
});

test('a greeting failure never blocks the microphone', async () => {
  for (const [name, voice] of [
    ['speak throws', { async speak() { throw new Error('provider exploded'); } }],
    ['no clip returned', { async speak() { return { speech: { id: 1, text: 'hi', clipId: null, error: 'not_configured' } }; } }],
    ['no playback support', {
      async speak() { return { speech: { id: 1, text: 'hi', clipId: 'c'.repeat(64), error: null } }; },
    }],
  ]) {
    const order = [];
    const instance = await startServer({
      musicService: musicStub(),
      voiceService: voice,
      assistantService: assistantStub({ startOrder: order }),
      isVoiceReady: () => true,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/assistant/ptt/start`, {
        method: 'POST', headers: auth, body: '{}',
      });
      assert.equal(response.status, 200, `${name}: summon still succeeds`);
      assert.deepEqual(order, ['mic-start'], `${name}: mic opens anyway`);
    } finally {
      await close(instance.server);
    }
  }
});

test('the playback report endpoint is auth-gated and feeds the voice service', async () => {
  const recordings = [];
  const voice = {
    ...voiceStub(),
    recordPlayback(payload) { recordings.push(payload); return { ok: true, playback: { ...payload, at: 'now' } }; },
  };
  const instance = await startServer({ voiceService: voice });
  try {
    const noAuth = await fetch(`http://127.0.0.1:${instance.port}/api/v1/voice/playback`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, status: 'played' }),
    });
    assert.equal(noAuth.status, 401);

    const bad = await fetch(`http://127.0.0.1:${instance.port}/api/v1/voice/playback`, {
      method: 'POST', headers: auth, body: JSON.stringify({ id: 'nope', status: 'played' }),
    });
    assert.equal(bad.status, 400, 'malformed reports are rejected');

    const good = await fetch(`http://127.0.0.1:${instance.port}/api/v1/voice/playback`, {
      method: 'POST', headers: auth, body: JSON.stringify({ id: 3, status: 'failed', detail: 'playback_failed' }),
    });
    assert.equal(good.status, 200);
    assert.equal(recordings.length, 1);
    assert.deepEqual(recordings[0], { id: 3, clipId: null, status: 'failed', detail: 'playback_failed' });
  } finally {
    await close(instance.server);
  }
});

test('the real voice service records honest playback outcomes and releases waiters', async () => {
  const petController = createPetController();
  const cache = { async stats() { return { bytes: 0, files: 0 }; }, async lookup() { return null; }, async put() { return true; } };
  const service = createVoiceService({
    getConfig: () => ({ configured: false, config: { apiKey: null, voiceId: 'v', modelId: 'm', outputFormat: 'mp3_44100_128' } }),
    getClient: () => null,
    cache,
    petController,
    localTts: null,
    getLocalTtsStatus: async () => ({ provider: 'espeak-ng', status: 'unavailable', binary: null, version: null, detail: 'not installed' }),
  });

  assert.equal(service.recordPlayback({ id: 0, status: 'played' }).error, 'invalid_id');
  assert.equal(service.recordPlayback({ id: 1, status: 'confused' }).error, 'invalid_status');

  const waiting = service.waitForPlayback(7, { timeoutMs: 2000 });
  const recorded = service.recordPlayback({ id: 7, clipId: 'b'.repeat(64), status: 'played', detail: '1200ms' });
  assert.equal(recorded.ok, true);
  const resolved = await waiting;
  assert.equal(resolved.status, 'played');
  assert.equal(resolved.id, 7);

  const status = await service.status();
  assert.equal(status.lastPlayback.status, 'played');
  assert.equal(status.localFallback.available, false, 'an unavailable fallback is never claimed');
  assert.equal(status.localFallback.status, 'unavailable');
  assert.equal(status.localFallback.detail, 'not installed');

  // A timeout resolves null instead of hanging a caller forever.
  const timedOut = await service.waitForPlayback(999, { timeoutMs: 200 });
  assert.equal(timedOut, null);
});

test('a muted pet gets a caption, no provider call, and an honest muted error', async () => {
  const petController = createPetController();
  petController.updateSettings({ audio: { enabled: false } });
  let clientCalls = 0;
  const cache = { async stats() { return { bytes: 0, files: 0 }; }, async lookup() { return null; }, async put() { return true; } };
  const service = createVoiceService({
    getConfig: () => ({ configured: true, config: { apiKey: 'sk_x'.repeat(10), voiceId: 'v', modelId: 'm', outputFormat: 'mp3_44100_128' } }),
    getClient: () => ({ synthesize: async () => { clientCalls += 1; return { ok: true, bytes: Buffer.alloc(1), mime: 'audio/mpeg' }; } }),
    cache,
    petController,
    localTts: null,
  });
  const result = await service.speak('hello there');
  assert.equal(result.speech.error, 'muted');
  assert.equal(result.speech.clipId, null);
  assert.equal(clientCalls, 0, 'muted speech spends nothing');
  assert.equal((await service.status()).lastError, 'muted');
});

test('a working local fallback makes speech ready without any cloud key', async () => {
  const petController = createPetController();
  const cache = { async stats() { return { bytes: 0, files: 0 }; }, async lookup() { return null; }, async put() { return true; } };
  const service = createVoiceService({
    getConfig: () => ({ configured: false, config: { apiKey: null, voiceId: 'v', modelId: 'm', outputFormat: 'mp3_44100_128' } }),
    getClient: () => null,
    cache,
    petController,
    localTts: { voice: 'en-us', speed: 165, synthesize: async () => ({ ok: true, bytes: Buffer.alloc(4), mime: 'audio/wav' }) },
    getLocalTtsStatus: async () => ({ provider: 'espeak-ng', status: 'ready', binary: '/usr/bin/espeak-ng', version: '1.52', detail: null }),
  });
  const status = await service.status();
  assert.equal(status.configured, false, 'no cloud key');
  assert.equal(status.provider, 'espeak-ng', 'the honest provider is the local one');
  assert.equal(status.localFallback.available, true);
  assert.equal(status.localFallback.binary, '/usr/bin/espeak-ng');
  assert.equal(status.localFallback.version, '1.52');
});
