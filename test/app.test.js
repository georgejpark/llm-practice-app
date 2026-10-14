import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createLlmService } from '../src/llm/index.js';
import { LlmError } from '../src/llm/retry.js';

// A fake provider lets us test the whole HTTP path with no network and no key.
function fakeProvider({ text = 'hello from fake', fail } = {}) {
  const calls = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async complete({ system, messages }) {
      calls.push({ system, messages });
      if (fail) {
        // fail may be a single error (always throw) or a queue of errors (throw until empty)
        const err = Array.isArray(fail) ? fail.shift() : fail;
        if (err) throw err;
      }
      return { text, model: 'fake-1', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

const quiet = { info() {}, warn() {}, error() {} };

async function startApp(provider, opts = {}) {
  const llm = createLlmService({ provider, timeoutMs: 1000, maxRetries: opts.maxRetries ?? 1, logger: quiet });
  const app = createApp({ llm, logger: quiet });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const post = (base, body) =>
  fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('GET /api/health reports the provider', async () => {
  const { base, close } = await startApp(fakeProvider());
  try {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.provider, 'fake');
  } finally { await close(); }
});

test('POST /api/ask returns the model answer and usage', async () => {
  const provider = fakeProvider({ text: '  The answer is 42.  ' });
  const { base, close } = await startApp(provider);
  try {
    const res = await post(base, { question: 'What is the answer?' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.answer, 'The answer is 42.');
    assert.equal(body.provider, 'fake');
    assert.deepEqual(body.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(typeof body.latencyMs, 'number');
    // the system prompt and the user message reached the provider
    assert.match(provider.calls[0].system, /assistant/i);
    assert.deepEqual(provider.calls[0].messages.at(-1), { role: 'user', content: 'What is the answer?' });
  } finally { await close(); }
});

test('POST /api/ask passes conversation history through', async () => {
  const provider = fakeProvider();
  const { base, close } = await startApp(provider);
  try {
    const history = [
      { role: 'user', content: 'My name is George.' },
      { role: 'assistant', content: 'Hi George.' },
    ];
    const res = await post(base, { question: 'What is my name?', history });
    assert.equal(res.status, 200);
    assert.equal(provider.calls[0].messages.length, 3);
    assert.deepEqual(provider.calls[0].messages[0], history[0]);
  } finally { await close(); }
});

test('POST /api/ask rejects a missing or empty question', async () => {
  const { base, close } = await startApp(fakeProvider());
  try {
    for (const body of [{}, { question: '' }, { question: '   ' }, { question: 123 }]) {
      const res = await post(base, body);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /question/);
    }
  } finally { await close(); }
});

test('POST /api/ask rejects an over-long question and bad history', async () => {
  const { base, close } = await startApp(fakeProvider());
  try {
    let res = await post(base, { question: 'x'.repeat(5000) });
    assert.equal(res.status, 400);
    res = await post(base, { question: 'hi', history: 'nope' });
    assert.equal(res.status, 400);
    res = await post(base, { question: 'hi', history: [{ role: 'system', content: 'x' }] });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('retries a rate-limit error once and then succeeds', async () => {
  const rateLimited = new LlmError('rate limited', { status: 503, retryable: true });
  const provider = fakeProvider({ fail: [rateLimited] }); // first call fails, second succeeds
  const { base, close } = await startApp(provider, { maxRetries: 1 });
  try {
    const res = await post(base, { question: 'hi' });
    assert.equal(res.status, 200);
    assert.equal(provider.calls.length, 2);
  } finally { await close(); }
});

test('a non-retryable provider error becomes a clean JSON error', async () => {
  const bad = new LlmError('invalid API key', { status: 500, retryable: false });
  const provider = fakeProvider({ fail: bad });
  const { base, close } = await startApp(provider, { maxRetries: 2 });
  try {
    const res = await post(base, { question: 'hi' });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /unavailable/);     // no internal detail leaked
    assert.equal(typeof body.requestId, 'string');
    assert.equal(provider.calls.length, 1);      // not retried
  } finally { await close(); }
});

test('unknown routes return 404 JSON', async () => {
  const { base, close } = await startApp(fakeProvider());
  try {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
  } finally { await close(); }
});
