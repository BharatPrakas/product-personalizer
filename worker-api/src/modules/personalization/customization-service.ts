/**
 * Customer customizations.
 *
 * Shopper side (public, anonymous): upload private images, save a customization, read / update it with
 * a scoped expiring token. The customization id alone never authorizes anything.
 * Merchant side (authenticated, store-scoped): list and read customizations and download their files.
 *
 * Trust rules:
 *  - the store comes from the resolved storefront key (shopper) or the verified token (merchant);
 *  - the configuration is resolved from the mapping for the product — the client only states which
 *    configId / version it rendered, and a mismatch is rejected rather than trusted;
 *  - customer files live under a private prefix and are only streamed after an access check.
 */

import type { Database } from '../../database/connection';
import type { AppConfig } from '../../config/environment';
import {
  ApiError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { sniffImage } from '../../shared/image-sniff';
import { type ObjectStorage, customizationKeyPrefix, generateCustomizationObjectKey } from '../../storage/object-storage';
import { decodeCursor, encodeCursor } from './pagination';
import {
  CustomizationRepository,
  type CustomerAssetKind,
  type CustomerAssetRow,
  type CustomizationListRow,
  type CustomizationRow,
} from './customization-repository';
import { issueCustomerToken, verifyCustomerToken } from './customer-token';
import type { ResolvedStore } from './storefront-service';
import { StorefrontRepository } from './storefront-repository';
import type { CursorPageMeta } from './types';

export interface CustomizationContext {
  db: Database;
  /** Lazy, so routes that never touch binaries do not require storage to be configured. */
  storage: () => ObjectStorage;
  config: AppConfig;
  logger: Logger;
  now?: () => Date;
}

export interface AssetRefInput {
  assetId: string;
  uploadToken?: string;
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
  /** Bearer token for this customization only; keep it in memory / session storage, not in the cart. */
  accessToken: string;
  accessTokenExpiresAt: string;
  /** When the customization lapses if the shopper never orders or edits it again. */
  expiresAt: string;
}

export interface ShopperCustomizationDto {
  customizationId: string;
  status: 'saved' | 'ordered';
  configId: string;
  configVersion: number;
  productId: string;
  variantId: string | null;
  data: Record<string, unknown>;
  assets: CustomerAssetDto[];
  expiresAt: string | null;
}

export interface UploadedAssetDto extends CustomerAssetDto {
  uploadToken: string;
  uploadTokenExpiresAt: string;
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
  private readonly now: () => Date;

  constructor(private readonly ctx: CustomizationContext) {
    this.repo = new CustomizationRepository(ctx.db);
    this.storefront = new StorefrontRepository(ctx.db);
    this.now = ctx.now ?? (() => new Date());
  }

  private tokenSecret(): string {
    const secret = this.ctx.config.customizationTokenSecret;
    if (!secret) {
      throw new ServiceUnavailableError('customizations_not_configured', 'Saving customizations is not configured on this environment.');
    }
    return secret;
  }

  private expiryFrom(now: Date): Date {
    return new Date(now.getTime() + this.ctx.config.customizationRetentionDays * DAY_MS);
  }

  private issueAccessToken(storeId: string, customizationId: string, now: Date) {
    return issueCustomerToken(
      this.tokenSecret(),
      { scope: 'customization', storeId, subject: customizationId },
      this.ctx.config.customizationTokenTtlSeconds,
      now,
    );
  }

  /** Verifies the shopper's bearer token for ONE customization. All failures look the same. */
  private authorizeShopper(storeId: string, customizationId: string, token: string | null): void {
    const verdict = token
      ? verifyCustomerToken(this.tokenSecret(), token, { scope: 'customization', storeId, subject: customizationId }, this.now())
      : 'malformed';
    if (verdict !== 'ok') throw new UnauthorizedError('A valid access token for this customization is required.');
  }

  // ---- shopper: uploads ----

  async uploadAsset(
    store: ResolvedStore,
    input: { bytes: ArrayBuffer; kind: CustomerAssetKind; filename?: string },
  ): Promise<UploadedAssetDto> {
    const secret = this.tokenSecret();
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
    const token = issueCustomerToken(
      secret,
      { scope: 'upload', storeId: store.storeId, subject: row.id },
      this.ctx.config.customizationTokenTtlSeconds,
      this.now(),
    );
    return { ...toAssetDto(row), uploadToken: token.token, uploadTokenExpiresAt: token.expiresAt.toISOString() };
  }

  /** Each NEW attachment must present the upload token issued with that upload. */
  private assertUploadTokens(storeId: string, refs: readonly AssetRefInput[], now: Date): void {
    const secret = this.tokenSecret();
    for (const ref of refs) {
      const verdict = ref.uploadToken
        ? verifyCustomerToken(secret, ref.uploadToken, { scope: 'upload', storeId, subject: ref.assetId }, now)
        : 'malformed';
      if (verdict !== 'ok') {
        throw new ApiError(401, 'invalid_upload_token', `The upload token for asset ${ref.assetId} is missing, invalid or expired.`);
      }
    }
  }

  // ---- shopper: save / read / update ----

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
    this.tokenSecret();
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
    this.assertUploadTokens(store.storeId, refs, now);

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

    const access = this.issueAccessToken(store.storeId, customizationId, now);
    return {
      customizationId,
      status: 'saved',
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async getForShopper(store: ResolvedStore, customizationId: string, token: string | null): Promise<ShopperCustomizationDto> {
    this.authorizeShopper(store.storeId, customizationId, token);
    const row = await this.repo.getById(store.storeId, customizationId);
    if (!row) throw new NotFoundError('That customization was not found.');
    if (row.status === 'expired') throw new ApiError(410, 'customization_expired', 'That customization has expired.');
    const assets = await this.repo.attachedAssets(store.storeId, row.id);
    return {
      customizationId: row.id,
      status: row.status,
      configId: row.client_config_id,
      configVersion: row.config_version,
      productId: row.product_external_id,
      variantId: row.variant_external_id,
      data: row.data,
      assets: assets.map(toAssetDto),
      expiresAt: iso(row.expires_at),
    };
  }

  async update(
    store: ResolvedStore,
    customizationId: string,
    token: string | null,
    input: { data: Record<string, unknown>; assets: readonly AssetRefInput[] },
  ): Promise<SavedCustomizationDto> {
    this.authorizeShopper(store.storeId, customizationId, token);
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

    this.assertUploadTokens(store.storeId, toAttach, now);
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

    const access = this.issueAccessToken(store.storeId, customizationId, now);
    return {
      customizationId,
      status: 'saved',
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async getAssetForShopper(
    store: ResolvedStore,
    customizationId: string,
    assetId: string,
    token: string | null,
  ) {
    this.authorizeShopper(store.storeId, customizationId, token);
    const asset = await this.repo.getAsset(store.storeId, assetId);
    if (!asset || asset.customization_id !== customizationId || asset.status !== 'attached') {
      throw new NotFoundError('That file was not found.');
    }
    return this.openAsset(asset);
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

  async getAssetForMerchant(storeId: string, customizationId: string, assetId: string) {
    const asset = await this.repo.getAsset(storeId, assetId);
    if (!asset || asset.customization_id !== customizationId || asset.status !== 'attached') {
      throw new NotFoundError('That file was not found.');
    }
    return this.openAsset(asset);
  }
}

