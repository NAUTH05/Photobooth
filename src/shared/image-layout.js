export function containRect(sourceWidth, sourceHeight, x, y, width, height) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || width <= 0 || height <= 0) throw new Error('Invalid image dimensions');
  const ratio = Math.min(width / sourceWidth, height / sourceHeight);
  const targetWidth = sourceWidth * ratio;
  const targetHeight = sourceHeight * ratio;
  return {
    x: x + (width - targetWidth) / 2,
    y: y + (height - targetHeight) / 2,
    width: targetWidth,
    height: targetHeight
  };
}

export function normalizePhotoTransform(transform = {}) {
  const panX = Number.isFinite(Number(transform.panX)) ? Number(transform.panX) : 50;
  const panY = Number.isFinite(Number(transform.panY)) ? Number(transform.panY) : 50;
  const zoom = Number.isFinite(Number(transform.zoom)) ? Number(transform.zoom) : 1;
  const rotation = Number.isFinite(Number(transform.rotation)) ? Number(transform.rotation) : 0;
  return {
    panX: Math.max(0, Math.min(100, panX)),
    panY: Math.max(0, Math.min(100, panY)),
    zoom: Math.max(1, Math.min(4, zoom)),
    rotation: ((rotation % 360) + 360) % 360
  };
}

export function coverCropRect(sourceWidth, sourceHeight, targetWidth, targetHeight, transform = {}) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    throw new Error('Invalid image dimensions');
  }
  const { panX, panY, zoom } = normalizePhotoTransform(transform);
  const targetAspect = targetWidth / targetHeight;
  let cropWidth;
  let cropHeight;
  if (sourceWidth / sourceHeight > targetAspect) {
    cropHeight = sourceHeight;
    cropWidth = cropHeight * targetAspect;
  } else {
    cropWidth = sourceWidth;
    cropHeight = cropWidth / targetAspect;
  }
  cropWidth = Math.min(sourceWidth, cropWidth / zoom);
  cropHeight = Math.min(sourceHeight, cropHeight / zoom);
  const left = (sourceWidth - cropWidth) * panX / 100;
  const top = (sourceHeight - cropHeight) * panY / 100;
  return {
    left: Math.max(0, Math.min(sourceWidth - cropWidth, left)),
    top: Math.max(0, Math.min(sourceHeight - cropHeight, top)),
    width: cropWidth,
    height: cropHeight
  };
}

export function scaleRect(rect, scaleX, scaleY = scaleX) {
  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY
  };
}

export function expandRect(rect, outset, bounds) {
  const amount = Math.max(0, Number(outset) || 0);
  const left = Math.max(0, rect.x - amount);
  const top = Math.max(0, rect.y - amount);
  const right = Math.min(bounds.width, rect.x + rect.width + amount);
  const bottom = Math.min(bounds.height, rect.y + rect.height + amount);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function outputDimensions(frameWidth, frameHeight, targetLongSide = 3600) {
  if (frameWidth <= 0 || frameHeight <= 0) throw new Error('Invalid frame dimensions');
  const longSide = Math.max(1, Number(targetLongSide) || 3600);
  const scale = longSide / Math.max(frameWidth, frameHeight);
  return { width: Math.round(frameWidth * scale), height: Math.round(frameHeight * scale), scale };
}
