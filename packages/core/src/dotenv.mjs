/**
 * Minimal, safe .env loader.
 *
 * Only fills variables that are not already set, never expands variables or
 * executes content, and returns key names only. Values are never logged or
 * included in errors. Test runners are skipped by the CLI unless forced so a
 * developer's real keys cannot change test behaviour.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function splitAssignment(line) {
  const index = line.indexOf('=');
  if (index < 0) return null;
  const rawKey = line.slice(0, index).trim().replace(/^export\s+/u, '');
  if (!KEY_PATTERN.test(rawKey) || FORBIDDEN_KEYS.has(rawKey)) return null;
  return { key: rawKey, rawValue: line.slice(index + 1).trim() };
}

function decodeValue(raw) {
  if (raw.length >= 2) {
    const quote = raw[0];
    if ((quote === '"' || quote === "'") && raw.at(-1) === quote) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/** Parse text into { values, warnings }. Warnings never include line contents. */
export function parseDotEnv(content) {
  const values = Object.create(null);
  const warnings = [];
  const lines = String(content ?? '').replace(/^\uFEFF/u, '').split(/\r?\n/u);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const assignment = splitAssignment(trimmed);
    if (!assignment) {
      warnings.push(`Ignoring malformed line ${index + 1} in .env.`);
      return;
    }
    values[assignment.key] = decodeValue(assignment.rawValue);
  });
  return { values, warnings };
}

/**
 * Apply a .env file to `env`.
 *
 * @returns {Promise<{loaded:boolean,file?:string,applied?:string[],warnings?:string[],reason?:string}>}
 */
export async function applyDotEnv({
  file = null,
  env = process.env,
  cwd = process.cwd(),
  override = false,
  disabled = false,
  skipInTests = false,
  read = readFile,
  checkStat = stat,
} = {}) {
  if (disabled || env.SPARKIEE_DISABLE_DOTENV === '1') {
    return { loaded: false, reason: 'disabled', warnings: [] };
  }
  if (skipInTests && env.NODE_TEST_CONTEXT) {
    return { loaded: false, reason: 'test-runner', warnings: [] };
  }
  const target = path.resolve(file ?? env.SPARKIEE_ENV_FILE ?? path.join(cwd, '.env'));
  const warnings = [];
  try {
    const info = await checkStat(target);
    if ((info.mode & 0o077) !== 0) {
      warnings.push(`${target} is readable by other users; run "chmod 600 ${target}" to protect keys.`);
    }
    const parsed = parseDotEnv(await read(target, 'utf8'));
    warnings.push(...parsed.warnings);
    const applied = [];
    for (const [key, value] of Object.entries(parsed.values)) {
      if (override || env[key] === undefined) {
        env[key] = value;
        applied.push(key);
      }
    }
    return { loaded: true, file: target, applied, warnings };
  } catch (error) {
    if (error?.code === 'ENOENT') return { loaded: false, file: target, reason: 'missing', warnings };
    warnings.push(`Could not read ${target}; environment variables were not loaded from it.`);
    return { loaded: false, file: target, reason: 'unreadable', warnings };
  }
}
