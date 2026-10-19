import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutHost } from '../packages/pet-host/src/shortcut-host.mjs';

function fakeGlobalShortcut() {
  const registered = new Map();
  let calls = 0;
  return {
    registered: () => registered,
    registrationCalls: () => calls,
    register(acc, cb) {
      calls += 1;
      registered.set(acc, cb);
      return true;
    },
    isRegistered(acc) { return registered.has(acc); },
    unregister(acc) { registered.delete(acc); },
  };
}

test('shortcut host: registers once after setup, reports success', async () => {
  const electron = fakeGlobalShortcut();
  const reports = [];
  const host = createShortcutHost({
    globalShortcut: electron,
    accelerator: 'Control+Alt+Space',
    enabled: true,
    onRegistration: (r) => reports.push(r),
  });
  const out = await host.start();
  assert.equal(out.registered, true);
  assert.equal(out.detail, 'registered');
  assert.equal(electron.registrationCalls(), 1);
  assert.equal(reports[0].registered, true);
});

test('shortcut host: disabled → does not register, honest not-requested state', async () => {
  const electron = fakeGlobalShortcut();
  const host = createShortcutHost({
    globalShortcut: electron,
    accelerator: 'Control+Alt+Space',
    enabled: false,
    onRegistration: () => {},
  });
  const out = await host.start();
  assert.equal(out.registered, false);
  assert.equal(out.detail, 'disabled');
  assert.equal(electron.registrationCalls(), 0);
});

test('shortcut host: registration conflict → honest false + detail', async () => {
  const electron = fakeGlobalShortcut();
  electron.register = () => false; // e.g. GNOME/portal denied
  const reports = [];
  const host = createShortcutHost({
    globalShortcut: electron,
    accelerator: 'Control+Alt+Space',
    enabled: true,
    onRegistration: (r) => reports.push(r),
  });
  const out = await host.start();
  assert.equal(out.registered, false);
  assert.match(out.detail, /conflict|denied/i);
  assert.equal(reports[0].registered, false);
});

test('shortcut host: repeated start never double-registers', async () => {
  const electron = fakeGlobalShortcut();
  const host = createShortcutHost({
    globalShortcut: electron,
    accelerator: 'Control+Alt+Space',
    enabled: true,
    onRegistration: () => {},
  });
  await host.start();
  await host.start();
  assert.equal(electron.registrationCalls(), 1);
});

test('shortcut host: settings change → unregister old, register new accelerator', async () => {
  const electron = fakeGlobalShortcut();
  const host = createShortcutHost({
    globalShortcut: electron,
    accelerator: 'Control+Alt+Space',
    enabled: true,
    onRegistration: () => {},
  });
  await host.start();
  await host.update({ accelerator: 'Control+Alt+Space', enabled: false });
  assert.equal(electron.registered().size, 0); // unregistered when disabled

  await host.update({ accelerator: 'Control+Alt+Space', enabled: true });
  assert.equal(electron.registered().size, 1);
});

test('shortcut host: activate fires the press callback; dispose unregisters', async () => {
  const electron = fakeGlobalShortcut();
  let presses = 0;
  const host = createShortcutHost({
    globalShortcut: electron,
    accelerator: 'Control+Alt+Space',
    enabled: true,
    onPress: () => { presses += 1; },
    onRegistration: () => {},
  });
  await host.start();
  electron.registered().get('Control+Alt+Space')();
  assert.equal(presses, 1);

  await host.dispose();
  assert.equal(electron.registered().size, 0);
  // Pressing a stale registration must not fire after dispose.
  electron.registered().get('Control+Alt+Space')?.();
  assert.equal(presses, 1);
});
