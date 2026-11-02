/**
 * SQL for `personalization.integration_credentials`. Queries are scoped by store, except the
 * verification lookup and `touch`, which start from the credential id (the store comes from the row).
 */

import type { SqlExecutor } from '../../database/connection';

export interface CredentialRow {
  id: string;
  store_id: string;
  label: string;
  secret_encrypted: string;
  status: 'active' | 'revoked';
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  last_used_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
}

const COLS = `id, store_id, label, secret_encrypted, status, expires_at, revoked_at,
  last_used_at, created_by, created_at`;

export class IntegrationCredentialsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async insert(input: {
    id: string;
    storeId: string;
    label: string;
    secretEncrypted: string;
    createdBy: string | null;
  }): Promise<CredentialRow> {
    const { rows } = await this.db.query<CredentialRow>(
      `INSERT INTO personalization.integration_credentials
         (id, store_id, label, secret_encrypted, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLS}`,
      [input.id, input.storeId, input.label, input.secretEncrypted, input.createdBy],
    );
    return rows[0];
  }

  async list(storeId: string): Promise<CredentialRow[]> {
    const { rows } = await this.db.query<CredentialRow>(
      `SELECT ${COLS} FROM personalization.integration_credentials
        WHERE store_id = $1
        ORDER BY created_at DESC, id`,
      [storeId],
    );
    return rows;
  }

  async get(storeId: string, id: string): Promise<CredentialRow | null> {
    const { rows } = await this.db.query<CredentialRow>(
      `SELECT ${COLS} FROM personalization.integration_credentials
        WHERE store_id = $1 AND id = $2`,
      [storeId, id],
    );
    return rows[0] ?? null;
  }

  /** Lookup for signature verification: the store is NOT known yet, it is derived from this row. */
  async findForVerification(id: string, at: Date): Promise<CredentialRow | null> {
    const { rows } = await this.db.query<CredentialRow>(
      `SELECT ${COLS} FROM personalization.integration_credentials
        WHERE id = $1 AND status = 'active'
          AND (expires_at IS NULL OR expires_at > $2)`,
      [id, at],
    );
    return rows[0] ?? null;
  }

  async setExpiry(storeId: string, id: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE personalization.integration_credentials SET expires_at = $3
        WHERE store_id = $1 AND id = $2 AND status = 'active'`,
      [storeId, id, expiresAt],
    );
  }

  async revoke(storeId: string, id: string, at: Date): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE personalization.integration_credentials SET status = 'revoked', revoked_at = $3
        WHERE store_id = $1 AND id = $2 AND status = 'active'`,
      [storeId, id, at],
    );
    return rowCount > 0;
  }

  /** Throttled to one write a minute per credential so a busy integration does not write per call. */
  async touch(id: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE personalization.integration_credentials SET last_used_at = $2
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $2::timestamptz - interval '1 minute')`,
      [id, at],
    );
  }
}
