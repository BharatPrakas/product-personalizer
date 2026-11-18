import { Service, inject } from '@angular/core';
import {
  CreatedCustomization,
  CustomizationPersistence,
  PersistKind,
  PersistTarget,
  UploadedFile,
} from './customization-persistence.service';
import type { SavePayload } from './export.service';

/** What a saved design belongs to: the host's product context and the template it was designed against. */
export interface PersistContext {
  target: PersistTarget;
  productId: string;
  variantId: string | null;
  collectionIds: readonly string[];
  templateId: string;
  templateVersion: number;
}

/**
 * Saves a frozen design to the personalization API: every file to private storage, then the customization
 * that references them. It is the one place that knows the shape of the stored record, shared by the modal's
 * Save and by `prepareForCart()`, so both produce exactly the same customization.
 */
@Service({ autoProvided: false })
export class DesignPersister {
  private readonly persistence = inject(CustomizationPersistence);

  async persist(
    context: PersistContext,
    design: SavePayload,
    signal: AbortSignal,
  ): Promise<CreatedCustomization> {
    const { target } = context;
    const files: Array<{ kind: PersistKind; blob: Blob; filename: string }> = [
      ...design.assets.map((a) => ({ kind: 'upload' as const, blob: a.blob, filename: a.assetId })),
      ...design.artworks.map((a) => ({ kind: 'artwork' as const, blob: a.blob, filename: a.printableAreaId })),
      ...design.previews.map((p) => ({ kind: 'preview' as const, blob: p.blob, filename: p.mockupId })),
    ];
    const uploaded: UploadedFile[] = [];
    for (const file of files) uploaded.push(await this.persistence.upload(target, file, signal));

    const refs = (offset: number, count: number) => uploaded.slice(offset, offset + count).map((u) => u.assetId);
    const uploadRefs = refs(0, design.assets.length);
    const artworkRefs = refs(design.assets.length, design.artworks.length);
    const previewRefs = refs(design.assets.length + design.artworks.length, design.previews.length);

    return this.persistence.create(
      target,
      {
        productId: context.productId,
        variantId: context.variantId,
        collectionIds: context.collectionIds,
        configId: context.templateId,
        configVersion: context.templateVersion,
        // What the merchant needs to fulfil the order: the values, and which stored file is which.
        data: {
          schema: 1,
          template: { id: context.templateId, version: context.templateVersion },
          customization: design.customization,
          files: {
            uploads: design.assets.map((a, i) => ({
              assetId: a.assetId, ref: uploadRefs[i], mimeType: a.mimeType, width: a.width, height: a.height,
            })),
            artworks: design.artworks.map((a, i) => ({
              printableAreaId: a.printableAreaId, artworkId: a.artworkId, width: a.width, height: a.height, ref: artworkRefs[i],
            })),
            previews: design.previews.map((p, i) => ({ mockupId: p.mockupId, ref: previewRefs[i] })),
          },
        },
        assets: uploaded,
      },
      signal,
    );
  }
}
