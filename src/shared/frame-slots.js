import { PRINT_HEIGHT, PRINT_WIDTH } from './photo-layout.js';

export function detectTransparentSlots(data, width, height, expectedCount, targetWidth = PRINT_WIDTH, targetHeight = PRINT_HEIGHT, options = {}) {
  if (!data || data.length !== width * height * 4) throw new Error('Invalid RGBA frame data');
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 8) return [];
  const visited = new Uint8Array(width * height);
  const components = [];
  const minimumArea = width * height * (Number(options.minimumAreaFraction) || .012);
  const alphaThreshold = Number.isFinite(Number(options.alphaThreshold)) ? Number(options.alphaThreshold) : 40;

  for (let start = 0; start < width * height; start += 1) {
    if (visited[start] || data[start * 4 + 3] > alphaThreshold) continue;
    const queue = [start];
    visited[start] = 1;
    let cursor = 0;
    let area = 0;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    while (cursor < queue.length) {
      const index = queue[cursor++];
      const x = index % width;
      const y = Math.floor(index / width);
      area += 1;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      const neighbors = [];
      if (x > 0) neighbors.push(index - 1);
      if (x + 1 < width) neighbors.push(index + 1);
      if (y > 0) neighbors.push(index - width);
      if (y + 1 < height) neighbors.push(index + width);
      for (const neighbor of neighbors) {
        if (!visited[neighbor] && data[neighbor * 4 + 3] <= alphaThreshold) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
    if (area >= minimumArea) components.push({ area, minX, minY, maxX, maxY });
  }

  const candidates = components
    .map((component) => ({ ...component, width: component.maxX - component.minX + 1, height: component.maxY - component.minY + 1 }))
    .filter((component) => {
      const aspect = component.width / component.height;
      return aspect >= .2 && aspect <= 5;
    })
    .sort((left, right) => right.area - left.area);
  const selected = [];
  for (const component of candidates) {
    const overlaps = selected.some((current) => {
      const left = Math.max(component.minX, current.minX);
      const top = Math.max(component.minY, current.minY);
      const right = Math.min(component.maxX, current.maxX);
      const bottom = Math.min(component.maxY, current.maxY);
      if (right < left || bottom < top) return false;
      const intersection = (right - left + 1) * (bottom - top + 1);
      return intersection / Math.min(component.area, current.area) > .5;
    });
    if (!overlaps) selected.push(component);
    if (selected.length === expectedCount) break;
  }
  if (selected.length !== expectedCount) return [];
  // When a 2-strip frame PNG is used, selected slots may span both columns.
  // Prefer a single-column solution using only left-half candidates.
  const midX = width / 2;
  const leftSelected = selected.filter((c) => (c.minX + c.maxX) / 2 < midX);
  if (leftSelected.length > 0 && leftSelected.length < expectedCount) {
    const leftCandidates = candidates.filter((c) => (c.minX + c.maxX) / 2 < midX);
    if (leftCandidates.length >= expectedCount) {
      const leftOnly = [];
      for (const component of leftCandidates) {
        const overlaps = leftOnly.some((cur) => {
          const il = Math.max(component.minX, cur.minX); const it = Math.max(component.minY, cur.minY);
          const ir = Math.min(component.maxX, cur.maxX); const ib = Math.min(component.maxY, cur.maxY);
          return ir >= il && ib >= it && (ir - il + 1) * (ib - it + 1) / Math.min(component.area, cur.area) > .5;
        });
        if (!overlaps) leftOnly.push(component);
        if (leftOnly.length === expectedCount) break;
      }
      if (leftOnly.length === expectedCount) {
        return leftOnly
          .sort((a, b) => Math.abs(a.minY - b.minY) > targetHeight * .01 ? a.minY - b.minY : a.minX - b.minX)
          .map((component) => ({
            x: Math.max(0, Math.round(component.minX / width * targetWidth)),
            y: Math.max(0, Math.round(component.minY / height * targetHeight)),
            width: Math.min(targetWidth, Math.round(component.width / width * targetWidth)),
            height: Math.min(targetHeight, Math.round(component.height / height * targetHeight)),
            fit: options.defaultFit === 'contain' ? 'contain' : 'cover'
          }));
      }
    }
  }
  return selected
    .map((component) => ({
      x: Math.max(0, Math.round(component.minX / width * targetWidth)),
      y: Math.max(0, Math.round(component.minY / height * targetHeight)),
      width: Math.min(targetWidth, Math.round(component.width / width * targetWidth)),
      height: Math.min(targetHeight, Math.round(component.height / height * targetHeight)),
      fit: options.defaultFit === 'contain' ? 'contain' : 'cover'
    }))
    .sort((left, right) => Math.abs(left.y - right.y) > targetHeight * .01 ? left.y - right.y : left.x - right.x);
}
