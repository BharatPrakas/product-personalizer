import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  STORE_A,
  STORE_B,
  applyMigrations,
  call,
  json,
  mapTo,
  queryDb,
  resetBucket,
  seedDraft,
  seedPublished,
  truncateAll,
} from './helpers';

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await truncateAll();
  resetBucket();
});

describe('mappings', () => {
  it('creates a mapping (201) with the documented shape, then lists it', async () => {
    await seedPublished('cfg-m1');
    const res = await mapTo('cfg-m1', 'product', 'prod-100', STORE_A, { label: '  Blue Tee  ' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Location')).toContain(`${ADMIN}/mappings/`);
    const m = (await json(res)).data;
    expect(m).toMatchObject({
      storeId: STORE_A,
      configId: 'cfg-m1',
      configName: 'Publishable Tee',
      configStatus: 'published',
      scope: 'product',
      externalId: 'prod-100',
      label: 'Blue Tee',
    });
    expect(typeof m.id).toBe('string');
    expect(typeof m.createdAt).toBe('number');
    expect(typeof m.updatedAt).toBe('number');

    const list = await json(await call(`${ADMIN}/mappings`));
    expect(list.data).toHaveLength(1);
    expect(list.meta.pagination).toEqual({ limit: 50, hasMore: false, nextCursor: null });
  });

  it('reports draft status for an unpublished config and archived for an archived one', async () => {
    await seedDraft('cfg-d1');
    const m = (await json(await mapTo('cfg-d1', 'product', 'p-draft'))).data;
    expect(m.configStatus).toBe('draft');
    await call(`${ADMIN}/configs/cfg-d1/archive`, { method: 'POST' });
    const list = await json(await call(`${ADMIN}/mappings`));
    expect(list.data[0].configStatus).toBe('archived');
  });

  it('filters by configId, scope and externalId and paginates with a cursor', async () => {
    await seedPublished('cfg-f1');
    await seedPublished('cfg-f2');
    await mapTo('cfg-f1', 'product', 'p1');
    await mapTo('cfg-f1', 'variant', 'v1');
    await mapTo('cfg-f2', 'product', 'p2');

    const byConfig = await json(await call(`${ADMIN}/mappings?configId=cfg-f1`));
    expect(byConfig.data.map((m: any) => m.externalId).sort()).toEqual(['p1', 'v1']);
    const byScope = await json(await call(`${ADMIN}/mappings?scope=variant`));
    expect(byScope.data).toHaveLength(1);
    const byExternal = await json(await call(`${ADMIN}/mappings?externalId=p2`));
    expect(byExternal.data[0].configId).toBe('cfg-f2');
    const unknownConfig = await json(await call(`${ADMIN}/mappings?configId=nope`));
    expect(unknownConfig.data).toEqual([]);

    const first = await json(await call(`${ADMIN}/mappings?limit=2`));
    expect(first.data).toHaveLength(2);
    expect(first.meta.pagination.hasMore).toBe(true);
    const second = await json(
      await call(`${ADMIN}/mappings?limit=2&cursor=${encodeURIComponent(first.meta.pagination.nextCursor)}`),
    );
    expect(second.data).toHaveLength(1);
    expect(second.meta.pagination.hasMore).toBe(false);
    const ids = [...first.data, ...second.data].map((m: any) => m.id);
    expect(new Set(ids).size).toBe(3);

    const bad = await call(`${ADMIN}/mappings?cursor=%%%`);
    expect(bad.status).toBe(400);
  });

  it('is idempotent when the target is already mapped to the same config', async () => {
    await seedPublished('cfg-i1');
    const a = (await json(await mapTo('cfg-i1', 'product', 'p-same'))).data;
    const again = await mapTo('cfg-i1', 'product', 'p-same', STORE_A, { label: 'Renamed' });
    expect(again.status).toBe(200);
    const b = (await json(again)).data;
    expect(b.id).toBe(a.id);
    expect(b.label).toBe('Renamed');
    expect((await json(await call(`${ADMIN}/mappings`))).data).toHaveLength(1);
  });

  it('answers 409 mapping_conflict for a different config, and moves it with reassign', async () => {
    await seedPublished('cfg-c1');
    await seedPublished('cfg-c2');
    const first = (await json(await mapTo('cfg-c1', 'product', 'p-conflict'))).data;

    const conflict = await mapTo('cfg-c2', 'product', 'p-conflict');
    expect(conflict.status).toBe(409);
    const body = await json(conflict);
    expect(body.error.code).toBe('mapping_conflict');
    expect(body.error.details.existing).toEqual({
      id: first.id,
      configId: 'cfg-c1',
      configName: 'Publishable Tee',
    });

    const moved = await mapTo('cfg-c2', 'product', 'p-conflict', STORE_A, { reassign: true });
    expect(moved.status).toBe(200);
    const m = (await json(moved)).data;
    expect(m.id).toBe(first.id);
    expect(m.configId).toBe('cfg-c2');
    expect((await json(await call(`${ADMIN}/mappings?configId=cfg-c1`))).data).toEqual([]);
  });

  it('refuses archived (422 config_archived), unknown (404) and foreign configs (404)', async () => {
    await seedPublished('cfg-a1');
    await call(`${ADMIN}/configs/cfg-a1/archive`, { method: 'POST' });
    const archived = await mapTo('cfg-a1', 'product', 'p-arch');
    expect(archived.status).toBe(422);
    expect((await json(archived)).error.code).toBe('config_archived');

    expect((await mapTo('cfg-missing', 'product', 'p-x')).status).toBe(404);

    await seedPublished('cfg-a-only');
    // Store B referencing store A's config id must not find it.
    const foreign = await mapTo('cfg-a-only', 'product', 'p-foreign', STORE_B);
    expect(foreign.status).toBe(404);
  });

  it('validates the body', async () => {
    await seedPublished('cfg-v1');
    const badScope = await call(`${ADMIN}/mappings`, {
      method: 'POST',
      body: { configId: 'cfg-v1', scope: 'galaxy', externalId: 'x' },
    });
    expect(badScope.status).toBe(422);
    const longId = await mapTo('cfg-v1', 'product', 'x'.repeat(201));
    expect(longId.status).toBe(422);
    const emptyId = await mapTo('cfg-v1', 'product', '   ');
    expect(emptyId.status).toBe(422);
    const longLabel = await mapTo('cfg-v1', 'product', 'ok', STORE_A, { label: 'l'.repeat(201) });
    expect(longLabel.status).toBe(422);
  });

  it('updates label, and moving to another config needs reassign', async () => {
    await seedPublished('cfg-u1');
    await seedPublished('cfg-u2');
    const m = (await json(await mapTo('cfg-u1', 'product', 'p-upd'))).data;

    const label = await call(`${ADMIN}/mappings/${m.id}`, { method: 'PUT', body: { label: 'New title' } });
    expect(label.status).toBe(200);
    expect((await json(label)).data.label).toBe('New title');
    const cleared = await call(`${ADMIN}/mappings/${m.id}`, { method: 'PUT', body: { label: '' } });
    expect((await json(cleared)).data.label).toBeNull();

    const blocked = await call(`${ADMIN}/mappings/${m.id}`, { method: 'PUT', body: { configId: 'cfg-u2' } });
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error.code).toBe('mapping_conflict');

    const moved = await call(`${ADMIN}/mappings/${m.id}`, {
      method: 'PUT',
      body: { configId: 'cfg-u2', reassign: true },
    });
    expect(moved.status).toBe(200);
    expect((await json(moved)).data.configId).toBe('cfg-u2');

    expect((await call(`${ADMIN}/mappings/${m.id}`, { method: 'PUT', body: {} })).status).toBe(422);
    expect((await call(`${ADMIN}/mappings/not-a-uuid`, { method: 'PUT', body: { label: 'x' } })).status).toBe(404);
  });

  it('deletes with 204 and then 404', async () => {
    await seedPublished('cfg-del');
    const m = (await json(await mapTo('cfg-del', 'product', 'p-del'))).data;
    expect((await call(`${ADMIN}/mappings/${m.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`${ADMIN}/mappings/${m.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('removes mappings when their config is deleted, and counts them on the config', async () => {
    await seedPublished('cfg-cas');
    await mapTo('cfg-cas', 'product', 'p-cas1');
    await mapTo('cfg-cas', 'variant', 'v-cas1');
    const cfg = (await json(await call(`${ADMIN}/configs/cfg-cas`))).data;
    expect(cfg.mappingCount).toBe(2);
    const listed = (await json(await call(`${ADMIN}/configs`))).data;
    expect(listed[0].mappingCount).toBe(2);

    expect((await call(`${ADMIN}/configs/cfg-cas`, { method: 'DELETE' })).status).toBe(204);
    expect((await json(await call(`${ADMIN}/mappings`))).data).toEqual([]);
  });

  it('writes audit rows for mapping changes', async () => {
    await seedPublished('cfg-aud');
    const m = (await json(await mapTo('cfg-aud', 'product', 'p-aud'))).data;
    await call(`${ADMIN}/mappings/${m.id}`, { method: 'DELETE' });
    const rows = await queryDb<{ action: string; resource_type: string }>(
      `SELECT action, resource_type FROM platform.audit_logs WHERE action LIKE 'mapping.%' ORDER BY created_at`,
    );
    expect(rows.map((r) => r.action)).toEqual(['mapping.create', 'mapping.delete']);
    expect(rows[0].resource_type).toBe('mapping');
  });

  it('needs authentication', async () => {
    expect((await call(`${ADMIN}/mappings`, { token: null })).status).toBe(401);
    expect((await call(`${ADMIN}/markups`, { token: null })).status).toBe(401);
  });
});

describe('bulk mappings', () => {
  it('creates, leaves unchanged, reports conflicts, and deletes in one call', async () => {
    await seedPublished('cfg-b1');
    await seedPublished('cfg-b2');
    const existing = (await json(await mapTo('cfg-b1', 'product', 'p-keep'))).data;
    const other = (await json(await mapTo('cfg-b2', 'product', 'p-other'))).data;
    const toDelete = (await json(await mapTo('cfg-b1', 'collection', 'c-gone'))).data;

    const res = await call(`${ADMIN}/mappings/bulk`, {
      method: 'POST',
      body: {
        configId: 'cfg-b1',
        create: [
          { scope: 'product', externalId: 'p-new1', label: 'One' },
          { scope: 'variant', externalId: 'v-new2' },
          { scope: 'product', externalId: 'p-keep' }, // already ours
          { scope: 'product', externalId: 'p-other' }, // owned by cfg-b2 -> conflict
          { scope: 'product', externalId: 'p-new1' }, // duplicate in the request
        ],
        deleteIds: [toDelete.id],
      },
    });
    expect(res.status).toBe(200);
    const r = (await json(res)).data;
    expect(r.created.map((m: any) => m.externalId).sort()).toEqual(['p-new1', 'v-new2']);
    expect(r.created.find((m: any) => m.externalId === 'p-new1').label).toBe('One');
    expect(r.unchanged.map((m: any) => m.id)).toEqual([existing.id]);
    expect(r.reassigned).toEqual([]);
    expect(r.conflicts).toEqual([
      {
        scope: 'product',
        externalId: 'p-other',
        existing: { id: other.id, configId: 'cfg-b2', configName: 'Publishable Tee' },
      },
    ]);
    expect(r.deleted).toBe(1);

    // The conflicting target was NOT moved; the deleted one is gone.
    const after = (await json(await call(`${ADMIN}/mappings?limit=200`))).data;
    expect(after.find((m: any) => m.externalId === 'p-other').configId).toBe('cfg-b2');
    expect(after.find((m: any) => m.externalId === 'c-gone')).toBeUndefined();
  });

  it('moves conflicting targets when reassign is true', async () => {
    await seedPublished('cfg-r1');
    await seedPublished('cfg-r2');
    await mapTo('cfg-r2', 'product', 'p-move');
    const res = await call(`${ADMIN}/mappings/bulk`, {
      method: 'POST',
      body: { configId: 'cfg-r1', reassign: true, create: [{ scope: 'product', externalId: 'p-move' }] },
    });
    const r = (await json(res)).data;
    expect(r.conflicts).toEqual([]);
    expect(r.reassigned).toHaveLength(1);
    expect(r.reassigned[0].configId).toBe('cfg-r1');
  });

  it('lets a delete and re-create of the same target succeed in one request', async () => {
    await seedPublished('cfg-dr');
    const m = (await json(await mapTo('cfg-dr', 'product', 'p-dr'))).data;
    const r = (
      await json(
        await call(`${ADMIN}/mappings/bulk`, {
          method: 'POST',
          body: { configId: 'cfg-dr', deleteIds: [m.id], create: [{ scope: 'product', externalId: 'p-dr' }] },
        }),
      )
    ).data;
    expect(r.deleted).toBe(1);
    expect(r.created).toHaveLength(1);
    expect(r.created[0].id).not.toBe(m.id);
  });

  it('rejects more than 500 items, an archived or unknown config', async () => {
    await seedPublished('cfg-lim');
    const create = Array.from({ length: 501 }, (_, i) => ({ scope: 'product', externalId: `p${i}` }));
    const tooMany = await call(`${ADMIN}/mappings/bulk`, { method: 'POST', body: { configId: 'cfg-lim', create } });
    expect(tooMany.status).toBe(422);

    const fine = await call(`${ADMIN}/mappings/bulk`, {
      method: 'POST',
      body: { configId: 'cfg-lim', create: create.slice(0, 500) },
    });
    expect(fine.status).toBe(200);
    expect((await json(fine)).data.created).toHaveLength(500);

    expect(
      (await call(`${ADMIN}/mappings/bulk`, { method: 'POST', body: { configId: 'nope', create: [] } })).status,
    ).toBe(404);
    await call(`${ADMIN}/configs/cfg-lim/archive`, { method: 'POST' });
    const archived = await call(`${ADMIN}/mappings/bulk`, {
      method: 'POST',
      body: { configId: 'cfg-lim', create: [{ scope: 'product', externalId: 'zzz' }] },
    });
    expect(archived.status).toBe(422);
    expect((await json(archived)).error.code).toBe('config_archived');
  });
});

describe('mapping tenant isolation', () => {
  it('store B cannot read, modify or delete store A mappings', async () => {
    await seedPublished('cfg-ta', STORE_A);
    await seedPublished('cfg-tb', STORE_B);
    const a = (await json(await mapTo('cfg-ta', 'product', 'shared-ext-id', STORE_A))).data;

    expect((await json(await call(`${ADMIN}/mappings`, { storeId: STORE_B }))).data).toEqual([]);
    const put = await call(`${ADMIN}/mappings/${a.id}`, { storeId: STORE_B, method: 'PUT', body: { label: 'hax' } });
    expect(put.status).toBe(404);
    const del = await call(`${ADMIN}/mappings/${a.id}`, { storeId: STORE_B, method: 'DELETE' });
    expect(del.status).toBe(404);
    const bulk = await call(`${ADMIN}/mappings/bulk`, {
      storeId: STORE_B,
      method: 'POST',
      body: { configId: 'cfg-tb', deleteIds: [a.id] },
    });
    expect((await json(bulk)).data.deleted).toBe(0);

    // The same external id is free in store B (uniqueness is per store).
    const own = await mapTo('cfg-tb', 'product', 'shared-ext-id', STORE_B);
    expect(own.status).toBe(201);

    // Store A's mapping is intact and untouched.
    const still = (await json(await call(`${ADMIN}/mappings`, { storeId: STORE_A }))).data;
    expect(still).toHaveLength(1);
    expect(still[0]).toMatchObject({ id: a.id, configId: 'cfg-ta', label: null });
  });
});
