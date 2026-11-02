/**
 * SQL for customizations, their private customer assets and order links. Every query takes an explicit
 * store id; nothing here trusts an id from a request on its own. Row-locking reads (`forUpdate`) are
 * only meant to be used on a transaction executor.
 */

import type { SqlExecutor } from '../../database/connection';
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
  last_activity_at: Date | string;
  expires_at: Date | string | null;
  ordered_at: Date | string | null;
  expired_at: Date | string | null;
  created_at_ms: string;
  updated_at_ms: string;
}

export interface CustomerAssetRow {
  id: string;
  store_id: string;
  customization_id: string | null;
  kind: CustomerAssetKind;
  object_key: string;
  original_filename: string | null;
  content_type: string;
  size_bytes: string;
  width: number | null;
  height: number | null;
  checksum_sha256: string | null;
  status: CustomerAssetStatus;
  created_at: Date | string;
}

export interface OrderLinkRow {
  customization_id: string;
  store_id: string;
  external_order_id: string;
  external_line_id: string;
  product_external_id: string;
  event_id: string;
  occurred_at: Date | string;
  created_at: Date | string;
}

export interface CustomizationListRow extends CustomizationRow {
  link_order_id: string | null;
  link_line_id: string | null;
  link_created_at: Date | string | null;
}

// `cfg` is the configuration row, joined only to expose the client-facing config id.
const COLS = `c.id, c.store_id, c.config_id, c.config_version, cfg.client_config_id,
  c.product_external_id, c.variant_external_id, c.mapping_scope, c.mapping_external_id, c.status,
  c.data, c.last_activity_at, c.expires_at, c.ordered_at, c.expired_at, c.created_at_ms, c.updated_at_ms`;
const FROM = `personalization.customizations c
  JOIN personalization.configs cfg ON cfg.id = c.config_id AND cfg.store_id = c.store_id`;

const ASSET_COLS = `id, store_id, customization_id, kind, object_key, original_filename, content_type,
  size_bytes, width, height, checksum_sha256, status, created_at`;

export class CustomizationRepository {
  constructor(private readonly db: SqlExecutor) {}

  async configVersionExists(configUuid: string, storeId: string, version: number): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM personalization.config_versions
        WHERE config_id = $1 AND store_id = $2 AND version = $3`,
      [configUuid, storeId, version],
    );
    return rows.length > 0;
  }

  async insert(input: {
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
  }): Promise<string> {
    const ms = input.now.getTime();
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO personalization.customizations
         (store_id, config_id, config_version, product_external_id, variant_external_id,
          mapping_scope, mapping_external_id, data, last_activity_at, expires_at,
          created_at_ms, updated_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $11)
       RETURNING id`,
      [input.storeId, input.configUuid, input.configVersion, input.productId, input.variantId,
       input.mappingScope, input.mappingExternalId, JSON.stringify(input.data), input.now,
       input.expiresAt, ms],
    );
    return rows[0].id;
  }

  async getById(storeId: string, id: string, forUpdate = false): Promise<CustomizationRow | null> {
    const { rows } = await this.db.query<CustomizationRow>(
      `SELECT ${COLS} FROM ${FROM} WHERE c.store_id = $1 AND c.id = $2${forUpdate ? ' FOR UPDATE OF c' : ''}`,
      [storeId, id],
    );
    return rows[0] ?? null;
  }

  /** Conditional on `saved`: zero rows means the state changed and the caller must re-check it. */
  async updateSaved(
    storeId: string,
    id: string,
    data: unknown,
    now: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE personalization.customizations
          SET data = $3::jsonb, last_activity_at = $4, expires_at = $5,
              updated_at_ms = greatest($6::bigint, updated_at_ms + 1), updated_at = now()
        WHERE store_id = $1 AND id = $2 AND status = 'saved'`,
      [storeId, id, JSON.stringify(data), now, expiresAt, now.getTime()],
    );
    return rowCount > 0;
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
      where += ` AND (c.created_at_ms, c.id) < ($${params.length - 1}::bigint, $${params.length}::uuid)`;
    }
    params.push(limit + 1);
    const { rows } = await this.db.query<CustomizationListRow>(
      `SELECT ${COLS}, ol.external_order_id AS link_order_id, ol.external_line_id AS link_line_id,
              ol.created_at AS link_created_at
         FROM ${FROM}
         LEFT JOIN personalization.order_links ol ON ol.customization_id = c.id
        WHERE ${where}
        ORDER BY c.created_at_ms DESC, c.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async getOrderLink(storeId: string, customizationId: string): Promise<OrderLinkRow | null> {
    const { rows } = await this.db.query<OrderLinkRow>(
      `SELECT customization_id, store_id, external_order_id, external_line_id, product_external_id,
              event_id, occurred_at, created_at
         FROM personalization.order_links WHERE store_id = $1 AND customization_id = $2`,
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
      `INSERT INTO personalization.customization_assets
         (store_id, kind, object_key, original_filename, content_type, size_bytes, width, height,
          checksum_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${ASSET_COLS}`,
      [input.storeId, input.kind, input.objectKey, input.filename, input.contentType, input.sizeBytes,
       input.width, input.height, input.checksum],
    );
    return rows[0];
  }

  async getAsset(storeId: string, assetId: string): Promise<CustomerAssetRow | null> {
    const { rows } = await this.db.query<CustomerAssetRow>(
      `SELECT ${ASSET_COLS} FROM personalization.customization_assets WHERE store_id = $1 AND id = $2`,
      [storeId, assetId],
    );
    return rows[0] ?? null;
  }

  /** Assets currently attached to a customization. */
  async attachedAssets(storeId: string, customizationId: string): Promise<CustomerAssetRow[]> {
    const { rows } = await this.db.query<CustomerAssetRow>(
      `SELECT ${ASSET_COLS} FROM personalization.customization_assets
        WHERE store_id = $1 AND customization_id = $2 AND status = 'attached'
        ORDER BY created_at, id`,
      [storeId, customizationId],
    );
    return rows;
  }

  /**
   * Attach unattached uploads. Conditional on `uploaded` AND no owner, so an asset can be claimed once;
   * the caller compares the returned count with what it asked for.
   */
  async attachUploads(storeId: string, customizationId: string, assetIds: readonly string[], now: Date): Promise<number> {
    if (assetIds.length === 0) return 0;
    const { rowCount } = await this.db.query(
      `UPDATE personalization.customization_assets
          SET customization_id = $2, status = 'attached', attached_at = $4, updated_at = now()
        WHERE store_id = $1 AND id = ANY($3::uuid[]) AND status = 'uploaded' AND customization_id IS NULL`,
      [storeId, customizationId, assetIds, now],
    );
    return rowCount;
  }

  /** Detach assets the customer removed: they are released and deleted after the grace period. */
  async releaseAttached(storeId: string, customizationId: string, assetIds: readonly string[], deleteAfter: Date): Promise<void> {
    if (assetIds.length === 0) return;
    await this.db.query(
      `UPDATE personalization.customization_assets
          SET status = 'released', delete_after = $4, updated_at = now()
        WHERE store_id = $1 AND customization_id = $2 AND id = ANY($3::uuid[]) AND status = 'attached'`,
      [storeId, customizationId, assetIds, deleteAfter],
    );
  }
}
