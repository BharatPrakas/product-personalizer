/** Storage-adapter tests for the direct-transfer additions (presign / copy / bounded reads), R2 + S3. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3ObjectStorage } from '../src/storage/s3-storage';
import { R2ObjectStorage } from '../src/storage/r2-storage';
import { createObjectStorage } from '../src/storage';
import {
  ObjectTooLargeError,
  StorageConfigError,
  StoragePreconditionError,
  StorageRequestError,
  pendingObjectKey,
  readLimited,
  sameEtag,
} from '../src/storage/object-storage';
import { loadConfig, type Env } from '../src/config/environment';
import { InMemoryR2 } from './helpers';

const S3 = { bucket: 'zb-assets', region: 'eu-west-1', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-x' };
const R2 = { bucket: 'zb-r2', accessKeyId: 'R2ID', secretAccessKey: 'r2-secret', endpoint: 'https://acct1234.r2.cloudflarestorage.com' };
const SIGNED_AT = new Date('2026-03-04T05:06:07.000Z');
const KEY = 'stores/s1/product-personalization/pending/11111111-1111-4111-8111-111111111111';

afterEach(() => vi.unstubAllGlobals());

interface Call { url: string; method: string; headers: Headers }
function mockFetch(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(String(input));
    const call = { url: request.url, method: request.method, headers: request.headers };
    calls.push(call);
    return respond(call);
  }));
  return calls;
}

describe('S3 presigned URLs', () => {
  const storage = () => new S3ObjectStorage({ ...S3, signingTime: SIGNED_AT });

  it('signs a PUT for exactly one key, method and Content-Type, with the requested expiry', async () => {
    const result = await storage().presignPut(KEY, { contentType: 'image/png', expiresInSeconds: 300 });
    const url = new URL(result.url);
    expect(url.origin).toBe('https://zb-assets.s3.eu-west-1.amazonaws.com');
    expect(url.pathname).toBe(`/${KEY}`);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIDTEST/20260304/eu-west-1/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260304T050607Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png' }, expiresIn: 300 });
    expect(result.url).not.toContain('secret-x');
  });

  it('is deterministic for a fixed time and changes with the key, type and expiry', async () => {
    const sign = async (key: string, contentType: string, expires: number) =>
      new URL((await storage().presignPut(key, { contentType, expiresInSeconds: expires })).url).searchParams.get('X-Amz-Signature');
    const base = await sign(KEY, 'image/png', 300);
    expect(await sign(KEY, 'image/png', 300)).toBe(base);
    expect(await sign(`${KEY}x`, 'image/png', 300)).not.toBe(base);
    expect(await sign(KEY, 'image/jpeg', 300)).not.toBe(base);
    expect(await sign(KEY, 'image/png', 301)).not.toBe(base);
  });

  it('clamps the lifetime to something sane', async () => {
    const long = await storage().presignGet(KEY, { expiresInSeconds: 10_000_000 });
    expect(long.expiresIn).toBe(3600);
    expect(new URL(long.url).searchParams.get('X-Amz-Expires')).toBe('3600');
    expect((await storage().presignGet(KEY, { expiresInSeconds: 0 })).expiresIn).toBe(1);
  });

  it('signs a GET without any extra headers', async () => {
    const result = await storage().presignGet(KEY, { expiresInSeconds: 60 });
    expect(result).toMatchObject({ method: 'GET', headers: {}, expiresIn: 60 });
    expect(new URL(result.url).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('percent-encodes awkward keys but keeps the path structure', async () => {
    const result = await storage().presignGet('stores/a b/ü.png', { expiresInSeconds: 60 });
    expect(new URL(result.url).pathname).toBe('/stores/a%20b/%C3%BC.png');
  });
});

describe('R2 presigned URLs (S3-compatible API)', () => {
  const storage = (bucket = new InMemoryR2()) =>
    new R2ObjectStorage(bucket as unknown as R2Bucket, { ...R2, signingTime: SIGNED_AT });

  it('presigns against the R2 S3 endpoint, path-style, region auto — never a public domain', async () => {
    const result = await storage().presignPut(KEY, { contentType: 'image/webp', expiresInSeconds: 300 });
    const url = new URL(result.url);
    expect(url.origin).toBe('https://acct1234.r2.cloudflarestorage.com');
    expect(url.pathname).toBe(`/zb-r2/${KEY}`);
    expect(url.searchParams.get('X-Amz-Credential')).toBe('R2ID/20260304/auto/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(result.headers).toEqual({ 'Content-Type': 'image/webp' });
    expect((await storage().presignGet(KEY, { expiresInSeconds: 60 })).method).toBe('GET');
  });

  it('reports exactly what is missing instead of failing later', async () => {
    const bare = new R2ObjectStorage(new InMemoryR2() as unknown as R2Bucket);
    await expect(bare.presignPut(KEY, { contentType: 'image/png', expiresInSeconds: 60 })).rejects.toBeInstanceOf(StorageConfigError);
    await expect(bare.presignGet(KEY, { expiresInSeconds: 60 })).rejects.toThrow(/R2_ACCOUNT_ID/);
  });

  it('the factory wires presign credentials only when they are all present', async () => {
    const base: Env = {
      DB: undefined as never, STORAGE_DRIVER: 'r2', PERSONALIZATION_ASSETS: new InMemoryR2() as unknown as R2Bucket,
    };
    const without = createObjectStorage(base, loadConfig(base));
    await expect(without.presignGet(KEY, { expiresInSeconds: 60 })).rejects.toBeInstanceOf(StorageConfigError);
    const env: Env = { ...base, R2_ACCOUNT_ID: 'abcdef0123456789', R2_BUCKET_NAME: 'b', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 's' };
    const withKeys = createObjectStorage(env, loadConfig(env));
    expect(new URL((await withKeys.presignGet(KEY, { expiresInSeconds: 60 })).url).origin).toBe('https://abcdef0123456789.r2.cloudflarestorage.com');
    const eu: Env = { ...env, R2_S3_ENDPOINT: 'https://abcdef0123456789.eu.r2.cloudflarestorage.com/' };
    expect(new URL((await createObjectStorage(eu, loadConfig(eu)).presignGet(KEY, { expiresInSeconds: 60 })).url).host).toBe('abcdef0123456789.eu.r2.cloudflarestorage.com');
  });
});

describe('S3 server-side operations used by verification', () => {
  const storage = () => new S3ObjectStorage(S3);

  it('HEAD reports the stored Content-Type', async () => {
    mockFetch(() => new Response(null, { status: 200, headers: { 'content-length': '3', etag: '"e1"', 'content-type': 'image/png' } }));
    expect(await storage().head('k')).toEqual({ size: 3, etag: '"e1"', contentType: 'image/png' });
  });

  it('COPY is a signed PUT with a copy source, REPLACE metadata and a conditional ETag', async () => {
    const calls = mockFetch((c) =>
      c.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'content-length': '5', etag: '"new"', 'content-type': 'image/png' } })
        : new Response('<CopyObjectResult><ETag>"new"</ETag></CopyObjectResult>', { status: 200 }),
    );
    const result = await storage().copy('stores/s1/x/pending/a b', 'stores/s1/x/assets/c.png', {
      contentType: 'image/png', storeId: 's1', ifMatchEtag: 'abc',
    });
    const put = calls[0];
    expect(put.method).toBe('PUT');
    expect(put.url).toBe('https://zb-assets.s3.eu-west-1.amazonaws.com/stores/s1/x/assets/c.png');
    expect(put.headers.get('x-amz-copy-source')).toBe('/zb-assets/stores/s1/x/pending/a%20b');
    expect(put.headers.get('x-amz-metadata-directive')).toBe('REPLACE');
    expect(put.headers.get('x-amz-copy-source-if-match')).toBe('"abc"');
    expect(put.headers.get('x-amz-meta-store-id')).toBe('s1');
    expect(put.headers.get('content-type')).toBe('image/png');
    expect(result).toEqual({ size: 5, etag: '"new"', contentType: 'image/png' });
  });

  it('maps a failed precondition / missing source to StoragePreconditionError', async () => {
    mockFetch(() => new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 }));
    await expect(storage().copy('a', 'b', { contentType: 'image/png', storeId: 's', ifMatchEtag: 'x' })).rejects.toBeInstanceOf(StoragePreconditionError);
    mockFetch(() => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }));
    await expect(storage().copy('a', 'b', { contentType: 'image/png', storeId: 's' })).rejects.toBeInstanceOf(StoragePreconditionError);
  });

  it('treats a 200 CopyObject answer carrying an <Error> as a failure', async () => {
    mockFetch(() => new Response('<Error><Code>InternalError</Code></Error>', { status: 200 }));
    await expect(storage().copy('a', 'b', { contentType: 'image/png', storeId: 's' })).rejects.toMatchObject({ code: 'InternalError' });
  });

  it('surfaces provider errors with the code and no URL or key', async () => {
    mockFetch(() => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
    const error = await storage().copy('a', 'b', { contentType: 'image/png', storeId: 's' }).catch((e) => e);
    expect(error).toBeInstanceOf(StorageRequestError);
    expect(error.message).toBe('Object storage copy failed with HTTP 403 (AccessDenied).');
  });

  it('readBytes returns the bytes, null for a missing object, and refuses oversized ones', async () => {
    mockFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { etag: '"e"', 'content-type': 'image/png', 'content-length': '3' } }));
    expect(await storage().readBytes('k', 10)).toMatchObject({ bytes: new Uint8Array([1, 2, 3]), size: 3, etag: '"e"', contentType: 'image/png' });
    await expect(storage().readBytes('k', 2)).rejects.toBeInstanceOf(ObjectTooLargeError);
    mockFetch(() => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }));
    expect(await storage().readBytes('k', 10)).toBeNull();
  });
});

describe('R2 binding operations used by verification', () => {
  const put = (bucket: InMemoryR2, key: string, bytes: number[], type = 'image/png') =>
    bucket.put(key, new Uint8Array(bytes), { httpMetadata: { contentType: type } });

  it('HEAD, bounded read and copy work through the binding', async () => {
    const bucket = new InMemoryR2();
    const storage = new R2ObjectStorage(bucket as unknown as R2Bucket);
    const { etag } = await put(bucket, 'src', [1, 2, 3, 4]);
    expect(await storage.head('src')).toMatchObject({ size: 4, contentType: 'image/png' });
    expect(await storage.head('nope')).toBeNull();
    expect((await storage.readBytes('src', 10))?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    await expect(storage.readBytes('src', 3)).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(await storage.readBytes('nope', 3)).toBeNull();

    const copied = await storage.copy('src', 'dst', { contentType: 'image/webp', storeId: 's1', sha256: 'ab', ifMatchEtag: etag });
    expect(copied.size).toBe(4);
    expect(bucket.objects.get('dst')).toMatchObject({ contentType: 'image/webp', customMetadata: { storeId: 's1' } });
    expect(bucket.objects.has('src')).toBe(true); // a copy, not a move
  });

  it('refuses to promote an object that changed after it was verified', async () => {
    const bucket = new InMemoryR2();
    const storage = new R2ObjectStorage(bucket as unknown as R2Bucket);
    const { etag } = await put(bucket, 'src', [1, 2, 3]);
    await put(bucket, 'src', [9, 9, 9]); // overwritten after verification
    await expect(storage.copy('src', 'dst', { contentType: 'image/png', storeId: 's', ifMatchEtag: etag })).rejects.toBeInstanceOf(StoragePreconditionError);
    expect(bucket.objects.has('dst')).toBe(false);
    await expect(storage.copy('missing', 'dst', { contentType: 'image/png', storeId: 's' })).rejects.toBeInstanceOf(StoragePreconditionError);
  });
});

describe('helpers', () => {
  it('sameEtag ignores quotes and weak markers', () => {
    expect(sameEtag('"abc"', 'abc')).toBe(true);
    expect(sameEtag('W/"abc"', 'abc')).toBe(true);
    expect(sameEtag('"abc"', '"abd"')).toBe(false);
  });

  it('pendingObjectKey only accepts a UUID, so a key can never be steered', () => {
    expect(pendingObjectKey('s1', '11111111-1111-4111-8111-111111111111')).toBe(KEY);
    expect(() => pendingObjectKey('s1', '../../etc/passwd')).toThrow();
    expect(() => pendingObjectKey('s1', 'abc')).toThrow();
  });

  it('readLimited stops reading once the limit is exceeded', async () => {
    let pulled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(100));
        if (pulled > 50) controller.close();
      },
    });
    await expect(readLimited(stream, 250)).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(pulled).toBeLessThan(10);
  });
});
