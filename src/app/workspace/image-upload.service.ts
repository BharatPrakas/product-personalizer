import { Service, inject } from '@angular/core';
import { I18n } from '../admin/i18n/i18n.service';
import { ImageService } from '../customizer/services/image.service';
import { LocalAssetLibrary } from '../customizer/services/local-asset-library.service';

export type StoredImage = { ok: true; src: string } | { ok: false; message: string };

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PIXELS = 36_000_000;

/** Validates a merchant's image file and keeps it in the browser's image library. */
@Service()
export class ImageUploadService {
  private readonly images = inject(ImageService);
  private readonly library = inject(LocalAssetLibrary);
  private readonly i18n = inject(I18n);

  async store(file: File): Promise<StoredImage> {
    if (file.size > MAX_BYTES) return { ok: false, message: this.i18n.t('error.image.too-large') };
    try {
      const bitmap = await this.images.decodeBlob(file);
      const pixels = bitmap.width * bitmap.height;
      bitmap.close();
      if (pixels > MAX_PIXELS) throw new Error('too large');
    } catch {
      return { ok: false, message: this.i18n.t('error.image.unreadable', { name: file.name }) };
    }
    return { ok: true, src: await this.library.put(file, file.name) };
  }
}
