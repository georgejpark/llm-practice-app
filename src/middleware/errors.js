import { randomUUID } from 'node:crypto';

// Attach a request id and log one line per request. Simple, but it means every
// error can be traced back to a request in the logs.
export function requestLogger(logger = console) {
  return (req, res, next) => {
    req.id = req.headers['x-request-id'] || randomUUID();
    res.setHeader('x-request-id', req.id);
    const started = Date.now();
    res.on('finish', () => {
      logger.info(`${req.id} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  };
}

// Last middleware in the chain. Turns any thrown error into a JSON response
// and never leaks stack traces or API keys to the client.
export function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    logger.error(`${req.id} error ${status}: ${err.message}`, err.cause?.message ? `(cause: ${err.cause.message})` : '');
    res.status(status).json({
      error: status >= 500 ? 'The assistant is unavailable right now. Please try again.' : err.message,
      requestId: req.id,
    });
  };
}
