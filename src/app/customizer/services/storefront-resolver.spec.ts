import { CustomizerError } from './errors';
import { StorefrontResolver, parseOutcome, storefrontUrl } from './storefront-resolver.service';

describe('storefront resolver', () => {
  it('builds the public read URL with only the needed query parameters', () => {
    const url = new URL(
      storefrontUrl({ apiBaseUrl: 'https://api.example.com/', storeId: 'shop-1', productId: 'p/1 2', variantId: 'v9', collectionIds: ['a', 'b'] }),
    );
    expect(url.origin).toBe('https://api.example.com');
    expect(url.pathname).toBe('/api/v1/storefront/personalization/products/p%2F1%202/config');
    expect(url.searchParams.get('storeId')).toBe('shop-1');
    expect(url.searchParams.get('variantId')).toBe('v9');
    expect(url.searchParams.get('collectionIds')).toBe('a,b');
    const bare = new URL(storefrontUrl({ apiBaseUrl: 'https://api.example.com', storeId: 's', productId: 'p' }));
    expect([...bare.searchParams.keys()]).toEqual(['storeId']);
  });

  it('parses mapped and unmapped answers, with or without the envelope', () => {
    const mapped = { personalizable: true, configId: 'cfg-1', version: 3, scope: 'variant', config: { a: 1 } };
    expect(parseOutcome({ data: mapped })).toEqual({ kind: 'mapped', config: { a: 1 }, configId: 'cfg-1', version: 3, scope: 'variant' });
    expect(parseOutcome(mapped).kind).toBe('mapped');
    expect(parseOutcome({ data: { personalizable: false } })).toEqual({ kind: 'unmapped' });
    expect(parseOutcome(null)).toEqual({ kind: 'unmapped' });
    expect(() => parseOutcome({ data: { personalizable: true, configId: 'x' } })).toThrow(CustomizerError);
  });

  it('turns HTTP failures into recoverable load errors and 404 into "unmapped"', async () => {
    const resolver = new StorefrontResolver();
    const request = { apiBaseUrl: 'https://api.example.com', storeId: 's', productId: 'p' };
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
      expect(await resolver.resolve(request, new AbortController().signal)).toEqual({ kind: 'unmapped' });
      globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
      await expect(resolver.resolve(request, new AbortController().signal)).rejects.toMatchObject({ code: 'config-load-failed', recoverable: true });
      globalThis.fetch = (async () => new Response('not json', { status: 200 })) as typeof fetch;
      await expect(resolver.resolve(request, new AbortController().signal)).rejects.toBeInstanceOf(CustomizerError);
      globalThis.fetch = (async () => {
        throw new TypeError('network');
      }) as typeof fetch;
      await expect(resolver.resolve(request, new AbortController().signal)).rejects.toMatchObject({ recoverable: true });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sends no credentials with the public read', async () => {
    const original = globalThis.fetch;
    let init: RequestInit | undefined;
    try {
      globalThis.fetch = (async (_url: unknown, i?: RequestInit) => {
        init = i;
        return new Response(JSON.stringify({ data: { personalizable: false } }), { status: 200 });
      }) as typeof fetch;
      await new StorefrontResolver().resolve({ apiBaseUrl: 'https://api.example.com', storeId: 's', productId: 'p' }, new AbortController().signal);
      expect(init?.credentials).toBe('omit');
      expect(init?.headers).not.toHaveProperty('Authorization');
    } finally {
      globalThis.fetch = original;
    }
  });
});
