import { Service, inject } from '@angular/core';
import { I18n } from '../admin/i18n/i18n.service';
import type { ConfigIssue } from '../customizer/models/config.models';
import type { ProductConfig } from '../customizer/models/product.models';
import { LocalAssetLibrary } from '../customizer/services/local-asset-library.service';
import { upgradeV1 } from '../customizer/util/config-upgrade';
import { validateConfig } from '../customizer/util/config-validator';
import { isLocalAssetUrl, resolveBase } from '../customizer/util/url-policy';
import { validateConfiguration } from './validation';
import { assetBaseUrl } from './asset-base';

export type ImportResult =
  { ok: true; draft: ProductConfig } | { ok: false; issues: ConfigIssue[] };

/**
 * Moving configurations in and out of the application as files, and resolving their images for
 * display. Stored (`idb:`) images are embedded as data URLs on export so a file is self-contained,
 * and turned back into stored images on import.
 */
@Service()
export class ConfigurationTransferService {
  private readonly library = inject(LocalAssetLibrary);
  private readonly i18n = inject(I18n);

  async exportJson(config: ProductConfig): Promise<string> {
    const embedded = await mapStrings(structuredClone(config), async (text) => {
      if (!isLocalAssetUrl(text)) return text;
      const blob = await this.library.get(text);
      return blob ? blobToDataUrl(blob) : text;
    });
    return JSON.stringify(embedded, null, 2);
  }

  /** Validates before anything is stored; version-1 files take the compatibility upgrade path. */
  async parseImport(text: string): Promise<ImportResult> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return {
        ok: false,
        issues: [{ path: '', code: 'json', message: this.i18n.t('error.json') }],
      };
    }
    const version =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)['schemaVersion']
        : undefined;

    let config: ProductConfig;
    if (version === 1) {
      const result = validateConfig(raw, {
        resolvedBase: resolveBase({
          configUrl: null,
          baseUrl: null,
          documentBase: assetBaseUrl(),
        }),
        policy: { pageOrigin: location.origin, allowedOrigins: [], allowLocalAssets: true },
      });
      if (!result.ok) return { ok: false, issues: result.issues };
      config = upgradeV1(result.config);
    } else {
      const result = validateConfiguration(raw, { allowIncomplete: true });
      if (!result.ok) return { ok: false, issues: result.issues };
      // Keep the author's relative asset paths: the resolved copy has absolute URLs.
      config = raw as ProductConfig;
    }
    const withImages = await mapStrings(structuredClone(config), async (value) => {
      if (!value.startsWith('data:image/')) return value;
      return this.library.put(await (await fetch(value)).blob(), 'imported');
    });
    const draft: ProductConfig = { ...withImages, status: 'draft' };
    const check = validateConfiguration(draft, { allowIncomplete: true });
    return check.ok ? { ok: true, draft } : { ok: false, issues: check.issues };
  }

  /** Absolute URL for a stored `src` (browser-stored images keep their `idb:` reference). */
  assetUrl(config: ProductConfig, src: string): string {
    if (isLocalAssetUrl(src) || src.startsWith('data:') || /^https?:/i.test(src)) return src;
    return new URL(src, new URL(config.assetBaseUrl ?? '', assetBaseUrl())).href;
  }

  /** A URL an `<img>` can show for the first mockup; call `revoke` when done with it. */
  async thumbnail(config: ProductConfig): Promise<Thumbnail | null> {
    const src = config.mockups[0]?.thumbnail ?? config.mockups[0]?.src;
    if (!src) return null;
    if (isLocalAssetUrl(src)) {
      const blob = await this.library.get(src);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      return { url, local: true, revoke: () => URL.revokeObjectURL(url) };
    }
    return { url: this.assetUrl(config, src), local: false, revoke: () => undefined };
  }
}

export interface Thumbnail {
  url: string;
  /** A `blob:` URL created for this view (cannot be served through an image loader). */
  local: boolean;
  revoke: () => void;
}

async function mapStrings<T>(value: T, fn: (text: string) => Promise<string>): Promise<T> {
  if (typeof value === 'string') return (await fn(value)) as unknown as T;
  if (Array.isArray(value)) {
    return (await Promise.all(value.map((item) => mapStrings(item, fn)))) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await mapStrings(item, fn)] as const),
    );
    return Object.fromEntries(entries) as T;
  }
  return value;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
