import test from 'node:test';
import assert from 'node:assert/strict';
import { createPetController, isValidPetCommandPayload, PET_COMMANDS } from '../packages/core/src/pet-state.mjs';

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
