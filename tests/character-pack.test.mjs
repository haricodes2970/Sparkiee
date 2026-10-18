import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_ANIMATION_IDS,
  listCharacterPacks,
  loadCharacterPack,
  safeResolveAssetPath,
  validateCharacterPackManifest,
} from '../packages/core/src/character-pack.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function validManifest() {
  return {
    id: 'test-pack',
    name: 'Test Pack',
    version: '1.0.0',
    description: 'A test pack.',
    license: { type: 'MIT' },
    spriteSheet: { file: 'sprites/sheet.png', frameWidth: 32, frameHeight: 32, columns: 8 },
    animations: Object.fromEntries(SUPPORTED_ANIMATION_IDS.map((id) => [id, { frames: [0, 1], frameMs: 120, loop: true }])),
    voice: {
      style: 'synth',
      events: {
        greet: { caption: 'Hi!', baseFrequency: 600, endFrequency: 900, durationMs: 200, waveform: 'triangle', chirps: 2, cooldownMs: 1000 },
      },
    },
    layout: { windowWidth: 220, windowHeight: 300, spriteScale: 4, captionDurationMs: 2500, captionMaxLines: 2 },
  };
}

test('a complete manifest passes validation', () => {
  assert.deepEqual(validateCharacterPackManifest(validManifest()), []);
});

test('the bundled starter pack is valid', async () => {
  const result = await loadCharacterPack(path.join(REPO_ROOT, 'assets/characters/sparkiee-original'));
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.equal(result.pack.id, 'sparkiee-original');
  assert.ok(result.pack.spriteSheetPath.endsWith('sheet.png'));
});

test('manifest validation rejects malformed packs with actionable errors', () => {
  const bad = validManifest();
  bad.id = 'Bad ID!';
  bad.version = 'v1';
  bad.spriteSheet.file = '../escape.png';
  bad.animations.walk.frameMs = 5;
  bad.animations.walk.frames = [];
  delete bad.animations.sleep;
  bad.voice.events['bad event'] = null;
  const errors = validateCharacterPackManifest(bad);
  assert.ok(errors.some((e) => e.includes('id must match')));
  assert.ok(errors.some((e) => e.includes('version')));
  assert.ok(errors.some((e) => e.includes('spriteSheet.file')));
  assert.ok(errors.some((e) => e.includes('animations.walk.frameMs')));
  assert.ok(errors.some((e) => e.includes('animations.walk.frames')));
  assert.ok(errors.some((e) => e.includes('animations.sleep is required')));
  assert.ok(validateCharacterPackManifest(null).length > 0);
  assert.ok(validateCharacterPackManifest('nope').length > 0);
});

test('clip-style voice requires supported audio extensions', () => {
  const manifest = validManifest();
  manifest.voice = { style: 'clips', events: { greet: 'sounds/greet.wav', bad: 'sounds/run.exe' } };
  const errors = validateCharacterPackManifest(manifest);
  assert.ok(errors.some((e) => e.includes('supported audio format')));
  manifest.voice.events.bad = '../outside.wav';
  assert.ok(validateCharacterPackManifest(manifest).some((e) => e.includes('safe pack-relative path') || e.includes('relative audio path')));
});

test('safeResolveAssetPath blocks every escape attempt', () => {
  const root = '/pack/dir';
  for (const attempt of ['../secret', '../../etc/passwd', '/etc/passwd', 'a/../../b', '..', 'sprites/../../../x', 'a\\b', '']) {
    const result = safeResolveAssetPath(root, attempt);
    assert.equal(result.ok, false, `"${attempt}" must be rejected`);
  }
  assert.deepEqual(safeResolveAssetPath(root, 'sprites/sheet.png'), { ok: true, path: path.resolve(root, 'sprites/sheet.png') });
  assert.equal(safeResolveAssetPath('', 'x.png').ok, false);
});

test('loadCharacterPack reports missing manifests and sprite files', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-pack-'));
  try {
    const missing = await loadCharacterPack(path.join(scratch, 'nothing'));
    assert.equal(missing.ok, false);
    assert.match(missing.errors[0], /cannot read manifest/);

    const emptyPack = path.join(scratch, 'empty');
    await mkdir(emptyPack, { recursive: true });
    await writeFile(path.join(emptyPack, 'manifest.json'), '{ not json');
    const broken = await loadCharacterPack(emptyPack);
    assert.equal(broken.ok, false);
    assert.match(broken.errors[0], /not valid JSON/);

    await writeFile(path.join(emptyPack, 'manifest.json'), JSON.stringify(validManifest()));
    const noSheet = await loadCharacterPack(emptyPack);
    assert.equal(noSheet.ok, false);
    assert.match(noSheet.errors[0], /sprite sheet missing/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('listCharacterPacks discovers valid packs and reports invalid ones', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-packs-'));
  try {
    const good = path.join(scratch, 'good');
    await mkdir(path.join(good, 'sprites'), { recursive: true });
    await writeFile(path.join(good, 'manifest.json'), JSON.stringify(validManifest()));
    await writeFile(path.join(good, 'sprites', 'sheet.png'), Buffer.from([1, 2, 3]));
    const bad = path.join(scratch, 'bad');
    await mkdir(bad, { recursive: true });
    await writeFile(path.join(bad, 'manifest.json'), JSON.stringify({ id: 'x' }));

    const { packs, invalid } = await listCharacterPacks([scratch, path.join(scratch, 'missing-root')]);
    assert.equal(packs.length, 1);
    assert.equal(packs[0].id, 'test-pack');
    assert.equal(invalid.length, 1);
    assert.ok(invalid[0].errors.length > 0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
