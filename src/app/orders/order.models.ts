/**
 * The merchant Orders view: what the personalization API returns for `GET /orders`,
 * `GET /orders/:orderId` and `GET /customizations/:id` (worker-api `order-service.ts` /
 * `customization-service.ts`).
 *
 * Order and customer details are optional in the order webhook (contract v1 section 7,
 * [proposed – optional]); everything the store did not send is `null` and shown as
 * "Not provided by the store". They are customer personal data: never log them and never put them
 * in `admin-error` events.
 */

export type OrderLineStatus = 'saved' | 'ordered' | 'expired';
export type OrderAssetKind = 'upload' | 'preview' | 'artwork';

export interface OrderListLine {
  lineId: string;
  productId: string;
  title: string | null;
  quantity: number | null;
  status: OrderLineStatus;
  customizationId: string;
  previewAssetId: string | null;
}

export interface OrderSummary {
  orderId: string;
  orderNumber: string | null;
  placedAt: string | null;
  customerName: string | null;
  linkedAt: string;
  lineCount: number;
  lines: OrderListLine[];
}

export interface OrderTotals {
  subtotal: string | null;
  shipping: string | null;
  tax: string | null;
  discount: string | null;
  total: string | null;
}

export interface OrderCustomer {
  id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface OrderAddress {
  name: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
}

export interface OrderAsset {
  assetId: string;
  kind: OrderAssetKind;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  /** What the storefront named the file: printable area id, mockup id or local upload id. */
  filename: string | null;
}

export interface OrderLine {
  lineId: string;
  productId: string;
  variantId: string | null;
  quantity: number | null;
  title: string | null;
  sku: string | null;
  /** Decimal string in the order currency, e.g. "12.50". */
  unitPrice: string | null;
  linkedAt: string;
  customization: { id: string; status: OrderLineStatus; configId: string; configVersion: number };
  assets: OrderAsset[];
}

export interface OrderDetail {
  orderId: string;
  orderNumber: string | null;
  placedAt: string | null;
  currency: string | null;
  totals: OrderTotals;
  customer: OrderCustomer;
  shippingAddress: OrderAddress | null;
  billingAddress: OrderAddress | null;
  linkedAt: string;
  lines: OrderLine[];
}

/** `GET /customizations/:id` — the full saved design. `data` is whatever the storefront saved. */
export interface MerchantCustomization {
  id: string;
  status: OrderLineStatus;
  configId: string;
  configVersion: number;
  productId: string;
  variantId: string | null;
  data?: Record<string, unknown>;
  createdAt: number;
  orderedAt: string | null;
}

export interface OrderListFilter {
  /** Order id or number (exact or prefix). */
  q?: string;
  productId?: string;
  /** ISO date-time bounds, inclusive. */
  from?: string;
  to?: string;
}

export interface OrderPage {
  items: OrderSummary[];
  nextCursor: string | null;
}

export class OrderNotFoundError extends Error {
  constructor() {
    super('That order was not found.');
    this.name = 'OrderNotFoundError';
  }
}

/** The file is gone (deleted, never uploaded, or not attached anymore). */
export class OrderFileMissingError extends Error {
  constructor() {
    super('That file is unavailable.');
    this.name = 'OrderFileMissingError';
  }
}
