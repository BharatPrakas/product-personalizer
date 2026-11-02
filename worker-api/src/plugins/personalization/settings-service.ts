/**
 * Per-store settings. Currently one setting: `storefrontOrigins`, the browser origins allowed to call
 * the PUBLIC storefront routes cross-origin. Empty (the default) means no cross-origin access.
 */

import { StoreSettingsRepository } from '../../modules/store-settings/repository';
import { ValidationError, type FieldIssue } from '../../shared/errors';
import { type StoreContext, writeAudit } from './support';

export interface StorefrontSettingsDto {
  storefrontOrigins: string[];
}

/** `https://Shop.example.com` -> `https://shop.example.com`; null if it is not a bare http(s) origin. */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/') return null;
  return url.origin;
}

export class SettingsService {
  private readonly repo: StoreSettingsRepository;

  constructor(private readonly ctx: StoreContext) {
    this.repo = new StoreSettingsRepository(ctx.db);
  }

  async getStorefront(): Promise<StorefrontSettingsDto> {
    const settings = await this.repo.get(this.ctx.storeId);
    return { storefrontOrigins: settings?.storefrontOrigins ?? [] };
  }

  async setStorefrontOrigins(input: string[]): Promise<StorefrontSettingsDto> {
    const issues: FieldIssue[] = [];
    const origins = new Set<string>();
    input.forEach((value, index) => {
      const origin = normalizeOrigin(value);
      if (origin) origins.add(origin);
      else {
        issues.push({
          path: `storefrontOrigins.${index}`,
          code: 'invalid_origin',
          message: 'Must be an origin such as https://shop.example.com (scheme, host, optional port; no path).',
        });
      }
    });
    if (issues.length > 0) throw new ValidationError(issues);

    const storefrontOrigins = [...origins];
    await this.repo.setStorefrontOrigins(this.ctx.storeId, storefrontOrigins);
    await writeAudit(this.ctx, 'settings.update', 'settings', this.ctx.storeId, { storefrontOrigins: storefrontOrigins.length });
    return { storefrontOrigins };
  }
}
