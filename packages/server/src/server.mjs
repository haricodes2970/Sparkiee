import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAuthorized, toRuntimePayload, DEFAULT_HOST } from '../../core/src/index.mjs';
import { createPetController, isValidPetCommandPayload, isValidPetSettingsPayload, isValidPresentationClaimPayload, isValidPresentationReleasePayload } from '../../core/src/pet-state.mjs';
import { AGENT_EVENT_REACTIONS, COMMAND_SPEECH_EVENTS, isValidVoiceEvent, pickLine, SPEECH_EVENT_COOLDOWN_MS } from '../../core/src/voice-lines.mjs';
import { AGENT_EVENT_COOLDOWN_MS, AGENT_EVENT_DEDUP_MS, AGENT_EVENT_MEMORY_LIMIT, isValidAgentEventPayload } from '../../core/src/agent-events.mjs';
import { parseMusicIntent, runMusicCommand } from '../../core/src/music-commands.mjs';
import { createSttService } from '../../core/src/stt-service.mjs';
import { createAssistantService } from './assistant-service.mjs';

const DASHBOARD_ROOT = fileURLToPath(new URL('../../dashboard/', import.meta.url));
const SHARED_LIB_ROOT = fileURLToPath(new URL('../../pet-host/renderer/lib/', import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/src/main.js', ['src/main.js', 'text/javascript; charset=utf-8']],
  ['/src/styles.css', ['src/styles.css', 'text/css; charset=utf-8']],
]);
// Browser-safe renderer modules the dashboard imports directly from the
// pet renderer library — one frame player, one policy set, one caption
// controller for both surfaces. Only these exact filenames are served.
const SHARED_LIB_FILES = new Map([
  ['/src/lib/frame-player.mjs', ['frame-player.mjs', 'text/javascript; charset=utf-8']],
  ['/src/lib/speech-policy.mjs', ['speech-policy.mjs', 'text/javascript; charset=utf-8']],
  ['/src/lib/caption.mjs', ['caption.mjs', 'text/javascript; charset=utf-8']],
  ['/src/lib/audio-engine.mjs', ['audio-engine.mjs', 'text/javascript; charset=utf-8']],
]);
const CHARACTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

async function readJsonBody(request, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    const error = new Error('A JSON request body is required.');
    error.statusCode = 400;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Malformed JSON request body.');
    error.statusCode = 400;
    throw error;
  }
}

function isSameOriginDashboardRequest(request, port) {
  const origin = request.headers.origin;
  const requestHost = request.headers.host;
  if (typeof origin !== 'string' || typeof requestHost !== 'string') return false;
  if (origin !== `http://${requestHost}`) return false;
  if (!requestHost.endsWith(`:${port}`)) return false;
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

async function serveStatic(response, route, files, rootPath) {
  const target = files.get(route);
  if (!target) return false;
  const [relativePath, contentType] = target;
  const root = path.resolve(rootPath);
  const fullPath = path.resolve(root, relativePath);
  if (!fullPath.startsWith(`${root}${path.sep}`) && fullPath !== path.resolve(root, 'index.html')) {
    sendJson(response, 400, { error: 'Invalid asset path' });
    return true;
  }
  try {
    await access(fullPath);
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': fileStat.size,
      'cache-control': route === '/' || route === '/index.html' ? 'no-cache' : 'public, max-age=60',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    });
    createReadStream(fullPath).pipe(response);
  } catch {
    sendJson(response, 500, { error: 'Dashboard asset unavailable' });
  }
  return true;
}

/** Serve a dashboard file, then any allowlisted shared renderer module. */
async function serveFrontendAsset(response, route) {
  if (await serveStatic(response, route, STATIC_FILES, DASHBOARD_ROOT)) return true;
  return serveStatic(response, route, SHARED_LIB_FILES, SHARED_LIB_ROOT);
}

function presentationErrorStatus(error) {
  if (error?.code === 'PRESENTATION_OWNED') return 409;
  if (typeof error?.code === 'string' && error.code.startsWith('INVALID_')) return 400;
  return 500;
}

/** Create the loopback-only Sparkiee HTTP API and dashboard server. */
export function createSparkieeServer({
  port,
  token,
  startedAt = Date.now(),
  onShutdown = () => {},
  petController = createPetController(),
  getHostState = () => ({ phase: 'idle', pid: null, pidAlive: false, lastError: null, restarts: 0, since: startedAt }),
  onRestartHost = () => {},
  getCharacterInfo = () => null,
  getCharacters = () => ({ packs: [], invalid: [] }),
  getPackDetail = async () => null,
  musicService = null,
  voiceService = null,
  assistantService = null,
  refreshVoiceConfig = async () => ({ configured: false, warnings: [] }),
  isVoiceReady = () => false,
  agentNow = () => Date.now(),
  agentEventDedupMs = AGENT_EVENT_DEDUP_MS,
  agentEventCooldownMs = AGENT_EVENT_COOLDOWN_MS,
  assistantThrottleMs = 400,
  assistantSpeechRateMax = 8,
  hotkey = null,
}) {
  let shutdownRequested = false;
  const commandSpeechSpokeAt = new Map(); // voiceEvent -> timestamp
  const agentEventSeen = new Map(); // `${sessionId}:${event}` -> timestamp
  let lastAssistantCommandAt = 0;
  const assistantSpeechTimes = []; // rolling window for TTS rate limiting

  /**
   * Command reactions may speak a predefined line when spoken voice is
   * configured, enabled, and the event is outside its cooldown. Movement
   * commands never speak (autonomous roaming must not chatter), and an
   * unconfigured provider keeps the original chirps alone.
   */
  async function maybeSpeakForCommand(command, snapshot) {
    if (!voiceService || !isVoiceReady()) return;
    const speech = snapshot?.settings?.speech;
    if (!speech || speech.enabled === false || speech.provider !== 'elevenlabs' || speech.style === 'chirps') return;
    const voiceEvent = COMMAND_SPEECH_EVENTS[command];
    if (!voiceEvent) return;
    const now = Date.now();
    if (now - (commandSpeechSpokeAt.get(voiceEvent) ?? -Infinity) < SPEECH_EVENT_COOLDOWN_MS) return;
    commandSpeechSpokeAt.set(voiceEvent, now);
    try {
      await voiceService.speakEvent(voiceEvent, { source: 'command' });
    } catch {
      // Speech is best-effort: the animation and chirp reaction already happened.
    }
  }

  /** Same bar as command speech: configured, enabled, ElevenLabs, not chirps. */
  function canSpeakAssistant() {
    if (!voiceService || !isVoiceReady()) return false;
    const speech = petController.snapshot()?.settings?.speech;
    return Boolean(speech) && speech.enabled !== false
      && speech.provider === 'elevenlabs' && speech.style !== 'chirps';
  }

  /** Within the rolling TTS budget for user-triggered assistant replies? */
  function assistantSpeechAllowed() {
    const now = Date.now();
    while (assistantSpeechTimes.length > 0 && now - assistantSpeechTimes[0] > 60_000) {
      assistantSpeechTimes.shift();
    }
    if (assistantSpeechTimes.length >= assistantSpeechRateMax) return false;
    assistantSpeechTimes.push(now);
    return true;
  }

  /**
   * The ONE text→action path. Used by the typed-command endpoint and by the
   * PTT transcript pipeline: every route runs the same parsing, throttling
   * policy, voice gate and action ledger, so speech and typing can never
   * diverge in behaviour.
   */
  async function runTextCommand(text) {
    const intent = parseMusicIntent(text);
    if (!intent) {
      return {
        handled: false,
        intent: null,
        reply: 'I did not catch a music command. Try: play, pause, resume, stop, next, previous, volume, shuffle, find, or what is playing.',
        executed: false,
        speech: null,
        playback: musicService.playbackStatus ? musicService.playbackStatus() : null,
      };
    }

    let result;
    try {
      result = await runMusicCommand(intent, {
        player: {
          play: (options) => musicService.play(options),
          pause: () => musicService.pause(),
          resume: () => musicService.resume(),
          stop: () => musicService.stop(),
          next: () => musicService.next(),
          previous: () => musicService.previous(),
          updateSettings: (partial) => musicService.updateSettings(partial),
          status: () => musicService.playbackStatus(),
        },
        searchRanked: (query, options) => musicService.searchRanked(query, options),
      });
    } catch (error) {
      return {
        handled: true,
        intent: intent.intent,
        executed: false,
        reply: `The ${intent.intent} action failed: ${error?.message?.slice(0, 120) ?? 'unknown error'}`,
        speech: null,
        error: true,
      };
    }

    // Speak only confirmed, meaningful replies — same gate as the endpoint.
    let speech = null;
    if (result.reply && canSpeakAssistant() && assistantSpeechAllowed()) {
      try {
        const snapshot = await voiceService.speak(result.reply, { source: 'assistant' });
        speech = snapshot.speech ?? null;
        if (speech?.clipId && musicService.duckForSpeech) {
          const estimateMs = Math.min(7000, 700 + result.reply.length * 65);
          musicService.duckForSpeech(estimateMs);
        }
      } catch {
        speech = null; // the textual reply remains truthful either way
      }
    }

    if (assistantService?.recordAction) {
      assistantService.recordAction({
        kind: 'command',
        text: String(text ?? ''),
        intent: intent.intent,
        reply: result.reply ?? null,
        executed: Boolean(result.executed),
      });
    }

    return {
      handled: true,
      intent: intent.intent,
      reply: result.reply,
      executed: Boolean(result.executed),
      speech,
      candidates: result.candidates ?? undefined,
      matches: result.matches ?? undefined,
      suggestions: result.suggestions ?? undefined,
      track: result.track ?? undefined,
      playback: musicService.playbackStatus ? musicService.playbackStatus() : null,
    };
  }

  // Local speech recognition for the transcript pipeline. Created once; the
  // recogniser subprocess exists only while a transcription runs.
  let sttService = null;
  if (assistantService?.attachExecutor) {
    if (!sttService) sttService = createSttService();
    assistantService.attachExecutor({
      transcribe: ({ pcm, sampleRate } = {}) => sttService.transcribe({ pcm, sampleRate }),
      cancelTranscribe: () => sttService.cancel(),
      runText: runTextCommand,
    });
  }
  const server = createServer(async (request, response) => {
    const host = request.socket.localAddress;
    if (host && host !== '127.0.0.1' && host !== '::ffff:127.0.0.1') {
      sendJson(response, 403, { error: 'Loopback access only' });
      return;
    }

    const method = request.method ?? 'GET';
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      sendJson(response, 400, { error: 'Invalid request URL' });
      return;
    }

    if (method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { ok: true, name: 'Sparkiee', version: '0.1.0' });
      return;
    }
    if (method === 'GET' && pathname === '/api/v1/runtime') {
      sendJson(response, 200, toRuntimePayload({ port, startedAt, host: getHostState() }));
      return;
    }
    if (method === 'GET' && pathname === '/api/v1/pet/state') {
      if (isAuthorized(request, token)) petController.heartbeat();
      sendJson(response, 200, petController.snapshot());
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/pet/command') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      if (!isValidPetCommandPayload(payload)) {
        sendJson(response, 400, { error: 'Invalid pet command payload.' });
        return;
      }
      const petSnapshot = petController.command(payload.command);
      // Pick up voice configuration changes (e.g. `sparkiee voice setup`)
      // without a daemon restart; the daemon throttles the actual file read.
      await refreshVoiceConfig().catch(() => {});
      await maybeSpeakForCommand(payload.command, petSnapshot);
      sendJson(response, 200, { ok: true, pet: petSnapshot });
      return;
    }
    if (method === 'PUT' && pathname === '/api/v1/pet/settings') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      if (!isValidPetSettingsPayload(payload)) {
        sendJson(response, 400, { error: `Invalid pet settings payload. Accepted keys: moveSpeed (${0.25}–${3}), autoRoam (boolean).` });
        return;
      }
      sendJson(response, 200, { ok: true, pet: petController.updateSettings(payload) });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/pet/test-sound') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      let payload = {};
      if (request.headers['content-length'] && request.headers['content-length'] !== '0') {
        try {
          payload = await readJsonBody(request);
        } catch (error) {
          sendJson(response, error.statusCode ?? 400, { error: error.message });
          return;
        }
      }
      const event = payload && typeof payload.event === 'string' ? payload.event : 'greet';
      if (!/^[a-z][a-z0-9_]{1,32}$/.test(event)) {
        sendJson(response, 400, { error: 'event must be a valid voice event id.' });
        return;
      }
      sendJson(response, 200, { ok: true, pet: petController.triggerVoice(event) });
      return;
    }
    // -------------------------------------------------------------------------
    // Presentation ownership: exactly one live surface shows the pet.
    // Dashboard tabs claim/renew a bounded lease (same-origin or token); the
    // desktop host transfers out with the token; the daemon ticker expires
    // dead leases so a closed browser tab restores desktop presentation.
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/v1/presentation') {
      sendJson(response, 200, { presentation: petController.snapshot().presentation });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/presentation/claim') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      if (!isValidPresentationClaimPayload(payload)) {
        sendJson(response, 400, { error: 'Expected {owner, ttlMs?} with an 8-64 character session id.' });
        return;
      }
      try {
        const snapshot = petController.claimPresentation(payload);
        sendJson(response, 200, { ok: true, presentation: snapshot.presentation, pet: snapshot });
      } catch (error) {
        sendJson(response, presentationErrorStatus(error), {
          error: error.message,
          presentation: petController.snapshot().presentation,
        });
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/presentation/release') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      if (!isValidPresentationReleasePayload(payload)) {
        sendJson(response, 400, { error: 'Expected {owner?} with a valid session id.' });
        return;
      }
      try {
        const snapshot = petController.releasePresentation({ owner: payload.owner ?? null, reason: 'released' });
        sendJson(response, 200, { ok: true, presentation: snapshot.presentation, pet: snapshot });
      } catch (error) {
        sendJson(response, presentationErrorStatus(error), {
          error: error.message,
          presentation: petController.snapshot().presentation,
        });
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/presentation/to-dashboard') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      const snapshot = petController.transferToDashboard({ reason: 'sent' });
      sendJson(response, 200, { ok: true, presentation: snapshot.presentation, pet: snapshot });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/presentation/to-desktop') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      const snapshot = petController.transferToDesktop({ reason: 'requested' });
      sendJson(response, 200, { ok: true, presentation: snapshot.presentation, pet: snapshot });
      return;
    }
    // -------------------------------------------------------------------------
    // Agent events: the OpenCode observer plugin reports short lifecycle facts
    // (session id + predefined event, no content). Reactions are predefined:
    // a pet command plus an optional spoken line. Duplicates within 2s and
    // repeats within the cooldown are acknowledged without reacting again, so
    // a chatty agent cannot make Sparky celebrate forever. Permission events
    // only prompt the pet to look attentive — approvals stay with the human.
    // -------------------------------------------------------------------------
    if (method === 'POST' && pathname === '/api/v1/agent/event') {
      if (!isAuthorized(request, token)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      if (!isValidAgentEventPayload(payload)) {
        sendJson(response, 400, { error: 'Expected {source, sessionId, event} with a known agent event id.' });
        return;
      }
      const key = `${payload.sessionId}:${payload.event}`;
      const now = agentNow();
      const lastAt = agentEventSeen.get(key);
      if (lastAt !== undefined && now - lastAt < agentEventDedupMs) {
        sendJson(response, 200, { ok: true, event: payload.event, deduped: true, reaction: null });
        return;
      }
      agentEventSeen.set(key, now);
      if (agentEventSeen.size > AGENT_EVENT_MEMORY_LIMIT) {
        for (const [seenKey, seenAt] of agentEventSeen) {
          if (now - seenAt >= agentEventCooldownMs) agentEventSeen.delete(seenKey);
        }
      }
      if (lastAt !== undefined && now - lastAt < agentEventCooldownMs) {
        sendJson(response, 200, { ok: true, event: payload.event, throttled: true, reaction: null });
        return;
      }
      const reaction = AGENT_EVENT_REACTIONS[payload.event] ?? null;
      let speech = 'skipped';
      if (reaction?.command) petController.command(reaction.command);
      if (reaction?.voiceEvent && voiceService && isVoiceReady()) {
        const speechSettings = petController.snapshot()?.settings?.speech;
        if (speechSettings && speechSettings.enabled !== false
          && speechSettings.provider === 'elevenlabs' && speechSettings.style !== 'chirps') {
          // Generation is asynchronous; the plugin call must not wait on
          // the provider. Failures surface in pet state and the dashboard.
          void voiceService.speakEvent(reaction.voiceEvent, { source: 'agent' }).catch(() => {});
          speech = 'announced';
        }
      }
      sendJson(response, 200, { ok: true, event: payload.event, reaction, speech });
      return;
    }
    // -------------------------------------------------------------------------
    // Voice: provider status, explicit speech, and clip delivery for the pet
    // host. No route ever includes the API key in a response.
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/v1/voice/status') {
      // Read-only and secret-free, like /api/v1/pet/state; the dashboard
      // fetches it without a token.
      const loaded = await refreshVoiceConfig().catch(() => null);
      const voice = voiceService ? await voiceService.status() : null;
      // Defence in depth: strip credential-shaped fields from whatever the
      // service reports, so a future bug cannot leak a key to a browser.
      const safeVoice = voice && typeof voice === 'object'
        ? Object.fromEntries(Object.entries(voice).filter(([key]) => !['apikey', 'api_key', 'key', 'token', 'authorization', 'secret'].includes(key.toLowerCase())))
        : null;
      sendJson(response, 200, {
        ok: true,
        voice: safeVoice,
        warnings: loaded?.warnings ?? [],
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/voice/speak') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!voiceService) {
        sendJson(response, 503, { error: 'Voice service unavailable.' });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      await refreshVoiceConfig().catch(() => {});
      const voiceEvent = typeof payload.voiceEvent === 'string' ? payload.voiceEvent : null;
      let text = null;
      if (voiceEvent !== null) {
        if (!isValidVoiceEvent(voiceEvent)) {
          sendJson(response, 400, { error: 'voiceEvent must be a known event id.' });
          return;
        }
        text = pickLine(voiceEvent, Number.isInteger(payload.lineIndex) ? payload.lineIndex : 0);
        if (!text) {
          sendJson(response, 400, { error: 'That event has no configured line.' });
          return;
        }
      } else if (typeof payload.text === 'string') {
        text = payload.text;
      } else {
        sendJson(response, 400, { error: 'Provide "text" or a known "voiceEvent".' });
        return;
      }
      try {
        const snapshot = await voiceService.speak(text, { voiceEvent, source: 'api' });
        sendJson(response, 200, {
          ok: true,
          speech: snapshot.speech,
          generated: Boolean(snapshot.speech?.clipId),
        });
      } catch (error) {
        sendJson(response, error.code === 'INVALID_UTTERANCE' ? 400 : 500, {
          error: error.code === 'INVALID_UTTERANCE' ? error.message : 'Speech generation failed.',
        });
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/voice/test') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!voiceService) {
        sendJson(response, 503, { error: 'Voice service unavailable.' });
        return;
      }
      await refreshVoiceConfig().catch(() => {});
      try {
        const snapshot = await voiceService.test();
        sendJson(response, 200, {
          ok: true,
          speech: snapshot.speech,
          generated: Boolean(snapshot.speech?.clipId),
        });
      } catch (error) {
        sendJson(response, error.code === 'RATE_LIMITED' ? 429 : 500, { error: error.message });
      }
      return;
    }
    const clipMatch = /^\/api\/v1\/voice\/clip\/(.+)$/.exec(pathname);
    if (method === 'GET' && clipMatch) {
      // Raw audio bytes: token-only, never same-origin (renderers never
      // fetch clips directly; the trusted Electron main process does).
      if (!isAuthorized(request, token)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!voiceService) {
        sendJson(response, 503, { error: 'Voice service unavailable.' });
        return;
      }
      const clipId = clipMatch[1];
      if (!/^[a-f0-9]{64}$/.test(clipId)) {
        sendJson(response, 400, { error: 'Invalid clip id.' });
        return;
      }
      const clip = await voiceService.getClip(clipId);
      if (clip.status === 'invalid') {
        sendJson(response, 400, { error: 'Invalid clip id.' });
        return;
      }
      if (clip.status !== 'ok') {
        sendJson(response, 404, { error: 'Clip not found' });
        return;
      }
      response.writeHead(200, {
        'content-type': clip.mime,
        'content-length': clip.audio.length,
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
      });
      response.end(clip.audio);
      return;
    }
    if (method === 'GET' && pathname === '/api/v1/character') {
      let character = null;
      try {
        character = await getCharacterInfo();
      } catch {
        character = null;
      }
      sendJson(response, 200, { character });
      return;
    }
    if (method === 'GET' && pathname === '/api/v1/characters') {
      sendJson(response, 200, await getCharacters());
      return;
    }
    // -------------------------------------------------------------------------
    // Character assets for the dashboard habitat: validated character ids only
    // (never arbitrary paths). The pack JSON references the sprite through a
    // same-origin HTTP route; the loader guarantees the sprite file sits
    // inside its pack directory, and no filesystem path ever appears in a
    // response body.
    // -------------------------------------------------------------------------
    const characterAssetMatch = /^\/api\/v1\/characters\/([^/]+)(\/pack|\/sprite\.png)$/.exec(pathname);
    if (method === 'GET' && characterAssetMatch) {
      const characterId = characterAssetMatch[1];
      if (!CHARACTER_ID_PATTERN.test(characterId)) {
        sendJson(response, 400, { error: 'Invalid character id.' });
        return;
      }
      let detail = null;
      try {
        detail = await getPackDetail(characterId);
      } catch {
        detail = null;
      }
      if (!detail) {
        sendJson(response, 404, { error: 'Character pack not found.' });
        return;
      }
      if (characterAssetMatch[2] === '/pack') {
        sendJson(response, 200, { pack: detail.summary });
        return;
      }
      try {
        const info = await stat(detail.spritePath);
        if (!info.isFile() || !detail.spritePath.endsWith('.png')) throw new Error('Not a sprite sheet');
        response.writeHead(200, {
          'content-type': 'image/png',
          'content-length': info.size,
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
        });
        createReadStream(detail.spritePath).pipe(response);
      } catch {
        sendJson(response, 404, { error: 'Sprite sheet unavailable.' });
      }
      return;
    }
    // -------------------------------------------------------------------------
    // Assistant: deterministic text-command routing (music first). Auth-gated
    // because commands change player state and may spend TTS credits. The
    // recognised text never leaves this process — no AI provider is involved.
    // -------------------------------------------------------------------------
    if (method === 'POST' && pathname === '/api/v1/assistant/command') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!musicService) {
        sendJson(response, 503, { error: 'Assistant unavailable: no music service is attached.' });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      if (!payload || typeof payload.text !== 'string' || payload.text.trim().length < 1 || payload.text.length > 300) {
        sendJson(response, 400, { error: 'Expected { text: string } of 1-300 characters.' });
        return;
      }
      const now = Date.now();
      if (now - lastAssistantCommandAt < assistantThrottleMs) {
        sendJson(response, 429, { error: 'Commands are arriving too fast. Slow down a moment.' });
        return;
      }
      lastAssistantCommandAt = now;

      const result = await runTextCommand(payload.text);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }
    // -------------------------------------------------------------------------
    // Assistant state & control: public status, gated commands.
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/v1/assistant/status') {
      const shortcut = hotkey
        ? hotkey.snapshot().shortcut
        : { enabled: true, accelerator: 'Control+Alt+Space', registered: null, registrationDetail: null };
      if (!assistantService) {
        sendJson(response, 200, { ok: true, assistant: { state: 'disabled', wake: { status: 'needs-setup', missing: ['no-service'] }, shortcut } });
        return;
      }
      const snap = await assistantService.status();
      // Populate mic devices lazily (cached 10s in the service would be ideal;
      // here we just call listDevices and cache briefly on the server).
      if (assistantService._mic && typeof assistantService._mic.listDevices === 'function') {
        try {
          const devices = await assistantService._mic.listDevices();
          snap.mic.devices = devices;
        } catch {
          snap.mic.devices = [];
        }
      }
      sendJson(response, 200, {
        ok: true,
        assistant: {
          ...snap,
          shortcut: hotkey
            ? hotkey.snapshot().shortcut
            : { enabled: true, accelerator: 'Control+Alt+Space', registered: null, registrationDetail: null },
        },
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/assistant/listen') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!assistantService) {
        sendJson(response, 503, { error: 'Assistant unavailable.' });
        return;
      }
      let payload;
      try { payload = await readJsonBody(request); } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      if (!payload || typeof payload.enabled !== 'boolean') {
        sendJson(response, 400, { error: 'Expected { enabled: boolean }.' });
        return;
      }
      try {
        await assistantService.setListening(payload.enabled);
      } catch (error) {
        if (error?.code === 'WAKE_NEEDS_SETUP') {
          sendJson(response, 400, { error: 'Wake word is not configured.', setup: error.setup });
          return;
        }
        sendJson(response, 500, { error: error?.message ?? 'Failed to change listening state.' });
        return;
      }
      const snap = await assistantService.status();
      sendJson(response, 200, { ok: true, assistant: snap });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/assistant/ptt/start') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!assistantService) {
        sendJson(response, 503, { error: 'Assistant unavailable.' });
        return;
      }
      try {
        const { sessionId, done } = await assistantService.startPtt();
        const snap = await assistantService.status();
        sendJson(response, 200, { ok: true, assistant: snap, sessionId });
      } catch (error) {
        if (error?.code === 'MIC_BUSY') {
          sendJson(response, 409, { error: 'The microphone is already in use.' });
          return;
        }
        sendJson(response, 503, { error: error?.message ?? 'Microphone unavailable.' });
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/assistant/ptt/stop') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!assistantService) {
        sendJson(response, 503, { error: 'Assistant unavailable.' });
        return;
      }
      const result = await assistantService.stopPtt();
      const snap = await assistantService.status();
      // Legacy (no pipeline attached) results are the raw capture summary.
      const capture = result?.capture ?? null;
      sendJson(response, 200, {
        ok: true,
        assistant: snap,
        capture: capture ?? result,
        transcript: result?.transcript ?? null,
        handled: result?.handled ?? false,
        executed: result?.executed ?? false,
        intent: result?.intent ?? null,
        reply: result?.reply ?? null,
        speech: result?.speech ?? null,
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/assistant/ptt/cancel') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!assistantService) {
        sendJson(response, 503, { error: 'Assistant unavailable.' });
        return;
      }
      const result = await assistantService.cancelPtt();
      const snap = await assistantService.status();
      sendJson(response, 200, { ok: true, assistant: snap, capture: result?.capture ?? null, cancelled: true });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/assistant/mic/diagnose') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!assistantService) {
        sendJson(response, 503, { error: 'Assistant unavailable.' });
        return;
      }
      const diag = await assistantService.runDiagnostic();
      const snap = await assistantService.status();
      sendJson(response, 200, { ok: true, assistant: snap, mic: diag });
      return;
    }
    // -------------------------------------------------------------------------
    // Global hotkey: public state, gated settings save, Electron registration.
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/v1/assistant/shortcut') {
      const shortcut = hotkey
        ? hotkey.snapshot().shortcut
        : { enabled: true, accelerator: 'Control+Alt+Space', registered: null, registrationDetail: null };
      sendJson(response, 200, { ok: true, shortcut });
      return;
    }
    if (method === 'PUT' && pathname === '/api/v1/assistant/shortcut') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      let payload;
      try { payload = await readJsonBody(request); } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      if (!payload || typeof payload.shortcut !== 'object' || payload.shortcut === null) {
        sendJson(response, 400, { error: 'Expected { shortcut: { enabled?: boolean, accelerator?: string } }.' });
        return;
      }
      if (!hotkey) {
        sendJson(response, 503, { error: 'Hotkey settings are unavailable on this runtime.' });
        return;
      }
      try {
        const snap = await hotkey.save(payload);
        sendJson(response, 200, { ok: true, shortcut: snap?.shortcut ?? snap });
      } catch (error) {
        if (error?.code === 'INVALID_ACCELERATOR') {
          sendJson(response, 400, { error: error.message });
          return;
        }
        sendJson(response, 500, { error: error?.message ?? 'Failed to save hotkey settings.' });
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/assistant/shortcut/registration') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!hotkey) {
        sendJson(response, 503, { error: 'Hotkey state is unavailable on this runtime.' });
        return;
      }
      let payload;
      try { payload = await readJsonBody(request); } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      if (!payload || typeof payload.registered !== 'boolean') {
        sendJson(response, 400, { error: 'Expected { registered: boolean, detail?: string }.' });
        return;
      }
      const snap = hotkey.setRegistration(payload);
      sendJson(response, 200, { ok: true, shortcut: snap?.shortcut ?? snap });
      return;
    }
    // -------------------------------------------------------------------------
    // Music library: read-only views are public on loopback (like pet state);
    // the rescan walks the filesystem, so it carries the dashboard/token gate.
    // Responses expose opaque ids and display metadata — never file paths.
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/v1/music/status') {
      if (!musicService) {
        sendJson(response, 503, { error: 'Music library unavailable.' });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        music: await musicService.status(),
        playback: musicService.playbackStatus ? musicService.playbackStatus() : null,
      });
      return;
    }
    if (method === 'GET' && pathname === '/api/v1/music/library') {
      if (!musicService) {
        sendJson(response, 503, { error: 'Music library unavailable.' });
        return;
      }
      let query = '';
      let limit;
      try {
        const search = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
        query = search.get('q') ?? '';
        if (search.has('limit')) limit = Number(search.get('limit'));
      } catch {
        // fall through with defaults
      }
      if (typeof query !== 'string' || query.length > 200) {
        sendJson(response, 400, { error: 'Query must be a string of at most 200 characters.' });
        return;
      }
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 500)) {
        sendJson(response, 400, { error: 'limit must be between 1 and 500.' });
        return;
      }
      sendJson(response, 200, { ok: true, ...(await musicService.list({ query, limit })) });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/music/scan') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!musicService) {
        sendJson(response, 503, { error: 'Music library unavailable.' });
        return;
      }
      sendJson(response, 200, { ok: true, music: await musicService.rescan({ force: true }) });
      return;
    }
    // Transport: state-changing, so every op carries the dashboard/token gate.
    // Play accepts an opaque track id only — never a filesystem path.
    const transportPaths = {
      '/api/v1/music/play': 'play',
      '/api/v1/music/pause': 'pause',
      '/api/v1/music/resume': 'resume',
      '/api/v1/music/stop': 'stop',
      '/api/v1/music/next': 'next',
      '/api/v1/music/previous': 'previous',
    };
    if (method === 'POST' && transportPaths[pathname]) {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!musicService) {
        sendJson(response, 503, { error: 'Music playback unavailable.' });
        return;
      }
      let payload = {};
      if (transportPaths[pathname] === 'play') {
        try {
          payload = await readJsonBody(request);
        } catch (error) {
          sendJson(response, error.statusCode ?? 400, { error: error.message });
          return;
        }
        if (!payload || typeof payload.trackId !== 'string') {
          sendJson(response, 400, { error: 'play requires { trackId } — an opaque library id, not a path.' });
          return;
        }
      }
      try {
        const playback = await musicService[transportPaths[pathname]]({ trackId: payload?.trackId });
        sendJson(response, 200, { ok: true, playback });
      } catch (error) {
        const statusByCode = {
          INVALID_TRACK: 400,
          TRACK_NOT_FOUND: 404,
          INVALID_STATE: 409,
          ENGINE_UNAVAILABLE: 503,
        };
        sendJson(response, statusByCode[error?.code] ?? 500, {
          error: error?.message ?? 'Music transport failed.',
          playback: musicService.playbackStatus ? musicService.playbackStatus() : null,
        });
      }
      return;
    }
    if (method === 'PUT' && pathname === '/api/v1/music/settings') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      if (!musicService) {
        sendJson(response, 503, { error: 'Music playback unavailable.' });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      if (!payload || typeof payload !== 'object'
        || (payload.volume !== undefined && typeof payload.volume !== 'number')
        || (payload.muted !== undefined && typeof payload.muted !== 'boolean')
        || (payload.shuffle !== undefined && typeof payload.shuffle !== 'boolean')) {
        sendJson(response, 400, { error: 'Expected { volume?: number, muted?: boolean, shuffle?: boolean }.' });
        return;
      }
      try {
        const playback = await musicService.updateSettings(payload);
        sendJson(response, 200, { ok: true, playback });
      } catch (error) {
        const statusByCode = {
          INVALID_VOLUME: 400,
          INVALID_MUTED: 400,
          INVALID_SHUFFLE: 400,
          ENGINE_UNAVAILABLE: 503,
        };
        sendJson(response, statusByCode[error?.code] ?? 500, {
          error: error?.message ?? 'Music settings failed.',
          playback: musicService.playbackStatus ? musicService.playbackStatus() : null,
        });
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/host/restart') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      try {
        await onRestartHost();
      } catch (error) {
        sendJson(response, 500, { error: `Pet host restart failed: ${error.message}`, host: getHostState() });
        return;
      }
      sendJson(response, 202, { ok: true, host: getHostState() });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/shutdown') {
      if (!isAuthorized(request, token)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (shutdownRequested) {
        sendJson(response, 202, { ok: true, state: 'stopping' });
        return;
      }
      shutdownRequested = true;
      sendJson(response, 202, { ok: true, state: 'stopping' });
      setTimeout(() => onShutdown(), 25).unref();
      return;
    }
    if (method === 'GET' && await serveFrontendAsset(response, pathname)) return;
    if (method === 'OPTIONS') {
      response.writeHead(405, { allow: 'GET, POST' });
      response.end();
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 2_000;
  return server;
}
