import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class NativeBridge {
  constructor(appPath, localStore, resourcesPath = null) {
    this.localStore = localStore;
    const nativeRoot = resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'native', 'build') : path.join(appPath, 'native', 'build');
    this.executable = process.platform === 'win32'
      ? path.join(nativeRoot, 'photobooth-camera-bridge.exe')
      : path.join(nativeRoot, 'photobooth-camera-bridge');
  }

  async health() {
    try {
      const { stdout } = await execFileAsync(this.executable, ['health'], { windowsHide: true, timeout: 3000 });
      return JSON.parse(stdout);
    } catch (error) {
      return { ok: false, error: `Native bridge chưa được build: ${error.message}` };
    }
  }

  async trigger(sessionId, dslrConfig) {
    if (!dslrConfig.program) throw new Error('Chưa cấu hình chương trình điều khiển DSLR');
    const sessionDirectory = this.localStore.sessionPath(sessionId);
    await fs.mkdir(sessionDirectory, { recursive: true });
    const output = path.join(sessionDirectory, `dslr-temp-${Date.now()}.jpg`);
    const adapterArgs = (dslrConfig.args ?? []).map((arg) => String(arg).replaceAll('{output}', output));
    const args = ['trigger', '--program', dslrConfig.program, '--output', output, '--timeout-ms', String(dslrConfig.timeoutMs ?? 30000)];
    for (const arg of adapterArgs) args.push('--arg', arg);
    try {
      await execFileAsync(this.executable, args, { windowsHide: true, timeout: (dslrConfig.timeoutMs ?? 30000) + 2000 });
      const data = await fs.readFile(output);
      const item = await this.localStore.registerExisting({ sessionId, kind: 'dslr-original', filePath: output });
      await fs.unlink(output).catch(() => {});
      return { item, dataUrl: `data:image/jpeg;base64,${data.toString('base64')}` };
    } catch (error) {
      throw new Error(`DSLR capture failed: ${error.stderr || error.message}`);
    }
  }
}
