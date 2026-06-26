'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge. The renderer never touches Node, the filesystem,
// or the API key directly — it only calls these named channels.
contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (values) => ipcRenderer.invoke('settings:save', values),
  listModels: () => ipcRenderer.invoke('models:list'),

  pickImage: () => ipcRenderer.invoke('image:pick'),

  analyze: (payload) => ipcRenderer.invoke('analyze:start', payload),
  onDelta: (cb) => {
    const handler = (_evt, text) => cb(text);
    ipcRenderer.on('analyze:delta', handler);
    return () => ipcRenderer.removeListener('analyze:delta', handler);
  },

  openExternal: (url) => ipcRenderer.invoke('open:external', url),
});
