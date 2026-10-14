import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, withTimeout, isRetryable, LlmError } from '../src/llm/retry.js';

test('withTimeout aborts a slow call', async () => {
  await assert.rejects(
    withTimeout((signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
      });
    }), 20),
    (err) => err.name === 'AbortError',
  );
});

test('withRetry retries retryable errors up to maxRetries', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new LlmError('busy', { status: 503, retryable: true });
    return 'ok';
  }, { maxRetries: 2, baseDelayMs: 1 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry gives up after maxRetries', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls += 1; throw new LlmError('busy', { status: 503, retryable: true }); },
      { maxRetries: 2, baseDelayMs: 1 }),
    /busy/,
  );
  assert.equal(calls, 3);
});

test('withRetry does not retry non-retryable errors', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls += 1; throw new LlmError('bad request', { status: 400, retryable: false }); },
      { maxRetries: 5, baseDelayMs: 1 }),
    /bad request/,
  );
  assert.equal(calls, 1);
});

test('isRetryable classifies common SDK errors', () => {
  assert.equal(isRetryable({ status: 429 }), true);
  assert.equal(isRetryable({ status: 502 }), true);
  assert.equal(isRetryable({ status: 400 }), false);
  assert.equal(isRetryable({ status: 401 }), false);
  assert.equal(isRetryable({ name: 'AbortError' }), true);
  assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
});
