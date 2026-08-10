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
    slots.push({ x: startX + column * (cellWidth + gap), y: margin + row * (cellHeight + gap), width: cellWidth, height: cellHeight, fit: 'contain' });
  }
  return slots;
}

export function resolvePhotoSlots(frame, count) {
  if (Array.isArray(frame?.slots) && frame.slots.length === count && validSlotSet(frame.slots)) {
    return frame.slots.map((slot) => ({ ...slot, fit: slot.fit === 'cover' ? 'cover' : 'contain' }));
  }
  return autoPhotoSlots(count);
}

export function frameSupportsCount(frame, count) {
  if (frame?.slotCount === 'any') return !Array.isArray(frame.slots) || frame.slots.length === 0;
  if (Number.isInteger(Number(frame?.slotCount))) {
    if (Number(frame.slotCount) !== count) return false;
    return !Array.isArray(frame.slots) || (frame.slots.length === count && validSlotSet(frame.slots));
  }
  if (!frame?.file) return true;
  return count === 4;
}

function validSlot(slot) {
  return [slot?.x, slot?.y, slot?.width, slot?.height].every(Number.isFinite)
    && slot.x >= 0 && slot.y >= 0 && slot.width > 0 && slot.height > 0
    && slot.x + slot.width <= PRINT_WIDTH
    && slot.y + slot.height <= PRINT_HEIGHT;
}

function validSlotSet(slots) {
  if (!slots.every(validSlot)) return false;
  for (let left = 0; left < slots.length; left += 1) {
    for (let right = left + 1; right < slots.length; right += 1) {
      const a = slots[left], b = slots[right];
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      if (overlaps) return false;
    }
  }
  return true;
}
