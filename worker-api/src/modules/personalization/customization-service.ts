/**
 * Customer customizations.
 *
 * Shopper side (public, anonymous, no credentials): upload images, save / update a customization, and get
 * back `customizedImageUrl`, the public URL of the rendered customized image. Ids are unguessable UUIDs.
 * Merchant side (authenticated, store-scoped): list and read customizations and download their files.
 *
 * Trust rules:
 *  - the store comes from the resolved storefront key (shopper) or the verified token (merchant) and must
 *    be known;
 *  - the configuration is resolved from the mapping for the product — the client only states which
 *    configId / version it rendered, and a mismatch is rejected rather than trusted;
 *  - customer files live under a private prefix. The ONLY file served to the public is an attached
 *    `preview` image (see `findPublicImage`); uploads and print artwork are never exposed to shoppers.
 */

import type { Database } from '../../database/connection';
import type { AppConfig } from '../../config/environment';
import {
  ApiError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { STOREFRONT_SEGMENT, apiPath } from '../../shared/api-paths';
import { sniffImage } from '../../shared/image-sniff';
import {
  type ObjectStorage,
  StorageConfigError,
  customizationKeyPrefix,
  generateCustomizationObjectKey,
} from '../../storage/object-storage';
import { DirectUploadService } from './direct-upload-service';
import { decodeCursor, encodeCursor } from './pagination';
import {
  CustomizationRepository,
  type CustomerAssetKind,
  type CustomerAssetRow,
  type CustomizationListRow,
  type CustomizationRow,
} from './customization-repository';
import type { ResolvedStore } from './storefront-service';
import { StorefrontRepository } from './storefront-repository';
import type { CursorPageMeta } from './types';

export interface CustomizationContext {
  db: Database;
  /** Lazy, so routes that never touch binaries do not require storage to be configured. */
  storage: () => ObjectStorage;
  config: AppConfig;
  logger: Logger;
  /** The Worker's public origin as seen by the request (https in production); `customizedImageUrl` is built on it. */
  publicOrigin: string;
  now?: () => Date;
}

export interface AssetRefInput {
  assetId: string;
}

export interface CustomerAssetDto {
  assetId: string;
  kind: CustomerAssetKind;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

/** What the shopper gets back after saving — the minimum needed to continue. */
export interface SavedCustomizationDto {
  customizationId: string;
  status: 'saved';
  /**
   * Absolute, public URL of the customized image (the first `preview` asset of the save), safe for
   * `<img src>`; `null` when the save carried no preview. It changes whenever the saved preview changes.
   */
  customizedImageUrl: string | null;
  /** When the customization lapses if the shopper never orders or edits it again. */
  expiresAt: string;
}

/** Response to a shopper's upload-initiation request. */
export interface CustomerUploadInitiationDto {
  uploadId: string;
  assetId: string;
  uploadUrl: string;
  method: 'PUT';
  /** Headers the browser must send with the PUT, exactly as given (they are part of the signature). */
  headers: Record<string, string>;
  expiresIn: number;
}

export interface MerchantCustomizationDto {
  id: string;
  status: 'saved' | 'ordered' | 'expired';
  configId: string;
  configVersion: number;
  productId: string;
  variantId: string | null;
  mapping: { scope: string; externalId: string };
  /** Omitted from list responses; present on a single customization. */
  data?: Record<string, unknown>;
  assets: CustomerAssetDto[];
  order: { orderId: string; lineId: string; linkedAt: string } | null;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: string;
  expiresAt: string | null;
  orderedAt: string | null;
  expiredAt: string | null;
}

/** The only types a public image may have: what `sniffImage` can produce, never the declared type. */
const PUBLIC_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function toAssetDto(row: CustomerAssetRow): CustomerAssetDto {
  return {
    assetId: row.id,
    kind: row.kind,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    width: row.width,
    height: row.height,
  };
}

/** Asset ids must be unique within one request; a duplicate would double-count the attach check. */
function uniqueAssetRefs(refs: readonly AssetRefInput[]): AssetRefInput[] {
  const seen = new Set<string>();
  for (const ref of refs) {
    const id = ref.assetId.toLowerCase();
    if (seen.has(id)) {
      throw new ValidationError([{ path: 'assets', code: 'duplicate', message: `Asset ${id} is listed twice.` }]);
    }
    seen.add(id);
  }
  return refs.map((r) => ({ ...r, assetId: r.assetId.toLowerCase() }));
}

export class CustomizationService {
  private readonly repo: CustomizationRepository;
  private readonly storefront: StorefrontRepository;
  private readonly direct: DirectUploadService;
  private readonly now: () => Date;

  constructor(private readonly ctx: CustomizationContext) {
    this.repo = new CustomizationRepository(ctx.db);
    this.storefront = new StorefrontRepository(ctx.db);
    this.direct = new DirectUploadService({
      db: ctx.db,
      storage: ctx.storage,
      config: ctx.config,
      logger: ctx.logger,
      now: ctx.now,
    });
    this.now = ctx.now ?? (() => new Date());
  }

  private expiryFrom(now: Date): Date {
    return new Date(now.getTime() + this.ctx.config.customizationRetentionDays * DAY_MS);
  }

  // ---- shopper: uploads ----

  async uploadAsset(
    store: ResolvedStore,
    input: { bytes: ArrayBuffer; kind: CustomerAssetKind; filename?: string },
  ): Promise<CustomerAssetDto> {
    const size = input.bytes.byteLength;
    if (size === 0) throw new UnsupportedMediaTypeError('The uploaded file is empty.');
    if (size > this.ctx.config.maxUploadBytes) {
      throw new PayloadTooLargeError(`Files can be at most ${this.ctx.config.maxUploadBytes} bytes.`);
    }
    // Trust the bytes, not the declared Content-Type.
    const sniffed = sniffImage(new Uint8Array(input.bytes));
    if (!sniffed.ok || !sniffed.type) {
      throw new UnsupportedMediaTypeError('Only PNG, JPEG or WebP images are accepted.');
    }
    const digest = await crypto.subtle.digest('SHA-256', input.bytes);
    const checksum = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

    const storage = this.ctx.storage();
    const objectKey = generateCustomizationObjectKey({ storeId: store.storeId, type: sniffed.type });
    await storage.put(objectKey, input.bytes, { contentType: sniffed.type, sha256: checksum, storeId: store.storeId });
    let row: CustomerAssetRow;
    try {
      row = await this.repo.insertAsset({
        storeId: store.storeId,
        kind: input.kind,
        objectKey,
        filename: input.filename ?? null,
        contentType: sniffed.type,
        sizeBytes: size,
        width: sniffed.width ?? null,
        height: sniffed.height ?? null,
        checksum,
      });
    } catch (error) {
      // Do not leave an object nothing references.
      await storage.delete(objectKey).catch(() => undefined);
      throw error;
    }
    return toAssetDto(row);
  }

  // ---- shopper: direct uploads (presigned PUT -> verify) ----

  /**
   * Step 1: the shopper declares the file and gets a presigned PUT for one PRIVATE staging object. Same
   * trust model as the proxied upload: a known store key + rate limits + the per-store open-upload cap;
   * the bytes are sniffed before anything is stored. Passing `uploadId` renews the URL of a customer
   * upload that is still open (the id is an unguessable UUID only the uploader has seen).
   */
  async initiateUpload(
    store: ResolvedStore,
    input: {
      kind: CustomerAssetKind;
      filename?: string;
      contentType: string;
      size: number;
      sha256?: string;
      uploadId?: string;
    },
  ): Promise<CustomerUploadInitiationDto> {
    if (input.uploadId) {
      const existing = await this.direct.uploads.get(store.storeId, input.uploadId.toLowerCase());
      if (!existing || existing.scope !== 'customer') throw new NotFoundError('That upload was not found.');
    }
    const { upload, request } = await this.direct.initiate({
      scope: 'customer',
      storeId: store.storeId,
      purpose: `customer-${input.kind}`,
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
      sha256: input.sha256,
      renewUploadId: input.uploadId,
    });
    return {
      uploadId: upload.id,
      assetId: upload.asset_id,
      uploadUrl: request.url,
      method: 'PUT',
      headers: request.headers,
      expiresIn: request.expiresIn,
    };
  }

  /**
   * Step 3: verify the uploaded object and create the (unattached) customer asset. The response has the same
   * shape as the proxied upload, so everything after this point (attach, save) is unchanged. Idempotent.
   */
  async completeUpload(store: ResolvedStore, uploadId: string): Promise<CustomerAssetDto> {
    const upload = await this.direct.uploads.get(store.storeId, uploadId.toLowerCase());
    if (!upload || upload.scope !== 'customer') throw new NotFoundError('That upload was not found.');

    const { assetId } = await this.direct.complete(store.storeId, upload.id, 'customer');
    const row = await this.repo.getAsset(store.storeId, assetId);
    if (!row) throw new NotFoundError('That upload was not found.');
    return toAssetDto(row);
  }

  // ---- shopper: save / update ----

  async create(
    store: ResolvedStore,
    input: {
      productId: string;
      variantId?: string;
      collectionIds?: readonly string[];
      configId: string;
      configVersion: number;
      data: Record<string, unknown>;
      assets: readonly AssetRefInput[];
    },
  ): Promise<SavedCustomizationDto> {
    const refs = uniqueAssetRefs(input.assets);
    const now = this.now();

    // The configuration is whatever the mapping says applies to this product right now.
    const match = await this.storefront.resolveMapping(store.storeId, {
      externalId: input.productId,
      variantId: input.variantId ?? null,
      collectionIds: input.collectionIds ?? [],
    });
    if (!match) throw new ApiError(404, 'not_personalizable', 'This product has no published personalization.');
    if (match.client_config_id !== input.configId) {
      throw new ConflictError('The personalization for this product changed. Reload the product and try again.', {
        reason: 'config_changed',
      });
    }
    if (!(await this.repo.configVersionExists(match.config_uuid, store.storeId, input.configVersion))) {
      throw new ValidationError([{ path: 'configVersion', code: 'unknown_version', message: 'That configuration version does not exist.' }]);
    }
    const expiresAt = this.expiryFrom(now);
    const customizationId = await this.repo.insertWithAttach({
      storeId: store.storeId,
      configUuid: match.config_uuid,
      configVersion: input.configVersion,
      productId: input.productId,
      variantId: input.variantId ?? null,
      mappingScope: match.scope,
      mappingExternalId: match.external_id,
      data: input.data,
      now,
      expiresAt,
      assetIds: refs.map((r) => r.assetId),
    });
    if (customizationId === null) {
      // Nothing committed, including the customization row: an upload is unknown, already used, or
      // belongs to another store (see the attach-count guard in migrations/d1/0001_baseline.sql).
      throw new ConflictError('One or more uploads are unavailable. Upload them again.', { reason: 'asset_unavailable' });
    }

    return {
      customizationId,
      status: 'saved',
      customizedImageUrl: await this.customizedImageUrl(store.storeId, refs),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async update(
    store: ResolvedStore,
    customizationId: string,
    input: { data: Record<string, unknown>; assets: readonly AssetRefInput[] },
  ): Promise<SavedCustomizationDto> {
    const refs = uniqueAssetRefs(input.assets);
    const now = this.now();
    const expiresAt = this.expiryFrom(now);
    const graceEnd = new Date(now.getTime() + this.ctx.config.assetDeleteGraceHours * HOUR_MS);

    const row = await this.repo.getById(store.storeId, customizationId);
    if (!row) throw new NotFoundError('That customization was not found.');
    if (row.status === 'expired') throw new ApiError(410, 'customization_expired', 'That customization has expired.');
    if (row.status !== 'saved') {
      throw new ConflictError('This customization has been ordered and can no longer be changed.', {
        reason: 'customization_not_editable',
      });
    }
    const current = await this.repo.attachedAssets(store.storeId, row.id);
    const currentIds = new Set(current.map((a) => a.id));
    const wanted = new Set(refs.map((r) => r.assetId));
    const toAttach = refs.filter((r) => !currentIds.has(r.assetId));
    const toRelease = [...currentIds].filter((id) => !wanted.has(id));

    // One atomic batch: nothing commits (including the release and the data write) if the claim comes
    // up short, and the data write itself re-checks `status = 'saved'` — see applyUpdate.
    const outcome = await this.repo.applyUpdate({
      storeId: store.storeId,
      customizationId: row.id,
      toAttach: toAttach.map((r) => r.assetId),
      toRelease,
      data: input.data,
      now,
      expiresAt,
      deleteAfter: graceEnd,
    });
    if (outcome === 'attach_unavailable') {
      throw new ConflictError('One or more uploads are unavailable. Upload them again.', { reason: 'asset_unavailable' });
    }
    if (outcome === 'state_changed') {
      throw new ConflictError('This customization changed while saving. Try again.', { reason: 'state_changed' });
    }

    return {
      customizationId,
      status: 'saved',
      customizedImageUrl: await this.customizedImageUrl(store.storeId, refs),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** The first preview among `refs` (request order) is the customized image; its URL changes with the asset. */
  private async customizedImageUrl(storeId: string, refs: readonly AssetRefInput[]): Promise<string | null> {
    if (refs.length === 0) return null;
    const kinds = new Map((await this.repo.assetsByIds(storeId, refs.map((r) => r.assetId))).map((a) => [a.id, a.kind]));
    const preview = refs.find((r) => kinds.get(r.assetId) === 'preview');
    if (!preview) return null;
    const base = `${this.ctx.publicOrigin}${apiPath(this.ctx.config.apiVersion, STOREFRONT_SEGMENT)}`;
    return `${base}/customization-images/${preview.assetId}?storeId=${encodeURIComponent(storeId)}`;
  }

  /**
   * The one customer file the public may read: an ATTACHED `preview` image of this store. Uploads, print
   * artwork, unattached or released files, other stores' files and anything whose stored type is not a
   * sniffed raster image are all "not found".
   */
  async findPublicImage(store: ResolvedStore, assetId: string): Promise<CustomerAssetRow> {
    const asset = await this.repo.getAsset(store.storeId, assetId);
    if (
      !asset ||
      asset.kind !== 'preview' ||
      asset.status !== 'attached' ||
      asset.customization_id === null ||
      !PUBLIC_IMAGE_TYPES.has(asset.content_type)
    ) {
      throw new NotFoundError('That image was not found.');
    }
    return asset;
  }

  openPublicImage(asset: CustomerAssetRow) {
    return this.openAsset(asset);
  }

  private async presignedGet(asset: CustomerAssetRow) {
    if (!asset.object_key.startsWith(customizationKeyPrefix(asset.store_id))) {
      throw new NotFoundError('That file was not found.');
    }
    try {
      const signed = await this.ctx.storage().presignGet(asset.object_key, {
        expiresInSeconds: this.ctx.config.privateUrlTtlSeconds,
      });
      return { url: signed.url, method: 'GET' as const, expiresIn: signed.expiresIn, contentType: asset.content_type };
    } catch (error) {
      if (error instanceof StorageConfigError) {
        throw new ServiceUnavailableError('direct_download_not_configured', 'Direct downloads are not configured on this environment.');
      }
      throw error;
    }
  }

  private async openAsset(asset: CustomerAssetRow) {
    if (!asset.object_key.startsWith(customizationKeyPrefix(asset.store_id))) {
      throw new NotFoundError('That file was not found.');
    }
    const object = await this.ctx.storage().get(asset.object_key);
    if (!object) throw new NotFoundError('That file was not found.');
    return { object, contentType: asset.content_type, checksum: asset.checksum_sha256 };
  }

  // ---- merchant ----

  private toMerchantDto(
    row: CustomizationRow,
    assets: CustomerAssetRow[],
    link: { orderId: string; lineId: string; linkedAt: string } | null,
    includeData: boolean,
  ): MerchantCustomizationDto {
    return {
      id: row.id,
      status: row.status,
      configId: row.client_config_id,
      configVersion: row.config_version,
      productId: row.product_external_id,
      variantId: row.variant_external_id,
      mapping: { scope: row.mapping_scope, externalId: row.mapping_external_id },
      ...(includeData ? { data: row.data } : {}),
      assets: assets.map(toAssetDto),
      order: link,
      createdAt: Number(row.created_at_ms),
      updatedAt: Number(row.updated_at_ms),
      lastActivityAt: new Date(row.last_activity_at).toISOString(),
      expiresAt: iso(row.expires_at),
      orderedAt: iso(row.ordered_at),
      expiredAt: iso(row.expired_at),
    };
  }

  async listForMerchant(
    storeId: string,
    query: { status?: string; orderId?: string; productId?: string; limit: number; cursor?: string },
  ): Promise<{ items: MerchantCustomizationDto[]; page: CursorPageMeta }> {
    const rows = await this.repo.list(storeId, query, decodeCursor(query.cursor), query.limit);
    const hasMore = rows.length > query.limit;
    const pageRows: CustomizationListRow[] = hasMore ? rows.slice(0, query.limit) : rows;
    const items = pageRows.map((r) =>
      this.toMerchantDto(r, [], r.link_order_id
        ? { orderId: r.link_order_id, lineId: r.link_line_id!, linkedAt: new Date(r.link_created_at!).toISOString() }
        : null, false),
    );
    const last = pageRows[pageRows.length - 1];
    return {
      items,
      page: {
        limit: query.limit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor({ createdAtMs: Number(last.created_at_ms), id: last.id }) : null,
      },
    };
  }

  async getForMerchant(storeId: string, customizationId: string): Promise<MerchantCustomizationDto> {
    const row = await this.repo.getById(storeId, customizationId);
    if (!row) throw new NotFoundError('That customization was not found.');
    const [assets, link] = await Promise.all([
      this.repo.attachedAssets(storeId, row.id),
      this.repo.getOrderLink(storeId, row.id),
    ]);
    return this.toMerchantDto(
      row,
      assets,
      link
        ? { orderId: link.external_order_id, lineId: link.external_line_id, linkedAt: new Date(link.created_at).toISOString() }
        : null,
      true,
    );
  }

  async getAssetUrlForMerchant(storeId: string, customizationId: string, assetId: string) {
    const asset = await this.repo.getAsset(storeId, assetId);
    if (!asset || asset.customization_id !== customizationId || asset.status !== 'attached') {
      throw new NotFoundError('That file was not found.');
    }
    return this.presignedGet(asset);
  }

  async getAssetForMerchant(storeId: string, customizationId: string, assetId: string) {
    const asset = await this.repo.getAsset(storeId, assetId);
    if (!asset || asset.customization_id !== customizationId || asset.status !== 'attached') {
      throw new NotFoundError('That file was not found.');
    }
    return this.openAsset(asset);
  }
}

