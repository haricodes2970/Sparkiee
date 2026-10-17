import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('../', import.meta.url));
const PET_PAGE = path.join(APP_DIR, 'renderer', 'index.html');
const HOST = '127.0.0.1';
const PORT = Number(process.env.SPARKIEE_PORT || 2005);
const TOKEN = process.env.SPARKIEE_RUNTIME_TOKEN;
const VALID_COMMANDS = new Set(['idle', 'walk', 'run', 'dance', 'sleep', 'celebrate', 'wave', 'surprised', 'hide', 'show']);
const POLL_MS = 900;
let petWindow;
let pollTimer;
let lastState = '';
let latestState = null;

if (process.platform === 'linux' && process.env.SPARKIEE_OZONE_PLATFORM !== 'wayland') {
  // Phase 0 selected XWayland for GNOME because the pet needs window positioning.
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

function apiUrl(route) {
  return `http://${HOST}:${PORT}${route}`;
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

function publishState(state) {
  latestState = state;
  const serialised = JSON.stringify(state);
  if (serialised === lastState) return;
  lastState = serialised;
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:state', state);
    if (state.visible && !petWindow.isVisible()) petWindow.showInactive();
    if (!state.visible && petWindow.isVisible()) petWindow.hide();
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

function createPetWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 204;
  const height = 220;
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
  pet.loadFile(PET_PAGE);
  return pet;
}

ipcMain.handle('pet:command', async (_event, command) => sendCommand(command));
ipcMain.handle('pet:get-state', () => latestState);

app.whenReady().then(async () => {
  if (!TOKEN || !/^[a-f0-9]{64}$/.test(TOKEN)) {
    app.quit();
    return;
  }
  petWindow = createPetWindow();
  await pollState();
  pollTimer = setInterval(() => void pollState(), POLL_MS);
  app.on('activate', () => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.showInactive();
  });
}).catch(() => app.quit());

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  ipcMain.removeHandler('pet:command');
  ipcMain.removeHandler('pet:get-state');
});

app.on('window-all-closed', () => app.quit());
