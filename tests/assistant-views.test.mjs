import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMicIndicator } from '../packages/pet-host/renderer/lib/mic-indicator.mjs';
import { assistantPanelViewModel } from '../packages/dashboard/src/lib/assistant-panel.mjs';

// ---------------------------------------------------------------------------
// Pet-side compact mic indicator: a level/state bubble, never a second pet.
// ---------------------------------------------------------------------------

test('mic indicator: hidden when no assistant data or mic inactive in idle states', () => {
  assert.deepEqual(describeMicIndicator({ assistant: null }), { visible: false, label: '', phase: '' });
  assert.deepEqual(describeMicIndicator({}), { visible: false, label: '', phase: '' });
  assert.deepEqual(
    describeMicIndicator({ assistant: { state: 'disabled', micActive: false } }),
    { visible: false, label: '', phase: '' },
  );
  assert.deepEqual(
    describeMicIndicator({ assistant: { state: 'armed', micActive: false } }),
    { visible: false, label: '', phase: '' },
  );
});

test('mic indicator: visible during live mic/stt/speech states with phase label', () => {
  assert.deepEqual(
    describeMicIndicator({ assistant: { state: 'listening', micActive: true } }),
    { visible: true, label: 'Listening', phase: 'listening' },
  );
  assert.deepEqual(
    describeMicIndicator({ assistant: { state: 'transcribing', micActive: false } }),
    { visible: true, label: 'Transcribing', phase: 'transcribing' },
  );
  assert.deepEqual(
    describeMicIndicator({ assistant: { state: 'executing', micActive: false } }),
    { visible: true, label: 'Working', phase: 'working' },
  );
  assert.deepEqual(
    describeMicIndicator({ assistant: { state: 'speaking', micActive: false } }),
    { visible: true, label: 'Speaking', phase: 'speaking' },
  );
  assert.deepEqual(
    describeMicIndicator({ assistant: { state: 'error', micActive: false, lastError: 'mic lost' } }),
    { visible: true, label: 'Mic error', phase: 'error' },
  );
});

test('mic indicator: label is bounded and single-line safe', () => {
  const out = describeMicIndicator({ assistant: { state: 'listening', micActive: true } });
  assert.ok(out.label.length <= 20);
  assert.ok(!out.label.includes('\n'));
});

// ---------------------------------------------------------------------------
// Dashboard assistant panel: honest view-model from the status payload.
// ---------------------------------------------------------------------------

const BASE = {
  assistant: {
    state: 'disabled',
    micActive: false,
    listening: false,
    cancellable: false,
    wake: { status: 'needs-setup', missing: ['node-module'], detail: 'Missing' },
    mic: { devices: [], active: null },
    shortcut: { enabled: false, accelerator: 'Control+Alt+Space', registered: null, registrationDetail: null },
    lastAction: null,
    lastError: null,
  },
  stt: { provider: 'faster-whisper', status: 'needs-setup', missing: ['stt-venv', 'model'], model: 'tiny.en', detail: 'Run setup.' },
};

test('assistant panel: idle + everything needs setup → every row honest', () => {
  const vm = assistantPanelViewModel(BASE);
  assert.equal(vm.stateLabel, 'Idle');
  assert.equal(vm.hotkeyLabel, 'Off (Ctrl + Alt + Space)');
  assert.match(vm.wakeLabel, /needs setup/i);
  assert.match(vm.sttLabel, /needs setup/i);
  assert.equal(vm.transcript, '');
  assert.equal(vm.busy, false);
  assert.equal(vm.startEnabled, true);
  assert.equal(vm.stopEnabled, false);
  assert.equal(vm.cancelEnabled, false);
});

test('assistant panel: live capture shows transcript capacity and stop/cancel controls', () => {
  const vm = assistantPanelViewModel({
    assistant: {
      ...BASE.assistant,
      state: 'listening',
      micActive: true,
      listening: true,
      cancellable: true,
      shortcut: { enabled: true, accelerator: 'Control+Alt+Space', registered: true, registrationDetail: 'registered' },
      mic: { devices: ['alsa_input.x'], active: { id: 'mic-1', elapsedMs: 3200, label: 'ptt' } },
    },
    stt: BASE.stt,
    transcript: 'play madira',
  });
  assert.equal(vm.stateLabel, 'Listening');
  assert.match(vm.hotkeyLabel, /On — registered/i);
  assert.match(vm.hotkeyLabel, /Ctrl \+ Alt \+ Space/);
  assert.equal(vm.busy, true);
  assert.equal(vm.stopEnabled, true);
  assert.equal(vm.cancelEnabled, true);
  assert.equal(vm.transcript, 'play madira');
  assert.match(vm.micLabel, /capturing|active/i);
});

test('assistant panel: last action renders transcript + executed truth, bounded len', () => {
  const vm = assistantPanelViewModel({
    ...BASE,
    assistant: {
      ...BASE.assistant,
      lastAction: { at: '2026-10-19T00:00:00Z', kind: 'ptt', transcript: 'play madira', intent: 'play_track', executed: true },
    },
  });
  assert.match(vm.lastActionLabel, /played|routed|executed/i);
  assert.ok(vm.lastActionLabel.includes('play madira'));
  assert.ok(vm.lastActionLabel.length <= 140);
});

test('assistant panel: registered:false never shows as active', () => {
  const vm = assistantPanelViewModel({
    ...BASE,
    assistant: {
      ...BASE.assistant,
      shortcut: { enabled: true, accelerator: 'Control+Alt+Space', registered: false, registrationDetail: 'org.freedesktop.portal denied' },
    },
  });
  assert.match(vm.hotkeyLabel, /denied/i);
  assert.ok(!vm.hotkeyLabel.startsWith('On — registered'));
});
