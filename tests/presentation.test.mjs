import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPetController,
  desktopWindowVisible,
  isValidPresentationClaimPayload,
  isValidPresentationReleasePayload,
  PRESENTATION_CLAIM_GRACE_MS,
  PRESENTATION_LEASE_DEFAULT_MS,
} from '../packages/core/src/pet-state.mjs';

function controllerAt(startMs = 1_000_000) {
  let now = startMs;
  const controller = createPetController({ clock: () => now });
  return { controller, advance: (ms) => { now += ms; return now; }, now: () => now };
}

test('presentation starts on the desktop with no owner', () => {
  const { controller } = controllerAt();
  const { presentation } = controller.snapshot();
  assert.equal(presentation.mode, 'desktop');
  assert.equal(presentation.owner, null);
  assert.equal(presentation.leaseExpiresAt, null);
  assert.equal(presentation.pending, false);
  assert.equal(presentation.error, null);
});

test('claiming moves presentation to the dashboard with a bounded lease', () => {
  const harness = controllerAt();
  const { controller, now } = harness;
  const snapshot = controller.claimPresentation({ owner: 'tab-one-1234', ttlMs: 20_000 });
  assert.equal(snapshot.presentation.mode, 'dashboard');
  assert.equal(snapshot.presentation.owner, 'tab-one-1234');
  assert.equal(snapshot.presentation.pending, false);
  assert.equal(
    Date.parse(snapshot.presentation.leaseExpiresAt),
    now() + 20_000,
  );
  assert.deepEqual(
    { from: snapshot.presentation.lastTransition.from, to: snapshot.presentation.lastTransition.to, reason: snapshot.presentation.lastTransition.reason },
    { from: 'desktop', to: 'dashboard', reason: 'claimed' },
  );
  // Desktop surface must not be visible while the dashboard owns the pet.
  assert.equal(desktopWindowVisible(snapshot), false);
});

test('renewing extends the lease without a redundant transition record', () => {
  const { controller, advance, now } = controllerAt();
  controller.claimPresentation({ owner: 'tab-one-1234', ttlMs: 10_000 });
  const firstTransition = controller.snapshot().presentation.lastTransition;
  advance(3_000);
  const renewed = controller.claimPresentation({ owner: 'tab-one-1234', ttlMs: 10_000 });
  assert.equal(renewed.presentation.owner, 'tab-one-1234');
  assert.equal(renewed.presentation.leaseExpiresAt, new Date(now() + 10_000).toISOString());
  assert.deepEqual(renewed.presentation.lastTransition, firstTransition);
});

test('a second dashboard tab cannot take over an unexpired claim', () => {
  const { controller, advance } = controllerAt();
  controller.claimPresentation({ owner: 'tab-one-1234' });
  advance(2_000);
  assert.throws(
    () => controller.claimPresentation({ owner: 'tab-two-5678' }),
    (error) => error.code === 'PRESENTATION_OWNED',
  );
  assert.equal(controller.snapshot().presentation.owner, 'tab-one-1234');
  // Once the lease dies, the stale claim is replaced without an error.
  advance(PRESENTATION_LEASE_DEFAULT_MS);
  const taken = controller.claimPresentation({ owner: 'tab-two-5678' });
  assert.equal(taken.presentation.owner, 'tab-two-5678');
});

test('claim payloads validate owner ids and lease bounds', () => {
  assert.equal(isValidPresentationClaimPayload({ owner: 'tab-one-1234' }), true);
  assert.equal(isValidPresentationClaimPayload({ owner: 'tab-one-1234', ttlMs: 30_000 }), true);
  assert.equal(isValidPresentationClaimPayload({}), false);
  assert.equal(isValidPresentationClaimPayload({ owner: 'short' }), false);
  assert.equal(isValidPresentationClaimPayload({ owner: 'bad owner id' }), false);
  assert.equal(isValidPresentationClaimPayload({ owner: 'tab-one-1234', ttlMs: 1 }), false);
  assert.equal(isValidPresentationClaimPayload({ owner: 'tab-one-1234', ttlMs: 999_999_999 }), false);
  assert.equal(isValidPresentationClaimPayload({ owner: 'tab-one-1234', extra: true }), false);
  assert.equal(isValidPresentationReleasePayload({}), true);
  assert.equal(isValidPresentationReleasePayload({ owner: 'tab-one-1234' }), true);
  assert.equal(isValidPresentationReleasePayload({ owner: 'x' }), false);
  assert.equal(isValidPresentationReleasePayload({ owner: 'tab-one-1234', extra: 1 }), false);
});

test('an unclaimed transfer expires back to the desktop on the next tick', () => {
  const { controller, advance } = controllerAt();
  controller.transferToDashboard({ reason: 'sent' });
  const pending = controller.snapshot().presentation;
  assert.equal(pending.mode, 'dashboard');
  assert.equal(pending.owner, null);
  assert.equal(pending.pending, true);
  // Not yet expired: the tick must not fire early.
  advance(PRESENTATION_CLAIM_GRACE_MS - 1);
  assert.equal(controller.tickPresentation(), null);
  assert.equal(controller.snapshot().presentation.mode, 'dashboard');
  // Grace period over, no dashboard tab claimed: restore desktop.
  advance(2);
  const restored = controller.tickPresentation();
  assert.equal(restored.presentation.mode, 'desktop');
  assert.equal(restored.presentation.owner, null);
  assert.equal(restored.presentation.lastTransition.reason, 'unclaimed');
  assert.equal(desktopWindowVisible(restored), true);
});

test('an abandoned dashboard claim expires and restores desktop presentation', () => {
  const { controller, advance } = controllerAt();
  controller.claimPresentation({ owner: 'tab-one-1234', ttlMs: 5_000 });
  advance(4_999);
  assert.equal(controller.tickPresentation(), null);
  advance(2);
  const restored = controller.tickPresentation();
  assert.equal(restored.presentation.mode, 'desktop');
  assert.equal(restored.presentation.lastTransition.reason, 'lease_expired');
  assert.equal(restored.presentation.owner, null);
  // Honest error only when the desktop host is also down.
  assert.equal(restored.presentation.error, null);
  controller.claimPresentation({ owner: 'tab-one-1234', ttlMs: 5_000 });
  advance(5_001);
  const offline = controller.tickPresentation({ hostRunning: false });
  assert.match(offline.presentation.error, /host is not running/i);
});

test('releasing returns presentation to the desktop and only the owner may release', () => {
  const { controller } = controllerAt();
  controller.claimPresentation({ owner: 'tab-one-1234' });
  assert.throws(
    () => controller.releasePresentation({ owner: 'tab-two-5678' }),
    (error) => error.code === 'PRESENTATION_OWNED',
  );
  const released = controller.releasePresentation({ owner: 'tab-one-1234' });
  assert.equal(released.presentation.mode, 'desktop');
  assert.equal(released.presentation.owner, null);
  assert.equal(released.presentation.lastTransition.reason, 'released');
  assert.equal(desktopWindowVisible(released), true);
});

test('a stale host transfer cannot kick an active dashboard owner', () => {
  const { controller, advance } = controllerAt();
  controller.claimPresentation({ owner: 'tab-one-1234', ttlMs: 20_000 });
  const before = controller.snapshot().presentation;
  advance(1_000);
  const after = controller.transferToDashboard({ reason: 'sent' });
  assert.deepEqual(after.presentation, before);
});

test('hide hands presentation to the dashboard while summon undoes an unclaimed transfer', () => {
  const { controller, advance } = controllerAt();
  const hidden = controller.command('hide');
  assert.equal(hidden.visible, false);
  assert.equal(hidden.presentation.mode, 'dashboard');
  assert.equal(hidden.presentation.pending, true);
  assert.equal(hidden.presentation.lastTransition.reason, 'hidden');
  // Summon before any dashboard claims: transfer undone, pet visible on desktop.
  const shown = controller.command('show');
  assert.equal(shown.visible, true);
  assert.equal(shown.presentation.mode, 'desktop');
  assert.equal(shown.presentation.lastTransition.reason, 'shown');
  // Hide again, let the grace period lapse: mode returns to desktop but the
  // pet stays hidden (the user's hide intent is preserved).
  controller.command('hide');
  advance(PRESENTATION_CLAIM_GRACE_MS + 1);
  const restored = controller.tickPresentation();
  assert.equal(restored.presentation.mode, 'desktop');
  assert.equal(restored.visible, false);
});

test('summoning while a dashboard holds the claim keeps presentation there', () => {
  const { controller } = controllerAt();
  controller.claimPresentation({ owner: 'tab-one-1234' });
  const shown = controller.command('show');
  assert.equal(shown.visible, true);
  assert.equal(shown.presentation.mode, 'dashboard');
  assert.equal(shown.presentation.owner, 'tab-one-1234');
  assert.equal(desktopWindowVisible(shown), false);
});

test('the desktop window visibility helper separates both flags', () => {
  assert.equal(desktopWindowVisible({ visible: true, presentation: { mode: 'desktop' } }), true);
  assert.equal(desktopWindowVisible({ visible: false, presentation: { mode: 'desktop' } }), false);
  assert.equal(desktopWindowVisible({ visible: true, presentation: { mode: 'dashboard' } }), false);
  assert.equal(desktopWindowVisible(null), false);
  assert.equal(desktopWindowVisible({ visible: true }), true); // legacy snapshots
});

test('claim grace constant keeps transfers bounded', () => {
  assert.ok(PRESENTATION_CLAIM_GRACE_MS >= 5_000 && PRESENTATION_CLAIM_GRACE_MS <= 60_000);
});
