/**
 * Data access for the `uploads` table (migrations/0001_baseline.sql). Every state change is a CONDITIONAL update
 * (`WHERE status IN (...)`) whose row count the caller checks: D1 has no row locks or interactive
 * transactions, so "who won" is decided by SQLite applying exactly one of two competing UPDATEs.
 */

import { chunkForParamLimit, placeholders, type Database, type Statement } from '../../database/connection';

export type UploadStatus = 'pending' | 'uploaded' | 'verifying' | 'stored' | 'failed' | 'expired';
export type UploadScopeName = 'merchant' | 'customer';
export type UploadPurpose = 'merchant-asset' | 'customer-upload' | 'customer-preview' | 'customer-artwork';

export interface UploadRow {
  id: string;
  store_id: string;
  scope: UploadScopeName;
  purpose: UploadPurpose;
  asset_id: string;
  config_id: string | null;
  client_ref: string | null;
  original_filename: string | null;
  storage_provider: 'r2' | 's3';
  pending_key: string;
  final_key: string | null;
  expected_content_type: string;
  expected_size: number;
  expected_sha256: string | null;
  verified_content_type: string | null;
  actual_size: number | null;
  checksum_sha256: string | null;
  width: number | null;
  height: number | null;
  etag: string | null;
  status: UploadStatus;
  failure_reason: string | null;
  url_expires_at: string;
  attempts: number;
  cleaned: number;
  cleanup_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const COLS = `id, store_id, scope, purpose, asset_id, config_id, client_ref, original_filename,
  storage_provider, pending_key, final_key, expected_content_type, expected_size, expected_sha256,
  verified_content_type, actual_size, checksum_sha256, width, height, etag, status, failure_reason,
  url_expires_at, attempts, cleaned, cleanup_attempts, last_error, created_at, updated_at, completed_at`;

export interface InsertUpload {
  id: string;
  storeId: string;
  scope: UploadScopeName;
  purpose: UploadPurpose;
  assetId: string;
  configDbId: string | null;
  clientRef: string | null;
  filename: string | null;
  provider: 'r2' | 's3';
  pendingKey: string;
  contentType: string;
  size: number;
  sha256: string | null;
  urlExpiresAt: Date;
  now: Date;
}

/** What the verified bytes turned out to be; written to the row when it is finalized. */
export interface VerifiedUpload {
  contentType: string;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  etag: string;
}

export class UploadRepository {
  constructor(private readonly db: Database) {}

  async insert(input: InsertUpload): Promise<UploadRow> {
    const { rows } = await this.db.query<UploadRow>(
      `INSERT INTO uploads
         (id, store_id, scope, purpose, asset_id, config_id, client_ref, original_filename,
          storage_provider, pending_key, expected_content_type, expected_size, expected_sha256,
          url_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
       RETURNING ${COLS}`,
      [input.id, input.storeId, input.scope, input.purpose, input.assetId, input.configDbId, input.clientRef,
       input.filename, input.provider, input.pendingKey, input.contentType, input.size, input.sha256,
       input.urlExpiresAt, input.now],
    );
    return rows[0];
  }

  /** Always store-scoped: another tenant's upload id is indistinguishable from a missing one. */
  async get(storeId: string, id: string): Promise<UploadRow | null> {
    const { rows } = await this.db.query<UploadRow>(
      `SELECT ${COLS} FROM uploads WHERE store_id = $1 AND id = $2`,
      [storeId, id],
    );
    return rows[0] ?? null;
  }

  async openByClientRef(storeId: string, clientRef: string): Promise<UploadRow | null> {
    const { rows } = await this.db.query<UploadRow>(
      `SELECT ${COLS} FROM uploads
        WHERE store_id = $1 AND client_ref = $2 AND status IN ('pending', 'uploaded', 'verifying')`,
      [storeId, clientRef],
    );
    return rows[0] ?? null;
  }

  /** Of these asset ids, the ones that belong to an upload that is NOT `stored` (so must not be referenced). */
  async unverifiedAssetIds(storeId: string, assetIds: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const chunk of chunkForParamLimit(assetIds, 1, 1)) {
      const { rows } = await this.db.query<{ asset_id: string }>(
        `SELECT asset_id FROM uploads
          WHERE store_id = $1 AND status <> 'stored' AND asset_id IN (${placeholders(2, chunk.length)})`,
        [storeId, ...chunk],
      );
      out.push(...rows.map((r) => r.asset_id));
    }
    return out;
  }

  async countOpen(storeId: string): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*) AS n FROM uploads WHERE store_id = $1 AND status IN ('pending', 'uploaded', 'verifying')`,
      [storeId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Extends the URL lifetime of an upload that is still waiting for bytes / verification. */
  async renew(storeId: string, id: string, urlExpiresAt: Date, now: Date): Promise<UploadRow | null> {
    const { rows } = await this.db.query<UploadRow>(
      `UPDATE uploads SET url_expires_at = $3, updated_at = $4
        WHERE store_id = $1 AND id = $2 AND status IN ('pending', 'uploaded')
        RETURNING ${COLS}`,
      [storeId, id, urlExpiresAt, now],
    );
    return rows[0] ?? null;
  }

  /** HEAD saw the staged object. pending -> uploaded; a no-op for any other state. */
  async markUploaded(id: string, size: number, etag: string, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE uploads SET status = 'uploaded', actual_size = $2, etag = $3, updated_at = $4
        WHERE id = $1 AND status = 'pending'`,
      [id, size, etag, now],
    );
  }

  /**
   * Takes ownership of verification. Succeeds from `uploaded`, or from a `verifying` claim older than
   * `staleBefore` (its owner crashed). Exactly one concurrent caller gets the row back.
   */
  async claimVerifying(id: string, now: Date, staleBefore: Date): Promise<UploadRow | null> {
    const { rows } = await this.db.query<UploadRow>(
      `UPDATE uploads SET status = 'verifying', attempts = attempts + 1, updated_at = $2
        WHERE id = $1 AND (status = 'uploaded' OR (status = 'verifying' AND updated_at < $3))
        RETURNING ${COLS}`,
      [id, now, staleBefore],
    );
    return rows[0] ?? null;
  }

  /** Gives a claim back after a transient failure so the next completion call can retry. */
  async release(id: string, to: 'pending' | 'uploaded', now: Date): Promise<void> {
    await this.db.query(
      `UPDATE uploads SET status = $2, updated_at = $3 WHERE id = $1 AND status = 'verifying'`,
      [id, to, now],
    );
  }

  /** Fixes the permanent key before the copy so a retry promotes to the very same key. */
  async fixFinalKey(id: string, key: string, now: Date): Promise<string | null> {
    const { rows } = await this.db.query<{ final_key: string }>(
      `UPDATE uploads SET final_key = coalesce(final_key, $2), updated_at = $3
        WHERE id = $1 AND status = 'verifying' RETURNING final_key`,
      [id, key, now],
    );
    return rows[0]?.final_key ?? null;
  }

  async fail(id: string, reason: string, now: Date): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE uploads SET status = 'failed', failure_reason = $2, completed_at = $3, updated_at = $3
        WHERE id = $1 AND status IN ('pending', 'uploaded', 'verifying')`,
      [id, reason.slice(0, 200), now],
    );
    return rowCount > 0;
  }

  async markCleaned(id: string): Promise<void> {
    await this.db.query(`UPDATE uploads SET cleaned = 1, last_error = NULL WHERE id = $1`, [id]);
  }

  /**
   * The statement that makes an upload `stored`. Runs in the same atomic batch as the asset insert, and
   * is the arbiter of a race: the batch's second result row-count says whether THIS call won.
   */
  finalizeStatement(id: string, v: VerifiedUpload, now: Date): Statement {
    return {
      text: `UPDATE uploads
                SET status = 'stored', verified_content_type = $2, actual_size = $3, checksum_sha256 = $4,
                    width = $5, height = $6, etag = $7, completed_at = $8, updated_at = $8
              WHERE id = $1 AND status = 'verifying'
              RETURNING id`,
      params: [id, v.contentType, v.size, v.sha256, v.width, v.height, v.etag, now],
    };
  }
}
