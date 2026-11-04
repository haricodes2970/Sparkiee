/**
 * Local text-to-speech fallback (espeak-ng).
 *
 * Used when no cloud voice provider is configured, or when the configured
 * provider fails: a caption alone is not speech, so Sparky speaks through the
 * operating system's own synthesiser instead of pretending the cloud worked.
 *
 * Properties:
 * - No shell is ever involved: the phrase is a single argv entry.
 * - Audio is synthesised into a private temporary directory (0700), read into
 *   memory and deleted immediately. Nothing here is kept on disk; the voice
 *   cache stores the resulting clip like any provider clip.
 * - Failures are stable codes the UI can explain, never a fake success.
 */

import { spawn as spawnChild } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_LOCAL_TTS_BINARY = 'espeak-ng';
export const DEFAULT_LOCAL_TTS_VOICE = 'en-us';
export const DEFAULT_LOCAL_TTS_SPEED = 165;
export const LOCAL_TTS_SYNTH_TIMEOUT_MS = 8_000;
export const LOCAL_TTS_MAX_TEXT = 240;
export const FEDORA_INSTALL_HINT = 'Install it with "sudo dnf install espeak-ng" (or "sudo apt install espeak-ng").';

/**
 * Duration of a RIFF/WAVE buffer in milliseconds, or null when the header is
 * not a parseable PCM wave. Derived from real byte counts, never estimated.
 */
export function wavDurationMs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let byteRate = null;
  let dataSize = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 12 <= buffer.length) {
      byteRate = buffer.readUInt32LE(body + 8);
    }
    if (id === 'data') {
      dataSize = Math.max(0, Math.min(size, buffer.length - body));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!byteRate || dataSize === null) return null;
  return Math.round((dataSize / byteRate) * 1000);
}

/**
 * Is a usable local speech synthesiser present? Follows the same honest
 * pattern as the STT probe: report availability, never assume it.
 *
 * @returns {Promise<{available: boolean, provider: string, binary: string,
 *   version: string|null, command: string, detail: string}>}
 */
export async function probeLocalTts({
  binary = DEFAULT_LOCAL_TTS_BINARY,
  spawnImpl = spawnChild,
  timeoutMs = 3000,
} = {}) {
  const outcome = await run(binary, ['--version'], { spawnImpl, timeoutMs });
  if (outcome.ok) {
    const version = (outcome.stdout || '').trim().split('\n')[0].slice(0, 80);
    return {
      service: 'local-tts',
      provider: 'espeak-ng',
      status: 'ready',
      binary,
      version: version || null,
      detail: `${binary} is available (${version || 'version unknown'}). Spoken replies use it when no cloud voice is configured.`,
    };
  }
  if (outcome.code === 'ENOENT') {
    return {
      provider: 'espeak-ng',
      status: 'unavailable',
      binary,
      version: null,
      detail: `${binary} is not installed. ${FEDORA_INSTALL_HINT}`,
    };
  }
  return {
    provider: 'espeak-ng',
    status: 'unavailable',
    binary,
    version: null,
    detail: `Could not run ${binary} (${outcome.message ?? 'unknown error'}).`,
  };
}

function run(command, args, { spawnImpl, timeoutMs }) {
  const spawnFn = spawnImpl ?? spawnChild;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: error?.code ?? 'spawn', message: error?.message ?? 'spawn failed' });
      return;
    }
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const timer = timeoutMs ? setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, code: 'timeout', message: `${command} did not finish within ${timeoutMs} ms` });
    }, timeoutMs) : null;
    timer?.unref?.();
    child.stdout?.on('data', (chunk) => { if (stdout.length < 2048) stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 2048) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish({ ok: false, code: error?.code ?? 'spawn', message: error?.message ?? 'spawn failed' }));
    child.on('close', (code) => finish(code === 0
      ? { ok: true, code: 0, stdout, stderr }
      : { ok: false, code: 'exit', exitCode: code, stdout, stderr, message: stderr.trim().split('\n').slice(-2).join(' ') || `${command} exited with ${code}` }));
  });
}

/**
 * Local TTS client shaped like the cloud client (`synthesize`), so the voice
 * service can fall back without knowing which provider answered.
 *
 * @returns {{provider: string, synthesize: (text: string) => Promise<{ok: boolean, audio?: Buffer, mime?: string, durationMs?: number|null, code?: string, message?: string}>}}
 */
export function createLocalTts({
  binary = DEFAULT_LOCAL_TTS_BINARY,
  voice = DEFAULT_LOCAL_TTS_VOICE,
  speed = DEFAULT_LOCAL_TTS_SPEED,
  spawnImpl,
  timeoutMs = LOCAL_TTS_SYNTH_TIMEOUT_MS,
  tmpRoot = undefined,
  mkdtempImpl = mkdtemp,
  readFileImpl = readFile,
  rmImpl = rm,
} = {}) {
  return Object.freeze({
    provider: 'espeak-ng',
    voice,
    speed,
    binary,
    async synthesize(text) {
      const spoken = typeof text === 'string'
        ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LOCAL_TTS_MAX_TEXT)
        : '';
      if (!spoken) return { ok: false, code: 'invalid', message: 'There is nothing to speak.' };

      let dir = null;
      try {
        dir = await mkdtempImpl(path.join(tmpRoot ?? os.tmpdir(), 'sparkiee-tts-'));
      } catch (error) {
        return { ok: false, code: 'failed', message: `Could not create a temporary directory: ${error?.message ?? 'unknown error'}` };
      }
      const outFile = path.join(dir, 'speech.wav');
      try {
        const outcome = await run(binary, ['-v', voice, '-s', String(speed), '-w', outFile, spoken], {
          spawnImpl,
          timeoutMs,
        });
        if (!outcome.ok) {
          return outcome.code === 'ENOENT'
            ? { ok: false, code: 'unavailable', message: `${binary} is not installed. ${FEDORA_INSTALL_HINT}` }
            : { ok: false, code: 'failed', message: `espeak-ng could not synthesise speech (${outcome.message ?? 'unknown error'}).` };
        }
        const audio = await readFileImpl(outFile);
        if (!audio || audio.length === 0) {
          return { ok: false, code: 'failed', message: 'espeak-ng produced an empty audio buffer.' };
        }
        return { ok: true, audio, mime: 'audio/wav', provider: 'espeak-ng', durationMs: wavDurationMs(audio) };
      } catch (error) {
        return { ok: false, code: 'failed', message: `Local speech synthesis failed: ${error?.message ?? 'unknown error'}` };
      } finally {
        if (dir) await rmImpl(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  });
}
