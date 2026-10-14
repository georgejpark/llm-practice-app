import { config } from './config.js';
import { createApp } from './app.js';
import { createProvider, createLlmService } from './llm/index.js';

// Entry point: wire real config -> real provider -> app -> listen.
const provider = createProvider(config);
const llm = createLlmService({ provider });
const app = createApp({ llm });

const server = app.listen(config.port, () => {
  console.log(`listening on http://localhost:${config.port} (provider=${provider.name}, model=${provider.model})`);
});

// Graceful shutdown so in-flight requests finish when the process is stopped.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
