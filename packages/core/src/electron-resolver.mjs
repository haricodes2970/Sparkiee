import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve the Electron binary path WITHOUT triggering a download.
 *
 * The stock `electron` npm entry point runs `spawnSync(install.js)` when the
 * binary is missing, which blocks the Node.js event loop for as long as the
 * download takes. The Sparkiee daemon must never block its HTTP server, so it
 * resolves the binary itself and reports an actionable failure instead.
 *
 * @param {object} [options]
 * @param {string} options.electronDir Absolute path to the installed `electron` package directory.
 * @param {string} [options.overrideDistPath] Value of ELECTRON_OVERRIDE_DIST_PATH, if set.
 * @returns {{ok: true, binary: string} | {ok: false, reason: 'not-installed'|'binary-missing'|'invalid-package', detail: string, hint: string}}
 */
export function resolveElectronBinary({ electronDir, overrideDistPath } = {}) {
  if (typeof electronDir !== 'string' || electronDir.length === 0) {
    return {
      ok: false,
      reason: 'not-installed',
      detail: 'The electron package is not installed.',
      hint: 'Run npm install in the Sparkiee directory to install the Electron dependency.',
    };
  }
  const pathFile = path.join(electronDir, 'path.txt');
  let executableName = '';
  if (existsSync(pathFile)) {
    try {
      executableName = readFileSync(pathFile, 'utf8').trim();
    } catch {
      return {
        ok: false,
        reason: 'invalid-package',
        detail: `Electron package at ${electronDir} has an unreadable path.txt.`,
        hint: 'Delete node_modules/electron and run npm install again.',
      };
    }
  }
  if (overrideDistPath) {
    const binary = path.join(overrideDistPath, executableName || 'electron');
    if (existsSync(binary)) return { ok: true, binary };
    return {
      ok: false,
      reason: 'binary-missing',
      detail: `ELECTRON_OVERRIDE_DIST_PATH points to ${overrideDistPath}, but no Electron binary was found there.`,
      hint: 'Unset ELECTRON_OVERRIDE_DIST_PATH or point it at a directory that contains an Electron binary.',
    };
  }
  if (!executableName) {
    return {
      ok: false,
      reason: 'not-installed',
      detail: `Electron package at ${electronDir} has no path.txt, so the binary was never downloaded.`,
      hint: 'Run npm install in the Sparkiee directory (the electron postinstall downloads the binary).',
    };
  }
  const binary = path.join(electronDir, 'dist', executableName);
  if (!existsSync(binary)) {
    return {
      ok: false,
      reason: 'binary-missing',
      detail: `Electron binary is missing at ${binary}.`,
      hint: 'Delete node_modules/electron and run npm install again to re-download the binary.',
    };
  }
  return { ok: true, binary };
}
