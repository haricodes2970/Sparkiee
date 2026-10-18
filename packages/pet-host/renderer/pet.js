const root = document.querySelector('#pet-root');
const spriteEl = document.querySelector('#pet-sprite');
const statusText = document.querySelector('#pet-status');
const captionBox = document.querySelector('#caption-box');
const captionText = document.querySelector('#caption-text');
const connectionDot = document.querySelector('#connection-dot');
const errorText = document.querySelector('#pet-error');
const petButton = document.querySelector('#pet-button');
let currentState = null;
let currentPack = null;
let pointerStart = null;
let dragged = false;

// ---------------------------------------------------------------------------
// Sprite frame player: swaps background-position on a pixelated sheet.
// Looping animations run until replaced; one-shot animations play once and
// then fall back to idle frames while the state label stays put.
// ---------------------------------------------------------------------------

const spritePlayer = (() => {
  let timer = null;
  let playing = null;

  function showFrame(pack, frameIndex) {
    const { frameWidth, frameHeight, columns } = pack.sprite;
    spriteEl.style.width = `${frameWidth * pack.layout.spriteScale}px`;
    spriteEl.style.height = `${frameHeight * pack.layout.spriteScale}px`;
    spriteEl.style.backgroundImage = `url("${pack.sprite.url}")`;
    spriteEl.style.backgroundSize = `${frameWidth * columns * pack.layout.spriteScale}px auto`;
    spriteEl.style.backgroundPosition =
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
      spriteEl.classList.remove('loading');
      playing = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
      play(pack, currentState?.animation || 'idle', { fallbackToIdle: false });
    },
    play,
    animation() {
      return playing;
    },
  };
})();

spriteEl.classList.add('loading');

// ---------------------------------------------------------------------------
// State application
// ---------------------------------------------------------------------------

function applyState(state) {
  if (!state || typeof state !== 'object') return;
  const previous = currentState;
  currentState = state;
  statusText.textContent = String(state.label || 'Hanging out').toLowerCase().slice(0, 40);
  connectionDot.classList.toggle('disconnected', state.hostConnected !== true);
  document.querySelector('#pet-name').textContent = String(state.characterName || 'sparkiee').slice(0, 32).toLowerCase();
  if (state.visible === false) root.dataset.hidden = 'true';
  else delete root.dataset.hidden;

  const caption = String(state.message || '').slice(0, 180);
  if (captionText.textContent !== caption) {
    captionText.textContent = caption;
    captionBox.classList.remove('caption-bump');
    void captionBox.offsetWidth; // restart the pop animation
    captionBox.classList.add('caption-bump');
  }
  captionBox.classList.add('visible');

  if (currentPack) {
    const animation = currentPack.animations[state.animation] ? state.animation : 'idle';
    spritePlayer.play(currentPack, animation);
    if (previous && previous.animation !== state.animation) {
      window.dispatchEvent(new CustomEvent('sparkiee:animation-changed', { detail: { from: previous.animation, to: state.animation } }));
    }
  }
}

async function command(name) {
  errorText.textContent = '';
  try {
    applyState(await window.sparkieePet.command(name));
  } catch {
    errorText.textContent = 'Cannot reach Sparkiee right now.';
    errorText.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Pack loading (manifest summary pushed by the Electron main process)
// ---------------------------------------------------------------------------

function applyPack(pack) {
  if (!pack || typeof pack !== 'object' || !pack.sprite || !pack.animations) return;
  currentPack = pack;
  spritePlayer.load(pack);
}
window.sparkieePet.onPack(applyPack);
window.sparkieePet.getPack().then(applyPack).catch(() => {});

// ---------------------------------------------------------------------------
// Drag + click interactions
// ---------------------------------------------------------------------------

petButton.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  pointerStart = { x: event.screenX, y: event.screenY, id: event.pointerId };
  dragged = false;
  petButton.setPointerCapture(event.pointerId);
  window.sparkieePet.startDrag({ screenX: event.screenX, screenY: event.screenY });
});
petButton.addEventListener('pointermove', (event) => {
  if (!pointerStart || event.pointerId !== pointerStart.id) return;
  if (Math.abs(event.screenX - pointerStart.x) + Math.abs(event.screenY - pointerStart.y) > 5) dragged = true;
  window.sparkieePet.moveDrag({ screenX: event.screenX, screenY: event.screenY });
});
function finishDrag(event) {
  if (!pointerStart || event.pointerId !== pointerStart.id) return;
  window.sparkieePet.endDrag();
  pointerStart = null;
  window.requestAnimationFrame(() => { dragged = false; });
}
petButton.addEventListener('pointerup', finishDrag);
petButton.addEventListener('pointercancel', finishDrag);
petButton.addEventListener('click', () => {
  if (dragged) return;
  void command('wave');
});

window.sparkieePet.onState(applyState);
window.sparkieePet.getState().then(applyState).catch(() => {});
