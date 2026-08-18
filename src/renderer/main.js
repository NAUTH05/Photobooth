import QRCode from 'qrcode';
import { containRect } from '../shared/image-layout.js';
import { LUT_PRESETS } from '../shared/lut-presets.js';
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
  timelapseRecording: null, timelapseSavePromise: null, photoTransforms: {}, activeTransformId: '', previewTimer: null, previewPayloadSignature: '', draftTimer: null,
  printCopies: 1, zoomScale: 1, zoomTranslateX: 0, zoomTranslateY: 0, isZoomDragging: false, zoomDragStartX: 0, zoomDragStartY: 0,
  zoomReturnFocus: null, recoveryShotUrls: new Set(), captureGeneration: 0, navigatedFromSessions: false, lutId: 'natural',
  luts: LUT_PRESETS.map(({ table: _table, ...lut }) => lut), lutPreviewUrls: new Map(), lutPreviewGeneration: 0,
};

function availableLut(value = state.lutId) {
  return state.luts.find((lut) => lut.id === String(value || ''))
    || state.luts.find((lut) => lut.id === 'natural')
    || state.luts[0];
}

const normalizeAvailableLutId = (value) => availableLut(value)?.id || 'natural';

const lutPreviewKey = (shot, maxWidth) => `${shot.artifactId}:${state.lutId}:${maxWidth}`;

function clearLutPreviewUrls() {
  state.lutPreviewGeneration += 1;
  for (const url of state.lutPreviewUrls.values()) URL.revokeObjectURL(url);
  state.lutPreviewUrls.clear();
}

async function requestShotLutPreview(shot, maxWidth) {
  if (state.lutId === 'natural') return shot.dataUrl;
  const key = lutPreviewKey(shot, maxWidth);
  if (state.lutPreviewUrls.has(key)) return state.lutPreviewUrls.get(key);
  const selectedLutId = state.lutId;
  const result = await window.photobooth.luts.renderArtifact({
    sessionId: state.session?.id,
    artifactId: shot.artifactId,
    lutId: selectedLutId,
    maxWidth
  });
  if (selectedLutId !== state.lutId) return '';
  const url = URL.createObjectURL(bytesToBlob(result));
  state.lutPreviewUrls.set(key, url);
  while (state.lutPreviewUrls.size > 40) {
    const oldestKey = state.lutPreviewUrls.keys().next().value;
    URL.revokeObjectURL(state.lutPreviewUrls.get(oldestKey));
    state.lutPreviewUrls.delete(oldestKey);
  }
  return url;
}

async function refreshShotLutPreviews() {
  const generation = ++state.lutPreviewGeneration;
  renderPhotoGallery();
  if (state.lutId === 'natural' || !state.session) return;
  for (const shot of selectedShots()) {
    try {
      await requestShotLutPreview(shot, 900);
      if (generation !== state.lutPreviewGeneration) return;
      renderPhotoGallery();
    } catch (error) {
      if (generation === state.lutPreviewGeneration) console.error('Không tạo được preview LUT cho ảnh lẻ', error);
    }
  }
}

async function openShotZoom(shot) {
  const thumbnail = state.lutPreviewUrls.get(lutPreviewKey(shot, 900));
  openZoom(thumbnail || shot.dataUrl, thumbnail ? 'none' : (availableLut().css || 'none'));
  if (state.lutId === 'natural') return;
  const selectedLutId = state.lutId;
  try {
    const url = await requestShotLutPreview(shot, 2600);
    if (!url || selectedLutId !== state.lutId || !$('#zoomModal')?.classList.contains('open')) return;
    $('#zoomImage').src = url;
    $('#zoomImage').style.filter = 'none';
  } catch (error) {
    toast(`Oops, chưa mở được ảnh lớn: ${error.message}`);
  }
}

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
  pill.classList.toggle('busy', stats.pending > 0 || stats.cloudPending > 0);
  pill.classList.toggle('error', stats.failed > 0 || stats.cloudFailed > 0);
  pill.querySelector('span').textContent = (stats.pending || stats.cloudPending) ? `${Math.max(stats.pending, stats.cloudPending)} bộ ảnh đang lưu nè~` : 'Mọi ảnh đã an toàn ✨';
  $('#queueStats').innerHTML = `Đang lưu album online: <b>${stats.cloudPending || 0}</b><br>Có thể tiếp tục: <b>${stats.recoverable || 0}</b><br>Đã lưu xong: <b>${stats.uploaded}</b><br>Dung lượng trên máy: <b>${(stats.localBytes / 1048576).toFixed(1)} MB</b>`;
}

async function loadFrames(force = false) {
  const manifest = force ? await window.photobooth.frames.sync() : await window.photobooth.frames.list();
  const selectedFrameId = state.selectedFrame?.id;
  state.frames = manifest.frames;
  state.selectedFrame = state.frames.find((frame) => frame.id === selectedFrameId) ?? state.frames[0] ?? null;
  if (force) {
    state.luts = await window.photobooth.luts.list();
    renderLutOptions();
  }
  renderFrames();
  return manifest;
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
    lutId: state.lutId,
    qrDataUrl: state.qrDataUrl || ''
  };
}

function compositePayloadSignature(payload = compositePayload()) {
  return JSON.stringify(payload);
}

function syncConfirmFrameButton() {
  const button = $('#confirmFrame');
  if (!button) return;
  const complete = validateSlotAssignments(state.slotAssignments, selectedArtifactIds(), state.selectionTargetCount);
  button.disabled = !complete || state.previewPayloadSignature !== compositePayloadSignature();
}

function bytesToBlob(result) {
  return new Blob([new Uint8Array(result.bytes)], { type: result.mimeType || 'image/jpeg' });
}

function scheduleFramePreview(delay = 80) {
  clearTimeout(state.previewTimer);
  syncConfirmFrameButton();
  const version = ++state.previewVersion;
  state.previewTimer = setTimeout(() => updateFramePreview(version).catch((error) => {
    if (version === state.previewVersion) toast(`Oops, chưa cập nhật được xem trước: ${error.message}`);
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
  panel.innerHTML = '<button type="button" class="crop-open-btn" id="openCropModalBtn">✂ Căn lại khoảnh khắc</button>';
  $('#photoTransformHost').append(panel);
  const cropBtn = panel.querySelector('#openCropModalBtn');
  if (cropBtn) {
    cropBtn.onclick = () => {
      if (state.activeTransformId) openCropModal(state.activeTransformId);
      else toast('Hãy chọn một ô ảnh trước nha~');
    };
  }
  return panel;
}

function renderTransformControls() {
  const panel = ensureTransformControls();
  const transform = state.photoTransforms[state.activeTransformId];
  panel.querySelector('#openCropModalBtn').disabled = !transform;
}

function selectGalleryPhoto(artifactId, { openCrop = false } = {}) {
  const assignedSlotIndex = state.slotAssignments.indexOf(artifactId);
  if (assignedSlotIndex < 0) {
    state.pendingArtifactId = artifactId;
    renderFrameEditor();
    if (openCrop) toast('Hãy đặt ảnh vào một ô trước nha~');
    return;
  }
  setActiveSlot(assignedSlotIndex);
  if (openCrop) openCropModal(artifactId);
}

function renderPhotoGallery() {
  const container = $('#framePhotoGallery');
  container.replaceChildren();
  selectedShots().forEach((shot, index) => {
    const assignedSlotIndex = state.slotAssignments.indexOf(shot.artifactId);
    const card = document.createElement('div');
    card.className = `frame-photo${state.pendingArtifactId === shot.artifactId || state.activeTransformId === shot.artifactId ? ' active' : ''}`;
    card.draggable = true;
    card.tabIndex = 0;
    card.role = 'button';
    card.setAttribute('aria-label', assignedSlotIndex >= 0
      ? `Chọn ảnh ${index + 1} ở ô ${assignedSlotIndex + 1} để chỉnh vị trí`
      : `Chọn ảnh ${index + 1} để gán vào khung`);
    card.dataset.artifactId = shot.artifactId;
    const exactPreview = state.lutPreviewUrls.get(lutPreviewKey(shot, 900));
    const image = document.createElement('img'); image.src = exactPreview || shot.dataUrl; image.alt = `Ảnh ${index + 1}`;
    image.style.filter = exactPreview ? 'none' : (availableLut().css || 'none');
    const label = document.createElement('small'); label.textContent = assignedSlotIndex >= 0 ? `ẢNH ${index + 1} · Ô ${assignedSlotIndex + 1}` : `ẢNH ${index + 1} · CHƯA XẾP`;
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'photo-edit'; edit.textContent = '✂'; edit.title = assignedSlotIndex >= 0 ? `Căn lại ảnh ô ${assignedSlotIndex + 1}` : 'Đặt ảnh vào ô trước';
    edit.disabled = assignedSlotIndex < 0;
    edit.onclick = (event) => { event.stopPropagation(); selectGalleryPhoto(shot.artifactId, { openCrop: true }); };
    const view = document.createElement('button'); view.type = 'button'; view.className = 'photo-view'; view.textContent = '⤢'; view.title = 'Ngắm ảnh thật rõ';
    view.onclick = (event) => { event.stopPropagation(); openShotZoom(shot); };
    card.append(image, label, edit, view);
    card.onclick = () => selectGalleryPhoto(shot.artifactId);
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
    const label = document.createElement('span'); label.textContent = artifactId ? `Ô ${index + 1}` : `ĐẶT ẢNH ${index + 1} VÀO ĐÂY`;
    element.append(label);
    if (artifactId) {
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'slot-clear'; clear.textContent = '×'; clear.title = 'Bỏ ảnh khỏi ô';
      clear.onclick = (event) => { event.stopPropagation(); updateAssignments(clearSlot(state.slotAssignments, index), index); };
      const cropBtn = document.createElement('button'); cropBtn.type = 'button'; cropBtn.className = 'slot-crop-btn'; cropBtn.textContent = '✂'; cropBtn.title = 'Căn lại ảnh';
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
  syncConfirmFrameButton();
  const assigned = state.slotAssignments.filter(Boolean).length;
  $('#slotStatus').textContent = complete ? `Tuyệt vời · ${assigned}/${state.selectionTargetCount} ảnh đã vào đúng chỗ ✨` : `Đã xếp ${assigned}/${state.selectionTargetCount} tấm · lấp đầy ô còn lại nhé~`;
}

async function updateFramePreview(version, fixedPayload = null, fixedFrame = null) {
  const image = $('#framePreviewImage');
  const frameContainer = $('#framePreview');
  const smile = $('.preview-smile');
  const frame = fixedFrame || state.selectedFrame;
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
  const payload = fixedPayload || compositePayload(frame);
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
    state.previewPayloadSignature = compositePayloadSignature(payload);
    syncConfirmFrameButton();
    renderSlotOverlay();
    return true;
  } catch (error) {
    console.warn('Frame preview render failed:', error);
    syncConfirmFrameButton();
    return false;
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
  if (camera.deviceId) video.deviceId = { exact: camera.deviceId }; else if (camera.facingMode) video.facingMode = camera.facingMode;
  if (state.config.camera.mode === 'dslr') {
    $('#cameraVideo').style.display = 'none';
    $('#cameraModeLabel').textContent = 'MÁY ẢNH CHUYÊN DỤNG';
    if (state.config.timelapse?.enabled) {
      try { state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false }); }
      catch { updateTimelapseStatus('error', 'Chưa bật được camera quay hậu trường'); }
    }
    return;
  }
  $('#cameraVideo').style.display = 'block';
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (error) {
    console.warn('Constrained camera request failed, attempting fallback stream:', error);
    const fallback = camera.facingMode ? { facingMode: camera.facingMode } : true;
    state.stream = await navigator.mediaDevices.getUserMedia({ video: fallback, audio: false });
  }
  const element = $('#cameraVideo');
  element.srcObject = state.stream;
  element.classList.toggle('mirror', camera.mirrorPreview);
  element.style.filter = 'none';
  await element.play();
  $('#cameraModeLabel').textContent = 'CAMERA ĐANG BẬT';
}

/** Toggle mirror preview from the capture screen button. */
async function toggleMirrorPreview() {
  const current = Boolean(state.config?.camera?.mirrorPreview);
  const next = !current;
  const patch = {};
  setAtPath(patch, 'camera.mirrorPreview', next);
  state.config = await window.photobooth.config.save(patch);
  // Live update video element
  const video = $('#cameraVideo');
  if (video) video.classList.toggle('mirror', next);
  // Also sync the settings checkbox if open
  const checkbox = document.querySelector('[name="camera.mirrorPreview"]');
  if (checkbox) checkbox.checked = next;
  syncMirrorToggleButton();
}

/** Update mirror toggle button visual state. */
function syncMirrorToggleButton() {
  const btn = $('#mirrorToggleButton');
  if (!btn) return;
  const mirrored = Boolean(state.config?.camera?.mirrorPreview);
  btn.classList.toggle('active', mirrored);
  btn.setAttribute('aria-pressed', String(mirrored));
  btn.title = mirrored ? 'Tắt lật gương' : 'Bật lật gương';
}

function syncLutControls() {
  const selected = availableLut();
  $('#lutName').textContent = selected.label;
  $$('.lut-option').forEach((button) => {
    button.classList.toggle('active', button.dataset.lutId === selected.id);
    button.setAttribute('aria-pressed', String(button.dataset.lutId === selected.id));
    button.disabled = state.busy;
  });
  if ($('#importLutButton')) $('#importLutButton').disabled = state.busy;
}

function selectLut(lutId) {
  if (state.busy) return;
  state.lutId = normalizeAvailableLutId(lutId);
  syncLutControls();
  renderPhotoGallery();
  refreshShotLutPreviews();
  scheduleFramePreview(0);
  scheduleDraftSave('frame');
}

function renderLutOptions() {
  const picker = $('#lutOptions');
  picker.replaceChildren();
  for (const lut of state.luts) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lut-option';
    button.classList.toggle('custom', Boolean(lut.custom));
    button.dataset.lutId = lut.id;
    button.title = lut.description;
    button.setAttribute('aria-label', `${lut.label} · ${lut.description}`);
    const swatch = document.createElement('span');
    swatch.className = 'lut-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.setProperty('--lut-swatch', lut.swatch);
    const label = document.createElement('strong');
    label.textContent = lut.label;
    button.append(swatch, label);
    button.onclick = () => selectLut(lut.id);
    picker.append(button);
  }
  syncLutControls();
}

async function importCubeLuts() {
  if (state.busy) return;
  state.busy = true;
  syncLutControls();
  try {
    const result = await window.photobooth.luts.importCube();
    if (result.cancelled) return;
    state.luts = result.luts;
    renderLutOptions();
    if (result.imported.length) {
      state.lutId = normalizeAvailableLutId(result.imported[0].id);
      renderPhotoGallery();
      refreshShotLutPreviews();
      scheduleFramePreview(0);
      scheduleDraftSave('frame');
      const suffix = result.imported.length > 1 ? ` và ${result.imported.length - 1} LUT khác` : '';
      toast(`Đã thêm ${result.imported[0].label}${suffix} vào bộ sưu tập ✨`);
    }
  } catch (error) {
    toast(`Oops, chưa thêm được gam màu: ${error.message}`);
    console.error(error);
  } finally {
    state.busy = false;
    syncLutControls();
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
}

function updateTimelapseStatus(status, message) {
  const element = $('#timelapseStatus');
  element.className = `timelapse-status${status === 'hidden' ? '' : ` show ${status}`}`;
  element.querySelector('span').textContent = message || 'Một chút hậu trường nè~';
}

function startTimelapseRecording() {
  if (!state.config.timelapse?.enabled) return updateTimelapseStatus('hidden');
  if (!state.stream || typeof MediaRecorder === 'undefined') {
    return updateTimelapseStatus('error', 'Chưa bật được camera quay hậu trường');
  }
  const mimeType = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ].find((value) => MediaRecorder.isTypeSupported(value));
  if (!mimeType) return updateTimelapseStatus('error', 'Máy chưa hỗ trợ quay hậu trường nè');
  const chunks = [];
  const recorder = new MediaRecorder(state.stream, {
    mimeType,
    videoBitsPerSecond: Number(state.config.timelapse.videoBitsPerSecond) || 4000000
  });
  let resolveStopped;
  let rejectStopped;
  const stopped = new Promise((resolve, reject) => { resolveStopped = resolve; rejectStopped = reject; });
  recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
  recorder.onerror = (event) => rejectStopped(event.error || new Error('Chưa ghi được đoạn phim hậu trường'));
  recorder.onstop = () => resolveStopped(new Blob(chunks, { type: recorder.mimeType || mimeType }));
  state.timelapseSavePromise = null;
  state.timelapseRecording = { recorder, stopped, stopTask: null };
  recorder.start(1000);
  updateTimelapseStatus('recording', 'Đang quay hậu trường nè~');
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
    updateTimelapseStatus('processing', 'Đang xử lý video hậu trường nè~');
    const sessionId = state.session.id;
    const savePromise = (async () => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return window.photobooth.timelapse.encode({ sessionId, bytes });
    })().then((result) => {
      updateTimelapseStatus('ready', 'Video hậu trường đã xong rồi nè ✨');
      return result;
    }).catch((error) => {
      console.error(error);
      updateTimelapseStatus('error', 'Chưa lưu được video hậu trường');
      toast(`Oops, chưa lưu được video hậu trường: ${error.message}`);
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
  const width = video.videoWidth || state.config.camera.width;
  const height = video.videoHeight || state.config.camera.height;
  console.info(`Webcam negotiated capture: ${width}x${height}`);

  const canvas = $('#cameraCanvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (state.config.camera.mirrorPreview) {
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.94);

  const item = await saveBlob(dataUrlToBlob(dataUrl), 'photo-original', 'jpg');
  return { artifactId: item.id, kind: item.kind, dataUrl, width, height };
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
    context.font = '400 19px Nunito'; context.fillText(new Date().toLocaleString('vi-VN'), label.x, label.y + 48, label.maxWidth);
    context.font = '600 15px Segoe UI'; context.fillText('QUÉT QR ĐỂ XEM ALBUM', label.x, label.y + 92, label.maxWidth);
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
  syncLutControls();
  const button = $('#confirmFrame');
  button.disabled = true; button.firstChild.textContent = 'Đang gói ghém bộ ảnh… ';
  try {
    await ensureQrDataUrl();
    await ensureFrameSlots(state.selectedFrame);
    const payload = compositePayload();
    const signature = compositePayloadSignature(payload);
    if (state.previewPayloadSignature !== signature) {
      clearTimeout(state.previewTimer);
      const version = ++state.previewVersion;
      await updateFramePreview(version, payload, state.selectedFrame);
    }
    if (state.previewPayloadSignature !== signature) throw new Error('Bản xem trước chưa kịp hoàn thiện, bạn thử lại một lần nữa nhé');
    button.firstChild.textContent = 'Đang tô màu từng khoảnh khắc… ';
    await window.photobooth.luts.prepareSession({
      sessionId: state.session.id,
      artifactIds: state.shots.map((shot) => shot.artifactId),
      lutId: state.lutId
    });
    button.firstChild.textContent = 'Đang ghép tấm ảnh thành phẩm… ';
    const result = await window.photobooth.composite.create(payload);
    const blob = bytesToBlob(result);
    state.resultBlob = blob;
    state.resultProfile = result.profile || '4x6-portrait';
    state.resultArtifactId = result.item?.id || '';
    state.resultDataUrl = URL.createObjectURL(blob);
    if (state.timelapseSavePromise) {
      button.firstChild.textContent = 'Đang gói đoạn phim hậu trường… ';
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
    syncLutControls();
    syncConfirmFrameButton();
    button.firstChild.textContent = 'Hoàn thiện bộ ảnh ';
  }
}

function addCaptureThumbnail(dataUrl) {
  const container = $('#captureThumbnails');
  const img = document.createElement('img');
  img.className = 'capture-thumb';
  img.src = dataUrl;
  img.alt = 'Ảnh vừa chụp';
  img.title = 'Chạm để ngắm tấm ảnh thật rõ';
  img.onclick = () => openZoom(dataUrl);
  container.append(img);
  img.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function captureAndStoreShot(index, count, generation = state.captureGeneration) {
  $('#captureMessage').textContent = `Ảnh ${index + 1}/${count} · cười thật tươi nhé~`;
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
    // Don't sleep after the last shot
    if (index < count - 1) {
      await sleep(state.config.camera.intervalSeconds * 1000);
    }
  }
  if (generation === state.captureGeneration) await finishCapturePhase();
}

function candidateCount() {
  return normalizeTargetCount(state.config.camera.candidateCount, 6);
}

async function finishCapturePhase() {
  await stopTimelapseRecording({ save: true }).catch((error) => {
    console.error(error);
    updateTimelapseStatus('error', 'Lỗi dừng quay hậu trường nè');
  });
  stopCamera();
  await ensureQrDataUrl();
  state.selectionTargetCount = Math.min(candidateCount(), state.shots.length >= 8 ? 8 : state.shots.length >= 6 ? 6 : 4);
  state.selectedShotIndexes = new Set(state.shots.map((_shot, index) => index));
  state.slotAssignments = [];
  openSelectionScreen();
  scheduleDraftSave();
}

function openSelectionScreen() {
  $('#selectionTarget').value = String(state.selectionTargetCount);
  renderShotSelection();
  showScreen('selectionScreen');
  scheduleDraftSave('selection');
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
      else return toast(`Chỉ được giữ ${state.selectionTargetCount} tấm thôi nha~`);
      state.slotAssignments = [];
      renderShotSelection();
      scheduleDraftSave();
    };
    const zoomBtn = document.createElement('button');
    zoomBtn.className = 'shot-zoom-btn'; zoomBtn.type = 'button'; zoomBtn.title = 'Ngắm tấm ảnh thật rõ'; zoomBtn.textContent = '⤢';
    zoomBtn.onclick = () => openZoom(shot.dataUrl);
    card.append(select, zoomBtn);
    container.append(card);
  });
  const complete = state.selectedShotIndexes.size === state.selectionTargetCount;
  $('#selectedCount').textContent = `Đã chọn ${state.selectedShotIndexes.size}/${state.selectionTargetCount} tấm`;
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
  await ensureQrDataUrl();
  const count = state.selectedShotIndexes.size || state.selectionTargetCount;
  $('#frameScreen .section-heading h2').textContent = `Chọn chiếc khung dành cho ${count} khoảnh khắc`;
  ensureAssignments();
  showScreen('frameScreen');
  syncLutControls();
  renderFrames();
  refreshShotLutPreviews();
  scheduleDraftSave('frame');
}

function revokeRecoveryUrls() {
  for (const url of state.recoveryShotUrls) URL.revokeObjectURL(url);
  state.recoveryShotUrls.clear();
}

function clearResultState() {
  if (state.resultDataUrl?.startsWith('blob:')) URL.revokeObjectURL(state.resultDataUrl);
  if (state.framePreviewUrl) URL.revokeObjectURL(state.framePreviewUrl);
  state.resultDataUrl = '';
  state.framePreviewUrl = '';
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
  return {
    targetCount: state.selectionTargetCount,
    selectedArtifactIds: selectedArtifactIds(),
    frameId: state.selectedFrame?.id || '',
    slotAssignments: state.slotAssignments,
    transforms: state.photoTransforms,
    lutId: state.lutId,
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
  grid.innerHTML = '<div class="session-empty">Đang tìm lại ảnh nè…</div>';
  try {
    const allSessions = await window.photobooth.session.listAll();
    const resultSessions = await window.photobooth.session.listResults().catch(() => []);
    const resultIds = new Set(resultSessions.map((s) => s.id));
    grid.replaceChildren();
    if (!allSessions.length) {
      grid.innerHTML = '<div class="session-empty">Chưa có lần chụp nào trên máy nè~</div>';
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
      info.innerHTML = `<strong>${date}</strong><small>${count} ảnh${hasResult ? ' · đã hoàn thành' : isRecoverable ? ' · chưa xong' : ''}</small>`;
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
    grid.innerHTML = `<div class="session-empty">Oops, chưa tải được danh sách: ${error.message}</div>`;
  }
}

// Creates a new session copying photos from any old session so user can reframe and reprint
async function reopenSession(sessionId) {
  if (state.busy) return;
  state.busy = true;
  state.navigatedFromSessions = true;
  try {
    revokeSessionThumbUrls();
    clearLutPreviewUrls();
    const originals = await window.photobooth.session.readOriginalsAny({ sessionId });
    if (!originals.length) { toast('Chưa tìm thấy ảnh nào để xem lại nè'); return; }
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
    openSelectionScreen();
  } catch (error) {
    toast(`Oops, chưa mở lại được ảnh: ${error.message}`); console.error(error);
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
  $('#recoverySummary').textContent = entries.length ? `${entries.length} lần chụp đang chờ bạn nè~` : '';
  list.replaceChildren();
  entries.forEach(({ type, sessionValue }) => {
    const row = document.createElement('div'); row.className = 'recovery-item';
    const text = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = new Date(sessionValue.createdAt).toLocaleString('vi-VN');
    const detail = document.createElement('small');
    detail.textContent = type === 'result'
      ? 'Ảnh đã xong · xem lại hoặc in thêm nhé~'
      : `${sessionValue.items.filter((item) => ['photo-original', 'dslr-original'].includes(item.kind)).length} khoảnh khắc đang chờ trên máy`;
    text.append(title, detail);
    const actions = document.createElement('div');
    const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'small-button';
    resume.textContent = type === 'result' ? 'Xem lại ảnh' : 'Chụp tiếp nha~';
    resume.onclick = () => type === 'result' ? restoreResultSession(sessionValue.id) : resumeSession(sessionValue.id);
    actions.append(resume);
    if (type === 'capture') {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'Xoá lần chụp này';
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
    clearLutPreviewUrls();
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
    // Restore selected shots from draft if available, otherwise select all
    if (Array.isArray(draft.selectedArtifactIds) && draft.selectedArtifactIds.length) {
      const artifactIdToIndex = new Map(state.shots.map((shot, index) => [shot.artifactId, index]));
      state.selectedShotIndexes = new Set(draft.selectedArtifactIds.map((id) => artifactIdToIndex.get(id)).filter((i) => i !== undefined));
    } else {
      state.selectedShotIndexes = new Set(state.shots.map((_, index) => index));
    }
    state.photoTransforms = structuredClone(draft.transforms || {});
    state.lutId = normalizeAvailableLutId(draft.lutId);
    state.shots.forEach((shot) => { state.photoTransforms[shot.artifactId] ??= { panX: 50, panY: 50, zoom: 1, rotation: 0 }; });
    state.slotAssignments = Array.isArray(draft.slotAssignments) ? draft.slotAssignments.slice(0, state.selectionTargetCount) : [];
    state.selectedFrame = state.frames.find((frame) => frame.id === draft.frameId) || state.selectedFrame;
    if (state.shots.length < state.selectionTargetCount) {
      state.captureGeneration += 1;
      const count = state.selectionTargetCount;
      state.config.camera.candidateCount = count;
      showScreen('captureScreen');
      updateTimelapseStatus('hidden');
      $('#captureMessage').textContent = `Đã tìm lại ${state.shots.length}/${count} tấm · chụp tiếp nhé~`;
      $('#shotProgress').innerHTML = Array.from({ length: count }, (_value, index) => `<i class="${index < state.shots.length ? 'done' : ''}"></i>`).join('');
      $('#captureThumbnails').replaceChildren();
      state.shots.forEach((shot) => addCaptureThumbnail(shot.dataUrl));
      if (state.shots.length >= 4) $('#captureNextButton').hidden = false;
      await startCamera();
    } else if (draft.step === 'frame' && state.slotAssignments.length) {
      openFrameSelection();
    } else {
      openSelectionScreen();
    }
  } catch (error) {
    toast(`Oops, chưa tiếp tục được: ${error.message}`);
    console.error(error);
  } finally {
    state.busy = false;
    syncLutControls();
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
    state.lutId = normalizeAvailableLutId(result.session.publishedLutId);
    state.resultBlob = blob;
    state.resultDataUrl = URL.createObjectURL(blob);
    state.resultProfile = result.profile || '4x6-portrait';
    state.resultArtifactId = result.item.id;
    state.galleryUrl = result.galleryUrl;
    await ensureQrDataUrl();
    showResult();
    await showQr(result.galleryUrl);
  } catch (error) {
    toast(`Oops, chưa mở lại được ảnh: ${error.message}`);
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
    // Start timelapse on first capture press to avoid recording idle time
    if (!state.timelapseRecording) startTimelapseRecording();
    const count = candidateCount();
    if (state.config.camera.captureWorkflow === 'auto') {
      await runPhotoAuto(generation);
    } else {
      const index = state.shots.length;
      await captureAndStoreShot(index, count, generation);
      if (state.shots.length >= MAX_SHOTS) {
        $('#captureMessage').textContent = `Đã chụp đủ ${MAX_SHOTS} tấm · cùng xem lại nào~`;
      } else {
        $('#captureMessage').textContent = `Đã chụp ${state.shots.length} tấm · sẵn sàng cho tấm tiếp theo nhé~`;
      }
    }
  } catch (error) {
    if (generation === state.captureGeneration) toast(error.message);
    if (error.message !== 'Đã hủy thao tác chụp') console.error(error);
  } finally {
    state.busy = false;
    $('#shutterButton').disabled = state.shots.length >= MAX_SHOTS;
    syncLutControls();
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
  $('#finishButton').textContent = state.navigatedFromSessions ? 'Về danh sách chụp trước →' : 'Về trang chủ';
  $('#resultStatus').textContent = state.config.cloudflare?.enabled ? 'Album đang được gói ghém · ảnh đang lưu an toàn…' : 'Album trên máy đã sẵn sàng rồi nè~';
  refreshStats();
}

async function changeFrameFromResult() {
  if (state.busy || !state.session) return;
  await ensureQrDataUrl();
  if (!state.shots.length) {
    state.busy = true;
    try {
      const originals = await window.photobooth.session.readOriginalsAny({ sessionId: state.session.id });
      if (!originals || !originals.length) { toast('Chưa tìm thấy ảnh nguyên bản để thử khung khác nè'); return; }
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
      toast(`Oops, chưa mở được ảnh nguyên bản: ${error.message}`);
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

function openZoom(src, filter = 'none') {
  state.zoomScale = 1;
  state.zoomTranslateX = 0;
  state.zoomTranslateY = 0;
  state.isZoomDragging = false;
  const img = $('#zoomImage');
  if (img) { img.src = src; img.style.filter = filter; }
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
  slotWidth: 1,
  slotHeight: 1,
  panX: 50,
  panY: 50,
  zoom: 1,
  rotation: 0,
  mirrored: false,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  initialPanX: 50,
  initialPanY: 50
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
    mirrored: existing.mirrored === true,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    initialPanX: existing.panX,
    initialPanY: existing.panY
  };
  
  $('#cropModalSlotTitle').textContent = `Căn lại ảnh ô ${slotIndex + 1} nha~`;
  const img = $('#cropTargetImage');
  img.src = shot.dataUrl;
  $('#cropModalZoom').value = cropState.zoom;
  $('#cropMirrorBtn').setAttribute('aria-pressed', String(cropState.mirrored));
  
  const dialog = $('#cropModal');
  if (dialog) {
    dialog.showModal();
    img.onload = () => updateCropModalLayout();
    requestAnimationFrame(updateCropModalLayout);
  }
}

function closeCropModal() {
  cropState.isDragging = false;
  const dialog = $('#cropModal');
  if (dialog) dialog.close();
}

function updateCropModalLayout() {
  const container = $('#cropViewportContainer');
  const cropBox = $('#cropBox');
  const stage = $('#cropImageStage');
  const mirrorLayer = $('#cropMirrorLayer');
  const img = $('#cropTargetImage');
  if (!container || !cropBox || !stage || !mirrorLayer || !img) return;

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
  mirrorLayer.style.transform = cropState.mirrored ? 'scaleX(-1)' : 'none';

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
  const miniStage = $('#cropMiniStage');
  const miniMirrorLayer = $('#cropMiniMirrorLayer');
  const miniImg = $('#cropMiniPreviewImg');
  if (miniWrap && miniStage && miniMirrorLayer && miniImg) {
    miniImg.src = cropState.dataUrl;
    const miniWrapW = miniWrap.clientWidth || 140;
    const miniWrapH = miniWrap.clientHeight || 140;
    let miniBoxW, miniBoxH;
    if (miniWrapW / miniWrapH > slotAspect) {
      miniBoxH = miniWrapH; miniBoxW = miniBoxH * slotAspect;
    } else {
      miniBoxW = miniWrapW; miniBoxH = miniBoxW / slotAspect;
    }
    const scaleMini = miniBoxW / cropW;
    miniStage.style.width = `${Math.round(SW * scaleMini)}px`;
    miniStage.style.height = `${Math.round(SH * scaleMini)}px`;
    miniStage.style.transform = `translate(${-left * scaleMini}px, ${-top * scaleMini}px)`;
    miniMirrorLayer.style.transform = cropState.mirrored ? 'scaleX(-1)' : 'none';
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
}

async function showQr(link) {
  const card = $('#qrCard'); card.innerHTML = '';
  const canvas = document.createElement('canvas'); card.append(canvas);
  await QRCode.toCanvas(canvas, link, { width: 180, margin: 1, color: { dark: '#322b2d', light: '#ffffff' } });
  const label = document.createElement('small');
  label.textContent = `Quét để xem album · ${new URL(link).host} nha~`;
  label.title = link;
  card.append(label);
}

async function openMode() { state.mode = 'photo'; state.navigatedFromSessions = false; await openCapture(); }

async function openCapture() {
  state.navigatedFromSessions = false;
  state.captureGeneration += 1;
  if (state.sessionFinished) await acknowledgeCurrentResult().catch(() => { });
  clearResultState();
  clearLutPreviewUrls();
  state.captureGeneration += 1;
  clearTimeout(state.draftTimer);
  const previousSession = state.session;
  const previousFinished = state.sessionFinished;
  const stopped = await stopTimelapseRecording({ save: false }).catch(() => ({ savePromise: state.timelapseSavePromise }));
  await stopped?.savePromise?.catch(() => { });
  stopCamera();
  if (previousSession && !previousFinished) await window.photobooth.session.cancel(previousSession.id).catch(() => { });
  state.session = null; state.sessionFinished = false; revokeRecoveryUrls(); state.shots = [];
  state.photoTransforms = {}; state.activeTransformId = ''; state.selectedShotIndexes = new Set(); state.selectionTargetCount = candidateCount(); state.slotAssignments = []; state.activeSlotIndex = -1; state.pendingArtifactId = ''; state.galleryUrl = ''; state.qrDataUrl = ''; state.timelapseSavePromise = null; state.lutId = 'natural';
  const count = candidateCount();
  showScreen('captureScreen');
  updateTimelapseStatus('hidden');
  $('#captureThumbnails').replaceChildren();
  $('#captureNextButton').hidden = true;
  $('#shutterButton').disabled = false;
  $('#captureMessage').textContent = state.config.camera.captureWorkflow === 'manual' ? 'Chạm nút tròn khi bạn sẵn sàng nhé~' : 'Chạm nút tròn để bắt đầu chụp nè~';
  $('#shotProgress').innerHTML = Array.from({ length: count }, () => '<i></i>').join('');
  $('#liveFrame').removeAttribute('src'); $('#liveFrame').style.display = 'none';
  try {
    await startCamera();
    state.session = await window.photobooth.session.create('photo');
  } catch (error) {
    stopCamera();
    toast(`Máy ảnh chưa sẵn sàng nè: ${error.message}`);
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
  clearLutPreviewUrls();
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
  $('#backendHealth').textContent = backend.ok ? `Hoạt động bình thường · cổng ${backend.port}` : 'Chưa sẵn sàng nè';
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
    select.replaceChildren(new Option('Tự động chọn camera', ''));
    if (devices.length === 0) {
      select.add(new Option('Không tìm thấy camera nào', ''));
    } else {
      devices.forEach((device, index) => {
        const label = device.label || `Camera ${index + 1} (${device.deviceId.slice(0, 6)})`;
        select.add(new Option(label, device.deviceId));
      });
    }
    select.value = state.config.camera.deviceId || '';
  } catch (error) {
    console.error('Lỗi đọc danh sách camera:', error);
    select.replaceChildren(new Option('Tự động chọn camera', ''));
  }
}

/** Save a single settings field immediately (auto-save on change). */
async function saveSettingField(field) {
  if (!field.name) return;
  let value = field.type === 'checkbox' ? field.checked : field.value;
  if (field.type === 'number') value = Number(value);
  if (field.name === 'camera.dslr.args') value = value.split('\n').map((item) => item.trim()).filter(Boolean);
  const patch = {};
  setAtPath(patch, field.name, value);
  try {
    state.config = await window.photobooth.config.save(patch);
  } catch (error) {
    // Revert UI to actual backend value on validation failure
    const actualValue = getAtPath(state.config, field.name);
    if (field.type === 'checkbox') field.checked = Boolean(actualValue);
    else field.value = actualValue ?? '';
    throw error;
  }
  // Sync UI to actual saved value (backend may have normalized)
  const savedValue = getAtPath(state.config, field.name);
  if (field.type === 'checkbox') field.checked = Boolean(savedValue);
  else if (field.value !== String(savedValue ?? '')) field.value = savedValue ?? '';
  applyBranding();
  // Live-update mirror preview when toggled in settings
  if (field.name === 'camera.mirrorPreview') {
    const video = $('#cameraVideo');
    if (video) video.classList.toggle('mirror', Boolean(savedValue));
  }
}

function applyBranding() {
  $('#brandName').textContent = state.config.branding.name;
  $('#brandTagline').textContent = state.config.branding.tagline === 'Giữ lại khoảnh khắc của bạn'
    ? 'Gói nụ cười mang về nha~'
    : state.config.branding.tagline;
  document.documentElement.style.setProperty('--accent', state.config.branding.accent);
}

async function init() {
  state.config = await window.photobooth.config.get(); state.luts = await window.photobooth.luts.list(); state.selectionTargetCount = candidateCount(); applyBranding(); renderLutOptions(); await loadFrames(); await refreshStats(); await refreshRecoverableSessions();
  state.assetUnsubscribe = window.photobooth.assets?.onSynced(async (result) => {
    if (!result?.ok) return;
    await loadFrames();
    state.luts = await window.photobooth.luts.list();
    renderLutOptions();
    const downloaded = Number(result.downloadedFrames || 0) + Number(result.downloadedLuts || 0);
      if (downloaded > 0) toast(`Vừa có thêm ${downloaded} tài nguyên mới toanh ✨`);
  });
  const assetStatus = await window.photobooth.assets?.status();
  if (assetStatus?.lastResult?.ok && !assetStatus.syncing) {
    await loadFrames();
    state.luts = await window.photobooth.luts.list();
    renderLutOptions();
  }
  $$('.mode-card').forEach((button) => button.onclick = openMode);
  $$('[data-back]').forEach((button) => button.onclick = goHome);
  $('#confirmFrame').onclick = finalizePhoto; $('#confirmShots').onclick = () => openFrameSelection();
  $('#selectionTarget').onchange = changeSelectionTarget;
  $('#zoomComposition').onclick = () => { if (state.framePreviewUrl) openZoom(state.framePreviewUrl); };
  $('#captureNextButton').onclick = () => { if (!state.busy) finishCapturePhase().catch((error) => toast(error.message)); };
  $('#backToSelection').onclick = () => {
    if (state.navigatedFromSessions) openSessionsScreen();
    else openSelectionScreen();
  };
  $('#retakeAll').onclick = () => {
    if (state.navigatedFromSessions) openSessionsScreen();
    else openCapture();
  };
  $('#shutterButton').onclick = beginCapture; $('#cancelCapture').onclick = goHome;
  $('#brandHome').onclick = goHome; $('#settingsButton').onclick = openSettings;
  // Auto-save settings on any change
  $('#settingsForm').addEventListener('change', (event) => {
    const field = event.target;
    if (field.name) saveSettingField(field).catch((error) => {
      console.error('Could not save setting change:', error);
      toast('Chưa lưu được thay đổi này, bạn thử lại nhé~');
    });
  });
  $('#settingsForm').addEventListener('submit', (event) => event.preventDefault());
  $('#settingsClose').onclick = () => $('#settingsDialog').close();
  $('#settingsCancel').onclick = () => $('#settingsDialog').close();
  // Mirror toggle button on capture screen
  $('#mirrorToggleButton').onclick = toggleMirrorPreview;
  syncMirrorToggleButton();
  $('#importLutButton').onclick = importCubeLuts;
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
    const btn = $('#printButton');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const dataUrl = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(state.resultBlob); });
      const result = await window.photobooth.print({ dataUrl, profile: state.resultProfile, copies: state.printCopies, sessionId: state.session?.id });
      toast(result.ok ? `${state.printCopies} bản in đang được gửi đi ✨` : `Oops, chưa in được lúc này: ${result.error}`);
    } catch (error) {
      toast(`Oops, chưa in được lúc này: ${error.message}`);
    } finally {
      btn.disabled = false;
    }
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
        const dPanX = ((cropState.mirrored ? dx : -dx) / scaleBox) / rangeX * 100;
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
  $('#cropMirrorBtn').onclick = () => {
    cropState.mirrored = !cropState.mirrored;
    $('#cropMirrorBtn').setAttribute('aria-pressed', String(cropState.mirrored));
    updateCropModalLayout();
  };
  $('#cropResetBtn').onclick = () => {
    cropState.panX = 50; cropState.panY = 50; cropState.zoom = 1; cropState.rotation = 0; cropState.mirrored = false;
    $('#cropModalZoom').value = 1;
    $('#cropMirrorBtn').setAttribute('aria-pressed', 'false');
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
        rotation: cropState.rotation,
        mirrored: cropState.mirrored
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
  $('#checkBridge').onclick = async () => { const result = await window.photobooth.native.health(); $('#bridgeHealth').textContent = result.ok ? `DSLR đã kết nối · v${result.version}` : result.error; };
  $('#syncFrames').onclick = async () => {
    try {
      const result = await loadFrames(true);
      const sync = result.assetSync;
      const downloaded = Number(sync?.downloadedFrames || 0) + Number(sync?.downloadedLuts || 0);
      toast(downloaded ? `Đã cập nhật ${downloaded} tài nguyên mới toanh` : 'Kho sáng tạo đã mới nhất rồi ✨');
    } catch (error) { toast(error.message); }
  };
  state.uploadUnsubscribe = window.photobooth.onUploadStatus((message) => {
    refreshStats();
    if (message.sessionId !== state.session?.id) return;
    if (message.status === 'uploaded') $('#resultStatus').textContent = 'Album online đã sẵn sàng rồi nè ✨';
    if (message.status === 'retrying') $('#resultStatus').textContent = 'Mạng đang chập chờn · ảnh vẫn an toàn trên máy nha~';
  });
  $('#queuePill').onclick = async () => { await window.photobooth.queue.retry(); await refreshStats(); toast('Đang thử lưu lại những ảnh còn chờ…'); };
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
  toast('Chạm đã sẵn sàng rồi nè ✨');
}).catch((error) => { console.error(error); toast(error.message); });
