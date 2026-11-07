/**
 * Voice lifecycle against a real daemon with the real local engine.
 *
 * Piper is installed once by "sparkiee voice setup"; this test reuses that
 * installation (real XDG data dir) and skips honestly when it is absent, so
 * it never pretends to verify a voice that cannot speak.
 *
 * Guarantees verified here:
 * - the daemon reports the local engine truthfully;
 * - speech goes through Piper + cache and announces a clip;
 * - clips are token-gated raw WAV audio;
 * - repeated phrases are served from cache (one synthesis);
 * - agent events drive speech without leaking task content;
 * - no credential-shaped value appears in any HTTP response.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createProbeServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(ROOT, 'bin/sparkiee.mjs');
const FAKE_GROQ_KEY = 'gsk_integration_fake_key_0123456789abcd';

async function reservePort() {
  const server = createProbeServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runCli(args, env, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: sparkiee ${args.join(' ')}`));
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitForStatus(port, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/runtime`);
      if (response.ok) {
        const payload = await response.json();
        if (payload.state === 'ready' && payload.pid && expected(payload)) return payload;
      }
    } catch {
      // daemon not listening yet
    }
    if (Date.now() > deadline) throw new Error('daemon did not become ready in time');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('voice lifecycle: local Piper speaks, clips are gated, cache and captions stay honest', async (t) => {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const preflight = await runCli(['voice', 'status'], { ...process.env, XDG_DATA_HOME: dataHome });
  if (!/Runtime\s+: ready/.test(preflight.stdout)) {
    t.skip('Piper is not installed in this user data dir; run "sparkiee voice setup" to exercise this test.');
    return;
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-voicelife-'));
  const port = await reservePort();
  const env = {
    ...process.env,
    HOME: scratch,
    XDG_STATE_HOME: path.join(scratch, '.state'),
    XDG_CACHE_HOME: path.join(scratch, '.cache'),
    XDG_CONFIG_HOME: path.join(scratch, '.config'),
    XDG_DATA_HOME: dataHome,
    SPARKIEE_PORT: String(port),
    SPARKIEE_DISABLE_PET: '1',
    SPARKIEE_MUSIC_ROOTS: path.join(scratch, 'no-music'),
    GROQ_API_KEY: FAKE_GROQ_KEY,
  };
  t.after(async () => {
    await runCli(['stop'], env).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  });

  const started = await runCli(['start'], env);
  assert.equal(started.code, 0, started.stderr);
  await waitForStatus(port, () => true);
  const token = (await readFile(path.join(scratch, '.state', 'sparkiee', 'runtime.token'), 'utf8')).trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const base = `http://127.0.0.1:${port}`;

  // 1. Local engine visible and honest.
  const status = await (await fetch(`${base}/api/v1/voice/status`)).json();
  assert.equal(status.voice.configured, true, 'daemon sees the local engine');
  assert.equal(status.voice.provider, 'piper');
  assert.match(status.voice.voices.hi, /priyamvada/);
  assert.match(status.voice.voices.en, /lessac/);

  // 2. Explicit speech synthesises and announces a cacheable clip.
  const speak = await fetch(`${base}/api/v1/voice/speak`, {
    method: 'POST', headers: auth, body: JSON.stringify({ text: 'Integration hello from Sparky.' }),
  });
  const speakBody = await speak.json();
  assert.equal(speak.ok, true);
  assert.equal(speakBody.generated, true);
  assert.equal(speakBody.provider, 'piper');
  assert.equal(speakBody.speech.text, 'Integration hello from Sparky.');
  assert.match(speakBody.speech.clipId, /^[a-f0-9]{64}$/);

  // 3. Clip delivery is token-gated raw WAV audio.
  const noToken = await fetch(`${base}/api/v1/voice/clip/${speakBody.speech.clipId}`);
  assert.equal(noToken.status, 401, 'clips never ship without the runtime token');
  const clip = await fetch(`${base}/api/v1/voice/clip/${speakBody.speech.clipId}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(clip.status, 200);
  assert.equal(clip.headers.get('content-type'), 'audio/wav');
  const audio = Buffer.from(await clip.arrayBuffer());
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.ok(audio.length > 1000, 'real speech, not an empty buffer');

  // 4. Cache: the same phrase does not synthesise twice.
  const again = await fetch(`${base}/api/v1/voice/speak`, {
    method: 'POST', headers: auth, body: JSON.stringify({ text: 'Integration hello from Sparky.' }),
  });
  const againBody = await again.json();
  assert.equal(againBody.speech.clipId, speakBody.speech.clipId, 'identical phrase, identical cached clip');

  // 5. Agent events drive reactions with speech and no content leakage.
  const agent = await fetch(`${base}/api/v1/agent/event`, {
    method: 'POST', headers: auth, body: JSON.stringify({ source: 'opencode', sessionId: 'ses_integration', event: 'task_complete' }),
  });
  assert.equal((await agent.json()).reaction.command, 'celebrate');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const petState = await (await fetch(`${base}/api/v1/pet/state`)).json();
  assert.equal(petState.animation, 'celebrate', 'pet celebrates a confirmed completion');
  assert.equal(petState.speech.text, 'Your task is complete!', 'spoken line announced');
  assert.equal(petState.speech.error, null);

  // 6. No credential-shaped value appears in any response body.
  const scanned = await Promise.all([
    fetch(`${base}/api/v1/voice/status`),
    fetch(`${base}/api/v1/pet/state`),
    fetch(`${base}/api/v1/pet/characters`),
    fetch(`${base}/api/v1/runtime`),
    fetch(`${base}/api/v1/assistant/status`),
  ]);
  for (const response of scanned) {
    const text = await response.text();
    assert.ok(!text.includes(FAKE_GROQ_KEY), `${response.url} never echoes a provider key`);
    assert.ok(!text.includes(token), `${response.url} never echoes the runtime token`);
  }
});
