import QRCode from 'qrcode';
import { containRect } from '../shared/image-layout.js';
import { DEFAULT_FOOTER_HEIGHT, frameSupportsCount, PRINT_HEIGHT, PRINT_WIDTH, resolvePhotoSlots } from '../shared/photo-layout.js';
import { assignArtifact, clearSlot, createSlotAssignments, moveSlot, normalizeTargetCount, validateSlotAssignments } from '../shared/slot-assignments.js';
import './styles.css';

const MAX_SHOTS = 50;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  config: null, stream: null, mode: 'photo', session: null, frames: [], selectedFrame: null,
  resultDataUrl: '', resultBlob: null, resultProfile: '4x6-portrait', resultArtifactId: '', busy: false, uploadUnsubscribe: null, shots: [], sessionFinished: false,
  selectedShotIndexes: new Set(), selectionTargetCount: 4, slotAssignments: [], activeSlotIndex: -1, pendingArtifactId: '',
  galleryUrl: '', qrDataUrl: '', framePreviewUrl: '', previewVersion: 0, frameSelectionGeneration: 0,
  timelapseRecording: null, timelapseSavePromise: null, photoTransforms: {}, activeTransformId: '', previewTimer: null, draftTimer: null,
  printCopies: 1, zoomScale: 1, zoomTranslateX: 0, zoomTranslateY: 0, isZoomDragging: false, zoomDragStartX: 0, zoomDragStartY: 0,
  zoomReturnFocus: null, recoveryShotUrls: new Set(), captureGeneration: 0, navigatedFromSessions: false
};

function showScreen(id) {
  $$('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === id));
  document.body.classList.toggle('capture-active', id === 'captureScreen');
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
  $('#queueStats').innerHTML = `Phiên chờ upload: <b>${stats.pending}</b><br>Phiên có thể khôi phục: <b>${stats.recoverable || 0}</b><br>Phiên đã upload: <b>${stats.uploaded}</b><br>Dữ liệu local: <b>${(stats.localBytes / 1048576).toFixed(1)} MB</b>`;
}

async function loadFrames(force = false) {
  const manifest = force ? await window.photobooth.frames.sync() : await window.photobooth.frames.list();
  state.frames = manifest.frames;
  state.selectedFrame = state.frames[0] ?? null;
  renderFrames();
}

function selectedShots() {
  return [...state.selectedShotIndexes].sort((left, right) => left - right).map((index) => state.shots[index]).filter(Boolean);
}

function selectedArtifactIds() {
  return selectedShots().map((shot) => shot.artifactId);
}

function assignedShots() {
  const byId = new Map(state.shots.map((shot) => [shot.artifactId, shot]));
  return state.slotAssignments.map((artifactId) => byId.get(artifactId)).filter(Boolean);
}

function ensureAssignments() {
  const selected = selectedArtifactIds();
  const valid = state.slotAssignments.length === state.selectionTargetCount
    && state.slotAssignments.filter(Boolean).every((artifactId) => selected.includes(artifactId));
  if (!valid) state.slotAssignments = state.slotAssignments.length
    ? createSlotAssignments([], state.selectionTargetCount)
    : createSlotAssignments(selected, state.selectionTargetCount);
  if (state.activeSlotIndex < 0 || state.activeSlotIndex >= state.slotAssignments.length) {
    state.activeSlotIndex = state.slotAssignments.findIndex(Boolean);
  }
  state.activeTransformId = state.slotAssignments[state.activeSlotIndex] || '';
}

async function renderFrames() {
  const container = $('#frameOptions');
  container.innerHTML = '';
  const photoCount = state.selectionTargetCount;
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
    button.onclick = async () => {
      const generation = ++state.frameSelectionGeneration;
      state.selectedFrame = frame;
      container.querySelectorAll('.frame-option').forEach((item) => item.classList.toggle('active', item === button));
      await ensureFrameSlots(frame);
      if (generation !== state.frameSelectionGeneration || state.selectedFrame !== frame) return;
      renderFrameEditor();
      scheduleFramePreview(0);
      scheduleDraftSave();
    };
    container.append(button);
  }
  // Analyze slots before rendering so overlay positions match actual frame areas
  await ensureFrameSlots(state.selectedFrame).catch(() => { });
  renderFrameEditor();
  scheduleFramePreview(0);
}

function compositePayload(frame = state.selectedFrame) {
  return {
    sessionId: state.session?.id || '',
    artifactIds: [...(state.slotAssignments || [])],
    frameId: frame?.id || '',
    transforms: structuredClone(state.photoTransforms || {}),
    qrDataUrl: state.qrDataUrl || ''
  };
}

function bytesToBlob(result) {
  return new Blob([new Uint8Array(result.bytes)], { type: result.mimeType || 'image/jpeg' });
}

function scheduleFramePreview(delay = 80) {
  clearTimeout(state.previewTimer);
  const version = ++state.previewVersion;
  state.previewTimer = setTimeout(() => updateFramePreview(version).catch((error) => {
    if (version === state.previewVersion) toast(`Không dựng được preview: ${error.message}`);
  }), delay);
}

function setActiveSlot(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.slotAssignments.length) return;
  state.activeSlotIndex = index;
  state.activeTransformId = state.slotAssignments[index] || '';
  state.pendingArtifactId = '';
  renderFrameEditor();
}

function updateAssignments(next, activeIndex) {
  state.slotAssignments = next;
  state.activeSlotIndex = Math.max(0, Math.min(next.length - 1, activeIndex));
  state.activeTransformId = next[state.activeSlotIndex] || '';
  state.pendingArtifactId = '';
  renderFrameEditor();
  scheduleFramePreview(0);
  scheduleDraftSave();
}

function ensureTransformControls() {
  let panel = $('#photoTransformControls');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'photoTransformControls';
  panel.className = 'photo-transform-controls';
  panel.innerHTML = '<div class="transform-shots"></div><label>Crop zoom <input class="transform-zoom" type="range" min="1" max="4" step="0.05" value="1"></label><div class="transform-buttons"><button type="button" data-pan="left">←</button><button type="button" data-pan="up">↑</button><button type="button" data-pan="down">↓</button><button type="button" data-pan="right">→</button><button type="button" data-rotate="-90">↶</button><button type="button" data-rotate="90">↷</button><button type="button" data-reset>Đặt lại</button></div><button type="button" class="crop-open-btn" id="openCropModalBtn">✂ Cắt & Chọn vùng (Avatar Crop)</button>';
  $('#photoTransformHost').append(panel);
  const changed = () => { scheduleFramePreview(); scheduleDraftSave(); };
  panel.querySelector('.transform-zoom').oninput = (event) => {
    const transform = state.photoTransforms[state.activeTransformId];
    if (!transform) return;
    transform.zoom = Number(event.target.value);
    changed();
  };
  panel.querySelectorAll('[data-pan]').forEach((button) => button.onclick = () => {
    const transform = state.photoTransforms[state.activeTransformId];
    if (!transform) return;
    const direction = button.dataset.pan;
    if (direction === 'left') transform.panX = Math.max(0, transform.panX - 5);
    if (direction === 'right') transform.panX = Math.min(100, transform.panX + 5);
    if (direction === 'up') transform.panY = Math.max(0, transform.panY - 5);
    if (direction === 'down') transform.panY = Math.min(100, transform.panY + 5);
    changed();
  });
  panel.querySelectorAll('[data-rotate]').forEach((button) => button.onclick = () => {
    const transform = state.photoTransforms[state.activeTransformId];
    if (!transform) return;
    transform.rotation = (transform.rotation + Number(button.dataset.rotate) + 360) % 360;
    changed();
  });
  panel.querySelector('[data-reset]').onclick = () => {
    if (!state.activeTransformId) return;
    state.photoTransforms[state.activeTransformId] = { panX: 50, panY: 50, zoom: 1, rotation: 0 };
    renderTransformControls(); changed();
  };
  const cropBtn = panel.querySelector('#openCropModalBtn');
  if (cropBtn) {
    cropBtn.onclick = () => {
      if (state.activeTransformId) openCropModal(state.activeTransformId);
      else toast('Hãy chọn ô ảnh muốn cắt');
    };
  }
  return panel;
}

function renderTransformControls() {
  const panel = ensureTransformControls();
  const container = panel.querySelector('.transform-shots');
  container.replaceChildren();
  state.slotAssignments.forEach((artifactId, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = artifactId ? `Ô ${index + 1}` : `Ô ${index + 1} trống`;
    button.classList.toggle('active', index === state.activeSlotIndex);
    button.disabled = !artifactId;
    button.onclick = () => setActiveSlot(index);
    container.append(button);
  });
  const transform = state.photoTransforms[state.activeTransformId];
  panel.querySelector('.transform-zoom').value = transform?.zoom || 1;
  panel.querySelectorAll('input, .transform-buttons button').forEach((control) => { control.disabled = !transform; });
}

function renderPhotoGallery() {
  const container = $('#framePhotoGallery');
  container.replaceChildren();
  selectedShots().forEach((shot, index) => {
    const card = document.createElement('div');
    card.className = `frame-photo${state.pendingArtifactId === shot.artifactId || state.activeTransformId === shot.artifactId ? ' active' : ''}`;
    card.draggable = true;
    card.tabIndex = 0;
    card.role = 'button';
    card.setAttribute('aria-label', `Chọn ảnh ${index + 1} để gán vào khung`);
    card.dataset.artifactId = shot.artifactId;
    const image = document.createElement('img'); image.src = shot.dataUrl; image.alt = `Ảnh ${index + 1}`;
    const label = document.createElement('small'); label.textContent = `IMAGE ${index + 1}`;
    const view = document.createElement('button'); view.type = 'button'; view.className = 'photo-view'; view.textContent = '⤢'; view.title = 'Xem ảnh lớn';
    view.onclick = (event) => { event.stopPropagation(); openZoom(shot.dataUrl); };
    card.append(image, label, view);
    card.onclick = () => { state.pendingArtifactId = shot.artifactId; renderFrameEditor(); };
    card.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); }
    };
    card.ondragstart = (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-photobooth-artifact', shot.artifactId);
    };
    container.append(card);
  });
}

function renderSlotOverlay() {
  const overlay = $('#frameSlotOverlay');
  overlay.replaceChildren();
  if (!state.selectedFrame) return;
  const frameWidth = Number(state.selectedFrame.width) || PRINT_WIDTH;
  const frameHeight = Number(state.selectedFrame.height) || PRINT_HEIGHT;
  const slots = resolvePhotoSlots(state.selectedFrame, state.selectionTargetCount);
  slots.forEach((slot, index) => {
    const artifactId = state.slotAssignments[index];
    const assignedShot = state.shots.find((shot) => shot.artifactId === artifactId);
    const element = document.createElement('div');
    element.className = `frame-slot${artifactId ? ' occupied' : ' empty'}${index === state.activeSlotIndex ? ' active' : ''}`;
    element.tabIndex = 0;
    element.role = 'button';
    element.setAttribute('aria-label', artifactId ? `Ô ảnh ${index + 1}, chạm để chỉnh` : `Ô ảnh ${index + 1} đang trống`);
    if (assignedShot && !state.framePreviewUrl) {
      element.style.backgroundImage = `linear-gradient(#173c3418,#173c3418),url("${assignedShot.dataUrl}")`;
      element.style.backgroundSize = 'cover';
      element.style.backgroundPosition = 'center';
    }
    element.style.left = `${slot.x / frameWidth * 100}%`;
    element.style.top = `${slot.y / frameHeight * 100}%`;
    element.style.width = `${slot.width / frameWidth * 100}%`;
    element.style.height = `${slot.height / frameHeight * 100}%`;
    element.draggable = Boolean(artifactId);
    const label = document.createElement('span'); label.textContent = artifactId ? `Ô ${index + 1}` : `THẢ ẢNH ${index + 1}`;
    element.append(label);
    if (artifactId) {
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'slot-clear'; clear.textContent = '×'; clear.title = 'Bỏ ảnh khỏi ô';
      clear.onclick = (event) => { event.stopPropagation(); updateAssignments(clearSlot(state.slotAssignments, index), index); };
      const cropBtn = document.createElement('button'); cropBtn.type = 'button'; cropBtn.className = 'slot-crop-btn'; cropBtn.textContent = '✂'; cropBtn.title = 'Cắt & chọn vùng ảnh';
      cropBtn.onclick = (event) => { event.stopPropagation(); setActiveSlot(index); openCropModal(artifactId); };
      element.append(cropBtn, clear);
    }
    let isSlotDragging = false;
    let slotStartX = 0, slotStartY = 0, initialPanX = 50, initialPanY = 50;
    element.onpointerdown = (event) => {
      if (!artifactId || event.target.closest('button')) return;
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      setActiveSlot(index);
      isSlotDragging = true;
      slotStartX = event.clientX;
      slotStartY = event.clientY;
      const transform = state.photoTransforms[artifactId] || { panX: 50, panY: 50, zoom: 1, rotation: 0 };
      initialPanX = transform.panX;
      initialPanY = transform.panY;
      element.setPointerCapture?.(event.pointerId);
    };
    element.onpointermove = (event) => {
      if (!isSlotDragging || !artifactId) return;
      const dx = event.clientX - slotStartX;
      const dy = event.clientY - slotStartY;
      const transform = state.photoTransforms[artifactId];
      if (!transform) return;

      const shot = state.shots.find((s) => s.artifactId === artifactId);
      const naturalW = shot?.width || 1200;
      const naturalH = shot?.height || 800;
      const isRotatedQuarter = (transform.rotation || 0) % 180 !== 0;
      const SW = isRotatedQuarter ? naturalH : naturalW;
      const SH = isRotatedQuarter ? naturalW : naturalH;

      const slotAspect = slot.width / slot.height;
      let cropW, cropH;
      if (SW / SH > slotAspect) {
        cropH = SH; cropW = cropH * slotAspect;
      } else {
        cropW = SW; cropH = cropW / slotAspect;
      }
      const zoom = Math.max(1, transform.zoom || 1);
      cropW = Math.min(SW, cropW / zoom);
      cropH = Math.min(SH, cropH / zoom);

      const slotElementW = element.clientWidth || 100;
      const scaleSlot = slotElementW / cropW;
      const rangeX = SW - cropW;
      const rangeY = SH - cropH;

      if (rangeX > 0) {
        const dPanX = (-dx / scaleSlot) / rangeX * 100;
        transform.panX = Math.max(0, Math.min(100, initialPanX + dPanX));
      }
      if (rangeY > 0) {
        const dPanY = (-dy / scaleSlot) / rangeY * 100;
        transform.panY = Math.max(0, Math.min(100, initialPanY + dPanY));
      }
      scheduleFramePreview(40);
      scheduleDraftSave();
    };
    const endSlotDrag = (event) => {
      if (!isSlotDragging) return;
      isSlotDragging = false;
      if (event.pointerId !== undefined) {
        try { element.releasePointerCapture(event.pointerId); } catch {}
      }
    };
    element.onpointerup = endSlotDrag;
    element.onpointercancel = endSlotDrag;
    element.onclick = () => {
      if (state.pendingArtifactId) updateAssignments(assignArtifact(state.slotAssignments, state.pendingArtifactId, index, selectedArtifactIds()), index);
      else setActiveSlot(index);
    };
    element.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); element.click(); }
      if ((event.key === 'Delete' || event.key === 'Backspace') && artifactId) { event.preventDefault(); updateAssignments(clearSlot(state.slotAssignments, index), index); }
    };
    element.ondragstart = (event) => {
      if (!artifactId) return event.preventDefault();
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-photobooth-slot', String(index));
    };
    element.ondragover = (event) => { event.preventDefault(); element.classList.add('drag-over'); };
    element.ondragleave = () => element.classList.remove('drag-over');
    element.ondrop = (event) => {
      event.preventDefault(); element.classList.remove('drag-over');
      const sourceSlot = event.dataTransfer.getData('application/x-photobooth-slot');
      const artifact = event.dataTransfer.getData('application/x-photobooth-artifact');
      if (sourceSlot !== '') updateAssignments(moveSlot(state.slotAssignments, Number(sourceSlot), index), index);
      else if (artifact) updateAssignments(assignArtifact(state.slotAssignments, artifact, index, selectedArtifactIds()), index);
    };
    overlay.append(element);
  });
}

function renderFrameEditor() {
  ensureAssignments();
  renderPhotoGallery();
  renderSlotOverlay();
  renderTransformControls();
  const complete = validateSlotAssignments(state.slotAssignments, selectedArtifactIds(), state.selectionTargetCount);
  $('#confirmFrame').disabled = !complete;
  const assigned = state.slotAssignments.filter(Boolean).length;
  $('#slotStatus').textContent = complete ? `Đã sắp xếp đủ ${assigned}/${state.selectionTargetCount} ảnh` : `Đã xếp ${assigned}/${state.selectionTargetCount} ảnh · hãy điền đủ các ô`;
}

async function updateFramePreview(version) {
  const image = $('#framePreviewImage');
  const frameContainer = $('#framePreview');
  const smile = $('.preview-smile');
  const frame = state.selectedFrame;
  if (frameContainer) frameContainer.style.background = `linear-gradient(145deg,${frame?.accent || '#f9d9cf'},#f8dfd6)`;
  if (!frame || !state.session?.id) {
    if (version !== state.previewVersion) return;
    if (state.framePreviewUrl) URL.revokeObjectURL(state.framePreviewUrl);
    state.framePreviewUrl = '';
    if (image) { image.removeAttribute('src'); image.style.display = 'none'; }
    if (smile) smile.style.display = 'block';
    return;
  }
  if (smile) smile.style.display = 'block';
  await ensureFrameSlots(frame);
  if (version !== state.previewVersion || state.selectedFrame !== frame) return;
  const payload = compositePayload(frame);
  try {
    const result = await window.photobooth.composite.preview(payload);
    if (version !== state.previewVersion || state.selectedFrame !== frame) return;
    const blob = bytesToBlob(result);
    if (state.framePreviewUrl) URL.revokeObjectURL(state.framePreviewUrl);
    state.framePreviewUrl = URL.createObjectURL(blob);
    if (image) {
      image.src = state.framePreviewUrl;
      image.style.display = 'block';
    }
    if (frameContainer) frameContainer.style.aspectRatio = `${result.width} / ${result.height}`;
    if (smile) smile.style.display = 'none';
    renderSlotOverlay();
  } catch (error) {
    console.warn('Frame preview render failed:', error);
  }
}

async function ensureFrameSlots(frame) {
  if (!frame?.inferSlots || Array.isArray(frame.slots)) return frame;
  const analyzed = await window.photobooth.frames.analyze(frame.id);
  Object.assign(frame, analyzed);
  return frame;
}

async function startCamera() {
  stopCamera();
  const camera = state.config.camera;
  const video = { width: { ideal: camera.width }, height: { ideal: camera.height } };
  if (camera.deviceId) video.deviceId = { ideal: camera.deviceId }; else if (camera.facingMode) video.facingMode = camera.facingMode;
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
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (error) {
    console.warn('Constrained camera request failed, attempting default video stream:', error);
    state.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
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

async function countdown(seconds, generation = state.captureGeneration) {
  for (let value = seconds; value > 0; value -= 1) {
    if (generation !== state.captureGeneration) throw new Error('Đã hủy thao tác chụp');
    $('#countdown').textContent = value;
    await sleep(850);
    if (generation !== state.captureGeneration) throw new Error('Đã hủy thao tác chụp');
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
    return { artifactId: result.item.id, kind: result.item.kind, dataUrl: result.dataUrl };
  }
  const video = $('#cameraVideo');
  const canvas = $('#cameraCanvas');
  canvas.width = video.videoWidth || state.config.camera.width;
  canvas.height = video.videoHeight || state.config.camera.height;
  console.info(`Webcam negotiated capture: ${canvas.width}x${canvas.height}`);
  const context = canvas.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (state.config.camera.mirrorOutput) {
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', .94);
  const item = await saveBlob(dataUrlToBlob(dataUrl), 'photo-original', 'jpg');
  return { artifactId: item.id, kind: item.kind, dataUrl, width: canvas.width, height: canvas.height };
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

async function ensureQrDataUrl() {
  if (state.qrDataUrl && state.galleryUrl) return state.qrDataUrl;
  if (!state.session?.id) return '';
  try {
    state.galleryUrl = await window.photobooth.gallery.url(state.session.id);
    state.qrDataUrl = await QRCode.toDataURL(state.galleryUrl, { width: 260, margin: 1, errorCorrectionLevel: 'M' });
  } catch (err) {
    console.warn('Could not generate QR code data URL:', err);
  }
  return state.qrDataUrl;
}

async function finalizePhoto() {
  if (state.busy || !validateSlotAssignments(state.slotAssignments, selectedArtifactIds(), state.selectionTargetCount)) return;
  state.busy = true;
  const button = $('#confirmFrame');
  button.disabled = true; button.firstChild.textContent = 'Đang ghép ảnh… ';
  try {
    await ensureQrDataUrl();
    await ensureFrameSlots(state.selectedFrame);
    const result = await window.photobooth.composite.create(compositePayload());
    const blob = bytesToBlob(result);
    state.resultBlob = blob;
    state.resultProfile = result.profile || '4x6-portrait';
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
    state.busy = false;
    button.disabled = !validateSlotAssignments(state.slotAssignments, selectedArtifactIds(), state.selectionTargetCount);
    button.firstChild.textContent = 'Chốt ảnh này ';
  }
}

function addCaptureThumbnail(dataUrl) {
  const container = $('#captureThumbnails');
  const img = document.createElement('img');
  img.className = 'capture-thumb';
  img.src = dataUrl;
  img.alt = 'Ảnh vừa chụp';
  img.title = 'Nhấn để xem phóng to full screen';
  img.onclick = () => openZoom(dataUrl);
  container.append(img);
  img.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function captureAndStoreShot(index, count, generation = state.captureGeneration) {
  $('#captureMessage').textContent = `Tạo dáng cho ảnh ${index + 1} / ${count}`;
  await countdown(state.config.camera.countdownSeconds, generation);
  if (generation !== state.captureGeneration) throw new Error('Đã hủy thao tác chụp');
  const shot = await captureStill();
  if (generation !== state.captureGeneration) throw new Error('Đã hủy thao tác chụp');
  state.shots.push(shot);
  state.photoTransforms[shot.artifactId] ??= { panX: 50, panY: 50, zoom: 1, rotation: 0 };
  addCaptureThumbnail(shot.dataUrl);
  if (state.shots.length >= 4) $('#captureNextButton').hidden = false;
  $$('#shotProgress i')[index]?.classList.add('done');
  $('#countdown').classList.add('flash'); await sleep(110); $('#countdown').classList.remove('flash');
}

async function runPhotoAuto(generation = state.captureGeneration) {
  const count = candidateCount();
  for (let index = state.shots.length; index < count; index += 1) {
    if (generation !== state.captureGeneration) throw new Error('Đã hủy thao tác chụp');
    await captureAndStoreShot(index, count, generation);
    await sleep(state.config.camera.intervalSeconds * 1000);
  }
  if (generation === state.captureGeneration) await finishCapturePhase();
}

function candidateCount() {
  return normalizeTargetCount(state.config.camera.candidateCount, 6);
}

async function finishCapturePhase() {
  await stopTimelapseRecording({ save: true }).catch((error) => {
    console.error(error);
    updateTimelapseStatus('error', 'Lỗi dừng timelapse');
  });
  stopCamera();
  await ensureQrDataUrl();
  state.selectionTargetCount = Math.min(candidateCount(), state.shots.length >= 8 ? 8 : state.shots.length >= 6 ? 6 : 4);
  state.selectedShotIndexes = new Set(state.shots.map((_shot, index) => index));
  state.slotAssignments ??= [];
  openFrameSelection();
  scheduleDraftSave();
}

function renderShotSelection() {
  const container = $('#shotSelection');
  container.replaceChildren();
  $('#selectionTarget').querySelectorAll('option').forEach((option) => {
    option.disabled = Number(option.value) > state.shots.length;
  });
  state.shots.forEach((shot, index) => {
    const card = document.createElement('div');
    card.className = `shot-option${state.selectedShotIndexes.has(index) ? ' selected' : ''}`;
    const select = document.createElement('button');
    select.className = 'shot-select-btn'; select.type = 'button';
    select.setAttribute('aria-pressed', String(state.selectedShotIndexes.has(index)));
    const image = document.createElement('img'); image.src = shot.dataUrl; image.alt = `Ảnh đã chụp ${index + 1}`;
    const number = document.createElement('span'); number.className = 'shot-number'; number.textContent = index + 1;
    const mark = document.createElement('span'); mark.className = 'selected-mark'; mark.textContent = '✓';
    select.append(image, number, mark);
    select.onclick = () => {
      if (state.selectedShotIndexes.has(index)) state.selectedShotIndexes.delete(index);
      else if (state.selectedShotIndexes.size < state.selectionTargetCount) state.selectedShotIndexes.add(index);
      else return toast(`Chỉ chọn đúng ${state.selectionTargetCount} ảnh`);
      state.slotAssignments = [];
      renderShotSelection();
      scheduleDraftSave();
    };
    const zoomBtn = document.createElement('button');
    zoomBtn.className = 'shot-zoom-btn'; zoomBtn.type = 'button'; zoomBtn.title = 'Xem ảnh lớn'; zoomBtn.textContent = '⤢';
    zoomBtn.onclick = () => openZoom(shot.dataUrl);
    card.append(select, zoomBtn);
    container.append(card);
  });
  const complete = state.selectedShotIndexes.size === state.selectionTargetCount;
  $('#selectedCount').textContent = `Đã chọn ${state.selectedShotIndexes.size}/${state.selectionTargetCount} ảnh`;
  $('#confirmShots').disabled = !complete;
}

function changeSelectionTarget(event) {
  state.selectionTargetCount = normalizeTargetCount(event.target.value, state.selectionTargetCount);
  const kept = [...state.selectedShotIndexes].sort((left, right) => left - right).slice(0, state.selectionTargetCount);
  state.selectedShotIndexes = new Set(kept);
  state.slotAssignments = [];
  renderShotSelection();
  scheduleDraftSave();
}

async function openFrameSelection() {
  state.selectionTargetCount = Math.min(candidateCount(), state.shots.length >= 8 ? 8 : state.shots.length >= 6 ? 6 : 4);
  state.selectedShotIndexes = new Set(state.shots.map((_shot, index) => index));
  await ensureQrDataUrl();
  $('#frameScreen .section-heading h2').textContent = `Chọn khung và sắp xếp ảnh (${state.shots.length} ảnh đã chụp)`;
  ensureAssignments();
  showScreen('frameScreen');
  renderFrames();
  scheduleDraftSave('frame');
}

function revokeRecoveryUrls() {
  for (const url of state.recoveryShotUrls) URL.revokeObjectURL(url);
  state.recoveryShotUrls.clear();
}

function clearResultState() {
  if (state.resultDataUrl?.startsWith('blob:')) URL.revokeObjectURL(state.resultDataUrl);
  state.resultDataUrl = '';
  state.resultBlob = null;
  state.resultProfile = '4x6-portrait';
  state.resultArtifactId = '';
  $('#resultMedia').replaceChildren();
}

async function acknowledgeCurrentResult() {
  if (!state.session?.id || !state.resultArtifactId) return;
  await window.photobooth.session.acknowledgeResult(state.session.id);
}

function draftValue(step = $('#frameScreen').classList.contains('active') ? 'frame' : 'selection') {
  const selected = selectedArtifactIds().slice(0, state.selectionTargetCount);
  return {
    targetCount: state.selectionTargetCount,
    selectedArtifactIds: selected,
    frameId: state.selectedFrame?.id || '',
    slotAssignments: state.slotAssignments,
    transforms: state.photoTransforms,
    step
  };
}

function scheduleDraftSave(step) {
  clearTimeout(state.draftTimer);
  if (!state.session || state.sessionFinished || state.shots.length === 0) return;
  state.draftTimer = setTimeout(() => {
    window.photobooth.session.saveDraft({ sessionId: state.session.id, draft: draftValue(step) }).catch((error) => console.error('Không lưu được draft', error));
  }, 300);
}

const sessionThumbUrls = new Set();
function revokeSessionThumbUrls() {
  for (const url of sessionThumbUrls) URL.revokeObjectURL(url);
  sessionThumbUrls.clear();
}

async function openSessionsScreen() {
  state.navigatedFromSessions = true;
  revokeSessionThumbUrls();
  showScreen('sessionsScreen');
  await renderSessionsList();
}

async function renderSessionsList() {
  const grid = $('#sessionsList');
  grid.innerHTML = '<div class="session-empty">Đang tải…</div>';
  try {
    const allSessions = await window.photobooth.session.listAll();
    const resultSessions = await window.photobooth.session.listResults().catch(() => []);
    const resultIds = new Set(resultSessions.map((s) => s.id));
    grid.replaceChildren();
    if (!allSessions.length) {
      grid.innerHTML = '<div class="session-empty">Không có phiên nào được lưu local.</div>';
      return;
    }
    for (const session of allSessions) {
      const hasResult = resultIds.has(session.id);
      const isRecoverable = session.status === 'recoverable';
      const folder = document.createElement('div');
      folder.className = `session-folder${hasResult ? ' is-result' : ''}`;
      const date = new Date(session.createdAt).toLocaleString('vi-VN');
      const originals = (session.items || []).filter((item) => ['photo-original', 'dslr-original'].includes(item.kind));
      const count = originals.length;
      const photoGrid = document.createElement('div');
      photoGrid.className = 'session-folder-photos';
      for (let i = 0; i < 4; i++) { const ph = document.createElement('div'); ph.className = 'photo-ph'; photoGrid.append(ph); }
      const info = document.createElement('div'); info.className = 'session-folder-info';
      info.innerHTML = `<strong>${date}</strong><small>${count} ảnh${hasResult ? ' · đã in' : isRecoverable ? ' · chưa hoàn tất' : ''}</small>`;
      folder.append(photoGrid, info);
      folder.onclick = () => {
        if (hasResult) restoreResultSession(session.id);
        else if (isRecoverable) resumeSession(session.id);
        else reopenSession(session.id);
      };
      grid.append(folder);
      if (originals.length) {
        window.photobooth.session.readOriginalsAny({ sessionId: session.id, artifactIds: originals.slice(0, 4).map((item) => item.id) })
          .then((items) => {
            photoGrid.replaceChildren();
            for (let i = 0; i < 4; i++) {
              if (items[i]) {
                const url = URL.createObjectURL(bytesToBlob(items[i])); sessionThumbUrls.add(url);
                const img = document.createElement('img'); img.src = url; img.alt = ''; photoGrid.append(img);
              } else { const ph = document.createElement('div'); ph.className = 'photo-ph'; photoGrid.append(ph); }
            }
          }).catch(() => { });
      }
    }
  } catch (error) {
    grid.innerHTML = `<div class="session-empty">Lỗi: ${error.message}</div>`;
  }
}

// Creates a new session copying photos from any old session so user can reframe and reprint
async function reopenSession(sessionId) {
  if (state.busy) return;
  state.busy = true;
  state.navigatedFromSessions = true;
  try {
    revokeSessionThumbUrls();
    const originals = await window.photobooth.session.readOriginalsAny({ sessionId });
    if (!originals.length) { toast('Không tìm thấy ảnh trong phiên này'); return; }
    revokeRecoveryUrls();
    const newSession = await window.photobooth.session.create('photo');
    state.session = newSession;
    state.sessionFinished = false;
    state.shots = [];
    state.photoTransforms = {};
    for (const item of originals) {
      const saved = await window.photobooth.session.save({ sessionId: newSession.id, kind: item.kind, extension: 'jpg', bytes: item.bytes });
      const url = URL.createObjectURL(bytesToBlob(item));
      state.recoveryShotUrls.add(url);
      state.shots.push({ artifactId: saved.id, kind: saved.kind, dataUrl: url });
      state.photoTransforms[saved.id] = { panX: 50, panY: 50, zoom: 1, rotation: 0 };
    }
    await ensureQrDataUrl();
    state.selectionTargetCount = state.shots.length >= 8 ? 8 : state.shots.length >= 6 ? 6 : 4;
    state.selectedShotIndexes = new Set(state.shots.map((_, i) => i));
    state.slotAssignments = [];
    openFrameSelection();
  } catch (error) {
    toast(`Không mở được phiên: ${error.message}`); console.error(error);
  } finally {
    state.busy = false;
  }
}

async function refreshRecoverableSessions() {
  const [sessions, results] = await Promise.all([
    window.photobooth.session.listRecoverable(),
    window.photobooth.session.listResults()
  ]);
  const resultIds = new Set(results.map((sessionValue) => sessionValue.id));
  const entries = [
    ...results.map((sessionValue) => ({ type: 'result', sessionValue })),
    ...sessions.filter((sessionValue) => !resultIds.has(sessionValue.id)).map((sessionValue) => ({ type: 'capture', sessionValue }))
  ];
  const panel = $('#recoveryPanel');
  const list = $('#recoveryList');
  panel.hidden = entries.length === 0;
  $('#recoverySummary').textContent = entries.length ? `${entries.length} phiên chưa hoàn tất` : '';
  list.replaceChildren();
  entries.forEach(({ type, sessionValue }) => {
    const row = document.createElement('div'); row.className = 'recovery-item';
    const text = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = new Date(sessionValue.createdAt).toLocaleString('vi-VN');
    const detail = document.createElement('small');
    detail.textContent = type === 'result'
      ? 'Kết quả đã ghép · sẵn sàng mở lại và in'
      : `${sessionValue.items.filter((item) => ['photo-original', 'dslr-original'].includes(item.kind)).length} ảnh local`;
    text.append(title, detail);
    const actions = document.createElement('div');
    const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'small-button';
    resume.textContent = type === 'result' ? 'Mở kết quả' : 'Khôi phục';
    resume.onclick = () => type === 'result' ? restoreResultSession(sessionValue.id) : resumeSession(sessionValue.id);
    actions.append(resume);
    if (type === 'capture') {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'Xóa';
      remove.onclick = async () => { await window.photobooth.session.cancel(sessionValue.id); await refreshRecoverableSessions(); await refreshStats(); };
      actions.append(remove);
    }
    row.append(text, actions); list.append(row);
  });
}

async function resumeSession(sessionId) {
  if (state.busy) return;
  state.busy = true;
  state.navigatedFromSessions = true;
  try {
    revokeRecoveryUrls();
    const sessionValue = await window.photobooth.session.resume(sessionId);
    const originals = await window.photobooth.session.readOriginals({ sessionId, artifactIds: sessionValue.items.filter((item) => ['photo-original', 'dslr-original'].includes(item.kind)).map((item) => item.id) });
    state.session = sessionValue;
    state.sessionFinished = false;
    state.shots = originals.map((item) => {
      const url = URL.createObjectURL(bytesToBlob(item));
      state.recoveryShotUrls.add(url);
      return { artifactId: item.id, kind: item.kind, dataUrl: url };
    });
    await ensureQrDataUrl();
    const draft = sessionValue.draft || {};
    state.selectionTargetCount = normalizeTargetCount(draft.targetCount, state.shots.length >= 8 ? 8 : state.shots.length >= 6 ? 6 : 4);
    state.selectedShotIndexes = new Set(state.shots.map((_, index) => index));
    state.photoTransforms = structuredClone(draft.transforms || {});
    state.shots.forEach((shot) => { state.photoTransforms[shot.artifactId] ??= { panX: 50, panY: 50, zoom: 1, rotation: 0 }; });
    state.slotAssignments = Array.isArray(draft.slotAssignments) ? draft.slotAssignments.slice(0, state.selectionTargetCount) : [];
    state.selectedFrame = state.frames.find((frame) => frame.id === draft.frameId) || state.selectedFrame;
    if (state.shots.length < state.selectionTargetCount) {
      state.captureGeneration += 1;
      const count = state.selectionTargetCount;
      state.config.camera.candidateCount = count;
      showScreen('captureScreen');
      updateTimelapseStatus('hidden');
      $('#captureMessage').textContent = `Đã khôi phục ${state.shots.length}/${count} ảnh · tiếp tục chụp ảnh còn thiếu`;
      $('#shotProgress').innerHTML = Array.from({ length: count }, (_value, index) => `<i class="${index < state.shots.length ? 'done' : ''}"></i>`).join('');
      $('#captureThumbnails').replaceChildren();
      state.shots.forEach((shot) => addCaptureThumbnail(shot.dataUrl));
      if (state.shots.length >= 4) $('#captureNextButton').hidden = false;
      await startCamera();
      startTimelapseRecording();
    } else {
      openFrameSelection();
    }
  } catch (error) {
    toast(`Không khôi phục được phiên: ${error.message}`);
    console.error(error);
  } finally {
    state.busy = false;
    await refreshRecoverableSessions();
  }
}

async function restoreResultSession(sessionId) {
  if (state.busy) return;
  state.busy = true;
  state.navigatedFromSessions = true;
  try {
    clearResultState();
    const result = await window.photobooth.session.restoreResult(sessionId);
    const blob = bytesToBlob(result);
    state.session = result.session;
    state.sessionFinished = true;
    state.resultBlob = blob;
    state.resultDataUrl = URL.createObjectURL(blob);
    state.resultProfile = result.profile || '4x6-portrait';
    state.resultArtifactId = result.item.id;
    state.galleryUrl = result.galleryUrl;
    await ensureQrDataUrl();
    showResult();
    await showQr(result.galleryUrl);
  } catch (error) {
    toast(`Không mở được kết quả: ${error.message}`);
    console.error(error);
  } finally {
    state.busy = false;
    await refreshRecoverableSessions();
  }
}

async function beginCapture() {
  if (state.busy || state.shots.length >= MAX_SHOTS) return;
  state.busy = true; $('#shutterButton').disabled = true;
  const generation = state.captureGeneration;
  try {
    if (!state.session) state.session = await window.photobooth.session.create('photo');
    const count = candidateCount();
    if (state.config.camera.captureWorkflow === 'auto') {
      await runPhotoAuto(generation);
    } else {
      const index = state.shots.length;
      await captureAndStoreShot(index, count, generation);
      if (state.shots.length >= MAX_SHOTS) {
        $('#captureMessage').textContent = `Đã chụp đủ ${MAX_SHOTS} ảnh · nhấn "Tiếp theo" để tiếp tục`;
      } else {
        $('#captureMessage').textContent = `Đã chụp ${state.shots.length} ảnh · nhấn nút để chụp tiếp`;
      }
    }
  } catch (error) {
    if (generation === state.captureGeneration) toast(error.message);
    if (error.message !== 'Đã hủy thao tác chụp') console.error(error);
  } finally {
    state.busy = false;
    $('#shutterButton').disabled = state.shots.length >= MAX_SHOTS;
    $('#countdown').textContent = '';
  }
}

function showResult() {
  stopCamera(); showScreen('resultScreen');
  const img = document.createElement('img');
  img.src = state.resultDataUrl; img.alt = 'Kết quả photobooth';
  img.style.cursor = 'zoom-in';
  img.onclick = () => openZoom(state.resultDataUrl);
  $('#resultMedia').replaceChildren(img);
  state.printCopies = 1;
  $('#printCopiesDisplay').textContent = '1 bản';
  $('#printButton').style.display = 'inline-block';
  $('#finishButton').textContent = state.navigatedFromSessions ? 'Về danh sách session →' : 'Hoàn tất về trang chủ';
  $('#resultStatus').textContent = state.config.drive.enabled ? 'Gallery đã sẵn sàng · ảnh đang đồng bộ lên Google Drive…' : 'Gallery local đã sẵn sàng';
  refreshStats();
}

async function changeFrameFromResult() {
  if (state.busy || !state.session) return;
  await ensureQrDataUrl();
  if (!state.shots.length) {
    state.busy = true;
    try {
      const originals = await window.photobooth.session.readOriginalsAny({ sessionId: state.session.id });
      if (!originals || !originals.length) { toast('Không tìm thấy ảnh gốc để đổi khung'); return; }
      revokeRecoveryUrls();
      state.shots = [];
      state.photoTransforms = {};
      for (const item of originals) {
        const url = URL.createObjectURL(bytesToBlob(item));
        state.recoveryShotUrls.add(url);
        state.shots.push({ artifactId: item.id, kind: item.kind, dataUrl: url });
        state.photoTransforms[item.id] = { panX: 50, panY: 50, zoom: 1, rotation: 0 };
      }
      state.selectionTargetCount = state.shots.length >= 8 ? 8 : state.shots.length >= 6 ? 6 : 4;
      state.selectedShotIndexes = new Set(state.shots.map((_, i) => i));
      state.slotAssignments = [];
    } catch (error) {
      toast(`Lỗi đọc ảnh gốc: ${error.message}`);
      console.error(error);
      return;
    } finally {
      state.busy = false;
    }
  }
  openFrameSelection();
}

function applyZoomTransform() {
  const img = $('#zoomImage');
  const wrap = $('.zoom-image-wrap');
  if (!img) return;
  img.style.transform = `translate(${state.zoomTranslateX}px, ${state.zoomTranslateY}px) scale(${state.zoomScale})`;
  if (wrap) wrap.classList.toggle('dragging', state.isZoomDragging);
  if (!state.isZoomDragging) {
    img.style.cursor = state.zoomScale > 1 ? 'grab' : 'zoom-in';
  }
}

function openZoom(src) {
  state.zoomScale = 1;
  state.zoomTranslateX = 0;
  state.zoomTranslateY = 0;
  state.isZoomDragging = false;
  const img = $('#zoomImage');
  if (img) img.src = src;
  applyZoomTransform();
  $('#zoomModal')?.classList.add('open');
}

function closeZoom() {
  state.isZoomDragging = false;
  $('#zoomModal')?.classList.remove('open');
  setTimeout(() => {
    const img = $('#zoomImage');
    if (img) img.src = '';
    state.zoomScale = 1;
    state.zoomTranslateX = 0;
    state.zoomTranslateY = 0;
  }, 250);
}

let cropState = {
  artifactId: '',
  dataUrl: '',
  slotWidth: 1000,
  slotHeight: 1000,
  panX: 50,
  panY: 50,
  zoom: 1,
  rotation: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  initialPanX: 50,
  initialPanY: 50,
  savedTransform: null
};

function openCropModal(artifactId) {
  if (!artifactId) return;
  const shot = state.shots.find((s) => s.artifactId === artifactId);
  if (!shot) return;
  const slotIndex = state.activeSlotIndex >= 0 ? state.activeSlotIndex : 0;
  const slots = resolvePhotoSlots(state.selectedFrame, state.selectionTargetCount);
  const slot = slots[slotIndex] || { width: 1000, height: 1000 };
  
  const existing = state.photoTransforms[artifactId] || { panX: 50, panY: 50, zoom: 1, rotation: 0 };
  cropState = {
    artifactId,
    dataUrl: shot.dataUrl,
    slotWidth: slot.width,
    slotHeight: slot.height,
    panX: existing.panX,
    panY: existing.panY,
    zoom: existing.zoom,
    rotation: existing.rotation,
    savedTransform: structuredClone(existing),
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    initialPanX: existing.panX,
    initialPanY: existing.panY
  };
  
  $('#cropModalSlotTitle').textContent = `Chỉnh vị trí Ô ${slotIndex + 1}`;
  const img = $('#cropTargetImage');
  img.src = shot.dataUrl;
  $('#cropModalZoom').value = cropState.zoom;
  
  const dialog = $('#cropModal');
  if (dialog) {
    dialog.showModal();
    img.onload = () => updateCropModalLayout();
    requestAnimationFrame(updateCropModalLayout);
  }
}

function closeCropModal(canceled = false) {
  cropState.isDragging = false;
  if (canceled && cropState.artifactId && cropState.savedTransform) {
    state.photoTransforms[cropState.artifactId] = cropState.savedTransform;
    scheduleFramePreview(0);
  }
  const dialog = $('#cropModal');
  if (dialog) dialog.close();
}

function updateCropModalLayout() {
  const container = $('#cropViewportContainer');
  const cropBox = $('#cropBox');
  const stage = $('#cropImageStage');
  const img = $('#cropTargetImage');
  if (!container || !cropBox || !stage || !img) return;

  const containerW = container.clientWidth || 500;
  const containerH = container.clientHeight || 380;
  const padding = 24;
  const maxW = containerW - padding * 2;
  const maxH = containerH - padding * 2;
  
  const slotAspect = cropState.slotWidth / cropState.slotHeight;
  let boxW, boxH;
  if (maxW / maxH > slotAspect) {
    boxH = maxH;
    boxW = boxH * slotAspect;
  } else {
    boxW = maxW;
    boxH = boxW / slotAspect;
  }
  cropBox.style.width = `${Math.round(boxW)}px`;
  cropBox.style.height = `${Math.round(boxH)}px`;

  const naturalW = img.naturalWidth || 800;
  const naturalH = img.naturalHeight || 600;
  const isRotatedQuarter = cropState.rotation % 180 !== 0;
  const SW = isRotatedQuarter ? naturalH : naturalW;
  const SH = isRotatedQuarter ? naturalW : naturalH;

  let cropW, cropH;
  if (SW / SH > slotAspect) {
    cropH = SH;
    cropW = cropH * slotAspect;
  } else {
    cropW = SW;
    cropH = cropW / slotAspect;
  }
  cropW = Math.min(SW, cropW / Math.max(1, cropState.zoom));
  cropH = Math.min(SH, cropH / Math.max(1, cropState.zoom));

  const left = Math.max(0, Math.min(SW - cropW, (SW - cropW) * (cropState.panX / 100)));
  const top = Math.max(0, Math.min(SH - cropH, (SH - cropH) * (cropState.panY / 100)));

  const scaleBox = boxW / cropW;
  cropState.scaleBox = scaleBox;
  cropState.cropW = cropW;
  cropState.cropH = cropH;
  cropState.SW = SW;
  cropState.SH = SH;

  const stageW = SW * scaleBox;
  const stageH = SH * scaleBox;
  const stageLeft = -left * scaleBox;
  const stageTop = -top * scaleBox;

  stage.style.width = `${Math.round(stageW)}px`;
  stage.style.height = `${Math.round(stageH)}px`;
  stage.style.transform = `translate(${stageLeft}px, ${stageTop}px)`;

  const rot = cropState.rotation % 360;
  img.style.width = `${Math.round(naturalW * scaleBox)}px`;
  img.style.height = `${Math.round(naturalH * scaleBox)}px`;
  if (rot === 90) {
    img.style.transform = `rotate(90deg) translate(0, -100%)`;
  } else if (rot === 180) {
    img.style.transform = `rotate(180deg) translate(-100%, -100%)`;
  } else if (rot === 270) {
    img.style.transform = `rotate(270deg) translate(-100%, 0)`;
  } else {
    img.style.transform = 'none';
  }

  const miniWrap = $('#cropMiniPreviewWrap');
  const miniBox = $('#cropMiniBox');
  const miniStage = $('#cropMiniStage');
  const miniImg = $('#cropMiniPreviewImg');
  if (miniWrap && miniBox && miniStage && miniImg) {
    miniImg.src = cropState.dataUrl;
    const miniWrapW = miniWrap.clientWidth || 240;
    const miniWrapH = miniWrap.clientHeight || 150;
    let miniBoxW, miniBoxH;
    if (miniWrapW / miniWrapH > slotAspect) {
      miniBoxH = miniWrapH - 12; miniBoxW = miniBoxH * slotAspect;
    } else {
      miniBoxW = miniWrapW - 12; miniBoxH = miniBoxW / slotAspect;
    }
    miniBox.style.width = `${Math.round(miniBoxW)}px`;
    miniBox.style.height = `${Math.round(miniBoxH)}px`;

    const scaleMini = miniBoxW / cropW;
    miniStage.style.width = `${Math.round(SW * scaleMini)}px`;
    miniStage.style.height = `${Math.round(SH * scaleMini)}px`;
    miniStage.style.transform = `translate(${-left * scaleMini}px, ${-top * scaleMini}px)`;
    miniImg.style.width = `${Math.round(naturalW * scaleMini)}px`;
    miniImg.style.height = `${Math.round(naturalH * scaleMini)}px`;
    if (rot === 90) {
      miniImg.style.transform = `rotate(90deg) translate(0, -100%)`;
    } else if (rot === 180) {
      miniImg.style.transform = `rotate(180deg) translate(-100%, -100%)`;
    } else if (rot === 270) {
      miniImg.style.transform = `rotate(270deg) translate(-100%, 0)`;
    } else {
      miniImg.style.transform = 'none';
    }
  }

  if (cropState.artifactId) {
    state.photoTransforms[cropState.artifactId] = {
      panX: cropState.panX,
      panY: cropState.panY,
      zoom: cropState.zoom,
      rotation: cropState.rotation
    };
    scheduleFramePreview(50);
  }
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

async function openMode() { state.mode = 'photo'; state.navigatedFromSessions = false; await openCapture(); }

async function openCapture() {
  state.navigatedFromSessions = false;
  state.captureGeneration += 1;
  if (state.sessionFinished) await acknowledgeCurrentResult().catch(() => { });
  clearResultState();
  state.captureGeneration += 1;
  clearTimeout(state.draftTimer);
  const previousSession = state.session;
  const previousFinished = state.sessionFinished;
  const stopped = await stopTimelapseRecording({ save: false }).catch(() => ({ savePromise: state.timelapseSavePromise }));
  await stopped?.savePromise?.catch(() => { });
  stopCamera();
  if (previousSession && !previousFinished) await window.photobooth.session.cancel(previousSession.id).catch(() => { });
  state.session = null; state.sessionFinished = false; revokeRecoveryUrls(); state.shots = [];
  state.photoTransforms = {}; state.activeTransformId = ''; state.selectedShotIndexes = new Set(); state.selectionTargetCount = candidateCount(); state.slotAssignments = []; state.activeSlotIndex = -1; state.pendingArtifactId = ''; state.galleryUrl = ''; state.qrDataUrl = ''; state.timelapseSavePromise = null;
  
  await appendCapture();
}

async function appendCapture() {
  state.captureGeneration += 1;
  clearTimeout(state.draftTimer);
  showScreen('captureScreen');
  updateTimelapseStatus('hidden');
  
  $('#captureThumbnails').replaceChildren();
  state.shots.forEach((shot) => addCaptureThumbnail(shot.dataUrl));
  
  $('#captureNextButton').hidden = state.shots.length === 0;
  $('#shutterButton').disabled = state.shots.length >= MAX_SHOTS;
  
  const count = candidateCount();
  if (state.shots.length === 0) {
    $('#captureMessage').textContent = state.config.camera.captureWorkflow === 'manual' ? 'Nhấn nút để chụp ảnh 1' : 'Nhấn nút để bắt đầu chụp tự động';
  } else if (state.shots.length >= MAX_SHOTS) {
    $('#captureMessage').textContent = `Đã chụp đủ ${MAX_SHOTS} ảnh · nhấn "Tiếp theo" để xếp khung`;
  } else {
    $('#captureMessage').textContent = `Đã chụp ${state.shots.length} ảnh · nhấn nút để chụp ảnh ${state.shots.length + 1} hoặc nhấn "Tiếp theo"`;
  }

  const dotsCount = Math.max(count, state.shots.length);
  $('#shotProgress').innerHTML = Array.from({ length: dotsCount }, (_value, index) => 
    `<i class="${index < state.shots.length ? 'done' : ''}"></i>`
  ).join('');
  
  $('#liveFrame').removeAttribute('src'); $('#liveFrame').style.display = 'none';

  try {
    await startCamera();
    if (!state.session) {
      state.session = await window.photobooth.session.create('photo');
    }
    startTimelapseRecording();
  } catch (error) {
    stopCamera();
    toast(`Không mở được camera: ${error.message}`);
  }
}

async function goHome() {
  state.captureGeneration += 1;
  clearTimeout(state.draftTimer);
  const currentSession = state.session;
  const currentFinished = state.sessionFinished;
  if (currentFinished) await acknowledgeCurrentResult().catch(() => { });
  const stopped = await stopTimelapseRecording({ save: false }).catch(() => ({ savePromise: state.timelapseSavePromise }));
  await stopped?.savePromise?.catch(() => { });
  stopCamera(); showScreen('homeScreen');
  updateTimelapseStatus('hidden');
  if (currentSession && !currentFinished) await window.photobooth.session.cancel(currentSession.id).catch(() => { });
  clearResultState();
  state.session = null; state.sessionFinished = false; revokeRecoveryUrls(); state.shots = []; state.photoTransforms = {}; state.activeTransformId = ''; state.slotAssignments = []; state.activeSlotIndex = -1; refreshStats(); refreshRecoverableSessions();
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
  const select = $('#cameraDevice');
  if (!select) return;
  try {
    let devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
    if (devices.some((d) => !d.label)) {
      try {
        const temporary = await navigator.mediaDevices.getUserMedia({ video: true });
        devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
        temporary.getTracks().forEach((track) => track.stop());
      } catch (err) {
        console.warn('Temporary camera acquisition failed:', err);
      }
    }
    select.replaceChildren(new Option('Tự động chọn Camera', ''));
    if (devices.length === 0) {
      select.add(new Option('Không tìm thấy thiết bị webcam', ''));
    } else {
      devices.forEach((device, index) => {
        const label = device.label || `Webcam ${index + 1} (${device.deviceId.slice(0, 6)})`;
        select.add(new Option(label, device.deviceId));
      });
    }
    select.value = state.config.camera.deviceId || '';
  } catch (error) {
    console.error('Lỗi đọc danh sách camera:', error);
    select.replaceChildren(new Option('Tự động chọn Camera', ''));
  }
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
  state.config = await window.photobooth.config.get(); state.selectionTargetCount = candidateCount(); applyBranding(); await loadFrames(); await refreshStats(); await refreshRecoverableSessions();
  $$('.mode-card').forEach((button) => button.onclick = openMode);
  $$('[data-back]').forEach((button) => button.onclick = goHome);
  $('#confirmFrame').onclick = finalizePhoto; $('#confirmShots').onclick = openFrameSelection;
  $('#selectionTarget').onchange = changeSelectionTarget;
  $('#zoomComposition').onclick = () => { if (state.framePreviewUrl) openZoom(state.framePreviewUrl); };
  $('#captureNextButton').onclick = () => { if (!state.busy) finishCapturePhase().catch((error) => toast(error.message)); };
  $('#backToSelection').onclick = () => {
    if (state.navigatedFromSessions) openSessionsScreen();
    else appendCapture();
  };
  if ($('#retakeAll')) {
    $('#retakeAll').onclick = () => {
      if (state.navigatedFromSessions) openSessionsScreen();
      else openCapture();
    };
  }
  $('#shutterButton').onclick = beginCapture;
  $('#cancelCapture').onclick = () => {
    if (state.shots.length > 0) openFrameSelection();
    else goHome();
  };
  $('#brandHome').onclick = goHome; $('#settingsButton').onclick = openSettings; $('#settingsForm').onsubmit = saveSettings;
  $('#settingsClose').onclick = () => $('#settingsDialog').close();
  $('#settingsCancel').onclick = () => $('#settingsDialog').close();
  $('#retakeButton').onclick = openMode;
  $('#changeFrameButton').onclick = changeFrameFromResult;
  $('#resultBack').onclick = () => {
    if (state.navigatedFromSessions) openSessionsScreen();
    else goHome();
  };
  $('#finishButton').onclick = () => {
    if (state.navigatedFromSessions) openSessionsScreen();
    else goHome();
  };
  $('#printDecrease').onclick = () => {
    if (state.printCopies > 1) { state.printCopies -= 1; $('#printCopiesDisplay').textContent = `${state.printCopies} bản`; }
  };
  $('#printIncrease').onclick = () => {
    if (state.printCopies < 5) { state.printCopies += 1; $('#printCopiesDisplay').textContent = `${state.printCopies} bản`; }
  };
  $('#printButton').onclick = async () => {
    const dataUrl = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(state.resultBlob); });
    const result = await window.photobooth.print({ dataUrl, profile: state.resultProfile, copies: state.printCopies });
    toast(result.ok ? `Đã gửi lệnh in ${state.printCopies} bản` : `Không in được: ${result.error}`);
  };

  const zoomWrap = $('.zoom-image-wrap');
  if (zoomWrap) {
    zoomWrap.onpointerdown = (event) => {
      if (!$('#zoomModal').classList.contains('open')) return;
      if (event.target.closest('.zoom-controls')) return;
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      state.isZoomDragging = true;
      state.zoomDragStartX = event.clientX - state.zoomTranslateX;
      state.zoomDragStartY = event.clientY - state.zoomTranslateY;
      zoomWrap.setPointerCapture?.(event.pointerId);
      applyZoomTransform();
    };
    zoomWrap.onpointermove = (event) => {
      if (!state.isZoomDragging) return;
      state.zoomTranslateX = event.clientX - state.zoomDragStartX;
      state.zoomTranslateY = event.clientY - state.zoomDragStartY;
      applyZoomTransform();
    };
    const endDrag = (event) => {
      if (!state.isZoomDragging) return;
      state.isZoomDragging = false;
      if (event.pointerId !== undefined) {
        try { zoomWrap.releasePointerCapture(event.pointerId); } catch {}
      }
      applyZoomTransform();
    };
    zoomWrap.onpointerup = endDrag;
    zoomWrap.onpointercancel = endDrag;
  }

  $('#zoomIn').onclick = () => {
    state.zoomScale = Math.min(state.zoomScale + 0.35, 4);
    applyZoomTransform();
  };
  $('#zoomOut').onclick = () => {
    state.zoomScale = Math.max(state.zoomScale - 0.35, 0.8);
    if (state.zoomScale <= 1) { state.zoomTranslateX = 0; state.zoomTranslateY = 0; }
    applyZoomTransform();
  };
  $('#zoomClose').onclick = closeZoom;
  $('#zoomBackdrop').onclick = closeZoom;
  $('#zoomModal').addEventListener('wheel', (event) => {
    if (!$('#zoomModal').classList.contains('open')) return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.25 : -0.25;
    state.zoomScale = Math.max(0.8, Math.min(4, state.zoomScale + delta));
    if (state.zoomScale <= 1) { state.zoomTranslateX = 0; state.zoomTranslateY = 0; }
    applyZoomTransform();
  }, { passive: false });

  const cropContainer = $('#cropViewportContainer');
  if (cropContainer) {
    cropContainer.onpointerdown = (event) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      cropState.isDragging = true;
      cropState.dragStartX = event.clientX;
      cropState.dragStartY = event.clientY;
      cropState.initialPanX = cropState.panX;
      cropState.initialPanY = cropState.panY;
      cropContainer.setPointerCapture?.(event.pointerId);
    };
    cropContainer.onpointermove = (event) => {
      if (!cropState.isDragging) return;
      const dx = event.clientX - cropState.dragStartX;
      const dy = event.clientY - cropState.dragStartY;
      const scaleBox = cropState.scaleBox || 1;
      const rangeX = (cropState.SW - cropState.cropW);
      const rangeY = (cropState.SH - cropState.cropH);
      
      if (rangeX > 0) {
        const dPanX = (-dx / scaleBox) / rangeX * 100;
        cropState.panX = Math.max(0, Math.min(100, cropState.initialPanX + dPanX));
      }
      if (rangeY > 0) {
        const dPanY = (-dy / scaleBox) / rangeY * 100;
        cropState.panY = Math.max(0, Math.min(100, cropState.initialPanY + dPanY));
      }
      updateCropModalLayout();
    };
    const endCropDrag = (event) => {
      if (!cropState.isDragging) return;
      cropState.isDragging = false;
      if (event.pointerId !== undefined) {
        try { cropContainer.releasePointerCapture(event.pointerId); } catch {}
      }
    };
    cropContainer.onpointerup = endCropDrag;
    cropContainer.onpointercancel = endCropDrag;
    cropContainer.onwheel = (event) => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.1 : -0.1;
      cropState.zoom = Math.max(1, Math.min(4, cropState.zoom + delta));
      $('#cropModalZoom').value = cropState.zoom;
      updateCropModalLayout();
    };
  }

  $('#cropModalZoom').oninput = (event) => {
    cropState.zoom = Number(event.target.value);
    updateCropModalLayout();
  };
  $('#cropRotateLeft').onclick = () => {
    cropState.rotation = (cropState.rotation - 90 + 360) % 360;
    updateCropModalLayout();
  };
  $('#cropRotateRight').onclick = () => {
    cropState.rotation = (cropState.rotation + 90) % 360;
    updateCropModalLayout();
  };
  $('#cropResetBtn').onclick = () => {
    cropState.panX = 50; cropState.panY = 50; cropState.zoom = 1; cropState.rotation = 0;
    $('#cropModalZoom').value = 1;
    updateCropModalLayout();
  };
  $('#cropModalClose').onclick = closeCropModal;
  $('#cropCancelBtn').onclick = closeCropModal;
  $('#cropApplyBtn').onclick = () => {
    if (cropState.artifactId) {
      state.photoTransforms[cropState.artifactId] = {
        panX: cropState.panX,
        panY: cropState.panY,
        zoom: cropState.zoom,
        rotation: cropState.rotation
      };
      renderTransformControls();
      scheduleFramePreview(0);
      scheduleDraftSave();
    }
    closeCropModal();
  };
  $('#openSessionsBtn').onclick = openSessionsScreen;
  $('#sessionsBack').onclick = () => { revokeSessionThumbUrls(); showScreen('homeScreen'); };
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
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('#zoomModal').classList.contains('open')) { closeZoom(); return; }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') openSettings();
  });
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

init().then(() => {
  toast('READY');
}).catch((error) => { console.error(error); toast(error.message); });
