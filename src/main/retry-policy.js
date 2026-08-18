const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

export class RequestError extends Error {
  constructor(message, { status = null, retryable = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RequestError';
    this.status = Number.isFinite(Number(status)) ? Number(status) : null;
    this.retryable = retryable == null ? isRetryableStatus(this.status) : Boolean(retryable);
  }
}

export function isRetryableStatus(status) {
  const value = Number(status);
  if (!Number.isFinite(value)) return true;
  return RETRYABLE_HTTP_STATUSES.has(value) || value >= 500;
}

export function isRetryableError(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable;
  const status = error?.status ?? error?.response?.status;
  if (status != null) return isRetryableStatus(status);
  return true;
}

export function retryDelayMs(attempt, {
  baseMs = 5000,
  maxMs = 30 * 60 * 1000,
  jitterRatio = 0.2,
  random = Math.random
} = {}) {
  const exponent = Math.max(0, Math.min(8, Math.round(Number(attempt) || 1) - 1));
  const bounded = Math.min(Math.max(1, Number(maxMs) || 1), Math.max(1, Number(baseMs) || 1) * (2 ** exponent));
  const jitter = Math.max(0, Math.min(1, Number(jitterRatio) || 0));
  const factor = 1 - jitter + (Math.max(0, Math.min(1, Number(random()) || 0)) * jitter * 2);
  return Math.max(1, Math.round(bounded * factor));
}

export async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timeout')), Math.max(1000, Number(timeoutMs) || 120000));
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new RequestError('Kết nối quá thời gian cho phép', { retryable: true, cause: error });
    throw new RequestError(String(error?.message || error), { retryable: true, cause: error });
  } finally {
    clearTimeout(timer);
  }
}
