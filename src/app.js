import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { askRouter } from './routes/ask.js';
import { requestLogger, errorHandler } from './middleware/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build the Express app around an LLM service. Keeping this separate from
// server.js lets tests create an app with a fake provider and no network.
export function createApp({ llm, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', askRouter(llm));
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use(errorHandler(logger));
  return app;
}
