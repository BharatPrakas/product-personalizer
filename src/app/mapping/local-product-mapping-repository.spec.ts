import { LocalProductMappingRepository } from './local-product-mapping-repository.service';
import { MappingConflictError, MappingInvalidError } from './mapping.models';

// jsdom has no IndexedDB, so the repository runs on its in-memory fallback here.
describe('LocalProductMappingRepository', () => {
  let repo: LocalProductMappingRepository;
  beforeEach(() => (repo = new LocalProductMappingRepository()));

  it('creates a mapping and is idempotent for the same template', async () => {
    const a = await repo.create({
      configId: 'cfg-1',
      scope: 'product',
      externalId: 'p1',
      label: 'Mug',
    });
    const again = await repo.create({ configId: 'cfg-1', scope: 'product', externalId: 'p1' });
    expect(again.id).toBe(a.id);
    expect(await repo.list()).toHaveLength(1);
  });

  it('refuses to take a target owned by another template unless asked to reassign', async () => {
    const a = await repo.create({ configId: 'cfg-1', scope: 'product', externalId: 'p1' });
    await expect(
      repo.create({ configId: 'cfg-2', scope: 'product', externalId: 'p1' }),
    ).rejects.toBeInstanceOf(MappingConflictError);
    const moved = await repo.create({
      configId: 'cfg-2',
      scope: 'product',
      externalId: 'p1',
      reassign: true,
    });
    expect(moved.id).toBe(a.id);
    expect(moved.configId).toBe('cfg-2');
  });

  it('the same external id in different scopes does not conflict', async () => {
    await repo.create({ configId: 'cfg-1', scope: 'product', externalId: '7' });
    await expect(
      repo.create({ configId: 'cfg-2', scope: 'variant', externalId: '7' }),
    ).resolves.toBeTruthy();
  });

  it('rejects malformed targets', async () => {
    await expect(
      repo.create({ configId: 'c', scope: 'product', externalId: '' }),
    ).rejects.toBeInstanceOf(MappingInvalidError);
    await expect(
      repo.create({ configId: 'c', scope: 'product', externalId: ' x ' }),
    ).rejects.toBeInstanceOf(MappingInvalidError);
    await expect(
      repo.create({ configId: 'c', scope: 'sku' as never, externalId: 'x' }),
    ).rejects.toBeInstanceOf(MappingInvalidError);
  });

  it('bulk: creates, reports conflicts, reassigns on request and deletes', async () => {
    await repo.create({ configId: 'other', scope: 'product', externalId: 'p2' });
    const first = await repo.bulk({
      configId: 'cfg-1',
      create: [
        { scope: 'product', externalId: 'p1' },
        { scope: 'product', externalId: 'p2' },
      ],
    });
    expect(first.created.map((x) => x.externalId)).toEqual(['p1']);
    expect(first.conflicts).toHaveLength(1);
    expect(first.conflicts[0].existing.configId).toBe('other');

    const second = await repo.bulk({
      configId: 'cfg-1',
      create: [
        { scope: 'product', externalId: 'p1' },
        { scope: 'product', externalId: 'p2' },
      ],
      reassign: true,
    });
    expect(second.unchanged).toHaveLength(1);
    expect(second.reassigned.map((x) => x.externalId)).toEqual(['p2']);

    const ids = (await repo.list({ configId: 'cfg-1' })).map((x) => x.id);
    const third = await repo.bulk({ configId: 'cfg-1', deleteIds: [ids[0], 'missing'] });
    expect(third.deleted).toBe(1);
    expect(await repo.list({ configId: 'cfg-1' })).toHaveLength(1);
  });

  it('refuses oversized bulk requests', async () => {
    const create = Array.from({ length: 501 }, (_, i) => ({
      scope: 'product' as const,
      externalId: `p${i}`,
    }));
    await expect(repo.bulk({ configId: 'c', create })).rejects.toBeInstanceOf(MappingInvalidError);
  });

  it('deleteForConfig removes only that template', async () => {
    await repo.create({ configId: 'a', scope: 'product', externalId: '1' });
    await repo.create({ configId: 'b', scope: 'product', externalId: '2' });
    expect(await repo.deleteForConfig('a')).toBe(1);
    expect((await repo.list()).map((m) => m.configId)).toEqual(['b']);
  });
});
