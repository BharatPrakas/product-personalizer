/**
 * Scheduled cleanup of abandoned customizations and customer files.
 *
 * Safety rules, in the order they are applied:
 *  1. Only `saved` customizations past their inactivity expiry are touched, and never one that has an
 *     order link. `ordered` rows are outside this job entirely — their retention is a separate business
 *     policy (see README) and nothing here deletes them or their files.
 *  2. Expiring a customization clears its data and RELEASES its files; nothing is deleted yet.
 *  3. Abandoned uploads (never attached to a customization) are released separately, after a TTL.
 *  4. A released file is only deleted after a grace period, and only if its customization is not
 *     ordered / linked to an order. The object is deleted outside any transaction; a failure keeps the
 *     row for a later retry with backoff.
 *  5. Expired rows are kept as empty tombstones for a while (so a late order callback gets a clear
 *     answer), then purged once none of their files remain.
 *
 * Every claim uses `FOR UPDATE SKIP LOCKED`, so overlapping runs (or a run racing an order callback,
 * which locks the customization row) cannot double-process or delete something just ordered.
 * Each run is recorded in `personalization.cleanup_runs`.
 */

import type { Database } from '../../database/connection';
import { runInTransaction } from '../../database/transactions';
import type { AppConfig } from '../../config/environment';
import type { Logger } from '../../shared/logger';
import { type ObjectStorage, customizationKeyPrefix } from '../../storage/object-storage';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Rows handled per phase per run; the next scheduled run continues where this one stopped. */
export const CLEANUP_BATCH_SIZE = 200;
const STALE_CLAIM_MS = HOUR_MS;
const MAX_BACKOFF_HOURS = 24;

export interface CleanupOutcome {
  runId: string;
  customizationsExpired: number;
  uploadsReleased: number;
  assetsDeleted: number;
  assetsFailed: number;
  tombstonesPurged: number;
  errors: string[];
}

export interface CleanupContext {
  db: Database;
  storage: () => ObjectStorage;
  config: AppConfig;
  logger: Logger;
  batchSize?: number;
}

interface ClaimedAsset {
  id: string;
  store_id: string;
  object_key: string;
  delete_attempts: number;
}

export class CleanupService {
  constructor(private readonly ctx: CleanupContext) {}

  async run(trigger: string, now: Date = new Date()): Promise<CleanupOutcome> {
    const { db, logger } = this.ctx;
    const started = await db.query<{ id: string }>(
      `INSERT INTO personalization.cleanup_runs (trigger, started_at) VALUES ($1, $2) RETURNING id`,
      [trigger, now],
    );
    const outcome: CleanupOutcome = {
      runId: started.rows[0].id,
      customizationsExpired: 0,
      uploadsReleased: 0,
      assetsDeleted: 0,
      assetsFailed: 0,
      tombstonesPurged: 0,
      errors: [],
    };

    const phases: Array<[string, () => Promise<void>]> = [
      ['reset_stale_claims', () => this.resetStaleClaims(now)],
      ['expire_customizations', async () => { outcome.customizationsExpired = await this.expireCustomizations(now); }],
      ['release_abandoned_uploads', async () => { outcome.uploadsReleased = await this.releaseAbandonedUploads(now); }],
      ['delete_released_assets', async () => {
        const result = await this.deleteReleasedAssets(now);
        outcome.assetsDeleted = result.deleted;
        outcome.assetsFailed = result.failed;
      }],
      ['purge_tombstones', async () => { outcome.tombstonesPurged = await this.purgeTombstones(now); }],
    ];
    // One phase failing must not stop the others; the run is recorded as failed and retried next time.
    for (const [name, phase] of phases) {
      try {
        await phase();
      } catch (error) {
        outcome.errors.push(`${name}: ${String(error).slice(0, 300)}`);
        logger.error('cleanup phase failed', { phase: name, runId: outcome.runId, error: String(error) });
      }
    }

    await db.query(
      `UPDATE personalization.cleanup_runs
          SET status = $2, finished_at = now(), customizations_expired = $3, uploads_released = $4,
              assets_deleted = $5, assets_failed = $6, tombstones_purged = $7, error = $8
        WHERE id = $1`,
      [outcome.runId, outcome.errors.length > 0 ? 'failed' : 'succeeded', outcome.customizationsExpired,
       outcome.uploadsReleased, outcome.assetsDeleted, outcome.assetsFailed, outcome.tombstonesPurged,
       outcome.errors.length > 0 ? outcome.errors.join('; ').slice(0, 1000) : null],
    );
    logger.info('cleanup finished', { ...outcome, errors: outcome.errors.length });
    return outcome;
  }

  private get batch(): number {
    return this.ctx.batchSize ?? CLEANUP_BATCH_SIZE;
  }

  /** A run that died mid-delete leaves rows in `deleting`; hand them back for another attempt. */
  private async resetStaleClaims(now: Date): Promise<void> {
    await this.ctx.db.query(
      `UPDATE personalization.customization_assets SET status = 'released', updated_at = $1
        WHERE status = 'deleting' AND updated_at < $2`,
      [now, new Date(now.getTime() - STALE_CLAIM_MS)],
    );
  }

  private async expireCustomizations(now: Date): Promise<number> {
    const deleteAfter = new Date(now.getTime() + this.ctx.config.assetDeleteGraceHours * HOUR_MS);
    return runInTransaction(this.ctx.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `WITH candidates AS (
           SELECT c.id FROM personalization.customizations c
            WHERE c.status = 'saved' AND c.expires_at <= $1
              AND NOT EXISTS (SELECT 1 FROM personalization.order_links ol WHERE ol.customization_id = c.id)
            ORDER BY c.expires_at
            LIMIT $2
            FOR UPDATE OF c SKIP LOCKED)
         UPDATE personalization.customizations c
            SET status = 'expired', expired_at = $1, expires_at = NULL, data = '{}'::jsonb,
                updated_at_ms = greatest($3::bigint, c.updated_at_ms + 1), updated_at = now()
           FROM candidates
          WHERE c.id = candidates.id AND c.status = 'saved'
        RETURNING c.id`,
        [now, this.batch, now.getTime()],
      );
      if (rows.length > 0) {
        await tx.query(
          `UPDATE personalization.customization_assets
              SET status = 'released', delete_after = $2, updated_at = now()
            WHERE customization_id = ANY($1::uuid[]) AND status = 'attached'`,
          [rows.map((r) => r.id), deleteAfter],
        );
      }
      return rows.length;
    });
  }

  private async releaseAbandonedUploads(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.ctx.config.unattachedUploadTtlHours * HOUR_MS);
    const deleteAfter = new Date(now.getTime() + this.ctx.config.assetDeleteGraceHours * HOUR_MS);
    const { rowCount } = await this.ctx.db.query(
      `UPDATE personalization.customization_assets a
          SET status = 'released', delete_after = $2, updated_at = now()
        WHERE a.id IN (
                SELECT x.id FROM personalization.customization_assets x
                 WHERE x.status = 'uploaded' AND x.customization_id IS NULL AND x.created_at < $1
                 ORDER BY x.created_at
                 LIMIT $3
                 FOR UPDATE OF x SKIP LOCKED)
          AND a.status = 'uploaded' AND a.customization_id IS NULL`,
      [cutoff, deleteAfter, this.batch],
    );
    return rowCount;
  }

  private async deleteReleasedAssets(now: Date): Promise<{ deleted: number; failed: number }> {
    const { db, logger } = this.ctx;
    // Claim: grace period elapsed AND the owning customization is neither ordered nor order-linked.
    const claimed = await db.query<ClaimedAsset>(
      `UPDATE personalization.customization_assets a
          SET status = 'deleting', delete_attempts = a.delete_attempts + 1, updated_at = $1
        WHERE a.id IN (
                SELECT x.id FROM personalization.customization_assets x
                 WHERE x.status = 'released' AND x.delete_after <= $1
                   AND NOT EXISTS (SELECT 1 FROM personalization.customizations c
                                    WHERE c.id = x.customization_id AND c.status = 'ordered')
                   AND NOT EXISTS (SELECT 1 FROM personalization.order_links ol
                                    WHERE ol.customization_id = x.customization_id)
                 ORDER BY x.delete_after
                 LIMIT $2
                 FOR UPDATE OF x SKIP LOCKED)
      RETURNING a.id, a.store_id, a.object_key, a.delete_attempts`,
      [now, this.batch],
    );

    let deleted = 0;
    let failed = 0;
    for (const asset of claimed.rows) {
      try {
        if (!asset.object_key.startsWith(customizationKeyPrefix(asset.store_id))) {
          throw new Error('object key is outside the private customization prefix');
        }
        await this.ctx.storage().delete(asset.object_key);
        await db.query(
          `UPDATE personalization.customization_assets
              SET status = 'deleted', deleted_at = $2, last_error = NULL, updated_at = $2
            WHERE id = $1 AND status = 'deleting'`,
          [asset.id, now],
        );
        deleted += 1;
      } catch (error) {
        failed += 1;
        const backoffHours = Math.min(2 ** (asset.delete_attempts - 1), MAX_BACKOFF_HOURS);
        logger.warn('customer asset delete failed', { assetId: asset.id, attempts: asset.delete_attempts, error: String(error) });
        await db.query(
          `UPDATE personalization.customization_assets
              SET status = 'released', delete_after = $2, last_error = $3, updated_at = $4
            WHERE id = $1 AND status = 'deleting'`,
          [asset.id, new Date(now.getTime() + backoffHours * HOUR_MS), String(error).slice(0, 300), now],
        );
      }
    }
    return { deleted, failed };
  }

  private async purgeTombstones(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.ctx.config.expiredTombstoneDays * DAY_MS);
    const { rowCount } = await this.ctx.db.query(
      `DELETE FROM personalization.customizations c
        WHERE c.id IN (
                SELECT x.id FROM personalization.customizations x
                 WHERE x.status = 'expired' AND x.expired_at < $1
                   AND NOT EXISTS (SELECT 1 FROM personalization.order_links ol WHERE ol.customization_id = x.id)
                   AND NOT EXISTS (SELECT 1 FROM personalization.customization_assets a
                                    WHERE a.customization_id = x.id AND a.status <> 'deleted')
                 ORDER BY x.expired_at
                 LIMIT $2
                 FOR UPDATE OF x SKIP LOCKED)
          AND c.status = 'expired'`,
      [cutoff, this.batch],
    );
    return rowCount;
  }
}
