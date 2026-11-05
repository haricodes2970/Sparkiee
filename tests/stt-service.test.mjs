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
    env: { XDG_DATA_HOME: '/fake/data', XDG_CONFIG_HOME: '/nonexistent-sparkiee-test-config' },
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

// ---------------------------------------------------------------------------
// Model config + decode quality (aligned with the proven Pisumathu settings).
// ---------------------------------------------------------------------------

test('stt catalog: large-v3-turbo entry with origin/size documented', async () => {
  const { STT_MODEL_CATALOG } = await import('../packages/core/src/stt-service.mjs');
  assert.ok(STT_MODEL_CATALOG['tiny.en']);
  const turbo = STT_MODEL_CATALOG['large-v3-turbo'];
  assert.ok(turbo, 'large-v3-turbo must be a catalog option');
  assert.match(turbo.repo, /faster-whisper-large-v3-turbo/);
  assert.ok(turbo.sizeBytes > 500_000_000, 'size documented honestly (>=500 MB)');
  assert.ok(turbo.licence || turbo.license, 'licence documented');
});

test('resolveSttModel: stt.json (0600) config wins, default tiny.en otherwise', async () => {
  const { resolveSttModel, writeSttConfig, readSttConfig, sttConfigPath } = await import('../packages/core/src/stt-service.mjs');
  const { mkdtempSync, rmSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/sparkiee-sttcfg-`);
  try {
    const env = { XDG_CONFIG_HOME: dir };
    assert.equal(resolveSttModel({ env }), 'tiny.en'); // no file → honest default
    await writeSttConfig({ env }, { model: 'large-v3-turbo' });
    const saved = statSync(`${dir}/sparkiee/stt.json`);
    assert.equal(saved.mode & 0o777, 0o600, 'stt.json must be 0600');
    assert.equal(resolveSttModel({ env }), 'large-v3-turbo');
    assert.deepEqual((await readSttConfig({ env })).model, 'large-v3-turbo');
    assert.ok(sttConfigPath({ env }).endsWith('stt.json'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildTranscribeScript: model named, Pisumathu decode params, cuda→cpu fallback', async () => {
  const { buildTranscribeScript } = await import('../packages/core/src/stt-service.mjs');
  const script = buildTranscribeScript('large-v3-turbo');
  assert.ok(script.includes("'large-v3-turbo'"), 'model name in script');
  assert.ok(/temperature\s*=\s*0\.0/.test(script), 'temperature pinned to 0');
  assert.ok(/condition_on_previous_text\s*=\s*False/.test(script), 'no hallucination chains');
  assert.ok(/beam_size\s*=\s*5/.test(script), 'beam_size 5');
  assert.ok(/best_of\s*=\s*5/.test(script), 'best_of 5');
  assert.ok(/vad_filter\s*=\s*True/.test(script), 'Silero VAD on');
  assert.ok(/device='cuda'/.test(script), 'tries CUDA first');
  assert.ok(/device='cpu'/.test(script), 'falls back to CPU');
});

test('createSttService: model overridable via config; env carries model name', async () => {
  const children = [];
  const captured = {};
  const spawnImpl = (bin, args, opts) => {
    captured.args = args; captured.env = opts?.env;
    const c = fakeChild({ output: JSON.stringify({ text: 'x', source: 'int16le:16000', segments: [] }) });
    children.push(c);
    setImmediate(() => c.respond());
    return c;
  };
  const svc = createSttService({ spawnImpl, venvPython: '/fake/venv/bin/python', model: 'large-v3-turbo' });
  await svc.transcribe({ pcm: pcmBytes(600) });
  assert.ok(captured.env?.SPARKIEE_STT_MODEL === 'large-v3-turbo', captured.env?.SPARKIEE_STT_MODEL);
  assert.ok(captured.args.includes('large-v3-turbo'));
});

// ---------------------------------------------------------------------------
// One global model cache: the HF hub convention, shared by every app.
// ---------------------------------------------------------------------------

test('resolveSttModelDir: global HF hub cache, honours HF_HOME / HUGGINGFACE_HUB_CACHE', async () => {
  const { resolveSttModelDir } = await import('../packages/core/src/stt-service.mjs');
  const os = await import('node:os');
  const path = await import('node:path');
  assert.equal(resolveSttModelDir({}), path.join(os.homedir(), '.cache', 'huggingface', 'hub'));
  assert.equal(resolveSttModelDir({ HF_HOME: '/tmp/hfhome' }), '/tmp/hfhome/hub');
  assert.equal(resolveSttModelDir({ HF_HOME: '/tmp/hfhome', HUGGINGFACE_HUB_CACHE: '/shared/hub' }), '/shared/hub');
});

test('createSttService: recogniser resolves the GLOBAL hub cache, not an app-private copy', async () => {
  const captured = {};
  const c = fakeChild({ output: JSON.stringify({ text: 'x', source: 'int16le:16000', segments: [] }) });
  const svc = createSttService({
    venvPython: '/fake/venv/bin/python',
    env: { HUGGINGFACE_HUB_CACHE: '/shared/hub' },
    spawnImpl: (bin, args, opts) => { captured.env = opts?.env; setImmediate(() => c.respond()); return c; },
  });
  await svc.transcribe({ pcm: pcmBytes(600) });
  assert.equal(captured.env?.HUGGINGFACE_HUB_CACHE, '/shared/hub');
  assert.equal(captured.env?.HF_HOME, undefined, 'must not nest a private hub inside HF_HOME');
});

test('probeSttSetup: reports the CONFIGURED model, not the fallback, when healthy', async () => {
  const { probeSttSetup } = await import('../packages/core/src/stt-service.mjs');
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/sparkiee-probe-`);
  try {
    mkdirSync(`${dir}/sparkiee`, { recursive: true });
    writeFileSync(`${dir}/sparkiee/stt.json`, JSON.stringify({ model: 'large-v3-turbo' }));
    const probe = await probeSttSetup({
      env: { XDG_CONFIG_HOME: dir, XDG_DATA_HOME: `${dir}/data` },
      pythonBin: () => '/usr/bin/python3',
      fileExists: () => true,
      runCheck: async () => ({ ok: true }),
    });
    assert.equal(probe.status, 'ready');
    assert.equal(probe.model, 'large-v3-turbo');
    assert.ok(probe.sizeBytes > 1_000_000_000, 'reports the real model size');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// GPU runtime: shared CUDA libs + a fallback that survives decode-time errors.
// ---------------------------------------------------------------------------

test('buildTranscribeScript: CUDA attempt wraps transcribe itself, CPU retry after failure', async () => {
  const { buildTranscribeScript } = await import('../packages/core/src/stt-service.mjs');
  const script = buildTranscribeScript('large-v3-turbo');
  // The cublas/cudnn failure surfaces during encode, not model load — the
  // fallback must cover the decode call, not just construction.
  assert.ok(/def _decode\(/.test(script), 'decode step factored out');
  assert.ok(/except Exception:\s*\n\s*model = WhisperModel\(MODEL_NAME, device='cpu'/.test(script), 'CPU retry happens after any GPU failure');
  assert.ok(/return list\(model\.transcribe\(/.test(script), 'generator is materialised inside the guarded block');
});

test('createSttService: injects the shared CUDA library path when that dir exists', async () => {
  const captured = {};
  const c = fakeChild({ output: JSON.stringify({ text: 'x', source: 'int16le:16000', segments: [] }) });
  const svc = createSttService({
    venvPython: '/fake/venv/bin/python',
    cudaLibsDir: '/shared/cuda-libs',
    cudaLibsExist: true,
    spawnImpl: (bin, args, opts) => { captured.env = opts?.env; setImmediate(() => c.respond()); return c; },
  });
  await svc.transcribe({ pcm: pcmBytes(600) });
  const ld = captured.env?.LD_LIBRARY_PATH ?? '';
  assert.ok(ld.includes('/shared/cuda-libs/nvidia/cublas/lib'), ld);
  assert.ok(ld.includes('/shared/cuda-libs/nvidia/cudnn/lib'), ld);
});

test('createSttService: leaves LD_LIBRARY_PATH alone when the shared dir is absent', async () => {
  const captured = {};
  const c = fakeChild({ output: JSON.stringify({ text: 'x', source: 'int16le:16000', segments: [] }) });
  const svc = createSttService({
    venvPython: '/fake/venv/bin/python',
    cudaLibsExist: false,
    spawnImpl: (bin, args, opts) => { captured.env = opts?.env; setImmediate(() => c.respond()); return c; },
  });
  await svc.transcribe({ pcm: pcmBytes(600) });
  assert.equal(captured.env?.LD_LIBRARY_PATH, undefined);
});
