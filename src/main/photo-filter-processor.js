import sharp from 'sharp';
import { photoFilter } from '../shared/photo-filters.js';

export async function applyPhotoFilterBuffer(input, filterId) {
  const source = Buffer.from(input);
  const selected = photoFilter(filterId);
  if (selected.id === 'natural') return source;

  return sharp(source, { failOn: 'warning' })
    .rotate()
    .toColourspace('srgb')
    .recomb(selected.matrix)
    .linear([1, 1, 1], selected.bias.map((value) => value * 255))
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    .toBuffer();
}
