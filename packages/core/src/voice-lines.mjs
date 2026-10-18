/**
 * Sparky's spoken lines, per event.
 *
 * These are short, predefined, original utterances — no arbitrary
 * AI-generated dialogue and no user content ever reaches the TTS
 * provider. Lines are chosen deterministically (first line by default;
 * callers may pick an index). Character packs may override lines in a
 * future revision; the engine interface stays the same.
 */

export const MAX_SPEECH_LENGTH = 220;

/** Short phrase used by `sparkiee voice test` and the dashboard button. */
export const VOICE_TEST_PHRASE = "Hi! I'm Sparky, your desktop companion.";

export const VOICE_LINES = Object.freeze({
  // Greetings and arrivals
  greet: Object.freeze(["Hey! I'm Sparky!", 'Hi there! What\'s the plan?', "Sparky's here!"]),
  return: Object.freeze(["I'm back!", 'Miss me?']),
  waiting: Object.freeze(['Still here whenever you need me.']),

  // Curiosity
  curiosity: Object.freeze(['Hmm? What\'s that?', 'Ooh, show me!', 'Let me have a look.']),
  confused: Object.freeze(['Hmm? What\'s that?', 'I am not sure about that one.']),
  think: Object.freeze(['Let me have a look.', 'Mm, thinking...']),

  // Coding task lifecycle (only ever fired on confirmed events)
  task_start: Object.freeze(['Okay! Let\'s get to work!']),
  task_progress: Object.freeze(['Still working on it!', 'Almost there!']),
  task_complete: Object.freeze(['Your task is complete!', 'All done! Nice work.']),
  task_error: Object.freeze(['Something went wrong. Let\'s take a look.']),

  // Reactions
  excitement: Object.freeze(['Woo! Here we go!']),
  celebration: Object.freeze(['Yay! That deserves a celebration!']),
  error: Object.freeze(['Something went wrong. Let\'s take a look.']),
  attention: Object.freeze(['I need your attention for a moment.']),
  permission_required: Object.freeze(['OpenCode needs your approval for this one.']),

  // Soft states
  surprise: Object.freeze(['Whoa!']),
  groove: Object.freeze(['Tiny dance break!']),
  nap: Object.freeze(['Just resting my eyes...']),
});

export const EVENT_IDS = Object.freeze(Object.keys(VOICE_LINES));

export function isValidVoiceEvent(event) {
  return typeof event === 'string' && Object.hasOwn(VOICE_LINES, event);
}

/**
 * Pick a line for an event. Deterministic by default so repeated events
 * are predictable and cacheable; pass an index for variety.
 */
export function pickLine(event, index = 0) {
  const lines = VOICE_LINES[event];
  if (!Array.isArray(lines)) return null;
  const line = lines[((Number(index) || 0) % lines.length + lines.length) % lines.length];
  return typeof line === 'string' && line.length <= MAX_SPEECH_LENGTH ? line : null;
}

/**
 * Map agent lifecycle events (from the OpenCode observer or the API) to
 * pet reactions. session_idle deliberately maps to no announcement: an
 * idle session is not evidence of a successful task.
 */
export const AGENT_EVENT_REACTIONS = Object.freeze({
  task_start: Object.freeze({ command: 'thinking', voiceEvent: 'task_start' }),
  task_progress: Object.freeze({ command: 'thinking', voiceEvent: 'task_progress' }),
  task_complete: Object.freeze({ command: 'celebrate', voiceEvent: 'task_complete' }),
  task_error: Object.freeze({ command: 'task_error', voiceEvent: 'error' }),
  permission_request: Object.freeze({ command: 'permission_required', voiceEvent: 'permission_required' }),
  session_idle: Object.freeze({ command: null, voiceEvent: null }),
  session_error: Object.freeze({ command: 'task_error', voiceEvent: 'error' }),
});

export const AGENT_EVENT_TYPES = Object.freeze(Object.keys(AGENT_EVENT_REACTIONS));

/**
 * Pet commands that also earn a spoken line when spoken voice is enabled.
 * Movement and visibility commands are deliberately absent: autonomous
 * roaming would otherwise chatter continuously.
 */
export const COMMAND_SPEECH_EVENTS = Object.freeze({
  wave: 'greet',
  celebrate: 'celebration',
  sleep: 'nap',
  dance: 'groove',
  confused: 'confused',
  thinking: 'think',
  task_complete: 'task_complete',
  task_error: 'error',
  permission_required: 'attention',
  surprised: 'surprise',
});

/** Minimum gap between spoken lines of the same event (anti-spam). */
export const SPEECH_EVENT_COOLDOWN_MS = 6000;
