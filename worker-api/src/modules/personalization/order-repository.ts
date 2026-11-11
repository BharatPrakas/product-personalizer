/**
 * SQL for the merchant Orders view: order links grouped by order, the optional order details, and the
 * customizations / files behind each line. Every query takes an explicit store id; nothing here trusts
 * an id from a request on its own.
 */

import { chunkForParamLimit, type Database } from '../../database/connection';
import type { CustomizationStatus, CustomerAssetKind } from './customization-repository';
import type { OrderCursor } from './pagination';

export interface OrderListRow {
  order_id: string;
  linked_at: string;
  line_count: number;
  order_number: string | null;
  placed_at: string | null;
  customer_name: string | null;
}

export interface OrderDetailsRow {
  order_number: string | null;
  placed_at: string | null;
  currency: string | null;
  totals: string | null;
  customer: string | null;
  shipping_address: string | null;
  billing_address: string | null;
}

export interface OrderLineRow {
  order_id: string;
  line_id: string;
  product_external_id: string;
  variant_external_id: string | null;
  quantity: number | null;
  line_title: string | null;
  line_sku: string | null;
  unit_price: string | null;
  linked_at: string;
  customization_id: string;
  customization_status: CustomizationStatus;
  config_version: number;
  client_config_id: string;
}

export interface OrderAssetRow {
  id: string;
  customization_id: string;
  kind: CustomerAssetKind;
  original_filename: string | null;
  content_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
}

export interface OrderListFilter {
  q?: string;
  productId?: string;
  /** Inclusive lower bound, ISO UTC. */
  from?: string;
  /** Exclusive upper bound, ISO UTC. */
  toExclusive?: string;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

const LINE_COLS = `ol.external_order_id AS order_id, ol.external_line_id AS line_id, ol.product_external_id,
  ol.variant_external_id, ol.quantity, ol.line_title, ol.line_sku, ol.unit_price, ol.created_at AS linked_at,
  ol.customization_id, c.status AS customization_status, c.config_version, cfg.client_config_id`;
const LINE_FROM = `order_links ol
  JOIN customizations c ON c.id = ol.customization_id AND c.store_id = ol.store_id
  JOIN configs cfg ON cfg.id = c.config_id AND cfg.store_id = c.store_id`;

export class OrderRepository {
  constructor(private readonly db: Database) {}

  /**
   * One row per order with at least one linked line, newest first by when the order was first linked
   * (stable: later lines of the same order never move it). The list carries only the order number,
   * dates and the customer's NAME — email, phone and addresses are detail-only.
   */
  async list(storeId: string, filter: OrderListFilter, cursor: OrderCursor | null, limit: number): Promise<OrderListRow[]> {
    const params: unknown[] = [storeId];
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = ['ol.store_id = $1'];
    const having: string[] = [];
    if (filter.q) {
      const exact = p(filter.q);
      const prefix = p(`${escapeLike(filter.q)}%`);
      where.push(`(ol.external_order_id = ${exact} OR od.order_number = ${exact}
        OR ol.external_order_id LIKE ${prefix} ESCAPE '\\' OR od.order_number LIKE ${prefix} ESCAPE '\\')`);
    }
    if (filter.productId) {
      where.push(`ol.external_order_id IN (SELECT external_order_id FROM order_links
                                             WHERE store_id = $1 AND product_external_id = ${p(filter.productId)})`);
    }
    // Date filters use when the order was placed, falling back to when it was linked.
    if (filter.from) having.push(`COALESCE(od.placed_at, MIN(ol.created_at)) >= ${p(filter.from)}`);
    if (filter.toExclusive) having.push(`COALESCE(od.placed_at, MIN(ol.created_at)) < ${p(filter.toExclusive)}`);
    if (cursor) {
      having.push(`(MIN(ol.created_at), ol.external_order_id) < (${p(cursor.linkedAt)}, ${p(cursor.orderId)})`);
    }
    const { rows } = await this.db.query<OrderListRow>(
      `SELECT ol.external_order_id AS order_id, MIN(ol.created_at) AS linked_at, COUNT(*) AS line_count,
              od.order_number, od.placed_at, json_extract(od.customer, '$.name') AS customer_name
         FROM order_links ol
         LEFT JOIN order_details od
           ON od.store_id = ol.store_id AND od.external_order_id = ol.external_order_id
        WHERE ${where.join(' AND ')}
        GROUP BY ol.external_order_id
        ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
        ORDER BY linked_at DESC, order_id DESC
        LIMIT ${p(limit + 1)}`,
      params,
    );
    return rows;
  }

  async details(storeId: string, orderId: string): Promise<OrderDetailsRow | null> {
    const { rows } = await this.db.query<OrderDetailsRow>(
      `SELECT order_number, placed_at, currency, totals, customer, shipping_address, billing_address
         FROM order_details WHERE store_id = $1 AND external_order_id = $2`,
      [storeId, orderId],
    );
    return rows[0] ?? null;
  }

  /** The linked lines of the given orders, each with its customization's status and template version. */
  async lines(storeId: string, orderIds: readonly string[]): Promise<OrderLineRow[]> {
    const out: OrderLineRow[] = [];
    for (const chunk of chunkForParamLimit(orderIds, 1)) {
      const { rows } = await this.db.query<OrderLineRow>(
        `SELECT ${LINE_COLS} FROM ${LINE_FROM}
          WHERE ol.store_id = $1 AND ol.external_order_id IN (${chunk.map((_, i) => `$${i + 2}`).join(', ')})
          ORDER BY ol.created_at, ol.external_line_id`,
        [storeId, ...chunk],
      );
      out.push(...rows);
    }
    return out;
  }

  /** Attached files of the given customizations, optionally of one kind only. */
  async assets(storeId: string, customizationIds: readonly string[], kind?: CustomerAssetKind): Promise<OrderAssetRow[]> {
    const out: OrderAssetRow[] = [];
    for (const chunk of chunkForParamLimit(customizationIds, 1, 2)) {
      const params: unknown[] = [storeId, ...chunk];
      const kindClause = kind ? ` AND kind = $${params.push(kind)}` : '';
      const { rows } = await this.db.query<OrderAssetRow>(
        `SELECT id, customization_id, kind, original_filename, content_type, size_bytes, width, height
           FROM customization_assets
          WHERE store_id = $1 AND status = 'attached'
            AND customization_id IN (${chunk.map((_, i) => `$${i + 2}`).join(', ')})${kindClause}
          ORDER BY created_at, id`,
        params,
      );
      out.push(...rows);
    }
    return out;
  }
}
