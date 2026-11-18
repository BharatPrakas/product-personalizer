/**
 * HTTP handlers for customizations.
 *
 * Shopper routes are PUBLIC (no token of any kind): every one is addressed to a store by `?storeId=`, must
 * name a known store, is rate-limited per store + client IP, and answers `Access-Control-Allow-Origin: *`
 * without credentials. Responses are not cacheable, except the customized image. Error responses carry the
 * same CORS headers, so the storefront can read the error code.
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
import { etagMatches, publicCorsHeaders } from './storefront-controller';
import {
  MAX_CUSTOMIZATION_DATA_BYTES,
  STORE_KEY_PATTERN,
  completeUploadSchema,
  createCustomizationSchema,
  customerInitiateUploadSchema,
  customerStoreQuerySchema,
  customerUploadQuerySchema,
  customizationListQuerySchema,
  updateCustomizationSchema,
} from './validation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Room for the asset list and envelope on top of the data limit. */
const MAX_JSON_BODY_BYTES = MAX_CUSTOMIZATION_DATA_BYTES + 64 * 1024;

const CACHE_IMAGE = 'public, max-age=86400, immutable';
/** A page shows several customized images, so image reads get a proportionally larger budget. */
const IMAGE_LIMIT_FACTOR = 5;

const clientIp = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? 'unknown';

function serviceFor(c: Context<AppEnv>): CustomizationService {
  const config = c.get('config');
  return new CustomizationService({
    db: c.get('db'),
    storage: () => createObjectStorage(c.env, config),
    config,
    logger: c.get('logger'),
    publicOrigin: new URL(c.req.url).origin,
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
 * Shared pipeline for shopper routes: validate the store key, rate-limit, resolve the (known) store, run
 * the handler, and make sure success AND error responses carry CORS headers.
 */
function shopperRoute(
  limiter: RateLimiter,
  options: { write: boolean; bucket?: 'image' },
  handler: (c: Context<AppEnv>, req: ShopperRequest) => Promise<Response>,
) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const cors = publicCorsHeaders();
    try {
      const { storeId } = customerStoreQuerySchema.parse(c.req.query());
      const config = c.get('config');
      const limit = options.write
        ? config.storefrontWriteRateLimit
        : config.storefrontRateLimit * (options.bucket === 'image' ? IMAGE_LIMIT_FACTOR : 1);
      const keyPart = STORE_KEY_PATTERN.test(storeId) ? storeId : 'invalid';
      const bucket = options.bucket ?? (options.write ? 'w' : 'r');
      const decision = await limiter.check(`cz:${bucket}:${keyPart}:${clientIp(c)}`, limit, config.storefrontRateWindowSeconds);
      if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);

      const store = await storefrontFor(c).resolveStore(storeId);
      // Unknown, disabled and malformed store keys are indistinguishable.
      if (!store) throw new NotFoundError('That store was not found.');
      return applyHeaders(await handler(c, { store, service: serviceFor(c) }), cors);
    } catch (error) {
      return applyHeaders(await onError(error as Error, c), cors);
    }
  };
}

/** `POST /uploads/url` — declare a file, get a presigned PUT for one private staging object. */
export const initiateCustomerUpload = (limiter: RateLimiter) =>
  shopperRoute(limiter, { write: true }, async (c, { store, service }) => {
    const body = customerInitiateUploadSchema.parse(await readJson(c));
    const initiated = await service.initiateUpload(store, body);
    // A presigned URL is a bearer capability: never cacheable.
    return created(c, initiated);
  });

/** `POST /uploads/complete` — verify the uploaded object and create the unattached asset. */
export const completeCustomerUpload = (limiter: RateLimiter) =>
  shopperRoute(limiter, { write: true }, async (c, { store, service }) => {
    const body = completeUploadSchema.parse(await readJson(c));
    return ok(c, await service.completeUpload(store, body.uploadId));
  });

export const uploadCustomerAsset = (limiter: RateLimiter) =>
  shopperRoute(limiter, { write: true }, async (c, { store, service }) => {
    if (!c.get('config').legacyProxyUploads) {
      throw new ApiError(410, 'legacy_upload_disabled', 'Proxied uploads are disabled. Use the direct upload flow.');
    }
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

export const updateCustomization = (limiter: RateLimiter) =>
  shopperRoute(limiter, { write: true }, async (c, { store, service }) => {
    const body = updateCustomizationSchema.parse(await readJson(c));
    const saved = await service.update(store, uuidParam(c, 'id'), {
      data: body.data as Record<string, unknown>,
      assets: body.assets,
    });
    return ok(c, saved);
  });

/**
 * `GET /customization-images/:assetId` — the customized image, for `<img src>` on any page. Only an attached
 * `preview` of the named store is served (everything else is 404), always with the type the bytes were
 * sniffed as at upload. The URL changes with every new preview, so the response is immutable.
 */
export const getCustomizationImage = (limiter: RateLimiter) =>
  shopperRoute(limiter, { write: false, bucket: 'image' }, async (c, { store, service }) => {
    const asset = await service.findPublicImage(store, uuidParam(c, 'assetId'));
    const headers = new Headers({
      'Content-Type': asset.content_type,
      'Cache-Control': CACHE_IMAGE,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    // The stored SHA-256 identifies the bytes, so a conditional hit never touches object storage.
    if (asset.checksum_sha256) {
      const etag = `"${asset.checksum_sha256}"`;
      headers.set('ETag', etag);
      if (etagMatches(c.req.header('if-none-match'), etag)) return new Response(null, { status: 304, headers });
    }
    const { object } = await service.openPublicImage(asset);
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { status: 200, headers });
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

export async function getCustomizationAssetUrl(c: Context<AppEnv>): Promise<Response> {
  const result = await serviceFor(c).getAssetUrlForMerchant(
    c.get('tenant').storeId,
    uuidParam(c, 'id'),
    uuidParam(c, 'assetId'),
  );
  const res = ok(c, result);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
