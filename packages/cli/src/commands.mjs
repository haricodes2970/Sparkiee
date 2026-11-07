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
  VOICE_CATALOG,
  describeVoiceConfig,
  loadVoiceConfig,
  resolveTtsDataDir,
  resolveVoiceConfigPath,
} from '../../core/src/voice-config.mjs';
import { createPiperTts } from '../../core/src/piper-tts.mjs';
import { formatTaskDuration } from '../../core/src/pet-state.mjs';
import { createProjectRegistry } from '../../core/src/project-registry.mjs';
import { setupPiperEnvironment, DEFAULT_VOICE_SETUP_TIMEOUT_MS } from '../../core/src/tts-setup.mjs';
import {
  CHAT_PROVIDERS,
  CHAT_PROVIDER_INFO,
  DEFAULT_CHAT_PROVIDER,
  describeChatConfig,
  isValidChatApiKey,
  isValidChatModel,
  loadChatConfig,
  resolveChatConfigPath,
  writeChatConfig,
} from '../../core/src/chat-config.mjs';
import { createChatClient } from '../../core/src/chat-client.mjs';
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
  assistant setup [--provider groq|google]
               Connect the chat assistant: store a Groq or Google AI Studio API
               key (never echoed), verify it, and pick a model from the live list
  assistant setup --remove
               Forget the active provider's key (the other provider is kept)
  assistant status
               Show honest, separate readiness for mic, STT, chat, TTS
  assistant reset
               Forget the in-memory conversation history
  assistant stt-setup  One-time local speech-recognition setup (venv + model;
                       use --model large-v3-turbo for higher accuracy)
  assistant hotkey install|status|remove
               Manage the GNOME media-keys fallback binding for the mic shortcut
  pet dock     Pin Sparky on the OpenCode chatbox and nap until a task starts
  pet undock   Return Sparky to the desktop
  pet sleep    Put Sparky to sleep where she is
  pet wake     Wake Sparky without moving her
  pet status   Show dock posture and the tracked task timer
  project list Show locally mapped project folders
  project add <name> [path]
               Map a project name to a folder (defaults to the current dir)
  project remove <name>
               Forget a mapped project
  project open <name> [--run <command>]
               Open the project in a terminal and optionally run a dev command
  project run <name> <command...>
               Open the project and run a local developer command
  voice status Show whether Sparky's spoken voice is configured
  voice setup  Install the free local voice (Piper) and download voice models
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
  SPARKIEE_TTS_SPEED  Speaking speed for the local voice (0.5-2.0, default 1.0)
  GROQ_API_KEY        Optional Groq chat key (overrides assistant setup)
  GOOGLE_AI_API_KEY   Optional Google AI Studio chat key (alias: GEMINI_API_KEY)
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
    const { response, payload } = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/runtime`, {
      // A cold daemon that is still walking the music library can briefly
      // miss a sub-second probe. Two seconds stays honest without leaking.
      signal: AbortSignal.timeout(2_000),
    });
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
  const pid = Number((await readFile(paths.pidFile, 'utf8').catch(() => '0')).trim());
  let token = null;
  if (!runtime) {
    // A busy daemon (initial music scan can starve the event loop) may miss
    // the short status probe while still being alive. With a valid runtime
    // token and a live pid, attempt the real shutdown anyway instead of
    // pretending it is not running and leaking the process.
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
      try {
        token = await readAuthToken(paths);
      } catch {
        token = null;
      }
    }
    if (!token) {
      await removeStalePidFile(paths);
      process.stdout.write(`Sparkiee is not running at http://${DEFAULT_HOST}:${port}.\n`);
      return;
    }
  } else {
    token = await readAuthToken(paths);
  }

  const { response, payload } = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/shutdown`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(payload?.error ?? `Runtime shutdown failed with HTTP ${response.status}.`);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const gone = Number.isInteger(pid) && pid > 0
      ? !isPidAlive(pid)
      : !(await getRuntime(port));
    if (gone) {
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
// Voice commands: install and control Sparky's local, free voice.
// ---------------------------------------------------------------------------

/** Read a secret from the terminal without echoing it (chat keys only). */
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

async function probeVoiceEngine(env, described) {
  const engine = createPiperTts({ env, getConfig: () => described });
  try {
    return await engine.probe();
  } finally {
    await engine.close().catch(() => {});
  }
}

function voiceRow(language, voiceId) {
  const meta = VOICE_CATALOG[voiceId];
  return `${language === 'hi' ? 'Hindi' : 'English'} voice  : ${meta?.label ?? voiceId}${meta ? ` [${meta.license}]` : ''}\n`;
}

async function voiceStatus(env) {
  const loaded = await loadVoiceConfig({ env });
  const described = describeVoiceConfig(loaded);
  const engine = await probeVoiceEngine(env, described);
  process.stdout.write(
    `Voice engine     : piper (local, free, no account)\n` +
    `Runtime          : ${engine?.status ?? 'unknown'}${engine?.installed === false ? ' — run "sparkiee voice setup"' : ''}\n` +
    voiceRow('hi', described.voices.hi) +
    voiceRow('en', described.voices.en) +
    `Speed            : ${described.speed.toFixed(2)}x\n` +
    `Data directory   : ${resolveTtsDataDir(env)}\n` +
    `Config file      : ${resolveVoiceConfigPath(env)}\n` +
    `Detail           : ${engine?.detail ?? 'engine status unavailable'}\n`,
  );
  for (const warning of described.warnings) process.stdout.write(`Warning: ${warning}\n`);
  if (engine?.status !== 'ready') {
    process.stdout.write(`Install it with "sparkiee voice setup".\n`);
  }

  // Daemon-side view when the runtime is up.
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
      `Runtime voice    : ${voice.configured ? `ready (${voice.provider})` : 'not ready'}\n` +
      `Spoken reactions : ${speech.enabled === false ? 'disabled' : `enabled (${speech.style ?? 'speech'} style)`}\n` +
      `Sound            : ${state.payload?.settings?.audio?.enabled === false ? 'muted (captions keep working)' : 'on'}\n` +
      `Speech cache     : ${voice.cacheFiles ?? 0} clips (${Math.round((voice.cacheBytes ?? 0) / 1024)} KB)\n` +
      (voice.lastError ? `Last speech error: ${describeSpeechError(voice.lastError)}\n` : ''),
    );
    for (const warning of payload.warnings ?? []) process.stdout.write(`Runtime warning: ${warning}\n`);
  } catch {
    process.stdout.write(`Runtime: running but voice status unavailable.\n`);
  }
}

async function voiceSetup(env, args) {
  let timeoutMs = DEFAULT_VOICE_SETUP_TIMEOUT_MS;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--timeout-ms') {
      const raw = args[index + 1];
      if (!raw) throw new Error('--timeout-ms requires a value.');
      timeoutMs = Number(raw);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 60 * 60 * 1000) {
        throw new Error(`Invalid --timeout-ms "${raw}". Expected an integer from 5000 to 3600000.`);
      }
      index += 1;
    } else {
      throw new Error(`Unknown option "${arg}". Usage: sparkiee voice setup [--timeout-ms <ms>]`);
    }
  }

  process.stdout.write(
    `Installing the local Piper voice (no account, no key).\n` +
    `Downloads: piper-tts from PyPI, then two voices (~60 MB each) from ${'rhasspy/piper-voices'}.\n\n`,
  );
  const result = await setupPiperEnvironment({
    env,
    timeoutMs,
    onLine: (line) => process.stdout.write(`${line}\n`),
  });
  if (!result.ok) {
    throw new Error(`Voice setup did not finish: ${result.detail}`);
  }
  process.stdout.write(
    `\n${result.detail}\n` +
    `Try it: "sparkiee voice test" or press Test spoken voice in the dashboard.\n`,
  );
  await nudgeDaemon(env);
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
    // Cold start loads the Piper model (often 1-3 s on a busy CPU), and a
    // generated test is worth waiting for instead of a misleading abort.
    signal: AbortSignal.timeout(20_000),
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

async function petCommand(subcommand, env) {
  const { port, token } = await requireDaemon(env);
  const base = `http://${DEFAULT_HOST}:${port}`;
  const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (subcommand === 'status') {
    const { payload } = await fetchJson(`${base}/api/v1/pet/state`);
    const task = payload?.task;
    let taskText = 'no task tracked';
    if (task?.active === true) taskText = `working (${formatTaskDuration(Date.now() - Date.parse(task.startedAt))})`;
    else if (task?.outcome === 'success') taskText = `last task completed in ${formatTaskDuration(task.durationMs)}`;
    else if (task?.outcome === 'error') taskText = 'last task failed';
    process.stdout.write(
      `Sparky is ${payload?.docked === true ? 'docked on the OpenCode chatbox' : 'on the desktop'}.\n` +
      `Task: ${taskText}\n`,
    );
    return;
  }
  if (subcommand === 'dock' || subcommand === 'undock') {
    const docked = subcommand === 'dock';
    const { response, payload } = await fetchJson(`${base}/api/v1/pet/dock`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ docked }),
    });
    if (!response.ok) throw new Error(payload?.error ?? `Runtime returned HTTP ${response.status}`);
    process.stdout.write(docked
      ? 'Sparky is docked on the OpenCode chatbox and will nap until a task starts.\nDrag the sleeping pet to fine-tune the spot; it is remembered per display.\n'
      : 'Sparky is back on the desktop.\n');
    return;
  }
  if (subcommand === 'sleep' || subcommand === 'wake') {
    const { response, payload } = await fetchJson(`${base}/api/v1/pet/command`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ command: subcommand }),
    });
    if (!response.ok) throw new Error(payload?.error ?? `Runtime returned HTTP ${response.status}`);
    process.stdout.write(`Sparky: ${payload.pet.message}\n`);
    return;
  }
  throw new Error(`Unknown pet command "${subcommand}". Try: pet dock, pet undock, pet sleep, pet wake, pet status.`);
}

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
      if (!raw) throw new Error('--model requires a value: tiny.en | large-v3-turbo.');
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
// Conversational assistant setup (Groq / Google AI Studio). The key is read
// hidden, verified against the live model list, and stored 0600 under the
// per-user config directory. It is never printed, never written to a tracked
// file, and only ever sent to the provider the user picked.
// ---------------------------------------------------------------------------

/** Keep candidate chat models, dropping embedding/vision/audio-only entries. */
const NON_CHAT_MODEL = /(embed|rerank|bge|clip|whisper|parakeet|asr|tts|deplot|segformer|grounding|retriever|reward)/i;
export function rankChatModels(models) {
  return models.filter((id) => !NON_CHAT_MODEL.test(id));
}

function parseAssistantSetupArgs(args) {
  const options = {
    remove: false,
    verify: true,
    keyFile: null,
    model: null,
    localOnly: false,
    allowRemote: false,
    provider: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--remove') options.remove = true;
    else if (arg === '--no-verify') options.verify = false;
    else if (arg === '--local-only') options.localOnly = true;
    else if (arg === '--allow-remote') options.allowRemote = true;
    else if (arg === '--provider') {
      const raw = args[index + 1];
      if (!raw) throw new Error(`--provider requires a value: ${CHAT_PROVIDERS.join(' | ')}.`);
      if (!CHAT_PROVIDERS.includes(raw)) {
        throw new Error(`Unknown provider "${raw}". Choose one of: ${CHAT_PROVIDERS.join(', ')}.`);
      }
      options.provider = raw;
      index += 1;
    } else if (arg === '--key-file') {
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
      throw new Error(`Unknown option "${arg}". Usage: sparkiee assistant setup [--provider groq|google] [--key-file <path>] [--model <id>] [--no-verify] [--local-only] [--allow-remote] [--remove]`);
    }
  }
  if (options.localOnly && options.allowRemote) {
    throw new Error('--local-only and --allow-remote contradict each other.');
  }
  return options;
}

async function readSecretInput(keyFile, label = 'Chat provider') {
  if (keyFile) return (await readFile(path.resolve(keyFile), 'utf8')).trim();
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return promptHidden(`${label} API key (input hidden, never logged): `);
}

/** Ask which provider to configure; non-interactive runs default to Groq. */
async function chooseChatProvider(requested) {
  if (requested) return requested;
  if (!process.stdin.isTTY) return DEFAULT_CHAT_PROVIDER;
  const answer = await promptVisible(
    `Chat provider — 1) Groq (${CHAT_PROVIDER_INFO.groq.modelHint})  2) Google AI Studio (${CHAT_PROVIDER_INFO.google.modelHint}) [1]: `,
  );
  if (answer.length === 0 || answer === '1' || answer.toLowerCase() === 'groq') return 'groq';
  if (answer === '2' || answer.toLowerCase() === 'google') return 'google';
  throw new Error(`"${answer}" is not a provider. Choose 1 (Groq) or 2 (Google AI Studio).`);
}

/** Choose a model the live API actually offers — never a hardcoded guess. */
async function chooseChatModel(provider, client, models, requested) {
  const candidates = rankChatModels(models);
  if (requested) {
    if (!models.includes(requested)) {
      throw new Error(`The API does not list the model "${requested}". Run "sparkiee assistant setup --provider ${provider}" without --model to pick from the live list.`);
    }
    return requested;
  }
  if (candidates.length === 0) {
    throw new Error(`${CHAT_PROVIDER_INFO[provider].label} lists no chat models. Pass --model <id> to choose one explicitly.`);
  }
  const hint = CHAT_PROVIDER_INFO[provider].modelHint;
  if (candidates.includes(hint)) return hint;
  if (!process.stdin.isTTY) {
    throw new Error(`Pick a model with --model <id>. Available (first 10): ${candidates.slice(0, 10).join(', ')}`);
  }
  const shown = candidates.slice(0, 25);
  process.stdout.write('Available chat models:\n');
  shown.forEach((id, index) => process.stdout.write(`  ${String(index + 1).padStart(2)}. ${id}\n`));
  const suggestedIndex = Math.max(0, shown.findIndex((id) => /instruct|flash/i.test(id)));
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
    const loaded = await loadChatConfig({ env });
    const provider = options.provider ?? loaded.provider;
    await writeChatConfig({ env, patch: { provider, clearProvider: true } });
    process.stdout.write(
      `${CHAT_PROVIDER_INFO[provider].label} key removed. Sparky will say it is not set up instead of guessing an answer.\n` +
      `Config file: ${resolveChatConfigPath(env)} (the other provider's key is preserved).\n`,
    );
    await nudgeDaemon(env);
    return;
  }

  const provider = await chooseChatProvider(options.provider);
  const info = CHAT_PROVIDER_INFO[provider];
  const key = await readSecretInput(options.keyFile, info.label);
  if (!isValidChatApiKey(provider, key)) {
    throw new Error(`That does not look like a ${info.label} API key. Nothing was saved.`);
  }

  let model = options.model;
  if (model && !isValidChatModel(model)) {
    throw new Error(`"${model}" is not a plausible model id. Nothing was saved.`);
  }
  if (options.verify) {
    process.stdout.write(`Verifying the key against ${info.label} and reading the live model list…\n`);
    const probe = createChatClient({ provider, config: { apiKey: key, model: null, baseUrl: info.baseUrl, localOnly: false } });
    const listed = await probe.listModels();
    if (!listed.ok) {
      if (listed.error.code === 'auth') {
        throw new Error(`${info.label} rejected that key. Double-check it and run "sparkiee assistant setup" again. Nothing was saved.`);
      }
      process.stdout.write(`Warning: could not list models right now (${listed.error.message}).\n`);
      if (!model) {
        throw new Error('A model id is required and the live list was unavailable. Re-run with --model <id>. Nothing was saved.');
      }
    } else {
      process.stdout.write(`${info.label} accepted the key (${listed.models.length} models available).\n`);
      model = await chooseChatModel(provider, probe, listed.models, model);
    }
  }
  if (!model) {
    throw new Error('No model selected. Re-run with --model <id>, or allow verification to list the live models.');
  }

  const patch = { provider, apiKey: key, model };
  if (options.localOnly) patch.localOnly = true;
  else if (options.allowRemote) patch.localOnly = false;
  const file = await writeChatConfig({ env, patch });
  const localOnly = options.localOnly ? true : (options.allowRemote ? false : null);
  process.stdout.write(
    `Key saved (${key.length} characters, never logged) to ${file} with 0600 permissions.\n` +
    `Provider: ${info.label}\n` +
    `Model: ${model}\n` +
    (localOnly === null
      ? 'Local-only mode: unchanged.\n'
      : `Local-only mode: ${localOnly ? 'on — nothing is sent to any provider until you turn it off' : 'off — chat requests go to the provider'}\n`) +
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
  const loaded = await loadChatConfig({ env });
  const described = describeChatConfig(loaded);
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

  const active = conversation ?? described;
  const providerRow = (id) => {
    const entry = described.providers?.[id] ?? { configured: false, model: null };
    const marker = (active.provider ?? described.provider) === id ? '*' : ' ';
    const state = entry.configured ? `ready (${entry.model})` : 'not set up';
    return `  ${marker} ${CHAT_PROVIDER_INFO[id].label.padEnd(17)}: ${state}\n`;
  };

  process.stdout.write(
    'Sparkiee assistant readiness\n' +
    `  Assistant state  : ${assistantState ?? (runtime ? 'unknown' : 'runtime not running')}\n` +
    `  Microphone input : ${mic ? (mic.devices?.length ? `${mic.devices.length} device(s) available` : 'no input device found') : (runtime ? 'unknown' : 'runtime not running')}\n` +
    `  Local STT        : ${stt ? stt.status : (runtime ? 'unknown' : 'runtime not running')}${stt?.model ? ` (${stt.model})` : ''}\n` +
    `  Chat providers   : (* = active)\n` +
    providerRow('groq') +
    providerRow('google') +
    `  Local-only mode  : ${(conversation?.localOnly ?? described.localOnly) ? 'on (no transcript leaves this machine)' : 'off'}\n` +
    `  Local voice      : ${voice ? (voice.configured ? `ready (${voice.provider ?? 'piper'})` : 'not set up') : (runtime ? 'unknown' : 'runtime not running')}\n` +
    `  Voice fallback   : ${voice?.localFallback ? (voice.localFallback.available ? `ready (${voice.localFallback.binary ?? 'espeak-ng'})` : 'unavailable') : (runtime ? 'unknown' : 'runtime not running')}\n` +
    `  Wake word        : ${wake ? wake.status : (runtime ? 'unknown' : 'runtime not running')}\n` +
    `  Chat config file : ${resolveChatConfigPath(env)}\n`,
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

async function projectOpen(env, name, command) {
  if (!name) throw new Error('Usage: sparkiee project open <name> [--run <command>]');
  const { port, token } = await requireDaemon(env);
  const text = command ? `open project ${name} and run ${command}` : `open project ${name}`;
  const { response, payload } = await fetchJson(`http://${DEFAULT_HOST}:${port}/api/v1/assistant/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(payload?.error ?? `Project command failed with HTTP ${response.status}.`);
  if (payload?.reply) process.stdout.write(`${payload.reply}\n`);
  if (payload?.executed !== true) process.exitCode = 1;
}

async function runProjectCommand(subcommand, args, env) {
  const registry = createProjectRegistry({ env });
  switch (subcommand) {
    case 'list':
    case 'status': {
      const projects = await registry.list();
      if (projects.length === 0) {
        process.stdout.write('No projects mapped yet. Add one with "sparkiee project add <name> <path>".\n');
        return;
      }
      for (const project of projects) process.stdout.write(`${project.name.padEnd(20)} ${project.path}\n`);
      return;
    }
    case 'add': {
      const name = args[0];
      if (!name) throw new Error('Usage: sparkiee project add <name> [path]');
      const target = path.resolve(args[1] ?? process.cwd());
      const saved = await registry.add({ name, path: target });
      process.stdout.write(`Mapped project "${saved.name}" -> ${saved.path}\n`);
      return;
    }
    case 'remove':
    case 'rm': {
      const name = args[0];
      if (!name) throw new Error('Usage: sparkiee project remove <name>');
      const removed = await registry.remove(name);
      if (!removed) throw new Error(`Project "${name}" is not mapped.`);
      process.stdout.write(`Removed project "${name}".\n`);
      return;
    }
    case 'open': {
      const name = args[0];
      let command = null;
      const runAt = args.indexOf('--run');
      if (runAt >= 0) command = args.slice(runAt + 1).join(' ') || null;
      await projectOpen(env, name, command);
      return;
    }
    case 'run': {
      const name = args[0];
      const command = args.slice(1).join(' ');
      if (!name || !command) throw new Error('Usage: sparkiee project run <name> <command...>');
      await projectOpen(env, name, command);
      return;
    }
    case 'file':
      process.stdout.write(`${registry.file}\n`);
      return;
    default:
      throw new Error(`Unknown project command "${subcommand}". Try: project list | add | remove | open | run | file.`);
  }
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
  if (command === 'pet') {
    await petCommand(argv[1] ?? 'status', env);
    return;
  }
  if (command === 'project') {
    await runProjectCommand(argv[1] ?? 'list', argv.slice(2), env);
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
