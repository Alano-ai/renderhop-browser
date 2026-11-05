import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('renderhop', {
  command: (command: unknown) => ipcRenderer.invoke('command', command),
  onState: (fn: (value: unknown) => void) => ipcRenderer.on('state', (_e, v) => fn(v)),
  onFrame: (fn: (value: unknown) => void) => ipcRenderer.on('frame', (_e, v) => fn(v)),
});
