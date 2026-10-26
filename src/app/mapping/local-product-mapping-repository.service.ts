import { Service } from '@angular/core';
import { dbDelete, dbGetAll, dbPut } from '../customizer/services/local-db';
import { uuid } from '../customizer/util/ids';
import {
  BulkMappingInput,
  BulkMappingResult,
  MAX_BULK_ITEMS,
  MappingConflictError,
  MappingInvalidError,
  MappingTarget,
  ProductMapping,
  targetKey,
  validateTarget,
} from './mapping.models';
import { MappingFilter, ProductMappingRepository } from './product-mapping-repository';

export const LOCAL_STORE_ID = 'local';

/**
 * Browser-stored mappings. When IndexedDB is unavailable they live in memory for the session
 * (the storage label of the configuration repository already tells the merchant about that).
 */
@Service()
export class LocalProductMappingRepository extends ProductMappingRepository {
  private memory: Map<string, ProductMapping> | null = null;

  private async all(): Promise<ProductMapping[]> {
    if (this.memory) return [...this.memory.values()];
    try {
      return await dbGetAll<ProductMapping>('mappings');
    } catch {
      this.memory = new Map();
      return [];
    }
  }

  private async put(mapping: ProductMapping): Promise<void> {
    if (!this.memory) {
      try {
        await dbPut('mappings', mapping);
        return;
      } catch {
        this.memory = new Map((await this.all()).map((m) => [m.id, m]));
      }
    }
    this.memory.set(mapping.id, mapping);
  }

  private async remove(id: string): Promise<void> {
    if (!this.memory) {
      try {
        await dbDelete('mappings', id);
        return;
      } catch {
        this.memory = new Map((await this.all()).map((m) => [m.id, m]));
      }
    }
    this.memory.delete(id);
  }

  async list(filter: MappingFilter = {}): Promise<ProductMapping[]> {
    return (await this.all())
      .filter(
        (m) =>
          (!filter.configId || m.configId === filter.configId) &&
          (!filter.scope || m.scope === filter.scope) &&
          (!filter.externalId || m.externalId === filter.externalId),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(
    input: MappingTarget & { configId: string; reassign?: boolean },
  ): Promise<ProductMapping> {
    validateTarget(input);
    const existing = (await this.all()).find(
      (m) => targetKey(m.scope, m.externalId) === targetKey(input.scope, input.externalId),
    );
    const now = Date.now();
    if (existing) {
      if (existing.configId === input.configId) {
        if (input.label && input.label !== existing.label) {
          const updated = { ...existing, label: input.label, updatedAt: now };
          await this.put(updated);
          return updated;
        }
        return existing;
      }
      if (!input.reassign) {
        throw new MappingConflictError(input.scope, input.externalId, {
          id: existing.id,
          configId: existing.configId,
        });
      }
      const moved = {
        ...existing,
        configId: input.configId,
        label: input.label ?? existing.label,
        updatedAt: now,
      };
      await this.put(moved);
      return moved;
    }
    const created: ProductMapping = {
      id: uuid(),
      storeId: LOCAL_STORE_ID,
      configId: input.configId,
      scope: input.scope,
      externalId: input.externalId,
      label: input.label ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.put(created);
    return created;
  }

  async update(
    id: string,
    patch: { configId?: string; label?: string | null; reassign?: boolean },
  ): Promise<ProductMapping> {
    const current = (await this.all()).find((m) => m.id === id);
    if (!current) throw new MappingInvalidError('The mapping no longer exists.');
    if (patch.label != null && patch.label.length > 200) {
      throw new MappingInvalidError('The name must be at most 200 characters.');
    }
    const updated: ProductMapping = {
      ...current,
      configId: patch.configId ?? current.configId,
      label: patch.label === undefined ? current.label : patch.label,
      updatedAt: Date.now(),
    };
    await this.put(updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.remove(id);
  }

  async bulk(input: BulkMappingInput): Promise<BulkMappingResult> {
    const create = input.create ?? [];
    const deleteIds = input.deleteIds ?? [];
    if (create.length + deleteIds.length > MAX_BULK_ITEMS) {
      throw new MappingInvalidError(`At most ${MAX_BULK_ITEMS} changes at a time.`);
    }
    create.forEach(validateTarget);
    const result: BulkMappingResult = {
      created: [],
      reassigned: [],
      unchanged: [],
      conflicts: [],
      deleted: 0,
    };
    const byKey = new Map((await this.all()).map((m) => [targetKey(m.scope, m.externalId), m]));
    const now = Date.now();
    for (const target of create) {
      const key = targetKey(target.scope, target.externalId);
      const existing = byKey.get(key);
      if (!existing) {
        const created: ProductMapping = {
          id: uuid(),
          storeId: LOCAL_STORE_ID,
          configId: input.configId,
          scope: target.scope,
          externalId: target.externalId,
          label: target.label ?? null,
          createdAt: now,
          updatedAt: now,
        };
        await this.put(created);
        byKey.set(key, created);
        result.created.push(created);
      } else if (existing.configId === input.configId) {
        result.unchanged.push(existing);
      } else if (input.reassign) {
        const moved = {
          ...existing,
          configId: input.configId,
          label: target.label ?? existing.label,
          updatedAt: now,
        };
        await this.put(moved);
        byKey.set(key, moved);
        result.reassigned.push(moved);
      } else {
        result.conflicts.push({
          scope: target.scope,
          externalId: target.externalId,
          existing: { id: existing.id, configId: existing.configId },
        });
      }
    }
    const known = new Set([...byKey.values()].map((m) => m.id));
    for (const id of deleteIds) {
      if (!known.has(id)) continue;
      await this.remove(id);
      result.deleted++;
    }
    return result;
  }

  async deleteForConfig(configId: string): Promise<number> {
    const doomed = (await this.all()).filter((m) => m.configId === configId);
    for (const m of doomed) await this.remove(m.id);
    return doomed.length;
  }
}
