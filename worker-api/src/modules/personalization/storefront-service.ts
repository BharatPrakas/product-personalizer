/**
 * Public storefront logic: resolve which PUBLISHED configuration applies to a product page and
 * produce the config the storefront renders (assets rewritten to public, absolute URLs).
 *
 * Nothing here is authenticated, so the rules are deliberately narrow:
 *  - The store is addressed by its public key (the platform's external store id) and must be known (it
 *    has made an authenticated request); an unknown / malformed key behaves exactly like "nothing mapped".
 *  - Only the latest PUBLISHED snapshot of a non-archived configuration is ever returned — never the
 *    draft, never an older version.
 *  - A config that still holds a reference we cannot serve publicly is not served at all.
 */

import type { Database } from '../../database/connection';
import type { AppConfig } from '../../config/environment';
import type { Logger } from '../../shared/logger';
import { StoreSettingsRepository } from '../store-settings/repository';
import { type ObjectStorage, assetKeyPrefix } from '../../storage/object-storage';
import { verifyAssetSignature } from './asset-signature';
import { StorefrontRepository, type ServableAssetRow } from './storefront-repository';
import {
  type AssetIndex,
  collectAssetLocators,
  rewriteAssetReferences,
} from './storefront-assets';
import type { MappingScope, ProductConfigLike } from './types';
import { STORE_KEY_PATTERN } from './validation';

export interface StorefrontContext {
  db: Database;
  /** Lazy, so routes that never touch binaries do not require storage to be configured. */
  storage: () => ObjectStorage;
  config: AppConfig;
  logger: Logger;
  /** The Worker's public origin as seen by the request (https in production). */
  publicOrigin: string;
}

export interface ResolvedStore {
  storeId: string;
  allowedOrigins: readonly string[];
}

export type StorefrontPayload =
  | { personalizable: false }
  | {
      personalizable: true;
      configId: string;
      version: number;
      scope: MappingScope;
      externalId: string;
      config: ProductConfigLike;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StorefrontService {
  private readonly repo: StorefrontRepository;
  private readonly stores: StoreSettingsRepository;

  constructor(private readonly ctx: StorefrontContext) {
    this.repo = new StorefrontRepository(ctx.db);
    this.stores = new StoreSettingsRepository(ctx.db);
  }

  /** null for a malformed or unknown store — callers must not distinguish the cases. */
  async resolveStore(storeKey: string): Promise<ResolvedStore | null> {
    if (!STORE_KEY_PATTERN.test(storeKey)) return null;
    const settings = await this.stores.get(storeKey);
    return settings ? { storeId: storeKey, allowedOrigins: settings.storefrontOrigins } : null;
  }

  async resolveConfig(
    store: ResolvedStore,
    target: { externalId: string; variantId: string | null; collectionIds: readonly string[] },
  ): Promise<StorefrontPayload> {
    const match = await this.repo.resolveMapping(store.storeId, target);
    if (!match) return { personalizable: false };

    const opts = {
      apiVersion: this.ctx.config.apiVersion,
      assetPublicBaseUrl: this.ctx.config.assetPublicBaseUrl,
      publicOrigin: this.ctx.publicOrigin,
    };
    const locators = collectAssetLocators(match.published, opts);
    const assets = await this.repo.findAssets(store.storeId, [...locators.ids], [...locators.keys]);
    const index: AssetIndex = {
      ids: new Set(assets.map((a) => a.id.toLowerCase())),
      idByKey: new Map(assets.map((a) => [a.object_key, a.id.toLowerCase()])),
    };
    const { config, unresolved } = rewriteAssetReferences(match.published, index, opts);
    if (unresolved.length > 0) {
      // Fail closed: a half-resolved config would render broken or leak local-only references.
      this.ctx.logger.warn('published config has unservable asset references', {
        storeId: store.storeId,
        configId: match.client_config_id,
        count: unresolved.length,
      });
      return { personalizable: false };
    }
    const version = typeof match.published.version === 'number' ? match.published.version : 1;
    return {
      personalizable: true,
      configId: match.client_config_id,
      version,
      scope: match.scope,
      externalId: match.external_id,
      config,
    };
  }

  /** The asset row plus its store's CORS settings, or null when it must not be served. */
  async resolveAsset(
    assetId: string,
    signature: string | null = null,
  ): Promise<{ asset: ServableAssetRow; store: ResolvedStore; signed: boolean } | null> {
    if (!UUID.test(assetId)) return null;
    const id = assetId.toLowerCase();
    // A valid signature (issued by this Worker for this store's asset) serves drafts too; otherwise the
    // asset must be referenced by the store's published configuration.
    let asset: ServableAssetRow | null = null;
    let signed = false;
    const secret = this.ctx.config.assetSigningSecret;
    if (signature && secret) {
      const stored = await this.repo.getStoredAsset(id);
      if (stored && verifyAssetSignature(secret, stored.store_id, stored.id, signature)) {
        asset = stored;
        signed = true;
      }
    }
    asset ??= await this.repo.getServableAsset(id);
    if (!asset) return null;
    if (!asset.object_key.startsWith(assetKeyPrefix(asset.store_id))) return null;
    const store = await this.resolveStore(asset.store_id);
    return store ? { asset, store, signed } : null;
  }

  openAsset(asset: ServableAssetRow) {
    return this.ctx.storage().get(asset.object_key);
  }
}
