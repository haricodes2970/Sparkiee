export const BASE_SPEEDS = Object.freeze({ walk: 55, run: 165 }); // CSS-pixel seconds
const MIN_LEG_LENGTH = 120;
const MAX_TICK_SECONDS = 0.25;
const REACHED_EPSILON = 1.5;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Autonomous desktop-roaming controller for the pet window.
 *
 * Pure logic with injected effects so it can be unit-tested without a
 * display: the caller supplies window/work-area accessors, a position
 * setter, a clock, and timer functions. Movement is destination-based
 * (occasional goals with dwell pauses), interpolated by elapsed time so it
 * behaves consistently across refresh rates.
 */
export function createMovementController({
  getBounds,
  getWorkArea,
  setPosition,
  speedScale = () => 1,
  rand = Math.random,
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  let mode = null;
  let target = null;
  let timer = null;
  let paused = false;
  let lastTick = now();
  let dwellUntil = 0;

  function currentSpeed() {
    const base = BASE_SPEEDS[mode] ?? BASE_SPEEDS.walk;
    const scale = clamp(Number(speedScale()) || 1, 0.25, 4);
    return base * scale;
  }

  function clampToArea(position, area, size) {
    const maxX = area.x + Math.max(0, area.width - size.width);
    const maxY = area.y + Math.max(0, area.height - size.height);
    return {
      x: clamp(position.x, area.x, maxX),
      y: clamp(position.y, area.y, maxY),
    };
  }

  function pickDestination() {
    const area = getWorkArea();
    const bounds = getBounds();
    const maxX = area.x + Math.max(0, area.width - bounds.width);
    const maxY = area.y + Math.max(0, area.height - bounds.height);
    const current = { x: bounds.x, y: bounds.y };
    let candidate = current;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      candidate = {
        x: area.x + rand() * Math.max(0, maxX - area.x),
        y: area.y + rand() * Math.max(0, maxY - area.y),
      };
      const distance = Math.hypot(candidate.x - current.x, candidate.y - current.y);
      if (distance >= MIN_LEG_LENGTH) break;
    }
    target = clampToArea(candidate, area, bounds);
  }

  function dwellDuration() {
    if (mode === 'run') return 200 + rand() * 600;
    return 900 + rand() * 2_100;
  }

  function tick() {
    const at = now();
    const dt = clamp((at - lastTick) / 1000, 0, MAX_TICK_SECONDS);
    lastTick = at;
    if (!mode || paused || at < dwellUntil) return;

    const area = getWorkArea();
    const rawBounds = getBounds();
    const bounds = clampToArea(rawBounds, area, rawBounds);
    if (!target) pickDestination();

    const speed = currentSpeed();
    const step = speed * dt;
    const dx = target.x - bounds.x;
    const dy = target.y - bounds.y;
    const distance = Math.hypot(dx, dy);

    let next;
    if (distance <= step || distance <= REACHED_EPSILON) {
      next = target;
      target = null;
      dwellUntil = at + dwellDuration();
    } else {
      next = { x: bounds.x + (dx / distance) * step, y: bounds.y + (dy / distance) * step };
    }
    const clamped = clampToArea(next, area, rawBounds);
    setPosition(clamped.x, clamped.y);
  }

  return {
    start(nextMode) {
      if (nextMode !== 'walk' && nextMode !== 'run') return false;
      if (mode === nextMode) return true;
      mode = nextMode;
      target = null;
      dwellUntil = 0;
      lastTick = now();
      if (timer === null) timer = setTimer(tick, 50);
      return true;
    },
    stop() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      mode = null;
      target = null;
      dwellUntil = 0;
    },
    pause() {
      paused = true;
    },
    resume() {
      if (paused) lastTick = now();
      paused = false;
    },
    tick,
    isActive() {
      return mode !== null;
    },
    getMode() {
      return mode;
    },
  };
}
