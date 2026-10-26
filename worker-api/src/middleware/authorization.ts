/**
 * Authorization helpers: scope checks and plugin-installation enforcement. Ownership of individual
 * resources (a specific config/asset belongs to this store) is enforced in the repository/service
 * layer with store-scoped queries — a hidden id or guessed path is never treated as authorization.
 */

import type { MiddlewareHandler } from 'hono';
import { StorePluginsRepository } from '../platform/plugin-permissions/repository';
import { ForbiddenError } from '../shared/errors';
import { hasScope, type AppEnv } from '../shared/context';

export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!hasScope(c.get('auth'), scope)) {
      throw new ForbiddenError(`Missing required scope "${scope}".`);
    }
    await next();
  };
}

/**
 * Ensures the plugin is enabled for the store. In development the install row is created on first
 * use (so the stack works out of the box); in staging/production an explicit installation is
 * required and a missing one is a 403.
 */
export function requirePluginEnabled(pluginId: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const repo = new StorePluginsRepository(c.get('db'));
    const storeId = c.get('tenant').storeId;
    let enabled = await repo.isEnabled(storeId, pluginId);
    if (!enabled && c.get('config').environment === 'development') {
      await repo.install(storeId, pluginId);
      enabled = true;
    }
    if (!enabled) {
      throw new ForbiddenError(`The "${pluginId}" plugin is not enabled for this store.`);
    }
    await next();
  };
}
