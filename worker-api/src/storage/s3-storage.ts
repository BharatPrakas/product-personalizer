/**
 * AWS S3 object storage for local, dev and staging. Calls the S3 REST API directly with AWS
 * Signature V4 (via `aws4fetch`), which works on the Workers runtime and in Node tests, so no
 * AWS SDK is bundled. The credentials are an IAM user scoped to one bucket; they are supplied as
 * secrets (`.dev.vars` locally, `wrangler secret put` in deployed environments) and never logged.
 *
 * Addressing: virtual-hosted style (`https://<bucket>.s3.<region>.amazonaws.com/<key>`) by default.
 * Set `S3_ENDPOINT` for an S3-compatible service (for example MinIO); that switches to path style.
 */

import { AwsClient } from 'aws4fetch';
import type { FetchedObject, ObjectStorage, PutOptions, StoredObject } from './object-storage';
import { StorageRequestError } from './object-storage';

export interface S3StorageSettings {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Required with temporary credentials (access key id starting `ASIA`); omit for long-term keys. */
  sessionToken?: string | null;
  /** Optional S3-compatible endpoint, e.g. `http://127.0.0.1:9000`. Omit for AWS. */
  endpoint?: string | null;
}

/**
 * Builds the error for a failed S3 call, including S3's error code (`<Code>` in the XML body, e.g.
 * `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `AccessDenied`). The code names the cause and is not
 * sensitive; the rest of the body (which can echo request details) is discarded.
 */
async function failure(operation: string, response: Response): Promise<StorageRequestError> {
  let code: string | undefined;
  try {
    const text = (await response.text()).slice(0, 4096);
    code = /<Code>([A-Za-z0-9]+)<\/Code>/.exec(text)?.[1];
  } catch {
    // No readable body (for example a HEAD response).
  }
  return new StorageRequestError(operation, response.status, code);
}

/** Encodes each path segment but keeps the `/` separators that the key format relies on. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: AwsClient;
  private readonly baseUrl: string;
  private readonly pathStyle: boolean;

  constructor(private readonly settings: S3StorageSettings) {
    this.client = new AwsClient({
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      ...(settings.sessionToken ? { sessionToken: settings.sessionToken } : {}),
      service: 's3',
      region: settings.region,
      // aws4fetch retries 5xx/429 up to 10 times with exponential backoff by default, which could hold
      // a Worker request open for a long time. Keep it short: 2 retries, 100ms then 200ms.
      retries: 2,
      initRetryMs: 100,
    });
    if (settings.endpoint) {
      this.baseUrl = settings.endpoint.replace(/\/+$/, '');
      this.pathStyle = true;
    } else {
      this.baseUrl = `https://${settings.bucket}.s3.${settings.region}.amazonaws.com`;
      this.pathStyle = false;
    }
  }

  private url(key: string): string {
    const path = encodeKey(key);
    return this.pathStyle
      ? `${this.baseUrl}/${encodeURIComponent(this.settings.bucket)}/${path}`
      : `${this.baseUrl}/${path}`;
  }

  async put(key: string, body: ArrayBuffer | ReadableStream, opts: PutOptions): Promise<StoredObject> {
    const headers: Record<string, string> = {
      'Content-Type': opts.contentType,
      // Ownership metadata, mirroring the R2 adapter.
      'x-amz-meta-store-id': opts.storeId,
    };
    const response = await this.client.fetch(this.url(key), {
      method: 'PUT',
      headers,
      body: body as BodyInit,
    });
    if (!response.ok) throw await failure('put', response);
    const size = await this.sizeOf(key, body);
    return { size, etag: response.headers.get('etag') ?? '' };
  }

  /** The PUT response has no size, so take it from the bytes we just sent when we can. */
  private async sizeOf(key: string, body: ArrayBuffer | ReadableStream): Promise<number> {
    if (body instanceof ArrayBuffer) return body.byteLength;
    const head = await this.head(key);
    return head?.size ?? 0;
  }

  async head(key: string): Promise<StoredObject | null> {
    const response = await this.client.fetch(this.url(key), { method: 'HEAD' });
    if (response.status === 404) return null;
    if (!response.ok) throw await failure('head', response);
    return {
      size: Number(response.headers.get('content-length') ?? '0'),
      etag: response.headers.get('etag') ?? '',
    };
  }

  async get(key: string): Promise<FetchedObject | null> {
    const response = await this.client.fetch(this.url(key), { method: 'GET' });
    if (response.status === 404) return null;
    if (!response.ok || !response.body) throw await failure('get', response);
    return {
      body: response.body,
      size: Number(response.headers.get('content-length') ?? '0'),
      etag: response.headers.get('etag') ?? '',
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.client.fetch(this.url(key), { method: 'DELETE' });
    // S3 returns 204 for a delete, and 204 also for a missing key. 404 is treated as already gone.
    if (!response.ok && response.status !== 404) throw await failure('delete', response);
  }
}
