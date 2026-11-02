/**
 * Integration credentials: issue, rotate, revoke, list — and resolve a verified credential for an
 * incoming signed request.
 *
 * Secret handling rules (enforced here, so no caller can get them wrong):
 *  - the plaintext secret is returned exactly once, from `create` / `rotate`;
 *  - listings expose metadata only — there is no code path that decrypts a secret for display;
 *  - the secret is never logged or written to the audit trail (only the credential id is).
 */

import type { Database } from '../../database/connection';
import { runInTransaction } from '../../database/transactions';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../../shared/errors';
import { decryptSecret, encryptSecret, generateSecret, parseMasterKey } from './crypto';
import { IntegrationCredentialsRepository, type CredentialRow } from './repository';

export interface CredentialMetadataDto {
  id: string;
  label: string;
  status: 'active' | 'revoked';
  /** Set once the credential has been rotated out; it stops working at this instant. */
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface IssuedCredentialDto extends CredentialMetadataDto {
  /** Shown exactly once. Store it in the integrating backend's secret manager. */
  secret: string;
}

export interface VerifiedCredential {
  id: string;
  storeId: string;
  secret: string;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

function toMetadata(row: CredentialRow): CredentialMetadataDto {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    lastUsedAt: iso(row.last_used_at),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export const DEFAULT_ROTATION_GRACE_SECONDS = 24 * 60 * 60;

export class IntegrationCredentialsService {
  private readonly repo: IntegrationCredentialsRepository;

  constructor(
    private readonly db: Database,
    private readonly pluginId: string,
    /** Raw `INTEGRATION_ENCRYPTION_KEY`, or null when it is not configured. */
    private readonly encryptionKey: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repo = new IntegrationCredentialsRepository(db);
  }

  private masterKey(): Buffer {
    if (!this.encryptionKey) {
      throw new ServiceUnavailableError('integrations_not_configured', 'Integration credentials are not configured on this environment.');
    }
    return parseMasterKey(this.encryptionKey);
  }

  async create(storeId: string, label: string, createdBy: string | null): Promise<IssuedCredentialDto> {
    const key = this.masterKey();
    const id = crypto.randomUUID();
    const secret = generateSecret();
    const row = await this.repo.insert({
      id,
      storeId,
      pluginId: this.pluginId,
      label,
      secretEncrypted: encryptSecret(key, storeId, id, secret),
      createdBy,
    });
    return { ...toMetadata(row), secret };
  }

  async list(storeId: string): Promise<CredentialMetadataDto[]> {
    return (await this.repo.list(storeId, this.pluginId)).map(toMetadata);
  }

  /**
   * Issue a replacement and let the old credential keep working for `graceSeconds` (0 = revoke it
   * immediately), so the integrating backend can deploy the new secret without downtime.
   */
  async rotate(
    storeId: string,
    id: string,
    graceSeconds: number,
    createdBy: string | null,
  ): Promise<{ credential: IssuedCredentialDto; previous: CredentialMetadataDto }> {
    const key = this.masterKey();
    const at = this.now();
    const newId = crypto.randomUUID();
    const secret = generateSecret();
    const { fresh, previous } = await runInTransaction(this.db, async (tx) => {
      const repo = new IntegrationCredentialsRepository(tx);
      const current = await repo.get(storeId, this.pluginId, id);
      if (!current) throw new NotFoundError('That credential was not found.');
      if (current.status !== 'active') throw new ConflictError('That credential is already revoked.');
      const inserted = await repo.insert({
        id: newId,
        storeId,
        pluginId: this.pluginId,
        label: current.label,
        secretEncrypted: encryptSecret(key, storeId, newId, secret),
        createdBy,
      });
      if (graceSeconds <= 0) await repo.revoke(storeId, this.pluginId, id, at);
      else await repo.setExpiry(storeId, this.pluginId, id, new Date(at.getTime() + graceSeconds * 1000));
      return { fresh: inserted, previous: (await repo.get(storeId, this.pluginId, id))! };
    });
    return { credential: { ...toMetadata(fresh), secret }, previous: toMetadata(previous) };
  }

  async revoke(storeId: string, id: string): Promise<void> {
    const revoked = await this.repo.revoke(storeId, this.pluginId, id, this.now());
    if (revoked) return;
    const existing = await this.repo.get(storeId, this.pluginId, id);
    // Revoking an already-revoked credential is a no-op success; an unknown id is a 404.
    if (!existing) throw new NotFoundError('That credential was not found.');
  }

  /**
   * The credential a signed request claims, decrypted for HMAC verification, or null when it is
   * unknown, revoked, expired or cannot be decrypted. The store comes from the row, never the request.
   */
  async resolveForVerification(id: string): Promise<VerifiedCredential | null> {
    const key = this.masterKey();
    const row = await this.repo.findForVerification(this.pluginId, id, this.now());
    if (!row) return null;
    try {
      return { id: row.id, storeId: row.store_id, secret: decryptSecret(key, row.store_id, row.id, row.secret_encrypted) };
    } catch {
      return null;
    }
  }

  async markUsed(id: string): Promise<void> {
    await this.repo.touch(id, this.now());
  }
}
