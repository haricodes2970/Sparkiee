import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { ensureRuntimeHome, readAuthToken, resolvePort, resolveRuntimePaths } from '../../core/src/index.mjs';
import { createSparkieeServer } from './server.mjs';

const paths = resolveRuntimePaths();
const port = resolvePort();
const host = '127.0.0.1';
let httpServer;
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

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  await log(`Shutting down (${reason}).`);
  await removePidIfOwned();
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
  httpServer = createSparkieeServer({ port, token, onShutdown: () => void shutdown('API request') });

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
