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
    cancel: (id) => ipcRenderer.invoke('session:cancel', id),
    listRecoverable: () => ipcRenderer.invoke('session:list-recoverable'),
    listResults: () => ipcRenderer.invoke('session:list-results'),
    restoreResult: (id) => ipcRenderer.invoke('session:restore-result', id),
    acknowledgeResult: (id) => ipcRenderer.invoke('session:acknowledge-result', id),
    resume: (id) => ipcRenderer.invoke('session:resume', id),
    readOriginals: (payload) => ipcRenderer.invoke('session:read-originals', payload),
    readOriginalsAny: (payload) => ipcRenderer.invoke('session:read-originals-any', payload),
    listAll: () => ipcRenderer.invoke('session:list-all'),
    saveDraft: (payload) => ipcRenderer.invoke('session:save-draft', payload)
  },
  frames: {
    list: () => ipcRenderer.invoke('frames:list'),
    sync: () => ipcRenderer.invoke('frames:sync'),
    analyze: (frameId) => ipcRenderer.invoke('frames:analyze', frameId)
  },
  luts: {
    list: () => ipcRenderer.invoke('luts:list'),
    importCube: () => ipcRenderer.invoke('luts:import'),
    renderArtifact: (payload) => ipcRenderer.invoke('luts:render-artifact', payload),
    prepareSession: (payload) => ipcRenderer.invoke('luts:prepare-session', payload)
  },
  assets: {
    status: () => ipcRenderer.invoke('assets:status'),
    onSynced: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('assets:synced', listener);
      return () => ipcRenderer.removeListener('assets:synced', listener);
    }
  },
  composite: {
    preview: (payload) => ipcRenderer.invoke('composite:preview', payload),
    create: (payload) => ipcRenderer.invoke('composite:create', payload)
  },
  gallery: {
    url: (sessionId) => ipcRenderer.invoke('gallery:url', sessionId)
  },
  queue: {
    stats: () => ipcRenderer.invoke('queue:stats'),
    retry: () => ipcRenderer.invoke('queue:retry')
  },
  uploads: {
    list: (options) => ipcRenderer.invoke('uploads:list', options),
    detail: (sessionId) => ipcRenderer.invoke('uploads:detail', sessionId),
    cancel: (sessionId) => ipcRenderer.invoke('uploads:cancel', sessionId),
    retry: (sessionId) => ipcRenderer.invoke('uploads:retry', sessionId),
    archive: (sessionId) => ipcRenderer.invoke('uploads:archive', sessionId),
    unarchive: (sessionId) => ipcRenderer.invoke('uploads:unarchive', sessionId),
    reveal: (sessionId) => ipcRenderer.invoke('uploads:reveal', sessionId)
  },
  timelapse: {
    encode: (payload) => ipcRenderer.invoke('timelapse:encode', payload)
  },
  native: {
    health: () => ipcRenderer.invoke('native:health'),
    trigger: (sessionId) => ipcRenderer.invoke('native:trigger', { sessionId })
  },
  print: (payload) => ipcRenderer.invoke('print:image', payload),
  onUploadStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('upload:status', listener);
    return () => ipcRenderer.removeListener('upload:status', listener);
  },
  onBackgroundError: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('app:background-error', listener);
    return () => ipcRenderer.removeListener('app:background-error', listener);
  }
});
