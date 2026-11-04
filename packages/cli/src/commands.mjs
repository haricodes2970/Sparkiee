import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile, unlink, stat, open } from 'node:fs/promises';
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
import {
  DEFAULT_NVIDIA_BASE_URL,
  describeNvidiaConfig,
  isValidNvidiaApiKey,
  loadNvidiaConfig,
  resolveNvidiaConfigPath,
  writeNvidiaConfig,
} from '../../core/src/nvidia-config.mjs';
import { createNvidiaChatClient } from '../../core/src/chat-client.mjs';
import { setupSttEnvironment, MAX_SETUP_TIMEOUT_MS } from '../../core/src/stt-setup.mjs';
import { createGnomeHotkeyInstaller } from '../../core/src/gnome-hotkey.mjs';
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
  ptt toggle   Start or stop a push-to-talk recording (used by the OS keybinding)
  assistant setup  Connect the chat assistant: store the NVIDIA API key (never
               echoed), verify it, and pick a model from the live list
  assistant setup --remove
               Forget the stored NVIDIA key (unrelated settings preserved)
  assistant status
               Show honest, separate readiness for mic, STT, NVIDIA, TTS
  assistant reset
               Forget the in-memory conversation history
  assistant stt-setup  One-time local speech-recognition setup (venv + tiny.en model)
  assistant hotkey install|status|remove
               Manage the GNOME media-keys fallback binding for the mic shortcut
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
  NVIDIA_API_KEY      Optional chat key (overrides assistant setup; daemon only)
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

async function waitForStartup({ childPid, port, paths, timeoutMs, logOffset = 0 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = await getRuntime(port);
    if (runtime) return runtime;

    // Only this run's fresh log bytes: the log file holds history from
    // earlier sessions, and a stale "EADDRINUSE" line from yesterday must
    // never make a healthy startup today look failed.
    const log = await logFileTailFrom(paths, logOffset);
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

/** Read only the log bytes written after `offset`. Offset out of range → empty. */
async function logFileTailFrom(paths, offset) {
  try {
    const handle = await open(paths.logFile, 'r');
    try {
      const { size } = await handle.stat();
      const begin = Math.max(0, Math.min(offset, size));
      const buf = Buffer.alloc(size - begin);
      await handle.read(buf, 0, buf.length, begin);
      return buf.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
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
  // A pid file whose owner is already gone is stale — remove it here so the
  // next start cannot be confused by it (stop cleans its own, crashes cannot).
  let stalePid = Number((await readFile(paths.pidFile, 'utf8').catch(() => '0')).trim());
  if (Number.isInteger(stalePid) && !isPidAlive(stalePid)) {
    try { await unlink(paths.pidFile); } catch { /* already gone */ }
    stalePid = 0;
  }
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
  // Capture the log size before spawning so startup detection only scans
  // bytes this run produced (see waitForStartup).
  let logOffset = 0;
  try { logOffset = (await stat(paths.logFile)).size; } catch { logOffset = 0; }
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

  const runtime = await waitForStartup({ childPid: child.pid, port, paths, timeoutMs, logOffset });
  // The spawned child and the daemon that answered must be the same process.
  // Anything else means a second runtime won the port race mid-startup: never
  // report success for a daemon we did not spawn, and never leave ours behind.
  if (runtime.pid && runtime.pid !== child.pid) {
    try { child.kill('SIGTERM'); } catch { /* may already be gone */ }
    process.stdout.write(`Sparkiee is already running at ${runtime.dashboardUrl} (pid ${runtime.pid}).\n${describeHost(runtime.petHost)}\n`);
    return;
  }
  process.stdout.write(`Sparkiee started successfully.\nDashboard: ${runtime.dashboardUrl}\nPID: ${runtime.pid}\n${describeHost(runtime.petHost)}\n`);
}

async function status(env) {
  const port = resolvePort(env);
  const paths = resolveRuntimePaths(env);
  const runtime = await getRuntime(port);
  if (!runtime) {
    // Honest diagnosis, not a bare "not running": a daemon can be alive but
    // wedged (big event-loop stall) — its pid file and the port tell the truth.
    const hungPid = Number((await readFile(paths.pidFile, 'utf8').catch(() => '0')).trim());
    if (Number.isInteger(hungPid) && isPidAlive(hungPid)) {
      process.stdout.write(
        `A Sparkiee daemon (pid ${hungPid}) is running but not answering on port ${port}.\n` +
        `Run "sparkiee stop" to shut it down, or check ${paths.logFile}.\n`,
      );
    } else {
      process.stdout.write(`Sparkiee is not running at http://${DEFAULT_HOST}:${port}.\n`);
    }
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
    await removeStalePidFile(paths);
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
      await removeStalePidFile(paths);
      process.stdout.write('Sparkiee stopped.\n');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Shutdown was requested but the runtime is still responding. Inspect ${paths.logFile}.`);
}

/** Remove the pid file only when its owner is verifiably gone. */
async function removeStalePidFile(paths) {
  try {
    const pid = Number((await readFile(paths.pidFile, 'utf8')).trim());
    if (Number.isInteger(pid) && pid > 0 && !isPidAlive(pid)) await unlink(paths.pidFile);
  } catch {
    // unreadable or missing: nothing to clean
  }
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

// ---------------------------------------------------------------------------
// Push-to-talk commands.
//
// `sparkiee ptt toggle` is the exact command the GNOME media-keys fallback
// binding runs (Stage 2): it must be short, token-authed (loopback only, key
// never leaves the state dir), and must never print secrets.
// ---------------------------------------------------------------------------

async function pttToggle(env) {
  const port = resolvePort(env);
  const paths = resolveRuntimePaths(env);
  const runtime = await getRuntime(port);
  if (!runtime) throw new Error('Sparkiee is not running. Start it with "sparkiee start".');
  const token = await readAuthToken(paths);
  const { response, payload } = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/assistant/ptt/toggle`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
    // A 'start' action speaks the summon greeting before opening the mic, so
    // this one call legitimately waits several seconds.
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(payload?.error ?? `PTT toggle failed with HTTP ${response.status}.`);
  // Silent success unless an action needs attention: keybindings run with no
  // visible terminal, and stdout noise would be pointless.
  const action = payload?.action ?? 'unknown';
  if (action === 'busy' || action === 'unknown') {
    process.stderr.write(`Sparky is ${action === 'busy' ? 'still finishing the last request' : 'unsure what to do'}.\n`);
  }
}

/** The fully qualified command line the OS keybinding should run. */
function resolvePttCommand(env) {
  if (env.SPARKIEE_PTT_COMMAND) return env.SPARKIEE_PTT_COMMAND;
  // Absolute: keybindings do not inherit shells. commands.mjs lives at
  // packages/cli/src; the repo bin is two levels up.
  const bin = fileURLToPath(new URL('../../../bin/sparkiee.mjs', import.meta.url));
  return `${process.execPath} ${bin} ptt toggle`;
}

async function assistantHotkey(env, subcommand, args) {
  const installer = await createGnomeHotkeyInstaller({ env });
  switch (subcommand) {
    case 'install': {
      let accelerator = 'Control+Alt+Space';
      const index = args.indexOf('--accelerator');
      if (index === -1) {
        if (args.length > 0) throw new Error('Unknown arguments. Usage: sparkiee assistant hotkey install [--accelerator Control+Alt+Space].');
      } else {
        accelerator = args[index + 1];
        if (!accelerator) throw new Error('--accelerator requires a value.');
      }
      const command = resolvePttCommand(env);
      const result = await installer.install({ binding: accelerator, command });
      process.stdout.write(
        `GNOME keybinding installed.\nBinding: ${result.binding}\nRuns: ${result.command}\n` +
        `This binding fires system-wide, including while Wayland-native apps hold focus.\n` +
        `Remove it with "sparkiee assistant hotkey remove".\n`,
      );
      return;
    }
    case 'remove': {
      const result = await installer.remove();
      process.stdout.write(`GNOME keybinding removed (list now holds ${result.paths.length} custom binding${result.paths.length === 1 ? '' : 's'}).\n`);
      return;
    }
    case 'status': {
      const status = await installer.status();
      if (!status.installed) {
        process.stdout.write(
          `GNOME keybinding fallback: not installed.\n` +
          `Install it to make the shortcut reliable while Wayland-native apps hold focus:\n` +
          `  sparkiee assistant hotkey install\n`,
        );
        return;
      }
      process.stdout.write(`GNOME keybinding fallback: installed.\nBinding: ${status.binding}\nRuns: ${status.command}\n`);
      return;
    }
    default:
      throw new Error(`Unknown assistant hotkey command. Try: assistant hotkey install | status | remove.`);
  }
}

async function runAssistantCommand(subcommand, args, env) {
  switch (subcommand) {
    case 'setup':
      await assistantSetup(env, args);
      return;
    case 'stt-setup':
      await assistantSttSetup(env, args);
      return;
    case 'status':
      await assistantStatus(env);
      return;
    case 'reset':
      await assistantReset(env);
      return;
    case 'hotkey':
      await assistantHotkey(env, args[0] ?? 'status', args.slice(1));
      return;
    default:
      throw new Error('Unknown assistant command. Try: assistant setup | assistant status | assistant reset | assistant stt-setup | assistant hotkey status.');
  }
}

/**
 * One-time local speech-recognition setup (explicit, idempotent, honest):
 * venv + faster-whisper + tiny.en model. Long-running by nature; every
 * progress step is echoed. Secrets are never involved — this step talks
 * to PyPI and the Hugging Face model repository only.
 */
async function assistantSttSetup(env, args) {
  let timeoutMs = 20 * 60 * 1000;
  let model = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--timeout-ms') {
      const raw = args[i + 1];
      if (!raw) throw new Error('--timeout-ms requires a value.');
      timeoutMs = Number(raw);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > MAX_SETUP_TIMEOUT_MS) {
        throw new Error(`Invalid --timeout-ms "${raw}". Expected an integer from 5000 to ${MAX_SETUP_TIMEOUT_MS}.`);
      }
      i += 1;
    } else if (arg === '--model') {
      const raw = args[i + 1];
      if (!raw) throw new Error('--model requires a value (see sparkiee assistant stt-setup --model-list).');
      model = raw;
      i += 1;
    } else {
      throw new Error('Unknown arguments. Usage: sparkiee assistant stt-setup [--model <name>] [--timeout-ms <ms>].');
    }
  }
  if (model) {
    const { STT_MODEL_CATALOG, RECOMMENDED_STT_MODEL } = await import('../../core/src/stt-service.mjs');
    const meta = STT_MODEL_CATALOG[model];
    if (!meta) {
      const known = Object.entries(STT_MODEL_CATALOG)
        .map(([name, entry]) => `${name} (~${Math.round(entry.sizeBytes / 1_048_576)} MB)`).join(', ');
      throw new Error(`Unknown STT model "${model}". Options: ${known}.`);
    }
    process.stdout.write(`Choosing STT model: ${model}\n  Origin: ${meta.repo} · ${meta.licence}\n  Download size: ~${Math.round(meta.sizeBytes / 1_048_576)} MB, stored under the Sparkiee data dir (0700).\n  Nothing downloads unless you run this setup command.\n`);
  }
  const result = await setupSttEnvironment({ env, onLine: (line) => process.stdout.write(`${line}\n`), timeoutMs, model });
  if (!result.ok) {
    throw new Error(`Speech recognition setup did not finish: ${result.detail}`);
  }
  process.stdout.write(`Try it: focus any app, press Ctrl+Alt+Space, and say "Play Madira".\n`);
}

// ---------------------------------------------------------------------------
// Conversational assistant setup (NVIDIA). The key is read hidden, verified
// against the live model list, and stored 0600 under the per-user config
// directory. It is never printed, never written to a tracked file, and never
// sent anywhere except NVIDIA's own API when Sparky is asked to chat.
// ---------------------------------------------------------------------------

/** Keep candidate chat models, dropping embedding/vision/audio-only entries. */
const NON_CHAT_MODEL = /(embed|rerank|bge|clip|whisper|parakeet|asr|tts|deplot|segformer|grounding|retriever|reward)/i;
export function rankChatModels(models) {
  return models.filter((id) => !NON_CHAT_MODEL.test(id));
}

function parseAssistantSetupArgs(args) {
  const options = { remove: false, verify: true, keyFile: null, model: null, localOnly: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--remove') options.remove = true;
    else if (arg === '--no-verify') options.verify = false;
    else if (arg === '--local-only') options.localOnly = true;
    else if (arg === '--allow-remote') options.localOnly = false;
    else if (arg === '--key-file') {
      options.keyFile = args[index + 1];
      index += 1;
      if (!options.keyFile) throw new Error('--key-file requires a path.');
    } else if (arg === '--model') {
      options.model = args[index + 1];
      index += 1;
      if (!options.model) throw new Error('--model requires a model id.');
    } else if (arg === '--stt') {
      options.stt = true;
    } else {
      throw new Error(`Unknown option "${arg}". Usage: sparkiee assistant setup [--key-file <path>] [--model <id>] [--no-verify] [--local-only] [--remove]`);
    }
  }
  return options;
}

async function readSecretInput(keyFile) {
  if (keyFile) return (await readFile(path.resolve(keyFile), 'utf8')).trim();
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return promptHidden('NVIDIA API key (input hidden, never logged): ');
}

/** Choose a model the live API actually offers — never a hardcoded guess. */
async function chooseNvidiaModel(client, models, requested) {
  const candidates = rankChatModels(models);
  if (requested) {
    if (!models.includes(requested)) {
      throw new Error(`The API does not list the model "${requested}". Run "sparkiee assistant setup" without --model to pick from the live list.`);
    }
    return requested;
  }
  if (candidates.length === 0) {
    throw new Error('The NVIDIA account lists no chat models. Pass --model <id> to choose one explicitly.');
  }
  if (!process.stdin.isTTY) {
    throw new Error(`Pick a model with --model <id>. Available (first 10): ${candidates.slice(0, 10).join(', ')}`);
  }
  const shown = candidates.slice(0, 25);
  process.stdout.write('Available chat models:\n');
  shown.forEach((id, index) => process.stdout.write(`  ${String(index + 1).padStart(2)}. ${id}\n`));
  const suggestedIndex = Math.max(0, shown.findIndex((id) => /instruct/i.test(id)));
  const answer = await promptVisible(`Model [${suggestedIndex + 1}] "${shown[suggestedIndex]}": `);
  if (answer.length === 0) return shown[suggestedIndex];
  const asNumber = Number(answer);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= shown.length) return shown[asNumber - 1];
  if (shown.includes(answer)) return answer;
  throw new Error(`"${answer}" is not one of the listed models. Nothing was saved.`);
}

/** Visible (echoing) prompt for non-secret choices. */
function promptVisible(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function assistantSetup(env, args) {
  const options = parseAssistantSetupArgs(args);
  if (options.stt) {
    await assistantSttSetup(env, args.filter((arg) => arg !== '--stt'));
    return;
  }

  if (options.remove) {
    await writeNvidiaConfig({ env, patch: { apiKey: null, model: null } });
    process.stdout.write(
      'NVIDIA key removed. Sparky will say it is not set up instead of guessing an answer.\n' +
      `Config file: ${resolveNvidiaConfigPath(env)} (unrelated settings preserved).\n`,
    );
    await nudgeDaemon(env);
    return;
  }

  const key = await readSecretInput(options.keyFile);
  if (!isValidNvidiaApiKey(key)) {
    throw new Error('That does not look like an NVIDIA API key (expected "nvapi-…" or a 40+ character token). Nothing was saved.');
  }

  const baseUrl = DEFAULT_NVIDIA_BASE_URL;
  let model = options.model;
  if (options.verify) {
    process.stdout.write('Verifying the key against NVIDIA and reading the live model list…\n');
    const probe = createNvidiaChatClient({ config: { apiKey: key, model: null, baseUrl, localOnly: false } });
    const listed = await probe.listModels();
    if (!listed.ok) {
      if (listed.error.code === 'auth') {
        throw new Error('NVIDIA rejected that key. Double-check it and run "sparkiee assistant setup" again. Nothing was saved.');
      }
      process.stdout.write(`Warning: could not list models right now (${listed.error.message}).\n`);
      if (!model) {
        throw new Error('A model id is required and the live list was unavailable. Re-run with --model <id>. Nothing was saved.');
      }
    } else {
      process.stdout.write(`NVIDIA accepted the key (${listed.models.length} models available).\n`);
      model = await chooseNvidiaModel(probe, listed.models, options.model);
    }
  }
  if (!model) {
    throw new Error('No model selected. Re-run with --model <id>, or allow verification to list the live models.');
  }

  const file = await writeNvidiaConfig({
    env,
    patch: { apiKey: key, model, baseUrl, localOnly: options.localOnly ? true : null },
  });
  process.stdout.write(
    `Key saved (${key.length} characters, never logged) to ${file} with 0600 permissions.\n` +
    `Model: ${model}\n` +
    `Local-only mode: ${options.localOnly ? 'on — nothing is sent to NVIDIA until you turn it off' : 'off — chat requests go to NVIDIA'}\n` +
    'Try it: press Ctrl+Alt+Space and ask a question, or type one in the dashboard.\n',
  );
  await nudgeDaemon(env);
}

/**
 * The daemon caches config for a few seconds; a status probe makes the fresh
 * setup visible immediately without a restart. Best-effort by design.
 */
async function nudgeDaemon(env) {
  const port = resolvePort(env);
  if (!(await getRuntime(port))) return;
  await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/assistant/status`).catch(() => {});
}

async function assistantStatus(env) {
  const loaded = await loadNvidiaConfig({ env });
  const described = describeNvidiaConfig(loaded);
  const port = resolvePort(env);
  const runtime = await getRuntime(port);

  let conversation = null;
  let stt = null;
  let wake = null;
  let mic = null;
  let voice = null;
  let assistantState = null;
  if (runtime) {
    const { response, payload } = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/assistant/status`).catch(() => ({ response: { ok: false } }));
    if (response.ok) {
      conversation = payload.assistant?.conversation ?? null;
      stt = payload.assistant?.stt ?? null;
      wake = payload.assistant?.wake ?? null;
      mic = payload.assistant?.mic ?? null;
      assistantState = payload.assistant?.state ?? null;
    }
    const vs = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/voice/status`).catch(() => ({ response: { ok: false } }));
    if (vs.response.ok) voice = vs.payload.voice ?? null;
  }

  process.stdout.write(
    'Sparkiee assistant readiness\n' +
    `  Assistant state  : ${assistantState ?? (runtime ? 'unknown' : 'runtime not running')}\n` +
    `  Microphone input : ${mic ? (mic.devices?.length ? `${mic.devices.length} device(s) available` : 'no input device found') : (runtime ? 'unknown' : 'runtime not running')}\n` +
    `  Local STT        : ${stt ? stt.status : (runtime ? 'unknown' : 'runtime not running')}${stt?.model ? ` (${stt.model})` : ''}\n` +
    `  NVIDIA chat      : ${conversation ? (conversation.configured ? `ready (${conversation.model})` : 'not set up') : (described.configured ? 'configured (daemon not refreshed yet)' : 'not set up')}\n` +
    `  Local-only mode  : ${(conversation?.localOnly ?? described.localOnly) ? 'on (no transcript leaves this machine)' : 'off'}\n` +
    `  ElevenLabs TTS   : ${voice ? (voice.configured ? 'ready' : 'no cloud key') : (runtime ? 'unknown' : 'runtime not running')}\n` +
    `  Local TTS fallback: ${voice?.localFallback ? (voice.localFallback.available ? `ready (${voice.localFallback.binary ?? 'espeak-ng'})` : 'unavailable') : (runtime ? 'unknown' : 'runtime not running')}\n` +
    `  Wake word        : ${wake ? wake.status : (runtime ? 'unknown' : 'runtime not running')}\n` +
    `  NVIDIA key file  : ${resolveNvidiaConfigPath(env)}\n`,
  );
  for (const warning of described.warnings) process.stdout.write(`  Warning: ${warning}\n`);
  if (conversation?.lastError) process.stdout.write(`  Last chat error: ${conversation.lastError}\n`);
  if (!runtime) process.stdout.write('Start it with "sparkiee start" for live readiness.\n');
}

async function assistantReset(env) {
  const { port, token } = await requireDaemon(env);
  const { response, payload } = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/assistant/conversation/reset`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(payload?.error ?? `Reset failed with HTTP ${response.status}.`);
  process.stdout.write(`Conversation reset — ${payload.cleared ?? 0} stored message(s) forgotten.\n`);
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
  if (command === 'assistant') {
    await runAssistantCommand(argv[1] ?? 'status', argv.slice(2), env);
    return;
  }
  if (command === 'ptt' && argv[1] === 'toggle') {
    await pttToggle(env);
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
