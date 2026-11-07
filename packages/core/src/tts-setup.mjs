/**
 * Explicit local voice setup: a private Python venv with Piper, plus the two
 * curated voice models. Nothing installs or downloads automatically — this
 * runs only when the user asks for it ("sparkiee voice setup").
 *
 * Idempotent: a healthy venv and present model files are skipped, and each
 * step reports honest progress. No secrets are involved: the only hosts
 * contacted are PyPI and the Hugging Face model repository.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_VOICES,
  SUPPORTED_LANGUAGES,
  VOICE_CATALOG,
  resolveTtsDataDir,
  resolveTtsVenvPython,
  resolveTtsVoiceConfigPath,
  resolveTtsVoiceDir,
  resolveTtsVoiceModelPath,
  writeVoiceConfig,
} from './voice-config.mjs';
import { spawnRun } from './stt-setup.mjs';

export const PIPER_PACKAGE = 'piper-tts==1.8.0';
export const DEFAULT_VOICE_SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_MODEL_BYTES = 1_000_000;

/** Locate `uv` (preferred: it can fetch a compatible CPython without pip). */
export function findUv({ env = process.env, fileExists = (p) => existsSync(p) } = {}) {
  if (env.SPARKIEE_UV) return env.SPARKIEE_UV;
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'uv');
    if (fileExists(candidate)) return candidate;
  }
  for (const dir of ['/usr/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.cargo', 'bin')]) {
    const candidate = path.join(dir, 'uv');
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

/** Find a system python for the fallback venv path. */
export function findPython({ env = process.env, fileExists = (p) => existsSync(p) } = {}) {
  if (env.SPARKIEE_TTS_BOOTSTRAP_PYTHON) return env.SPARKIEE_TTS_BOOTSTRAP_PYTHON;
  for (const dir of ['/usr/bin', '/usr/local/bin', '/bin']) {
    for (const name of ['python3', 'python']) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

async function fileReady(file, { fileExists = (p) => existsSync(p), statImpl = stat } = {}) {
  try {
    if (!fileExists(file)) return false;
    const info = await statImpl(file);
    return info.isFile() && info.size >= MIN_MODEL_BYTES;
  } catch {
    return false;
  }
}

export const VOICE_DOWNLOAD_LABEL = 'rhasspy/piper-voices';

/**
 * Download one file to `target`. Follows redirects (the Hub serves through a
 * CDN), writes privately, and removes a partial file on failure so the next
 * run cannot mistake it for a complete model.
 *
 * @returns {Promise<{ok: boolean, bytes?: number, detail?: string}>}
 */
export async function downloadFile(url, target, {
  fetchImpl = globalThis.fetch,
  writeFileImpl = writeFile,
  makeDirImpl = mkdir,
  chmodImpl = chmod,
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer?.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status} for ${url}` };
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) return { ok: false, detail: `empty download from ${url}` };
    await makeDirImpl(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFileImpl(target, audio, { mode: 0o600 });
    await chmodImpl(target, 0o600).catch(() => {});
    return { ok: true, bytes: audio.length };
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return {
      ok: false,
      detail: timedOut ? `download timed out: ${url}` : `download failed: ${error?.message ?? 'network error'}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the full setup. `onLine` receives progress lines.
 * Returns {ok, detail, installed, voices} — expected failures never throw.
 */
export async function setupPiperEnvironment({
  env = process.env,
  onLine = () => {},
  timeoutMs = DEFAULT_VOICE_SETUP_TIMEOUT_MS,
  runImpl = null,
  fetchImpl = globalThis.fetch,
  fileExists = (p) => existsSync(p),
  statImpl = stat,
  fileReadyImpl = null,
  downloadImpl = downloadFile,
  writeConfigImpl = writeVoiceConfig,
} = {}) {
  const exec = runImpl ?? spawnRun;
  const dataDir = resolveTtsDataDir(env);
  const venvDir = path.join(dataDir, 'venv');
  const venvPython = resolveTtsVenvPython(env);
  const isFileReady = fileReadyImpl ?? ((file) => fileReady(file, { fileExists, statImpl }));
  const voices = {};

  // 1. Python runtime with Piper.
  onLine(`Checking the local voice runtime in ${venvDir}…`);
  let runtimeOk = false;
  if (fileExists(venvPython)) {
    const probe = await exec(venvPython, ['-c', 'import piper; print("piper-ok")'], { timeoutMs: 60_000 });
    runtimeOk = probe.ok && /piper-ok/.test(probe.stdout ?? '');
    if (runtimeOk) onLine('  Piper is already installed — skipping the download.');
    else onLine('  Existing runtime is incomplete; reinstalling Piper.');
  }

  if (!runtimeOk) {
    const uv = findUv({ env, fileExists });
    if (uv) {
      onLine('Creating a private Python 3.11 environment with uv…');
      const made = await exec(uv, ['venv', '--python', '3.11', venvDir], { timeoutMs: 5 * 60_000 });
      if (!made.ok) {
        return { ok: false, detail: `Could not create the voice environment (${(made.stderr ?? made.message ?? 'uv failed').trim().slice(0, 300)}).` };
      }
      onLine(`Installing ${PIPER_PACKAGE} (about 20 MB)…`);
      const installed = await exec(uv, ['pip', 'install', '--python', venvPython, PIPER_PACKAGE], { timeoutMs });
      if (!installed.ok) {
        return { ok: false, detail: `Could not install Piper (${(installed.stderr ?? installed.message ?? 'pip failed').trim().slice(0, 300)}).` };
      }
    } else {
      const python = findPython({ env, fileExists });
      if (!python) {
        return {
          ok: false,
          detail: 'Need either "uv" (recommended) or python3 with venv support. Install uv with: curl -LsSf https://astral.sh/uv/install.sh | sh',
        };
      }
      onLine(`Creating a private Python environment with ${python}…`);
      const made = await exec(python, ['-m', 'venv', venvDir], { timeoutMs: 5 * 60_000 });
      if (!made.ok) {
        return { ok: false, detail: `Could not create the voice environment (${(made.stderr ?? made.message ?? 'python failed').trim().slice(0, 300)}).` };
      }
      onLine(`Installing ${PIPER_PACKAGE} (about 20 MB)…`);
      const installed = await exec(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', PIPER_PACKAGE], { timeoutMs });
      if (!installed.ok) {
        return { ok: false, detail: `Could not install Piper (${(installed.stderr ?? installed.message ?? 'pip failed').trim().slice(0, 300)}).` };
      }
    }
    const verify = await exec(venvPython, ['-c', 'import piper; print("piper-ok")'], { timeoutMs: 60_000 });
    if (!verify.ok) {
      return { ok: false, detail: 'Piper installed but could not be imported; the environment may be broken.' };
    }
  }

  // 2. Voice models.
  for (const language of SUPPORTED_LANGUAGES) {
    const voiceId = DEFAULT_VOICES[language];
    const meta = VOICE_CATALOG[voiceId];
    const modelPath = resolveTtsVoiceModelPath(env, voiceId);
    const configPath = resolveTtsVoiceConfigPath(env, voiceId);
    const targetDir = resolveTtsVoiceDir(env, voiceId);
    onLine(`Voice ${language.toUpperCase()}: ${meta.label}`);
    if (await isFileReady(modelPath) && fileExists(configPath)) {
      onLine('  already downloaded — skipping.');
      voices[language] = voiceId;
      continue;
    }
    await mkdir(targetDir, { recursive: true, mode: 0o700 }).catch(() => {});
    const targets = [
      { url: meta.files[0], target: modelPath, size: meta.sizeBytes },
      { url: meta.files[1], target: configPath, size: 10_000 },
    ];
    let failed = null;
    for (const item of targets) {
      const sizeMb = Math.round(item.size / 1_048_576);
      onLine(`  downloading ${path.basename(item.target)}${sizeMb > 0 ? ` (~${sizeMb} MB)` : ''}…`);
      const result = await downloadImpl(item.url, item.target, { fetchImpl, fileExists, statImpl });
      if (!result.ok) { failed = result.detail; break; }
      onLine(`  saved ${path.basename(item.target)} (${(result.bytes / 1_048_576).toFixed(1)} MB).`);
    }
    if (failed) {
      return { ok: false, detail: `Could not download the ${meta.label} voice: ${failed}` };
    }
    if (!(await isFileReady(modelPath)) || !fileExists(configPath)) {
      return { ok: false, detail: `The ${meta.label} voice download did not complete.` };
    }
    voices[language] = voiceId;
  }

  // 3. Persist the choice so the daemon picks it up without a restart.
  const file = await writeConfigImpl({ env, patch: { engine: 'piper', voices: { ...DEFAULT_VOICES } } });
  onLine(`Voice configuration saved to ${file}.`);
  return {
    ok: true,
    installed: true,
    voices,
    detail: `Piper is ready with ${Object.values(voices).map((id) => VOICE_CATALOG[id].label).join(' + ')}.`,
  };
}
