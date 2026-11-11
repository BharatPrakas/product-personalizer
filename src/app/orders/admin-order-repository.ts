import { Service, inject } from '@angular/core';
import { AdminEvents } from '../admin/admin-events.service';
import { toAdminError } from '../admin/admin-errors';
import type { ProductConfig } from '../customizer/models/product.models';
import { RuntimeConfig } from '../workspace/cloud/runtime-config';
import { CloudOrderRepository } from './cloud-order-repository.service';
import { LocalOrderRepository } from './local-order-repository.service';
import {
  MerchantCustomization,
  OrderDetail,
  OrderFileMissingError,
  OrderListFilter,
  OrderNotFoundError,
  OrderPage,
} from './order.models';
import { OrderRepository } from './order-repository';

/**
 * Chooses browser or cloud per call and reports unexpected failures as `admin-error` (whose
 * messages are fixed strings: no order or customer data ever reaches the host through events).
 */
@Service()
export class AdminOrderRepository extends OrderRepository {
  private readonly local = inject(LocalOrderRepository);
  private readonly cloud = inject(CloudOrderRepository);
  private readonly runtime = inject(RuntimeConfig);
  private readonly events = inject(AdminEvents);

  private inner(): OrderRepository {
    return this.runtime.useCloud() ? this.cloud : this.local;
  }

  private async run<T>(fn: (repo: OrderRepository) => Promise<T>): Promise<T> {
    try {
      return await fn(this.inner());
    } catch (error) {
      const expected =
        error instanceof OrderNotFoundError ||
        error instanceof OrderFileMissingError ||
        (error instanceof DOMException && error.name === 'AbortError');
      if (!expected) this.events.error(toAdminError(error));
      throw error;
    }
  }

  available(): boolean {
    return this.inner().available();
  }

  list(filter: OrderListFilter, cursor?: string | null): Promise<OrderPage> {
    return this.run((r) => r.list(filter, cursor));
  }

  get(orderId: string): Promise<OrderDetail> {
    return this.run((r) => r.get(orderId));
  }

  customization(customizationId: string): Promise<MerchantCustomization> {
    return this.run((r) => r.customization(customizationId));
  }

  file(customizationId: string, assetId: string, signal?: AbortSignal): Promise<Blob> {
    return this.run((r) => r.file(customizationId, assetId, signal));
  }

  configVersion(configId: string, version: number): Promise<ProductConfig | null> {
    return this.inner().configVersion(configId, version);
  }
}
