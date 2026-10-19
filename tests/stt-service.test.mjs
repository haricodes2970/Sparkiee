import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createSttService,
  probeSttSetup,
  resolveSttDataDir,
  DEFAULT_STT_MODEL,
  STT_BUSY,
  STT_NOT_READY,
  TRANSCRIPT_MAX_CHARS,
} from '../packages/core/src/stt-service.mjs';

/** Fake whisper python: reads stdin, emits whatever job says on stdout. */
function fakeChild(job = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  const chunks = [];
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.write = (b) => { chunks.push(b); };
  child.stdin.end = (b) => { if (b) chunks.push(b); };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (sig) => {
    child.killedSignal = sig;
    child.emit('close', sig === 'SIGKILL' ? 137 : 0, sig);
  };
  child.respond = () => {
    child.stdout.emit('data', Buffer.from(job.output ?? ''));
    child.stderr.emit('data', Buffer.from(job.stderr ?? ''));
    child.stdout.emit('end');
    child.emit('close', job.exitCode ?? 0, null);
  };
  child.chunks = chunks;
  return child;
}

function pcmBytes(durationMs = 1000, amplitude = 2000) {
  const n = Math.trunc((durationMs / 1000) * 16000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(amplitude, i * 2);
  return buf;
}

test('stt: transcribe pipes pcm via stdin, parses single JSON result, no temp file', async () => {
  const children = [];
  const result = {
    text: ' play madira ',
    segments: [{ text: ' play madira', no_speech_prob: 0.02, avg_logprob: -0.3 }],
    source: 'int16le:16000',
  };
  const spawnImpl = (_bin, args, opts) => {
    children.push({ args, opts, child: fakeChild({ output: JSON.stringify(result) }) });
    setImmediate(() => children[children.length - 1].child.respond());
    return children[children.length - 1].child;
  };
  const svc = createSttService({ spawnImpl, venvPython: '/fake/venv/bin/python' });

  const out = await svc.transcribe({ pcm: pcmBytes(800) });

  assert.equal(out.status, 'ok');
  assert.equal(out.text, 'play madira'); // trimmed
  assert.ok(!out.text.startsWith(' '));
  assert.equal(out.source, 'int16le:16000');
  // PCM was piped on stdin — nothing was written to disk.
  assert.ok(children[0].child.chunks.length > 0);
  assert.equal(children[0].args[0], '-c'); // inline script, no temp file path
  assert.ok(!JSON.stringify(children[0].args).includes('.wav'));
});

test('stt: single-flight — concurrent call rejected with STT_BUSY', async () => {
  const children = [];
  const spawnImpl = () => { const c = fakeChild({}); children.push(c); return c; };
  const svc = createSttService({ spawnImpl, venvPython: '/fake/venv/bin/python' });
  const first = svc.transcribe({ pcm: pcmBytes(400) });
  await assert.rejects(
    () => svc.transcribe({ pcm: pcmBytes(400) }),
    (e) => e.code === 'STT_BUSY',
  );
  children[0].respond();
  await first;
});

test('stt: subprocess timeout kills python and reports error, no hang', async () => {
  const children = [];
  const spawnImpl = () => { const c = fakeChild({}); children.push(c); return c; };
  const svc = createSttService({ spawnImpl, venvPython: '/fake/venv/bin/python', timeoutMs: 80 });
  const result = await svc.transcribe({ pcm: pcmBytes(400) });
  assert.equal(result.status, 'error');
  assert.match(result.error ?? result.detail ?? '', /timed out/i);
  assert.equal(children[0].killedSignal, 'SIGTERM');
});

test('stt: cancellation discards the work immediately', async () => {
  const children = [];
  const spawnImpl = () => { const c = fakeChild({}); children.push(c); return c; };
  const svc = createSttService({ spawnImpl, venvPython: '/fake/venv/bin/python' });
  const call = svc.transcribe({ pcm: pcmBytes(400) });
  const aborted = await svc.cancel();
  assert.equal(aborted, true);
  await assert.rejects(() => call, (e) => e.code === 'STT_CANCELLED');
});

test('stt: stale process resolve on next single flight is ignored (session guard)', async () => {
  // First run times out and is killed; the child then emits close again — the
  // abandoned promise must not poison the next transcription.
  const children = [];
  const spawnImpl = () => { const c = fakeChild({}); children.push(c); return c; };
  const svc = createSttService({ spawnImpl, venvPython: '/fake/venv/bin/python', timeoutMs: 60 });
  await svc.transcribe({ pcm: pcmBytes(200) }); // times out
  const out = await svc.transcribe({ pcm: pcmBytes(400) }); // must still work
  assert.equal(out.status, 'error'); // second child also never responds, times out
  assert.equal(svc.busy(), false);
});

test('validateTranscript: rejects control chars, caps length, trims', async () => {
  const { validateTranscript } = await import('../packages/core/src/stt-service.mjs');
  const clean = validateTranscript('  play madira  ');
  assert.equal(clean, 'play madira');
  assert.throws(() => validateTranscript('bad\u0000nul'), /STT_INVALID_TRANSCRIPT|control|invalid/i);
  const long = 'a'.repeat(TRANSCRIPT_MAX_CHARS + 5);
  assert.throws(() => validateTranscript(long), /too long|STT_TRANSCRIPT_TOO_LONG/i);
  assert.equal(validateTranscript('').length, 0);
});

test('stt: tiny/quiet audio short-circuits to silence without spawning python', async () => {
  const children = [];
  const spawnImpl = () => { const c = fakeChild({}); children.push(c); return c; };
  const svc = createSttService({ spawnImpl, venvPython: '/fake/venv/bin/python' });
  const out = await svc.transcribe({ pcm: Buffer.alloc(100) }); // 100 bytes ≈ 3 samples
  assert.equal(out.status, 'silence');
  assert.equal(children.length, 0);
});

test('stt: non-json / crash output → error result, not a fake transcript', async () => {
  const spawnImpl = () => {
    const c = fakeChild({ output: 'TracebackNameError', exitCode: 1 });
    setImmediate(() => c.respond());
    return c;
  };
  const svc = createSttService({ spawnImpl, venvPython: '/fake/venv/bin/python' });
  const out = await svc.transcribe({ pcm: pcmBytes(400) });
  assert.equal(out.status, 'error');
  assert.ok(!out.text);
});

test('stt: python ENOENT → STT_UNAVAILABLE, honest detail', async () => {
  const spawnImpl = () => {
    const e = new Error('spawn ENOENT');
    e.code = 'ENOENT';
    throw e;
  };
  const svc = createSttService({ spawnImpl, venvPython: '/missing/venv/bin/python' });
  const out = await svc.transcribe({ pcm: pcmBytes(400) });
  assert.equal(out.status, 'unavailable');
  assert.match(out.detail ?? '', /not available|install|setup/i);
});

// ---------------------------------------------------------------------------
// Probe + setup: needs-setup honesty, consent gate, status shape.
// ---------------------------------------------------------------------------

test('probeSttSetup: nothing installed → needs-setup with python/module/model checklist', async () => {
  const probe = await probeSttSetup({
    env: {},
    pythonBin: (spec) => spec === 'python3' ? '/usr/bin/python3' : null,
    fileExists: () => false,
    runCheck: async () => { throw new Error('no module'); },
  });
  assert.equal(probe.provider, 'faster-whisper');
  assert.equal(probe.status, 'needs-setup');
  assert.ok(probe.missing.includes('stt-venv'));
  assert.ok(probe.missing.includes('model'));
  assert.match(probe.detail, /consent|setup/i);
});

test('probeSttSetup: ready when venv python checks module+model via runCheck', async () => {
  const probe = await probeSttSetup({
    env: { XDG_DATA_HOME: '/fake/data' },
    pythonBin: () => '/usr/bin/python3',
    fileExists: (p) => true,
    runCheck: async () => ({ ok: true, model: DEFAULT_STT_MODEL }),
  });
  assert.equal(probe.status, 'ready');
  assert.deepEqual(probe.missing, []);
  assert.equal(probe.model, DEFAULT_STT_MODEL);
  assert.ok(JSON.stringify(probe).length < 600); // compact, no paths leaked in detail
});

test('probeSttSetup: no python3 at all → unavailable (cannot install engine)', async () => {
  const probe = await probeSttSetup({
    env: {},
    pythonBin: () => null,
    fileExists: () => false,
    runCheck: async () => ({ ok: false }),
  });
  assert.equal(probe.status, 'unavailable');
  assert.ok(probe.missing.includes('python'));
});

test('resolveSttDataDir honours XDG_DATA_HOME and defaults to ~/.local/share/sparkiee/stt', () => {
  assert.equal(resolveSttDataDir({ XDG_DATA_HOME: '/x' }), '/x/sparkiee/stt');
  const home = process.env.HOME?.trim() ? process.env.HOME : '~';
  assert.ok(resolveSttDataDir({}).includes('sparkiee/stt'), resolveSttDataDir({}));
});
