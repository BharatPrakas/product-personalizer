import { collectionsOf, matchesProduct, normalizeProducts } from './product-catalog.service';

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
