import { PHOTO_FILTERS, normalizePhotoFilterId, photoFilter } from './photo-filters.js';

export const LUT_SIZE = 17;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function buildLut(filter, size = LUT_SIZE) {
  const table = new Uint8Array(size * size * size * 3);
  let offset = 0;
  for (let blueIndex = 0; blueIndex < size; blueIndex += 1) {
    const blue = blueIndex / (size - 1);
    for (let greenIndex = 0; greenIndex < size; greenIndex += 1) {
      const green = greenIndex / (size - 1);
      for (let redIndex = 0; redIndex < size; redIndex += 1) {
        const red = redIndex / (size - 1);
        const input = [red, green, blue];
        for (let channel = 0; channel < 3; channel += 1) {
          const value = filter.matrix[channel].reduce((sum, coefficient, index) => sum + coefficient * input[index], filter.bias[channel]);
          table[offset++] = Math.round(clamp01(value) * 255);
        }
      }
    }
  }
  return table;
}

export const LUT_PRESETS = Object.freeze(PHOTO_FILTERS.map((filter) => Object.freeze({
  id: filter.id,
  label: filter.label,
  description: filter.description,
  css: filter.css,
  swatch: filter.swatch,
  size: LUT_SIZE,
  table: buildLut(filter)
})));

const lutsById = new Map(LUT_PRESETS.map((preset) => [preset.id, preset]));

export function normalizeLutId(value) {
  return normalizePhotoFilterId(value);
}

export function lutPreset(value) {
  return lutsById.get(normalizeLutId(value)) || lutsById.get(photoFilter(value).id);
}

const tableOffset = (red, green, blue, size) => ((blue * size + green) * size + red) * 3;
const mix = (left, right, amount) => left + (right - left) * amount;

export function applyLutToPixels(pixels, channels, lutValue) {
  const selected = lutValue && typeof lutValue === 'object' && lutValue.table ? lutValue : lutPreset(lutValue);
  if (selected.id === 'natural') return pixels;
  if (!pixels || channels < 3 || pixels.length % channels !== 0) throw new Error('Dữ liệu LUT không hợp lệ');
  const { table, size } = selected;
  if (!Number.isInteger(size) || size < 2 || table.length !== size ** 3 * 3) throw new Error('Bảng LUT 3D không hợp lệ');
  const domainMin = selected.domainMin || [0, 0, 0];
  const domainMax = selected.domainMax || [1, 1, 1];
  const positionFor = (value, channel) => {
    const normalized = (value / 255 - domainMin[channel]) / (domainMax[channel] - domainMin[channel]);
    return clamp01(normalized) * (size - 1);
  };

  for (let index = 0; index < pixels.length; index += channels) {
    const redPosition = positionFor(pixels[index], 0);
    const greenPosition = positionFor(pixels[index + 1], 1);
    const bluePosition = positionFor(pixels[index + 2], 2);
    const red0 = Math.min(size - 2, Math.floor(redPosition));
    const green0 = Math.min(size - 2, Math.floor(greenPosition));
    const blue0 = Math.min(size - 2, Math.floor(bluePosition));
    const redMix = redPosition - red0;
    const greenMix = greenPosition - green0;
    const blueMix = bluePosition - blue0;

    for (let channel = 0; channel < 3; channel += 1) {
      const c000 = table[tableOffset(red0, green0, blue0, size) + channel];
      const c100 = table[tableOffset(red0 + 1, green0, blue0, size) + channel];
      const c010 = table[tableOffset(red0, green0 + 1, blue0, size) + channel];
      const c110 = table[tableOffset(red0 + 1, green0 + 1, blue0, size) + channel];
      const c001 = table[tableOffset(red0, green0, blue0 + 1, size) + channel];
      const c101 = table[tableOffset(red0 + 1, green0, blue0 + 1, size) + channel];
      const c011 = table[tableOffset(red0, green0 + 1, blue0 + 1, size) + channel];
      const c111 = table[tableOffset(red0 + 1, green0 + 1, blue0 + 1, size) + channel];
      const front = mix(mix(c000, c100, redMix), mix(c010, c110, redMix), greenMix);
      const back = mix(mix(c001, c101, redMix), mix(c011, c111, redMix), greenMix);
      pixels[index + channel] = Math.max(0, Math.min(255, Math.round(mix(front, back, blueMix))));
    }
  }
  return pixels;
}
