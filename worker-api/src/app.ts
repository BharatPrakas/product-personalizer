/**
 * Application assembly. Wires the middleware pipeline, the public health endpoint, the platform
 * endpoints and every registered plugin. The composition is deliberately plugin-agnostic: plugins
 * come from the registry and are mounted under a versioned namespace, each guarded by the shared
 * authentication / tenant / installation middleware. Adding a plugin changes only the registry.
 */

import { Hono } from 'hono';
import type { AppEnv } from './shared/context';
import { requestContext } from './middleware/request-id';
import { cors } from './middleware/cors';
import { withDatabase } from './middleware/database';
import { authenticate } from './middleware/authentication';
import { tenantContext } from './middleware/tenant-context';
import { requirePluginEnabled } from './middleware/authorization';
import { onError, notFound } from './middleware/error-handler';
import { health, listPlugins, pluginStatus } from './platform/controller';
import { PluginRegistry } from './platform/plugin-registry/registry';
import { personalizationPlugin } from './plugins/personalization/routes';
import { ok } from './shared/responses';
import { RateLimiter, type RateLimitStore } from './shared/rate-limit';

export const API_BASE = '/api/v1';

/** The platform's plugin registry. Append a `PluginModule` to add a plugin. */
export function buildRegistry(): PluginRegistry {
  return new PluginRegistry().register(personalizationPlugin);
}

export interface AppDependencies {
  /** Counter store for the public-route limiter. Defaults to a per-isolate in-memory store. */
  rateLimitStore?: RateLimitStore;
  /** Clock for the limiter (epoch ms). Injectable for tests. */
  now?: () => number;
}

export function createApp(
  registry: PluginRegistry = buildRegistry(),
  deps: AppDependencies = {},
): Hono<AppEnv> {
  const rateLimiter = new RateLimiter(deps.rateLimitStore, deps.now);
  const app = new Hono<AppEnv>();

  app.onError(onError);
  app.notFound(notFound);

  // Global pipeline (runs for every request, including preflight and health).
  app.use('*', requestContext);
  app.use('*', cors);
  app.use('*', withDatabase);

  // Public, unauthenticated.
  app.get('/', (c) => ok(c, { name: 'zb-plugin-platform', apiBase: API_BASE }));
  app.get(`${API_BASE}/health`, health);

  // Public plugin routes (storefront). Registered BEFORE the secured area so its authentication
  // middleware never runs for them; each handler answers without calling `next`.
  for (const plugin of registry.all()) {
    if (!plugin.registerPublic) continue;
    const publicRouter = new Hono<AppEnv>();
    plugin.registerPublic(publicRouter, { rateLimiter });
    app.route(`${API_BASE}/storefront/${plugin.id}`, publicRouter);
  }

  // Anything else under the public prefix is a plain 404 (not a 401 from the secured area below).
  app.all(`${API_BASE}/storefront/*`, notFound);

  // Authenticated + tenant-scoped area. Registered AFTER health so health stays public.
  const secured = new Hono<AppEnv>();
  secured.use('*', authenticate);
  secured.use('*', tenantContext);

  // Platform endpoints.
  secured.get('/plugins', listPlugins);
  secured.get('/plugins/:pluginId/status', pluginStatus);

  // Each plugin gets its own router, guarded by the installation check, mounted under its id.
  for (const plugin of registry.all()) {
    const router = new Hono<AppEnv>();
    router.use('*', requirePluginEnabled(plugin.id));
    plugin.register(router);
    secured.route(`/plugins/${plugin.id}`, router);
  }

  app.route(API_BASE, secured);
  return app;
}
