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
  not_configured: 'Speech is not configured. Run "sparkiee voice setup" or stay with the original chirps.',
  auth: 'The ElevenLabs API key was rejected. Run "sparkiee voice setup" with a valid key.',
  quota: 'The ElevenLabs account is out of credits or restricted for this voice.',
  rate: 'ElevenLabs rate limit reached. Sparky will try again shortly.',
  validation: 'ElevenLabs rejected the speech request.',
  timeout: 'Speech generation timed out.',
  network: 'Could not reach ElevenLabs.',
  provider: 'ElevenLabs returned an unexpected response.',
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
  clock = () => Date.now(),
  maxSpeechLength = MAX_UTTERANCE_LENGTH,
} = {}) {
  const inFlight = new Map(); // cacheKey -> Promise<result>
  const recentUserRequests = [];
  let lastError = null;
  let lastSpokenAt = 0;

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
   */
  async function speak(text, { voiceEvent = null, source = 'api' } = {}) {
    const trimmed = typeof text === 'string' ? text.trim().slice(0, maxSpeechLength) : '';
    if (!isValidUtterance(trimmed)) {
      const error = new Error(`Speech text must be 1-${maxSpeechLength} characters of plain text.`);
      error.code = 'INVALID_UTTERANCE';
      throw error;
    }

    const loaded = getConfig();
    const settings = { stability: 0.5, similarity_boost: 0.75 };
    const key = synthesisCacheKey({
      text: trimmed,
      voiceId: loaded.config.voiceId,
      modelId: loaded.config.modelId,
      outputFormat: loaded.config.outputFormat,
      settings,
    });

    // 1. Cache hit: announce immediately, zero provider cost.
    const cached = await cache.get(key).catch(() => null);
    if (cached) {
      lastSpokenAt = clock();
      lastError = null;
      return petController.announceSpeech({ text: trimmed, clipId: key, voiceEvent, source });
    }

    // 2. Unconfigured: announce with an error so the renderer still shows
    //    the caption and falls back to chirps.
    if (!loaded.configured) {
      lastError = 'not_configured';
      return petController.announceSpeech({ text: trimmed, clipId: null, error: 'not_configured', voiceEvent, source });
    }

    // 3. Provider call, deduplicated in flight.
    let request = inFlight.get(key);
    if (!request) {
      const client = getClient(loaded.config);
      request = (async () => {
        if (!client) return { ok: false, code: 'not_configured', message: describeSpeechError('not_configured') };
        return client.synthesize(trimmed);
      })();
      inFlight.set(key, request);
    }

    let result;
    try {
      result = await request;
    } catch (error) {
      result = { ok: false, code: 'provider', message: error?.message ?? 'speech generation failed' };
    } finally {
      inFlight.delete(key);
    }

    if (result.ok) {
      await cache.put(key, result.audio, result.mime).catch(() => null);
      lastSpokenAt = clock();
      lastError = null;
      return petController.announceSpeech({ text: trimmed, clipId: key, voiceEvent, source });
    }

    lastError = result.code ?? 'provider';
    return petController.announceSpeech({
      text: trimmed,
      clipId: null,
      error: lastError,
      voiceEvent,
      source,
    });
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
      return {
        configured: loaded.configured,
        voiceId: loaded.config.voiceId,
        modelId: loaded.config.modelId,
        outputFormat: loaded.config.outputFormat,
        cacheFiles: stats.files,
        cacheBytes: stats.bytes,
        lastError,
        lastSpokenAt: lastSpokenAt > 0 ? new Date(lastSpokenAt).toISOString() : null,
        maxSpeechLength,
      };
    },
    /**
     * Fetch a cached clip for delivery to the pet host. The key must be a
     * sha256 hex digest; anything else is reported as invalid without
     * touching the filesystem.
     */
    async getClip(key) {
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return { status: 'invalid' };
      try {
        const audio = await cache.get(key);
        if (!audio) return { status: 'missing' };
        return { status: 'ok', audio, mime: mimeForOutputFormat(getConfig().config.outputFormat) };
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
