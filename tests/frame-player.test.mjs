import test from 'node:test';
import assert from 'node:assert/strict';
import { createFramePlayer } from '../packages/pet-host/renderer/lib/frame-player.mjs';

function fakeElement() {
  const classes = new Set(['loading']);
  return {
    style: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      has: (name) => classes.has(name),
    },
  };
}

function makePack() {
  return {
    id: 'frame-test',
    name: 'Frame Test',
    sprite: { url: '/api/v1/characters/frame-test/sprite.png', frameWidth: 32, frameHeight: 32, columns: 4 },
    layout: { spriteScale: 2 },
    animations: {
      idle: { frames: [0, 1, 2], frameMs: 16, loop: true },
      wave: { frames: [5], frameMs: 16, loop: false },
      celebrate: { frames: [8, 9], frameMs: 16, loop: false },
    },
  };
}

test('frame player rejects a missing element', () => {
  assert.throws(() => createFramePlayer({ element: null }), /DOM element/);
});

test('load paints the first frame of the state animation and clears the loading class', () => {
  const element = fakeElement();
  let current = 'wave';
  const player = createFramePlayer({ element, getAnimation: () => current });
  const pack = makePack();
  player.load(pack);
  assert.equal(element.classList.has('loading'), false);
  // frame 5: column 5 % 4 = 1, row floor(5 / 4) = 1 → -64px -64px at scale 2.
  assert.equal(element.style.backgroundPosition, '-64px -64px');
  assert.equal(element.style.width, '64px');
  assert.equal(element.style.backgroundImage, 'url("/api/v1/characters/frame-test/sprite.png")');

  // Unknown state animation falls back to idle frames.
  current = 'does-not-exist';
  player.load(pack);
  assert.equal(element.style.backgroundPosition, '0px 0px');
  player.dispose();
});

test('looping animations keep running until replaced', async () => {
  const element = fakeElement();
  const player = createFramePlayer({ element });
  const pack = makePack();
  player.load(pack);
  player.play(pack, 'idle');
  assert.equal(player.animation(), 'idle');
  await new Promise((resolve) => setTimeout(resolve, 60));
  // Still looping after more than one full pass (3 frames × 16ms).
  assert.equal(player.animation(), 'idle');
  assert.match(element.style.backgroundPosition, /^-?\d+px -?\d+px$/);
  player.dispose();
});

test('one-shot animations fall back to idle frames while state label stays put', async () => {
  const element = fakeElement();
  const player = createFramePlayer({ element });
  const pack = makePack();
  player.load(pack);
  player.play(pack, 'celebrate');
  assert.equal(player.animation(), 'celebrate');
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(player.animation(), 'idle');
  player.dispose();
  const positionAtDispose = element.style.backgroundPosition;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(element.style.backgroundPosition, positionAtDispose);
  assert.equal(player.animation(), null);
});
