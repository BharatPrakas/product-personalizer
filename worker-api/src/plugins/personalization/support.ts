/**
 * Small helpers shared by the mapping, markup and settings services: the request-scoped context, the
 * never-failing audit write, and Postgres error inspection.
 */

import type { Database } from '../../database/connection';
import type { Logger } from '../../shared/logger';
import { recordAudit } from '../../platform/tenant-management/audit';
import { PLUGIN_ID } from './types';

/** Request-scoped context for services that need no object storage. `storeId` comes from the token. */
export interface PluginContext {
  db: Database;
  logger: Logger;
  storeId: string;
  requestId: string;
  actor: string | null;
}

export async function writeAudit(
  ctx: PluginContext,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await recordAudit(ctx.db, {
      requestId: ctx.requestId,
      storeId: ctx.storeId,
      pluginId: PLUGIN_ID,
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
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}

export function stamp(previous?: number): number {
  const now = Date.now();
  return previous !== undefined ? Math.max(now, previous + 1) : now;
}
