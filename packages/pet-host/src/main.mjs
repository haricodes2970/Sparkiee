import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMovementController } from './movement.mjs';
import { listCharacterPacks } from '../../core/src/character-pack.mjs';
import { COMMAND_VOICE_EVENTS } from '../../core/src/pet-state.mjs';

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
  if (!movement) return;
  if (!state || state.visible === false) {
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
      if (state.visible && !petWindow.isVisible()) petWindow.showInactive();
      if (!state.visible && petWindow.isVisible()) petWindow.hide();
    }
    reactToMovement(state);
    void reloadPackForState(state);
  }
}

async function pollState() {
  try {
    publishState(await requestApi('/api/v1/pet/state'));
  } catch {
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
  pet.on('ready-to-show', () => pet.showInactive());
  pet.on('closed', () => {
    petWindow = undefined;
    app.quit();
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
    getBounds: () => petWindow.getBounds(),
    getWorkArea: () => screen.getDisplayMatching(petWindow.getBounds()).workArea,
    setPosition: (x, y) => petWindow.setPosition(Math.round(x), Math.round(y), false),
    speedScale: () => latestState?.settings?.moveSpeed ?? 1,
  });
  await pollState();
  pollTimer = setInterval(() => void pollState(), POLL_MS);
  app.on('activate', () => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.showInactive();
  });
}).catch(() => app.quit());

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  movement?.stop();
  ipcMain.removeHandler('pet:command');
  ipcMain.removeHandler('pet:get-state');
  ipcMain.removeHandler('pet:get-pack');
  ipcMain.removeAllListeners('pet:drag-start');
  ipcMain.removeAllListeners('pet:drag-move');
  ipcMain.removeAllListeners('pet:drag-end');
});

app.on('window-all-closed', () => app.quit());
