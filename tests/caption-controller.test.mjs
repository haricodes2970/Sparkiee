import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptionController } from '../packages/pet-host/renderer/lib/caption.mjs';

function makeClassList() {
  const values = new Set();
  return {
    add(name) { values.add(name); },
    remove(name) { values.delete(name); },
    toggle(name, force) {
      const on = force === undefined ? !values.has(name) : force;
      if (on) values.add(name); else values.delete(name);
      return on;
    },
    contains(name) { return values.has(name); },
    values,
  };
}

function makeHarness() {
  let nextTimerId = 1;
  let now = 0;
  const timers = new Map();
  const box = { classList: makeClassList(), offsetWidth: 100 };
  const text = { textContent: '' };
  const controller = createCaptionController({
    box,
    text,
    setTimer(fn, ms) {
      const id = nextTimerId += 1;
      timers.set(id, { fn, dueAt: now + ms });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
  });
  return {
    box,
    text,
    controller,
    timers,
    pending() { return timers.size; },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.dueAt <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

test('captions appear beneath the pet with pop animation and auto-hide', () => {
  const h = makeHarness();
  assert.equal(h.controller.show('Spi-spi!'), true);
  assert.ok(h.box.classList.contains('visible'));
  assert.ok(h.box.classList.contains('caption-bump'));
  assert.equal(h.text.textContent, 'Spi-spi!');
  assert.equal(h.pending(), 1, 'hide timer scheduled');

  h.advance(2599);
  assert.ok(h.box.classList.contains('visible'), 'still visible before duration');
  h.advance(1);
  assert.ok(!h.box.classList.contains('visible'), 'faded after duration');
  assert.equal(h.pending(), 0);
});

test('captions still render when audio is muted (independent module)', () => {
  const h = makeHarness();
  // Mute is an audio-engine concern; the caption controller never sees it.
  h.controller.setSettings({ enabled: true });
  assert.equal(h.controller.show('Yay!'), true);
  assert.ok(h.box.classList.contains('visible'));
});

test('disabling captions hides the box and blocks new captions', () => {
  const h = makeHarness();
  h.controller.show('visible first');
  h.controller.setSettings({ enabled: false });
  assert.ok(!h.box.classList.contains('visible'));
  assert.equal(h.pending(), 0, 'pending hide timer cancelled');
  assert.equal(h.controller.show('blocked'), false);
  assert.ok(!h.box.classList.contains('visible'));

  h.controller.setSettings({ enabled: true });
  assert.equal(h.controller.show('back'), true);
  assert.ok(h.box.classList.contains('visible'));
});

test('custom duration and large-caption accessibility setting apply', () => {
  const h = makeHarness();
  h.controller.setSettings({ durationMs: 5000, large: true });
  assert.ok(h.box.classList.contains('large'));
  h.controller.show('reading this comfortably');
  h.advance(4999);
  assert.ok(h.box.classList.contains('visible'));
  h.advance(1);
  assert.ok(!h.box.classList.contains('visible'));

  h.controller.setSettings({ large: false });
  assert.ok(!h.box.classList.contains('large'));
});

test('repeated captions restart the timer and re-pop', () => {
  const h = makeHarness();
  h.controller.show('first');
  h.advance(1500);
  h.controller.show('second');
  assert.equal(h.pending(), 1, 'old timer replaced, not stacked');
  h.advance(2000);
  assert.ok(h.box.classList.contains('visible'), 'restart extends visibility');
  h.advance(601);
  assert.ok(!h.box.classList.contains('visible'));
  assert.equal(h.text.textContent, 'second');
});

test('voice captions and state captions share one box without overlap', () => {
  const h = makeHarness();
  h.controller.show('Just chilling. What\'s the plan?');
  h.controller.show('Spi-la-chu!', { ms: 800 }); // voice overrides state caption
  assert.equal(h.text.textContent, 'Spi-la-chu!');
  h.advance(800);
  assert.ok(!h.box.classList.contains('visible'));
});

test('overlong captions are truncated and unsafe values coerced', () => {
  const h = makeHarness();
  h.controller.show('x'.repeat(500));
  assert.equal(h.text.textContent.length, 180);
  h.controller.show(undefined);
  assert.equal(h.text.textContent, '');
  h.controller.show(null);
  assert.equal(h.text.textContent, '');
  h.controller.show(12345);
  assert.equal(h.text.textContent, '12345');
});

test('hide and dispose cancel pending timers', () => {
  const h = makeHarness();
  h.controller.show('bye');
  h.controller.hide();
  assert.ok(!h.box.classList.contains('visible'));
  assert.equal(h.pending(), 0);
  h.controller.show('again');
  h.controller.dispose();
  assert.equal(h.pending(), 0);
});
