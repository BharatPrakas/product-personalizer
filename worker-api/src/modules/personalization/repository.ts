/**
 * Data access for configurations, versions and merchant assets. EVERY query is scoped by `store_id`, so a
 * store can never reach another store's row by guessing an id. The repository is constructed with the
 * `Database`, so the service layer can compose multi-statement operations into one atomic `batch()`.
 */

import type { Database, Statement } from '../../database/connection';
import type { AssetStatus, ProductConfigLike } from './types';

export interface ConfigRow {
  id: string;
  store_id: string;
  client_config_id: string;
  name: string;
  schema_version: number;
  draft: ProductConfigLike;
  published: ProductConfigLike | null;
  created_at_ms: number;
  updated_at_ms: number;
  published_at_ms: number | null;
  archived_at_ms: number | null;
  mapping_count: number;
}

export interface ConfigVersionRow {
  id: string;
  config_id: string;
  version: number;
  snapshot: ProductConfigLike;
  created_at_ms: number;
}

export interface AssetRow {
  id: string;
  store_id: string;
  config_id: string | null;
  object_key: string;
  original_filename: string | null;
  content_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  checksum_sha256: string | null;
  status: AssetStatus;
  client_ref: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

const CONFIG_COLS_BASE = `id, store_id, client_config_id, name, schema_version, draft, published,
  created_at_ms, updated_at_ms, published_at_ms, archived_at_ms`;
const CONFIG_COLS = `${CONFIG_COLS_BASE},
  (SELECT count(*) FROM mappings mp
     WHERE mp.config_id = configs.id AND mp.store_id = configs.store_id) AS mapping_count`;
const ASSET_COLS = `id, store_id, config_id, object_key, original_filename, content_type,
  size_bytes, width, height, checksum_sha256, status, client_ref, created_at_ms, updated_at_ms`;

export function parseConfigRow<T extends { draft?: unknown; published?: unknown; snapshot?: unknown }>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  if (typeof out.draft === 'string') out.draft = JSON.parse(out.draft as string);
  if (typeof out.published === 'string') out.published = JSON.parse(out.published as string);
  if (typeof out.snapshot === 'string') out.snapshot = JSON.parse(out.snapshot as string);
  return out as T;
}

export class PersonalizationRepository {
  constructor(private readonly db: Database) {}

  // ---- configs ----

  async getByClientId(storeId: string, clientId: string): Promise<ConfigRow | null> {
    const { rows } = await this.db.query<ConfigRow>(
      `SELECT ${CONFIG_COLS} FROM configs
        WHERE store_id = $1 AND client_config_id = $2`,
      [storeId, clientId],
    );
    return rows[0] ? parseConfigRow(rows[0]) : null;
  }

  async list(
    storeId: string,
    opts: { includeArchived: boolean; page: number; pageSize: number },
  ): Promise<{ rows: ConfigRow[]; total: number }> {
    const where = opts.includeArchived
      ? 'store_id = $1'
      : 'store_id = $1 AND archived_at_ms IS NULL';
    const totalResult = await this.db.query<{ count: number }>(
      `SELECT count(*) AS count FROM configs WHERE ${where}`,
      [storeId],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);
    const { rows } = await this.db.query<ConfigRow>(
      `SELECT ${CONFIG_COLS} FROM configs
        WHERE ${where}
        ORDER BY updated_at_ms DESC
        LIMIT $2 OFFSET $3`,
      [storeId, opts.pageSize, (opts.page - 1) * opts.pageSize],
    );
    return { rows: rows.map(parseConfigRow), total };
  }

  async clientIdExists(storeId: string, clientId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ one: number }>(
      `SELECT 1 AS one FROM configs
        WHERE store_id = $1 AND client_config_id = $2`,
      [storeId, clientId],
    );
    return rows.length > 0;
  }

  async insert(input: {
    storeId: string;
    clientConfigId: string;
    name: string;
    schemaVersion: number;
    draft: ProductConfigLike;
    nowMs: number;
  }): Promise<ConfigRow> {
    const { rows } = await this.db.query<ConfigRow>(
      `INSERT INTO configs
         (id, store_id, client_config_id, name, schema_version, draft, created_at_ms, updated_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING ${CONFIG_COLS_BASE}, 0 AS mapping_count`,
      [crypto.randomUUID(), input.storeId, input.clientConfigId, input.name, input.schemaVersion,
       JSON.stringify(input.draft), input.nowMs],
    );
    return parseConfigRow(rows[0]);
  }

  /**
   * Optimistic-concurrency update: only succeeds when `updated_at_ms` still equals
   * `expectedUpdatedAt`. Returns 'conflict' when the row exists but was changed, 'not_found' when it
   * does not exist.
   */
  async updateDraft(input: {
    storeId: string;
    clientId: string;
    name: string;
    schemaVersion: number;
    draft: ProductConfigLike;
    expectedUpdatedAt: number;
    nowMs: number;
  }): Promise<ConfigRow | 'conflict' | 'not_found'> {
    // The configuration version is owned by the lifecycle (publish bumps it), never by an editor
    // save, so we preserve the stored version inside the same atomic, concurrency-checked UPDATE.
    const { rows } = await this.db.query<ConfigRow>(
      `UPDATE configs
          SET draft = json_set($4, '$.version', coalesce(json_extract(draft, '$.version'), 1)),
              name = $5, schema_version = $6, updated_at_ms = $7, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE store_id = $1 AND client_config_id = $2 AND updated_at_ms = $3
      RETURNING ${CONFIG_COLS}`,
      [input.storeId, input.clientId, input.expectedUpdatedAt, JSON.stringify(input.draft),
       input.name, input.schemaVersion, input.nowMs],
    );
    if (rows[0]) return parseConfigRow(rows[0]);
    return (await this.clientIdExists(input.storeId, input.clientId)) ? 'conflict' : 'not_found';
  }

  /**
   * Statement pair for publish: UPDATE the config, INSERT the immutable version snapshot. Both are
   * fully determined up front (the config's db id is already known to the caller, who read it before
   * deciding to publish), so they run as one atomic `batch()` — see service.ts `publish()`.
   */
  publishStatements(input: {
    configDbId: string;
    storeId: string;
    clientId: string;
    published: ProductConfigLike;
    nextDraft: ProductConfigLike;
    version: number;
    nowMs: number;
  }): Statement[] {
    return [
      {
        text: `UPDATE configs
                  SET published = $3, draft = $4,
                      published_at_ms = $5, updated_at_ms = $5, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE store_id = $1 AND client_config_id = $2
              RETURNING ${CONFIG_COLS}`,
        params: [input.storeId, input.clientId, JSON.stringify(input.published),
          JSON.stringify(input.nextDraft), input.nowMs],
      },
      {
        text: `INSERT INTO config_versions (id, config_id, store_id, version, snapshot, created_at_ms)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (config_id, version) DO NOTHING`,
        params: [crypto.randomUUID(), input.configDbId, input.storeId, input.version,
          JSON.stringify(input.published), input.nowMs],
      },
    ];
  }

  async setArchived(
    storeId: string,
    clientId: string,
    archivedAtMs: number | null,
    nowMs: number,
  ): Promise<ConfigRow | null> {
    const { rows } = await this.db.query<ConfigRow>(
      `UPDATE configs
          SET archived_at_ms = $3, updated_at_ms = $4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE store_id = $1 AND client_config_id = $2
      RETURNING ${CONFIG_COLS}`,
      [storeId, clientId, archivedAtMs, nowMs],
    );
    return rows[0] ? parseConfigRow(rows[0]) : null;
  }

  async deleteByClientId(storeId: string, clientId: string): Promise<ConfigRow | null> {
    const { rows } = await this.db.query<ConfigRow>(
      `DELETE FROM configs
        WHERE store_id = $1 AND client_config_id = $2
      RETURNING ${CONFIG_COLS}`,
      [storeId, clientId],
    );
    return rows[0] ? parseConfigRow(rows[0]) : null;
  }

  // ---- versions ----

  async listVersions(storeId: string, clientId: string): Promise<ConfigVersionRow[]> {
    const { rows } = await this.db.query<ConfigVersionRow>(
      `SELECT v.id, v.config_id, v.version, v.snapshot, v.created_at_ms
         FROM config_versions v
         JOIN configs c ON c.id = v.config_id
        WHERE c.store_id = $1 AND c.client_config_id = $2
        ORDER BY v.version DESC`,
      [storeId, clientId],
    );
    return rows.map(parseConfigRow);
  }

  async getVersion(
    storeId: string,
    clientId: string,
    versionId: string,
  ): Promise<ConfigVersionRow | null> {
    const { rows } = await this.db.query<ConfigVersionRow>(
      `SELECT v.id, v.config_id, v.version, v.snapshot, v.created_at_ms
         FROM config_versions v
         JOIN configs c ON c.id = v.config_id
        WHERE c.store_id = $1 AND c.client_config_id = $2 AND v.id = $3`,
      [storeId, clientId, versionId],
    );
    return rows[0] ? parseConfigRow(rows[0]) : null;
  }

  // ---- assets ----

  async insertAsset(input: {
    storeId: string;
    configDbId: string | null;
    objectKey: string;
    originalFilename: string | null;
    contentType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    checksum: string | null;
    clientRef: string | null;
    nowMs: number;
  }): Promise<AssetRow> {
    const { rows } = await this.db.query<AssetRow>(
      `INSERT INTO assets
         (id, store_id, config_id, object_key, original_filename, content_type, size_bytes,
          width, height, checksum_sha256, status, client_ref, created_at_ms, updated_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'stored', $11, $12, $12)
       RETURNING ${ASSET_COLS}`,
      [crypto.randomUUID(), input.storeId, input.configDbId, input.objectKey, input.originalFilename,
       input.contentType, input.sizeBytes, input.width, input.height, input.checksum, input.clientRef,
       input.nowMs],
    );
    return rows[0];
  }

  /** Assets associated (via config_id) to a config. Must be read BEFORE deleting the config, since
   *  ON DELETE SET NULL clears config_id on cascade. */
  async assetsForConfig(storeId: string, configDbId: string): Promise<AssetRow[]> {
    const { rows } = await this.db.query<AssetRow>(
      `SELECT ${ASSET_COLS} FROM assets
        WHERE store_id = $1 AND config_id = $2 AND status = 'stored'`,
      [storeId, configDbId],
    );
    return rows;
  }

  async getAssetById(storeId: string, assetId: string): Promise<AssetRow | null> {
    const { rows } = await this.db.query<AssetRow>(
      `SELECT ${ASSET_COLS} FROM assets WHERE store_id = $1 AND id = $2`,
      [storeId, assetId],
    );
    return rows[0] ?? null;
  }

  async getAssetByClientRef(storeId: string, clientRef: string): Promise<AssetRow | null> {
    const { rows } = await this.db.query<AssetRow>(
      `SELECT ${ASSET_COLS} FROM assets
        WHERE store_id = $1 AND client_ref = $2 AND status = 'stored'`,
      [storeId, clientRef],
    );
    return rows[0] ?? null;
  }

  async listAssets(
    storeId: string,
    opts: { configDbId: string | null; kind?: 'image' | 'font'; page: number; pageSize: number },
  ): Promise<{ rows: AssetRow[]; total: number }> {
    const params: unknown[] = [storeId];
    let where = "store_id = $1 AND status = 'stored'";
    if (opts.configDbId) {
      params.push(opts.configDbId);
      where += ` AND config_id = $${params.length}`;
    }
    if (opts.kind) {
      where += ` AND content_type ${opts.kind === 'font' ? 'LIKE' : 'NOT LIKE'} 'font/%'`;
    }
    const totalResult = await this.db.query<{ count: number }>(
      `SELECT count(*) AS count FROM assets WHERE ${where}`,
      params,
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);
    params.push(opts.pageSize, (opts.page - 1) * opts.pageSize);
    const { rows } = await this.db.query<AssetRow>(
      `SELECT ${ASSET_COLS} FROM assets
        WHERE ${where}
        ORDER BY created_at_ms DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { rows, total };
  }

  async markAssetDeleted(storeId: string, assetId: string, nowMs: number): Promise<void> {
    await this.db.query(
      `UPDATE assets SET status = 'deleted', updated_at_ms = $3
        WHERE store_id = $1 AND id = $2`,
      [storeId, assetId, nowMs],
    );
  }

  /**
   * True when any stored config draft/published OR version snapshot references a needle string.
   * `instr()` (plain substring search), not `LIKE '%'||needle||'%'`: SQLite's LIKE pattern-complexity
   * limit (and D1's, which is tighter still) can reject a pattern built from a long needle like an
   * object key, and `instr` needs no escaping of the needle's own `%`/`_` characters either.
   */
  async isReferenced(storeId: string, needles: readonly string[]): Promise<boolean> {
    for (const needle of needles) {
      if (!needle) continue;
      const { rows } = await this.db.query<{ one: number }>(
        `SELECT 1 AS one FROM configs
           WHERE store_id = $1 AND (instr(draft, $2) > 0 OR instr(coalesce(published, ''), $2) > 0)
         UNION
         SELECT 1 FROM config_versions
           WHERE store_id = $1 AND instr(snapshot, $2) > 0
         LIMIT 1`,
        [storeId, needle],
      );
      if (rows.length > 0) return true;
    }
    return false;
  }
}
