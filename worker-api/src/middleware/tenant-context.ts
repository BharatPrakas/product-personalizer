/**
 * Resolves the tenant for the request from the verified auth principal. Runs after `authenticate`,
 * so the store id is always signature-derived. A single place to add future tenant-level checks
 * (suspended store, data residency, ...) without touching every route.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../shared/context';
import { UnauthorizedError } from '../shared/errors';

export const tenantContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth?.storeId) throw new UnauthorizedError('No tenant could be resolved.');
  c.set('tenant', { storeId: auth.storeId });
  // Attach the store id to every subsequent log line for this request.
  c.set('logger', c.get('logger').child({ storeId: auth.storeId }));
  await next();
};
