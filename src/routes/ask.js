import { Router } from 'express';
import { validateAsk } from '../middleware/validate.js';

// POST /api/ask  { question: string, history?: [{role, content}] }
// -> { answer, provider, model, usage, latencyMs }
export function askRouter(llm) {
  const router = Router();

  router.post('/ask', validateAsk, async (req, res, next) => {
    try {
      const result = await llm.ask({ question: req.body.question, history: req.body.history });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/health', (req, res) => {
    res.json({ ok: true, provider: llm.provider.name, model: llm.provider.model });
  });

  return router;
}
