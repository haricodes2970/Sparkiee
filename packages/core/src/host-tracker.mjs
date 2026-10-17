import { isPidAlive } from './index.mjs';

export const HOST_PHASES = Object.freeze(['disabled', 'unavailable', 'idle', 'launching', 'running', 'exited', 'failed']);

/**
 * Tracks the real lifecycle of the desktop pet host process.
 *
 * Phase meanings:
 * - disabled:    SPARKIEE_DISABLE_PET=1; no host expected.
 * - unavailable: no graphical session; no host expected.
 * - idle:        daemon started, host not requested yet.
 * - launching:   spawn requested, process not confirmed.
 * - running:     host process confirmed alive.
 * - exited:      host process exited (cleanly or by signal).
 * - failed:      launch failed or the binary is missing; lastError says why.
 */
export function createHostTracker({ disabled = false, noDisplay = false } = {}) {
  const initialPhase = disabled ? 'disabled' : noDisplay ? 'unavailable' : 'idle';
  let phase = initialPhase;
  let pid = null;
  let lastError = null;
  let restarts = 0;
  let since = Date.now();

  function transition(nextPhase, { error = lastError, childPid = pid } = {}) {
    phase = nextPhase;
    pid = childPid;
    lastError = error;
    since = Date.now();
  }

  return {
    canLaunch() {
      return !disabled && !noDisplay;
    },
    markLaunching() {
      transition('launching', { childPid: null, error: null });
    },
    markRunning(childPid) {
      transition('running', { childPid, error: null });
    },
    markExited(code, signal, { wasShuttingDown = false } = {}) {
      const clean = wasShuttingDown || code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL';
      transition(clean ? 'exited' : 'failed', {
        childPid: null,
        error: clean ? lastError : `Pet host exited unexpectedly (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`,
      });
    },
    markFailed(message) {
      transition('failed', { childPid: null, error: message });
    },
    countRestart() {
      restarts += 1;
    },
    resetFailures() {
      restarts = 0;
      if (phase === 'failed' && !lastError) transition('idle');
    },
    get restarts() {
      return restarts;
    },
    snapshot() {
      return {
        phase,
        pid,
        pidAlive: pid !== null && isPidAlive(pid),
        lastError,
        restarts,
        since,
      };
    },
  };
}
