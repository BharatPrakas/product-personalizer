import { Service, inject } from '@angular/core';
import { CustomizerConfig } from '../models/config.models';
import { Customization, SavedAsset } from '../models/draft.models';
import { CustomizerSaveDetail } from '../models/events.models';
import { isImageValue } from '../util/draft-utils';
import { LocalAsset, Scene } from '../util/scene';
import { CustomizerError } from './errors';
import { canvasToBlob } from './image.service';
import { RenderService } from './render.service';

export type SavePayload = Omit<CustomizerSaveDetail, 'requestId'>;

export interface ExportInput {
  config: CustomizerConfig;
  scene: Scene;
  mockup: ImageBitmap;
  customization: Customization;
  localAssets: ReadonlyMap<string, LocalAsset>;
}

/** Produces the host payload: JSON snapshot, artwork PNG, preview PNG and canonical uploads. */
@Service()
export class ExportService {
  private readonly render = inject(RenderService);

  async export(input: ExportInput): Promise<SavePayload> {
    const { config, scene, mockup, customization } = input;
    const assets = collectAssets(customization, input.localAssets);

    let artworkCanvas: HTMLCanvasElement | null = null;
    let previewCanvas: HTMLCanvasElement | null = null;
    try {
      artworkCanvas = this.render.renderArtwork(scene);
      previewCanvas = this.render.renderPreview(mockup, config.mockup.placement, scene);
      const artworkBlob = await canvasToBlob(artworkCanvas, 'image/png');
      const previewBlob = await canvasToBlob(previewCanvas, 'image/png');
      return { customization, previewBlob, artworkBlob, assets };
    } catch (error) {
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
    } finally {
      // Release the (up to 16 MP) backing stores promptly.
      for (const canvas of [artworkCanvas, previewCanvas])
        if (canvas) canvas.width = canvas.height = 0;
    }
  }
}

function collectAssets(
  customization: Customization,
  local: ReadonlyMap<string, LocalAsset>,
): SavedAsset[] {
  const assets: SavedAsset[] = [];
  for (const value of Object.values(customization.values)) {
    if (!isImageValue(value) || value.assetId === null) continue;
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
