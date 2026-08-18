import { parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';
import { applyLutToPixels } from '../shared/lut-presets.js';

parentPort.on('message', async (message) => {
  const { id, input, lutValue, format } = message;
  try {
    const source = Buffer.from(input);
    if (!lutValue || lutValue.id === 'natural') {
      parentPort.postMessage({ id, result: source });
      return;
    }
    const { data, info } = await sharp(source, { failOn: 'warning' }).raw().toBuffer({ resolveWithObject: true });
    applyLutToPixels(data, info.channels, lutValue);
    const pipeline = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
    let result;
    if (format === 'png' || info.channels === 4) {
      result = await pipeline.png().toBuffer();
    } else {
      result = await pipeline.jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
    }
    // Copy into a clean ArrayBuffer so it can be transferred
    const copy = new Uint8Array(result).buffer;
    parentPort.postMessage({ id, result: Buffer.from(copy) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message || String(error) });
  }
});
