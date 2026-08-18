import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegStaticPath from 'ffmpeg-static';

const MAX_SOURCE_BYTES = 512 * 1024 * 1024;

function unpackedPath(value) {
  if (!value) throw new Error('Không tìm thấy FFmpeg để xử lý timelapse');
  return value.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function isWebm(buffer) {
  return buffer.length >= 4
    && buffer[0] === 0x1a
    && buffer[1] === 0x45
    && buffer[2] === 0xdf
    && buffer[3] === 0xa3;
}

export function buildTimelapseArgs(inputPath, outputPath, { speed = 2, crf = 28 } = {}) {
  const safeSpeed = Math.max(1, Math.min(8, Number(speed) || 2));
  const safeCrf = Math.max(0, Math.min(51, Math.round(Number(crf) || 28)));
  const setPts = (1 / safeSpeed).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
    '-an', '-vf', `setpts=${setPts}*PTS,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(safeCrf),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-metadata', `title=Chạm Photobooth Timelapse ${safeSpeed}x`,
    outputPath
  ];
}

function run(executable, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let errorOutput = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Xử lý timelapse quá thời gian cho phép'));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-12000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg không thể tạo timelapse (${code}): ${errorOutput.trim()}`));
    });
  });
}

export class TimelapseProcessor {
  constructor(localStore, configStore, executable = ffmpegStaticPath, runner = run) {
    this.localStore = localStore;
    this.configStore = configStore;
    this.executable = unpackedPath(executable);
    this.runner = runner;
  }

  async encode({ sessionId, bytes }) {
    const source = Buffer.from(bytes ?? []);
    if (!source.length || source.length > MAX_SOURCE_BYTES || !isWebm(source)) {
      throw new Error('Video timelapse nguồn không hợp lệ');
    }
    const sessionDirectory = this.localStore.sessionPath(sessionId);
    const token = crypto.randomUUID();
    const inputPath = path.join(sessionDirectory, `.timelapse-input-${token}.webm`);
    const outputPath = path.join(sessionDirectory, `.timelapse-output-${token}.mp4`);
    const config = this.configStore.get().timelapse ?? {};
    try {
      await fs.writeFile(inputPath, source);
      await this.runner(this.executable, buildTimelapseArgs(inputPath, outputPath, config));
      const output = await fs.stat(outputPath);
      if (!output.isFile() || output.size < 24) throw new Error('Video timelapse đầu ra bị rỗng');
      return await this.localStore.registerExisting({ sessionId, kind: 'video-timelapse', filePath: outputPath });
    } finally {
      await fs.unlink(inputPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
    }
  }
}
