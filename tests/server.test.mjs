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

async function startServer() {
  const port = await freePort();
  const token = 'c'.repeat(64);
  let shutdownRequested = false;
  const server = createSparkieeServer({ port, token, startedAt: Date.now() - 1500, onShutdown: () => { shutdownRequested = true; } });
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

test('dashboard files are served with a restrictive content security policy', async () => {
  const instance = await startServer();
  try {
    const page = await fetch(`http://127.0.0.1:${instance.port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await page.text(), /Sparkiee — Pet Control Centre/);

    const script = await fetch(`http://127.0.0.1:${instance.port}/src/main.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
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
    const result = await accepted.json();
    assert.equal(result.pet.animation, 'dance');

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
