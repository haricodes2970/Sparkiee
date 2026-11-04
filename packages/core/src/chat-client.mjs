/**
 * Conversational client for NVIDIA's OpenAI-compatible inference gateway.
 *
 * Sparky sends a bounded message list and gets one assistant reply back. The
 * client is deliberately dumb: no tool calling, no shell, no code execution —
 * the model returns text, full stop. Every failure is mapped to a stable code
 * so the UI can explain exactly what went wrong, and every error string is
 * redacted before it can reach a human.
 *
 * `fetchImpl` is injectable so the whole client is testable without network.
 */

import { redactSecrets } from './secret-redaction.mjs';
import { isValidNvidiaApiKey, isValidNvidiaModel, DEFAULT_NVIDIA_BASE_URL } from './nvidia-config.mjs';

export const CHAT_ERROR_MESSAGES = Object.freeze({
  not_configured: 'The NVIDIA assistant is not set up yet. Run "sparkiee assistant setup".',
  local_only: 'Local-only mode is on, so nothing is sent to NVIDIA. Turn it off in the dashboard to chat.',
  auth: 'NVIDIA rejected the API key. Run "sparkiee assistant setup" to reconfigure it.',
  model_not_found: 'NVIDIA does not recognise the configured model. Run "sparkiee assistant setup" to pick a new one.',
  rate_limited: 'NVIDIA is rate limiting this key. Wait a moment and try again.',
  timeout: 'NVIDIA did not answer in time. Try again.',
  network: 'Could not reach NVIDIA. Check the network connection.',
  bad_response: 'NVIDIA returned an unexpected response.',
  provider_error: 'NVIDIA reported an error. Try again.',
  empty_reply: 'NVIDIA returned an empty reply.',
});

export const MAX_CHAT_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 25_000;

function describeError(code, detail = null) {
  return {
    code,
    message: CHAT_ERROR_MESSAGES[code] ?? CHAT_ERROR_MESSAGES.provider_error,
    detail: detail ? redactSecrets(String(detail)).slice(0, 240) : null,
  };
}

function mapStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'provider_error';
  if (status >= 500) return 'provider_error';
  return 'provider_error';
}

/**
 * @param {object} options
 * @param {{apiKey: string|null, model: string|null, baseUrl: string, localOnly: boolean}} options.config
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 */
export function createNvidiaChatClient({ config, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const baseUrl = (config?.baseUrl || DEFAULT_NVIDIA_BASE_URL).replace(/\/+$/, '');
  const key = isValidNvidiaApiKey(config?.apiKey) ? config.apiKey.trim() : null;
  const model = isValidNvidiaModel(config?.model) ? config.model.trim() : null;
  const boundedTimeout = Math.max(1000, Math.min(MAX_CHAT_TIMEOUT_MS, timeoutMs));

  async function request(pathname, { method = 'GET', body = null, timeoutOverrideMs = null } = {}) {
    const controller = new AbortController();
    const budget = Math.max(1000, Math.min(MAX_CHAT_TIMEOUT_MS, timeoutOverrideMs ?? boundedTimeout));
    const timer = setTimeout(() => controller.abort(), budget);
    timer?.unref?.();
    try {
      const response = await fetchImpl(`${baseUrl}${pathname}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${key}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text().catch(() => '');
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { response, parsed, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /models — used at setup to pick a real, existing model id. */
  async function listModels({ timeoutOverrideMs = 15_000 } = {}) {
    if (!key) return { ok: false, error: describeError('not_configured') };
    let result;
    try {
      result = await request('/models', { timeoutOverrideMs });
    } catch (error) {
      // AbortError lands here when the timeout fires before any response.
      const code = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : 'network';
      return { ok: false, error: describeError(code, error?.message) };
    }
    if (!result.response.ok) {
      return { ok: false, error: describeError(mapStatus(result.response.status), result.text) };
    }
    const raw = Array.isArray(result.parsed?.data) ? result.parsed.data : [];
    const models = raw
      .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : null))
      .filter((id) => id && isValidNvidiaModel(id));
    return { ok: true, models };
  }

  /**
   * POST /chat/completions. Returns `{ok:true, text, model, usage}` or
   * `{ok:false, error:{code,message,detail}}`. Never throws for provider
   * problems — a thrown exception would be indistinguishable from a bug.
   */
  async function chat({ messages, maxTokens = 400, temperature = 0.6, topP = 0.95, timeoutOverrideMs = null } = {}) {
    if (!key || !model) return { ok: false, error: describeError('not_configured') };
    if (!Array.isArray(messages) || messages.length === 0) {
      return { ok: false, error: describeError('bad_response', 'no messages supplied') };
    }
    const body = {
      model,
      messages: messages.map((message) => ({
        role: ['system', 'user', 'assistant'].includes(message?.role) ? message.role : 'user',
        content: String(message?.content ?? '').slice(0, 8000),
      })),
      max_tokens: Math.max(16, Math.min(2048, maxTokens)),
      temperature: Math.max(0, Math.min(2, temperature)),
      top_p: Math.max(0.01, Math.min(1, topP)),
      stream: false,
    };

    let result;
    try {
      result = await request('/chat/completions', { method: 'POST', body, timeoutOverrideMs });
    } catch (error) {
      const code = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : 'network';
      return { ok: false, error: describeError(code, error?.message) };
    }

    if (!result.response.ok) {
      return { ok: false, error: describeError(mapStatus(result.response.status), result.text) };
    }

    const choice = result.parsed?.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
    if (!content) {
      return { ok: false, error: describeError('empty_reply'), model };
    }
    return {
      ok: true,
      text: content,
      model: result.parsed?.model ?? model,
      usage: result.parsed?.usage ?? null,
    };
  }

  return {
    configured: Boolean(key && model),
    hasKey: Boolean(key),
    model,
    baseUrl,
    listModels,
    chat,
  };
}
