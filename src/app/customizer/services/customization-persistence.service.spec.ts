import { CustomizationPersistence, SHOPPER_PATH } from './customization-persistence.service';
import { CustomizerError } from './errors';

const target = { apiBaseUrl: 'https://api.example.com/', storeId: 'store 1' };
const signal = () => new AbortController().signal;

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

  it('uploads a file as the raw body with the store and kind in the query, without credentials', async () => {
    const calls = mockFetch(() => json(201, { data: { assetId: 'a1', uploadToken: 't1' } }));
    const blob = new Blob(['x'], { type: 'image/png' });
    const result = await service.upload(target, { kind: 'artwork', blob, filename: 'front' }, signal());
    expect(result).toEqual({ assetId: 'a1', uploadToken: 't1' });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(`https://api.example.com${SHOPPER_PATH}/uploads`);
    expect(url.searchParams.get('storeId')).toBe('store 1');
    expect(url.searchParams.get('kind')).toBe('artwork');
    expect(url.searchParams.get('filename')).toBe('front');
    expect(calls[0].init).toMatchObject({ method: 'POST', credentials: 'omit', mode: 'cors', body: blob });
    expect(new Headers(calls[0].init.headers).get('content-type')).toBe('image/png');
  });

  it('creates a customization and returns its id, token and expiry', async () => {
    const calls = mockFetch(() =>
      json(201, { data: { customizationId: 'cz', accessToken: 'tok', expiresAt: '2026-12-01T00:00:00Z' } }),
    );
    const created = await service.create(
      target,
      { productId: 'p1', variantId: 'v1', collectionIds: ['c1'], configId: 'cfg', configVersion: 3, data: { a: 1 }, assets: [{ assetId: 'a1', uploadToken: 't1' }] },
      signal(),
    );
    expect(created).toEqual({ customizationId: 'cz', accessToken: 'tok', expiresAt: '2026-12-01T00:00:00Z' });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      productId: 'p1', variantId: 'v1', collectionIds: ['c1'], configId: 'cfg', configVersion: 3, data: { a: 1 },
      assets: [{ assetId: 'a1', uploadToken: 't1' }],
    });
  });

  it('omits empty optional fields', async () => {
    const calls = mockFetch(() => json(201, { data: { customizationId: 'cz', accessToken: 't' } }));
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
    const network = await service.upload(target, { kind: 'upload', blob: new Blob(['x']) }, signal()).catch((e) => e);
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
