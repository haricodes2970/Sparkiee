const root = document.querySelector('#pet-root');
const bubble = document.querySelector('#speech-bubble');
const statusText = document.querySelector('#bubble-status');
const messageText = document.querySelector('#bubble-message');
const connectionDot = document.querySelector('#connection-dot');
const errorText = document.querySelector('#pet-error');
const petButton = document.querySelector('#pet-button');
const commandButtons = document.querySelectorAll('[data-command]');
let currentState;
let pointerStart = null;
let dragged = false;

const ANIMATIONS = new Set(['idle', 'walk', 'run', 'dance', 'sleep', 'celebrate', 'wave', 'surprised']);

function applyState(state) {
  if (!state || typeof state !== 'object') return;
  currentState = state;
  root.classList.remove(...[...ANIMATIONS].map((item) => `animation-${item}`));
  const animation = ANIMATIONS.has(state.animation) ? state.animation : 'idle';
  root.classList.add(`animation-${animation}`);
  statusText.textContent = String(state.label || 'Hanging out').slice(0, 80);
  messageText.textContent = String(state.message || 'Hey there, developer!').slice(0, 180);
  connectionDot.classList.toggle('disconnected', state.hostConnected !== true);
  document.querySelector('#pet-name').textContent = String(state.characterName || 'sparkiee').slice(0, 32).toLowerCase();
  if (state.visible === false) root.dataset.hidden = 'true';
  else delete root.dataset.hidden;
}

async function command(name) {
  errorText.textContent = '';
  try {
    applyState(await window.sparkieePet.command(name));
  } catch {
    errorText.textContent = 'Cannot reach Sparkiee right now.';
  }
}

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
for (const button of commandButtons) {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    void command(button.dataset.command);
  });
}
root.addEventListener('mouseenter', () => bubble.classList.add('expanded'));
root.addEventListener('mouseleave', () => bubble.classList.remove('expanded'));
window.sparkieePet.onState(applyState);
window.sparkieePet.getState().then(applyState).catch(() => {});
