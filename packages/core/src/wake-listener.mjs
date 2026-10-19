/**
 * Wake-word listener: bridges microphone PCM frames into the detector.
 *
 * Feeds live s16le mono @ 16kHz from a `mic-session` into a detector
 * (Porcupine or test fake) with a cooldown so one "Yo Spark" doesn't fire
 * multiple times. On detection it stops the mic session and calls the
 * `onDetect` callback; the caller decides the next state (utterance capture,
 * PTT, etc.).
 */
import { MIC_SAMPLE_RATE } from './mic-session.mjs';

export function createWakeListener({
  createDetector,
  mic,
  onDetect,
  cooldownMs = 3000,
  maxSessionMs = 3_600_000, // 1 hour continuous armed listening
} = {}) {
  let detector = null;
  let armed = false;
  let lastDetectAt = 0;
  let frameBuffer = Buffer.alloc(0);
  let micSessionId = null;
  let disposeMic = null;

  async function start() {
    if (armed) return;
    detector = createDetector();
    armed = true;
    lastDetectAt = 0;
    frameBuffer = Buffer.alloc(0);

    const { id, done } = await mic.start({
      device: null, // default
      durationMs: maxSessionMs,
      label: 'wake',
      onAudio: (chunk) => {
        if (!armed) return;
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
        while (frameBuffer.length >= detector.frameLength * 2) {
          const frame = Buffer.alloc(detector.frameLength * 2);
          frameBuffer.copy(frame, 0, 0, frame.length);
          frameBuffer = frameBuffer.slice(frame.length);
          const floats = new Float32Array(detector.frameLength);
          for (let i = 0; i < detector.frameLength; i += 1) {
            floats[i] = frame.readInt16LE(i * 2) / 32768;
          }
          try {
            const hit = detector.process(floats);
            if (hit && Date.now() - lastDetectAt > cooldownMs) {
              lastDetectAt = Date.now();
              armed = false;
              onDetect();
              break;
            }
          } catch (error) {
            onDetect(error);
            break;
          }
        }
      },
    });
    micSessionId = id;
    disposeMic = () => mic.stop('wake-cancel');
    return done;
  }

  function stop() {
    if (!armed) return;
    armed = false;
    if (disposeMic) {
      disposeMic();
      disposeMic = null;
    }
    micSessionId = null;
  }

  return {
    start,
    stop,
    isArmed() { return armed; },
  };
}