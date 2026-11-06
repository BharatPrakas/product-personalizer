/**
 * Data access for product mappings. EVERY query is scoped by `store_id`; the join to `configs` is
 * also constrained to the same store. Constructed with the `Database` so the service can compose
 * multi-statement operations into one atomic `batch()`.
 */

import { chunkForParamLimit, placeholders, type Database, type Statement } from '../../database/connection';
import type { Cursor } from './pagination';
import type { MappingScope } from './types';

export interface MappingRow {
  id: string;
  store_id: string;
  config_id: string;
  scope: MappingScope;
  external_id: string;
  label: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  client_config_id: string;
  config_name: string;
  config_published: number;
  config_archived_at_ms: number | null;
}

export interface ConfigRef {
  id: string;
  client_config_id: string;
  name: string;
  archived_at_ms: number | null;
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
const FROM = `mappings m
  JOIN configs c ON c.id = m.config_id AND c.store_id = m.store_id`;

export class MappingRepository {
  constructor(private readonly db: Database) {}

  /** Lightweight config lookup by client id. D1 has no row locking; callers rely on the conditional
   *  writes below (ON CONFLICT / affected-row checks) to stay correct under concurrent writers. */
  async getConfigRef(storeId: string, clientId: string): Promise<ConfigRef | null> {
    const { rows } = await this.db.query<ConfigRef>(
      `SELECT id, client_config_id, name, archived_at_ms FROM configs
        WHERE store_id = $1 AND client_config_id = $2`,
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
      where += ` AND (m.created_at_ms, m.id) < ($${params.length - 1}, $${params.length})`;
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

  async getById(storeId: string, id: string): Promise<MappingRow | null> {
    const { rows } = await this.db.query<MappingRow>(
      `SELECT ${COLS} FROM ${FROM}
        WHERE m.store_id = $1 AND m.id = $2`,
      [storeId, id],
    );
    return rows[0] ?? null;
  }

  async getByIds(storeId: string, ids: readonly string[]): Promise<MappingRow[]> {
    if (ids.length === 0) return [];
    const rows: MappingRow[] = [];
    for (const idChunk of chunkForParamLimit(ids, 1)) {
      const { rows: chunkRows } = await this.db.query<MappingRow>(
        `SELECT ${COLS} FROM ${FROM} WHERE m.store_id = $1 AND m.id IN (${placeholders(2, idChunk.length)})`,
        [storeId, ...idChunk],
      );
      rows.push(...chunkRows);
    }
    return rows;
  }

  /**
   * Existing mappings for a set of (scope, externalId) targets. D1 caps bound parameters at 100 (far
   * below raw SQLite's default), so a large bulk request is chunked into several queries.
   */
  async findByTargets(storeId: string, targets: readonly MappingTarget[]): Promise<MappingRow[]> {
    if (targets.length === 0) return [];
    const rows: MappingRow[] = [];
    for (const targetChunk of chunkForParamLimit(targets, 2)) {
      // SQLite has no unnest(), and this build's SQLite does not support naming a VALUES table's
      // columns (`AS t(a, b)`) — only its default positional names (`column1`, `column2`, ...).
      const rowsSql = targetChunk.map((_, i) => `($${2 + i * 2}, $${3 + i * 2})`).join(', ');
      const params: unknown[] = [storeId];
      for (const t of targetChunk) params.push(t.scope, t.externalId);
      const { rows: chunkRows } = await this.db.query<MappingRow>(
        `SELECT ${COLS} FROM ${FROM}
           JOIN (VALUES ${rowsSql}) AS t
             ON t.column1 = m.scope AND t.column2 = m.external_id
          WHERE m.store_id = $1`,
        params,
      );
      rows.push(...chunkRows);
    }
    return rows;
  }

  /**
   * One `INSERT ... VALUES ...` per item, not a bulk `INSERT ... SELECT ... FROM (VALUES ...)`: this
   * build's SQLite mis-parses `FROM (VALUES ...) AS t ON CONFLICT ...` (it reads `t ON` as a join
   * condition, not the upsert clause, and chokes on the `DO` that follows) — `INSERT ... VALUES ...`
   * has no such ambiguity. Returns a Statement, not executed, so callers can batch several together.
   */
  insertStatement(storeId: string, configDbId: string, item: NewMapping, nowMs: number): Statement {
    return {
      text: `INSERT INTO mappings (id, store_id, config_id, scope, external_id, label, created_at_ms, updated_at_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
             ON CONFLICT (store_id, scope, external_id) DO NOTHING
             RETURNING id, scope, external_id`,
      params: [crypto.randomUUID(), storeId, configDbId, item.scope, item.externalId, item.label, nowMs],
    };
  }

  /** Insert, skipping targets that already exist (a concurrent writer won). Returns inserted rows. */
  async insertMany(
    storeId: string,
    configDbId: string,
    items: readonly NewMapping[],
    nowMs: number,
  ): Promise<Array<{ id: string; scope: MappingScope; external_id: string }>> {
    if (items.length === 0) return [];
    const statements = items.map((item) => this.insertStatement(storeId, configDbId, item, nowMs));
    const results = await this.db.batch<{ id: string; scope: MappingScope; external_id: string }>(statements);
    return results.flatMap((r) => r.rows);
  }

  /** Point mappings at another configuration (store-scoped, so a foreign id is a no-op). Chunked into
   *  several statements (not executed) so callers can batch them with other writes. */
  moveManyStatements(storeId: string, ids: readonly string[], configDbId: string, nowMs: number): Statement[] {
    return chunkForParamLimit(ids, 1, 3).map((idChunk) => ({
      text: `UPDATE mappings
                SET config_id = $2, updated_at_ms = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE store_id = $1 AND id IN (${placeholders(4, idChunk.length)})`,
      params: [storeId, configDbId, nowMs, ...idChunk],
    }));
  }

  async moveMany(storeId: string, ids: readonly string[], configDbId: string, nowMs: number): Promise<void> {
    if (ids.length === 0) return;
    for (const stmt of this.moveManyStatements(storeId, ids, configDbId, nowMs)) {
      await this.db.query(stmt.text, stmt.params);
    }
  }

  setLabelStatement(storeId: string, id: string, label: string | null, nowMs: number): Statement {
    return {
      text: `UPDATE mappings
                SET label = $3, updated_at_ms = $4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE store_id = $1 AND id = $2`,
      params: [storeId, id, label, nowMs],
    };
  }

  async setLabel(storeId: string, id: string, label: string | null, nowMs: number): Promise<void> {
    const stmt = this.setLabelStatement(storeId, id, label, nowMs);
    await this.db.query(stmt.text, stmt.params);
  }

  async deleteOne(storeId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM mappings WHERE store_id = $1 AND id = $2`,
      [storeId, id],
    );
    return rowCount > 0;
  }

  /** Chunked, not executed, so callers can fold these into a larger atomic batch. */
  deleteManyStatements(storeId: string, ids: readonly string[]): Statement[] {
    return chunkForParamLimit(ids, 1).map((idChunk) => ({
      text: `DELETE FROM mappings WHERE store_id = $1 AND id IN (${placeholders(2, idChunk.length)})`,
      params: [storeId, ...idChunk],
    }));
  }

  async deleteMany(storeId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    let total = 0;
    for (const stmt of this.deleteManyStatements(storeId, ids)) {
      const { rowCount } = await this.db.query(stmt.text, stmt.params);
      total += rowCount;
    }
    return total;
  }
}
