/**
 * Local speech-to-text: faster-whisper (tiny.en, CPU int8) in a managed venv.
 *
 * Consent + honesty rules:
 * - Nothing installs automatically. `setupStt` runs only when a user
 *   explicitly asks for it (CLI/dashboard button); probing is read-only.
 * - Audio reaches the recogniser over the process's stdin — no temp WAV
 *   file is ever written, and no recording is kept on disk.
 * - Subprocess time is bounded; stuck children are SIGTERM then SIGKILL-ed.
 * - Transcription is single-flight; a second call is rejected (STT_BUSY)
 *   instead of silently queueing mic audio nobody owns.
 * - Transcript text is validated (trim, control-char rejection, length cap)
 *   and empty/garbage results are reported as `silence` or `error`, never
 *   pasted forward as a real command.
 */

import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Shallow fs presence helper kept injectable in probe options. */
import { existsSync } from 'node:fs';

export const DEFAULT_STT_MODEL = 'tiny.en';
export const STT_PROVIDER = 'faster-whisper';
export const TRANSCRIPT_MAX_CHARS = 500;
export const STT_BUSY = 'STT_BUSY';
export const STT_NOT_READY = 'STT_NOT_READY';
/** <100 ms of 16 kHz s16le audio is noise, not speech: short-circuit. */
const MIN_PCM_BYTES = 3200;
/** SIGTERM→SIGKILL grace when terminating a stuck recogniser. */
const KILL_GRACE_MS = 1500;

export function micErrorLike(code, message) {
  return Object.assign(new Error(message), { code });
}

export function resolveSttDataDir(env = process.env) {
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim().length > 0
    ? env.XDG_DATA_HOME.trim()
    : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'sparkiee', 'stt');
}

export function resolveSttVenvPython(env = process.env) {
  return path.join(resolveSttDataDir(env), 'venv', 'bin', 'python');
}

export function resolveSttModelDir(env = process.env) {
  return path.join(resolveSttDataDir(env), 'models');
}

/**
 * Inline recogniser program. Reads raw s16le mono PCM on stdin, prints ONE
 * JSON line on stdout. Kept as a template string so no temp file is needed.
 */
export const TRANSCRIBE_SCRIPT = `
import json, sys
import numpy as np
from faster_whisper import WhisperModel

pcm = sys.stdin.buffer.read()
audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
model = WhisperModel('tiny.en', device='cpu', compute_type='int8')
segments, info = model.transcribe(audio, language='en', beam_size=1, vad_filter=True)
out = {'source': 'int16le:16000', 'segments': []}
texts = []
for s in segments:
    out['segments'].append({
        'text': s.text,
        'no_speech_prob': round(float(s.no_speech_prob), 3),
        'avg_logprob': round(float(s.avg_logprob), 3),
    })
    texts.append(s.text)
out['text'] = ' '.join(texts).strip()
sys.stdout.write(json.dumps(out) + '\\n')
`;

/**
 * Validate a transcript produced by the recogniser. Returns the trimmed
 * text, or throws typed errors for junk. Empty input is allowed ('' after
 * trimming) — callers map that to a silence result.
 */
export function validateTranscript(raw) {
  if (typeof raw !== 'string') {
    throw micErrorLike('STT_INVALID_TRANSCRIPT', 'Transcript was not text.');
  }
  const text = raw.trim().replace(/\s+/g, ' ');
  if (text.length > TRANSCRIPT_MAX_CHARS) {
    throw micErrorLike('STT_TRANSCRIPT_TOO_LONG',
      `Transcript too long (over ${TRANSCRIPT_MAX_CHARS} characters) — ignoring.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    throw micErrorLike('STT_INVALID_TRANSCRIPT', 'Transcript contained control characters — ignoring.');
  }
  return text;
}

/** Start a bounded, cancellable, single-flight transcription of raw PCM. */
export function createSttService({
  spawnImpl = spawn,
  venvPython = resolveSttVenvPython(),
  model = DEFAULT_STT_MODEL,
  timeoutMs = 20_000,
  minPcmBytes = MIN_PCM_BYTES,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  let flight = null;

  function finish(session, payload) {
    if (session.settled) return;
    session.settled = true;
    if (session.timer) clearTimeout(session.timer);
    flight = null;
    session.resolve(payload);
  }

  function killChild(session, signal) {
    try {
      if (session.child && session.child.exitCode === null && !session.child.killed) {
        session.child.kill(signal);
      }
    } catch {
      // child already gone
    }
    if (signal === 'SIGTERM') {
      setTimeout(() => {
        try {
          if (session.child && session.child.exitCode === null && !session.child.killed) {
            session.child.kill('SIGKILL');
          }
        } catch {
          // child already gone
        }
      }, KILL_GRACE_MS).unref?.();
    }
  }

  return {
    /** True while a recogniser subprocess is live. */
    busy() {
      return flight !== null;
    },

    /** Abort the live transcription; its promise rejects with STT_CANCELLED. */
    cancel() {
      if (!flight) return false;
      flight.cancelled = true;
      killChild(flight, 'SIGTERM');
      return true;
    },

    /**
     * Transcribe raw s16le mono 16 kHz PCM (Buffer). One JSON result:
     * {status: 'ok'|'silence'|'error'|'unavailable', text?, source?, ms, ...}
     * Throws STT_BUSY when another transcribe is running.
     */
    async transcribe({ pcm, sampleRate = 16000 } = {}) {
      const startedAt = now();
      if (flight) {
        throw micErrorLike('STT_BUSY', 'A transcription is already running.');
      }
      if (!Buffer.isBuffer(pcm) || pcm.length < minPcmBytes) {
        return { status: 'silence', text: '', detail: 'Captured audio is too short to contain speech.', ms: 0 };
      }

      const session = { settled: false, cancelled: false, child: null, timer: null, resolve: null };
      const promise = new Promise((resolve, reject) => { session.resolve = resolve; session.reject = reject; });
      flight = session;

      const stdoutBuffer = [];
      let child;
      try {
        child = spawnImpl(venvPython, ['-c', TRANSCRIBE_SCRIPT, model], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...env, HF_HOME: resolveSttModelDir(env), SPARKIEE_STT_MODEL: model },
        });
      } catch (error) {
        finish(session, {
          status: 'unavailable',
          detail: error?.code === 'ENOENT'
            ? 'Local speech recognition is not available — run the STT setup step first.'
            : `Speech recognition failed to start: ${error?.message ?? error}`,
          ms: now() - startedAt,
        });
        return promise;
      }

      session.child = child;
      child.stdin?.on('error', () => { /* stdin may close early on crash; stdout decides */ });
      child.stdout?.on('data', (chunk) => {
        if (session.settled) return;
        stdoutBuffer.push(chunk);
        if (stdoutBuffer.reduce((n, c) => n + c.length, 0) > 256_000) {
          stdoutBuffer.length = 0; // absurd output: never trust it as a transcript
        }
      });

      child.on('error', () => {
        finish(session, {
          status: 'unavailable',
          detail: 'Local speech recognition is not available — run the STT setup step first.',
          ms: now() - startedAt,
        });
      });

      child.on('close', () => {
        if (session.settled || session.timedOut) return;
        if (session.cancelled) {
          flight = null;
          session.settled = true;
          if (session.timer) clearTimeout(session.timer);
          session.reject(micErrorLike('STT_CANCELLED', 'Transcription was cancelled.'));
          return;
        }
        const raw = Buffer.concat(stdoutBuffer).toString('utf8').trim();
        let parsed = null;
        try {
          const line = raw.split('\n').find((l) => l.trim().startsWith('{'));
          parsed = line ? JSON.parse(line) : null;
        } catch {
          parsed = null;
        }
        if (!parsed || typeof parsed.text !== 'string') {
          finish(session, {
            status: 'error',
            detail: 'Speech recogniser produced no usable transcript.',
            ms: now() - startedAt,
          });
          return;
        }
        const text = validateTranscript(parsed.text);
        finish(session, {
          status: text.length === 0 ? 'silence' : 'ok',
          text,
          source: typeof parsed.source === 'string' ? parsed.source : 'int16le:16000',
          segments: Array.isArray(parsed.segments) ? parsed.segments : [],
          ms: now() - startedAt,
        });
      });

      session.timer = setTimeout(() => {
        if (session.settled) return;
        session.timedOut = true;
        killChild(session, 'SIGTERM');
        finish(session, {
          status: 'error',
          error: `Transcription timed out after ${Math.round(timeoutMs / 1000)}s and was stopped.`,
          ms: now() - startedAt,
        });
      }, timeoutMs);

      try {
        child.stdin.end(pcm);
      } catch {
        // stdout 'close' path reports the real reason
      }
      return promise;
    },

    /** Leave nothing running behind shutdown/cancel. */
    dispose() {
      this.cancel();
      if (flight) {
        flight.settled = true;
        flight = null;
      }
    },
  };
}

/**
 * Read-only readiness probe. Never spawns the recogniser work itself beyond
 * one cheap module check inside the managed venv.
 *
 * @param {object} options
 * @param {{[k:string]: string}} options.env
 * @param {(spec: string) => string|null} options.pythonBin Resolve a system python.
 * @param {(p: string) => boolean} [options.fileExists]
 * @param {({venvPython: string}) => Promise<{ok: boolean, model?: string}>} options.runCheck
 *   Executes `python -c 'import faster_whisper'` at the venv python (bounded).
 */
export async function probeSttSetup({
  env = process.env,
  pythonBin = () => null, // tests inject; live daemon swaps in a real resolver
  fileExists = (p) => existsSync(p),
  runCheck,
} = {}) {
  const venvPython = resolveSttVenvPython(env);
  const dataDir = resolveSttDataDir(env);
  const modelDir = resolveSttModelDir(env);
  const details = { _paths: { venvPython, dataDir, modelDir }, model: DEFAULT_STT_MODEL };

  if (fileExists(venvPython) && runCheck) {
    let check = { ok: false };
    try {
      check = await runCheck({ venvPython, env });
    } catch {
      check = { ok: false };
    }
    if (check.ok) {
      return {
        provider: STT_PROVIDER,
        status: 'ready',
        missing: [],
        model: DEFAULT_STT_MODEL,
        sizeBytes: 75_000_000,
        origin: 'Systran/faster-whisper-tiny.en (converted OpenAI Whisper weights, MIT licence)',
        detail: 'Local speech recognition is ready (tiny.en, CPU int8). Audio stays on this machine.',
        pythonBin: undefined,
        ...details,
      };
    }
  }

  const systemPython = pythonBin('python3') ?? pythonBin('python');
  const missing = ['stt-venv'];
  let status = 'needs-setup';
  if (!systemPython) {
    missing.unshift('python');
    status = 'unavailable';
  }
  missing.push('model');
  return {
    provider: STT_PROVIDER,
    status,
    missing,
    model: DEFAULT_STT_MODEL,
    sizeBytes: 75_000_000,
    origin: 'Systran/faster-whisper-tiny.en (converted OpenAI Whisper weights, MIT licence)',
    detail: status === 'unavailable'
      ? 'No usable system Python was found — install python3, then run the explicit STT setup step.'
      : 'Local speech recognition needs a one-time explicit setup: it creates a venv, pip-installs faster-whisper (~75 MB with deps) and downloads the tiny.en model (~75 MB) only when you run the setup command.',
    pythonBin: undefined,
    ...details,
  };
}
