import { Service, inject } from '@angular/core';
import { ApiClient, ApiClientError, type AssetDto } from '../workspace/cloud/api-client.service';
import { FontRepository } from './font-repository';
import { FontFileInvalidError, type CustomFont, validateFontLabel } from './font.models';

function toCustomFont(asset: AssetDto): CustomFont {
  return {
    id: asset.id,
    label: asset.originalFilename?.trim() || 'Custom font',
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    createdAt: asset.createdAt,
    deliveryUrl: asset.deliveryUrl,
  };
}

/** The store's custom font library, kept by the personalization API (same store the configs live in). */
@Service()
export class CloudFontRepository extends FontRepository {
  private readonly api = inject(ApiClient);

  async list(): Promise<CustomFont[]> {
    const assets = await this.api.listAssets({ kind: 'font' });
    return assets.map(toCustomFont).sort((a, b) => b.createdAt - a.createdAt);
  }

  async upload(input: { blob: Blob; label: string; filename?: string }): Promise<CustomFont> {
    const label = validateFontLabel(input.label);
    try {
      // The label is what the merchant sees later — stored as the original filename, exactly how
      // every other asset already carries its display name; no new field needed server-side.
      const asset = await this.api.uploadAsset(input.blob, { filename: label });
      return { ...toCustomFont(asset), label };
    } catch (error) {
      if (error instanceof ApiClientError && (error.status === 415 || error.status === 413)) {
        throw new FontFileInvalidError(error.message);
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await this.api.deleteAsset(id);
  }
}
