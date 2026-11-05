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
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';

/** Shallow fs presence helper kept injectable in probe options. */

export const DEFAULT_STT_MODEL = 'tiny.en';
/** Proven-quality default for CUDA machines (larger but GPU-friendly). */
export const RECOMMENDED_STT_MODEL = 'large-v3-turbo';
export const STT_MODEL_CATALOG = Object.freeze({
  'tiny.en': Object.freeze({
    repo: 'Systran/faster-whisper-tiny.en',
    sizeBytes: 78_000_000,
    params: '39M',
    licence: 'MIT (converted OpenAI Whisper weights)',
  }),
  'large-v3-turbo': Object.freeze({
    repo: 'deepdml/faster-whisper-large-v3-turbo-ct2',
    sizeBytes: 1_620_000_000,
    params: '809M',
    licence: 'MIT (converted OpenAI Whisper large-v3-turbo weights)',
  }),
});
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

/**
 * Shared CUDA runtime libraries (cuBLAS/cuDNN wheels) used by every local
 * ML app on this machine — installed once, never per-venv. Public binaries,
 * so they live under the shared data dir rather than an app-private one.
 */
export function resolveCudaLibsDir(env = process.env) {
  const explicit = typeof env.SPARKIEE_CUDA_LIBS === 'string' && env.SPARKIEE_CUDA_LIBS.trim().length > 0
    ? env.SPARKIEE_CUDA_LIBS.trim()
    : null;
  if (explicit) return explicit;
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim().length > 0
    ? env.XDG_DATA_HOME.trim()
    : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'cuda-libs');
}

/** LD_LIBRARY_PATH that makes the shared CUDA wheels discoverable. */
export function cudaLibraryPath(cudaLibsDir, env = process.env) {
  const parts = [
    path.join(cudaLibsDir, 'nvidia', 'cublas', 'lib'),
    path.join(cudaLibsDir, 'nvidia', 'cudnn', 'lib'),
  ];
  if (typeof env.LD_LIBRARY_PATH === 'string' && env.LD_LIBRARY_PATH.trim().length > 0) {
    parts.push(env.LD_LIBRARY_PATH.trim());
  }
  return parts.join(':');
}

/**
 * One global model cache for every app that needs Whisper weights, using the
 * Hugging Face hub convention (~/.cache/huggingface/hub by default). The
 * weights are public files, so no app-private 0700 copy is duplicated.
 * Precedence matches huggingface_hub itself: HUGGINGFACE_HUB_CACHE, then
 * HF_HOME/hub, then the default cache dir.
 */
export function resolveSttModelDir(env = process.env) {
  const explicit = typeof env.HUGGINGFACE_HUB_CACHE === 'string' && env.HUGGINGFACE_HUB_CACHE.trim().length > 0
    ? env.HUGGINGFACE_HUB_CACHE.trim()
    : null;
  if (explicit) return explicit;
  const hfHome = typeof env.HF_HOME === 'string' && env.HF_HOME.trim().length > 0
    ? env.HF_HOME.trim()
    : null;
  if (hfHome) return path.join(hfHome, 'hub');
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

/** Protected user config for the recogniser model: $XDG_CONFIG_HOME/sparkiee/stt.json (0600). */
export function sttConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim().length > 0
    ? env.XDG_CONFIG_HOME.trim()
    : path.join(os.homedir(), '.config');
  return path.join(base, 'sparkiee', 'stt.json');
}

export async function readSttConfig({ env = process.env } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(sttConfigPath(env), 'utf8'));
    const model = typeof parsed?.model === 'string' && STT_MODEL_CATALOG[parsed.model] ? parsed.model : null;
    return { model: model ?? DEFAULT_STT_MODEL };
  } catch {
    return { model: DEFAULT_STT_MODEL };
  }
}

/** Explicit consent boundary: writing a model choice means downloading it. */
export async function writeSttConfig({ env = process.env } = {}, partial = {}) {
  const current = await readSttConfig({ env });
  let model = current.model;
  if (typeof partial?.model === 'string') {
    if (!STT_MODEL_CATALOG[partial.model]) {
      throw Object.assign(new Error(`UNKNOWN_STT_MODEL: "${partial.model}". Options: ${Object.keys(STT_MODEL_CATALOG).join(', ')}.`), { code: 'UNKNOWN_STT_MODEL' });
    }
    model = partial.model;
  }
  const file = sttConfigPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ model, version: 1 }, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return { model };
}

/** Configured model (catalog-validated); default tiny.en when nothing is set. Never throws. */
export function resolveSttModel({ env = process.env } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(sttConfigPath(env), 'utf8'));
    if (parsed && STT_MODEL_CATALOG[parsed.model]) return parsed.model;
  } catch {
    // No config file or junk: the documented default stands.
  }
  return DEFAULT_STT_MODEL;
}



/**
 * Inline recogniser program. Reads raw s16le mono PCM on stdin, prints ONE
 * JSON line on stdout. Kept as a template string so no temp file is needed.
 */
export const TRANSCRIBE_SCRIPT = `
import json, sys, os
import numpy as np
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get('SPARKIEE_STT_MODEL', 'INSERT_MODEL')
pcm = sys.stdin.buffer.read()
audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
def _decode(model):
    # Materialised here: the CUDA failure (cublas/cudnn) surfaces during
    # encode, not at construction, so the guarded block must cover decoding.
    return list(model.transcribe(
        audio,
        language='en',
        beam_size=5,
        best_of=5,
        temperature=0.0,
        condition_on_previous_text=False,
        vad_filter=True,
    )[0])
def _run():
    # CUDA first (machines with a real GPU), CPU int8 as the honest fallback.
    try:
        model = WhisperModel(MODEL_NAME, device='cuda', compute_type='int8_float16')
        return _decode(model), 'cuda'
    except Exception:
        model = WhisperModel(MODEL_NAME, device='cpu', compute_type='int8')
        return _decode(model), 'cpu'
segments, device = _run()
out = {'source': 'int16le:16000', 'device': device, 'segments': []}
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
 * Script text for a configured model. The raw model name is interpolated as
 * a fallback (the env SPARKIEE_STT_MODEL still wins at runtime), and the
 * recogniser always runs inside the managed venv only.
 */
export function buildTranscribeScript(model = DEFAULT_STT_MODEL) {
  const safe = String(model ?? DEFAULT_STT_MODEL).replace(/[^A-Za-z0-9._-]/g, '');
  return TRANSCRIBE_SCRIPT.replace("'INSERT_MODEL'", `'${safe}'`);
}

/**
 * Resident recogniser: loads the model once, then serves any number of
 * utterances over stdin/stdout (newline JSON header + raw PCM). This is the
 * difference between ~0.7 s and ~4 s per command: the one-shot program pays
 * the model/GPU-context load on every utterance.
 */
export const WORKER_SCRIPT = `
import json, sys, os
import numpy as np
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get('SPARKIEE_STT_MODEL', 'INSERT_MODEL')
model = None
device = None
gpu_error = None

def _load(use_cuda):
    global model, device, gpu_error
    if model is not None:
        return
    try:
        if use_cuda:
            model = WhisperModel(MODEL_NAME, device='cuda', compute_type='int8_float16')
            device = 'cuda'
        else:
            model = WhisperModel(MODEL_NAME, device='cpu', compute_type='int8')
            device = 'cpu'
    except Exception as exc:
        model = None
        if use_cuda:
            gpu_error = str(exc)[:300]
            _load(False)
        else:
            raise

def _infer(audio):
    segments = list(model.transcribe(
        audio,
        language='en',
        beam_size=5,
        best_of=5,
        temperature=0.0,
        condition_on_previous_text=False,
        vad_filter=True,
    )[0])
    return [{
        'text': s.text,
        'no_speech_prob': round(float(s.no_speech_prob), 3),
        'avg_logprob': round(float(s.avg_logprob), 3),
    } for s in segments]

def main():
    global model, device, gpu_error
    for line in sys.stdin.buffer:
        line = line.strip()
        if not line:
            continue
        try:
            header = json.loads(line)
        except Exception:
            continue
        rid = header.get('id')
        count = int(header.get('bytes') or 0)
        pcm = sys.stdin.buffer.read(count)
        audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
        payload = {'id': rid, 'source': 'int16le:16000'}
        try:
            _load(True)
            try:
                segments = _infer(audio)
            except Exception as exc:
                # Decode-time GPU failures (cublas/cudnn, OOM) reload on CPU once.
                gpu_error = str(exc)[:300]
                model = None
                _load(False)
                segments = _infer(audio)
            payload['device'] = device
            if gpu_error:
                payload['gpu_error'] = gpu_error
            payload['segments'] = segments
            payload['text'] = ' '.join(s['text'] for s in segments).strip()
        except Exception as exc:
            payload['error'] = str(exc)
        sys.stdout.write(json.dumps(payload) + '\\n')
        sys.stdout.flush()

main()
`;

export function buildWorkerScript(model = DEFAULT_STT_MODEL) {
  const safe = String(model ?? DEFAULT_STT_MODEL).replace(/[^A-Za-z0-9._-]/g, '');
  return WORKER_SCRIPT.replace("'INSERT_MODEL'", `'${safe}'`);
}

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
  cudaLibsDir = resolveCudaLibsDir(env),
  cudaLibsExist = () => existsSync(cudaLibsDir),
  persistent = false,
  idleMs = 120_000,
} = {}) {
  let flight = null;
  /** Resident worker state (persistent mode only). */
  let worker = null; // { child, buffer, idleTimer }
  let workerPending = null; // { session, id, startedAt }
  let workerSeq = 0;
  let disposed = false;

  const recogniserEnv = () => {
    const hasCudaLibs = typeof cudaLibsExist === 'function' ? Boolean(cudaLibsExist()) : Boolean(cudaLibsExist);
    return {
      ...env,
      HUGGINGFACE_HUB_CACHE: resolveSttModelDir(env),
      SPARKIEE_STT_MODEL: model,
      // Weights are already on disk: never let a recogniser call touch the
      // network (hub metadata checks add seconds and break the local guarantee).
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      ...(hasCudaLibs ? { LD_LIBRARY_PATH: cudaLibraryPath(cudaLibsDir, env) } : {}),
    };
  };

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

  function workerFailPending(detail) {
    if (!workerPending) return;
    const pending = workerPending;
    workerPending = null;
    if (pending.session.timer) clearTimeout(pending.session.timer);
    finish(pending.session, { status: 'error', error: detail, ms: now() - pending.startedAt });
  }

  /** Kill the resident recogniser; any in-flight request fails honestly. */
  function stopWorker(detail = 'Speech recogniser stopped before replying.') {
    if (worker) {
      const { child, idleTimer } = worker;
      if (idleTimer) clearTimeout(idleTimer);
      worker = null;
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, KILL_GRACE_MS).unref?.();
    }
    workerFailPending(detail);
  }

  function touchWorkerIdle() {
    if (!worker || !(idleMs > 0)) return;
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    worker.idleTimer = setTimeout(() => stopWorker(), idleMs);
    worker.idleTimer.unref?.();
  }

  function workerResult(session, parsed, startedAt) {
    if (!parsed || typeof parsed.text !== 'string') {
      finish(session, {
        status: 'error',
        error: typeof parsed?.error === 'string' && parsed.error.length > 0
          ? parsed.error
          : 'Speech recogniser produced no usable transcript.',
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
  }

  function startWorker() {
    const child = spawnImpl(venvPython, ['-u', '-c', buildWorkerScript(model)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: recogniserEnv(),
    });
    const state = { child, buffer: '', idleTimer: null };
    worker = state;
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      state.buffer += chunk;
      let newline = state.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = state.buffer.slice(0, newline).trim();
        state.buffer = state.buffer.slice(newline + 1);
        newline = state.buffer.indexOf('\n');
        if (!line || !workerPending) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed?.id !== workerPending.id) continue;
        const pending = workerPending;
        workerPending = null;
        if (pending.session.timer) clearTimeout(pending.session.timer);
        workerResult(pending.session, parsed, pending.startedAt);
        touchWorkerIdle();
      }
    });
    child.stdin?.on('error', () => { /* stdout/close reports the real reason */ });
    child.on?.('error', () => {
      if (worker === state) worker = null;
      workerFailPending('Local speech recognition is not available — run the STT setup step first.');
    });
    child.on?.('close', () => {
      if (worker === state) worker = null;
      workerFailPending('Speech recogniser stopped before replying.');
    });
    return state;
  }

  function workerTranscribe(session, pcm, startedAt) {
    try {
      if (!worker) startWorker();
    } catch (error) {
      finish(session, {
        status: 'unavailable',
        error: error?.code === 'ENOENT'
          ? 'Local speech recognition is not available — run the STT setup step first.'
          : `Speech recognition failed to start: ${error?.message ?? error}`,
        ms: now() - startedAt,
      });
      return;
    }
    touchWorkerIdle();
    const id = ++workerSeq;
    workerPending = { session, id, startedAt };
    session.timer = setTimeout(() => {
      if (session.settled) return;
      session.timedOut = true;
      const pending = workerPending;
      workerPending = null;
      stopWorker();
      if (pending?.session === session) {
        finish(session, {
          status: 'error',
          error: `Transcription timed out after ${Math.round(timeoutMs / 1000)}s and was stopped.`,
          ms: now() - startedAt,
        });
      }
    }, timeoutMs);
    try {
      worker.child.stdin.write(`${JSON.stringify({ id, bytes: pcm.length })}\n`);
      worker.child.stdin.write(pcm);
    } catch {
      stopWorker();
    }
  }

  return {
    /** True while a recogniser subprocess is live. */
    busy() {
      return flight !== null;
    },

    /** Abort the live transcription; its promise rejects with STT_CANCELLED. */
    cancel() {
      if (persistent) {
        if (!workerPending) return false;
        const pending = workerPending;
        workerPending = null;
        if (pending.session.timer) clearTimeout(pending.session.timer);
        pending.session.settled = true;
        flight = null;
        stopWorker();
        pending.session.reject(micErrorLike('STT_CANCELLED', 'Transcription was cancelled.'));
        return true;
      }
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

      if (persistent) {
        workerTranscribe(session, pcm, startedAt);
        return promise;
      }

      const stdoutBuffer = [];
      let child;
      try {
        child = spawnImpl(venvPython, ['-c', buildTranscribeScript(model), model], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: recogniserEnv(),
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
      disposed = true;
      this.cancel();
      stopWorker();
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
  const configuredModel = resolveSttModel({ env });
  const modelMeta = STT_MODEL_CATALOG[configuredModel] ?? STT_MODEL_CATALOG[DEFAULT_STT_MODEL];
  const details = { _paths: { venvPython, dataDir, modelDir }, model: configuredModel };

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
        model: configuredModel,
        sizeBytes: modelMeta.sizeBytes,
        origin: `${modelMeta.repo} (converted OpenAI Whisper weights, MIT licence)`,
        detail: `Local speech recognition is ready (${configuredModel}). Audio stays on this machine.`,
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
    model: configuredModel,
    sizeBytes: modelMeta.sizeBytes,
    origin: `${modelMeta.repo} (converted OpenAI Whisper weights, MIT licence)`,
    detail: status === 'unavailable'
      ? 'No usable system Python was found — install python3, then run the explicit STT setup step.'
      : `Local speech recognition needs a one-time explicit setup: it creates a venv, pip-installs faster-whisper and downloads the ${configuredModel} model (~${Math.round(modelMeta.sizeBytes / 1_048_576)} MB) only when you run the setup command.`,
    pythonBin: undefined,
    ...details,
  };
}
