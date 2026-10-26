/**
 * The personalization `PluginModule`: mounts the plugin's routes onto the router it is handed. The
 * router is already scoped to `/api/<version>/plugins/personalization` and guarded by
 * authentication, tenant resolution and the installation check (see app.ts), so handlers only deal
 * with business concerns. Adding a future plugin means writing another module like this one.
 */

import type { Hono } from 'hono';
import type { AppEnv } from '../../shared/context';
import type { PluginModule } from '../../platform/plugin-registry/registry';
import * as controller from './controller';
import * as mappings from './mapping-controller';
import * as storefront from './storefront-controller';
import { PLUGIN_ID, STORAGE_FOLDER } from './types';

export const personalizationPlugin: PluginModule = {
  id: PLUGIN_ID,
  displayName: 'Product Personalization',
  version: '1.0.0',
  storageFolder: STORAGE_FOLDER,
  register(router: Hono<AppEnv>): void {
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
  },
  registerPublic(router: Hono<AppEnv>, { rateLimiter }): void {
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
  },
};
