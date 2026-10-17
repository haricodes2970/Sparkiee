import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveElectronBinary } from '../packages/core/src/electron-resolver.mjs';

async function makeElectronDir({ pathTxt, distBinary } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-electron-'));
  const electronDir = path.join(root, 'electron');
  await mkdir(electronDir, { recursive: true });
  if (pathTxt !== undefined) await writeFile(path.join(electronDir, 'path.txt'), pathTxt);
  if (distBinary !== undefined) {
    await mkdir(path.join(electronDir, 'dist'), { recursive: true });
    await writeFile(path.join(electronDir, 'dist', distBinary), '');
  }
  return { root, electronDir };
}

test('resolveElectronBinary fails fast with an actionable hint when electron is not installed', async () => {
  const result = resolveElectronBinary({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-installed');
  assert.match(result.hint, /npm install/);
  const { root, electronDir } = await makeElectronDir({});
  try {
    const missingTxt = resolveElectronBinary({ electronDir });
    assert.equal(missingTxt.ok, false);
    assert.equal(missingTxt.reason, 'not-installed');
    assert.match(missingTxt.hint, /npm install/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveElectronBinary reports binary-missing without downloading anything', async () => {
  const { root, electronDir } = await makeElectronDir({ pathTxt: 'electron\n' });
  try {
    const result = resolveElectronBinary({ electronDir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'binary-missing');
    assert.match(result.detail, /dist[\\/]electron/);
    assert.match(result.hint, /Delete node_modules\/electron/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveElectronBinary returns the binary path when the package is intact', async () => {
  const { root, electronDir } = await makeElectronDir({ pathTxt: 'electron', distBinary: 'electron' });
  try {
    const result = resolveElectronBinary({ electronDir });
    assert.equal(result.ok, true);
    assert.equal(result.binary, path.join(electronDir, 'dist', 'electron'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveElectronBinary honours ELECTRON_OVERRIDE_DIST_PATH without masking errors', async () => {
  const { root, electronDir } = await makeElectronDir({ pathTxt: 'electron', distBinary: 'electron' });
  const override = path.join(root, 'override');
  try {
    await mkdir(override, { recursive: true });
    await writeFile(path.join(override, 'electron'), '');
    const ok = resolveElectronBinary({ electronDir, overrideDistPath: override });
    assert.equal(ok.ok, true);
    assert.equal(ok.binary, path.join(override, 'electron'));

    const bad = resolveElectronBinary({ electronDir, overrideDistPath: path.join(root, 'nope') });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'binary-missing');
    assert.match(bad.hint, /ELECTRON_OVERRIDE_DIST_PATH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
