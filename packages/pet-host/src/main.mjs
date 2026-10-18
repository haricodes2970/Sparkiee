import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMovementController } from './movement.mjs';
import { listCharacterPacks } from '../../core/src/character-pack.mjs';
import { COMMAND_VOICE_EVENTS, desktopWindowVisible } from '../../core/src/pet-state.mjs';

const APP_DIR = fileURLToPath(new URL('../', import.meta.url));
const PET_PAGE = path.join(APP_DIR, 'renderer', 'index.html');
const HOST = '127.0.0.1';
const PORT = Number(process.env.SPARKIEE_PORT || 2005);
const TOKEN = process.env.SPARKIEE_RUNTIME_TOKEN;
const VALID_COMMANDS = new Set(['idle', 'walk', 'run', 'dance', 'sleep', 'celebrate', 'wave', 'surprised', 'confused', 'thinking', 'task_complete', 'task_error', 'permission_required', 'hide', 'show']);
const POLL_MS = 900;
const PACK_ROOTS = [
  // repo-relative bundled packs: packages/pet-host/src -> repo root
  fileURLToPath(new URL('../../../assets/characters/', import.meta.url)),
  path.join(
    process.env.XDG_DATA_HOME || path.join(process.env.HOME || '', '.local', 'share'),
    'sparkiee',
    'characters',
  ),
];
let petWindow;
let pollTimer;
let lastState = '';
let latestState = null;
let dragOrigin = null;
let movement;
let currentPack = null;
let loadedPackId = null;
let sentSpeechId = 0;
let deliveringSpeech = false;
let runtimeReachable = true;
let closeTransferPendingUntil = 0;
let quitting = false;
const hostStartedAt = Date.now();

if (process.platform === 'linux' && process.env.SPARKIEE_OZONE_PLATFORM !== 'wayland') {
  // Phase 0 selected XWayland for GNOME because the pet needs window positioning.
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

function apiUrl(route) {
  return `http://${HOST}:${PORT}${route}`;
}

function isPointerPoint(point) {
  return point && typeof point === 'object' &&
    Number.isFinite(point.screenX) && Number.isFinite(point.screenY) &&
    Math.abs(point.screenX) < 100_000 && Math.abs(point.screenY) < 100_000;
}

async function requestApi(route, options = {}) {
  if (!TOKEN || !/^[a-f0-9]{64}$/.test(TOKEN)) throw new Error('Sparkiee runtime token is missing or invalid.');
  const response = await fetch(apiUrl(route), {
    ...options,
    signal: AbortSignal.timeout(1600),
    headers: { accept: 'application/json', authorization: `Bearer ${TOKEN}`, ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Runtime returned HTTP ${response.status}`);
  return payload;
}

function reactToMovement(state) {
  if (!movement || !petWindow || petWindow.isDestroyed()) return;
  // Roaming follows the visible desktop surface only: hidden pets and
  // dashboard-owned pets keep the native window (and its movement) still.
  if (!state || !desktopWindowVisible(state)) {
    movement.stop();
    return;
  }
  const animation = state.animation;
  if (animation === 'walk' || animation === 'run') {
    movement.start(animation);
    return;
  }
  // Idle roams gently when the user has autonomous movement enabled.
  if (animation === 'idle' && state.settings?.autoRoam !== false) {
    movement.start('walk');
    return;
  }
  // Dance, sleep, celebrate, thinking, reactions, etc. keep the pet
  // in place until the state changes again.
  movement.stop();
}

// ---------------------------------------------------------------------------
// Character pack loading (bundled repo packs + user-local packs)
// ---------------------------------------------------------------------------

function buildPackSummary(pack) {
  return {
    id: pack.id,
    name: pack.name,
    sprite: {
      url: pathToFileURL(pack.spriteSheetPath).href,
      frameWidth: pack.spriteSheet.frameWidth,
      frameHeight: pack.spriteSheet.frameHeight,
      columns: pack.spriteSheet.columns,
    },
    animations: pack.animations,
    layout: {
      windowWidth: pack.layout.windowWidth,
      windowHeight: pack.layout.windowHeight,
      spriteScale: pack.layout.spriteScale,
      captionDurationMs: pack.layout.captionDurationMs,
      captionMaxLines: pack.layout.captionMaxLines,
    },
    voiceStyle: pack.voice.style,
    voiceEvents: pack.voice.events,
    commandVoiceEvents: COMMAND_VOICE_EVENTS,
  };
}

async function loadCharacterPackById(characterId) {
  const { packs } = await listCharacterPacks(PACK_ROOTS);
  const wanted = typeof characterId === 'string' ? characterId : null;
  const pack = packs.find((candidate) => candidate.id === wanted)
    ?? packs.find((candidate) => candidate.id === 'sparkiee-original')
    ?? packs[0]
    ?? null;
  return pack;
}

async function reloadPackForState(state) {
  const wanted = state?.settings?.characterId;
  // Only reload when an explicit, different character is requested.
  if (loadedPackId !== null && (wanted === undefined || wanted === null || wanted === loadedPackId)) return;
  const pack = await loadCharacterPackById(wanted);
  if (!pack) return;
  const switched = loadedPackId !== null && loadedPackId !== pack.id;
  loadedPackId = pack.id;
  currentPack = buildPackSummary(pack);
  if (petWindow && !petWindow.isDestroyed()) {
    if (switched) applyWindowLayout(currentPack.layout);
    petWindow.webContents.send('pet:pack', currentPack);
  }
}

function applyWindowLayout(layout) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const width = Math.round(layout.windowWidth);
  const height = Math.round(layout.windowHeight);
  const [oldX, oldY] = petWindow.getPosition();
  const old = petWindow.getBounds();
  const centerX = oldX + old.width / 2;
  const centerY = oldY + old.height / 2;
  const { workArea } = screen.getDisplayMatching(old);
  const x = Math.min(Math.max(workArea.x, Math.round(centerX - width / 2)), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(workArea.y, Math.round(centerY - height / 2)), workArea.y + workArea.height - height);
  petWindow.setBounds({ x, y, width, height }, false);
}

function publishState(state) {
  latestState = state;
  const serialised = JSON.stringify(state);
  if (serialised !== lastState) {
    lastState = serialised;
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('pet:state', state);
    }
    reactToMovement(state);
    void reloadPackForState(state);
    void deliverPendingSpeech();
  }
  reconcileWindowVisibility(state);
}

/**
 * The native window follows presentation ownership plus the visible flag:
 * hidden while a dashboard owns the pet, and recreated after an ordinary
 * window close once presentation returns to the desktop. Checked on every
 * poll (not only on state changes) so close/restore races self-heal.
 */
function reconcileWindowVisibility(state) {
  const shouldShow = desktopWindowVisible(state);
  if (!petWindow || petWindow.isDestroyed()) {
    // A close-initiated transfer is in flight: do not flash the window back
    // before the daemon confirms where presentation now lives.
    const transferInFlight = Date.now() < closeTransferPendingUntil && runtimeReachable;
    if (shouldShow && !transferInFlight) petWindow = createPetWindow();
    return;
  }
  if (shouldShow && !petWindow.isVisible()) petWindow.showInactive();
  if (!shouldShow && petWindow.isVisible()) petWindow.hide();
}

// ---------------------------------------------------------------------------
// Speech delivery: the daemon announces {id, text, clipId} in pet state after
// generation succeeds; the main process downloads the cached clip with the
// runtime token and hands the renderer a data URL. Renderers never see the
// API key, the token, or any network route.
// ---------------------------------------------------------------------------

async function buildSpeechPayload(speech) {
  const base = {
    id: speech.id,
    text: String(speech.text ?? '').slice(0, 220),
    voiceEvent: typeof speech.voiceEvent === 'string' ? speech.voiceEvent.slice(0, 40) : null,
    source: typeof speech.source === 'string' ? speech.source.slice(0, 16) : null,
    dataUrl: null,
    error: null,
  };
  if (!speech.clipId || !/^[a-f0-9]{64}$/.test(speech.clipId)) {
    return { ...base, error: typeof speech.error === 'string' && speech.error ? speech.error.slice(0, 40) : 'unavailable' };
  }
  if (!TOKEN || !/^[a-f0-9]{64}$/.test(TOKEN)) return { ...base, error: 'no_token' };
  try {
    const response = await fetch(apiUrl(`/api/v1/voice/clip/${speech.clipId}`), {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { ...base, error: 'clip_unavailable' };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 4_000_000) return { ...base, error: 'clip_unavailable' };
    const mime = (response.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
    if (!/^audio\/[a-z0-9.+-]+$/.test(mime)) return { ...base, error: 'clip_unavailable' };
    return { ...base, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
  } catch {
    return { ...base, error: 'clip_unavailable' };
  }
}

async function deliverPendingSpeech() {
  if (deliveringSpeech) return;
  deliveringSpeech = true;
  try {
    for (;;) {
      const speech = latestState?.speech;
      if (!speech || !Number.isInteger(speech.id) || speech.id <= sentSpeechId) return;
      // Do not replay the previous phrase after a pet-host restart.
      const announcedAt = Date.parse(speech.at);
      if (Number.isFinite(announcedAt) && announcedAt < hostStartedAt - 2000) {
        sentSpeechId = speech.id;
        continue;
      }
      const payload = await buildSpeechPayload(speech);
      sentSpeechId = speech.id;
      // A newer phrase arrived while fetching: this one is obsolete.
      const latest = latestState?.speech;
      if (latest && latest.id === speech.id && petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send('pet:speech', payload);
      }
    }
  } catch {
    // Speech delivery is best-effort; animation and captions continue.
  } finally {
    deliveringSpeech = false;
  }
}

async function pollState() {
  try {
    publishState(await requestApi('/api/v1/pet/state'));
    runtimeReachable = true;
  } catch {
    runtimeReachable = false;
    publishState({
      ...(latestState || {}),
      animation: 'surprised',
      label: 'Runtime disconnected',
      message: 'I cannot reach Sparkiee right now.',
      hostConnected: false,
      visible: true,
    });
  }
}

async function sendCommand(command) {
  if (typeof command !== 'string' || !VALID_COMMANDS.has(command)) throw new Error('Unsupported Sparkiee pet command.');
  const payload = await requestApi('/api/v1/pet/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command }),
  });
  publishState(payload.pet);
  return payload.pet;
}

function movePetFromPointer(point) {
  if (!dragOrigin || !isPointerPoint(point) || !petWindow || petWindow.isDestroyed()) return;
  const deltaX = Math.round(point.screenX - dragOrigin.pointerX);
  const deltaY = Math.round(point.screenY - dragOrigin.pointerY);
  if (Math.abs(deltaX) < 3 && Math.abs(deltaY) < 3) return;
  const display = screen.getDisplayMatching(petWindow.getBounds());
  const area = display.workArea;
  const [currentX, currentY] = petWindow.getPosition();
  const targetX = Math.min(Math.max(area.x, dragOrigin.windowX + deltaX), area.x + area.width - petWindow.getBounds().width);
  const targetY = Math.min(Math.max(area.y, dragOrigin.windowY + deltaY), area.y + area.height - petWindow.getBounds().height);
  if (targetX !== currentX || targetY !== currentY) petWindow.setPosition(targetX, targetY, false);
}

function createPetWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = currentPack?.layout?.windowWidth ?? 220;
  const height = currentPack?.layout?.windowHeight ?? 300;
  const pet = new BrowserWindow({
    width,
    height,
    x: Math.max(workArea.x, workArea.x + workArea.width - width - 24),
    y: Math.max(workArea.y, workArea.y + workArea.height - height - 30),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, 'src', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  pet.setMenu(null);
  pet.setAlwaysOnTop(true);
  pet.on('ready-to-show', () => {
    // First paint can land after the first polls: only show immediately if
    // the desktop surface owns presentation (otherwise the reconcile pass
    // keeps the just-created window unmapped until it does).
    if (desktopWindowVisible(latestState)) pet.showInactive();
  });
  pet.on('closed', () => {
    petWindow = undefined;
    // An ordinary window close (Alt+F4 on the frameless window) is a
    // transfer request, not an app exit: ask for dashboard presentation.
    // If no dashboard tab claims the transfer within the grace period the
    // daemon restores desktop mode and the window is recreated on the next
    // poll — the host process never dies, so the daemon never enters a
    // restart loop for a deliberate close. Graceful app shutdowns skip the
    // transfer so restarting the host never parks presentation in limbo.
    if (!quitting) {
      closeTransferPendingUntil = Date.now() + 5_000;
      void requestApi('/api/v1/presentation/to-dashboard', { method: 'POST' }).catch(() => {});
    }
  });
  pet.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  pet.webContents.on('did-finish-load', () => {
    if (currentPack) pet.webContents.send('pet:pack', currentPack);
  });
  pet.loadFile(PET_PAGE);
  return pet;
}

ipcMain.handle('pet:command', async (_event, command) => sendCommand(command));
ipcMain.handle('pet:get-state', () => latestState);
ipcMain.handle('pet:get-pack', () => currentPack);
ipcMain.handle('pet:send-to-dashboard', async () => {
  const payload = await requestApi('/api/v1/presentation/to-dashboard', { method: 'POST' });
  if (payload?.pet) publishState(payload.pet);
  return payload?.pet ?? null;
});
ipcMain.on('pet:drag-start', (event, point) => {
  if (!isPointerPoint(point) || !petWindow || event.sender !== petWindow.webContents) return;
  const [windowX, windowY] = petWindow.getPosition();
  dragOrigin = { pointerX: point.screenX, pointerY: point.screenY, windowX, windowY };
  // Autonomous roaming must not fight the user while they drag.
  movement?.pause();
});
ipcMain.on('pet:drag-move', (event, point) => {
  if (!petWindow || event.sender !== petWindow.webContents) return;
  movePetFromPointer(point);
});
ipcMain.on('pet:drag-end', (event) => {
  if (petWindow && event.sender === petWindow.webContents) {
    dragOrigin = null;
    movement?.resume();
  }
});

app.whenReady().then(async () => {
  if (!TOKEN || !/^[a-f0-9]{64}$/.test(TOKEN)) {
    app.quit();
    return;
  }
  await reloadPackForState(null).catch(() => {});
  petWindow = createPetWindow();
  movement = createMovementController({
    getBounds: () => (petWindow && !petWindow.isDestroyed()
      ? petWindow.getBounds()
      : { x: 0, y: 0, width: 0, height: 0 }),
    getWorkArea: () => (petWindow && !petWindow.isDestroyed()
      ? screen.getDisplayMatching(petWindow.getBounds()).workArea
      : screen.getPrimaryDisplay().workArea),
    setPosition: (x, y) => {
      if (petWindow && !petWindow.isDestroyed()) petWindow.setPosition(Math.round(x), Math.round(y), false);
    },
    speedScale: () => latestState?.settings?.moveSpeed ?? 1,
  });
  await pollState();
  pollTimer = setInterval(() => void pollState(), POLL_MS);
  app.on('activate', () => {
    if (desktopWindowVisible(latestState) && (!petWindow || petWindow.isDestroyed())) {
      petWindow = createPetWindow();
    } else if (petWindow && !petWindow.isDestroyed()) {
      petWindow.showInactive();
    }
  });
}).catch(() => app.quit());

app.on('before-quit', () => {
  quitting = true;
  if (pollTimer) clearInterval(pollTimer);
  movement?.stop();
  ipcMain.removeHandler('pet:command');
  ipcMain.removeHandler('pet:get-state');
  ipcMain.removeHandler('pet:get-pack');
  ipcMain.removeHandler('pet:send-to-dashboard');
  ipcMain.removeAllListeners('pet:drag-start');
  ipcMain.removeAllListeners('pet:drag-move');
  ipcMain.removeAllListeners('pet:drag-end');
});

// Deliberate or WM-initiated window closure must not kill the host process:
// an exiting host would bounce through the daemon's restart loop. The host
// stays alive headless and the reconcile pass recreates the window when
// presentation returns to the desktop.
app.on('window-all-closed', () => {});
