import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStore } from '../src/main/local-store.js';
import { buildTimelapseArgs, TimelapseProcessor } from '../src/main/timelapse-processor.js';

const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32]);

test('builds a real 2x setpts filter and clamps encoding values', () => {
  const args = buildTimelapseArgs('input.webm', 'output.mp4', { speed: 2, crf: 5 });
  assert.equal(args[args.indexOf('-vf') + 1], 'setpts=0.5*PTS,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30');
  assert.equal(args[args.indexOf('-crf') + 1], '5');
  assert.equal(args.at(-1), 'output.mp4');
});

test('encodes and registers a timelapse video in the active session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-timelapse-'));
  try {
    const store = new LocalStore(root); await store.init();
    const session = await store.createSession('photo');
    let invokedArgs;
    const runner = async (_executable, args) => {
      invokedArgs = args;
      await fs.writeFile(args.at(-1), mp4);
    };
    const config = { get: () => ({ timelapse: { speed: 2, crf: 5 } }) };
    const processor = new TimelapseProcessor(store, config, 'C:\\ffmpeg.exe', runner);
    const item = await processor.encode({ sessionId: session.id, bytes: webm });
    assert.equal(item.kind, 'video-timelapse');
    assert.match(item.filename, /video-timelapse\.mp4$/);
    assert.equal(invokedArgs[invokedArgs.indexOf('-vf') + 1].startsWith('setpts=0.5*PTS'), true);
    assert.deepEqual(await fs.readFile(store.queue.sessions[session.id].items[0].path), mp4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
