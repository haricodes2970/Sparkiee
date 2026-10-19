/**
 * Assistant listening state machine (spec: explicit, observable states).
 *
 * One authoritative machine per runtime: the dashboard and pet read the same
 * snapshot, transitions are validated (invalid ones throw, never silently
 * applied), and the microphone indicator is independent of the state so a
 * diagnostic capture never fakes an "armed" listening session.
 */

export const ASSISTANT_STATES = Object.freeze([
  'disabled',
  'armed',
  'wake_detected',
  'listening',
  'transcribing',
  'interpreting',
  'executing',
  'speaking',
  'awaiting_confirmation',
  'error',
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  disabled: ['armed', 'listening', 'error'],
  armed: ['disabled', 'wake_detected', 'listening', 'error'],
  wake_detected: ['listening', 'armed', 'disabled', 'error'],
  listening: ['transcribing', 'armed', 'disabled', 'error'],
  transcribing: ['interpreting', 'armed', 'disabled', 'error'],
  interpreting: ['executing', 'awaiting_confirmation', 'speaking', 'armed', 'disabled', 'error'],
  executing: ['speaking', 'armed', 'disabled', 'error'],
  speaking: ['armed', 'disabled', 'awaiting_confirmation', 'error'],
  awaiting_confirmation: ['executing', 'armed', 'disabled', 'error'],
  error: ['disabled', 'armed'],
});

function stateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function isValidAssistantState(value) {
  return typeof value === 'string' && ASSISTANT_STATES.includes(value);
}

export function canTransition(from, to) {
  if (!isValidAssistantState(from) || !isValidAssistantState(to)) return false;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function createAssistantController({ now = () => Date.now() } = {}) {
  let state = 'disabled';
  let since = now();
  let micActive = false;
  let lastAction = null;
  let lastError = null;
  const history = []; // most-recent-last, capped

  function snapshot() {
    return {
      state,
      since: new Date(since).toISOString(),
      micActive,
      listening: state === 'armed' || state === 'wake_detected' || state === 'listening',
      cancellable: state === 'listening' || state === 'transcribing' || state === 'wake_detected',
      lastAction: lastAction ? { ...lastAction } : null,
      lastError,
      history: history.map((entry) => ({ ...entry })),
    };
  }

  return {
    snapshot,
    transition(to, { reason = null, error = null } = {}) {
      if (!isValidAssistantState(to)) {
        throw stateError('INVALID_ASSISTANT_STATE', `Unknown assistant state: ${String(to)}.`);
      }
      if (!canTransition(state, to)) {
        throw stateError(
          'INVALID_TRANSITION',
          `Cannot go from assistant state "${state}" to "${to}".`,
        );
      }
      const from = state;
      state = to;
      since = now();
      lastError = error ?? (to === 'error' ? (lastError ?? 'Unknown assistant error.') : null);
      history.push({ at: new Date(since).toISOString(), from, to, reason });
      while (history.length > 10) history.shift();
      return snapshot();
    },
    setMicActive(active, { reason = null } = {}) {
      micActive = Boolean(active);
      if (reason) {
        history.push({ at: new Date(now()).toISOString(), from: state, to: state, reason });
        while (history.length > 10) history.shift();
      }
      return snapshot();
    },
    recordAction(action) {
      lastAction = { at: new Date(now()).toISOString(), ...action };
      if (action.error) lastError = String(action.error);
      return snapshot();
    },
    fail(message) {
      lastError = String(message ?? 'Unknown assistant error.');
      // Erroring from any state is allowed; land in error only via the map.
      if (canTransition(state, 'error')) return this.transition('error', { error: lastError });
      return snapshot();
    },
  };
}
