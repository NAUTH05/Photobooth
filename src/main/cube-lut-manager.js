import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LUT_PRESETS, lutPreset } from '../shared/lut-presets.js';

const MAX_CUBE_BYTES = 24 * 1024 * 1024;
const MIN_LUT_SIZE = 2;
const MAX_LUT_SIZE = 65;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const tableOffset = (red, green, blue, size) => ((blue * size + green) * size + red) * 3;

function cleanTitle(value, fallback = 'LUT tùy chỉnh') {
  const title = String(value || '').replace(/^['"]|['"]$/g, '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (title || fallback).slice(0, 80);
}

function fallbackTitle(filename = '') {
  const base = path.basename(filename, path.extname(filename)).split('--')[0];
  return cleanTitle(base.replace(/[-_]+/g, ' '));
}

function parseVector(parts, lineNumber, directive) {
  if (parts.length !== 4) throw new Error(`${directive} không hợp lệ ở dòng ${lineNumber}`);
  const values = parts.slice(1).map(Number);
  if (values.some((value) => !Number.isFinite(value))) throw new Error(`${directive} không hợp lệ ở dòng ${lineNumber}`);
  return values;
}

export function parseCubeLut(source, { filename = '' } = {}) {
  const lines = String(source || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let title = '';
  let size = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].split('#', 1)[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const directive = parts[0].toUpperCase();
    if (directive === 'TITLE') {
      title = cleanTitle(line.slice(parts[0].length).trim(), fallbackTitle(filename));
      continue;
    }
    if (directive === 'LUT_3D_SIZE') {
      if (parts.length !== 2 || !Number.isInteger(Number(parts[1]))) throw new Error(`LUT_3D_SIZE không hợp lệ ở dòng ${lineNumber}`);
      size = Number(parts[1]);
      if (size < MIN_LUT_SIZE || size > MAX_LUT_SIZE) throw new Error(`LUT 3D chỉ hỗ trợ kích thước ${MIN_LUT_SIZE}–${MAX_LUT_SIZE}`);
      continue;
    }
    if (directive === 'DOMAIN_MIN') {
      domainMin = parseVector(parts, lineNumber, directive);
      continue;
    }
    if (directive === 'DOMAIN_MAX') {
      domainMax = parseVector(parts, lineNumber, directive);
      continue;
    }
    if (directive === 'LUT_1D_SIZE') throw new Error('App chỉ hỗ trợ LUT 3D, chưa hỗ trợ LUT 1D');
    if (parts.length !== 3) throw new Error(`Dữ liệu LUT không hợp lệ ở dòng ${lineNumber}`);
    const row = parts.map(Number);
    if (row.some((value) => !Number.isFinite(value))) throw new Error(`Giá trị màu LUT không hợp lệ ở dòng ${lineNumber}`);
    values.push(...row);
  }

  if (!size) throw new Error('File .cube thiếu LUT_3D_SIZE');
  if (domainMin.some((value, index) => value >= domainMax[index])) throw new Error('DOMAIN_MIN phải nhỏ hơn DOMAIN_MAX');
  const expectedValues = size ** 3 * 3;
  if (values.length !== expectedValues) {
    throw new Error(`LUT ${size}³ cần ${expectedValues / 3} dòng màu, nhưng file có ${values.length / 3}`);
  }
  const table = new Uint8Array(expectedValues);
  for (let index = 0; index < expectedValues; index += 1) table[index] = Math.round(clamp01(values[index]) * 255);
  return {
    title: cleanTitle(title, fallbackTitle(filename)),
    size,
    table,
    domainMin,
    domainMax
  };
}

function colorAt(table, size, position) {
  const index = Math.max(0, Math.min(size - 1, Math.round(position * (size - 1))));
  const offset = tableOffset(index, index, index, size);
  return `rgb(${table[offset]} ${table[offset + 1]} ${table[offset + 2]})`;
}

function publicPreset(preset) {
  return {
    id: preset.id,
    label: preset.label,
    description: preset.description,
    css: preset.css || 'none',
    swatch: preset.swatch,
    size: preset.size,
    custom: Boolean(preset.custom),
    filename: preset.filename || '',
    remote: Boolean(preset.remote)
  };
}

function slug(value) {
  return String(value || 'lut')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .toLowerCase() || 'lut';
}

export class CubeLutManager {
  constructor(root) {
    this.root = root;
    this.custom = new Map();
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    this.custom.clear();
    let remoteLabels = new Map();
    try {
      const remoteManifest = JSON.parse(await fs.readFile(path.join(this.root, 'manifest.json'), 'utf8'));
      remoteLabels = new Map((remoteManifest.luts || []).map((item) => [path.basename(String(item.file || '')), String(item.label || '').trim()]));
    } catch {}
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.cube') continue;
      try {
        const preset = await this.readPreset(path.join(this.root, entry.name));
        const remoteLabel = remoteLabels.get(entry.name);
        if (remoteLabel) {
          preset.label = remoteLabel.slice(0, 100);
          preset.description = `Màu hậu kỳ từ kho sáng tạo · LUT .cube ${preset.size}³`;
          preset.remote = true;
        }
        this.custom.set(preset.id, preset);
      } catch (error) {
        console.warn(`Bỏ qua LUT không hợp lệ ${entry.name}: ${error.message}`);
      }
    }
    return this.list();
  }

  async readPreset(filePath, originalName = '') {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('Đường dẫn LUT không phải là file');
    if (stat.size < 1 || stat.size > MAX_CUBE_BYTES) throw new Error('File LUT phải nhỏ hơn 24 MB');
    const bytes = await fs.readFile(filePath);
    const parsed = parseCubeLut(bytes.toString('utf8'), { filename: originalName || filePath });
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 20);
    const id = `cube-${hash}`;
    return {
      ...parsed,
      id,
      label: parsed.title,
      description: `LUT .cube ${parsed.size}³`,
      css: 'none',
      swatch: `linear-gradient(135deg, ${colorAt(parsed.table, parsed.size, .12)}, ${colorAt(parsed.table, parsed.size, .5)} 52%, ${colorAt(parsed.table, parsed.size, .88)})`,
      custom: true,
      filename: path.basename(originalName || filePath),
      filePath
    };
  }

  async importFiles(filePaths = []) {
    const candidates = new Map();
    for (const sourcePath of filePaths) {
      if (path.extname(String(sourcePath)).toLowerCase() !== '.cube') throw new Error('Chỉ có thể cài file LUT định dạng .cube');
      const preset = await this.readPreset(sourcePath, path.basename(sourcePath));
      candidates.set(preset.id, { sourcePath, preset });
    }
    const imported = [];
    for (const { sourcePath, preset } of candidates.values()) {
      const destination = path.join(this.root, `${slug(preset.label)}--${preset.id.slice(5)}.cube`);
      try {
        await fs.access(destination);
      } catch {
        const bytes = await fs.readFile(sourcePath);
        const temporary = `${destination}.${process.pid}.tmp`;
        try {
          await fs.writeFile(temporary, bytes);
          await fs.rename(temporary, destination);
        } finally {
          await fs.unlink(temporary).catch(() => {});
        }
      }
      const stored = { ...preset, filePath: destination, filename: path.basename(sourcePath) };
      this.custom.set(stored.id, stored);
      imported.push(publicPreset(stored));
    }
    return imported;
  }

  list() {
    const builtIn = LUT_PRESETS.map((preset) => publicPreset({ ...preset, custom: false }));
    const custom = [...this.custom.values()]
      .sort((left, right) => left.label.localeCompare(right.label, 'vi'))
      .map(publicPreset);
    return [...builtIn, ...custom];
  }

  resolve(value) {
    const id = String(value || 'natural');
    return this.custom.get(id) || lutPreset(id);
  }
}
