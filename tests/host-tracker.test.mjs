import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_PHASES, createHostTracker } from '../packages/core/src/host-tracker.mjs';

test('host tracker starts in the correct phase for disabled and headless modes', () => {
  assert.equal(createHostTracker({ disabled: true }).snapshot().phase, 'disabled');
  assert.equal(createHostTracker({ noDisplay: true }).snapshot().phase, 'unavailable');
  assert.equal(createHostTracker({}).snapshot().phase, 'idle');
  assert.equal(createHostTracker({ disabled: true }).canLaunch(), false);
  assert.equal(createHostTracker({ noDisplay: true }).canLaunch(), false);
  assert.equal(createHostTracker({}).canLaunch(), true);
});

test('host tracker follows the real process lifecycle', () => {
  const tracker = createHostTracker({});
  tracker.markLaunching();
  assert.equal(tracker.snapshot().phase, 'launching');
  tracker.markRunning(process.pid);
  const running = tracker.snapshot();
  assert.equal(running.phase, 'running');
  assert.equal(running.pid, process.pid);
  assert.equal(running.pidAlive, true);
  assert.equal(running.lastError, null);

  tracker.markExited(1, null, { wasShuttingDown: false });
  const failed = tracker.snapshot();
  assert.equal(failed.phase, 'failed');
  assert.match(failed.lastError, /exited unexpectedly/);
  assert.equal(failed.pidAlive, false);

  tracker.markExited(0, 'SIGTERM', { wasShuttingDown: true });
  assert.equal(tracker.snapshot().phase, 'exited');
});

test('host tracker records launch failures with a reason', () => {
  const tracker = createHostTracker({});
  tracker.markLaunching();
  tracker.markFailed('Electron binary is missing.');
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.phase, 'failed');
  assert.equal(snapshot.lastError, 'Electron binary is missing.');
  assert.ok(HOST_PHASES.includes(snapshot.phase));
});

test('host tracker counts and resets restart attempts', () => {
  const tracker = createHostTracker({});
  tracker.markFailed('boom');
  tracker.countRestart();
  tracker.countRestart();
  assert.equal(tracker.snapshot().restarts, 2);
  tracker.resetFailures();
  assert.equal(tracker.snapshot().restarts, 0);
});
