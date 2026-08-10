import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

function lanAddress() {
  const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, items]) =>
    (items ?? []).filter((item) => item?.family === 'IPv4' && !item.internal).map((item) => ({ ...item, name }))
  );
  const score = (item) => {
    const privateScore = item.address.startsWith('192.168.') ? 0
      : item.address.startsWith('10.') ? 10
        : /^172\.(1[6-9]|2\d|3[01])\./.test(item.address) ? 20 : 50;
    return privateScore + (/virtual|vethernet|wsl|docker|vmware|vpn/i.test(item.name) ? 100 : 0);
  };
  addresses.sort((left, right) => score(left) - score(right));
  return addresses[0]?.address ?? '127.0.0.1';
}

export class CppGalleryBackend {
  constructor(appPath, runtimeRoot, configStore, resourcesPath = null) {
    this.appPath = appPath;
    this.runtimeRoot = runtimeRoot;
    this.configStore = configStore;
    const nativeRoot = resourcesPath
      ? path.join(resourcesPath, 'app.asar.unpacked', 'native', 'build')
      : path.join(appPath, 'native', 'build');
    this.executable = process.platform === 'win32'
      ? path.join(nativeRoot, 'photobooth-gallery-backend.exe')
      : path.join(nativeRoot, 'photobooth-gallery-backend');
    this.staticRoot = path.join(appPath, 'src', 'gallery');
    this.process = null;
    this.port = null;
  }

  async start() {
    if (!fs.existsSync(this.executable)) {
      throw new Error('C++ gallery backend chưa được build. Hãy chạy npm run build:native.');
    }
    const gallery = this.configStore.get().gallery;
    const args = [
      '--host', gallery.host || '0.0.0.0',
      '--port', String(Number(gallery.port) || 3847),
      '--queue', path.join(this.runtimeRoot, 'upload-queue.json'),
      '--static', this.staticRoot
    ];
    this.process = spawn(this.executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stderr = [];
    this.process.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
    const lines = readline.createInterface({ input: this.process.stdout });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('C++ gallery backend khởi động quá thời gian')), 8000);
      const fail = (error) => {
        clearTimeout(timer);
        reject(new Error(`Không khởi động được C++ gallery backend: ${error?.message || stderr.join('').trim() || 'unknown error'}`));
      };
      this.process.once('error', fail);
      this.process.once('exit', (code) => {
        if (this.port == null) fail(new Error(`process exited with code ${code}: ${stderr.join('').trim()}`));
        else this.port = null;
      });
      lines.on('line', (line) => {
        try {
          const event = JSON.parse(line);
          if (event.ready && Number.isInteger(event.port)) {
            this.port = event.port;
            clearTimeout(timer);
            resolve();
          }
        } catch {}
      });
    });
  }

  stop() {
    this.process?.kill();
    this.process = null;
    this.port = null;
  }

  health() {
    return {
      ok: Boolean(this.process && !this.process.killed && this.process.exitCode === null && this.port),
      backend: 'cpp',
      version: '1.0.0',
      port: this.port
    };
  }

  urlFor(session) {
    if (!this.port) throw new Error('C++ gallery backend chưa sẵn sàng');
    const gallery = this.configStore.get().gallery;
    const base = (gallery.publicBaseUrl || `http://${lanAddress()}:${this.port}`).replace(/\/$/, '');
    return `${base}/s/${encodeURIComponent(session.id)}?t=${encodeURIComponent(session.galleryToken)}`;
  }
}
