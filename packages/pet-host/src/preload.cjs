const { contextBridge, ipcRenderer } = require('electron');

const VALID_COMMANDS = new Set(['idle', 'walk', 'run', 'dance', 'sleep', 'celebrate', 'wave', 'surprised', 'hide', 'show']);

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
}));
