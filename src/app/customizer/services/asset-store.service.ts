import { Service, inject, signal } from '@angular/core';
import { ProductConfig } from '../models/product.models';
import { LocalAsset } from '../util/scene';
import { ImageService } from './image.service';

const LOAD_CONCURRENCY = 6;

/** Absolute URLs of every raster the configuration needs besides the shopper's photos. */
export function staticAssetUrls(config: ProductConfig): string[] {
  const urls = new Set<string>();
  for (const mockup of config.mockups) {
    urls.add(mockup.src);
    for (const overlay of mockup.overlays ?? []) urls.add(overlay.src);
  }
  for (const field of config.fields) {
    if (field.type === 'artwork') field.choices.forEach((choice) => urls.add(choice.src));
  }
  for (const artwork of config.artworks) {
    for (const layer of artwork.layers) {
      if (layer.type === 'fixed-image') urls.add(layer.src);
    }
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
  async loadStatic(config: ProductConfig, abort: AbortSignal): Promise<Map<string, ImageBitmap>> {
    return this.loadUrls(staticAssetUrls(config), abort);
  }

  /** Load `urls` into a staging map without touching live state. */
  async loadUrls(urls: readonly string[], abort: AbortSignal): Promise<Map<string, ImageBitmap>> {
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

  /**
   * Editor use: make sure every URL of `config` is decoded, keeping what is already loaded and
   * releasing images the configuration no longer references. Failed URLs are reported, not thrown,
   * so one broken asset cannot blank the whole editor.
   */
  async syncStatic(config: ProductConfig, abort: AbortSignal): Promise<string[]> {
    const wanted = new Set(staticAssetUrls(config));
    const current = this.staticImages();
    const missing = [...wanted].filter((url) => !current.has(url));
    const failed: string[] = [];
    const loaded = new Map<string, ImageBitmap>();
    await Promise.all(
      missing.map(async (url) => {
        try {
          loaded.set(url, await this.images.fetchBitmap(url, abort));
        } catch (error) {
          if (abort.aborted) throw error;
          failed.push(url);
        }
      }),
    );
    if (abort.aborted) {
      closeAll(loaded.values());
      abort.throwIfAborted();
    }
    const next = new Map<string, ImageBitmap>();
    for (const [url, bitmap] of this.staticImages()) {
      if (wanted.has(url)) next.set(url, bitmap);
      else bitmap.close();
    }
    for (const [url, bitmap] of loaded) next.set(url, bitmap);
    this.staticImages.set(next);
    return failed;
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
