import { PRINT_HEIGHT, PRINT_WIDTH } from './photo-layout.js';

export function detectTransparentSlots(data, width, height, expectedCount, targetWidth = PRINT_WIDTH, targetHeight = PRINT_HEIGHT) {
  if (!data || data.length !== width * height * 4) throw new Error('Invalid RGBA frame data');
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 8) return [];
  const visited = new Uint8Array(width * height);
  const components = [];
  const minimumArea = width * height * .012;

  for (let start = 0; start < width * height; start += 1) {
    if (visited[start] || data[start * 4 + 3] > 40) continue;
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
        if (!visited[neighbor] && data[neighbor * 4 + 3] <= 40) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
    if (area >= minimumArea) components.push({ area, minX, minY, maxX, maxY });
  }

  const selected = components.sort((left, right) => right.area - left.area).slice(0, expectedCount);
  if (selected.length !== expectedCount) return [];
  return selected
    .map((component) => ({
      x: Math.max(0, Math.round(component.minX / width * targetWidth)),
      y: Math.max(0, Math.round(component.minY / height * targetHeight)),
      width: Math.min(targetWidth, Math.round((component.maxX - component.minX + 1) / width * targetWidth)),
      height: Math.min(targetHeight, Math.round((component.maxY - component.minY + 1) / height * targetHeight)),
      fit: 'contain'
    }))
    .sort((left, right) => Math.abs(left.y - right.y) > 20 ? left.y - right.y : left.x - right.x);
}
