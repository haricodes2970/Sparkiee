import test from 'node:test';
import assert from 'node:assert/strict';
import { createPetController, isValidPetCommandPayload, isValidPetSettingsPayload, PET_COMMANDS } from '../packages/core/src/pet-state.mjs';

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
  assert.deepEqual(pet.snapshot().settings, { moveSpeed: 1, autoRoam: true });
});

test('pet settings accept validated updates and reject out-of-range values', () => {
  const pet = createPetController();
  const updated = pet.updateSettings({ moveSpeed: 2.5, autoRoam: false });
  assert.deepEqual(updated.settings, { moveSpeed: 2.5, autoRoam: false });

  assert.throws(() => pet.updateSettings({ moveSpeed: 0 }), /moveSpeed must be a number/);
  assert.throws(() => pet.updateSettings({ moveSpeed: 99 }), /moveSpeed must be a number/);
  assert.throws(() => pet.updateSettings({ moveSpeed: 'fast' }), /moveSpeed must be a number/);
  assert.throws(() => pet.updateSettings({ autoRoam: 'yes' }), /autoRoam must be a boolean/);
  assert.deepEqual(pet.snapshot().settings, { moveSpeed: 2.5, autoRoam: false });
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
