import { Service } from '@angular/core';
import { ConfigIssue, CustomizerConfig, LIMITS } from '../models/config.models';
import { validateConfig } from '../util/config-validator';
import { resolveBase } from '../util/url-policy';
import { CustomizerError, isAbortError } from './errors';

export interface ConfigInput {
  /** Object configuration (property). */
  config: unknown;
  configUrl: string | null;
  baseUrl: string | null;
  allowedOrigins: readonly string[] | null;
  documentBase: string;
  pageOrigin: string;
}

export type ConfigOutcome =
  | { kind: 'awaiting' }
  | { kind: 'conflict' }
  | { kind: 'invalid'; issues: ConfigIssue[] }
  | { kind: 'ready'; config: CustomizerConfig };

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

    const result = validateConfig(raw, {
      resolvedBase: resolved,
      policy: { pageOrigin: input.pageOrigin, allowedOrigins: input.allowedOrigins ?? [] },
    });
    return result.ok
      ? { kind: 'ready', config: result.config }
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
      if (text.length > LIMITS.maxConfigBytes) {
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
