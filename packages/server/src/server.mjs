import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAuthorized, toRuntimePayload, DEFAULT_HOST } from '../../core/src/index.mjs';
import { createPetController, isValidPetCommandPayload, isValidPetSettingsPayload } from '../../core/src/pet-state.mjs';
import { COMMAND_SPEECH_EVENTS, isValidVoiceEvent, pickLine, SPEECH_EVENT_COOLDOWN_MS } from '../../core/src/voice-lines.mjs';

const DASHBOARD_ROOT = fileURLToPath(new URL('../../dashboard/', import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/src/main.js', ['src/main.js', 'text/javascript; charset=utf-8']],
  ['/src/styles.css', ['src/styles.css', 'text/css; charset=utf-8']],
  ['/src/pet-controls.css', ['src/pet-controls.css', 'text/css; charset=utf-8']],
]);

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

async function serveStatic(response, route) {
  const target = STATIC_FILES.get(route);
  if (!target) return false;
  const [relativePath, contentType] = target;
  const rootPath = path.resolve(DASHBOARD_ROOT);
  const fullPath = path.resolve(rootPath, relativePath);
  if (!fullPath.startsWith(`${rootPath}${path.sep}`) && fullPath !== path.resolve(rootPath, 'index.html')) {
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
  voiceService = null,
  refreshVoiceConfig = async () => ({ configured: false, warnings: [] }),
  isVoiceReady = () => false,
}) {
  let shutdownRequested = false;
  const commandSpeechSpokeAt = new Map(); // voiceEvent -> timestamp

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
    if (method === 'GET' && await serveStatic(response, pathname)) return;
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
