import { config } from '../config.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';
import { withRetry, withTimeout } from './retry.js';

// Pick the provider from config. Tests pass their own fake provider instead.
export function createProvider(cfg = config) {
  switch (cfg.provider) {
    case 'anthropic':
      return createAnthropicProvider(cfg.anthropic);
    case 'openai':
      return createOpenAIProvider(cfg.openai);
    default:
      throw new Error(`Unknown LLM_PROVIDER "${cfg.provider}" (use anthropic or openai)`);
  }
}

const SYSTEM_PROMPT = `You are a concise, accurate assistant for a customer support team.
Answer the user's question directly. If you are not sure, say so instead of guessing.
Keep answers under 200 words unless the user asks for more detail.`;

// The one function the routes call. Wraps the provider with timeout + retry and
// returns a plain object the HTTP layer can send back as JSON.
export function createLlmService({ provider, timeoutMs = config.requestTimeoutMs, maxRetries = config.maxRetries, logger = console }) {
  return {
    provider,
    async ask({ question, history = [] }) {
      const messages = [...history, { role: 'user', content: question }];
      const started = Date.now();

      const result = await withRetry(
        (attempt) =>
          withTimeout(
            (signal) => provider.complete({ system: SYSTEM_PROMPT, messages, signal }),
            timeoutMs,
          ),
        {
          maxRetries,
          onRetry: ({ attempt, delay, error }) =>
            logger.warn(`llm retry ${attempt} after ${delay}ms: ${error.message}`),
        },
      );

      return {
        answer: result.text.trim(),
        provider: provider.name,
        model: result.model,
        usage: result.usage,
        latencyMs: Date.now() - started,
      };
    },
  };
}
