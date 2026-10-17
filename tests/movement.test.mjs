import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_SPEEDS, createMovementController } from '../packages/pet-host/src/movement.mjs';

function makeWorld({ area = { x: 0, y: 0, width: 1920, height: 1080 }, bounds = { x: 100, y: 100, width: 200, height: 220 } } = {}) {
  let clock = 1_000;
  const positions = [];
  const timers = new Map();
  let nextTimerId = 1;
  const cleared = [];
  const world = {
    area,
    bounds: { ...bounds },
    positions,
    cleared,
    setBounds(position) {
      world.bounds = { ...world.bounds, x: Math.round(position.x), y: Math.round(position.y) };
    },
    advance(ms, stepMs = 50) {
      for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
        clock += stepMs;
        world.controller?.tick();
      }
    },
  };
  world.controller = createMovementController({
    getBounds: () => ({ ...world.bounds }),
    getWorkArea: () => ({ ...world.area }),
    setPosition: (x, y) => {
      world.setBounds({ x, y });
      positions.push({ x, y, at: clock });
    },
    rand: () => 0.5,
    now: () => clock,
    setTimer: (callback, ms) => {
      const id = nextTimerId++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimer: (id) => {
      cleared.push(id);
      timers.delete(id);
    },
  });
  world.activeTimers = () => timers.size;
  return world;
}

test('walk moves the window toward destinations and stays inside the work area', () => {
  const world = makeWorld();
  world.controller.start('walk');
  world.advance(30_000);
  assert.ok(world.positions.length > 20, 'expected sustained movement');
  for (const { x, y } of world.positions) {
    assert.ok(x >= world.area.x && x <= world.area.x + world.area.width - world.bounds.width, `x ${x} inside`);
    assert.ok(y >= world.area.y && y <= world.area.y + world.area.height - world.bounds.height, `y ${y} inside`);
  }
});

test('movement is time-based and respects the per-mode speed budget', () => {
  const world = makeWorld();
  world.controller.start('walk');
  const start = { ...world.bounds };
  // First leg heads toward (960, 540) with rand()=0.5; advance a known time.
  world.advance(2_000, 50);
  const moved = Math.hypot(world.bounds.x - start.x, world.bounds.y - start.y);
  assert.ok(moved <= BASE_SPEEDS.walk * 2.2 + 30, `walk should cover ~${BASE_SPEEDS.walk * 2}s of ground, got ${moved.toFixed(1)}px`);
  assert.ok(moved > 40, 'walk should actually move the window');
});

test('run is faster than walk', () => {
  const walkWorld = makeWorld();
  walkWorld.controller.start('walk');
  walkWorld.advance(1_500, 50);
  const walkDistance = Math.hypot(walkWorld.bounds.x - 100, walkWorld.bounds.y - 100);

  const runWorld = makeWorld();
  runWorld.controller.start('run');
  runWorld.advance(1_500, 50);
  const runDistance = Math.hypot(runWorld.bounds.x - 100, runWorld.bounds.y - 100);

  assert.ok(runDistance > walkDistance, `run (${runDistance.toFixed(0)}px) should beat walk (${walkDistance.toFixed(0)}px)`);
});

test('speed scale multiplies movement speed', () => {
  function distanceCovered(scale) {
    let clock = 0;
    let bounds = { x: 100, y: 100, width: 200, height: 220 };
    const controller = createMovementController({
      getBounds: () => ({ ...bounds }),
      getWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      setPosition: (x, y) => { bounds = { ...bounds, x, y }; },
      rand: () => 0.5,
      now: () => clock,
      speedScale: () => scale,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    controller.start('walk');
    for (let i = 0; i < 20; i += 1) { clock += 50; controller.tick(); }
    return Math.hypot(bounds.x - 100, bounds.y - 100);
  }
  const base = distanceCovered(1);
  const doubled = distanceCovered(2);
  assert.ok(base > 40, 'base speed covers ground');
  assert.ok(doubled > base * 1.8, `2x scale should roughly double distance (${doubled.toFixed(0)} vs ${base.toFixed(0)})`);
});

test('dragging pauses movement and resuming continues without teleporting', () => {
  const world = makeWorld();
  world.controller.start('walk');
  world.advance(1_000, 50);
  const before = { x: world.bounds.x, y: world.bounds.y };
  world.controller.pause();
  world.advance(3_000, 50);
  assert.deepEqual({ x: world.bounds.x, y: world.bounds.y }, before, 'no movement while paused');
  world.controller.resume();
  world.advance(100, 50);
  const afterResume = Math.hypot(world.bounds.x - before.x, world.bounds.y - before.y);
  assert.ok(afterResume < BASE_SPEEDS.walk * 0.5, 'no teleport on resume');
});

test('stop clears movement timers and deactivates the controller', () => {
  const world = makeWorld();
  world.controller.start('walk');
  assert.equal(world.activeTimers(), 1);
  world.controller.stop();
  assert.equal(world.activeTimers(), 0);
  assert.equal(world.cleared.length, 1);
  assert.equal(world.controller.isActive(), false);
  assert.equal(world.controller.getMode(), null);
  const before = { x: world.bounds.x, y: world.bounds.y };
  world.advance(2_000, 50);
  assert.deepEqual({ x: world.bounds.x, y: world.bounds.y }, before);
});

test('work-area changes re-clamp destinations instead of escaping the display', () => {
  const world = makeWorld({ area: { x: 0, y: 0, width: 1920, height: 1080 } });
  world.controller.start('run');
  world.advance(1_000, 50);
  // Simulate the user dragging the pet onto a smaller display.
  world.area = { x: 2000, y: 0, width: 800, height: 600 };
  world.bounds = { ...world.bounds, x: 2100, y: 100 };
  world.advance(4_000, 50);
  assert.ok(world.bounds.x >= 2000 && world.bounds.x <= 2000 + 800 - world.bounds.width, 'x stays on the new display');
  assert.ok(world.bounds.y >= 0 && world.bounds.y <= 600 - world.bounds.height, 'y stays on the new display');
});

test('only walk and run are valid movement modes', () => {
  const world = makeWorld();
  assert.equal(world.controller.start('dance'), false);
  assert.equal(world.controller.start('sleep'), false);
  assert.equal(world.controller.isActive(), false);
  assert.equal(world.controller.start('walk'), true);
});
