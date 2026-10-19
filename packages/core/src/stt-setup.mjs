/**
 * Explicit local speech-recognition setup: creates the venv, installs
 * faster-whisper, and downloads the tiny.en model — only when the user runs
 * it (CLI). Nothing installs automatically, nothing downloads silently, and
 * every step reports honest progress or a concrete failure.
 *
 * Idempotent: a healthy setup is detected (module import + model cache
 * present) and skipped.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_STT_MODEL, resolveSttDataDir, resolveSttModelDir, resolveSttVenvPython } from './stt-service.mjs';

const PIP_PACKAGE = 'faster-whisper';
/** Whole-setup ceiling; the model download dominates it. */
export const DEFAULT_SETUP_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_SETUP_TIMEOUT_MS = DEFAULT_SETUP_TIMEOUT_MS;
const MODEL_CACHE_DIRNAME = 'models--Systran--faster-whisper-tiny.en';

export function spawnRun(cmd, args, { timeoutMs, cwd, env, onChunk } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: error?.code ?? 'spawn_error', stdout: '', stderr: '', message: error?.message ?? String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const took = Date.now();
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-32_000);
      onChunk?.('out', String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32_000);
      onChunk?.('err', String(chunk));
    });
    child.on('error', (error) => resolve({ ok: false, code: error?.code ?? 'spawn_error', stdout, stderr, message: error?.message ?? String(error) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr, ms: Date.now() - took }));
    const timer = typeof timeoutMs === 'number' ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    if (timer) child.on('close', () => clearTimeout(timer));
  });
}

/** Find a usable system python for venv creation (never the app's node). */
export function findSystemPython({ env = process.env, fileExists = (p) => existsSync(p) } = {}) {
  if (env.SPARKIEE_STT_PYTHON) return env.SPARKIEE_STT_PYTHON;
  for (const dir of ['/usr/bin', '/usr/local/bin', '/bin']) {
    for (const name of ['python3', 'python']) {
      const p = path.join(dir, name);
      if (fileExists(p)) return p;
    }
  }
  return null;
}

export const MISSING_SUPPORT = 'Install python3 (dnf install python3), then re-run "sparkiee assistant setup".';
export const MODEL = DEFAULT_STT_MODEL;

/**
 * Run the full setup. `onLine` receives progress lines for display.
 * Returns {ok, detail, missing} — never throws for expected shapes.
 */
export async function setupSttEnvironment({
  env = process.env,
  onLine = () => {},
  timeoutMs = DEFAULT_SETUP_TIMEOUT_MS,
  runImpl = null,
  fileExists = (p) => existsSync(p),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const exec = runImpl ?? spawnRun;
  const dataDir = resolveSttDataDir(env);
  const venvPython = resolveSttVenvPython(env);
  const modelDir = resolveSttModelDir(env);
  const pipArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', PIP_PACKAGE];
  const modelScript = `from faster_whisper import WhisperModel\nWhisperModel('${DEFAULT_STT_MODEL}', device='cpu', compute_type='int8')\nprint('model-ok')\n`;

  const systemPython = findSystemPython({ env, fileExists });
  if (!systemPython) {
    return { ok: false, missing: ['python'], detail: MISSING_SUPPORT };
  }

  // Already healthy? Skip work without touching anything.
  if (existsSync(venvPython) && existsSync(path.join(modelDir, MODEL_CACHE_DIRNAME))) {
    const probe = await exec(venvPython, ['-c', 'import faster_whisper, sys; print("ok")'], { timeoutMs: 30_000 });
    if (probe.ok) {
      onLine('Speech recognition is already set up. Nothing to do.');
      return { ok: true, detail: 'already-ready', venvPython, modelDir, model: DEFAULT_STT_MODEL };
    }
  }

  onLine(`1/3 Creating the virtual environment in ${dataDir}/venv…`);
  let step = await exec(systemPython, ['-m', 'venv', '--clear', path.dirname(path.dirname(venvPython))], {
    timeoutMs: Math.min(120_000, Math.max(0, deadline - Date.now())),
  });
  if (!step.ok) {
    return { ok: false, missing: ['stt-venv'], detail: `Could not create the venv (exit ${step.code}). ${step.stderr?.trim().split('\n').slice(-2).join(' ') ?? ''}`.trim() };
  }

  onLine(`2/3 Installing faster-whisper into the venv (no secrets, no audio sent anywhere)…`);
  step = await exec(venvPython, pipArgs, {
    timeoutMs: Math.min(10 * 60_000, Math.max(0, deadline - Date.now())),
    onChunk: (stream, chunk) => {
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (t) onLine(`    ${t.slice(0, 120)}`);
      }
    },
  });
  if (!step.ok) {
    return { ok: false, missing: ['stt-venv'], detail: `pip install failed (exit ${step.code}). ${step.stderr?.trim().split('\n').slice(-3).join(' ') ?? ''}`.trim() };
  }

  onLine(`3/3 Downloading the tiny.en model (~75 MB) once into ${modelDir}…`);
  step = await exec(venvPython, ['-c', modelScript], {
    timeoutMs: Math.max(30_000, Math.min(deadline - Date.now(), 15 * 60_000)),
    env: { HF_HOME: modelDir },
  });
  if (!step.ok) {
    if (Date.now() > deadline) {
      return { ok: false, missing: ['model'], detail: 'The model download did not finish in the allowed time. Re-run "sparkiee assistant setup" to continue from the cache.' };
    }
    return { ok: false, missing: ['model'], detail: `Model download failed (exit ${step.code}). ${step.stderr?.trim().split('\n').slice(-3).join(' ') ?? ''}`.trim() };
  }

  onLine('Speech recognition is ready (tiny.en, CPU int8). Audio never leaves this machine.');
  return { ok: true, detail: 'setup-complete', venvPython, modelDir, model: DEFAULT_STT_MODEL };
}
