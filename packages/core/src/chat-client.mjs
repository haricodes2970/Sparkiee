/**
 * Conversational client for Groq and Google AI Studio.
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
import {
  CHAT_PROVIDER_INFO,
  DEFAULT_CHAT_PROVIDER,
  isValidChatApiKey,
  isValidChatModel,
  isValidChatBaseUrl,
} from './chat-config.mjs';

export const CHAT_ERROR_MESSAGES = Object.freeze({
  not_configured: 'No chat provider is set up yet. Run "sparkiee assistant setup".',
  local_only: 'Local-only mode is on, so nothing is sent to a chat provider. Turn it off in the dashboard to chat.',
  auth: 'The chat provider rejected the API key. Run "sparkiee assistant setup" to reconfigure it.',
  model_not_found: 'The chat provider does not recognise the configured model. Run "sparkiee assistant setup" to pick a new one.',
  rate_limited: 'The chat provider is rate limiting this key. Wait a moment and try again.',
  timeout: 'The chat provider did not answer in time. Try again.',
  network: 'Could not reach the chat provider. Check the network connection.',
  blocked: 'The chat provider blocked that reply for safety. Try rephrasing.',
  bad_response: 'The chat provider returned an unexpected response.',
  provider_error: 'The chat provider reported an error. Try again.',
  empty_reply: 'The chat provider returned an empty reply.',
});

export const MAX_CHAT_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 25_000;

const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION']);

function describeError(code, detail = null, secret = null) {
  return {
    code,
    message: CHAT_ERROR_MESSAGES[code] ?? CHAT_ERROR_MESSAGES.provider_error,
    detail: detail ? redactSecrets(String(detail), { secrets: secret ? [secret] : [] }).slice(0, 240) : null,
  };
}

function mapStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}

function normaliseProvider(provider) {
  return Object.hasOwn(CHAT_PROVIDER_INFO, provider) ? provider : DEFAULT_CHAT_PROVIDER;
}

/** Keep only roles the providers accept; drop empty turns. */
function normaliseMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: ['system', 'user', 'assistant'].includes(message?.role) ? message.role : 'user',
      content: String(message?.content ?? '').slice(0, 8000).trim(),
    }))
    .filter((message) => message.content.length > 0);
}

/**
 * @param {object} options
 * @param {'groq'|'google'} [options.provider]
 * @param {{apiKey: string|null, model: string|null, baseUrl?: string, localOnly?: boolean}} options.config
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 */
export function createChatClient({
  provider = DEFAULT_CHAT_PROVIDER,
  config,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const kind = normaliseProvider(provider);
  const info = CHAT_PROVIDER_INFO[kind];
  const baseUrl = (isValidChatBaseUrl(config?.baseUrl) ? config.baseUrl : info.baseUrl).replace(/\/+$/, '');
  const key = isValidChatApiKey(kind, config?.apiKey) ? config.apiKey.trim() : null;
  const model = isValidChatModel(config?.model) ? config.model.trim() : null;
  const localOnly = config?.localOnly === true;
  const boundedTimeout = Math.max(1000, Math.min(MAX_CHAT_TIMEOUT_MS, timeoutMs));

  function headers() {
    if (kind === 'google') {
      // Header, never a query parameter: the key must not end up in a URL,
      // proxy log, or crash report.
      return { accept: 'application/json', 'x-goog-api-key': key };
    }
    return { accept: 'application/json', authorization: `Bearer ${key}` };
  }

  async function request(url, { method = 'GET', body = null, timeoutOverrideMs = null } = {}) {
    const controller = new AbortController();
    const budget = Math.max(1000, Math.min(MAX_CHAT_TIMEOUT_MS, timeoutOverrideMs ?? boundedTimeout));
    const timer = setTimeout(() => controller.abort(), budget);
    timer?.unref?.();
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          ...headers(),
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

  /** GET the provider's live model list — used at setup; never a hardcoded guess. */
  async function listModels({ timeoutOverrideMs = 15_000 } = {}) {
    if (!key) return { ok: false, error: describeError('not_configured') };
    let result;
    try {
      result = await request(`${baseUrl}/models`, { timeoutOverrideMs });
    } catch (error) {
      const code = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : 'network';
      return { ok: false, error: describeError(code, error?.message, key) };
    }
    if (!result.response.ok) {
      return { ok: false, error: describeError(mapStatus(result.response.status), result.text, key) };
    }
    const models = kind === 'google'
      ? (Array.isArray(result.parsed?.models) ? result.parsed.models : [])
        .filter((entry) => Array.isArray(entry?.supportedGenerationMethods)
          && entry.supportedGenerationMethods.includes('generateContent'))
        .map((entry) => String(entry?.name ?? '').replace(/^models\//, '').trim())
        .filter(isValidChatModel)
      : (Array.isArray(result.parsed?.data) ? result.parsed.data : [])
        .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : null))
        .filter((id) => id && isValidChatModel(id));
    return { ok: true, models };
  }

  function buildBody(messages, { maxTokens, temperature, topP }) {
    if (kind === 'google') {
      const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
      const turns = messages.filter((message) => message.role !== 'system');
      return {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: turns.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
        generationConfig: {
          maxOutputTokens: Math.max(16, Math.min(2048, maxTokens)),
          temperature: Math.max(0, Math.min(2, temperature)),
          topP: Math.max(0.01, Math.min(1, topP)),
        },
      };
    }
    return {
      model,
      messages,
      max_tokens: Math.max(16, Math.min(2048, maxTokens)),
      temperature: Math.max(0, Math.min(2, temperature)),
      top_p: Math.max(0.01, Math.min(1, topP)),
      stream: false,
    };
  }

  function parseReply(parsed) {
    if (kind === 'google') {
      if (typeof parsed?.promptFeedback?.blockReason === 'string') return { blocked: true };
      const candidate = parsed?.candidates?.[0];
      if (typeof candidate?.finishReason === 'string' && BLOCKED_FINISH_REASONS.has(candidate.finishReason)) {
        return { blocked: true };
      }
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const text = parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ').replace(/\s+/g, ' ').trim();
      return { text, model, usage: parsed?.usageMetadata ?? null };
    }
    const choice = parsed?.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
    return { text, model: parsed?.model ?? model, usage: parsed?.usage ?? null };
  }

  /**
   * POST the chat turn. Returns `{ok:true, text, model, usage}` or
   * `{ok:false, error:{code,message,detail}}`. Never throws for provider
   * problems — a thrown exception would be indistinguishable from a bug.
   */
  async function chat({ messages, maxTokens = 400, temperature = 0.6, topP = 0.95, timeoutOverrideMs = null } = {}) {
    if (localOnly) return { ok: false, error: describeError('local_only') };
    if (!key || !model) return { ok: false, error: describeError('not_configured') };
    const turns = normaliseMessages(messages);
    if (turns.length === 0) return { ok: false, error: describeError('bad_response', 'no messages supplied') };

    const url = kind === 'google'
      ? `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`
      : `${baseUrl}/chat/completions`;
    const body = buildBody(turns, { maxTokens, temperature, topP });

    let result;
    try {
      result = await request(url, { method: 'POST', body, timeoutOverrideMs });
    } catch (error) {
      const code = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : 'network';
      return { ok: false, error: describeError(code, error?.message, key) };
    }

    if (!result.response.ok) {
      return { ok: false, error: describeError(mapStatus(result.response.status), result.text, key) };
    }

    const parsed = parseReply(result.parsed);
    if (parsed.blocked) return { ok: false, error: describeError('blocked') };
    if (!parsed.text) return { ok: false, error: describeError('empty_reply') };
    return { ok: true, text: parsed.text, model: parsed.model ?? model, usage: parsed.usage ?? null };
  }

  return {
    provider: kind,
    configured: Boolean(key && model && !localOnly),
    hasKey: Boolean(key),
    model,
    baseUrl,
    localOnly,
    listModels,
    chat,
  };
}
