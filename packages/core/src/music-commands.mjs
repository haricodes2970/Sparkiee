/**
 * Deterministic natural-language music commands.
 *
 * Pure text → intent parsing, plus an executor that talks to the playback
 * engine and library. No generative model is involved: recognised text is
 * never sent to an AI provider, and no audio or library contents ever leave
 * the machine.
 *
 * Safety properties:
 * - The parser only produces intents; the executor only ever passes opaque
 *   track ids and validated numbers to the player. Recognised song names
 *   become search queries, never commands or paths.
 * - Play resolution follows the product rule: an unambiguous exact or strong
 *   match is selected, several matches ask the user which they meant, a
 *   fuzzy near-miss is only offered as a suggestion, and no match says so.
 * - Every result carries a truthful `executed` flag — replies are only
 *   spoken after the engine confirms the action.
 */

import { normalizeForMatch, SEARCH_FILLER_WORDS } from './music-library.mjs';

/** Strip a leading wake word: "Yo Spark, …", "Sparky …". */
export function stripWakePrefix(text) {
  return String(text ?? '')
    .replace(/^(?:yo[\s,]+spark|sparky|spark)(?:[\s,:!?]+|$)/i, '')
    .trim();
}

/** Preprocess raw command text into a matchable form. */
export function normalizeCommandText(text) {
  const stripped = stripWakePrefix(text)
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim()
    .toLowerCase();
  return stripped;
}

const PATTERNS = {
  // Order matters: specific intents must win over the generic play verb
  // ("play the next song" is next, not a search for a song named "next song").
  volumeSet: /(?:set|turn|change)\s+(?:the\s+)?(?:music\s+)?volume\s+to\s+(\d{1,3})\s*(?:percent|%)|^volume\s+(?:to\s+)?(\d{1,3})\s*(?:percent|%)$/,
  volumeDown: /(?:turn|make|bring|put)\s+(?:it|the\s+music|the\s+volume|music|volume)\s+(?:down|lower)|^volume\s+down$|quieter/,
  volumeUp: /(?:turn|make|bring|put)\s+(?:it|the\s+music|the\s+volume|music|volume)\s+(?:up|higher|louder)|^volume\s+up$|louder/,
  next: /^(?:next|skip)(?:\s+(?:the\s+)?(?:song|track|music|one))?$|^play\s+(?:the\s+)?(?:next|another)\s+(?:song|track|music)$/,
  previous: /^(?:previous|prev|back|go\s+back)(?:\s+(?:the\s+)?(?:song|track|music))?$|^play\s+(?:the\s+)?(?:previous|last)\s+(?:song|track)$|^last\s+song$/,
  shuffle: /^shuffle(?:\s+(?:my\s+|the\s+)?(?:music|songs|playlist))?$|^randomi[sz]e(?:\s+(?:my\s+)?music)?$/,
  status: /^(?:what|whats|what's)\s+(?:\w+\s+)?(?:is\s+)?playing$|^now\s+playing$|^what\s+am\s+i\s+listening\s+to$/,
  pause: /^pause(?:\s+(?:the\s+)?(?:music|track|song))?(?:\s+it)?$/,
  resume: /^(?:resume|unpause|continue)(?:\s+(?:the\s+)?(?:music|track|song))?(?:\s+it)?$|^keep\s+(?:playing|going)$|^go\s+on$/,
  stop: /^(?:stop|halt)(?:\s+(?:the\s+)?(?:music|track|song|player))?(?:\s+it)?$/,
  find: /^(?:find|search(?:\s+for)?|look\s+up|show\s+me)\s+(?:the\s+)?(?:song\s+|track\s+)?(.+)$/,
  play: /^(?:play|put\s+on)(?:\s+(?:the|some|my))?(?:\s+(?:music|track|song|album))?(?:\s+(.+))?$/,
};

/**
 * Parse recognised text into a music intent.
 * Returns null when the text is not a music command (callers must treat
 * that as "unhandled" — never guess an action).
 *
 * @param {string} text Raw text (may include the wake word).
 * @returns {{intent: string, query?: string, value?: number}|null}
 */
export function parseMusicIntent(text) {
  const normalized = normalizeCommandText(text);
  if (!normalized) return null;

  let match = normalized.match(PATTERNS.volumeSet);
  if (match) {
    const raw = Number(match[1] ?? match[2]);
    return { intent: 'volume', mode: 'set', value: raw };
  }
  if (PATTERNS.volumeDown.test(normalized)) return { intent: 'volume', mode: 'down' };
  if (PATTERNS.volumeUp.test(normalized)) return { intent: 'volume', mode: 'up' };
  if (PATTERNS.next.test(normalized)) return { intent: 'next' };
  if (PATTERNS.previous.test(normalized)) return { intent: 'previous' };
  if (PATTERNS.shuffle.test(normalized)) return { intent: 'shuffle' };
  if (PATTERNS.status.test(normalized)) return { intent: 'status' };
  if (PATTERNS.pause.test(normalized)) return { intent: 'pause' };
  if (PATTERNS.resume.test(normalized)) return { intent: 'resume' };
  if (PATTERNS.stop.test(normalized)) return { intent: 'stop' };
  match = normalized.match(PATTERNS.find);
  if (match && match[1]?.trim()) return { intent: 'find', query: match[1].trim() };
  match = normalized.match(PATTERNS.play);
  if (match) {
    const query = match[1]?.trim();
    return query ? { intent: 'play', query } : { intent: 'play' };
  }
  return null;
}

/** Content words only — "the madira" resolves like "madira". */
function effectiveQuery(query) {
  const normalized = normalizeForMatch(query);
  const tokens = normalized.split(' ').filter(Boolean);
  const content = tokens.filter((token) => !SEARCH_FILLER_WORDS.has(token));
  return (content.length > 0 ? content : tokens).join(' ');
}

function capNames(tracks, max = 3) {
  const names = tracks.slice(0, max).map((track) => track.name);
  if (tracks.length > max) return `${names.join(', ')} and more`;
  return names.join(', ');
}

function executed(result, reply, extra = {}) {
  return { executed: true, reply, ...extra };
}

function notExecuted(reply, extra = {}) {
  return { executed: false, reply, ...extra };
}

/** Reply for a transport/setting failure, using the engine's honest message. */
function failureReply(error) {
  switch (error?.code) {
    case 'INVALID_STATE':
    case 'TRACK_NOT_FOUND':
    case 'INVALID_VOLUME':
    case 'INVALID_MUTED':
    case 'INVALID_SHUFFLE':
    case 'ENGINE_UNAVAILABLE':
      return error.message;
    default:
      return 'That music command did not work.';
  }
}

async function safeRun(action) {
  try {
    return { ok: true, state: await action() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Resolve a play query against the indexed library — the product rule.
 *
 * @returns {{status: string, track?: object, candidates?: object[], suggestions?: object[]}}
 */
async function resolvePlayQuery(query, searchRanked) {
  const ranked = await searchRanked(query, { limit: 10 });
  const available = ranked.filter((track) => track.available);
  const exactQuery = effectiveQuery(query);

  const pickTier = (tier) => available.filter((track) => track.tier === tier);

  for (const tier of ['exact', 'strong', 'tokens']) {
    const matches = tier === 'exact'
      // Filler-stripped equality against title or display name (which falls
      // back to the filename stem for untagged files): "the madira" counts
      // as exact for Madira.
      ? available.filter((track) => {
        const title = normalizeForMatch(track.title || '');
        const name = normalizeForMatch(track.name || '');
        return title === exactQuery || name === exactQuery;
      })
      : pickTier(tier);
    if (matches.length === 1) return { status: 'matched', track: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
  }

  const unavailableMatches = ranked.filter((track) => !track.available);
  if (unavailableMatches.length > 0) {
    return { status: 'unavailable', track: unavailableMatches[0] };
  }
  // Fuzzy near-misses are suggestions, never automatic selections.
  const fuzzy = ranked.filter((track) => track.tier === 'fuzzy' && track.available);
  if (fuzzy.length > 0) return { status: 'not_found', suggestions: fuzzy.slice(0, 3) };
  return { status: 'not_found', suggestions: [] };
}

/**
 * Execute a parsed music intent against the engine + library.
 *
 * @param {object} intent From parseMusicIntent.
 * @param {object} deps
 * @param {object} deps.player Playback engine facade (play/pause/…/status).
 * @param {(q: {query: string, limit?: number}) => Promise<{tracks: object[]}>} deps.searchRanked
 * @returns {Promise<{executed: boolean, reply: string, playback?: object, candidates?: object[], matches?: object[]}>}
 */
export async function runMusicCommand(intent, { player, searchRanked }) {
  if (!intent || typeof intent !== 'object') {
    return notExecuted('I did not catch a music command.');
  }

  switch (intent.intent) {
    case 'play': {
      if (!intent.query) {
        const current = player.status();
        if (current.phase === 'paused') {
          const resumed = await safeRun(() => player.resume());
          if (!resumed.ok) return notExecuted(failureReply(resumed.error), { playback: player.status() });
          return executed(resumed.state, 'Resuming.', { playback: resumed.state });
        }
        if (current.phase === 'playing') {
          return executed(current, 'Music is already playing.', { playback: current });
        }
        return notExecuted('What should I play? Try: play Madira.', { playback: current });
      }

      const resolved = await resolvePlayQuery(intent.query, searchRanked);
      if (resolved.status === 'ambiguous') {
        const count = resolved.candidates.length > 5 ? 'several' : resolved.candidates.length;
        return notExecuted(
          `I found ${count} matches: ${capNames(resolved.candidates)}. Which one do you mean?`,
          { candidates: resolved.candidates.slice(0, 5) },
        );
      }
      if (resolved.status === 'unavailable') {
        return notExecuted(`I found ${resolved.track.name}, but its file is missing from your music folder.`);
      }
      if (resolved.status === 'not_found') {
        const suggestion = resolved.suggestions[0];
        return notExecuted(
          suggestion
            ? `I could not find ${intent.query}. Did you mean ${suggestion.name}?`
            : `I could not find ${intent.query} in your music.`,
          { suggestions: resolved.suggestions },
        );
      }

      const started = await safeRun(() => player.play({ trackId: resolved.track.id }));
      if (!started.ok) return notExecuted(failureReply(started.error), { playback: player.status() });
      return executed(started.state, `Okay! Playing ${resolved.track.name}.`, {
        track: resolved.track,
        playback: started.state,
      });
    }

    case 'pause': {
      const result = await safeRun(() => player.pause());
      if (!result.ok) return notExecuted(failureReply(result.error), { playback: player.status() });
      return executed(result.state, 'Paused.', { playback: result.state });
    }

    case 'resume': {
      const result = await safeRun(() => player.resume());
      if (!result.ok) return notExecuted(failureReply(result.error), { playback: player.status() });
      return executed(result.state, 'Resuming.', { playback: result.state });
    }

    case 'stop': {
      const result = await safeRun(() => player.stop());
      if (!result.ok) return notExecuted(failureReply(result.error), { playback: player.status() });
      return executed(result.state, 'Stopped.', { playback: result.state });
    }

    case 'next':
    case 'previous': {
      const verb = intent.intent === 'next' ? 'next' : 'previous';
      const result = await safeRun(() => player[intent.intent]());
      if (!result.ok) return notExecuted(failureReply(result.error), { playback: player.status() });
      const track = result.state?.track;
      if (result.state?.phase === 'playing' && track) {
        return executed(result.state, `Playing ${track.name}.`, { playback: result.state });
      }
      return notExecuted(`There is no ${verb} track to play.`, { playback: result.state });
    }

    case 'volume': {
      if (intent.mode === 'set') {
        if (!Number.isInteger(intent.value) || intent.value < 0 || intent.value > 100) {
          return notExecuted('Volume must be between 0 and 100 percent.', { playback: player.status() });
        }
        const result = await safeRun(() => player.updateSettings({ volume: intent.value / 100 }));
        if (!result.ok) return notExecuted(failureReply(result.error), { playback: player.status() });
        return executed(result.state, `Music volume set to ${intent.value} percent.`, { playback: result.state });
      }
      const current = player.status();
      const delta = intent.mode === 'up' ? 0.1 : -0.1;
      const nextVolume = Math.min(1, Math.max(0, Math.round((current.volume + delta) * 10) / 10));
      if (nextVolume === current.volume) {
        const edge = intent.mode === 'up' ? 'already at maximum.' : 'already at zero.';
        return executed(current, `Music is ${edge}`, { playback: current });
      }
      const result = await safeRun(() => player.updateSettings({ volume: nextVolume }));
      if (!result.ok) return notExecuted(failureReply(result.error), { playback: player.status() });
      const pct = Math.round(nextVolume * 100);
      return executed(result.state, `Music volume ${intent.mode === 'up' ? 'up' : 'down'} to ${pct} percent.`, {
        playback: result.state,
      });
    }

    case 'shuffle': {
      const result = await safeRun(() => player.updateSettings({ shuffle: true }));
      if (!result.ok) return notExecuted(failureReply(result.error), { playback: player.status() });
      if (result.state.phase !== 'stopped') {
        return executed(result.state, 'Shuffling. The next track will be random.', { playback: result.state });
      }
      // Not playing yet: start from the head of the shuffled queue.
      const started = await safeRun(() => player.next());
      if (!started.ok) return executed(result.state, 'Shuffle is on, but there is nothing to play.', { playback: player.status() });
      if (started.state?.phase !== 'playing') {
        return executed(result.state, 'Shuffle is on, but your library has no tracks yet.', { playback: started.state });
      }
      return executed(started.state, `Shuffling! Playing ${started.state.track?.name ?? 'your music'}.`, {
        playback: started.state,
      });
    }

    case 'status': {
      const state = player.status();
      if ((state.phase === 'playing' || state.phase === 'paused') && state.track) {
        const artist = state.track.artist ? ` by ${state.track.artist}` : '';
        const paused = state.phase === 'paused' ? ' (paused)' : '';
        return executed(state, `Playing ${state.track.name}${artist}${paused}.`, { playback: state });
      }
      return executed(state, 'Nothing is playing right now.', { playback: state });
    }

    case 'find': {
      const { tracks = [] } = await searchRanked(intent.query, { limit: 10 }).then(
        (results) => ({ tracks: results }),
        () => ({ tracks: [] }),
      );
      const available = tracks.filter((track) => track.available);
      if (available.length === 0) {
        if (tracks.length > 0) {
          return notExecuted(`I found ${tracks[0].name}, but its file is missing from your music folder.`, {
            matches: tracks,
          });
        }
        return notExecuted(`I could not find anything like ${intent.query}.`, { matches: [] });
      }
      if (available.length === 1) {
        return executed({ phase: null }, `Found ${available[0].name}.`, { matches: available });
      }
      const shown = available.length >= 10
        ? 'at least 10 tracks'
        : available.length > 5
          ? `${available.length} tracks`
          : capNames(available, 5);
      return executed({ phase: null }, `Found ${shown} matching ${intent.query}.`, { matches: available });
    }

    default:
      return notExecuted('I did not catch a music command.');
  }
}
