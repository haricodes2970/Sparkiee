/**
 * Voice service: turns events into speech for the desktop pet.
 *
 * Pipeline: event → utterance → (cache | Piper) → pet state speech
 * announcement → pet host fetches the clip → renderer plays it and shows
 * the subtitle.
 *
 * Properties:
 * - The daemon never blocks: synthesis runs async; the announcement only
 *   lands in pet state once the clip is cached and fetchable.
 * - In-flight requests for the same phrase share one engine call.
 * - User-triggered speech is rate limited.
 * - Failures are honest: the announcement carries an error code so the
 *   renderer shows the caption plus a chirp fallback and the dashboard can
 *   explain what went wrong. Everything stays on this machine.
 */

import { synthesisCacheKey, mimeForOutputFormat, detectSpeechLanguage } from '../../core/src/voice-config.mjs';
import { isValidUtterance, MAX_UTTERANCE_LENGTH } from '../../core/src/piper-tts.mjs';
import { pickLine, VOICE_TEST_PHRASE } from '../../core/src/voice-lines.mjs';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const PIPER_OUTPUT_FORMAT = 'wav_22050';

export const SPEECH_ERROR_MESSAGES = Object.freeze({
  muted: 'Sound is muted, so the caption is shown instead of speech. Run "sparkiee voice unmute" to hear Sparky.',
  not_configured: 'The local voice is not set up. Run "sparkiee voice setup" to install Piper and download the voices.',
  not_installed: 'The local voice runtime is not installed. Run "sparkiee voice setup".',
  setup_required: 'The local voice runtime is not installed. Run "sparkiee voice setup".',
  voice_missing: 'A voice model is missing. Run "sparkiee voice setup" to download it.',
  validation: 'The local voice rejected the speech request.',
  timeout: 'The local voice did not finish in time.',
  network: 'The local voice could not run.',
  provider: 'The local voice returned an unexpected response.',
  failed: 'The local voice failed while synthesising that phrase.',
  local_tts_unavailable: 'The emergency speech fallback (espeak-ng) is not installed. ' +
    'Install it with: sudo dnf install espeak-ng',
  local_tts_failed: 'The emergency speech fallback (espeak-ng) could not synthesise that phrase.',
});

export function describeSpeechError(code) {
  return SPEECH_ERROR_MESSAGES[code] ?? SPEECH_ERROR_MESSAGES.provider;
}

/**
 * @param {object} options
 * @param {() => {configured: boolean, config: object}} options.getConfig
 *   Lazy config lookup so setup changes apply without a daemon restart.
 * @param {(config: object) => {synthesize: Function, probe: Function}|null} options.getEngine
 *   Factory for the local TTS engine (Piper).
 * @param {{get: Function, put: Function, stats: Function, find?: Function}} options.cache
 * @param {object} options.petController pet-state controller.
 * @param {() => number} [options.clock]
 * @param {number} [options.maxSpeechLength]
 */
export function createVoiceService({
  getConfig,
  getEngine = null,
  cache,
  petController,
  localTts = null,
  getLocalTtsStatus = null,
  clock = () => Date.now(),
  maxSpeechLength = MAX_UTTERANCE_LENGTH,
} = {}) {
  const inFlight = new Map(); // cacheKey -> Promise<result>
  const recentUserRequests = [];
  let lastError = null;
  let lastSpokenAt = 0;
  let lastProvider = null;
  let lastPlayback = null; // {id, clipId, status, detail, at}
  const playbackWaiters = new Map(); // speech id -> [{resolve, timer}]

  /**
   * The renderer reports what actually happened to the announced clip. This
   * is the only honest source of "did the user hear it": a synthesis success
   * is not playback success. Waiters (the greeting flow) are released here.
   */
  function recordPlayback({ id, clipId = null, status, detail = null } = {}) {
    const PLAYBACK_STATUSES = ['played', 'failed', 'muted', 'skipped'];
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid_id' };
    if (!PLAYBACK_STATUSES.includes(status)) return { ok: false, error: 'invalid_status' };
    lastPlayback = {
      id,
      clipId: typeof clipId === 'string' && /^[a-f0-9]{64}$/.test(clipId) ? clipId : null,
      status,
      detail: typeof detail === 'string' && detail.length > 0 ? detail.slice(0, 80) : null,
      at: new Date(clock()).toISOString(),
    };
    const waiters = playbackWaiters.get(id) ?? [];
    playbackWaiters.delete(id);
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(lastPlayback);
    }
    return { ok: true, playback: lastPlayback };
  }

  /**
   * Resolve when the pet host reports the outcome of speech `id`, or null
   * after `timeoutMs`. Bounded on purpose: a missing renderer (headless /
   * dashboard-only) must never wedge the caller.
   */
  function waitForPlayback(id, { timeoutMs = 6000 } = {}) {
    if (lastPlayback && lastPlayback.id === id) return Promise.resolve(lastPlayback);
    return new Promise((resolve) => {
      const settle = (value) => resolve(value);
      // Deliberately NOT unref'd: the caller is awaiting this promise, so the
      // timer must keep the event loop alive until it settles.
      const timer = setTimeout(() => {
        const waiters = playbackWaiters.get(id) ?? [];
        playbackWaiters.set(id, waiters.filter((waiter) => waiter.settle !== settle));
        settle(null);
      }, Math.max(200, Math.min(30_000, timeoutMs)));
      const waiters = playbackWaiters.get(id) ?? [];
      waiters.push({ resolve, settle, timer });
      playbackWaiters.set(id, waiters);
    });
  }

  /**
   * Mime-aware cache lookup. Newer caches expose `find`, so a clip stored as
   * WAV is discoverable from its key alone; the plain `get(key, mime)` path
   * keeps older test doubles working.
   */
  async function cacheLookup(key, mime = null) {
    if (!key) return null;
    if (typeof cache?.find === 'function') {
      const hit = await cache.find(key).catch(() => null);
      if (hit) return hit;
    }
    if (!mime) return null;
    const audio = await cache.get(key, mime).catch(() => null);
    return audio ? { audio, mime } : null;
  }

  function withinRateLimit() {
    const now = clock();
    while (recentUserRequests.length > 0 && now - recentUserRequests[0] > RATE_LIMIT_WINDOW_MS) {
      recentUserRequests.shift();
    }
    if (recentUserRequests.length >= RATE_LIMIT_MAX) return false;
    recentUserRequests.push(now);
    return true;
  }

  async function probeEngine(loaded) {
    if (typeof getEngine !== 'function') return null;
    const engine = getEngine(loaded?.config ?? null);
    if (!engine || typeof engine.probe !== 'function') return null;
    try { return await engine.probe(); } catch { return null; }
  }

  /**
   * Synthesize (or fetch from cache) a phrase and publish the speech
   * announcement to pet state. Returns the announcement.
   *
   * Provider order: Piper when its runtime and voices are present, then the
   * emergency espeak-ng fallback. The fallback exists because a caption is not
   * speech; when every path fails the announcement carries the underlying code.
   */
  async function speak(text, { voiceEvent = null, source = 'api' } = {}) {
    const trimmed = typeof text === 'string' ? text.trim().slice(0, maxSpeechLength) : '';
    if (!isValidUtterance(trimmed)) {
      const error = new Error(`Speech text must be 1-${maxSpeechLength} characters of plain text.`);
      error.code = 'INVALID_UTTERANCE';
      throw error;
    }

    // Muted: never spend synthesis work or pretend audio is coming. The
    // caption still lands, matching the renderer's own mute behaviour.
    if (petController?.snapshot?.()?.settings?.audio?.enabled === false) {
      lastError = 'muted';
      lastProvider = null;
      return {
        ...petController.announceSpeech({ text: trimmed, clipId: null, error: 'muted', voiceEvent, source }),
        provider: null,
      };
    }

    const loaded = getConfig();
    const language = detectSpeechLanguage(trimmed);
    const voiceId = loaded.config.voices?.[language] ?? null;
    const speed = loaded.config.speed ?? 1;
    const engineKey = synthesisCacheKey({
      text: trimmed,
      voiceId,
      modelId: 'piper',
      outputFormat: PIPER_OUTPUT_FORMAT,
      settings: { speed },
    });
    const localKey = localTts
      ? synthesisCacheKey({
        text: trimmed,
        voiceId: `local:${localTts.voice ?? 'espeak-ng'}`,
        modelId: 'espeak-ng',
        outputFormat: 'wav_22050',
        settings: { speed: localTts.speed ?? null },
      })
      : null;

    // 1. Cache hit: announce immediately, zero synthesis cost. A fallback
    // cache entry must never shadow a configured primary engine — otherwise an
    // old espeak-ng clip keeps playing after Piper is installed.
    const primaryConfigured = Boolean(loaded.configured && voiceId);
    const cachedEngine = primaryConfigured ? await cacheLookup(engineKey, 'audio/wav') : null;
    const cachedLocal = !cachedEngine && !primaryConfigured && localTts
      ? await cacheLookup(localKey, 'audio/wav')
      : null;
    if (cachedEngine || cachedLocal) {
      const clipKey = cachedEngine ? engineKey : localKey;
      const provider = cachedEngine ? 'piper' : 'espeak-ng';
      lastSpokenAt = clock();
      lastError = null;
      lastProvider = provider;
      return { ...petController.announceSpeech({ text: trimmed, clipId: clipKey, voiceEvent, source }), provider, cached: true };
    }

    // 2. Local engine (Piper), deduplicated in flight.
    let engineError = null;
    if (primaryConfigured) {
      let request = inFlight.get(engineKey);
      if (!request) {
        request = (async () => {
          const engine = typeof getEngine === 'function' ? getEngine(loaded.config) : null;
          if (!engine || typeof engine.synthesize !== 'function') {
            return { ok: false, code: 'not_configured', message: describeSpeechError('not_configured') };
          }
          return engine.synthesize(trimmed, { language });
        })();
        inFlight.set(engineKey, request);
      }

      let result;
      try {
        result = await request;
      } catch (error) {
        result = { ok: false, code: 'provider', message: error?.message ?? 'speech generation failed' };
      } finally {
        inFlight.delete(engineKey);
      }

      if (result.ok) {
        await cache.put(engineKey, result.audio, result.mime ?? 'audio/wav').catch(() => null);
        lastSpokenAt = clock();
        lastError = null;
        lastProvider = 'piper';
        return { ...petController.announceSpeech({ text: trimmed, clipId: engineKey, voiceEvent, source }), provider: 'piper' };
      }
      engineError = result.code ?? 'provider';
    }

    // 3. Emergency fallback: real audible speech even when Piper is not set
    // up or is having a bad day. The Piper failure code travels with the
    // announcement so later reports stay honest about which path spoke.
    if (localTts) {
      const cachedFallback = localKey ? await cacheLookup(localKey, 'audio/wav') : null;
      if (cachedFallback) {
        lastSpokenAt = clock();
        lastError = null;
        lastProvider = 'espeak-ng';
        return {
          ...petController.announceSpeech({ text: trimmed, clipId: localKey, voiceEvent, source }),
          provider: 'espeak-ng',
          cached: true,
          fallbackFrom: primaryConfigured ? 'piper' : null,
          fallbackReason: primaryConfigured ? (engineError ?? 'not_configured') : null,
        };
      }
      let local;
      try {
        local = await localTts.synthesize(trimmed);
      } catch (error) {
        local = { ok: false, code: 'failed', message: error?.message ?? 'speech generation failed' };
      }
      if (local.ok && local.audio) {
        await cache.put(localKey, local.audio, local.mime ?? 'audio/wav').catch(() => null);
        lastSpokenAt = clock();
        lastError = null;
        lastProvider = 'espeak-ng';
        return {
          ...petController.announceSpeech({ text: trimmed, clipId: localKey, voiceEvent, source }),
          provider: 'espeak-ng',
          fallbackFrom: 'piper',
          fallbackReason: engineError ?? 'not_configured',
        };
      }
      engineError = local.code === 'unavailable' ? 'local_tts_unavailable' : 'local_tts_failed';
    }

    // 4. Nothing worked: announce the honest failure (caption + chirp).
    lastError = engineError ?? 'not_configured';
    lastProvider = null;
    return { ...petController.announceSpeech({ text: trimmed, clipId: null, error: lastError, voiceEvent, source }), provider: null };
  }

  /**
   * Speak a predefined line for a voice event. Returns null when the
   * event has no line.
   */
  async function speakEvent(voiceEvent, { lineIndex = 0, source = 'api' } = {}) {
    const line = pickLine(voiceEvent, lineIndex);
    if (!line) return null;
    return speak(line, { voiceEvent, source });
  }

  return Object.freeze({
    speak,
    speakEvent,
    /**
     * Rate-limited user-triggered test phrase (dashboard button, CLI).
     */
    async test() {
      if (!withinRateLimit()) {
        const error = new Error('Too many voice test requests. Wait a moment before trying again.');
        error.code = 'RATE_LIMITED';
        throw error;
      }
      return speak(VOICE_TEST_PHRASE, { voiceEvent: 'greet', source: 'test' });
    },
    /**
     * Status safe for the dashboard and CLI.
     */
    async status() {
      const loaded = getConfig();
      const stats = await cache.stats().catch(() => ({ bytes: 0, files: 0 }));
      let localStatus = null;
      if (getLocalTtsStatus) {
        try { localStatus = await getLocalTtsStatus(); } catch { localStatus = null; }
      }
      const engineStatus = await probeEngine(loaded);
      const engineReady = engineStatus?.status === 'ready';
      // Honest availability: a probed espeak-ng wins over the mere presence
      // of the injected object. Never claim a fallback that cannot run.
      const localAvailable = localStatus ? localStatus.status === 'ready' : Boolean(localTts);
      const provider = engineReady ? 'piper' : (localAvailable ? 'espeak-ng' : 'none');
      return {
        configured: engineReady,
        provider,
        engine: engineStatus,
        voices: loaded.config.voices,
        speed: loaded.config.speed,
        localFallback: {
          available: localAvailable,
          provider: 'espeak-ng',
          status: localStatus?.status ?? (localTts ? 'unknown' : 'unavailable'),
          binary: localStatus?.binary ?? localTts?.binary ?? null,
          version: localStatus?.version ?? null,
          detail: localStatus?.detail ?? null,
        },
        lastPlayback,
        cacheFiles: stats.files,
        cacheBytes: stats.bytes,
        lastError,
        lastProvider,
        lastSpokenAt: lastSpokenAt > 0 ? new Date(lastSpokenAt).toISOString() : null,
        maxSpeechLength,
      };
    },
    recordPlayback,
    waitForPlayback,
    /**
     * Fetch a cached clip for delivery to the pet host. The key must be a
     * sha256 hex digest; anything else is reported as invalid without
     * touching the filesystem.
     */
    async getClip(key) {
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return { status: 'invalid' };
      try {
        const hit = await cacheLookup(key, mimeForOutputFormat(PIPER_OUTPUT_FORMAT));
        if (!hit) return { status: 'missing' };
        return { status: 'ok', audio: hit.audio, mime: hit.mime };
      } catch {
        return { status: 'missing' };
      }
    },
    /** Clear the clip cache (dashboard/CLI maintenance). */
    async clearCache() {
      await cache.clear();
    },
  });
}
