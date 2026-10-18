import { createAudioEngine } from './lib/audio-engine.mjs';
import { createCaptionController } from './lib/caption.mjs';
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
let currentState = null;
let currentPack = null;
let pointerStart = null;
let dragged = false;
let lastVoiceAt = null;
let lastAnimation = null;
let lastSpeechId = 0;
let speechElement = null;
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

function stopSpeechAudio() {
  if (!speechElement) return;
  try {
    speechElement.pause();
    speechElement.removeAttribute('src');
  } catch {
    // element may already be released
  }
  speechElement = null;
}

function playSpeechClip(dataUrl) {
  stopSpeechAudio();
  const element = new Audio(dataUrl);
  const volume = currentState?.settings?.audio?.volume;
  element.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.7;
  speechElement = element;
  // Spoken words must not be drowned out by a chirp that is still ringing.
  audio.stopAll();
  return new Promise((resolve) => {
    let settled = false;
    let watchdog = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) clearTimeout(watchdog);
      resolve(value);
    };
    element.addEventListener(
      'loadedmetadata',
      () => finish(Number.isFinite(element.duration) ? element.duration : null),
      { once: true },
    );
    element.addEventListener('error', () => finish(null), { once: true });
    watchdog = setTimeout(() => finish(Number.isFinite(element.duration) ? element.duration : null), 900);
    element.play().catch(() => finish(null));
  });
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
  let played = false;
  if (speech.dataUrl && !muted) {
    const durationSeconds = await playSpeechClip(speech.dataUrl);
    played = durationSeconds !== null;
    if (played) {
      const ms = speechCaptionDuration({ audioDurationSeconds: durationSeconds, configuredMs });
      // ...and then tracks the real speech length (same text: timer only,
      // no flicker).
      showCaption(text, { ms });
      speechCaptionUntil = Date.now() + ms;
      return;
    }
    stopSpeechAudio(); // release the element that failed to play
  }
  // Honest fallback: speech failed (generation or playback), so the chirp
  // returns where it was suppressed, or for an explicit test click.
  const failure = played ? null : { ...speech, error: speech.error || 'playback_failed' };
  if (failure && shouldFallbackChirp(failure, { suppressedAt: eventChirpSuppressedAt, now: Date.now() })) {
    await fallbackChirpFor(speech);
  }
}

// ---------------------------------------------------------------------------
// State application
// ---------------------------------------------------------------------------

function applyState(state) {
  if (!state || typeof state !== 'object') return;
  currentState = state;
  statusText.textContent = String(state.label || 'Hanging out').toLowerCase().slice(0, 40);
  connectionDot.classList.toggle('disconnected', state.hostConnected !== true);
  document.querySelector('#pet-name').textContent = String(state.characterName || 'sparkiee').slice(0, 32).toLowerCase();
  if (state.visible === false) root.dataset.hidden = 'true';
  else delete root.dataset.hidden;

  if (state.settings?.audio) audio.setSettings(state.settings.audio);

  const animation = currentPack?.animations?.[state.animation] ? state.animation : 'idle';
  if (currentPack) spritePlayer.play(currentPack, animation);

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
window.sparkieePet.onSpeech((speech) => {
  // Ignore superseded or duplicate announcements (state re-sends, restarts).
  if (!speech || !Number.isInteger(speech.id) || speech.id <= lastSpeechId) return;
  lastSpeechId = speech.id;
  void handleSpeech(speech);
});
window.addEventListener('pagehide', stopSpeechAudio);
