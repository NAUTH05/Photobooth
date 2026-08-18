import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig } from '../src/main/config-schema.js';

const base = {
  cloudflare: { enabled: false, baseUrl: '', uploadSecret: '' },
  storage: {}, gallery: {}, print: {}
};

test('normalizes safe operational limits and supports never-delete retention', () => {
  const value = normalizeConfig({ ...base, storage: { retentionHoursAfterUpload: -1, retryJitterPercent: 500 } });
  assert.equal(value.storage.retentionHoursAfterUpload, -1);
  assert.equal(value.storage.retryJitterPercent, 100);
  assert.equal(value.cloudflare.requestTimeoutSeconds, 180);
});

test('rejects unsafe Cloudflare configuration before saving it', () => {
  assert.throws(() => normalizeConfig({ ...base, cloudflare: { enabled: true, baseUrl: 'http://gallery.example', uploadSecret: 'short' } }), /HTTPS/);
  assert.throws(() => normalizeConfig({ ...base, cloudflare: { enabled: true, baseUrl: 'https://gallery.example', uploadSecret: 'short' } }), /24 ký tự/);
  assert.doesNotThrow(() => normalizeConfig({ ...base, cloudflare: { enabled: true, baseUrl: 'http://localhost:3000', uploadSecret: 'a'.repeat(24) } }));
});

test('normalizes the creative library independently from gallery uploads', () => {
  const value = normalizeConfig({
    ...base,
    assets: { enabled: true, baseUrl: 'http://localhost:8788/', syncMinutes: 0, requestTimeoutSeconds: 2 }
  });
  assert.equal(value.assets.baseUrl, 'http://localhost:8788');
  assert.equal(value.assets.syncMinutes, 1);
  assert.equal(value.assets.requestTimeoutSeconds, 10);
});

test('normalizes timelapse configuration', () => {
  const value = normalizeConfig({
    ...base,
    timelapse: { enabled: true, speed: 10, crf: 99, videoBitsPerSecond: 99999999 }
  });
  assert.equal(value.timelapse.enabled, true);
  assert.equal(value.timelapse.speed, 8);
  assert.equal(value.timelapse.crf, 51);
  assert.equal(value.timelapse.videoBitsPerSecond, 20000000);
});

