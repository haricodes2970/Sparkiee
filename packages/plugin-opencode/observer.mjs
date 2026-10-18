/**
 * Observer-only bridge between OpenCode's event stream and Sparkiee's
 * local agent-event API.
 *
 * Design rules (kept pure and unit-tested, no I/O here):
 * - Only short lifecycle facts are reported: the agent-event id and the
 *   session id. Message text, file paths, tool arguments, terminal
 *   output, and provider data never leave this process.
 * - The plugin observes and reports; it never approves, rejects, or
 *   otherwise alters anything inside OpenCode.
 * - task_complete is reported only for session.execution.succeeded —
 *   a genuinely confirmed completion. Idle sessions are reported as
 *   session_idle, which Sparkiee deliberately answers with no
 *   celebration.
 * - Every report is throttled per session+event and every send failure
 *   (daemon not running, restart, network hiccup) is swallowed: the
 *   observer must never disturb OpenCode.
 */

/**
 * OpenCode V2 event type -> Sparkiee agent event.
 *
 * Types that are intentionally silent are absent, not null-mapped:
 * execution.interrupted (user stopped; neither success nor failure),
 * permission.replied (the human already handled it), and every
 * content-bearing event.
 */
export const OPENCODE_EVENT_AGENT_MAP = Object.freeze({
  'session.execution.started': 'task_start',
  'session.execution.succeeded': 'task_complete',
  'session.execution.failed': 'task_error',
  'permission.asked': 'permission_request',
  'session.idle': 'session_idle',
});

/** Default per-session+event report gap (the daemon enforces its own too). */
export const AGENT_REPORT_COOLDOWN_MS = 15_000;

/** Tolerate JSON strings and already-decoded objects from the stream. */
export function parseOpenCodeEvent(raw) {
  let event = raw;
  if (typeof raw === 'string') {
    try {
      event = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null;
  return event;
}

/** Extract the reportable {event, sessionId} fact, or null to stay quiet. */
export function reporterEventFor(raw) {
  const event = parseOpenCodeEvent(raw);
  if (!event) return null;
  const agentEvent = OPENCODE_EVENT_AGENT_MAP[event.type];
  if (!agentEvent) return null;
  const sessionId = event.data?.sessionID;
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) return null;
  return { event: agentEvent, sessionId };
}

/**
 * Wrap an async `send` with per-session+event throttling. `send` throws
 * on failure; failures are reported as results, never as exceptions.
 */
export function createAgentReporter({ send, now = () => Date.now(), cooldownMs = AGENT_REPORT_COOLDOWN_MS } = {}) {
  const last = new Map();
  return async function report(rawEvent) {
    const fact = reporterEventFor(rawEvent);
    if (!fact) return { reported: false, reason: 'ignored' };
    const key = `${fact.sessionId}:${fact.event}`;
    const at = now();
    if (at - (last.get(key) ?? -Infinity) < cooldownMs) return { reported: false, reason: 'cooldown' };
    last.set(key, at);
    if (last.size > 500) {
      for (const [seenKey, seenAt] of last) {
        if (at - seenAt >= cooldownMs) last.delete(seenKey);
      }
    }
    try {
      await send({ source: 'opencode', ...fact });
      return { reported: true };
    } catch {
      // Sparkiee not running (or restarting) is the normal case for many
      // users; the observer stays silent and keeps watching.
      return { reported: false, reason: 'unreachable' };
    }
  };
}
