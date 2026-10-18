import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioEngine, voicePriority } from '../packages/pet-host/renderer/lib/audio-engine.mjs';

function makeFakeContext() {
  const nodes = [];
  const context = {
    currentTime: 0,
    destination: { name: 'destination' },
    closed: false,
    createGain() {
      const gain = {
        gain: {
          value: 0,
          calls: [],
          setValueAtTime(value, time) { this.calls.push(['set', value, time]); this.value = value; },
          exponentialRampToValueAtTime(value, time) { this.calls.push(['ramp', value, time]); this.value = value; },
        },
        connect(target) { this.target = target; },
      };
      nodes.push(gain);
      return gain;
    },
    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: {
          calls: [],
          setValueAtTime(value, time) { this.calls.push(['set', value, time]); },
          exponentialRampToValueAtTime(value, time) { this.calls.push(['ramp', value, time]); },
        },
        started: false,
        stopped: false,
        connect(target) { this.target = target; },
        start(time) { this.started = true; this.startTime = time; },
        stop(time) { this.stopped = true; this.stopTime = time; },
      };
      nodes.push(osc);
      return osc;
    },
    close() { this.closed = true; return Promise.resolve(); },
  };
  return { context, nodes };
}

const PACK = {
  voiceStyle: 'synth',
  voiceEvents: {
    greet: { caption: 'Spi-spi!', baseFrequency: 620, endFrequency: 880, durationMs: 200, waveform: 'triangle', chirps: 2, cooldownMs: 1000 },
    celebration: { caption: 'Yay!', baseFrequency: 660, endFrequency: 990, durationMs: 400, waveform: 'triangle', chirps: 3, cooldownMs: 2000 },
    waiting: { caption: 'Pi?', baseFrequency: 520, endFrequency: 480, durationMs: 150, waveform: 'sine', chirps: 1, cooldownMs: 0 },
  },
};

function makeEngine(overrides = {}) {
  let clock = 10_000;
  const { context, nodes } = makeFakeContext();
  const engine = createAudioEngine({
    createContext: () => context,
    now: () => clock,
    ...overrides,
  });
  engine.setPack(PACK);
  return { engine, context, nodes, advance: (ms) => { clock += ms; } };
}

test('playing a voice event synthesizes oscillators and reports success', async () => {
  const { engine, nodes } = makeEngine();
  assert.equal(await engine.playVoice('greet'), true);
  const oscillators = nodes.filter((node) => 'frequency' in node);
  assert.equal(oscillators.length, 2, 'two chirps requested');
  for (const osc of oscillators) assert.equal(osc.started, true);
  assert.equal(engine.activeEvent(), 'greet');
});

test('cooldowns stop repeated vocalisation until the window passes', async () => {
  const { engine, advance } = makeEngine();
  assert.equal(await engine.playVoice('greet'), true);
  assert.equal(await engine.playVoice('greet'), false, 'blocked by cooldown');
  advance(600);
  assert.equal(await engine.playVoice('greet'), false, 'still cooling down');
  advance(600);
  assert.equal(await engine.playVoice('greet'), true, 'cooldown passed');
  advance(600); // let the greet sound finish so lower priorities can play
  assert.equal(await engine.playVoice('waiting'), true, 'other events unaffected');
});

test('mute disables playback without breaking the engine', async () => {
  const { engine } = makeEngine();
  assert.deepEqual(engine.setSettings({ enabled: false }), { enabled: false, volume: 0.7 });
  assert.equal(await engine.playVoice('greet'), false);
  engine.setSettings({ enabled: true });
  assert.equal(await engine.playVoice('greet'), true);
});

test('volume flows to the master gain', async () => {
  const { engine, nodes } = makeEngine();
  engine.setSettings({ volume: 0.25 });
  await engine.playVoice('greet');
  const master = nodes.find((node) => 'gain' in node && Array.isArray(node.gain.calls));
  assert.ok(master, 'master gain created');
  assert.equal(master.gain.value, 0.25, 'volume applied to master gain');
});

test('priority queue interrupts louder events and drops quieter ones', async () => {
  const { engine, nodes } = makeEngine();
  assert.equal(await engine.playVoice('waiting'), true);
  // waiting (priority 0) is still playing; celebration (3) must interrupt
  assert.equal(await engine.playVoice('celebration'), true);
  const stoppedOscillator = nodes.find((node) => 'frequency' in node && node.stopped);
  assert.ok(stoppedOscillator, 'previous sound was stopped');
  // while celebration plays, waiting must be dropped
  assert.equal(await engine.playVoice('waiting'), false);
});

test('missing clips fall back to synthesized sound instead of silence', async () => {
  const clipPack = { voiceStyle: 'clips', voiceEvents: { greet: 'sounds/greet.wav' } };
  const { context, nodes } = makeFakeContext();
  const engine = createAudioEngine({
    createContext: () => context,
    now: () => 1_000,
    playClip: () => false, // clip unavailable
  });
  engine.setPack(clipPack);
  assert.equal(await engine.playVoice('greet'), true, 'fallback kept the reaction alive');
  assert.ok(nodes.some((node) => 'frequency' in node), 'synth fallback used');

  const played = [];
  const engine2 = createAudioEngine({
    createContext: () => makeFakeContext().context,
    now: () => 1_000,
    playClip: (clip) => { played.push(clip); return true; },
  });
  engine2.setPack(clipPack);
  assert.equal(await engine2.playVoice('greet'), true);
  assert.deepEqual(played, ['sounds/greet.wav']);
});

test('unknown events, disabled engines, and bad input never throw', async () => {
  const { engine } = makeEngine();
  assert.equal(await engine.playVoice('nope'), false);
  assert.equal(await engine.playVoice(undefined), false);
  assert.equal(await engine.playVoice(42), false);
  engine.stopAll();
  engine.dispose();
  assert.equal(engine.isActive(), false);
});

test('force bypasses the cooldown for explicit test sounds', async () => {
  const { engine } = makeEngine();
  assert.equal(await engine.playVoice('greet'), true);
  assert.equal(await engine.playVoice('greet', { force: true }), true);
});

test('voice priorities are stable and documented per event', () => {
  assert.ok(voicePriority('celebration') > voicePriority('greet'));
  assert.ok(voicePriority('greet') > voicePriority('waiting'));
  assert.equal(voicePriority('unknown-event'), 1, 'sane default');
});
