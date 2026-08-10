import './styles.css';
import QRCode from 'qrcode';
import { containRect } from '../shared/image-layout.js';
import { detectTransparentSlots } from '../shared/frame-slots.js';
import { DEFAULT_FOOTER_HEIGHT, frameSupportsCount, PRINT_HEIGHT, PRINT_WIDTH, resolvePhotoSlots } from '../shared/photo-layout.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  config: null, stream: null, mode: 'photo', session: null, frames: [], selectedFrame: null,
  resultDataUrl: '', resultBlob: null, busy: false, uploadUnsubscribe: null, shots: [], sessionFinished: false,
  selectedShotIndexes: new Set(), galleryUrl: '', qrDataUrl: '', framePreviewUrl: '', previewVersion: 0,
  timelapseRecording: null, timelapseSavePromise: null
};

function showScreen(id) {
  $$('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === id));
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2600);
}

async function refreshStats() {
  const stats = await window.photobooth.queue.stats();
  const pill = $('#queuePill');
  pill.classList.toggle('busy', stats.pending > 0);
  pill.classList.toggle('error', stats.failed > 0);
  pill.querySelector('span').textContent = stats.pending ? `${stats.pending} phiên đang chờ` : 'Đã đồng bộ';
  $('#queueStats').innerHTML = `Phiên chờ upload: <b>${stats.pending}</b><br>Phiên đã upload: <b>${stats.uploaded}</b><br>Dữ liệu local: <b>${(stats.localBytes / 1048576).toFixed(1)} MB</b>`;
}

async function loadFrames(force = false) {
  const manifest = force ? await window.photobooth.frames.sync() : await window.photobooth.frames.list();
  state.frames = manifest.frames;
  state.selectedFrame = state.frames[0] ?? null;
  renderFrames();
}

function renderFrames() {
  const container = $('#frameOptions');
  container.innerHTML = '';
  const photoCount = state.selectedShotIndexes.size || 4;
  let compatible = state.frames.filter((frame) => frameSupportsCount(frame, photoCount));
  if (!compatible.length) compatible = [{ id: `auto-${photoCount}`, name: `Tự động · ${photoCount} ảnh`, file: '', accent: state.config.branding.accent, slotCount: photoCount }];
  if (!compatible.some((frame) => frame.id === state.selectedFrame?.id)) state.selectedFrame = compatible[0];
  for (const frame of compatible) {
    const button = document.createElement('button');
    button.className = `frame-option${frame.id === state.selectedFrame?.id ? ' active' : ''}`;
    button.dataset.frameId = frame.id;
    button.style.setProperty('--frame-accent', frame.accent || '#ff5d8f');
    const swatch = document.createElement('div'); swatch.className = 'frame-swatch';
    const artwork = frame.previewDataUrl || frame.dataUrl;
    if (artwork) {
      const preview = document.createElement('img');
      preview.src = artwork;
      preview.alt = '';
      preview.loading = 'lazy';
      preview.decoding = 'async';
      swatch.append(preview);
    }
    const label = document.createElement('strong'); label.textContent = `${frame.name} · ${photoCount} ảnh`;
    button.append(swatch, label);
    button.onclick = () => {
      state.selectedFrame = frame;
      container.querySelectorAll('.frame-option').forEach((item) => item.classList.toggle('active', item === button));
      updateFramePreview().catch((error) => toast(`Không dựng được preview: ${error.message}`));
    };
    container.append(button);
  }
  updateFramePreview().catch((error) => toast(`Không dựng được preview: ${error.message}`));
}

async function updateFramePreview() {
  const image = $('#framePreviewImage');
  $('#framePreview').style.background = `linear-gradient(145deg,${state.selectedFrame?.accent || '#f9d9cf'},#f8dfd6)`;
  const shots = [...state.selectedShotIndexes].sort((a, b) => a - b).map((index) => state.shots[index]);
  if (shots.length < 1 || !state.qrDataUrl) {
    image.removeAttribute('src'); image.style.display = 'none'; return;
  }
  const version = ++state.previewVersion;
  $('.preview-smile').style.display = 'block';
  await ensureFrameSlots(state.selectedFrame);
  const blob = await composePhotoStrip(shots, state.selectedFrame, state.qrDataUrl, { preview: true });
  if (version !== state.previewVersion) return;
  if (state.framePreviewUrl) URL.revokeObjectURL(state.framePreviewUrl);
  state.framePreviewUrl = URL.createObjectURL(blob);
  image.src = state.framePreviewUrl;
  image.style.display = 'block';
  $('.preview-smile').style.display = 'none';
}

async function ensureFrameSlots(frame) {
  if (!frame?.inferSlots || Array.isArray(frame.slots) || !frame.dataUrl) return frame;
  const image = await imageFromUrl(frame.dataUrl);
  const sampleWidth = 300;
  const sampleHeight = Math.max(1, Math.round(sampleWidth * image.naturalHeight / image.naturalWidth));
  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth; canvas.height = sampleHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.clearRect(0, 0, sampleWidth, sampleHeight);
  context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
  const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight);
  const slots = detectTransparentSlots(pixels.data, sampleWidth, sampleHeight, Number(frame.slotCount));
  if (slots.length !== Number(frame.slotCount)) throw new Error(`Không dò được ${frame.slotCount} vùng ảnh trong frame ${frame.name}`);
  frame.slots = slots;
  return frame;
}

async function startCamera() {
  stopCamera();
  const camera = state.config.camera;
  const video = { width: { ideal: camera.width }, height: { ideal: camera.height } };
  if (camera.deviceId) video.deviceId = { exact: camera.deviceId }; else video.facingMode = camera.facingMode;
  if (state.config.camera.mode === 'dslr') {
    $('#cameraVideo').style.display = 'none';
    $('#cameraModeLabel').textContent = 'DSLR / CANON BRIDGE';
    if (state.config.timelapse?.enabled) {
      try { state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false }); }
      catch { updateTimelapseStatus('error', 'Không có webcam quay timelapse'); }
    }
    return;
  }
  $('#cameraVideo').style.display = 'block';
  state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  const element = $('#cameraVideo');
  element.srcObject = state.stream;
  element.classList.toggle('mirror', camera.mirrorPreview);
  await element.play();
  $('#cameraModeLabel').textContent = 'WEBCAM';
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
}

function updateTimelapseStatus(status, message) {
  const element = $('#timelapseStatus');
  element.className = `timelapse-status${status === 'hidden' ? '' : ` show ${status}`}`;
  element.querySelector('span').textContent = message || 'Timelapse 2×';
}

function startTimelapseRecording() {
  if (!state.config.timelapse?.enabled) return updateTimelapseStatus('hidden');
  if (!state.stream || typeof MediaRecorder === 'undefined') {
    return updateTimelapseStatus('error', 'Không thể quay timelapse');
  }
  const mimeType = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ].find((value) => MediaRecorder.isTypeSupported(value));
  if (!mimeType) return updateTimelapseStatus('error', 'Trình quay video không hỗ trợ');
  const chunks = [];
  const recorder = new MediaRecorder(state.stream, {
    mimeType,
    videoBitsPerSecond: Number(state.config.timelapse.videoBitsPerSecond) || 4000000
  });
  let resolveStopped;
  let rejectStopped;
  const stopped = new Promise((resolve, reject) => { resolveStopped = resolve; rejectStopped = reject; });
  recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
  recorder.onerror = (event) => rejectStopped(event.error || new Error('Không thể ghi timelapse'));
  recorder.onstop = () => resolveStopped(new Blob(chunks, { type: recorder.mimeType || mimeType }));
  state.timelapseSavePromise = null;
  state.timelapseRecording = { recorder, stopped, stopTask: null };
  recorder.start(1000);
  updateTimelapseStatus('recording', `Đang quay timelapse ${state.config.timelapse.speed || 2}×`);
}

async function stopTimelapseRecording({ save = true } = {}) {
  const recording = state.timelapseRecording;
  if (!recording) return { savePromise: state.timelapseSavePromise };
  if (recording.stopTask) return recording.stopTask;
  recording.stopTask = (async () => {
    if (recording.recorder.state !== 'inactive') recording.recorder.stop();
    const blob = await recording.stopped;
    if (state.timelapseRecording === recording) state.timelapseRecording = null;
    if (!save || !state.session || blob.size < 4) {
      updateTimelapseStatus('hidden');
      return { savePromise: null };
    }
    updateTimelapseStatus('processing', 'Đang tạo timelapse 2×');
    const sessionId = state.session.id;
    const savePromise = (async () => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return window.photobooth.timelapse.encode({ sessionId, bytes });
    })().then((result) => {
      updateTimelapseStatus('ready', 'Đã lưu timelapse 2×');
      return result;
    }).catch((error) => {
      console.error(error);
      updateTimelapseStatus('error', 'Lỗi lưu timelapse');
      toast(`Không lưu được timelapse: ${error.message}`);
      return null;
    });
    state.timelapseSavePromise = savePromise;
    return { savePromise };
  })();
  return recording.stopTask;
}

async function countdown(seconds) {
  for (let value = seconds; value > 0; value -= 1) {
    $('#countdown').textContent = value;
    await sleep(850);
    $('#countdown').textContent = '';
    await sleep(150);
  }
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Dữ liệu ảnh không hợp lệ');
  const metadata = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mimeType = metadata.match(/^data:([^;,]+)/)?.[1] || 'application/octet-stream';
  const binary = metadata.includes(';base64') ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function captureStill() {
  if (state.config.camera.mode === 'dslr') {
    const result = await window.photobooth.native.trigger(state.session.id);
    return result.dataUrl;
  }
  const video = $('#cameraVideo');
  const canvas = $('#cameraCanvas');
  canvas.width = video.videoWidth || state.config.camera.width;
  canvas.height = video.videoHeight || state.config.camera.height;
  const context = canvas.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (state.config.camera.mirrorOutput) {
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .94);
}

async function imageFromUrl(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

function drawContain(context, image, x, y, width, height) {
  const imageWidth = image.videoWidth || image.naturalWidth || image.width;
  const imageHeight = image.videoHeight || image.naturalHeight || image.height;
  const target = containRect(imageWidth, imageHeight, x, y, width, height);
  context.fillStyle = '#efe8e4';
  context.fillRect(x, y, width, height);
  context.drawImage(image, target.x, target.y, target.width, target.height);
}

function drawImageInSlot(context, image, slot) {
  if (slot.fit !== 'cover') return drawContain(context, image, slot.x, slot.y, slot.width, slot.height);
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  const ratio = Math.max(slot.width / imageWidth, slot.height / imageHeight);
  const sourceWidth = slot.width / ratio;
  const sourceHeight = slot.height / ratio;
  context.drawImage(image, (imageWidth - sourceWidth) / 2, (imageHeight - sourceHeight) / 2, sourceWidth, sourceHeight, slot.x, slot.y, slot.width, slot.height);
}

function drawBuiltInFrame(context, frame, width, height) {
  if (frame?.dataUrl) return;
  const accent = frame?.accent || state.config.branding.accent;
  context.save();
  context.strokeStyle = accent; context.lineWidth = 20;
  context.strokeRect(12, 12, width - 24, height - 24);
  context.fillStyle = accent;
  context.beginPath(); context.arc(38, 38, 22, 0, Math.PI * 2); context.fill();
  context.beginPath(); context.arc(width - 38, 38, 22, 0, Math.PI * 2); context.fill();
  context.restore();
}

async function composePhotoStrip(shots, frame = state.selectedFrame, qrDataUrl = state.qrDataUrl, { preview = false } = {}) {
  const canvas = document.createElement('canvas');
  const outputHeight = preview
    ? PRINT_HEIGHT
    : Math.max(1200, Math.min(7200, Number(state.config.composite?.targetResolution) || PRINT_HEIGHT));
  const outputWidth = Math.round(outputHeight * PRINT_WIDTH / PRINT_HEIGHT);
  canvas.width = outputWidth; canvas.height = outputHeight;
  const context = canvas.getContext('2d');
  context.scale(outputWidth / PRINT_WIDTH, outputHeight / PRINT_HEIGHT);
  context.fillStyle = frame?.backgroundColor || '#fffaf7'; context.fillRect(0, 0, PRINT_WIDTH, PRINT_HEIGHT);
  const images = await Promise.all(shots.map(imageFromUrl));
  const slots = resolvePhotoSlots(frame, images.length);
  images.forEach((image, index) => drawImageInSlot(context, image, slots[index]));
  if (!frame?.dataUrl) {
    context.fillStyle = frame?.footerColor || frame?.accent || state.config.branding.accent;
    context.fillRect(0, PRINT_HEIGHT - DEFAULT_FOOTER_HEIGHT, PRINT_WIDTH, DEFAULT_FOOTER_HEIGHT);
  }
  if (frame?.dataUrl) {
    const overlay = await imageFromUrl(frame.dataUrl);
    context.drawImage(overlay, 0, 0, PRINT_WIDTH, PRINT_HEIGHT);
  } else {
    drawBuiltInFrame(context, frame, PRINT_WIDTH, PRINT_HEIGHT);
  }

  const composite = state.config.composite ?? {};
  const qrImage = qrDataUrl && composite.qrEnabled !== false ? await imageFromUrl(qrDataUrl) : null;
  const qrSize = Number(composite.qrSizeStandard) || 120;
  const qr = {
    x: Math.round(PRINT_WIDTH * (Number(composite.qrPosXFraction) || 0)),
    y: Math.round(PRINT_HEIGHT * (Number(composite.qrPosYFraction) || 0) - qrSize),
    size: qrSize,
    ...(frame?.qr || {})
  };
  if (qrImage) {
    context.fillStyle = '#fff'; context.fillRect(qr.x - 6, qr.y - 6, qr.size + 12, qr.size + 12);
    context.drawImage(qrImage, qr.x, qr.y, qr.size, qr.size);
  }
  if (!frame?.dataUrl || frame?.label) {
    const label = { x: 58, y: 1625, maxWidth: qr.x - 90, color: '#fff', ...(frame?.label || {}) };
    context.fillStyle = label.color;
    context.font = '700 32px Segoe UI'; context.fillText(state.config.branding.name, label.x, label.y, label.maxWidth);
    context.font = '400 19px Segoe UI'; context.fillText(new Date().toLocaleString('vi-VN'), label.x, label.y + 48, label.maxWidth);
    context.font = '600 15px Segoe UI'; context.fillText('QUÉT QR ĐỂ NHẬN ẢNH', label.x, label.y + 92, label.maxWidth);
  }
  const quality = Math.max(.01, Math.min(1, (Number(composite.jpegQuality) || 95) / 100));
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function saveBlob(blob, kind, extension) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return window.photobooth.session.save({ sessionId: state.session.id, kind, extension, bytes });
}

async function finalizePhoto() {
  if (state.busy || state.selectedShotIndexes.size < 1) return;
  state.busy = true;
  const button = $('#confirmFrame');
  button.disabled = true; button.firstChild.textContent = 'Đang ghép ảnh… ';
  try {
    await ensureFrameSlots(state.selectedFrame);
    const selectedShots = [...state.selectedShotIndexes].sort((a, b) => a - b).map((index) => state.shots[index]);
    const blob = await composePhotoStrip(selectedShots, state.selectedFrame, state.qrDataUrl);
    await saveBlob(blob, 'photo-strip', 'jpg');
    state.resultBlob = blob;
    state.resultDataUrl = URL.createObjectURL(blob);
    if (state.timelapseSavePromise) {
      button.firstChild.textContent = 'Đang hoàn thiện timelapse… ';
      await state.timelapseSavePromise;
    }
    const finished = await window.photobooth.session.finish(state.session.id);
    state.sessionFinished = true;
    showResult();
    await showQr(finished.galleryUrl);
  } catch (error) {
    toast(error.message); console.error(error);
  } finally {
    state.busy = false; button.disabled = false; button.firstChild.textContent = 'Chốt ảnh này ';
  }
}

async function captureAndStoreShot(index, count) {
  $('#captureMessage').textContent = `Tạo dáng cho ảnh ${index + 1} / ${count}`;
  await countdown(state.config.camera.countdownSeconds);
  const dataUrl = await captureStill();
  state.shots.push(dataUrl);
  if (state.config.camera.mode !== 'dslr') await saveBlob(dataUrlToBlob(dataUrl), 'photo-original', 'jpg');
  $$('#shotProgress i')[index].classList.add('done');
  $('#countdown').classList.add('flash'); await sleep(110); $('#countdown').classList.remove('flash');
}

async function runPhotoAuto() {
  const count = candidateCount();
  for (let index = 0; index < count; index += 1) {
    await captureAndStoreShot(index, count);
    await sleep(state.config.camera.intervalSeconds * 1000);
  }
  await finishCapturePhase();
}

function candidateCount() {
  return Math.max(4, Math.min(8, state.config.camera.candidateCount ?? 6));
}

async function finishCapturePhase() {
  await stopTimelapseRecording({ save: true }).catch((error) => {
    console.error(error);
    updateTimelapseStatus('error', 'Lỗi dừng timelapse');
  });
  stopCamera();
  state.galleryUrl = await window.photobooth.gallery.url(state.session.id);
  state.qrDataUrl = await QRCode.toDataURL(state.galleryUrl, { width: 260, margin: 1, errorCorrectionLevel: 'M' });
  state.selectedShotIndexes = new Set(state.shots.slice(0, 4).map((_shot, index) => index));
  renderShotSelection();
  showScreen('selectionScreen');
}

function renderShotSelection() {
  const container = $('#shotSelection');
  container.replaceChildren();
  state.shots.forEach((shot, index) => {
    const button = document.createElement('button');
    button.className = `shot-option${state.selectedShotIndexes.has(index) ? ' selected' : ''}`;
    button.type = 'button'; button.setAttribute('aria-pressed', String(state.selectedShotIndexes.has(index)));
    const image = document.createElement('img'); image.src = shot; image.alt = `Ảnh đã chụp ${index + 1}`;
    const number = document.createElement('span'); number.className = 'shot-number'; number.textContent = index + 1;
    const mark = document.createElement('span'); mark.className = 'selected-mark'; mark.textContent = '✓';
    button.append(image, number, mark);
    button.onclick = () => {
      if (state.selectedShotIndexes.has(index)) state.selectedShotIndexes.delete(index);
      else state.selectedShotIndexes.add(index);
      renderShotSelection();
    };
    container.append(button);
  });
  $('#selectedCount').textContent = state.selectedShotIndexes.size ? `Đã chọn ${state.selectedShotIndexes.size} ảnh` : 'Chưa chọn ảnh';
  $('#confirmShots').disabled = state.selectedShotIndexes.size < 1;
}

function openFrameSelection() {
  if (state.selectedShotIndexes.size < 1) return;
  $('#frameScreen .section-heading h2').textContent = `Chọn khung phù hợp với ${state.selectedShotIndexes.size} ảnh`;
  showScreen('frameScreen');
  renderFrames();
}

async function beginCapture() {
  if (state.busy) return;
  state.busy = true; $('#shutterButton').disabled = true;
  try {
    if (!state.session) state.session = await window.photobooth.session.create('photo');
    const count = candidateCount();
    if (state.config.camera.captureWorkflow === 'auto') {
      await runPhotoAuto();
    } else {
      const index = state.shots.length;
      await captureAndStoreShot(index, count);
      if (state.shots.length >= count) await finishCapturePhase();
      else $('#captureMessage').textContent = `Đã chụp ${state.shots.length}/${count} · nhấn nút để chụp ảnh tiếp theo`;
    }
  } catch (error) {
    toast(error.message); console.error(error);
  } finally {
    state.busy = false; $('#shutterButton').disabled = false; $('#countdown').textContent = '';
  }
}

function showResult() {
  stopCamera(); showScreen('resultScreen');
  $('#resultMedia').innerHTML = `<img src="${state.resultDataUrl}" alt="Kết quả photobooth">`;
  $('#printButton').style.display = 'inline-block';
  $('#resultStatus').textContent = state.config.drive.enabled ? 'Gallery đã sẵn sàng · ảnh đang đồng bộ lên Google Drive…' : 'Gallery local đã sẵn sàng';
  refreshStats();
}

async function showQr(link) {
  const card = $('#qrCard'); card.innerHTML = '';
  const canvas = document.createElement('canvas'); card.append(canvas);
  await QRCode.toCanvas(canvas, link, { width: 180, margin: 1, color: { dark: '#322b2d', light: '#ffffff' } });
  const label = document.createElement('small');
  label.textContent = `Quét để mở gallery · ${new URL(link).host}`;
  label.title = link;
  card.append(label);
}

async function openMode() { state.mode = 'photo'; await openCapture(); }

async function openCapture() {
  const previousSession = state.session;
  const previousFinished = state.sessionFinished;
  const stopped = await stopTimelapseRecording({ save: false }).catch(() => ({ savePromise: state.timelapseSavePromise }));
  await stopped?.savePromise?.catch(() => {});
  stopCamera();
  if (previousSession && !previousFinished) await window.photobooth.session.cancel(previousSession.id).catch(() => {});
  state.session = null; state.sessionFinished = false; state.shots = [];
  state.selectedShotIndexes = new Set(); state.galleryUrl = ''; state.qrDataUrl = ''; state.timelapseSavePromise = null;
  const count = candidateCount();
  showScreen('captureScreen');
  updateTimelapseStatus('hidden');
  $('#captureMessage').textContent = state.config.camera.captureWorkflow === 'manual' ? 'Nhấn nút để chụp ảnh 1' : 'Nhấn nút để bắt đầu chụp tự động';
  $('#shotProgress').innerHTML = Array.from({ length: count }, () => '<i></i>').join('');
  $('#liveFrame').removeAttribute('src'); $('#liveFrame').style.display = 'none';
  try {
    await startCamera();
    state.session = await window.photobooth.session.create('photo');
    startTimelapseRecording();
  } catch (error) {
    stopCamera();
    toast(`Không mở được camera: ${error.message}`);
  }
}

async function goHome() {
  const currentSession = state.session;
  const currentFinished = state.sessionFinished;
  const stopped = await stopTimelapseRecording({ save: false }).catch(() => ({ savePromise: state.timelapseSavePromise }));
  await stopped?.savePromise?.catch(() => {});
  stopCamera(); showScreen('homeScreen');
  updateTimelapseStatus('hidden');
  if (currentSession && !currentFinished) await window.photobooth.session.cancel(currentSession.id).catch(() => {});
  state.session = null; state.shots = []; refreshStats();
}

function getAtPath(object, dotted) { return dotted.split('.').reduce((value, key) => value?.[key], object); }
function setAtPath(object, dotted, value) {
  const keys = dotted.split('.'); let target = object;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = value;
}

async function openSettings() {
  const dialog = $('#settingsDialog');
  for (const field of $('#settingsForm').elements) {
    if (!field.name) continue;
    let value = getAtPath(state.config, field.name);
    if (field.name === 'camera.dslr.args') value = (value ?? []).join('\n');
    if (field.type === 'checkbox') field.checked = Boolean(value); else field.value = value ?? '';
  }
  await listCameras(); await refreshStats();
  const backend = await window.photobooth.gallery.health();
  $('#backendHealth').textContent = backend.ok ? `Đang chạy · cổng ${backend.port} · v${backend.version}` : 'Chưa khởi động';
  dialog.showModal();
}

async function listCameras() {
  try {
    const temporary = await navigator.mediaDevices.getUserMedia({ video: true });
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
    temporary.getTracks().forEach((track) => track.stop());
    $('#cameraDevice').replaceChildren(new Option('Tự động', ''));
    devices.forEach((device, index) => $('#cameraDevice').add(new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
    $('#cameraDevice').value = state.config.camera.deviceId || '';
  } catch {}
}

async function saveSettings(event) {
  event.preventDefault(); const patch = {};
  for (const field of $('#settingsForm').elements) {
    if (!field.name) continue;
    let value = field.type === 'checkbox' ? field.checked : field.value;
    if (field.type === 'number') value = Number(value);
    if (field.name === 'camera.dslr.args') value = value.split('\n').map((item) => item.trim()).filter(Boolean);
    setAtPath(patch, field.name, value);
  }
  state.config = await window.photobooth.config.save(patch);
  applyBranding(); $('#settingsDialog').close(); toast('Đã lưu cài đặt');
}

function applyBranding() {
  $('#brandName').textContent = state.config.branding.name;
  $('#brandTagline').textContent = state.config.branding.tagline;
  document.documentElement.style.setProperty('--accent', state.config.branding.accent);
}

async function init() {
  state.config = await window.photobooth.config.get(); applyBranding(); await loadFrames(); await refreshStats();
  $$('.mode-card').forEach((button) => button.onclick = openMode);
  $$('[data-back]').forEach((button) => button.onclick = goHome);
  $('#confirmFrame').onclick = finalizePhoto; $('#confirmShots').onclick = openFrameSelection;
  $('#backToSelection').onclick = () => { showScreen('selectionScreen'); renderShotSelection(); };
  $('#retakeAll').onclick = openCapture;
  $('#shutterButton').onclick = beginCapture; $('#cancelCapture').onclick = goHome;
  $('#brandHome').onclick = goHome; $('#settingsButton').onclick = openSettings; $('#settingsForm').onsubmit = saveSettings;
  $('#retakeButton').onclick = openMode; $('#finishButton').onclick = goHome;
  $('#printButton').onclick = async () => {
    const dataUrl = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(state.resultBlob); });
    const result = await window.photobooth.print(dataUrl); toast(result.ok ? 'Đã gửi lệnh in' : `Không in được: ${result.error}`);
  };
  $$('.tab').forEach((tab) => tab.onclick = () => {
    $$('.tab').forEach((item) => item.classList.toggle('active', item === tab));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab.dataset.tab));
  });
  $('#checkBridge').onclick = async () => { const result = await window.photobooth.native.health(); $('#bridgeHealth').textContent = result.ok ? `C++ bridge ${result.version}: OK` : result.error; };
  $('#syncFrames').onclick = async () => { try { await loadFrames(true); toast('Đã đồng bộ khung'); } catch (error) { toast(error.message); } };
  $('#connectDrive').onclick = async () => {
    try {
      await window.photobooth.drive.authorize($('#oauthClientFile').value);
      state.config = await window.photobooth.config.get(); toast('Đã kết nối Google Drive');
    } catch (error) { toast(error.message); }
  };
  state.uploadUnsubscribe = window.photobooth.onUploadStatus((message) => {
    refreshStats();
    if (message.sessionId !== state.session?.id) return;
    if (message.status === 'uploaded') $('#resultStatus').textContent = 'Ảnh đã đồng bộ an toàn lên Google Drive';
    if (message.status === 'retrying') $('#resultStatus').textContent = 'Mạng chưa ổn định · ảnh đang nằm an toàn trong hàng đợi local';
  });
  $('#queuePill').onclick = async () => { await window.photobooth.queue.retry(); await refreshStats(); toast('Đã chạy lại hàng đợi upload'); };
  document.addEventListener('keydown', (event) => { if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') openSettings(); });
  if (import.meta.env.DEV) {
    window.__photoboothDebug = {
      showFrameScreen(count = 30) {
        state.selectedShotIndexes = new Set([0, 1, 2, 3]);
        state.frames = Array.from({ length: count }, (_value, index) => ({ id: `preview-${index}`, name: `Frame ${index + 1}`, file: '', accent: index % 2 ? '#ef765e' : '#7fa99b', slotCount: 4 }));
        state.selectedFrame = state.frames[0];
        renderFrames();
        showScreen('frameScreen');
      },
      async showResultScreen() {
        const shotCanvas = document.createElement('canvas');
        shotCanvas.width = 800; shotCanvas.height = 600;
        const context = shotCanvas.getContext('2d');
        const gradient = context.createLinearGradient(0, 0, shotCanvas.width, shotCanvas.height);
        gradient.addColorStop(0, '#173c34'); gradient.addColorStop(1, '#ef765e');
        context.fillStyle = gradient; context.fillRect(0, 0, shotCanvas.width, shotCanvas.height);
        const shot = shotCanvas.toDataURL('image/jpeg', .85);
        const galleryUrl = 'http://10.0.39.38:6001/gallery/demo';
        const qrDataUrl = await QRCode.toDataURL(galleryUrl, { width: 260, margin: 1, errorCorrectionLevel: 'M' });
        const blob = await composePhotoStrip([shot, shot, shot, shot], null, qrDataUrl, { preview: true });
        state.resultDataUrl = URL.createObjectURL(blob);
        showResult();
        await showQr(galleryUrl);
      }
    };
  }
}

init().catch((error) => { console.error(error); toast(error.message); });
