/**
 * PostgreSQL access through Hyperdrive, using node-postgres (`pg`).
 *
 * Runtime notes that are easy to get wrong:
 *  - `pg` only runs on the Workers runtime with `compatibility_flags: ["nodejs_compat"]` and a recent
 *    `compatibility_date` (set in wrangler.jsonc). A plain Node example will NOT work unchanged.
 *  - Hyperdrive already pools connections at the edge, so we open ONE short-lived client per request
 *    rather than a per-request pool, and close it after the response via `waitUntil`.
 *  - Transactions are kept short and never wrap an R2 network call (see service layer).
 *
 * The same code runs in Node for tests by pointing the connection string at a local Postgres.
 */

import pg from 'pg';

const { Client } = pg;

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export class Database implements SqlExecutor {
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private readonly connectionString: string) {}

  private async ensure(): Promise<pg.Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = new Client({
        connectionString: this.connectionString,
        // Hyperdrive terminates TLS to the origin; the Worker<->Hyperdrive hop is internal.
        // For local Postgres over 127.0.0.1 TLS is not used.
        application_name: 'zb-plugin-platform',
      });
      await client.connect();
      this.client = client;
    })();
    await this.connecting;
    return this.client!;
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const client = await this.ensure();
    const result = await client.query(text, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
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
   * Run `fn` inside a single transaction. Commits on success, rolls back on any throw. Keep the body
   * short — do all R2 / network work outside the transaction.
   */
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.ensure();
    await client.query('BEGIN');
    try {
      const executor: SqlExecutor = {
        query: async <R>(text: string, params: readonly unknown[] = []) => {
          const result = await client.query(text, params as unknown[]);
          return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
        },
      };
      const value = await fn(executor);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is being discarded anyway; surface the original error.
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (client) await client.end();
  }
}

export function createDatabase(connectionString: string): Database {
  if (!connectionString) {
    throw new Error('A PostgreSQL connection string is required (check the HYPERDRIVE binding).');
  }
  return new Database(connectionString);
}
