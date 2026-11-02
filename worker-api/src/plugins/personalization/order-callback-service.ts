/**
 * Order events: links customizations to the ZenBasket order lines they were bought on.
 *
 * One signed event (Extension Platform Contract v1, section 7) may carry several order lines. The
 * whole event is ONE PostgreSQL transaction, and each line runs under its own SAVEPOINT:
 *
 *   1. event dedup      INSERT ... ON CONFLICT DO NOTHING on (store, eventId). A repeat with the same
 *                       payload answers with the STORED per-line results and changes nothing; a repeat
 *                       with a DIFFERENT payload is a 409 (event_id_reused).
 *   2. per line         lock the customization (scoped to the authenticated store) -> product/variant
 *                       check -> existing-link check -> link (ON CONFLICT DO NOTHING, zero rows triggers
 *                       a state re-read, not a blind failure) -> `saved` -> `ordered`.
 *   3. outcome          a line whose business rules fail is `rejected` (its savepoint is rolled back,
 *                       the other lines are unaffected). Anything unexpected (database error, ...)
 *                       aborts the whole transaction so the event can be retried as a unit.
 *   4. record           the per-line results are stored on the event row, so a replay answers identically.
 *
 * Which store, order line and customization are involved is decided from the authenticated credential
 * and our own rows — the payload's `storeId` is only cross-checked against the credential by the controller.
 */

import type { Database, SqlExecutor } from '../../database/connection';
import { runInTransaction } from '../../database/transactions';
import { ApiError, ConflictError, NotFoundError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { recordAudit } from '../../platform/tenant-management/audit';
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
    const result = await runInTransaction(this.ctx.db, (tx) => this.apply(tx, args));
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
    tx: SqlExecutor,
    args: { storeId: string; credentialId: string; event: OrderEvent; payloadSha256: string },
  ): Promise<OrderEventResult> {
    const { storeId, event } = args;

    // 1. Durable event-id deduplication.
    const inserted = await tx.query(
      `INSERT INTO personalization.integration_events
         (store_id, event_id, event_type, payload_sha256, external_order_id, line_count,
          credential_id, occurred_at, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (store_id, event_id) DO NOTHING`,
      [storeId, event.eventId, event.type, args.payloadSha256, event.order.id, event.lines.length,
       args.credentialId, event.occurredAt, this.ctx.requestId],
    );
    if (inserted.rowCount === 0) {
      const { rows } = await tx.query<{ payload_sha256: string; results: LineResult[] | null }>(
        `SELECT payload_sha256, results FROM personalization.integration_events
          WHERE store_id = $1 AND event_id = $2`,
        [storeId, event.eventId],
      );
      const prior = rows[0];
      if (!prior || prior.payload_sha256 !== args.payloadSha256) {
        throw new ConflictError('This eventId was already used with a different payload.', { reason: 'event_id_reused' });
      }
      return { eventId: event.eventId, duplicate: true, results: prior.results ?? [] };
    }

    // 2./3. Every line under its own savepoint.
    const results: LineResult[] = [];
    for (const [index, line] of event.lines.entries()) {
      const savepoint = `line_${index}`;
      await tx.query(`SAVEPOINT ${savepoint}`);
      try {
        results.push(await this.applyLine(tx, storeId, event, line));
        await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status >= 500) throw error;
        await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
        results.push({ lineId: line.id, status: 'rejected', reason: reasonOf(error) });
      }
    }

    // 4. Remember the outcome so a replay answers identically.
    await tx.query(
      `UPDATE personalization.integration_events SET results = $3::jsonb
        WHERE store_id = $1 AND event_id = $2`,
      [storeId, event.eventId, JSON.stringify(results)],
    );
    return { eventId: event.eventId, duplicate: false, results };
  }

  private async applyLine(
    tx: SqlExecutor,
    storeId: string,
    event: OrderEvent,
    line: OrderEventLine,
  ): Promise<LineResult> {
    const now = (this.ctx.now ?? (() => new Date()))();
    const repo = new CustomizationRepository(tx);
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

    // Lock the customization, scoped to the authenticated store (another store's id is a plain 404).
    const row = await repo.getById(storeId, customizationId, true);
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

    // Link it to the order line.
    const linked = await tx.query(
      `INSERT INTO personalization.order_links
         (store_id, customization_id, external_order_id, external_line_id, product_external_id,
          event_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [storeId, row.id, orderId, line.id, row.product_external_id, event.eventId, event.occurredAt],
    );
    if (linked.rowCount === 0) {
      // Zero rows is a signal to look, not a verdict: who holds this order line?
      const { rows } = await tx.query<{ customization_id: string }>(
        `SELECT customization_id FROM personalization.order_links
          WHERE store_id = $1 AND external_order_id = $2 AND external_line_id = $3`,
        [storeId, orderId, line.id],
      );
      if (rows[0]?.customization_id === row.id) return outcome('duplicate');
      throw new ConflictError('That order line is already linked to a different customization.', {
        reason: 'order_line_already_linked',
      });
    }

    // saved -> ordered. Ordered rows no longer expire.
    const updated = await tx.query(
      `UPDATE personalization.customizations
          SET status = 'ordered', ordered_at = $3, expires_at = NULL,
              updated_at_ms = greatest($4::bigint, updated_at_ms + 1), updated_at = now()
        WHERE store_id = $1 AND id = $2 AND status = 'saved'`,
      [storeId, row.id, now, now.getTime()],
    );
    if (updated.rowCount === 0) {
      const current = await repo.getById(storeId, row.id);
      const link = await repo.getOrderLink(storeId, row.id);
      if (current?.status === 'ordered' && link?.external_order_id === orderId && link.external_line_id === line.id) {
        return outcome('duplicate');
      }
      throw new ConflictError('The customization changed state while it was being ordered.', {
        reason: 'customization_not_orderable',
      });
    }
    return outcome('applied');
  }
}
