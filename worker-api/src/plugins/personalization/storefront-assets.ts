/**
 * Asset-reference mapping for the PUBLIC storefront config. This is the ONE place that decides what a
 * stored asset reference means and what the storefront serves instead.
 *
 * How references look in stored (draft / published) config JSON:
 *   - the authorized Worker delivery URL   `<origin>/api/<v>/plugins/personalization/assets/<uuid>/content`
 *   - an R2 custom-domain URL              `<ASSET_PUBLIC_BASE_URL>/<object key>`
 *   - any other absolute http(s) URL       (host/CDN hosted; passed through untouched)
 *   - a path relative to `assetBaseUrl`    (resolved against it when that is absolute)
 *   - `idb:` / `data:` / other schemes     (browser-local; can NEVER be served)
 *
 * The storefront rewrites every Worker-managed reference to
 * `<origin>/api/<v>/storefront/personalization/assets/<uuid>` — an absolute URL on the Worker's own
 * origin that needs no merchant token — and refuses to serve a config that still holds a reference it
 * cannot make absolute http(s), or one pointing at an asset of ANOTHER store (it is simply not in the
 * store-scoped index). Reference-carrying keys are `src`, `thumbnail` and `thumbnailSrc`, which covers
 * mockups, overlays, fixed-image layers, fonts and artwork choices in schema v2.
 */

import type { ProductConfigLike } from './types';

export const ASSET_REFERENCE_KEYS: ReadonlySet<string> = new Set(['src', 'thumbnail', 'thumbnailSrc']);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ADMIN_ASSET_PATH = new RegExp(`^/api/[^/]+/plugins/personalization/assets/(${UUID})/content$`, 'i');
const STOREFRONT_ASSET_PATH = new RegExp(`^/api/[^/]+/storefront/personalization/assets/(${UUID})$`, 'i');
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;
const MAX_URL_LENGTH = 2048;

export interface AssetUrlOptions {
  /** API version segment used to build the public asset URL, e.g. `v1`. */
  apiVersion: string;
  /** R2 custom-domain base (no trailing slash), when configured. */
  assetPublicBaseUrl: string | null;
}

export type ReferenceClass =
  /** A Worker-managed asset, identified by its row id. */
  | { kind: 'asset-id'; id: string }
  /** A Worker-managed asset, identified by its R2 object key (public-base URLs). */
  | { kind: 'asset-key'; key: string }
  /** An absolute http(s) URL hosted elsewhere; kept as is. */
  | { kind: 'external'; url: string }
  /** Cannot be turned into an absolute http(s) URL (idb:, data:, relative without a base, ...). */
  | { kind: 'unresolved'; reason: string };

/** Classify one stored reference. Pure; `assetBaseUrl` is the config's own (possibly relative) base. */
export function classifyReference(
  value: string,
  assetBaseUrl: string | undefined,
  opts: AssetUrlOptions,
): ReferenceClass {
  if (value.length === 0 || value.length > MAX_URL_LENGTH || value !== value.trim() || FORBIDDEN_CHARS.test(value)) {
    return { kind: 'unresolved', reason: 'invalid-url' };
  }

  let url: URL;
  const scheme = SCHEME.exec(value);
  if (scheme) {
    if (!/^https?:$/i.test(scheme[0])) return { kind: 'unresolved', reason: 'unsupported-protocol' };
    try {
      url = new URL(value);
    } catch {
      return { kind: 'unresolved', reason: 'invalid-url' };
    }
  } else {
    // Relative reference: only resolvable against an ABSOLUTE http(s) asset base.
    if (value.startsWith('//')) return { kind: 'unresolved', reason: 'protocol-relative' };
    let base: URL;
    try {
      base = new URL(assetBaseUrl ?? '');
    } catch {
      return { kind: 'unresolved', reason: 'relative-without-absolute-base' };
    }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') {
      return { kind: 'unresolved', reason: 'relative-without-absolute-base' };
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    try {
      url = new URL(value, base);
    } catch {
      return { kind: 'unresolved', reason: 'invalid-url' };
    }
  }
  if (url.username || url.password) return { kind: 'unresolved', reason: 'credentials-in-url' };

  const adminMatch = ADMIN_ASSET_PATH.exec(url.pathname) ?? STOREFRONT_ASSET_PATH.exec(url.pathname);
  if (adminMatch) return { kind: 'asset-id', id: adminMatch[1].toLowerCase() };

  if (opts.assetPublicBaseUrl) {
    try {
      const base = new URL(opts.assetPublicBaseUrl);
      const prefix = base.pathname.replace(/\/+$/, '') + '/';
      if (url.origin === base.origin && url.pathname.startsWith(prefix)) {
        return { kind: 'asset-key', key: decodeURIComponent(url.pathname.slice(prefix.length)) };
      }
    } catch {
      // A malformed base or percent-encoding just means "not one of ours".
    }
  }
  return { kind: 'external', url: scheme ? value : url.href };
}

/** Visit every reference-carrying string in the config (deep). */
function walk(value: unknown, visit: (key: string, text: string) => string | void, replace: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, visit, replace));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (ASSET_REFERENCE_KEYS.has(key) && typeof item === 'string') {
        const result = visit(key, item);
        out[key] = replace && typeof result === 'string' ? result : item;
      } else {
        out[key] = walk(item, visit, replace);
      }
    }
    return out;
  }
  return value;
}

function assetBaseOf(config: ProductConfigLike): string | undefined {
  return typeof config['assetBaseUrl'] === 'string' ? config['assetBaseUrl'] : undefined;
}

export interface AssetLocators {
  ids: Set<string>;
  keys: Set<string>;
}

/** Which Worker-managed assets does this config reference? (Input to the store-scoped DB lookup.) */
export function collectAssetLocators(config: ProductConfigLike, opts: AssetUrlOptions): AssetLocators {
  const found: AssetLocators = { ids: new Set(), keys: new Set() };
  const base = assetBaseOf(config);
  walk(
    config,
    (_key, text) => {
      const ref = classifyReference(text, base, opts);
      if (ref.kind === 'asset-id') found.ids.add(ref.id);
      else if (ref.kind === 'asset-key') found.keys.add(ref.key);
    },
    false,
  );
  return found;
}

/** Assets of THIS store that may be served publicly. Anything not listed is treated as unresolved. */
export interface AssetIndex {
  /** Row ids. */
  ids: ReadonlySet<string>;
  /** object_key -> row id. */
  idByKey: ReadonlyMap<string, string>;
}

export interface RewriteOptions extends AssetUrlOptions {
  /** The Worker's public origin, e.g. `https://api.example.com` (no trailing slash). */
  publicOrigin: string;
}

export interface RewriteResult {
  config: ProductConfigLike;
  /** References that could not be made absolute http(s) on a permitted host. Non-empty = do not serve. */
  unresolved: string[];
}

export function storefrontAssetUrl(opts: RewriteOptions, assetId: string): string {
  return `${opts.publicOrigin}/api/${opts.apiVersion}/storefront/personalization/assets/${assetId}`;
}

/**
 * Rewrite every asset reference to an absolute http(s) URL. Worker-managed assets known to `index`
 * become public storefront asset URLs; external absolute URLs are kept; everything else is reported
 * in `unresolved`. The input is not mutated. `assetBaseUrl` is dropped from the result because every
 * reference is now absolute (the strict v2 validator treats it as optional).
 */
export function rewriteAssetReferences(
  config: ProductConfigLike,
  index: AssetIndex,
  opts: RewriteOptions,
): RewriteResult {
  const unresolved: string[] = [];
  const base = assetBaseOf(config);
  const rewritten = walk(
    config,
    (_key, text) => {
      const ref = classifyReference(text, base, opts);
      switch (ref.kind) {
        case 'external':
          return ref.url;
        case 'asset-id':
          if (index.ids.has(ref.id)) return storefrontAssetUrl(opts, ref.id);
          break;
        case 'asset-key': {
          const id = index.idByKey.get(ref.key);
          if (id) return storefrontAssetUrl(opts, id);
          break;
        }
        case 'unresolved':
          break;
      }
      unresolved.push(text.length > 80 ? `${text.slice(0, 77)}...` : text);
      return undefined;
    },
    true,
  ) as ProductConfigLike;
  delete rewritten['assetBaseUrl'];
  return { config: rewritten, unresolved };
}
