/**
 * Assigns a request id (honouring a well-formed inbound `X-Request-Id`, else generating one) and
 * attaches the parsed config and a request-scoped logger. Runs first so everything downstream — and
 * every error response — can be correlated.
 */

import type { MiddlewareHandler } from 'hono';
import { loadConfig } from '../config/environment';
import type { AppEnv } from '../shared/context';
import { Logger } from '../shared/logger';

const VALID_ID = /^[A-Za-z0-9._-]{8,128}$/;

export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const inbound = c.req.header('x-request-id');
  const requestId = inbound && VALID_ID.test(inbound) ? inbound : crypto.randomUUID();
  const config = loadConfig(c.env);
  const logger = new Logger(config.logLevel, { requestId });

  c.set('requestId', requestId);
  c.set('config', config);
  c.set('logger', logger);
  c.header('X-Request-Id', requestId);

  const start = Date.now();
  await next();
  logger.info('request', {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs: Date.now() - start,
  });
};
