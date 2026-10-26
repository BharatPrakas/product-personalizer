import { Service, computed, inject, type Signal } from '@angular/core';
import type { ProductConfig } from '../customizer/models/product.models';
import { CloudConfigurationRepository } from '../workspace/cloud/cloud-configuration-repository.service';
import { RuntimeConfig } from '../workspace/cloud/runtime-config';
import {
  ConfigurationRepository,
  type NewConfigurationInput,
  type StorageInfo,
} from '../workspace/configuration-repository';
import type { ConfigurationRecord } from '../workspace/configuration.models';
import { LocalConfigurationRepository } from '../workspace/local-configuration-repository.service';
import { ProductMappingRepository } from '../mapping/product-mapping-repository';
import { AdminEvents } from './admin-events.service';
import { AdminHost } from './admin-host.service';
import { ReadOnlyError, toAdminError } from './admin-errors';

/**
 * The repository of the admin element. It delegates every call to the browser or the cloud
 * implementation according to the host's current `persistence` / `apiBaseUrl` (re-evaluated per
 * call, so the host can change them at any time), refuses writes while `readonly` is set, and
 * turns outcomes into the element's public events.
 */
@Service()
export class AdminConfigurationRepository extends ConfigurationRepository {
  private readonly local = inject(LocalConfigurationRepository);
  private readonly cloud = inject(CloudConfigurationRepository);
  private readonly runtime = inject(RuntimeConfig);
  private readonly host = inject(AdminHost);
  private readonly events = inject(AdminEvents);
  private readonly mappings = inject(ProductMappingRepository);

  private readonly active = computed<ConfigurationRepository>(() =>
    this.runtime.useCloud() ? this.cloud : this.local,
  );
  readonly storage: Signal<StorageInfo> = computed(() => this.active().storage());

  /** The implementation behind the next call. */
  private inner(): ConfigurationRepository {
    return this.active();
  }

  private async read<T>(fn: (repo: ConfigurationRepository) => Promise<T>): Promise<T> {
    try {
      return await fn(this.inner());
    } catch (error) {
      this.events.error(toAdminError(error));
      throw error;
    }
  }

  private async write<T>(fn: (repo: ConfigurationRepository) => Promise<T>): Promise<T> {
    if (this.host.readonly()) {
      const error = new ReadOnlyError();
      this.events.error(toAdminError(error));
      throw error;
    }
    return this.read(fn);
  }

  list(options?: { includeArchived?: boolean }): Promise<ConfigurationRecord[]> {
    return this.read((r) => r.list(options));
  }

  get(id: string): Promise<ConfigurationRecord | null> {
    return this.read((r) => r.get(id));
  }

  create(input: NewConfigurationInput): Promise<ConfigurationRecord> {
    return this.write((r) => r.create(input)).then((record) => this.saved(record));
  }

  createFromDraft(draft: ProductConfig): Promise<ConfigurationRecord> {
    return this.write((r) => r.createFromDraft(draft)).then((record) => this.saved(record));
  }

  saveDraft(
    id: string,
    draft: ProductConfig,
    expectedUpdatedAt: number,
  ): Promise<ConfigurationRecord> {
    return this.write((r) => r.saveDraft(id, draft, expectedUpdatedAt)).then((record) =>
      this.saved(record),
    );
  }

  publish(id: string): Promise<ConfigurationRecord> {
    return this.write((r) => r.publish(id)).then((record) => {
      this.events.configPublished({
        configId: record.id,
        name: record.draft.product.name,
        version: record.published?.version ?? 0,
        publishedAt: record.publishedAt ?? record.updatedAt,
      });
      return record;
    });
  }

  duplicate(id: string): Promise<ConfigurationRecord> {
    return this.write((r) => r.duplicate(id)).then((record) => this.saved(record));
  }

  archive(id: string): Promise<ConfigurationRecord> {
    return this.write(async (r) => {
      // Counted before archiving so the event says what stopped being served.
      const affected = await this.mappings
        .list({ configId: id })
        .then((list) => list.length)
        .catch(() => 0);
      return { record: await r.archive(id), affected };
    }).then(({ record, affected }) => {
      this.events.configArchived({
        configId: record.id,
        name: record.draft.product.name,
        archived: true,
        affectedMappings: affected,
      });
      return record;
    });
  }

  restore(id: string): Promise<ConfigurationRecord> {
    return this.write((r) => r.restore(id)).then((record) => {
      this.events.configArchived({
        configId: record.id,
        name: record.draft.product.name,
        archived: false,
        affectedMappings: 0,
      });
      return record;
    });
  }

  delete(id: string): Promise<void> {
    return this.write((r) => r.delete(id)).then(() =>
      this.mappings.deleteForConfig(id).then(() => undefined),
    );
  }

  private saved(record: ConfigurationRecord): ConfigurationRecord {
    this.events.configSaved({
      configId: record.id,
      name: record.draft.product.name,
      updatedAt: record.updatedAt,
    });
    return record;
  }
}
