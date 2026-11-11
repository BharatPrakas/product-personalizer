import { Service } from '@angular/core';
import type { ProductConfig } from '../customizer/models/product.models';
import {
  MerchantCustomization,
  OrderDetail,
  OrderFileMissingError,
  OrderNotFoundError,
  OrderPage,
} from './order.models';
import { OrderRepository } from './order-repository';

/** Browser-only workspace: there is no order webhook, so there are never any orders. */
@Service()
export class LocalOrderRepository extends OrderRepository {
  available(): boolean {
    return false;
  }

  async list(): Promise<OrderPage> {
    return { items: [], nextCursor: null };
  }

  async get(): Promise<OrderDetail> {
    throw new OrderNotFoundError();
  }

  async customization(): Promise<MerchantCustomization> {
    throw new OrderNotFoundError();
  }

  async file(): Promise<Blob> {
    throw new OrderFileMissingError();
  }

  async configVersion(): Promise<ProductConfig | null> {
    return null;
  }
}
