import { Service, inject } from '@angular/core';
import type { ProductConfig } from '../../customizer/models/product.models';
import { LocalAssetLibrary } from '../../customizer/services/local-asset-library.service';
import { isLocalAssetUrl } from '../../customizer/util/url-policy';
import { ApiClient } from './api-client.service';

export interface AssetSyncResult {
  /** The configuration with every local asset reference rewritten to a stable cloud delivery URL. */
  config: ProductConfig;
  /** ref (`idb:`/`data:`) -> delivery URL. */
  mapping: Record<string, string>;
  /** Refs that could not be resolved locally (left unchanged, surfaced to the caller). */
  unresolved: string[];
  uploadedCount: number;
}

const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,/;

function isAssetRef(value: string): boolean {
  return isLocalAssetUrl(value) || DATA_IMAGE.test(value);
}

/**
 * Uploads the local-only binaries a configuration references (`idb:` uploads, inline `data:` images)
 * to R2 and rewrites those references to stable cloud delivery URLs, so the persisted cloud copy is
 * self-contained and the renderer (which already fetches `http(s)` assets) needs no change.
 *
 * Idempotent and resumable: each upload sends the original ref as `clientRef`, so the Worker returns
 * the already-stored asset on a retry instead of creating a duplicate.
 */
@Service()
export class AssetSyncService {
  private readonly library = inject(LocalAssetLibrary);
  private readonly api = inject(ApiClient);
  /** Session cache so the same ref is uploaded at most once per session. */
  private readonly resolved = new Map<string, string>();

  async syncConfigAssets(config: ProductConfig): Promise<AssetSyncResult> {
    const refs = new Set<string>();
    collectRefs(config, refs);

    const mapping: Record<string, string> = {};
    const unresolved: string[] = [];
    let uploadedCount = 0;

    for (const ref of refs) {
      const cached = this.resolved.get(ref);
      if (cached) {
        mapping[ref] = cached;
        continue;
      }
      const blob = await this.resolveBlob(ref);
      if (!blob) {
        unresolved.push(ref);
        continue;
      }
      const asset = await this.api.uploadAsset(blob, {
        clientRef: ref,
        configId: config.id,
        filename: 'image',
      });
      this.resolved.set(ref, asset.deliveryUrl);
      mapping[ref] = asset.deliveryUrl;
      uploadedCount++;
    }

    const rewritten = mapStrings(config, (value) => mapping[value] ?? value) as ProductConfig;
    return { config: rewritten, mapping, unresolved, uploadedCount };
  }

  private async resolveBlob(ref: string): Promise<Blob | null> {
    if (isLocalAssetUrl(ref)) return this.library.get(ref);
    if (DATA_IMAGE.test(ref)) {
      try {
        return await (await fetch(ref)).blob();
      } catch {
        return null;
      }
    }
    return null;
  }
}

function collectRefs(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (isAssetRef(value)) into.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectRefs(item, into));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectRefs(item, into));
  }
}

/** Deep-clone, replacing every string via `fn`. Mirrors ConfigurationTransferService.mapStrings. */
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, fn);
    return out;
  }
  return value;
}
