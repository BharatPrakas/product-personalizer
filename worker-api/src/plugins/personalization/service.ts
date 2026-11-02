/**
 * Business logic for configurations, versions and merchant assets. Coordinates the repository
 * (Postgres), asset storage (R2) and validation, and maps DB rows to the client-facing DTOs that
 * mirror the Angular `ConfigurationRecord`.
 *
 * Invariants kept here (not in SQL):
 *  - Optimistic concurrency: saveDraft only succeeds when the client's `expectedUpdatedAt` still
 *    matches the stored stamp; otherwise a ConflictError (→ 409) so a newer copy is never clobbered.
 *  - Publish writes an immutable version row and carries the draft on as version + 1.
 *  - Asset deletes never remove a binary that is still referenced by any config or historical
 *    version, and all R2 network work happens OUTSIDE the database transaction.
 */

import type { Database } from '../../database/connection';
import { runInTransaction } from '../../database/transactions';
import type { AppConfig } from '../../config/environment';
import type { Logger } from '../../shared/logger';
import { STOREFRONT_SEGMENT, apiPath } from '../../shared/api-paths';
import { recordAudit } from '../../platform/tenant-management/audit';
import { type ObjectStorage, assetKeyPrefix, generateObjectKey } from '../../storage/object-storage';
import { sniffImage } from '../../shared/image-sniff';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../shared/errors';
import { PersonalizationRepository, type AssetRow, type ConfigRow, type ConfigVersionRow } from './repository';
import { signAsset, upgradeLegacyAssetUrls } from './asset-signature';
import { validateProductConfig } from './validation';
import {
  type AssetDto,
  type ConfigRecordDto,
  type ConfigVersionDto,
  type ConfigVersionSummaryDto,
  type ProductConfigLike,
} from './types';

export interface ServiceContext {
  db: Database;
  storage: ObjectStorage;
  config: AppConfig;
  logger: Logger;
  storeId: string;
  requestId: string;
  actor: string | null;
  /** The Worker's own origin, used to build authorized delivery URLs when no public base is set. */
  origin: string;
}

function toNum(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export class PersonalizationService {
  private readonly repo: PersonalizationRepository;

  constructor(private readonly ctx: ServiceContext) {
    this.repo = new PersonalizationRepository(ctx.db);
  }

  // ---- mapping ----

  private toRecord(row: ConfigRow): ConfigRecordDto {
    return {
      id: row.client_config_id,
      draft: this.withSignedAssetUrls(row.draft),
      published: this.withSignedAssetUrls(row.published),
      createdAt: Number(row.created_at_ms),
      updatedAt: Number(row.updated_at_ms),
      publishedAt: toNum(row.published_at_ms),
      archivedAt: toNum(row.archived_at_ms),
      mappingCount: row.mapping_count,
    };
  }

  private deliveryUrl(row: AssetRow): string {
    if (this.ctx.config.assetPublicBaseUrl) {
      return `${this.ctx.config.assetPublicBaseUrl}/${row.object_key}`;
    }
    // The renderer loads images with plain browser requests (<img>, fetch), which cannot carry a Bearer
    // token, so the stored reference is a signed URL on the public asset route. The signature binds it
    // to this store and asset, so draft assets stay private. The Bearer-protected `/assets/:id/content`
    // remains for API clients.
    const base = `${this.ctx.origin}${apiPath(this.ctx.config.apiVersion, STOREFRONT_SEGMENT)}/assets/${row.id}`;
    const secret = this.ctx.config.assetSigningSecret;
    return secret ? `${base}?sig=${signAsset(secret, row.store_id, row.id)}` : base;
  }

  /** Configs saved before signed URLs hold Bearer-only URLs; re-point them so they still load. */
  private withSignedAssetUrls<T>(config: T): T {
    return upgradeLegacyAssetUrls(config, this.ctx.config.assetSigningSecret, this.ctx.storeId);
  }

  private toAsset(row: AssetRow): AssetDto {
    return {
      id: row.id,
      storeId: row.store_id,
      configId: row.config_id,
      objectKey: row.object_key,
      originalFilename: row.original_filename,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      width: row.width,
      height: row.height,
      checksumSha256: row.checksum_sha256,
      status: row.status,
      clientRef: row.client_ref,
      createdAt: Number(row.created_at_ms),
      deliveryUrl: this.deliveryUrl(row),
    };
  }

  private toVersionSummary(row: ConfigVersionRow): ConfigVersionSummaryDto {
    return { versionId: row.id, version: row.version, createdAt: Number(row.created_at_ms) };
  }

  // ---- helpers ----

  private stamp(previous?: number): number {
    const now = Date.now();
    return previous !== undefined ? Math.max(now, previous + 1) : now;
  }

  private newClientId(): string {
    return `cfg-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  }

  private nameOf(draft: ProductConfigLike): string {
    const name = typeof draft.product?.name === 'string' ? draft.product.name.trim() : '';
    return (name || 'Untitled configuration').slice(0, 120);
  }

  private schemaVersionOf(draft: ProductConfigLike): number {
    return typeof draft.schemaVersion === 'number' && draft.schemaVersion >= 1 ? draft.schemaVersion : 2;
  }

  private assertValid(draft: unknown): asserts draft is ProductConfigLike {
    const result = validateProductConfig(draft);
    if (!result.ok) throw new ValidationError(result.issues);
  }

  /** Refuse to touch any object outside this store's own asset prefix. */
  private assertOwnKey(objectKey: string): void {
    if (!objectKey.startsWith(assetKeyPrefix(this.ctx.storeId))) {
      throw new Error('Asset key is outside this store\'s asset prefix.');
    }
  }

  private audit(action: string, resourceId: string, metadata?: Record<string, unknown>): Promise<void> {
    return recordAudit(this.ctx.db, {
      requestId: this.ctx.requestId,
      storeId: this.ctx.storeId,
      actor: this.ctx.actor,
      action,
      resourceType: action.startsWith('asset') ? 'asset' : 'config',
      resourceId,
      metadata,
    }).catch((error) => {
      // Audit must never fail the operation; log and continue.
      this.ctx.logger.warn('audit write failed', { action, error: String(error) });
    });
  }

  // ---- configs ----

  async listConfigs(opts: {
    includeArchived: boolean;
    page: number;
    pageSize: number;
  }): Promise<{ records: ConfigRecordDto[]; total: number; page: number; pageSize: number }> {
    const { rows, total } = await this.repo.list(this.ctx.storeId, opts);
    return { records: rows.map((r) => this.toRecord(r)), total, page: opts.page, pageSize: opts.pageSize };
  }

  async getConfig(clientId: string): Promise<ConfigRecordDto> {
    const row = await this.repo.getByClientId(this.ctx.storeId, clientId);
    if (!row) throw new NotFoundError(`Configuration "${clientId}" was not found.`);
    return this.toRecord(row);
  }

  async createConfig(input: { clientConfigId?: string; draft: unknown }): Promise<ConfigRecordDto> {
    this.assertValid(input.draft);
    const draft = input.draft;
    const clientId = input.clientConfigId ?? this.newClientId();

    // Idempotent create: a retried / double-submitted create with the same client id returns the
    // existing record rather than creating a duplicate configuration.
    const existing = await this.repo.getByClientId(this.ctx.storeId, clientId);
    if (existing) return this.toRecord(existing);

    const version = typeof draft.version === 'number' && draft.version > 0 ? draft.version : 1;
    const normalized: ProductConfigLike = { ...draft, id: clientId, status: 'draft', version };
    const now = this.stamp();
    const row = await this.repo.insert({
      storeId: this.ctx.storeId,
      clientConfigId: clientId,
      name: this.nameOf(normalized),
      schemaVersion: this.schemaVersionOf(normalized),
      draft: normalized,
      nowMs: now,
    });
    await this.audit('config.create', clientId, { schemaVersion: row.schema_version });
    return this.toRecord(row);
  }

  async saveDraft(clientId: string, draft: unknown, expectedUpdatedAt: number): Promise<ConfigRecordDto> {
    this.assertValid(draft);
    const normalized: ProductConfigLike = { ...draft, id: clientId, status: 'draft' };
    const result = await this.repo.updateDraft({
      storeId: this.ctx.storeId,
      clientId,
      name: this.nameOf(normalized),
      schemaVersion: this.schemaVersionOf(normalized),
      draft: normalized,
      expectedUpdatedAt,
      nowMs: this.stamp(expectedUpdatedAt),
    });
    if (result === 'not_found') throw new NotFoundError(`Configuration "${clientId}" was not found.`);
    if (result === 'conflict') {
      throw new ConflictError('This configuration was changed somewhere else since you opened it.');
    }
    await this.audit('config.save_draft', clientId);
    return this.toRecord(result);
  }

  async publish(clientId: string, expectedUpdatedAt?: number): Promise<ConfigRecordDto> {
    const current = await this.repo.getByClientId(this.ctx.storeId, clientId);
    if (!current) throw new NotFoundError(`Configuration "${clientId}" was not found.`);
    if (expectedUpdatedAt !== undefined && Number(current.updated_at_ms) !== expectedUpdatedAt) {
      throw new ConflictError('This configuration was changed somewhere else since you opened it.');
    }
    this.assertValid(current.draft);
    this.assertPublishable(current.draft);

    const version = typeof current.draft.version === 'number' ? current.draft.version : 1;
    const published: ProductConfigLike = { ...current.draft, status: 'published' };
    const nextDraft: ProductConfigLike = { ...current.draft, status: 'draft', version: version + 1 };
    const now = this.stamp(Number(current.updated_at_ms));

    const row = await runInTransaction(this.ctx.db, async (tx) => {
      const repo = new PersonalizationRepository(tx);
      return repo.applyPublish({
        storeId: this.ctx.storeId,
        clientId,
        published,
        nextDraft,
        version,
        nowMs: now,
      });
    });
    await this.audit('config.publish', clientId, { version });
    return this.toRecord(row);
  }

  /** Minimal server-side publish-readiness. Authoritative strict validation is the shared Angular
   *  validator; this is a backstop so an obviously-incomplete config cannot be published via the API. */
  private assertPublishable(draft: ProductConfigLike): void {
    const issues = [] as { path: string; code: string; message: string }[];
    const nonEmpty = (key: keyof ProductConfigLike, label: string) => {
      const value = draft[key];
      if (!Array.isArray(value) || value.length === 0) {
        issues.push({ path: String(key), code: 'required', message: `At least one ${label} is required to publish.` });
      }
    };
    nonEmpty('mockups', 'mockup');
    nonEmpty('printableAreas', 'printable area');
    nonEmpty('artworks', 'artwork');
    if (issues.length > 0) throw new ValidationError(issues, 'The configuration is not ready to publish.');
  }

  async duplicate(clientId: string): Promise<ConfigRecordDto> {
    const source = await this.repo.getByClientId(this.ctx.storeId, clientId);
    if (!source) throw new NotFoundError(`Configuration "${clientId}" was not found.`);
    const copyId = this.newClientId();
    const sourceName = this.nameOf(source.draft);
    const clone = structuredClone(source.draft) as ProductConfigLike;
    const draft: ProductConfigLike = {
      ...clone,
      id: copyId,
      status: 'draft',
      version: 1,
      product: {
        ...(clone.product ?? {}),
        id: `product-${copyId}`,
        name: `${sourceName} (copy)`.slice(0, 120),
      },
    };
    const now = this.stamp();
    const row = await this.repo.insert({
      storeId: this.ctx.storeId,
      clientConfigId: copyId,
      name: this.nameOf(draft),
      schemaVersion: this.schemaVersionOf(draft),
      draft,
      nowMs: now,
    });
    await this.audit('config.duplicate', copyId, { source: clientId });
    return this.toRecord(row);
  }

  async archive(clientId: string): Promise<ConfigRecordDto> {
    const row = await this.repo.setArchived(this.ctx.storeId, clientId, this.stamp(), this.stamp());
    if (!row) throw new NotFoundError(`Configuration "${clientId}" was not found.`);
    await this.audit('config.archive', clientId);
    return this.toRecord(row);
  }

  async restore(clientId: string): Promise<ConfigRecordDto> {
    const row = await this.repo.setArchived(this.ctx.storeId, clientId, null, this.stamp());
    if (!row) throw new NotFoundError(`Configuration "${clientId}" was not found.`);
    await this.audit('config.restore', clientId);
    return this.toRecord(row);
  }

  async deleteConfig(clientId: string): Promise<void> {
    // Gather candidate assets BEFORE the delete (cascade clears config_id), inside one short tx with
    // the delete itself. R2 work happens afterwards, never inside the transaction.
    const outcome = await runInTransaction(this.ctx.db, async (tx) => {
      const repo = new PersonalizationRepository(tx);
      const current = await repo.getByClientId(this.ctx.storeId, clientId);
      if (!current) return null;
      const candidates = await repo.assetsForConfig(this.ctx.storeId, current.id);
      await repo.deleteByClientId(this.ctx.storeId, clientId);
      return { candidates };
    }).catch((error: unknown) => {
      // Customizations pin a published version (FK ... ON DELETE RESTRICT): a configuration that
      // shoppers designed against or ordered cannot be deleted. Archiving it is the safe alternative.
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '23503' || code === '23001') {
        throw new ConflictError(
          'This configuration has customer customizations and cannot be deleted. Archive it instead.',
          { reason: 'config_has_customizations' },
        );
      }
      throw error;
    });
    if (!outcome) throw new NotFoundError(`Configuration "${clientId}" was not found.`);

    for (const asset of outcome.candidates) {
      const stillReferenced = await this.repo.isReferenced(this.ctx.storeId, [asset.id, asset.object_key]);
      if (stillReferenced) continue;
      try {
        this.assertOwnKey(asset.object_key);
        await this.ctx.storage.delete(asset.object_key);
        await this.repo.markAssetDeleted(this.ctx.storeId, asset.id, this.stamp());
      } catch (error) {
        // Leave the row intact; a later cleanup pass can retry. Never fail the config delete here.
        this.ctx.logger.warn('asset cleanup failed', { assetId: asset.id, error: String(error) });
      }
    }
    await this.audit('config.delete', clientId, { releasedAssets: outcome.candidates.length });
  }

  // ---- versions ----

  async listVersions(clientId: string): Promise<ConfigVersionSummaryDto[]> {
    const exists = await this.repo.getByClientId(this.ctx.storeId, clientId);
    if (!exists) throw new NotFoundError(`Configuration "${clientId}" was not found.`);
    const rows = await this.repo.listVersions(this.ctx.storeId, clientId);
    return rows.map((r) => this.toVersionSummary(r));
  }

  async getVersion(clientId: string, versionId: string): Promise<ConfigVersionDto> {
    const row = await this.repo.getVersion(this.ctx.storeId, clientId, versionId);
    if (!row) throw new NotFoundError('That configuration version was not found.');
    return { ...this.toVersionSummary(row), snapshot: row.snapshot };
  }

  // ---- assets ----

  async uploadAsset(input: {
    bytes: ArrayBuffer;
    declaredContentType?: string;
    filename?: string;
    clientRef?: string;
    configClientId?: string;
  }): Promise<AssetDto> {
    const size = input.bytes.byteLength;
    if (size === 0) throw new UnsupportedMediaTypeError('The uploaded file is empty.');
    if (size > this.ctx.config.maxUploadBytes) {
      throw new PayloadTooLargeError(`Files can be at most ${this.ctx.config.maxUploadBytes} bytes.`);
    }

    // Idempotent / dedupe: a retried migration upload with the same client ref returns the existing
    // asset instead of storing a duplicate object.
    if (input.clientRef) {
      const existing = await this.repo.getAssetByClientRef(this.ctx.storeId, input.clientRef);
      if (existing) return this.toAsset(existing);
    }

    // Trust the bytes, not the declared Content-Type.
    const sniffed = sniffImage(new Uint8Array(input.bytes));
    if (!sniffed.ok || !sniffed.type) {
      throw new UnsupportedMediaTypeError('Only PNG, JPEG or WebP images are accepted.');
    }

    const digest = await crypto.subtle.digest('SHA-256', input.bytes);
    const checksum = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

    let configDbId: string | null = null;
    if (input.configClientId) {
      const config = await this.repo.getByClientId(this.ctx.storeId, input.configClientId);
      configDbId = config?.id ?? null;
    }

    const objectKey = generateObjectKey({ storeId: this.ctx.storeId, type: sniffed.type });
    await this.ctx.storage.put(objectKey, input.bytes, {
      contentType: sniffed.type,
      sha256: checksum,
      storeId: this.ctx.storeId,
    });

    const row = await this.repo.insertAsset({
      storeId: this.ctx.storeId,
      configDbId,
      objectKey,
      originalFilename: input.filename ?? null,
      contentType: sniffed.type,
      sizeBytes: size,
      width: sniffed.width ?? null,
      height: sniffed.height ?? null,
      checksum,
      clientRef: input.clientRef ?? null,
      nowMs: this.stamp(),
    });
    await this.audit('asset.upload', row.id, { sizeBytes: size, contentType: sniffed.type });
    return this.toAsset(row);
  }

  async getAsset(assetId: string): Promise<AssetDto> {
    const row = await this.repo.getAssetById(this.ctx.storeId, assetId);
    if (!row || row.status === 'deleted') throw new NotFoundError('That asset was not found.');
    return this.toAsset(row);
  }

  async getAssetContent(
    assetId: string,
  ): Promise<{ body: ReadableStream; contentType: string; size: number; etag: string; checksum: string | null }> {
    const row = await this.repo.getAssetById(this.ctx.storeId, assetId);
    if (!row || row.status === 'deleted') throw new NotFoundError('That asset was not found.');
    this.assertOwnKey(row.object_key);
    const object = await this.ctx.storage.get(row.object_key);
    if (!object) throw new NotFoundError('The asset binary is missing from storage.');
    return {
      body: object.body,
      contentType: object.contentType || row.content_type,
      size: object.size,
      etag: object.etag,
      checksum: row.checksum_sha256,
    };
  }

  async listAssets(opts: {
    configClientId?: string;
    page: number;
    pageSize: number;
  }): Promise<{ assets: AssetDto[]; total: number; page: number; pageSize: number }> {
    let configDbId: string | null = null;
    if (opts.configClientId) {
      const config = await this.repo.getByClientId(this.ctx.storeId, opts.configClientId);
      configDbId = config?.id ?? null;
    }
    const { rows, total } = await this.repo.listAssets(this.ctx.storeId, {
      configDbId,
      page: opts.page,
      pageSize: opts.pageSize,
    });
    return { assets: rows.map((r) => this.toAsset(r)), total, page: opts.page, pageSize: opts.pageSize };
  }

  async deleteAsset(assetId: string): Promise<void> {
    const row = await this.repo.getAssetById(this.ctx.storeId, assetId);
    if (!row || row.status === 'deleted') throw new NotFoundError('That asset was not found.');
    const referenced = await this.repo.isReferenced(this.ctx.storeId, [row.id, row.object_key]);
    if (referenced) {
      throw new ConflictError('This asset is still referenced by a configuration or version.');
    }
    this.assertOwnKey(row.object_key);
    await this.ctx.storage.delete(row.object_key);
    await this.repo.markAssetDeleted(this.ctx.storeId, row.id, this.stamp());
    await this.audit('asset.delete', row.id);
  }
}
