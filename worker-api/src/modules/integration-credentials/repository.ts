/**
 * SQL for `integration_credentials`. Queries are scoped by store, except the verification lookup and
 * `touch`, which start from the credential id (the store comes from the row).
 */

import type { Database, Statement } from '../../database/connection';

export interface CredentialRow {
  id: string;
  store_id: string;
  label: string;
  secret_encrypted: string;
  status: 'active' | 'revoked';
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
}

const COLS = `id, store_id, label, secret_encrypted, status, expires_at, revoked_at,
  last_used_at, created_by, created_at`;

export class IntegrationCredentialsRepository {
  constructor(private readonly db: Database) {}

  insertStatement(input: {
    id: string;
    storeId: string;
    label: string;
    secretEncrypted: string;
    createdBy: string | null;
  }): Statement {
    return {
      text: `INSERT INTO integration_credentials
               (id, store_id, label, secret_encrypted, created_by)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING ${COLS}`,
      params: [input.id, input.storeId, input.label, input.secretEncrypted, input.createdBy],
    };
  }

  async insert(input: {
    id: string;
    storeId: string;
    label: string;
    secretEncrypted: string;
    createdBy: string | null;
  }): Promise<CredentialRow> {
    const stmt = this.insertStatement(input);
    const { rows } = await this.db.query<CredentialRow>(stmt.text, stmt.params);
    return rows[0];
  }

  async list(storeId: string): Promise<CredentialRow[]> {
    const { rows } = await this.db.query<CredentialRow>(
      `SELECT ${COLS} FROM integration_credentials
        WHERE store_id = $1
        ORDER BY created_at DESC, id`,
      [storeId],
    );
    return rows;
  }

  async get(storeId: string, id: string): Promise<CredentialRow | null> {
    const { rows } = await this.db.query<CredentialRow>(
      `SELECT ${COLS} FROM integration_credentials
        WHERE store_id = $1 AND id = $2`,
      [storeId, id],
    );
    return rows[0] ?? null;
  }

  /** Lookup for signature verification: the store is NOT known yet, it is derived from this row. */
  async findForVerification(id: string, at: Date): Promise<CredentialRow | null> {
    const { rows } = await this.db.query<CredentialRow>(
      `SELECT ${COLS} FROM integration_credentials
        WHERE id = $1 AND status = 'active'
          AND (expires_at IS NULL OR expires_at > $2)`,
      [id, at],
    );
    return rows[0] ?? null;
  }

  setExpiryStatement(storeId: string, id: string, expiresAt: Date): Statement {
    return {
      text: `UPDATE integration_credentials SET expires_at = $3
              WHERE store_id = $1 AND id = $2 AND status = 'active'`,
      params: [storeId, id, expiresAt],
    };
  }

  async setExpiry(storeId: string, id: string, expiresAt: Date): Promise<void> {
    const stmt = this.setExpiryStatement(storeId, id, expiresAt);
    await this.db.query(stmt.text, stmt.params);
  }

  revokeStatement(storeId: string, id: string, at: Date): Statement {
    return {
      text: `UPDATE integration_credentials SET status = 'revoked', revoked_at = $3
              WHERE store_id = $1 AND id = $2 AND status = 'active'`,
      params: [storeId, id, at],
    };
  }

  async revoke(storeId: string, id: string, at: Date): Promise<boolean> {
    const stmt = this.revokeStatement(storeId, id, at);
    const { rowCount } = await this.db.query(stmt.text, stmt.params);
    return rowCount > 0;
  }

  /** Throttled to one write a minute per credential so a busy integration does not write per call. */
  async touch(id: string, at: Date): Promise<void> {
    const cutoff = new Date(at.getTime() - 60_000).toISOString();
    await this.db.query(
      `UPDATE integration_credentials SET last_used_at = $2
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $3)`,
      [id, at, cutoff],
    );
  }
}
