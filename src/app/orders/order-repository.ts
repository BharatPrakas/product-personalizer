import type { ProductConfig } from '../customizer/models/product.models';
import type { MerchantCustomization, OrderDetail, OrderListFilter, OrderPage } from './order.models';

/**
 * Where orders come from. Orders only exist on the personalization API (they are created by the
 * platform's signed order webhook), so the browser-only workspace has none: `available()` is false
 * and the page explains that orders need the connected backend.
 *
 * Failures reject with `OrderNotFoundError` / `OrderFileMissingError` for the expected cases and
 * `ApiClientError` otherwise.
 */
export abstract class OrderRepository {
  abstract available(): boolean;
  abstract list(filter: OrderListFilter, cursor?: string | null): Promise<OrderPage>;
  abstract get(orderId: string): Promise<OrderDetail>;
  /** The full saved design of one line. */
  abstract customization(customizationId: string): Promise<MerchantCustomization>;
  /** One stored file's bytes. */
  abstract file(customizationId: string, assetId: string, signal?: AbortSignal): Promise<Blob>;
  /** The template version a design was made with, or null when it can no longer be read. */
  abstract configVersion(configId: string, version: number): Promise<ProductConfig | null>;
}
