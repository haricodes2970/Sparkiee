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
  transcribing: { label: 'Transcribing', phase: 'transcribing' },
  interpreting: { label: 'Thinking', phase: 'working' },
  executing: { label: 'Working', phase: 'working' },
  speaking: { label: 'Speaking', phase: 'speaking' },
  awaiting_confirmation: { label: 'Confirm?', phase: 'speaking' },
  error: { label: 'Mic error', phase: 'error' },
});

const HIDDEN = Object.freeze({ visible: false, label: '', phase: '' });

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
