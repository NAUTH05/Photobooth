import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCubeLut } from './cube-lut-manager.js';

const ASSET_ID = /^(frame|lut)-[a-f0-9]{20}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FRAME_BYTES = 50 * 1024 * 1024;
const MAX_LUT_BYTES = 24 * 1024 * 1024;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

function safeFilename(value, fallback) {
  return (String(value || '').replaceAll('\\', '/').split('/').at(-1)?.replace(/[^A-Za-z0-9._-]/g, '_') || fallback).slice(0, 160);
}

function slug(value) {
  return String(value || 'asset')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 50) || 'asset';
}

function assertServerUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHosts.has(url.hostname))) {
    throw new Error('Kho sáng tạo phải dùng HTTPS; HTTP chỉ được dùng cho localhost');
  }
  return url;
}

function assetUrl(baseUrl, value) {
  const base = assertServerUrl(`${baseUrl.replace(/\/$/, '')}/`);
  const resolved = new URL(String(value || ''), base);
  if (resolved.origin !== base.origin || (resolved.protocol !== 'https:' && !(resolved.protocol === 'http:' && loopbackHosts.has(resolved.hostname)))) {
    throw new Error('Manifest chứa địa chỉ tải tài nguyên không an toàn');
  }
  return resolved.toString();
}

async function hashFile(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function matchesFile(filePath, expectedHash, expectedSize) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size !== expectedSize) return false;
    return (await hashFile(filePath)) === expectedHash;
  } catch {
    return false;
  }
}

async function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, value);
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function findObsoleteRemoteFiles(root, currentFiles) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('remote--') && !currentFiles.has(entry.name))
    .map((entry) => entry.name);
}

function normalizeManifest(value, baseUrl) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || !Array.isArray(value.frames) || !Array.isArray(value.luts)) {
    throw new Error('Manifest kho sáng tạo không hợp lệ');
  }
  const seen = new Set();
  const normalizeCommon = (item, kind, maximum, extensionPattern) => {
    const id = String(item?.id || '');
    const sha256 = String(item?.sha256 || '').toLowerCase();
    const size = Number(item?.size);
    const file = safeFilename(item?.file, '');
    if (!ASSET_ID.test(id) || !id.startsWith(kind === 'frames' ? 'frame-' : 'lut-') || seen.has(id)) throw new Error(`Mã ${kind} không hợp lệ hoặc bị trùng`);
    if (!SHA256.test(sha256) || !Number.isSafeInteger(size) || size < 1 || size > maximum || !extensionPattern.test(file)) throw new Error(`Metadata ${id} không hợp lệ`);
    seen.add(id);
    return { id, sha256, size, file, downloadUrl: assetUrl(baseUrl, item.downloadUrl) };
  };
  const frames = value.frames.filter((item) => !item?.archived).map((item) => ({
    ...normalizeCommon(item, 'frames', MAX_FRAME_BYTES, /\.(png|webp)$/i),
    name: String(item.name || '').trim().slice(0, 100) || 'Khung ảnh',
    accent: /^#[0-9a-f]{6}$/i.test(String(item.accent || '')) ? String(item.accent) : '#ef765e',
    slotCount: Math.max(1, Math.min(8, Math.round(Number(item.slotCount) || 4))),
    layout: ['2x6', '4x6'].includes(item.layout) ? item.layout : '4x6',
    category: ['2x6-strip', '4x6-portrait', '4x6-landscape'].includes(item.category) ? item.category : '4x6-portrait',
    fit: 'cover',
    inferSlots: true,
  }));
  const luts = value.luts.filter((item) => !item?.archived).map((item) => ({
    ...normalizeCommon(item, 'luts', MAX_LUT_BYTES, /\.cube$/i),
    label: String(item.label || '').trim().slice(0, 100) || 'Màu hậu kỳ',
  }));
  return {
    schemaVersion: 1,
    version: Number.isSafeInteger(Number(value.version)) ? Number(value.version) : Date.now(),
    updatedAt: Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : new Date().toISOString(),
    frames,
    luts,
  };
}

async function fetchBytes(url, expectedSize, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/octet-stream' }, signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Server trả về HTTP ${response.status}`);
    const announced = Number(response.headers.get('content-length') || 0);
    if (announced && announced !== expectedSize) throw new Error('Kích thước tải xuống không khớp manifest');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== expectedSize) throw new Error('Tệp tải xuống chưa đầy đủ');
    return bytes;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Kho sáng tạo phản hồi quá lâu');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class RemoteAssetManager {
  constructor({ framesRoot, lutsRoot, configStore, frameManager, lutManager }) {
    this.framesRoot = framesRoot;
    this.lutsRoot = lutsRoot;
    this.configStore = configStore;
    this.frameManager = frameManager;
    this.lutManager = lutManager;
    this.frameManifestPath = path.join(framesRoot, 'manifest.json');
    this.lutManifestPath = path.join(lutsRoot, 'manifest.json');
    this.lastResult = null;
    this.activeSync = null;
  }

  baseUrl() {
    const config = this.configStore.get();
    if (config.assets?.enabled === false) return '';
    return String(config.assets?.baseUrl || config.cloudflare?.baseUrl || '').trim().replace(/\/$/, '');
  }

  status() {
    return { configured: Boolean(this.baseUrl()), syncing: Boolean(this.activeSync), lastResult: this.lastResult };
  }

  async sync() {
    if (this.activeSync) return this.activeSync;
    this.activeSync = this.performSync().finally(() => { this.activeSync = null; });
    return this.activeSync;
  }

  async performSync() {
    const baseUrl = this.baseUrl();
    if (!baseUrl) {
      const result = { ok: true, skipped: true, reason: 'not-configured', downloadedFrames: 0, downloadedLuts: 0 };
      this.lastResult = { ...result, at: new Date().toISOString() };
      return result;
    }
    assertServerUrl(baseUrl);
    await Promise.all([fs.mkdir(this.framesRoot, { recursive: true }), fs.mkdir(this.lutsRoot, { recursive: true })]);
    const config = this.configStore.get();
    const timeoutMs = Math.max(10, Math.min(300, Number(config.assets?.requestTimeoutSeconds || 30))) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${baseUrl}/api/assets/manifest.json`, { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error', cache: 'no-store' });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Kho sáng tạo phản hồi quá lâu');
      throw new Error(`Không thể kết nối kho sáng tạo: ${error.message}`);
    } finally { clearTimeout(timer); }
    if (!response.ok) throw new Error(`Không thể đọc kho sáng tạo (HTTP ${response.status})`);
    let remote;
    try { remote = normalizeManifest(await response.json(), baseUrl); }
    catch (error) { throw new Error(`Manifest kho sáng tạo bị lỗi: ${error.message}`); }

    let downloadedFrames = 0;
    let downloadedLuts = 0;
    const localFrames = [];
    for (const item of remote.frames) {
      const extension = path.extname(item.file).toLowerCase();
      const localFile = `remote--${item.id}--${slug(item.name)}${extension}`;
      const target = path.join(this.framesRoot, localFile);
      if (!(await matchesFile(target, item.sha256, item.size))) {
        const bytes = await fetchBytes(item.downloadUrl, item.size, timeoutMs);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Checksum của khung “${item.name}” không khớp`);
        await atomicWrite(target, bytes);
        downloadedFrames += 1;
      }
      const { downloadUrl, ...localItem } = item;
      localFrames.push({ ...localItem, file: localFile, source: 'remote' });
    }

    const localLuts = [];
    for (const item of remote.luts) {
      const localFile = `remote--${item.id}--${slug(item.label)}.cube`;
      const target = path.join(this.lutsRoot, localFile);
      if (!(await matchesFile(target, item.sha256, item.size))) {
        const bytes = await fetchBytes(item.downloadUrl, item.size, timeoutMs);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Checksum của màu “${item.label}” không khớp`);
        parseCubeLut(bytes.toString('utf8'), { filename: item.file });
        await atomicWrite(target, bytes);
        downloadedLuts += 1;
      }
      const { downloadUrl, ...localItem } = item;
      localLuts.push({ ...localItem, file: localFile, source: 'remote' });
    }

    const frameManifest = { schemaVersion: 1, version: remote.version, updatedAt: remote.updatedAt, frames: localFrames };
    const lutManifest = { schemaVersion: 1, version: remote.version, updatedAt: remote.updatedAt, luts: localLuts };
    await Promise.all([
      atomicWrite(this.frameManifestPath, JSON.stringify(frameManifest, null, 2)),
      atomicWrite(this.lutManifestPath, JSON.stringify(lutManifest, null, 2)),
    ]);

    const currentFrameFiles = new Set(localFrames.map((item) => item.file));
    const currentLutFiles = new Set(localLuts.map((item) => item.file));
    const [obsoleteFrames, obsoleteLuts] = await Promise.all([
      findObsoleteRemoteFiles(this.framesRoot, currentFrameFiles),
      findObsoleteRemoteFiles(this.lutsRoot, currentLutFiles),
    ]);
    await Promise.all([
      ...obsoleteFrames.map((file) => fs.unlink(path.join(this.framesRoot, file)).catch(() => {})),
      ...obsoleteLuts.map((file) => fs.unlink(path.join(this.lutsRoot, file)).catch(() => {})),
    ]);

    this.frameManager.lastSync = new Date().toISOString();
    await this.lutManager.init();
    const result = {
      ok: true,
      skipped: false,
      version: remote.version,
      frameCount: localFrames.length,
      lutCount: localLuts.length,
      downloadedFrames,
      downloadedLuts,
    };
    this.lastResult = { ...result, at: new Date().toISOString() };
    return result;
  }
}
