/**
 * Conversation policy for spoken, multi-turn interaction.
 *
 * Pure decisions only: greeting length, closing phrases, and whether a turn
 * earns a follow-up listening window. The server owns timers and microphones;
 * this module never touches I/O so the rules are cheap to test.
 */

export const FOLLOW_UP_MS = 6_500;

/** A gap this long starts a fresh session and the full introduction again. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export const LONG_GREETING = "Hey, I'm Sparky! What would you like me to do?";

export const SHORT_GREETINGS = Object.freeze(['Hey!', 'Yes?', "I'm here."]);

const CLOSING_PHRASES = new Set([
  'that is all',
  'thats all',
  'that is it',
  'thats it',
  'we are done',
  'were done',
  'i am done',
  'im done',
  'nothing else',
  'no thanks',
  'no thank you',
  'thanks',
  'thank you',
  'thanks sparky',
  'thank you sparky',
  'ok thanks',
  'okay thanks',
  'bye',
  'good bye',
  'goodbye',
  'see you',
  'see ya',
  'good night',
  'goodnight',
  'never mind',
  'nevermind',
]);

/**
 * Normalise only for phrase matching: lowercase, strip wake names and
 * punctuation. Music parsing still uses its own normaliser.
 */
export function normalizeConversationText(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^\p{L}\p{N}\s%]/gu, ' ')
    .replace(/\b(?:yo|hey)\s+spark(?:y|iee)?\b/gu, ' ')
    .replace(/\bspark(?:y|iee)?\b/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isClosingPhrase(text) {
  const normalized = normalizeConversationText(text);
  return normalized.length > 0 && CLOSING_PHRASES.has(normalized);
}

/**
 * Choose the greeting for an upcoming manual summon.
 *
 * `previousTurn` and `lastAt` describe the prior greeting. A first summon or
 * a gap longer than `gapMs` returns the full introduction; otherwise short
 * acknowledgements rotate so repeated summons never feel like a reset.
 */
export function nextGreeting({
  previousTurn = 0,
  lastAt = 0,
  now = Date.now(),
  gapMs = SESSION_GAP_MS,
} = {}) {
  const stale = !Number.isFinite(lastAt) || lastAt <= 0 || (now - lastAt) >= gapMs;
  const turn = stale ? 1 : Math.max(1, Math.trunc(Number(previousTurn) || 0)) + 1;
  if (turn <= 1) return { turn: 1, mode: 'long', text: LONG_GREETING };
  return {
    turn,
    mode: 'short',
    text: SHORT_GREETINGS[(turn - 2) % SHORT_GREETINGS.length],
  };
}

/**
 * Decide whether a finished assistant turn should reopen the microphone.
 * Silence never continues; explicit closure never continues; everything else
 * gets one bounded follow-up window.
 */
export function conversationDecision({ transcript = null, closing = false } = {}) {
  if (typeof transcript !== 'string' || transcript.trim().length === 0) {
    return { continue: false, reason: 'no-speech' };
  }
  if (closing === true || isClosingPhrase(transcript)) {
    return { continue: false, reason: 'closing' };
  }
  return { continue: true, reason: 'follow-up' };
}
