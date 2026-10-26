/**
 * Append-only audit logging (`platform.audit_logs`). Records privileged operations with identifiers
 * and small structured metadata only — never tokens, secrets, payload bodies or file bytes.
 */

import type { SqlExecutor } from '../../database/connection';

export interface AuditEntry {
  requestId: string;
  storeId: string;
  pluginId: string;
  actor: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(db: SqlExecutor, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO platform.audit_logs
       (request_id, store_id, plugin_id, actor, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.requestId,
      entry.storeId,
      entry.pluginId,
      entry.actor,
      entry.action,
      entry.resourceType ?? null,
      entry.resourceId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}
