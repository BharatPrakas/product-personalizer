/**
 * Transaction helpers layered on top of `Database.transaction`. The retry helper re-runs a
 * transaction body on transient Postgres errors (deadlock / serialization failure) with a small
 * bounded backoff. Business conflicts (our own optimistic-concurrency check) are NOT retried — they
 * surface to the caller as a 409.
 */

import type { Database, SqlExecutor } from './connection';

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);
const MAX_ATTEMPTS = 3;

function isRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    RETRYABLE_SQLSTATES.has((error as { code: string }).code)
  );
}

export async function runInTransaction<T>(
  db: Database,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await db.transaction(fn);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
  throw lastError;
}
