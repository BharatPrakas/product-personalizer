import { Service, inject, signal } from '@angular/core';
import { dbGet, dbGetAll, dbPut } from '../../customizer/services/local-db';
import { type ConfigurationRecord, normalizeRecord } from '../configuration.models';
import { ApiClient, ApiClientError } from './api-client.service';
import { AssetSyncService } from './asset-sync.service';

export type MigrationState = 'pending' | 'migrated' | 'failed';

/** Per-record migration status, persisted in the `sync` IndexedDB store so migration is resumable. */
export interface MigrationStatusEntry {
  id: string;
  state: MigrationState;
  /** `updatedAt` of the local record when it was migrated — lets us detect later local edits. */
  sourceUpdatedAt: number;
  migratedAt: number | null;
  attempts: number;
  lastError: string | null;
  uploadedAssets: number;
}

export interface MigrationReport {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  entries: MigrationStatusEntry[];
}

/**
 * One-time, user-triggered migration of existing IndexedDB configurations to the cloud. It is:
 *   - NON-DESTRUCTIVE: local IndexedDB data is never cleared; it stays as the local cache.
 *   - IDEMPOTENT: configs are pushed under their existing local id, which the Worker dedupes; assets
 *     are pushed under their `idb:` ref as `clientRef`, which the Worker also dedupes.
 *   - RESUMABLE: status is written to the `sync` store per record, so a refresh or network blip does
 *     not lose progress, and re-running retries only what failed or changed.
 *   - VERIFIED: a record is marked `migrated` only after the cloud copy is read back successfully.
 *
 * It does NOT run automatically on startup; the host/merchant invokes it explicitly.
 */
@Service()
export class MigrationService {
  private readonly api = inject(ApiClient);
  private readonly assets = inject(AssetSyncService);

  readonly running = signal(false);
  readonly progress = signal<{ done: number; total: number }>({ done: 0, total: 0 });

  /** Local records that still hold configurations (the source of the migration). */
  private async localRecords(): Promise<ConfigurationRecord[]> {
    const raw = await dbGetAll<ConfigurationRecord>('configs');
    return raw.map(normalizeRecord);
  }

  async status(): Promise<MigrationStatusEntry[]> {
    return dbGetAll<MigrationStatusEntry>('sync');
  }

  private async statusOf(id: string): Promise<MigrationStatusEntry | undefined> {
    return dbGet<MigrationStatusEntry>('sync', id);
  }

  private async writeStatus(entry: MigrationStatusEntry): Promise<void> {
    await dbPut('sync', entry);
  }

  /** Migrate every local configuration. Safe to call repeatedly. */
  async migrateAll(options: { retryFailed?: boolean } = {}): Promise<MigrationReport> {
    if (this.running()) throw new Error('A migration is already in progress.');
    this.running.set(true);
    const report: MigrationReport = { total: 0, migrated: 0, skipped: 0, failed: 0, entries: [] };
    try {
      const records = await this.localRecords();
      report.total = records.length;
      this.progress.set({ done: 0, total: records.length });

      for (const record of records) {
        const existing = await this.statusOf(record.id);
        const alreadyDone =
          existing?.state === 'migrated' && existing.sourceUpdatedAt === record.updatedAt;
        const shouldRetry = existing?.state === 'failed' && (options.retryFailed ?? true);
        if (alreadyDone || (existing?.state === 'failed' && !shouldRetry)) {
          report.skipped++;
          if (existing) report.entries.push(existing);
          this.bump();
          continue;
        }

        const entry = await this.migrateOne(record, existing);
        report.entries.push(entry);
        if (entry.state === 'migrated') report.migrated++;
        else report.failed++;
        this.bump();
      }
      return report;
    } finally {
      this.running.set(false);
    }
  }

  private bump(): void {
    this.progress.update((p) => ({ done: p.done + 1, total: p.total }));
  }

  private async migrateOne(
    record: ConfigurationRecord,
    existing: MigrationStatusEntry | undefined,
  ): Promise<MigrationStatusEntry> {
    const attempts = (existing?.attempts ?? 0) + 1;
    try {
      // 1. Upload the draft's local assets to R2 and rewrite refs to delivery URLs.
      const synced = await this.assets.syncConfigAssets({ ...record.draft, id: record.id });

      // 2. Create the configuration under its existing local id (idempotent server-side).
      await this.api.createConfig(record.id, synced.config);

      // 3. If it was published locally, establish a published snapshot in the cloud.
      //    (Caveat: the Worker publishes the current draft; for a config with pending unpublished
      //    changes the cloud published snapshot reflects the draft, not the older published copy.)
      if (record.published) {
        try {
          await this.api.publish(record.id);
        } catch (error) {
          // A not-ready config cannot be published; keep it as a draft in the cloud and continue.
          if (!(error instanceof ApiClientError) || error.status !== 422) throw error;
        }
      }

      // 4. Verify persistence before marking migrated.
      const verify = await this.api.getConfig(record.id);
      if (!verify.data || verify.data.id !== record.id) {
        throw new Error('Cloud copy could not be verified after upload.');
      }

      const entry: MigrationStatusEntry = {
        id: record.id,
        state: 'migrated',
        sourceUpdatedAt: record.updatedAt,
        migratedAt: Date.now(),
        attempts,
        lastError: null,
        uploadedAssets: synced.uploadedCount,
      };
      await this.writeStatus(entry);
      return entry;
    } catch (error) {
      const entry: MigrationStatusEntry = {
        id: record.id,
        state: 'failed',
        sourceUpdatedAt: record.updatedAt,
        migratedAt: existing?.migratedAt ?? null,
        attempts,
        lastError: error instanceof Error ? error.message : String(error),
        uploadedAssets: existing?.uploadedAssets ?? 0,
      };
      await this.writeStatus(entry); // local data is left untouched; retry is safe.
      return entry;
    }
  }
}
