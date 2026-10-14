import Anthropic from '@anthropic-ai/sdk';
import { LlmError } from './retry.js';

// Provider adapter for Claude. Every provider exposes the same shape:
//   name, model, complete({ system, messages, signal }) -> { text, usage, model }
// so the rest of the app never knows which vendor is behind it.
export function createAnthropicProvider({ apiKey, model }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey, maxRetries: 0 }); // we do our own retries

  return {
    name: 'anthropic',
    model,
    async complete({ system, messages, maxTokens = 1024, signal }) {
      try {
        const res = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
          },
          { signal },
        );
        const text = res.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        return {
          text,
          model: res.model,
          usage: {
            inputTokens: res.usage?.input_tokens ?? 0,
            outputTokens: res.usage?.output_tokens ?? 0,
          },
        };
      } catch (err) {
        throw toLlmError(err, 'anthropic');
      }
    },
  };
}

function toLlmError(err, provider) {
  const status = err?.status ?? err?.statusCode;
  if (status === 401 || status === 403) {
    return new LlmError(`${provider}: invalid API key`, { status: 500, retryable: false, cause: err });
  }
  if (status === 400) {
    return new LlmError(`${provider}: bad request to model`, { status: 400, retryable: false, cause: err });
  }
  if (status === 429) {
    return new LlmError(`${provider}: rate limited`, { status: 503, retryable: true, cause: err });
  }
  if (err?.name === 'AbortError') {
    return new LlmError(`${provider}: request timed out`, { status: 504, retryable: true, cause: err });
  }
  return new LlmError(`${provider}: upstream error`, { status: 502, retryable: true, cause: err });
}
