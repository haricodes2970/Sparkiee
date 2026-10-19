/**
 * Dashboard assistant panel view-model.
 *
 * Pure and DOM-free so the honest-values rules are testable in node: hotkey
 * registration is reported exactly as the daemon saw it (no fabricated
 * "active"), every needs-setup row says so, and unknown states fall back to
 * the raw state word rather than a friendly lie.
 */

const STATE_LABELS = Object.freeze({
  disabled: 'Idle',
  armed: 'Waiting for "Yo Spark"',
  wake_detected: 'Heard "Yo Spark" — listening',
  listening: 'Listening',
  transcribing: 'Transcribing',
  interpreting: 'Working it out',
  executing: 'Executing',
  speaking: 'Speaking',
  awaiting_confirmation: 'Waiting for a confirmation',
  error: 'Error',
});

const BUSY_STATES = Object.freeze(new Set(['wake_detected', 'listening', 'transcribing', 'interpreting', 'executing', 'speaking', 'awaiting_confirmation']));

function shortAccelerator(accelerator) {
  return String(accelerator ?? 'Control+Alt+Space')
    .replace('Control+Alt+Space', 'Ctrl + Alt + Space')
    .replace('Control', 'Ctrl')
    .replace('CommandOrControl', 'Ctrl');
}

function describeHotkey(shortcut) {
  if (!shortcut) return 'Hotkey state unknown';
  const combo = shortAccelerator(shortcut.accelerator);
  if (shortcut.enabled !== true) return `Off (${combo})`;
  if (shortcut.registered === true) return `On — registered (${combo})`;
  if (shortcut.registered === false) {
    const reason = String(shortcut.registrationDetail ?? 'not active').slice(0, 80);
    return `On — ${reason}`;
  }
  return `Pending registration (${combo})`;
}

function describeLastAction(action) {
  if (!action || typeof action !== 'object') return '';
  const transcript = typeof action.transcript === 'string' ? action.transcript.slice(0, 60) : null;
  const executed = action.executed === true;
  let verdict;
  if (action.kind === 'ptt-cancelled') verdict = 'cancelled without executing';
  else if (action.kind === 'ptt') verdict = executed ? 'executed' : 'did not execute';
  else if (action.executable === false) verdict = '';
  else verdict = executed ? 'executed' : 'did not execute';
  const head = transcript ? `Heard “${transcript}”` : `Last ${action.kind ?? 'action'}`;
  const tail = verdict && action.intent ? ` · ${action.intent} — ${verdict}`
    : verdict ? ` · ${verdict}` : action.intent ? ` · ${action.intent}` : '';
  return `${head}${tail}`.slice(0, 140).trim();
}

export function assistantPanelViewModel(payload = {}) {
  const assistant = payload.assistant ?? {};
  const stt = payload.stt ?? null;
  const state = assistant.state ?? 'disabled';
  const shortcut = assistant.shortcut ?? null;
  const wake = assistant.wake ?? null;
  const mic = assistant.mic ?? null;
  const busy = BUSY_STATES.has(state) || assistant.micActive === true;

  return {
    stateLabel: STATE_LABELS[state] ?? state,
    state: state,
    hotkeyLabel: describeHotkey(shortcut),
    wakeLabel: wake ? (wake.status === 'ready' ? 'ready' : wake.status === 'unavailable' ? 'unavailable' : 'needs setup') : 'unknown',
    sttLabel: stt
      ? (stt.status === 'ready' ? `ready (${stt.model ?? 'tiny.en'})` : stt.status === 'unavailable' ? 'unavailable' : 'needs setup')
      : 'unknown',
    micLabel: assistant.micActive && mic?.active
      ? `capturing (${Math.max(0, Math.round((Number(mic.active.elapsedMs) || 0) / 100) / 10).toFixed(1)}s)`
      : mic?.active ? 'capturing' : 'not capturing',
    transcript: typeof payload.transcript === 'string' ? payload.transcript.slice(0, 200) : '',
    lastActionLabel: describeLastAction(assistant.lastAction),
    lastError: assistant.lastError == null ? '' : String(assistant.lastError).slice(0, 140),
    testBusy: false,
    busy,
    startEnabled: !busy,
    stopEnabled: state === 'listening' || assistant.micActive === true,
    cancelEnabled: assistant.cancellable === true,
  };
}
