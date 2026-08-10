import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const safeTime = () => new Date().toISOString().replace(/[:.]/g, '-');
const allowedExtensions = new Set(['jpg', 'jpeg', 'png', 'mp4']);
const isExpired = (session) => Boolean(session.expiresAt && Date.parse(session.expiresAt) <= Date.now());

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
    try { this.queue = JSON.parse(await fs.readFile(this.queuePath, 'utf8')); } catch {}
    this.queue.sessions ??= {};
    let recovered = false;
    for (const session of Object.values(this.queue.sessions)) {
      if (session.status === 'capturing' && !session.items?.length) {
        delete this.queue.sessions[session.id];
        try { await fs.rmdir(this.sessionPath(session.id)); } catch {}
        recovered = true;
        continue;
      }
      if ((session.status === 'capturing' || session.status === 'uploading') && session.items?.length) {
        session.status = 'pending';
        session.recoveredAt = new Date().toISOString();
        recovered = true;
      }
    }
    if (recovered) await this.persist();
  }

  sessionPath(sessionId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id');
    return path.join(this.sessionsRoot, sessionId);
  }

  async createSession(mode = 'photo', expirationDays = 7) {
    const id = `PB_${safeTime()}_${crypto.randomBytes(3).toString('hex')}`;
    await fs.mkdir(this.sessionPath(id), { recursive: true });
    this.queue.sessions[id] = {
      id, mode, createdAt: new Date().toISOString(), status: 'capturing', items: [], attempts: 0,
      galleryToken: crypto.randomBytes(18).toString('base64url'),
      expiresAt: new Date(Date.now() + Math.max(1, expirationDays) * 86400000).toISOString()
    };
    await this.persist();
    return this.queue.sessions[id];
  }

  async saveArtifact({ sessionId, kind, extension, bytes, originalName }) {
    const session = this.queue.sessions[sessionId];
    if (!session) throw new Error('Session not found');
    if (isExpired(session)) throw new Error('Gallery đã hết hạn');
    if (session.status !== 'capturing') throw new Error('Session không còn nhận ảnh');
    const ext = String(extension).toLowerCase().replace('.', '');
    if (!allowedExtensions.has(ext)) throw new Error(`Unsupported extension: ${ext}`);
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
    session.items.push(item);
    await this.persist();
    return { ...item, path: undefined };
  }

  async registerExisting({ sessionId, kind, filePath }) {
    const bytes = await fs.readFile(filePath);
    return this.saveArtifact({
      sessionId, kind, extension: path.extname(filePath).slice(1) || 'jpg', bytes,
      originalName: `${safeTime()}_${kind}${path.extname(filePath) || '.jpg'}`
    });
  }

  async finishSession(sessionId) {
    const session = this.queue.sessions[sessionId];
    if (!session) throw new Error('Session not found');
    if (isExpired(session)) throw new Error('Gallery đã hết hạn');
    if (!session.items?.length) {
      delete this.queue.sessions[sessionId];
      try { await fs.rmdir(this.sessionPath(sessionId)); } catch {}
      await this.persist();
      throw new Error('Không thể hoàn tất gallery rỗng');
    }
    session.status = 'pending';
    session.finishedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async cancelSession(sessionId) {
    const session = this.queue.sessions[sessionId];
    if (!session || session.status !== 'capturing') return session ? structuredClone(session) : null;
    for (const item of session.items) {
      try { await fs.unlink(item.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      item.deletedAt = new Date().toISOString();
    }
    try { await fs.rmdir(this.sessionPath(sessionId)); } catch {}
    session.status = 'cancelled';
    session.cancelledAt = new Date().toISOString();
    session.finishedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(session);
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
      pending: sessions.filter((s) => !isExpired(s) && ['pending', 'retrying', 'uploading'].includes(s.status)).length,
      uploaded: sessions.filter((s) => s.status === 'uploaded').length,
      failed: sessions.filter((s) => s.status === 'failed').length,
      localBytes: sessions.flatMap((s) => s.items).filter((i) => !i.deletedAt).reduce((sum, i) => sum + (i.size || 0), 0)
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
        try { await fs.unlink(item.path); } catch (error) { if (error.code !== 'ENOENT') continue; }
        item.deletedAt = new Date().toISOString();
        removed += 1;
      }
      try { await fs.rmdir(this.sessionPath(session.id)); } catch {}
    }
    if (removed) await this.persist();
    return removed;
  }

  async persist() {
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(this.root, { recursive: true });
      const temporary = `${this.queuePath}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(this.queue, null, 2), 'utf8');
      await fs.rename(temporary, this.queuePath);
    });
    return this.writeChain;
  }
}
