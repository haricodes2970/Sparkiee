/**
 * Electron-side host for the global push-to-talk shortcut.
 *
 * Kept Electron-free (a `globalShortcut` facade is injected) so the
 * registration lifecycle is testable: register after ready, report the real
 * outcome (never claim active when the desktop denied it), never register
 * twice, and unregister on dispose.
 */

export function createShortcutHost({
  globalShortcut,
  accelerator = 'Control+Alt+Space',
  enabled = true,
  onPress = () => {},
  onRegistration = () => {},
} = {}) {
  let active = false; // a listener is actually registered right now
  let disposed = false;

  function register(enabledNow, acceleratorNow) {
    if (active) {
      try { globalShortcut.unregister(accelerator); } catch { /* best effort */ }
      active = false;
    }
    if (!enabledNow) {
      onRegistration({ registered: false, detail: 'disabled' });
      return { registered: false, detail: 'disabled' };
    }
    let ok = false;
    try {
      ok = globalShortcut.register(acceleratorNow, () => {
        if (active) onPress();
      });
    } catch (error) {
      ok = false;
      const detail = `registration failed: ${error?.message ?? error}`;
      onRegistration({ registered: false, detail });
      return { registered: false, detail };
    }
    active = ok;
    if (ok) {
      onRegistration({ registered: true, detail: 'registered' });
      return { registered: true, detail: 'registered' };
    }
    const detail = 'registration conflict or denied by the desktop environment';
    onRegistration({ registered: false, detail });
    return { registered: false, detail };
  }

  return {
    /** Register the (enabled?) accelerator once. Idempotent. */
    start() {
      if (disposed) return { registered: false, detail: 'disposed' };
      if (active) return { registered: true, detail: 'registered' };
      return register(enabled, accelerator);
    },

    /** Apply changed settings: unregisters the old combo before re-registering. */
    update({ enabled: enabledNow = false, accelerator: acceleratorNow = accelerator } = {}) {
      if (disposed) return { registered: false, detail: 'disposed' };
      return register(enabledNow, acceleratorNow);
    },

    /** True while a listener is live on the desktop. */
    isActive() {
      return active && !disposed;
    },

    /** Unregister everything — called on before-quit and settings-off. */
    dispose() {
      if (active) {
        try { globalShortcut.unregister(accelerator); } catch { /* best effort */ }
      }
      active = false;
      disposed = true;
    },
  };
}
