import { coerceView, parseUrl, urlFor } from './admin-navigation';

describe('admin navigation', () => {
  it('maps views to in-memory URLs and back', () => {
    expect(urlFor('list', null)).toBe('/configurations');
    expect(urlFor('editor', 'cfg-1')).toBe('/configurations/cfg-1');
    expect(urlFor('editor', null)).toBe('/configurations');
    expect(urlFor('preview', 'cfg-1')).toBe('/preview/cfg-1');
    expect(urlFor('mapping', null)).toBe('/mapping');
    expect(urlFor('mapping', 'cfg-1')).toBe('/mapping/cfg-1');
    expect(urlFor('orders', null)).toBe('/orders');
    expect(urlFor('orders', null, 'ORD-1')).toBe('/orders/ORD-1');
    for (const [view, id] of [
      ['editor', 'cfg-1'],
      ['preview', 'cfg-1'],
      ['mapping', 'cfg-1'],
      ['mapping', null],
      ['list', null],
    ] as const) {
      expect(parseUrl(urlFor(view, id))).toEqual({ view, configId: id, orderId: null });
    }
    for (const orderId of [null, 'ORD-1', '#1001', 'ORD 7/β?x=1', '..']) {
      expect(parseUrl(urlFor('orders', null, orderId))).toEqual({ view: 'orders', configId: null, orderId });
    }
  });

  it('ignores ids that could break out of the path', () => {
    expect(urlFor('editor', '../../x')).toBe('/configurations');
    expect(urlFor('editor', 'a/b')).toBe('/configurations');
    // Order ids are the platform's own strings: always one encoded segment.
    expect(urlFor('orders', null, '../../x')).toBe('/orders/..%2F..%2Fx');
    expect(urlFor('orders', null, 'a\nb')).toBe('/orders');
    expect(urlFor('orders', null, '   ')).toBe('/orders');
    expect(urlFor('orders', null, 'x'.repeat(201))).toBe('/orders');
    // The order id only applies to the orders view.
    expect(urlFor('mapping', null, 'ORD-1')).toBe('/mapping');
  });

  it('ignores query strings and malformed escapes, and falls back to the list', () => {
    expect(parseUrl('/mapping/abc?x=1')).toEqual({ view: 'mapping', configId: 'abc', orderId: null });
    expect(parseUrl('/orders/ORD-1#top')).toEqual({ view: 'orders', configId: null, orderId: 'ORD-1' });
    expect(parseUrl('/orders/%E0%A4%A')).toEqual({ view: 'orders', configId: null, orderId: null });
    expect(parseUrl('/nope')).toEqual({ view: 'list', configId: null, orderId: null });
    expect(parseUrl('')).toEqual({ view: 'list', configId: null, orderId: null });
  });

  it('coerces unknown view values', () => {
    expect(coerceView('mapping')).toBe('mapping');
    expect(coerceView('orders')).toBe('orders');
    expect(coerceView('bogus')).toBe('list');
    expect(coerceView(undefined)).toBe('list');
  });
});
