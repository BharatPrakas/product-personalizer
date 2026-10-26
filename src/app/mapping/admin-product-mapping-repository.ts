import { Service, inject } from '@angular/core';
import { AdminEvents } from '../admin/admin-events.service';
import { AdminHost } from '../admin/admin-host.service';
import { ReadOnlyError, toAdminError } from '../admin/admin-errors';
import type { ProductMapping } from '../customizer/models/admin-element-contract';
import { RuntimeConfig } from '../workspace/cloud/runtime-config';
import { CloudProductMappingRepository } from './cloud-product-mapping-repository.service';
import { LocalProductMappingRepository } from './local-product-mapping-repository.service';
import {
  BulkMappingInput,
  BulkMappingResult,
  MappingConflictError,
  MappingTarget,
} from './mapping.models';
import { MappingFilter, ProductMappingRepository } from './product-mapping-repository';

/** Chooses browser or cloud per call, enforces `readonly`, and emits `mapping-changed`. */
@Service()
export class AdminProductMappingRepository extends ProductMappingRepository {
  private readonly local = inject(LocalProductMappingRepository);
  private readonly cloud = inject(CloudProductMappingRepository);
  private readonly runtime = inject(RuntimeConfig);
  private readonly host = inject(AdminHost);
  private readonly events = inject(AdminEvents);

  private inner(): ProductMappingRepository {
    return this.runtime.useCloud() ? this.cloud : this.local;
  }

  private async run<T>(
    write: boolean,
    fn: (repo: ProductMappingRepository) => Promise<T>,
  ): Promise<T> {
    try {
      if (write && this.host.readonly()) throw new ReadOnlyError();
      return await fn(this.inner());
    } catch (error) {
      // A conflict is an expected, user-resolved outcome, not an element error.
      if (!(error instanceof MappingConflictError)) this.events.error(toAdminError(error));
      throw error;
    }
  }

  list(filter?: MappingFilter): Promise<ProductMapping[]> {
    return this.run(false, (r) => r.list(filter));
  }

  async create(
    input: MappingTarget & { configId: string; reassign?: boolean },
  ): Promise<ProductMapping> {
    const before = input.reassign ? await this.safeFind(input) : null;
    const mapping = await this.run(true, (r) => r.create(input));
    this.events.mappingChanged({
      action: before && before.configId !== input.configId ? 'reassigned' : 'created',
      configId: input.configId,
      mappings: [mapping],
      deletedIds: [],
    });
    return mapping;
  }

  async update(
    id: string,
    patch: { configId?: string; label?: string | null; reassign?: boolean },
  ): Promise<ProductMapping> {
    const mapping = await this.run(true, (r) => r.update(id, patch));
    this.events.mappingChanged({
      action: 'updated',
      configId: mapping.configId,
      mappings: [mapping],
      deletedIds: [],
    });
    return mapping;
  }

  async delete(id: string): Promise<void> {
    await this.run(true, (r) => r.delete(id));
    this.events.mappingChanged({
      action: 'deleted',
      configId: null,
      mappings: [],
      deletedIds: [id],
    });
  }

  async bulk(input: BulkMappingInput): Promise<BulkMappingResult> {
    const result = await this.run(true, (r) => r.bulk(input));
    this.events.mappingChanged({
      action: 'bulk',
      configId: input.configId,
      mappings: [...result.created, ...result.reassigned],
      deletedIds: result.deleted > 0 ? [...(input.deleteIds ?? [])] : [],
    });
    return result;
  }

  async deleteForConfig(configId: string): Promise<number> {
    const removed = await this.run(true, (r) => r.deleteForConfig(configId));
    if (removed > 0) {
      this.events.mappingChanged({ action: 'bulk', configId, mappings: [], deletedIds: [] });
    }
    return removed;
  }

  private async safeFind(target: MappingTarget): Promise<ProductMapping | null> {
    try {
      const found = await this.inner().list({ scope: target.scope, externalId: target.externalId });
      return found[0] ?? null;
    } catch {
      return null;
    }
  }
}
