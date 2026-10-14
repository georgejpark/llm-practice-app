import 'dotenv/config';

// All configuration comes from environment variables so nothing secret is in the code.
// Defaults are safe for local practice; production would set every value explicitly.
const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  provider: (process.env.LLM_PROVIDER || 'anthropic').toLowerCase(),
  port: num(process.env.PORT, 3000),
  requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 30_000),
  maxRetries: num(process.env.MAX_RETRIES, 2),
  maxQuestionChars: 4_000,
  maxHistoryMessages: 20,
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },
};
