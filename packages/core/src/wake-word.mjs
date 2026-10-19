/**
 * Wake-word provider abstraction — "Yo Spark" with honest status.
 *
 * The only engine that truly supports custom phrases locally is Porcupine
 * (Picovoice). It needs three things the user must supply:
 *   1. `@picovoice/porcupine-node` installed (`npm i @picovoice/porcupine-node`).
 *   2. A Picovoice AccessKey (free tier, personal use).
 *   3. A `.ppn` keyword model trained on the Console for "Yo Spark"
 *      (platform-specific: linux_x86_64 here).
 *
 * Until all three are present the probe reports `needs-setup` with a
 * precise checklist. The daemon never fakes a wake detection.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveVoiceConfigDir } from './voice-config.mjs';

export const WAKE_PHRASE = 'Yo Spark';

export async function probeWakeWordSetup({
  env = process.env,
  configDir = resolveVoiceConfigDir(env),
  resolveModule = (specifier) => createRequire(import.meta.url).resolve(specifier),
  fileStat = statSync,
  fileExists = existsSync,
} = {}) {
  // 1. Node module presence.
  let modulePresent = false;
  try {
    resolveModule('@picovoice/porcupine-node');
    modulePresent = true;
  } catch {
    // absent
  }

  // 2. AccessKey: env var OR wake.json.
  const accessKeyEnv = env.SPARKIEE_PICOVOICE_ACCESS_KEY?.trim() || '';
  const accessKeyConfig = (() => {
    const wakePath = `${configDir}/wake.json`;
    if (!fileExists(wakePath)) return '';
    try {
      const data = JSON.parse(readFileSync(wakePath, 'utf8'));
      return String(data.accessKey ?? '').trim();
    } catch {
      return '';
    }
  })();
  const accessKeyPresent = Boolean(accessKeyEnv || accessKeyConfig);

  // 3. Keyword model file: default path OR wake.json override.
  const defaultModel = `${configDir}/wake/yo-spark_linux_x86_64.ppn`;
  const modelConfig = (() => {
    const wakePath = `${configDir}/wake.json`;
    if (!fileExists(wakePath)) return null;
    try {
      const data = JSON.parse(readFileSync(wakePath, 'utf8'));
      return data.keywordPath || null;
    } catch {
      return null;
    }
  })();
  const keywordPath = modelConfig || (fileExists(defaultModel) ? defaultModel : null);
  const modelPresent = Boolean(keywordPath && fileExists(keywordPath));

  const missing = [];
  if (!modulePresent) missing.push('node-module');
  if (!accessKeyPresent) missing.push('access-key');
  if (!modelPresent) missing.push('keyword-model');

  const status = missing.length === 0 ? 'ready' : 'needs-setup';
  const detail = status === 'ready'
    ? 'Custom wake word is configured and will be used when listening is enabled.'
    : `Missing: ${missing.join(', ')}. See docs for: npm install, Picovoice Console AccessKey, and training "Yo Spark" → .ppn for linux_x86_64.`;

  return {
    phrase: WAKE_PHRASE,
    provider: 'porcupine',
    status,
    missing,
    accessKeyPresent,
    keywordModel: keywordPath ? { present: true, name: keywordPath.split('/').pop() } : { present: false, name: null },
    detail,
    // Internal hints for the daemon (never sent over HTTP).
    _internals: modulePresent && accessKeyPresent && modelPresent
      ? { module: '@picovoice/porcupine-node', accessKey: accessKeyEnv || accessKeyConfig, keywordPath }
      : null,
  };
}

/**
 * Thin wrapper around the real Porcupine instance. The exact API of
 * porcupine-node v3 is wrapped here so the rest of the codebase does not
 * depend on its exact shape — if it changes, only this adapter moves.
 *
 * In tests a fake detector is injected, so the real module is never required.
 */
export function createDetector({ Porcupine, accessKey, keywordPath, sensitivity = 0.5 }) {
  let instance;
  let frameLength = 512; // Porcupine default; overwritten after init
  let sampleRate = 16000;

  try {
    instance = new Porcupine({
      accessKey,
      keywordPaths: [keywordPath],
      sensitivities: [sensitivity],
    });
    frameLength = instance.frameLength;
    sampleRate = instance.sampleRate;
  } catch (error) {
    return {
      frameLength,
      sampleRate,
      process: () => { throw error; },
      dispose: () => {},
    };
  }

  return {
    frameLength,
    sampleRate,
    process(pcmFrame) {
      // Porcupine.process returns the keyword index (>=0) or -1.
      const idx = instance.process(pcmFrame);
      return idx >= 0;
    },
    dispose() {
      if (instance) {
        instance.release();
        instance = null;
      }
    },
  };
}