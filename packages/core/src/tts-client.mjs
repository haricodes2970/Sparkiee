/**
 * ElevenLabs text-to-speech client.
 *
 * Uses the official REST API (POST /v1/text-to-speech/{voice_id}) with the
 * xi-api-key header over Node's built-in fetch. No SDK dependency.
 *
 * The key never appears in errors, return values, or logs produced here.
 * All failure modes are normalised to stable codes the UI can explain.
 *
 * Injectable fetch + clock keep this fully testable offline.
 */

import { API_BASE_URL, isValidApiKey, isValidVoiceId } from './voice-config.mjs';

export const MAX_UTTERANCE_LENGTH = 220;

export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  stability: 0.5,
  similarity_boost: 0.75,
});

/**
 * Stable error codes surfaced to callers.
 * auth: missing/invalid key · quota: out of credits or restricted ·
 * rate: too many requests · validation: rejected request ·
 * network: transport failure · timeout: no answer in time ·
 * provider: unexpected provider response.
 */
function normaliseError(status) {
  if (status === 401) return { code: 'auth', message: 'The ElevenLabs API key was rejected. Run "sparkiee voice setup" with a valid key.' };
  if (status === 403) return { code: 'quota', message: 'The ElevenLabs account cannot use this voice or model right now (plan restriction or out of credits).' };
  if (status === 429) return { code: 'rate', message: 'ElevenLabs rate limit reached. Sparky will try again later.' };
  if (status === 422) return { code: 'validation', message: 'ElevenLabs rejected the speech request (invalid voice, model, or text).' };
  return { code: 'provider', message: `ElevenLabs returned HTTP ${status}.` };
}

export function isValidUtterance(text) {
  return typeof text === 'string'
    && text.trim().length > 0
    && text.length <= MAX_UTTERANCE_LENGTH
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
}

/**
 * @param {object} options
 * @param {object} options.config Effective config from voice-config.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 */
export function createElevenLabsClient({ config, fetchImpl = fetch, timeoutMs = 12_000, baseUrl = API_BASE_URL } = {}) {
  if (!config || !isValidApiKey(config.apiKey)) {
    const error = new Error('ElevenLabs client requires a configured API key.');
    error.code = 'NOT_CONFIGURED';
    throw error;
  }

  /**
   * Synthesize speech. Resolves to:
   *   { ok: true, audio: Buffer, mime: 'audio/mpeg', format, modelId, voiceId }
   *   { ok: false, code, message }
   */
  return Object.freeze({
    async synthesize(text, { voiceSettings = DEFAULT_VOICE_SETTINGS } = {}) {
      if (!isValidUtterance(text)) {
        return { ok: false, code: 'validation', message: `Utterance must be 1-${MAX_UTTERANCE_LENGTH} characters of plain text.` };
      }
      if (!isValidVoiceId(config.voiceId)) {
        return { ok: false, code: 'validation', message: 'The configured voice id is not valid. Run "sparkiee voice setup".' };
      }

      const url = `${baseUrl}/v1/text-to-speech/${config.voiceId}?output_format=${encodeURIComponent(config.outputFormat)}`;
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'xi-api-key': config.apiKey,
            'content-type': 'application/json',
            accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text,
            model_id: config.modelId,
            voice_settings: {
              stability: voiceSettings.stability,
              similarity_boost: voiceSettings.similarity_boost,
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return timedOut
          ? { ok: false, code: 'timeout', message: `ElevenLabs did not answer within ${Math.round(timeoutMs / 1000)}s.` }
          : { ok: false, code: 'network', message: `Could not reach ElevenLabs: ${error?.message ?? 'network error'}.` };
      }

      if (!response.ok) {
        const { code, message } = normaliseError(response.status);
        return { ok: false, code, message };
      }

      let audio;
      try {
        audio = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        return { ok: false, code: 'network', message: `Could not download the generated audio: ${error?.message ?? 'read error'}.` };
      }
      if (audio.length === 0) {
        return { ok: false, code: 'provider', message: 'ElevenLabs returned an empty audio clip.' };
      }
      return {
        ok: true,
        audio,
        mime: 'audio/mpeg',
        format: config.outputFormat,
        modelId: config.modelId,
        voiceId: config.voiceId,
      };
    },

    /**
     * Cheap, credit-free probe used by "sparkiee voice setup --verify"
     * and voice status probes. Confirms the key works and the configured
     * voice exists on this account.
     */
    async verify() {
      try {
        const response = await fetchImpl(`${baseUrl}/v1/voices/${config.voiceId}`, {
          headers: { 'xi-api-key': config.apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 401) return { ok: false, code: 'auth', message: 'The ElevenLabs API key was rejected.' };
        if (response.status === 404) return { ok: false, code: 'validation', message: `Voice ${config.voiceId} was not found on this account.` };
        if (!response.ok) return { ok: false, ...normaliseError(response.status) };
        let payload = {};
        try {
          payload = await response.json();
        } catch {
          payload = {};
        }
        return { ok: true, voiceId: config.voiceId, name: typeof payload?.voice?.name === 'string' ? payload.voice.name.slice(0, 64) : null };
      } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return timedOut
          ? { ok: false, code: 'timeout', message: 'ElevenLabs did not answer the verification request in time.' }
          : { ok: false, code: 'network', message: `Could not reach ElevenLabs: ${error?.message ?? 'network error'}.` };
      }
    },
  });
}
