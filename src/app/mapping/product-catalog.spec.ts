import { TestBed } from '@angular/core/testing';
import { AdminHost } from '../admin/admin-host.service';
import { ZenBasketBridge } from '../zenbasket/zenbasket-bridge';
import type { ZenBasketSdk } from '../zenbasket/zb-sdk';
import { ProductCatalog, collectionsOf, matchesProduct, normalizeProducts } from './product-catalog.service';

describe('product catalog', () => {
  it('drops malformed entries and unsafe image URLs', () => {
    const out = normalizeProducts([
      { id: 'a', title: 'Mug', imageUrl: 'javascript:alert(1)' },
      {
        id: 'b',
        title: 'Cap',
        imageUrl: 'https://cdn.example/cap.png',
        variants: [
          { id: 'v', title: 'Red' },
          { id: '', title: 'x' },
        ],
      },
      { id: 7, title: 'Numeric' },
      { title: 'No id' },
      null,
      'str',
    ]);
    expect(out.map((p) => p.id)).toEqual(['a', 'b', '7']);
    expect(out[0].imageUrl).toBeUndefined();
    expect(out[1].imageUrl).toBe('https://cdn.example/cap.png');
    expect(out[1].variants).toEqual([{ id: 'v', title: 'Red', sku: undefined }]);
  });

  it('returns nothing for non-arrays', () => {
    expect(normalizeProducts({ items: [] })).toEqual([]);
    expect(normalizeProducts(undefined)).toEqual([]);
  });

  it('matches on title, sku, id, variants and collections', () => {
    const p = normalizeProducts([
      {
        id: 'p1',
        title: 'Tote bag',
        sku: 'TB-1',
        variants: [{ id: 'v1', title: 'Navy', sku: 'TB-NAVY' }],
        collections: [{ id: 'c1', title: 'Summer' }],
      },
    ])[0];
    for (const q of ['tote', 'tb-1', 'p1', 'navy', 'tb-navy', 'summer', ''])
      expect(matchesProduct(p, q)).toBe(true);
    expect(matchesProduct(p, 'winter')).toBe(false);
  });

  it('lists each collection once, sorted', () => {
    const products = normalizeProducts([
      {
        id: '1',
        title: 'A',
        collections: [
          { id: 'c2', title: 'Zed' },
          { id: 'c1', title: 'Alpha' },
        ],
      },
      { id: '2', title: 'B', collections: [{ id: 'c1', title: 'Alpha' }] },
    ]);
    expect(collectionsOf(products).map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});

describe('ProductCatalog with the ZenBasket SDK', () => {
  const search = vi.fn();
  const hostWith = (zbService: unknown) => {
    const el = document.createElement('div');
    (el as unknown as Record<string, unknown>)['zbService'] = zbService;
    TestBed.inject(ZenBasketBridge).attach(el);
  };
  const sdk = (searchFn: (...args: never[]) => unknown = search) =>
    ({ version: 1, auth: { getAccessToken: async () => ({ token: 't' }) }, products: { search: searchFn }, core: {} }) as unknown as ZenBasketSdk;

  beforeEach(() => search.mockReset());

  it('has no source without catalog, URL or SDK', () => {
    expect(TestBed.inject(ProductCatalog).source()).toBe('none');
  });

  it('uses the SDK when the host provides one, and treats it as a remote source', () => {
    hostWith(sdk());
    const catalog = TestBed.inject(ProductCatalog);
    expect(catalog.source()).toBe('sdk');
    expect(catalog.isRemote()).toBe(true);
  });

  it('prefers the host catalog, then the search URL, over the SDK', () => {
    hostWith(sdk());
    const host = TestBed.inject(AdminHost);
    const catalog = TestBed.inject(ProductCatalog);
    host.productSearchUrl.set('https://host.example/search');
    expect(catalog.source()).toBe('url');
    host.productCatalog.set([{ id: '1', title: 'Mug' }]);
    expect(catalog.source()).toBe('catalog');
    expect(catalog.isRemote()).toBe(false);
  });

  it('searches through the SDK with a trimmed query and a page of 50, and normalizes the result', async () => {
    search.mockResolvedValue({
      items: [
        { id: 7, title: 'Mug', imageUrl: 'javascript:alert(1)' },
        { id: '', title: 'broken' },
      ],
      total: 2,
    });
    hostWith(sdk());
    const found = await TestBed.inject(ProductCatalog).search('  mug  ');
    expect(search).toHaveBeenCalledWith({ query: 'mug', limit: 50 });
    expect(found).toEqual([expect.objectContaining({ id: '7', title: 'Mug', imageUrl: undefined })]);
  });

  it('sends no query text for an empty search', async () => {
    search.mockResolvedValue({ items: [] });
    hostWith(sdk());
    await TestBed.inject(ProductCatalog).search('   ');
    expect(search).toHaveBeenCalledWith({ query: undefined, limit: 50 });
  });

  it('lets a failing SDK search propagate so the page can show its retry state', async () => {
    const failing = vi.fn(async () => {
      throw new Error('graphql down');
    });
    hostWith(sdk(failing));
    await expect(TestBed.inject(ProductCatalog).search('x')).rejects.toThrow('graphql down');
  });

  it('returns nothing without any source', async () => {
    expect(await TestBed.inject(ProductCatalog).search('x')).toEqual([]);
  });
});
