/**
 * Data access for product mappings. EVERY query is scoped by `store_id`; the join to `configs` is
 * also constrained to the same store. Constructed with an `SqlExecutor` (request DB or open
 * transaction) so the service can compose multi-statement operations atomically.
 */

import type { SqlExecutor } from '../../database/connection';
import type { Cursor } from './pagination';
import type { MappingScope } from './types';

export interface MappingRow {
  id: string;
  store_id: string;
  config_id: string;
  scope: MappingScope;
  external_id: string;
  label: string | null;
  created_at_ms: string;
  updated_at_ms: string;
  client_config_id: string;
  config_name: string;
  config_published: boolean;
  config_archived_at_ms: string | null;
}

export interface ConfigRef {
  id: string;
  client_config_id: string;
  name: string;
  archived_at_ms: string | null;
}

export interface MappingTarget {
  scope: MappingScope;
  externalId: string;
}

export interface NewMapping extends MappingTarget {
  label: string | null;
}

const COLS = `m.id, m.store_id, m.config_id, m.scope, m.external_id, m.label,
  m.created_at_ms, m.updated_at_ms,
  c.client_config_id, c.name AS config_name, (c.published IS NOT NULL) AS config_published,
  c.archived_at_ms AS config_archived_at_ms`;
const FROM = `personalization.mappings m
  JOIN personalization.configs c ON c.id = m.config_id AND c.store_id = m.store_id`;

export class MappingRepository {
  constructor(private readonly db: SqlExecutor) {}

  /** Lightweight config lookup by client id; `lock` takes a share lock so it cannot vanish mid-tx. */
  async getConfigRef(storeId: string, clientId: string, lock = false): Promise<ConfigRef | null> {
    const { rows } = await this.db.query<ConfigRef>(
      `SELECT id, client_config_id, name, archived_at_ms FROM personalization.configs
        WHERE store_id = $1 AND client_config_id = $2${lock ? ' FOR SHARE' : ''}`,
      [storeId, clientId],
    );
    return rows[0] ?? null;
  }

  async list(
    storeId: string,
    opts: {
      configClientId?: string;
      scope?: MappingScope;
      externalId?: string;
      limit: number;
      cursor: Cursor | null;
    },
  ): Promise<MappingRow[]> {
    const params: unknown[] = [storeId];
    let where = 'm.store_id = $1';
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where += ` AND ${clause.replace('?', `$${params.length}`)}`;
    };
    if (opts.configClientId !== undefined) add('c.client_config_id = ?', opts.configClientId);
    if (opts.scope !== undefined) add('m.scope = ?', opts.scope);
    if (opts.externalId !== undefined) add('m.external_id = ?', opts.externalId);
    if (opts.cursor) {
      params.push(opts.cursor.createdAtMs, opts.cursor.id);
      where += ` AND (m.created_at_ms, m.id) < ($${params.length - 1}::bigint, $${params.length}::uuid)`;
    }
    params.push(opts.limit + 1);
    const { rows } = await this.db.query<MappingRow>(
      `SELECT ${COLS} FROM ${FROM}
        WHERE ${where}
        ORDER BY m.created_at_ms DESC, m.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async getById(storeId: string, id: string, lock = false): Promise<MappingRow | null> {
    const { rows } = await this.db.query<MappingRow>(
      `SELECT ${COLS} FROM ${FROM}
        WHERE m.store_id = $1 AND m.id = $2${lock ? ' FOR UPDATE OF m' : ''}`,
      [storeId, id],
    );
    return rows[0] ?? null;
  }

  async getByIds(storeId: string, ids: readonly string[]): Promise<MappingRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<MappingRow>(
      `SELECT ${COLS} FROM ${FROM} WHERE m.store_id = $1 AND m.id = ANY($2::uuid[])`,
      [storeId, ids],
    );
    return rows;
  }

  /** Existing mappings for a set of (scope, externalId) targets, row-locked for the transaction. */
  async findByTargets(storeId: string, targets: readonly MappingTarget[]): Promise<MappingRow[]> {
    if (targets.length === 0) return [];
    const { rows } = await this.db.query<MappingRow>(
      `SELECT ${COLS} FROM ${FROM}
         JOIN unnest($2::text[], $3::text[]) AS t(scope, external_id)
           ON t.scope = m.scope AND t.external_id = m.external_id
        WHERE m.store_id = $1
          FOR UPDATE OF m`,
      [storeId, targets.map((t) => t.scope), targets.map((t) => t.externalId)],
    );
    return rows;
  }

  /** Insert, skipping targets that already exist (a concurrent writer won). Returns inserted rows. */
  async insertMany(
    storeId: string,
    configDbId: string,
    items: readonly NewMapping[],
    nowMs: number,
  ): Promise<Array<{ id: string; scope: MappingScope; external_id: string }>> {
    if (items.length === 0) return [];
    const { rows } = await this.db.query<{ id: string; scope: MappingScope; external_id: string }>(
      `INSERT INTO personalization.mappings
         (store_id, config_id, scope, external_id, label, created_at_ms, updated_at_ms)
       SELECT $1, $2, t.scope, t.external_id, t.label, $6::bigint, $6::bigint
         FROM unnest($3::text[], $4::text[], $5::text[]) AS t(scope, external_id, label)
       ON CONFLICT (store_id, scope, external_id) DO NOTHING
       RETURNING id, scope, external_id`,
      [
        storeId,
        configDbId,
        items.map((i) => i.scope),
        items.map((i) => i.externalId),
        items.map((i) => i.label),
        nowMs,
      ],
    );
    return rows;
  }

  /** Point mappings at another configuration (store-scoped, so a foreign id is a no-op). */
  async moveMany(storeId: string, ids: readonly string[], configDbId: string, nowMs: number): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query(
      `UPDATE personalization.mappings
          SET config_id = $3, updated_at_ms = $4, updated_at = now()
        WHERE store_id = $1 AND id = ANY($2::uuid[])`,
      [storeId, ids, configDbId, nowMs],
    );
  }

  async setLabel(storeId: string, id: string, label: string | null, nowMs: number): Promise<void> {
    await this.db.query(
      `UPDATE personalization.mappings
          SET label = $3, updated_at_ms = $4, updated_at = now()
        WHERE store_id = $1 AND id = $2`,
      [storeId, id, label, nowMs],
    );
  }

  async deleteOne(storeId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM personalization.mappings WHERE store_id = $1 AND id = $2`,
      [storeId, id],
    );
    return rowCount > 0;
  }

  async deleteMany(storeId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { rowCount } = await this.db.query(
      `DELETE FROM personalization.mappings WHERE store_id = $1 AND id = ANY($2::uuid[])`,
      [storeId, ids],
    );
    return rowCount;
  }
}
