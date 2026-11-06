/**
 * SQL for customizations, their private customer assets and order links. Every query takes an explicit
 * store id; nothing here trusts an id from a request on its own.
 */

import { placeholders, type Database, type Statement } from '../../database/connection';
import type { Cursor } from './pagination';

export type CustomizationStatus = 'saved' | 'ordered' | 'expired';
export type CustomerAssetKind = 'upload' | 'preview' | 'artwork';
export type CustomerAssetStatus = 'uploaded' | 'attached' | 'released' | 'deleting' | 'deleted';

export interface CustomizationRow {
  id: string;
  store_id: string;
  config_id: string;
  config_version: number;
  client_config_id: string;
  product_external_id: string;
  variant_external_id: string | null;
  mapping_scope: 'product' | 'variant' | 'collection';
  mapping_external_id: string;
  status: CustomizationStatus;
  data: Record<string, unknown>;
  last_activity_at: string;
  expires_at: string | null;
  ordered_at: string | null;
  expired_at: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CustomerAssetRow {
  id: string;
  store_id: string;
  customization_id: string | null;
  kind: CustomerAssetKind;
  object_key: string;
  original_filename: string | null;
  content_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  checksum_sha256: string | null;
  status: CustomerAssetStatus;
  created_at: string;
}

export interface OrderLinkRow {
  customization_id: string;
  store_id: string;
  external_order_id: string;
  external_line_id: string;
  product_external_id: string;
  event_id: string;
  occurred_at: string;
  created_at: string;
}

export interface CustomizationListRow extends CustomizationRow {
  link_order_id: string | null;
  link_line_id: string | null;
  link_created_at: string | null;
}

// `cfg` is the configuration row, joined only to expose the client-facing config id.
const COLS = `c.id, c.store_id, c.config_id, c.config_version, cfg.client_config_id,
  c.product_external_id, c.variant_external_id, c.mapping_scope, c.mapping_external_id, c.status,
  c.data, c.last_activity_at, c.expires_at, c.ordered_at, c.expired_at, c.created_at_ms, c.updated_at_ms`;
const FROM = `customizations c
  JOIN configs cfg ON cfg.id = c.config_id AND cfg.store_id = c.store_id`;

const ASSET_COLS = `id, store_id, customization_id, kind, object_key, original_filename, content_type,
  size_bytes, width, height, checksum_sha256, status, created_at`;

function parseData<T extends { data?: unknown }>(row: T): T {
  if (typeof row.data === 'string') return { ...row, data: JSON.parse(row.data) };
  return row;
}

export class CustomizationRepository {
  constructor(private readonly db: Database) {}

  async configVersionExists(configUuid: string, storeId: string, version: number): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM config_versions
        WHERE config_id = $1 AND store_id = $2 AND version = $3`,
      [configUuid, storeId, version],
    );
    return rows.length > 0;
  }

  /**
   * Inserts the customization AND claims the requested uploads as one atomic batch. `assetIds` already
   * belongs to this store (validated by the caller); if any of them cannot be claimed (not uploaded,
   * already owned), nothing commits at all — including the customization row — via the
   * `pending_attach_count` trigger guard (migrations/d1/0001_baseline.sql). Returns the new
   * customization id, or null when the claim came up short.
   */
  async insertWithAttach(input: {
    storeId: string;
    configUuid: string;
    configVersion: number;
    productId: string;
    variantId: string | null;
    mappingScope: string;
    mappingExternalId: string;
    data: unknown;
    now: Date;
    expiresAt: Date;
    assetIds: readonly string[];
  }): Promise<string | null> {
    const id = crypto.randomUUID();
    const ms = input.now.getTime();
    const statements: Statement[] = [
      {
        text: `INSERT INTO customizations
                 (id, store_id, config_id, config_version, product_external_id, variant_external_id,
                  mapping_scope, mapping_external_id, data, last_activity_at, expires_at,
                  pending_attach_count, created_at_ms, updated_at_ms)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
        params: [id, input.storeId, input.configUuid, input.configVersion, input.productId, input.variantId,
          input.mappingScope, input.mappingExternalId, JSON.stringify(input.data), input.now, input.expiresAt,
          input.assetIds.length, ms],
      },
    ];
    if (input.assetIds.length > 0) {
      statements.push({
        text: `UPDATE customization_assets
                  SET customization_id = $2, status = 'attached', attached_at = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE store_id = $1 AND id IN (${placeholders(4, input.assetIds.length)}) AND status = 'uploaded' AND customization_id IS NULL`,
        params: [input.storeId, id, input.now, ...input.assetIds],
      });
    }
    // No-op touch that exists only to fire the attach-count guard trigger (see the migration).
    statements.push({
      text: `UPDATE customizations SET updated_at = updated_at WHERE id = $1`,
      params: [id],
    });
    try {
      await this.db.batch(statements);
      return id;
    } catch (error) {
      if (error instanceof Error && error.message.includes('attach_count_mismatch')) return null;
      throw error;
    }
  }

  async getById(storeId: string, id: string): Promise<CustomizationRow | null> {
    const { rows } = await this.db.query<CustomizationRow>(
      `SELECT ${COLS} FROM ${FROM} WHERE c.store_id = $1 AND c.id = $2`,
      [storeId, id],
    );
    return rows[0] ? parseData(rows[0]) : null;
  }

  /**
   * One atomic batch: set up the attach-count guard, claim newly-requested uploads, release removed
   * ones, and write the new `data`/`expires_at` — all or nothing. If the claim comes up short, NOTHING
   * commits (the guard trigger aborts the whole batch); the data/expiry write is itself conditional on
   * `status = 'saved'`, same as the old `updateSaved`, so a concurrent order/expiry is caught too.
   */
  async applyUpdate(input: {
    storeId: string;
    customizationId: string;
    toAttach: readonly string[];
    toRelease: readonly string[];
    data: unknown;
    now: Date;
    expiresAt: Date;
    deleteAfter: Date;
  }): Promise<'ok' | 'attach_unavailable' | 'state_changed'> {
    const statements: Statement[] = [
      {
        text: `UPDATE customizations SET pending_attach_count = $2 WHERE id = $1`,
        params: [input.customizationId, input.toAttach.length],
      },
    ];
    if (input.toAttach.length > 0) {
      statements.push({
        text: `UPDATE customization_assets
                  SET customization_id = $2, status = 'attached', attached_at = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE store_id = $1 AND id IN (${placeholders(4, input.toAttach.length)}) AND status = 'uploaded' AND customization_id IS NULL`,
        params: [input.storeId, input.customizationId, input.now, ...input.toAttach],
      });
    }
    if (input.toRelease.length > 0) {
      statements.push({
        text: `UPDATE customization_assets
                  SET status = 'released', delete_after = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE store_id = $1 AND customization_id = $2 AND id IN (${placeholders(4, input.toRelease.length)}) AND status = 'attached'`,
        params: [input.storeId, input.customizationId, input.deleteAfter, ...input.toRelease],
      });
    }
    const dataUpdateIndex = statements.length;
    statements.push({
      text: `UPDATE customizations
                SET data = $3, last_activity_at = $4, expires_at = $5,
                    updated_at_ms = MAX($6, updated_at_ms + 1), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE store_id = $1 AND id = $2 AND status = 'saved'`,
      params: [input.storeId, input.customizationId, JSON.stringify(input.data), input.now, input.expiresAt, input.now.getTime()],
    });
    // Unconditional, so the attach-count guard is always evaluated even if the data UPDATE above
    // matched zero rows (e.g. the customization was ordered concurrently).
    statements.push({
      text: `UPDATE customizations SET updated_at = updated_at WHERE id = $1`,
      params: [input.customizationId],
    });
    let results: Awaited<ReturnType<Database['batch']>>;
    try {
      results = await this.db.batch(statements);
    } catch (error) {
      if (error instanceof Error && error.message.includes('attach_count_mismatch')) return 'attach_unavailable';
      throw error;
    }
    return results[dataUpdateIndex].rowCount > 0 ? 'ok' : 'state_changed';
  }

  // ---- list / read (merchant) ----

  async list(
    storeId: string,
    filter: { status?: string; orderId?: string; productId?: string },
    cursor: Cursor | null,
    limit: number,
  ): Promise<CustomizationListRow[]> {
    const params: unknown[] = [storeId];
    let where = 'c.store_id = $1';
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where += ` AND ${clause.replace('?', `$${params.length}`)}`;
    };
    if (filter.status) add('c.status = ?', filter.status);
    if (filter.productId) add('c.product_external_id = ?', filter.productId);
    if (filter.orderId) add('ol.external_order_id = ?', filter.orderId);
    if (cursor) {
      params.push(cursor.createdAtMs, cursor.id);
      where += ` AND (c.created_at_ms, c.id) < ($${params.length - 1}, $${params.length})`;
    }
    params.push(limit + 1);
    const { rows } = await this.db.query<CustomizationListRow>(
      `SELECT ${COLS}, ol.external_order_id AS link_order_id, ol.external_line_id AS link_line_id,
              ol.created_at AS link_created_at
         FROM ${FROM}
         LEFT JOIN order_links ol ON ol.customization_id = c.id
        WHERE ${where}
        ORDER BY c.created_at_ms DESC, c.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map(parseData);
  }

  async getOrderLink(storeId: string, customizationId: string): Promise<OrderLinkRow | null> {
    const { rows } = await this.db.query<OrderLinkRow>(
      `SELECT customization_id, store_id, external_order_id, external_line_id, product_external_id,
              event_id, occurred_at, created_at
         FROM order_links WHERE store_id = $1 AND customization_id = $2`,
      [storeId, customizationId],
    );
    return rows[0] ?? null;
  }

  // ---- customer assets ----

  async insertAsset(input: {
    storeId: string;
    kind: CustomerAssetKind;
    objectKey: string;
    filename: string | null;
    contentType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    checksum: string;
  }): Promise<CustomerAssetRow> {
    const { rows } = await this.db.query<CustomerAssetRow>(
      `INSERT INTO customization_assets
         (id, store_id, kind, object_key, original_filename, content_type, size_bytes, width, height,
          checksum_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${ASSET_COLS}`,
      [crypto.randomUUID(), input.storeId, input.kind, input.objectKey, input.filename, input.contentType,
       input.sizeBytes, input.width, input.height, input.checksum],
    );
    return rows[0];
  }

  async getAsset(storeId: string, assetId: string): Promise<CustomerAssetRow | null> {
    const { rows } = await this.db.query<CustomerAssetRow>(
      `SELECT ${ASSET_COLS} FROM customization_assets WHERE store_id = $1 AND id = $2`,
      [storeId, assetId],
    );
    return rows[0] ?? null;
  }

  /** Assets currently attached to a customization. */
  async attachedAssets(storeId: string, customizationId: string): Promise<CustomerAssetRow[]> {
    const { rows } = await this.db.query<CustomerAssetRow>(
      `SELECT ${ASSET_COLS} FROM customization_assets
        WHERE store_id = $1 AND customization_id = $2 AND status = 'attached'
        ORDER BY created_at, id`,
      [storeId, customizationId],
    );
    return rows;
  }
}
