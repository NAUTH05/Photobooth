import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { lutPreset } from '../shared/lut-presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'lut-worker.js');
const MAX_WORKERS = 2;
const TASK_TIMEOUT_MS = 60000;

let taskIdCounter = 0;

class LutWorkerPool {
  constructor() {
    this.workers = [];
    this.queue = [];
    this.active = new Map();
  }

  ensureWorker() {
    if (this.workers.length >= MAX_WORKERS) return;
    const worker = new Worker(WORKER_PATH);
    worker.unref(); // Don't keep the process alive just for LUT workers
    worker.on('message', (message) => {
      const pending = this.active.get(message.id);
      if (!pending) return;
      this.active.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(Buffer.from(message.result));
      this.processQueue();
    });
    worker.on('error', (error) => {
      console.error('LUT worker error:', error);
      this.removeWorker(worker);
      // Reject all tasks assigned to this worker
      for (const [id, pending] of this.active) {
        if (pending.worker === worker) {
          this.active.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new Error(`LUT worker crashed: ${error.message}`));
        }
      }
      this.processQueue();
    });
    worker.on('exit', (code) => {
      this.removeWorker(worker);
      if (code !== 0) console.warn(`LUT worker exited with code ${code}`);
    });
    this.workers.push(worker);
  }

  removeWorker(worker) {
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
  }

  run(input, lutValue, format) {
    return new Promise((resolve, reject) => {
      this.queue.push({ input, lutValue, format, resolve, reject });
      this.processQueue();
    });
  }

  processQueue() {
    while (this.queue.length > 0) {
      if (this.active.size >= MAX_WORKERS) {
        this.ensureWorker();
        return;
      }
      this.ensureWorker();
      const idleWorker = this.workers.find((w) => ![...this.active.values()].some((p) => p.worker === w));
      if (!idleWorker) return;
      const task = this.queue.shift();
      const id = ++taskIdCounter;
      const timer = setTimeout(() => {
        if (this.active.has(id)) {
          this.active.delete(id);
          task.reject(new Error('LUT processing timed out'));
        }
      }, TASK_TIMEOUT_MS);
      this.active.set(id, { resolve: task.resolve, reject: task.reject, worker: idleWorker, timer });
      idleWorker.postMessage({ id, input: task.input, lutValue: task.lutValue, format: task.format });
    }
  }

  async shutdown() {
    for (const [id, pending] of this.active) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Worker pool shutting down'));
    }
    this.active.clear();
    this.queue.length = 0;
    const terminations = this.workers.map((w) => w.terminate());
    this.workers.length = 0;
    await Promise.allSettled(terminations);
  }
}

const pool = new LutWorkerPool();

export async function applyLutBuffer(input, lutValue, { format = 'jpeg' } = {}) {
  const source = Buffer.from(input);
  const selected = lutValue && typeof lutValue === 'object' && lutValue.table ? lutValue : lutPreset(lutValue);
  if (selected.id === 'natural') return source;
  // Serialize the LUT value for transfer to worker (table may be Uint8Array)
  const serializable = {
    id: selected.id,
    size: selected.size,
    table: selected.table instanceof Uint8Array ? Array.from(selected.table) : selected.table,
    domainMin: selected.domainMin,
    domainMax: selected.domainMax
  };
  return pool.run(source, serializable, format);
}

export function shutdownLutPool() {
  return pool.shutdown();
}
