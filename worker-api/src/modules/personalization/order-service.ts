/**
 * Merchant Orders view (authenticated, store-scoped): the orders that carry personalized lines, with the
 * optional order/customer details the `order.confirmed` webhook stored (contract v1 section 7,
 * [proposed – optional]).
 *
 * Everything the platform did not send is `null` — never invented, never fetched from the platform.
 * The list exposes only the order number, dates and customer name; email, phone and addresses are in
 * the single-order response only. Full customization data and file bytes stay on the existing
 * `/customizations/:id` and `/customizations/:id/assets/:assetId/content` endpoints.
 */

import type { Database } from '../../database/connection';
import { NotFoundError } from '../../shared/errors';
import type { CustomerAssetKind, CustomizationStatus } from './customization-repository';
import { decodeOrderCursor, encodeOrderCursor } from './pagination';
import { OrderRepository, type OrderAssetRow, type OrderLineRow } from './order-repository';
import type { CursorPageMeta } from './types';

/** Lines summarised per order in the list; `lineCount` is always the full count. */
const LIST_LINES_PER_ORDER = 10;

export interface OrderTotalsDto {
  subtotal: string | null;
  shipping: string | null;
  tax: string | null;
  discount: string | null;
  total: string | null;
}

export interface OrderCustomerDto {
  id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface OrderAddressDto {
  name: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
}

export interface OrderListLineDto {
  lineId: string;
  productId: string;
  title: string | null;
  quantity: number | null;
  status: CustomizationStatus;
  customizationId: string;
  /** First preview image of the line, for a thumbnail; fetch through the customization asset endpoint. */
  previewAssetId: string | null;
}

export interface OrderSummaryDto {
  orderId: string;
  orderNumber: string | null;
  placedAt: string | null;
  customerName: string | null;
  /** When the first line of this order was linked. */
  linkedAt: string;
  lineCount: number;
  lines: OrderListLineDto[];
}

export interface OrderAssetDto {
  assetId: string;
  kind: CustomerAssetKind;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  /** What the storefront named the file (a printable area / mockup / local asset id), if anything. */
  filename: string | null;
}

export interface OrderLineDto {
  lineId: string;
  productId: string;
  variantId: string | null;
  quantity: number | null;
  title: string | null;
  sku: string | null;
  unitPrice: string | null;
  linkedAt: string;
  customization: { id: string; status: CustomizationStatus; configId: string; configVersion: number };
  assets: OrderAssetDto[];
}

export interface OrderDto {
  orderId: string;
  orderNumber: string | null;
  placedAt: string | null;
  currency: string | null;
  totals: OrderTotalsDto;
  customer: OrderCustomerDto;
  shippingAddress: OrderAddressDto | null;
  billingAddress: OrderAddressDto | null;
  linkedAt: string;
  lines: OrderLineDto[];
}

const iso = (v: string) => new Date(v).toISOString();

function parseObject(text: string | null): Record<string, unknown> {
  if (!text) return {};
  const value = JSON.parse(text) as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Every listed key, as a string or `null` — so a missing field is always an explicit null. */
function pick<K extends string>(source: Record<string, unknown>, keys: readonly K[]): Record<K, string | null> {
  return Object.fromEntries(
    keys.map((k) => [k, typeof source[k] === 'string' ? (source[k] as string) : null]),
  ) as Record<K, string | null>;
}

const TOTAL_KEYS = ['subtotal', 'shipping', 'tax', 'discount', 'total'] as const;
const CUSTOMER_KEYS = ['id', 'name', 'email', 'phone'] as const;
const ADDRESS_KEYS = ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country', 'phone'] as const;

function toAssetDto(row: OrderAssetRow): OrderAssetDto {
  return {
    assetId: row.id,
    kind: row.kind,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    filename: row.original_filename,
  };
}

/** `from` (inclusive) / `to` (inclusive) from the query -> ISO bounds. A bare date is a whole UTC day. */
export function dateBounds(from?: string, to?: string): { from?: string; toExclusive?: string } {
  const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const out: { from?: string; toExclusive?: string } = {};
  if (from) out.from = isDate(from) ? `${from}T00:00:00.000Z` : new Date(from).toISOString();
  if (to) {
    const end = isDate(to) ? Date.parse(`${to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000 : Date.parse(to) + 1;
    out.toExclusive = new Date(end).toISOString();
  }
  return out;
}

export class OrderService {
  private readonly repo: OrderRepository;

  constructor(db: Database) {
    this.repo = new OrderRepository(db);
  }

  async list(
    storeId: string,
    query: { q?: string; productId?: string; from?: string; to?: string; limit: number; cursor?: string },
  ): Promise<{ items: OrderSummaryDto[]; page: CursorPageMeta }> {
    const rows = await this.repo.list(
      storeId,
      { q: query.q, productId: query.productId, ...dateBounds(query.from, query.to) },
      decodeOrderCursor(query.cursor),
      query.limit,
    );
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;

    const lines = await this.repo.lines(storeId, pageRows.map((r) => r.order_id));
    const byOrder = new Map<string, OrderLineRow[]>();
    for (const line of lines) {
      const list = byOrder.get(line.order_id) ?? [];
      if (list.length < LIST_LINES_PER_ORDER) list.push(line);
      byOrder.set(line.order_id, list);
    }
    const shown = [...byOrder.values()].flat();
    const previews = await this.repo.assets(storeId, [...new Set(shown.map((l) => l.customization_id))], 'preview');
    const firstPreview = new Map<string, string>();
    for (const asset of previews) {
      if (!firstPreview.has(asset.customization_id)) firstPreview.set(asset.customization_id, asset.id);
    }

    const items = pageRows.map<OrderSummaryDto>((r) => ({
      orderId: r.order_id,
      orderNumber: r.order_number,
      placedAt: r.placed_at ? iso(r.placed_at) : null,
      customerName: typeof r.customer_name === 'string' ? r.customer_name : null,
      linkedAt: iso(r.linked_at),
      lineCount: Number(r.line_count),
      lines: (byOrder.get(r.order_id) ?? []).map((l) => ({
        lineId: l.line_id,
        productId: l.product_external_id,
        title: l.line_title,
        quantity: l.quantity,
        status: l.customization_status,
        customizationId: l.customization_id,
        previewAssetId: firstPreview.get(l.customization_id) ?? null,
      })),
    }));
    const last = pageRows[pageRows.length - 1];
    return {
      items,
      page: {
        limit: query.limit,
        hasMore,
        nextCursor: hasMore && last ? encodeOrderCursor({ linkedAt: last.linked_at, orderId: last.order_id }) : null,
      },
    };
  }

  async get(storeId: string, orderId: string): Promise<OrderDto> {
    const lines = await this.repo.lines(storeId, [orderId]);
    // An order is known to this store only through its own links; another store's order is a plain 404.
    if (lines.length === 0) throw new NotFoundError('That order was not found.');
    const [details, assets] = await Promise.all([
      this.repo.details(storeId, orderId),
      this.repo.assets(storeId, lines.map((l) => l.customization_id)),
    ]);
    const assetsOf = new Map<string, OrderAssetDto[]>();
    for (const a of assets) assetsOf.set(a.customization_id, [...(assetsOf.get(a.customization_id) ?? []), toAssetDto(a)]);

    const address = (text: string | null) => (text ? pick(parseObject(text), ADDRESS_KEYS) : null);
    return {
      orderId,
      orderNumber: details?.order_number ?? null,
      placedAt: details?.placed_at ? iso(details.placed_at) : null,
      currency: details?.currency ?? null,
      totals: pick(parseObject(details?.totals ?? null), TOTAL_KEYS),
      customer: pick(parseObject(details?.customer ?? null), CUSTOMER_KEYS),
      shippingAddress: address(details?.shipping_address ?? null),
      billingAddress: address(details?.billing_address ?? null),
      linkedAt: iso(lines.reduce((min, l) => (l.linked_at < min ? l.linked_at : min), lines[0].linked_at)),
      lines: lines.map((l) => ({
        lineId: l.line_id,
        productId: l.product_external_id,
        variantId: l.variant_external_id,
        quantity: l.quantity,
        title: l.line_title,
        sku: l.line_sku,
        unitPrice: l.unit_price,
        linkedAt: iso(l.linked_at),
        customization: {
          id: l.customization_id,
          status: l.customization_status,
          configId: l.client_config_id,
          configVersion: l.config_version,
        },
        assets: assetsOf.get(l.customization_id) ?? [],
      })),
    };
  }
}
