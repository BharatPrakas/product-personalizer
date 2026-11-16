/**
 * Direct browser-to-object-storage uploads: initiation, verification and promotion. Shared by the
 * merchant (assets, fonts) and shopper (customer images, previews, artwork) flows; the two differ only in
 * who is authorized, which content types are accepted, and which asset table receives the verified file.
 *
 *   initiate   validate -> `uploads` row (pending) -> presigned PUT for ONE staging key
 *   (browser)  PUT bytes straight to R2 / S3 — never through the Worker
 *   complete   HEAD -> claim -> read bytes -> sniff + checksum -> promote to the permanent key ->
 *              one atomic D1 batch creates the asset row and marks the upload `stored`
 *
 * Design rules:
 *  - The browser can only ever write `.../pending/<uploadId>`. The permanent key is generated here, after
 *    the bytes are verified, so a leaked or replayed signed URL cannot alter a published asset.
 *  - The asset row (and therefore any reference to it) exists only AFTER verification.
 *  - Every transition is a conditional UPDATE; completion is idempotent and safe under concurrency.
 *  - Browser-supplied type / size / extension are hints that must agree with the real bytes.
 */

import type { Database } from '../../database/connection';
import type { AppConfig } from '../../config/environment';
import { ApiError, ConflictError, NotFoundError, PayloadTooLargeError, ServiceUnavailableError, UnsupportedMediaTypeError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { sniffImage } from '../../shared/image-sniff';
import { sniffFont } from '../../shared/font-sniff';
import {
  ObjectTooLargeError,
  type DetectedAssetType,
  type ObjectStorage,
  type PresignedRequest,
  StorageConfigError,
  StoragePreconditionError,
  StorageRequestError,
  customizationKeyPrefix,
  assetKeyPrefix,
  generateCustomizationObjectKey,
  generateObjectKey,
  pendingKeyPrefix,
  pendingObjectKey,
} from '../../storage/object-storage';
import {
  UploadRepository,
  type UploadPurpose,
  type UploadRow,
  type UploadScopeName,
} from './upload-repository';

export interface DirectUploadContext {
  db: Database;
  storage: () => ObjectStorage;
  config: AppConfig;
  logger: Logger;
  now?: () => Date;
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const FONT_TYPES = [
  'font/woff2', 'font/woff', 'font/ttf', 'font/otf', 'font/sfnt',
  'application/font-woff', 'application/font-woff2', 'application/x-font-ttf',
  'application/x-font-otf', 'application/x-font-opentype', 'application/vnd.ms-opentype',
] as const;
/** Browsers report '' for font files; the client sends this and the bytes decide (must sniff as a font). */
const GENERIC_TYPE = 'application/octet-stream';

/** A decompression-bomb guard: refuse images beyond this many pixels (100 MP) or any zero dimension. */
const MAX_PIXELS = 100_000_000;
const HEX64 = /^[0-9a-f]{64}$/;
const HOUR_MS = 60 * 60 * 1000;
/** A `verifying` claim older than this belonged to a request that died; it may be taken over. */
export const STALE_VERIFY_MS = HOUR_MS;

export const PURPOSE_KIND: Record<Exclude<UploadPurpose, 'merchant-asset'>, 'upload' | 'preview' | 'artwork'> = {
  'customer-upload': 'upload',
  'customer-preview': 'preview',
  'customer-artwork': 'artwork',
};

export function normalizeContentType(raw: string): string {
  return raw.split(';')[0].trim().toLowerCase();
}

function allowedTypes(scope: UploadScopeName): readonly string[] {
  return scope === 'merchant' ? [...IMAGE_TYPES, ...FONT_TYPES, GENERIC_TYPE] : IMAGE_TYPES;
}

export interface InitiateInput {
  scope: UploadScopeName;
  storeId: string;
  purpose: UploadPurpose;
  filename?: string;
  contentType: string;
  size: number;
  sha256?: string;
  clientRef?: string;
  /** Internal id of the configuration the asset belongs to (merchant), already resolved + store-checked. */
  configDbId?: string | null;
  /** Ask for a fresh URL for an upload that is still open instead of starting a new one. */
  renewUploadId?: string;
}

export interface InitiatedUpload {
  upload: UploadRow;
  request: PresignedRequest;
  /** True when an existing open upload was re-used (client retry / URL renewal). */
  reused: boolean;
}

export interface CompletedUpload {
  upload: UploadRow;
  /** The asset row to return: `upload.asset_id`, or the pre-existing asset on a client-ref duplicate. */
  assetId: string;
  /** True only for the call that actually verified and stored the upload (not for idempotent replays). */
  fresh?: boolean;
}

const REJECTIONS: Record<string, string> = {
  size_mismatch: 'The uploaded file does not match the size that was declared.',
  content_type_mismatch: 'The uploaded file does not match the file type that was declared.',
  invalid_content: 'The file is not a supported image or font.',
  checksum_mismatch: 'The uploaded file does not match its checksum.',
  object_changed: 'The file changed while it was being processed. Upload it again.',
  image_dimensions: 'The image dimensions are not supported.',
  duplicate_client_ref: 'This file was already stored.',
};

const rejected = (reason: string): ApiError =>
  new ApiError(422, 'upload_rejected', REJECTIONS[reason] ?? 'The uploaded file was rejected.', { reason });

export class DirectUploadService {
  readonly uploads: UploadRepository;
  private readonly now: () => Date;

  constructor(private readonly ctx: DirectUploadContext) {
    this.uploads = new UploadRepository(ctx.db);
    this.now = ctx.now ?? (() => new Date());
  }

  // ---- initiation ----

  async initiate(input: InitiateInput): Promise<InitiatedUpload> {
    const { config } = this.ctx;
    const contentType = normalizeContentType(input.contentType);
    if (!allowedTypes(input.scope).includes(contentType)) {
      throw new UnsupportedMediaTypeError(
        input.scope === 'merchant'
          ? 'Only PNG, JPEG, WebP images or WOFF2, WOFF, TTF, OTF fonts are accepted.'
          : 'Only PNG, JPEG or WebP images are accepted.',
      );
    }
    if (!Number.isInteger(input.size) || input.size <= 0) throw new UnsupportedMediaTypeError('The file is empty.');
    if (input.size > config.maxUploadBytes) {
      throw new PayloadTooLargeError(`Files can be at most ${config.maxUploadBytes} bytes.`);
    }
    if (input.sha256 && !HEX64.test(input.sha256.toLowerCase())) throw new UnsupportedMediaTypeError('sha256 must be 64 hex characters.');

    const now = this.now();
    const urlExpiresAt = new Date(now.getTime() + config.uploadUrlTtlSeconds * 1000);

    // Retry / renewal: never mint a second asset for the same logical upload.
    const existing = input.renewUploadId
      ? await this.uploads.get(input.storeId, input.renewUploadId.toLowerCase())
      : input.clientRef
        ? await this.uploads.openByClientRef(input.storeId, input.clientRef)
        : null;
    if (existing) return this.renewExisting(existing, input, contentType, urlExpiresAt, now);

    if ((await this.uploads.countOpen(input.storeId)) >= config.maxOpenUploadsPerStore) {
      throw new ApiError(429, 'too_many_open_uploads', 'Too many uploads are in progress. Finish or retry them shortly.');
    }

    const id = crypto.randomUUID();
    const storage = this.ctx.storage();
    const pendingKey = pendingObjectKey(input.storeId, id);
    let row: UploadRow;
    try {
      row = await this.uploads.insert({
        id,
        storeId: input.storeId,
        scope: input.scope,
        purpose: input.purpose,
        assetId: crypto.randomUUID(),
        configDbId: input.configDbId ?? null,
        clientRef: input.clientRef ?? null,
        filename: input.filename ?? null,
        provider: config.storageDriver,
        pendingKey,
        contentType,
        size: input.size,
        sha256: input.sha256?.toLowerCase() ?? null,
        urlExpiresAt,
        now,
      });
    } catch (error) {
      // Two concurrent initiations with one client ref: the loser re-uses the winner's upload.
      const raced = input.clientRef ? await this.uploads.openByClientRef(input.storeId, input.clientRef) : null;
      if (raced) return this.renewExisting(raced, input, contentType, urlExpiresAt, now);
      throw error;
    }
    return { upload: row, request: await this.presign(storage, row), reused: false };
  }

  private async renewExisting(
    existing: UploadRow,
    input: InitiateInput,
    contentType: string,
    urlExpiresAt: Date,
    now: Date,
  ): Promise<InitiatedUpload> {
    const compatible =
      existing.scope === input.scope &&
      existing.purpose === input.purpose &&
      existing.expected_content_type === contentType &&
      existing.expected_size === input.size;
    if (!compatible || (existing.status !== 'pending' && existing.status !== 'uploaded')) {
      throw new ConflictError('That upload can no longer be retried. Start a new upload.', { reason: 'upload_not_renewable' });
    }
    const renewed = await this.uploads.renew(input.storeId, existing.id, urlExpiresAt, now);
    if (!renewed) {
      throw new ConflictError('That upload can no longer be retried. Start a new upload.', { reason: 'upload_not_renewable' });
    }
    return { upload: renewed, request: await this.presign(this.ctx.storage(), renewed), reused: true };
  }

  private async presign(storage: ObjectStorage, row: UploadRow): Promise<PresignedRequest> {
    try {
      return await storage.presignPut(row.pending_key, {
        contentType: row.expected_content_type,
        expiresInSeconds: this.ctx.config.uploadUrlTtlSeconds,
      });
    } catch (error) {
      // The row is useless without a URL; do not leave it counting against the store's open-upload cap.
      await this.uploads.fail(row.id, 'presign_failed', this.now());
      await this.uploads.markCleaned(row.id);
      if (error instanceof StorageConfigError) {
        this.ctx.logger.error('direct upload is not configured', { error: error.message });
        throw new ServiceUnavailableError('direct_upload_not_configured', 'Direct uploads are not configured on this environment.');
      }
      throw error;
    }
  }

  // ---- completion ----

  async complete(storeId: string, uploadId: string, scope: UploadScopeName): Promise<CompletedUpload> {
    const upload = await this.uploads.get(storeId, uploadId.toLowerCase());
    if (!upload || upload.scope !== scope) throw new NotFoundError('That upload was not found.');

    switch (upload.status) {
      case 'stored':
        return { upload, assetId: upload.asset_id };
      case 'failed':
        throw rejected(upload.failure_reason ?? 'rejected');
      case 'expired':
        throw new ApiError(410, 'upload_expired', 'This upload expired before it was confirmed. Upload the file again.', { reason: 'upload_expired' });
      default:
        break;
    }

    const storage = this.ctx.storage();
    const now = this.now();
    try {
      // 1. Is the staged object there at all? (cheap; no claim needed to answer "not yet".)
      if (upload.status === 'pending' || upload.status === 'uploaded') {
        const head = await storage.head(upload.pending_key);
        if (!head) throw new ApiError(409, 'upload_missing', 'The file has not been uploaded yet.', { reason: 'upload_missing' });
        if (head.size !== upload.expected_size) return await this.reject(upload, 'size_mismatch', storage);
        if (upload.status === 'pending') await this.uploads.markUploaded(upload.id, head.size, head.etag, now);
      }

      // 2. One request owns verification + promotion; a concurrent caller is told to retry.
      const claimed = await this.uploads.claimVerifying(upload.id, now, new Date(now.getTime() - STALE_VERIFY_MS));
      if (!claimed) {
        const current = await this.uploads.get(storeId, upload.id);
        if (current?.status === 'stored') return { upload: current, assetId: current.asset_id };
        if (current?.status === 'failed') throw rejected(current.failure_reason ?? 'rejected');
        throw new ApiError(409, 'upload_in_progress', 'This upload is being processed. Retry in a moment.', { reason: 'upload_in_progress' });
      }
      return await this.verifyAndPromote(claimed, storage);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // A storage outage must not poison the upload: hand the claim back and let the client retry.
      await this.uploads.release(upload.id, 'uploaded', this.now()).catch(() => undefined);
      this.ctx.logger.warn('upload verification failed transiently', {
        uploadId: upload.id,
        error: error instanceof StorageRequestError ? error.message : String(error),
      });
      throw new ServiceUnavailableError('storage_unavailable', 'The file could not be verified right now. Please retry.');
    }
  }

  private async verifyAndPromote(upload: UploadRow, storage: ObjectStorage): Promise<CompletedUpload> {
    let object;
    try {
      object = await storage.readBytes(upload.pending_key, upload.expected_size);
    } catch (error) {
      if (error instanceof ObjectTooLargeError) return this.reject(upload, 'size_mismatch', storage);
      throw error;
    }
    if (!object) {
      await this.uploads.release(upload.id, 'pending', this.now());
      throw new ApiError(409, 'upload_missing', 'The file has not been uploaded yet.', { reason: 'upload_missing' });
    }
    if (object.size !== upload.expected_size) return this.reject(upload, 'size_mismatch', storage);
    // The provider records the Content-Type that was SIGNED into the URL; anything else means tampering.
    if (object.contentType && normalizeContentType(object.contentType) !== upload.expected_content_type) {
      return this.reject(upload, 'content_type_mismatch', storage);
    }

    const inspected = this.inspect(upload, object.bytes);
    if ('reason' in inspected) return this.reject(upload, inspected.reason, storage);

    const digest = await crypto.subtle.digest('SHA-256', object.bytes as BufferSource);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (upload.expected_sha256 && upload.expected_sha256 !== sha256) return this.reject(upload, 'checksum_mismatch', storage);

    const now = this.now();
    const candidate =
      upload.scope === 'merchant'
        ? generateObjectKey({ storeId: upload.store_id, type: inspected.type })
        : generateCustomizationObjectKey({ storeId: upload.store_id, type: inspected.type });
    const finalKey = await this.uploads.fixFinalKey(upload.id, candidate, now);
    if (!finalKey) return this.settled(upload); // lost the claim to a concurrent finisher
    this.assertPermanentKey(upload, finalKey);

    try {
      await storage.copy(upload.pending_key, finalKey, {
        contentType: inspected.type,
        storeId: upload.store_id,
        sha256,
        ifMatchEtag: object.etag,
      });
    } catch (error) {
      if (error instanceof StoragePreconditionError) return this.reject(upload, 'object_changed', storage);
      throw error;
    }

    const verified = {
      contentType: inspected.type,
      size: object.size,
      sha256,
      width: inspected.width,
      height: inspected.height,
      etag: object.etag,
    };
    let results;
    try {
      results = await this.ctx.db.batch([this.assetInsert(upload, finalKey, verified, now), this.uploads.finalizeStatement(upload.id, verified, now)]);
    } catch (error) {
      if (/UNIQUE/i.test(String(error)) && upload.client_ref) return this.duplicateClientRef(upload, storage);
      throw error;
    }
    if (results[1].rows.length === 0) return this.settled(upload); // another request finalized (or failed) it

    // The staging object is no longer needed. Delete it now (best effort) but leave `cleaned = 0`: the
    // presigned PUT may stay valid for a few more minutes, and a replay could re-create the object.
    // The scheduled cleanup removes it again once the URL has certainly expired, then marks it cleaned.
    try {
      await storage.delete(upload.pending_key);
    } catch (error) {
      this.ctx.logger.warn('pending object delete failed after promotion', { uploadId: upload.id, error: String(error) });
    }
    const stored = await this.uploads.get(upload.store_id, upload.id);
    return { upload: stored ?? { ...upload, status: 'stored' }, assetId: upload.asset_id, fresh: true };
  }

  /** The row changed under us: report what it became (idempotent for `stored`). */
  private async settled(upload: UploadRow): Promise<CompletedUpload> {
    const current = await this.uploads.get(upload.store_id, upload.id);
    if (current?.status === 'stored') return { upload: current, assetId: current.asset_id };
    if (current?.status === 'failed') throw rejected(current.failure_reason ?? 'rejected');
    throw new ApiError(409, 'upload_in_progress', 'This upload is being processed. Retry in a moment.', { reason: 'upload_in_progress' });
  }

  /** Sniff the real bytes and check they are what the browser said they were. */
  private inspect(
    upload: UploadRow,
    bytes: Uint8Array,
  ): { type: DetectedAssetType; width: number | null; height: number | null } | { reason: string } {
    const declared = upload.expected_content_type;
    const image = sniffImage(bytes);
    if (image.ok && image.type) {
      if (declared !== image.type) return { reason: 'content_type_mismatch' };
      const { width, height } = image;
      if (width !== undefined && height !== undefined && (width <= 0 || height <= 0 || width * height > MAX_PIXELS)) {
        return { reason: 'image_dimensions' };
      }
      return { type: image.type, width: width ?? null, height: height ?? null };
    }
    if (upload.purpose === 'merchant-asset' && !(IMAGE_TYPES as readonly string[]).includes(declared)) {
      const font = sniffFont(bytes);
      if (font.ok && font.type) return { type: font.type, width: null, height: null };
    }
    return { reason: 'invalid_content' };
  }

  /** A permanent key must sit in this store's own public (merchant) or private (customer) prefix. */
  private assertPermanentKey(upload: UploadRow, key: string): void {
    const prefix = upload.scope === 'merchant' ? assetKeyPrefix(upload.store_id) : customizationKeyPrefix(upload.store_id);
    if (!key.startsWith(prefix)) throw new Error('Permanent key is outside the expected prefix.');
  }

  /** Merchant -> `assets`, customer -> `customization_assets`; gated on the upload still being ours. */
  private assetInsert(upload: UploadRow, key: string, v: { contentType: string; size: number; sha256: string; width: number | null; height: number | null }, now: Date) {
    if (upload.scope === 'merchant') {
      return {
        text: `INSERT INTO assets
                 (id, store_id, config_id, object_key, original_filename, content_type, size_bytes, width,
                  height, checksum_sha256, status, client_ref, created_at_ms, updated_at_ms)
               SELECT $2, u.store_id, u.config_id, $3, u.original_filename, $4, $5, $6, $7, $8, 'stored',
                      u.client_ref, $9, $9
                 FROM uploads u WHERE u.id = $1 AND u.status = 'verifying'`,
        params: [upload.id, upload.asset_id, key, v.contentType, v.size, v.width, v.height, v.sha256, now.getTime()],
      };
    }
    return {
      text: `INSERT INTO customization_assets
               (id, store_id, kind, object_key, original_filename, content_type, size_bytes, width, height,
                checksum_sha256)
             SELECT $2, u.store_id, $3, $4, u.original_filename, $5, $6, $7, $8, $9
               FROM uploads u WHERE u.id = $1 AND u.status = 'verifying'`,
      params: [
        upload.id, upload.asset_id, PURPOSE_KIND[upload.purpose as keyof typeof PURPOSE_KIND], key,
        v.contentType, v.size, v.width, v.height, v.sha256,
      ],
    };
  }

  /** Terminal failure: record it, remove the staged bytes, tell the client why. */
  private async reject(upload: UploadRow, reason: string, storage: ObjectStorage): Promise<never> {
    await this.uploads.fail(upload.id, reason, this.now());
    // Early best-effort delete; the scheduled cleanup does the authoritative one after URL expiry.
    await storage.delete(upload.pending_key).catch(() => undefined);
    throw rejected(reason);
  }

  /** The unique client-ref index fired: another upload already stored this ref. Return that asset. */
  private async duplicateClientRef(upload: UploadRow, storage: ObjectStorage): Promise<CompletedUpload> {
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM assets WHERE store_id = $1 AND client_ref = $2 AND status = 'stored'`,
      [upload.store_id, upload.client_ref],
    );
    await this.uploads.fail(upload.id, 'duplicate_client_ref', this.now());
    await storage.delete(upload.pending_key).catch(() => undefined);
    if (!rows[0]) throw rejected('duplicate_client_ref');
    // `final_key` is set, so cleanup removes the promoted copy once it confirms nothing references it.
    const current = await this.uploads.get(upload.store_id, upload.id);
    return { upload: current ?? upload, assetId: rows[0].id };
  }
}

/** The set of prefixes a presigned URL may ever point at; exported for the cleanup safety checks. */
export function isStagingKey(storeId: string, key: string): boolean {
  return key.startsWith(pendingKeyPrefix(storeId));
}
