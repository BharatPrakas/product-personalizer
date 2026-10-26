import { LocalMarkupRepository } from './local-markup-repository.service';
import { MarkupInvalidError, MarkupNameTakenError } from './markup.models';

const payload = {
  v: 1 as const,
  kind: 'area' as const,
  area: {
    name: 'A',
    canvas: { width: 100, height: 100, background: 'transparent' },
    shape: { type: 'rect' as const },
  },
};

describe('LocalMarkupRepository', () => {
  let repo: LocalMarkupRepository;
  beforeEach(() => (repo = new LocalMarkupRepository()));

  it('creates, lists, searches, renames and deletes', async () => {
    const heart = await repo.create({ name: 'Heart', kind: 'area', payload });
    await repo.create({ name: 'Round badge', kind: 'area', payload });
    expect((await repo.list({ kind: 'area' })).length).toBe(2);
    expect((await repo.list({ search: 'hea' })).map((m) => m.name)).toEqual(['Heart']);
    expect((await repo.list({ kind: 'artwork' })).length).toBe(0);
    expect((await repo.rename(heart.id, 'Big heart')).name).toBe('Big heart');
    await repo.delete(heart.id);
    expect((await repo.list()).map((m) => m.name)).toEqual(['Round badge']);
  });

  it('names are unique per kind, ignoring case', async () => {
    await repo.create({ name: 'Heart', kind: 'area', payload });
    await expect(repo.create({ name: 'heart', kind: 'area', payload })).rejects.toBeInstanceOf(
      MarkupNameTakenError,
    );
    const other = await repo.create({ name: 'Other', kind: 'area', payload });
    await expect(repo.rename(other.id, 'HEART')).rejects.toBeInstanceOf(MarkupNameTakenError);
    await expect(repo.rename(other.id, 'Other')).resolves.toBeTruthy(); // renaming to itself is fine
  });

  it('rejects empty names and mismatched payloads', async () => {
    await expect(repo.create({ name: ' ', kind: 'area', payload })).rejects.toBeInstanceOf(
      MarkupInvalidError,
    );
    await expect(repo.create({ name: 'x', kind: 'artwork', payload })).rejects.toBeInstanceOf(
      MarkupInvalidError,
    );
  });
});
