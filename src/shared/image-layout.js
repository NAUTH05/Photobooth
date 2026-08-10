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
