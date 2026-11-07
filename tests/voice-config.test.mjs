import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SPEED,
  DEFAULT_VOICES,
  VOICE_CATALOG,
  deleteVoiceConfig,
  describeVoiceConfig,
  detectSpeechLanguage,
  loadVoiceConfig,
  mergeVoiceConfig,
  resolveTtsDataDir,
  resolveTtsVenvPython,
  resolveTtsVoiceModelPath,
  resolveVoiceCacheDir,
  resolveVoiceConfigPath,
  synthesisCacheKey,
  validateVoiceConfig,
  writeVoiceConfig,
} from '../packages/core/src/voice-config.mjs';

async function tempEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-voice-'));
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, '.config'),
    XDG_CACHE_HOME: path.join(root, '.cache'),
    XDG_DATA_HOME: path.join(root, '.local', 'share'),
  };
  return { root, env };
}

test('paths respect XDG variables and fall back to the home directory', () => {
  assert.equal(
    resolveVoiceConfigPath({ XDG_CONFIG_HOME: '/custom/cfg', HOME: '/home/u' }),
    path.join('/custom/cfg', 'sparkiee', 'voice.json'),
  );
  assert.equal(resolveVoiceConfigPath({ HOME: '/home/u' }), path.join('/home/u', '.config', 'sparkiee', 'voice.json'));
  assert.equal(resolveVoiceCacheDir({ XDG_CACHE_HOME: '/custom/cache' }), path.join('/custom/cache', 'sparkiee', 'voice'));
  assert.equal(resolveTtsDataDir({ XDG_DATA_HOME: '/custom/data' }), path.join('/custom/data', 'sparkiee', 'tts'));
  assert.equal(resolveTtsDataDir({ HOME: '/home/u' }), path.join('/home/u', '.local', 'share', 'sparkiee', 'tts'));
  assert.equal(
    resolveTtsVenvPython({ XDG_DATA_HOME: '/custom/data' }),
    path.join('/custom/data', 'sparkiee', 'tts', 'venv', 'bin', 'python'),
  );
  assert.equal(
    resolveTtsVenvPython({ SPARKIEE_TTS_PYTHON: '/opt/python' }),
    '/opt/python',
    'explicit override wins',
  );
  assert.equal(
    resolveTtsVoiceModelPath({ XDG_DATA_HOME: '/d' }, 'hi_IN-priyamvada-medium'),
    path.join('/d', 'sparkiee', 'tts', 'voices', 'hi_IN-priyamvada-medium', 'hi_IN-priyamvada-medium.onnx'),
  );
});

test('the catalogue ships an Indian female voice and an English female voice', () => {
  assert.deepEqual(DEFAULT_VOICES, { hi: 'hi_IN-priyamvada-medium', en: 'en_US-lessac-medium' });
  const hi = VOICE_CATALOG[DEFAULT_VOICES.hi];
  const en = VOICE_CATALOG[DEFAULT_VOICES.en];
  assert.equal(hi.language, 'hi');
  assert.match(hi.label, /Hindi, female/);
  assert.equal(en.language, 'en');
  assert.match(en.label, /English, female/);
  for (const voice of [hi, en]) {
    assert.equal(voice.files.length, 2, 'model + config');
    for (const url of voice.files) {
      assert.match(url, /^https:\/\/huggingface\.co\/rhasspy\/piper-voices\//);
      assert.match(url, /\.onnx(\.json)?$/);
    }
  }
});

test('language detection sends Devanagari to Hindi and everything else to English', () => {
  assert.equal(detectSpeechLanguage('नमस्ते, क्या हाल है?'), 'hi');
  assert.equal(detectSpeechLanguage('Hello there!'), 'en');
  assert.equal(detectSpeechLanguage('Chalo, task complete!'), 'en');
  assert.equal(detectSpeechLanguage('ok नमस्ते'), 'hi', 'any Devanagari wins');
  assert.equal(detectSpeechLanguage(null), 'en');
});

test('defaults apply with no file, and a valid file overrides only what it names', async () => {
  const { root, env } = await tempEnv();
  try {
    const empty = await loadVoiceConfig({ env });
    assert.equal(empty.configured, true, 'local voice is always available in principle');
    assert.deepEqual(empty.config.voices, DEFAULT_VOICES);
    assert.equal(empty.config.speed, DEFAULT_SPEED);
    assert.equal(empty.source, null);

    await writeVoiceConfig({ env, patch: { voices: { hi: DEFAULT_VOICES.hi }, speed: 1.25 } });
    const loaded = await loadVoiceConfig({ env });
    assert.equal(loaded.source, 'file');
    assert.equal(loaded.config.speed, 1.25);
    assert.deepEqual(loaded.config.voices, DEFAULT_VOICES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SPARKIEE_TTS_SPEED overrides the file without being written back', async () => {
  const { root, env } = await tempEnv();
  try {
    await writeVoiceConfig({ env, patch: { speed: 1.1 } });
    const loaded = await loadVoiceConfig({ env: { ...env, SPARKIEE_TTS_SPEED: '1.6' } });
    assert.equal(loaded.config.speed, 1.6);
    const onDisk = JSON.parse(await (await import('node:fs/promises')).readFile(resolveVoiceConfigPath(env), 'utf8'));
    assert.equal(onDisk.speed, 1.1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the config file is 0600 inside a 0700 directory and never contains a key', async () => {
  const { root, env } = await tempEnv();
  try {
    const file = await writeVoiceConfig({ env, patch: {} });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    const text = await (await import('node:fs/promises')).readFile(file, 'utf8');
    assert.ok(!/apiKey|key|token|secret/i.test(text), 'no credential fields at all');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid voices, languages, engines, and speeds are refused with actionable text', async () => {
  const { root, env } = await tempEnv();
  try {
    await assert.rejects(
      () => writeVoiceConfig({ env, patch: { voices: { hi: '../../etc/passwd' } } }),
      /unknown voice/,
    );
    await assert.rejects(() => writeVoiceConfig({ env, patch: { voices: { fr: DEFAULT_VOICES.en } } }), /unknown language/);
    await assert.rejects(() => writeVoiceConfig({ env, patch: { speed: 9 } }), /speed/);
    await assert.rejects(() => writeVoiceConfig({ env, patch: { engine: 'cloud' } }), /engine/);
    assert.equal(await deleteVoiceConfig({ env }), false, 'nothing was written');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validateVoiceConfig reports every problem', () => {
  assert.deepEqual(validateVoiceConfig({ engine: 'piper', voices: DEFAULT_VOICES, speed: 1 }), []);
  const errors = validateVoiceConfig({ engine: 'cloud', voices: { hi: 'nope', fr: DEFAULT_VOICES.en }, speed: 9 });
  assert.equal(errors.length, 4);
  assert.ok(errors.every((entry) => typeof entry === 'string' && entry.length > 10));
  assert.ok(validateVoiceConfig(null).length > 0);
  assert.ok(validateVoiceConfig([]).length > 0);
});

test('broken or hostile config files degrade with warnings, never crash', async () => {
  const { root, env } = await tempEnv();
  try {
    await mkdir(path.dirname(resolveVoiceConfigPath(env)), { recursive: true });
    await writeFile(resolveVoiceConfigPath(env), '{ not json');
    const broken = await loadVoiceConfig({ env });
    assert.ok(broken.warnings.some((warning) => warning.includes('not valid JSON')));
    assert.deepEqual(broken.config.voices, DEFAULT_VOICES);

    await writeFile(resolveVoiceConfigPath(env), JSON.stringify({ voices: { hi: '../etc/passwd' }, speed: 99, engine: 'x' }));
    const hostile = await loadVoiceConfig({ env });
    assert.deepEqual(hostile.config.voices, DEFAULT_VOICES, 'hostile voice ignored');
    assert.equal(hostile.config.speed, DEFAULT_SPEED, 'hostile speed ignored');
    assert.equal(hostile.config.engine, 'piper', 'hostile engine ignored');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('describeVoiceConfig is status-only and carries no secrets', () => {
  const described = describeVoiceConfig({
    configured: true,
    source: 'file',
    config: { engine: 'piper', voices: DEFAULT_VOICES, speed: 1 },
    warnings: [],
  });
  assert.equal(described.engine, 'piper');
  assert.deepEqual(described.voices, DEFAULT_VOICES);
  assert.equal(described.speed, 1);
  assert.equal(described.configured, true);
  assert.ok(!/apiKey|secret|token/i.test(JSON.stringify(described)));
});

test('mergeVoiceConfig honours validated file overrides only', () => {
  const merged = mergeVoiceConfig({
    fileConfig: { engine: 'piper', voices: { hi: DEFAULT_VOICES.hi, en: DEFAULT_VOICES.en }, speed: 0.9 },
    env: {},
  });
  assert.equal(merged.speed, 0.9);
  const defaults = mergeVoiceConfig({ fileConfig: { voices: { hi: 'bad' }, speed: 42 }, env: {} });
  assert.deepEqual(defaults, { engine: 'piper', voices: DEFAULT_VOICES, speed: DEFAULT_SPEED });
});

test('synthesis cache keys are stable, distinct, and path-safe', () => {
  const base = { text: 'Task complete!', voiceId: DEFAULT_VOICES.en, modelId: 'piper', outputFormat: 'wav_22050', settings: { speed: 1 } };
  const a = synthesisCacheKey(base);
  assert.equal(a, synthesisCacheKey({ ...base }));
  assert.match(a, /^[a-f0-9]{64}$/, 'hex only — path safe');
  assert.notEqual(a, synthesisCacheKey({ ...base, text: 'Task complete?' }));
  assert.notEqual(a, synthesisCacheKey({ ...base, voiceId: DEFAULT_VOICES.hi }));
  assert.notEqual(a, synthesisCacheKey({ ...base, settings: { speed: 1.3 } }));
});
