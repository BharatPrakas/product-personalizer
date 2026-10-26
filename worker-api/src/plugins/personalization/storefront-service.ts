/**
 * Public storefront logic: resolve which PUBLISHED configuration applies to a product page and
 * produce the config the storefront renders (assets rewritten to public, absolute URLs).
 *
 * Nothing here is authenticated, so the rules are deliberately narrow:
 *  - The store is addressed by its public key (the platform's external store id) and must have the
 *    plugin enabled; an unknown / disabled / malformed key behaves exactly like "nothing mapped".
 *  - Only the latest PUBLISHED snapshot of a non-archived configuration is ever returned — never the
 *    draft, never an older version.
 *  - A config that still holds a reference we cannot serve publicly is not served at all.
 */

import type { Database } from '../../database/connection';
import type { AppConfig } from '../../config/environment';
import type { Logger } from '../../shared/logger';
import { StorePluginsRepository } from '../../platform/plugin-permissions/repository';
import { type ObjectStorage, assetKeyPrefix } from '../../storage/object-storage';
import { originsFromSettings } from './settings-service';
import { StorefrontRepository, type ServableAssetRow } from './storefront-repository';
import {
  type AssetIndex,
  collectAssetLocators,
  rewriteAssetReferences,
} from './storefront-assets';
import { PLUGIN_ID, STORAGE_FOLDER, type MappingScope, type ProductConfigLike } from './types';
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
  private readonly installs: StorePluginsRepository;

  constructor(private readonly ctx: StorefrontContext) {
    this.repo = new StorefrontRepository(ctx.db);
    this.installs = new StorePluginsRepository(ctx.db);
  }

  /** null for a malformed, unknown or disabled store — callers must not distinguish the cases. */
  async resolveStore(storeKey: string): Promise<ResolvedStore | null> {
    if (!STORE_KEY_PATTERN.test(storeKey)) return null;
    const install = await this.installs.get(storeKey, PLUGIN_ID);
    if (!install || install.status !== 'enabled') return null;
    return { storeId: storeKey, allowedOrigins: originsFromSettings(install.settings) };
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
  async resolveAsset(assetId: string): Promise<{ asset: ServableAssetRow; store: ResolvedStore } | null> {
    if (!UUID.test(assetId)) return null;
    const asset = await this.repo.getServableAsset(assetId.toLowerCase());
    if (!asset) return null;
    if (!asset.object_key.startsWith(assetKeyPrefix(asset.store_id, STORAGE_FOLDER))) return null;
    const store = await this.resolveStore(asset.store_id);
    return store ? { asset, store } : null;
  }

  openAsset(asset: ServableAssetRow) {
    return this.ctx.storage().get(asset.object_key);
  }
}
