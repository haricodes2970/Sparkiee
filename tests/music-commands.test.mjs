import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMusicIntent, runMusicCommand, normalizeCommandText, stripWakePrefix } from '../packages/core/src/music-commands.mjs';

// ---------------------------------------------------------------------------
// Parser: every product phrase, wake-word stripping, and hard non-matches.
// ---------------------------------------------------------------------------

test('wake word and punctuation strip cleanly before matching', () => {
  assert.equal(stripWakePrefix('Yo Spark, play Madira'), 'play Madira');
  assert.equal(stripWakePrefix('yo spark play Madira'), 'play Madira');
  assert.equal(stripWakePrefix('Sparky, pause'), 'pause');
  assert.equal(stripWakePrefix('play Madira'), 'play Madira');
  assert.equal(normalizeCommandText('  PAUSE!!! '), 'pause');
  assert.equal(normalizeCommandText('spark'), '');
});

test('all documented music phrases parse to the right intents', () => {
  assert.deepEqual(parseMusicIntent('Yo Spark, play Madira.'), { intent: 'play', query: 'madira' });
  assert.deepEqual(parseMusicIntent('play Madira'), { intent: 'play', query: 'madira' });
  assert.deepEqual(parseMusicIntent('pause the music'), { intent: 'pause' });
  assert.deepEqual(parseMusicIntent('pause'), { intent: 'pause' });
  assert.deepEqual(parseMusicIntent('resume'), { intent: 'resume' });
  assert.deepEqual(parseMusicIntent('stop the music'), { intent: 'stop' });
  assert.deepEqual(parseMusicIntent('stop'), { intent: 'stop' });
  assert.deepEqual(parseMusicIntent('next song'), { intent: 'next' });
  assert.deepEqual(parseMusicIntent('play the next song'), { intent: 'next' }, 'next must beat the play verb');
  assert.deepEqual(parseMusicIntent('previous song'), { intent: 'previous' });
  assert.deepEqual(parseMusicIntent('play the previous song'), { intent: 'previous' });
  assert.deepEqual(parseMusicIntent('go back'), { intent: 'previous' });
  assert.deepEqual(parseMusicIntent('turn the music down'), { intent: 'volume', mode: 'down' });
  assert.deepEqual(parseMusicIntent('turn the music up'), { intent: 'volume', mode: 'up' });
  assert.deepEqual(parseMusicIntent('set music volume to 40 percent'), { intent: 'volume', mode: 'set', value: 40 });
  assert.deepEqual(parseMusicIntent('volume to 40%'), { intent: 'volume', mode: 'set', value: 40 });
  assert.deepEqual(parseMusicIntent('what song is playing?'), { intent: 'status' });
  assert.deepEqual(parseMusicIntent("what's playing"), { intent: 'status' });
  assert.deepEqual(parseMusicIntent('find Nanchaku'), { intent: 'find', query: 'nanchaku' });
  assert.deepEqual(parseMusicIntent('shuffle my music'), { intent: 'shuffle' });
  assert.deepEqual(parseMusicIntent('shuffle'), { intent: 'shuffle' });
  assert.deepEqual(parseMusicIntent('play'), { intent: 'play' });
  assert.deepEqual(parseMusicIntent('play the music'), { intent: 'play' });
  assert.deepEqual(parseMusicIntent('Yo Spark, play Lunch Break.'), { intent: 'play', query: 'lunch break' });
});

test('non-music text never becomes an intent', () => {
  assert.equal(parseMusicIntent('open vscode'), null);
  assert.equal(parseMusicIntent('what is OpenCode doing'), null);
  assert.equal(parseMusicIntent('spark'), null);
  assert.equal(parseMusicIntent('sparkle me this'), null);
  assert.equal(parseMusicIntent(''), null);
  assert.equal(parseMusicIntent(null), null);
  assert.equal(parseMusicIntent('delete my documents'), null);
});

// ---------------------------------------------------------------------------
// Runner: truthful executed flags, ambiguity, and safe resolution.
// ---------------------------------------------------------------------------

function track(overrides = {}) {
  return {
    id: '45cacd0ef916f24f',
    name: 'Madira',
    title: 'Madira',
    artist: null,
    album: null,
    durationMs: 169_846,
    sizeBytes: 5_587_341,
    file: 'Madira.mp3',
    available: true,
    tier: 'exact',
    ...overrides,
  };
}

function fakePlayer({ phase = 'stopped', currentTrack = null, volume = 0.8, playError = null, pauseError = null } = {}) {
  const calls = [];
  const base = (extra) => ({
    phase,
    track: currentTrack,
    positionMs: 0,
    durationMs: currentTrack?.durationMs ?? null,
    volume,
    muted: false,
    shuffle: false,
    ducked: false,
    queueLength: 3,
    engine: { backend: 'cvlc', available: true, detail: null },
    lastError: null,
    ...extra,
  });
  return {
    calls,
    statusValue: base(),
    player: {
      status: () => base(),
      play: async ({ trackId }) => {
        calls.push(['play', trackId]);
        if (playError) throw playError;
        return base({ phase: 'playing', track: currentTrack ?? track() });
      },
      pause: async () => {
        calls.push(['pause']);
        if (pauseError) throw pauseError;
        return base({ phase: 'paused' });
      },
      resume: async () => {
        calls.push(['resume']);
        return base({ phase: 'playing' });
      },
      stop: async () => {
        calls.push(['stop']);
        return base({ phase: 'stopped', track: null, positionMs: 0 });
      },
      next: async () => {
        calls.push(['next']);
        return base({ phase: 'playing', track: currentTrack ?? track() });
      },
      previous: async () => {
        calls.push(['previous']);
        return base({ phase: 'playing', track: currentTrack ?? track() });
      },
      updateSettings: async (partial) => {
        calls.push(['settings', partial]);
        return base({ ...partial });
      },
    },
  };
}

function searcher(results) {
  return async () => results;
}

test('one safe exact match plays and gets a truthful confirmation', async () => {
  const ctx = fakePlayer();
  const result = await runMusicCommand(
    { intent: 'play', query: 'madira' },
    { player: ctx.player, searchRanked: searcher([track()]) },
  );
  assert.equal(result.executed, true);
  assert.equal(result.reply, 'Okay! Playing Madira.');
  assert.deepEqual(ctx.calls[0], ['play', '45cacd0ef916f24f']);
  assert.equal(result.playback.phase, 'playing');
});

test('filler words still resolve exactly: "the madira" plays Madira', async () => {
  const ctx = fakePlayer();
  const result = await runMusicCommand(
    { intent: 'play', query: 'the madira' },
    { player: ctx.player, searchRanked: searcher([track({ tier: 'tokens' })]) },
  );
  assert.equal(result.executed, true);
  assert.equal(result.reply, 'Okay! Playing Madira.');
});

test('several matches ask instead of guessing — nothing plays', async () => {
  const ctx = fakePlayer();
  const result = await runMusicCommand(
    { intent: 'play', query: 'madira' },
    {
      player: ctx.player,
      searchRanked: searcher([
        track({ id: 'aaaaaaaaaaaaaaaa', name: 'Madira', file: 'Madira.mp3' }),
        track({ id: 'bbbbbbbbbbbbbbbb', name: 'Madira', file: 'live/Madira.mp3', tier: 'tokens' }),
      ]),
    },
  );
  assert.equal(result.executed, false);
  assert.match(result.reply, /2 matches: Madira, Madira\. Which one do you mean\?/);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(ctx.calls, [], 'no track is selected on ambiguity');
});

test('a fuzzy near-miss is offered, never auto-played', async () => {
  const ctx = fakePlayer();
  const result = await runMusicCommand(
    { intent: 'play', query: 'madiraa' },
    { player: ctx.player, searchRanked: searcher([track({ tier: 'fuzzy' })]) },
  );
  assert.equal(result.executed, false);
  assert.match(result.reply, /Did you mean Madira\?/);
  assert.deepEqual(ctx.calls, [], 'weak matches never play');
});

test('no match says so honestly', async () => {
  const ctx = fakePlayer();
  const result = await runMusicCommand(
    { intent: 'play', query: 'utterly unknown' },
    { player: ctx.player, searchRanked: searcher([]) },
  );
  assert.equal(result.executed, false);
  assert.equal(result.reply, 'I could not find utterly unknown in your music.');
  assert.deepEqual(ctx.calls, []);
});

test('a matched-but-missing file reports the truth instead of playing', async () => {
  const ctx = fakePlayer();
  const result = await runMusicCommand(
    { intent: 'play', query: 'madira' },
    { player: ctx.player, searchRanked: searcher([track({ available: false })]) },
  );
  assert.equal(result.executed, false);
  assert.match(result.reply, /file is missing from your music folder/);
  assert.deepEqual(ctx.calls, []);
});

test('bare play resumes when paused and asks what to play when stopped', async () => {
  const paused = fakePlayer({ phase: 'paused' });
  const resumeResult = await runMusicCommand(
    { intent: 'play' },
    { player: paused.player, searchRanked: searcher([]) },
  );
  assert.equal(resumeResult.executed, true);
  assert.equal(resumeResult.reply, 'Resuming.');
  assert.deepEqual(paused.calls[0], ['resume']);

  const stopped = fakePlayer({ phase: 'stopped' });
  const askResult = await runMusicCommand(
    { intent: 'play' },
    { player: stopped.player, searchRanked: searcher([]) },
  );
  assert.equal(askResult.executed, false);
  assert.match(askResult.reply, /What should I play\?/);
  assert.deepEqual(stopped.calls, []);
});

test('engine state conflicts reply with the engine\'s own honest words', async () => {
  const stopped = fakePlayer({ pauseError: Object.assign(new Error('Nothing is playing right now.'), { code: 'INVALID_STATE' }) });
  const pauseResult = await runMusicCommand({ intent: 'pause' }, { player: stopped.player, searchRanked: searcher([]) });
  assert.equal(pauseResult.executed, false);
  assert.equal(pauseResult.reply, 'Nothing is playing right now.');

  const noVlc = fakePlayer({ pauseError: Object.assign(new Error('cvlc not found — install VLC to play music.'), { code: 'ENGINE_UNAVAILABLE' }) });
  const engineResult = await runMusicCommand({ intent: 'pause' }, { player: noVlc.player, searchRanked: searcher([]) });
  assert.equal(engineResult.executed, false);
  assert.match(engineResult.reply, /install VLC/);
});

test('volume bounds are enforced before touching the engine', async () => {
  const ctx = fakePlayer();
  const tooHigh = await runMusicCommand(
    { intent: 'volume', mode: 'set', value: 150 },
    { player: ctx.player, searchRanked: searcher([]) },
  );
  assert.equal(tooHigh.executed, false);
  assert.equal(tooHigh.reply, 'Volume must be between 0 and 100 percent.');
  assert.deepEqual(ctx.calls, []);

  const ok = await runMusicCommand(
    { intent: 'volume', mode: 'set', value: 40 },
    { player: ctx.player, searchRanked: searcher([]) },
  );
  assert.equal(ok.executed, true);
  assert.equal(ok.reply, 'Music volume set to 40 percent.');
  assert.deepEqual(ctx.calls[0], ['settings', { volume: 0.4 }]);
});

test('relative volume steps clamp at the edges', async () => {
  const loud = fakePlayer({ volume: 0.8 });
  const up = await runMusicCommand({ intent: 'volume', mode: 'up' }, { player: loud.player, searchRanked: searcher([]) });
  assert.equal(up.reply, 'Music volume up to 90 percent.');

  const max = fakePlayer({ volume: 1 });
  const edge = await runMusicCommand({ intent: 'volume', mode: 'up' }, { player: max.player, searchRanked: searcher([]) });
  assert.equal(edge.executed, true);
  assert.match(edge.reply, /already at maximum/);
  assert.deepEqual(max.calls, []);
});

test('status answers with the real track or honest silence', async () => {
  const playing = fakePlayer({
    phase: 'paused',
    currentTrack: track({ artist: 'Seedhe Maut' }),
  });
  const busy = await runMusicCommand({ intent: 'status' }, { player: playing.player, searchRanked: searcher([]) });
  assert.equal(busy.reply, 'Playing Madira by Seedhe Maut (paused).');

  const idle = fakePlayer({ phase: 'stopped' });
  const quiet = await runMusicCommand({ intent: 'status' }, { player: idle.player, searchRanked: searcher([]) });
  assert.equal(quiet.reply, 'Nothing is playing right now.');
});

test('find lists matches without starting playback', async () => {
  const ctx = fakePlayer();
  const one = await runMusicCommand(
    { intent: 'find', query: 'madira' },
    { player: ctx.player, searchRanked: searcher([track()]) },
  );
  assert.equal(one.executed, true);
  assert.equal(one.reply, 'Found Madira.');
  assert.equal(one.matches.length, 1);

  const many = await runMusicCommand(
    { intent: 'find', query: 'm' },
    {
      player: ctx.player,
      searchRanked: searcher([
        track({ id: 'aaaaaaaaaaaaaaaa', name: 'Madira' }),
        track({ id: 'bbbbbbbbbbbbbbbb', name: 'Nanchaku' }),
        track({ id: 'cccccccccccccccc', name: 'Khauf' }),
      ]),
    },
  );
  assert.match(many.reply, /^Found Madira, Nanchaku, Khauf matching m\.$/);

  const none = await runMusicCommand(
    { intent: 'find', query: 'zzz' },
    { player: ctx.player, searchRanked: searcher([]) },
  );
  assert.equal(none.executed, false);
  assert.match(none.reply, /could not find anything like zzz/);
  assert.deepEqual(ctx.calls, [], 'find never plays');
});

test('shuffle starts a stopped player from the shuffled queue head', async () => {
  const ctx = fakePlayer({ phase: 'stopped' });
  const result = await runMusicCommand({ intent: 'shuffle' }, { player: ctx.player, searchRanked: searcher([]) });
  assert.equal(result.executed, true);
  assert.deepEqual(ctx.calls, [['settings', { shuffle: true }], ['next']]);
  assert.match(result.reply, /^Shuffling! Playing /);

  const already = fakePlayer({ phase: 'playing', currentTrack: track() });
  const during = await runMusicCommand({ intent: 'shuffle' }, { player: already.player, searchRanked: searcher([]) });
  assert.equal(during.executed, true);
  assert.deepEqual(already.calls, [['settings', { shuffle: true }]], 'playing track keeps playing');
});

test('next reports honestly when there is nothing to advance to', async () => {
  const ctx = fakePlayer();
  ctx.player.next = async () => {
    ctx.calls.push(['next']);
    return { phase: 'stopped', track: null, queueLength: 0, volume: 0.8 };
  };
  const result = await runMusicCommand({ intent: 'next' }, { player: ctx.player, searchRanked: searcher([]) });
  assert.equal(result.executed, false);
  assert.match(result.reply, /no next track/);
});

test('stop always succeeds and confirms', async () => {
  const ctx = fakePlayer({ phase: 'playing', currentTrack: track() });
  const result = await runMusicCommand({ intent: 'stop' }, { player: ctx.player, searchRanked: searcher([]) });
  assert.equal(result.executed, true);
  assert.equal(result.reply, 'Stopped.');
  assert.deepEqual(ctx.calls, [['stop']]);
});
