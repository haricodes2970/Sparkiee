/**
 * Shared sprite frame player for every Sparkiee surface (desktop pet
 * window and dashboard habitat). One implementation of the frame maths:
 * swaps background-position on a pixelated sheet, looping animations run
 * until replaced, one-shot animations play once and fall back to idle
 * frames while the state label stays put.
 *
 * Browser-safe: no Node.js imports. The sprite element and the current
 * state animation getter are injected so both renderers share the module.
 */

/**
 * @param {{element: HTMLElement, getAnimation?: () => string}} options
 *   element: the div that shows the sprite (background-position target).
 *   getAnimation: returns the current state animation id (defaults to idle).
 */
export function createFramePlayer({ element, getAnimation = () => 'idle' }) {
  if (!element || typeof element.style !== 'object') {
    throw new Error('createFramePlayer requires a DOM element.');
  }
  let timer = null;
  let playing = null;

  function showFrame(pack, frameIndex) {
    const { frameWidth, frameHeight, columns } = pack.sprite;
    element.style.width = `${frameWidth * pack.layout.spriteScale}px`;
    element.style.height = `${frameHeight * pack.layout.spriteScale}px`;
    element.style.backgroundImage = `url("${pack.sprite.url}")`;
    element.style.backgroundSize = `${frameWidth * columns * pack.layout.spriteScale}px auto`;
    element.style.backgroundPosition =
      `${-(frameIndex % columns) * frameWidth * pack.layout.spriteScale}px ` +
      `${-Math.floor(frameIndex / columns) * frameHeight * pack.layout.spriteScale}px`;
  }

  function play(pack, animationId, { fallbackToIdle = true } = {}) {
    const animation = pack.animations[animationId] || pack.animations.idle;
    if (playing === animationId && timer !== null) return;
    playing = animationId;
    if (timer !== null) clearInterval(timer);
    timer = null;
    let step = 0;
    showFrame(pack, animation.frames[0]);
    if (animation.frames.length === 1 && !animation.loop) return;
    timer = setInterval(() => {
      step += 1;
      if (step >= animation.frames.length) {
        if (animation.loop) {
          step = 0;
        } else {
          clearInterval(timer);
          timer = null;
          playing = null;
          if (fallbackToIdle && pack.animations.idle) {
            play(pack, 'idle', { fallbackToIdle: false });
          }
          return;
        }
      }
      showFrame(pack, animation.frames[step]);
    }, animation.frameMs);
  }

  return {
    load(pack) {
      element.classList.remove('loading');
      playing = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
      const current = getAnimation();
      play(pack, pack.animations[current] ? current : 'idle', { fallbackToIdle: false });
    },
    play,
    animation() {
      return playing;
    },
    dispose() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      playing = null;
    },
  };
}
