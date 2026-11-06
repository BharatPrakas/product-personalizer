/**
 * Small helpers shared by the mapping, markup and settings services: the request-scoped context, the
 * never-failing audit write, and D1/SQLite constraint-violation inspection.
 */

import type { Database } from '../../database/connection';
import type { Logger } from '../../shared/logger';
import { recordAudit } from '../audit/audit';

/** Request-scoped context for services that need no object storage. `storeId` comes from the token. */
export interface StoreContext {
  db: Database;
  logger: Logger;
  storeId: string;
  requestId: string;
  actor: string | null;
}

export async function writeAudit(
  ctx: StoreContext,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await recordAudit(ctx.db, {
      requestId: ctx.requestId,
      storeId: ctx.storeId,
      actor: ctx.actor,
      action,
      resourceType,
      resourceId,
      metadata,
    });
  } catch (error) {
    // Audit must never fail the operation; log and continue.
    ctx.logger.warn('audit write failed', { action, error: String(error) });
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('FOREIGN KEY constraint failed');
}

export function stamp(previous?: number): number {
  const now = Date.now();
  return previous !== undefined ? Math.max(now, previous + 1) : now;
}
