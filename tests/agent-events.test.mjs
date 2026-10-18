import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSparkieeServer } from '../packages/server/src/server.mjs';
import { AGENT_EVENT_COOLDOWN_MS, AGENT_EVENT_DEDUP_MS, isValidAgentEventPayload } from '../packages/core/src/agent-events.mjs';
import { AGENT_EVENT_REACTIONS, VOICE_LINES } from '../packages/core/src/voice-lines.mjs';
import {
  OPENCODE_EVENT_AGENT_MAP,
  createAgentReporter,
  parseOpenCodeEvent,
  reporterEventFor,
} from '../packages/plugin-opencode/observer.mjs';

const TOKEN = 'b'.repeat(64);
const HIDDEN_KEY = 'sk_agent_secret_00000000000000000';

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
  const server = createSparkieeServer({
    port,
    token: TOKEN,
    startedAt: Date.now() - 1500,
    onShutdown: () => {},
    ...options,
  });
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

function fakeVoiceService() {
  const calls = { speakEvent: [] };
  return {
    calls,
    async speakEvent(voiceEvent, options = {}) {
      calls.speakEvent.push({ voiceEvent, options });
      return { speech: { id: 1, text: VOICE_LINES[voiceEvent]?.[0] ?? voiceEvent, clipId: 'a'.repeat(64), error: null } };
    },
    async speak(text) {
      return { speech: { id: 1, text, clipId: null, error: 'quota' } };
    },
    async test() {
      return { speech: { id: 1, text: 'test', clipId: 'a'.repeat(64), error: null } };
    },
    async status() {
      return { configured: true, apiKey: HIDDEN_KEY };
    },
    async getClip() {
      return { status: 'missing' };
    },
  };
}

async function sendAgentEvent(port, payload, { token = TOKEN } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/agent/event`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

// ---------------------------------------------------------------------------
// Observer mapping (plugin side, pure)
// ---------------------------------------------------------------------------

test('observer maps only confirmed lifecycle facts from OpenCode V2 events', () => {
  const event = (type, sessionID = 'ses_1') => ({ type, data: { sessionID } });
  assert.equal(reporterEventFor(event('session.execution.succeeded')).event, 'task_complete');
  assert.equal(reporterEventFor(event('session.execution.started')).event, 'task_start');
  assert.equal(reporterEventFor(event('session.execution.failed')).event, 'task_error');
  assert.equal(reporterEventFor(event('permission.asked')).event, 'permission_request');
  assert.equal(reporterEventFor(event('session.idle')).event, 'session_idle', 'idle is reported but never celebrated');
  assert.equal(reporterEventFor(event('session.execution.interrupted')), null, 'user interrupt is silent');
  assert.equal(reporterEventFor(event('permission.replied')), null, 'human already handled it');
  assert.equal(reporterEventFor(event('message.part.delta')), null, 'content-bearing events never leave OpenCode');
  assert.equal(reporterEventFor(event('session.compaction.started')), null);
  assert.equal(reporterEventFor(null), null);
  assert.equal(reporterEventFor('not json {'), null);
  assert.equal(reporterEventFor({ nope: true }), null);
  assert.equal(reporterEventFor(event('session.idle', '')), null, 'empty session id rejected');
  assert.equal(reporterEventFor(event('session.idle', 'x'.repeat(200))), null, 'oversized session id rejected');

  // The exact V2 stream shape: string-encoded payloads parse identically.
  const encoded = JSON.stringify(event('session.execution.succeeded', 'ses_abc'));
  assert.deepEqual(reporterEventFor(encoded), { event: 'task_complete', sessionId: 'ses_abc' });
  assert.deepEqual(parseOpenCodeEvent(encoded).type, 'session.execution.succeeded');
});

test('observer reports facts without content and swallows cooldowns and failures', async () => {
  const sent = [];
  let clock = 1000;
  const report = createAgentReporter({
    send: async (payload) => { sent.push(payload); },
    now: () => clock,
    cooldownMs: 1000,
  });
  const event = (n) => JSON.stringify({ type: 'session.execution.succeeded', data: { sessionID: `ses_${n}` } });

  assert.deepEqual(await report(event(1)), { reported: true });
  assert.deepEqual(sent[0], { source: 'opencode', event: 'task_complete', sessionId: 'ses_1' }, 'no fields beyond the fact');
  clock += 100;
  assert.deepEqual(await report(event(1)), { reported: false, reason: 'cooldown' });
  assert.deepEqual(await report(event(2)), { reported: true }, 'other sessions are independent');
  clock += 1001;
  assert.deepEqual(await report(event(1)), { reported: true }, 'cooldown expiry allows a new report');
  assert.equal(sent.length, 3);

  const failing = createAgentReporter({ send: async () => { throw new Error('ECONNREFUSED'); }, cooldownMs: 1000 });
  assert.deepEqual(await failing(event(9)), { reported: false, reason: 'unreachable' }, 'daemon down never throws');
});

test('observer package relies on the host-provided module and contains no exit paths', async () => {
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../packages/plugin-opencode/package.json', import.meta.url)), 'utf8'));
  assert.deepEqual(manifest.dependencies, undefined, 'OpenCode provides @opencode/plugin; it must not be installed here');
  const index = await readFile(fileURLToPath(new URL('../packages/plugin-opencode/index.mjs', import.meta.url)), 'utf8');
  assert.ok(!index.includes('process.exit'), 'observer never exits OpenCode');
  assert.ok(!index.includes('ctx.permission'), 'observer never hooks or answers permission prompts');
});

test('constants honour the spec: idle and interrupts never complete tasks', () => {
  assert.equal(AGENT_EVENT_REACTIONS.session_idle.command, null);
  assert.equal(AGENT_EVENT_REACTIONS.session_idle.voiceEvent, null);
  assert.equal(AGENT_EVENT_REACTIONS.task_complete.command, 'celebrate');
  assert.equal(OPENCODE_EVENT_AGENT_MAP['session.execution.succeeded'], 'task_complete');
  assert.equal(AGENT_EVENT_REACTIONS[OPENCODE_EVENT_AGENT_MAP['session.idle']].voiceEvent, null, 'idle maps to an event that never speaks');
  assert.ok(AGENT_EVENT_DEDUP_MS < AGENT_EVENT_COOLDOWN_MS);
  assert.equal(isValidAgentEventPayload({ source: 'opencode', sessionId: 'ses_1', event: 'task_complete' }), true);
  assert.equal(isValidAgentEventPayload({ source: 'opencode', sessionId: 'ses_1', event: 'nonsense' }), false);
  assert.equal(isValidAgentEventPayload({ source: 'x'.repeat(40), sessionId: 'ses_1', event: 'task_complete' }), false);
  assert.equal(isValidAgentEventPayload({ source: 'opencode', sessionId: '', event: 'task_complete' }), false);
});

// ---------------------------------------------------------------------------
// Daemon endpoint
// ---------------------------------------------------------------------------

test('agent endpoint requires the local token and validates payloads', async () => {
  const instance = await startServer({ isVoiceReady: () => true });
  try {
    const anon = await sendAgentEvent(instance.port, { source: 'opencode', sessionId: 'ses_1', event: 'task_complete' }, { token: null });
    assert.equal(anon.response.status, 401);

    const bad = await sendAgentEvent(instance.port, { source: 'opencode', sessionId: 'ses_1', event: 'destroy_everything' });
    assert.equal(bad.response.status, 400);

    const incomplete = await sendAgentEvent(instance.port, { source: 'opencode', event: 'task_complete' });
    assert.equal(incomplete.response.status, 400);
  } finally {
    await close(instance.server);
  }
});

test('confirmed completion celebrates and speaks; idle and interrupts stay silent', async () => {
  const voice = fakeVoiceService();
  const commands = [];
  const petController = {
    command: (command) => { commands.push(command); return { settings: { speech: { enabled: true, provider: 'elevenlabs', style: 'both' } } }; },
    snapshot: () => ({ settings: { speech: { enabled: true, provider: 'elevenlabs', style: 'both' } } }),
  };
  const instance = await startServer({ petController, voiceService: voice, isVoiceReady: () => true });
  try {
    const done = await sendAgentEvent(instance.port, { source: 'opencode', sessionId: 'ses_a', event: 'task_complete' });
    assert.equal(done.response.status, 200);
    assert.equal(done.body.reaction.command, 'celebrate');
    assert.equal(done.body.speech, 'announced');
    assert.deepEqual(commands, ['celebrate'], 'pet celebrates on confirmed completion');
    await settle();
    assert.deepEqual(voice.calls.speakEvent.map((c) => c.voiceEvent), ['task_complete']);
    assert.equal(voice.calls.speakEvent[0].options.source, 'agent');

    const idle = await sendAgentEvent(instance.port, { source: 'opencode', sessionId: 'ses_a', event: 'session_idle' });
    assert.equal(idle.body.reaction.command, null, 'idle is not success');
    assert.equal(idle.body.reaction.voiceEvent, null, 'idle never speaks');
    assert.equal(idle.body.speech, 'skipped');
    await settle();
    assert.equal(voice.calls.speakEvent.length, 1, 'idle adds no celebration');

    const permission = await sendAgentEvent(instance.port, { source: 'opencode', sessionId: 'ses_a', event: 'permission_request' });
    assert.equal(permission.body.reaction.command, 'permission_required', 'pet looks attentive; the human still decides');
    await settle();
    assert.equal(voice.calls.speakEvent.at(-1).voiceEvent, 'permission_required');
  } finally {
    await close(instance.server);
  }
});

test('agent events dedupe within the window and throttle repeats per session', async () => {
  let clock = 5000;
  const voice = fakeVoiceService();
  const commands = [];
  const petController = {
    command: (command) => { commands.push(command); return { settings: { speech: { enabled: true, provider: 'elevenlabs', style: 'both' } } }; },
    snapshot: () => ({ settings: { speech: { enabled: true, provider: 'elevenlabs', style: 'both' } } }),
  };
  const instance = await startServer({
    petController,
    voiceService: voice,
    isVoiceReady: () => true,
    agentNow: () => clock,
  });
  try {
    const first = await sendAgentEvent(instance.port, { source: 'opencode', sessionId: 'ses_1', event: 'task_error' });
    assert.equal(first.body.throttled, undefined);

    clock += 500; // inside dedup window
    const dup = await sendAgentEvent(instance.port, { source: 'opencode', sessionId: 'ses_1', event: 'task_error' });
    assert.equal(dup.body.deduped, true);

    clock += AGENT_EVENT_DEDUP_MS; // beyond dedup, inside cooldown
    const repeat = await sendAgentEvent(instance.port, { source: 'opencode', sessionId: 'ses_1', event: 'task_error' });
    assert.equal(repeat.body.throttled, true);

    clock += AGENT_EVENT_COOLDOWN_MS; // cooldown over: react again
    const again = await sendAgentEvent(instance.port, { source: 'opencode', sessionId: 'ses_1', event: 'task_error' });
    assert.equal(again.body.throttled, undefined);

    const otherSession = await sendAgentEvent(instance.port, { source: 'opencode', sessionId: 'ses_2', event: 'task_error' });
    assert.equal(otherSession.body.throttled, undefined, 'sessions are independent');

    await settle();
    assert.deepEqual(commands, ['task_error', 'task_error', 'task_error'], 'duplicates and throttled repeats never re-act');
    assert.equal(voice.calls.speakEvent.length, 3);
  } finally {
    await close(instance.server);
  }
});

test('agent reactions respect speech settings and stay silent without a provider', async () => {
  const commands = [];
  const pet = (speech) => ({
    command: (command) => { commands.push(command); return { settings: { speech } }; },
    snapshot: () => ({ settings: { speech } }),
  });
  const disabled = fakeVoiceService();
  const off = await startServer({
    petController: pet({ enabled: false, provider: 'elevenlabs', style: 'speech' }),
    voiceService: disabled,
    isVoiceReady: () => true,
  });
  try {
    const response = await sendAgentEvent(off.port, { source: 'opencode', sessionId: 'ses_1', event: 'task_complete' });
    assert.equal(response.body.speech, 'skipped');
    await settle();
    assert.equal(disabled.calls.speakEvent.length, 0, 'disabled speech stays quiet');
    assert.deepEqual(commands, ['celebrate'], 'the visual reaction still happens');
  } finally {
    await close(off.server);
  }

  commands.length = 0;
  const unready = fakeVoiceService();
  const noProvider = await startServer({
    petController: pet({ enabled: true, provider: 'elevenlabs', style: 'speech' }),
    voiceService: unready,
    isVoiceReady: () => false,
  });
  try {
    await sendAgentEvent(noProvider.port, { source: 'opencode', sessionId: 'ses_1', event: 'task_error' });
    await settle();
    assert.equal(unready.calls.speakEvent.length, 0, 'no speech generation without a configured provider');
    assert.deepEqual(commands, ['task_error']);
  } finally {
    await close(noProvider.server);
  }
});

test('agent endpoint responses never contain secrets', async () => {
  const voice = fakeVoiceService();
  const instance = await startServer({ voiceService: voice, isVoiceReady: () => true });
  try {
    const { body } = await sendAgentEvent(instance.port, { source: 'opencode', sessionId: 'ses_1', event: 'task_complete' });
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes(HIDDEN_KEY));
    assert.ok(!serialised.includes('sk_agent_secret'));
    assert.ok(!serialised.includes(TOKEN));
  } finally {
    await close(instance.server);
  }
});
