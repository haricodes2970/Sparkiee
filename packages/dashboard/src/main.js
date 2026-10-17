const connectionPill = document.querySelector('#connection-pill');
const connectionText = document.querySelector('#connection-text');
const runtimeState = document.querySelector('#runtime-state');
const runtimeCaption = document.querySelector('#runtime-caption');
const runtimePort = document.querySelector('#runtime-port');
const petHostStat = document.querySelector('#pet-host-stat');
const petHostCaption = document.querySelector('#pet-host-caption');
const petHostPill = document.querySelector('#pet-host-pill');
const petStatusLabel = document.querySelector('#pet-status-label');
const petStatusMessage = document.querySelector('#pet-status-message');
const petVisibilityText = document.querySelector('#pet-visibility-text');
const commandFeedback = document.querySelector('#command-feedback');
const lastChecked = document.querySelector('#last-checked');
const liveRegion = document.querySelector('#live-region');
const activityList = document.querySelector('#activity-list');
const commandButtons = document.querySelectorAll('[data-pet-command]');
const retryHostButton = document.querySelector('#retry-host');
const activity = [];
let lastPetState = null;
let commandInFlight = false;
let lastHostPhase = null;

const HOST_PHASE_LABELS = {
  running: 'Running',
  launching: 'Launching…',
  idle: 'Not started',
  exited: 'Stopped',
  failed: 'Launch failed',
  disabled: 'Disabled',
  unavailable: 'No display',
};

function recordActivity(command, label, message, time) {
  activity.unshift({ command, label, message, time: time || new Date().toISOString() });
  activity.splice(8);
  renderActivity();
}

function applyHostState(petHost) {
  if (!petHost || typeof petHost !== 'object') return;
  const phase = petHost.phase in HOST_PHASE_LABELS ? petHost.phase : 'idle';
  petHostStat.textContent = HOST_PHASE_LABELS[phase];
  petHostCaption.textContent = phase === 'running'
    ? `Desktop pet process ${petHost.pid}${petHost.pidAlive === false ? ' (not responding)' : ''}`
    : (petHost.lastError || 'The desktop pet window is not running right now.');
  retryHostButton.hidden = !(phase === 'failed' || phase === 'exited');
  if (lastHostPhase !== null && lastHostPhase !== phase) {
    recordActivity('host', `Pet host ${HOST_PHASE_LABELS[phase].toLowerCase()}`, petHost.lastError || `Phase changed to ${phase}.`);
  }
  lastHostPhase = phase;
}

async function retryHostLaunch() {
  retryHostButton.disabled = true;
  commandFeedback.className = 'command-feedback';
  commandFeedback.textContent = 'Asking the runtime to relaunch the desktop pet…';
  try {
    const response = await fetch('/api/v1/host/restart', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    applyHostState(result.host);
    commandFeedback.className = 'command-feedback success';
    commandFeedback.textContent = result.host.phase === 'running'
      ? `Desktop pet is running again (pid ${result.host.pid}).`
      : `Relaunch requested — the pet host is ${HOST_PHASE_LABELS[result.host.phase] || result.host.phase}.`;
  } catch (error) {
    commandFeedback.className = 'command-feedback error';
    commandFeedback.textContent = error.message || 'Could not relaunch the desktop pet host.';
  } finally {
    retryHostButton.disabled = false;
  }
}

function setConnectionState(state, text) {
  connectionPill.className = `status-pill ${state}`;
  connectionText.textContent = text;
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s uptime`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m uptime`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m uptime`;
}

function renderActivity() {
  activityList.replaceChildren();
  if (activity.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'activity-empty';
    empty.textContent = 'Your pet\'s recent emotes will appear here.';
    activityList.append(empty);
    return;
  }
  for (const item of activity) {
    const row = document.createElement('div');
    row.className = 'activity-item';
    const glyph = document.createElement('span');
    glyph.className = 'activity-glyph';
    glyph.textContent = item.command === 'celebrate' ? '✧' : item.command === 'sleep' ? '☾' : '✦';
    const body = document.createElement('div');
    body.className = 'activity-body';
    const label = document.createElement('strong');
    label.textContent = item.label;
    const detail = document.createElement('span');
    detail.textContent = item.message;
    body.append(label, detail);
    const time = document.createElement('time');
    time.dateTime = item.time;
    time.textContent = new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    row.append(glyph, body, time);
    activityList.append(row);
  }
}

function applyPetState(state) {
  if (!state || typeof state !== 'object') return;
  lastPetState = state;
  petStatusLabel.textContent = state.label || 'Hanging out';
  petStatusMessage.textContent = state.message || 'Ready for an adventure.';
  petHostStat.textContent = state.hostConnected ? 'Connected' : 'Offline';
  petHostCaption.textContent = state.hostConnected ? 'Desktop pet is responding' : 'Desktop window not connected';
  petHostPill.textContent = state.hostConnected ? 'PET CONNECTED' : 'HOST OFFLINE';
  petHostPill.classList.toggle('host-online', state.hostConnected === true);
  petHostPill.classList.toggle('host-offline', state.hostConnected !== true);
  petVisibilityText.textContent = state.visible === false ? 'Pet is hidden' : 'Pet is visible';
  document.querySelector('#show-pet').disabled = state.visible !== false;
  document.querySelector('#hide-pet').disabled = state.visible === false;
  document.querySelector('#preview-character').classList.remove('preview-idle', 'preview-wave', 'preview-dance', 'preview-sleep', 'preview-run', 'preview-celebrate');
  const animation = ['idle', 'wave', 'dance', 'sleep', 'run', 'celebrate'].includes(state.animation) ? state.animation : 'idle';
  document.querySelector('#preview-character').classList.add(`preview-${animation}`);
  liveRegion.textContent = `Pet state: ${state.label || animation}. ${state.hostConnected ? 'Desktop pet connected.' : 'Desktop pet host offline.'}`;
}

async function refreshRuntime() {
  try {
    const response = await fetch('/api/v1/runtime', { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`Runtime returned HTTP ${response.status}`);
    const runtime = await response.json();
    runtimeState.textContent = runtime.state === 'ready' ? 'Online' : 'Not ready';
    runtimeCaption.textContent = `Process ${runtime.pid} · ${formatUptime(runtime.uptimeSeconds)}`;
    runtimePort.textContent = String(runtime.port);
    applyHostState(runtime.petHost);
    setConnectionState('online', 'Runtime connected');
    lastChecked.textContent = `Last checked ${new Date().toLocaleTimeString()}`;
  } catch {
    runtimeState.textContent = 'Offline';
    runtimeCaption.textContent = 'Start it with “sparkiee start”';
    setConnectionState('offline', 'Runtime unreachable');
    lastChecked.textContent = `Could not reach runtime · ${new Date().toLocaleTimeString()}`;
  }
}

async function refreshPet() {
  try {
    const response = await fetch('/api/v1/pet/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('Pet state unavailable');
    applyPetState(await response.json());
  } catch {
    petHostStat.textContent = 'Unavailable';
    petHostCaption.textContent = 'Start the Sparkiee runtime';
    petHostPill.textContent = 'RUNTIME OFFLINE';
    petHostPill.classList.add('host-offline');
  }
}

async function sendPetCommand(command) {
  if (commandInFlight) return;
  commandInFlight = true;
  for (const button of commandButtons) button.disabled = true;
  commandFeedback.className = 'command-feedback';
  commandFeedback.textContent = `Sending ${command} command…`;
  try {
    const response = await fetch('/api/v1/pet/command', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    applyPetState(result.pet);
    commandFeedback.className = 'command-feedback success';
    commandFeedback.textContent = `Sparkiee: ${result.pet.message}`;
    if (!['show', 'hide'].includes(command)) {
      recordActivity(command, result.pet.label, result.pet.message, result.pet.updatedAt);
    }
  } catch (error) {
    commandFeedback.className = 'command-feedback error';
    commandFeedback.textContent = error.message || 'Could not send the command. Is Sparkiee running?';
  } finally {
    commandInFlight = false;
    for (const button of commandButtons) button.disabled = false;
    if (lastPetState) applyPetState(lastPetState);
  }
}

for (const button of commandButtons) {
  button.addEventListener('click', () => void sendPetCommand(button.dataset.petCommand));
}
retryHostButton.addEventListener('click', () => void retryHostLaunch());

void refreshRuntime();
void refreshPet();
window.setInterval(() => void refreshRuntime(), 5000);
window.setInterval(() => void refreshPet(), 1200);
