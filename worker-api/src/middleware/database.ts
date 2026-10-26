/**
 * Opens one Postgres client per request (Hyperdrive pools at the edge) and guarantees it is closed
 * once the response is produced. The client is created lazily on first `c.get('db')` use, so routes
 * that never touch the database (health, CORS preflight) open no connection.
 */

import type { MiddlewareHandler } from 'hono';
import { createDatabase, type Database } from '../database/connection';
import type { AppEnv } from '../shared/context';

export const withDatabase: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Held in an object so the finally block sees mutations made inside the proxy closure.
  const holder: { db: Database | null } = { db: null };
  const lazy = new Proxy({} as Database, {
    get(_target, prop) {
      holder.db ??= createDatabase(c.env.HYPERDRIVE.connectionString);
      const value = (holder.db as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? value.bind(holder.db) : value;
    },
  });
  c.set('db', lazy);

  try {
    await next();
  } finally {
    const open = holder.db;
    if (open) {
      const waitUntil = c.executionCtx?.waitUntil?.bind(c.executionCtx);
      if (waitUntil) waitUntil(open.close());
      else await open.close();
    }
  }
};
