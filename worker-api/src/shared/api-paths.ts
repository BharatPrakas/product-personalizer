/**
 * The Worker's public URL contract. The prefixes are stable on purpose: signed asset URLs are stored
 * inside configuration JSON (and cached by CDNs), the element bundles call these paths, and the
 * ZenBasket integration guide documents them. Change them only together with all of those consumers.
 */

export const API_BASE = '/api/v1';

/** Segments after `/api/<version>/` of the three route groups. */
export const ADMIN_SEGMENT = 'plugins/personalization';
export const STOREFRONT_SEGMENT = 'storefront/personalization';
export const INTEGRATIONS_SEGMENT = 'integrations/personalization';

/** `/api/<version>/<segment>`, for URLs the Worker hands out (Location headers, asset delivery URLs). */
export function apiPath(apiVersion: string, segment: string): string {
  return `/api/${apiVersion}/${segment}`;
}
