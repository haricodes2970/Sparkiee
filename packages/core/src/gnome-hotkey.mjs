/**
 * GNOME media-keys fallback for the push-to-talk accelerator.
 *
 * Electron's globalShortcut runs over XWayland: on GNOME Wayland the grab
 * only wins keys while an X-capable window holds input focus, so pressing
 * Ctrl+Alt+Space with a Wayland-native app focused silently does nothing.
 * GNOME's own custom keybinding (media-keys daemon) fires everywhere; it
 * runs a command this app provides instead of an Electron grab.
 *
 * Honesty rules:
 * - Nothing is installed automatically. The CLI command runs it explicitly.
 * - The installer only reads/writes the gnome-settings-daemon media-keys
 *   custom-keybindings entries named after this app path; all other
 *   user keybindings pass through untouched.
 * - Every read returns what the desktop actually has; failures surface.
 */

import { execFile } from 'node:child_process';

const SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const LIST_KEY = 'custom-keybindings';
const ENTRY_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';
const OUR_REL_PATH = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/sparkiee-pet/';
/** Full path under which our name/binding/command live. */
const SCHEMA_PATH = `${ENTRY_SCHEMA}:${OUR_REL_PATH}`;

/** Test-only surface for the exact paths we own. */
export const GNOME_HOTKEY_PATH = OUR_REL_PATH;
export const GNOME_HOTKEY_SCHEMA_PATH = SCHEMA_PATH;

/** Electron accelerator → GNOME media-keys accelerator notation. */
export function toGnomeBinding(accelerator = 'Control+Alt+Space') {
  return String(accelerator)
    .split('+')
    .map((part) => {
      const lower = part.trim().toLowerCase();
      if (lower === 'control' || lower === 'commandorcontrol') return '<Control>';
      if (lower === 'alt') return '<Alt>';
      if (lower === 'shift') return '<Shift>';
      if (lower === 'super' || lower === 'meta') return '<Super>';
      return part.trim().toLowerCase();
    })
    .join('');
}

/** Parse a gsettings array value (e.g. `@as []` or `[ '/a/', '/b/' ]`). */
export function parseGsettingsArray(raw) {
  if (typeof raw !== 'string') return [];
  const text = raw.replace(/^@as\s*/, '').trim();
  if (!text || text === '[]') return [];
  try {
    const parsed = JSON.parse(text.replace(/'/g, '"'));
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

export async function createGnomeHotkeyInstaller({
  env = process.env,
  run = (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  }),
} = {}) {
  const gsettings = env.GSETTINGS_EXECUTABLE || 'gsettings';

  async function listPaths() {
    const raw = await run(gsettings, ['get', SCHEMA, LIST_KEY]);
    return parseGsettingsArray(raw);
  }

  async function ourEntry() {
    const keys = { name: null, binding: null, command: null };
    for (const key of Object.keys(keys)) {
      try {
        const raw = await run(gsettings, ['get', SCHEMA_PATH, key]);
        keys[key] = typeof raw === 'string' ? raw.trim().replace(/^'/, '').replace(/'$/, '') : null;
      } catch {
        keys[key] = null;
      }
    }
    const registered = keys.name === 'Sparkiee' && Boolean(keys.command);
    return {
      registered,
      ...keys,
      binding: keys.binding, // stored value is already GNOME notation
      path: OUR_REL_PATH,
    };
  }

  return {
    /** What the desktop holds for this app right now (read-only). */
    status: async () => {
      let paths = [];
      try { paths = await listPaths(); } catch { /* schema missing; report below */ }
      const entry = await ourEntry();
      return {
        available: paths.length > 0 || entry.registered,
        installed: entry.registered && paths.includes(OUR_REL_PATH),
        binding: entry.binding,
        command: entry.command,
        path: OUR_REL_PATH,
      };
    },

    /** Register (or overwrite) our keybinding; never touches other entries. */
    install: async ({ binding, command, name = 'Sparkiee' }) => {
      if (!binding) throw Object.assign(new Error('A binding string is required.'), { code: 'INVALID_INSTALL' });
      const gnomeBinding = toGnomeBinding(binding);
      const paths = await listPaths();
      if (!paths.includes(OUR_REL_PATH)) {
        const next = [...paths, OUR_REL_PATH];
        await run(gsettings, ['set', SCHEMA, LIST_KEY, JSON.stringify(next)]);
      }
      await run(gsettings, ['set', SCHEMA_PATH, 'name', name]);
      await run(gsettings, ['set', SCHEMA_PATH, 'binding', gnomeBinding]);
      await run(gsettings, ['set', SCHEMA_PATH, 'command', command]);
      return { installed: true, binding: gnomeBinding, command, path: OUR_REL_PATH };
    },

    /** Remove our entry and shrink the list; other user bindings survive. */
    remove: async () => {
      const paths = (await listPaths()).filter((entry) => entry !== OUR_REL_PATH);
      await run(gsettings, ['set', SCHEMA, LIST_KEY, JSON.stringify(paths)]);
      return { installed: false, paths, path: OUR_REL_PATH };
    },
  };
}
