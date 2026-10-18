import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
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
import {
  DEFAULT_MODEL_ID,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_VOICE_ID,
  describeVoiceConfig,
  isValidApiKey,
  isValidVoiceId,
  loadVoiceConfig,
  resolveVoiceConfigPath,
  writeVoiceConfig,
} from '../../core/src/voice-config.mjs';
import { createElevenLabsClient } from '../../core/src/tts-client.mjs';
import { describeSpeechError } from '../../server/src/voice-service.mjs';

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
  start        Start the local runtime and dashboard (default)
  stop         Stop the local runtime
  status       Show whether the local runtime is running
  voice status Show whether Sparky's spoken voice is configured
  voice setup  Store the ElevenLabs API key (never echoed)
  voice test   Speak a short test phrase on the desktop pet
  voice mute   Mute all sound (captions keep working)
  voice unmute Unmute sound
  --help       Show this help message
  --version    Show the installed version

Dashboard:
  http://${DEFAULT_HOST}:${DEFAULT_PORT}

Environment:
  SPARKIEE_PORT   HTTP port (default: ${DEFAULT_PORT})
  SPARKIEE_HOME   Runtime state directory (default: $XDG_STATE_HOME/sparkiee
                  or ~/.local/state/sparkiee)
  ELEVENLABS_API_KEY  Optional voice-provider key (overrides voice setup)
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

// ---------------------------------------------------------------------------
// Voice commands: configure and control Sparky's spoken voice without ever
// printing the API key.
// ---------------------------------------------------------------------------

/** Read a secret from the terminal without echoing it. */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = true;
    rl._writeToOutput = (stringToWrite) => {
      if (muted) rl.output.write('•');
      else rl.output.write(stringToWrite);
    };
    rl.question(question, (answer) => {
      muted = false;
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function voiceStatus(env) {
  const loaded = await loadVoiceConfig({ env });
  const described = describeVoiceConfig(loaded);
  process.stdout.write(
    `Voice provider: ElevenLabs\n` +
    `Configured: ${described.configured ? `yes (from ${described.source})` : 'no — original chirps are in use'}\n` +
    `Voice id: ${described.voiceId}${described.voiceId === DEFAULT_VOICE_ID ? ' (Sparky default)' : ''}\n` +
    `Model: ${described.modelId}\n` +
    `Output: ${described.outputFormat}\n` +
    `Config file: ${resolveVoiceConfigPath(env)}\n`,
  );
  for (const warning of described.warnings) process.stdout.write(`Warning: ${warning}\n`);
  if (!described.configured) {
    process.stdout.write(`Set the key with ELEVENLABS_API_KEY or "sparkiee voice setup".\n`);
  }

  // Daemon-side view when the runtime is up (never contains secrets).
  const port = resolvePort(env);
  const runtime = await getRuntime(port);
  if (!runtime) {
    process.stdout.write(`Runtime: not running — start it with "sparkiee start".\n`);
    return;
  }
  try {
    const { response, payload } = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/voice/status`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const voice = payload.voice ?? {};
    const state = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/pet/state`);
    const speech = state.payload?.settings?.speech ?? {};
    process.stdout.write(
      `Runtime: daemon sees provider ${voice.configured ? 'configured' : 'not configured'}\n` +
      `Spoken reactions: ${speech.enabled === false ? 'disabled' : `enabled (${speech.style ?? 'speech'} style)`}\n` +
      `Sound: ${state.payload?.settings?.audio?.enabled === false ? 'muted (captions keep working)' : 'on'}\n` +
      `Speech cache: ${voice.cacheFiles ?? 0} clips (${Math.round((voice.cacheBytes ?? 0) / 1024)} KB)\n` +
      (voice.lastError ? `Last speech error: ${describeSpeechError(voice.lastError)}\n` : ''),
    );
    for (const warning of payload.warnings ?? []) process.stdout.write(`Runtime warning: ${warning}\n`);
  } catch {
    process.stdout.write(`Runtime: running but voice status unavailable.\n`);
  }
}

async function voiceSetup(env, args) {
  let keyFile = null;
  let verify = true;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--key-file') {
      keyFile = args[index + 1];
      index += 1;
      if (!keyFile) throw new Error('--key-file requires a path.');
    } else if (args[index] === '--no-verify') {
      verify = false;
    } else {
      throw new Error(`Unknown option "${args[index]}". Usage: sparkiee voice setup [--key-file <path>] [--no-verify]`);
    }
  }

  let key = null;
  if (keyFile) {
    key = (await readFile(path.resolve(keyFile), 'utf8')).trim();
  } else if (!process.stdin.isTTY) {
    // Piped input: echo "$KEY" | sparkiee voice setup
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    key = Buffer.concat(chunks).toString('utf8').trim();
  } else {
    key = await promptHidden('ElevenLabs API key (input hidden): ');
  }
  if (!isValidApiKey(key)) {
    throw new Error('That does not look like an ElevenLabs API key (expected 20-256 letters, digits, - or _).');
  }

  const voiceId = env.SPARKIEE_VOICE_ID && isValidVoiceId(env.SPARKIEE_VOICE_ID) ? env.SPARKIEE_VOICE_ID : DEFAULT_VOICE_ID;
  const modelId = typeof env.SPARKIEE_VOICE_MODEL === 'string' && /^[a-z0-9_]{3,64}$/.test(env.SPARKIEE_VOICE_MODEL)
    ? env.SPARKIEE_VOICE_MODEL
    : DEFAULT_MODEL_ID;

  if (verify) {
    process.stdout.write('Verifying the key and voice with ElevenLabs (no credits used)…\n');
    const client = createElevenLabsClient({ config: { apiKey: key, voiceId, modelId, outputFormat: DEFAULT_OUTPUT_FORMAT } });
    const result = await client.verify();
    if (result.code === 'auth') {
      throw new Error('ElevenLabs rejected that key. Double-check it and run "sparkiee voice setup" again. Nothing was saved.');
    }
    if (result.code === 'validation') {
      throw new Error(`${result.message} Nothing was saved. Use SPARKIEE_VOICE_ID to pick another voice.`);
    }
    if (!result.ok) {
      process.stdout.write(`Warning: could not verify right now (${result.message}). Saving anyway — run "sparkiee voice status" later.\n`);
    } else {
      process.stdout.write(`Voice verified${result.name ? `: “${result.name}”` : ''}.\n`);
    }
  }

  const file = await writeVoiceConfig({ env, apiKey: key, voiceId, modelId, outputFormat: DEFAULT_OUTPUT_FORMAT });
  process.stdout.write(
    `Key saved (${key.length} characters, never logged) to ${file} with 0600 permissions.\n` +
    `Try it: "sparkiee voice test" (uses a few credits) or press Test spoken voice in the dashboard.\n`,
  );
}

async function requireDaemon(env) {
  const port = resolvePort(env);
  const runtime = await getRuntime(port);
  if (!runtime) {
    throw new Error(`Sparkiee is not running. Start it with "sparkiee start", then retry.`);
  }
  const paths = resolveRuntimePaths(env);
  const token = await readAuthToken(paths);
  return { port, token };
}

async function voiceTest(env) {
  const { port, token } = await requireDaemon(env);
  const { response, payload } = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/voice/test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (response.status === 429) throw new Error(payload?.error ?? 'Too many voice test requests — wait a moment.');
  if (!response.ok) throw new Error(payload?.error ?? `Voice test failed with HTTP ${response.status}.`);
  if (payload.generated) {
    process.stdout.write(
      `Sparky is speaking on the desktop pet: “${payload.speech.text}”\n` +
      `The caption appears under the character even when sound is muted.\n`,
    );
  } else {
    process.stdout.write(
      `The test phrase could not be generated (${payload.speech?.error ?? 'unknown error'}).\n` +
      `${describeSpeechError(payload.speech?.error)}\n` +
      `Original chirps keep working in the meantime.\n`,
    );
  }
}

async function voiceMute(env, unmute) {
  const { port, token } = await requireDaemon(env);
  const { response, payload } = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/pet/settings`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ audio: { enabled: unmute } }),
  });
  if (!response.ok) throw new Error(payload?.error ?? `Settings update failed with HTTP ${response.status}.`);
  process.stdout.write(unmute
    ? 'Sound unmuted. Sparky can chirp and speak again.\n'
    : 'Sound muted. Subtitles under the pet keep working — that is the design.\n');
}

async function runVoiceCommand(subcommand, args, env) {
  switch (subcommand) {
    case 'status':
      await voiceStatus(env);
      return;
    case 'setup':
      await voiceSetup(env, args);
      return;
    case 'test':
      await voiceTest(env);
      return;
    case 'mute':
      await voiceMute(env, false);
      return;
    case 'unmute':
      await voiceMute(env, true);
      return;
    default:
      throw new Error(`Unknown voice command "voice ${subcommand}". Try: voice status | setup | test | mute | unmute.`);
  }
}

export async function runCli(argv, env = process.env) {
  const command = argv[0] ?? 'start';
  if (command === 'voice') {
    await runVoiceCommand(argv[1] ?? 'status', argv.slice(2), env);
    return;
  }
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
