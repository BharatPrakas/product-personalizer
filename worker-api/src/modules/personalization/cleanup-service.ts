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
 * Direct (presigned) uploads add three phases, run before the customization phases:
 *  - expire_pending_uploads: an upload whose URL lapsed (plus a grace period) without being confirmed
 *    becomes `expired`, and a `verifying` claim whose owner died is handed back;
 *  - delete_upload_objects: removes the staging object of every finished upload once its presigned URL has
 *    certainly expired (a replayed PUT cannot re-create it afterwards), and — for failed / expired uploads
 *    only — the promoted copy, but never one an `assets` / `customization_assets` row references;
 *  - purge_upload_records: drops old, fully cleaned `uploads` rows.
 * All three are idempotent and tenant-scoped by the key prefixes they refuse to leave.
 *
 * Every claim is a plain conditional UPDATE/DELETE (`WHERE ... IN (SELECT ... LIMIT n)`), not
 * `FOR UPDATE SKIP LOCKED`: D1 serializes every write to a single logical writer, so two overlapping
 * cleanup runs cannot interleave their claims the way two concurrent Postgres transactions could —
 * there is no row lock to take because there is no concurrent writer to lock against. Each run is
 * recorded in `cleanup_runs`.
 */

import type { Database } from '../../database/connection';
import type { AppConfig } from '../../config/environment';
import type { Logger } from '../../shared/logger';
import {
  type ObjectStorage,
  assetKeyPrefix,
  customizationKeyPrefix,
  pendingKeyPrefix,
} from '../../storage/object-storage';

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
  uploadsExpired: number;
  uploadObjectsDeleted: number;
  uploadObjectsFailed: number;
  uploadRecordsPurged: number;
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
    const runId = crypto.randomUUID();
    await db.query(
      `INSERT INTO cleanup_runs (id, trigger, started_at) VALUES ($1, $2, $3)`,
      [runId, trigger, now],
    );
    const outcome: CleanupOutcome = {
      runId,
      customizationsExpired: 0,
      uploadsReleased: 0,
      assetsDeleted: 0,
      assetsFailed: 0,
      tombstonesPurged: 0,
      uploadsExpired: 0,
      uploadObjectsDeleted: 0,
      uploadObjectsFailed: 0,
      uploadRecordsPurged: 0,
      errors: [],
    };

    const phases: Array<[string, () => Promise<void>]> = [
      ['reset_stale_claims', () => this.resetStaleClaims(now)],
      ['expire_pending_uploads', async () => { outcome.uploadsExpired = await this.expirePendingUploads(now); }],
      ['delete_upload_objects', async () => {
        const result = await this.deleteUploadObjects(now);
        outcome.uploadObjectsDeleted = result.deleted;
        outcome.uploadObjectsFailed = result.failed;
      }],
      ['purge_upload_records', async () => { outcome.uploadRecordsPurged = await this.purgeUploadRecords(now); }],
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
      `UPDATE cleanup_runs
          SET status = $2, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), customizations_expired = $3,
              uploads_released = $4, assets_deleted = $5, assets_failed = $6, tombstones_purged = $7, error = $8,
              uploads_expired = $9, upload_objects_deleted = $10, upload_records_purged = $11
        WHERE id = $1`,
      [outcome.runId, outcome.errors.length > 0 ? 'failed' : 'succeeded', outcome.customizationsExpired,
       outcome.uploadsReleased, outcome.assetsDeleted, outcome.assetsFailed, outcome.tombstonesPurged,
       outcome.errors.length > 0 ? outcome.errors.join('; ').slice(0, 1000) : null,
       outcome.uploadsExpired, outcome.uploadObjectsDeleted, outcome.uploadRecordsPurged],
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
      `UPDATE customization_assets SET status = 'released', updated_at = $1
        WHERE status = 'deleting' AND updated_at < $2`,
      [now, new Date(now.getTime() - STALE_CLAIM_MS)],
    );
  }

  /** Unconfirmed direct uploads whose URL (plus grace) has lapsed become `expired`; dead claims are returned. */
  private async expirePendingUploads(now: Date): Promise<number> {
    const db = this.ctx.db;
    await db.query(
      `UPDATE uploads SET status = 'uploaded', updated_at = $1
        WHERE status = 'verifying' AND updated_at < $2`,
      [now, new Date(now.getTime() - STALE_CLAIM_MS)],
    );
    const cutoff = new Date(now.getTime() - this.ctx.config.pendingUploadGraceMinutes * 60 * 1000);
    const { rows } = await db.query<{ id: string }>(
      `UPDATE uploads
          SET status = 'expired', failure_reason = 'url_expired', completed_at = $1, updated_at = $1
        WHERE id IN (
                SELECT id FROM uploads
                 WHERE status IN ('pending', 'uploaded') AND url_expires_at < $2
                 ORDER BY url_expires_at
                 LIMIT $3)
          AND status IN ('pending', 'uploaded')
      RETURNING id`,
      [now, cutoff, this.batch],
    );
    return rows.length;
  }

  private async deleteUploadObjects(now: Date): Promise<{ deleted: number; failed: number }> {
    const { db, logger } = this.ctx;
    // Only after the presigned URL has expired: until then a replayed PUT could re-create the object.
    const { rows } = await db.query<{
      id: string;
      store_id: string;
      scope: 'merchant' | 'customer';
      status: 'stored' | 'failed' | 'expired';
      pending_key: string;
      final_key: string | null;
    }>(
      `SELECT id, store_id, scope, status, pending_key, final_key FROM uploads
        WHERE cleaned = 0 AND status IN ('stored', 'failed', 'expired') AND url_expires_at < $1
        ORDER BY updated_at
        LIMIT $2`,
      [now, this.batch],
    );
    let deleted = 0;
    let failed = 0;
    for (const upload of rows) {
      try {
        if (!upload.pending_key.startsWith(pendingKeyPrefix(upload.store_id))) {
          throw new Error('pending key is outside the staging prefix');
        }
        const storage = this.ctx.storage();
        await storage.delete(upload.pending_key);
        deleted += 1;
        // A stored upload's permanent key is the live asset — never touch it. A failed / expired one may
        // have a promoted copy that no row references (crash between copy and the DB write).
        if (upload.status !== 'stored' && upload.final_key) {
          const prefix =
            upload.scope === 'merchant' ? assetKeyPrefix(upload.store_id) : customizationKeyPrefix(upload.store_id);
          if (!upload.final_key.startsWith(prefix)) throw new Error('final key is outside the store prefix');
          const referenced = await db.query(
            `SELECT 1 AS one FROM assets WHERE object_key = $1
             UNION ALL SELECT 1 FROM customization_assets WHERE object_key = $1 LIMIT 1`,
            [upload.final_key],
          );
          if (referenced.rows.length === 0) {
            await storage.delete(upload.final_key);
            deleted += 1;
          }
        }
        await db.query(`UPDATE uploads SET cleaned = 1, last_error = NULL WHERE id = $1`, [upload.id]);
      } catch (error) {
        failed += 1;
        logger.warn('upload object delete failed', { uploadId: upload.id, error: String(error) });
        await db.query(
          `UPDATE uploads SET cleanup_attempts = cleanup_attempts + 1, last_error = $2 WHERE id = $1`,
          [upload.id, String(error).slice(0, 300)],
        );
      }
    }
    return { deleted, failed };
  }

  private async purgeUploadRecords(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.ctx.config.expiredTombstoneDays * DAY_MS);
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `DELETE FROM uploads
        WHERE id IN (
                SELECT id FROM uploads
                 WHERE cleaned = 1 AND status IN ('stored', 'failed', 'expired') AND updated_at < $1
                 ORDER BY updated_at
                 LIMIT $2)
      RETURNING id`,
      [cutoff, this.batch],
    );
    return rows.length;
  }

  private async expireCustomizations(now: Date): Promise<number> {
    const deleteAfter = new Date(now.getTime() + this.ctx.config.assetDeleteGraceHours * HOUR_MS);
    // One atomic batch: claim candidates (conditional UPDATE, no row lock needed — see the file
    // comment), then release their assets. The second statement is scoped by `expired_at = $now`
    // rather than the first statement's RETURNING ids, since D1's batch() cannot pass one statement's
    // result into the next; `now` uniquely identifies the rows this run just expired.
    const [expireResult] = await this.ctx.db.batch<{ id: string }>([
      {
        text: `UPDATE customizations
                  SET status = 'expired', expired_at = $1, expires_at = NULL, data = '{}',
                      updated_at_ms = MAX($2, updated_at_ms + 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id IN (
                  SELECT id FROM customizations
                   WHERE status = 'saved' AND expires_at <= $3
                     AND NOT EXISTS (SELECT 1 FROM order_links ol WHERE ol.customization_id = customizations.id)
                   ORDER BY expires_at
                   LIMIT $4)
              RETURNING id`,
        params: [now, now.getTime(), now, this.batch],
      },
      {
        text: `UPDATE customization_assets
                  SET status = 'released', delete_after = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE status = 'attached' AND customization_id IN (
                  SELECT id FROM customizations WHERE status = 'expired' AND expired_at = $1)`,
        params: [now, deleteAfter],
      },
    ]);
    return expireResult.rows.length;
  }

  private async releaseAbandonedUploads(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.ctx.config.unattachedUploadTtlHours * HOUR_MS);
    const deleteAfter = new Date(now.getTime() + this.ctx.config.assetDeleteGraceHours * HOUR_MS);
    const { rowCount } = await this.ctx.db.query(
      `UPDATE customization_assets
          SET status = 'released', delete_after = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id IN (
                SELECT id FROM customization_assets
                 WHERE status = 'uploaded' AND customization_id IS NULL AND created_at < $1
                 ORDER BY created_at
                 LIMIT $3)
          AND status = 'uploaded' AND customization_id IS NULL`,
      [cutoff, deleteAfter, this.batch],
    );
    return rowCount;
  }

  private async deleteReleasedAssets(now: Date): Promise<{ deleted: number; failed: number }> {
    const { db, logger } = this.ctx;
    // Claim: grace period elapsed AND the owning customization is neither ordered nor order-linked.
    const claimed = await db.query<ClaimedAsset>(
      `UPDATE customization_assets
          SET status = 'deleting', delete_attempts = delete_attempts + 1, updated_at = $1
        WHERE id IN (
                SELECT x.id FROM customization_assets x
                 WHERE x.status = 'released' AND x.delete_after <= $1
                   AND NOT EXISTS (SELECT 1 FROM customizations c
                                    WHERE c.id = x.customization_id AND c.status = 'ordered')
                   AND NOT EXISTS (SELECT 1 FROM order_links ol
                                    WHERE ol.customization_id = x.customization_id)
                 ORDER BY x.delete_after
                 LIMIT $2)
      RETURNING id, store_id, object_key, delete_attempts`,
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
          `UPDATE customization_assets
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
          `UPDATE customization_assets
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
    // RETURNING + rows.length, not rowCount: this DELETE cascades into customization_assets (its
    // already-`deleted`-status, kept-until-purge rows), which would otherwise double the count.
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `DELETE FROM customizations
        WHERE id IN (
                SELECT x.id FROM customizations x
                 WHERE x.status = 'expired' AND x.expired_at < $1
                   AND NOT EXISTS (SELECT 1 FROM order_links ol WHERE ol.customization_id = x.id)
                   AND NOT EXISTS (SELECT 1 FROM customization_assets a
                                    WHERE a.customization_id = x.id AND a.status <> 'deleted')
                 ORDER BY x.expired_at
                 LIMIT $2)
          AND status = 'expired'
      RETURNING id`,
      [cutoff, this.batch],
    );
    return rows.length;
  }
}
