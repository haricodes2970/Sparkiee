const { contextBridge, ipcRenderer } = require('electron');

const VALID_COMMANDS = new Set(['idle', 'walk', 'run', 'dance', 'sleep', 'celebrate', 'wave', 'surprised', 'confused', 'thinking', 'task_complete', 'task_error', 'permission_required', 'hide', 'show']);

function isPointerPoint(point) {
  return point && typeof point === 'object' &&
    Number.isFinite(point.screenX) && Number.isFinite(point.screenY) &&
    Math.abs(point.screenX) < 100_000 && Math.abs(point.screenY) < 100_000;
}

function isPackPayload(pack) {
  return Boolean(
    pack && typeof pack === 'object' &&
    typeof pack.id === 'string' && pack.id.length <= 64 &&
    typeof pack.name === 'string' && pack.name.length <= 64 &&
    pack.sprite && typeof pack.sprite === 'object' &&
    typeof pack.sprite.url === 'string' &&
    Number.isFinite(pack.sprite.frameWidth) && Number.isFinite(pack.sprite.frameHeight) &&
    Number.isInteger(pack.sprite.columns) && pack.sprite.columns > 0 &&
    pack.animations && typeof pack.animations === 'object' &&
    pack.layout && typeof pack.layout === 'object' &&
    Number.isFinite(pack.layout.spriteScale) && pack.layout.spriteScale >= 1 && pack.layout.spriteScale <= 16
  );
}

function sanitizePack(pack) {
  const animations = {};
  for (const [id, animation] of Object.entries(pack.animations)) {
    if (!/^[a-z][a-z0-9_]{1,32}$/.test(id)) continue;
    if (!animation || !Array.isArray(animation.frames)) continue;
    animations[id] = {
      frames: animation.frames.filter((frame) => Number.isInteger(frame) && frame >= 0 && frame < 4096).slice(0, 24),
      frameMs: Math.min(2000, Math.max(16, Number(animation.frameMs) || 200)),
      loop: animation.loop === true,
    };
  }
  const voiceEvents = {};
  for (const [id, descriptor] of Object.entries(pack.voiceEvents || {})) {
    if (!/^[a-z][a-z0-9_]{1,32}$/.test(id)) continue;
    if (typeof descriptor === 'object' && descriptor !== null && typeof descriptor.caption === 'string') {
      voiceEvents[id] = {
        caption: descriptor.caption.slice(0, 80),
        baseFrequency: Math.min(4000, Math.max(200, Number(descriptor.baseFrequency) || 600)),
        endFrequency: Math.min(4000, Math.max(200, Number(descriptor.endFrequency) || descriptor.baseFrequency || 600)),
        durationMs: Math.min(3000, Math.max(40, Number(descriptor.durationMs) || 200)),
        waveform: ['sine', 'square', 'sawtooth', 'triangle'].includes(descriptor.waveform) ? descriptor.waveform : 'triangle',
        chirps: Math.min(4, Math.max(1, Math.round(Number(descriptor.chirps) || 1))),
        cooldownMs: Math.min(10_000, Math.max(0, Number(descriptor.cooldownMs) || 0)),
      };
    } else if (typeof descriptor === 'string') {
      voiceEvents[id] = descriptor.slice(0, 200);
    }
  }
  return {
    id: pack.id,
    name: pack.name,
    sprite: {
      url: String(pack.sprite.url),
      frameWidth: pack.sprite.frameWidth,
      frameHeight: pack.sprite.frameHeight,
      columns: pack.sprite.columns,
    },
    animations,
    layout: {
      spriteScale: Math.min(16, Math.max(1, Number(pack.layout.spriteScale) || 4)),
      captionDurationMs: Math.min(15_000, Math.max(500, Number(pack.layout.captionDurationMs) || 2500)),
    },
    voiceStyle: pack.voiceStyle === 'clips' ? 'clips' : 'synth',
    voiceEvents,
    commandVoiceEvents: pack.commandVoiceEvents && typeof pack.commandVoiceEvents === 'object' ? pack.commandVoiceEvents : {},
  };
}

contextBridge.exposeInMainWorld('sparkieePet', Object.freeze({
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pet:state', listener);
    return () => ipcRenderer.removeListener('pet:state', listener);
  },
  onPack(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, pack) => {
      if (isPackPayload(pack)) callback(sanitizePack(pack));
    };
    ipcRenderer.on('pet:pack', listener);
    return () => ipcRenderer.removeListener('pet:pack', listener);
  },
  async getPack() {
    const pack = await ipcRenderer.invoke('pet:get-pack');
    return isPackPayload(pack) ? sanitizePack(pack) : null;
  },
  async getState() {
    return ipcRenderer.invoke('pet:get-state');
  },
  async command(command) {
    if (typeof command !== 'string' || !VALID_COMMANDS.has(command)) {
      throw new Error('Unsupported pet command.');
    }
    return ipcRenderer.invoke('pet:command', command);
  },
  startDrag(point) {
    if (isPointerPoint(point)) ipcRenderer.send('pet:drag-start', point);
  },
  moveDrag(point) {
    if (isPointerPoint(point)) ipcRenderer.send('pet:drag-move', point);
  },
  endDrag() {
    ipcRenderer.send('pet:drag-end');
  },
}));
