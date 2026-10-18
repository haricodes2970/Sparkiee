/**
 * Music playback engine — daemon-hosted, single instance.
 *
 * Architecture: the daemon owns one long-lived `cvlc --intf rc` child and
 * drives it over the RC line protocol. Keeping playback in the daemon (not
 * the Electron renderer) means the music survives every desktop↔dashboard
 * presentation transition, exactly one player can exist per runtime, and no
 * native Node audio dependency is required. The daemon never blocks on I/O —
 * the child does the decoding and the PipeWire output.
 *
 * Safety: play requests carry opaque track ids only. The id is resolved
 * through the library's containment-checked path (realpath inside the music
 * root, regular file) before the path reaches the RC `add` command, and the
 * path is passed as a file:// URL so spaces and metacharacters in filenames
 * can never be interpreted as commands.
 *
 * Audio policy: music volume is independent from chirp/TTS settings. Spoken
 * responses duck the music (default 30%) and restore the previous level;
 * mute forces output to zero without losing position and is never
 * auto-unmuted.
 */

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TRACK_ID_PATTERN = /^[0-9a-f]{16}$/;
const VLC_UNIT_GAIN = 256; // RC volume scale: 256 = 1.0 gain, 512 max

export const MUSIC_PHASES = Object.freeze(['stopped', 'playing', 'paused']);

function musicPlayerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {object} options
 * @param {object} options.library Music library (resolvePath + orderedTracks).
 * @param {Function} [options.spawnImpl] Backend spawner (injectable for tests).
 * @param {() => number} [options.now] Clock.
 * @param {string} [options.cvlcBinary] Backend binary name.
 * @param {boolean} [options.autoAdvance] Advance the queue at track end.
 */
export function createMusicPlayer({
  library,
  spawnImpl = spawn,
  now = () => Date.now(),
  cvlcBinary = 'cvlc',
  autoAdvance = true,
  queryTimeoutMs = 2000,
  duckFactor = 0.3,
} = {}) {
  let child = null;
  let stdoutBuffer = '';
  let engineDetail = null;
  let spawnAttempted = false;
  const pendingQueries = [];
  let phase = 'stopped';
  let currentTrackId = null;
  let positionMs = 0;
  let startedAt = 0;
  let runtimeDurationMs = null; // RC get_length fallback when ffprobe had none
  let volume = 0.8;
  let muted = false;
  let shuffle = false;
  let ducked = false;
  let lastError = null;
  let queue = []; // ordered track ids
  let queueIndex = -1;
  let advanceTimer = null;
  let duckTimer = null;

  function trackInfo(trackId) {
    const track = library.orderedTracks().find((candidate) => candidate.id === trackId);
    if (!track) return null;
    return {
      id: track.id,
      name: track.displayName,
      title: track.title,
      artist: track.artist,
      durationMs: track.durationMs,
    };
  }

  function rebuildQueue(startingAtId = null) {
    const ordered = library.orderedTracks().map((track) => track.id);
    if (shuffle) {
      for (let i = ordered.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      }
      if (startingAtId && ordered.includes(startingAtId)) {
        const at = ordered.indexOf(startingAtId);
        [ordered[0], ordered[at]] = [ordered[at], ordered[0]];
      }
    }
    queue = ordered;
    queueIndex = startingAtId && queue.includes(startingAtId)
      ? queue.indexOf(startingAtId)
      : Math.max(0, queueIndex);
    if (queueIndex < 0 || queueIndex >= queue.length) queueIndex = 0;
  }

  function ensureQueue() {
    const known = new Set(library.orderedTracks().map((track) => track.id));
    if (queue.length === 0 || queue.some((id) => !known.has(id))) rebuildQueue(currentTrackId);
  }

  function sendCommand(command) {
    if (!child || child.exitCode !== null || engineDetail) {
      throw musicPlayerError('ENGINE_UNAVAILABLE', engineDetail ?? 'Playback engine is not running.');
    }
    child.stdin.write(`${command}\n`);
  }

  /** RC query with a bounded wait; resolves null on timeout. */
  function query(command) {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null) {
        resolve(null);
        return;
      }
      let timer = null;
      const resolver = (value) => {
        clearTimeout(timer);
        const index = pendingQueries.indexOf(resolver);
        if (index >= 0) pendingQueries.splice(index, 1);
        resolve(value);
      };
      timer = setTimeout(() => {
        const index = pendingQueries.indexOf(resolver);
        if (index >= 0) pendingQueries.splice(index, 1);
        resolve(null);
      }, queryTimeoutMs);
      pendingQueries.push(resolver);
      child.stdin.write(`${command}\n`);
    });
  }

  function handleStdout(chunk) {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.replace(/^>\s*/, '').trim();
      if (/^-?\d+(\.\d+)?$/.test(trimmed) && pendingQueries.length > 0) {
        pendingQueries.shift()(Number(trimmed));
      }
    }
  }

  function ensureChild() {
    spawnAttempted = true;
    if (child && child.exitCode === null && !engineDetail) return child;
    child = null;
    let spawned;
    try {
      spawned = spawnImpl(cvlcBinary, ['--intf', 'rc', '--no-video', '--no-one-instance'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (error) {
      engineDetail = error?.code === 'ENOENT'
        ? `${cvlcBinary} not found — install VLC to play music.`
        : `Playback backend failed to start: ${error?.message ?? error}`;
      throw musicPlayerError('ENGINE_UNAVAILABLE', engineDetail);
    }
    child = spawned;
    stdoutBuffer = '';
    // Failures (ENOENT surfaces here, async) and EPIPE on stdin must never
    // crash the daemon — they downgrade the engine to an honest error state.
    child.on('error', (error) => {
      engineDetail = error?.code === 'ENOENT'
        ? `${cvlcBinary} not found — install VLC to play music.`
        : `Playback backend error: ${error?.message ?? error}`;
      child = null;
      if (phase !== 'stopped') {
        phase = 'stopped';
        positionMs = 0;
        currentTrackId = null;
        lastError = engineDetail;
      }
      stopAdvanceTimer();
    });
    child.stdin.on('error', () => { /* engine exit races are handled above */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', handleStdout);
    child.on('exit', () => {
      child = null;
      if (phase !== 'stopped') {
        phase = 'stopped';
        positionMs = 0;
        currentTrackId = null;
        lastError = 'Playback process exited unexpectedly.';
      }
      stopAdvanceTimer();
    });
    engineDetail = null;
    try {
      child.stdin.write(`volume ${effectiveVolumeCommand()}\n`);
    } catch {
      // volume sync is best-effort at spawn; play() re-syncs right after
    }
    return child;
  }

  function effectiveVolumeCommand() {
    if (muted) return 0;
    const scaled = Math.round((ducked ? volume * duckFactor : volume) * VLC_UNIT_GAIN);
    return Math.max(0, scaled);
  }

  function syncVolume() {
    if (!child || child.exitCode !== null || engineDetail) return;
    try {
      child.stdin.write(`volume ${effectiveVolumeCommand()}\n`);
    } catch {
      // backend raced out from under us; state remains honest in status()
    }
  }

  function stopAdvanceTimer() {
    if (advanceTimer) {
      clearInterval(advanceTimer);
      advanceTimer = null;
    }
  }

  function startAdvanceTimer() {
    if (advanceTimer) return;
    advanceTimer = setInterval(() => {
      void tick().catch(() => {});
    }, 1000);
    if (typeof advanceTimer.unref === 'function') advanceTimer.unref();
  }

  function currentPosition() {
    if (phase !== 'playing') return positionMs;
    const info = currentTrackId ? trackInfo(currentTrackId) : null;
    const elapsed = now() - startedAt;
    const duration = info?.durationMs ?? runtimeDurationMs;
    if (duration && elapsed > duration) return duration;
    return Math.max(0, elapsed);
  }

  function currentDuration() {
    const info = currentTrackId ? trackInfo(currentTrackId) : null;
    return info?.durationMs ?? runtimeDurationMs ?? null;
  }

  function stopPlayback() {
    stopAdvanceTimer();
    if (child && child.exitCode === null && !engineDetail) {
      try {
        child.stdin.write('stop\n');
      } catch {
        // engine already gone — state reset below is still honest
      }
    }
    phase = 'stopped';
    positionMs = 0;
    currentTrackId = null;
    runtimeDurationMs = null;
  }

  function status() {
    const info = currentTrackId ? trackInfo(currentTrackId) : null;
    return {
      phase,
      track: info,
      positionMs: currentPosition(),
      durationMs: currentDuration(),
      volume,
      muted,
      shuffle,
      ducked,
      queueLength: queue.length,
      engine: {
        backend: 'cvlc',
        available: child ? true : spawnAttempted ? false : null,
        detail: engineDetail,
      },
      lastError,
    };
  }

  /** Play a track by opaque id. Throws honest typed errors. */
  async function play({ trackId }) {
    if (typeof trackId !== 'string' || !TRACK_ID_PATTERN.test(trackId)) {
      throw musicPlayerError('INVALID_TRACK', 'trackId must be an opaque 16-character library id.');
    }
    const absolutePath = await library.resolvePath(trackId);
    if (!absolutePath) {
      throw musicPlayerError('TRACK_NOT_FOUND', 'That track is not in the library (it may have been removed).');
    }
    ensureChild();
    ensureQueue();
    if (!queue.includes(trackId)) rebuildQueue(trackId);
    queueIndex = Math.max(0, queue.indexOf(trackId));
    runtimeDurationMs = null;
    sendCommand('stop');
    sendCommand('clear');
    // file:// URL: spaces and metacharacters stay literal, never command syntax.
    sendCommand(`add ${pathToFileURL(absolutePath).href}`);
    sendCommand(`volume ${effectiveVolumeCommand()}`);
    phase = 'playing';
    currentTrackId = trackId;
    positionMs = 0;
    startedAt = now();
    lastError = null;
    startAdvanceTimer();
    // Length fallback when the index had no duration (rc answers in seconds).
    void query('get_length').then((seconds) => {
      if (currentTrackId === trackId && seconds > 0) runtimeDurationMs = seconds * 1000;
    });
    return status();
  }

  async function advance(step) {
    ensureQueue();
    if (queue.length === 0) {
      stopPlayback();
      return status();
    }
    const wrapped = ((queueIndex + step) % queue.length + queue.length) % queue.length;
    const nextId = queue[wrapped];
    if (!nextId) {
      stopPlayback();
      return status();
    }
    return play({ trackId: nextId });
  }

  /** Auto-advance check — driven by the internal timer, callable in tests. */
  async function tick() {
    if (phase !== 'playing') return false;
    let duration = currentDuration();
    if (!duration) {
      const seconds = await query('get_length');
      if (seconds > 0) {
        runtimeDurationMs = seconds * 1000;
        duration = runtimeDurationMs;
      }
      if (!duration) return false;
    }
    if (currentPosition() < duration) return false;
    if (!autoAdvance || queue.filter(Boolean).length <= 1) {
      // End of a single-track queue: stop cleanly instead of looping forever.
      stopPlayback();
      return true;
    }
    await advance(1);
    return true;
  }

  return {
    status,
    play,
    async pause() {
      if (phase !== 'playing') {
        throw musicPlayerError('INVALID_STATE', 'Nothing is playing right now.');
      }
      sendCommand('pause');
      positionMs = currentPosition();
      phase = 'paused';
      stopAdvanceTimer();
      return status();
    },
    async resume() {
      if (phase !== 'paused') {
        throw musicPlayerError('INVALID_STATE', 'Music is not paused right now.');
      }
      sendCommand('pause'); // RC pause is a toggle
      phase = 'playing';
      startedAt = now() - positionMs;
      startAdvanceTimer();
      return status();
    },
    async stop() {
      stopPlayback();
      return status();
    },
    next() {
      return advance(1);
    },
    previous() {
      // Common player UX: first press restarts the current track.
      if (phase !== 'stopped' && currentPosition() > 3000 && currentTrackId) {
        return play({ trackId: currentTrackId });
      }
      return advance(-1);
    },
    updateSettings({ volume: nextVolume, muted: nextMuted, shuffle: nextShuffle } = {}) {
      if (nextVolume !== undefined) {
        const numeric = Number(nextVolume);
        if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
          throw musicPlayerError('INVALID_VOLUME', 'volume must be a number between 0 and 1.');
        }
        volume = numeric;
      }
      if (nextMuted !== undefined) {
        if (typeof nextMuted !== 'boolean') throw musicPlayerError('INVALID_MUTED', 'muted must be a boolean.');
        muted = nextMuted;
      }
      if (nextShuffle !== undefined) {
        if (typeof nextShuffle !== 'boolean') throw musicPlayerError('INVALID_SHUFFLE', 'shuffle must be a boolean.');
        if (nextShuffle !== shuffle) {
          shuffle = nextShuffle;
          rebuildQueue(currentTrackId);
        }
      }
      syncVolume();
      return status();
    },
    /** Duck music under a spoken response, then restore the previous level. */
    duck({ durationMs = 2500 } = {}) {
      if (muted || phase === 'stopped') return status();
      ducked = true;
      syncVolume();
      if (duckTimer) clearTimeout(duckTimer);
      duckTimer = setTimeout(() => {
        duckTimer = null;
        ducked = false;
        syncVolume();
      }, Math.max(200, Math.min(15_000, durationMs)));
      if (typeof duckTimer.unref === 'function') duckTimer.unref();
      return status();
    },
    unduck() {
      if (duckTimer) clearTimeout(duckTimer);
      duckTimer = null;
      ducked = false;
      syncVolume();
      return status();
    },
    tick,
    /** Stop output and release the child process (daemon shutdown). */
    dispose() {
      stopAdvanceTimer();
      if (duckTimer) clearTimeout(duckTimer);
      duckTimer = null;
      if (child && child.exitCode === null) {
        try {
          child.stdin.write('stop\nquit\n');
        } catch {
          // best effort
        }
        const doomed = child;
        setTimeout(() => {
          if (doomed.exitCode === null && !doomed.killed) doomed.kill('SIGKILL');
        }, 1500).unref();
      }
      child = null;
      phase = 'stopped';
      currentTrackId = null;
      positionMs = 0;
      runtimeDurationMs = null;
    },
  };
}
