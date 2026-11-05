/**
 * Where the ELEMENT'S OWN bundled files (the 4 default fonts, and any other `dist/product-
 * personalization/assets/...` file a template references by a relative path) are permanently
 * hosted. Every new template's `assetBaseUrl` is seeded from this constant.
 *
 * Why this has to be an absolute URL, not resolved at runtime: the Worker rewrites every asset
 * reference in a PUBLISHED template server-side (so the storefront element never needs to guess
 * where the bundle lives), and it can only do that by resolving a relative reference against the
 * template's own stored `assetBaseUrl`. If that field is itself relative (the old default,
 * `'assets/'`), the Worker has nothing to resolve it against and refuses to serve the whole
 * template (`personalizable: false`) — see docs/extension-platform-contract-v1.md and
 * worker-api/docs/zenbasket-integration.md.
 *
 * TEMPORARY PLACEHOLDER — replace with the real, stable public URL of wherever
 * `dist/product-personalization/` (the output of `npm run build:element`) is deployed, e.g. an R2
 * public bucket or an S3+CloudFront distribution, BEFORE relying on this in staging/production.
 * Must end in `/assets/` (the folder `build:element` copies static files into) and be reachable
 * with CORS from every storefront origin (the browser fetches fonts directly from it).
 */
export const BUNDLED_ASSET_BASE_URL = 'http://localhost:4600/assets/';

/**
 * True for anything the Worker can already resolve server-side (an absolute http(s) URL). False for
 * the old relative default (`'assets/'`), any other relative path, or a missing/empty value.
 */
function isAbsoluteHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Applied once, when a config is about to be persisted to (or imported into) the cloud-backed
 * repository: forces `assetBaseUrl` to an absolute URL so the Worker can resolve every relative
 * reference the template carries (the bundled fonts, and anything else). Leaves an already-absolute
 * value alone — a merchant/import may deliberately point at their own CDN.
 */
export function withCloudAssetBase<T extends { assetBaseUrl?: string }>(config: T): T {
  if (isAbsoluteHttpUrl(config.assetBaseUrl)) return config;
  return { ...config, assetBaseUrl: BUNDLED_ASSET_BASE_URL };
}
