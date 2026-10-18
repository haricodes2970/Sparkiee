import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMusicPlayer } from '../packages/core/src/music-player.mjs';

/**
 * Fake cvlc child: records every RC command written to stdin, answers
 * get_length with the canned duration, and can simulate crashes.
 */
function makeFakeBackend({ lengthSeconds = 169, failSpawn = false } = {}) {
  const calls = [];
  const children = [];
  const spawnImpl = () => {
    if (failSpawn) {
      const error = new Error('spawn cvlc ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    const child = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.stdin = new EventEmitter();
    child.stdin.write = (chunk) => {
      const command = chunk.trim();
      calls.push(command);
      if (command === 'get_length') {
        queueMicrotask(() => child.stdout.emit('data', `${lengthSeconds}\n`));
      }
      return true;
    };
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = (signal) => {
      child.killed = true;
      child.exitCode = signal === 'SIGKILL' ? 137 : 0;
      child.emit('exit', 0, signal);
    };
    children.push(child);
    return child;
  };
  return { spawnImpl, calls, children };
}

function makeLibrary(trackCount = 3) {
  const tracks = Array.from({ length: trackCount }, (_, index) => ({
    id: index.toString(16).padStart(16, '0'),
    displayName: `Track ${index}`,
    title: index === 0 ? 'Madira' : null,
    artist: null,
    album: null,
    durationMs: 169_846,
    relativePath: `Track ${index}.mp3`,
  }));
  const pathById = new Map(
    tracks.map((track) => [track.id, `/home/hari007/Music/album/${track.relativePath}`]),
  );
  return {
    tracks,
    resolvePath: async (trackId) => pathById.get(trackId) ?? null,
    orderedTracks: () => tracks.map((track) => ({ ...track })),
  };
}

function setup(options = {}) {
  let clock = 1_000_000;
  const backend = makeFakeBackend(options.backend);
  const library = options.library ?? makeLibrary(options.trackCount);
  const player = createMusicPlayer({
    library,
    spawnImpl: backend.spawnImpl,
    now: () => clock,
    ...(options.player ?? {}),
  });
  return {
    player,
    backend,
    library,
    advanceClock(ms) { clock += ms; },
    firstTrackId: library.tracks[0].id,
    secondTrackId: library.tracks[1]?.id,
    lastTrackId: library.tracks[library.tracks.length - 1]?.id,
  };
}

test('play validates the opaque id, resolves containment, and drives RC safely', async () => {
  const ctx = setup();
  await assert.rejects(() => ctx.player.play({ trackId: '../../etc/passwd' }), (error) => error.code === 'INVALID_TRACK');
  await assert.rejects(() => ctx.player.play({ trackId: '/home/hari007/Music/x.mp3' }), (error) => error.code === 'INVALID_TRACK');
  await assert.rejects(
    () => ctx.player.play({ trackId: 'ffffffffffffffff' }),
    (error) => error.code === 'TRACK_NOT_FOUND',
  );

  const state = await ctx.player.play({ trackId: ctx.firstTrackId });
  assert.equal(state.phase, 'playing');
  assert.equal(state.track.name, 'Track 0');
  assert.equal(state.track.title, 'Madira');
  assert.equal(state.engine.backend, 'cvlc');
  assert.equal(state.engine.available, true);
  // Spawn syncs volume first; play then sequences stop → clear → add → volume.
  const stopIdx = ctx.backend.calls.indexOf('stop');
  assert.ok(stopIdx >= 0, 'stop precedes the new media');
  assert.equal(ctx.backend.calls[stopIdx + 1], 'clear');
  const addCmd = ctx.backend.calls[stopIdx + 2];
  assert.ok(addCmd.startsWith('add file:///home/hari007/Music/album/'), `path stays a file:// URL: ${addCmd}`);
  const addPath = addCmd.slice(addCmd.indexOf(' ') + 1);
  assert.ok(!addPath.includes(' '), `no raw spaces in the path portion: ${addPath}`);
  assert.equal(ctx.backend.calls[stopIdx + 3], 'volume 205'); // 0.8 * 256
});

test('pause freezes position, resume continues from it, stop resets', async () => {
  const ctx = setup();
  await ctx.player.play({ trackId: ctx.firstTrackId });
  ctx.advanceClock(30_000);
  const paused = await ctx.player.pause();
  assert.equal(paused.phase, 'paused');
  assert.equal(paused.positionMs, 30_000);

  ctx.advanceClock(60_000); // wall time passes while paused
  assert.equal(ctx.player.status().positionMs, 30_000, 'paused position does not drift');

  const resumed = await ctx.player.resume();
  assert.equal(resumed.phase, 'playing');
  ctx.advanceClock(5_000);
  assert.equal(ctx.player.status().positionMs, 35_000);

  const stopped = await ctx.player.stop();
  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.track, null);
  assert.equal(stopped.positionMs, 0);
});

test('transport rejects invalid state transitions honestly', async () => {
  const ctx = setup();
  await assert.rejects(() => ctx.player.pause(), (error) => error.code === 'INVALID_STATE');
  await assert.rejects(() => ctx.player.resume(), (error) => error.code === 'INVALID_STATE');
  await ctx.player.play({ trackId: ctx.firstTrackId });
  await assert.rejects(() => ctx.player.resume(), (error) => error.code === 'INVALID_STATE');
  await ctx.player.stop();
  await assert.rejects(() => ctx.player.pause(), (error) => error.code === 'INVALID_STATE');
});

test('next and previous navigate the queue and wrap; previous restarts a fresh track', async () => {
  const ctx = setup({ trackCount: 3 });
  await ctx.player.play({ trackId: ctx.firstTrackId });
  const next = await ctx.player.next();
  assert.equal(next.track.id, ctx.secondTrackId);

  const back = await ctx.player.previous();
  assert.equal(back.track.id, ctx.firstTrackId);

  // Wrap backwards from the head to the tail.
  const wrapped = await ctx.player.previous();
  assert.equal(wrapped.track.id, ctx.lastTrackId);

  const wrappedForward = await ctx.player.next();
  assert.equal(wrappedForward.track.id, ctx.firstTrackId);

  // Deep into the current track, previous means "restart this track".
  await ctx.player.play({ trackId: ctx.firstTrackId });
  ctx.advanceClock(10_000);
  const restarted = await ctx.player.previous();
  assert.equal(restarted.track.id, ctx.firstTrackId);
  assert.equal(restarted.positionMs, 0);
});

test('settings validate strictly; mute forces volume 0 and is never auto-restored', async () => {
  const ctx = setup();
  // updateSettings validates synchronously → assert.throws, not rejects.
  assert.throws(
    () => ctx.player.updateSettings({ volume: 1.5 }),
    (error) => error.code === 'INVALID_VOLUME',
  );
  assert.throws(
    () => ctx.player.updateSettings({ muted: 'yes' }),
    (error) => error.code === 'INVALID_MUTED',
  );
  assert.throws(
    () => ctx.player.updateSettings({ shuffle: 1 }),
    (error) => error.code === 'INVALID_SHUFFLE',
  );

  await ctx.player.play({ trackId: ctx.firstTrackId });
  ctx.backend.calls.length = 0;
  const mutedState = ctx.player.updateSettings({ volume: 0.4, muted: true });
  assert.equal(mutedState.muted, true);
  assert.equal(mutedState.volume, 0.4);
  assert.ok(ctx.backend.calls.includes('volume 0'), 'mute drives output to zero');

  const unmuted = ctx.player.updateSettings({ muted: false });
  assert.equal(unmuted.muted, false);
  assert.ok(ctx.backend.calls.includes('volume 102'), 'unmute restores 0.4 * 256');
});

test('shuffle rebuilds the queue around the current track', async () => {
  const ctx = setup({ trackCount: 8 });
  await ctx.player.play({ trackId: ctx.firstTrackId });
  const state = ctx.player.updateSettings({ shuffle: true });
  assert.equal(state.shuffle, true);
  assert.equal(state.queueLength, 8);
  assert.equal(state.track.id, ctx.firstTrackId, 'current track stays pinned at the head');
});

test('duck lowers music under speech and unduck restores the level', async () => {
  const ctx = setup();
  await ctx.player.play({ trackId: ctx.firstTrackId });
  ctx.backend.calls.length = 0;
  const ducked = ctx.player.duck({ durationMs: 400 });
  assert.equal(ducked.ducked, true);
  assert.ok(ctx.backend.calls.includes('volume 61'), `0.8*0.3*256 ≈ 61, saw ${ctx.backend.calls}`);

  const restored = ctx.player.unduck();
  assert.equal(restored.ducked, false);
  assert.ok(ctx.backend.calls.includes('volume 205'), 'previous level restored');

  // Muted music stays muted through duck/restore cycles.
  ctx.player.updateSettings({ muted: true });
  ctx.backend.calls.length = 0;
  ctx.player.duck({ durationMs: 400 });
  ctx.player.unduck();
  assert.ok(!ctx.backend.calls.some((command) => command !== 'volume 0'), 'mute is never overridden');
});

test('auto-advance moves to the next track at the end and stops after a single-track queue', async () => {
  const ctx = setup({ trackCount: 3 });
  await ctx.player.play({ trackId: ctx.firstTrackId });
  ctx.advanceClock(169_846 + 100);
  const advanced = await ctx.player.tick();
  assert.equal(advanced, true);
  assert.equal(ctx.player.status().track.id, ctx.secondTrackId, 'queue advanced');

  // Mid-track ticks do nothing.
  const midTrack = await ctx.player.tick();
  assert.equal(midTrack, false);

  // Single-track queue ends cleanly instead of looping.
  const solo = setup({ trackCount: 1 });
  await solo.player.play({ trackId: solo.firstTrackId });
  solo.advanceClock(169_846 + 100);
  await solo.player.tick();
  assert.equal(solo.player.status().phase, 'stopped');
});

test('a crashed backend downgrades to stopped with an honest error and can respawn', async () => {
  const ctx = setup();
  await ctx.player.play({ trackId: ctx.firstTrackId });
  const child = ctx.backend.children[0];
  child.exitCode = 1;
  child.emit('exit', 1, null);

  const state = ctx.player.status();
  assert.equal(state.phase, 'stopped');
  assert.equal(state.track, null);
  assert.match(state.lastError, /exited unexpectedly/);
  assert.equal(state.engine.available, false);

  // Next play respawns and works.
  const respawned = await ctx.player.play({ trackId: ctx.firstTrackId });
  assert.equal(respawned.phase, 'playing');
  assert.equal(ctx.backend.children.length, 2);
});

test('a missing cvlc binary reports Needs-setup-level honesty, never a crash', async () => {
  const ctx = setup({ backend: { failSpawn: true } });
  await assert.rejects(
    () => ctx.player.play({ trackId: ctx.firstTrackId }),
    (error) => error.code === 'ENGINE_UNAVAILABLE',
  );
  const state = ctx.player.status();
  assert.equal(state.engine.available, false);
  assert.match(state.engine.detail, /install VLC/);
  assert.equal(state.phase, 'stopped');
});

test('dispose quits the child and clears all state', async () => {
  const ctx = setup();
  await ctx.player.play({ trackId: ctx.firstTrackId });
  ctx.player.dispose();
  assert.ok(ctx.backend.calls.some((command) => command.includes('quit')), 'RC quit sent to the child');
  const state = ctx.player.status();
  assert.equal(state.phase, 'stopped');
  assert.equal(state.track, null);
});
