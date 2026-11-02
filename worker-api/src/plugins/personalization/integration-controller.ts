/**
 * Server-to-server integration endpoints.
 *
 *  - `POST /api/v1/integrations/personalization/events`  signed order events from ZenBasket (contract v1).
 *  - `/plugins/personalization/integration/credentials`         merchant-authenticated credential
 *    management (create / list / rotate / revoke the per-store signing secrets).
 *
 * The callback is unauthenticated by Bearer token on purpose: its authentication IS the HMAC signature
 * over the exact request body. The store is taken from the credential that signed it, never from the
 * body (the body's `storeId` is only cross-checked).
 */

import type { Context } from 'hono';
import type { AppEnv } from '../../shared/context';
import {
  ApiError,
  BadRequestError,
  ForbiddenError,
  PayloadTooLargeError,
  RateLimitError,
  UnauthorizedError,
} from '../../shared/errors';
import { created, noContent, ok } from '../../shared/responses';
import type { RateLimiter } from '../../shared/rate-limit';
import { StorePluginsRepository } from '../../platform/plugin-permissions/repository';
import {
  DEFAULT_ROTATION_GRACE_SECONDS,
  IntegrationCredentialsService,
} from '../../platform/integration-credentials/service';
import { checkTimestamp, signatureMatches } from '../../platform/integration-credentials/signature';
import { recordAudit } from '../../platform/tenant-management/audit';
import { OrderCallbackService, type OrderEvent } from './order-callback-service';
import { PLUGIN_ID } from './types';
import {
  MAX_CALLBACK_BODY_BYTES,
  ORDER_EVENT_TYPE_CONFIRMED,
  credentialCreateSchema,
  credentialRotateSchema,
  orderEventSchema,
} from './validation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function credentialsFor(c: Context<AppEnv>): IntegrationCredentialsService {
  return new IntegrationCredentialsService(c.get('db'), PLUGIN_ID, c.get('config').integrationEncryptionKey);
}

/**
 * Hash of the event's MEANING (not its bytes), so a harmless re-serialization (key order, whitespace,
 * line order) still counts as a repeat of the same event.
 */
async function canonicalHash(event: OrderEvent): Promise<string> {
  const lines = [...event.lines]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((l) => [
      l.id, l.productId, l.variantId ?? null, l.quantity ?? null,
      Object.entries(l.extensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]);
  const canonical = JSON.stringify([
    event.contract, event.type, event.storeId, event.order.id, event.occurredAt, lines,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function orderEvents(limiter: RateLimiter) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const config = c.get('config');
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const decision = await limiter.check(`cb:${ip}`, config.orderCallbackRateLimit, config.storefrontRateWindowSeconds);
    if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);

    // Read the EXACT bytes that were signed, bounded before and after reading.
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > MAX_CALLBACK_BODY_BYTES) throw new PayloadTooLargeError();
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > MAX_CALLBACK_BODY_BYTES) throw new PayloadTooLargeError();

    const keyId = c.req.header('x-zb-key-id')?.trim() ?? '';
    const timestamp = c.req.header('x-zb-timestamp')?.trim();
    const signature = c.req.header('x-zb-signature')?.trim() ?? '';
    if (!UUID.test(keyId) || !timestamp || !signature) {
      throw new UnauthorizedError('X-ZB-Key-Id, X-ZB-Timestamp and X-ZB-Signature are required.');
    }
    if (!checkTimestamp(timestamp, Date.now(), config.orderCallbackToleranceSeconds).ok) {
      throw new ApiError(401, 'invalid_timestamp', 'The request timestamp is missing or outside the accepted window.');
    }

    const credentials = credentialsFor(c);
    const credential = await credentials.resolveForVerification(keyId.toLowerCase());
    // Unknown, revoked, expired and wrongly-signed look identical to the caller.
    if (!credential || !signatureMatches(credential.secret, timestamp, raw, signature)) {
      throw new UnauthorizedError('The signature is not valid.');
    }
    await credentials.markUsed(credential.id).catch(() => undefined);

    // Only now is the body trusted enough to parse.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestError('The request body must be valid JSON.');
    }
    const event = orderEventSchema.parse(parsed);

    if (event.storeId !== credential.storeId) {
      throw new ForbiddenError('The credential does not belong to the store in the event.');
    }
    if (event.type !== ORDER_EVENT_TYPE_CONFIRMED) {
      throw new ApiError(422, 'unsupported_event_type', `Only "${ORDER_EVENT_TYPE_CONFIRMED}" events are accepted.`);
    }
    if (!(await new StorePluginsRepository(c.get('db')).isEnabled(credential.storeId, PLUGIN_ID))) {
      throw new ForbiddenError(`The "${PLUGIN_ID}" plugin is not enabled for this store.`);
    }

    const result = await new OrderCallbackService({
      db: c.get('db'),
      logger: c.get('logger'),
      requestId: c.get('requestId'),
    }).confirm({
      storeId: credential.storeId,
      credentialId: credential.id,
      event,
      payloadSha256: await canonicalHash(event),
    });
    // The receiver response is part of the platform contract (section 7), so it is not wrapped in `data`.
    return c.json({ contract: 1, eventId: result.eventId, duplicate: result.duplicate, results: result.results, requestId: c.get('requestId') });
  };
}

// ---- credential management (merchant-authenticated) ----

/**
 * Managing signing secrets needs the explicit `integrations:manage` scope. A wildcard scope does not
 * count, and the editor's ordinary session never carries it, so the admin UI cannot read or mint them.
 * (The static development token is exempt so the stack can be exercised locally.)
 */
function requireIntegrationAdmin(c: Context<AppEnv>): void {
  const auth = c.get('auth');
  if (auth.tokenType === 'dev' || auth.scopes.includes('integrations:manage')) return;
  throw new ForbiddenError('Missing required scope "integrations:manage".');
}

async function audit(c: Context<AppEnv>, action: string, credentialId: string): Promise<void> {
  const auth = c.get('auth');
  try {
    await recordAudit(c.get('db'), {
      requestId: c.get('requestId'),
      storeId: c.get('tenant').storeId,
      pluginId: PLUGIN_ID,
      actor: auth.subject ?? auth.tokenType,
      action,
      resourceType: 'integration_credential',
      resourceId: credentialId,
    });
  } catch (error) {
    c.get('logger').warn('audit write failed', { action, error: String(error) });
  }
}

/** Responses that carry a secret must never be cached. */
function noStore(res: Response): Response {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

function credentialId(c: Context<AppEnv>): string {
  const id = c.req.param('id');
  if (!id || !UUID.test(id)) throw new ApiError(404, 'not_found', 'That credential was not found.');
  return id.toLowerCase();
}

/** The JSON body, or undefined when there is none. Reads the body rather than trusting Content-Length. */
async function optionalJson(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError('The request body must be valid JSON.');
  }
}

export async function listCredentials(c: Context<AppEnv>): Promise<Response> {
  requireIntegrationAdmin(c);
  return ok(c, await credentialsFor(c).list(c.get('tenant').storeId));
}

export async function createCredential(c: Context<AppEnv>): Promise<Response> {
  requireIntegrationAdmin(c);
  const body = credentialCreateSchema.parse((await optionalJson(c)) ?? {});
  const auth = c.get('auth');
  const issued = await credentialsFor(c).create(c.get('tenant').storeId, body.label, auth.subject ?? auth.tokenType);
  await audit(c, 'integration_credential.create', issued.id);
  return noStore(created(c, issued));
}

export async function rotateCredential(c: Context<AppEnv>): Promise<Response> {
  requireIntegrationAdmin(c);
  const body = credentialRotateSchema.parse((await optionalJson(c)) ?? {});
  const auth = c.get('auth');
  const grace = body.gracePeriodSeconds ?? DEFAULT_ROTATION_GRACE_SECONDS;
  const { credential, previous } = await credentialsFor(c).rotate(
    c.get('tenant').storeId,
    credentialId(c),
    grace,
    auth.subject ?? auth.tokenType,
  );
  await audit(c, 'integration_credential.rotate', previous.id);
  return noStore(ok(c, { credential, previous }, 201));
}

export async function revokeCredential(c: Context<AppEnv>): Promise<Response> {
  requireIntegrationAdmin(c);
  const id = credentialId(c);
  await credentialsFor(c).revoke(c.get('tenant').storeId, id);
  await audit(c, 'integration_credential.revoke', id);
  return noContent(c);
}
