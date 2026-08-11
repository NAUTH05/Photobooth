import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizePhotoTransform } from '../shared/image-layout.js';

const safeTime = () => new Date().toISOString().replace(/[:.]/g, '-');
const allowedExtensions = new Set(['jpg', 'jpeg', 'png', 'mp4']);
const originalKinds = new Set(['photo-original', 'dslr-original']);
const validTargetCounts = new Set([4, 6, 8]);
const validResultProfiles = new Set(['4x6-portrait', '4x6-landscape', '2x6']);
const restorableResultStatuses = new Set(['capturing', 'recoverable', 'pending', 'uploading', 'retrying', 'uploaded', 'failed']);
const isExpired = (session) => Boolean(session.expiresAt && Date.parse(session.expiresAt) <= Date.now());

function sessionFolderTime(date = new Date()) {
  const value = new Date(date);
  const part = (number) => String(number).padStart(2, '0');
  return `${part(value.getDate())}-${part(value.getMonth() + 1)}-${value.getFullYear()}_${part(value.getHours())}-${part(value.getMinutes())}-${part(value.getSeconds())}`;
}

function isValidArtifact(buffer, extension) {
  if (extension === 'jpg' || extension === 'jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (extension === 'png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (extension === 'mp4') {
    return buffer.length >= 12 && buffer.subarray(4, 8).equals(Buffer.from('ftyp'));
  }
  return false;
}

function publicItem(item) {
  const value = {
    id: item.id,
    kind: item.kind,
    filename: item.filename,
    size: item.size,
    status: item.status,
    createdAt: item.createdAt
  };
  if (item.kind === 'photo-strip' && validResultProfiles.has(item.profile)) value.profile = item.profile;
  return value;
}

function publicSession(session, { includeItems = false, includeDraft = false } = {}) {
  const value = {
    id: session.id,
    mode: session.mode,
    createdAt: session.createdAt,
    status: session.status,
    recoveredAt: session.recoveredAt,
    expiresAt: session.expiresAt,
    itemCount: (session.items || []).filter((item) => !item.deletedAt).length
  };
  if (includeItems) value.items = (session.items || []).filter((item) => !item.deletedAt).map(publicItem);
  if (includeDraft && session.draft) value.draft = structuredClone(session.draft);
  return value;
}

export class LocalStore {
  constructor(root) {
    this.root = root;
    this.sessionsRoot = path.join(root, 'sessions');
    this.queuePath = path.join(root, 'upload-queue.json');
    this.queue = { sessions: {} };
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.sessionsRoot, { recursive: true });
    try {
      const text = await fs.readFile(this.queuePath, 'utf8');
      if (text.trim()) {
        this.queue = JSON.parse(text);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Không đọc được hàng đợi local: ${error.message}`);
    }
    this.queue.sessions ??= {};
    let recovered = false;
    for (const session of Object.values(this.queue.sessions)) {
      session.items ??= [];
      const expectedDirectory = this.sessionPath(session.id);
      for (const item of session.items) {
        if (!item.filename || item.filename !== path.basename(item.filename)) {
          item.deletedAt ??= new Date().toISOString();
          item.invalidReason = 'invalid-filename';
          recovered = true;
          continue;
        }
        const expectedPath = path.join(expectedDirectory, item.filename);
        const relative = path.relative(expectedDirectory, expectedPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          item.deletedAt ??= new Date().toISOString();
          item.invalidReason = 'path-outside-session';
          recovered = true;
          continue;
        }
        item.path = expectedPath;
      }
      if (session.status === 'capturing' && !session.items.some((item) => !item.deletedAt)) {
        const directory = this.sessionPath(session.id);
        delete this.queue.sessions[session.id];
        try { await fs.rmdir(directory); } catch { }
        recovered = true;
        continue;
      }
      if (session.status === 'capturing' && session.items.some((item) => !item.deletedAt)) {
        session.status = 'recoverable';
        session.recoveredAt = new Date().toISOString();
        recovered = true;
      } else if (session.status === 'uploading' && session.items.some((item) => !item.deletedAt)) {
        session.status = 'pending';
        session.recoveredAt = new Date().toISOString();
        recovered = true;
      }
    }
    if (recovered) await this.persist();
  }

  sessionPath(sessionId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id');
    const session = this.queue.sessions[sessionId];
    const folderName = session?.folderName || sessionId;
    if (!/^[a-zA-Z0-9_-]+$/.test(folderName)) throw new Error('Invalid session folder');
    return path.join(this.sessionsRoot, folderName);
  }

  async reserveSessionFolder(date = new Date()) {
    const base = sessionFolderTime(date);
    for (let suffix = 0; suffix < 1000; suffix += 1) {
      const folderName = suffix ? `${base}_${String(suffix + 1).padStart(2, '0')}` : base;
      try {
        await fs.mkdir(path.join(this.sessionsRoot, folderName), { recursive: false });
        return folderName;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw new Error('Không thể tạo thư mục phiên chụp duy nhất');
  }

  async createSession(mode = 'photo', expirationDays = 7) {
    const now = new Date();
    const id = `PB_${now.toISOString().replace(/[-:.]/g, '').replace('Z', '')}_${crypto.randomBytes(3).toString('hex')}`;
    const folderName = await this.reserveSessionFolder(now);
    this.queue.sessions[id] = {
      id, folderName, mode, createdAt: now.toISOString(), status: 'capturing', items: [], attempts: 0,
      galleryToken: crypto.randomBytes(18).toString('base64url'),
      expiresAt: new Date(Date.now() + Math.max(1, expirationDays) * 86400000).toISOString()
    };
    await this.persist();
    return publicSession(this.queue.sessions[id]);
  }

  async saveArtifact({ sessionId, kind, extension, bytes, originalName, profile }) {
    const session = this.queue.sessions[sessionId];
    if (!session) throw new Error('Session not found');
    if (isExpired(session)) throw new Error('Gallery đã hết hạn');
    if (session.status !== 'capturing') throw new Error('Session không còn nhận ảnh');
    const ext = String(extension).toLowerCase().replace('.', '');
    if (!allowedExtensions.has(ext)) throw new Error(`Unsupported extension: ${ext}`);
    const resultProfile = kind === 'photo-strip' ? String(profile || '') : '';
    if (kind === 'photo-strip' && !validResultProfiles.has(resultProfile)) throw new Error('Profile ảnh kết quả không hợp lệ');
    const sequence = String(session.items.length + 1).padStart(2, '0');
    const cleanOriginal = originalName ? path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_') : '';
    const filename = cleanOriginal || `${safeTime()}_${sequence}_${kind}.${ext}`;
    const target = path.join(this.sessionPath(sessionId), filename);
    const buffer = Buffer.from(bytes);
    if (!isValidArtifact(buffer, ext)) throw new Error('Nội dung tệp không hợp lệ');
    await fs.writeFile(target, buffer);
    const item = {
      id: crypto.randomUUID(), kind, filename, path: target, size: buffer.length,
      md5: crypto.createHash('md5').update(buffer).digest('hex'), status: 'pending', createdAt: new Date().toISOString()
    };
    if (kind === 'photo-strip') item.profile = resultProfile;
    const previousResult = session.result ? structuredClone(session.result) : null;
    session.items.push(item);
    if (kind === 'photo-strip') {
      session.result = { artifactId: item.id, profile: resultProfile, readyAt: item.createdAt, acknowledgedAt: null };
    }
    try {
      await this.persist();
    } catch (error) {
      session.items.pop();
      if (kind === 'photo-strip') {
        if (previousResult) session.result = previousResult;
        else delete session.result;
      }
      try { await fs.unlink(target); } catch { }
      throw error;
    }
    return publicItem(item);
  }

  async registerExisting({ sessionId, kind, filePath }) {
    const bytes = await fs.readFile(filePath);
    return this.saveArtifact({
      sessionId, kind, extension: path.extname(filePath).slice(1) || 'jpg', bytes,
      originalName: `${safeTime()}_${kind}${path.extname(filePath) || '.jpg'}`
    });
  }

  resolveArtifact(sessionId, artifactId, allowedKinds = []) {
    const session = this.queue.sessions[sessionId];
    if (!session) throw new Error('Session not found');
    if (isExpired(session)) throw new Error('Gallery đã hết hạn');
    const item = session.items?.find((candidate) => candidate.id === artifactId);
    if (!item || item.deletedAt) throw new Error('Ảnh gốc không tồn tại');
    if (allowedKinds.length && !allowedKinds.includes(item.kind)) throw new Error('Loại ảnh không hợp lệ để ghép frame');
    if (!/\.jpe?g$/i.test(item.filename)) throw new Error('Compositor chỉ nhận JPEG gốc');
    return { ...item };
  }

  listRecoverableSessions() {
    return Object.values(this.queue.sessions)
      .filter((session) => session.status === 'recoverable' && !isExpired(session) && session.items?.some((item) => !item.deletedAt && originalKinds.has(item.kind)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((session) => publicSession(session, { includeItems: true, includeDraft: true }));
  }

  listAllWithPhotos() {
    return Object.values(this.queue.sessions)
      .filter((session) => session.items?.some((item) => !item.deletedAt && originalKinds.has(item.kind)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((session) => publicSession(session, { includeItems: true, includeDraft: true }));
  }

  async readOriginalsAny(sessionId, artifactIds = []) {
    const session = this.queue.sessions[sessionId];
    if (!session) throw new Error('Session not found');
    const allOriginals = session.items?.filter((item) => !item.deletedAt && originalKinds.has(item.kind)) || [];
    const requested = artifactIds.length ? artifactIds : allOriginals.map((item) => item.id);
    if (!requested.length) return [];
    if (new Set(requested).size !== requested.length) throw new Error('Duplicate artifact IDs');
    const results = [];
    for (const artifactId of requested) {
      const item = allOriginals.find((i) => i.id === artifactId);
      if (!item || !item.path) continue;
      try {
        const bytes = await fs.readFile(item.path);
        results.push({ ...publicItem(item), bytes: Uint8Array.from(bytes), mimeType: 'image/jpeg' });
      } catch { /* skip missing/deleted files */ }
    }
    return results;
  }

  async resumeSession(sessionId) {
    const session = this.queue.sessions[sessionId];
    if (!session || session.status !== 'recoverable') throw new Error('Phiên chụp không thể khôi phục');
    if (isExpired(session)) throw new Error('Gallery đã hết hạn');
    session.status = 'capturing';
    session.resumedAt = new Date().toISOString();
    await this.persist();
    return publicSession(session, { includeItems: true, includeDraft: true });
  }

  async readOriginals(sessionId, artifactIds = []) {
    const session = this.queue.sessions[sessionId];
    if (!session || !['capturing', 'recoverable'].includes(session.status)) throw new Error('Phiên chụp không khả dụng');
    const requested = artifactIds.length ? artifactIds : session.items.filter((item) => originalKinds.has(item.kind) && !item.deletedAt).map((item) => item.id);
    if (new Set(requested).size !== requested.length) throw new Error('Danh sách ảnh bị trùng');
    return Promise.all(requested.map(async (artifactId) => {
      const item = this.resolveArtifact(sessionId, artifactId, [...originalKinds]);
      const bytes = await fs.readFile(item.path);
      if (!isValidArtifact(bytes, path.extname(item.filename).slice(1).toLowerCase())) throw new Error('Ảnh local bị hỏng');
      return { ...publicItem(item), bytes: Uint8Array.from(bytes), mimeType: 'image/jpeg' };
    }));
  }

  resultItem(session) {
    const result = session?.result;
    if (!result || result.acknowledgedAt || !validResultProfiles.has(result.profile)) return null;
    const item = session.items?.find((candidate) => candidate.id === result.artifactId && candidate.kind === 'photo-strip' && !candidate.deletedAt);
    return item || null;
  }

  listRestorableResults() {
    return Object.values(this.queue.sessions)
      .filter((session) => restorableResultStatuses.has(session.status) && !isExpired(session) && this.resultItem(session))
      .sort((left, right) => String(right.result.readyAt || right.createdAt).localeCompare(String(left.result.readyAt || left.createdAt)))
      .map((session) => ({
        ...publicSession(session),
        result: { artifactId: session.result.artifactId, profile: session.result.profile, readyAt: session.result.readyAt }
      }));
  }

  async readResult(sessionId) {
    const session = this.queue.sessions[sessionId];
    if (!session || !restorableResultStatuses.has(session.status) || isExpired(session)) throw new Error('Kết quả không thể khôi phục');
    const item = this.resultItem(session);
    if (!item) throw new Error('Ảnh kết quả không tồn tại');
    const bytes = await fs.readFile(item.path);
    if (!isValidArtifact(bytes, path.extname(item.filename).slice(1).toLowerCase())) throw new Error('Ảnh kết quả local bị hỏng');
    return {
      session: publicSession(session),
      item: publicItem(item),
      profile: session.result.profile,
      bytes: Uint8Array.from(bytes),
      mimeType: 'image/jpeg'
    };
  }

  async acknowledgeResult(sessionId) {
    const session = this.queue.sessions[sessionId];
    if (!session) throw new Error('Session not found');
    if (session.result && !session.result.acknowledgedAt) {
      session.result.acknowledgedAt = new Date().toISOString();
      await this.persist();
    }
    return publicSession(session);
  }

  validateDraft(session, draft = {}) {
    const targetCount = Number(draft.targetCount);
    if (!validTargetCounts.has(targetCount)) throw new Error('Số lượng ảnh draft không hợp lệ');
    const originalIds = new Set(session.items.filter((item) => !item.deletedAt && originalKinds.has(item.kind)).map((item) => item.id));
    const selectedArtifactIds = Array.isArray(draft.selectedArtifactIds) ? draft.selectedArtifactIds.map(String) : [];
    if (selectedArtifactIds.length > targetCount || new Set(selectedArtifactIds).size !== selectedArtifactIds.length || selectedArtifactIds.some((id) => !originalIds.has(id))) {
      throw new Error('Danh sách ảnh draft không hợp lệ');
    }
    const rawAssignments = Array.isArray(draft.slotAssignments) ? draft.slotAssignments : [];
    if (rawAssignments.length > targetCount) throw new Error('Số slot draft không hợp lệ');
    const slotAssignments = Array.from({ length: targetCount }, (_value, index) => rawAssignments[index] == null ? null : String(rawAssignments[index]));
    const assigned = slotAssignments.filter(Boolean);
    if (new Set(assigned).size !== assigned.length || assigned.some((id) => !selectedArtifactIds.includes(id))) throw new Error('Assignment draft không hợp lệ');
    const transforms = {};
    for (const [artifactId, transform] of Object.entries(draft.transforms || {})) {
      if (!originalIds.has(artifactId)) throw new Error('Transform draft không hợp lệ');
      transforms[artifactId] = normalizePhotoTransform(transform);
    }
    return {
      targetCount,
      selectedArtifactIds,
      frameId: typeof draft.frameId === 'string' ? draft.frameId.slice(0, 200) : '',
      slotAssignments,
      transforms,
      step: ['selection', 'frame'].includes(draft.step) ? draft.step : 'selection',
      updatedAt: new Date().toISOString()
    };
  }

  async saveDraft({ sessionId, draft }) {
    const session = this.queue.sessions[sessionId];
    if (!session || !['capturing', 'recoverable'].includes(session.status)) throw new Error('Phiên chụp không khả dụng');
    session.draft = this.validateDraft(session, draft);
    await this.persist();
    return structuredClone(session.draft);
  }

  async finishSession(sessionId) {
    const session = this.queue.sessions[sessionId];
    if (!session) throw new Error('Session not found');
    if (isExpired(session)) throw new Error('Gallery đã hết hạn');
    if (!session.items?.length) {
      const directory = this.sessionPath(sessionId);
      delete this.queue.sessions[sessionId];
      try { await fs.rmdir(directory); } catch { }
      await this.persist();
      throw new Error('Không thể hoàn tất gallery rỗng');
    }
    session.status = 'pending';
    session.finishedAt = new Date().toISOString();
    delete session.draft;
    await this.persist();
    return structuredClone(session);
  }

  async cancelSession(sessionId) {
    const session = this.queue.sessions[sessionId];
    if (!session || !['capturing', 'recoverable'].includes(session.status)) return session ? publicSession(session) : null;
    for (const item of session.items) {
      try { await fs.unlink(item.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      item.deletedAt = new Date().toISOString();
    }
    try { await fs.rmdir(this.sessionPath(sessionId)); } catch { }
    session.status = 'cancelled';
    session.cancelledAt = new Date().toISOString();
    session.finishedAt = new Date().toISOString();
    delete session.draft;
    await this.persist();
    return publicSession(session);
  }

  async mutate(sessionId, callback) {
    const session = this.queue.sessions[sessionId];
    if (!session) return;
    await callback(session);
    await this.persist();
  }

  pending() {
    return Object.values(this.queue.sessions)
      .filter((session) => !isExpired(session) && ['pending', 'retrying', 'uploading'].includes(session.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  stats() {
    const sessions = Object.values(this.queue.sessions);
    return {
      pending: sessions.filter((session) => !isExpired(session) && ['pending', 'retrying', 'uploading'].includes(session.status)).length,
      recoverable: sessions.filter((session) => !isExpired(session) && session.status === 'recoverable').length,
      uploaded: sessions.filter((session) => session.status === 'uploaded').length,
      failed: sessions.filter((session) => session.status === 'failed').length,
      localBytes: sessions.flatMap((session) => session.items || []).filter((item) => !item.deletedAt).reduce((sum, item) => sum + (item.size || 0), 0)
    };
  }

  findSession(sessionId, galleryToken) {
    const session = this.queue.sessions[sessionId];
    if (!session || !session.galleryToken || session.galleryToken !== galleryToken) return null;
    return session;
  }

  async cleanup(retentionHours) {
    const cutoff = Date.now() - Math.max(0, retentionHours) * 3600000;
    let removed = 0;
    for (const session of Object.values(this.queue.sessions)) {
      if (session.status !== 'uploaded' || !session.uploadedAt || Date.parse(session.uploadedAt) > cutoff) continue;
      for (const item of session.items) {
        if (item.deletedAt || item.status !== 'uploaded' || !item.checksumVerified) continue;
        const protectsResult = session.result?.artifactId === item.id && !session.result.acknowledgedAt && !isExpired(session);
        if (protectsResult) continue;
        try { await fs.unlink(item.path); } catch (error) { if (error.code !== 'ENOENT') continue; }
        item.deletedAt = new Date().toISOString();
        removed += 1;
      }
      try { await fs.rmdir(this.sessionPath(session.id)); } catch { }
    }
    if (removed) await this.persist();
    return removed;
  }

  async persist() {
    const operation = this.writeChain.catch(() => { }).then(async () => {
      await fs.mkdir(this.root, { recursive: true });
      const temporary = `${this.queuePath}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(this.queue, null, 2), 'utf8');
      await fs.rename(temporary, this.queuePath);
    });
    this.writeChain = operation.catch(() => { });
    return operation;
  }
}

export { sessionFolderTime };
