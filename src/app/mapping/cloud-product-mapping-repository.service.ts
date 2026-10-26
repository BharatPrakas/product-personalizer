import { Service, inject } from '@angular/core';
import type { ProductMapping } from '../customizer/models/admin-element-contract';
import { ApiClient, ApiClientError } from '../workspace/cloud/api-client.service';
import {
  BulkMappingInput,
  BulkMappingResult,
  ExistingMapping,
  MappingConflictError,
  MappingInvalidError,
  MappingScope,
  MappingTarget,
  validateTarget,
} from './mapping.models';
import { MappingFilter, ProductMappingRepository } from './product-mapping-repository';

interface ConflictDetails {
  existing?: ExistingMapping;
  scope?: MappingScope;
  externalId?: string;
}

/** Mappings kept by the personalization API (PostgreSQL, scoped to the token's store). */
@Service()
export class CloudProductMappingRepository extends ProductMappingRepository {
  private readonly api = inject(ApiClient);

  async list(filter: MappingFilter = {}): Promise<ProductMapping[]> {
    const all: ProductMapping[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.guard(() =>
        this.api.get<ProductMapping[]>('/mappings', {
          configId: filter.configId,
          scope: filter.scope,
          externalId: filter.externalId,
          limit: 200,
          cursor,
        }),
      );
      all.push(...res.data);
      const page = res.meta?.pagination as
        { hasMore?: boolean; nextCursor?: string | null } | undefined;
      cursor = page?.hasMore && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
    return all;
  }

  async create(
    input: MappingTarget & { configId: string; reassign?: boolean },
  ): Promise<ProductMapping> {
    validateTarget(input);
    const res = await this.guard(
      () =>
        this.api.post<ProductMapping>('/mappings', {
          configId: input.configId,
          scope: input.scope,
          externalId: input.externalId,
          label: input.label ?? undefined,
          reassign: input.reassign === true ? true : undefined,
        }),
      input,
    );
    return res.data;
  }

  async update(
    id: string,
    patch: { configId?: string; label?: string | null; reassign?: boolean },
  ): Promise<ProductMapping> {
    const res = await this.guard(() =>
      this.api.put<ProductMapping>(`/mappings/${encodeURIComponent(id)}`, patch),
    );
    return res.data;
  }

  async delete(id: string): Promise<void> {
    await this.guard(() => this.api.remove(`/mappings/${encodeURIComponent(id)}`));
  }

  async bulk(input: BulkMappingInput): Promise<BulkMappingResult> {
    (input.create ?? []).forEach(validateTarget);
    const res = await this.guard(() => this.api.post<BulkMappingResult>('/mappings/bulk', input));
    return res.data;
  }

  /** The API removes a template's mappings together with the template (foreign key cascade). */
  async deleteForConfig(): Promise<number> {
    return 0;
  }

  private async guard<T>(fn: () => Promise<T>, target?: MappingTarget): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.status === 409 && error.code === 'mapping_conflict') {
          const d = (error.details ?? {}) as ConflictDetails;
          if (d.existing) {
            throw new MappingConflictError(
              d.scope ?? target?.scope ?? 'product',
              d.externalId ?? target?.externalId ?? '',
              d.existing,
            );
          }
        }
        if (error.status === 422 || error.status === 400)
          throw new MappingInvalidError(error.message);
      }
      throw error;
    }
  }
}
