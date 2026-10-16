import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'Sparkiee';
export const APP_VERSION = '0.1.0';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 2005;
export const PROTOCOL_VERSION = 1;

export function resolveRuntimePaths(env = process.env) {
  const stateBase = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const home = env.SPARKIEE_HOME || path.join(stateBase, 'sparkiee');
  return {
    home,
    pidFile: path.join(home, 'sparkiee.pid'),
    tokenFile: path.join(home, 'runtime.token'),
    logFile: path.join(home, 'daemon.log'),
  };
}

export function resolvePort(env = process.env) {
  const raw = env.SPARKIEE_PORT ?? String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SPARKIEE_PORT "${raw}". Expected an integer from 1 to 65535.`);
  }
  return port;
}

export async function ensureRuntimeHome(paths = resolveRuntimePaths()) {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  try {
    await chmod(paths.home, 0o700);
  } catch {
    // Some filesystems/platforms do not support POSIX permission semantics.
  }
}

export async function ensureAuthToken(paths = resolveRuntimePaths()) {
  await ensureRuntimeHome(paths);
  try {
    const file = await open(paths.tokenFile, 'wx', 0o600);
    try {
      await file.writeFile(`${randomBytes(32).toString('hex')}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  try {
    await chmod(paths.tokenFile, 0o600);
  } catch {
    // Best-effort hardening on filesystems with POSIX permissions.
  }
  return readAuthToken(paths);
}

export async function readAuthToken(paths = resolveRuntimePaths()) {
  try {
    const token = (await readFile(paths.tokenFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) {
      throw new Error('Sparkiee runtime token is malformed. Remove runtime.token and restart Sparkiee.');
    }
    return token;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Sparkiee token not found at ${paths.tokenFile}. Run "sparkiee start" first.`);
    }
    throw error;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function isAuthorized(request, expectedToken) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return false;
  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
  if (!match) return false;
  const provided = Buffer.from(match[1], 'hex');
  const expected = Buffer.from(expectedToken, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function toRuntimePayload({ port, startedAt, pid = process.pid }) {
  return {
    name: APP_NAME,
    version: APP_VERSION,
    state: 'ready',
    pid,
    host: DEFAULT_HOST,
    port,
    dashboardUrl: `http://${DEFAULT_HOST}:${port}`,
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    protocolVersion: PROTOCOL_VERSION,
  };
}
