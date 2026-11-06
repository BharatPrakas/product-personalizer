/**
 * Order events: links customizations to the ZenBasket order lines they were bought on.
 *
 * One signed event (Extension Platform Contract v1, section 7) may carry several order lines. D1 has
 * no interactive transaction and no SAVEPOINT, so — unlike the single Postgres transaction this used
 * to run in — each line commits independently as its own tiny atomic `batch()`, and the event overall
 * is driven by `integration_events.status`:
 *
 *   1. event dedup      INSERT ... ON CONFLICT DO NOTHING on (store, eventId), status: 'processing'.
 *                       A repeat with the same eventId while status is still 'processing' (a prior
 *                       attempt crashed mid-event, or this is a genuinely concurrent retry) is safe to
 *                       re-run from line 1: every line below is already conditional/idempotent (its
 *                       own "zero rows is a signal to look, not a verdict" re-read), so re-applying an
 *                       already-applied line is a no-op that resolves to 'duplicate'. Only once status
 *                       is 'completed' does a repeat short-circuit on the STORED `results`. A repeat
 *                       with a different payload is a 409 (event_id_reused).
 *   2. per line         read the customization -> product/variant check -> existing-link check -> one
 *                       atomic batch (link INSERT `ON CONFLICT DO NOTHING` + `saved` -> `ordered`
 *                       UPDATE) -> zero rows from either statement triggers a disambiguating re-read,
 *                       not a blind failure.
 *   3. outcome          a line whose business rules fail is `rejected`; the other lines are
 *                       unaffected (each already committed, or not yet attempted, independently). An
 *                       unexpected (>=500) error stops processing the remaining lines and leaves
 *                       `status` at 'processing', so the next replay resumes rather than redoing
 *                       already-applied lines.
 *   4. record           once every line has been attempted, the results are stored on the event row
 *                       and `status` flips to 'completed', so a replay answers identically.
 *
 * Which store, order line and customization are involved is decided from the authenticated credential
 * and our own rows — the payload's `storeId` is only cross-checked against the credential by the controller.
 */

import type { Database } from '../../database/connection';
import { ApiError, ConflictError, NotFoundError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { recordAudit } from '../audit/audit';
import { CustomizationRepository } from './customization-repository';

export interface OrderEventLine {
  id: string;
  productId: string;
  variantId?: string;
  quantity?: number;
  extensions: Record<string, string>;
}

export interface OrderEvent {
  contract: 1;
  eventId: string;
  type: string;
  occurredAt: string;
  storeId: string;
  order: { id: string };
  lines: OrderEventLine[];
}

export type LineStatus = 'applied' | 'duplicate' | 'rejected';

export interface LineResult {
  lineId: string;
  status: LineStatus;
  /** Machine-readable cause for `rejected`. */
  reason?: string;
  customizationId?: string;
}

export interface OrderEventResult {
  eventId: string;
  /** True when the whole event was already processed: `results` are the stored outcome. */
  duplicate: boolean;
  results: LineResult[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A line failing a business rule is `rejected` with this reason; everything else is not caught here. */
function reasonOf(error: ApiError): string {
  const details = error.details as { reason?: unknown } | undefined;
  if (typeof details?.reason === 'string') return details.reason;
  if (error instanceof NotFoundError) return 'customization_not_found';
  return error.code;
}

export class OrderCallbackService {
  constructor(
    private readonly ctx: { db: Database; logger: Logger; requestId: string; now?: () => Date },
  ) {}

  async confirm(args: {
    /** From the verified credential — the only source of truth for which store is calling. */
    storeId: string;
    credentialId: string;
    event: OrderEvent;
    payloadSha256: string;
  }): Promise<OrderEventResult> {
    const result = await this.apply(args);
    if (!result.duplicate) {
      for (const line of result.results.filter((r) => r.status === 'applied')) {
        try {
          await recordAudit(this.ctx.db, {
            requestId: this.ctx.requestId,
            storeId: args.storeId,
            actor: `integration:${args.credentialId}`,
            action: 'order.link',
            resourceType: 'customization',
            resourceId: line.customizationId,
            metadata: { orderId: args.event.order.id, lineId: line.lineId, eventId: args.event.eventId },
          });
        } catch (error) {
          // Audit must never undo a committed link.
          this.ctx.logger.warn('audit write failed', { action: 'order.link', error: String(error) });
        }
      }
    }
    return result;
  }

  private async apply(
    args: { storeId: string; credentialId: string; event: OrderEvent; payloadSha256: string },
  ): Promise<OrderEventResult> {
    const { db } = this.ctx;
    const { storeId, event } = args;

    // 1. Durable event-id deduplication.
    const inserted = await db.query(
      `INSERT INTO integration_events
         (store_id, event_id, event_type, payload_sha256, external_order_id, line_count,
          credential_id, occurred_at, request_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'processing')
       ON CONFLICT (store_id, event_id) DO NOTHING`,
      [storeId, event.eventId, event.type, args.payloadSha256, event.order.id, event.lines.length,
       args.credentialId, event.occurredAt, this.ctx.requestId],
    );
    if (inserted.rowCount === 0) {
      type EventRow = { payload_sha256: string; status: 'processing' | 'completed'; results: LineResult[] | string | null };
      const readPrior = async (): Promise<EventRow | undefined> => {
        const { rows } = await db.query<EventRow>(
          `SELECT payload_sha256, status, results FROM integration_events
            WHERE store_id = $1 AND event_id = $2`,
          [storeId, event.eventId],
        );
        return rows[0];
      };
      let prior = await readPrior();
      if (!prior || prior.payload_sha256 !== args.payloadSha256) {
        throw new ConflictError('This eventId was already used with a different payload.', { reason: 'event_id_reused' });
      }
      // status === 'processing' means either a genuinely concurrent delivery of the SAME event (the
      // common case — D1 has no transaction to block this request behind the other's, unlike
      // Postgres) or a prior attempt that crashed mid-event. Briefly poll for the former (it normally
      // finishes in milliseconds); only after giving up do we assume the latter and reprocess
      // ourselves — every line below is idempotent, so that reprocessing is always safe, just not
      // always necessary.
      for (let attempt = 0; prior.status === 'processing' && attempt < 25; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const next = await readPrior();
        if (!next) break; // Purged/rolled back somehow; fall through and reprocess.
        prior = next;
      }
      if (prior.status === 'completed') {
        const results = typeof prior.results === 'string' ? JSON.parse(prior.results) : prior.results ?? [];
        return { eventId: event.eventId, duplicate: true, results };
      }
      // Still 'processing' after polling: treat the other attempt as stalled and reprocess ourselves.
    }

    // 2./3. Each line commits independently; a rejected line does not affect the others.
    const results: LineResult[] = [];
    for (const line of event.lines) {
      try {
        results.push(await this.applyLine(db, storeId, event, line));
      } catch (error) {
        if (!(error instanceof ApiError) || error.status >= 500) throw error;
        results.push({ lineId: line.id, status: 'rejected', reason: reasonOf(error) });
      }
    }

    // 4. Remember the outcome so a replay answers identically.
    await db.query(
      `UPDATE integration_events SET results = $3, status = 'completed'
        WHERE store_id = $1 AND event_id = $2`,
      [storeId, event.eventId, JSON.stringify(results)],
    );
    return { eventId: event.eventId, duplicate: false, results };
  }

  private async applyLine(
    db: Database,
    storeId: string,
    event: OrderEvent,
    line: OrderEventLine,
  ): Promise<LineResult> {
    const now = (this.ctx.now ?? (() => new Date()))();
    const repo = new CustomizationRepository(db);
    const orderId = event.order.id;

    const rawId = line.extensions['customizationId'];
    if (rawId === undefined) {
      throw new ApiError(422, 'missing_customization_id', 'The line carries no customizationId.');
    }
    if (!UUID.test(rawId)) {
      throw new ApiError(422, 'invalid_customization_id', 'The customizationId is not valid.');
    }
    const customizationId = rawId.toLowerCase();
    const outcome = (status: LineStatus): LineResult => ({ lineId: line.id, status, customizationId });

    // No row lock: D1 has none, and every write below is conditional with a re-read fallback, so a
    // concurrent attempt on the same customization resolves deterministically either way.
    const row = await repo.getById(storeId, customizationId);
    if (!row) throw new NotFoundError('That customization was not found.');

    // The order must be for the product the shopper customized.
    if (row.product_external_id !== line.productId) {
      throw new ApiError(422, 'product_mismatch', 'The product does not match the customization.');
    }
    if (line.variantId && row.variant_external_id && row.variant_external_id !== line.variantId) {
      throw new ApiError(422, 'variant_mismatch', 'The variant does not match the customization.');
    }

    // Already linked? Same line is an idempotent success; anything else is a conflict.
    const existing = await repo.getOrderLink(storeId, row.id);
    if (existing) {
      if (existing.external_order_id === orderId && existing.external_line_id === line.id) {
        return outcome('duplicate');
      }
      throw new ConflictError('This customization is already linked to a different order line.', {
        reason: 'customization_already_ordered',
      });
    }
    if (row.status === 'expired') {
      throw new ConflictError('This customization expired before it was ordered.', { reason: 'customization_expired' });
    }
    if (row.status !== 'saved') {
      throw new ConflictError(`This customization cannot be ordered from status "${row.status}".`, {
        reason: 'customization_not_orderable',
      });
    }

    // Link it to the order line and flip saved -> ordered as one atomic batch — D1 has no transaction
    // to hold them together otherwise, and an order_link with no matching status flip (or vice versa)
    // would be a real data inconsistency, not a cosmetic one. The UPDATE's WHERE also requires the
    // link to now exist for THIS customization+order+line: if the INSERT lost a conflict (whether on
    // "this customization already has a link" or "this order line already has a different
    // customization"), that EXISTS check fails too, so the status never flips — batch() cannot branch
    // between statements, so the precondition has to be re-expressed in the second statement's WHERE.
    const linkId = crypto.randomUUID();
    const [linkResult, updateResult] = await db.batch([
      {
        text: `INSERT INTO order_links
                 (id, store_id, customization_id, external_order_id, external_line_id, product_external_id,
                  event_id, occurred_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT DO NOTHING`,
        params: [linkId, storeId, row.id, orderId, line.id, row.product_external_id, event.eventId, event.occurredAt],
      },
      {
        text: `UPDATE customizations
                  SET status = 'ordered', ordered_at = $3, expires_at = NULL,
                      updated_at_ms = MAX($4, updated_at_ms + 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE store_id = $1 AND id = $2 AND status = 'saved'
                  AND EXISTS (SELECT 1 FROM order_links
                               WHERE customization_id = $2 AND external_order_id = $5 AND external_line_id = $6)`,
        params: [storeId, row.id, now, now.getTime(), orderId, line.id],
      },
    ]);

    if (linkResult.rowCount === 0) {
      // Zero rows is a signal to look, not a verdict: who holds this order line?
      const { rows } = await db.query<{ customization_id: string }>(
        `SELECT customization_id FROM order_links
          WHERE store_id = $1 AND external_order_id = $2 AND external_line_id = $3`,
        [storeId, orderId, line.id],
      );
      if (rows[0]?.customization_id === row.id) return outcome('duplicate');
      throw new ConflictError('That order line is already linked to a different customization.', {
        reason: 'order_line_already_linked',
      });
    }

    if (updateResult.rowCount === 0) {
      const current = await repo.getById(storeId, row.id);
      const link = await repo.getOrderLink(storeId, row.id);
      if (current?.status === 'ordered' && link?.external_order_id === orderId && link.external_line_id === line.id) {
        return outcome('duplicate');
      }
      throw new ConflictError('The customization changed state while it was being ordered.', {
        reason: 'customization_state_changed',
      });
    }

    return outcome('applied');
  }
}
