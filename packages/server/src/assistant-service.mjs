/**
 * Server-side assistant orchestration — state machine + mic + wake + PTT.
 *
 * This is the single source of truth for the assistant's runtime status.
 * The HTTP handlers only gate auth and forward calls here.
 */
import { createAssistantController } from '../../core/src/assistant-state.mjs';
import { createMicSessionManager } from '../../core/src/mic-session.mjs';
import { createWakeListener } from '../../core/src/wake-listener.mjs';
import { probeWakeWordSetup } from '../../core/src/wake-word.mjs';

export function createAssistantService({
  now = () => Date.now(),
  wakeProbe = probeWakeWordSetup,
  createDetector = null, // injected for tests; real lazy-required in default
  micSessionManager = null, // injected for tests
} = {}) {
  let wakeProbeCached = null;
  let wakeProbeAt = 0;
  const WAKE_PROBE_TTL = 5000;

  const controller = createAssistantController({ now });
  const mic = micSessionManager ?? createMicSessionManager({ now });

  let wakeListener = null;
  let listeningEnabled = false;
  let armedBeforePtt = false;

  async function getWakeSetup() {
    if (wakeProbeCached && now() - wakeProbeAt < WAKE_PROBE_TTL) return wakeProbeCached;
    wakeProbeCached = await wakeProbe();
    wakeProbeAt = now();
    return wakeProbeCached;
  }

  async function startWakeListener() {
    const setup = await getWakeSetup();
    if (setup.status !== 'ready') return { started: false, setup };
    if (!createDetector) {
      // Real Porcupine — lazy require; _internals only present when ready.
      const { createDetector: realCreate } = await import('../../core/src/wake-word.mjs');
      const PorcupineModule = await import('@picovoice/porcupine-node');
      createDetector = ({ accessKey, keywordPath }) => realCreate({
        Porcupine: PorcupineModule.default,
        accessKey,
        keywordPath,
      });
    }
    const internals = setup._internals;
    if (!internals) return { started: false, setup };

    const detectorFactory = () => createDetector(internals);
    wakeListener = createWakeListener({
      createDetector: detectorFactory,
      mic,
      onDetect: onWakeDetected,
    });
    const done = await wakeListener.start();
    controller.transition('armed', { reason: 'wake-listening-started' });
    return { started: true, done, setup };
  }

  async function stopWakeListener() {
    if (wakeListener) {
      wakeListener.stop();
      wakeListener = null;
    }
    listeningEnabled = false;
    const snap = controller.snapshot();
    if (snap.state !== 'disabled') {
      controller.transition('disabled', { reason: 'wake-listening-stopped' });
    }
  }

  async function onWakeDetected(error) {
    if (error) {
      controller.fail(`Wake detection error: ${error?.message ?? error}`);
      return;
    }
    // Wake detected → enter wake_detected, then capture a bounded utterance.
    controller.transition('wake_detected', { reason: 'wake-word-detected' });
    // Utterance capture: bounded by silence or 8s max.
    await captureUtterance();
  }

  async function captureUtterance() {
    if (controller.snapshot().state !== 'wake_detected') return;
    controller.transition('listening', { reason: 'capturing-utterance' });

    const { id, done } = await mic.start({
      device: null,
      durationMs: 8000,
      label: 'utterance',
      onAudio: null, // silence detection on chunks below (via levels in summary)
    });

    const summary = await done;
    // Silence detection: avgRms < ~500 (ambient) for sustained period.
    // The done promise resolves when max-duration or manual stop; here we
    // always use max-duration since we don't have real-time RMS streaming.
    // Commit 6 will add per-chunk RMS + silence detection.
    const wasWake = controller.snapshot().state === 'listening';
    if (wasWake) {
      controller.transition('armed', { reason: 'utterance-captured' });
    }
    controller.recordAction({
      kind: 'wake-capture',
      durationMs: summary.durationMs,
      bytes: summary.bytes,
      peakRms: summary.peakRms,
      avgRms: summary.avgRms,
      note: 'captured — transcription arrives with speech recognition setup',
    });
  }

  async function startPtt() {
    if (mic.active()) {
      throw Object.assign(new Error('MIC_BUSY'), { code: 'MIC_BUSY' });
    }
    armedBeforePtt = controller.snapshot().state === 'armed';
    const { id, done } = await mic.start({
      durationMs: 15000,
      label: 'ptt',
      onAudio: null,
    });
    // Natural expiry (max-duration) without a manual stop must still move
    // state honestly back to armed/disabled — a stuck "listening" is a lie.
    done.then((summary) => {
      const snap = controller.snapshot();
      if (snap.state !== 'listening') return;
      const target = (listeningEnabled && armedBeforePtt) ? 'armed' : 'disabled';
      try {
        controller.transition(target, { reason: 'ptt-max-duration' });
      } catch {
        try { controller.transition('disabled', { reason: 'ptt-max-duration' }); } catch {}
      }
      controller.setMicActive(false, { reason: 'ptt-max-duration' });
      controller.recordAction({
        kind: 'ptt',
        durationMs: summary?.durationMs ?? 0,
        bytes: summary?.bytes ?? 0,
        peakRms: summary?.peakRms ?? 0,
        avgRms: summary?.avgRms ?? 0,
        note: 'captured (transcription pending speech recognition) — session expired at max duration',
      });
    }).catch(() => {});
    if (controller.snapshot().state === 'listening') {
      // Stale listening state — previous session just expired between checks.
      // The mic check passed because no parec child is running anymore.
      try { controller.transition('disabled', { reason: 'ptt-stale-state-recovered' }); } catch {}
      if (controller.snapshot().state === 'listening') {
        try { mic.stop('ptt-stale-clear'); } catch {}
      }
    }
    controller.transition('listening', { reason: 'ptt-started' });
    controller.setMicActive(true, { reason: 'ptt-started' });
    return { sessionId: id, done };
  }

  async function stopPtt() {
    const summary = mic.stop('ptt-stopped');
    controller.setMicActive(false, { reason: 'ptt-stopped' });
    const targetState = (listeningEnabled && armedBeforePtt) ? 'armed' : 'disabled';
    if (controller.snapshot().state !== targetState) {
      controller.transition(targetState, { reason: 'ptt-stopped' });
    }
    controller.recordAction({
      kind: 'ptt',
      durationMs: summary?.durationMs ?? 0,
      bytes: summary?.bytes ?? 0,
      peakRms: summary?.peakRms ?? 0,
      avgRms: summary?.avgRms ?? 0,
      note: 'captured — transcription arrives with speech recognition setup',
    });
    return summary;
  }

  async function runDiagnostic() {
    const { id, done } = await mic.start({
      durationMs: 2000,
      label: 'diagnostic',
      onAudio: null,
    });
    const summary = await done;
    return {
      ok: summary?.bytes > 0 && !summary.error,
      peakRms: summary?.peakRms ?? 0,
      avgRms: summary?.avgRms ?? 0,
      durationMs: summary?.durationMs ?? 0,
      bytes: summary?.bytes ?? 0,
      error: summary?.error ?? null,
    };
  }

  async function setListening(enabled) {
    if (enabled) {
      const { started, setup } = await startWakeListener();
      if (!started) {
        throw Object.assign(new Error('WAKE_NEEDS_SETUP'), { code: 'WAKE_NEEDS_SETUP', setup });
      }
      listeningEnabled = true;
    } else {
      await stopWakeListener();
    }
    return controller.snapshot();
  }

  async function status() {
    const snap = controller.snapshot();
    const activeMic = mic.active();
    const probe = await getWakeSetup();
    // Never expose the AccessKey or path: the public status gets a
    // de-identified wake view. `_internals` carries the key so it MUST be
    // stripped before any response body is built from this.
    const wake = probe && probe._internals ? { ...probe, _internals: undefined } : probe;
    delete wake._internals;
    return {
      state: snap.state,
      since: snap.since,
      micActive: snap.micActive,
      listening: snap.listening,
      cancellable: snap.cancellable,
      wake,
      mic: {
        devices: [], // filled lazily by HTTP handler with cached list
        active: activeMic ? { id: activeMic.id, label: activeMic.label, device: activeMic.device, startedAt: activeMic.startedAt, elapsedMs: activeMic.elapsedMs } : null,
      },
      lastAction: snap.lastAction,
      lastError: snap.lastError,
      history: snap.history,
    };
  }

  function recordAction(action) {
    controller.recordAction(action);
  }

  function dispose() {
    mic.dispose();
    if (wakeListener) wakeListener.stop();
  }

  return {
    status,
    setListening,
    startPtt,
    stopPtt,
    runDiagnostic,
    recordAction,
    dispose,
    getWakeSetup,
    // test hooks
    _controller: controller,
    _mic: mic,
  };
}