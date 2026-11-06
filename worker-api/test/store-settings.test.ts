import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  STOREFRONT,
  STORE_A,
  STORE_B,
  applyMigrations,
  call,
  json,
  publishableDraft,
  queryDb,
  resetBucket,
  sharedBucket,
  tinyPng,
  truncateAll,
} from './helpers';

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await truncateAll();
  resetBucket();
});

const stores = () => queryDb<any>('SELECT store_id, storefront_origins, created_at FROM store_settings ORDER BY store_id');

describe('store registration', () => {
  it('registers a store on its first authenticated request, once', async () => {
    expect(await stores()).toEqual([]);

    expect((await call(`${ADMIN}/configs`)).status).toBe(200);
    const [first] = await stores();
    expect(first).toMatchObject({ store_id: STORE_A, storefront_origins: [] });

    expect((await call(`${ADMIN}/configs`)).status).toBe(200);
    const rows = await stores();
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at).toEqual(first.created_at);
  });

  it('registers each store separately, from its verified token only', async () => {
    await call(`${ADMIN}/configs`, { storeId: STORE_A });
    expect((await stores()).map((r) => r.store_id)).toEqual([STORE_A]);
    await call(`${ADMIN}/configs`, { storeId: STORE_B });
    expect((await stores()).map((r) => r.store_id)).toEqual([STORE_A, STORE_B]);
  });

  it('registers nothing for a request without a valid token', async () => {
    expect((await call(`${ADMIN}/configs`, { token: null })).status).toBe(401);
    expect((await call(`${ADMIN}/configs`, { token: 'not-the-dev-token' })).status).toBe(401);
    expect(await stores()).toEqual([]);
  });

  it('keeps each store\'s storefront origins separate', async () => {
    const put = await call(`${ADMIN}/settings/storefront`, {
      method: 'PUT',
      storeId: STORE_A,
      body: { storefrontOrigins: ['https://Shop.example.com', 'https://shop.example.com/'] },
    });
    expect(put.status).toBe(200);
    expect((await json(put)).data.storefrontOrigins).toEqual(['https://shop.example.com']);

    const own = await json(await call(`${ADMIN}/settings/storefront`, { storeId: STORE_A }));
    const other = await json(await call(`${ADMIN}/settings/storefront`, { storeId: STORE_B }));
    expect(own.data.storefrontOrigins).toEqual(['https://shop.example.com']);
    expect(other.data.storefrontOrigins).toEqual([]);
  });
});

describe('a store that has never used the merchant API', () => {
  const unknown = 'store_never_seen';

  it('is answered like "nothing mapped" on the public config route', async () => {
    const res = await call(`${STOREFRONT}/products/p1/config?storeId=${unknown}`, { token: null });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ personalizable: false });
  });

  it('cannot receive shopper uploads or saves, and nothing is written', async () => {
    const upload = await call(`${STOREFRONT}/uploads?storeId=${unknown}&kind=upload`, {
      method: 'POST',
      token: null,
      rawBody: tinyPng(),
      headers: { 'Content-Type': 'image/png' },
    });
    expect(upload.status).toBe(404);

    const save = await call(`${STOREFRONT}/customizations?storeId=${unknown}`, {
      method: 'POST',
      token: null,
      body: { productId: 'p1', configId: 'cfg-x', configVersion: 1, data: {}, assets: [] },
    });
    expect(save.status).toBe(404);

    expect(sharedBucket.objects.size).toBe(0);
    expect(await queryDb('SELECT 1 FROM customization_assets')).toEqual([]);
    expect(await queryDb('SELECT 1 FROM customizations')).toEqual([]);
  });

  it('becomes known as soon as its merchant uses the API', async () => {
    const created = await call(`${ADMIN}/configs`, {
      method: 'POST',
      storeId: unknown,
      body: { clientConfigId: 'cfg-first', draft: publishableDraft('cfg-first') },
    });
    expect(created.status).toBe(201);

    const upload = await call(`${STOREFRONT}/uploads?storeId=${unknown}&kind=upload`, {
      method: 'POST',
      token: null,
      rawBody: tinyPng(),
      headers: { 'Content-Type': 'image/png' },
    });
    expect(upload.status).toBe(201);
  });
});
