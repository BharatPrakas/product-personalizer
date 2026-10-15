import { Service } from '@angular/core';
import { ConfigIssue } from '../models/config.models';
import { PRODUCT_LIMITS, ProductConfig, SourceSchemaVersion } from '../models/product.models';
import { validateConfig } from '../util/config-validator';
import { upgradeV1 } from '../util/config-upgrade';
import { validateProductConfig } from '../util/product-validator';
import { AssetPolicy, resolveBase } from '../util/url-policy';
import { CustomizerError, isAbortError } from './errors';

export interface ConfigInput {
  /** Object configuration (property). */
  config: unknown;
  configUrl: string | null;
  baseUrl: string | null;
  allowedOrigins: readonly string[] | null;
  /** Standalone authoring app: accept `idb:` and inline `data:image/` sources. */
  allowLocalAssets?: boolean;
  documentBase: string;
  pageOrigin: string;
}

export type ConfigOutcome =
  | { kind: 'awaiting' }
  | { kind: 'conflict' }
  | { kind: 'invalid'; issues: ConfigIssue[] }
  | { kind: 'ready'; config: ProductConfig; sourceVersion: SourceSchemaVersion };

const supplied = (value: unknown) => value !== null && value !== undefined && value !== '';

/** Fetches (for `configUrl`), validates and URL-resolves configuration. Stateless. */
@Service()
export class ConfigService {
  async load(input: ConfigInput, signal: AbortSignal): Promise<ConfigOutcome> {
    const hasObject = supplied(input.config);
    const hasUrl = supplied(input.configUrl);
    if (hasObject && hasUrl) return { kind: 'conflict' };
    if (!hasObject && !hasUrl) return { kind: 'awaiting' };

    let raw: unknown;
    let resolved;
    try {
      resolved = resolveBase({
        configUrl: hasUrl ? input.configUrl : null,
        baseUrl: supplied(input.baseUrl) ? input.baseUrl : null,
        documentBase: input.documentBase,
      });
    } catch {
      throw new CustomizerError(
        'config-load-failed',
        'The configuration URL or base URL is not a valid URL.',
        true,
      );
    }

    if (hasUrl) {
      raw = await this.fetchJson(resolved.configUrl as string, signal);
    } else if (typeof input.config === 'object') {
      try {
        // Plain-data copy: never evaluates, and the host's object is never mutated.
        raw = JSON.parse(JSON.stringify(input.config));
      } catch {
        return {
          kind: 'invalid',
          issues: [{ path: '', code: 'type', message: 'config must be JSON-serialisable data' }],
        };
      }
    } else {
      return {
        kind: 'invalid',
        issues: [
          {
            path: '',
            code: 'type',
            message: 'config must be assigned as an object property (not an HTML attribute)',
          },
        ],
      };
    }

    const policy: AssetPolicy = {
      pageOrigin: input.pageOrigin,
      allowedOrigins: input.allowedOrigins ?? [],
      allowLocalAssets: input.allowLocalAssets === true,
    };
    const version =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)['schemaVersion']
        : undefined;
    if (version === 2) {
      const result = validateProductConfig(raw, { resolvedBase: resolved, policy });
      return result.ok
        ? { kind: 'ready', config: result.config, sourceVersion: 2 }
        : { kind: 'invalid', issues: result.issues };
    }
    // Version 1 (and anything unrecognised, which the v1 validator reports) takes the compatibility path.
    const result = validateConfig(raw, { resolvedBase: resolved, policy });
    return result.ok
      ? { kind: 'ready', config: upgradeV1(result.config), sourceVersion: 1 }
      : { kind: 'invalid', issues: result.issues };
  }

  private async fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await fetch(url, {
        signal,
        mode: 'cors',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new CustomizerError(
          'config-load-failed',
          `The configuration could not be loaded (HTTP ${response.status}).`,
          true,
        );
      }
      const text = await response.text();
      if (text.length > PRODUCT_LIMITS.maxConfigBytes) {
        throw new CustomizerError(
          'config-load-failed',
          'The configuration file is too large.',
          true,
        );
      }
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof CustomizerError || isAbortError(error) || signal.aborted) throw error;
      if (error instanceof SyntaxError) {
        throw new CustomizerError(
          'config-load-failed',
          'The configuration is not valid JSON.',
          true,
        );
      }
      throw new CustomizerError(
        'config-load-failed',
        'The configuration could not be loaded (network error, or the server blocks cross-origin access).',
        true,
      );
    }
  }
}
