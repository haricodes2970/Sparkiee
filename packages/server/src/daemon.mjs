import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRuntimeHome, readAuthToken, resolvePort, resolveRuntimePaths } from '../../core/src/index.mjs';
import { resolveElectronBinary } from '../../core/src/electron-resolver.mjs';
import { createHostTracker } from '../../core/src/host-tracker.mjs';
import { createSparkieeServer } from './server.mjs';

const paths = resolveRuntimePaths();
const port = resolvePort();
const host = '127.0.0.1';
const require = createRequire(import.meta.url);
const PET_APP_DIR = fileURLToPath(new URL('../../pet-host/', import.meta.url));
const petDisabled = process.env.SPARKIEE_DISABLE_PET === '1';
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const hostTracker = createHostTracker({ disabled: petDisabled, noDisplay });
const MAX_HOST_RESTARTS = 3;
let runtimeToken = null;
let restartTimer;
let httpServer;
let petHost;
let shuttingDown = false;

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await appendFile(paths.logFile, line, { mode: 0o600 });
  } catch {
    process.stderr.write(line);
  }
}

async function removePidIfOwned() {
  try {
    const currentPid = Number((await readFile(paths.pidFile, 'utf8')).trim());
    if (currentPid === process.pid) await unlink(paths.pidFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') await log(`Unable to remove PID file: ${error.message}`);
  }
}

function launchPetHost(token) {
  if (!hostTracker.canLaunch()) {
    void log(petDisabled
      ? 'Desktop pet host disabled by SPARKIEE_DISABLE_PET=1.'
      : 'No graphical display detected; dashboard is running without a desktop pet host.');
    return;
  }
  hostTracker.markLaunching();
  try {
    // Resolve the Electron binary without the stock `electron` entry point,
    // which downloads synchronously and would block the HTTP server (the bug
    // behind the "did not become ready" CLI timeout on first run).
    let electronDir;
    try {
      electronDir = path.dirname(require.resolve('electron/package.json'));
    } catch {
      electronDir = undefined;
    }
    const resolved = resolveElectronBinary({ electronDir, overrideDistPath: process.env.ELECTRON_OVERRIDE_DIST_PATH });
    if (!resolved.ok) {
      hostTracker.markFailed(`${resolved.detail} ${resolved.hint}`);
      void log(`Desktop pet host unavailable: ${hostTracker.snapshot().lastError}`);
      return;
    }
    petHost = spawn(resolved.binary, [PET_APP_DIR], {
      cwd: PET_APP_DIR,
      env: {
        ...process.env,
        SPARKIEE_PORT: String(port),
        SPARKIEE_HOME: paths.home,
        SPARKIEE_RUNTIME_TOKEN: token,
      },
      stdio: 'ignore',
      detached: false,
    });
    petHost.on('spawn', () => {
      if (petHost?.pid) hostTracker.markRunning(petHost.pid);
      void log(`Desktop pet host running (pid ${petHost?.pid ?? 'unknown'}).`);
    });
    petHost.on('error', (error) => {
      hostTracker.markFailed(`Could not launch desktop pet host: ${error.message}. Ensure dependencies are installed with npm install.`);
      void log(hostTracker.snapshot().lastError);
    });
    petHost.on('exit', (code, signal) => {
      hostTracker.markExited(code, signal, { wasShuttingDown: shuttingDown });
      void log(`Desktop pet host exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`);
      petHost = undefined;
      scheduleHostRestart();
    });
    void log('Desktop pet host launch requested.');
  } catch (error) {
    hostTracker.markFailed(`Desktop pet host unavailable: ${error.message}. Run npm install and check Electron dependencies.`);
    void log(hostTracker.snapshot().lastError);
  }
}

function scheduleHostRestart() {
  if (shuttingDown || !hostTracker.canLaunch() || !runtimeToken) return;
  if (restartTimer) return;
  if (hostTracker.restarts >= MAX_HOST_RESTARTS) {
    void log(`Desktop pet host restart limit (${MAX_HOST_RESTARTS}) reached. Use the dashboard retry action or restart Sparkiee.`);
    return;
  }
  const delay = 1_000 * (2 ** hostTracker.restarts);
  hostTracker.countRestart();
  void log(`Scheduling desktop pet host restart in ${delay}ms (attempt ${hostTracker.restarts}/${MAX_HOST_RESTARTS}).`);
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    if (!shuttingDown && !petHost) launchPetHost(runtimeToken);
  }, delay);
  restartTimer.unref();
}

async function restartHost() {
  if (!hostTracker.canLaunch()) {
    hostTracker.markFailed(petDisabled
      ? 'Pet host cannot start: disabled by SPARKIEE_DISABLE_PET=1.'
      : 'Pet host cannot start: no graphical session was detected.');
    return;
  }
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }
  hostTracker.resetFailures();
  if (petHost && !petHost.killed) {
    // Already running; report the live process instead of spawning a duplicate.
    return;
  }
  await log('Desktop pet host restart requested.');
  launchPetHost(runtimeToken);
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }
  await log(`Shutting down (${reason}).`);
  await removePidIfOwned();
  if (petHost && !petHost.killed) {
    petHost.kill('SIGTERM');
    const childToKill = petHost;
    setTimeout(() => {
      if (childToKill.exitCode === null && !childToKill.killed) childToKill.kill('SIGKILL');
    }, 1800).unref();
  }
  if (!httpServer?.listening) {
    process.exitCode = 0;
    return;
  }
  httpServer.close(() => {
    process.exitCode = 0;
  });
  setTimeout(() => httpServer.closeAllConnections(), 2_000).unref();
}

async function main() {
  await ensureRuntimeHome(paths);
  const token = await readAuthToken(paths);
  httpServer = createSparkieeServer({
    port,
    token,
    onShutdown: () => void shutdown('API request'),
    getHostState: () => hostTracker.snapshot(),
    onRestartHost: () => restartHost(),
  });
  runtimeToken = token;

  httpServer.on('error', async (error) => {
    if (error?.code === 'EADDRINUSE') {
      await log(`EADDRINUSE: port ${port} is already in use on ${host}.`);
    } else {
      await log(`Server error: ${error?.stack ?? error}`);
    }
    process.exitCode = 1;
    await removePidIfOwned();
    if (httpServer?.listening) httpServer.close();
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(port, host);
  });

  await writeFile(paths.pidFile, `${process.pid}\n`, { mode: 0o600 });
  await log(`Sparkiee ready at http://${host}:${port} (pid ${process.pid}).`);
  launchPetHost(token);
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', async (error) => {
    await log(`Uncaught exception: ${error?.stack ?? error}`);
    await shutdown('uncaught exception');
    process.exitCode = 1;
  });
  process.on('unhandledRejection', async (error) => {
    await log(`Unhandled rejection: ${error?.stack ?? error}`);
    await shutdown('unhandled rejection');
    process.exitCode = 1;
  });
}

main().catch(async (error) => {
  if (error?.code === 'EADDRINUSE') {
    await log(`EADDRINUSE: port ${port} is already in use on ${host}.`);
  } else {
    await log(`Startup failed: ${error?.stack ?? error}`);
  }
  process.exitCode = 1;
  process.exit();
});
