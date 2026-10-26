import { Service } from '@angular/core';
import { PRODUCT_LIMITS } from '../models/product.models';
import { CustomizerError, isAbortError } from './errors';

export interface ResolveRequest {
  /** Base URL of the personalization API, e.g. `https://api.example.com`. */
  apiBaseUrl: string;
  /** Public storefront key of the store (not a secret). */
  storeId: string;
  /** The host's id for the product on this page. */
  productId: string;
  variantId?: string | null;
  collectionIds?: readonly string[] | null;
}

export type ResolveOutcome =
  | {
      kind: 'mapped';
      /** The published configuration (schema v2) exactly as the API served it. */
      config: unknown;
      configId: string;
      version: number;
      scope: 'product' | 'variant' | 'collection';
    }
  | { kind: 'unmapped' };

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = PRODUCT_LIMITS.maxConfigBytes + 64 * 1024;

/** Where the public read endpoint lives, relative to the API base. */
export const STOREFRONT_PATH = '/api/v1/storefront/personalization/products';

export function storefrontUrl(request: ResolveRequest): string {
  const base = request.apiBaseUrl.replace(/\/+$/, '');
  const url = new URL(`${base}${STOREFRONT_PATH}/${encodeURIComponent(request.productId)}/config`);
  url.searchParams.set('storeId', request.storeId);
  if (request.variantId) url.searchParams.set('variantId', request.variantId);
  const collections = (request.collectionIds ?? []).filter(Boolean).slice(0, 20);
  if (collections.length) url.searchParams.set('collectionIds', collections.join(','));
  return url.href;
}

/**
 * Asks the public storefront endpoint which published configuration is mapped to the product the
 * host page shows. The request carries no credentials (it is a public, cacheable read), so the
 * browser's HTTP cache and the API's ETag keep repeat views cheap.
 */
@Service({ autoProvided: false })
export class StorefrontResolver {
  async resolve(request: ResolveRequest, signal: AbortSignal): Promise<ResolveOutcome> {
    let url: string;
    try {
      url = storefrontUrl(request);
    } catch {
      throw new CustomizerError(
        'config-load-failed',
        'The API base URL is not a valid URL.',
        false,
      );
    }
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'strict-origin-when-cross-origin',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (signal.aborted && isAbortError(error)) throw error;
      throw new CustomizerError(
        'config-load-failed',
        'The personalization service could not be reached.',
        true,
      );
    }
    if (response.status === 404) return { kind: 'unmapped' };
    if (!response.ok) {
      throw new CustomizerError(
        'config-load-failed',
        response.status === 429
          ? 'The personalization service is busy. Try again in a moment.'
          : `The personalization service answered ${response.status}.`,
        true,
      );
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_RESPONSE_BYTES) {
      throw new CustomizerError('config-load-failed', 'The configuration is too large.', false);
    }
    let body: unknown;
    try {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('too large');
      body = JSON.parse(text);
    } catch (error) {
      if (signal.aborted && isAbortError(error)) throw error;
      throw new CustomizerError(
        'config-load-failed',
        'The personalization service sent an unreadable response.',
        true,
      );
    }
    return parseOutcome(body);
  }
}

/** Accepts the API envelope `{ data: {...} }` and a bare payload. */
export function parseOutcome(body: unknown): ResolveOutcome {
  const root = asRecord(body);
  const data = asRecord(root?.['data']) ?? root;
  if (!data || data['personalizable'] !== true) return { kind: 'unmapped' };
  const scope = data['scope'];
  const configId = data['configId'];
  const version = data['version'];
  if (
    data['config'] === null ||
    typeof data['config'] !== 'object' ||
    typeof configId !== 'string' ||
    typeof version !== 'number'
  ) {
    throw new CustomizerError(
      'config-load-failed',
      'The personalization service sent an unexpected response.',
      false,
    );
  }
  return {
    kind: 'mapped',
    config: data['config'],
    configId,
    version,
    scope: scope === 'variant' || scope === 'collection' ? scope : 'product',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
