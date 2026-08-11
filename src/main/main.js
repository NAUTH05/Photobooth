import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import { CppGalleryBackend } from './cpp-gallery-backend.js';
import { DriveClient } from './drive-client.js';
import { FrameManager } from './frame-manager.js';
import { mainFrameHandler } from './ipc-guard.js';
import { LocalStore } from './local-store.js';
import { NativeBridge } from './native-bridge.js';
import { SharpCompositor } from './sharp-compositor.js';
import { TimelapseProcessor } from './timelapse-processor.js';
import { UploadManager } from './upload-manager.js';

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
let cleanupTimer;
let frameSyncTimer;
let cleanupStarted = false;

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
      sandbox: true, spellcheck: false
    }
  });
  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    const developmentUrl = new URL(process.env.VITE_DEV_SERVER_URL);
    if (!['127.0.0.1', 'localhost'].includes(developmentUrl.hostname)) throw new Error('VITE_DEV_SERVER_URL phải dùng loopback host');
    await mainWindow.loadURL(developmentUrl.toString());
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'index.html'));
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
}

function registerIpc() {
  const handle = (channel, listener) => ipcMain.handle(channel, mainFrameHandler(() => mainWindow, listener));
  handle('config:get', () => publicConfig(configStore.get()));
  handle('config:save', async (_event, patch) => {
    const current = configStore.get();
    if (patch?.drive?.oauthRefreshToken === '••••••••') patch.drive.oauthRefreshToken = current.drive.oauthRefreshToken;
    return publicConfig(await configStore.save(patch));
  });
  handle('session:create', (_event, mode) => localStore.createSession(mode, configStore.get().gallery.expirationDays));
  handle('artifact:save', (_event, payload) => localStore.saveArtifact(payload));
  handle('session:finish', async (_event, sessionId) => {
    const result = await localStore.finishSession(sessionId);
    uploader.process().catch(() => { });
    return { sessionId, status: result.status, galleryUrl: galleryServer.urlFor(result) };
  });
  handle('session:cancel', async (_event, sessionId) => {
    const result = await localStore.cancelSession(sessionId);
    uploader.process().catch(() => { });
    return result;
  });
  handle('session:list-recoverable', () => localStore.listRecoverableSessions());
  handle('session:list-all', () => localStore.listAllWithPhotos());
  handle('session:read-originals-any', (_event, payload) => localStore.readOriginalsAny(payload?.sessionId, payload?.artifactIds));
  handle('session:list-results', () => localStore.listRestorableResults());
  handle('session:restore-result', async (_event, sessionId) => {
    const result = await localStore.readResult(sessionId);
    const sessionValue = localStore.queue.sessions[sessionId];
    if (['capturing', 'recoverable'].includes(sessionValue.status)) await localStore.finishSession(sessionId);
    uploader.process().catch(() => { });
    return { ...result, session: { ...result.session, status: localStore.queue.sessions[sessionId].status }, galleryUrl: galleryServer.urlFor(localStore.queue.sessions[sessionId]) };
  });
  handle('session:acknowledge-result', (_event, sessionId) => localStore.acknowledgeResult(sessionId));
  handle('session:resume', (_event, sessionId) => localStore.resumeSession(sessionId));
  handle('session:read-originals', (_event, payload) => localStore.readOriginals(payload?.sessionId, payload?.artifactIds));
  handle('session:save-draft', (_event, payload) => localStore.saveDraft(payload));
  handle('queue:stats', () => localStore.stats());
  handle('queue:retry', async () => { await uploader.process(); return localStore.stats(); });
  handle('timelapse:encode', (_event, payload) => timelapseProcessor.encode(payload));
  handle('frames:list', () => frameManager.list());
  handle('frames:sync', () => frameManager.sync());
  handle('frames:analyze', (_event, frameId) => frameManager.resolve(frameId));
  const validateCompositeRequest = (payload) => {
    if (![4, 6, 8].includes(payload?.artifactIds?.length)) throw new Error('Số ảnh ghép phải là 4, 6 hoặc 8');
    return payload;
  };
  handle('composite:preview', (_event, payload) => sharpCompositor.render({ ...validateCompositeRequest(payload), preview: true, save: false }));
  handle('composite:create', (_event, payload) => sharpCompositor.render({ ...validateCompositeRequest(payload), preview: false, save: true }));
  handle('gallery:url', (_event, sessionId) => {
    const sessionValue = localStore.queue.sessions[sessionId];
    if (!sessionValue) throw new Error('Session not found');
    return galleryServer.urlFor(sessionValue);
  });
  handle('gallery:health', () => galleryServer.health());
  handle('drive:authorize', async (_event, oauthClientFile) => {
    const refreshToken = await DriveClient.authorize(oauthClientFile, (url) => shell.openExternal(url));
    await configStore.save({ drive: { oauthClientFile, oauthRefreshToken: refreshToken, enabled: true } });
    return { ok: true };
  });
  handle('native:health', () => nativeBridge.health());
  handle('native:trigger', (_event, sessionId) => nativeBridge.trigger(sessionId, configStore.get().camera.dslr));
  handle('print:image', async (_event, payload) => {
    const config = configStore.get().print;
    if (!config.enabled) return { ok: false, error: 'Printing is disabled' };
    const request = typeof payload === 'string' ? { dataUrl: payload } : (payload || {});
    let dataUrl = String(request.dataUrl || '');
    if (!dataUrl.startsWith('data:image/')) return { ok: false, error: 'Invalid image data' };
    const profile = String(request.profile || '4x6-portrait');
    const isLandscape = profile === '4x6-landscape';
    const isStrip = profile === '2x6';
    if (isStrip) {
      try {
        const base64Data = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
        const singleBuf = Buffer.from(base64Data, 'base64');
        const meta = await (await import('sharp')).default(singleBuf).metadata();
        if (meta.width && meta.height && meta.width < meta.height * 0.75) {
          const stripW = meta.width;
          const stripH = meta.height;
          const sharpObj = (await import('sharp')).default;
          const sheetBuf = await sharpObj({ create: { width: stripW * 2, height: stripH, channels: 3, background: '#ffffff' } })
            .composite([{ input: singleBuf, left: 0, top: 0 }, { input: singleBuf, left: stripW, top: 0 }])
            .jpeg({ quality: 98 })
            .toBuffer();
          dataUrl = `data:image/jpeg;base64,${sheetBuf.toString('base64')}`;
        }
      } catch (err) {
        console.warn('Cannot duplicate strip for print:', err);
      }
    }
    const deviceName = isStrip ? (config.deviceName2Cut || config.deviceName) : config.deviceName;
    const offsetX = isLandscape
      ? (Number.isFinite(Number(config.offset4x6LandscapeX)) ? Number(config.offset4x6LandscapeX) : Number(config.offset4x6X) || Number(config.offsetX) || 0)
      : (Number.isFinite(Number(config.offset4x6X)) ? Number(config.offset4x6X) : Number(config.offsetX) || 0);
    const offsetY = isLandscape
      ? (Number.isFinite(Number(config.offset4x6LandscapeY)) ? Number(config.offset4x6LandscapeY) : Number(config.offset4x6Y) || Number(config.offsetY) || 0)
      : (Number.isFinite(Number(config.offset4x6Y)) ? Number(config.offset4x6Y) : Number(config.offsetY) || 0);
    const requestedCopies = Number.isFinite(Number(request.copies)) && Number(request.copies) >= 1
      ? Math.min(10, Math.round(Number(request.copies))) : undefined;
    const copies = requestedCopies ?? config.copies ?? 1;
    const orientation = isLandscape ? 'landscape' : 'portrait';
    const html = `<!doctype html><style>@page{margin:0;size:${orientation}}html,body{margin:0;width:100%;height:100%;overflow:hidden}img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transform:translate(${offsetX}mm,${offsetY}mm)}</style><img src="${dataUrl}">`;
    const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return await new Promise((resolve) => printWindow.webContents.print({
        silent: config.silent, deviceName: deviceName || undefined, printBackground: true,
        copies, pageSize: { width: config.pageWidthMicrons, height: config.pageHeightMicrons }, landscape: isLandscape
      }, (success, failureReason) => resolve({ ok: success, error: failureReason })));
    } finally {
      printWindow.destroy();
    }
  });
}

async function prepareRuntimeRoot(appPath) {
  const preferredRoot = app.isPackaged
    ? path.join(path.dirname(process.execPath), 'runtime-data')
    : path.join(appPath, 'runtime-data');
  const fallbackRoot = path.join(app.getPath('userData'), 'runtime-data');
  let runtimeRoot = preferredRoot;
  const verifyWritable = async (candidate) => {
    await fs.mkdir(candidate, { recursive: true });
    const probe = path.join(candidate, `.write-test-${process.pid}`);
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.unlink(probe);
  };
  try {
    await verifyWritable(preferredRoot);
  } catch (error) {
    if (!app.isPackaged) throw new Error(`Không thể ghi dữ liệu local tại ${preferredRoot}: ${error.message}`);
    runtimeRoot = fallbackRoot;
    await verifyWritable(runtimeRoot);
    console.warn(`Không thể ghi cạnh ứng dụng; dùng thư mục local ${runtimeRoot}`);
  }
  return runtimeRoot;
}

async function cleanupServices() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (frameSyncTimer) clearInterval(frameSyncTimer);
  cleanupTimer = null;
  frameSyncTimer = null;
  uploader?.stop();
  galleryServer?.stop();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
}

app.whenReady().then(async () => {
  cleanupStarted = false;
  const appPath = app.getAppPath();
  const runtimeRoot = await prepareRuntimeRoot(appPath);
  const secretCodec = safeStorage.isEncryptionAvailable() ? {
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
  } : null;
  configStore = new ConfigStore(appPath, runtimeRoot, secretCodec);
  await configStore.load();
  localStore = new LocalStore(runtimeRoot);
  await localStore.init();
  timelapseProcessor = new TimelapseProcessor(localStore, configStore);
  const driveFactory = (config) => new DriveClient(config);
  const bundledFramesDir = app.isPackaged
    ? path.join(process.resourcesPath, 'frames')
    : path.join(appPath, 'frames');
  const framesCacheDir = path.join(runtimeRoot, 'frames');
  frameManager = new FrameManager(
    framesCacheDir,
    driveFactory,
    configStore,
    bundledFramesDir
  );
  await frameManager.init();
  sharpCompositor = new SharpCompositor(localStore, frameManager, configStore);
  nativeBridge = new NativeBridge(appPath, localStore, app.isPackaged ? process.resourcesPath : null);
  galleryServer = new CppGalleryBackend(
    appPath,
    runtimeRoot,
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
  cleanupTimer = setInterval(() => localStore.cleanup(configStore.get().storage.retentionHoursAfterUpload).catch((error) => console.error('Local cleanup failed', error)), cleanupMs);
  const syncMs = Math.max(1, configStore.get().drive.syncFramesMinutes) * 60000;
  frameSyncTimer = setInterval(() => frameManager.sync().catch(() => { }), syncMs);
}).catch(async (error) => {
  console.error('Photobooth startup failed', error);
  process.exitCode = 1;
  await cleanupServices();
  app.quit();
});

app.on('before-quit', () => { cleanupServices().catch((error) => console.error('Cleanup failed', error)); });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
