/**
 * Voice service: turns events into speech for the desktop pet.
 *
 * Pipeline: event → utterance → (cache | ElevenLabs) → pet state speech
 * announcement → pet host fetches the clip → renderer plays it and shows
 * the subtitle.
 *
 * Properties:
 * - The daemon never blocks: synthesis runs async; the announcement only
 *   lands in pet state once the clip is cached and fetchable.
 * - In-flight requests for the same phrase share one provider call.
 * - User-triggered speech is rate limited.
 * - Failures are honest: the announcement carries an error code so the
 *   renderer shows the caption plus a chirp fallback and the dashboard
 *   can explain what went wrong. The API key never leaves this process.
 */

import { synthesisCacheKey, mimeForOutputFormat } from '../../core/src/voice-config.mjs';
import { isValidUtterance, MAX_UTTERANCE_LENGTH } from '../../core/src/tts-client.mjs';
import { pickLine, VOICE_TEST_PHRASE } from '../../core/src/voice-lines.mjs';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

export const SPEECH_ERROR_MESSAGES = Object.freeze({
  muted: 'Sound is muted, so the caption is shown instead of speech. Run "sparkiee voice unmute" to hear Sparky.',
  not_configured: 'Speech is not configured. Run "sparkiee voice setup" or "sparkiee assistant setup" — or install espeak-ng for local speech.',
  auth: 'The ElevenLabs API key was rejected. Run "sparkiee voice setup" with a valid key.',
  quota: 'The ElevenLabs account is out of credits or restricted for this voice.',
  rate: 'ElevenLabs rate limit reached. Sparky will try again shortly.',
  validation: 'ElevenLabs rejected the speech request.',
  timeout: 'Speech generation timed out.',
  network: 'Could not reach ElevenLabs.',
  provider: 'ElevenLabs returned an unexpected response.',
  local_tts_unavailable: 'The local speech fallback (espeak-ng) is not installed. ' +
    'Install it with: sudo dnf install espeak-ng',
  local_tts_failed: 'The local speech fallback (espeak-ng) could not synthesise that phrase.',
});

export function describeSpeechError(code) {
  return SPEECH_ERROR_MESSAGES[code] ?? SPEECH_ERROR_MESSAGES.provider;
}

/**
 * @param {object} options
 * @param {() => {configured: boolean, config: object}} options.getConfig
 *   Lazy config lookup so setup changes apply without a daemon restart.
 * @param {(config: object) => {synthesize: Function}|null} options.getClient
 *   Factory for the provider client (returns null when unconfigured).
 * @param {{get: Function, put: Function, stats: Function}} options.cache
 * @param {object} options.petController pet-state controller.
 * @param {() => number} [options.clock]
 * @param {number} [options.maxSpeechLength]
 */
export function createVoiceService({
  getConfig,
  getClient,
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
   * WAV (the local fallback) is discoverable from its key alone; the plain
   * `get(key, mime)` path keeps older test doubles working.
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

  /**
   * Synthesize (or fetch from cache) a phrase and publish the speech
   * announcement to pet state. Returns the announcement.
   *
   * Provider order: ElevenLabs when configured, then the local espeak-ng
   * fallback. The fallback exists because a caption is not speech: the user
   * must be able to hear Sparky without cloud credentials. When every path
   * fails the announcement carries the underlying, honest error code.
   */
  async function speak(text, { voiceEvent = null, source = 'api' } = {}) {
    const trimmed = typeof text === 'string' ? text.trim().slice(0, maxSpeechLength) : '';
    if (!isValidUtterance(trimmed)) {
      const error = new Error(`Speech text must be 1-${maxSpeechLength} characters of plain text.`);
      error.code = 'INVALID_UTTERANCE';
      throw error;
    }

    // Muted: never spend a provider call or pretend audio is coming. The
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
    const settings = { stability: 0.5, similarity_boost: 0.75 };
    const cloudKey = synthesisCacheKey({
      text: trimmed,
      voiceId: loaded.config.voiceId,
      modelId: loaded.config.modelId,
      outputFormat: loaded.config.outputFormat,
      settings,
    });
    const cloudMime = mimeForOutputFormat(loaded.config.outputFormat);
    const localKey = localTts
      ? synthesisCacheKey({
        text: trimmed,
        voiceId: `local:${localTts.voice ?? 'espeak-ng'}`,
        modelId: 'espeak-ng',
        outputFormat: 'wav_22050',
        settings: { speed: localTts.speed ?? null },
      })
      : null;

    // 1. Cache hit: announce immediately, zero provider cost.
    const cachedCloud = loaded.configured ? await cacheLookup(cloudKey, cloudMime) : null;
    const cachedLocal = !cachedCloud && localTts ? await cacheLookup(localKey, 'audio/wav') : null;
    if (cachedCloud || cachedLocal) {
      const clipKey = cachedCloud ? cloudKey : localKey;
      const provider = cachedCloud ? 'elevenlabs' : 'espeak-ng';
      lastSpokenAt = clock();
      lastError = null;
      lastProvider = provider;
      return { ...petController.announceSpeech({ text: trimmed, clipId: clipKey, voiceEvent, source }), provider, cached: true };
    }

    // 2. Cloud provider (when configured), deduplicated in flight.
    let providerError = null;
    if (loaded.configured) {
      let request = inFlight.get(cloudKey);
      if (!request) {
        const client = getClient(loaded.config);
        request = (async () => {
          if (!client) return { ok: false, code: 'not_configured', message: describeSpeechError('not_configured') };
          return client.synthesize(trimmed);
        })();
        inFlight.set(cloudKey, request);
      }

      let result;
      try {
        result = await request;
      } catch (error) {
        result = { ok: false, code: 'provider', message: error?.message ?? 'speech generation failed' };
      } finally {
        inFlight.delete(cloudKey);
      }

      if (result.ok) {
        await cache.put(cloudKey, result.audio, result.mime ?? cloudMime).catch(() => null);
        lastSpokenAt = clock();
        lastError = null;
        lastProvider = 'elevenlabs';
        return { ...petController.announceSpeech({ text: trimmed, clipId: cloudKey, voiceEvent, source }), provider: 'elevenlabs' };
      }
      providerError = result.code ?? 'provider';
    }

    // 3. Local fallback: real audible speech even when the cloud is not set
    // up or is having an outage. The cloud failure code travels with the
    // announcement so later reports stay honest about which path spoke.
    if (localTts) {
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
          fallbackFrom: 'elevenlabs',
          fallbackReason: providerError ?? 'not_configured',
        };
      }
      providerError = local.code === 'unavailable' ? 'local_tts_unavailable' : 'local_tts_failed';
    }

    // 4. Nothing worked: announce the honest failure (caption + chirp).
    lastError = providerError ?? 'not_configured';
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
     * Status safe for the dashboard and CLI: never includes the key.
     */
    async status() {
      const loaded = getConfig();
      const stats = await cache.stats().catch(() => ({ bytes: 0, files: 0 }));
      let localStatus = null;
      if (getLocalTtsStatus) {
        try { localStatus = await getLocalTtsStatus(); } catch { localStatus = null; }
      }
      // Honest availability: a probed espeak-ng wins over the mere presence
      // of the injected client. Never claim a fallback that cannot run.
      const localAvailable = localStatus ? localStatus.status === 'ready' : Boolean(localTts);
      const provider = loaded.configured ? 'elevenlabs' : (localAvailable ? 'espeak-ng' : 'none');
      return {
        configured: loaded.configured,
        provider,
        localFallback: {
          available: localAvailable,
          provider: 'espeak-ng',
          status: localStatus?.status ?? (localTts ? 'unknown' : 'unavailable'),
          binary: localStatus?.binary ?? localTts?.binary ?? null,
          version: localStatus?.version ?? null,
          detail: localStatus?.detail ?? null,
        },
        lastPlayback,
        voiceId: loaded.config.voiceId,
        modelId: loaded.config.modelId,
        outputFormat: loaded.config.outputFormat,
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
        const hit = await cacheLookup(key, mimeForOutputFormat(getConfig().config.outputFormat));
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
