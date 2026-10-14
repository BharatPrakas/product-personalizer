import { Service, inject } from '@angular/core';
import { ConfigIssue, CustomizerConfig } from '../models/config.models';
import { AssetMapInput } from '../models/draft.models';
import { CustomizerErrorDetail } from '../models/events.models';
import { checkMockupGeometry } from '../util/config-validator';
import { DraftValues, defaultValues, isImageValue, parseCustomization } from '../util/draft-utils';
import { LocalAsset } from '../util/scene';
import { checkHostAssetUrl } from '../util/url-policy';
import { AssetStore } from './asset-store.service';
import { ConfigService } from './config.service';
import { CustomizerError, UploadError, isAbortError } from './errors';
import { FontService } from './font.service';
import { ImageService } from './image.service';

export interface LoadRequest {
  config: unknown;
  configUrl: string | null;
  baseUrl: string | null;
  allowedOrigins: readonly string[] | null;
  initialCustomization: unknown;
  assetMap: AssetMapInput | null;
}

export type LoadOutcome =
  | { kind: 'awaiting' }
  | {
      kind: 'failed';
      status: 'invalid-config' | 'asset-error';
      error: CustomizerErrorDetail;
      issues: ConfigIssue[];
    }
  | {
      kind: 'ready';
      config: CustomizerConfig;
      fontFamilies: Map<string, string>;
      staticImages: Map<string, ImageBitmap>;
      values: DraftValues;
      localAssets: LocalAsset[];
      /** Non-fatal problems found while restoring a draft. */
      notices: CustomizerErrorDetail[];
    };

/**
 * One configuration load: config -> fonts -> images -> optional draft restore. Nothing is
 * written to live state; the caller commits the outcome only if the load is still current, and
 * every bitmap created for a superseded or failed load is closed here.
 */
@Service({ autoProvided: false })
export class LoadPipeline {
  private readonly configs = inject(ConfigService);
  private readonly fonts = inject(FontService);
  private readonly images = inject(ImageService);
  private readonly store = inject(AssetStore);

  async run(request: LoadRequest, abort: AbortSignal): Promise<LoadOutcome> {
    const loaded = await this.loadConfig(request, abort);
    if (loaded.kind !== 'config') return loaded;
    const { config } = loaded;

    let fontFamilies: Map<string, string>;
    try {
      const entries = await Promise.all(
        config.fonts.map(async (font) => [font.id, await this.fonts.load(font)] as const),
      );
      fontFamilies = new Map(entries);
    } catch (error) {
      return failedAsset(error);
    }
    abort.throwIfAborted();

    let staticImages: Map<string, ImageBitmap>;
    try {
      staticImages = await this.store.loadStatic(config, abort);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return failedAsset(error);
    }

    const restoredAssets: LocalAsset[] = [];
    try {
      abort.throwIfAborted();
      const mockup = staticImages.get(config.mockup.src);
      const geometry = mockup ? checkMockupGeometry(config, mockup.width, mockup.height) : null;
      if (geometry) {
        closeAll(staticImages.values());
        return {
          kind: 'failed',
          status: 'invalid-config',
          error: {
            code: 'invalid-config',
            message: `${geometry.path}: ${geometry.message}`,
            recoverable: true,
          },
          issues: [geometry],
        };
      }

      const notices: CustomizerErrorDetail[] = [];
      let values = defaultValues(config);
      if (request.initialCustomization !== null && request.initialCustomization !== undefined) {
        const parsed = parseCustomization(request.initialCustomization, config);
        if (parsed.ok) {
          values = parsed.values;
          await this.restoreAssets(
            config,
            values,
            request.assetMap,
            restoredAssets,
            notices,
            abort,
          );
        } else {
          notices.push({ code: 'restore-mismatch', message: parsed.message, recoverable: true });
        }
      }
      abort.throwIfAborted();
      return {
        kind: 'ready',
        config,
        fontFamilies,
        staticImages,
        values,
        localAssets: restoredAssets,
        notices,
      };
    } catch (error) {
      closeAll(staticImages.values());
      closeAll(restoredAssets.map((asset) => asset.bitmap));
      throw error;
    }
  }

  private async loadConfig(request: LoadRequest, abort: AbortSignal) {
    try {
      const outcome = await this.configs.load(
        {
          config: request.config,
          configUrl: request.configUrl,
          baseUrl: request.baseUrl,
          allowedOrigins: request.allowedOrigins,
          documentBase: document.baseURI,
          pageOrigin: location.origin,
        },
        abort,
      );
      switch (outcome.kind) {
        case 'awaiting':
          return outcome;
        case 'conflict':
          return failedConfig(
            'config-conflict',
            'Both "config" and "configUrl" are set. Provide exactly one.',
            [],
          );
        case 'invalid': {
          const first = outcome.issues
            .slice(0, 3)
            .map((issue) => `${issue.path || 'config'}: ${issue.message}`)
            .join('; ');
          const more = outcome.issues.length > 3 ? ` (+${outcome.issues.length - 3} more)` : '';
          return failedConfig(
            'invalid-config',
            `The configuration is invalid. ${first}${more}`,
            outcome.issues,
          );
        }
        case 'ready':
          return { kind: 'config' as const, config: outcome.config };
      }
    } catch (error) {
      if (isAbortError(error) || abort.aborted) throw error;
      const code = error instanceof CustomizerError ? error.code : 'config-load-failed';
      const message =
        error instanceof CustomizerError ? error.message : 'The configuration could not be loaded.';
      return failedConfig(code, message, []);
    }
  }

  private async restoreAssets(
    config: CustomizerConfig,
    values: DraftValues,
    assetMap: AssetMapInput | null,
    into: LocalAsset[],
    notices: CustomizerErrorDetail[],
    abort: AbortSignal,
  ): Promise<void> {
    for (const field of config.fields) {
      const value = values[field.id];
      if (field.type !== 'image' || !isImageValue(value) || value.assetId === null) continue;
      abort.throwIfAborted();
      const assetId = value.assetId;
      try {
        const source = lookup(assetMap, assetId);
        if (source === undefined) throw new UploadError('not supplied');
        const blob = typeof source === 'string' ? await this.fetchHostUrl(source, abort) : source;
        const decoded = await this.images.decodeRestored(blob);
        into.push({ assetId, ...decoded });
      } catch (error) {
        if (isAbortError(error) || abort.aborted) throw error;
        notices.push({
          code: 'asset-missing',
          message: `The saved image for "${field.label}" could not be restored; it needs to be uploaded again.`,
          fieldId: field.id,
          recoverable: true,
        });
      }
    }
  }

  private async fetchHostUrl(url: string, abort: AbortSignal): Promise<Blob> {
    const checked = checkHostAssetUrl(url, document.baseURI);
    if (!checked.ok) throw new UploadError(checked.message);
    return this.images.fetchBlob(checked.url, abort);
  }
}

function lookup(map: AssetMapInput | null, id: string): string | Blob | undefined {
  if (!map) return undefined;
  if (map instanceof Map) return map.get(id);
  const record = map as Readonly<Record<string, string | Blob>>;
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

function failedConfig(
  code: CustomizerErrorDetail['code'],
  message: string,
  issues: ConfigIssue[],
): LoadOutcome {
  return {
    kind: 'failed',
    status: 'invalid-config',
    error: { code, message, recoverable: true },
    issues,
  };
}

function failedAsset(error: unknown): LoadOutcome {
  const known = error instanceof CustomizerError;
  return {
    kind: 'failed',
    status: 'asset-error',
    error: {
      code: known ? error.code : 'asset-load-failed',
      message: known ? error.message : 'A required image or font could not be loaded.',
      recoverable: true,
    },
    issues: [],
  };
}

function closeAll(bitmaps: Iterable<ImageBitmap>): void {
  for (const bitmap of bitmaps) bitmap.close();
}
