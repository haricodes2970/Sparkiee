import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAssistantController, canTransition, isValidAssistantState } from '../packages/core/src/assistant-state.mjs';

test('assistant state machine: valid states and transitions', () => {
  assert.ok(isValidAssistantState('armed'));
  assert.ok(!isValidAssistantState('flying'));
  assert.ok(canTransition('disabled', 'armed'));
  assert.ok(canTransition('disabled', 'listening'), 'PTT allows disabled->listening');
  assert.ok(canTransition('armed', 'listening'));
  assert.ok(canTransition('armed', 'disabled'));
  assert.ok(canTransition('listening', 'transcribing'));
  assert.ok(canTransition('error', 'armed'));
});

test('assistant controller: snapshot, transition, micActive, recordAction', () => {
  let now = 1000;
  const ctrl = createAssistantController({ now: () => now });
  const s0 = ctrl.snapshot();
  assert.equal(s0.state, 'disabled');
  assert.equal(s0.micActive, false);
  assert.equal(s0.listening, false);
  assert.equal(s0.cancellable, false);
  assert.equal(s0.lastAction, null);

  const s1 = ctrl.transition('armed', { reason: 'test-enable' });
  assert.equal(s1.state, 'armed');
  assert.equal(s1.listening, true);
  assert.equal(s1.since, new Date(now).toISOString());

  ctrl.setMicActive(true, { reason: 'ptt-start' });
  const s2 = ctrl.snapshot();
  assert.equal(s2.micActive, true);

  ctrl.recordAction({ kind: 'ptt', durationMs: 1200, text: 'play madira', reply: 'Okay!', executed: true });
  const s3 = ctrl.snapshot();
  assert.ok(s3.lastAction);
  assert.equal(s3.lastAction.kind, 'ptt');
  assert.equal(s3.lastAction.text, 'play madira');

  // Invalid state throws INVALID_ASSISTANT_STATE.
  assert.throws(() => ctrl.transition('flying'), (e) => e.code === 'INVALID_ASSISTANT_STATE');
  // Invalid transition from disabled: wake_detected not allowed.
  const ctrl2 = createAssistantController({ now: () => now });
  assert.throws(() => ctrl2.transition('wake_detected'), (e) => e.code === 'INVALID_TRANSITION');
});

test('controller fail() lands in error when allowed', () => {
  const ctrl = createAssistantController({});
  ctrl.transition('armed', {});
  const s = ctrl.fail('mic exploded');
  assert.equal(s.state, 'error');
  assert.match(s.lastError, /mic exploded/);
});