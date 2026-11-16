import { Service, inject } from '@angular/core';
import type { ProductConfig } from '../../customizer/models/product.models';
import { LocalAssetLibrary } from '../../customizer/services/local-asset-library.service';
import { isLocalAssetUrl } from '../../customizer/util/url-policy';
import { UploadDeduper } from '../../customizer/util/direct-upload';
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

export interface AssetSyncOptions {
  /** Cancels the sync; the in-flight upload is aborted and `AbortError` is thrown. */
  signal?: AbortSignal;
}

/**
 * Uploads the local-only binaries a configuration references (`idb:` uploads, inline `data:` images)
 * straight to object storage (R2 or S3, chosen by the Worker) and rewrites those references to stable
 * cloud delivery URLs, so the persisted cloud copy is self-contained and the renderer (which already
 * fetches `http(s)` assets) needs no change.
 *
 * Idempotent and resumable: each upload sends the original ref as `clientRef`, so the Worker resolves a
 * retry to the same upload / already-stored asset instead of creating a duplicate, and concurrent syncs
 * of the same ref share one upload. A config is only ever rewritten to assets the Worker has VERIFIED —
 * `uploadAsset` resolves only after the confirmation call succeeds.
 */
@Service()
export class AssetSyncService {
  private readonly library = inject(LocalAssetLibrary);
  private readonly api = inject(ApiClient);
  /** Session cache so the same ref is uploaded at most once per session. */
  private readonly resolved = new Map<string, string>();
  /** Concurrent syncs (autosave + publish) of the same ref share one upload. */
  private readonly inflight = new UploadDeduper<string>();

  async syncConfigAssets(config: ProductConfig, options: AssetSyncOptions = {}): Promise<AssetSyncResult> {
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
      const deliveryUrl = await this.inflight.run(ref, async () => {
        const asset = await this.api.uploadAsset(blob, {
          clientRef: ref,
          configId: config.id,
          filename: 'image',
          signal: options.signal,
        });
        this.resolved.set(ref, asset.deliveryUrl);
        return asset.deliveryUrl;
      });
      mapping[ref] = deliveryUrl;
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
