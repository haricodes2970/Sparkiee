/**
 * Voice/sound engine for the pet renderer.
 *
 * Original synthesized chirps (Web Audio oscillator contours) with a
 * priority-aware queue, per-event cooldowns, mute/volume, optional clip
 * playback for clip-style packs, and graceful degradation when a clip is
 * missing. No network access, no background playback.
 *
 * Browser-safe: no Node.js imports. Effects are injected for testability.
 */

export const VOICE_PRIORITIES = Object.freeze({
  celebration: 3,
  excitement: 3,
  attention: 2,
  error: 2,
  greet: 1,
  return: 1,
  confused: 1,
  think: 1,
  groove: 1,
  waiting: 0,
});

const FALLBACK_SYNTH = Object.freeze({
  caption: 'Spi?',
  baseFrequency: 600,
  endFrequency: 720,
  durationMs: 160,
  waveform: 'triangle',
  chirps: 1,
  cooldownMs: 800,
});

export function voicePriority(eventId) {
  return VOICE_PRIORITIES[eventId] ?? 1;
}

/**
 * @param {object} [options]
 * @param {() => AudioContext} [options.createContext] AudioContext factory.
 * @param {() => number} [options.now] Clock.
 * @param {((clipPath: string) => boolean|Promise<boolean>)|null} [options.playClip]
 *   Clip-style playback hook; return false when the clip is unavailable.
 */
export function createAudioEngine({
  createContext = () => new AudioContext(),
  now = () => Date.now(),
  playClip = null,
} = {}) {
  let context = null;
  let masterGain = null;
  let pack = { voiceStyle: 'synth', voiceEvents: {} };
  let settings = { enabled: true, volume: 0.7 };
  let active = null; // { nodes: [], priority, endsAt, eventId }
  const lastPlayed = new Map();

  function ensureContext() {
    if (!context) {
      context = createContext();
      masterGain = context.createGain();
      masterGain.gain.value = settings.volume;
      masterGain.connect(context.destination);
    }
    return context;
  }

  function stopActive() {
    if (!active) return;
    for (const node of active.nodes) {
      try {
        node.stop();
      } catch {
        // node may already have stopped
      }
    }
    active = null;
  }

  function synthesize(descriptor) {
    const ctx = ensureContext();
    const chirps = Math.min(4, Math.max(1, Math.round(descriptor.chirps || 1)));
    const totalMs = Math.min(3000, Math.max(40, descriptor.durationMs || 200));
    const perChirp = totalMs / chirps;
    const start = ctx.currentTime + 0.01;
    const nodes = [];
    let endsAt = 0;
    for (let index = 0; index < chirps; index += 1) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = ['sine', 'square', 'sawtooth', 'triangle'].includes(descriptor.waveform) ? descriptor.waveform : 'triangle';
      const from = descriptor.baseFrequency * (1 + index * 0.05);
      const to = Math.max(80, descriptor.endFrequency * (1 + index * 0.05));
      const chirpStart = start + (index * perChirp) / 1000;
      const chirpEnd = chirpStart + (perChirp / 1000) * 0.9;
      osc.frequency.setValueAtTime(from, chirpStart);
      osc.frequency.exponentialRampToValueAtTime(to, chirpEnd);
      gain.gain.setValueAtTime(0.0001, chirpStart);
      gain.gain.exponentialRampToValueAtTime(0.5, chirpStart + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, chirpEnd);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(chirpStart);
      osc.stop(chirpEnd + 0.02);
      nodes.push(osc, gain);
      endsAt = Math.max(endsAt, (chirpEnd - ctx.currentTime) * 1000);
    }
    return { nodes, durationMs: endsAt + 40 };
  }

  return {
    setPack(nextPack) {
      if (nextPack && typeof nextPack === 'object' && nextPack.voiceEvents) pack = nextPack;
    },
    setSettings(partial) {
      if (partial && typeof partial === 'object') {
        if (typeof partial.enabled === 'boolean') settings.enabled = partial.enabled;
        if (Number.isFinite(partial.volume)) {
          settings.volume = Math.min(1, Math.max(0, partial.volume));
          if (masterGain) masterGain.gain.value = settings.volume;
        }
      }
      return { ...settings };
    },
    getSettings() {
      return { ...settings };
    },
    /**
     * Play a voice event. Returns true when a sound was actually started.
     */
    async playVoice(eventId, { force = false } = {}) {
      if (!settings.enabled || typeof eventId !== 'string') return false;
      const descriptor = pack.voiceEvents?.[eventId];
      if (!descriptor) return false;
      const at = now();
      const cooldownMs = typeof descriptor === 'object' ? descriptor.cooldownMs || 0 : 0;
      if (!force && at - (lastPlayed.get(eventId) ?? -Infinity) < cooldownMs) return false;

      const priority = voicePriority(eventId);
      if (active && at < active.endsAt) {
        // Priority queue: louder events interrupt, quieter ones are dropped.
        if (priority < active.priority) return false;
        stopActive();
      }

      let started = false;
      if (pack.voiceStyle === 'clips' && typeof descriptor === 'string' && playClip) {
        started = await Promise.resolve(playClip(descriptor)).catch(() => false);
      }
      if (!started) {
        // Synthesized fallback (also the default voice style). Keeps a
        // missing clip from leaving dead silence.
        const result = synthesize(typeof descriptor === 'object' ? descriptor : FALLBACK_SYNTH);
        active = {
          nodes: result.nodes,
          priority,
          endsAt: at + result.durationMs,
          eventId,
        };
        started = true;
      }
      if (started) lastPlayed.set(eventId, at);
      return started;
    },
    stopAll() {
      stopActive();
    },
    isActive() {
      return Boolean(active && now() < active.endsAt);
    },
    activeEvent() {
      return this.isActive() ? active.eventId : null;
    },
    dispose() {
      stopActive();
      if (context && typeof context.close === 'function') context.close().catch(() => {});
      context = null;
      masterGain = null;
    },
  };
}
