import { EventEmitter } from 'node:events';

export class UploadManager extends EventEmitter {
  constructor(localStore, driveFactory, configStore) {
    super();
    this.localStore = localStore;
    this.driveFactory = driveFactory;
    this.configStore = configStore;
    this.running = false;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.process().catch(() => {}), 5000);
    this.process().catch(() => {});
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  async process() {
    const config = this.configStore.get();
    if (this.running || !config.drive.enabled) return;
    this.running = true;
    try {
      const client = this.driveFactory(config);
      for (const queued of this.localStore.pending()) {
        const nextAttemptAt = queued.nextAttemptAt ? Date.parse(queued.nextAttemptAt) : 0;
        if (nextAttemptAt > Date.now()) continue;
        await this.uploadSession(client, queued).catch(async (error) => {
          await this.localStore.mutate(queued.id, (session) => {
            session.status = 'retrying';
            session.attempts = (session.attempts ?? 0) + 1;
            session.lastError = String(error.message ?? error).slice(0, 500);
            const ceiling = config.storage.maxRetryMinutes * 60000;
            const wait = Math.min(ceiling, 5000 * (2 ** Math.min(session.attempts, 8)));
            session.nextAttemptAt = new Date(Date.now() + wait).toISOString();
          });
          this.emit('status', { sessionId: queued.id, status: 'retrying', error: String(error.message ?? error) });
        });
      }
      await this.expirePublicLinks(client);
    } finally {
      this.running = false;
    }
  }

  async expirePublicLinks(client) {
    const expired = Object.values(this.localStore.queue.sessions).filter((session) =>
      session.expiresAt && Date.parse(session.expiresAt) <= Date.now()
      && session.driveFolderId && session.drivePublicPermissionId && !session.permissionRevokedAt
    );
    for (const session of expired) {
      try {
        await client.revokePermission(session.driveFolderId, session.drivePublicPermissionId);
      } catch (error) {
        const status = error?.response?.status ?? error?.code;
        if (status !== 404) continue;
      }
      await this.localStore.mutate(session.id, (value) => { value.permissionRevokedAt = new Date().toISOString(); });
      this.emit('status', { sessionId: session.id, status: 'expired' });
    }
  }

  async uploadSession(client, queued) {
    if (queued.expiresAt && Date.parse(queued.expiresAt) <= Date.now()) {
      await this.localStore.mutate(queued.id, (session) => {
        session.status = 'expired';
        session.expiredAt ??= new Date().toISOString();
      });
      this.emit('status', { sessionId: queued.id, status: 'expired' });
      return;
    }
    await this.localStore.mutate(queued.id, (session) => { session.status = 'uploading'; session.lastError = null; });
    let session = this.localStore.queue.sessions[queued.id];
    this.emit('status', { sessionId: session.id, status: 'uploading', progress: 0 });
    if (!session.driveFolderId) {
      const folder = await client.createSessionFolder(session);
      await this.localStore.mutate(session.id, (value) => {
        value.driveFolderId = folder.id;
        value.publicLink = folder.webViewLink;
        value.drivePublicPermissionId = folder.publicPermissionId ?? null;
      });
    }
    session = this.localStore.queue.sessions[queued.id];
    let uploaded = session.items.filter((item) => item.status === 'uploaded').length;
    for (const item of session.items) {
      if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
        await this.localStore.mutate(session.id, (value) => {
          value.status = 'expired';
          value.expiredAt ??= new Date().toISOString();
        });
        this.emit('status', { sessionId: session.id, status: 'expired' });
        return;
      }
      if (item.status === 'uploaded') continue;
      const remote = await client.uploadFile(session.driveFolderId, item);
      const verified = Boolean(remote.md5Checksum) && remote.md5Checksum.toLowerCase() === item.md5.toLowerCase();
      if (!verified) throw new Error(`Checksum mismatch after uploading ${item.filename}`);
      await this.localStore.mutate(session.id, (value) => {
        const target = value.items.find((candidate) => candidate.id === item.id);
        Object.assign(target, { status: 'uploaded', driveFileId: remote.id, webViewLink: remote.webViewLink, checksumVerified: true, uploadedAt: new Date().toISOString() });
      });
      uploaded += 1;
      this.emit('status', { sessionId: session.id, status: 'uploading', progress: uploaded / session.items.length });
    }
    await this.localStore.mutate(session.id, (value) => {
      value.status = 'uploaded';
      value.uploadedAt = new Date().toISOString();
      value.nextAttemptAt = null;
    });
    session = this.localStore.queue.sessions[queued.id];
    this.emit('status', { sessionId: session.id, status: 'uploaded', progress: 1, publicLink: session.publicLink });
    await this.localStore.cleanup(this.configStore.get().storage.retentionHoursAfterUpload);
  }
}
