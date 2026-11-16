/**
 * Object-storage simulators for the direct-upload tests. They stand in for the PROVIDER, i.e. the
 * thing the browser (and, for S3, the Worker) talks to over HTTP:
 *
 *  - `FakeS3`  implements the S3 REST calls the S3 adapter makes (PUT / GET / HEAD / DELETE / server-side
 *              COPY with `x-amz-copy-source-if-match`) behind a stubbed global `fetch`, and VERIFIES the
 *              SigV4 query signature of every presigned request exactly as S3 would (signature, expiry,
 *              method, signed headers). That is what makes a header or key mismatch fail a test.
 *  - R2        the adapter uses the Worker binding (`InMemoryR2`) server-side; the browser's presigned PUT
 *              to R2's S3 endpoint is verified by the same signature check and then written to the bucket.
 *
 * `driver(...)` returns one uniform handle so every direct-upload test runs against both providers.
 */

import { vi } from 'vitest';
import { AwsClient } from 'aws4fetch';
import type { Env } from '../src/config/environment';
import { InMemoryR2 } from './helpers';

export type Driver = 'r2' | 's3';

export const S3_SETTINGS = {
  bucket: 'zb-plugins-test',
  region: 'us-west-2',
  accessKeyId: 'AKIAS3TESTKEY',
  secretAccessKey: 's3-test-secret',
};
export const R2_SETTINGS = {
  accountId: 'abcdef0123456789abcdef0123456789',
  bucket: 'zb-r2-test',
  accessKeyId: 'R2TESTKEYID',
  secretAccessKey: 'r2-test-secret',
};
export const R2_ENDPOINT = `https://${R2_SETTINGS.accountId}.r2.cloudflarestorage.com`;

interface StoredS3Object {
  bytes: Uint8Array;
  contentType: string;
  etag: string;
  meta: Record<string, string>;
}

/** What a browser would send: the presigned URL + the headers the Worker told it to use. */
export interface BrowserPutInit {
  uploadUrl: string;
  method?: string;
  headers: Record<string, string>;
}

export interface Provider {
  driver: Driver;
  /** Env overrides to pass as `call(..., { env })`. */
  env: Partial<Env>;
  has(key: string): boolean;
  keys(prefix?: string): string[];
  bytes(key: string): Uint8Array | undefined;
  contentType(key: string): string | undefined;
  /** Writes an object directly (simulates a provider-side change, e.g. an overwrite). */
  write(key: string, bytes: Uint8Array, contentType: string): void;
  remove(key: string): void;
  /** The browser's direct PUT. `now` lets a test act after the URL has expired. */
  browserPut(init: BrowserPutInit, bytes: Uint8Array, opts?: { now?: Date; headers?: Record<string, string> }): Promise<Response>;
  /** A browser GET against a presigned download URL. */
  browserGet(url: string, opts?: { now?: Date }): Promise<Response>;
  /** Makes the next server-side read of the provider fail hard (simulated outage). */
  injectReadOutage(): void;
  restore(): void;
}

const amzParam = (url: URL, name: string) => url.searchParams.get(name) ?? '';

/** Mirrors the provider's check of a presigned URL. Returns an error code, or null when valid. */
async function verifyPresigned(
  url: URL,
  method: string,
  headers: Headers,
  creds: { accessKeyId: string; secretAccessKey: string; region: string },
  now: Date,
): Promise<string | null> {
  const given = url.searchParams.get('X-Amz-Signature');
  if (!given) return 'MissingSecurityHeader';
  const date = amzParam(url, 'X-Amz-Date'); // 20260101T000000Z
  const expires = Number(amzParam(url, 'X-Amz-Expires'));
  const issued = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return 'AuthorizationQueryParametersError';
  if (now.getTime() > issued + expires * 1000) return 'AccessDenied'; // "Request has expired"
  if (!amzParam(url, 'X-Amz-Credential').startsWith(`${creds.accessKeyId}/`)) return 'InvalidAccessKeyId';

  // Recompute the signature from what the browser actually sent.
  const signedHeaders = amzParam(url, 'X-Amz-SignedHeaders').split(';').filter((h) => h !== 'host');
  const sendHeaders: Record<string, string> = {};
  for (const name of signedHeaders) sendHeaders[name] = headers.get(name) ?? '';
  const unsigned = new URL(url.toString());
  unsigned.searchParams.delete('X-Amz-Signature');
  const client = new AwsClient({ ...creds, service: 's3' });
  const recomputed = await client.sign(unsigned.toString(), {
    method,
    headers: sendHeaders,
    aws: { signQuery: true, allHeaders: true, datetime: date },
  });
  return new URL(recomputed.url).searchParams.get('X-Amz-Signature') === given ? null : 'SignatureDoesNotMatch';
}

const errorBody = (code: string, status: number) =>
  new Response(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`, { status });

let counter = 0;
const nextEtag = () => `"${(++counter).toString(16).padStart(8, '0')}"`;

/** An in-memory S3. Installed as the global `fetch`, so `S3ObjectStorage` talks to it unmodified. */
export class FakeS3 {
  readonly objects = new Map<string, StoredS3Object>();
  /** Every request, for assertions about what hit the provider. */
  readonly log: Array<{ method: string; key: string; presigned: boolean }> = [];
  /** Fail the next `count` requests of `method` (aws4fetch retries 5xx twice, so use 3 for a hard failure). */
  failNext: { method: string; status: number; count: number } | null = null;
  now = (): Date => new Date();

  private parse(url: URL): string {
    // Virtual-hosted: https://<bucket>.s3.<region>.amazonaws.com/<key>
    return decodeURIComponent(url.pathname.slice(1));
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const key = this.parse(url);
    const presigned = url.searchParams.has('X-Amz-Signature');
    this.log.push({ method: request.method, key, presigned });
    if (this.failNext && this.failNext.method === request.method) {
      const failure = this.failNext;
      if (--failure.count <= 0) this.failNext = null;
      return errorBody('InternalError', failure.status);
    }
    if (presigned) {
      const error = await verifyPresigned(url, request.method, request.headers, S3_SETTINGS, this.now());
      if (error) return errorBody(error, 403);
    } else if (!request.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256')) {
      return errorBody('AccessDenied', 403);
    }

    switch (request.method) {
      case 'PUT': {
        const source = request.headers.get('x-amz-copy-source');
        if (source) return this.copy(request, key, decodeURIComponent(source));
        const bytes = new Uint8Array(await request.arrayBuffer());
        const etag = nextEtag();
        this.objects.set(key, {
          bytes,
          contentType: request.headers.get('content-type') ?? 'binary/octet-stream',
          etag,
          meta: metaOf(request.headers),
        });
        return new Response(null, { status: 200, headers: { etag } });
      }
      case 'GET':
      case 'HEAD': {
        const object = this.objects.get(key);
        if (!object) return errorBody('NoSuchKey', 404);
        const headers = {
          etag: object.etag,
          'content-length': String(object.bytes.byteLength),
          'content-type': object.contentType,
        };
        return new Response(request.method === 'HEAD' ? null : object.bytes, { status: 200, headers });
      }
      case 'DELETE':
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      default:
        return errorBody('MethodNotAllowed', 405);
    }
  };

  private copy(request: Request, destKey: string, source: string): Response {
    const sourceKey = source.replace(new RegExp(`^/${S3_SETTINGS.bucket}/`), '');
    const object = this.objects.get(sourceKey);
    if (!object) return errorBody('NoSuchKey', 404);
    const ifMatch = request.headers.get('x-amz-copy-source-if-match');
    if (ifMatch && ifMatch !== object.etag) return errorBody('PreconditionFailed', 412);
    const etag = nextEtag();
    this.objects.set(destKey, {
      bytes: object.bytes,
      contentType: request.headers.get('content-type') ?? object.contentType,
      etag,
      meta: metaOf(request.headers),
    });
    return new Response(`<CopyObjectResult><ETag>${etag}</ETag></CopyObjectResult>`, { status: 200 });
  }
}

function metaOf(headers: Headers): Record<string, string> {
  const meta: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith('x-amz-meta-')) meta[name.slice('x-amz-meta-'.length)] = value;
  });
  return meta;
}

/** A uniform handle over either provider, with the env that points the Worker at it. */
export function provider(driver: Driver, bucket: InMemoryR2): Provider {
  if (driver === 's3') {
    const s3 = new FakeS3();
    vi.stubGlobal('fetch', s3.fetch);
    return {
      driver,
      env: {
        STORAGE_DRIVER: 's3',
        S3_BUCKET: S3_SETTINGS.bucket,
        S3_REGION: S3_SETTINGS.region,
        AWS_ACCESS_KEY_ID: S3_SETTINGS.accessKeyId,
        AWS_SECRET_ACCESS_KEY: S3_SETTINGS.secretAccessKey,
      },
      has: (key) => s3.objects.has(key),
      keys: (prefix = '') => [...s3.objects.keys()].filter((k) => k.startsWith(prefix)),
      bytes: (key) => s3.objects.get(key)?.bytes,
      contentType: (key) => s3.objects.get(key)?.contentType,
      write: (key, bytes, contentType) => {
        s3.objects.set(key, { bytes, contentType, etag: nextEtag(), meta: {} });
      },
      remove: (key) => void s3.objects.delete(key),
      browserPut: (init, bytes, opts) => {
        s3.now = () => opts?.now ?? new Date();
        return browserFetch(s3.fetch, init, bytes, opts);
      },
      browserGet: (url, opts) => {
        s3.now = () => opts?.now ?? new Date();
        return s3.fetch(url);
      },
      injectReadOutage: () => {
        s3.failNext = { method: 'GET', status: 500, count: 3 };
      },
      restore: () => vi.unstubAllGlobals(),
    };
  }

  // R2: server-side operations use the binding; the browser's PUT lands in the same bucket.
  const browserWrite = async (request: Request, now: Date): Promise<Response> => {
    const url = new URL(request.url);
    const error = await verifyPresigned(url, request.method, request.headers, { ...R2_SETTINGS, region: 'auto' }, now);
    if (error) return errorBody(error, 403);
    const prefix = `/${R2_SETTINGS.bucket}/`;
    if (url.origin !== R2_ENDPOINT || !url.pathname.startsWith(prefix)) return errorBody('NoSuchBucket', 404);
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    if (request.method === 'PUT') {
      await bucket.put(key, new Uint8Array(await request.arrayBuffer()), {
        httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' },
      });
      return new Response(null, { status: 200 });
    }
    const object = bucket.objects.get(key);
    return object ? new Response(object.bytes, { status: 200, headers: { 'content-type': object.contentType } }) : errorBody('NoSuchKey', 404);
  };
  return {
    driver,
    env: {
      STORAGE_DRIVER: 'r2',
      PERSONALIZATION_ASSETS: bucket as unknown as R2Bucket,
      R2_ACCOUNT_ID: R2_SETTINGS.accountId,
      R2_BUCKET_NAME: R2_SETTINGS.bucket,
      R2_ACCESS_KEY_ID: R2_SETTINGS.accessKeyId,
      R2_SECRET_ACCESS_KEY: R2_SETTINGS.secretAccessKey,
    },
    has: (key) => bucket.objects.has(key),
    keys: (prefix = '') => [...bucket.objects.keys()].filter((k) => k.startsWith(prefix)),
    bytes: (key) => bucket.objects.get(key)?.bytes,
    contentType: (key) => bucket.objects.get(key)?.contentType,
    write: (key, bytes, contentType) => void bucket.put(key, bytes, { httpMetadata: { contentType } }),
    remove: (key) => void bucket.objects.delete(key),
    browserPut: (init, bytes, opts) =>
      browserFetch((req) => browserWrite(req as Request, opts?.now ?? new Date()), init, bytes, opts),
    browserGet: (url, opts) => browserWrite(new Request(url), opts?.now ?? new Date()),
    injectReadOutage: () => {
      const original = bucket.get.bind(bucket);
      bucket.get = async () => {
        bucket.get = original;
        throw new Error('R2 is unavailable');
      };
    },
    restore: () => undefined,
  };
}

function browserFetch(
  send: (input: Request) => Promise<Response>,
  init: BrowserPutInit,
  bytes: Uint8Array,
  opts?: { headers?: Record<string, string> },
): Promise<Response> {
  // A browser sends exactly the headers it was given (plus its own, which are never signed).
  const headers = new Headers({ ...init.headers, ...opts?.headers });
  return send(new Request(init.uploadUrl, { method: init.method ?? 'PUT', headers, body: bytes as BodyInit }));
}
