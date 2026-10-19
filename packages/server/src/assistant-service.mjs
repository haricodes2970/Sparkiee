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
  stt = null, // optional { transcribe({pcm}), cancel() } — commit-3 pipeline
  runIntent = null, // optional async (text) => {handled, reply, executed, ...}
  setIntervalImpl = (fn, ms) => { const t = setInterval(fn, ms); t?.unref?.(); return t; },
  clearIntervalImpl = (id) => clearInterval(id),
  speechRmsThreshold = 500,
  minUtteranceBytes = 3200, // <100 ms of 16 kHz s16le is noise, not speech
} = {}) {
  let wakeProbeCached = null;
  let wakeProbeAt = 0;
  const WAKE_PROBE_TTL = 5000;

  const controller = createAssistantController({ now });
  const mic = micSessionManager ?? createMicSessionManager({ now });

  let wakeListener = null;
  let listeningEnabled = false;
  let armedBeforePtt = false;

  // Transcript pipeline (capture buffer stays in RAM only).
  let executor = null; // attached by the server: {transcribe, cancelTranscribe, runText}
  let capture = null; // {buffer, watchdogId, speechSeen, lastLoudAt, silenceMs, settled, result}
  function rmsOf(chunk) {
    if (!chunk || chunk.length < 2) return 0;
    let sum = 0;
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i);
      sum += sample * sample;
    }
    const n = Math.floor(chunk.length / 2);
    return n > 0 ? Math.round(Math.sqrt(sum / n)) : 0;
  }
  function stopWatchdog() {
    if (capture?.watchdogId !== undefined && capture?.watchdogId !== null) {
      try { clearIntervalImpl(capture.watchdogId); } catch { /* already gone */ }
    }
  }

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

  async function startPtt({ silenceMs = 1200, durationMs = 15000 } = {}) {
    if (mic.active()) {
      throw Object.assign(new Error('MIC_BUSY'), { code: 'MIC_BUSY' });
    }
    armedBeforePtt = controller.snapshot().state === 'armed';
    const utterance = { buffer: [], speechSeen: false, lastLoudAt: now(), silenceMs, settled: false, result: null, watchdogId: null };
    capture = utterance;
    const { id, done } = await mic.start({
      durationMs,
      label: 'ptt',
      onAudio: (chunk) => {
        if (!capture || capture !== utterance) return;
        utterance.buffer.push(chunk);
        if (rmsOf(chunk) > speechRmsThreshold) {
          utterance.speechSeen = true;
          utterance.lastLoudAt = now();
        }
      },
    });
    // Silence watchdog: speech followed by sustained silence auto-submits.
    utterance.watchdogId = setIntervalImpl(() => {
      if (!capture || capture !== utterance || utterance.settled) return;
      if (!utterance.speechSeen) return;
      if (now() - utterance.lastLoudAt < utterance.silenceMs) return;
      if (!mic.active() || controller.snapshot().state !== 'listening') return;
      utterance.settled = true;
      stopWatchdog();
      submitCapturedUtterance(utterance, 'ptt-silence-submit').catch(() => {});
    }, 250);
    // Natural expiry (max-duration) without a manual stop must still move
    // state honestly back to armed/disabled — a stuck "listening" is a lie.
    done.then((summary) => {
      const snap = controller.snapshot();
      if (snap.state !== 'listening' || utterance.settled) return;
      utterance.settled = true;
      if (capture === utterance) { stopWatchdog(); capture = null; }
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
        note: 'captured (transcription pending) — session expired at max duration and was NOT submitted',
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

  /** Server-side executor hooks (music router + local STT). */
  function attachExecutor(next) {
    executor = {
      transcribe: typeof next?.transcribe === 'function' ? next.transcribe : null,
      cancelTranscribe: typeof next?.cancelTranscribe === 'function' ? next.cancelTranscribe : null,
      runText: typeof next?.runText === 'function' ? next.runText : null,
    };
    return executor;
  }

  /**
   * Submit the current capture: local STT on the RAM-only buffer, then route
   * the transcript through the existing music command router. The buffer is
   * never written to disk and is dropped immediately after transcription.
   */
  async function submitCapturedUtterance(utterance, reason, summary = null) {
    const target = (listeningEnabled && armedBeforePtt) ? 'armed' : 'disabled';
    // The watchdog path still has an active parec child: stop it here first.
    const micSummary = summary ?? (mic.active() ? mic.stop(reason) : null);
    const finish = async (out) => {
      if (capture === utterance) { stopWatchdog(); capture = null; }
      controller.setMicActive(false, { reason });
      try { controller.transition(target, { reason: 'ptt-pipeline-done' }); } catch {
        try { controller.transition('disabled', { reason: 'ptt-pipeline-done' }); } catch { /* error state or already there */ }
      }
      utterance.settled = true;
      utterance.result = out;
      if (out && out.capture === null && micSummary) out.capture = micSummary;
      const waiters = utterance.resultWaiters ?? [];
      utterance.resultWaiters = [];
      for (const w of waiters) w(out);
      return out;
    };
    try { controller.transition('transcribing', { reason }); } catch {
      // State moved away (expiry handler / double stop): do not fake progress.
      return finish({
        capture: null, transcript: null, handled: false, executed: false,
        reply: 'Recording ended before transcription could start.', speech: null, error: false, intent: null,
      });
    }
    const bytes = utterance.buffer.length ? Buffer.concat(utterance.buffer) : null;
    utterance.buffer = []; // drop the raw audio ASAP
    const effectiveTranscribe = stt?.transcribe ?? executor?.transcribe;
    const effectiveRunText = runIntent ?? executor?.runText;

    if (!bytes || bytes.length < minUtteranceBytes || !effectiveTranscribe) {
      const out = {
        capture: null, transcript: null, handled: false, executed: false, intent: null,
        reply: !effectiveTranscribe
          ? 'Captured your request, but speech recognition is not set up yet, so nothing was transcribed.'
          : "I didn't hear anything I could recognise.",
        speech: null, error: false,
      };
      try { controller.transition('interpreting', { reason: 'ptt-empty-capture' }); } catch {}
      controller.recordAction({
        kind: 'ptt', durationMs: 0, bytes: bytes?.length ?? 0,
        note: !effectiveTranscribe ? 'captured — STT not attached' : 'captured — audio too short, discarded',
      });
      return finish(out);
    }

    // Sanitise the state check before deep transitions.
    let sttOut = null;
    let sttFailed = false;
    try {
      sttOut = await effectiveTranscribe({ pcm: bytes, sampleRate: 16000 });
    } catch (error) {
      sttFailed = true;
      controller.recordAction({ kind: 'ptt', error: 'stt', note: error?.message?.slice(0, 120) ?? 'stt failed' });
    }
    const text = !sttFailed && sttOut?.status === 'ok' && typeof sttOut.text === 'string' ? sttOut.text.trim() : null;

    if (!text) {
      try { controller.transition('interpreting', { reason: 'ptt-stt-no-speech' }); } catch { /* fallthrough */ }
      const status = sttOut?.status ?? 'unknown';
      const reply = sttFailed || status === 'error'
        ? 'Transcription failed, so I did not catch that request.'
        : status === 'unavailable'
          ? 'Local speech recognition is not set up yet, so nothing was transcribed. Run the STT setup step first.'
          : "I didn't hear anything I could recognise.";
      controller.recordAction({
        kind: 'ptt',
        transcript: null,
        bytes: micSummary?.bytes ?? 0,
        note: sttFailed ? 'STT threw' : `STT status ${status}`,
      });
      return finish({
        capture: micSummary, transcript: null, handled: false, executed: false, intent: null,
        reply, speech: null, error: sttFailed || status === 'error' || status === 'unavailable',
      });
    }

    try { controller.transition('interpreting', { reason: 'transcript-ready' }); } catch { /* stay honest */ }

    if (!effectiveRunText) {
      controller.recordAction({ kind: 'ptt', transcript: text, note: 'captured — no command router attached' });
      return finish({
        capture: null, transcript: text, handled: false, executed: false, intent: null,
        reply: `I heard: “${text}” — but no command router is attached.`, speech: null, error: false,
      });
    }

    let out;
    try { out = await effectiveRunText(text); } catch (error) {
      const reply = `I heard “${text}” but the command failed.`;
      controller.recordAction({ kind: 'ptt', transcript: text, error: 'router', note: error?.message?.slice(0, 120) ?? 'router failed' });
      return finish({
        capture: null, transcript: text, handled: false, executed: false, intent: null,
        reply, speech: null, error: true,
      });
    }
    try { controller.transition('executing', { reason: 'intent-executed' }); } catch { /* stay honest */ }
    controller.recordAction({
      kind: 'ptt',
      transcript: text,
      intent: out?.intent ?? null,
      reply: out?.reply ?? null,
      executed: Boolean(out?.executed),
    });
    const speech = out?.speech ?? null;
    if (speech) {
      try { controller.transition('speaking', { reason: 'assistant-speech' }); } catch { /* stay honest */ }
    }
    return finish({
      capture: null,
      transcript: text,
      handled: Boolean(out?.handled),
      executed: Boolean(out?.executed),
      intent: out?.intent ?? null,
      reply: out?.reply ?? null,
      speech,
      error: false,
    });
  }

  async function stopPtt() {
    // Silence watchdog may already be submitting: attach to the same result.
    if (capture?.settled && capture?.result) return capture.result;
    if (capture?.settled) {
      // Submission in flight — wait for the same promise rather than double-running.
      return new Promise((resolve) => { capture.resultWaiters = capture.resultWaiters ?? []; capture.resultWaiters.push(resolve); });
    }
    const summary = mic.stop('ptt-stopped');
    if (capture) capture.summary = summary;
    const pending = masterSubmit(capture, 'ptt-stopped', summary);
    if (pending) return pending;
    // Legacy path (no transcript pipeline): keep the old honest behaviour.
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

  function masterSubmit(utterance, reason, summary = null) {
    if (!utterance || utterance.submitted || !(stt || executor?.transcribe)) return null;
    utterance.submitted = true;
    return submitCapturedUtterance(utterance, reason, summary).catch((error) => ({
      capture: null, transcript: null, handled: false, executed: false, intent: null,
      reply: `Transcription pipeline failed: ${error?.message?.slice(0, 100) ?? 'unknown error'}`,
      speech: null, error: true,
    }));
  }

  /** Explicit cancel: discard the utterance without transcribing or executing. */
  async function cancelPtt() {
    stopWatchdog();
    if (capture) { capture.settled = true; capture.summary = null; }
    const summary = mic.stop('ptt-cancelled');
    if (capture) capture.buffer = [];
    capture = null;
    controller.setMicActive(false, { reason: 'ptt-cancelled' });
    const targetState = (listeningEnabled && armedBeforePtt) ? 'armed' : 'disabled';
    try {
      if (controller.snapshot().state !== targetState) {
        controller.transition(targetState, { reason: 'ptt-cancelled' });
      }
    } catch { /* already reset by expiry path */ }
    controller.recordAction({
      kind: 'ptt-cancelled',
      durationMs: summary?.durationMs ?? 0,
      note: 'utterance discarded — nothing transcribed or executed',
    });
    return { cancelled: true, capture: summary };
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
    cancelPtt,
    attachExecutor,
    runDiagnostic,
    recordAction,
    dispose,
    getWakeSetup,
    // test hooks
    _controller: controller,
    _mic: mic,
  };
}