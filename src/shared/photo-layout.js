export const PRINT_WIDTH = 1200;
export const PRINT_HEIGHT = 1800;
export const DEFAULT_FOOTER_HEIGHT = 260;

export function autoPhotoSlots(count, width = PRINT_WIDTH, height = PRINT_HEIGHT) {
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('Photo count must be between 1 and 8');
  const margin = 48;
  const gap = 18;
  const footerTop = height - DEFAULT_FOOTER_HEIGHT;
  const columns = count <= 3 ? 1 : 2;
  const rows = Math.ceil(count / columns);
  const cellWidth = (width - margin * 2 - gap * (columns - 1)) / columns;
  const cellHeight = (footerTop - margin * 2 - gap * (rows - 1)) / rows;
  const slots = [];
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / columns);
    const itemsInRow = Math.min(columns, count - row * columns);
    const column = index % columns;
    const rowWidth = itemsInRow * cellWidth + (itemsInRow - 1) * gap;
    const startX = (width - rowWidth) / 2;
    slots.push({ x: startX + column * (cellWidth + gap), y: margin + row * (cellHeight + gap), width: cellWidth, height: cellHeight, fit: 'cover' });
  }
  return slots;
}

function normalizeSlot(slot, frameFit = 'cover') {
  return {
    ...slot,
    fit: slot.fit === 'contain' ? 'contain' : frameFit === 'contain' ? 'contain' : 'cover',
    panX: Number.isFinite(Number(slot.panX)) ? Number(slot.panX) : 50,
    panY: Number.isFinite(Number(slot.panY)) ? Number(slot.panY) : 50,
    zoom: Math.max(1, Number(slot.zoom) || 1),
    rotation: Number(slot.rotation) || 0,
    outset: Math.max(0, Number(slot.outset) || 0)
  };
}

export function resolvePhotoSlots(frame, count) {
  const width = Number(frame?.width) || PRINT_WIDTH;
  const height = Number(frame?.height) || PRINT_HEIGHT;
  if (Array.isArray(frame?.slots) && frame.slots.length === count && validSlotSet(frame.slots, width, height)) {
    return frame.slots.map((slot) => normalizeSlot(slot, frame.fit));
  }
  return autoPhotoSlots(count, width, height).map((slot) => normalizeSlot(slot, frame?.fit));
}

export function frameSupportsCount(frame, count) {
  const width = Number(frame?.width) || PRINT_WIDTH;
  const height = Number(frame?.height) || PRINT_HEIGHT;
  if (frame?.slotCount === 'any') return !Array.isArray(frame.slots) || frame.slots.length === 0;
  if (Number.isInteger(Number(frame?.slotCount))) {
    if (Number(frame.slotCount) !== count) return false;
    return !Array.isArray(frame.slots) || (frame.slots.length === count && validSlotSet(frame.slots, width, height));
  }
  if (!frame?.file) return true;
  return count === 4;
}

function validSlot(slot, width, height) {
  return [slot?.x, slot?.y, slot?.width, slot?.height].every(Number.isFinite)
    && slot.x >= 0 && slot.y >= 0 && slot.width > 0 && slot.height > 0
    && slot.x + slot.width <= width
    && slot.y + slot.height <= height;
}

function validSlotSet(slots, width, height) {
  if (!slots.every((slot) => validSlot(slot, width, height))) return false;
  for (let left = 0; left < slots.length; left += 1) {
    for (let right = left + 1; right < slots.length; right += 1) {
      const a = slots[left], b = slots[right];
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      if (overlaps) return false;
    }
  }
  return true;
}

export function outputProfile(frame, targetResolution = 3600) {
  const target = Math.max(1200, Math.min(7200, Math.round(Number(targetResolution) || 3600)));
  const category = String(frame?.category || '4x6-portrait');
  if (category === '2x6' || frame?.layout === '2x6') return { kind: '2x6', width: Math.round(target * 2 / 3), height: target, stripWidth: Math.round(target / 3) };
  if (category === '4x6-landscape') return { kind: '4x6-landscape', width: target, height: Math.round(target * 2 / 3) };
  return { kind: '4x6-portrait', width: Math.round(target * 2 / 3), height: target };
}
