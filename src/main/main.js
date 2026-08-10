import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import { DriveClient } from './drive-client.js';
import { FrameManager } from './frame-manager.js';
import { CppGalleryBackend } from './cpp-gallery-backend.js';
import { LocalStore } from './local-store.js';
import { NativeBridge } from './native-bridge.js';
import { UploadManager } from './upload-manager.js';
import { TimelapseProcessor } from './timelapse-processor.js';
import { SharpCompositor } from './sharp-compositor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow;
let configStore;
let localStore;
let frameManager;
let uploader;
let nativeBridge;
let galleryServer;
let timelapseProcessor;
let sharpCompositor;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

const publicConfig = (config) => {
  const value = structuredClone(config);
  if (value.drive) {
    value.drive.oauthRefreshToken = value.drive.oauthRefreshToken ? '••••••••' : '';
    delete value.drive.oauthRefreshTokenEncrypted;
  }
  return value;
};

async function createWindow() {
  const config = configStore.get();
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 700,
    kiosk: Boolean(config.kiosk), fullscreen: Boolean(config.kiosk), autoHideMenuBar: true,
    backgroundColor: '#f3eee6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: false, spellcheck: false
    }
  });
  if (process.env.VITE_DEV_SERVER_URL) await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
}

function registerIpc() {
  ipcMain.handle('config:get', () => publicConfig(configStore.get()));
  ipcMain.handle('config:save', async (_event, patch) => {
    const current = configStore.get();
    if (patch?.drive?.oauthRefreshToken === '••••••••') patch.drive.oauthRefreshToken = current.drive.oauthRefreshToken;
    return publicConfig(await configStore.save(patch));
  });
  ipcMain.handle('session:create', (_event, mode) => localStore.createSession(mode, configStore.get().gallery.expirationDays));
  ipcMain.handle('artifact:save', (_event, payload) => localStore.saveArtifact(payload));
  ipcMain.handle('session:finish', async (_event, sessionId) => {
    const result = await localStore.finishSession(sessionId);
    uploader.process().catch(() => {});
    return { sessionId, status: result.status, galleryUrl: galleryServer.urlFor(result) };
  });
  ipcMain.handle('session:cancel', async (_event, sessionId) => {
    const result = await localStore.cancelSession(sessionId);
    uploader.process().catch(() => {});
    return result;
  });
  ipcMain.handle('queue:stats', () => localStore.stats());
  ipcMain.handle('queue:retry', async () => { await uploader.process(); return localStore.stats(); });
  ipcMain.handle('timelapse:encode', (_event, payload) => timelapseProcessor.encode(payload));
  ipcMain.handle('frames:list', () => frameManager.list());
  ipcMain.handle('frames:sync', () => frameManager.sync());
  ipcMain.handle('frames:analyze', (_event, frameId) => frameManager.resolve(frameId));
  ipcMain.handle('composite:preview', (_event, payload) => sharpCompositor.render({ ...payload, preview: true, save: false }));
  ipcMain.handle('composite:create', (_event, payload) => sharpCompositor.render({ ...payload, preview: false, save: true }));
  ipcMain.handle('gallery:url', (_event, sessionId) => {
    const sessionValue = localStore.queue.sessions[sessionId];
    if (!sessionValue) throw new Error('Session not found');
    return galleryServer.urlFor(sessionValue);
  });
  ipcMain.handle('gallery:health', () => galleryServer.health());
  ipcMain.handle('drive:authorize', async (_event, oauthClientFile) => {
    const refreshToken = await DriveClient.authorize(oauthClientFile, (url) => shell.openExternal(url));
    await configStore.save({ drive: { oauthClientFile, oauthRefreshToken: refreshToken, enabled: true } });
    return { ok: true };
  });
  ipcMain.handle('native:health', () => nativeBridge.health());
  ipcMain.handle('native:trigger', (_event, sessionId) => nativeBridge.trigger(sessionId, configStore.get().camera.dslr));
  ipcMain.handle('print:image', async (_event, payload) => {
    const config = configStore.get().print;
    if (!config.enabled) return { ok: false, error: 'Printing is disabled' };
    const request = typeof payload === 'string' ? { dataUrl: payload } : (payload || {});
    const dataUrl = String(request.dataUrl || '');
    if (!dataUrl.startsWith('data:image/')) return { ok: false, error: 'Invalid image data' };
    const profile = String(request.profile || '4x6-portrait');
    const isLandscape = profile === '4x6-landscape';
    const isStrip = profile === '2x6';
    const deviceName = isStrip ? (config.deviceName2Cut || config.deviceName) : config.deviceName;
    const offsetX = isLandscape
      ? (Number.isFinite(Number(config.offset4x6LandscapeX)) ? Number(config.offset4x6LandscapeX) : Number(config.offset4x6X) || Number(config.offsetX) || 0)
      : (Number.isFinite(Number(config.offset4x6X)) ? Number(config.offset4x6X) : Number(config.offsetX) || 0);
    const offsetY = isLandscape
      ? (Number.isFinite(Number(config.offset4x6LandscapeY)) ? Number(config.offset4x6LandscapeY) : Number(config.offset4x6Y) || Number(config.offsetY) || 0)
      : (Number.isFinite(Number(config.offset4x6Y)) ? Number(config.offset4x6Y) : Number(config.offsetY) || 0);
    const orientation = isLandscape ? 'landscape' : 'portrait';
    const html = `<!doctype html><style>@page{margin:0;size:${orientation}}html,body{margin:0;width:100%;height:100%;overflow:hidden}img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transform:translate(${offsetX}mm,${offsetY}mm)}</style><img src="${dataUrl}">`;
    const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return await new Promise((resolve) => printWindow.webContents.print({
        silent: config.silent, deviceName: deviceName || undefined, printBackground: true,
        copies: config.copies, pageSize: { width: config.pageWidthMicrons, height: config.pageHeightMicrons }, landscape: isLandscape
      }, (success, failureReason) => resolve({ ok: success, error: failureReason })));
    } finally {
      printWindow.destroy();
    }
  });
}

app.whenReady().then(async () => {
  const appPath = app.getAppPath();
  const secretCodec = safeStorage.isEncryptionAvailable() ? {
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
  } : null;
  configStore = new ConfigStore(appPath, app.getPath('userData'), secretCodec);
  await configStore.load();
  localStore = new LocalStore(path.join(app.getPath('userData'), 'runtime-data'));
  await localStore.init();
  timelapseProcessor = new TimelapseProcessor(localStore, configStore);
  const driveFactory = (config) => new DriveClient(config);
  frameManager = new FrameManager(
    path.join(app.getPath('userData'), 'frames'),
    driveFactory,
    configStore,
    configStore.get().frames.localDir
  );
  await frameManager.init();
  sharpCompositor = new SharpCompositor(localStore, frameManager, configStore);
  nativeBridge = new NativeBridge(appPath, localStore, app.isPackaged ? process.resourcesPath : null);
  galleryServer = new CppGalleryBackend(
    appPath,
    path.join(app.getPath('userData'), 'runtime-data'),
    configStore,
    app.isPackaged ? process.resourcesPath : null
  );
  await galleryServer.start();
  uploader = new UploadManager(localStore, driveFactory, configStore);
  uploader.on('status', (message) => mainWindow?.webContents.send('upload:status', message));
  registerIpc();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(permission === 'media' && webContents === mainWindow?.webContents));
  await createWindow();
  uploader.start();
  const cleanupMs = Math.max(1, configStore.get().storage.cleanupMinutes) * 60000;
  setInterval(() => localStore.cleanup(configStore.get().storage.retentionHoursAfterUpload), cleanupMs);
  const syncMs = Math.max(1, configStore.get().drive.syncFramesMinutes) * 60000;
  setInterval(() => frameManager.sync().catch(() => {}), syncMs);
});

app.on('window-all-closed', () => {
  uploader?.stop();
  galleryServer?.stop();
  if (process.platform !== 'darwin') app.quit();
});
