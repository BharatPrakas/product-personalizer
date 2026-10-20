import { Service, inject, signal } from '@angular/core';
import type { ProductConfig } from '../customizer/models/product.models';
import { LocalAssetLibrary } from '../customizer/services/local-asset-library.service';
import { dbDelete, dbGet, dbGetAll, dbPut, openLocalDb } from '../customizer/services/local-db';
import { uuid } from '../customizer/util/ids';
import { addMockup } from '../editor/util/config-edit';
import {
  ConfigurationConflictError,
  ConfigurationInvalidError,
  ConfigurationNotFoundError,
  ConfigurationRepository,
  type NewConfigurationInput,
  type StorageInfo,
  StorageError,
} from './configuration-repository';
import { type ConfigurationRecord, normalizeRecord } from './configuration.models';
import { emptyConfiguration } from './empty-configuration';
import { canPublish, setupSteps } from './publish-readiness';
import { validateConfiguration } from './validation';

const BROWSER: StorageInfo = {
  kind: 'browser',
  label: 'Saved in this browser only (IndexedDB). Nothing is sent to a server.',
  persistent: true,
};
const MEMORY: StorageInfo = {
  kind: 'memory',
  label:
    'Browser storage is unavailable here: changes are kept in memory and are lost when this tab closes.',
  persistent: false,
};

/** The standalone application's repository: IndexedDB, or memory when IndexedDB cannot be opened. */
@Service()
export class LocalConfigurationRepository extends ConfigurationRepository {
  private readonly library = inject(LocalAssetLibrary);
  private readonly memory = new Map<string, ConfigurationRecord>();
  private mode: Promise<'browser' | 'memory'> | null = null;

  readonly storage = signal<StorageInfo>(BROWSER);

  /** Decided once: if IndexedDB opens, every write must really reach it (a failed write is an error). */
  private backend(): Promise<'browser' | 'memory'> {
    this.mode ??= openLocalDb().then(
      () => 'browser' as const,
      () => {
        this.storage.set(MEMORY);
        return 'memory' as const;
      },
    );
    return this.mode;
  }

  private async readAll(): Promise<ConfigurationRecord[]> {
    if ((await this.backend()) === 'memory') return [...this.memory.values()];
    try {
      return (await dbGetAll<ConfigurationRecord>('configs')).map(normalizeRecord);
    } catch {
      throw new StorageError('The saved configurations could not be read from this browser.');
    }
  }

  private async write(record: ConfigurationRecord): Promise<ConfigurationRecord> {
    if ((await this.backend()) === 'memory') {
      this.memory.set(record.id, record);
      return record;
    }
    try {
      await dbPut('configs', record);
    } catch {
      throw new StorageError();
    }
    return record;
  }

  // ---- reads -----------------------------------------------------------------------------------

  async list(options: { includeArchived?: boolean } = {}): Promise<ConfigurationRecord[]> {
    const all = await this.readAll();
    return all
      .filter((r) => options.includeArchived || r.archivedAt === null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<ConfigurationRecord | null> {
    if ((await this.backend()) === 'memory') return this.memory.get(id) ?? null;
    try {
      const raw = await dbGet<ConfigurationRecord>('configs', id);
      return raw ? normalizeRecord(raw) : null;
    } catch {
      throw new StorageError('The configuration could not be read from this browser.');
    }
  }

  private async require(id: string): Promise<ConfigurationRecord> {
    const record = await this.get(id);
    if (!record) throw new ConfigurationNotFoundError(id);
    return record;
  }

  // ---- writes ----------------------------------------------------------------------------------

  async create(input: NewConfigurationInput): Promise<ConfigurationRecord> {
    const id = this.newId();
    let draft = emptyConfiguration(id, input.name.trim() || 'Untitled configuration');
    if (input.mockupSrc) {
      draft = addMockup(draft, {
        name: input.mockupName?.trim() || 'Front view',
        src: input.mockupSrc,
      }).config;
    }
    return this.write(this.fresh(id, draft));
  }

  async createFromDraft(draft: ProductConfig): Promise<ConfigurationRecord> {
    const id = this.newId();
    return this.write(this.fresh(id, { ...draft, id, status: 'draft', version: 1 }));
  }

  async saveDraft(
    id: string,
    draft: ProductConfig,
    expectedUpdatedAt: number,
  ): Promise<ConfigurationRecord> {
    const current = await this.require(id);
    if (current.updatedAt !== expectedUpdatedAt) throw new ConfigurationConflictError();
    const result = validateConfiguration(draft, { allowIncomplete: true });
    if (!result.ok) throw new ConfigurationInvalidError(result.issues);
    return this.write({
      ...current,
      // Lifecycle fields belong to the repository, not the editor.
      draft: { ...draft, id, status: 'draft', version: current.draft.version },
      updatedAt: this.stamp(current.updatedAt),
    });
  }

  async publish(id: string): Promise<ConfigurationRecord> {
    const current = await this.require(id);
    const strict = validateConfiguration(current.draft, { allowIncomplete: false });
    const issues = strict.ok ? [] : strict.issues;
    if (issues.length > 0 || !canPublish(setupSteps(current.draft, issues))) {
      throw new ConfigurationInvalidError(issues);
    }
    const now = this.stamp(current.updatedAt);
    return this.write({
      ...current,
      published: { ...current.draft, status: 'published' },
      // The draft carries on as the next version, so a published version is never edited in place.
      draft: { ...current.draft, status: 'draft', version: current.draft.version + 1 },
      publishedAt: now,
      updatedAt: now,
    });
  }

  async duplicate(id: string): Promise<ConfigurationRecord> {
    const source = await this.require(id);
    const copyId = this.newId();
    const name = `${source.draft.product.name} (copy)`.slice(0, 120);
    return this.write(
      this.fresh(copyId, {
        ...structuredClone(source.draft),
        id: copyId,
        status: 'draft',
        version: 1,
        product: { ...source.draft.product, id: `product-${copyId}`, name },
      }),
    );
  }

  async archive(id: string): Promise<ConfigurationRecord> {
    const current = await this.require(id);
    return this.write({ ...current, archivedAt: Date.now() });
  }

  async restore(id: string): Promise<ConfigurationRecord> {
    const current = await this.require(id);
    return this.write({ ...current, archivedAt: null });
  }

  async delete(id: string): Promise<void> {
    const record = await this.get(id);
    if ((await this.backend()) === 'memory') this.memory.delete(id);
    else {
      try {
        await dbDelete('configs', id);
      } catch {
        throw new StorageError('The configuration could not be deleted.');
      }
    }
    if (record) await this.releaseImagesOf(record);
  }

  /** Remove the stored images only this configuration used; images shared with others stay. */
  private async releaseImagesOf(deleted: ConfigurationRecord): Promise<void> {
    const candidates = imageRefsOf(deleted);
    if (candidates.size === 0) return;
    const stillUsed = new Set<string>();
    for (const record of await this.readAll())
      imageRefsOf(record).forEach((ref) => stillUsed.add(ref));
    for (const ref of candidates) {
      if (!stillUsed.has(ref)) await this.library.remove(ref);
    }
  }

  // ---- helpers ---------------------------------------------------------------------------------

  private newId(): string {
    return `cfg-${uuid().slice(0, 8)}`;
  }

  private fresh(id: string, draft: ProductConfig): ConfigurationRecord {
    const now = Date.now();
    return {
      id,
      draft,
      published: null,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      archivedAt: null,
    };
  }

  /** Strictly increasing so a save right after another still changes `updatedAt`. */
  private stamp(previous: number): number {
    return Math.max(Date.now(), previous + 1);
  }
}

const IMAGE_REF = /^idb:[A-Za-z0-9_-]+$/;

function imageRefsOf(record: ConfigurationRecord): Set<string> {
  const refs = new Set<string>();
  collectImageRefs(record.draft, refs);
  if (record.published) collectImageRefs(record.published, refs);
  return refs;
}

function collectImageRefs(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (IMAGE_REF.test(value)) into.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectImageRefs(item, into));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectImageRefs(item, into));
  }
}
