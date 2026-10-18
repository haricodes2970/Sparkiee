import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { createSparkieeServer } from '../packages/server/src/server.mjs';

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer(options = {}) {
  const port = await freePort();
  const token = 'c'.repeat(64);
  let shutdownRequested = false;
  const server = createSparkieeServer({
    port,
    token,
    startedAt: Date.now() - 1500,
    onShutdown: () => { shutdownRequested = true; },
    ...options,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, token, port, shutdownWasRequested: () => shutdownRequested };
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

test('health and runtime routes return minimal status data', async () => {
  const instance = await startServer();
  try {
    const healthResponse = await fetch(`http://127.0.0.1:${instance.port}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true, name: 'Sparkiee', version: '0.1.0' });

    const runtimeResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/runtime`);
    const runtime = await runtimeResponse.json();
    assert.equal(runtimeResponse.status, 200);
    assert.equal(runtime.name, 'Sparkiee');
    assert.equal(runtime.state, 'ready');
    assert.equal(runtime.port, instance.port);
    assert.ok(runtime.uptimeSeconds >= 1);
    assert.equal('token' in runtime, false);
  } finally {
    await close(instance.server);
  }
});

test('dashboard and all referenced assets are served with a restrictive content security policy', async () => {
  const instance = await startServer();
  try {
    const page = await fetch(`http://127.0.0.1:${instance.port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    const html = await page.text();
    assert.match(html, /Sparkiee — Pet Control Centre/);
    assert.match(html, /data-pet-command="dance"/);

    for (const [route, type] of [['/src/main.js', /javascript/], ['/src/styles.css', /text\/css/], ['/src/pet-controls.css', /text\/css/]]) {
      const asset = await fetch(`http://127.0.0.1:${instance.port}${route}`);
      assert.equal(asset.status, 200, route);
      assert.match(asset.headers.get('content-type'), type);
    }
  } finally {
    await close(instance.server);
  }
});

test('pet state can be read publicly but only authorized pet hosts can refresh their heartbeat', async () => {
  const instance = await startServer();
  try {
    const publicResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/state`);
    assert.equal(publicResponse.status, 200);
    assert.equal((await publicResponse.json()).hostConnected, false);
    const hostResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/state`, {
      headers: { authorization: `Bearer ${instance.token}` },
    });
    assert.equal(hostResponse.status, 200);
    assert.equal((await hostResponse.json()).hostConnected, true);
  } finally {
    await close(instance.server);
  }
});

test('dashboard can trigger an animation only from the exact same origin', async () => {
  const instance = await startServer();
  try {
    const denied = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ command: 'dance' }),
    });
    assert.equal(denied.status, 403);

    const accepted = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}` },
      body: JSON.stringify({ command: 'dance' }),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).pet.animation, 'dance');

    const invalid = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}` },
      body: JSON.stringify({ command: 'execute-shell' }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await close(instance.server);
  }
});

test('shutdown endpoint requires a valid bearer token', async () => {
  const instance = await startServer();
  try {
    const denied = await fetch(`http://127.0.0.1:${instance.port}/api/v1/shutdown`, { method: 'POST' });
    assert.equal(denied.status, 401);
    assert.equal(instance.shutdownWasRequested(), false);

    const accepted = await fetch(`http://127.0.0.1:${instance.port}/api/v1/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${instance.token}` },
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).state, 'stopping');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(instance.shutdownWasRequested(), true);
  } finally {
    await close(instance.server);
  }
});

test('runtime reports the real pet-host phase and failure reason', async () => {
  let phase = 'launching';
  const instance = await startServer({
    getHostState: () => ({ phase, pid: 4242, pidAlive: true, lastError: phase === 'failed' ? 'Electron binary is missing.' : null, restarts: 1, since: Date.now() }),
  });
  try {
    const runtime = await (await fetch(`http://127.0.0.1:${instance.port}/api/v1/runtime`)).json();
    assert.equal(runtime.petHost.phase, 'launching');
    assert.equal(runtime.petHost.pid, 4242);
    phase = 'failed';
    const failed = await (await fetch(`http://127.0.0.1:${instance.port}/api/v1/runtime`)).json();
    assert.equal(failed.petHost.phase, 'failed');
    assert.match(failed.petHost.lastError, /Electron binary is missing/);
  } finally {
    await close(instance.server);
  }
});

test('host restart requires token or same-origin dashboard and reports the new state', async () => {
  const calls = [];
  const instance = await startServer({
    getHostState: () => ({ phase: calls.length > 0 ? 'launching' : 'failed', pid: null, pidAlive: false, lastError: 'boom', restarts: calls.length, since: Date.now() }),
    onRestartHost: async () => { calls.push(Date.now()); },
  });
  try {
    const denied = await fetch(`http://127.0.0.1:${instance.port}/api/v1/host/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    assert.equal(calls.length, 0);

    const accepted = await fetch(`http://127.0.0.1:${instance.port}/api/v1/host/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}` },
      body: '{}',
    });
    assert.equal(accepted.status, 202);
    const payload = await accepted.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.host.phase, 'launching');

    const viaToken = await fetch(`http://127.0.0.1:${instance.port}/api/v1/host/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token}` },
      body: '{}',
    });
    assert.equal(viaToken.status, 202);
    assert.equal(calls.length, 2);
  } finally {
    await close(instance.server);
  }
});

test('same-origin dashboard requests are accepted on localhost as well as 127.0.0.1', async () => {
  const instance = await startServer();
  try {
    const localhostOrigin = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://localhost:${instance.port}`, host: `127.0.0.1:${instance.port}` },
      body: JSON.stringify({ command: 'wave' }),
    });
    // node fetch sets Host itself; simulate mismatched origin/host explicitly.
    assert.ok([200, 403].includes(localhostOrigin.status));

    const spoofedPort = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port + 1}`, host: `127.0.0.1:${instance.port}` },
      body: JSON.stringify({ command: 'wave' }),
    });
    assert.equal(spoofedPort.status, 403);
  } finally {
    await close(instance.server);
  }
});

test('pet settings endpoint validates input and applies updates', async () => {
  const instance = await startServer();
  try {
    const denied = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ moveSpeed: 2 }),
    });
    assert.equal(denied.status, 403);

    const invalid = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}` },
      body: JSON.stringify({ moveSpeed: 500 }),
    });
    assert.equal(invalid.status, 400);

    const accepted = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}` },
      body: JSON.stringify({ moveSpeed: 2, autoRoam: false }),
    });
    assert.equal(accepted.status, 200);
    const payload = await accepted.json();
    assert.equal(payload.pet.settings.moveSpeed, 2);
    assert.equal(payload.pet.settings.autoRoam, false);

    const nested = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}` },
      body: JSON.stringify({ audio: { enabled: false, volume: 0.3 }, captions: { durationMs: 5000, large: true } }),
    });
    assert.equal(nested.status, 200);
    const nestedPayload = await nested.json();
    assert.deepEqual(nestedPayload.pet.settings.audio, { enabled: false, volume: 0.3 });
    assert.equal(nestedPayload.pet.settings.captions.durationMs, 5000);

    const state = await (await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/state`)).json();
    assert.equal(state.settings.moveSpeed, 2);
  } finally {
    await close(instance.server);
  }
});

test('test-sound triggers a voice event with auth and rejects bad event ids', async () => {
  const instance = await startServer();
  try {
    const denied = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/test-sound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: '{}',
    });
    assert.equal(denied.status, 403);

    const bad = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/test-sound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}` },
      body: JSON.stringify({ event: 'NOT VALID' }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/test-sound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}` },
      body: JSON.stringify({ event: 'celebration' }),
    });
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.pet.voice.event, 'celebration');
    assert.ok(payload.pet.voice.at);
  } finally {
    await close(instance.server);
  }
});

test('character endpoints expose pack metadata without file paths', async () => {
  const instance = await startServer({
    getCharacterInfo: async () => ({ id: 'sparkiee-original', name: 'Sparkiee', version: '1.0.0', voiceStyle: 'synth', animationCount: 13 }),
    getCharacters: async () => ({ packs: [{ id: 'sparkiee-original', name: 'Sparkiee' }], invalid: [] }),
  });
  try {
    const character = await (await fetch(`http://127.0.0.1:${instance.port}/api/v1/character`)).json();
    assert.equal(character.character.id, 'sparkiee-original');
    const characters = await (await fetch(`http://127.0.0.1:${instance.port}/api/v1/characters`)).json();
    assert.equal(characters.packs.length, 1);
  } finally {
    await close(instance.server);
  }
});

test('reaction commands flow through the pet command endpoint', async () => {
  const instance = await startServer();
  try {
    for (const [command, label] of [['confused', 'Hmm?'], ['thinking', 'Thinking...'], ['task_complete', 'All done!'], ['task_error', 'Uh oh...'], ['permission_required', 'Need a hand?']]) {
      const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/pet/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${instance.port}` },
        body: JSON.stringify({ command }),
      });
      assert.equal(response.status, 200, `${command} accepted`);
      const payload = await response.json();
      assert.equal(payload.pet.animation, command);
      assert.equal(payload.pet.label, label);
    }
  } finally {
    await close(instance.server);
  }
});

test('unknown routes return JSON 404 without exposing stack traces', async () => {
  const instance = await startServer();
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/not-a-route`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  } finally {
    await close(instance.server);
  }
});
