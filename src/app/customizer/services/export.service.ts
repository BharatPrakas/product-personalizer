import { Service, inject } from '@angular/core';
import { Customization, SavedAreaArtwork, SavedAsset, SavedPreview } from '../models/draft.models';
import { CustomizerSaveDetail } from '../models/events.models';
import { isImageValue } from '../util/draft-utils';
import { AreaScene, LocalAsset } from '../util/scene';
import { CustomizerError } from './errors';
import { canvasToBlob } from './image.service';
import { PreviewComposite, RenderService } from './render.service';

export type SavePayload = Omit<CustomizerSaveDetail, 'requestId'>;

export interface ExportInput {
  /** One scene per active printable area: each exported from its own canvas. */
  scenes: readonly AreaScene[];
  /** One composite per active mockup. */
  composites: readonly PreviewComposite[];
  customization: Customization;
  localAssets: ReadonlyMap<string, LocalAsset>;
}

/** Production artwork of a single printable area as a PNG. */
export interface AreaExport {
  scene: AreaScene;
  blob: Blob;
}

/**
 * Produces the host payload: JSON snapshot, one production PNG per printable area, one composite
 * preview PNG per mockup and the canonical uploads. The two output paths never mix: production
 * PNGs contain only artwork (transparent outside the area mask); previews contain the mockup.
 */
@Service()
export class ExportService {
  private readonly render = inject(RenderService);

  async export(input: ExportInput): Promise<SavePayload> {
    const { customization } = input;
    const assets = collectAssets(customization, input.localAssets);
    try {
      const artworks: SavedAreaArtwork[] = [];
      for (const scene of input.scenes) {
        artworks.push({
          printableAreaId: scene.areaId,
          printableAreaName: scene.areaName,
          artworkId: scene.artworkId,
          width: scene.width,
          height: scene.height,
          blob: await this.areaPng(scene),
        });
      }
      const previews: SavedPreview[] = [];
      for (const composite of input.composites) {
        previews.push({
          mockupId: composite.mockup.id,
          mockupName: composite.mockup.name,
          blob: await this.previewPng(composite),
        });
      }
      if (artworks.length === 0 || previews.length === 0) {
        throw new CustomizerError(
          'export-failed',
          'There is nothing to export for this variant.',
          true,
        );
      }
      return {
        customization,
        previewBlob: previews[0].blob,
        artworkBlob: artworks[0].blob,
        artworks,
        previews,
        assets,
      };
    } catch (error) {
      if (error instanceof CustomizerError) throw error;
      if (error instanceof DOMException && error.name === 'SecurityError') {
        throw new CustomizerError(
          'asset-cors',
          'The design could not be exported because an image was loaded without cross-origin (CORS) permission.',
          true,
        );
      }
      throw new CustomizerError(
        'export-failed',
        'The preview and artwork files could not be generated. Please try again.',
        true,
      );
    }
  }

  async areaPng(scene: AreaScene): Promise<Blob> {
    const canvas = this.render.renderAreaArtwork(scene);
    try {
      return await canvasToBlob(canvas, 'image/png');
    } finally {
      canvas.width = canvas.height = 0; // release the (up to 16 MP) backing store promptly
    }
  }

  async previewPng(composite: PreviewComposite): Promise<Blob> {
    const canvas = this.render.renderPreview(composite);
    try {
      return await canvasToBlob(canvas, 'image/png');
    } finally {
      canvas.width = canvas.height = 0;
    }
  }
}

function collectAssets(
  customization: Customization,
  local: ReadonlyMap<string, LocalAsset>,
): SavedAsset[] {
  const assets: SavedAsset[] = [];
  const seen = new Set<string>();
  for (const value of Object.values(customization.values)) {
    if (!isImageValue(value) || value.assetId === null || seen.has(value.assetId)) continue;
    seen.add(value.assetId);
    const asset = local.get(value.assetId);
    if (!asset) {
      throw new CustomizerError(
        'asset-missing',
        'An uploaded photo is no longer available. Upload it again.',
        true,
      );
    }
    assets.push({
      assetId: asset.assetId,
      blob: asset.blob,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
    });
  }
  return assets;
}
