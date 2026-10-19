/**
 * Microphone capture sessions via `parec` (PulseAudio/PipeWire raw PCM).
 *
 * One active session at a time (the mic is exclusive), every session is
 * bounded by a hard timeout, and stopping is observable: the client stream is
 * named `sparkiee-mic`, so `pactl` proves both that capture is running and
 * that it stopped. Audio stays in process memory for the life of the session
 * and is discarded with the summary — no recordings are written to disk.
 *
 * Parec quirks learned on Fedora/PipeWire (live verified):
 * - `-r` is required; without it parec records nothing.
 * - stdout flushes in fragment-sized writes; `--latency=100msec` keeps data
 *   flowing in ~100ms chunks instead of multi-second stalls.
 * - A missing device or binary exits non-zero with the reason on stderr —
 *   surfaced verbatim as an honest MIC_UNAVAILABLE/DEVICE error.
 */

import { spawn } from 'node:child_process';

const BYTES_PER_SAMPLE = 2; // s16le mono
const SAMPLE_RATE = 16000;

function micError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Running level analysis over Int16 PCM. */
function makeLevelMeter() {
  let bytes = 0;
  let samples = 0;
  let sumSquares = 0;
  let peak = 0;
  return {
    push(buffer) {
      const count = Math.floor(buffer.length / BYTES_PER_SAMPLE);
      for (let i = 0; i < count; i += 1) {
        const value = buffer.readInt16LE(i * BYTES_PER_SAMPLE);
        const magnitude = Math.abs(value);
        if (magnitude > peak) peak = magnitude;
        sumSquares += value * value;
        samples += 1;
      }
      bytes += buffer.length;
    },
    summary() {
      return {
        bytes,
        peakRms: peak,
        avgRms: samples > 0 ? Math.round(Math.sqrt(sumSquares / samples)) : 0,
      };
    },
  };
}

/**
 * @param {object} options
 * @param {Function} [options.spawnImpl] Injectable spawner (tests).
 * @param {(cmd: string[]) => Promise<Array<{id: string, description?: string}>>} [options.listDevicesImpl]
 *   Device enumeration; defaults to `pactl list sources short`.
 * @param {number} [options.maxSessionMs] Hard ceiling for any session.
 * @param {string} [options.parecBinary]
 */
export function createMicSessionManager({
  spawnImpl = spawn,
  listDevicesImpl = null,
  maxSessionMs = 15_000,
  hardMaxSessionMs = 3_600_000,
  parecBinary = 'parec',
  pactlBinary = 'pactl',
  now = () => Date.now(),
} = {}) {
  let active = null; // { id, child, meter, startedAt, durationMs, stop, resolveDone, timer, label }

  async function listDevices() {
    if (listDevicesImpl) return listDevicesImpl();
    return new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawnImpl(pactlBinary, ['list', 'sources', 'short'], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve([]);
        return;
      }
      child.stdout?.on('data', (chunk) => { out += chunk; });
      child.on('error', () => resolve([]));
      child.on('close', () => {
        const devices = [];
        for (const line of out.split('\n')) {
          const [id, name, , spec, state] = line.trim().split(/\s+/);
          if (!id || !name) continue;
          // Monitor sources are output loops, never microphones.
          if (name.endsWith('.monitor')) continue;
          devices.push({ id: name, description: `${state ?? ''} ${spec ?? ''}`.trim() || null });
        }
        resolve(devices);
      });
    });
  }

  function finishSession(session, reason, error = null) {
    if (session.finished) return session.summary;
    session.finished = true;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    if (session.child && session.child.exitCode === null && !session.child.killed) {
      try { session.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    const levels = session.meter.summary();
    session.summary = {
      id: session.id,
      label: session.label,
      device: session.device,
      durationMs: Math.max(0, now() - session.startedAt),
      reason,
      error,
      ...levels,
    };
    active = null;
    session.resolveDone(session.summary);
    return session.summary;
  }

  return {
    listDevices,

    /**
     * Start a bounded capture. Resolves {id, done} — `done` resolves with the
     * final summary on stop, expiry, or device failure.
     * @param {object} options
     * @param {string|null} [options.device] Source name; null = system default.
     * @param {number} [options.durationMs] Auto-stop (clamped to maxSessionMs).
     * @param {(chunk: Buffer) => void} [options.onAudio] Streaming consumer.
     * @param {string} [options.label] 'ptt' | 'diagnostic' | 'wake' | 'utterance'.
     */
    start({ device = null, durationMs = 8000, onAudio = null, label = 'ptt' } = {}) {
      if (active) {
        return Promise.reject(micError('MIC_BUSY', 'The microphone is already in use by another session.'));
      }
      const clamped = Math.min(Math.max(1000, Math.trunc(durationMs) || 8000), maxSessionMs);
      const begin = async () => {
        if (device) {
          const devices = await listDevices();
          if (!devices.some((entry) => entry.id === device)) {
            throw micError('INVALID_DEVICE', `Unknown microphone device: ${device}.`);
          }
        }
        if (active) {
          throw micError('MIC_BUSY', 'The microphone is already in use by another session.');
        }
        const args = ['-r', '--latency=100msec', `--rate=${SAMPLE_RATE}`, '--channels=1', '--format=s16le'];
        if (device) args.push('--device', device);
        args.push('-n', 'sparkiee-mic', '--stream-name', 'assistant');
        let child;
        try {
          child = spawnImpl(parecBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          throw micError('MIC_UNAVAILABLE', error?.code === 'ENOENT'
            ? `${parecBinary} not found — install pulseaudio-utils to use the microphone.`
            : `Microphone failed to start: ${error?.message ?? error}`);
        }

        const meter = makeLevelMeter();
        let stderrTail = '';
        let resolveDone;
        const done = new Promise((resolve) => { resolveDone = resolve; });
        const session = {
          id: `mic-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          label,
          device: device ?? 'default',
          child,
          meter,
          startedAt: now(),
          resolveDone,
          done,
          timer: null,
          finished: false,
          summary: null,
        };

        child.on('error', (error) => {
          if (session.finished) return;
          finishSession(session, 'error', error?.code === 'ENOENT'
            ? `${parecBinary} not found — install pulseaudio-utils to use the microphone.`
            : `Microphone error: ${error?.message ?? error}`);
        });
        child.stderr?.on('data', (chunk) => {
          stderrTail = `${stderrTail}${chunk}`.slice(-400);
        });
        child.stdout?.on('data', (chunk) => {
          if (session.finished) return;
          meter.push(chunk);
          if (onAudio) onAudio(chunk);
        });
        child.on('close', (code) => {
          if (session.finished) return;
          // Natural expiry reports the reason; anything else is an error.
          const expired = session.timer === null && code === 0;
          finishSession(session, expired ? 'completed' : 'error',
            expired ? null : `Microphone stream ended unexpectedly${code !== null ? ` (code ${code})` : ''}${stderrTail ? `: ${stderrTail.trim()}` : ''}`);
        });

        session.timer = setTimeout(() => {
          session.timer = null;
          finishSession(session, 'max-duration');
        }, clamped);
        if (typeof session.timer.unref === 'function') session.timer.unref();

        active = session;
        return { id: session.id, done, durationMs: clamped };
      };
      return begin();
    },

    /** Stop the active session (manual). Returns the final summary or null. */
    stop(reason = 'manual') {
      if (!active) return null;
      return finishSession(active, reason);
    },

    /** Current session descriptor for status/indicator, or null. */
    active() {
      if (!active) return null;
      return {
        id: active.id,
        label: active.label,
        device: active.device,
        startedAt: new Date(active.startedAt).toISOString(),
        elapsedMs: Math.max(0, now() - active.startedAt),
      };
    },

    /** Kill anything left — daemon shutdown must leave no orphan parec. */
    dispose() {
      if (active) finishSession(active, 'shutdown');
    },
  };
}

export const MIC_SAMPLE_RATE = SAMPLE_RATE;
