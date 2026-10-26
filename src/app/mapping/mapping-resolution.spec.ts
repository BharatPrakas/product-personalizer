import { ProductMapping } from './mapping.models';
import { indexMappings, resolveMapping, statusFor } from './mapping-resolution';

const m = (
  scope: ProductMapping['scope'],
  externalId: string,
  configId: string,
): ProductMapping => ({
  id: `${scope}-${externalId}`,
  storeId: 's',
  configId,
  scope,
  externalId,
  label: null,
  createdAt: 1,
  updatedAt: 1,
});

describe('resolveMapping', () => {
  const all = [
    m('collection', 'c-2', 'cfg-c2'),
    m('collection', 'c-1', 'cfg-c1'),
    m('product', 'p1', 'cfg-p'),
    m('variant', 'v1', 'cfg-v'),
  ];

  it('a variant mapping wins over product and collection mappings', () => {
    expect(
      resolveMapping(all, { productId: 'p1', variantId: 'v1', collectionIds: ['c-1'] })?.configId,
    ).toBe('cfg-v');
  });

  it('a product mapping wins over a collection mapping', () => {
    expect(
      resolveMapping(all, { productId: 'p1', variantId: 'other', collectionIds: ['c-1'] })
        ?.configId,
    ).toBe('cfg-p');
  });

  it('falls back to a collection, choosing the lowest id deterministically', () => {
    expect(resolveMapping(all, { productId: 'zzz', collectionIds: ['c-2', 'c-1'] })?.configId).toBe(
      'cfg-c1',
    );
  });

  it('returns null when nothing matches', () => {
    expect(
      resolveMapping(all, { productId: 'none', variantId: 'none', collectionIds: ['x'] }),
    ).toBeNull();
    expect(resolveMapping([], { productId: 'p1' })).toBeNull();
  });

  it('does not treat a product id as a variant id', () => {
    expect(resolveMapping([m('variant', 'p1', 'cfg-v')], { productId: 'p1' })).toBeNull();
  });
});

describe('statusFor', () => {
  const index = indexMappings([m('product', 'p1', 'cfg-a'), m('product', 'p2', 'cfg-b')]);
  it('reports unmapped, mapped here and conflict', () => {
    expect(statusFor(index, 'product', 'p0', 'cfg-a').kind).toBe('unmapped');
    expect(statusFor(index, 'product', 'p1', 'cfg-a').kind).toBe('mapped');
    expect(statusFor(index, 'product', 'p2', 'cfg-a').kind).toBe('conflict');
  });
  it('keeps scopes apart', () => {
    expect(statusFor(index, 'variant', 'p1', 'cfg-a').kind).toBe('unmapped');
  });
});
