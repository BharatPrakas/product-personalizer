import { Service, inject, signal } from '@angular/core';
import { I18n } from '../../admin/i18n/i18n.service';
import type { ConfigIssue } from '../../customizer/models/config.models';
import type { ProductConfig } from '../../customizer/models/product.models';
import { uuid } from '../../customizer/util/ids';
import { dbDelete, dbGet, dbGetAll, dbPut } from '../../customizer/services/local-db';
import { addMockup } from '../../editor/util/config-edit';
import {
  ConfigurationConflictError,
  ConfigurationInvalidError,
  ConfigurationNotFoundError,
  ConfigurationRepository,
  type NewConfigurationInput,
  type StorageInfo,
  StorageError,
} from '../configuration-repository';
import type { ConfigurationRecord } from '../configuration.models';
import { emptyConfiguration } from '../empty-configuration';
import { withCloudAssetBase } from '../bundled-assets';
import { ApiClient, ApiClientError } from './api-client.service';
import { AssetSyncService } from './asset-sync.service';

const CLOUD: StorageInfo = {
  kind: 'cloud',
  labelKey: 'storage.detail.cloud',
  persistent: true,
};
const CLOUD_OFFLINE: StorageInfo = {
  kind: 'cloud',
  labelKey: 'storage.detail.offline',
  persistent: false,
};

interface CacheEntry {
  id: string;
  record: ConfigurationRecord;
}

/**
 * Cloud-authoritative repository. PostgreSQL (via the Worker API) is the source of truth; IndexedDB
 * is kept as a read-through cache so lists/opens still work briefly offline. Uploaded local images
 * (`idb:`) are pushed to R2 and the persisted cloud copy references stable delivery URLs — the editor
 * keeps its own in-memory draft, so this does not disturb dirty-tracking or the renderer.
 *
 * NOTE: implemented against the Worker API and type-checked, but not yet verified against a live
 * Cloudflare deployment (no Hyperdrive/R2 was provisioned in this environment).
 */
@Service()
export class CloudConfigurationRepository extends ConfigurationRepository {
  private readonly api = inject(ApiClient);
  private readonly assets = inject(AssetSyncService);
  private readonly i18n = inject(I18n);

  readonly storage = signal<StorageInfo>(CLOUD);

  // ---- reads ----

  async list(options: { includeArchived?: boolean } = {}): Promise<ConfigurationRecord[]> {
    try {
      const records: ConfigurationRecord[] = [];
      let page = 1;
      const pageSize = 100;
      for (;;) {
        const res = await this.api.listConfigs({
          includeArchived: options.includeArchived ?? false,
          page,
          pageSize,
        });
        records.push(...res.data);
        const pages = res.meta?.pagination?.totalPages ?? 1;
        if (page >= pages) break;
        page++;
      }
      this.storage.set(CLOUD);
      await this.cacheReplace(records);
      return records.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (error) {
      if (this.isNetwork(error)) {
        this.storage.set(CLOUD_OFFLINE);
        const cached = await this.cacheList();
        return cached
          .filter((r) => options.includeArchived || r.archivedAt === null)
          .sort((a, b) => b.updatedAt - a.updatedAt);
      }
      throw this.mapError(error);
    }
  }

  async get(id: string): Promise<ConfigurationRecord | null> {
    try {
      const res = await this.api.getConfig(id);
      this.storage.set(CLOUD);
      await this.cachePut(res.data);
      return res.data;
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) return null;
      if (this.isNetwork(error)) {
        this.storage.set(CLOUD_OFFLINE);
        return this.cacheGet(id);
      }
      throw this.mapError(error, id);
    }
  }

  // ---- writes ----

  async create(input: NewConfigurationInput): Promise<ConfigurationRecord> {
    const id = this.newId();
    let draft = withCloudAssetBase(emptyConfiguration(id, input.name.trim() || 'Untitled configuration'));
    if (input.mockupSrc) {
      draft = addMockup(draft, {
        name: input.mockupName?.trim() || 'Front view',
        src: input.mockupSrc,
      }).config;
    }
    return this.persistNew(id, draft);
  }

  async createFromDraft(draft: ProductConfig): Promise<ConfigurationRecord> {
    const id = this.newId();
    return this.persistNew(id, withCloudAssetBase({ ...draft, id, status: 'draft', version: 1 }));
  }

  private async persistNew(id: string, draft: ProductConfig): Promise<ConfigurationRecord> {
    try {
      const synced = await this.assets.syncConfigAssets({ ...draft, id });
      const res = await this.api.createConfig(id, synced.config);
      this.storage.set(CLOUD);
      await this.cachePut(res.data);
      return res.data;
    } catch (error) {
      throw this.mapError(error, id);
    }
  }

  async saveDraft(
    id: string,
    draft: ProductConfig,
    expectedUpdatedAt: number,
  ): Promise<ConfigurationRecord> {
    try {
      const synced = await this.assets.syncConfigAssets({ ...draft, id });
      const res = await this.api.saveDraft(id, synced.config, expectedUpdatedAt);
      this.storage.set(CLOUD);
      await this.cachePut(res.data);
      return res.data;
    } catch (error) {
      throw this.mapError(error, id);
    }
  }

  async publish(id: string): Promise<ConfigurationRecord> {
    try {
      const res = await this.api.publish(id);
      await this.cachePut(res.data);
      return res.data;
    } catch (error) {
      throw this.mapError(error, id);
    }
  }

  async duplicate(id: string): Promise<ConfigurationRecord> {
    try {
      const res = await this.api.duplicate(id);
      await this.cachePut(res.data);
      return res.data;
    } catch (error) {
      throw this.mapError(error, id);
    }
  }

  async archive(id: string): Promise<ConfigurationRecord> {
    try {
      const res = await this.api.archive(id);
      await this.cachePut(res.data);
      return res.data;
    } catch (error) {
      throw this.mapError(error, id);
    }
  }

  async restore(id: string): Promise<ConfigurationRecord> {
    try {
      const res = await this.api.restore(id);
      await this.cachePut(res.data);
      return res.data;
    } catch (error) {
      throw this.mapError(error, id);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.api.deleteConfig(id);
      await this.cacheDelete(id);
    } catch (error) {
      throw this.mapError(error, id);
    }
  }

  // ---- helpers ----

  private newId(): string {
    return `cfg-${uuid().slice(0, 8)}`;
  }

  private isNetwork(error: unknown): boolean {
    return (
      error instanceof ApiClientError &&
      (error.status === 0 || error.code === 'network' || error.code === 'not_configured')
    );
  }

  private mapError(error: unknown, id?: string): Error {
    if (error instanceof ApiClientError) {
      if (error.status === 409) return new ConfigurationConflictError();
      if (error.status === 404) return new ConfigurationNotFoundError(id ?? 'unknown');
      if (error.status === 422)
        return new ConfigurationInvalidError(this.extractIssues(error.details));
      if (error.status === 401 || error.status === 403) {
        return new StorageError(this.i18n.t('error.cloud.unauthorized'), { cause: error });
      }
      if (this.isNetwork(error)) {
        return new StorageError(this.i18n.t('error.cloud.unreachable'), { cause: error });
      }
      return new StorageError(error.message || this.i18n.t('error.cloud.failed'), {
        cause: error,
      });
    }
    return new StorageError(this.i18n.t('error.storage.write'));
  }

  private extractIssues(details: unknown): ConfigIssue[] {
    const issues = (details as { issues?: unknown })?.issues;
    if (!Array.isArray(issues))
      return [{ path: '(root)', code: 'invalid', message: 'The configuration is invalid.' }];
    return issues.map((i) => ({
      path: String((i as ConfigIssue).path ?? '(root)'),
      code: String((i as ConfigIssue).code ?? 'invalid'),
      message: String((i as ConfigIssue).message ?? 'Invalid value.'),
    }));
  }

  // ---- cache (best-effort; never fails a cloud operation) ----

  private async cachePut(record: ConfigurationRecord): Promise<void> {
    try {
      await dbPut<CacheEntry>('cloud-cache', { id: record.id, record });
    } catch {
      /* cache is best-effort */
    }
  }

  private async cacheReplace(records: ConfigurationRecord[]): Promise<void> {
    for (const record of records) await this.cachePut(record);
  }

  private async cacheGet(id: string): Promise<ConfigurationRecord | null> {
    try {
      return (await dbGet<CacheEntry>('cloud-cache', id))?.record ?? null;
    } catch {
      return null;
    }
  }

  private async cacheList(): Promise<ConfigurationRecord[]> {
    try {
      return (await dbGetAll<CacheEntry>('cloud-cache')).map((e) => e.record);
    } catch {
      return [];
    }
  }

  private async cacheDelete(id: string): Promise<void> {
    try {
      await dbDelete('cloud-cache', id);
    } catch {
      /* best-effort */
    }
  }
}
