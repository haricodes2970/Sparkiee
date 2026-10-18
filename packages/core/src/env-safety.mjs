/**
 * Environment sanitisation for child processes.
 *
 * Secrets that belong only to the daemon (such as the ElevenLabs key)
 * are stripped from any environment handed to other processes. The
 * desktop pet host only ever needs the runtime token, never provider
 * credentials.
 */

export const DAEMON_ONLY_SECRET_KEYS = Object.freeze(['ELEVENLABS_API_KEY']);

/**
 * Returns a shallow copy of `env` without the daemon-only secret keys.
 * The original object is never mutated.
 */
export function withoutSecrets(env = process.env, secretKeys = DAEMON_ONLY_SECRET_KEYS) {
  const safe = { ...env };
  for (const key of secretKeys) delete safe[key];
  return safe;
}
