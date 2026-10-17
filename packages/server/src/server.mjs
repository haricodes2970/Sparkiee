import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAuthorized, toRuntimePayload, DEFAULT_HOST } from '../../core/src/index.mjs';
import { createPetController, isValidPetCommandPayload } from '../../core/src/pet-state.mjs';

const DASHBOARD_ROOT = fileURLToPath(new URL('../../dashboard/', import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/src/main.js', ['src/main.js', 'text/javascript; charset=utf-8']],
  ['/src/styles.css', ['src/styles.css', 'text/css; charset=utf-8']],
  ['/src/pet-controls.css', ['src/pet-controls.css', 'text/css; charset=utf-8']],
]);

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

async function readJsonBody(request, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    const error = new Error('A JSON request body is required.');
    error.statusCode = 400;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Malformed JSON request body.');
    error.statusCode = 400;
    throw error;
  }
}

function isSameOriginDashboardRequest(request, port) {
  const origin = request.headers.origin;
  const requestHost = request.headers.host;
  if (typeof origin !== 'string' || typeof requestHost !== 'string') return false;
  if (origin !== `http://${requestHost}`) return false;
  if (!requestHost.endsWith(`:${port}`)) return false;
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

async function serveStatic(response, route) {
  const target = STATIC_FILES.get(route);
  if (!target) return false;
  const [relativePath, contentType] = target;
  const rootPath = path.resolve(DASHBOARD_ROOT);
  const fullPath = path.resolve(rootPath, relativePath);
  if (!fullPath.startsWith(`${rootPath}${path.sep}`) && fullPath !== path.resolve(rootPath, 'index.html')) {
    sendJson(response, 400, { error: 'Invalid asset path' });
    return true;
  }
  try {
    await access(fullPath);
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': fileStat.size,
      'cache-control': route === '/' || route === '/index.html' ? 'no-cache' : 'public, max-age=60',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    });
    createReadStream(fullPath).pipe(response);
  } catch {
    sendJson(response, 500, { error: 'Dashboard asset unavailable' });
  }
  return true;
}

/** Create the loopback-only Sparkiee HTTP API and dashboard server. */
export function createSparkieeServer({
  port,
  token,
  startedAt = Date.now(),
  onShutdown = () => {},
  petController = createPetController(),
  getHostState = () => ({ phase: 'idle', pid: null, pidAlive: false, lastError: null, restarts: 0, since: startedAt }),
  onRestartHost = () => {},
}) {
  let shutdownRequested = false;
  const server = createServer(async (request, response) => {
    const host = request.socket.localAddress;
    if (host && host !== '127.0.0.1' && host !== '::ffff:127.0.0.1') {
      sendJson(response, 403, { error: 'Loopback access only' });
      return;
    }

    const method = request.method ?? 'GET';
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      sendJson(response, 400, { error: 'Invalid request URL' });
      return;
    }

    if (method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { ok: true, name: 'Sparkiee', version: '0.1.0' });
      return;
    }
    if (method === 'GET' && pathname === '/api/v1/runtime') {
      sendJson(response, 200, toRuntimePayload({ port, startedAt, host: getHostState() }));
      return;
    }
    if (method === 'GET' && pathname === '/api/v1/pet/state') {
      if (isAuthorized(request, token)) petController.heartbeat();
      sendJson(response, 200, petController.snapshot());
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/pet/command') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
        return;
      }
      if (!isValidPetCommandPayload(payload)) {
        sendJson(response, 400, { error: 'Invalid pet command payload.' });
        return;
      }
      sendJson(response, 200, { ok: true, pet: petController.command(payload.command) });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/host/restart') {
      if (!isAuthorized(request, token) && !isSameOriginDashboardRequest(request, port)) {
        sendJson(response, 403, { error: 'Forbidden: provide the local runtime token or use the same-origin dashboard.' });
        return;
      }
      try {
        await onRestartHost();
      } catch (error) {
        sendJson(response, 500, { error: `Pet host restart failed: ${error.message}`, host: getHostState() });
        return;
      }
      sendJson(response, 202, { ok: true, host: getHostState() });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/shutdown') {
      if (!isAuthorized(request, token)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (shutdownRequested) {
        sendJson(response, 202, { ok: true, state: 'stopping' });
        return;
      }
      shutdownRequested = true;
      sendJson(response, 202, { ok: true, state: 'stopping' });
      setTimeout(() => onShutdown(), 25).unref();
      return;
    }
    if (method === 'GET' && await serveStatic(response, pathname)) return;
    if (method === 'OPTIONS') {
      response.writeHead(405, { allow: 'GET, POST' });
      response.end();
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 2_000;
  return server;
}
