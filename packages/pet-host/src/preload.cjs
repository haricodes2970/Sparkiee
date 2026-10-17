const { contextBridge, ipcRenderer } = require('electron');

const VALID_COMMANDS = new Set(['idle', 'walk', 'run', 'dance', 'sleep', 'celebrate', 'wave', 'surprised', 'hide', 'show']);

function isPointerPoint(point) {
  return point && typeof point === 'object' &&
    Number.isFinite(point.screenX) && Number.isFinite(point.screenY) &&
    Math.abs(point.screenX) < 100_000 && Math.abs(point.screenY) < 100_000;
}

contextBridge.exposeInMainWorld('sparkieePet', Object.freeze({
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pet:state', listener);
    return () => ipcRenderer.removeListener('pet:state', listener);
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
