/**
 * PUBLIC storefront handlers (no merchant token). Responsibilities kept here: per-store + client-IP
 * rate limiting, public CORS, strong ETag / conditional requests and cache headers. Business
 * resolution lives in `StorefrontService`.
 *
 * Responses intentionally omit `requestId` from the JSON body: the body must be byte-stable across
 * requests so the ETag and shared caches work. The request id is still returned in `X-Request-Id`.
 */

import type { Context } from 'hono';
import { createObjectStorage } from '../../storage';
import type { AppEnv } from '../../shared/context';
import { BadRequestError, NotFoundError, RateLimitError } from '../../shared/errors';
import type { RateLimiter } from '../../shared/rate-limit';
import { StorefrontService } from './storefront-service';
import { MAX_COLLECTION_IDS, STORE_KEY_PATTERN, storefrontConfigQuerySchema } from './validation';

const CACHE_PERSONALIZABLE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
const CACHE_NOT_PERSONALIZABLE = 'public, max-age=10, s-maxage=30, stale-while-revalidate=60';
const CACHE_ASSET = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';
/** One page load fetches many assets, so asset reads get a proportionally larger budget. */
const ASSET_LIMIT_FACTOR = 5;

function serviceFor(c: Context<AppEnv>): StorefrontService {
  const config = c.get('config');
  return new StorefrontService({
    db: c.get('db'),
    storage: () => createObjectStorage(c.env, config),
    config,
    logger: c.get('logger'),
    publicOrigin: new URL(c.req.url).origin,
  });
}

/**
 * CORS for every public storefront response. The routes are anonymous and credential-free, so any origin
 * may read them: `*` is never combined with credentials, and nothing here varies by caller.
 */
export function publicCorsHeaders(): Headers {
  return new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'ETag, X-Request-Id',
  });
}

async function strongEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `"${hex}"`;
}

/** `If-None-Match` comparison: weak comparison per RFC 9110, `*` matches any current representation. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((part) => part.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === etag);
}

async function enforceRateLimit(
  c: Context<AppEnv>,
  limiter: RateLimiter,
  key: string,
  factor = 1,
): Promise<void> {
  const config = c.get('config');
  const decision = await limiter.check(key, config.storefrontRateLimit * factor, config.storefrontRateWindowSeconds);
  if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
}

const clientIp = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? 'unknown';

function parseCollectionIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
  if (ids.length > MAX_COLLECTION_IDS) {
    throw new BadRequestError(`collectionIds accepts at most ${MAX_COLLECTION_IDS} ids.`);
  }
  if (ids.some((id) => id.length > 200)) throw new BadRequestError('A collection id is too long.');
  return ids;
}

/** Shared tail: ETag, conditional 304, cache + CORS headers. */
async function conditionalJson(
  c: Context<AppEnv>,
  payload: unknown,
  cacheControl: string,
  cors: Headers,
): Promise<Response> {
  const body = JSON.stringify({ data: payload });
  const etag = await strongEtag(body);
  const headers = new Headers(cors);
  headers.set('ETag', etag);
  headers.set('Cache-Control', cacheControl);
  if (etagMatches(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set('Content-Type', 'application/json; charset=UTF-8');
  return new Response(body, { status: 200, headers });
}

export function getProductConfig(limiter: RateLimiter) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const query = storefrontConfigQuerySchema.parse(c.req.query());
    const externalId = c.req.param('externalId');
    if (!externalId || externalId.length > 200) throw new BadRequestError('Invalid product id.');
    const collectionIds = parseCollectionIds(query.collectionIds);

    // Limit BEFORE any database work; keyed by the claimed store key + client IP.
    const keyPart = STORE_KEY_PATTERN.test(query.storeId) ? query.storeId : 'invalid';
    await enforceRateLimit(c, limiter, `cfg:${keyPart}:${clientIp(c)}`);

    const service = serviceFor(c);
    const store = await service.resolveStore(query.storeId);
    const cors = publicCorsHeaders();
    if (!store) {
      return conditionalJson(c, { personalizable: false }, CACHE_NOT_PERSONALIZABLE, cors);
    }
    const payload = await service.resolveConfig(store, {
      externalId,
      variantId: query.variantId ?? null,
      collectionIds,
    });
    return conditionalJson(
      c,
      payload,
      payload.personalizable ? CACHE_PERSONALIZABLE : CACHE_NOT_PERSONALIZABLE,
      cors,
    );
  };
}

export function getPublicAsset(limiter: RateLimiter) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    await enforceRateLimit(c, limiter, `asset:${clientIp(c)}`, ASSET_LIMIT_FACTOR);
    const service = serviceFor(c);
    const resolved = await service.resolveAsset(c.req.param('assetId') ?? '', c.req.query('sig') ?? null);
    if (!resolved) throw new NotFoundError('That asset was not found.');
    const { asset, signed } = resolved;

    const headers = publicCorsHeaders();
    // A signed URL can expose a draft asset, so keep it out of shared caches.
    headers.set('Cache-Control', signed ? 'private, max-age=3600' : CACHE_ASSET);
    headers.set('X-Content-Type-Options', 'nosniff');
    // Images/fonts are embedded by third-party storefront pages and drawn onto canvases.
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

    // The stored SHA-256 identifies the bytes, so a conditional hit never touches object storage.
    if (asset.checksum_sha256) {
      const etag = `"${asset.checksum_sha256}"`;
      headers.set('ETag', etag);
      if (etagMatches(c.req.header('if-none-match'), etag)) {
        return new Response(null, { status: 304, headers });
      }
    }
    const object = await service.openAsset(asset);
    if (!object) throw new NotFoundError('That asset was not found.');
    if (!asset.checksum_sha256) headers.set('ETag', object.etag);
    headers.set('Content-Type', asset.content_type);
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { status: 200, headers });
  };
}

/** CORS preflight for every public route. Answers 204 for any origin; rate limited like the routes themselves. */
export function preflight(limiter: RateLimiter) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    await enforceRateLimit(c, limiter, `pre:${clientIp(c)}`);
    const headers = publicCorsHeaders();
    headers.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
    headers.set('Access-Control-Max-Age', '600');
    return new Response(null, { status: 204, headers });
  };
}
