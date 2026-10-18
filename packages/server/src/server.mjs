import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAuthorized, toRuntimePayload, DEFAULT_HOST } from '../../core/src/index.mjs';
import { createPetController, isValidPetCommandPayload, isValidPetSettingsPayload, isValidPresentationClaimPayload, isValidPresentationReleasePayload } from '../../core/src/pet-state.mjs';
import { AGENT_EVENT_REACTIONS, COMMAND_SPEECH_EVENTS, isValidVoiceEvent, pickLine, SPEECH_EVENT_COOLDOWN_MS } from '../../core/src/voice-lines.mjs';
import { AGENT_EVENT_COOLDOWN_MS, AGENT_EVENT_DEDUP_MS, AGENT_EVENT_MEMORY_LIMIT, isValidAgentEventPayload } from '../../core/src/agent-events.mjs';

const DASHBOARD_ROOT = fileURLToPath(new URL('../../dashboard/', import.meta.url));
const SHARED_LIB_ROOT = fileURLToPath(new URL('../../pet-host/renderer/lib/', import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/src/main.js', ['src/main.js', 'text/javascript; charset=utf-8']],
  ['/src/styles.css', ['src/styles.css', 'text/css; charset=utf-8']],
  ['/src/pet-controls.css', ['src/pet-controls.css', 'text/css; charset=utf-8']],
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
  voiceService = null,
  refreshVoiceConfig = async () => ({ configured: false, warnings: [] }),
  isVoiceReady = () => false,
  agentNow = () => Date.now(),
  agentEventDedupMs = AGENT_EVENT_DEDUP_MS,
  agentEventCooldownMs = AGENT_EVENT_COOLDOWN_MS,
}) {
  let shutdownRequested = false;
  const commandSpeechSpokeAt = new Map(); // voiceEvent -> timestamp
  const agentEventSeen = new Map(); // `${sessionId}:${event}` -> timestamp

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
