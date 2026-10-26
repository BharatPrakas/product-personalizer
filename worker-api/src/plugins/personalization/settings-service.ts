/**
 * Per-store plugin settings, kept in the platform's existing `store_plugins.settings` jsonb (no new
 * column). Currently one setting: `storefrontOrigins`, the browser origins allowed to call the
 * PUBLIC storefront routes cross-origin. Empty (the default) means no cross-origin access.
 */

import { StorePluginsRepository } from '../../platform/plugin-permissions/repository';
import { NotFoundError, ValidationError, type FieldIssue } from '../../shared/errors';
import { type PluginContext, writeAudit } from './support';
import { PLUGIN_ID } from './types';

export interface StorefrontSettingsDto {
  storefrontOrigins: string[];
}

/** Read the stored list defensively: the jsonb is not guaranteed to hold what we wrote. */
export function originsFromSettings(settings: Record<string, unknown> | undefined): string[] {
  const raw = settings?.['storefrontOrigins'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((o): o is string => typeof o === 'string').map((o) => o.toLowerCase());
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
  private readonly repo: StorePluginsRepository;

  constructor(private readonly ctx: PluginContext) {
    this.repo = new StorePluginsRepository(ctx.db);
  }

  async getStorefront(): Promise<StorefrontSettingsDto> {
    const record = await this.repo.get(this.ctx.storeId, PLUGIN_ID);
    return { storefrontOrigins: originsFromSettings(record?.settings) };
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
    const record = await this.repo.updateSettings(this.ctx.storeId, PLUGIN_ID, { storefrontOrigins });
    if (!record) throw new NotFoundError('The plugin is not installed for this store.');
    await writeAudit(this.ctx, 'settings.update', 'settings', PLUGIN_ID, { storefrontOrigins: storefrontOrigins.length });
    return { storefrontOrigins };
  }
}
