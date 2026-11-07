import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_VOICE_EVENTS, createPetController, formatTaskDuration, isValidDockPayload, isValidPetCommandPayload, isValidPetSettingsPayload, PET_COMMANDS } from '../packages/core/src/pet-state.mjs';

test('new pet controller begins visible and idle without a connected host', () => {
  let time = 1000;
  const pet = createPetController({ clock: () => time });
  const state = pet.snapshot();
  assert.equal(state.animation, 'idle');
  assert.equal(state.visible, true);
  assert.equal(state.hostConnected, false);
  assert.equal(state.characterId, 'sparkiee-original');
});

test('all supported commands update state and timestamp', () => {
  let time = 1000;
  const pet = createPetController({ clock: () => time });
  for (const command of PET_COMMANDS) {
    time += 1000;
    const state = pet.command(command);
    assert.equal(state.updatedAt, new Date(time).toISOString());
    assert.ok(state.label.length > 0);
    assert.ok(state.message.length > 0);
  }
});

test('hide and show commands toggle visibility without corrupting animation state', () => {
  const pet = createPetController();
  assert.equal(pet.command('dance').animation, 'dance');
  const hidden = pet.command('hide');
  assert.equal(hidden.visible, false);
  assert.equal(hidden.animation, 'dance');
  const visible = pet.command('show');
  assert.equal(visible.visible, true);
  assert.equal(visible.animation, 'dance');
});

test('invalid commands are rejected', () => {
  const pet = createPetController();
  assert.throws(() => pet.command('execute-shell'), { code: 'INVALID_PET_COMMAND' });
  assert.throws(() => pet.command({ command: 'dance' }), { code: 'INVALID_PET_COMMAND' });
});

test('pet heartbeat expires after the freshness window', () => {
  let time = 1000;
  const pet = createPetController({ clock: () => time });
  pet.heartbeat();
  assert.equal(pet.snapshot().hostConnected, true);
  time += 3499;
  assert.equal(pet.snapshot().hostConnected, true);
  time += 2;
  assert.equal(pet.snapshot().hostConnected, false);
});

test('command payloads accept only a single supported command field', () => {
  assert.equal(isValidPetCommandPayload({ command: 'dance' }), true);
  assert.equal(isValidPetCommandPayload({ command: 'show' }), true);
  assert.equal(isValidPetCommandPayload({ command: 'execute-shell' }), false);
  assert.equal(isValidPetCommandPayload({ command: 'dance', args: 'bad' }), false);
  assert.equal(isValidPetCommandPayload(null), false);
  assert.equal(isValidPetCommandPayload(['dance']), false);
});

test('pet settings default to speed 1 with autonomous roaming enabled', () => {
  const pet = createPetController();
  const { settings } = pet.snapshot();
  assert.equal(settings.moveSpeed, 1);
  assert.equal(settings.autoRoam, true);
  assert.deepEqual(settings.audio, { enabled: true, volume: 0.7 });
  assert.deepEqual(settings.captions, { enabled: true, durationMs: 2600, large: false });
  assert.equal(settings.characterId, null);
});

test('pet settings accept validated updates and reject out-of-range values', () => {
  const pet = createPetController();
  const updated = pet.updateSettings({ moveSpeed: 2.5, autoRoam: false });
  assert.equal(updated.settings.moveSpeed, 2.5);
  assert.equal(updated.settings.autoRoam, false);

  assert.throws(() => pet.updateSettings({ moveSpeed: 0 }), /moveSpeed must be a number/);
  assert.throws(() => pet.updateSettings({ moveSpeed: 99 }), /moveSpeed must be a number/);
  assert.throws(() => pet.updateSettings({ moveSpeed: 'fast' }), /moveSpeed must be a number/);
  assert.throws(() => pet.updateSettings({ autoRoam: 'yes' }), /autoRoam must be a boolean/);
  assert.equal(pet.snapshot().settings.moveSpeed, 2.5);
  assert.equal(pet.snapshot().settings.autoRoam, false);
});

test('audio, captions, and character settings validate strictly', () => {
  const pet = createPetController();
  const updated = pet.updateSettings({
    audio: { enabled: false, volume: 0.2 },
    captions: { enabled: true, durationMs: 4000, large: true },
    characterId: 'sparkiee-original',
  });
  assert.deepEqual(updated.settings.audio, { enabled: false, volume: 0.2 });
  assert.deepEqual(updated.settings.captions, { enabled: true, durationMs: 4000, large: true });
  assert.equal(updated.settings.characterId, 'sparkiee-original');

  // partial nested updates keep siblings
  const partial = pet.updateSettings({ audio: { volume: 0.9 } });
  assert.deepEqual(partial.settings.audio, { enabled: false, volume: 0.9 });

  assert.throws(() => pet.updateSettings({ audio: { volume: 2 } }), /audio.volume/);
  assert.throws(() => pet.updateSettings({ audio: { enabled: 'yes' } }), /audio.enabled/);
  assert.throws(() => pet.updateSettings({ audio: { loud: true } }), /audio.loud/);
  assert.throws(() => pet.updateSettings({ captions: { durationMs: 100 } }), /captions.durationMs/);
  assert.throws(() => pet.updateSettings({ captions: { large: 'y' } }), /captions.large/);
  assert.throws(() => pet.updateSettings({ characterId: '../etc' }), /characterId/);
  assert.throws(() => pet.updateSettings({ characterId: 42 }), /characterId/);
  pet.updateSettings({ characterId: null });
  assert.equal(pet.snapshot().settings.characterId, null);
});

test('explicit voice triggers stamp a fresh voice event without changing animation', () => {
  let time = 5000;
  const pet = createPetController({ clock: () => time });
  pet.command('dance');
  time += 500;
  const snap = pet.triggerVoice('greet');
  assert.equal(snap.animation, 'dance', 'animation untouched');
  assert.deepEqual(snap.voice, { event: 'greet', at: new Date(5500).toISOString() });
  assert.throws(() => pet.triggerVoice('Bad Event!'), /valid event id/);
});

test('settings payload validation accepts partial updates and rejects unknown keys', () => {
  assert.equal(isValidPetSettingsPayload({ moveSpeed: 1.5 }), true);
  assert.equal(isValidPetSettingsPayload({ autoRoam: false }), true);
  assert.equal(isValidPetSettingsPayload({ moveSpeed: 2, autoRoam: true }), true);
  assert.equal(isValidPetSettingsPayload({}), false);
  assert.equal(isValidPetSettingsPayload({ speed: 2 }), false);
  assert.equal(isValidPetSettingsPayload({ moveSpeed: 0.1 }), false);
  assert.equal(isValidPetSettingsPayload({ moveSpeed: 4 }), false);
  assert.equal(isValidPetSettingsPayload({ autoRoam: 0 }), false);
  assert.equal(isValidPetSettingsPayload(null), false);
  assert.equal(isValidPetSettingsPayload([1]), false);
});

test('settings payload validation accepts nested audio, captions, and character ids', () => {
  assert.equal(isValidPetSettingsPayload({ audio: { enabled: false, volume: 0.5 } }), true);
  assert.equal(isValidPetSettingsPayload({ audio: { volume: 1 } }), true);
  assert.equal(isValidPetSettingsPayload({ audio: {} }), false);
  assert.equal(isValidPetSettingsPayload({ audio: { volume: -0.1 } }), false);
  assert.equal(isValidPetSettingsPayload({ audio: { bogus: 1 } }), false);
  assert.equal(isValidPetSettingsPayload({ captions: { enabled: false, durationMs: 9000, large: true } }), true);
  assert.equal(isValidPetSettingsPayload({ captions: { durationMs: 799 } }), false);
  assert.equal(isValidPetSettingsPayload({ captions: { durationMs: 15_001 } }), false);
  assert.equal(isValidPetSettingsPayload({ characterId: 'my-pack-2' }), true);
  assert.equal(isValidPetSettingsPayload({ characterId: null }), true);
  assert.equal(isValidPetSettingsPayload({ characterId: 'Bad ID' }), false);
  assert.equal(isValidPetSettingsPayload({ moveSpeed: 1, audio: { enabled: true }, captions: { large: true }, characterId: null, autoRoam: false }), true);
});

test('every animation command is accepted with a label, message, and animation', () => {
  const pet = createPetController();
  const animationCommands = PET_COMMANDS.filter((command) => !['hide', 'show', 'wake'].includes(command));
  assert.ok(animationCommands.length >= 13, 'all expressive commands present');
  for (const command of animationCommands) {
    const state = pet.command(command);
    assert.equal(state.animation, command, `${command} maps to its animation`);
    assert.ok(state.label && state.label.length > 0, `${command} has a label`);
    assert.ok(state.message && state.message.length > 0, `${command} has a message`);
  }
  assert.equal(pet.snapshot().voice, null, 'voice stays null until triggered');
});

test('hide and show toggle visibility while preserving the animation state', () => {
  const pet = createPetController();
  pet.command('dance');
  assert.equal(pet.command('hide').visible, false);
  const shown = pet.command('show');
  assert.equal(shown.visible, true);
  assert.equal(shown.animation, 'dance');
});

test('command voice map pairs each reaction with a declared event and stays silent for quiet states', () => {
  for (const [command, event] of Object.entries(COMMAND_VOICE_EVENTS)) {
    assert.ok(PET_COMMANDS.includes(command), `${command} is a real command`);
    assert.match(event, /^[a-z][a-z0-9_]{1,32}$/, `${event} is a valid event id`);
  }
  for (const quiet of ['walk', 'sleep', 'hide']) {
    assert.equal(COMMAND_VOICE_EVENTS[quiet], undefined, `${quiet} stays silent`);
  }
  assert.equal(COMMAND_VOICE_EVENTS.task_complete, 'celebration');
  assert.equal(COMMAND_VOICE_EVENTS.task_error, 'error');
  assert.equal(COMMAND_VOICE_EVENTS.permission_required, 'attention');
});

test('dock posture naps on the chatbox without hiding or losing the task state', () => {
  let time = 1000;
  const pet = createPetController({ clock: () => time });
  assert.equal(pet.snapshot().docked, false, 'starts on the desktop');
  const docked = pet.setDocked(true);
  assert.equal(docked.docked, true);
  assert.equal(docked.animation, 'sleep');
  assert.equal(docked.visible, true, 'docking never hides the pet');
  assert.match(docked.label, /chatbox/i);
  const awake = pet.wake();
  assert.equal(awake.docked, true, 'waking keeps the pinned spot');
  assert.equal(awake.animation, 'idle');
  assert.equal(pet.command('sleep').animation, 'sleep');
  const undocked = pet.setDocked(false);
  assert.equal(undocked.docked, false);
  assert.equal(undocked.animation, 'idle');
  assert.throws(() => pet.setDocked('yes'), { code: 'INVALID_DOCK_STATE' });
  assert.equal(isValidDockPayload({ docked: true }), true);
  assert.equal(isValidDockPayload({ docked: false }), true);
  assert.equal(isValidDockPayload({ docked: 'true' }), false);
  assert.equal(isValidDockPayload({ docked: true, x: 1 }), false);
});

test('agent events track a real task timer and only confirmed completion celebrates', () => {
  let time = 1_000;
  const pet = createPetController({ clock: () => time });
  const started = pet.agentEvent({ event: 'task_start', sessionId: 'ses_1' });
  assert.equal(started.task.active, true);
  assert.equal(started.task.sessionId, 'ses_1');
  assert.equal(started.animation, 'thinking');
  assert.match(started.message, /timer/i);
  time += 65_000;
  const done = pet.agentEvent({ event: 'task_complete', sessionId: 'ses_1' });
  assert.equal(done.task.active, false);
  assert.equal(done.task.outcome, 'success');
  assert.equal(done.task.durationMs, 65_000);
  assert.equal(done.animation, 'celebrate');
  assert.match(done.message, /1:05/);
  assert.equal(formatTaskDuration(65_000), '1:05');
  assert.equal(formatTaskDuration(3_723_000), '1:02:03');

  const idle = pet.agentEvent({ event: 'session_idle', sessionId: 'ses_1' });
  assert.equal(idle.task.outcome, 'success', 'idle never rewrites a confirmed outcome');
  assert.equal(idle.animation, 'celebrate');
  assert.throws(() => pet.agentEvent({ event: 'task_finished' }), { code: 'INVALID_AGENT_EVENT' });
});

test('quiet mode keeps the task timer honest while suppressing animations', () => {
  let time = 5_000;
  const pet = createPetController({ clock: () => time });
  pet.updateSettings({ quiet: true });
  const started = pet.agentEvent({ event: 'task_start' });
  assert.equal(started.task.active, true, 'the timer still runs');
  assert.equal(started.animation, 'idle', 'no reaction animation in quiet mode');
  assert.equal(started.label, 'Hanging out');
  time += 3_000;
  const failed = pet.agentEvent({ event: 'task_error' });
  assert.equal(failed.task.outcome, 'error');
  assert.equal(failed.task.durationMs, 3_000);
  assert.equal(failed.animation, 'idle');
  assert.equal(isValidPetSettingsPayload({ quiet: true }), true);
  assert.equal(isValidPetSettingsPayload({ quiet: 'yes' }), false);
});

test('an idle session stops a running timer without claiming success', () => {
  let time = 10_000;
  const pet = createPetController({ clock: () => time });
  pet.agentEvent({ event: 'task_start', sessionId: 'ses_x' });
  time += 4_500;
  const idle = pet.agentEvent({ event: 'session_idle', sessionId: 'ses_x' });
  assert.equal(idle.task.active, false);
  assert.equal(idle.task.outcome, 'idle', 'idle is not success');
  assert.equal(idle.task.durationMs, 4_500);
  assert.equal(idle.animation, 'thinking', 'no celebration for an idle session');
});
