import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_LOCAL_TTS_VOICE,
  createLocalTts,
  probeLocalTts,
  wavDurationMs,
} from '../packages/core/src/local-tts.mjs';
import { createAudioCache } from '../packages/core/src/audio-cache.mjs';
import { createPetController } from '../packages/core/src/pet-state.mjs';
import { createVoiceService } from '../packages/server/src/voice-service.mjs';

function fakeSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { calls.push({ killed: true }); };
    calls.push({ command, args, options });
    queueMicrotask(() => handler({ command, args, child }));
    return child;
  };
  return { spawnImpl, calls };
}

/** Minimal PCM wave with a known duration. */
function waveBuffer({ seconds = 1, byteRate = 44100 } = {}) {
  const dataSize = byteRate * seconds;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

test('wavDurationMs reads real byte counts and rejects non-waves', () => {
  assert.equal(wavDurationMs(waveBuffer({ seconds: 2 })), 2000);
  assert.equal(wavDurationMs(Buffer.from('not audio')), null);
  assert.equal(wavDurationMs(null), null);
});

test('probeLocalTts reports a ready synthesiser with its version', async () => {
  const { spawnImpl, calls } = fakeSpawn(({ child }) => {
    child.stdout.emit('data', Buffer.from('eSpeak NG text-to-speech: 1.52.0\n'));
    child.emit('close', 0);
  });
  const probe = await probeLocalTts({ spawnImpl });
  assert.equal(probe.status, 'ready');
  assert.equal(probe.provider, 'espeak-ng');
  assert.match(probe.version, /1\.52\.0/);
  assert.deepEqual(calls[0].args, ['--version']);
});

test('probeLocalTts reports a missing binary with an install hint', async () => {
  const { spawnImpl } = fakeSpawn(({ child }) => {
    const error = new Error('spawn espeak-ng ENOENT');
    error.code = 'ENOENT';
    child.emit('error', error);
  });
  const probe = await probeLocalTts({ spawnImpl });
  assert.equal(probe.status, 'unavailable');
  assert.match(probe.detail, /espeak-ng/);
});

test('local synthesis passes the phrase as one argv entry and returns wave audio', async () => {
  const audio = waveBuffer({ seconds: 1 });
  const { spawnImpl, calls } = fakeSpawn(async ({ args, child }) => {
    // The last argv entry is the phrase: no shell, no injection surface.
    assert.equal(Array.isArray(args), true);
    assert.equal(args.at(-1), 'Hello; rm -rf /');
    child.emit('close', 0);
  });
  const client = createLocalTts({
    spawnImpl,
    mkdtempImpl: async () => await mkdtemp(path.join(os.tmpdir(), 'sparkiee-tts-src-')),
    readFileImpl: async () => waveBuffer({ seconds: 1 }),
    rmImpl: async () => {},
  });
  const result = await client.synthesize('Hello; rm -rf /');
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'audio/wav');
  assert.equal(result.provider, 'espeak-ng');
  assert.equal(result.durationMs, 1000);
  assert.equal(result.audio.length, waveBuffer({ seconds: 1 }).length);
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 6), ['-v', DEFAULT_LOCAL_TTS_VOICE, '-s', '165', '-w', args[5]]);
});

test('local synthesis deletes its scratch directory even on failure', async () => {
  const removed = [];
  const client = createLocalTts({
    spawnImpl: fakeSpawn(({ args, child }) => {
      assert.ok(args.includes('-w'));
      child.emit('close', 1);
      child.stderr.emit('data', Buffer.from('voice missing'));
    }).spawnImpl,
    mkdtempImpl: async () => path.join(os.tmpdir(), 'sparkiee-tts-fake'),
    readFileImpl: async () => waveBuffer(),
    rmImpl: async (dir, options) => { removed.push({ dir, options }); },
  });
  const result = await client.synthesize('hello');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].options.recursive, true);
});

test('a missing espeak-ng binary is reported as unavailable, not a generic failure', async () => {
  const client = createLocalTts({
    spawnImpl: () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; queueMicrotask(() => { const error = new Error('spawn espeak-ng ENOENT'); error.code = 'ENOENT'; child.emit('error', error); }); return child; },
    mkdtempImpl: async () => path.join(os.tmpdir(), 'sparkiee-tts-fake2'),
    rmImpl: async () => {},
  });
  const result = await client.synthesize('hello');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unavailable');
  assert.match(result.message, /espeak-ng/i);
});

test('synthesis with real espeak-ng on this machine produces playable wave audio', async (t) => {
  const probe = await probeLocalTts({ spawnImpl: undefined });
  if (probe.status !== 'ready') {
    t.skip(`espeak-ng not installed: ${probe.detail}`);
    return;
  }
  const client = createLocalTts();
  const result = await client.synthesize("Hey, I'm Sparky!");
  assert.equal(result.ok, true);
  assert.equal(wavDurationMs(result.audio) > 300, true, 'real speech, not an empty buffer');
  assert.ok(result.audio.length < 4_000_000, 'clip fits the pet host transport');
});

// ---------------------------------------------------------------------------
// Voice service: cloud first, then real local speech. A caption alone is not
// "speaking", so an unavailable/failed cloud provider must not be the end of
// the story — but every outcome is labelled honestly.
// ---------------------------------------------------------------------------

function makeService({ configured = true, synthesizeImpl = null, localTts = null } = {}) {
  const dir = path.join(os.tmpdir(), `sparkiee-vf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cache = createAudioCache({ dir });
  const service = createVoiceService({
    getConfig: () => ({
      configured,
      config: { apiKey: 'k'.repeat(24), voiceId: 'v', modelId: 'm', outputFormat: 'mp3_44100_128' },
    }),
    getClient: () => (configured ? {
      synthesize: synthesizeImpl ?? (async () => ({ ok: true, audio: Buffer.from('mp3'), mime: 'audio/mpeg' })),
    } : null),
    cache,
    petController: createPetController(),
    localTts,
  });
  return { service, dir };
}

function fakeLocalTts(result) {
  const calls = [];
  return {
    calls,
    provider: 'espeak-ng',
    voice: 'en-us',
    speed: 165,
    synthesize: async (text) => { calls.push(text); return typeof result === 'function' ? result(text) : result; },
  };
}

test('an unconfigured cloud still speaks through the local fallback', async () => {
  const wav = waveBuffer({ seconds: 1 });
  const local = fakeLocalTts({ ok: true, audio: wav, mime: 'audio/wav' });
  const { service, dir } = makeService({ configured: false, localTts: local });
  try {
    const snapshot = await service.speak('Hello there!');
    assert.match(snapshot.speech.clipId, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.provider, 'espeak-ng');
    assert.equal(snapshot.fallbackReason, 'not_configured');
    assert.equal(snapshot.speech.error, null);
    assert.deepEqual(local.calls, ['Hello there!']);

    // The clip keeps its real format so the renderer plays WAV, not MP3.
    const clip = await service.getClip(snapshot.speech.clipId);
    assert.equal(clip.status, 'ok');
    assert.equal(clip.mime, 'audio/wav');
    assert.deepEqual(clip.audio, wav);

    // Identical phrase: cached locally, no second synthesis.
    await service.speak('Hello there!');
    assert.equal(local.calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a cloud outage falls back to local audio and reports the cloud failure', async () => {
  const local = fakeLocalTts({ ok: true, audio: waveBuffer(), mime: 'audio/wav' });
  const { service, dir } = makeService({
    localTts: local,
    synthesizeImpl: async () => ({ ok: false, code: 'quota', message: 'out of credits' }),
  });
  try {
    const snapshot = await service.speak('Still speak to me.');
    assert.ok(snapshot.speech.clipId, 'local audio was delivered');
    assert.equal(snapshot.provider, 'espeak-ng');
    assert.equal(snapshot.fallbackFrom, 'elevenlabs');
    assert.equal(snapshot.fallbackReason, 'quota');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('when every path fails the error is honest, never a fake success', async () => {
  const local = fakeLocalTts({ ok: false, code: 'unavailable', message: 'espeak-ng is not installed' });
  const { service, dir } = makeService({
    localTts: local,
    synthesizeImpl: async () => ({ ok: false, code: 'auth' }),
  });
  try {
    const snapshot = await service.speak('Nothing can speak this.');
    assert.equal(snapshot.speech.clipId, null);
    assert.equal(snapshot.speech.error, 'local_tts_unavailable');
    assert.equal(snapshot.provider, null);
    const status = await service.status();
    assert.equal(status.lastError, 'local_tts_unavailable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a working cloud provider is preferred and labelled', async () => {
  const local = fakeLocalTts({ ok: true, audio: waveBuffer(), mime: 'audio/wav' });
  const { service, dir } = makeService({ localTts: local });
  try {
    const snapshot = await service.speak('Cloud please.');
    assert.equal(snapshot.provider, 'elevenlabs');
    assert.equal(snapshot.fallbackReason, undefined);
    assert.equal(local.calls.length, 0, 'the local synthesiser is never invoked when the cloud works');
    const clip = await service.getClip(snapshot.speech.clipId);
    assert.equal(clip.mime, 'audio/mpeg');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
