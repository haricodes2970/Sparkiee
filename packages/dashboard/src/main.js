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
const speedSlider = document.querySelector('#move-speed');
const speedValue = document.querySelector('#move-speed-value');
const autoRoamToggle = document.querySelector('#auto-roam');
const audioEnabledToggle = document.querySelector('#audio-enabled');
const audioVolumeSlider = document.querySelector('#audio-volume');
const audioVolumeValue = document.querySelector('#audio-volume-value');
const testSoundButton = document.querySelector('#test-sound');
const captionsEnabledToggle = document.querySelector('#captions-enabled');
const captionsDurationSlider = document.querySelector('#captions-duration');
const captionsDurationValue = document.querySelector('#captions-duration-value');
const captionsLargeToggle = document.querySelector('#captions-large');
const characterNameEl = document.querySelector('#character-name');
const characterMetaEl = document.querySelector('#character-meta');
const characterPicker = document.querySelector('.character-picker');
const characterSelect = document.querySelector('#character-select');
const activity = [];
let lastPetState = null;
let commandInFlight = false;
let lastHostPhase = null;
let settingsInFlight = false;
let characterPacks = [];

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
  const stage = document.querySelector('.pet-preview-stage');
  if (stage) stage.classList.toggle('host-offline-stage', phase === 'failed' || phase === 'exited');
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
  if (state.settings && document.activeElement !== speedSlider) {
    speedSlider.value = String(state.settings.moveSpeed ?? 1);
  }
  speedValue.textContent = `${speedSlider.value}×`;
  if (state.settings && document.activeElement !== autoRoamToggle) {
    autoRoamToggle.checked = state.settings.autoRoam !== false;
  }
  if (state.settings?.audio) {
    if (document.activeElement !== audioEnabledToggle) audioEnabledToggle.checked = state.settings.audio.enabled !== false;
    if (document.activeElement !== audioVolumeSlider) audioVolumeSlider.value = String(state.settings.audio.volume ?? 0.7);
  }
  audioVolumeValue.textContent = `${Math.round(Number(audioVolumeSlider.value) * 100)}%`;
  if (state.settings?.captions) {
    if (document.activeElement !== captionsEnabledToggle) captionsEnabledToggle.checked = state.settings.captions.enabled !== false;
    if (document.activeElement !== captionsDurationSlider) captionsDurationSlider.value = String(state.settings.captions.durationMs ?? 2600);
    if (document.activeElement !== captionsLargeToggle) captionsLargeToggle.checked = state.settings.captions.large === true;
  }
  captionsDurationValue.textContent = `${(Number(captionsDurationSlider.value) / 1000).toFixed(1)}s`;
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

async function sendSettings(partial, describe) {
  if (settingsInFlight) return;
  settingsInFlight = true;
  commandFeedback.className = 'command-feedback';
  commandFeedback.textContent = 'Saving pet settings…';
  try {
    const response = await fetch('/api/v1/pet/settings', {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(partial),
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    applyPetState(result.pet);
    commandFeedback.className = 'command-feedback success';
    commandFeedback.textContent = describe;
    recordActivity('settings', 'Pet settings updated', describe);
  } catch (error) {
    commandFeedback.className = 'command-feedback error';
    commandFeedback.textContent = error.message || 'Could not save movement settings.';
  } finally {
    settingsInFlight = false;
  }
}

let speedDebounce;
let volumeDebounce;
let captionDurationDebounce;
speedSlider.addEventListener('input', () => { speedValue.textContent = `${speedSlider.value}×`; });
speedSlider.addEventListener('change', () => {
  window.clearTimeout(speedDebounce);
  speedDebounce = window.setTimeout(() => {
    const speed = Number(speedSlider.value);
    void sendSettings({ moveSpeed: speed }, `Movement speed set to ${speed}×.`);
  }, 250);
});
autoRoamToggle.addEventListener('change', () => {
  const enabled = autoRoamToggle.checked;
  void sendSettings({ autoRoam: enabled }, enabled ? 'Auto-roam enabled.' : 'Auto-roam disabled.');
});

audioEnabledToggle.addEventListener('change', () => {
  const enabled = audioEnabledToggle.checked;
  void sendSettings({ audio: { enabled } }, enabled ? 'Voice reactions enabled.' : 'Voice reactions muted (captions keep working).');
});
audioVolumeSlider.addEventListener('input', () => {
  audioVolumeValue.textContent = `${Math.round(Number(audioVolumeSlider.value) * 100)}%`;
});
audioVolumeSlider.addEventListener('change', () => {
  window.clearTimeout(volumeDebounce);
  volumeDebounce = window.setTimeout(() => {
    const volume = Number(audioVolumeSlider.value);
    void sendSettings({ audio: { volume } }, `Voice volume set to ${Math.round(volume * 100)}%.`);
  }, 250);
});
testSoundButton.addEventListener('click', async () => {
  testSoundButton.disabled = true;
  try {
    const response = await fetch('/api/v1/pet/test-sound', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'greet' }),
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    applyPetState(result.pet);
    commandFeedback.className = 'command-feedback success';
    commandFeedback.textContent = audioEnabledToggle.checked
      ? 'Sparkiee said hello — listen for the chirp and watch the caption.'
      : 'Voice is muted, so only the caption appeared. That is the design.';
  } catch (error) {
    commandFeedback.className = 'command-feedback error';
    commandFeedback.textContent = error.message || 'Could not play the test sound.';
  } finally {
    testSoundButton.disabled = false;
  }
});
captionsEnabledToggle.addEventListener('change', () => {
  const enabled = captionsEnabledToggle.checked;
  void sendSettings({ captions: { enabled } }, enabled ? 'Captions enabled.' : 'Captions disabled.');
});
captionsDurationSlider.addEventListener('input', () => {
  captionsDurationValue.textContent = `${(Number(captionsDurationSlider.value) / 1000).toFixed(1)}s`;
});
captionsDurationSlider.addEventListener('change', () => {
  window.clearTimeout(captionDurationDebounce);
  captionDurationDebounce = window.setTimeout(() => {
    const durationMs = Number(captionsDurationSlider.value);
    void sendSettings({ captions: { durationMs } }, `Caption duration set to ${(durationMs / 1000).toFixed(1)}s.`);
  }, 250);
});
captionsLargeToggle.addEventListener('change', () => {
  const large = captionsLargeToggle.checked;
  void sendSettings({ captions: { large } }, large ? 'Larger captions enabled.' : 'Standard caption size restored.');
});
characterSelect.addEventListener('change', () => {
  const characterId = characterSelect.value || null;
  void sendSettings({ characterId }, `Character pack switched to ${characterSelect.selectedOptions[0]?.textContent || characterId}.`);
});

async function refreshCharacter() {
  try {
    const response = await fetch('/api/v1/characters', { cache: 'no-store' });
    if (!response.ok) throw new Error('Character list unavailable');
    const data = await response.json();
    characterPacks = Array.isArray(data.packs) ? data.packs : [];
    const activeId = lastPetState?.settings?.characterId;
    const active = characterPacks.find((pack) => pack.id === activeId) ?? characterPacks[0];
    if (active) {
      characterNameEl.textContent = String(active.name || active.id).toLowerCase();
      const license = active.license?.type ? ` · ${active.license.type}` : '';
      characterMetaEl.textContent = `v${active.version || '1.0.0'}${license} · ${active.animationCount || 13} animations · ${active.voiceStyle === 'clips' ? 'clip voice' : 'synthesized voice'}`;
    } else {
      characterNameEl.textContent = 'no character';
      characterMetaEl.textContent = 'No valid character pack found — check docs/ASSET_CREDITS.md.';
    }
    // Only show the picker when the user actually has more than one pack.
    characterPicker.hidden = characterPacks.length < 2;
    characterSelect.replaceChildren();
    for (const pack of characterPacks) {
      const option = document.createElement('option');
      option.value = pack.id;
      option.textContent = pack.name || pack.id;
      option.selected = pack.id === (activeId ?? characterPacks[0]?.id);
      characterSelect.append(option);
    }
  } catch {
    characterNameEl.textContent = 'sparkiee';
    characterMetaEl.textContent = 'Character info unavailable — is the runtime up?';
  }
}

for (const button of commandButtons) {
  button.addEventListener('click', () => void sendPetCommand(button.dataset.petCommand));
}
retryHostButton.addEventListener('click', () => void retryHostLaunch());

void refreshRuntime();
void refreshPet();
void refreshCharacter();
window.setInterval(() => void refreshRuntime(), 5000);
window.setInterval(() => void refreshPet(), 1200);
window.setInterval(() => void refreshCharacter(), 10_000);
