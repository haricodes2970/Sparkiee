import test from 'node:test';
import assert from 'node:assert/strict';
import { createGnomeHotkeyInstaller, parseGsettingsArray, toGnomeBinding, GNOME_HOTKEY_PATH, GNOME_HOTKEY_SCHEMA_PATH as SCHEMA_PATH } from '../packages/core/src/gnome-hotkey.mjs';
import { DEFAULT_SHORTCUT_ACCELERATOR } from '../packages/core/src/voice-hotkey.mjs';

const SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybindings';

/** Fake gsettings: remembers values; `get` answers from the store. */
function fakeRun(store) {
  const seen = [];
  const run = async (file, args) => {
    seen.push(args.slice());
    const [verb, schema, key, ...valueParts] = args;
    if (verb !== 'get' && verb !== 'set') throw new Error(`unexpected ${verb}`);
    const fullKey = `${schema}:${key}`;
    if (verb === 'get') {
      const value = store.get(fullKey);
      if (value === undefined) {
        // gsettings answers `@as []` for an untouched list key; it errors only
        // on keys that do not exist in the schema at all.
        if (key === 'custom-keybindings') return '@as []';
        throw new Error(`no value for ${fullKey}`);
      }
      return value;
    }
    store.set(fullKey, valueParts.join(' '));
    return '';
  };
  return { seen, run: (file, args) => run(file, args) };
}

test('parseGsettingsArray handles empty, annotated, and filled values', () => {
  assert.deepEqual(parseGsettingsArray('@as []'), []);
  assert.deepEqual(parseGsettingsArray('[]'), []);
  assert.deepEqual(parseGsettingsArray("[ '/a/', '/b/' ]"), ['/a/', '/b/']);
  assert.deepEqual(parseGsettingsArray(''), []);
});

test('toGnomeBinding converts every supported accelerator element', () => {
  assert.equal(toGnomeBinding('Control+Alt+Space'), '<Control><Alt>space');
  assert.equal(toGnomeBinding('CommandOrControl+Alt+Space'), '<Control><Alt>space');
  assert.equal(toGnomeBinding('Shift+Super+F5'), '<Shift><Super>f5');
});

test('install merges our path once, sets name/binding/command, leaves others', async () => {
  const store = new Map([
    [`org.gnome.settings-daemon.plugins.media-keys:custom-keybindings`, "[ '/org/other/user/' ]"],
  ]);
  const fake = fakeRun(store);
  const installer = await createGnomeHotkeyInstaller({ run: fake.run });
  const result = await installer.install({ binding: DEFAULT_SHORTCUT_ACCELERATOR, command: 'node sparkiee ptt toggle' });
  assert.equal(result.installed, true);
  assert.equal(result.binding, '<Control><Alt>space');
  const list = parseGsettingsArray(store.get('org.gnome.settings-daemon.plugins.media-keys:custom-keybindings'));
  assert.deepEqual(list, ['/org/other/user/', GNOME_HOTKEY_PATH]);
  assert.equal(store.get(`${SCHEMA_PATH}:binding`), '<Control><Alt>space');
  assert.equal(store.get(`${SCHEMA_PATH}:command`), 'node sparkiee ptt toggle');
  assert.equal(store.get(`${SCHEMA_PATH}:name`), 'Sparkiee');
});

test('install over an existing entry does not duplicate the path', async () => {
  const store = new Map();
  const fake = fakeRun(store);
  const installer = await createGnomeHotkeyInstaller({ run: fake.run });
  await installer.install({ binding: 'Control+Alt+Space', command: 'x' });
  await installer.install({ binding: 'Control+Alt+Space', command: 'y' });
  const list = parseGsettingsArray(store.get('org.gnome.settings-daemon.plugins.media-keys:custom-keybindings'));
  assert.equal(list.length, 1);
});

test('status reports installed state honestly', async () => {
  const store = new Map();
  const fake = fakeRun(store);
  const installer = await createGnomeHotkeyInstaller({ run: fake.run });
  const before = await installer.status();
  assert.equal(before.installed, false);
  await installer.install({ binding: 'Control+Alt+Space', command: 'x' });
  const after = await installer.status();
  assert.equal(after.installed, true);
  assert.equal(after.binding, '<Control><Alt>space');
  // The per-entry keys use the singular relocatable schema id.
  assert.equal(store.get(SCHEMA_PATH + ':binding'), '<Control><Alt>space');
});

test('remove drops only our entry', async () => {
  const store = new Map();
  const fake = fakeRun(store);
  const installer = await createGnomeHotkeyInstaller({ run: fake.run });
  await installer.install({ binding: 'Control+Alt+Space', command: 'x' });
  const result = await installer.remove();
  assert.equal(result.installed, false);
  const list = parseGsettingsArray(store.get('org.gnome.settings-daemon.plugins.media-keys:custom-keybindings'));
  assert.deepEqual(list, []);
});
