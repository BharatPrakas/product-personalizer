/**
 * Asset URL resolution and policy. Pure functions, no DOM access (callers pass the document base).
 *
 * Policy:
 *  - only http(s) after resolution; executable / inline schemes (`javascript:`, `data:`, `blob:`, `file:` ...) are rejected
 *  - no credentials in URLs
 *  - relative asset paths may not climb out of the asset base with `..`
 *  - optionally restricted to a host-supplied list of origins (the page origin is always allowed)
 */

export interface AssetPolicy {
  /** Origin of the embedding page, e.g. `https://shop.example`. Always allowed. */
  pageOrigin: string;
  /** Extra origins the host allows. Empty means "any http(s) origin". */
  allowedOrigins: readonly string[];
  /**
   * Standalone authoring app only: also accept `idb:<id>` (browser-stored upload) and inline
   * `data:image/` sources. Hosted configurations never need this and the element leaves it off.
   */
  allowLocalAssets?: boolean;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; code: string; message: string };

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;
const MAX_URL_LENGTH = 2048;

const fail = (code: string, message: string): UrlCheck => ({ ok: false, code, message });

/** A browser-stored upload (`idb:<id>`), resolved from IndexedDB by the image service. */
export const LOCAL_ASSET_SCHEME = 'idb:';
const LOCAL_ASSET = /^idb:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_DATA_URL_LENGTH = 12 * 1024 * 1024;

export function isLocalAssetUrl(url: string): boolean {
  return LOCAL_ASSET.test(url);
}

/** `https://CDN.example.com/` -> `https://cdn.example.com`, so host-supplied entries match `URL.origin`. */
function normaliseOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

function isHttp(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function climbsOut(path: string): boolean {
  return path
    .split('/')
    .some((segment) => ['..', '%2e%2e', '.%2e', '%2e.'].includes(segment.toLowerCase()));
}

/** Resolve and vet an asset `src` against an absolute base. */
export function checkAssetSrc(
  src: unknown,
  base: string,
  policy: AssetPolicy,
  options: { allowParentSegments?: boolean } = {},
): UrlCheck {
  if (policy.allowLocalAssets && typeof src === 'string') {
    if (LOCAL_ASSET.test(src)) return { ok: true, url: src };
    if (src.length <= MAX_DATA_URL_LENGTH && DATA_IMAGE.test(src)) return { ok: true, url: src };
  }
  if (typeof src !== 'string' || src.length === 0 || src.length > MAX_URL_LENGTH) {
    return fail('invalid-url', `must be a non-empty URL of at most ${MAX_URL_LENGTH} characters`);
  }
  if (FORBIDDEN_CHARS.test(src)) {
    return fail('invalid-url', 'must not contain control characters or backslashes');
  }
  // URL parsing silently trims surrounding spaces, which would let " ../x" slip past the ".." check.
  if (src !== src.trim()) {
    return fail('invalid-url', 'must not start or end with whitespace');
  }
  const scheme = SCHEME.exec(src);
  if (scheme && !/^https?:$/i.test(scheme[0])) {
    return fail(
      'unsupported-protocol',
      `protocol "${scheme[0]}" is not allowed; use http(s) or a relative path`,
    );
  }
  const isRelativePath = !scheme && !src.startsWith('//');
  if (isRelativePath && !options.allowParentSegments && climbsOut(src.split(/[?#]/)[0])) {
    return fail('path-traversal', 'relative asset paths must not contain ".." segments');
  }

  let url: URL;
  try {
    url = new URL(src, base);
  } catch {
    return fail('invalid-url', 'is not a valid URL');
  }
  if (!isHttp(url)) {
    return fail('unsupported-protocol', `protocol "${url.protocol}" is not allowed`);
  }
  if (url.username || url.password) {
    return fail('credentials-in-url', 'must not contain credentials');
  }
  if (policy.allowedOrigins.length > 0) {
    const allowed = new Set([policy.pageOrigin, ...policy.allowedOrigins].map(normaliseOrigin));
    if (!allowed.has(url.origin)) {
      return fail(
        'origin-not-allowed',
        `origin ${url.origin} is not in the host's allowed asset origins`,
      );
    }
  }
  return { ok: true, url: url.href };
}

/** Vet a URL supplied by the host in `assetMap` (http, https or a host-created blob URL). */
export function checkHostAssetUrl(value: string, documentBase: string): UrlCheck {
  if (FORBIDDEN_CHARS.test(value) || value.length > MAX_URL_LENGTH || value.length === 0) {
    return fail('invalid-url', 'is not a valid URL');
  }
  let url: URL;
  try {
    url = new URL(value, documentBase);
  } catch {
    return fail('invalid-url', 'is not a valid URL');
  }
  if (!isHttp(url) && url.protocol !== 'blob:') {
    return fail('unsupported-protocol', `protocol "${url.protocol}" is not allowed`);
  }
  if (url.username || url.password) {
    return fail('credentials-in-url', 'must not contain credentials');
  }
  return { ok: true, url: url.href };
}

function asDirectory(url: URL): URL {
  const copy = new URL(url.href);
  copy.search = '';
  copy.hash = '';
  if (!copy.pathname.endsWith('/')) copy.pathname += '/';
  return copy;
}

export interface ResolvedBase {
  /** Absolute URL that `assetBaseUrl` is resolved against. */
  base: string;
  /** Absolute directory used when the configuration has no `assetBaseUrl`. */
  defaultAssetDir: string;
  /** Absolute config URL when the configuration came from `configUrl`. */
  configUrl?: string;
}

/**
 * - `configUrl`: resolve it against the document, then resolve `assetBaseUrl` against that absolute URL.
 * - object config: resolve against the explicit `baseUrl`, falling back to the document base.
 */
export function resolveBase(input: {
  configUrl: string | null;
  baseUrl: string | null;
  documentBase: string;
}): ResolvedBase {
  if (input.configUrl) {
    const configUrl = new URL(input.configUrl, input.documentBase);
    return {
      base: configUrl.href,
      defaultAssetDir: new URL('.', configUrl).href,
      configUrl: configUrl.href,
    };
  }
  if (input.baseUrl) {
    // An explicit base URL is always treated as a directory.
    const base = asDirectory(new URL(input.baseUrl, input.documentBase));
    return { base: base.href, defaultAssetDir: base.href };
  }
  return {
    base: input.documentBase,
    defaultAssetDir: new URL('.', input.documentBase).href,
  };
}

/** Absolute, slash-terminated asset directory for `assetBaseUrl` (or the default directory). */
export function resolveAssetDir(
  assetBaseUrl: string | undefined,
  resolved: ResolvedBase,
  policy: AssetPolicy,
): UrlCheck {
  if (assetBaseUrl === undefined) return { ok: true, url: resolved.defaultAssetDir };
  const checked = checkAssetSrc(assetBaseUrl, resolved.base, policy, { allowParentSegments: true });
  if (!checked.ok) return checked;
  return { ok: true, url: asDirectory(new URL(checked.url)).href };
}
