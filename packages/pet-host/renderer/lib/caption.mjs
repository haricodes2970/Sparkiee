/**
 * Subtitle controller for the caption box beneath the pet.
 *
 * Captions are independent of audio: they still render when the engine is
 * muted, and they hide when the user disables them. Timer functions are
 * injectable so the visibility contract is testable without a browser.
 *
 * Browser-safe: no Node.js imports.
 */

const MAX_CAPTION_LENGTH = 180;

/**
 * @param {object} deps
 * @param {Element} deps.box Caption box element (classes: visible, large, caption-bump).
 * @param {Element} deps.text Text element inside the box.
 * @param {(fn: Function, ms: number) => any} [deps.setTimer]
 * @param {(id: any) => void} [deps.clearTimer]
 */
export function createCaptionController({
  box,
  text,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let settings = { enabled: true, durationMs: 2600, large: false };
  let timer = null;

  function clearTimerNow() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    setSettings(partial) {
      if (partial && typeof partial === 'object') {
        if (typeof partial.enabled === 'boolean') settings.enabled = partial.enabled;
        if (Number.isInteger(partial.durationMs) && partial.durationMs > 0) {
          settings.durationMs = partial.durationMs;
        }
        if (typeof partial.large === 'boolean') settings.large = partial.large;
      }
      box.classList.toggle('large', settings.large);
      if (!settings.enabled) {
        clearTimerNow();
        box.classList.remove('visible');
      }
      return { ...settings };
    },
    getSettings() {
      return { ...settings };
    },
    /**
     * Show a caption for `ms` (or the configured duration). Returns true
     * when the caption became visible.
     */
    show(caption, { ms = null } = {}) {
      box.classList.toggle('large', settings.large);
      if (!settings.enabled) {
        clearTimerNow();
        box.classList.remove('visible');
        return false;
      }
      const value = String(caption ?? '').slice(0, MAX_CAPTION_LENGTH);
      if (text.textContent !== value) {
        text.textContent = value;
        box.classList.remove('caption-bump');
        void box.offsetWidth; // restart the pop animation
        box.classList.add('caption-bump');
      }
      box.classList.add('visible');
      clearTimerNow();
      const duration = ms ?? settings.durationMs;
      if (duration > 0) {
        timer = setTimer(() => {
          box.classList.remove('visible');
          timer = null;
        }, duration);
      }
      return true;
    },
    hide() {
      clearTimerNow();
      box.classList.remove('visible');
    },
    isVisible() {
      return box.classList.contains('visible');
    },
    dispose() {
      clearTimerNow();
    },
  };
}
