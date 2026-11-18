import { CustomizationPersistence, SHOPPER_PATH, publicImageUrl } from './customization-persistence.service';
import { CustomizerError } from './errors';

const target = { apiBaseUrl: 'https://api.example.com/', storeId: 'store 1' };
const signal = () => new AbortController().signal;
const IMAGE_URL = 'https://api.example.com/api/v1/storefront/personalization/customization-images/0b6f3a52-0000-4000-8000-000000000001?storeId=store%201';

function mockFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responder(url, init);
  });
  return calls;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('CustomizationPersistence', () => {
  const service = new CustomizationPersistence();

  describe('direct upload', () => {
    const png = () => new Blob(['x'], { type: 'image/png' });
    const initiation = {
      uploadId: 'up-1',
      assetId: 'a1',
      uploadUrl: 'https://bucket.example/pending/up-1?X-Amz-Signature=sig',
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      expiresIn: 300,
    };

    /** Routes the Worker calls and the storage PUT through one fetch stub, recording every request. */
    function stubNetwork(overrides: { complete?: () => Response; initiate?: () => Response; put?: (init: RequestInit) => Response | Promise<Response> } = {}) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      mockFetch((url, init) => {
        calls.push({ url, init });
        if (url.startsWith('https://bucket.example/')) return overrides.put?.(init) ?? new Response(null, { status: 200 });
        if (url.includes('/uploads/url')) return overrides.initiate?.() ?? json(201, { data: initiation });
        if (url.includes('/uploads/complete')) return overrides.complete?.() ?? json(200, { data: { assetId: 'a1' } });
        return json(500, {});
      });
      return calls;
    }

    it('asks the Worker for a URL, sends the bytes straight to storage, then confirms', async () => {
      const calls = stubNetwork();
      const blob = png();
      const result = await service.upload(target, { kind: 'artwork', blob, filename: 'front' }, signal(), { retryDelayMs: 1 });
      expect(result).toEqual({ assetId: 'a1' });
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
        `${SHOPPER_PATH}/uploads/url`,
        '/pending/up-1',
        `${SHOPPER_PATH}/uploads/complete`,
      ]);

      const [initiate, storage, complete] = calls;
      const initUrl = new URL(initiate.url);
      expect(initUrl.origin).toBe('https://api.example.com');
      expect(initUrl.searchParams.get('storeId')).toBe('store 1');
      expect(JSON.parse(initiate.init.body as string)).toEqual({ kind: 'artwork', contentType: 'image/png', size: 1, filename: 'front' });
      expect(initiate.init).toMatchObject({ method: 'POST', credentials: 'omit', mode: 'cors' });

      // The bytes never go to the Worker; the storage host gets only the signed headers and no credentials.
      expect(storage.init).toMatchObject({ method: 'PUT', body: blob, credentials: 'omit' });
      expect(storage.init.headers).toEqual({ 'Content-Type': 'image/png' });
      expect(new Headers(storage.init.headers).has('authorization')).toBe(false);

      // The API is anonymous: no call carries a credential of any kind.
      for (const call of calls) expect(new Headers(call.init.headers).has('authorization')).toBe(false);
      expect(JSON.parse(complete.init.body as string)).toEqual({ uploadId: 'up-1' });
      expect(new URL(complete.url).searchParams.get('storeId')).toBe('store 1');
    });

    it('works the same for every kind of shopper file', async () => {
      for (const kind of ['upload', 'preview', 'artwork'] as const) {
        const calls = stubNetwork();
        await service.upload(target, { kind, blob: png() }, signal(), { retryDelayMs: 1 });
        expect(JSON.parse(calls[0].init.body as string).kind).toBe(kind);
      }
    });

    it('renews an expired URL, and succeeds', async () => {
      let puts = 0;
      const calls = stubNetwork({ put: () => new Response(null, { status: ++puts === 1 ? 403 : 200 }) });
      const result = await service.upload(target, { kind: 'upload', blob: png() }, signal(), { retryDelayMs: 1 });
      expect(result.assetId).toBe('a1');
      const initiations = calls.filter((c) => c.url.includes('/uploads/url'));
      expect(initiations).toHaveLength(2);
      expect(JSON.parse(initiations[1].init.body as string).uploadId).toBe('up-1');
      expect(new Headers(initiations[1].init.headers).has('authorization')).toBe(false);
    });

    it('retries a lost confirmation without sending the file again', async () => {
      let confirms = 0;
      const calls = stubNetwork({ complete: () => (++confirms === 1 ? json(503, { error: { code: 'storage_unavailable' } }) : json(200, { data: { assetId: 'a1' } })) });
      await service.upload(target, { kind: 'upload', blob: png() }, signal(), { retryDelayMs: 1 });
      expect(calls.filter((c) => c.url.startsWith('https://bucket.example/'))).toHaveLength(1);
      expect(calls.filter((c) => c.url.includes('/uploads/complete'))).toHaveLength(2);
    });

    it.each([
      ['a rejected file', () => json(422, { error: { code: 'upload_rejected', details: { reason: 'invalid_content' } } }), /images could not be saved/i, false],
      ['a rate limit', () => json(429, { error: { code: 'rate_limited' } }), /too many requests/i, true],
    ])('shows a shopper-safe message for %s (no server detail)', async (_name, complete, message, recoverable) => {
      stubNetwork({ complete });
      const error = await service.upload(target, { kind: 'upload', blob: png() }, signal(), { retryDelayMs: 1, maxAttempts: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(CustomizerError);
      expect(error.code).toBe('save-failed');
      expect(error.message).toMatch(message);
      expect(error.message).not.toMatch(/upload_rejected|invalid_content|X-Amz/);
      expect(error.recoverable).toBe(recoverable);
    });

    it('reports an unreachable storage host as a recoverable network problem', async () => {
      stubNetwork({ put: () => Promise.reject(new TypeError('Failed to fetch')) });
      const error = await service.upload(target, { kind: 'upload', blob: png() }, signal(), { retryDelayMs: 1, maxAttempts: 2 }).catch((e) => e);
      expect(error).toBeInstanceOf(CustomizerError);
      expect(error.message).toMatch(/could not be reached/i);
      expect(error.recoverable).toBe(true);
    });

    it.each([
      ['an unsupported or oversized file', 415],
      ['an oversized file', 413],
    ])('maps initiation of %s (HTTP %s) to the bad-file message', async (_n, status) => {
      stubNetwork({ initiate: () => json(status, {}) });
      const error = await service.upload(target, { kind: 'upload', blob: png() }, signal(), { retryDelayMs: 1 }).catch((e) => e);
      expect(error.message).toMatch(/images could not be saved/i);
      expect(error.recoverable).toBe(false);
    });

    it('treats a malformed initiation answer as a failure, never as success', async () => {
      stubNetwork({ initiate: () => json(201, { data: { nothing: true } }) });
      const error = await service.upload(target, { kind: 'upload', blob: png() }, signal(), { retryDelayMs: 1, maxAttempts: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(CustomizerError);
      expect(error.message).toMatch(/could not be saved/i);
    });

    it('falls back to the proxied upload only where the Worker has direct uploads switched off', async () => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      mockFetch((url, init) => {
        calls.push({ url, init });
        if (url.includes('/uploads/url')) return json(503, { error: { code: 'direct_upload_not_configured' } });
        return json(201, { data: { assetId: 'a9' } });
      });
      const blob = png();
      const result = await service.upload(target, { kind: 'artwork', blob, filename: 'front' }, signal(), { retryDelayMs: 1 });
      expect(result).toEqual({ assetId: 'a9' });
      const proxied = new URL(calls[1].url);
      expect(proxied.pathname).toBe(`${SHOPPER_PATH}/uploads`);
      expect(proxied.searchParams.get('kind')).toBe('artwork');
      expect(calls[1].init).toMatchObject({ method: 'POST', credentials: 'omit', mode: 'cors', body: blob });
    });

    it('propagates a caller abort instead of reporting a network error, and never confirms', async () => {
      const controller = new AbortController();
      const calls = stubNetwork({
        // Storage hangs until the browser aborts the request, as a real fetch would.
        put: (init) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('a', 'AbortError')))),
      });
      const pending = service.upload(target, { kind: 'upload', blob: png() }, controller.signal, { retryDelayMs: 1 }).catch((e) => e);
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      const error = await pending;
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
      expect(calls.some((c) => c.url.includes('/uploads/complete'))).toBe(false);
    });
  });

  it('creates a customization and returns its id, customized image URL and expiry', async () => {
    const calls = mockFetch(() =>
      json(201, { data: { customizationId: 'cz', customizedImageUrl: IMAGE_URL, expiresAt: '2026-12-01T00:00:00Z' } }),
    );
    const created = await service.create(
      target,
      { productId: 'p1', variantId: 'v1', collectionIds: ['c1'], configId: 'cfg', configVersion: 3, data: { a: 1 }, assets: [{ assetId: 'a1' }] },
      signal(),
    );
    expect(created).toEqual({ customizationId: 'cz', customizedImageUrl: IMAGE_URL, expiresAt: '2026-12-01T00:00:00Z' });
    expect(new Headers(calls[0].init.headers).has('authorization')).toBe(false);
    expect(calls[0].init.credentials).toBe('omit');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      productId: 'p1', variantId: 'v1', collectionIds: ['c1'], configId: 'cfg', configVersion: 3, data: { a: 1 },
      assets: [{ assetId: 'a1' }],
    });
  });

  it.each([
    ['plain http', 'http://api.example.com/i.png'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a relative URL', '/api/v1/image'],
    ['a URL with credentials', 'https://user:pw@api.example.com/i.png'],
    ['more than 2048 characters', `https://api.example.com/${'a'.repeat(2100)}`],
    ['a non-string', 42],
  ])('drops a customizedImageUrl that is %s instead of passing it on', async (_name, value) => {
    mockFetch(() => json(201, { data: { customizationId: 'cz', customizedImageUrl: value } }));
    const created = await service.create(target, { productId: 'p', configId: 'c', configVersion: 1, data: {}, assets: [] }, signal());
    expect(created.customizedImageUrl).toBeNull();
    expect(created.customizationId).toBe('cz');
  });

  it('accepts plain http only for a loopback host (local development)', () => {
    expect(publicImageUrl('http://127.0.0.1:8787/a.png?storeId=s')).toBe('http://127.0.0.1:8787/a.png?storeId=s');
    expect(publicImageUrl('http://localhost:8787/a.png')).toBe('http://localhost:8787/a.png');
    expect(publicImageUrl(IMAGE_URL)).toBe(IMAGE_URL);
  });

  it('omits empty optional fields', async () => {
    const calls = mockFetch(() => json(201, { data: { customizationId: 'cz' } }));
    await service.create(target, { productId: 'p', variantId: null, collectionIds: [], configId: 'c', configVersion: 1, data: {}, assets: [] }, signal());
    const body = JSON.parse(calls[0].init.body as string);
    expect('variantId' in body).toBe(false);
    expect('collectionIds' in body).toBe(false);
  });

  it.each([
    [429, { error: { code: 'rate_limited' } }, /too many requests/i, true],
    [409, { error: { details: { reason: 'config_changed' } } }, /reload the page/i, false],
    [404, { error: { code: 'not_personalizable' } }, /not available/i, false],
    [413, {}, /images could not be saved/i, false],
    [415, {}, /images could not be saved/i, false],
    [422, { error: { message: 'internal detail' } }, /could not be saved/i, false],
    [503, { error: { message: 'internal detail' } }, /could not be saved/i, true],
  ])('maps HTTP %s to a shopper-safe message (no server detail)', async (status, body, message, recoverable) => {
    mockFetch(() => json(status, body));
    const error = await service.create(target, { productId: 'p', configId: 'c', configVersion: 1, data: {}, assets: [] }, signal()).catch((e) => e);
    expect(error).toBeInstanceOf(CustomizerError);
    expect(error.code).toBe('save-failed');
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain('internal detail');
    expect(error.recoverable).toBe(recoverable);
  });

  it('reports an unreachable service as recoverable, and treats a malformed success body as a failure', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const network = await service.upload(target, { kind: 'upload', blob: new Blob(['x']) }, signal(), { retryDelayMs: 1, maxAttempts: 1 }).catch((e) => e);
    expect(network.message).toMatch(/could not be reached/i);
    expect(network.recoverable).toBe(true);

    mockFetch(() => json(201, { data: { nothing: true } }));
    const malformed = await service.create(target, { productId: 'p', configId: 'c', configVersion: 1, data: {}, assets: [] }, signal()).catch((e) => e);
    expect(malformed).toBeInstanceOf(CustomizerError);
    expect(malformed.message).toMatch(/could not be saved/i);
  });

  it('propagates a caller abort instead of reporting a network error', async () => {
    const controller = new AbortController();
    mockFetch((_u, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = service.upload(target, { kind: 'upload', blob: new Blob(['x']) }, controller.signal).catch((e) => e);
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
  });
});
