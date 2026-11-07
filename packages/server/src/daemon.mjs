import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRuntimeHome, readAuthToken, resolvePort, resolveRuntimePaths } from '../../core/src/index.mjs';
import { resolveElectronBinary } from '../../core/src/electron-resolver.mjs';
import { createHostTracker } from '../../core/src/host-tracker.mjs';
import { listCharacterPacks } from '../../core/src/character-pack.mjs';
import { createPetController } from '../../core/src/pet-state.mjs';
import { loadVoiceConfig, resolveVoiceCacheDir, DEFAULT_VOICES, DEFAULT_SPEED } from '../../core/src/voice-config.mjs';
import { createAudioCache } from '../../core/src/audio-cache.mjs';
import { createLocalTts, probeLocalTts } from '../../core/src/local-tts.mjs';
import { createPiperTts } from '../../core/src/piper-tts.mjs';
import { loadChatConfig, describeChatConfig, CHAT_PROVIDER_INFO } from '../../core/src/chat-config.mjs';
import { createChatClient } from '../../core/src/chat-client.mjs';
import { withoutSecrets } from '../../core/src/env-safety.mjs';
import { createProjectRegistry } from '../../core/src/project-registry.mjs';
import { createSystemLauncher } from '../../core/src/system-launcher.mjs';
import { createVoiceService } from './voice-service.mjs';
import { createAssistantService } from './assistant-service.mjs';
import { createHotkeyState } from '../../core/src/voice-hotkey.mjs';
import { createSparkieeServer } from './server.mjs';
import { createMusicLibrary } from '../../core/src/music-library.mjs';
import { createMusicPlayer } from '../../core/src/music-player.mjs';
import { CHARACTER_ROOTS, createPackDetailProvider } from './pack-detail.mjs';

const paths = resolveRuntimePaths();
const projectRegistry = createProjectRegistry({ env: process.env });
const systemLauncher = createSystemLauncher({ env: process.env });
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
let characterCache = { at: 0, value: { packs: [], invalid: [] } };

async function describeCharacters() {
  const now = Date.now();
  if (now - characterCache.at < 5_000) return characterCache.value;
  const { packs, invalid } = await listCharacterPacks(CHARACTER_ROOTS);
  characterCache = {
    at: now,
    value: {
      packs: packs.map((pack) => ({
        id: pack.id,
        name: pack.name,
        version: pack.version,
        description: pack.description,
        license: pack.license,
        voiceStyle: pack.voice.style,
        animationCount: Object.keys(pack.animations).length,
      })),
      invalid,
    },
  };
  return characterCache.value;
}
let httpServer;
let petHost;
let musicPlayerRuntime;
let assistantService;
let shuttingDown = false;

// Pack detail for the dashboard habitat lives in pack-detail.mjs (shared
// with tests): same validated manifest summary the pet host renders, but
// with the sprite referenced through a same-origin HTTP route instead of a
// file:// URL. The sprite path itself only ever stays inside this process.
const getPackDetail = createPackDetailProvider();

// ---------------------------------------------------------------------------
// Voice configuration holder: cached so callers can read it synchronously,
// refreshed (throttled) on voice traffic so `sparkiee voice setup` applies
// without a daemon restart. The key never leaves this process.
// ---------------------------------------------------------------------------

const VOICE_CONFIG_TTL_MS = 3000;
const DEFAULT_UNCONFIGURED = Object.freeze({
  configured: false,
  config: { engine: 'piper', voices: { ...DEFAULT_VOICES }, speed: DEFAULT_SPEED },
  warnings: [],
  source: null,
});
const petController = createPetController();
const petDockFile = path.join(paths.home, 'pet-dock.json');

/**
 * Dock posture is tiny, non-secret state. Persisting it means a runtime
 * restart puts Sparky back to sleep on the same pinned anchor instead of
 * resetting to "hanging out" mid-task.
 */
async function loadPetDock() {
  try {
    const parsed = JSON.parse(await readFile(petDockFile, 'utf8'));
    if (typeof parsed?.docked === 'boolean') petController.setDocked(parsed.docked);
  } catch {
    // Missing or malformed file means "not docked" — never a startup failure.
  }
}

async function persistPetDock(docked) {
  try {
    await writeFile(petDockFile, `${JSON.stringify({ docked: docked === true })}\n`, { mode: 0o600 });
  } catch {
    // Persistence is a convenience; the live daemon state still works.
  }
}
let voiceConfigLoaded = null;
let voiceConfigAt = 0;
let piperEngine = null;
let localTtsStatus = null;
let localTtsStatusAt = 0;
const LOCAL_TTS_PROBE_TTL_MS = 30_000;

/**
 * Local speech fallback availability is probed for real (espeak-ng --version),
 * never assumed from the presence of the client. The result feeds the honest
 * speech-ready flag, so a machine with no cloud key but a working espeak-ng
 * still speaks instead of silently captioning.
 */
async function refreshLocalTtsStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && localTtsStatus && now - localTtsStatusAt < LOCAL_TTS_PROBE_TTL_MS) return localTtsStatus;
  localTtsStatusAt = now;
  try {
    localTtsStatus = await probeLocalTts();
  } catch (error) {
    localTtsStatus = {
      provider: 'espeak-ng',
      status: 'unavailable',
      binary: null,
      version: null,
      detail: `Could not probe the local speech fallback (${error?.message ?? 'unknown error'}).`,
    };
  }
  return localTtsStatus;
}

function isLocalTtsReady() {
  return localTtsStatus?.status === 'ready';
}

// ---------------------------------------------------------------------------
// Chat-provider configuration (Groq / Google AI Studio): cached like the voice
// config so the daemon can answer synchronously. Keys never leave this
// process and never reach the renderer.
// ---------------------------------------------------------------------------
const CHAT_CONFIG_TTL_MS = 3000;
const DEFAULT_CHAT_UNCONFIGURED = Object.freeze({
  configured: false,
  provider: 'groq',
  config: { provider: 'groq', providers: { groq: null, google: null }, localOnly: false },
  warnings: [],
  source: null,
});
let chatConfigLoaded = null;
let chatConfigAt = 0;

async function refreshChatConfig({ force = false } = {}) {
  const now = Date.now();
  if (!force && chatConfigLoaded && now - chatConfigAt < CHAT_CONFIG_TTL_MS) return chatConfigLoaded;
  chatConfigAt = now;
  try {
    chatConfigLoaded = await loadChatConfig();
  } catch {
    chatConfigLoaded = { ...DEFAULT_CHAT_UNCONFIGURED, warnings: ['Chat configuration could not be read.'] };
  }
  return chatConfigLoaded;
}

function getChatConfig() {
  return chatConfigLoaded ?? DEFAULT_CHAT_UNCONFIGURED;
}

/**
 * Replaceable adapter around the chat client: the server only ever sees this
 * small surface, so the provider can change without touching routing logic.
 * `configured()` is false in local-only mode, which makes the honest
 * "local-only" reply path do the work instead of a silent egress.
 */
function createChatProvider() {
  return {
    configured() {
      const loaded = getChatConfig();
      return loaded.configured === true && loaded.config.localOnly !== true;
    },
    describe() {
      return describeChatConfig(getChatConfig());
    },
    chat(messages, options) {
      const loaded = getChatConfig();
      const active = loaded.provider;
      const entry = loaded.config.providers?.[active] ?? {};
      return createChatClient({
        provider: active,
        config: {
          apiKey: entry.apiKey ?? null,
          model: entry.model ?? null,
          baseUrl: CHAT_PROVIDER_INFO[active].baseUrl,
          localOnly: loaded.config.localOnly === true,
        },
      }).chat(messages, options);
    },
  };
}

/**
 * Local speech availability is probed for real, never assumed from the
 * presence of a client. The result feeds the honest voice status in the
 * dashboard and decides whether captions yield to speech.
 */
async function refreshVoiceConfig({ force = false } = {}) {
  const now = Date.now();
  if (!force && voiceConfigLoaded && now - voiceConfigAt < VOICE_CONFIG_TTL_MS) return voiceConfigLoaded;
  voiceConfigAt = now;
  try {
    voiceConfigLoaded = await loadVoiceConfig();
  } catch {
    voiceConfigLoaded = {
      ...DEFAULT_UNCONFIGURED,
      warnings: ['Voice configuration could not be read.'],
    };
  }
  // Speech is possible with a ready Piper runtime or a working espeak-ng
  // fallback; both are probed rather than guessed.
  const piperStatus = piperEngine ? await piperEngine.probe().catch(() => null) : null;
  petController.setVoiceCapability(piperStatus?.status === 'ready' || isLocalTtsReady());
  return voiceConfigLoaded;
}

function getVoiceConfig() {
  return voiceConfigLoaded ?? DEFAULT_UNCONFIGURED;
}

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
    if (process.env.SPARKIEE_ELECTRON_DIR) {
      // Test/diagnostic seam: point at a specific electron package directory.
      electronDir = process.env.SPARKIEE_ELECTRON_DIR;
    } else {
      try {
        electronDir = path.dirname(require.resolve('electron/package.json'));
      } catch {
        electronDir = undefined;
      }
    }
    const resolved = resolveElectronBinary({ electronDir, overrideDistPath: process.env.ELECTRON_OVERRIDE_DIST_PATH });
    if (!resolved.ok) {
      hostTracker.markFailed(`${resolved.detail} ${resolved.hint}`);
      void log(`Desktop pet host unavailable: ${hostTracker.snapshot().lastError}`);
      return;
    }
    // Ozone platform for the browser process must be a real CLI argument:
    // app.commandLine.appendSwitch arrives too late and only affects renderers,
    // leaving the browser process on Wayland where windows cannot be positioned.
    const hostArgs = [];
    if (process.platform === 'linux' && process.env.SPARKIEE_OZONE_PLATFORM !== 'wayland') {
      hostArgs.push('--ozone-platform=x11');
    }
    petHost = spawn(resolved.binary, [...hostArgs, PET_APP_DIR], {
      cwd: PET_APP_DIR,
      // Provider credentials stay with the daemon; the pet host only needs
      // the runtime token and port.
      env: {
        ...withoutSecrets(process.env),
        SPARKIEE_PORT: String(port),
        SPARKIEE_HOME: paths.home,
        SPARKIEE_RUNTIME_TOKEN: token,
      },
      stdio: 'ignore',
      detached: false,
    });
    // Publish the pid immediately: exactly-one-host arbitration in the pet
    // host compares against this value, and a window between "launching"
    // and the spawn event could otherwise make an older host self-identify
    // as the owner. The pid marker file survives between restart attempts
    // (an orphan must never self-identify as owner just because it sampled
    // the runtime between two attempts), so it is persisted, not only in
    // memory, and removed again on clean shutdown.
    hostTracker.annotateLaunchPid(petHost.pid ?? null);
    writeFile(paths.hostPidFile, `${petHost.pid}\n`, { mode: 0o600 }).catch(() => {});
    petHost.on('spawn', () => {
      if (petHost?.pid) hostTracker.markRunning(petHost.pid);
      void log(`Desktop pet host running (pid ${petHost?.pid ?? 'unknown'}).`);
    });
    petHost.on('error', (error) => {
      hostTracker.markFailed(`Could not launch desktop pet host: ${error.message}. Ensure dependencies are installed with npm install.`);
      void log(hostTracker.snapshot().lastError);
    });
    petHost.on('exit', (code, signal) => {
      // A host that ran stable for 45s earns a fresh restart budget: a
      // crash long after a healthy run must not be throttled by ancient
      // single-instance losses.
      const ranMs = Date.now() - hostTracker.snapshot().since;
      if (ranMs > 45_000) hostTracker.resetFailures();
      hostTracker.markExited(code, signal, { wasShuttingDown: shuttingDown });
      void log(`Desktop pet host exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`);
      petHost = undefined;
      scheduleHostRestart(code);
    });
    void log('Desktop pet host launch requested.');
  } catch (error) {
    hostTracker.markFailed(`Desktop pet host unavailable: ${error.message}. Run npm install and check Electron dependencies.`);
    void log(hostTracker.snapshot().lastError);
  }
}

function scheduleHostRestart(exitCode = null) {
  if (shuttingDown || !hostTracker.canLaunch() || !runtimeToken) return;
  if (restartTimer) return;
  if (hostTracker.restarts >= MAX_HOST_RESTARTS) {
    void log(`Desktop pet host restart limit (${MAX_HOST_RESTARTS}) reached. Use the dashboard retry action or restart Sparkiee.`);
    return;
  }
  // A clean exit (code 0) is usually single-instance loss: the host noticed
  // another one owns the desktop. Retrying aggressively then just burns
  // restart attempts against an orphan that is already about to exit, so a
  // clean quit waits longer than a crash before retrying.
  const cleanQuit = exitCode === 0;
  const delay = cleanQuit ? 6_000 : 1_000 * (2 ** hostTracker.restarts);
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

function lastHostPidFromDisk() {
  try {
    const value = Number(readFileSync(paths.hostPidFile, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
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
  await unlink(paths.hostPidFile).catch((error) => {
    if (error?.code !== 'ENOENT') log(`Unable to remove pet-host pid file: ${error.message}`);
  });
  await removePidIfOwned();
  if (musicPlayerRuntime) {
    try {
      musicPlayerRuntime.dispose(); // stops music + releases the cvlc child
    } catch {
      // best effort — shutdown continues
    }
  }
  if (assistantService) {
    try {
      assistantService.dispose(); // stops mic + wake listener
    } catch {
      // best effort — shutdown continues
    }
  }
  if (piperEngine) {
    await piperEngine.close().catch(() => {});
    piperEngine = null;
  }
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
  await loadPetDock();
  await refreshVoiceConfig({ force: true });
  await refreshLocalTtsStatus({ force: true });
  await refreshChatConfig({ force: true });
  // Re-evaluate the speech-ready flag now that the local probe has answered.
  petController.setVoiceCapability(getVoiceConfig().configured === true || isLocalTtsReady());
  const voiceCache = createAudioCache({ dir: resolveVoiceCacheDir() });
  // Local voice: Piper speaks entirely on this machine. The engine is created
  // once and keeps a resident worker warm; it reads the current config lazily.
  piperEngine = createPiperTts({ env: process.env, getConfig: () => getVoiceConfig().config });
  petController.setVoiceCapability((await piperEngine.probe().catch(() => null))?.status === 'ready' || isLocalTtsReady());
  // Emergency speech fallback: captions are not speech, so an espeak-ng clip
  // is generated whenever Piper is unavailable. Probed for real.
  const localTts = isLocalTtsReady() ? createLocalTts() : null;
  const voiceService = createVoiceService({
    getConfig: getVoiceConfig,
    getEngine: () => piperEngine,
    cache: voiceCache,
    petController,
    localTts,
    getLocalTtsStatus: () => refreshLocalTtsStatus(),
  });
  // Read-only MP3 library over ~/Music (SPARKIEE_MUSIC_ROOTS overrides).
  // The initial scan runs in the background; status stays honest until it
  // finishes (scannedAt null, trackCount 0).
  const musicLibrary = createMusicLibrary();
  void musicLibrary.prime().catch(() => {});
  // One daemon-owned playback child survives desktop↔dashboard handoffs.
  musicPlayerRuntime = createMusicPlayer({ library: musicLibrary });
  // Assistant: state machine + mic + wake (Porcupine) + PTT.
  assistantService = createAssistantService();
  // Global push-to-talk shortcut: persisted settings + Electron registration.
  const hotkey = createHotkeyState();
  httpServer = createSparkieeServer({
    port,
    token,
    onShutdown: () => void shutdown('API request'),
    petController,
    getHostState: () => {
      const snap = hostTracker.snapshot();
      // The last-spawned host pid is authoritative across retry attempts and
      // phase resets — exactly-one-host arbitration in the pet host reads it.
      return { ...snap, pid: lastHostPidFromDisk() ?? snap.pid };
    },
    onRestartHost: () => restartHost(),
    onWindowEvent: ({ event, pid }) => {
      void log(`Pet host window ${event}${pid ? ` (host pid ${pid})` : ''}.`);
    },
    onDockChange: (docked) => persistPetDock(docked),
    getCharacterInfo: async () => {
      const { packs } = await describeCharacters();
      return packs.find((pack) => pack.id === 'sparkiee-original') ?? packs[0] ?? null;
    },
    getCharacters: () => describeCharacters(),
    getPackDetail,
    musicService: {
      status: () => musicLibrary.status(),
      list: (options) => musicLibrary.list(options),
      rescan: (options) => musicLibrary.rescan(options),
      playbackStatus: () => musicPlayerRuntime.status(),
      searchRanked: (query, options) => musicLibrary.searchRanked(query, options),
      duckForSpeech: (durationMs) => musicPlayerRuntime.duck({ durationMs }),
      unduck: () => musicPlayerRuntime.unduck(),
      play: (options) => musicPlayerRuntime.play(options),
      pause: () => musicPlayerRuntime.pause(),
      resume: () => musicPlayerRuntime.resume(),
      stop: () => musicPlayerRuntime.stop(),
      next: () => musicPlayerRuntime.next(),
      previous: () => musicPlayerRuntime.previous(),
      updateSettings: (payload) => musicPlayerRuntime.updateSettings(payload),
    },
    voiceService,
    assistantService,
    projectRegistry,
    systemLauncher,
    chatProvider: createChatProvider(),
    refreshChatConfig: () => refreshChatConfig(),
    hotkey,
    refreshVoiceConfig: () => refreshVoiceConfig(),
    isVoiceReady: () => getVoiceConfig().configured === true || isLocalTtsReady(),
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
  // Presentation lease ticker: an abandoned or unclaimed dashboard claim
  // expires here (bounded lease), restoring desktop presentation without
  // relying on browser unload events.
  const presentationTicker = setInterval(() => {
    try {
      const hostRunning = hostTracker.snapshot().phase === 'running';
      const restored = petController.tickPresentation({ hostRunning });
      if (restored?.presentation?.lastTransition) {
        void log(`Presentation restored to desktop (${restored.presentation.lastTransition.reason}).`);
      }
    } catch (error) {
      void log(`Presentation ticker error: ${error.message}`);
    }
  }, 2_000);
  presentationTicker.unref();
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
