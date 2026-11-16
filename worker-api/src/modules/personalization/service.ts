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
import type { AppConfig } from '../../config/environment';
import type { Logger } from '../../shared/logger';
import { STOREFRONT_SEGMENT, apiPath } from '../../shared/api-paths';
import { recordAudit } from '../audit/audit';
import { type ObjectStorage, StorageConfigError, assetKeyPrefix, generateObjectKey } from '../../storage/object-storage';
import { sniffImage } from '../../shared/image-sniff';
import { sniffFont } from '../../shared/font-sniff';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../shared/errors';
import { PersonalizationRepository, parseConfigRow, type AssetRow, type ConfigRow, type ConfigVersionRow } from './repository';
import { isForeignKeyViolation } from './support';
import { signAsset, upgradeLegacyAssetUrls } from './asset-signature';
import { validateProductConfig } from './validation';
import { collectAssetLocators } from './storefront-assets';
import { DirectUploadService } from './direct-upload-service';
import {
  type AssetDto,
  type UploadInitiationDto,
  type UploadedAssetDto,
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

function toNum(value: number | null): number | null {
  return value === null ? null : value;
}

export class PersonalizationService {
  private readonly repo: PersonalizationRepository;
  private readonly direct: DirectUploadService;

  constructor(private readonly ctx: ServiceContext) {
    this.repo = new PersonalizationRepository(ctx.db);
    this.direct = new DirectUploadService({
      db: ctx.db,
      storage: () => ctx.storage,
      config: ctx.config,
      logger: ctx.logger,
    });
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
    // Always the signed Worker URL, never `ASSET_PUBLIC_BASE_URL`: an asset only becomes eligible for the
    // public host once a PUBLISHED configuration references it (see the storefront rewrite), so a draft
    // or unreferenced upload is never handed out as a public URL.
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

  /**
   * A configuration may only reference assets whose upload was verified. A direct upload's asset id is
   * known to the browser as soon as it is initiated, so a draft could name one that is still pending (or
   * failed); refuse that here, before it can be saved or published.
   */
  private async assertNoUnverifiedUploads(draft: ProductConfigLike): Promise<void> {
    const { ids } = collectAssetLocators(draft, {
      apiVersion: this.ctx.config.apiVersion,
      assetPublicBaseUrl: this.ctx.config.assetPublicBaseUrl,
      bundledAssetBaseUrl: this.ctx.config.bundledAssetBaseUrl,
    });
    if (ids.size === 0) return;
    const unverified = await this.direct.uploads.unverifiedAssetIds(this.ctx.storeId, [...ids]);
    if (unverified.length > 0) {
      throw new ValidationError(
        unverified.map((id) => ({
          path: 'assets',
          code: 'upload_unverified',
          message: `Asset ${id} has not finished uploading. Wait for the upload to be confirmed.`,
        })),
      );
    }
  }

  /** Refuse to touch any object outside this store's own asset prefix. */
  private assertOwnKey(objectKey: string): void {
    if (!objectKey.startsWith(assetKeyPrefix(this.ctx.storeId))) {
      throw new Error('Asset key is outside this store\'s asset prefix.');
    }
  }

  /** Asset ids and object keys a config document references (draft, published or a version snapshot). */
  private locate(config: ProductConfigLike) {
    return collectAssetLocators(config, {
      apiVersion: this.ctx.config.apiVersion,
      assetPublicBaseUrl: this.ctx.config.assetPublicBaseUrl,
      bundledAssetBaseUrl: this.ctx.config.bundledAssetBaseUrl,
    });
  }

  /** Link freshly uploaded (still unowned) assets to the config that now references them. Best effort. */
  private async adoptReferencedAssets(configDbId: string, draft: ProductConfigLike): Promise<void> {
    try {
      const { ids } = this.locate(draft);
      if (ids.size > 0) await this.repo.adoptAssets(this.ctx.storeId, configDbId, [...ids]);
    } catch (error) {
      this.ctx.logger.warn('asset adoption failed', { error: String(error) });
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
    await this.assertNoUnverifiedUploads(input.draft);
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
    await this.adoptReferencedAssets(row.id, normalized);
    await this.audit('config.create', clientId, { schemaVersion: row.schema_version });
    return this.toRecord(row);
  }

  async saveDraft(clientId: string, draft: unknown, expectedUpdatedAt: number): Promise<ConfigRecordDto> {
    this.assertValid(draft);
    await this.assertNoUnverifiedUploads(draft);
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
    await this.adoptReferencedAssets(result.id, normalized);
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
    await this.assertNoUnverifiedUploads(current.draft);
    this.assertPublishable(current.draft);

    const version = typeof current.draft.version === 'number' ? current.draft.version : 1;
    const published: ProductConfigLike = { ...current.draft, status: 'published' };
    const nextDraft: ProductConfigLike = { ...current.draft, status: 'draft', version: version + 1 };
    const now = this.stamp(Number(current.updated_at_ms));

    // Both statements are fully determined already (current.id is the config's db id, known before
    // deciding to publish), so they run as one atomic batch — D1 has no interactive transaction to
    // hold the UPDATE and the version INSERT together otherwise.
    const [updateResult] = await this.ctx.db.batch<ConfigRow>(
      this.repo.publishStatements({
        configDbId: current.id,
        storeId: this.ctx.storeId,
        clientId,
        published,
        nextDraft,
        version,
        nowMs: now,
      }),
    );
    await this.audit('config.publish', clientId, { version });
    return this.toRecord(parseConfigRow(updateResult.rows[0]));
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
    // Gather candidate assets BEFORE the delete (cascade clears config_id). The DELETE itself is the
    // only statement that must be atomic, and a single D1 statement already is one; the two reads
    // tolerate the narrow race of a concurrent write landing between them (the asset-cleanup loop
    // below re-checks `isReferenced` before actually deleting any object, so a stale candidate list
    // is self-correcting, never destructive).
    const current = await this.repo.getByClientId(this.ctx.storeId, clientId);
    if (!current) throw new NotFoundError(`Configuration "${clientId}" was not found.`);
    // Candidates = assets linked to this config PLUS anything its draft / published copy / versions
    // reference. Linking alone misses assets uploaded before the config row existed (the editor uploads a
    // new configuration's images first), which would otherwise stay in storage forever.
    const linked = await this.repo.assetsForConfig(this.ctx.storeId, current.id);
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const doc of await this.repo.contentsForConfig(this.ctx.storeId, current.id)) {
      const found = this.locate(doc);
      found.ids.forEach((id) => ids.add(id));
      found.keys.forEach((key) => keys.add(key));
    }
    // Fonts are a store-wide library (listed and deleted separately), so a config never takes them with it.
    const referenced = (await this.repo.findAssetRows(this.ctx.storeId, [...ids], [...keys])).filter(
      (a) => !a.content_type.startsWith('font/'),
    );
    const candidates = [...new Map([...linked, ...referenced].map((a) => [a.id, a])).values()];
    try {
      await this.repo.deleteByClientId(this.ctx.storeId, clientId);
    } catch (error) {
      // Customizations pin a published version (FK ... ON DELETE RESTRICT): a configuration that
      // shoppers designed against or ordered cannot be deleted. Archiving it is the safe alternative.
      if (isForeignKeyViolation(error)) {
        throw new ConflictError(
          'This configuration has customer customizations and cannot be deleted. Archive it instead.',
          { reason: 'config_has_customizations' },
        );
      }
      throw error;
    }
    const outcome = { candidates };

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

    // Trust the bytes, not the declared Content-Type. An upload is either an image (mockups,
    // artwork, overlays) or a font (custom fonts, store-wide); never both, so image sniffing runs
    // first and font sniffing is only tried once it has ruled the bytes out.
    const bytes = new Uint8Array(input.bytes);
    const sniffedImage = sniffImage(bytes);
    const sniffed = sniffedImage.ok && sniffedImage.type ? sniffedImage : sniffFont(bytes);
    if (!sniffed.ok || !sniffed.type) {
      throw new UnsupportedMediaTypeError(
        'Only PNG, JPEG, WebP images or WOFF2, WOFF, TTF, OTF fonts are accepted.',
      );
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
      // Fonts have no intrinsic pixel dimensions.
      width: 'width' in sniffed ? (sniffed.width ?? null) : null,
      height: 'height' in sniffed ? (sniffed.height ?? null) : null,
      checksum,
      clientRef: input.clientRef ?? null,
      nowMs: this.stamp(),
    });
    await this.audit('asset.upload', row.id, { sizeBytes: size, contentType: sniffed.type });
    return this.toAsset(row);
  }

  // ---- direct uploads (presigned PUT -> verify) ----

  /**
   * Step 1 of a direct upload: validate the declared file and hand back a presigned PUT for ONE staging
   * object. The store comes from the verified token, never from the request. The bytes never touch the
   * Worker; `completeUpload` verifies them afterwards.
   */
  async initiateUpload(input: {
    filename?: string;
    contentType: string;
    size: number;
    sha256?: string;
    clientRef?: string;
    configClientId?: string;
    uploadId?: string;
  }): Promise<UploadInitiationDto> {
    // Idempotent: a clientRef that already has a verified asset needs no upload at all.
    if (input.clientRef) {
      const stored = await this.repo.getAssetByClientRef(this.ctx.storeId, input.clientRef);
      if (stored) {
        const asset = this.toUploadedAsset(stored, null);
        return { uploadId: null, assetId: stored.id, status: 'stored', uploadUrl: null, method: null, headers: {}, expiresIn: 0, asset };
      }
    }
    let configDbId: string | null = null;
    if (input.configClientId) {
      const config = await this.repo.getByClientId(this.ctx.storeId, input.configClientId);
      configDbId = config?.id ?? null;
    }
    const { upload, request } = await this.direct.initiate({
      scope: 'merchant',
      storeId: this.ctx.storeId,
      purpose: 'merchant-asset',
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
      sha256: input.sha256,
      clientRef: input.clientRef,
      configDbId,
      renewUploadId: input.uploadId,
    });
    await this.audit('asset.upload_initiated', upload.asset_id, { uploadId: upload.id, size: upload.expected_size });
    return {
      uploadId: upload.id,
      assetId: upload.asset_id,
      status: 'pending',
      uploadUrl: request.url,
      method: 'PUT',
      headers: request.headers,
      expiresIn: request.expiresIn,
    };
  }

  /** Step 3: verify the uploaded object and create the asset. Idempotent and safe to call concurrently. */
  async completeUpload(uploadId: string): Promise<UploadedAssetDto> {
    const { upload, assetId, fresh } = await this.direct.complete(this.ctx.storeId, uploadId, 'merchant');
    const row = await this.repo.getAssetById(this.ctx.storeId, assetId);
    if (!row || row.status === 'deleted') throw new NotFoundError('That asset was not found.');
    if (fresh) {
      await this.audit('asset.upload', row.id, { sizeBytes: Number(row.size_bytes), contentType: row.content_type, direct: true });
    }
    return this.toUploadedAsset(row, upload.id);
  }

  private toUploadedAsset(row: AssetRow, uploadId: string | null): UploadedAssetDto {
    const dto = this.toAsset(row);
    return { ...dto, uploadId, assetId: dto.id, size: dto.sizeBytes, publicUrl: null };
  }

  /**
   * A short-lived presigned GET for a merchant asset. The URL is generated per request and never stored.
   * Merchant assets are private until a published configuration references them, so this is the
   * authorized-read path for the editor and API clients (the Bearer-protected `/content` stream remains).
   */
  async getAssetDownloadUrl(assetId: string): Promise<{ url: string; method: 'GET'; expiresIn: number }> {
    const row = await this.repo.getAssetById(this.ctx.storeId, assetId);
    if (!row || row.status === 'deleted') throw new NotFoundError('That asset was not found.');
    this.assertOwnKey(row.object_key);
    try {
      const signed = await this.ctx.storage.presignGet(row.object_key, {
        expiresInSeconds: this.ctx.config.privateUrlTtlSeconds,
      });
      return { url: signed.url, method: 'GET', expiresIn: signed.expiresIn };
    } catch (error) {
      if (error instanceof StorageConfigError) {
        throw new ServiceUnavailableError('direct_download_not_configured', 'Direct downloads are not configured on this environment.');
      }
      throw error;
    }
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
    /** Restricts the listing to images (the default, unfiltered listing) or to fonts. */
    kind?: 'image' | 'font';
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
      kind: opts.kind,
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
