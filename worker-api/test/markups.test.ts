import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, STORE_A, STORE_B, applyMigrations, call, json, queryDb, resetBucket, truncateAll } from './helpers';

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await truncateAll();
  resetBucket();
});

const area = { name: 'Chest area', kind: 'area', payload: { shape: { type: 'rect' }, canvas: { width: 10, height: 10 } } };

async function createMarkup(body: unknown, storeId: string = STORE_A): Promise<Response> {
  return call(`${ADMIN}/markups`, { method: 'POST', storeId, body });
}

describe('markups', () => {
  it('creates (201), lists, updates and deletes', async () => {
    const res = await createMarkup(area);
    expect(res.status).toBe(201);
    const m = (await json(res)).data;
    expect(m).toMatchObject({ storeId: STORE_A, name: 'Chest area', kind: 'area', payload: area.payload });
    expect(typeof m.createdAt).toBe('number');

    const list = await json(await call(`${ADMIN}/markups`));
    expect(list.data).toHaveLength(1);
    expect(list.meta.pagination.hasMore).toBe(false);

    const renamed = await call(`${ADMIN}/markups/${m.id}`, { method: 'PUT', body: { name: 'Chest v2' } });
    expect(renamed.status).toBe(200);
    const r = (await json(renamed)).data;
    expect(r.name).toBe('Chest v2');
    expect(r.payload).toEqual(area.payload);
    expect(r.updatedAt).toBeGreaterThan(m.updatedAt - 1);

    const repayload = await call(`${ADMIN}/markups/${m.id}`, { method: 'PUT', body: { payload: { shape: 'ellipse' } } });
    const repayloaded = (await json(repayload)).data;
    expect(repayloaded.payload).toEqual({ shape: 'ellipse' });
    expect(repayloaded.name).toBe('Chest v2');

    expect((await call(`${ADMIN}/markups/${m.id}`, { method: 'PUT', body: {} })).status).toBe(422);
    expect((await call(`${ADMIN}/markups/${m.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`${ADMIN}/markups/${m.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await call(`${ADMIN}/markups/nope`, { method: 'PUT', body: { name: 'x' } })).status).toBe(404);
  });

  it('filters by kind and search (literal match) and paginates', async () => {
    await createMarkup({ name: 'Front chest', kind: 'area', payload: {} });
    await createMarkup({ name: 'Back 100%', kind: 'area', payload: {} });
    await createMarkup({ name: 'Floral', kind: 'artwork', payload: {} });

    const areas = await json(await call(`${ADMIN}/markups?kind=area`));
    expect(areas.data).toHaveLength(2);
    const search = await json(await call(`${ADMIN}/markups?search=CHEST`));
    expect(search.data.map((m: any) => m.name)).toEqual(['Front chest']);
    const percent = await json(await call(`${ADMIN}/markups?search=${encodeURIComponent('100%')}`));
    expect(percent.data).toHaveLength(1);
    const wildcard = await json(await call(`${ADMIN}/markups?search=${encodeURIComponent('%')}`));
    expect(wildcard.data).toHaveLength(1); // only the name that literally contains "%"

    const p1 = await json(await call(`${ADMIN}/markups?limit=2`));
    expect(p1.data).toHaveLength(2);
    const p2 = await json(
      await call(`${ADMIN}/markups?limit=2&cursor=${encodeURIComponent(p1.meta.pagination.nextCursor)}`),
    );
    expect(p2.data).toHaveLength(1);
    expect((await call(`${ADMIN}/markups?kind=bogus`)).status).toBe(422);
  });

  it('rejects a duplicate name within a kind (case-insensitive) with markup_name_taken', async () => {
    await createMarkup(area);
    const dup = await createMarkup({ ...area, name: 'CHEST AREA' });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error.code).toBe('markup_name_taken');

    // Same name under the other kind is fine.
    expect((await createMarkup({ ...area, kind: 'artwork' })).status).toBe(201);

    // Renaming onto an existing name conflicts; a case-only rename of itself does not.
    const other = (await json(await createMarkup({ name: 'Other', kind: 'area', payload: {} }))).data;
    const clash = await call(`${ADMIN}/markups/${other.id}`, { method: 'PUT', body: { name: 'chest area' } });
    expect(clash.status).toBe(409);
    expect((await json(clash)).error.code).toBe('markup_name_taken');
    const self = await call(`${ADMIN}/markups/${other.id}`, { method: 'PUT', body: { name: 'OTHER' } });
    expect(self.status).toBe(200);
  });

  it('validates name, kind and that payload is a JSON object', async () => {
    expect((await createMarkup({ name: '', kind: 'area', payload: {} })).status).toBe(422);
    expect((await createMarkup({ name: 'x'.repeat(121), kind: 'area', payload: {} })).status).toBe(422);
    expect((await createMarkup({ name: 'ok', kind: 'nope', payload: {} })).status).toBe(422);
    for (const payload of [[], 'text', 42, null, undefined]) {
      const res = await createMarkup({ name: 'p', kind: 'area', payload });
      expect(res.status).toBe(422);
    }
  });

  it('enforces the payload size limit (256 KB)', async () => {
    const big = { blob: 'x'.repeat(256 * 1024) };
    const tooBig = await createMarkup({ name: 'big', kind: 'area', payload: big });
    expect(tooBig.status).toBe(422);
    const body = await json(tooBig);
    expect(body.error.details.issues[0]).toMatchObject({ path: 'payload', code: 'too_large' });

    const justUnder = await createMarkup({ name: 'under', kind: 'area', payload: { blob: 'x'.repeat(250 * 1024) } });
    expect(justUnder.status).toBe(201);

    const m = (await json(justUnder)).data;
    const upd = await call(`${ADMIN}/markups/${m.id}`, { method: 'PUT', body: { payload: big } });
    expect(upd.status).toBe(422);

    const huge = await call(`${ADMIN}/markups`, {
      method: 'POST',
      headers: { 'content-length': String(5 * 1024 * 1024) },
      body: { name: 'huge', kind: 'area', payload: {} },
    });
    expect(huge.status).toBe(413);
  });

  it('refuses deeply nested payloads', async () => {
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) nested = { n: nested };
    expect((await createMarkup({ name: 'deep', kind: 'area', payload: nested })).status).toBe(422);
  });

  it('isolates stores: no cross-tenant read, update or delete, and names are per store', async () => {
    const a = (await json(await createMarkup(area, STORE_A))).data;
    expect((await json(await call(`${ADMIN}/markups`, { storeId: STORE_B }))).data).toEqual([]);
    expect((await call(`${ADMIN}/markups/${a.id}`, { storeId: STORE_B, method: 'PUT', body: { name: 'x' } })).status).toBe(404);
    expect((await call(`${ADMIN}/markups/${a.id}`, { storeId: STORE_B, method: 'DELETE' })).status).toBe(404);
    // Same name in store B does not conflict with store A.
    expect((await createMarkup(area, STORE_B)).status).toBe(201);
    expect((await json(await call(`${ADMIN}/markups`, { storeId: STORE_A }))).data).toHaveLength(1);
    expect((await json(await call(`${ADMIN}/markups`, { storeId: STORE_A }))).data[0].name).toBe('Chest area');
  });

  it('audits writes', async () => {
    const m = (await json(await createMarkup(area))).data;
    await call(`${ADMIN}/markups/${m.id}`, { method: 'PUT', body: { name: 'n2' } });
    await call(`${ADMIN}/markups/${m.id}`, { method: 'DELETE' });
    const rows = await queryDb<{ action: string }>(
      `SELECT action FROM platform.audit_logs WHERE action LIKE 'markup.%' ORDER BY created_at, action`,
    );
    expect(rows.map((r) => r.action).sort()).toEqual(['markup.create', 'markup.delete', 'markup.update']);
  });
});

describe('storefront settings', () => {
  it('stores normalised, de-duplicated origins per store and rejects bad ones', async () => {
    expect((await json(await call(`${ADMIN}/settings/storefront`))).data).toEqual({ storefrontOrigins: [] });

    const put = await call(`${ADMIN}/settings/storefront`, {
      method: 'PUT',
      body: { storefrontOrigins: ['https://Shop.Example.com/', 'https://shop.example.com', 'http://localhost:3000'] },
    });
    expect(put.status).toBe(200);
    expect((await json(put)).data.storefrontOrigins).toEqual(['https://shop.example.com', 'http://localhost:3000']);
    expect((await json(await call(`${ADMIN}/settings/storefront`))).data.storefrontOrigins).toHaveLength(2);
    // Another store's settings are independent.
    expect((await json(await call(`${ADMIN}/settings/storefront`, { storeId: STORE_B }))).data.storefrontOrigins).toEqual([]);

    for (const bad of ['shop.example.com', 'https://shop.example.com/path', 'ftp://x.example', 'https://u:p@x.example', 'javascript:alert(1)']) {
      const res = await call(`${ADMIN}/settings/storefront`, { method: 'PUT', body: { storefrontOrigins: [bad] } });
      expect(res.status, bad).toBe(422);
    }
    expect((await call(`${ADMIN}/settings/storefront`, { token: null })).status).toBe(401);
  });
});
