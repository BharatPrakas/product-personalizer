import { Service } from '@angular/core';
import { LIMITS } from '../models/config.models';
import { sniffImage } from '../util/image-sniff';
import { CustomizerError, UploadError, describeUrl } from './errors';

export interface CanonicalImage {
  blob: Blob;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

const MIB = 1024 * 1024;
const CANONICAL_JPEG_QUALITY = 0.92;

/** Stateless image helpers: fetching config assets, validating and normalising uploads. */
@Service()
export class ImageService {
  /** Fetch a configuration asset with CORS and decode it. Aborts with `signal`. */
  async fetchBitmap(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
    const blob = await this.fetchBlob(url, signal);
    try {
      // Refuse an over-budget PNG/JPEG from its header, before paying for the decode.
      const header = sniffImage(new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer()));
      if (header.ok) this.assertPixelBudget(header.width, header.height, url);
      const bitmap = await createImageBitmap(blob);
      try {
        this.assertPixelBudget(bitmap.width, bitmap.height, url); // formats the header sniff can't read
      } catch (error) {
        bitmap.close();
        throw error;
      }
      return bitmap;
    } catch (error) {
      if (error instanceof CustomizerError) throw error;
      throw new CustomizerError(
        'asset-load-failed',
        `${describeUrl(url)} is not a decodable raster image (PNG, JPEG or WebP).`,
      );
    }
  }

  async fetchBlob(url: string, signal?: AbortSignal): Promise<Blob> {
    let response: Response;
    try {
      response = await fetch(url, { mode: 'cors', credentials: 'same-origin', signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      const crossOrigin = new URL(url, document.baseURI).origin !== location.origin;
      throw new CustomizerError(
        crossOrigin ? 'asset-cors' : 'asset-load-failed',
        crossOrigin
          ? `${describeUrl(url)} could not be loaded. If it is hosted on another origin, the server must send CORS headers (Access-Control-Allow-Origin).`
          : `${describeUrl(url)} could not be loaded.`,
      );
    }
    if (!response.ok) {
      throw new CustomizerError(
        'asset-load-failed',
        `${describeUrl(url)} could not be loaded (HTTP ${response.status}).`,
      );
    }
    return response.blob();
  }

  /**
   * Decode a Blob with EXIF orientation applied. Browsers that predate the `from-image` option
   * reject it with a TypeError; they get a plain decode (which applies EXIF by default in current engines).
   */
  async decodeBlob(blob: Blob): Promise<ImageBitmap> {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (error) {
      if (error instanceof TypeError) return createImageBitmap(blob);
      throw error;
    }
  }

  private assertPixelBudget(width: number, height: number, url: string): void {
    if (width * height > LIMITS.maxImageMegapixels * 1_000_000) {
      throw new CustomizerError(
        'asset-load-failed',
        `${describeUrl(url)} is larger than ${LIMITS.maxImageMegapixels} megapixels.`,
      );
    }
  }

  /**
   * Validate a shopper's file and turn it into a canonical, metadata-free raster:
   * type/size/animation/dimensions are checked from the bytes, EXIF orientation is applied,
   * and the pixels are re-encoded (PNG stays PNG, JPEG stays JPEG at quality 0.92).
   */
  async processUpload(file: Blob): Promise<CanonicalImage> {
    if (file.size === 0) throw new UploadError('That file is empty. Choose a PNG or JPEG photo.');
    if (file.size > LIMITS.maxImageBytes) {
      throw new UploadError(
        `That file is ${(file.size / MIB).toFixed(1)} MB. Photos can be at most ${LIMITS.maxImageBytes / MIB} MB.`,
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sniffed = sniffImage(bytes);
    if (!sniffed.ok) {
      throw new UploadError(
        sniffed.reason === 'unsupported-type'
          ? 'Only PNG and JPEG photos can be used. Choose a different file.'
          : 'That image looks damaged and cannot be read. Choose a different file.',
      );
    }
    if (sniffed.animated) {
      throw new UploadError('Animated images are not supported. Choose a still PNG or JPEG photo.');
    }
    const megapixels = (sniffed.width * sniffed.height) / 1_000_000;
    if (megapixels > LIMITS.maxImageMegapixels) {
      throw new UploadError(
        `That photo is ${megapixels.toFixed(0)} megapixels. The limit is ${LIMITS.maxImageMegapixels}.`,
      );
    }

    let decoded: ImageBitmap;
    try {
      decoded = await this.decodeBlob(new Blob([bytes], { type: sniffed.mimeType }));
    } catch {
      throw new UploadError(
        'That image could not be read. It may be damaged; choose a different file.',
      );
    }

    const canvas = document.createElement('canvas');
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new UploadError('This browser could not prepare the photo.');
      ctx.drawImage(decoded, 0, 0);
      const blob = await canvasToBlob(canvas, sniffed.mimeType, CANONICAL_JPEG_QUALITY);
      if (blob.size > LIMITS.maxCanonicalBytes) {
        throw new UploadError('That photo is too large to prepare. Choose a smaller image.');
      }
      const bitmap = await createImageBitmap(blob);
      return {
        blob,
        mimeType: sniffed.mimeType,
        width: bitmap.width,
        height: bitmap.height,
        bitmap,
      };
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw new UploadError('This browser could not prepare the photo. Try a smaller image.');
    } finally {
      decoded.close();
      canvas.width = canvas.height = 0; // release the backing store promptly
    }
  }

  /**
   * Validate and decode an image the host handed back through `assetMap`. It is expected to be a
   * canonical blob from an earlier save, so it is not re-encoded.
   */
  async decodeRestored(blob: Blob): Promise<CanonicalImage> {
    // Our own canonical re-encode of a 10 MiB upload (an optimised PNG, say) can exceed 10 MiB.
    if (blob.size === 0 || blob.size > LIMITS.maxCanonicalBytes)
      throw new UploadError('Restored image has an unsupported size.');
    const sniffed = sniffImage(new Uint8Array(await blob.arrayBuffer()));
    if (
      !sniffed.ok ||
      sniffed.animated ||
      sniffed.width * sniffed.height > LIMITS.maxImageMegapixels * 1_000_000
    ) {
      throw new UploadError('Restored image is not a supported PNG or JPEG.');
    }
    const bitmap = await this.decodeBlob(blob);
    return { blob, mimeType: sniffed.mimeType, width: bitmap.width, height: bitmap.height, bitmap };
  }
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
        type,
        quality,
      );
    } catch (error) {
      reject(error);
    }
  });
}
