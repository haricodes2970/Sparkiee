/**
 * Pure rules for how spoken voice and the original chirps coexist in the
 * pet renderer. No DOM or network access, so every branch is unit-tested.
 *
 * Policies:
 * - style 'speech' with a ready provider: reactions are carried by speech,
 *   animation-change chirps yield the floor.
 * - style 'both': chirps play on animation changes, speech follows.
 * - style 'chirps', unconfigured provider, or speech disabled: the
 *   original chirps behave exactly as before.
 * - Explicit user actions (the chirp test button) always make a sound.
 * - Failed speech falls back to a chirp only where the chirp was
 *   suppressed, so a reaction is never silently lost.
 */

export function readSpeechSettings(state) {
  const speech = state && state.settings ? state.settings.speech : null;
  return {
    enabled: speech ? speech.enabled !== false : true,
    provider: speech && speech.provider === 'chirps' ? 'chirps' : 'elevenlabs',
    style: speech && ['speech', 'chirps', 'both'].includes(speech.style) ? speech.style : 'speech',
    ready: Boolean(state && state.speechReady),
  };
}

/** True when spoken voice actively carries reactions (chirps yield). */
export function speechCarriesReactions(state) {
  const settings = readSpeechSettings(state);
  return settings.enabled
    && settings.provider === 'elevenlabs'
    && settings.style === 'speech'
    && settings.ready;
}

/** Should an animation-change chirp play right now? */
export function shouldPlayEventChirp(state) {
  return !speechCarriesReactions(state);
}

/**
 * Chirp fallback after a speech announcement that produced no audio.
 * Explicit tests are never silent; otherwise the chirp returns only if it
 * was recently suppressed for a reaction (within `windowMs`).
 */
export function shouldFallbackChirp(speech, { suppressedAt = 0, now = 0, windowMs = 3000 } = {}) {
  if (!speech || !speech.error) return false;
  if (speech.source === 'test') return true;
  return suppressedAt > 0 && now >= suppressedAt && now - suppressedAt < windowMs;
}

/**
 * Caption duration for a spoken phrase: the configured duration is the
 * floor, and known audio keeps the caption visible for the whole speech
 * plus a short tail.
 */
export function speechCaptionDuration({ audioDurationSeconds = null, configuredMs = 2600 } = {}) {
  const floor = Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs : 2600;
  const speechMs = Number.isFinite(audioDurationSeconds) && audioDurationSeconds > 0
    ? audioDurationSeconds * 1000 + 700
    : 0;
  return Math.round(Math.max(floor, speechMs));
}
