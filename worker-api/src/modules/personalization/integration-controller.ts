/**
 * Server-to-server integration endpoint: `POST /events` (integration routes) receives the signed
 * `order.confirmed` events from ZenBasket (contract v1).
 *
 * The callback is unauthenticated by Bearer token on purpose: its authentication IS the HMAC signature
 * over the exact request body, keyed by the order-webhook key derived from the plugin-level secret
 * (`ZB_PLUGIN_SECRET`, see modules/zenbasket-auth). One secret serves every store, so the signature proves
 * "ZenBasket sent this" and NOTHING about which store: the store id in the body is untrusted until the
 * signature has verified, and is then checked against the stores this Worker knows before anything is
 * linked. A merchant JWT is never accepted here.
 */

import type { Context } from 'hono';
import type { AppEnv } from '../../shared/context';
import {
  ApiError,
  BadRequestError,
  PayloadTooLargeError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../shared/errors';
import type { RateLimiter } from '../../shared/rate-limit';
import { StoreSettingsRepository } from '../store-settings/repository';
import { deriveWebhookKey } from '../zenbasket-auth/plugin-secret';
import { checkTimestamp, signatureMatches } from '../zenbasket-auth/webhook-signature';
import { OrderCallbackService, type OrderEvent } from './order-callback-service';
import { MAX_CALLBACK_BODY_BYTES, ORDER_EVENT_TYPE_CONFIRMED, orderEventSchema } from './validation';

/** Object entries sorted by key, absent values dropped; `null` when nothing is left. */
function sortedEntries(value: object | undefined): Array<[string, unknown]> | null {
  if (!value) return null;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length > 0 ? entries : null;
}

/**
 * Hash of the event's MEANING (not its bytes), so a harmless re-serialization (key order, whitespace,
 * line order) still counts as a repeat of the same event.
 *
 * The optional order/line details are appended ONLY when present: an event in the original id-only
 * shape canonicalizes to exactly the string it always did, so replays of events stored before those
 * fields existed still match their stored hash. Any difference in a detail is a different payload
 * (`409 event_id_reused` under the same eventId).
 */
async function canonicalHash(event: OrderEvent): Promise<string> {
  const lines = [...event.lines]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((l) => {
      const base: unknown[] = [
        l.id, l.productId, l.variantId ?? null, l.quantity ?? null,
        Object.entries(l.extensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ];
      if (l.title !== undefined || l.sku !== undefined || l.unitPrice !== undefined) {
        base.push([l.title ?? null, l.sku ?? null, l.unitPrice ?? null]);
      }
      return base;
    });
  const { id: _id, ...details } = event.order;
  const canonical: unknown[] = [
    event.contract, event.type, event.storeId, event.order.id, event.occurredAt, lines,
  ];
  const orderDetails = [
    details.number ?? null, details.placedAt ?? null, details.currency ?? null,
    sortedEntries(details.totals), sortedEntries(details.customer),
    sortedEntries(details.shippingAddress), sortedEntries(details.billingAddress),
  ];
  if (orderDetails.some((v) => v !== null)) canonical.push(orderDetails);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function orderEvents(limiter: RateLimiter) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const config = c.get('config');
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const decision = await limiter.check(`cb:${ip}`, config.orderCallbackRateLimit, config.storefrontRateWindowSeconds);
    if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);

    // Fail closed: with no usable plugin secret nothing can be verified. 503 (not 401) so the sender
    // treats it as retryable once the operator has fixed the environment.
    if (!config.zbPluginSecret) {
      c.get('logger').error('order callbacks are not configured', { missing: 'ZB_PLUGIN_SECRET' });
      throw new ServiceUnavailableError('integrations_not_configured', 'Order callbacks are not configured on this environment.');
    }

    // Read the EXACT bytes that were signed, bounded before and after reading.
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > MAX_CALLBACK_BODY_BYTES) throw new PayloadTooLargeError();
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > MAX_CALLBACK_BODY_BYTES) throw new PayloadTooLargeError();

    // `X-ZB-Key-Id` belonged to the per-store scheme and is ignored: there is one secret, nothing to look up.
    const timestamp = c.req.header('x-zb-timestamp')?.trim();
    const signature = c.req.header('x-zb-signature')?.trim() ?? '';
    if (!timestamp || !signature) {
      throw new UnauthorizedError('X-ZB-Timestamp and X-ZB-Signature are required.');
    }
    if (!checkTimestamp(timestamp, Date.now(), config.orderCallbackToleranceSeconds).ok) {
      throw new ApiError(401, 'invalid_timestamp', 'The request timestamp is missing or outside the accepted window.');
    }

    const key = await deriveWebhookKey(config.zbPluginSecret);
    if (!signatureMatches(key, timestamp, raw, signature)) {
      throw new UnauthorizedError('The signature is not valid.');
    }

    // Only now is the body trusted enough to parse.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestError('The request body must be valid JSON.');
    }
    const event = orderEventSchema.parse(parsed);

    if (event.type !== ORDER_EVENT_TYPE_CONFIRMED) {
      throw new ApiError(422, 'unsupported_event_type', `Only "${ORDER_EVENT_TYPE_CONFIRMED}" events are accepted.`);
    }

    // The signature authenticates ZenBasket, not the store. A signed event for a store this Worker has
    // never served (or that the platform has since told it about, once lifecycle events exist) must not
    // create order links. The Worker keeps no install state of its own, so "known" is the only
    // distinction it can honestly make; see docs/zenbasket-integration.md (store authorization).
    if (!(await new StoreSettingsRepository(c.get('db')).exists(event.storeId))) {
      throw new ApiError(403, 'store_not_authorized', 'The store in the event is not registered for this plugin.');
    }

    const result = await new OrderCallbackService({
      db: c.get('db'),
      logger: c.get('logger'),
      requestId: c.get('requestId'),
    }).confirm({
      storeId: event.storeId,
      event,
      payloadSha256: await canonicalHash(event),
    });
    // The receiver response is part of the platform contract (section 7), so it is not wrapped in `data`.
    return c.json({ contract: 1, eventId: result.eventId, duplicate: result.duplicate, results: result.results, requestId: c.get('requestId') });
  };
}
