import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyDotEnv, parseDotEnv } from '../packages/core/src/dotenv.mjs';

test('dotenv parses exports, comments, quotes, and blank lines', () => {
  const parsed = parseDotEnv([
    '# provider keys',
    'GROQ_API_KEY=gsk_example',
    'export GOOGLE_AI_API_KEY="AIza example"',
    "SPARKIEE_TTS_SPEED='1.25'",
    'EMPTY=',
    'WITH_HASH=value#not-a-comment',
    'QUOTED_HASH="value # kept"',
    'BROKEN LINE',
  ].join('\n'));
  assert.equal(parsed.values.GROQ_API_KEY, 'gsk_example');
  assert.equal(parsed.values.GOOGLE_AI_API_KEY, 'AIza example');
  assert.equal(parsed.values.SPARKIEE_TTS_SPEED, '1.25');
  assert.equal(parsed.values.EMPTY, '');
  assert.equal(parsed.values.WITH_HASH, 'value#not-a-comment');
  assert.equal(parsed.values.QUOTED_HASH, 'value # kept');
  assert.equal(parsed.warnings.length, 1, 'malformed line reports a line number, not contents');
  assert.match(parsed.warnings[0], /line 8/i);
  assert.ok(!JSON.stringify(parsed.warnings).includes('BROKEN'), 'warnings never echo secret-bearing lines');
});

test('dotenv fills missing values without overwriting explicit environment', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-dotenv-'));
  try {
    const file = path.join(dir, '.env');
    await writeFile(file, 'GROQ_API_KEY=from-file\nSPARKIEE_PORT=2099\n', { mode: 0o600 });
    const env = { GROQ_API_KEY: 'explicit', HOME: dir };
    const result = await applyDotEnv({ file, env });
    assert.deepEqual(result.applied, ['SPARKIEE_PORT']);
    assert.equal(env.GROQ_API_KEY, 'explicit');
    assert.equal(env.SPARKIEE_PORT, '2099');
    assert.equal(result.loaded, true);
    assert.ok(!JSON.stringify(result).includes('from-file'), 'result never contains values');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dotenv ignores broad permissions with a path-only warning and can be disabled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-dotenv-'));
  try {
    const file = path.join(dir, '.env');
    await writeFile(file, 'GOOGLE_AI_API_KEY=secret-value\n');
    await chmod(file, 0o644);
    const env = {};
    const result = await applyDotEnv({ file, env });
    assert.equal(env.GOOGLE_AI_API_KEY, 'secret-value');
    assert.ok(result.warnings.some((warning) => warning.includes(file) && /readable/.test(warning)));
    assert.ok(!JSON.stringify(result.warnings).includes('secret-value'));

    const disabled = {};
    const skipped = await applyDotEnv({ file, env: disabled, disabled: true });
    assert.equal(skipped.loaded, false);
    assert.deepEqual(disabled, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dotenv skips test runners unless explicitly forced', async () => {
  let reads = 0;
  const result = await applyDotEnv({
    file: '/nonexistent/.env',
    env: { NODE_TEST_CONTEXT: 'child-v8' },
    skipInTests: true,
    read: async () => { reads += 1; return 'SHOULD_NOT=load\n'; },
  });
  assert.equal(result.loaded, false);
  assert.equal(reads, 0);
  assert.equal(result.reason, 'test-runner');
});
