export const PET_COMMANDS = Object.freeze([
  'idle',
  'walk',
  'run',
  'dance',
  'sleep',
  'celebrate',
  'wave',
  'surprised',
  'confused',
  'thinking',
  'task_complete',
  'task_error',
  'permission_required',
  'hide',
  'show',
]);

const LABELS = Object.freeze({
  idle: 'Hanging out',
  walk: 'Going for a walk',
  run: 'Zoomies!',
  dance: 'Dancing!',
  sleep: 'Taking a nap',
  celebrate: 'Celebrating!',
  wave: 'Saying hello',
  surprised: 'Oh!',
  confused: 'Hmm?',
  thinking: 'Thinking...',
  task_complete: 'All done!',
  task_error: 'Uh oh...',
  permission_required: 'Need a hand?',
  hide: 'Taking a break',
  show: 'Back again!',
});

const MESSAGES = Object.freeze({
  idle: "Just chilling. What's the plan?",
  walk: 'Look at me go!',
  run: 'Zoomies! Zoomies!',
  dance: 'Tiny dance break!',
  sleep: 'Zzz... wake me when the tests pass.',
  celebrate: 'Yay! That deserves a celebration!',
  wave: 'Hey there, developer!',
  surprised: 'Whoa! Did that just work?',
  confused: 'Spi-ku? I am not sure about that one.',
  thinking: 'Mm-spi... let me think.',
  task_complete: 'Task complete! High five?',
  task_error: 'Task hit a snag. Wanna take a look?',
  permission_required: 'This one needs your permission.',
  hide: "I'll be right here when you need me.",
  show: "I'm back! Let's make something.",
});

export const MOVE_SPEED_MIN = 0.25;
export const MOVE_SPEED_MAX = 3;

/**
 * Engine-level mapping from pet commands to character-pack voice events.
 * Packs declare the actual sounds/captions; the engine decides which event
 * fires for a command. Commands absent from this map are silent (sleep,
 * hide, walk).
 */
export const COMMAND_VOICE_EVENTS = Object.freeze({
  wave: 'greet',
  show: 'return',
  surprised: 'attention',
  permission_required: 'attention',
  run: 'excitement',
  celebrate: 'celebration',
  task_complete: 'celebration',
  task_error: 'error',
  confused: 'confused',
  thinking: 'think',
  dance: 'groove',
  idle: 'waiting',
});

export function createPetController({ clock = () => Date.now() } = {}) {
  let state = {
    characterId: 'sparkiee-original',
    characterName: 'Sparky',
    animation: 'idle',
    visible: true,
    label: LABELS.idle,
    message: MESSAGES.idle,
    updatedAt: new Date(clock()).toISOString(),
  };
  let settings = {
    moveSpeed: 1,
    autoRoam: true,
    audio: { enabled: true, volume: 0.7 },
    captions: { enabled: true, durationMs: 2600, large: false },
    speech: { enabled: true, provider: 'elevenlabs', style: 'speech' },
    characterId: null,
  };
  let voice = null;
  let speech = null;
  let speechSequence = 0;
  let speechReady = false;
  let lastHeartbeat = 0;

  function invalid(message) {
    const error = new Error(message);
    error.code = 'INVALID_PET_SETTINGS';
    return error;
  }

  return {
    snapshot() {
      return {
        ...state,
        voice: voice ? { ...voice } : null,
        speech: speech ? { ...speech } : null,
        speechReady,
        settings: {
          ...settings,
          audio: { ...settings.audio },
          captions: { ...settings.captions },
          speech: { ...settings.speech },
        },
        hostConnected: lastHeartbeat > 0 && clock() - lastHeartbeat < 3500,
      };
    },
    /**
     * Publish a speech announcement for the pet host to deliver: either a
     * cached clip to play (clipId) or an honest failure (error) so the
     * renderer shows the caption and falls back to chirps.
     */
    announceSpeech({ text, clipId = null, error = null, voiceEvent = null, source = 'api' } = {}) {
      const value = typeof text === 'string' ? text.trim().slice(0, 220) : '';
      if (value.length === 0) {
        const failure = new Error('speech text must be a non-empty string');
        failure.code = 'INVALID_SPEECH';
        throw failure;
      }
      speechSequence += 1;
      speech = {
        id: speechSequence,
        text: value,
        clipId: typeof clipId === 'string' ? clipId : null,
        error: typeof error === 'string' ? error : null,
        voiceEvent: typeof voiceEvent === 'string' ? voiceEvent : null,
        source: typeof source === 'string' ? source : 'api',
        at: new Date(clock()).toISOString(),
      };
      return this.snapshot();
    },
    /** Whether a configured speech provider is available (set by daemon). */
    setVoiceCapability(ready) {
      speechReady = ready === true;
      return this.snapshot();
    },
    updateSettings(partial) {
      const next = {
        ...settings,
        audio: { ...settings.audio },
        captions: { ...settings.captions },
        speech: { ...settings.speech },
      };
      if ('moveSpeed' in partial) {
        const speed = Number(partial.moveSpeed);
        if (!Number.isFinite(speed) || speed < MOVE_SPEED_MIN || speed > MOVE_SPEED_MAX) {
          throw invalid(`moveSpeed must be a number from ${MOVE_SPEED_MIN} to ${MOVE_SPEED_MAX}.`);
        }
        next.moveSpeed = speed;
      }
      if ('autoRoam' in partial) {
        if (typeof partial.autoRoam !== 'boolean') throw invalid('autoRoam must be a boolean.');
        next.autoRoam = partial.autoRoam;
      }
      if ('audio' in partial) {
        const audio = partial.audio;
        if (!audio || typeof audio !== 'object' || Array.isArray(audio)) throw invalid('audio must be an object.');
        for (const key of Object.keys(audio)) {
          if (!['enabled', 'volume'].includes(key)) throw invalid(`audio.${key} is not a supported audio setting.`);
        }
        if ('enabled' in audio && typeof audio.enabled !== 'boolean') throw invalid('audio.enabled must be a boolean.');
        if ('volume' in audio) {
          const volume = Number(audio.volume);
          if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw invalid('audio.volume must be a number from 0 to 1.');
          next.audio.volume = volume;
        }
        if ('enabled' in audio) next.audio.enabled = audio.enabled;
      }
      if ('captions' in partial) {
        const captions = partial.captions;
        if (!captions || typeof captions !== 'object' || Array.isArray(captions)) throw invalid('captions must be an object.');
        for (const key of Object.keys(captions)) {
          if (!['enabled', 'durationMs', 'large'].includes(key)) throw invalid(`captions.${key} is not a supported caption setting.`);
        }
        if ('enabled' in captions && typeof captions.enabled !== 'boolean') throw invalid('captions.enabled must be a boolean.');
        if ('large' in captions && typeof captions.large !== 'boolean') throw invalid('captions.large must be a boolean.');
        if ('durationMs' in captions) {
          const duration = Number(captions.durationMs);
          if (!Number.isInteger(duration) || duration < 800 || duration > 15_000) {
            throw invalid('captions.durationMs must be an integer from 800 to 15000.');
          }
          next.captions.durationMs = duration;
        }
        if ('enabled' in captions) next.captions.enabled = captions.enabled;
        if ('large' in captions) next.captions.large = captions.large;
      }
      if ('speech' in partial) {
        const speechSettings = partial.speech;
        if (!speechSettings || typeof speechSettings !== 'object' || Array.isArray(speechSettings)) throw invalid('speech must be an object.');
        for (const key of Object.keys(speechSettings)) {
          if (!['enabled', 'provider', 'style'].includes(key)) throw invalid(`speech.${key} is not a supported speech setting.`);
        }
        if ('enabled' in speechSettings && typeof speechSettings.enabled !== 'boolean') throw invalid('speech.enabled must be a boolean.');
        if ('provider' in speechSettings && !['elevenlabs', 'chirps'].includes(speechSettings.provider)) {
          throw invalid('speech.provider must be "elevenlabs" or "chirps".');
        }
        if ('style' in speechSettings && !['speech', 'chirps', 'both'].includes(speechSettings.style)) {
          throw invalid('speech.style must be "speech", "chirps", or "both".');
        }
        if ('enabled' in speechSettings) next.speech.enabled = speechSettings.enabled;
        if ('provider' in speechSettings) next.speech.provider = speechSettings.provider;
        if ('style' in speechSettings) next.speech.style = speechSettings.style;
      }
      if ('characterId' in partial) {
        const id = partial.characterId;
        if (id !== null && (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(id))) {
          throw invalid('characterId must be null or a valid character pack id.');
        }
        next.characterId = id;
      }
      settings = next;
      return this.snapshot();
    },
    /**
     * Trigger an explicit voice reaction (for example the dashboard test
     * sound) without changing the current animation.
     */
    triggerVoice(event) {
      if (typeof event !== 'string' || !/^[a-z][a-z0-9_]{1,32}$/.test(event)) {
        const error = new Error('voice event must be a valid event id.');
        error.code = 'INVALID_VOICE_EVENT';
        throw error;
      }
      voice = { event, at: new Date(clock()).toISOString() };
      return this.snapshot();
    },
    heartbeat() {
      lastHeartbeat = clock();
      return this.snapshot();
    },
    command(command) {
      if (typeof command !== 'string' || !PET_COMMANDS.includes(command)) {
        const error = new Error(`Unsupported pet command. Expected one of: ${PET_COMMANDS.join(', ')}.`);
        error.code = 'INVALID_PET_COMMAND';
        throw error;
      }
      const now = clock();
      state = {
        ...state,
        animation: ['hide', 'show'].includes(command) ? state.animation : command,
        visible: command === 'hide' ? false : command === 'show' ? true : state.visible,
        label: LABELS[command],
        message: MESSAGES[command],
        updatedAt: new Date(now).toISOString(),
      };
      return this.snapshot();
    },
  };
}

export function isValidPetCommandPayload(payload) {
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 1 &&
    typeof payload.command === 'string' &&
    PET_COMMANDS.includes(payload.command)
  );
}

const SETTINGS_TOP_LEVEL_KEYS = ['moveSpeed', 'autoRoam', 'audio', 'captions', 'speech', 'characterId'];

function isValidAudioSettings(audio) {
  if (!audio || typeof audio !== 'object' || Array.isArray(audio)) return false;
  const keys = Object.keys(audio);
  if (keys.length === 0 || keys.some((key) => !['enabled', 'volume'].includes(key))) return false;
  if ('enabled' in audio && typeof audio.enabled !== 'boolean') return false;
  if ('volume' in audio) {
    const volume = Number(audio.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) return false;
  }
  return true;
}

function isValidCaptionSettings(captions) {
  if (!captions || typeof captions !== 'object' || Array.isArray(captions)) return false;
  const keys = Object.keys(captions);
  if (keys.length === 0 || keys.some((key) => !['enabled', 'durationMs', 'large'].includes(key))) return false;
  if ('enabled' in captions && typeof captions.enabled !== 'boolean') return false;
  if ('large' in captions && typeof captions.large !== 'boolean') return false;
  if ('durationMs' in captions) {
    const duration = Number(captions.durationMs);
    if (!Number.isInteger(duration) || duration < 800 || duration > 15_000) return false;
  }
  return true;
}

function isValidSpeechSettings(speech) {
  if (!speech || typeof speech !== 'object' || Array.isArray(speech)) return false;
  const keys = Object.keys(speech);
  if (keys.length === 0 || keys.some((key) => !['enabled', 'provider', 'style'].includes(key))) return false;
  if ('enabled' in speech && typeof speech.enabled !== 'boolean') return false;
  if ('provider' in speech && !['elevenlabs', 'chirps'].includes(speech.provider)) return false;
  if ('style' in speech && !['speech', 'chirps', 'both'].includes(speech.style)) return false;
  return true;
}

export function isValidPetSettingsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (keys.length === 0 || keys.some((key) => !SETTINGS_TOP_LEVEL_KEYS.includes(key))) return false;
  if ('moveSpeed' in payload) {
    const speed = Number(payload.moveSpeed);
    if (!Number.isFinite(speed) || speed < MOVE_SPEED_MIN || speed > MOVE_SPEED_MAX) return false;
  }
  if ('autoRoam' in payload && typeof payload.autoRoam !== 'boolean') return false;
  if ('audio' in payload && !isValidAudioSettings(payload.audio)) return false;
  if ('captions' in payload && !isValidCaptionSettings(payload.captions)) return false;
  if ('speech' in payload && !isValidSpeechSettings(payload.speech)) return false;
  if ('characterId' in payload) {
    const id = payload.characterId;
    if (id !== null && (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(id))) return false;
  }
  return true;
}
