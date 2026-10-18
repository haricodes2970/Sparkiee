/**
 * Agent-event payloads and throttling rules for the local event API.
 *
 * The OpenCode observer plugin reports only short lifecycle facts
 * (which session, which event) — never message content, file paths,
 * terminal output, or provider data. Reactions are predefined in
 * voice-lines.mjs; session_idle deliberately produces no reaction so
 * an idle session is never treated as confirmed success.
 */

import { AGENT_EVENT_REACTIONS } from './voice-lines.mjs';

/** Identical session+event inside this window is a duplicate. */
export const AGENT_EVENT_DEDUP_MS = 2000;

/** Same session+event inside (but beyond) this window is throttled. */
export const AGENT_EVENT_COOLDOWN_MS = 15_000;

/** Upper bound on the in-memory dedup table before pruning. */
export const AGENT_EVENT_MEMORY_LIMIT = 500;

export function isValidAgentEventPayload(payload) {
  return Boolean(
    payload
    && typeof payload === 'object'
    && typeof payload.source === 'string'
    && payload.source.length >= 1
    && payload.source.length <= 32
    && typeof payload.sessionId === 'string'
    && payload.sessionId.length >= 1
    && payload.sessionId.length <= 128
    && typeof payload.event === 'string'
    && Object.hasOwn(AGENT_EVENT_REACTIONS, payload.event),
  );
}
