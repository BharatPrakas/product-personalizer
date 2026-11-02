import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3ObjectStorage } from '../src/storage/s3-storage';
import { StorageRequestError, StorageConfigError } from '../src/storage/object-storage';
import { createObjectStorage } from '../src/storage';
import { loadConfig, type Env } from '../src/config/environment';

const SETTINGS = {
  bucket: 'zb-assets-test',
  region: 'eu-west-1',
  accessKeyId: 'AKIDTESTKEY',
  secretAccessKey: 'test-secret',
};

interface Call {
  url: string;
  method: string;
  headers: Headers;
}

/**
 * Replace global fetch with a scripted responder and record every request. aws4fetch hands fetch a
 * Request object, so the URL, method and headers are read from it.
 */
function mockFetch(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(String(input));
      const call: Call = { url: request.url, method: request.method, headers: request.headers };
      calls.push(call);
      return respond(call);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('S3ObjectStorage', () => {
  it('PUT uses virtual-hosted addressing and a SigV4 Authorization header', async () => {
    const calls = mockFetch(() => new Response(null, { status: 200, headers: { etag: '"abc"' } }));
    const storage = new S3ObjectStorage(SETTINGS);
    const body = new Uint8Array([1, 2, 3]).buffer;

    const result = await storage.put('personalization/store_a/2026/10/x.png', body, {
      contentType: 'image/png',
      storeId: 'store_a',
    });

    expect(calls[0].url).toBe(
      'https://zb-assets-test.s3.eu-west-1.amazonaws.com/personalization/store_a/2026/10/x.png',
    );
    expect(calls[0].method).toBe('PUT');
    const headers = calls[0].headers;
    expect(headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDTESTKEY\/\d{8}\/eu-west-1\/s3\/aws4_request/,
    );
    expect(headers.get('x-amz-meta-store-id')).toBe('store_a');
    expect(result).toEqual({ size: 3, etag: '"abc"' });
  });

  it('PUT fails with a status-only error (no URL or credentials in the message)', async () => {
    mockFetch(() => new Response('denied', { status: 403 }));
    const storage = new S3ObjectStorage(SETTINGS);
    const error = await storage
      .put('k.png', new ArrayBuffer(1), { contentType: 'image/png', storeId: 's' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageRequestError);
    expect((error as Error).message).toBe('Object storage put failed with HTTP 403.');
    expect((error as Error).message).not.toContain('AKID');
  });

  it('includes the S3 error code in the failure so the cause is diagnosable', async () => {
    mockFetch(
      () =>
        new Response('<?xml version="1.0"?><Error><Code>InvalidAccessKeyId</Code><Message>secret detail</Message></Error>', {
          status: 403,
        }),
    );
    const error = await new S3ObjectStorage(SETTINGS)
      .put('k.png', new ArrayBuffer(1), { contentType: 'image/png', storeId: 's' })
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe('Object storage put failed with HTTP 403 (InvalidAccessKeyId).');
    expect((error as Error).message).not.toContain('secret detail');
  });

  it('sends the session token when temporary credentials are used', async () => {
    const calls = mockFetch(() => new Response(null, { status: 404 }));
    await new S3ObjectStorage({ ...SETTINGS, sessionToken: 'TEMP-TOKEN' }).head('a.png');
    expect(calls[0].headers.get('x-amz-security-token')).toBe('TEMP-TOKEN');
  });

  it('sends no session token for long-term keys', async () => {
    const calls = mockFetch(() => new Response(null, { status: 404 }));
    await new S3ObjectStorage(SETTINGS).head('a.png');
    expect(calls[0].headers.has('x-amz-security-token')).toBe(false);
  });

  it('HEAD returns null for a missing object', async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    expect(await new S3ObjectStorage(SETTINGS).head('missing.png')).toBeNull();
  });

  it('GET returns the body, size and content type', async () => {
    mockFetch(
      () =>
        new Response('hello', {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '5', etag: '"e1"' },
        }),
    );
    const object = await new S3ObjectStorage(SETTINGS).get('a.jpg');
    expect(object).not.toBeNull();
    expect(object!.contentType).toBe('image/jpeg');
    expect(object!.size).toBe(5);
    expect(await new Response(object!.body).text()).toBe('hello');
  });

  it('DELETE treats a missing key as already deleted', async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    await expect(new S3ObjectStorage(SETTINGS).delete('gone.png')).resolves.toBeUndefined();
  });

  it('DELETE surfaces a real server error', async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    await expect(new S3ObjectStorage(SETTINGS).delete('x.png')).rejects.toBeInstanceOf(StorageRequestError);
  });

  it('uses path-style addressing when an S3-compatible endpoint is set', async () => {
    const calls = mockFetch(() => new Response(null, { status: 404 }));
    const storage = new S3ObjectStorage({ ...SETTINGS, endpoint: 'http://127.0.0.1:9000/' });
    await storage.head('dir/file.png');
    expect(calls[0].url).toBe('http://127.0.0.1:9000/zb-assets-test/dir/file.png');
  });
});

function envWith(overrides: Partial<Env>): Env {
  return {
    HYPERDRIVE: {} as Hyperdrive,
    ...overrides,
  } as Env;
}

describe('createObjectStorage', () => {
  it('uses R2 when the driver is r2 and the binding exists', () => {
    const env = envWith({ PERSONALIZATION_ASSETS: {} as R2Bucket });
    const config = loadConfig(env);
    expect(config.storageDriver).toBe('r2');
    expect(() => createObjectStorage(env, config)).not.toThrow();
  });

  it('fails clearly when r2 is selected without the binding', () => {
    const env = envWith({});
    expect(() => createObjectStorage(env, loadConfig(env))).toThrow(StorageConfigError);
  });

  it('names every missing S3 setting without revealing any value', () => {
    const env = envWith({ STORAGE_DRIVER: 's3', S3_BUCKET: 'b' });
    let message = '';
    try {
      createObjectStorage(env, loadConfig(env));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('S3_REGION');
    expect(message).toContain('AWS_ACCESS_KEY_ID');
    expect(message).toContain('AWS_SECRET_ACCESS_KEY');
    expect(message).not.toContain('S3_BUCKET');
  });

  it('builds an S3 backend when fully configured', () => {
    const env = envWith({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'b',
      S3_REGION: 'eu-west-1',
      AWS_ACCESS_KEY_ID: 'AKID',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });
    expect(createObjectStorage(env, loadConfig(env))).toBeInstanceOf(S3ObjectStorage);
  });
});
