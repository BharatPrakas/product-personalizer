import { Service, inject, signal } from '@angular/core';
import { CustomizerConfig } from '../models/config.models';
import { LocalAsset } from '../util/scene';
import { ImageService } from './image.service';

const LOAD_CONCURRENCY = 6;

/** Absolute URLs of every raster the configuration needs besides the shopper's photos. */
export function staticAssetUrls(config: CustomizerConfig): string[] {
  const urls = new Set<string>([config.mockup.src]);
  for (const field of config.fields) {
    if (field.type === 'artwork') field.choices.forEach((choice) => urls.add(choice.src));
  }
  for (const layer of config.layers) {
    if (layer.type === 'fixed-image') urls.add(layer.src);
  }
  return [...urls];
}

/**
 * Instance-scoped owner of decoded bitmaps: the configuration's static images and the shopper's
 * local photos. Everything it holds is released by `dispose()` (or when replaced / removed), so
 * the live set stays bounded by what the current configuration and draft reference.
 */
@Service({ autoProvided: false })
export class AssetStore {
  private readonly images = inject(ImageService);

  readonly staticImages = signal<ReadonlyMap<string, ImageBitmap>>(new Map());
  readonly localAssets = signal<ReadonlyMap<string, LocalAsset>>(new Map());

  /**
   * Load into a staging map without touching live state, so a superseded load can be discarded.
   * Bitmaps are closed again if the load fails or is aborted.
   */
  async loadStatic(
    config: CustomizerConfig,
    abort: AbortSignal,
  ): Promise<Map<string, ImageBitmap>> {
    const urls = staticAssetUrls(config);
    const loaded = new Map<string, ImageBitmap>();
    const queue = [...urls];
    let failed = false;
    const worker = async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        abort.throwIfAborted();
        const bitmap = await this.images.fetchBitmap(url, abort);
        if (failed) {
          bitmap.close(); // another worker already failed; don't leak late arrivals
          return;
        }
        loaded.set(url, bitmap);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, urls.length) }, worker));
      abort.throwIfAborted();
      return loaded;
    } catch (error) {
      failed = true;
      queue.length = 0; // stop idle workers picking up more work
      closeAll(loaded.values());
      loaded.clear();
      throw error;
    }
  }

  /** Replace the static images with a staged set from `loadStatic`. */
  adoptStatic(next: Map<string, ImageBitmap>): void {
    closeAll(this.staticImages().values());
    this.staticImages.set(next);
  }

  addLocal(asset: LocalAsset): void {
    const previous = this.localAssets().get(asset.assetId);
    if (previous && previous.bitmap !== asset.bitmap) previous.bitmap.close();
    this.localAssets.update((map) => new Map(map).set(asset.assetId, asset));
  }

  removeLocal(assetId: string): void {
    const asset = this.localAssets().get(assetId);
    if (!asset) return;
    asset.bitmap.close();
    this.localAssets.update((map) => {
      const next = new Map(map);
      next.delete(assetId);
      return next;
    });
  }

  clearLocal(): void {
    closeAll([...this.localAssets().values()].map((asset) => asset.bitmap));
    this.localAssets.set(new Map());
  }

  /** Release every bitmap. The store is empty (and reusable) afterwards. */
  dispose(): void {
    this.clearLocal();
    closeAll(this.staticImages().values());
    this.staticImages.set(new Map());
  }
}

function closeAll(bitmaps: Iterable<ImageBitmap>): void {
  for (const bitmap of bitmaps) bitmap.close();
}
