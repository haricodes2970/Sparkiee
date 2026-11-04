/**
 * Credential redaction.
 *
 * Provider error bodies are the one place a key can escape: an upstream
 * service may echo the Authorization header back in its message. Anything
 * that could be shown to a human (CLI output, dashboard, logs, API errors)
 * is passed through here first, so Sparky can be honest about a failure
 * without ever printing the secret.
 *
 * Pure Node: no dependencies, no I/O.
 */

/** Long opaque tokens: NVIDIA (nvapi-...), ElevenLabs (sk_...), generic. */
const TOKEN_SHAPED = /\b(?:nvapi-|sk_)[A-Za-z0-9_-]{8,}\b|\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g;
/** `Bearer <token>` / `Authorization: ApiKey <token>` headers. */
const AUTH_HEADER = /\b(Bearer|ApiKey|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
/** `api_key=...`, `"apiKey": "..."`, `token: ...`, `secret = ...`. */
const LABELLED = /((?:api[_-]?key|authorization|auth|token|secret|password)["']?\s*[:=]\s*)(["']?)[^\s"',;}]{4,}\2/gi;
const PLACEHOLDER = '[redacted]';

/**
 * Remove anything that looks like a credential from `text`.
 *
 * @param {unknown} text
 * @param {{secrets?: string[]}} [options] Exact secret values to blank out
 *   even if their shape is unusual.
 * @returns {string}
 */
export function redactSecrets(text, { secrets = [] } = {}) {
  let out = typeof text === 'string' ? text : String(text ?? '');
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret === 'string' && secret.length >= 6) {
      out = out.split(secret).join(PLACEHOLDER);
    }
  }
  out = out.replace(AUTH_HEADER, (_match, scheme) => `${scheme} ${PLACEHOLDER}`);
  out = out.replace(LABELLED, (_match, label, quote) => `${label}${quote}${PLACEHOLDER}${quote}`);
  out = out.replace(TOKEN_SHAPED, PLACEHOLDER);
  return out;
}

/** True when the text still contains something credential-shaped. */
export function containsSecretLike(text) {
  if (typeof text !== 'string') return false;
  return TOKEN_SHAPED.test(text) || AUTH_HEADER.test(text) || LABELLED.test(text);
}
