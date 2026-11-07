import { createAudioEngine } from './lib/audio-engine.mjs';
import { createCaptionController } from './lib/caption.mjs';
import { describeHearingMeter, describeMicIndicator, hearingBars } from './lib/mic-indicator.mjs';
import { createFramePlayer } from './lib/frame-player.mjs';
import { shouldFallbackChirp, shouldPlayEventChirp, speechCaptionDuration } from './lib/speech-policy.mjs';

const root = document.querySelector('#pet-root');
const spriteEl = document.querySelector('#pet-sprite');
const statusText = document.querySelector('#pet-status');
const captionBox = document.querySelector('#caption-box');
const captionText = document.querySelector('#caption-text');
const connectionDot = document.querySelector('#connection-dot');
const errorText = document.querySelector('#pet-error');
const petButton = document.querySelector('#pet-button');
const taskCollar = document.querySelector('#task-collar');
const taskCollarLabel = document.querySelector('#task-collar-label');
const taskCollarTime = document.querySelector('#task-collar-time');
const dockBadge = document.querySelector('#dock-badge');
let currentState = null;
let currentPack = null;
let pointerStart = null;
let dragged = false;
let lastVoiceAt = null;
let lastAnimation = null;
let lastSpeechId = 0;
let speechElement = null;
let speechReporter = null; // reports the real outcome of the clip now playing
let speechCaptionUntil = 0;
let eventChirpSuppressedAt = 0;

const audio = createAudioEngine();
const caption = createCaptionController({ box: captionBox, text: captionText });
window.addEventListener('pagehide', () => {
  audio.dispose();
  caption.dispose();
});

// ---------------------------------------------------------------------------
// Sprite frame player: the shared frame player (same module the dashboard
// habitat imports) renders the validated character pack onto #pet-sprite.
// ---------------------------------------------------------------------------

const spritePlayer = createFramePlayer({
  element: spriteEl,
  getAnimation: () => currentState?.animation || 'idle',
});

spriteEl.classList.add('loading');

// ---------------------------------------------------------------------------
// Captions: appear beneath the character, synced with voice events. Captions
// keep working when audio is muted.
// ---------------------------------------------------------------------------

function syncCaptionSettings() {
  const captions = currentState?.settings?.captions;
  return caption.setSettings({
    enabled: captions?.enabled !== false,
    durationMs: Number.isInteger(captions?.durationMs)
      ? captions.durationMs
      : (currentPack?.layout?.captionDurationMs ?? undefined),
    large: captions?.large === true,
  });
}

function showCaption(text, { ms = null } = {}) {
  syncCaptionSettings();
  caption.show(text, { ms });
}

async function reactWithVoice(eventId, captionTextValue) {
  if (captionTextValue) showCaption(captionTextValue);
  try {
    await audio.playVoice(eventId);
  } catch {
    // Audio is best-effort; captions and animation already happened.
  }
}

// ---------------------------------------------------------------------------
// Spoken voice: plays a generated clip delivered by the Electron main
// process, keeps the subtitle synced for the whole utterance, and falls
// back to a chirp only where speech failed. Muted mode keeps captions.
// ---------------------------------------------------------------------------

function releaseSpeechAudio() {
  if (!speechElement) return;
  try {
    speechElement.pause();
    speechElement.removeAttribute('src');
  } catch {
    // element may already be released
  }
  speechElement = null;
}

/**
 * Stop whatever clip is playing. A clip cut short is reported honestly: the
 * user did not hear the whole phrase, so the daemon must not assume it did.
 */
function stopSpeechAudio() {
  const report = speechReporter;
  speechReporter = null;
  releaseSpeechAudio();
  if (report) report('skipped', 'stopped-early');
}

/**
 * Tell the daemon what actually happened to the announced clip. This is the
 * only honest playback evidence the app can produce: synthesis success is not
 * playback success. Best-effort — a missing bridge never breaks the pet.
 */
function reportSpeech(id, status, detail = null) {
  try {
    window.sparkieePet?.reportSpeech?.({ id, status, detail });
  } catch {
    // Telemetry only.
  }
}

/**
 * Play a generated clip and report what really happened to it.
 *
 * Two promises, because they answer two different questions:
 *  - `captionDone` resolves with the clip duration once playback has really
 *    started (so the subtitle matches the real speech length), or null when it
 *    never starts.
 *  - `result` resolves when playback has actually finished — which is the only
 *    moment the microphone may open. Reporting at the *start* of a clip would
 *    let the mic transcribe Sparky's own voice.
 *
 * Every failure carries the real reason (NotAllowedError, media-error,
 * not-loaded, stopped-early) instead of a generic "playback failed".
 */
function playSpeechClip(dataUrl, id) {
  releaseSpeechAudio();
  const element = new Audio(dataUrl);
  const volume = currentState?.settings?.audio?.volume;
  element.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.7;
  speechElement = element;
  // Spoken words must not be drowned out by a chirp that is still ringing.
  audio.stopAll();

  let playFailure = null; // DOMException name, when the browser refuses play()
  let reported = false;
  const report = (status, detail) => {
    if (reported) return;
    reported = true;
    if (speechReporter === report) speechReporter = null;
    reportSpeech(id, status, detail);
  };
  speechReporter = report;

  let settleResult = () => {};
  const result = new Promise((resolve) => {
    let settled = false;
    settleResult = (status, detail) => {
      if (settled) return;
      settled = true;
      if (speechElement === element) releaseSpeechAudio();
      report(status, detail);
      resolve({ status, detail });
    };
    element.addEventListener('ended', () => settleResult('played', `${Math.round((element.duration || 0) * 1000)}ms`), { once: true });
    element.addEventListener('error', () => settleResult('failed', playFailure || 'media-error'), { once: true });
  });

  let settleCaption = () => {};
  const captionDone = new Promise((resolve) => {
    let settled = false;
    let watchdog = null;
    const usableDuration = () => (Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null);
    settleCaption = (value) => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) clearTimeout(watchdog);
      resolve(value);
    };
    element.addEventListener('loadedmetadata', () => settleCaption(usableDuration()), { once: true });
    element.addEventListener('playing', () => settleCaption(usableDuration()), { once: true });
    element.addEventListener('error', () => settleCaption(null), { once: true });
    watchdog = setTimeout(() => {
      const duration = usableDuration();
      settleCaption(duration);
      // Never started in time: fail loudly rather than let silence pass as
      // speech. Releasing the element also prevents surprise late audio.
      if (duration === null) settleResult('failed', 'not-loaded');
    }, 3000);
    element.play().catch((error) => {
      playFailure = error?.name || 'play-failed';
      settleCaption(null);
      settleResult('failed', playFailure);
    });
  });

  return { captionDone, result };
}

async function fallbackChirpFor(speech) {
  const packEvents = currentPack?.voiceEvents ?? {};
  const commandMap = currentPack?.commandVoiceEvents ?? {};
  const eventId = (speech.voiceEvent && packEvents[speech.voiceEvent])
    || commandMap[currentState?.animation]
    || null;
  if (!eventId || !packEvents[eventId]) return;
  try {
    await audio.playVoice(eventId);
  } catch {
    // Best-effort.
  }
}

async function handleSpeech(speech) {
  const text = String(speech.text).slice(0, 180);
  syncCaptionSettings();
  const configuredMs = caption.getSettings().durationMs;
  // The subtitle appears the moment the phrase is ready...
  showCaption(text, { ms: configuredMs });
  speechCaptionUntil = Date.now() + configuredMs;

  const audioSettings = currentState?.settings?.audio ?? {};
  const muted = audioSettings.enabled === false;
  if (muted) {
    // Never play when muted — and say so, so the daemon does not mistake a
    // muted caption for audible speech.
    reportSpeech(speech.id, 'muted', 'audio-disabled');
    return;
  }
  if (!speech.dataUrl) {
    // No audio exists at all (generation failed): report the real code.
    reportSpeech(speech.id, 'failed', speech.error || 'no_clip');
    if (shouldFallbackChirp({ ...speech, error: speech.error || 'no_clip' }, { suppressedAt: eventChirpSuppressedAt, now: Date.now() })) {
      await fallbackChirpFor(speech);
    }
    return;
  }
  const playback = playSpeechClip(speech.dataUrl, speech.id);
  const durationSeconds = await playback.captionDone;
  if (durationSeconds !== null) {
    // The subtitle tracks the real speech length (same text: timer only, no
    // flicker). The playback report is delivered by playSpeechClip itself, at
    // the moment the clip really ends.
    const ms = speechCaptionDuration({ audioDurationSeconds: durationSeconds, configuredMs });
    showCaption(text, { ms });
    speechCaptionUntil = Date.now() + ms;
    return;
  }
  // Playback never started (or was refused): the real reason is already
  // reported. Read it so the fallback is honest about what went wrong.
  const outcome = await playback.result;
  // Honest fallback: playback failed, so the chirp returns where it was
  // suppressed, or for an explicit test click.
  if (shouldFallbackChirp({ ...speech, error: speech.error || outcome.detail || 'playback_failed' }, { suppressedAt: eventChirpSuppressedAt, now: Date.now() })) {
    await fallbackChirpFor(speech);
  }
}

// ---------------------------------------------------------------------------
// State application
// ---------------------------------------------------------------------------

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The task collar is driven entirely by the daemon's confirmed task record:
 * a live timer while `active`, then the measured duration and outcome. It
 * never invents a task from an animation or a caption.
 */
function paintTaskCollar(state) {
  if (!taskCollar) return;
  const task = state?.task;
  if (!task || typeof task !== 'object') {
    taskCollar.hidden = true;
    delete taskCollar.dataset.outcome;
    return;
  }
  taskCollar.hidden = false;
  const active = task.active === true;
  if (active) {
    delete taskCollar.dataset.outcome;
    taskCollarLabel.textContent = 'Working';
    const startedAt = Date.parse(task.startedAt ?? '');
    taskCollarTime.textContent = Number.isFinite(startedAt) ? formatElapsed(Date.now() - startedAt) : '0:00';
    return;
  }
  const failed = task.outcome === 'error';
  const idle = task.outcome === 'idle';
  taskCollar.dataset.outcome = failed ? 'error' : idle ? 'idle' : 'success';
  taskCollarLabel.textContent = failed ? 'Snag' : idle ? 'Idle' : 'Done';
  taskCollarTime.textContent = formatElapsed(task.durationMs ?? 0);
}

function applyState(state) {
  if (!state || typeof state !== 'object') return;
  currentState = state;
  statusText.textContent = String(state.label || 'Hanging out').toLowerCase().slice(0, 40);
  connectionDot.classList.toggle('disconnected', state.hostConnected !== true);
  document.querySelector('#pet-name').textContent = String(state.characterName || 'sparkiee').slice(0, 32).toLowerCase();
  if (dockBadge) dockBadge.hidden = state.docked !== true;
  root.dataset.docked = state.docked === true ? 'true' : 'false';
  paintTaskCollar(state);
  if (state.visible === false) {
    root.dataset.hidden = 'true';
    // Hidden pet must not keep talking: stop any clip mid-phrase.
    stopSpeechAudio();
  } else delete root.dataset.hidden;

  if (state.settings?.audio) audio.setSettings(state.settings.audio);

  const animation = currentPack?.animations?.[state.animation] ? state.animation : 'idle';
  if (currentPack) spritePlayer.play(currentPack, preferredAnimation(animation));

  // Default caption follows the state message, but an active spoken phrase
  // keeps the floor until its caption window ends.
  if (Date.now() >= speechCaptionUntil) showCaption(state.message || '');

  // Voice reactions fire when the animation changes or an explicit voice
  // trigger arrives (for example the dashboard test-sound button).
  const packEvents = currentPack?.voiceEvents ?? {};
  const commandMap = currentPack?.commandVoiceEvents ?? {};
  if (state.voice && state.voice.at && state.voice.at !== lastVoiceAt) {
    // Explicit chirp triggers always sound: the user asked for a chirp.
    lastVoiceAt = state.voice.at;
    if (packEvents[state.voice.event]) {
      void reactWithVoice(state.voice.event, packEvents[state.voice.event]?.caption);
    }
  } else if (currentPack && state.animation !== lastAnimation) {
    const eventId = commandMap[state.animation];
    if (eventId && packEvents[eventId]) {
      if (packEvents[eventId]?.caption) showCaption(packEvents[eventId].caption);
      if (shouldPlayEventChirp(currentState)) {
        void audio.playVoice(eventId).catch(() => {});
      } else {
        // Spoken voice carries this reaction; remember the suppression so
        // a failed announcement can restore the chirp.
        eventChirpSuppressedAt = Date.now();
      }
    }
  }
  lastAnimation = state.animation;
}

async function command(name) {
  errorText.textContent = '';
  try {
    applyState(await window.sparkieePet.command(name));
  } catch {
    errorText.textContent = 'Cannot reach Sparkiee right now.';
    errorText.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Pack loading (manifest summary pushed by the Electron main process)
// ---------------------------------------------------------------------------

function applyPack(pack) {
  if (!pack || typeof pack !== 'object' || !pack.sprite || !pack.animations) return;
  currentPack = pack;
  audio.setPack(pack);
  spritePlayer.load(pack);
}
window.sparkieePet.onPack(applyPack);
window.sparkieePet.getPack().then(applyPack).catch(() => {});

// ---------------------------------------------------------------------------
// Assistant phase stream: the mic indicator bubble beside the pet, and
// Escape-to-cancel while the microphone is actually active.
// ---------------------------------------------------------------------------

const micIndicator = document.querySelector('#mic-indicator');
const micIndicatorLabel = document.querySelector('#mic-indicator-label');
const micWave = document.querySelector('#mic-wave');
const micBars = micWave ? Array.from(micWave.querySelectorAll('i')) : [];
let assistantPhase = null;
let hearLevel = 0;

/**
 * The attentive hearing pose is an animation in the character pack (no second
 * pet, no extra window). Packs without it keep their normal state animation
 * instead of faking one; the meter below still reports the real level.
 */
function preferredAnimation(stateAnimation) {
  if (assistantPhase?.state === 'hearing' && assistantPhase.micActive === true
    && currentPack?.animations?.hearing) {
    return 'hearing';
  }
  return stateAnimation;
}

function paintHearingMeter() {
  if (!micBars.length) return;
  const bars = hearingBars(hearLevel);
  for (let i = 0; i < micBars.length; i += 1) {
    micBars[i].style.height = `${bars[i] ?? 2}px`;
  }
}

function updateMicIndicator() {
  if (!micIndicator) return;
  const info = describeMicIndicator({ assistant: assistantPhase });
  micIndicator.hidden = !info.visible;
  micIndicator.dataset.phase = info.phase ?? '';
  micIndicatorLabel.textContent = info.label ?? '';
  const meter = describeHearingMeter({ assistant: assistantPhase });
  if (!meter.visible) hearLevel = 0;
  paintHearingMeter();
}

window.sparkieePet.onAssistant((assistant) => {
  assistantPhase = assistant;
  updateMicIndicator();
  if (currentPack) {
    spritePlayer.play(currentPack, preferredAnimation(currentState?.animation || 'idle'));
  }
});
// Only the derived 0..1 level arrives; the daemon never sends raw audio.
if (typeof window.sparkieePet.onAssistantLevel === 'function') {
  window.sparkieePet.onAssistantLevel(({ level }) => {
    hearLevel = level;
    paintHearingMeter();
  });
}
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // Only when capture is genuinely live; a random Escape press must not
  // cancel unrelated assistant work.
  if (assistantPhase && (assistantPhase.micActive === true
    || assistantPhase.state === 'hearing'
    || assistantPhase.state === 'transcribing' || assistantPhase.state === 'interpreting')) {
    window.sparkieePet.cancelUtterance().catch(() => {});
  }
});
updateMicIndicator();

// ---------------------------------------------------------------------------
// Drag + click interactions
// ---------------------------------------------------------------------------

petButton.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  pointerStart = { x: event.screenX, y: event.screenY, id: event.pointerId };
  dragged = false;
  petButton.setPointerCapture(event.pointerId);
  window.sparkieePet.startDrag({ screenX: event.screenX, screenY: event.screenY });
});
petButton.addEventListener('pointermove', (event) => {
  if (!pointerStart || event.pointerId !== pointerStart.id) return;
  if (Math.abs(event.screenX - pointerStart.x) + Math.abs(event.screenY - pointerStart.y) > 5) dragged = true;
  window.sparkieePet.moveDrag({ screenX: event.screenX, screenY: event.screenY });
});
function finishDrag(event) {
  if (!pointerStart || event.pointerId !== pointerStart.id) return;
  window.sparkieePet.endDrag();
  pointerStart = null;
  window.requestAnimationFrame(() => { dragged = false; });
}
petButton.addEventListener('pointerup', finishDrag);
petButton.addEventListener('pointercancel', finishDrag);
petButton.addEventListener('click', () => {
  if (dragged) return;
  void command('wave');
});

// Unobtrusive hover control: transfer presentation to the dashboard. The
// window hides the moment the daemon records ownership transfer, so the
// button only exists while the desktop surface is live.
const sendDashboardButton = document.querySelector('#send-dashboard');
sendDashboardButton.addEventListener('click', async (event) => {
  event.stopPropagation();
  sendDashboardButton.disabled = true;
  errorText.textContent = '';
  try {
    await window.sparkieePet.sendToDashboard();
  } catch {
    errorText.textContent = 'Could not hand off to the dashboard.';
    errorText.hidden = false;
    sendDashboardButton.disabled = false;
  }
});

window.sparkieePet.onState(applyState);
window.sparkieePet.getState().then(applyState).catch(() => {});
// The task timer is the only thing that changes between state pushes.
window.setInterval(() => {
  if (currentState?.task?.active === true) paintTaskCollar(currentState);
}, 1000);
window.sparkieePet.onSpeech((speech) => {
  // Ignore superseded or duplicate announcements (state re-sends, restarts).
  if (!speech || !Number.isInteger(speech.id) || speech.id <= lastSpeechId) return;
  lastSpeechId = speech.id;
  void handleSpeech(speech);
});
window.addEventListener('pagehide', stopSpeechAudio);
