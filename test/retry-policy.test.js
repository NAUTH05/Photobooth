import assert from 'node:assert/strict';
import test from 'node:test';
import { isRetryableError, RequestError, retryDelayMs } from '../src/main/retry-policy.js';

test('classifies permanent and transient HTTP failures', () => {
  assert.equal(isRetryableError(new RequestError('unauthorized', { status: 401 })), false);
  assert.equal(isRetryableError(new RequestError('rate limited', { status: 429 })), true);
  assert.equal(isRetryableError(new RequestError('server error', { status: 503 })), true);
  assert.equal(isRetryableError(new Error('network disconnected')), true);
});

test('calculates bounded exponential backoff with deterministic jitter', () => {
  assert.equal(retryDelayMs(1, { baseMs: 1000, maxMs: 10000, jitterRatio: 0.2, random: () => 0 }), 800);
  assert.equal(retryDelayMs(3, { baseMs: 1000, maxMs: 10000, jitterRatio: 0, random: () => 1 }), 4000);
  assert.equal(retryDelayMs(20, { baseMs: 1000, maxMs: 10000, jitterRatio: 0, random: () => 1 }), 10000);
});
