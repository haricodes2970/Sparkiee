/**
 * Voice hotkey plumbing: the global push-to-talk accelerator, its protected
 * persisted settings, and the pure press→action decision the Electron host
 * consults before talking to the daemon.
 *
 * Safety choices:
 * - The accelerator is an allowlist, not a free-form string: a saved hotkey
 *   can never commandeer arbitrary desktop key combos.
 * - Settings live in the same 0600 user config directory as the ElevenLabs
 *   voice config (`$XDG_CONFIG_HOME/sparkiee/assistant.json`).
 * - The decision logic is pure so conflicting presses (mic busy, another
 *   capture in flight) resolve deterministically without a second daemon
 *   round trip.
 */

import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveVoiceConfigDir } from './voice-config.mjs';

export const DEFAULT_SHORTCUT_ACCELERATOR = 'Control+Alt+Space';
/** Electron globalShortcut accelerator allowlist for push-to-talk. */
export const ALLOWED_ACCELERATORS = Object.freeze([DEFAULT_SHORTCUT_ACCELERATOR]);
export const HOTKEY_SETTINGS_VERSION = 1;

const DEFAULTS = Object.freeze({
  version: HOTKEY_SETTINGS_VERSION,
  shortcut: { enabled: true, accelerator: DEFAULT_SHORTCUT_ACCELERATOR },
});

export function assistantSettingsPath({ env = process.env } = {}) {
  return join(resolveVoiceConfigDir(env), 'assistant.json');
}

export function normalizeAccelerator(accelerator) {
  if (typeof accelerator !== 'string') return '';
  return accelerator
    .split('+')
    .map((part) => part.trim().replace('ctrl', 'Control').replace('ctrl+', 'Control+'))
    .map((part) => (part.toLowerCase() === 'control' ? 'Control'
      : part.toLowerCase() === 'alt' ? 'Alt'
      : part.toLowerCase() === 'space' ? 'Space'
      : part))
    .filter(Boolean)
    .join('+');
}

export function isValidAccelerator(accelerator) {
  return ALLOWED_ACCELERATORS.includes(normalizeAccelerator(accelerator));
}

export async function readAssistantSettings({ env = process.env } = {}) {
  const file = assistantSettingsPath({ env });
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const shortcut = parsed?.shortcut ?? {};
    return {
      version: HOTKEY_SETTINGS_VERSION,
      shortcut: {
        enabled: shortcut.enabled !== false, // present + not-explicitly-false
        accelerator: isValidAccelerator(shortcut.accelerator)
          ? normalizeAccelerator(shortcut.accelerator)
          : DEFAULT_SHORTCUT_ACCELERATOR,
      },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

/** Merge partial settings; throws INVALID_ACCELERATOR on non-allowlisted keys. */
export async function writeAssistantSettings({ env = process.env } = {}, partial = {}) {
  const current = await readAssistantSettings({ env });
  const next = structuredClone(current);
  if (partial.shortcut && typeof partial.shortcut === 'object') {
    const { enabled, accelerator } = partial.shortcut;
    if (typeof enabled === 'boolean') next.shortcut.enabled = enabled;
    if (accelerator !== undefined) {
      const normalized = normalizeAccelerator(accelerator);
      if (!isValidAccelerator(normalized)) {
        throw Object.assign(new Error(
          `INVALID_ACCELERATOR: unsupported shortcut "${String(accelerator)}". Allowed for now: ${ALLOWED_ACCELERATORS.join(', ')}.`,
        ), { code: 'INVALID_ACCELERATOR' });
      }
      next.shortcut.accelerator = normalized;
    }
  }
  const file = assistantSettingsPath({ env });
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return next;
}

/**
 * Read-write hub shared by the daemon (status + settings endpoints) and the
 * Electron pet host (shortcut registration reporting). `registered` stays
 * `null` until the desktop host reports a real outcome — the dashboard never
 * gets a fabricated "active" state.
 */
export function createHotkeyState({
  envGet = () => process.env,
  read = readAssistantSettings,
  write = writeAssistantSettings,
} = {}) {
  let settings = { shortcut: { enabled: true, accelerator: DEFAULT_SHORTCUT_ACCELERATOR } };
  let registration = { registered: null, detail: null, since: null };

  (async () => {
    try {
      settings = await read({ env: envGet() });
    } catch {
      // defaults stand when the file is missing/corrupt
    }
  })();

  return {
    snapshot() {
      const { enabled, accelerator } = settings.shortcut;
      return {
        shortcut: {
          enabled,
          accelerator,
          registered: registration.registered,
          registrationDetail: registration.detail,
        },
      };
    },

    /** Merge new user settings and persist them. Returns the snapshot. */
    async save(partial) {
      settings = await write({ env: envGet() }, partial);
      return this.snapshot();
    },

    /** The pet host is the only writer of actual registration outcomes. */
    setRegistration({ registered, detail = null } = {}) {
      registration = {
        registered: Boolean(registered),
        detail: typeof detail === 'string' ? detail : null,
        since: new Date().toISOString(),
      };
      return this.snapshot();
    },

    registration() {
      return { ...registration };
    },
  };
}

/**
 * Pure decision for a hotkey press against the assistant snapshot.
 * 'start' begins capture, 'stop' stops-and-submits, 'busy' leaves the
 * recogniser/speaker stages untouched, null = unhandled (nothing running).
 */
export function hotkeyAction(snapshot = {}) {
  const { state = 'disabled', micActive = false } = snapshot ?? {};
  if (state === 'transcribing' || state === 'interpreting' || state === 'executing'
    || state === 'speaking' || state === 'awaiting_confirmation') return 'busy';
  if (state === 'listening' || micActive) return 'stop';
  if (state === 'disabled' || state === 'armed' || state === 'error') return 'start';
  return 'start';
}
