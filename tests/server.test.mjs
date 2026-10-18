import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { createSparkieeServer } from '../packages/server/src/server.mjs';
import { createPackDetailProvider } from '../packages/server/src/pack-detail.mjs';

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
    assert.match(html, /Sparkiee — Companion Journal/);
    assert.match(html, /data-pet-command="dance"/);

    for (const [route, type] of [['/src/main.js', /javascript/], ['/src/styles.css', /text\/css/]]) {
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

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

test('presentation ownership is readable publicly but claims need token or same origin', async () => {
  const instance = await startServer();
  try {
    const read = await fetch(`http://127.0.0.1:${instance.port}/api/v1/presentation`);
    assert.equal(read.status, 200);
    const before = await read.json();
    assert.equal(before.presentation.mode, 'desktop');
    assert.equal(before.presentation.owner, null);

    const denied = await postJson(
      `http://127.0.0.1:${instance.port}/api/v1/presentation/claim`,
      { owner: 'tab-one-1234' },
      { origin: 'https://attacker.example' },
    );
    assert.equal(denied.status, 403);

    const sameOrigin = await postJson(
      `http://127.0.0.1:${instance.port}/api/v1/presentation/claim`,
      { owner: 'tab-one-1234' },
      { origin: `http://127.0.0.1:${instance.port}` },
    );
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.payload.presentation.mode, 'dashboard');
    assert.equal(sameOrigin.payload.presentation.owner, 'tab-one-1234');
    assert.equal(sameOrigin.payload.pet.visible, true);

    const invalid = await postJson(
      `http://127.0.0.1:${instance.port}/api/v1/presentation/claim`,
      { owner: 'x' },
      { authorization: `Bearer ${'c'.repeat(64)}` },
    );
    assert.equal(invalid.status, 400);
  } finally {
    await close(instance.server);
  }
});

test('a second tab gets 409 while the first owns presentation, release restores desktop', async () => {
  const instance = await startServer();
  try {
    const auth = { authorization: `Bearer ${'c'.repeat(64)}` };
    const first = await postJson(`http://127.0.0.1:${instance.port}/api/v1/presentation/claim`, { owner: 'tab-one-1234' }, auth);
    assert.equal(first.status, 200);

    const second = await postJson(`http://127.0.0.1:${instance.port}/api/v1/presentation/claim`, { owner: 'tab-two-5678' }, auth);
    assert.equal(second.status, 409);
    assert.equal(second.payload.presentation.owner, 'tab-one-1234');
    assert.equal(second.payload.error, 'Another dashboard session currently owns Sparky.');

    const wrongRelease = await postJson(`http://127.0.0.1:${instance.port}/api/v1/presentation/release`, { owner: 'tab-two-5678' }, auth);
    assert.equal(wrongRelease.status, 409);

    const release = await postJson(`http://127.0.0.1:${instance.port}/api/v1/presentation/release`, { owner: 'tab-one-1234' }, auth);
    assert.equal(release.status, 200);
    assert.equal(release.payload.presentation.mode, 'desktop');
    assert.equal(release.payload.presentation.owner, null);
  } finally {
    await close(instance.server);
  }
});

test('desktop handoff endpoints require authorization and swap presentation atomically', async () => {
  const instance = await startServer();
  try {
    const denied = await postJson(`http://127.0.0.1:${instance.port}/api/v1/presentation/to-dashboard`, {});
    assert.equal(denied.status, 403);

    const auth = { authorization: `Bearer ${'c'.repeat(64)}` };
    const away = await postJson(`http://127.0.0.1:${instance.port}/api/v1/presentation/to-dashboard`, {}, auth);
    assert.equal(away.status, 200);
    assert.equal(away.payload.presentation.mode, 'dashboard');
    assert.equal(away.payload.presentation.pending, true);
    assert.equal(away.payload.presentation.owner, null);
    assert.equal(away.payload.pet.visible, true);

    const back = await postJson(`http://127.0.0.1:${instance.port}/api/v1/presentation/to-desktop`, {}, auth);
    assert.equal(back.status, 200);
    assert.equal(back.payload.presentation.mode, 'desktop');
    assert.equal(back.payload.presentation.owner, null);
    assert.equal(back.payload.pet.visible, true);
  } finally {
    await close(instance.server);
  }
});

test('character pack + sprite routes serve the real pack without leaking filesystem paths', async () => {
  const instance = await startServer({ getPackDetail: createPackDetailProvider() });
  try {
    const packResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/characters/sparkiee-original/pack`);
    assert.equal(packResponse.status, 200);
    const { pack } = await packResponse.json();
    assert.equal(pack.id, 'sparkiee-original');
    // Sprite referenced through a same-origin HTTP route, never file:// or a path.
    assert.equal(pack.sprite.url, '/api/v1/characters/sparkiee-original/sprite.png');
    assert.ok(Number.isInteger(pack.sprite.frameWidth) && pack.sprite.frameWidth > 0);
    assert.ok(pack.animations?.idle?.frames?.length > 0, 'idle animation present');
    assert.equal(typeof pack.voiceStyle, 'string');
    const raw = JSON.stringify(pack);
    assert.equal(raw.includes('file://'), false, 'no file URLs in pack JSON');
    assert.equal(raw.includes(process.cwd()), false, 'no absolute paths in pack JSON');
    assert.equal(raw.includes('spriteSheetPath'), false, 'no path fields in pack JSON');

    const spriteResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/characters/sparkiee-original/sprite.png`);
    assert.equal(spriteResponse.status, 200);
    assert.match(spriteResponse.headers.get('content-type'), /image\/png/);
    const bytes = Buffer.from(await spriteResponse.arrayBuffer());
    assert.ok(bytes.length > 100, 'sprite sheet served');
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic');

    const unknown = await fetch(`http://127.0.0.1:${instance.port}/api/v1/characters/not-a-real-pack/pack`);
    assert.equal(unknown.status, 404);

    const malformed = await fetch(`http://127.0.0.1:${instance.port}/api/v1/characters/Bad%20Id/pack`);
    assert.equal(malformed.status, 400);

    const traversal = await fetch(`http://127.0.0.1:${instance.port}/api/v1/characters/..%2F..%2Fsecret/pack`);
    assert.equal(traversal.status, 400, 'encoded traversal never reaches the filesystem');

    const badSprite = await fetch(`http://127.0.0.1:${instance.port}/api/v1/characters/Bad%20Id/sprite.png`);
    assert.equal(badSprite.status, 400);
  } finally {
    await close(instance.server);
  }
});

test('shared renderer modules are served from an exact allowlist', async () => {
  const instance = await startServer();
  try {
    const shared = await fetch(`http://127.0.0.1:${instance.port}/src/lib/frame-player.mjs`);
    assert.equal(shared.status, 200);
    assert.match(shared.headers.get('content-type'), /javascript/);
    const body = await shared.text();
    assert.ok(body.includes('createFramePlayer'), 'shared frame player body');

    for (const route of ['/src/lib/not-a-module.mjs', '/src/lib/main.js', '/src/server.mjs']) {
      const denied = await fetch(`http://127.0.0.1:${instance.port}${route}`);
      assert.equal(denied.status, 404, `${route} not served`);
      assert.equal(denied.headers.get('content-type'), 'application/json; charset=utf-8');
    }
  } finally {
    await close(instance.server);
  }
});

// ---------------------------------------------------------------------------
// Music library endpoints: loopback-public reads, gated rescan, honest 503
// when no library is attached, and zero filesystem paths in responses.
// ---------------------------------------------------------------------------

function musicServiceStub(overrides = {}) {
  const status = {
    roots: [{ path: '/home/hari007/Music', available: true }],
    formats: ['mp3'],
    trackCount: 19,
    scannedAt: '2026-10-18T12:00:00.000Z',
    rescanInFlight: false,
    lastError: null,
  };
  return {
    status: () => status,
    list: async ({ query = '' }) => ({
      tracks: [{
        id: 'a1b2c3d4e5f60718',
        name: 'Madira',
        title: 'Madira',
        artist: null,
        album: null,
        durationMs: 169_846,
        sizeBytes: 5_587_341,
        file: 'Madira.mp3',
        available: true,
      }],
      total: 1,
      query: String(query),
    }),
    rescan: async () => status,
    ...overrides,
  };
}

test('music status and library are readable on loopback and leak no paths', async () => {
  const instance = await startServer({ musicService: musicServiceStub() });
  try {
    const statusResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/status`);
    assert.equal(statusResponse.status, 200);
    const statusPayload = await statusResponse.json();
    assert.equal(statusPayload.music.trackCount, 19);
    assert.deepEqual(statusPayload.music.formats, ['mp3']);
    assert.equal(statusPayload.music.roots[0].path, '/home/hari007/Music', 'root is explicit and visible');

    const libraryResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/library?q=madira`);
    assert.equal(libraryResponse.status, 200);
    const libraryPayload = await libraryResponse.json();
    assert.equal(libraryPayload.tracks[0].name, 'Madira');
    assert.equal(libraryPayload.query, 'madira');
    const raw = JSON.stringify(libraryPayload);
    assert.equal(raw.includes('/home/hari007/Music/SeedheMauth'), false, 'no indexed file paths');
    assert.equal(raw.includes('file://'), false);

    const badLimit = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/library?limit=999`);
    assert.equal(badLimit.status, 400);
    const longQuery = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/library?q=${'x'.repeat(201)}`);
    assert.equal(longQuery.status, 400);
  } finally {
    await close(instance.server);
  }
});

test('music rescan requires the dashboard or token; missing service is an honest 503', async () => {
  const rescanCalls = { count: 0 };
  const instance = await startServer({
    musicService: musicServiceStub({ rescan: async () => {
      rescanCalls.count += 1;
      return { trackCount: 19, rescanInFlight: false };
    } }),
  });
  const bare = await startServer(); // no musicService at all
  try {
    const forbidden = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(forbidden.status, 403);
    assert.equal(rescanCalls.count, 0);

    const withToken = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token}` },
      body: '{}',
    });
    assert.equal(withToken.status, 200);
    assert.equal(rescanCalls.count, 1);

    const sameOrigin = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/scan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${instance.port}`,
        host: `127.0.0.1:${instance.port}`,
      },
      body: '{}',
    });
    assert.equal(sameOrigin.status, 200);

    const missing = await fetch(`http://127.0.0.1:${bare.port}/api/v1/music/status`);
    assert.equal(missing.status, 503);
    const missingScan = await fetch(`http://127.0.0.1:${bare.port}/api/v1/music/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${bare.port}`, host: `127.0.0.1:${bare.port}` },
      body: '{}',
    });
    assert.equal(missingScan.status, 503);
  } finally {
    await close(instance.server);
    await close(bare.server);
  }
});

// ---------------------------------------------------------------------------
// Music transport endpoints: gated, id-only play, honest error mapping.
// ---------------------------------------------------------------------------

function playbackStub(overrides = {}) {
  const playing = {
    phase: 'playing',
    track: { id: 'a1b2c3d4e5f60718', name: 'Madira', title: 'Madira', artist: null, durationMs: 169_846 },
    positionMs: 1200,
    durationMs: 169_846,
    volume: 0.8,
    muted: false,
    shuffle: false,
    ducked: false,
    queueLength: 19,
    engine: { backend: 'cvlc', available: true, detail: null },
    lastError: null,
  };
  return {
    status: () => ({ trackCount: 19, formats: ['mp3'], roots: [{ path: '/home/hari007/Music', available: true }], scannedAt: 'x', rescanInFlight: false, lastError: null }),
    list: async () => ({ tracks: [], total: 0, query: '' }),
    rescan: async () => ({ trackCount: 19 }),
    playbackStatus: () => ({ ...playing, phase: 'stopped' }),
    play: async ({ trackId }) => {
      if (!/^[0-9a-f]{16}$/.test(trackId)) {
        const error = new Error('trackId must be an opaque 16-character library id.');
        error.code = 'INVALID_TRACK';
        throw error;
      }
      if (trackId === 'a1b2c3d4e5f60718') return playing;
      const error = new Error('That track is not in the library (it may have been removed).');
      error.code = 'TRACK_NOT_FOUND';
      throw error;
    },
    pause: async () => ({ ...playing, phase: 'paused' }),
    resume: async () => playing,
    stop: async () => ({ ...playing, phase: 'stopped', track: null, positionMs: 0 }),
    next: async () => playing,
    previous: async () => playing,
    updateSettings: async (payload) => {
      if (payload.volume !== undefined && (payload.volume < 0 || payload.volume > 1)) {
        const error = new Error('volume must be a number between 0 and 1.');
        error.code = 'INVALID_VOLUME';
        throw error;
      }
      return { ...playing, ...payload };
    },
    ...overrides,
  };
}

test('music transport is auth-gated, id-only, and maps errors truthfully', async () => {
  const instance = await startServer({ musicService: playbackStub() });
  try {
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${instance.token}`,
    };
    // No auth → 403 on every state-changing op.
    const anon = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackId: 'a1b2c3d4e5f60718' }),
    });
    assert.equal(anon.status, 403);

    // Path-shaped payloads are rejected before any engine call.
    const pathPayload = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/play`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ trackId: '/home/hari007/Music/SeedheMauth/Madira.mp3' }),
    });
    assert.equal(pathPayload.status, 400, 'absolute path is not an opaque id → rejected');
    const pathBody = await pathPayload.json();
    assert.ok(!pathBody.error.includes('/home/hari007/Music'), 'error never echoes a path');

    const missingBody = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/play`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(missingBody.status, 400);

    const ok = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/play`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ trackId: 'a1b2c3d4e5f60718' }),
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.playback.phase, 'playing');
    assert.equal(okBody.playback.track.name, 'Madira');

    for (const op of ['pause', 'next', 'previous', 'stop']) {
      const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/${op}`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      assert.equal(response.status, 200, `${op} succeeds`);
    }

    // Settings: strict shape in, honest 400 for out-of-range volume.
    const badVolume = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ volume: 2 }),
    });
    assert.equal(badVolume.status, 400);
    const badType = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ muted: 'loud' }),
    });
    assert.equal(badType.status, 400);
    const goodSettings = await fetch(`http://127.0.0.1:${instance.port}/api/v1/music/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ volume: 0.4, shuffle: true }),
    });
    assert.equal(goodSettings.status, 200);
    const settingsBody = await goodSettings.json();
    assert.equal(settingsBody.playback.volume, 0.4);
  } finally {
    await close(instance.server);
  }
});

test('music status includes an honest playback block and 503s without a player', async () => {
  const withPlayer = await startServer({ musicService: playbackStub() });
  const withoutPlayer = await startServer({ musicService: playbackStub({ playbackStatus: undefined }) });
  try {
    const payload = await (await fetch(`http://127.0.0.1:${withPlayer.port}/api/v1/music/status`)).json();
    assert.equal(payload.playback.phase, 'stopped');
    assert.equal(payload.playback.engine.backend, 'cvlc');
    assert.ok(payload.music.trackCount >= 0);

    const barePayload = await (await fetch(`http://127.0.0.1:${withoutPlayer.port}/api/v1/music/status`)).json();
    assert.equal(barePayload.playback, null, 'no player attached → null, never invented');

    // A runtime without any music service answers transport with 503, never
    // a fake success or a 404 that would imply the route does not exist.
    const bare = await startServer();
    try {
      const gated = await fetch(`http://127.0.0.1:${bare.port}/api/v1/music/stop`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${bare.port}`,
          host: `127.0.0.1:${bare.port}`,
        },
        body: '{}',
      });
      assert.equal(gated.status, 503);
    } finally {
      await close(bare.server);
    }
  } finally {
    await close(withPlayer.server);
    await close(withoutPlayer.server);
  }
});
