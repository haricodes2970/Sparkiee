const root = document.querySelector('#pet-root');
const bubble = document.querySelector('#speech-bubble');
const statusText = document.querySelector('#bubble-status');
const messageText = document.querySelector('#bubble-message');
const connectionDot = document.querySelector('#connection-dot');
const errorText = document.querySelector('#pet-error');
const commandButtons = document.querySelectorAll('[data-command]');
let currentState;

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
  if (state.visible === false) {
    // The main process hides the actual native window after receiving this state.
    root.dataset.hidden = 'true';
  } else {
    delete root.dataset.hidden;
  }
}

async function command(name) {
  errorText.textContent = '';
  try {
    applyState(await window.sparkieePet.command(name));
  } catch {
    errorText.textContent = 'Cannot reach Sparkiee dashboard.';
  }
}

window.sparkieePet.onState(applyState);
window.sparkieePet.getState().then(applyState).catch(() => {});
document.querySelector('#pet-button').addEventListener('click', () => void command('wave'));
for (const button of commandButtons) {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    void command(button.dataset.command);
  });
}
root.addEventListener('mouseenter', () => bubble.classList.add('expanded'));
root.addEventListener('mouseleave', () => bubble.classList.remove('expanded'));
