import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_VERSION,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ensureAuthToken,
  ensureRuntimeHome,
  isPidAlive,
  readAuthToken,
  resolvePort,
  resolveRuntimePaths,
} from '../../core/src/index.mjs';

const DAEMON_ENTRY = fileURLToPath(new URL('../../server/src/daemon.mjs', import.meta.url));
const POLL_INTERVAL_MS = 80;
const DEFAULT_START_TIMEOUT_MS = 15_000;

function resolveStartTimeoutMs(env) {
  const raw = env.SPARKIEE_START_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_START_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 500 || value > 120_000) {
    throw new Error(`Invalid SPARKIEE_START_TIMEOUT_MS "${raw}". Expected an integer from 500 to 120000.`);
  }
  return value;
}

function describeHost(petHost) {
  if (!petHost) return 'Pet host: unknown';
  switch (petHost.phase) {
    case 'running':
      return `Pet host: running (pid ${petHost.pid})`;
    case 'launching':
      return 'Pet host: launching…';
    case 'disabled':
      return 'Pet host: disabled (SPARKIEE_DISABLE_PET=1)';
    case 'unavailable':
      return 'Pet host: unavailable (no graphical session detected)';
    case 'exited':
      return 'Pet host: stopped';
    case 'failed':
      return `Pet host: FAILED — ${petHost.lastError ?? 'unknown error'}`;
    default:
      return `Pet host: ${petHost.phase}`;
  }
}

function helpText() {
  return `Sparkiee ${APP_VERSION} — your extensible desktop-pet framework

Usage:
  sparkiee [command]

Commands:
  start       Start the local runtime and dashboard (default)
  stop        Stop the local runtime
  status      Show whether the local runtime is running
  --help      Show this help message
  --version   Show the installed version

Dashboard:
  http://${DEFAULT_HOST}:${DEFAULT_PORT}

Environment:
  SPARKIEE_PORT   HTTP port (default: ${DEFAULT_PORT})
  SPARKIEE_HOME   Runtime state directory (default: $XDG_STATE_HOME/sparkiee
                  or ~/.local/state/sparkiee)
`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(600),
    headers: { accept: 'application/json', ...options.headers },
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // An unrelated service on the requested port may return non-JSON content.
  }
  return { response, payload };
}

async function readLog(paths) {
  try {
    return await readFile(paths.logFile, 'utf8');
  } catch {
    return '';
  }
}

async function getRuntime(port) {
  try {
    const { response, payload } = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/runtime`);
    if (response.ok && payload?.name === 'Sparkiee') return payload;
  } catch {
    // Not running; the caller decides whether this is an error.
  }
  return null;
}

async function waitForStartup({ childPid, port, paths, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = await getRuntime(port);
    if (runtime) return runtime;

    const log = await readLog(paths);
    if (log.includes(`EADDRINUSE: port ${port}`)) {
      throw new Error(`Port ${port} is already in use on ${DEFAULT_HOST}. Stop the other service or set SPARKIEE_PORT to a free port.`);
    }
    if (!isPidAlive(childPid)) {
      const recent = log.trim().split('\n').slice(-3).join('\n');
      throw new Error(`The runtime exited during startup.${recent ? `\n${recent}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (isPidAlive(childPid)) {
    throw new Error(
      `The runtime (pid ${childPid}) is still running but did not answer within ${timeoutMs / 1000} seconds. ` +
      `Check ${paths.logFile}, then run "sparkiee stop" before retrying.`,
    );
  }
  throw new Error(`Sparkiee did not become ready within ${timeoutMs / 1000} seconds. Check ${paths.logFile}.`);
}

async function start(env) {
  const port = resolvePort(env);
  const timeoutMs = resolveStartTimeoutMs(env);
  const paths = resolveRuntimePaths(env);
  await ensureRuntimeHome(paths);

  const existing = await getRuntime(port);
  if (existing) {
    process.stdout.write(`Sparkiee is already running at ${existing.dashboardUrl} (pid ${existing.pid}).\n${describeHost(existing.petHost)}\n`);
    return;
  }

  // Guard against a hung or still-booting daemon that owns the port but does
  // not answer: do not spawn a duplicate that would only fail with EADDRINUSE.
  const stalePid = Number((await readFile(paths.pidFile, 'utf8').catch(() => '0')).trim());
  if (isPidAlive(stalePid)) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const late = await getRuntime(port);
      if (late) {
        process.stdout.write(`Sparkiee is already running at ${late.dashboardUrl} (pid ${late.pid}).\n${describeHost(late.petHost)}\n`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(
      `A Sparkiee runtime (pid ${stalePid}) is running but not answering on port ${port}. ` +
      `Run "sparkiee stop" first, or remove ${paths.pidFile} if the process is a leftover.`,
    );
  }

  // Persist a token before starting the detached daemon so the CLI and daemon share one credential.
  await ensureAuthToken(paths);
  const logFd = openSync(paths.logFile, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [DAEMON_ENTRY], {
      cwd: path.dirname(DAEMON_ENTRY),
      env: { ...env, SPARKIEE_PORT: String(port), SPARKIEE_HOME: paths.home },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  if (!child.pid) throw new Error('Unable to launch the Sparkiee runtime process.');

  const runtime = await waitForStartup({ childPid: child.pid, port, paths, timeoutMs });
  process.stdout.write(`Sparkiee started successfully.\nDashboard: ${runtime.dashboardUrl}\nPID: ${runtime.pid}\n${describeHost(runtime.petHost)}\n`);
}

async function status(env) {
  const port = resolvePort(env);
  const runtime = await getRuntime(port);
  if (!runtime) {
    process.stdout.write(`Sparkiee is not running at http://${DEFAULT_HOST}:${port}.\n`);
    return;
  }
  process.stdout.write(
    `Sparkiee is running.\n` +
    `Daemon: healthy — state ${runtime.state}, pid ${runtime.pid}, uptime ${runtime.uptimeSeconds}s\n` +
    `${describeHost(runtime.petHost)}\n` +
    `Dashboard: ${runtime.dashboardUrl}\n`,
  );
}

async function stop(env) {
  const port = resolvePort(env);
  const paths = resolveRuntimePaths(env);
  const runtime = await getRuntime(port);
  if (!runtime) {
    process.stdout.write(`Sparkiee is not running at http://${DEFAULT_HOST}:${port}.\n`);
    return;
  }

  const token = await readAuthToken(paths);
  const { response, payload } = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/shutdown`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(payload?.error ?? `Runtime shutdown failed with HTTP ${response.status}.`);

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!(await getRuntime(port))) {
      process.stdout.write('Sparkiee stopped.\n');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Shutdown was requested but the runtime is still responding. Inspect ${paths.logFile}.`);
}

export async function runCli(argv, env = process.env) {
  const command = argv[0] ?? 'start';
  if (argv.length > 1) throw new Error(`Unexpected arguments: ${argv.slice(1).join(' ')}. Run "sparkiee --help".`);

  switch (command) {
    case 'start':
      await start(env);
      return;
    case 'stop':
      await stop(env);
      return;
    case 'status':
      await status(env);
      return;
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(helpText());
      return;
    case '--version':
    case '-v':
      process.stdout.write(`${APP_VERSION}\n`);
      return;
    default:
      throw new Error(`Unknown command "${command}". Run "sparkiee --help".`);
  }
}
