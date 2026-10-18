/**
 * Voice security and lifecycle against a real daemon.
 *
 * A loopback mock plays the role of the ElevenLabs API (the daemon's
 * provider seam only accepts http://127.0.0.1), so this exercises the
 * complete pipeline — config -> provider -> cache -> announcement ->
 * token-gated clip delivery — with no real key and no network.
 *
 * The hard guarantees verified here:
 * - the API key appears in no HTTP response, on any endpoint;
 * - clips are token-gated raw audio;
 * - a provider failure still produces the caption text plus an honest
 *   error, never a fake success;
 * - repeated phrases are served from cache (one provider call).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createProbeServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(ROOT, 'bin/sparkiee.mjs');
const FAKE_KEY = 'sk_integration_fake_key_0123456789';
const FAKE_MP3 = Buffer.from('ID3-mock-audio-bytes-for-integration-only');

async function reservePort(serverFactory = createProbeServer) {
  const server = serverFactory();
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

/** Minimal ElevenLabs stand-in on loopback. */
async function startMockProvider() {
  const state = { synthesizeCalls: 0, failAuth: false, lastText: null };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const authorized = request.headers['xi-api-key'] === FAKE_KEY && !state.failAuth;
      if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ detail: { message: 'invalid key' } }));
        return;
      }
      if (request.method === 'GET' && request.url.startsWith('/v1/voices/')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ voice: { name: 'Sparky (mock)' } }));
        return;
      }
      if (request.method === 'POST' && request.url.startsWith('/v1/text-to-speech/')) {
        state.synthesizeCalls += 1;
        try {
          state.lastText = JSON.parse(Buffer.concat(chunks).toString('utf8')).text;
        } catch {
          state.lastText = null;
        }
        response.writeHead(200, { 'content-type': 'audio/mpeg' });
        response.end(FAKE_MP3);
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    state,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
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

test('voice lifecycle: key never leaks, clips are gated, failures keep captions honest', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-voicelife-'));
  const port = await reservePort();
  const mock = await startMockProvider();
  const env = {
    ...process.env,
    HOME: scratch,
    XDG_STATE_HOME: path.join(scratch, '.state'),
    XDG_CACHE_HOME: path.join(scratch, '.cache'),
    XDG_CONFIG_HOME: path.join(scratch, '.config'),
    SPARKIEE_PORT: String(port),
    SPARKIEE_DISABLE_PET: '1',
    ELEVENLABS_API_KEY: FAKE_KEY,
    SPARKIEE_VOICE_API_BASE_URL: `http://127.0.0.1:${mock.port}`,
  };
  t.after(async () => {
    await runCli(['stop'], env).catch(() => {});
    await mock.stop().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  });

  const started = await runCli(['start'], env);
  assert.equal(started.code, 0, started.stderr);
  await waitForStatus(port, () => true);
  const token = (await readFile(path.join(scratch, '.state', 'sparkiee', 'runtime.token'), 'utf8')).trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const base = `http://127.0.0.1:${port}`;

  // 1. Provider configured and visible, key never rendered.
  const status = await (await fetch(`${base}/api/v1/voice/status`)).json();
  assert.equal(status.voice.configured, true, 'daemon sees the provider');
  assert.equal(status.voice.voiceId, 'k7uh1RfFIE9Dn75CNvuX');

  // 2. Explicit speech goes through provider + cache and announces.
  const speak = await fetch(`${base}/api/v1/voice/speak`, {
    method: 'POST', headers: auth, body: JSON.stringify({ text: 'Integration hello from Sparky.' }),
  });
  const speakBody = await speak.json();
  assert.equal(speak.ok, true);
  assert.equal(speakBody.generated, true);
  assert.equal(speakBody.speech.text, 'Integration hello from Sparky.');
  assert.match(speakBody.speech.clipId, /^[a-f0-9]{64}$/);
  assert.equal(mock.state.lastText, 'Integration hello from Sparky.', 'the provider received the phrase');

  // 3. Clip delivery is token-gated raw audio.
  const noToken = await fetch(`${base}/api/v1/voice/clip/${speakBody.speech.clipId}`);
  assert.equal(noToken.status, 401, 'clips never ship without the runtime token');
  const clip = await fetch(`${base}/api/v1/voice/clip/${speakBody.speech.clipId}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(clip.status, 200);
  assert.equal(clip.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await clip.arrayBuffer()), FAKE_MP3);

  // 4. Cache: the same phrase does not hit the provider again.
  const again = await fetch(`${base}/api/v1/voice/speak`, {
    method: 'POST', headers: auth, body: JSON.stringify({ text: 'Integration hello from Sparky.' }),
  });
  const againBody = await again.json();
  assert.equal(againBody.speech.clipId, speakBody.speech.clipId, 'identical phrase, identical cached clip');
  assert.equal(mock.state.synthesizeCalls, 1, 'one provider call, one cache hit');

  // 5. Agent events drive reactions with speech and no content leakage.
  const agent = await fetch(`${base}/api/v1/agent/event`, {
    method: 'POST', headers: auth, body: JSON.stringify({ source: 'opencode', sessionId: 'ses_integration', event: 'task_complete' }),
  });
  assert.equal((await agent.json()).reaction.command, 'celebrate');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const petState = await (await fetch(`${base}/api/v1/pet/state`)).json();
  assert.equal(petState.animation, 'celebrate', 'pet celebrates a confirmed completion');
  assert.equal(petState.speech.text, 'Your task is complete!', 'spoken line announced');
  assert.equal(petState.speech.error, null);

  // 6. Provider failure: honest error, caption text preserved, no fake success.
  mock.state.failAuth = true;
  const failing = await fetch(`${base}/api/v1/voice/speak`, {
    method: 'POST', headers: auth, body: JSON.stringify({ text: 'A phrase during an outage.' }),
  });
  const failingBody = await failing.json();
  assert.equal(failingBody.generated, false, 'failure is never reported as success');
  assert.equal(failingBody.speech.error, 'auth');
  assert.equal(failingBody.speech.clipId, null);
  assert.equal(failingBody.speech.text, 'A phrase during an outage.', 'caption source text survives the failure');
  const failedState = await (await fetch(`${base}/api/v1/pet/state`)).json();
  assert.equal(failedState.speech.error, 'auth');
  assert.equal(failedState.speech.text, 'A phrase during an outage.', 'the pet host can still show a caption');

  // 7. The secret key appears in no response body anywhere.
  const scanned = await Promise.all([
    fetch(`${base}/api/v1/voice/status`),
    fetch(`${base}/api/v1/pet/state`),
    fetch(`${base}/api/v1/pet/characters`),
    fetch(`${base}/api/v1/runtime`),
    fetch(`${base}/`),
    fetch(`${base}/api/v1/voice/speak`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'Leak scan phrase.' }) }),
  ]);
  for (const response of scanned) {
    const text = await response.text();
    assert.ok(!text.includes(FAKE_KEY), `key leaked from ${response.url} (${response.status})`);
    assert.ok(!text.includes(FAKE_KEY.slice(3, 15)), 'no partial key either');
  }

  // 8. Clean shutdown through the normal CLI path.
  const stopped = await runCli(['stop'], env);
  assert.equal(stopped.code, 0, stopped.stderr);
});
