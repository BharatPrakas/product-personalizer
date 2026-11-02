/**
 * Application assembly: the middleware pipeline, the public health endpoint and the three route
 * groups of the API (their URL prefixes live in shared/api-paths.ts):
 *
 *  - storefront     public, no token; per-store CORS and rate limits
 *  - integrations   signed server-to-server calls; every handler authenticates the caller itself
 *  - merchant       Bearer token + tenant resolution
 */

import { Hono } from 'hono';
import type { AppEnv } from './shared/context';
import { ADMIN_SEGMENT, API_BASE, INTEGRATIONS_SEGMENT, STOREFRONT_SEGMENT } from './shared/api-paths';
import { requestContext } from './middleware/request-id';
import { cors } from './middleware/cors';
import { withDatabase } from './middleware/database';
import { authenticate } from './middleware/authentication';
import { tenantContext } from './middleware/tenant-context';
import { requirePluginEnabled } from './middleware/authorization';
import { onError, notFound } from './middleware/error-handler';
import { health } from './platform/controller';
import * as controller from './plugins/personalization/controller';
import * as customizations from './plugins/personalization/customization-controller';
import * as integration from './plugins/personalization/integration-controller';
import * as mappings from './plugins/personalization/mapping-controller';
import * as storefront from './plugins/personalization/storefront-controller';
import { PLUGIN_ID } from './plugins/personalization/types';
import { ok } from './shared/responses';
import { RateLimiter, type RateLimitStore } from './shared/rate-limit';

export interface AppDependencies {
  /** Counter store for the public-route limiter. Defaults to a per-isolate in-memory store. */
  rateLimitStore?: RateLimitStore;
  /** Clock for the limiter (epoch ms). Injectable for tests. */
  now?: () => number;
}

/** Merchant routes. Mounted behind authentication and tenant resolution; the store comes from the token. */
function merchantRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.use('*', requirePluginEnabled(PLUGIN_ID));

  // Configurations
  router.get('/configs', controller.listConfigs);
  router.post('/configs', controller.createConfig);
  router.get('/configs/:configId', controller.getConfig);
  router.put('/configs/:configId', controller.saveDraft);
  router.delete('/configs/:configId', controller.deleteConfig);
  router.post('/configs/:configId/publish', controller.publishConfig);
  router.post('/configs/:configId/duplicate', controller.duplicateConfig);
  router.post('/configs/:configId/archive', controller.archiveConfig);
  router.post('/configs/:configId/restore', controller.restoreConfig);

  // Version history
  router.get('/configs/:configId/versions', controller.listVersions);
  router.get('/configs/:configId/versions/:versionId', controller.getVersion);

  // Assets (binaries live in R2; metadata in Postgres)
  router.post('/assets', controller.uploadAsset);
  router.get('/assets', controller.listAssets);
  router.get('/assets/:assetId', controller.getAsset);
  router.get('/assets/:assetId/content', controller.getAssetContent);
  router.delete('/assets/:assetId', controller.deleteAsset);

  // Product mappings (`/mappings/bulk` is registered before `/mappings/:id`)
  router.get('/mappings', mappings.listMappings);
  router.post('/mappings', mappings.createMapping);
  router.post('/mappings/bulk', mappings.bulkMappings);
  router.put('/mappings/:id', mappings.updateMapping);
  router.delete('/mappings/:id', mappings.deleteMapping);

  // Markups
  router.get('/markups', mappings.listMarkups);
  router.post('/markups', mappings.createMarkup);
  router.put('/markups/:id', mappings.updateMarkup);
  router.delete('/markups/:id', mappings.deleteMarkup);

  // Per-store storefront settings (allowed CORS origins)
  router.get('/settings/storefront', mappings.getStorefrontSettings);
  router.put('/settings/storefront', mappings.putStorefrontSettings);

  // Customer customizations (merchant read access; private files stream only through here)
  router.get('/customizations', customizations.listCustomizations);
  router.get('/customizations/:id', customizations.getCustomization);
  router.get('/customizations/:id/assets/:assetId/content', customizations.getCustomizationAssetContent);

  // Per-store signing secrets for the order callback (needs the `integrations:manage` scope)
  router.get('/integration/credentials', integration.listCredentials);
  router.post('/integration/credentials', integration.createCredential);
  router.post('/integration/credentials/:id/rotate', integration.rotateCredential);
  router.delete('/integration/credentials/:id', integration.revokeCredential);
  return router;
}

/**
 * Public storefront routes, with NO authentication or tenant middleware. Handlers derive everything
 * from the request itself, validate it strictly and never trust it to select data outside what is
 * meant to be public.
 */
function storefrontRoutes(rateLimiter: RateLimiter): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  // Error responses (429, 4xx) from public routes must never be cached by shared caches.
  router.use('*', async (c, next) => {
    await next();
    // Raw `Response`s bypass the global header merge, so set the correlation id explicitly.
    c.res.headers.set('X-Request-Id', c.get('requestId'));
    if (c.res.status >= 400) c.res.headers.set('Cache-Control', 'no-store');
    if (!c.res.headers.has('Vary')) c.res.headers.set('Vary', 'Origin');
  });
  router.get('/products/:externalId/config', storefront.getProductConfig(rateLimiter));
  router.options('/products/:externalId/config', storefront.preflight(rateLimiter, 'config'));
  router.get('/assets/:assetId', storefront.getPublicAsset(rateLimiter));
  router.options('/assets/:assetId', storefront.preflight(rateLimiter, 'asset'));

  // Shopper customizations: private uploads, save, and token-gated read / update.
  const preflight = customizations.customerPreflight(rateLimiter);
  router.post('/uploads', customizations.uploadCustomerAsset(rateLimiter));
  router.options('/uploads', preflight);
  router.post('/customizations', customizations.createCustomization(rateLimiter));
  router.options('/customizations', preflight);
  router.get('/customizations/:id', customizations.getCustomizationForShopper(rateLimiter));
  router.put('/customizations/:id', customizations.updateCustomization(rateLimiter));
  router.options('/customizations/:id', preflight);
  router.get('/customizations/:id/assets/:assetId', customizations.getCustomizationAssetForShopper(rateLimiter));
  router.options('/customizations/:id/assets/:assetId', preflight);
  return router;
}

/** Server-to-server routes: no Bearer token; each handler verifies the request signature itself. */
function integrationRoutes(rateLimiter: RateLimiter): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  router.post('/events', integration.orderEvents(rateLimiter));
  return router;
}

export function createApp(deps: AppDependencies = {}): Hono<AppEnv> {
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

  // Registered BEFORE the secured area so its authentication middleware never runs for these routes.
  app.route(`${API_BASE}/${STOREFRONT_SEGMENT}`, storefrontRoutes(rateLimiter));
  app.route(`${API_BASE}/${INTEGRATIONS_SEGMENT}`, integrationRoutes(rateLimiter));
  app.all(`${API_BASE}/integrations/*`, notFound);

  // Anything else under the public prefix is a plain 404 (not a 401 from the secured area below).
  app.all(`${API_BASE}/storefront/*`, notFound);

  // Authenticated + tenant-scoped area. Registered AFTER health so health stays public.
  const secured = new Hono<AppEnv>();
  secured.use('*', authenticate);
  secured.use('*', tenantContext);
  secured.route(`/${ADMIN_SEGMENT}`, merchantRoutes());

  app.route(API_BASE, secured);
  return app;
}
