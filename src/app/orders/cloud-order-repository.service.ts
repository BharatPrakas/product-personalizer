import { Service, inject } from '@angular/core';
import type { ProductConfig } from '../customizer/models/product.models';
import { ApiClient, ApiClientError } from '../workspace/cloud/api-client.service';
import {
  MerchantCustomization,
  OrderDetail,
  OrderFileMissingError,
  OrderListFilter,
  OrderNotFoundError,
  OrderPage,
  OrderSummary,
} from './order.models';
import { OrderRepository } from './order-repository';

const PAGE_SIZE = 25;

/** Orders from the personalization API, scoped to the token's store by the API itself. */
@Service()
export class CloudOrderRepository extends OrderRepository {
  private readonly api = inject(ApiClient);
  /** Template versions are immutable, so a successful read is kept for the session. */
  private readonly versions = new Map<string, Promise<ProductConfig | null>>();

  available(): boolean {
    return true;
  }

  async list(filter: OrderListFilter, cursor?: string | null): Promise<OrderPage> {
    const res = await this.api.get<OrderSummary[]>('/orders', {
      q: filter.q?.trim() || undefined,
      productId: filter.productId?.trim() || undefined,
      from: filter.from,
      to: filter.to,
      limit: PAGE_SIZE,
      cursor: cursor ?? undefined,
    });
    const page = res.meta?.pagination as { hasMore?: boolean; nextCursor?: string | null } | undefined;
    return { items: res.data, nextCursor: page?.hasMore && page.nextCursor ? page.nextCursor : null };
  }

  async get(orderId: string): Promise<OrderDetail> {
    try {
      return (await this.api.get<OrderDetail>(`/orders/${encodeURIComponent(orderId)}`)).data;
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) throw new OrderNotFoundError();
      throw error;
    }
  }

  async customization(customizationId: string): Promise<MerchantCustomization> {
    try {
      return (await this.api.get<MerchantCustomization>(`/customizations/${encodeURIComponent(customizationId)}`)).data;
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) throw new OrderNotFoundError();
      throw error;
    }
  }

  async file(customizationId: string, assetId: string, signal?: AbortSignal): Promise<Blob> {
    try {
      return await this.api.getBlob(
        `/customizations/${encodeURIComponent(customizationId)}/assets/${encodeURIComponent(assetId)}/content`,
        signal,
      );
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) throw new OrderFileMissingError();
      throw error;
    }
  }

  configVersion(configId: string, version: number): Promise<ProductConfig | null> {
    const key = `${configId}@${version}`;
    let pending = this.versions.get(key);
    if (!pending) {
      pending = this.readVersion(configId, version);
      this.versions.set(key, pending);
      // A failure (network, not found) is not cached: the next detail view tries again.
      pending.then((v) => v ?? this.versions.delete(key), () => this.versions.delete(key));
    }
    return pending;
  }

  private async readVersion(configId: string, version: number): Promise<ProductConfig | null> {
    try {
      const summaries = (await this.api.listVersions(configId)).data;
      const match = summaries.find((v) => v.version === version);
      if (!match) return null;
      return (await this.api.getVersion(configId, match.versionId)).data.snapshot;
    } catch {
      // Labels fall back to the raw field ids; the order itself is still shown.
      return null;
    }
  }
}
