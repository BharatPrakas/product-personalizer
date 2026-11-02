/**
 * Resolves the tenant for the request from the verified auth principal. Runs after `authenticate`,
 * so the store id is always signature-derived. A single place to add future tenant-level checks
 * (suspended store, data residency, ...) without touching every route.
 *
 * The hosting platform only issues tokens for stores that have this extension, so a verified token is
 * all it takes for the store to become known to the public routes (see `StoreSettingsRepository`).
 */

import type { MiddlewareHandler } from 'hono';
import { StoreSettingsRepository } from '../modules/store-settings/repository';
import type { AppEnv } from '../shared/context';
import { UnauthorizedError } from '../shared/errors';

export const tenantContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth?.storeId) throw new UnauthorizedError('No tenant could be resolved.');
  await new StoreSettingsRepository(c.get('db')).ensure(auth.storeId);
  c.set('tenant', { storeId: auth.storeId });
  // Attach the store id to every subsequent log line for this request.
  c.set('logger', c.get('logger').child({ storeId: auth.storeId }));
  await next();
};
