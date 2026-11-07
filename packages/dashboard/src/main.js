import { createFramePlayer } from '/src/lib/frame-player.mjs';
import { assistantPanelViewModel } from '/src/lib/assistant-panel.mjs';

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
const quietModeToggle = document.querySelector('#quiet-mode');
const overviewTaskState = document.querySelector('#overview-task-state');
const dockStateText = document.querySelector('#dock-state-text');
const dockPetButton = document.querySelector('#dock-pet');
const undockPetButton = document.querySelector('#undock-pet');
const wakePetButton = document.querySelector('#wake-pet');
const audioEnabledToggle = document.querySelector('#audio-enabled');
const audioVolumeSlider = document.querySelector('#audio-volume');
const audioVolumeValue = document.querySelector('#audio-volume-value');
const testSoundButton = document.querySelector('#test-sound');
const captionsEnabledToggle = document.querySelector('#captions-enabled');
const captionsDurationSlider = document.querySelector('#captions-duration');
const captionsDurationValue = document.querySelector('#captions-duration-value');
const captionsLargeToggle = document.querySelector('#captions-large');
const speechEnabledToggle = document.querySelector('#speech-enabled');
const speechStyleSelect = document.querySelector('#speech-style');
const testVoiceButton = document.querySelector('#test-voice');
const voiceProviderDot = document.querySelector('#voice-provider-dot');
const voiceProviderText = document.querySelector('#voice-provider-text');
const voiceFeedback = document.querySelector('#voice-feedback');
// Assistant (microphone, hotkey, wake word, speech recognition).
const assistantDot = document.querySelector('#assistant-dot');
const assistantStateText = document.querySelector('#assistant-state-text');
const assistantHotkeyText = document.querySelector('#assistant-hotkey-text');
const assistantWakeSttText = document.querySelector('#assistant-wake-stt-text');
const assistantChatText = document.querySelector('#assistant-chat-text');
const assistantResetChatButton = document.querySelector('#assistant-reset-chat');
const assistantMicText = document.querySelector('#assistant-mic-text');
const assistantHearingRow = document.querySelector('#assistant-hearing-row');
const assistantHearingBar = document.querySelector('#assistant-hearing-bar');
const assistantHearingBars = assistantHearingBar ? Array.from(assistantHearingBar.querySelectorAll('i')) : [];
const assistantTranscriptText = document.querySelector('#assistant-transcript-text');
const assistantLastActionText = document.querySelector('#assistant-last-action-text');
const assistantPttButton = document.querySelector('#assistant-ptt');
const assistantCancelButton = document.querySelector('#assistant-cancel-utterance');
const assistantTestMicButton = document.querySelector('#assistant-test-mic');
const assistantMicResult = document.querySelector('#assistant-mic-result');
let assistantLastTranscript = '';
const characterNameEl = document.querySelector('#character-name');
const characterMetaEl = document.querySelector('#character-meta');
const characterPicker = document.querySelector('.character-picker');
const characterSelect = document.querySelector('#character-select');
// Habitat: the dashboard renders the *real* character pack here, but only
// while this tab owns presentation (one live surface at a time — in desktop
// mode this stage shows a status message, never a second drawn pet).
const habitatStage = document.querySelector('#habitat-stage');
const habitatBadge = document.querySelector('#habitat-mode-badge');
const habitatEmpty = document.querySelector('#habitat-empty');
const habitatEmptyTitle = document.querySelector('#habitat-empty-title');
const habitatEmptyNote = document.querySelector('#habitat-empty-note');
const habitatSprite = document.querySelector('#habitat-sprite');
const habitatCaption = document.querySelector('#habitat-caption');
const habitatOwnerText = document.querySelector('#habitat-owner-text');
const bringToHabitatButton = document.querySelector('#bring-to-habitat');
const sendToDesktopButton = document.querySelector('#send-to-desktop');
// Overview: mode strip, now-panel and voice card mirror the same live state.
const overviewModeBadge = document.querySelector('#overview-mode-badge');
const overviewModeDetail = document.querySelector('#overview-mode-detail');
const overviewBringButton = document.querySelector('#overview-bring');
const overviewSendButton = document.querySelector('#overview-send');
const overviewAnimation = document.querySelector('#overview-animation');
const overviewCaption = document.querySelector('#overview-caption');
const overviewVoiceState = document.querySelector('#overview-voice-state');
const voiceStat = document.querySelector('#voice-stat');
const voiceStatCaption = document.querySelector('#voice-stat-caption');
const charactersGrid = document.querySelector('#characters-grid');
const settingsPresentationState = document.querySelector('#settings-presentation-state');
const settingsRestoreButton = document.querySelector('#settings-restore-desktop');
const breadcrumbCurrent = document.querySelector('#breadcrumb-current');
const greetingTitle = document.querySelector('#greeting-title');
const activity = [];
let lastPetState = null;
let commandInFlight = false;
let lastHostPhase = null;
let settingsInFlight = false;
let characterPacks = [];
let voiceStatusInFlight = false;
let voiceTestInFlight = false;
// Presentation ownership: one stable session id per browser tab
// (sessionStorage survives a refresh, so a refresh renews the same claim
// instead of creating a second owner).
const PRESENTATION_OWNER_KEY = 'sparkiee.presentationOwner';
function resolvePresentationOwner() {
  try {
    const existing = sessionStorage.getItem(PRESENTATION_OWNER_KEY);
    if (existing) return existing;
    const fresh = globalThis.crypto?.randomUUID?.()
      ?? `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(PRESENTATION_OWNER_KEY, fresh);
    return fresh;
  } catch {
    // Storage blocked: per-load owner (lease renewal still keeps it alive).
    return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
const presentationOwner = resolvePresentationOwner();
let habitatMode = null;          // desktop | claiming | owned | other-tab
let habitatPack = null;
let habitatPlayer = null;
let habitatOwnedSince = 0;        // epoch ms — caption replay guard
let lastHabitatSpeechId = 0;
let presentationInFlight = false;
let captionHideTimer = null;

const SPEECH_ERROR_TEXT = {
  not_configured: 'The local voice is not set up — run “sparkiee voice setup”. Original chirps are in use meanwhile.',
  not_installed: 'Piper is not installed — run “sparkiee voice setup”.',
  setup_required: 'Piper is not installed — run “sparkiee voice setup”.',
  voice_missing: 'A voice model is missing — run “sparkiee voice setup”.',
  validation: 'The local voice rejected that phrase.',
  timeout: 'The local voice took too long to answer.',
  network: 'The local voice could not run.',
  failed: 'The local voice failed while synthesising that phrase.',
  provider: 'The local voice returned something unexpected.',
};

function speechErrorText(code) {
  return SPEECH_ERROR_TEXT[code] ?? SPEECH_ERROR_TEXT.provider;
}

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

// ---------------------------------------------------------------------------
// Presentation ownership: this tab renders the live pet ONLY while it owns
// the claim (state.presentation). Desktop mode shows a status message — never
// a second drawn character. The claim renews on every poll; the daemon's
// bounded lease restores the desktop when this tab dies (no unload reliance).
// ---------------------------------------------------------------------------

async function loadHabitatPack(characterId) {
  try {
    const response = await fetch(`/api/v1/characters/${encodeURIComponent(characterId)}/pack`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const pack = payload?.pack;
    if (!pack?.sprite || !pack?.animations) throw new Error('Malformed character pack');
    habitatPack = pack;
    if (!habitatPlayer) {
      habitatPlayer = createFramePlayer({
        element: habitatSprite,
        getAnimation: () => lastPetState?.animation || 'idle',
      });
    }
    habitatPlayer.load(pack);
    habitatSprite.setAttribute('aria-label', `${pack.name} sprite`);
    return pack;
  } catch {
    habitatPack = null;
    if (habitatMode === 'owned') {
      habitatEmpty.hidden = false;
      habitatEmptyTitle.textContent = 'Sprite preview unavailable.';
      habitatEmptyNote.textContent = 'The character pack could not be loaded from the local runtime. Emotes and status still work.';
    }
    return null;
  }
}

function clearHabitatCaption() {
  if (captionHideTimer) window.clearTimeout(captionHideTimer);
  captionHideTimer = null;
  habitatCaption.hidden = true;
}

function setHabitatMode(next) {
  if (habitatMode === next) return;
  const previous = habitatMode;
  habitatMode = next;
  const owned = next === 'owned';
  habitatSprite.hidden = !owned;
  habitatEmpty.hidden = owned;
  habitatCaption.hidden = !owned;
  for (const button of bringButtons) button.disabled = next !== 'desktop';
  for (const button of sendButtons) button.disabled = !owned;
  if (!owned) clearHabitatCaption();
  if (next === 'owned') {
    habitatBadge.textContent = 'DASHBOARD MODE · this tab has Sparky';
    habitatOwnerText.textContent = 'Presentation: this dashboard tab';
    overviewModeBadge.textContent = 'DASHBOARD MODE';
    overviewModeDetail.textContent = 'This dashboard tab shows the live pet — the native window is hidden.';
    settingsPresentationState.textContent = 'Mode: dashboard — this tab shows the live pet; the desktop window is hidden.';
    if (previous !== 'owned') {
      recordActivity('presentation', 'Sparky arrived in the dashboard', 'This tab now owns the live pet.');
    }
    return;
  }
  if (next === 'desktop') {
    habitatBadge.textContent = 'DESKTOP MODE · live pet on your desktop';
    habitatEmptyTitle.textContent = 'Sparky is wandering on your desktop.';
    habitatEmptyNote.textContent = 'This panel never draws a second pet — bring Sparky here for the live sprite.';
    habitatOwnerText.textContent = 'Presentation: desktop window';
    overviewModeBadge.textContent = 'DESKTOP MODE';
    overviewModeDetail.textContent = 'Sparky is in the native desktop window. Bring her here to render the live sprite in this tab.';
    settingsPresentationState.textContent = 'Mode: desktop — Sparky lives in the native window. The dashboard shows status only.';
    if (previous !== null && previous !== 'desktop') {
      recordActivity('presentation', 'Sparky returned to your desktop', 'The native window shows the live pet again.');
    }
    return;
  }
  if (next === 'claiming') {
    habitatBadge.textContent = 'HANDING OVER · claiming Sparky…';
    habitatEmptyTitle.textContent = 'Receiving Sparky…';
    habitatEmptyNote.textContent = 'This tab is claiming presentation ownership from the runtime.';
    habitatOwnerText.textContent = 'Presentation: claiming…';
    overviewModeBadge.textContent = 'HANDING OVER…';
    overviewModeDetail.textContent = 'Claiming presentation ownership for this tab.';
    settingsPresentationState.textContent = 'Mode: handing over — this tab is claiming the pet from the runtime.';
    return;
  }
  // 'other-tab'
  habitatBadge.textContent = 'DASHBOARD MODE · another tab has Sparky';
  habitatEmptyTitle.textContent = 'Another dashboard tab has Sparky.';
  habitatEmptyNote.textContent = 'Only one tab shows the live pet. When that tab closes, this one takes over (or Sparky returns to your desktop).';
  habitatOwnerText.textContent = 'Presentation: another dashboard tab';
  overviewModeBadge.textContent = 'ANOTHER TAB';
  overviewModeDetail.textContent = 'A different dashboard tab shows the live pet. This tab takes over once that lease ends.';
  settingsPresentationState.textContent = 'Mode: dashboard — another tab currently shows the live pet.';
}

async function claimPresentation() {
  if (presentationInFlight) return;
  setHabitatMode('claiming');
  presentationInFlight = true;
  try {
    const response = await fetch('/api/v1/presentation/claim', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ owner: presentationOwner }),
      cache: 'no-store',
    });
    const result = await response.json().catch(() => null);
    if (response.ok && result?.pet) {
      applyPetState(result.pet);
    } else if (response.status === 409) {
      setHabitatMode('other-tab');
    } else {
      setHabitatMode('desktop');
      habitatEmptyNote.textContent = `Could not take Sparky: ${result?.error || `HTTP ${response.status}`}.`;
    }
  } catch (error) {
    setHabitatMode('desktop');
    habitatEmptyNote.textContent = `Could not reach the local runtime: ${error.message}.`;
  } finally {
    presentationInFlight = false;
  }
}

async function renewPresentation() {
  // Renewal: same owner, same claim — extends the lease without churn.
  if (presentationInFlight) return;
  presentationInFlight = true;
  try {
    const response = await fetch('/api/v1/presentation/claim', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ owner: presentationOwner }),
      cache: 'no-store',
    });
    if (response.status === 409) {
      const result = await response.json().catch(() => null);
      if (result?.pet) applyPetState(result.pet);
      setHabitatMode('other-tab');
    } else if (!response.ok) {
      // Lease kept by the server until it expires — keep polling honestly.
      habitatOwnerText.textContent = `Presentation: renew failed (HTTP ${response.status})`;
    }
  } catch {
    // Runtime briefly unreachable: the bounded lease covers a few polls.
    habitatOwnerText.textContent = 'Presentation: renew pending (runtime unreachable)';
  } finally {
    presentationInFlight = false;
  }
}

function renderHabitatCaption(state) {
  const speech = state?.speech;
  if (!speech || typeof speech.id !== 'number') return;
  if (speech.id === lastHabitatSpeechId) return;
  const speechAt = Date.parse(speech.at || '') || 0;
  if (speechAt < habitatOwnedSince) {
    // Claimed after this phrase already played (takeover/refresh): no replay.
    lastHabitatSpeechId = speech.id;
    return;
  }
  lastHabitatSpeechId = speech.id;
  if (state.settings?.captions?.enabled === false) return;
  habitatCaption.textContent = speech.text;
  habitatCaption.classList.toggle('caption-large', state.settings?.captions?.large === true);
  habitatCaption.hidden = false;
  if (captionHideTimer) window.clearTimeout(captionHideTimer);
  const duration = Number(state.settings?.captions?.durationMs) || 2600;
  captionHideTimer = window.setTimeout(() => { habitatCaption.hidden = true; }, duration);
}

function applyPresentation(presentation) {
  const mode = presentation?.mode === 'dashboard' ? 'dashboard' : 'desktop';
  const now = Date.now();
  const leaseValid = Boolean(presentation?.leaseExpiresAt) && Date.parse(presentation.leaseExpiresAt) > now;
  const owner = presentation?.owner ?? null;
  if (mode === 'desktop') {
    setHabitatMode('desktop');
    return;
  }
  if (owner === null) {
    // A pending transfer (desktop sent Sparky over, or hide/lifecycle): this
    // open tab receives it. If several tabs race, exactly one claim wins.
    void claimPresentation();
    return;
  }
  if (owner === presentationOwner && leaseValid) {
    if (habitatMode !== 'owned') habitatOwnedSince = now;
    setHabitatMode('owned');
    return;
  }
  // Another tab's unexpired claim (or a just-expired one awaiting the
  // daemon's ticker): show the honest notice and keep polling.
  setHabitatMode('other-tab');
}

// Both surfaces (Overview mode strip + Sparky presentation panel) drive the
// same claim/release flow — one source of truth, no duplicated logic.
const bringButtons = [bringToHabitatButton, overviewBringButton];
const sendButtons = [sendToDesktopButton, overviewSendButton];
for (const button of bringButtons) {
  button.addEventListener('click', () => void claimPresentation());
}

async function releasePresentation() {
  for (const button of sendButtons) button.disabled = true;
  try {
    const response = await fetch('/api/v1/presentation/release', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ owner: presentationOwner }),
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
    applyPetState(result.pet);
  } catch (error) {
    commandFeedback.className = 'command-feedback error';
    commandFeedback.textContent = error.message || 'Could not hand Sparky back to the desktop.';
    if (lastPetState) applyPetState(lastPetState); // re-sync button states
  }
}
for (const button of sendButtons) {
  button.addEventListener('click', () => void releasePresentation());
}

settingsRestoreButton.addEventListener('click', async () => {
  settingsRestoreButton.disabled = true;
  try {
    // Force restore: no owner check — this is the "give me my window back"
    // escape hatch, equivalent to the pet host's own transfer path.
    const response = await fetch('/api/v1/presentation/to-desktop', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
    if (result?.pet) applyPetState(result.pet);
    settingsPresentationState.textContent = 'Restored — Sparky is back on the desktop window.';
  } catch (error) {
    settingsPresentationState.textContent = `Restore failed: ${error.message}`;
  } finally {
    settingsRestoreButton.disabled = false;
  }
});

function formatTaskTime(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function describeTask(task) {
  if (!task || typeof task !== 'object') return 'No task tracked yet';
  if (task.active === true) {
    const startedAt = Date.parse(task.startedAt ?? '');
    return `OpenCode task running — ${Number.isFinite(startedAt) ? formatTaskTime(Date.now() - startedAt) : '0:00'}`;
  }
  if (task.outcome === 'success') return `Last task completed in ${formatTaskTime(task.durationMs)}`;
  if (task.outcome === 'error') return 'Last task failed — check OpenCode';
  if (task.outcome === 'idle') return 'Last task went idle without a confirmed result';
  return 'No task tracked yet';
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
  if (state.settings && document.activeElement !== quietModeToggle && quietModeToggle) {
    quietModeToggle.checked = state.settings.quiet === true;
  }
  const docked = state.docked === true;
  if (dockStateText) dockStateText.textContent = docked ? 'Dock: OpenCode chatbox' : 'Dock: desktop';
  if (dockPetButton) dockPetButton.disabled = docked;
  if (undockPetButton) undockPetButton.disabled = !docked;
  if (wakePetButton) wakePetButton.disabled = !docked;
  if (overviewTaskState) overviewTaskState.textContent = describeTask(state.task);
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
  if (state.settings?.speech) {
    if (document.activeElement !== speechEnabledToggle) speechEnabledToggle.checked = state.settings.speech.enabled !== false;
    if (document.activeElement !== speechStyleSelect) speechStyleSelect.value = ['speech', 'chirps', 'both'].includes(state.settings.speech.style) ? state.settings.speech.style : 'speech';
  }
  renderSpeechStatus(state);
  // Overview "right now" mirrors: latest animation + caption (status text,
  // same on every surface — ownership only gates the live sprite).
  overviewAnimation.textContent = state.label || 'Hanging out';
  overviewCaption.textContent = state.speech?.text
    ? (state.speech.error
        ? `${state.speech.text} — voice failed: ${speechErrorText(state.speech.error)}`
        : state.speech.text)
    : 'No caption yet — Sparky is saving her voice.';
  // Presentation decides what this tab draws: real sprite only while owned.
  applyPresentation(state.presentation ?? null);
  if ((!habitatPack || habitatPack.id !== state.characterId) && state.characterId) {
    void loadHabitatPack(state.characterId);
  }
  if (habitatMode === 'owned' && habitatPack && habitatPlayer) {
    const animation = habitatPack.animations?.[state.animation] ? state.animation : 'idle';
    habitatPlayer.play(habitatPack, animation);
    renderHabitatCaption(state);
  }
  liveRegion.textContent = `Pet state: ${state.label || state.animation}. ${state.hostConnected ? 'Desktop pet connected.' : 'Desktop pet host offline.'}`;
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
    const state = await response.json();
    applyPetState(state);
    // While this tab owns the pet, renew the claim every poll — the lease
    // stays far ahead of the ticker and a closed tab expires on its own.
    if (habitatMode === 'owned') void renewPresentation();
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
if (quietModeToggle) {
  quietModeToggle.addEventListener('change', () => {
    const enabled = quietModeToggle.checked;
    void sendSettings({ quiet: enabled }, enabled
      ? 'Quiet mode on — the task timer still runs, reactions stay silent.'
      : 'Quiet mode off — agent events animate and speak again.');
  });
}

async function setDock(docked) {
  if (dockPetButton) dockPetButton.disabled = true;
  if (undockPetButton) undockPetButton.disabled = true;
  commandFeedback.className = 'command-feedback';
  commandFeedback.textContent = docked ? 'Docking Sparky on the OpenCode chatbox…' : 'Returning Sparky to the desktop…';
  try {
    const response = await fetch('/api/v1/pet/dock', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ docked }),
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    applyPetState(result.pet);
    commandFeedback.className = 'command-feedback success';
    commandFeedback.textContent = docked
      ? 'Sparky is napping on the chatbox — drag the sleeping pet to fine-tune the spot.'
      : 'Sparky is back on the desktop.';
    recordActivity(docked ? 'dock' : 'undock', result.pet.label, result.pet.message, result.pet.updatedAt);
  } catch (error) {
    commandFeedback.className = 'command-feedback error';
    commandFeedback.textContent = error.message || 'Could not change the dock state.';
  }
}
dockPetButton?.addEventListener('click', () => void setDock(true));
undockPetButton?.addEventListener('click', () => void setDock(false));
wakePetButton?.addEventListener('click', () => void sendPetCommand('wake'));

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

// ---------------------------------------------------------------------------
// Spoken voice (local Piper): engine status, style controls, and an honest
// test action. Everything runs on this machine; this browser only reads the
// daemon's sanitized status and asks the daemon to speak.
// ---------------------------------------------------------------------------

function renderSpeechStatus(state) {
  if (!voiceFeedback) return;
  const speech = state?.speech;
  if (!speech) {
    if (!voiceFeedback.dataset.locked) voiceFeedback.textContent = '';
    return;
  }
  if (voiceFeedback.dataset.locked === 'true') return; // a test result is being shown
  if (speech.error) {
    voiceFeedback.textContent = `Last speech failed: ${speechErrorText(speech.error)} The caption still appeared under Sparky.`;
  } else {
    voiceFeedback.textContent = `Last spoken phrase: “${String(speech.text).slice(0, 80)}”`;
  }
}

async function refreshVoiceStatus() {
  if (voiceStatusInFlight) return;
  voiceStatusInFlight = true;
  try {
    const response = await fetch('/api/v1/voice/status', { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const voice = payload.voice ?? {};
    if (voice.configured) {
      voiceProviderDot.classList.add('voice-provider-ready');
      const voiceLabel = voice.voices?.hi ? 'Hindi + English' : 'local';
      voiceProviderText.textContent = `Piper ready · ${voiceLabel} · ${voice.cacheFiles ?? 0} clips cached`;
      voiceStat.textContent = 'Piper ready';
      voiceStatCaption.textContent = `${voiceLabel} · local, free`;
      overviewVoiceState.textContent = `Piper ready · ${voice.cacheFiles ?? 0} clips cached`;
    } else {
      voiceProviderDot.classList.remove('voice-provider-ready');
      voiceProviderText.textContent = 'Piper not installed — original chirps in use. Run “sparkiee voice setup”.';
      voiceStat.textContent = 'Original chirps';
      voiceStatCaption.textContent = 'No local voice — run “sparkiee voice setup”';
      overviewVoiceState.textContent = 'Piper not installed — original chirps in use.';
    }
    if (voice.lastError) {
      voiceProviderDot.classList.remove('voice-provider-ready');
      voiceProviderDot.classList.add('voice-provider-error');
      voiceProviderText.textContent += ` · ${speechErrorText(voice.lastError)}`;
      voiceStat.textContent = 'Voice error';
      voiceStatCaption.textContent = speechErrorText(voice.lastError);
      overviewVoiceState.textContent = `Last speech failed: ${speechErrorText(voice.lastError)}`;
    } else {
      voiceProviderDot.classList.remove('voice-provider-error');
    }
    // The espeak fallback is a separate readiness fact: a caption is not speech,
    // and "Piper missing" must not read as "Sparky cannot talk".
    const localReady = voice.localFallback?.available === true;
    const localName = voice.localFallback?.binary || 'espeak-ng';
    if (!voice.configured && localReady) {
      voiceProviderDot.classList.add('voice-provider-ready');
      voiceProviderText.textContent = `No cloud key — speaking with the local fallback (${localName}).`;
      voiceStat.textContent = 'Local voice ready';
      voiceStatCaption.textContent = `Local fallback: ${localName}`;
      overviewVoiceState.textContent = `Local voice ready (${localName}) — no cloud key needed.`;
    } else if (voice.configured && localReady) {
      voiceProviderText.textContent += ` · local fallback ${localName} ready`;
    } else if (!voice.configured && !localReady && !voice.lastError) {
      voiceProviderText.textContent = 'Not configured — install espeak-ng for local speech, or run “sparkiee voice setup”.';
    }
    // Honest playback evidence: bytes synthesised is not audio the user heard.
    const playback = voice.lastPlayback;
    if (playback && playback.status === 'failed') {
      voiceProviderDot.classList.remove('voice-provider-ready');
      voiceProviderDot.classList.add('voice-provider-error');
      voiceStat.textContent = 'Playback failed';
      voiceStatCaption.textContent = `The last clip did not play (${playback.detail ?? 'unknown'}).`;
      overviewVoiceState.textContent = 'Last spoken clip did not play — check the audio output device.';
    }
    if (Array.isArray(payload.warnings) && payload.warnings.length > 0 && !voiceFeedback.dataset.locked) {
      voiceFeedback.textContent = payload.warnings[0];
    }
  } catch {
    voiceProviderText.textContent = 'Voice status unavailable — is the runtime up?';
    voiceStat.textContent = 'Unavailable';
    voiceStatCaption.textContent = 'Could not reach the local runtime';
    overviewVoiceState.textContent = 'Voice status unavailable — is the runtime up?';
  } finally {
    voiceStatusInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Assistant panel: honest voice-assistant status and one live surface of
// controls. The view-model keeps every label truthful — needs-setup rows say
// so, unregistered hotkeys say why, and unknown states show the raw word
// instead of a friendly lie.
// ---------------------------------------------------------------------------

let assistantInFlight = false;
let assistantTestMicInFlight = false;

function applyAssistantState(vm) {
  if (!vm || typeof vm !== 'object') return;
  const busy = vm.busy === true;
  const failed = vm.state === 'error' || vm.lastError !== '';
  assistantDot.classList.toggle('voice-provider-ready', busy);
  assistantDot.classList.toggle('voice-provider-error', failed);
  assistantStateText.textContent = vm.stateLabel;
  assistantHotkeyText.textContent = `Hotkey — ${vm.hotkeyLabel}`;
  assistantWakeSttText.textContent = `Wake word: ${vm.wakeLabel} · Speech recognition: ${vm.sttLabel}`;
  if (assistantChatText) {
    const history = vm.conversationHistory > 0 ? ` · ${vm.conversationHistory} message(s) remembered` : '';
    const error = vm.chatError ? ` · last error: ${vm.chatError}` : '';
    assistantChatText.textContent = `Chat assistant: ${vm.conversationLabel}${history}${error}`;
  }
  assistantMicText.textContent = `Microphone — ${vm.micLabel}`;
  // Hearing meter: pixel-styled bars driven by the backend's real 0..1 level.
  // Only visible while the assistant is genuinely hearing (capture live + state).
  const hearing = vm.hearLevel > 0 && vm.state === 'hearing';
  if (assistantHearingRow) assistantHearingRow.hidden = !hearing;
  if (hearing && assistantHearingBars.length) {
    const bars = [0.55, 1, 0.72, 0.9].map((w) => Math.round(2 + vm.hearLevel * w * 8));
    for (let i = 0; i < assistantHearingBars.length; i += 1) {
      assistantHearingBars[i].style.height = `${bars[i] ?? 2}px`;
    }
  }
  if (vm.transcript) {
    assistantTranscriptText.textContent = `Heard: ${vm.transcript}`;
  } else {
    assistantTranscriptText.textContent = '';
  }
  const lastAction = vm.lastError
    ? `Error: ${vm.lastError}`
    : (vm.lastActionLabel || 'No assistant actions yet this session.');
  assistantLastActionText.textContent = lastAction;
  assistantPttButton.disabled = !vm.startEnabled && !busy;
  assistantCancelButton.disabled = vm.cancelEnabled !== true;
  const stopLabel = vm.state === 'listening' || busy ? 'Stop listening' : 'Hold a voice command';
  assistantPttButton.lastChild.textContent = stopLabel;
  assistantLastTranscript = vm.transcript || assistantLastTranscript;
}

async function refreshAssistant() {
  if (assistantInFlight) return;
  assistantInFlight = true;
  try {
    const response = await fetch('/api/v1/assistant/status', { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const assistant = payload.assistant ?? payload ?? {};
    // The daemon nests STT inside the assistant snapshot; the view-model
    // takes it at the top level — lift it instead of pretending "unknown".
    applyAssistantState(assistantPanelViewModel({ assistant, stt: assistant.stt ?? null }));
  } catch {
    assistantDot.classList.remove('voice-provider-ready');
    assistantDot.classList.add('voice-provider-error');
    assistantStateText.textContent = 'Status unavailable';
    assistantHotkeyText.textContent = 'Hotkey — unknown';
    assistantWakeSttText.textContent = 'Wake word: unknown · Speech recognition: unknown';
    if (assistantChatText) assistantChatText.textContent = 'Chat assistant: unknown';
    assistantMicText.textContent = 'Microphone — unknown';
    assistantLastActionText.textContent = 'Assistant status unavailable — is the runtime up?';
    assistantLastTranscript = '';
  } finally {
    assistantInFlight = false;
  }
}

async function sendAssistantToggle() {
  if (assistantPttButton.disabled) return;
  assistantPttButton.disabled = true;
  assistantStateText.textContent = assistantLastTranscript ? 'Working it out…' : 'Starting mic…';
  try {
    const response = await fetch('/api/v1/assistant/ptt/toggle', {
      method: 'POST',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const assistant = result.assistant ?? {};
    applyAssistantState(assistantPanelViewModel({ assistant, stt: assistant.stt ?? null }));
  } catch (error) {
    assistantMicResult.textContent = `Could not toggle the microphone: ${error.message}`;
    void refreshAssistant();
  }
}

async function sendAssistantCancel() {
  if (assistantCancelButton.disabled) return;
  assistantCancelButton.disabled = true;
  try {
    const response = await fetch('/api/v1/assistant/ptt/cancel', {
      method: 'POST',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    assistantMicResult.textContent = 'Capture cancelled — the utterance was discarded, nothing was sent.';
  } catch (error) {
    assistantMicResult.textContent = `Could not cancel capture: ${error.message}`;
  } finally {
    void refreshAssistant();
  }
}

async function sendAssistantTestMic() {
  if (assistantTestMicInFlight) return;
  assistantTestMicInFlight = true;
  assistantTestMicButton.disabled = true;
  assistantMicResult.textContent = 'Testing the microphone for ~3 seconds…';
  try {
    const response = await fetch('/api/v1/assistant/mic/diagnose', {
      method: 'POST',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const mic = result.mic ?? {};
    assistantMicResult.textContent = mic.detail
      ? String(mic.detail).slice(0, 200)
      : (mic.ok === true ? 'Microphone is working.' : 'Microphone test did not confirm capture.');
  } catch (error) {
    assistantMicResult.textContent = `Microphone test failed: ${error.message}`;
  } finally {
    window.setTimeout(() => {
      assistantTestMicInFlight = false;
      assistantTestMicButton.disabled = false;
    }, 2000);
    void refreshAssistant();
  }
}

assistantPttButton.addEventListener('click', () => { void sendAssistantToggle(); });
assistantCancelButton.addEventListener('click', () => { void sendAssistantCancel(); });
assistantTestMicButton.addEventListener('click', () => { void sendAssistantTestMic(); });
if (assistantResetChatButton) {
  assistantResetChatButton.addEventListener('click', () => { void sendAssistantResetConversation(); });
}

async function sendAssistantResetConversation() {
  assistantResetChatButton.disabled = true;
  try {
    const response = await fetch('/api/v1/assistant/conversation/reset', {
      method: 'POST',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    assistantMicResult.textContent = `Conversation reset — ${result.cleared ?? 0} stored message(s) forgotten.`;
  } catch (error) {
    assistantMicResult.textContent = `Could not reset the conversation: ${error.message}`;
  } finally {
    assistantResetChatButton.disabled = false;
    void refreshAssistant();
  }
}


speechEnabledToggle.addEventListener('change', () => {
  const enabled = speechEnabledToggle.checked;
  void sendSettings({ speech: { enabled } }, enabled ? 'Spoken reactions enabled.' : 'Spoken reactions disabled — chirps carry the reactions.');
});
speechStyleSelect.addEventListener('change', () => {
  const style = speechStyleSelect.value;
  void sendSettings({ speech: { style } }, `Sound style set to ${speechStyleSelect.selectedOptions[0]?.textContent || style}.`);
});
testVoiceButton.addEventListener('click', async () => {
  // Debounce: one request at a time, server enforces the real rate limit.
  if (voiceTestInFlight) return;
  voiceTestInFlight = true;
  testVoiceButton.disabled = true;
  voiceFeedback.dataset.locked = 'true';
  voiceFeedback.textContent = 'Asking the local voice for a test phrase…';
  try {
    const response = await fetch('/api/v1/voice/test', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    const result = await response.json();
    if (response.status === 429) throw new Error(result.error || 'Too many test requests — wait a few seconds.');
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (result.generated) {
      voiceFeedback.textContent = `Sparky is speaking: “${result.speech.text}” — listen on your desktop; the caption appears even when muted.`;
    } else {
      voiceFeedback.textContent = `Could not generate speech: ${speechErrorText(result.speech?.error)} The desktop caption still showed the phrase.`;
    }
  } catch (error) {
    voiceFeedback.textContent = error.message || 'Voice test failed. Is the runtime up?';
  } finally {
    voiceTestInFlight = false;
    testVoiceButton.disabled = false;
    window.setTimeout(() => {
      voiceFeedback.dataset.locked = 'false';
      void refreshVoiceStatus();
      if (lastPetState) renderSpeechStatus(lastPetState);
    }, 6000);
  }
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
    renderCharacterCards(activeId ?? characterPacks[0]?.id);
  } catch {
    characterNameEl.textContent = 'sparkiee';
    characterMetaEl.textContent = 'Character info unavailable — is the runtime up?';
    if (charactersGrid) {
      charactersGrid.replaceChildren();
      const error = document.createElement('div');
      error.className = 'activity-empty';
      error.textContent = 'Character packs unavailable — is the runtime up?';
      charactersGrid.append(error);
    }
  }
}

// Characters view: browse every discovered pack and activate one. Real data
// straight from the validated manifests — never hardcoded art.
function renderCharacterCards(activeId) {
  if (!charactersGrid) return;
  charactersGrid.replaceChildren();
  if (characterPacks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'activity-empty';
    empty.textContent = 'No valid character pack found — check docs/ASSET_CREDITS.md.';
    charactersGrid.append(empty);
    return;
  }
  for (const pack of characterPacks) {
    const card = document.createElement('article');
    card.className = 'character-pack-card';
    if (pack.id === activeId) card.classList.add('pack-active');
    const top = document.createElement('div');
    top.className = 'pack-card-top';
    const name = document.createElement('strong');
    name.textContent = pack.name || pack.id;
    top.append(name);
    if (pack.id === activeId) {
      const tag = document.createElement('span');
      tag.className = 'pack-active-tag';
      tag.textContent = 'ACTIVE';
      top.append(tag);
    }
    const description = document.createElement('p');
    description.textContent = pack.description || 'No description in the manifest.';
    const meta = document.createElement('div');
    meta.className = 'pack-meta';
    const license = pack.license?.type ? ` · ${pack.license.type}` : '';
    meta.textContent = `v${pack.version || '1.0.0'}${license} · ${pack.animationCount || 13} animations · ${pack.voiceStyle === 'clips' ? 'clip voice' : 'synthesized voice'}`;
    card.append(top, description, meta);
    if (pack.id !== activeId) {
      const activate = document.createElement('button');
      activate.type = 'button';
      activate.className = 'secondary-action';
      activate.textContent = 'Make active';
      activate.addEventListener('click', () => {
        activate.disabled = true;
        void sendSettings({ characterId: pack.id }, `Character pack switched to ${pack.name || pack.id}.`)
          .finally(() => {
            characterSelect.value = pack.id;
            void refreshCharacter();
          });
      });
      card.append(activate);
    }
    charactersGrid.append(card);
  }
}

for (const button of commandButtons) {
  button.addEventListener('click', () => void sendPetCommand(button.dataset.petCommand));
}
retryHostButton.addEventListener('click', () => void retryHostLaunch());

// ---------------------------------------------------------------------------
// View router: hash-based sidebar navigation. The nav items are plain links,
// so keyboard navigation, focus and back/forward come for free. Unknown
// hashes (old bookmarks like #pet-controls) fall back to Overview.
// ---------------------------------------------------------------------------

const VIEW_TITLES = { overview: 'Overview', sparky: 'Sparky', characters: 'Characters', settings: 'Settings' };
const viewSections = document.querySelectorAll('[data-view]');
const viewLinks = document.querySelectorAll('[data-view-link]');

function showView(name) {
  const view = name in VIEW_TITLES ? name : 'overview';
  for (const section of viewSections) section.hidden = section.dataset.view !== view;
  for (const link of viewLinks) {
    const active = link.dataset.viewLink === view;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  breadcrumbCurrent.textContent = VIEW_TITLES[view];
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function viewFromHash() {
  return decodeURIComponent(window.location.hash.replace(/^#/, '')) || 'overview';
}

window.addEventListener('hashchange', () => showView(viewFromHash()));
showView(viewFromHash());

{
  const hour = new Date().getHours();
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  greetingTitle.textContent = `Good ${part}, Sparky.`;
}

void refreshRuntime();
void refreshPet();
void refreshCharacter();
void refreshVoiceStatus();
void refreshAssistant();
window.setInterval(() => void refreshRuntime(), 5000);
window.setInterval(() => void refreshPet(), 1200);
window.setInterval(() => void refreshCharacter(), 10_000);
window.setInterval(() => void refreshVoiceStatus(), 30_000);
window.setInterval(() => void refreshAssistant(), 1500);
