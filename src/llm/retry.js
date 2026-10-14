// Shared helpers for talking to any LLM provider: a timeout wrapper and a retry
// loop with exponential backoff. Only "retryable" failures (rate limits, server
// errors, timeouts, network blips) are retried. Bad requests fail immediately.

export class LlmError extends Error {
  constructor(message, { status = 502, retryable = false, cause } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;       // HTTP status we will return to our own client
    this.retryable = retryable;
    this.cause = cause;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Decide whether an error from a provider SDK is worth retrying.
export function isRetryable(err) {
  if (err?.retryable !== undefined) return err.retryable;
  const status = err?.status ?? err?.statusCode;
  if (status === 429) return true;          // rate limited
  if (status >= 500 && status <= 599) return true;
  if (err?.name === 'AbortError') return true; // our own timeout
  if (err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT') return true;
  return false;
}

// Run fn(signal) and abort it if it takes longer than timeoutMs.
export async function withTimeout(fn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Retry with exponential backoff: 500ms, 1s, 2s ... capped at 8s.
export async function withRetry(fn, { maxRetries = 2, baseDelayMs = 500, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) throw err;
      const delay = Math.min(baseDelayMs * 2 ** attempt, 8_000);
      onRetry?.({ attempt: attempt + 1, delay, error: err });
      await sleep(delay);
      attempt += 1;
    }
  }
}
