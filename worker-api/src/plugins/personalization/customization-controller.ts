/**
 * HTTP handlers for customizations.
 *
 * Shopper routes are PUBLIC (no merchant token): every one is addressed to a store by `?storeId=`, is
 * rate-limited per store + client IP, and answers CORS from that store's own origin allow-list. Writes
 * additionally refuse a browser Origin the store has not allowed. Responses are never cacheable.
 * Error responses carry the same CORS headers, so the storefront can read the error code.
 *
 * Merchant routes are authenticated and always scoped to the token's store.
 */

import type { Context } from 'hono';
import { createObjectStorage } from '../../storage';
import type { AppEnv } from '../../shared/context';
import { ApiError, BadRequestError, NotFoundError, PayloadTooLargeError, RateLimitError } from '../../shared/errors';
import type { RateLimiter } from '../../shared/rate-limit';
import { onError } from '../../middleware/error-handler';
import { ok, created } from '../../shared/responses';
import { CustomizationService } from './customization-service';
import { StorefrontService, type ResolvedStore } from './storefront-service';
import { storefrontCorsHeaders } from './storefront-controller';
import {
  MAX_CUSTOMIZATION_DATA_BYTES,
  STORE_KEY_PATTERN,
  createCustomizationSchema,
  customerStoreQuerySchema,
  customerUploadQuerySchema,
  customizationListQuerySchema,
  updateCustomizationSchema,
} from './validation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Room for the asset list and envelope on top of the data limit. */
const MAX_JSON_BODY_BYTES = MAX_CUSTOMIZATION_DATA_BYTES + 64 * 1024;

const clientIp = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? 'unknown';

function serviceFor(c: Context<AppEnv>): CustomizationService {
  const config = c.get('config');
  return new CustomizationService({
    db: c.get('db'),
    storage: () => createObjectStorage(c.env, config),
    config,
    logger: c.get('logger'),
  });
}

function storefrontFor(c: Context<AppEnv>): StorefrontService {
  const config = c.get('config');
  return new StorefrontService({
    db: c.get('db'),
    storage: () => createObjectStorage(c.env, config),
    config,
    logger: c.get('logger'),
    publicOrigin: new URL(c.req.url).origin,
  });
}

function uuidParam(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  // A malformed id can never exist: 404, and it never reaches Postgres as a bad uuid.
  if (!value || !UUID.test(value)) throw new NotFoundError();
  return value.toLowerCase();
}

function bearerToken(c: Context<AppEnv>): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim() ?? '');
  return match ? match[1].trim() : null;
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) throw new PayloadTooLargeError();
  const text = await c.req.text();
  if (text.length > MAX_JSON_BODY_BYTES) throw new PayloadTooLargeError();
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError('The request body must be valid JSON.');
  }
}

function applyHeaders(res: Response, extra: Headers): Response {
  for (const [name, value] of extra) {
    if (name.toLowerCase() === 'vary') res.headers.append('Vary', value);
    else res.headers.set(name, value);
  }
  if (!res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'no-store');
  return res;
}

interface ShopperRequest {
  store: ResolvedStore;
  service: CustomizationService;
}

/**
 * Shared pipeline for shopper routes: validate the store key, rate-limit, resolve the store and its
 * CORS policy, run the handler, and make sure success AND error responses carry CORS headers.
 */
function shopperRoute(
  limiter: RateLimiter,
  options: { write: boolean },
  handler: (c: Context<AppEnv>, req: ShopperRequest) => Promise<Response>,
) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    let cors = new Headers({ Vary: 'Origin' });
    try {
      const { storeId } = customerStoreQuerySchema.parse(c.req.query());
      const config = c.get('config');
      const limit = options.write ? config.storefrontWriteRateLimit : config.storefrontRateLimit;
      const keyPart = STORE_KEY_PATTERN.test(storeId) ? storeId : 'invalid';
      const decision = await limiter.check(
        `cz:${options.write ? 'w' : 'r'}:${keyPart}:${clientIp(c)}`,
        limit,
        config.storefrontRateWindowSeconds,
      );
      if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);

      const store = await storefrontFor(c).resolveStore(storeId);
      cors = storefrontCorsHeaders(c.req.header('origin'), store);
      // Unknown, disabled and malformed store keys are indistinguishable.
      if (!store) throw new NotFoundError('That store was not found.');
      const origin = c.req.header('origin');
      if (options.write && origin && !store.allowedOrigins.includes(origin.toLowerCase())) {
        throw new ApiError(403, 'origin_not_allowed', 'This origin is not allowed to save customizations for this store.');
      }
      return applyHeaders(await handler(c, { store, service: serviceFor(c) }), cors);
    } catch (error) {
      return applyHeaders(await onError(error as Error, c), cors);
    }
  };
}

export const uploadCustomerAsset = (limiter: RateLimiter) =>
  shopperRoute(limiter, { write: true }, async (c, { store, service }) => {
    const query = customerUploadQuerySchema.parse(c.req.query());
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > c.get('config').maxUploadBytes) {
      throw new PayloadTooLargeError(`Files can be at most ${c.get('config').maxUploadBytes} bytes.`);
    }
    const asset = await service.uploadAsset(store, {
      bytes: await c.req.arrayBuffer(),
      kind: query.kind,
      filename: query.filename,
    });
    return created(c, asset);
  });

export const createCustomization = (limiter: RateLimiter) =>
  shopperRoute(limiter, { write: true }, async (c, { store, service }) => {
    const body = createCustomizationSchema.parse(await readJson(c));
    const saved = await service.create(store, {
      ...body,
      data: body.data as Record<string, unknown>,
    });
    return created(c, saved);
  });

export const getCustomizationForShopper = (limiter: RateLimiter) =>
  shopperRoute(limiter, { write: false }, async (c, { store, service }) =>
    ok(c, await service.getForShopper(store, uuidParam(c, 'id'), bearerToken(c))),
  );

export const updateCustomization = (limiter: RateLimiter) =>
  shopperRoute(limiter, { write: true }, async (c, { store, service }) => {
    const body = updateCustomizationSchema.parse(await readJson(c));
    const saved = await service.update(store, uuidParam(c, 'id'), bearerToken(c), {
      data: body.data as Record<string, unknown>,
      assets: body.assets,
    });
    return ok(c, saved);
  });

export const getCustomizationAssetForShopper = (limiter: RateLimiter) =>
  shopperRoute(limiter, { write: false }, async (c, { store, service }) => {
    const { object, contentType, checksum } = await service.getAssetForShopper(
      store,
      uuidParam(c, 'id'),
      uuidParam(c, 'assetId'),
      bearerToken(c),
    );
    return privateFile(object, contentType, checksum);
  });

function privateFile(
  object: { body: ReadableStream; size: number },
  contentType: string,
  checksum: string | null,
): Response {
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Length': String(object.size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (checksum) headers.set('X-Checksum-Sha256', checksum);
  return new Response(object.body, { status: 200, headers });
}

/** CORS preflight for the shopper routes. Only an allowed origin of a known store gets ACAO headers. */
export function customerPreflight(limiter: RateLimiter) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const config = c.get('config');
    const decision = await limiter.check(`pre:${clientIp(c)}`, config.storefrontRateLimit, config.storefrontRateWindowSeconds);
    if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
    const key = c.req.query('storeId');
    const store = key ? await storefrontFor(c).resolveStore(key) : null;
    const headers = storefrontCorsHeaders(c.req.header('origin'), store);
    if (headers.has('Access-Control-Allow-Origin')) {
      headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
      headers.set('Access-Control-Allow-Headers', c.req.header('access-control-request-headers') ?? 'Authorization,Content-Type');
      headers.set('Access-Control-Max-Age', '600');
    }
    headers.append('Vary', 'Access-Control-Request-Headers');
    return new Response(null, { status: 204, headers });
  };
}

// ---- merchant (authenticated, store-scoped) ----

export async function listCustomizations(c: Context<AppEnv>): Promise<Response> {
  const query = customizationListQuerySchema.parse(c.req.query());
  const { items, page } = await serviceFor(c).listForMerchant(c.get('tenant').storeId, query);
  return ok(c, items, 200, { page });
}

export async function getCustomization(c: Context<AppEnv>): Promise<Response> {
  return ok(c, await serviceFor(c).getForMerchant(c.get('tenant').storeId, uuidParam(c, 'id')));
}

export async function getCustomizationAssetContent(c: Context<AppEnv>): Promise<Response> {
  const { object, contentType, checksum } = await serviceFor(c).getAssetForMerchant(
    c.get('tenant').storeId,
    uuidParam(c, 'id'),
    uuidParam(c, 'assetId'),
  );
  return privateFile(object, contentType, checksum);
}
