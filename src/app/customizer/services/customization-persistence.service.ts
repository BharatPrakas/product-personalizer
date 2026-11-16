import { Service } from '@angular/core';
import { DirectUploadError, uploadDirect, type UploadGateway, type UploadOptions } from '../util/direct-upload';
import { CustomizerError, isAbortError } from './errors';

/** Where the shopper endpoints live, relative to the API base. */
export const SHOPPER_PATH = '/api/v1/storefront/personalization';

export type PersistKind = 'upload' | 'preview' | 'artwork';

export interface PersistTarget {
  /** Base URL of the personalization API. */
  apiBaseUrl: string;
  /** Public storefront key of the store (not a secret). */
  storeId: string;
}

export interface UploadedFile {
  assetId: string;
  uploadToken: string;
}

export interface CreateRequest {
  productId: string;
  variantId?: string | null;
  collectionIds?: readonly string[];
  /** The template the shopper designed against (as rendered). */
  configId: string;
  configVersion: number;
  data: Record<string, unknown>;
  assets: readonly UploadedFile[];
}

export interface CreatedCustomization {
  customizationId: string;
  /** Bearer token for reading / updating THIS customization; kept in memory only. */
  accessToken: string;
  expiresAt: string;
}

const UPLOAD_TIMEOUT_MS = 30_000;
/** Per-attempt timeout of the direct PUT to object storage (a large print file on a slow link). */
const DIRECT_PUT_TIMEOUT_MS = 120_000;
const CREATE_TIMEOUT_MS = 15_000;

/** Shopper-safe wording per failure; never includes server details or shopper content. */
const MESSAGES = {
  network: 'The personalization service could not be reached. Check your connection and try again.',
  rateLimited: 'Too many requests. Please wait a moment and try again.',
  changed: 'This product’s personalization was just updated. Please reload the page and try again.',
  unavailable: 'Personalization is not available for this product right now.',
  badFile: 'One of the images could not be saved. It may be too large or in an unsupported format.',
  expired: 'The upload took too long. Please try again.',
  generic: 'Your design could not be saved. Please try again.',
} as const;

/**
 * A Worker error response, in the shape the direct-upload core reads (`status`, `code`, `details`), kept
 * separate from the shopper-facing CustomizerError so retry decisions never depend on message text.
 */
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: { reason?: unknown },
  ) {
    super(`HTTP ${status}`);
  }

  static async from(response: Response): Promise<HttpFailure> {
    try {
      const json = (await response.json()) as { error?: { code?: unknown; details?: { reason?: unknown } } };
      return new HttpFailure(response.status, typeof json?.error?.code === 'string' ? json.error.code : '', json?.error?.details);
    } catch {
      return new HttpFailure(response.status, '');
    }
  }
}

function api(target: PersistTarget, path: string, query: Record<string, string>): string {
  const url = new URL(`${target.apiBaseUrl.replace(/\/+$/, '')}${SHOPPER_PATH}${path}`);
  url.searchParams.set('storeId', target.storeId);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}

/**
 * Saves a shopper's design to the personalization API: each image to private storage, then the
 * customization itself. The response gives the element a `customizationId` — an identifier, not a
 * credential — plus a scoped token that never leaves this module's callers (it is not put on the cart).
 */
@Service({ autoProvided: false })
export class CustomizationPersistence {
  /**
   * Uploads one private file. The bytes go straight from the browser to object storage on a presigned URL
   * (the Worker only authorizes it and later verifies the object); the shopper token that authorizes
   * confirming — and later attaching — the file travels in the Worker calls, never to the storage host.
   * Falls back to the proxied route only where the Worker has direct uploads switched off.
   */
  async upload(
    target: PersistTarget,
    file: { kind: PersistKind; blob: Blob; filename?: string },
    signal: AbortSignal,
    options: Omit<UploadOptions, 'signal'> = {},
  ): Promise<UploadedFile> {
    // The upload token is issued with the first presigned URL and authorizes everything after it.
    let uploadToken: string | null = null;
    const gateway: UploadGateway<UploadedFile> = {
      initiate: async (renewUploadId) => {
        const body = this.dataOf(
          await this.request(
            api(target, '/uploads/url', {}),
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                // Renewing an open upload proves ownership with the token it was issued.
                ...(renewUploadId && uploadToken ? { Authorization: `Bearer ${uploadToken}` } : {}),
              },
              body: JSON.stringify({
                kind: file.kind,
                contentType: file.blob.type || 'application/octet-stream',
                size: file.blob.size,
                ...(file.filename ? { filename: file.filename.slice(0, 200) } : {}),
                ...(renewUploadId ? { uploadId: renewUploadId } : {}),
              }),
            },
            CREATE_TIMEOUT_MS,
            signal,
            true,
          ),
        );
        if (
          typeof body['uploadId'] !== 'string' ||
          typeof body['uploadUrl'] !== 'string' ||
          typeof body['uploadToken'] !== 'string'
        ) {
          throw new HttpFailure(502, 'bad_response');
        }
        uploadToken = body['uploadToken'];
        return {
          kind: 'pending',
          put: {
            uploadId: body['uploadId'],
            uploadUrl: body['uploadUrl'],
            method: 'PUT',
            headers: (body['headers'] as Record<string, string> | undefined) ?? {},
            expiresIn: typeof body['expiresIn'] === 'number' ? body['expiresIn'] : 300,
          },
        };
      },
      complete: async (uploadId) => {
        const body = this.dataOf(
          await this.request(
            api(target, '/uploads/complete', {}),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uploadToken ?? ''}` },
              body: JSON.stringify({ uploadId }),
            },
            CREATE_TIMEOUT_MS,
            signal,
            true,
          ),
        );
        if (typeof body['assetId'] !== 'string' || typeof body['uploadToken'] !== 'string') {
          throw new HttpFailure(502, 'bad_response');
        }
        return { assetId: body['assetId'], uploadToken: body['uploadToken'] };
      },
    };

    try {
      return await uploadDirect(file.blob, gateway, { putTimeoutMs: DIRECT_PUT_TIMEOUT_MS, ...options, signal });
    } catch (error) {
      if (error instanceof DirectUploadError) {
        if (error.code === 'not-configured') return this.uploadProxied(target, file, signal);
        throw this.uploadFailure(error);
      }
      throw error;
    }
  }

  /** Shopper-safe wording for a failed direct upload (never URLs, keys or server detail). */
  private uploadFailure(error: DirectUploadError): CustomizerError {
    switch (error.code) {
      case 'too-large':
      case 'unsupported':
      case 'rejected':
        return new CustomizerError('save-failed', MESSAGES.badFile, false);
      case 'rate-limited':
        return new CustomizerError('save-failed', MESSAGES.rateLimited, true);
      case 'url-expired':
        return new CustomizerError('save-failed', MESSAGES.expired, true);
      case 'network':
      case 'timeout':
        return new CustomizerError('save-failed', MESSAGES.network, true);
      default:
        return new CustomizerError('save-failed', MESSAGES.generic, error.retryable);
    }
  }

  /** The legacy route: the bytes pass through the Worker. Only used where presigned uploads are off. */
  private async uploadProxied(
    target: PersistTarget,
    file: { kind: PersistKind; blob: Blob; filename?: string },
    signal: AbortSignal,
  ): Promise<UploadedFile> {
    const url = api(target, '/uploads', {
      kind: file.kind,
      ...(file.filename ? { filename: file.filename.slice(0, 200) } : {}),
    });
    const body = await this.request(url, { method: 'POST', body: file.blob, headers: { 'Content-Type': file.blob.type || 'application/octet-stream' } }, UPLOAD_TIMEOUT_MS, signal);
    const data = this.dataOf(body);
    if (typeof data['assetId'] !== 'string' || typeof data['uploadToken'] !== 'string') {
      throw new CustomizerError('save-failed', MESSAGES.generic, true);
    }
    return { assetId: data['assetId'], uploadToken: data['uploadToken'] };
  }

  async create(target: PersistTarget, request: CreateRequest, signal: AbortSignal): Promise<CreatedCustomization> {
    const body = await this.request(
      api(target, '/customizations', {}),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: request.productId,
          ...(request.variantId ? { variantId: request.variantId } : {}),
          ...(request.collectionIds?.length ? { collectionIds: request.collectionIds } : {}),
          configId: request.configId,
          configVersion: request.configVersion,
          data: request.data,
          assets: request.assets,
        }),
      },
      CREATE_TIMEOUT_MS,
      signal,
    );
    const data = this.dataOf(body);
    if (typeof data['customizationId'] !== 'string' || typeof data['accessToken'] !== 'string') {
      throw new CustomizerError('save-failed', MESSAGES.generic, true);
    }
    return {
      customizationId: data['customizationId'],
      accessToken: data['accessToken'],
      expiresAt: typeof data['expiresAt'] === 'string' ? data['expiresAt'] : '',
    };
  }

  private dataOf(body: unknown): Record<string, unknown> {
    const data = (body as { data?: unknown } | null)?.data;
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  }

  /**
   * `forUploadCore`: on failure throw an {@link HttpFailure} carrying the status / server code, which the
   * direct-upload core classifies (retry, renew, reject). Otherwise failures become shopper-safe
   * `CustomizerError`s immediately.
   */
  private async request(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    signal: AbortSignal,
    forUploadCore = false,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'strict-origin-when-cross-origin',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (signal.aborted && isAbortError(error)) throw error;
      if (forUploadCore) throw new HttpFailure(0, '');
      throw new CustomizerError('save-failed', MESSAGES.network, true);
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new CustomizerError('save-failed', MESSAGES.generic, true);
      }
    }
    if (forUploadCore) throw await HttpFailure.from(response);
    throw await this.failure(response);
  }

  private async failure(response: Response): Promise<CustomizerError> {
    let reason: string | undefined;
    try {
      const json = (await response.json()) as { error?: { details?: { reason?: unknown } } };
      const value = json?.error?.details?.reason;
      reason = typeof value === 'string' ? value : undefined;
    } catch {
      // The status alone decides the message.
    }
    const status = response.status;
    if (status === 429) return new CustomizerError('save-failed', MESSAGES.rateLimited, true);
    if (status === 409 && reason === 'config_changed') return new CustomizerError('save-failed', MESSAGES.changed, false);
    if (status === 404) return new CustomizerError('save-failed', MESSAGES.unavailable, false);
    if (status === 413 || status === 415) return new CustomizerError('save-failed', MESSAGES.badFile, false);
    return new CustomizerError('save-failed', MESSAGES.generic, status >= 500);
  }
}
