/**
 * Append-only audit logging (`personalization.audit_logs`). Records privileged operations with
 * identifiers and small structured metadata only — never tokens, secrets, payload bodies or file bytes.
 */

import type { SqlExecutor } from '../../database/connection';

export interface AuditEntry {
  requestId: string;
  storeId: string;
  actor: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(db: SqlExecutor, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO personalization.audit_logs
       (request_id, store_id, actor, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.requestId,
      entry.storeId,
      entry.actor,
      entry.action,
      entry.resourceType ?? null,
      entry.resourceId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}
