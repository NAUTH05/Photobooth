import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import { CubeLutManager } from './cube-lut-manager.js';
import { CloudflareGalleryClient } from './cloudflare-gallery-client.js';
import { CloudflareUploadManager } from './cloudflare-upload-manager.js';
import { CppGalleryBackend } from './cpp-gallery-backend.js';
import { FrameManager } from './frame-manager.js';
import { GradedPhotoService } from './graded-photo-service.js';
import { mainFrameHandler } from './ipc-guard.js';
import { LocalStore } from './local-store.js';
import { NativeBridge } from './native-bridge.js';
import { RemoteAssetManager } from './remote-asset-manager.js';
import { SharpCompositor } from './sharp-compositor.js';
import { TimelapseProcessor } from './timelapse-processor.js';
import { shutdownLutPool } from './lut-processor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow;
let configStore;
let localStore;
let frameManager;
let cloudUploader;
let nativeBridge;
let galleryServer;
let timelapseProcessor;
let sharpCompositor;
let lutManager;
let gradedPhotoService;
let assetManager;
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
  if (value.cloudflare) {
    value.cloudflare.uploadSecret = value.cloudflare.uploadSecret ? '••••••••' : '';
    delete value.cloudflare.uploadSecretEncrypted;
  }
  return value;
};

const galleryUrlFor = (sessionValue) => {
  const config = configStore.get();
  if (config.cloudflare?.enabled && config.cloudflare.baseUrl) return new CloudflareGalleryClient(config.cloudflare).urlFor(sessionValue);
  return galleryServer.urlFor(sessionValue);
};

async function syncCreativeAssets() {
  const result = await assetManager.sync();
  if (result.skipped) await frameManager.sync();
  return result;
}

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
  const rendererSession = mainWindow.webContents.session;
  rendererSession.setPermissionCheckHandler((webContents, permission, _origin, details) => (
    webContents === mainWindow.webContents
    && permission === 'media'
    && details?.isMainFrame !== false
    && details?.mediaType !== 'audio'
  ));
  rendererSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    const videoOnly = !mediaTypes.length || mediaTypes.every((type) => type === 'video');
    callback(webContents === mainWindow.webContents && permission === 'media' && videoOnly);
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
    if (patch?.cloudflare?.uploadSecret === '••••••••') patch.cloudflare.uploadSecret = current.cloudflare.uploadSecret;
    return publicConfig(await configStore.save(patch));
  });
  handle('session:create', (_event, mode) => localStore.createSession(mode, configStore.get().gallery.expirationDays));
  handle('artifact:save', (_event, payload) => localStore.saveArtifact(payload));
  handle('session:finish', async (_event, sessionId) => {
    const result = await localStore.finishSession(sessionId);
    cloudUploader.process().catch(() => { });
    return { sessionId, status: result.status, galleryUrl: galleryUrlFor(result) };
  });
  handle('session:cancel', async (_event, sessionId) => {
    const result = await localStore.cancelSession(sessionId);
    cloudUploader.process().catch(() => { });
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
    cloudUploader.process().catch(() => { });
    return { ...result, session: { ...result.session, status: localStore.queue.sessions[sessionId].status }, galleryUrl: galleryUrlFor(localStore.queue.sessions[sessionId]) };
  });
  handle('session:acknowledge-result', (_event, sessionId) => localStore.acknowledgeResult(sessionId));
  handle('session:resume', (_event, sessionId) => localStore.resumeSession(sessionId));
  handle('session:read-originals', (_event, payload) => localStore.readOriginals(payload?.sessionId, payload?.artifactIds));
  handle('session:save-draft', (_event, payload) => localStore.saveDraft(payload));
  handle('queue:stats', () => localStore.stats());
  handle('queue:retry', async () => {
    await cloudUploader.retryFailed();
    await cloudUploader.process();
    return localStore.stats();
  });
  handle('timelapse:encode', (_event, payload) => timelapseProcessor.encode(payload));
  handle('frames:list', () => frameManager.list());
  handle('frames:sync', async () => {
    const assetSync = await syncCreativeAssets();
    return { ...(await frameManager.list()), assetSync };
  });
  handle('frames:analyze', (_event, frameId) => frameManager.resolve(frameId));
  handle('assets:status', () => assetManager.status());
  handle('luts:list', () => lutManager.list());
  handle('luts:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Thêm LUT màu cho photobooth',
      buttonLabel: 'Cài LUT',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'LUT 3D (.cube)', extensions: ['cube'] }]
    });
    if (result.canceled || !result.filePaths.length) return { cancelled: true, imported: [], luts: lutManager.list() };
    const imported = await lutManager.importFiles(result.filePaths);
    return { cancelled: false, imported, luts: lutManager.list() };
  });
  handle('luts:render-artifact', (_event, payload) => gradedPhotoService.renderPreview(payload || {}));
  handle('luts:prepare-session', (_event, payload) => gradedPhotoService.prepareSession(payload || {}));
  const validateCompositeRequest = (payload) => {
    if (![4, 6, 8].includes(payload?.artifactIds?.length)) throw new Error('Số ảnh ghép phải là 4, 6 hoặc 8');
    return payload;
  };
  handle('composite:preview', (_event, payload) => sharpCompositor.render({ ...validateCompositeRequest(payload), preview: true, save: false }));
  handle('composite:create', (_event, payload) => sharpCompositor.render({ ...validateCompositeRequest(payload), preview: false, save: true }));
  handle('gallery:url', (_event, sessionId) => {
    const sessionValue = localStore.queue.sessions[sessionId];
    if (!sessionValue) throw new Error('Session not found');
    return galleryUrlFor(sessionValue);
  });
  handle('gallery:health', () => galleryServer.health());
  handle('native:health', () => nativeBridge.health());
  handle('native:trigger', (_event, payload) => {
    const request = typeof payload === 'string' ? { sessionId: payload } : (payload || {});
    return nativeBridge.trigger(request.sessionId, configStore.get().camera.dslr, 'natural');
  });
  let printJobRunning = false;
  handle('print:image', async (_event, payload) => {
    if (printJobRunning) return { ok: false, error: 'Đang in rồi, đợi xong nhé~' };
    printJobRunning = true;
    let tempImgPath = null;
    let tempHtmlPath = null;
    try {
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
    let offsetX = 0;
    let offsetY = 0;
    if (isStrip) {
      offsetX = Number.isFinite(Number(config.offsetX)) ? Number(config.offsetX) : 0;
      offsetY = Number.isFinite(Number(config.offsetY)) ? Number(config.offsetY) : 0;
    } else if (isLandscape) {
      offsetX = Number.isFinite(Number(config.offset4x6LandscapeX)) ? Number(config.offset4x6LandscapeX) : (Number(config.offset4x6X) || Number(config.offsetX) || 0);
      offsetY = Number.isFinite(Number(config.offset4x6LandscapeY)) ? Number(config.offset4x6LandscapeY) : (Number(config.offset4x6Y) || Number(config.offsetY) || 0);
    } else {
      offsetX = Number.isFinite(Number(config.offset4x6X)) ? Number(config.offset4x6X) : (Number(config.offsetX) || 0);
      offsetY = Number.isFinite(Number(config.offset4x6Y)) ? Number(config.offset4x6Y) : (Number(config.offsetY) || 0);
    }

    const requestedCopies = Number.isFinite(Number(request.copies)) && Number(request.copies) >= 1
      ? Math.min(10, Math.round(Number(request.copies))) : undefined;
    const copies = requestedCopies ?? config.copies ?? 1;
    const printJob = await localStore.recordPrintJob(request.sessionId, {
      profile, copies, deviceName, status: 'queued'
    });
    const finishPrintJob = async (result) => {
      if (printJob) {
        await localStore.recordPrintJob(request.sessionId, {
          ...printJob,
          status: result.ok ? 'printed' : 'failed',
          error: result.ok ? null : result.error
        });
      }
      return result;
    };

    let orientation = 'portrait';
    let widthMm = 101.6;
    let heightMm = 152.4;

    try {
      const base64Data = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
      const meta = await (await import('sharp')).default(Buffer.from(base64Data, 'base64')).metadata();
      const isPortrait = meta.height > meta.width;
      if (isStrip || isPortrait) {
        orientation = 'portrait';
        widthMm = 101.6;
        heightMm = 152.4;
      } else {
        orientation = 'landscape';
        widthMm = 152.4;
        heightMm = 101.6;
      }
    } catch {
      if (isLandscape) {
        orientation = 'landscape';
        widthMm = 152.4;
        heightMm = 101.6;
      }
    }

    let printedCopies = 0;
    if (process.platform === 'win32') {
      try {
        const appPath = app.getAppPath();
        const scriptPath = app.isPackaged
          ? path.join(process.resourcesPath, 'scripts', 'print_image.ps1')
          : path.join(appPath, 'scripts', 'print_image.ps1');

        tempImgPath = path.join(os.tmpdir(), `print_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`);
        const base64Data = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
        await fs.writeFile(tempImgPath, Buffer.from(base64Data, 'base64'));

        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        const args = [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
          '-printerName', deviceName || '',
          '-imagePath', tempImgPath,
          '-offsetXStr', String(offsetX),
          '-offsetYStr', String(offsetY),
          '-widthMmStr', String(widthMm),
          '-heightMmStr', String(heightMm),
          '-orientation', orientation,
          '-enable2x6', isStrip ? 'true' : 'false',
          '-targetDpi', '600'
        ];

        for (let i = 0; i < copies; i += 1) {
          await execFileAsync('powershell.exe', args, { windowsHide: true, timeout: 30000 });
          printedCopies += 1;
        }
        return await finishPrintJob({ ok: true });
      } catch (psErr) {
        console.warn(`PowerShell printed ${printedCopies}/${copies}, falling back to Chromium for remaining:`, psErr.message);
      } finally {
        if (tempImgPath) {
          try { await fs.unlink(tempImgPath); } catch {}
          tempImgPath = null;
        }
      }
    }

    // Chromium fallback — only print remaining copies
    const remainingCopies = copies - printedCopies;
    if (remainingCopies <= 0) return await finishPrintJob({ ok: true });

    tempHtmlPath = path.join(os.tmpdir(), `print_page_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.html`);
    const html = `<!doctype html><style>@page{margin:0;size:${orientation}}html,body{margin:0;width:100%;height:100%;overflow:hidden}img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transform:translate(${offsetX}mm,${offsetY}mm)}</style><img src="${dataUrl}">`;
    await fs.writeFile(tempHtmlPath, html, 'utf8');
    const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await printWindow.loadFile(tempHtmlPath);
      const result = await new Promise((resolve) => printWindow.webContents.print({
        silent: config.silent, deviceName: deviceName || undefined, printBackground: true,
        copies: remainingCopies, pageSize: { width: config.pageWidthMicrons, height: config.pageHeightMicrons }, landscape: isLandscape
      }, (success, failureReason) => resolve({ ok: success, error: failureReason })));
      return await finishPrintJob(result);
    } catch (error) {
      await finishPrintJob({ ok: false, error: String(error?.message || error) });
      throw error;
    } finally {
      printWindow.destroy();
      if (tempHtmlPath) {
        try { await fs.unlink(tempHtmlPath); } catch {}
        tempHtmlPath = null;
      }
    }
    } finally {
      printJobRunning = false;
      // Final safety cleanup for any temp files
      if (tempImgPath) { try { await fs.unlink(tempImgPath); } catch {} }
      if (tempHtmlPath) { try { await fs.unlink(tempHtmlPath); } catch {} }
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
  cloudUploader?.stop();
  galleryServer?.stop();
  await shutdownLutPool().catch((error) => console.error('LUT worker pool shutdown error:', error));
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
  const agedRemoved = await localStore.cleanupByAge(7).catch((error) => { console.error('Age-based cleanup failed', error); return 0; });
  if (agedRemoved) console.log(`Cleaned up ${agedRemoved} local file(s) older than 7 days`);
  timelapseProcessor = new TimelapseProcessor(localStore, configStore);
  const bundledFramesDir = app.isPackaged
    ? path.join(process.resourcesPath, 'frames')
    : path.join(appPath, 'frames');
  const framesCacheDir = path.join(runtimeRoot, 'frames');
  frameManager = new FrameManager(
    framesCacheDir,
    configStore,
    bundledFramesDir
  );
  await frameManager.init();
  lutManager = new CubeLutManager(path.join(runtimeRoot, 'luts'));
  await lutManager.init();
  assetManager = new RemoteAssetManager({
    framesRoot: framesCacheDir,
    lutsRoot: path.join(runtimeRoot, 'luts'),
    configStore,
    frameManager,
    lutManager
  });
  gradedPhotoService = new GradedPhotoService(localStore, lutManager);
  sharpCompositor = new SharpCompositor(localStore, frameManager, configStore, lutManager);
  nativeBridge = new NativeBridge(appPath, localStore, app.isPackaged ? process.resourcesPath : null);
  galleryServer = new CppGalleryBackend(
    appPath,
    runtimeRoot,
    configStore,
    app.isPackaged ? process.resourcesPath : null
  );
  await galleryServer.start();
  cloudUploader = new CloudflareUploadManager(localStore, configStore);
  cloudUploader.on('status', (message) => mainWindow?.webContents.send('upload:status', message));
  registerIpc();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(permission === 'media' && webContents === mainWindow?.webContents));
  await createWindow();
  syncCreativeAssets()
    .then((result) => mainWindow?.webContents.send('assets:synced', result))
    .catch((error) => {
      console.warn('Creative asset sync failed; keeping local cache:', error.message);
      mainWindow?.webContents.send('assets:synced', { ok: false, error: error.message });
    });
  cloudUploader.start();
  const cleanupMs = Math.max(1, configStore.get().storage.cleanupMinutes) * 60000;
  cleanupTimer = setInterval(() => {
    const config = configStore.get();
    localStore.cleanup(config.storage.retentionHoursAfterUpload, { requireCloudflare: Boolean(config.cloudflare?.enabled) })
      .catch((error) => console.error('Local cleanup failed', error));
  }, cleanupMs);
  const syncMs = Math.max(1, configStore.get().assets?.syncMinutes || 15) * 60000;
  frameSyncTimer = setInterval(() => syncCreativeAssets().catch(() => { }), syncMs);
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
