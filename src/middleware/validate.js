import { config } from '../config.js';

// Validate the POST /api/ask body before it ever reaches the LLM.
// Cheap checks here save money and keep garbage out of the model.
export function validateAsk(req, res, next) {
  const { question, history } = req.body ?? {};

  if (typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'question is required and must be a non-empty string' });
  }
  if (question.length > config.maxQuestionChars) {
    return res.status(400).json({ error: `question must be ${config.maxQuestionChars} characters or fewer` });
  }

  if (history !== undefined) {
    if (!Array.isArray(history)) {
      return res.status(400).json({ error: 'history must be an array of {role, content}' });
    }
    if (history.length > config.maxHistoryMessages) {
      return res.status(400).json({ error: `history must have ${config.maxHistoryMessages} messages or fewer` });
    }
    for (const m of history) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
        return res.status(400).json({ error: 'each history item needs role (user|assistant) and string content' });
      }
    }
  }

  req.body.question = question.trim();
  req.body.history = history ?? [];
  next();
}
