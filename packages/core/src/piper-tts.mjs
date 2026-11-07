/**
 * Piper: the local neural text-to-speech engine Sparky actually speaks with.
 *
 * A resident Python worker keeps both voice models warm, so a spoken line
 * costs roughly 80-150 ms instead of reloading a 60 MB model each time. The
 * worker speaks a tiny newline-delimited JSON protocol over stdin/stdout. The
 * text travels as a JSON string — never through a shell — and each reply points
 * at a WAV file inside a private 0700 temporary directory that Node reads and
 * deletes immediately.
 *
 * Everything is local: no API key, no account, no network call at speech time.
 * When the engine or a voice is missing, synthesis fails with a stable code and
 * an instruction, never with a silent fake success.
 */

import { spawn as spawnChild } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SPEED,
  detectSpeechLanguage,
  resolveTtsVenvPython,
  resolveTtsVoiceConfigPath,
  resolveTtsVoiceModelPath,
  SUPPORTED_LANGUAGES,
  VOICE_CATALOG,
} from './voice-config.mjs';
import { wavDurationMs } from './local-tts.mjs';

export const MAX_UTTERANCE_LENGTH = 400;
export const PIPER_TIMEOUT_MS = 30_000;
export const PIPER_START_TIMEOUT_MS = 25_000;
export const PIPER_IDLE_UNLOAD_MS = 180_000;

export function isValidUtterance(text) {
  return typeof text === 'string'
    && text.trim().length > 0
    && text.length <= MAX_UTTERANCE_LENGTH
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
}

/** Collapse whitespace; control characters are left for validation to reject. */
export function normaliseSpeechText(text, maxLength = MAX_UTTERANCE_LENGTH) {
  const cleaned = typeof text === 'string'
    ? text.replace(/[\t\n\r]+/g, ' ').replace(/ {2,}/g, ' ').trim()
    : '';
  return maxLength > 0 ? cleaned.slice(0, maxLength + 1) : cleaned;
}

/**
 * The Python side of the worker protocol. Kept as a plain string so the whole
 * engine can be inspected and tested without a Python file on disk.
 */
export function buildPiperWorkerScript() {
  return [
    'import json, sys, wave',
    'from piper import PiperVoice',
    'from piper.config import SynthesisConfig',
    'voices = {}',
    'def load(model, config):',
    '    key = (model, config)',
    '    if key not in voices:',
    '        voices[key] = PiperVoice.load(model, config_path=config)',
    '    return voices[key]',
    'for line in sys.stdin:',
    '    line = line.strip()',
    '    if not line:',
    '        continue',
    '    try:',
    '        req = json.loads(line)',
    '        voice = load(req["model"], req["config"])',
    '        speed = float(req.get("speed") or 1.0)',
    '        syn = SynthesisConfig(length_scale=max(0.25, min(4.0, 1.0 / speed)))',
    '        with wave.open(req["out"], "wb") as wav:',
    '            voice.synthesize_wav(req["text"], wav, syn_config=syn)',
    '        sys.stdout.write(json.dumps({"id": req.get("id"), "ok": True}) + "\\n")',
    '        sys.stdout.flush()',
    '    except Exception as error:',
    '        sys.stdout.write(json.dumps({"id": (req.get("id") if isinstance(req, dict) else None), "ok": False, "error": str(error)[:300]}) + "\\n")',
    '        sys.stdout.flush()',
    '',
  ].join('\n');
}

function voiceMeta(voiceId) {
  return Object.hasOwn(VOICE_CATALOG, voiceId) ? VOICE_CATALOG[voiceId] : null;
}

/**
 * @param {object} options
 * @param {object} [options.env]
 * @param {Function} [options.spawnImpl]
 * @param {Function} [options.existsSyncImpl]
 * @param {() => {engine: string, voices: object, speed: number}} options.getConfig
 * @param {number} [options.timeoutMs]
 * @param {number} [options.idleUnloadMs]
 */
export function createPiperTts({
  env = process.env,
  spawnImpl = spawnChild,
  existsSyncImpl = (file) => existsSync(file),
  getConfig,
  timeoutMs = PIPER_TIMEOUT_MS,
  startTimeoutMs = PIPER_START_TIMEOUT_MS,
  idleUnloadMs = PIPER_IDLE_UNLOAD_MS,
  tmpRoot = undefined,
  mkdtempImpl = mkdtemp,
  readFileImpl = readFile,
  rmImpl = rm,
  chmodImpl = chmod,
} = {}) {
  const venvPython = resolveTtsVenvPython(env);
  let worker = null; // { child, buffer, idleTimer, startError }
  let pending = null; // { id, outFile, timer, resolve, voiceId }
  let sequence = 0;
  let tempDir = null;

  function currentConfig() {
    const config = typeof getConfig === 'function' ? getConfig() : null;
    return {
      engine: config?.engine ?? 'piper',
      voices: config?.voices ?? {},
      speed: typeof config?.speed === 'number' ? config.speed : DEFAULT_SPEED,
    };
  }

  function voiceFor(language) {
    const config = currentConfig();
    return config.voices[language] ?? null;
  }

  function modelPaths(voiceId) {
    return {
      model: resolveTtsVoiceModelPath(env, voiceId),
      config: resolveTtsVoiceConfigPath(env, voiceId),
    };
  }

  function languagesPresent() {
    const present = {};
    for (const language of SUPPORTED_LANGUAGES) {
      const voiceId = voiceFor(language);
      const meta = voiceId ? voiceMeta(voiceId) : null;
      const paths = voiceId ? modelPaths(voiceId) : null;
      present[language] = {
        voiceId,
        label: meta?.label ?? null,
        present: Boolean(paths && existsSyncImpl(paths.model) && existsSyncImpl(paths.config)),
      };
    }
    return present;
  }

  async function ensureTempDir() {
    if (tempDir) return tempDir;
    tempDir = await mkdtempImpl(path.join(tmpRoot ?? os.tmpdir(), 'sparkiee-piper-'));
    await chmodImpl(tempDir, 0o700).catch(() => {});
    return tempDir;
  }

  function stopWorker() {
    if (!worker) return;
    const { child, idleTimer } = worker;
    if (idleTimer) clearTimeout(idleTimer);
    worker = null;
    try { child.stdin?.end(); } catch { /* already closed */ }
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }

  function failPending(code, message) {
    if (!pending) return;
    const current = pending;
    pending = null;
    if (current.timer) clearTimeout(current.timer);
    current.resolve({ ok: false, code, message });
  }

  function resetIdleTimer() {
    if (!worker) return;
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    if (!(idleUnloadMs > 0)) return;
    worker.idleTimer = setTimeout(() => {
      if (!pending) stopWorker();
    }, idleUnloadMs);
    worker.idleTimer.unref?.();
  }

  function handleLine(line) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return; }
    if (!pending || parsed?.id !== pending.id) return;
    const current = pending;
    pending = null;
    if (current.timer) clearTimeout(current.timer);
    if (parsed.ok === true) {
      readFileImpl(current.outFile)
        .then((audio) => rmImpl(current.outFile, { force: true }).catch(() => {}).then(() => audio))
        .then((audio) => {
          if (!audio || audio.length === 0) {
            current.resolve({ ok: false, code: 'failed', message: 'Piper produced an empty audio clip.' });
            return;
          }
          current.resolve({
            ok: true,
            audio,
            mime: 'audio/wav',
            provider: 'piper',
            voiceId: current.voiceId,
            durationMs: wavDurationMs(audio),
          });
        })
        .catch((error) => current.resolve({ ok: false, code: 'failed', message: `Could not read the generated audio: ${error?.message ?? 'unknown error'}` }));
      return;
    }
    current.resolve({
      ok: false,
      code: 'failed',
      message: `Piper could not synthesise that phrase (${String(parsed.error ?? 'unknown error').slice(0, 200)}).`,
    });
  }

  function startWorker() {
    const state = { child: null, buffer: '', idleTimer: null, startError: null };
    let child;
    try {
      child = spawnImpl(venvPython, ['-u', '-c', buildPiperWorkerScript()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...env, PYTHONUNBUFFERED: '1' },
      });
    } catch (error) {
      state.startError = {
        code: error?.code === 'ENOENT' ? 'not_installed' : 'failed',
        message: error?.code === 'ENOENT'
          ? 'The local voice runtime is not installed. Run "sparkiee voice setup".'
          : `Could not start the local voice: ${error?.message ?? 'unknown error'}.`,
      };
      return state;
    }
    state.child = child;
    worker = state;

    const startTimer = setTimeout(() => {
      state.startError = { code: 'timeout', message: 'Piper did not start in time.' };
      stopWorker();
      failPending('timeout', 'Piper did not start in time.');
    }, startTimeoutMs);
    startTimer.unref?.();

    child.stdout?.on('data', (chunk) => {
      state.buffer += chunk.toString('utf8');
      let index;
      while ((index = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, index).trim();
        state.buffer = state.buffer.slice(index + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      state.lastStderr = `${state.lastStderr ?? ''}${text}`.slice(-4000);
      if (/ModuleNotFoundError|No module named/.test(text)) state.startError = { code: 'setup_required', message: 'Piper is not installed. Run "sparkiee voice setup".' };
    });
    child.on('error', (error) => {
      state.startError = {
        code: error?.code === 'ENOENT' ? 'not_installed' : 'failed',
        message: error?.code === 'ENOENT'
          ? 'The local voice runtime is not installed. Run "sparkiee voice setup".'
          : `Could not start the local voice: ${error?.message ?? 'unknown error'}.`,
      };
      if (worker === state) worker = null;
      failPending(state.startError.code, state.startError.message);
    });
    child.on('close', () => {
      clearTimeout(startTimer);
      if (worker === state) worker = null;
      const detail = state.startError
        ?? (state.lastStderr ? { code: 'failed', message: `Piper stopped before replying (${state.lastStderr.trim().split('\n').slice(-1)[0].slice(0, 160)}).` } : null);
      failPending(detail?.code ?? 'failed', detail?.message ?? 'The local voice stopped before replying.');
    });
    return state;
  }

  async function synthesize(text, { language = null } = {}) {
    const clean = normaliseSpeechText(text);
    if (!isValidUtterance(clean)) {
      return { ok: false, code: 'validation', message: `Utterance must be 1-${MAX_UTTERANCE_LENGTH} characters of plain text.` };
    }
    const chosenLanguage = SUPPORTED_LANGUAGES.includes(language) ? language : detectSpeechLanguage(clean);
    if (!existsSyncImpl(venvPython)) {
      return { ok: false, code: 'not_installed', message: 'The local voice runtime is not installed. Run "sparkiee voice setup".' };
    }
    const voiceId = voiceFor(chosenLanguage);
    if (!voiceId) {
      return { ok: false, code: 'voice_missing', message: `No ${chosenLanguage === 'hi' ? 'Hindi' : 'English'} voice is configured. Run "sparkiee voice setup".` };
    }
    const paths = modelPaths(voiceId);
    if (!existsSyncImpl(paths.model) || !existsSyncImpl(paths.config)) {
      return {
        ok: false,
        code: 'voice_missing',
        message: `The ${VOICE_CATALOG[voiceId]?.label ?? voiceId} voice is not downloaded yet. Run "sparkiee voice setup".`,
      };
    }
    if (!worker) {
      const started = startWorker();
      if (!started.child) {
        return { ok: false, code: started.startError?.code ?? 'failed', message: started.startError?.message ?? 'Could not start the local voice.' };
      }
    }

    const dir = await ensureTempDir().catch(() => null);
    if (!dir) return { ok: false, code: 'failed', message: 'Could not create a private temporary directory for speech.' };
    const id = ++sequence;
    const outFile = path.join(dir, `speech-${id}.wav`);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        failPending('timeout', `The local voice did not answer within ${Math.round(timeoutMs / 1000)}s.`);
        stopWorker();
      }, timeoutMs);
      // Deliberately NOT unref'd: the caller is waiting for this answer, so
      // the timer must keep the event loop alive until the worker replies.
      pending = { id, outFile, timer, resolve, voiceId };
      resetIdleTimer();
      try {
        worker.child.stdin.write(`${JSON.stringify({
          id,
          text: clean,
          model: paths.model,
          config: paths.config,
          out: outFile,
          speed: currentConfig().speed,
        })}\n`);
      } catch (error) {
        failPending('failed', `Could not send the phrase to the local voice: ${error?.message ?? 'unknown error'}.`);
      }
    });
  }

  /** Honest availability probe: files + runtime, no network, no load. */
  async function probe() {
    const installed = existsSyncImpl(venvPython);
    const voices = languagesPresent();
    const allPresent = Object.values(voices).every((entry) => entry.present);
    if (!installed) {
      return {
        engine: 'piper',
        status: 'not_installed',
        installed: false,
        voices,
        detail: 'The local voice runtime is not installed. Run "sparkiee voice setup" to install Piper and download the voices.',
      };
    }
    if (!allPresent) {
      const missing = Object.entries(voices).filter(([, entry]) => !entry.present).map(([language]) => language);
      return {
        engine: 'piper',
        status: 'voices_missing',
        installed: true,
        voices,
        detail: `Missing voice model${missing.length === 1 ? '' : 's'} for: ${missing.join(', ')}. Run "sparkiee voice setup".`,
      };
    }
    return {
      engine: 'piper',
      status: 'ready',
      installed: true,
      voices,
      detail: `Piper is ready (${Object.values(voices).map((entry) => entry.label).filter(Boolean).join(' + ')}).`,
    };
  }

  async function close() {
    stopWorker();
    failPending('closed', 'The local voice was shut down.');
    if (tempDir) {
      await rmImpl(tempDir, { recursive: true, force: true }).catch(() => {});
      tempDir = null;
    }
  }

  return Object.freeze({
    provider: 'piper',
    venvPython,
    synthesize,
    probe,
    close,
    getConfig: currentConfig,
  });
}
