/**
 * D1 (SQLite) access through the native `D1Database` binding.
 *
 * Query text keeps the Postgres-style numbered placeholders ($1, $2, ...) repository code already
 * uses; `toSqliteSql` rewrites them to SQLite's `?1, ?2, ...` right before preparing, so call sites
 * did not need every query renumbered. Dates are bound as ISO-8601 strings (see
 * migrations/d1/0001_baseline.sql for the exact format every timestamp column uses).
 *
 * There is no `transaction()`/`BEGIN` here: D1 has no interactive transactions, only `batch()`, which
 * runs a fixed list of prepared statements as one atomic unit (all succeed or none do) with no
 * branching between them. Callers that need atomicity across statements build the full list up front
 * — read everything first, decide, THEN batch — see database/transactions.ts removal note in each
 * service for how individual call sites were restructured.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Statement {
  text: string;
  params?: readonly unknown[];
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

/** `$1, $2, ...` (kept for readability / diff-minimal ports) -> SQLite's numbered `?1, ?2, ...`. */
export function toSqliteSql(text: string): string {
  return text.replace(/\$(\d+)/g, '?$1');
}

function bindValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function bindParams(params: readonly unknown[]): unknown[] {
  return params.map(bindValue);
}

function toQueryResult<T>(result: D1Result<T>): QueryResult<T> {
  const rows = result.results ?? [];
  // `meta.changes` is SQLite's own row-change count; `meta.rows_written` is a separate D1 resource/
  // billing metric that can overcount (observed: it counts a no-op trigger merely being REGISTERED on
  // the table being written, even when the trigger's WHEN condition never fires) — never use it for
  // business row counts. A RETURNING clause (rows.length) is preferred over either when present, since
  // a cascaded delete in another table inflates `changes` too (RETURNING only reports the directly
  // targeted table's rows).
  if (rows.length > 0) return { rows, rowCount: rows.length };
  const changes = result.meta?.changes;
  return { rows, rowCount: typeof changes === 'number' ? changes : 0 };
}

/** `$3, $4, $5` for `placeholders(3, 3)` — an IN-list of the right length starting at a given index. */
export function placeholders(start: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(', ');
}

/** D1 caps bound parameters per statement at 100 (unlike raw SQLite's much higher default). Any
 *  query that binds one or more params per item in a caller-supplied list must chunk it to stay well
 *  under that — this is the conservative per-chunk item count for `paramsPerItem` bound values each. */
export function chunkForParamLimit<T>(items: readonly T[], paramsPerItem: number, reservedParams = 1): T[][] {
  const perChunk = Math.max(1, Math.floor((90 - reservedParams) / paramsPerItem));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += perChunk) chunks.push(items.slice(i, i + perChunk));
  return chunks;
}

export class Database implements SqlExecutor {
  constructor(private readonly d1: D1Database) {}

  async query<T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.d1
      .prepare(toSqliteSql(text))
      .bind(...bindParams(params))
      .all<T>();
    return toQueryResult(result);
  }

  /** First row or null. */
  async queryOne<T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const { rows } = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /**
   * Runs every statement as one atomic unit — D1's `batch()`. Build the full list from data already
   * read; there is no way to inspect one statement's result before the next runs.
   */
  async batch<T = Record<string, unknown>>(statements: readonly Statement[]): Promise<QueryResult<T>[]> {
    if (statements.length === 0) return [];
    const prepared = statements.map((s) =>
      this.d1.prepare(toSqliteSql(s.text)).bind(...bindParams(s.params ?? [])),
    );
    const results = await this.d1.batch<T>(prepared);
    return results.map((r) => toQueryResult<T>(r));
  }
}

export function createDatabase(d1: D1Database): Database {
  if (!d1) {
    throw new Error('A D1 database binding is required (check the DB binding).');
  }
  return new Database(d1);
}
