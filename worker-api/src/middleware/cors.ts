/**
 * Restrictive CORS. Only origins on the configured allowlist are reflected; everything else gets no
 * `Access-Control-Allow-Origin` (the browser then blocks it). Requests with no Origin header
 * (server-to-server, curl) pass through untouched. Preflight (OPTIONS) is answered here.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../shared/context';

const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Authorization,Content-Type,X-Request-Id,If-Match';
const MAX_AGE = '600';

/**
 * Public storefront routes decide CORS per store (the store's own allowed origins), so the global
 * admin allow-list must not apply to them and they handle OPTIONS themselves.
 */
const STOREFRONT_PATH = /^\/api\/[^/]+\/storefront\//;

export const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (STOREFRONT_PATH.test(new URL(c.req.url).pathname)) {
    await next();
    return;
  }
  const origin = c.req.header('origin');
  const allowed =
    origin !== undefined &&
    c.get('config').corsAllowedOrigins.includes(origin.toLowerCase().replace(/\/+$/, ''));

  if (c.req.method === 'OPTIONS') {
    const headers = new Headers();
    if (allowed && origin) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
      headers.set('Access-Control-Allow-Headers', c.req.header('access-control-request-headers') ?? ALLOWED_HEADERS);
      headers.set('Access-Control-Max-Age', MAX_AGE);
    }
    headers.set('Vary', 'Origin');
    return new Response(null, { status: 204, headers });
  }

  await next();

  c.res.headers.append('Vary', 'Origin');
  if (allowed && origin) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Expose-Headers', 'X-Request-Id');
  }
  return;
};
