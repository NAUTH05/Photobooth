import fs from 'node:fs/promises';
import sharp from 'sharp';
import { applyLutBuffer } from './lut-processor.js';

const originalKinds = new Set(['photo-original', 'dslr-original']);

export class GradedPhotoService {
  constructor(localStore, lutManager) {
    this.localStore = localStore;
    this.lutManager = lutManager;
  }

  resolveOriginal(sessionId, artifactId) {
    return this.localStore.resolveArtifact(sessionId, String(artifactId || ''), [...originalKinds]);
  }

  async normalizedBytes(item, maxWidth = 0) {
    let pipeline = sharp(item.path, { failOn: 'warning' }).autoOrient();
    if (maxWidth > 0) {
      pipeline = pipeline.resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true });
    }
    return pipeline.jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
  }

  async renderPreview({ sessionId, artifactId, lutId, maxWidth = 2400 }) {
    const item = this.resolveOriginal(sessionId, artifactId);
    const width = Math.max(480, Math.min(3200, Math.round(Number(maxWidth) || 2400)));
    const input = await this.normalizedBytes(item, width);
    const bytes = await applyLutBuffer(input, this.lutManager.resolve(lutId), { format: 'jpeg' });
    return { bytes: Uint8Array.from(bytes), mimeType: 'image/jpeg' };
  }

  async prepareSession({ sessionId, artifactIds, lutId }) {
    const requested = Array.isArray(artifactIds) ? artifactIds.map(String) : [];
    if (!requested.length || requested.length > 50 || new Set(requested).size !== requested.length) throw new Error('Danh sách ảnh hậu kỳ không hợp lệ');
    const sources = requested.map((artifactId) => this.resolveOriginal(sessionId, artifactId));
    const selectedLut = this.lutManager.resolve(lutId);
    const session = this.localStore.queue.sessions[sessionId];
    if (!session || ['cancelled', 'failed', 'expired'].includes(session.status)) throw new Error('Phiên ảnh không còn nhận hậu kỳ');
    const sourceIds = new Set(sources.map((item) => item.id));

    if (selectedLut.id === 'natural') {
      await this.localStore.mutate(sessionId, (value) => {
        value.publishedLutId = 'natural';
        for (const item of value.items) {
          if (originalKinds.has(item.kind) && sourceIds.has(item.id)) item.galleryHidden = false;
          if (item.kind === 'photo-thumbnail' && sourceIds.has(item.sourceItemId)) item.galleryHidden = false;
          if (item.kind === 'photo-processed' && sourceIds.has(item.sourceItemId)) item.galleryHidden = true;
          if (item.kind === 'photo-thumbnail') {
            const processed = value.items.find((candidate) => candidate.id === item.sourceItemId && candidate.kind === 'photo-processed');
            if (processed && sourceIds.has(processed.sourceItemId)) item.galleryHidden = true;
          }
        }
      });
      return { lutId: 'natural', items: [] };
    }

    const selectedProcessedIds = new Map();
    for (const source of sources) {
      let processed = session.items.find((item) => item.kind === 'photo-processed' && item.sourceItemId === source.id && item.lutId === selectedLut.id && !item.deletedAt);
      if (processed) {
        try { await fs.access(processed.path); } catch { processed = null; }
      }
      if (!processed) {
        const normalized = await this.normalizedBytes(source);
        const bytes = await applyLutBuffer(normalized, selectedLut, { format: 'jpeg' });
        const saved = await this.localStore.saveArtifact({
          sessionId,
          kind: 'photo-processed',
          extension: 'jpg',
          bytes,
          sourceItemId: source.id,
          lutId: selectedLut.id
        });
        processed = this.localStore.queue.sessions[sessionId].items.find((item) => item.id === saved.id);
      }
      selectedProcessedIds.set(source.id, processed.id);
    }

    await this.localStore.mutate(sessionId, (value) => {
      value.publishedLutId = selectedLut.id;
      for (const item of value.items) {
        if (originalKinds.has(item.kind) && sourceIds.has(item.id)) item.galleryHidden = true;
        if (item.kind === 'photo-thumbnail' && sourceIds.has(item.sourceItemId)) item.galleryHidden = true;
        if (item.kind === 'photo-processed' && sourceIds.has(item.sourceItemId)) {
          item.galleryHidden = selectedProcessedIds.get(item.sourceItemId) !== item.id;
        }
        if (item.kind === 'photo-thumbnail') {
          const processed = value.items.find((candidate) => candidate.id === item.sourceItemId && candidate.kind === 'photo-processed');
          if (processed && sourceIds.has(processed.sourceItemId)) {
            item.galleryHidden = selectedProcessedIds.get(processed.sourceItemId) !== processed.id;
          }
        }
      }
    });
    return {
      lutId: selectedLut.id,
      items: [...selectedProcessedIds.values()].map((id) => {
        const item = this.localStore.queue.sessions[sessionId].items.find((candidate) => candidate.id === id);
        return { id: item.id, kind: item.kind, sourceItemId: item.sourceItemId, filename: item.filename };
      })
    };
  }
}
