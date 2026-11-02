/**
 * Markups: reusable, merchant-authored JSON snippets (printable-area / artwork markup), unique by
 * (store, kind, case-insensitive name). The payload is an opaque JSON object — bounded in size and
 * depth — that this service stores verbatim and never interprets.
 */

import type { SqlExecutor } from '../../database/connection';
import { ApiError, NotFoundError, ValidationError } from '../../shared/errors';
import { decodeCursor, encodeCursor, type Cursor } from './pagination';
import { type StoreContext, isUniqueViolation, stamp, writeAudit } from './support';
import type { CursorPageMeta, MarkupDto, MarkupKind } from './types';
import { validateMarkupPayload } from './validation';

interface MarkupRow {
  id: string;
  store_id: string;
  name: string;
  kind: MarkupKind;
  payload: Record<string, unknown>;
  created_at_ms: string;
  updated_at_ms: string;
}

const COLS = 'id, store_id, name, kind, payload, created_at_ms, updated_at_ms';

function toDto(row: MarkupRow): MarkupDto {
  return {
    id: row.id,
    storeId: row.store_id,
    name: row.name,
    kind: row.kind,
    payload: row.payload,
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
  };
}

const nameTaken = () =>
  new ApiError(409, 'markup_name_taken', 'A markup with this name already exists for this kind.');

/** Escape LIKE metacharacters so a search term is matched literally. */
const likeEscape = (term: string) => term.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export class MarkupRepository {
  constructor(private readonly db: SqlExecutor) {}

  async list(
    storeId: string,
    opts: { kind?: MarkupKind; search?: string; limit: number; cursor: Cursor | null },
  ): Promise<MarkupRow[]> {
    const params: unknown[] = [storeId];
    let where = 'store_id = $1';
    if (opts.kind) {
      params.push(opts.kind);
      where += ` AND kind = $${params.length}`;
    }
    if (opts.search) {
      params.push(`%${likeEscape(opts.search)}%`);
      where += ` AND name ILIKE $${params.length} ESCAPE '\\'`;
    }
    if (opts.cursor) {
      params.push(opts.cursor.createdAtMs, opts.cursor.id);
      where += ` AND (created_at_ms, id) < ($${params.length - 1}::bigint, $${params.length}::uuid)`;
    }
    params.push(opts.limit + 1);
    const { rows } = await this.db.query<MarkupRow>(
      `SELECT ${COLS} FROM personalization.markups
        WHERE ${where}
        ORDER BY created_at_ms DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async insert(
    storeId: string,
    input: { name: string; kind: MarkupKind; payload: Record<string, unknown>; nowMs: number },
  ): Promise<MarkupRow> {
    const { rows } = await this.db.query<MarkupRow>(
      `INSERT INTO personalization.markups
         (store_id, name, kind, payload, created_at_ms, updated_at_ms)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5)
       RETURNING ${COLS}`,
      [storeId, input.name, input.kind, JSON.stringify(input.payload), input.nowMs],
    );
    return rows[0];
  }

  async update(
    storeId: string,
    id: string,
    input: { name?: string; payload?: Record<string, unknown>; nowMs: number },
  ): Promise<MarkupRow | null> {
    const { rows } = await this.db.query<MarkupRow>(
      `UPDATE personalization.markups
          SET name = COALESCE($3, name), payload = COALESCE($4::jsonb, payload),
              updated_at_ms = GREATEST($5::bigint, updated_at_ms + 1), updated_at = now()
        WHERE store_id = $1 AND id = $2
        RETURNING ${COLS}`,
      [storeId, id, input.name ?? null, input.payload ? JSON.stringify(input.payload) : null, input.nowMs],
    );
    return rows[0] ?? null;
  }

  async delete(storeId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM personalization.markups WHERE store_id = $1 AND id = $2',
      [storeId, id],
    );
    return rowCount > 0;
  }
}

export class MarkupService {
  private readonly repo: MarkupRepository;

  constructor(private readonly ctx: StoreContext) {
    this.repo = new MarkupRepository(ctx.db);
  }

  private assertPayload(payload: unknown): asserts payload is Record<string, unknown> {
    const result = validateMarkupPayload(payload);
    if (!result.ok) throw new ValidationError(result.issues);
  }

  async list(opts: {
    kind?: MarkupKind;
    search?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: MarkupDto[]; page: CursorPageMeta }> {
    const rows = await this.repo.list(this.ctx.storeId, { ...opts, cursor: decodeCursor(opts.cursor) });
    const hasMore = rows.length > opts.limit;
    const pageRows = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(toDto),
      page: {
        limit: opts.limit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor({ createdAtMs: Number(last.created_at_ms), id: last.id }) : null,
      },
    };
  }

  async create(input: { name: string; kind: MarkupKind; payload: unknown }): Promise<MarkupDto> {
    this.assertPayload(input.payload);
    try {
      const row = await this.repo.insert(this.ctx.storeId, {
        name: input.name,
        kind: input.kind,
        payload: input.payload,
        nowMs: stamp(),
      });
      await writeAudit(this.ctx, 'markup.create', 'markup', row.id, { kind: row.kind });
      return toDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async update(id: string, input: { name?: string; payload?: unknown }): Promise<MarkupDto> {
    if (input.payload !== undefined) this.assertPayload(input.payload);
    try {
      const row = await this.repo.update(this.ctx.storeId, id, {
        name: input.name,
        payload: input.payload as Record<string, unknown> | undefined,
        nowMs: stamp(),
      });
      if (!row) throw new NotFoundError('That markup was not found.');
      await writeAudit(this.ctx, 'markup.update', 'markup', row.id);
      return toDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    if (!(await this.repo.delete(this.ctx.storeId, id))) throw new NotFoundError('That markup was not found.');
    await writeAudit(this.ctx, 'markup.delete', 'markup', id);
  }
}
