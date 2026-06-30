'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge. The renderer never touches Node, the filesystem,
// or the API key directly — it only calls these named channels.
contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (values) => ipcRenderer.invoke('settings:save', values),

  pickImage: () => ipcRenderer.invoke('image:pick'),

  analyze: (payload) => ipcRenderer.invoke('analyze:start', payload),
  onDelta: (cb) => {
    const handler = (_evt, text) => cb(text);
    ipcRenderer.on('analyze:delta', handler);
    return () => ipcRenderer.removeListener('analyze:delta', handler);
  },
  onPass: (cb) => {
    const handler = (_evt, info) => cb(info);
    ipcRenderer.on('analyze:pass', handler);
    return () => ipcRenderer.removeListener('analyze:pass', handler);
  },
  onNote: (cb) => {
    const handler = (_evt, text) => cb(text);
    ipcRenderer.on('analyze:note', handler);
    return () => ipcRenderer.removeListener('analyze:note', handler);
  },
  onSearch: (cb) => {
    const handler = (_evt, info) => cb(info);
    ipcRenderer.on('analyze:search', handler);
    return () => ipcRenderer.removeListener('analyze:search', handler);
  },
  onLocated: (cb) => {
    const handler = (_evt, loc) => cb(loc);
    ipcRenderer.on('analyze:located', handler);
    return () => ipcRenderer.removeListener('analyze:located', handler);
  },

  openExternal: (url) => ipcRenderer.invoke('open:external', url),
});
