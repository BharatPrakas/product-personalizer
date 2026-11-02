/**
 * Signed asset URLs. The editor renders saved configs with plain browser requests (<img>, fetch), which
 * cannot carry a Bearer token, and a draft's assets must not be public. So the delivery URL stored in a
 * config carries a signature: HMAC-SHA256 over (store id, asset id) with a server-side secret.
 *
 *   <origin>/api/<v>/<STOREFRONT_SEGMENT>/assets/<uuid>?sig=<base64url>
 *
 * The signature is a capability: it proves the Worker issued this URL for this store's asset, so it can
 * be stored in the configuration (it never expires) and is useless for any other asset or store. Rotate
 * `ASSET_SIGNING_SECRET` only if you accept re-issuing the URLs saved in configurations.
 *
 * Uses `node:crypto` (available on Workers with `nodejs_compat`) so signing stays synchronous.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ADMIN_SEGMENT, STOREFRONT_SEGMENT, apiPath } from '../../shared/api-paths';

export function signAsset(secret: string, storeId: string, assetId: string): string {
  return createHmac('sha256', secret)
    .update(`asset-url:v1:${storeId}:${assetId.toLowerCase()}`)
    .digest('base64url');
}

export function verifyAssetSignature(
  secret: string,
  storeId: string,
  assetId: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signAsset(secret, storeId, assetId));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(expected, given);
}

/** Admin-route URLs saved before signed URLs existed: `<origin>/api/<v>/<ADMIN_SEGMENT>/assets/<uuid>/content`. */
const LEGACY_ASSET_URL = new RegExp(
  `(https?://[^"\\\\/\\s]+)/api/([^/"\\\\]+)/${ADMIN_SEGMENT}/assets/([0-9a-fA-F-]{36})/content`,
  'g',
);

/**
 * Re-point legacy admin-route asset URLs inside a configuration at the signed public route, so configs
 * saved earlier open without a stored-data migration. Returns the input untouched when there is nothing
 * to rewrite.
 */
export function upgradeLegacyAssetUrls<T>(config: T, secret: string | null, storeId: string): T {
  if (!secret || config === null || config === undefined) return config;
  const text = JSON.stringify(config);
  if (!text.includes(`/${ADMIN_SEGMENT}/assets/`)) return config;
  const rewritten = text.replace(
    LEGACY_ASSET_URL,
    (_match, origin: string, version: string, id: string) =>
      `${origin}${apiPath(version, STOREFRONT_SEGMENT)}/assets/${id}?sig=${signAsset(secret, storeId, id)}`,
  );
  return JSON.parse(rewritten) as T;
}
