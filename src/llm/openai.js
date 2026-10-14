import OpenAI from 'openai';
import { LlmError } from './retry.js';

// Provider adapter for OpenAI. Same interface as the Anthropic adapter.
// On the real take-home, this is the one that will be exercised.
export function createOpenAIProvider({ apiKey, model }) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const client = new OpenAI({ apiKey, maxRetries: 0 }); // we do our own retries

  return {
    name: 'openai',
    model,
    async complete({ system, messages, maxTokens = 1024, signal }) {
      try {
        const res = await client.chat.completions.create(
          {
            model,
            max_tokens: maxTokens,
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              ...messages.map((m) => ({ role: m.role, content: m.content })),
            ],
          },
          { signal },
        );
        const choice = res.choices?.[0];
        return {
          text: choice?.message?.content ?? '',
          model: res.model,
          usage: {
            inputTokens: res.usage?.prompt_tokens ?? 0,
            outputTokens: res.usage?.completion_tokens ?? 0,
          },
        };
      } catch (err) {
        throw toLlmError(err, 'openai');
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
