/**
 * Read-only queries behind the public storefront routes. Everything is keyed by an explicit store id
 * that the service has already resolved; nothing here trusts a caller-supplied id beyond that.
 */

import type { SqlExecutor } from '../../database/connection';
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
  size_bytes: string;
  checksum_sha256: string | null;
}

export class StorefrontRepository {
  constructor(private readonly db: SqlExecutor) {}

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
    const { rows } = await this.db.query<ResolvedMappingRow>(
      `SELECT c.id AS config_uuid, m.scope, m.external_id, c.client_config_id, c.published
         FROM personalization.mappings m
         JOIN personalization.configs c ON c.id = m.config_id AND c.store_id = m.store_id
        WHERE m.store_id = $1
          AND c.published IS NOT NULL
          AND c.archived_at_ms IS NULL
          AND ((m.scope = 'variant' AND m.external_id = $2)
            OR (m.scope = 'product' AND m.external_id = $3)
            OR (m.scope = 'collection' AND m.external_id = ANY($4::text[])))
        ORDER BY CASE m.scope WHEN 'variant' THEN 1 WHEN 'product' THEN 2 ELSE 3 END,
                 m.created_at_ms, m.id
        LIMIT 1`,
      [storeId, target.variantId, target.externalId, target.collectionIds],
    );
    return rows[0] ?? null;
  }

  /** Stored assets of the store among the given ids / object keys. */
  async findAssets(
    storeId: string,
    ids: readonly string[],
    keys: readonly string[],
  ): Promise<Array<{ id: string; object_key: string }>> {
    if (ids.length === 0 && keys.length === 0) return [];
    const { rows } = await this.db.query<{ id: string; object_key: string }>(
      `SELECT id, object_key FROM personalization.assets
        WHERE store_id = $1 AND status = 'stored'
          AND (id = ANY($2::uuid[]) OR object_key = ANY($3::text[]))`,
      [storeId, ids, keys],
    );
    return rows;
  }

  /** A stored asset by id, whether or not it is published. Callers must verify a signature first. */
  async getStoredAsset(assetId: string): Promise<ServableAssetRow | null> {
    const { rows } = await this.db.query<ServableAssetRow>(
      `SELECT id, store_id, object_key, content_type, size_bytes, checksum_sha256
         FROM personalization.assets WHERE id = $1 AND status = 'stored'`,
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
         FROM personalization.assets a
        WHERE a.id = $1 AND a.status = 'stored'
          AND EXISTS (
            SELECT 1 FROM personalization.configs c
             WHERE c.store_id = a.store_id
               AND c.published IS NOT NULL
               AND c.archived_at_ms IS NULL
               AND (strpos(c.published::text, a.id::text) > 0
                 OR strpos(c.published::text, a.object_key) > 0))`,
      [assetId],
    );
    return rows[0] ?? null;
  }
}
