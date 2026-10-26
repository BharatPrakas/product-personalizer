/**
 * Single build entry shared by both custom elements. It has no side effects: the stable files
 * `storefront.js` and `store-admin.js` (written by scripts/finalize-element.mjs) import the
 * loaders below, so Angular's runtime lives in shared chunks that are downloaded once and each
 * element's own code is a lazy chunk that is only fetched when that element is requested.
 */

export function loadStorefront(): Promise<void> {
  return import('./main.storefront').then((m) => m.registerProductCustomizer());
}

export function loadAdmin(): Promise<void> {
  return import('./main.admin').then((m) => m.registerPersonalizationAdmin());
}
