/** SQL for `platform.integration_credentials`. Every query is scoped by store (and plugin). */

import type { SqlExecutor } from '../../database/connection';

export interface CredentialRow {
  id: string;
  store_id: string;
  plugin_id: string;
  label: string;
  secret_encrypted: string;
  status: 'active' | 'revoked';
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  last_used_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
}

const COLS = `id, store_id, plugin_id, label, secret_encrypted, status, expires_at, revoked_at,
  last_used_at, created_by, created_at`;

export class IntegrationCredentialsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async insert(input: {
    id: string;
    storeId: string;
    pluginId: string;
    label: string;
    secretEncrypted: string;
    createdBy: string | null;
  }): Promise<CredentialRow> {
    const { rows } = await this.db.query<CredentialRow>(
      `INSERT INTO platform.integration_credentials
         (id, store_id, plugin_id, label, secret_encrypted, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${COLS}`,
      [input.id, input.storeId, input.pluginId, input.label, input.secretEncrypted, input.createdBy],
    );
    return rows[0];
  }

  async list(storeId: string, pluginId: string): Promise<CredentialRow[]> {
    const { rows } = await this.db.query<CredentialRow>(
      `SELECT ${COLS} FROM platform.integration_credentials
        WHERE store_id = $1 AND plugin_id = $2
        ORDER BY created_at DESC, id`,
      [storeId, pluginId],
    );
    return rows;
  }

  async get(storeId: string, pluginId: string, id: string): Promise<CredentialRow | null> {
    const { rows } = await this.db.query<CredentialRow>(
      `SELECT ${COLS} FROM platform.integration_credentials
        WHERE store_id = $1 AND plugin_id = $2 AND id = $3`,
      [storeId, pluginId, id],
    );
    return rows[0] ?? null;
  }

  /** Lookup for signature verification: the store is NOT known yet, it is derived from this row. */
  async findForVerification(pluginId: string, id: string, at: Date): Promise<CredentialRow | null> {
    const { rows } = await this.db.query<CredentialRow>(
      `SELECT ${COLS} FROM platform.integration_credentials
        WHERE plugin_id = $1 AND id = $2 AND status = 'active'
          AND (expires_at IS NULL OR expires_at > $3)`,
      [pluginId, id, at],
    );
    return rows[0] ?? null;
  }

  async setExpiry(storeId: string, pluginId: string, id: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE platform.integration_credentials SET expires_at = $4
        WHERE store_id = $1 AND plugin_id = $2 AND id = $3 AND status = 'active'`,
      [storeId, pluginId, id, expiresAt],
    );
  }

  async revoke(storeId: string, pluginId: string, id: string, at: Date): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE platform.integration_credentials SET status = 'revoked', revoked_at = $4
        WHERE store_id = $1 AND plugin_id = $2 AND id = $3 AND status = 'active'`,
      [storeId, pluginId, id, at],
    );
    return rowCount > 0;
  }

  /** Throttled to one write a minute per credential so a busy integration does not write per call. */
  async touch(id: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE platform.integration_credentials SET last_used_at = $2
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $2::timestamptz - interval '1 minute')`,
      [id, at],
    );
  }
}
