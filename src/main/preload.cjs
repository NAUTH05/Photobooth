const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photobooth', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (patch) => ipcRenderer.invoke('config:save', patch)
  },
  session: {
    create: (mode) => ipcRenderer.invoke('session:create', mode),
    save: (payload) => ipcRenderer.invoke('artifact:save', payload),
    finish: (id) => ipcRenderer.invoke('session:finish', id),
    cancel: (id) => ipcRenderer.invoke('session:cancel', id)
  },
  frames: {
    list: () => ipcRenderer.invoke('frames:list'),
    sync: () => ipcRenderer.invoke('frames:sync'),
    analyze: (frameId) => ipcRenderer.invoke('frames:analyze', frameId)
  },
  composite: {
    preview: (payload) => ipcRenderer.invoke('composite:preview', payload),
    create: (payload) => ipcRenderer.invoke('composite:create', payload)
  },
  drive: {
    authorize: (oauthClientFile) => ipcRenderer.invoke('drive:authorize', oauthClientFile)
  },
  gallery: {
    url: (sessionId) => ipcRenderer.invoke('gallery:url', sessionId),
    health: () => ipcRenderer.invoke('gallery:health')
  },
  queue: {
    stats: () => ipcRenderer.invoke('queue:stats'),
    retry: () => ipcRenderer.invoke('queue:retry')
  },
  timelapse: {
    encode: (payload) => ipcRenderer.invoke('timelapse:encode', payload)
  },
  native: {
    health: () => ipcRenderer.invoke('native:health'),
    trigger: (sessionId) => ipcRenderer.invoke('native:trigger', sessionId)
  },
  print: (payload) => ipcRenderer.invoke('print:image', payload),
  onUploadStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('upload:status', listener);
    return () => ipcRenderer.removeListener('upload:status', listener);
  }
});
