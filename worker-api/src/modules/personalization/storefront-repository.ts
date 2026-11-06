/**
 * Read-only queries behind the public storefront routes. Everything is keyed by an explicit store id
 * that the service has already resolved; nothing here trusts a caller-supplied id beyond that.
 */

import { chunkForParamLimit, placeholders, type Database } from '../../database/connection';

/** D1 caps bound parameters per statement at 100; a product in more collections than this loses
 *  precedence matching for the excess ones rather than erroring the whole request. */
const MAX_COLLECTION_IDS = 90;
import type { ProductConfigLike } from './types';

export interface ResolvedMappingRow {
  /** Internal configuration uuid (what customizations reference). */
  config_uuid: string;
  scope: 'product' | 'variant' | 'collection';
  external_id: string;
  client_config_id: string;
  published: ProductConfigLike;
}

export interface ServableAssetRow {
  id: string;
  store_id: string;
  object_key: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string | null;
}

function parsePublished(row: ResolvedMappingRow): ResolvedMappingRow {
  return typeof row.published === 'string' ? { ...row, published: JSON.parse(row.published) } : row;
}

export class StorefrontRepository {
  constructor(private readonly db: Database) {}

  /**
   * The single winning mapping for a product page. Only configurations that are published and not
   * archived take part, so a higher-precedence mapping to a draft-only / archived template falls
   * through to the next. Precedence: variant (1) > product (2) > collection (3); ties (several
   * matching collections) break deterministically on mapping creation time, then id.
   */
  async resolveMapping(
    storeId: string,
    target: { externalId: string; variantId: string | null; collectionIds: readonly string[] },
  ): Promise<ResolvedMappingRow | null> {
    const collectionIds = target.collectionIds.slice(0, MAX_COLLECTION_IDS);
    const collectionPlaceholders = collectionIds.length > 0 ? placeholders(4, collectionIds.length) : null;
    const { rows } = await this.db.query<ResolvedMappingRow>(
      `SELECT c.id AS config_uuid, m.scope, m.external_id, c.client_config_id, c.published
         FROM mappings m
         JOIN configs c ON c.id = m.config_id AND c.store_id = m.store_id
        WHERE m.store_id = $1
          AND c.published IS NOT NULL
          AND c.archived_at_ms IS NULL
          AND ((m.scope = 'variant' AND m.external_id = $2)
            OR (m.scope = 'product' AND m.external_id = $3)
            ${collectionPlaceholders ? `OR (m.scope = 'collection' AND m.external_id IN (${collectionPlaceholders}))` : ''})
        ORDER BY CASE m.scope WHEN 'variant' THEN 1 WHEN 'product' THEN 2 ELSE 3 END,
                 m.created_at_ms, m.id
        LIMIT 1`,
      [storeId, target.variantId, target.externalId, ...collectionIds],
    );
    return rows[0] ? parsePublished(rows[0]) : null;
  }

  /** Stored assets of the store among the given ids / object keys. */
  async findAssets(
    storeId: string,
    ids: readonly string[],
    keys: readonly string[],
  ): Promise<Array<{ id: string; object_key: string }>> {
    if (ids.length === 0 && keys.length === 0) return [];
    const byId = new Map<string, { id: string; object_key: string }>();
    for (const idChunk of chunkForParamLimit(ids, 1)) {
      const { rows } = await this.db.query<{ id: string; object_key: string }>(
        `SELECT id, object_key FROM assets WHERE store_id = $1 AND status = 'stored' AND id IN (${placeholders(2, idChunk.length)})`,
        [storeId, ...idChunk],
      );
      for (const row of rows) byId.set(row.id, row);
    }
    for (const keyChunk of chunkForParamLimit(keys, 1)) {
      const { rows } = await this.db.query<{ id: string; object_key: string }>(
        `SELECT id, object_key FROM assets WHERE store_id = $1 AND status = 'stored' AND object_key IN (${placeholders(2, keyChunk.length)})`,
        [storeId, ...keyChunk],
      );
      for (const row of rows) byId.set(row.id, row);
    }
    return [...byId.values()];
  }

  /** A stored asset by id, whether or not it is published. Callers must verify a signature first. */
  async getStoredAsset(assetId: string): Promise<ServableAssetRow | null> {
    const { rows } = await this.db.query<ServableAssetRow>(
      `SELECT id, store_id, object_key, content_type, size_bytes, checksum_sha256
         FROM assets WHERE id = $1 AND status = 'stored'`,
      [assetId],
    );
    return rows[0] ?? null;
  }

  /**
   * An asset is publicly servable only while it is stored AND its store's current PUBLISHED, non-
   * archived configuration still references it (by row id or object key). Drafts never count.
   */
  async getServableAsset(assetId: string): Promise<ServableAssetRow | null> {
    const { rows } = await this.db.query<ServableAssetRow>(
      `SELECT a.id, a.store_id, a.object_key, a.content_type, a.size_bytes, a.checksum_sha256
         FROM assets a
        WHERE a.id = $1 AND a.status = 'stored'
          AND EXISTS (
            SELECT 1 FROM configs c
             WHERE c.store_id = a.store_id
               AND c.published IS NOT NULL
               AND c.archived_at_ms IS NULL
               AND (instr(c.published, a.id) > 0
                 OR instr(c.published, a.object_key) > 0))`,
      [assetId],
    );
    return rows[0] ?? null;
  }
}
