import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir, } from 'node:os';
import path from 'node:path';
import {
  hotkeyAction,
  createHotkeyState,
  DEFAULT_SHORTCUT_ACCELERATOR,
  isValidAccelerator,
  normalizeAccelerator,
  readAssistantSettings,
  writeAssistantSettings,
  assistantSettingsPath,
} from '../packages/core/src/voice-hotkey.mjs';

// ---------------------------------------------------------------------------
// Pure hotkey decision logic.
// ---------------------------------------------------------------------------

test('hotkeyAction: idle assistant → start PTT', () => {
  assert.equal(hotkeyAction({ state: 'disabled', micActive: false }), 'start');
  assert.equal(hotkeyAction({ state: 'armed', micActive: false }), 'start');
});

test('hotkeyAction: active capture → stop-and-submit', () => {
  assert.equal(hotkeyAction({ state: 'listening', micActive: true }), 'stop');
});

test('hotkeyAction: nothing to do while transcribing/speaking busy states', () => {
  assert.equal(hotkeyAction({ state: 'transcribing', micActive: true }), 'busy');
  assert.equal(hotkeyAction({ state: 'speaking', micActive: false }), 'busy');
});

// ---------------------------------------------------------------------------
// Accelerator normalization/validation — allowlist, never arbitrary keys.
// ---------------------------------------------------------------------------

test('accelerator: default is Control+Alt+Space', () => {
  assert.equal(DEFAULT_SHORTCUT_ACCELERATOR, 'Control+Alt+Space');
  assert.equal(normalizeAccelerator('control + alt + space'), 'Control+Alt+Space');
});

test('accelerator: allowlist rejects other combos', () => {
  assert.equal(isValidAccelerator('Control+Alt+Space'), true);
  assert.equal(isValidAccelerator('Control+Alt+Delete'), false);
  assert.equal(isValidAccelerator('CommandOrControl+Shift+P'), false);
  assert.equal(isValidAccelerator(''), false);
  assert.equal(isValidAccelerator(null), false);
});

// ---------------------------------------------------------------------------
// Protected settings file (0600) in the voice config dir.
// ---------------------------------------------------------------------------

function envFor(dir) {
  return { XDG_CONFIG_HOME: dir };
}

test('assistant settings: round-trips defaults and persists 0600', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sparkiee-hotkey-'));
  try {
    const env = envFor(dir);
    const settings = await readAssistantSettings({ env });
    assert.equal(settings.shortcut.enabled, true);
    assert.equal(settings.shortcut.accelerator, 'Control+Alt+Space');

    await writeAssistantSettings({ env }, { shortcut: { enabled: false } });
    const saved = await readAssistantSettings({ env });
    assert.equal(saved.shortcut.enabled, false);
    assert.equal(saved.shortcut.accelerator, 'Control+Alt+Space');

    const st = statSync(assistantSettingsPath({ env }));
    assert.equal(st.mode & 0o777, 0o600, 'settings file must be 0600');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('assistant settings: rejects writing a non-allowlisted accelerator', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sparkiee-hotkey-'));
  try {
    await assert.rejects(
      () => writeAssistantSettings({ env: envFor(dir) }, { shortcut: { accelerator: 'Control+Alt+Delete' } }),
      /INVALID_ACCELERATOR/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// createHotkeyState hub — server/daemon/pet-host share this state.
// ---------------------------------------------------------------------------

test('hotkey state hub: defaults, save via persisted settings, registration snapshot', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sparkiee-hotkey-'));
  try {
    const env = envFor(dir);
    // Register default resolvers so readAssistantSettings hits THIS dir.
    const hub = createHotkeyState({
      envGet: () => env, read: (o) => readAssistantSettings(o), write: (o, p) => writeAssistantSettings(o, p),
    });
    const s0 = hub.snapshot();
    assert.equal(s0.shortcut.enabled, true);
    assert.equal(s0.shortcut.accelerator, 'Control+Alt+Space');
    assert.equal(s0.shortcut.registered, null); // unset until Electron reports back

    hub.setRegistration({ registered: true, detail: 'globalShortcut registered at host start' });
    assert.equal(hub.snapshot().shortcut.registered, true);

    hub.setRegistration({ registered: false, detail: 'org.freedesktop.portal.GlobalShortcuts unavailable' });
    assert.equal(hub.snapshot().shortcut.registered, false);

    await hub.save({ shortcut: { enabled: false } });
    const s1 = hub.snapshot();
    assert.equal(s1.shortcut.enabled, false);
    assert.equal(s1.shortcut.accelerator, 'Control+Alt+Space');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
