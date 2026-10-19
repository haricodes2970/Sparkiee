/**
 * Compact microphone indicator for the desktop pet window.
 *
 * A small transient state bubble (icon + phase word) that sits beside the
 * pet during capture/recognise/execute/speak phases only. It never adds a
 * second Sparky character and only renders from real assistant states —
 * idle/armed stays invisible.
 */

const PHASES = Object.freeze({
  wake_detected: { label: 'Listening', phase: 'listening' },
  listening: { label: 'Listening', phase: 'listening' },
  hearing: { label: 'Hearing', phase: 'hearing' },
  transcribing: { label: 'Transcribing', phase: 'transcribing' },
  interpreting: { label: 'Thinking', phase: 'working' },
  executing: { label: 'Working', phase: 'working' },
  speaking: { label: 'Speaking', phase: 'speaking' },
  awaiting_confirmation: { label: 'Confirm?', phase: 'speaking' },
  error: { label: 'Mic error', phase: 'error' },
});

const HIDDEN = Object.freeze({ visible: false, label: '', phase: '' });

// Relative bar weights: uneven so the meter reads as a tiny waveform, not a
// solid block. Heights are in CSS pixels (pixel-art scale) and never reach 0.
const BAR_WEIGHTS = Object.freeze([0.55, 1, 0.72, 0.9]);

/**
 * Pixel-styled bar heights for the hearing meter, derived from the daemon's
 * real PCM level (0..1). Pure so the mapping is testable without a DOM.
 */
export function hearingBars(level) {
  const value = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return BAR_WEIGHTS.map((weight) => Math.round(2 + value * weight * 8));
}

/**
 * The meter is only ever visible while the backend says audio is flowing AND
 * the session is in the hearing phase. A silent microphone must show the
 * listening/processing phase rather than a faked waveform.
 */
export function describeHearingMeter({ assistant } = {}) {
  const state = assistant?.state ?? null;
  const active = assistant?.micActive === true;
  return {
    visible: state === 'hearing' && active,
    level: active ? Number(assistant?.hearLevel) || 0 : 0,
  };
}

export function describeMicIndicator({ assistant } = {}) {
  const state = assistant?.state ?? null;
  if (!state) return { ...HIDDEN };
  // The live microphone bubble only makes sense while something is actually
  // happening; idle/disabled/armed stay silent so the pet is not decorated.
  if (state === 'disabled' || state === 'armed') return { ...HIDDEN };
  const phase = PHASES[state];
  if (!phase) return { ...HIDDEN };
  return { visible: true, label: phase.label, phase: phase.phase };
}
