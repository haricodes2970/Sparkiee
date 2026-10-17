export const PET_COMMANDS = Object.freeze([
  'idle',
  'walk',
  'run',
  'dance',
  'sleep',
  'celebrate',
  'wave',
  'surprised',
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
  hide: "I'll be right here when you need me.",
  show: "I'm back! Let's make something.",
});

export function createPetController({ clock = () => Date.now() } = {}) {
  let state = {
    characterId: 'sparkiee-original',
    characterName: 'Sparkiee',
    animation: 'idle',
    visible: true,
    label: LABELS.idle,
    message: MESSAGES.idle,
    updatedAt: new Date(clock()).toISOString(),
  };
  let lastHeartbeat = 0;

  return {
    snapshot() {
      return {
        ...state,
        hostConnected: lastHeartbeat > 0 && clock() - lastHeartbeat < 3500,
      };
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
