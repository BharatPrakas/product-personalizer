import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  PRODUCT_ID,
  STOREFRONT,
  STORE_A,
  STORE_B,
  applyMigrations,
  call,
  json,
  queryDb,
  resetBucket,
  saveCustomization,
  seedPersonalizableProduct,
  sharedBucket,
  storefrontConfig,
  tinyPng,
  truncateAll,
  uploadCustomerImage,
} from './helpers';
import { issueCustomerToken } from '../src/modules/personalization/customer-token';

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await truncateAll();
  resetBucket();
});

const pub = (path: string, options: Parameters<typeof call>[1] = {}) => call(path, { token: null, ...options });
const czUrl = (id = '', storeId = STORE_A, extra = '') => `${STOREFRONT}/customizations${id ? `/${id}` : ''}?storeId=${storeId}${extra}`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const errorOf = async (res: Response) => (await json(res)).error;

describe('private customer uploads', () => {
  it('stores the image under the private customizations prefix and returns a scoped upload token', async () => {
    await seedPersonalizableProduct();
    const asset = await uploadCustomerImage();
    expect(asset).toMatchObject({ kind: 'upload', contentType: 'image/png', width: 1, height: 1 });
    expect(asset.uploadToken).toMatch(/^zbc1\./);
    const [row] = await queryDb<any>('SELECT object_key, status, customization_id FROM personalization.customization_assets');
    expect(row.object_key.startsWith(`stores/${STORE_A}/product-personalization/customizations/`)).toBe(true);
    expect(row.status).toBe('uploaded');
    expect(row.customization_id).toBeNull();
    expect(sharedBucket.objects.has(row.object_key)).toBe(true);
    // The response never exposes the object key.
    expect(JSON.stringify(asset)).not.toContain('stores/');
  });

  it('is never reachable through the public asset route, even with a valid-looking request', async () => {
    await seedPersonalizableProduct();
    const asset = await uploadCustomerImage();
    expect((await pub(`${STOREFRONT}/assets/${asset.assetId}`)).status).toBe(404);
    expect((await pub(`${STOREFRONT}/assets/${asset.assetId}?sig=${asset.uploadToken}`)).status).toBe(404);
  });

  it('rejects non-images, empty bodies, oversized files and unknown stores', async () => {
    await seedPersonalizableProduct();
    const post = (body: Uint8Array, storeId = STORE_A, env = {}) =>
      pub(`${STOREFRONT}/uploads?storeId=${storeId}`, { method: 'POST', rawBody: body, env });
    expect((await post(new TextEncoder().encode('<svg onload=alert(1)>'))).status).toBe(415);
    expect((await post(new Uint8Array())).status).toBe(415);
    expect((await post(tinyPng(), STORE_A, { MAX_UPLOAD_BYTES: '10' })).status).toBe(413);
    expect((await post(tinyPng(), 'no_such_store')).status).toBe(404);
    expect(await queryDb('SELECT 1 FROM personalization.customization_assets')).toHaveLength(0);
  });

  it('answers 503 when customer tokens are not configured, without storing anything', async () => {
    await seedPersonalizableProduct();
    const res = await pub(`${STOREFRONT}/uploads?storeId=${STORE_A}`, { method: 'POST', rawBody: tinyPng(), env: { CUSTOMIZATION_TOKEN_SECRET: undefined } });
    expect(res.status).toBe(503);
    expect(sharedBucket.objects.size).toBe(0);
  });
});

describe('saving a customization', () => {
  it('returns only the id, a scoped token and expiry — not the customer’s data', async () => {
    await seedPersonalizableProduct();
    const asset = await uploadCustomerImage();
    const cfg = await storefrontConfig();
    const res = await pub(czUrl(), {
      method: 'POST',
      body: {
        productId: PRODUCT_ID, configId: cfg.configId, configVersion: cfg.version,
        data: { fields: { name: 'secret-customer-text' } },
        assets: [{ assetId: asset.assetId, uploadToken: asset.uploadToken }],
      },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const saved = (await json(res)).data;
    expect(Object.keys(saved).sort()).toEqual(['accessToken', 'accessTokenExpiresAt', 'customizationId', 'expiresAt', 'status']);
    expect(JSON.stringify(saved)).not.toContain('secret-customer-text');

    const [row] = await queryDb<any>('SELECT * FROM personalization.customizations');
    expect(row).toMatchObject({ store_id: STORE_A, config_version: cfg.version, product_external_id: PRODUCT_ID, mapping_scope: 'product', status: 'saved' });
    // 30-day default inactivity window.
    const days = (new Date(row.expires_at).getTime() - new Date(row.last_activity_at).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    const [a] = await queryDb<any>('SELECT status, customization_id FROM personalization.customization_assets');
    expect(a).toMatchObject({ status: 'attached', customization_id: saved.customizationId });
  });

  it('honours the configurable retention period', async () => {
    await seedPersonalizableProduct();
    await saveCustomization({ env: { CUSTOMIZATION_RETENTION_DAYS: '7' } });
    const [row] = await queryDb<any>('SELECT expires_at, last_activity_at FROM personalization.customizations');
    expect(Math.round((new Date(row.expires_at).getTime() - new Date(row.last_activity_at).getTime()) / 86_400_000)).toBe(7);
  });

  it('pins the configuration version it was designed against, even after a republish', async () => {
    await seedPersonalizableProduct();
    const before = await storefrontConfig();
    const first = await saveCustomization();
    // Republish: the live version moves on.
    await call(`${ADMIN}/configs/cfg-cz1/publish`, { method: 'POST' });
    const after = await storefrontConfig();
    expect(after.version).toBe(before.version + 1);
    const [row] = await queryDb<any>('SELECT config_version FROM personalization.customizations WHERE id = $1', [first.customizationId]);
    expect(row.config_version).toBe(before.version);
    // An older rendered version is still accepted (its snapshot exists); a never-published one is not.
    const stale = await pub(czUrl(), { method: 'POST', body: { productId: PRODUCT_ID, configId: after.configId, configVersion: before.version, data: {} } });
    expect(stale.status).toBe(201);
    const bogus = await pub(czUrl(), { method: 'POST', body: { productId: PRODUCT_ID, configId: after.configId, configVersion: 999, data: {} } });
    expect(bogus.status).toBe(422);
  });

  it('refuses a product with no published mapping and a config the product no longer uses', async () => {
    await seedPersonalizableProduct();
    const cfg = await storefrontConfig();
    const unmapped = await pub(czUrl(), { method: 'POST', body: { productId: 'unmapped', configId: cfg.configId, configVersion: cfg.version, data: {} } });
    expect(unmapped.status).toBe(404);
    expect((await errorOf(unmapped)).code).toBe('not_personalizable');
    const wrongConfig = await pub(czUrl(), { method: 'POST', body: { productId: PRODUCT_ID, configId: 'cfg-someone-else', configVersion: cfg.version, data: {} } });
    expect(wrongConfig.status).toBe(409);
    expect((await errorOf(wrongConfig)).details.reason).toBe('config_changed');
  });

  it('rejects invalid bodies (non-object data, oversized data, too many assets, unknown store)', async () => {
    await seedPersonalizableProduct();
    const cfg = await storefrontConfig();
    const base = { productId: PRODUCT_ID, configId: cfg.configId, configVersion: cfg.version };
    expect((await pub(czUrl(), { method: 'POST', body: { ...base, data: 'text' } })).status).toBe(422);
    expect((await pub(czUrl(), { method: 'POST', body: { ...base, data: [] } })).status).toBe(422);
    expect((await pub(czUrl(), { method: 'POST', body: { ...base, data: { blob: 'x'.repeat(300 * 1024) } } })).status).toBe(422);
    expect((await pub(czUrl(), { method: 'POST', body: { ...base, data: { blob: 'x'.repeat(400 * 1024) } } })).status).toBe(413);
    expect((await pub(czUrl(), { method: 'POST', body: { ...base, data: {} }, rawBody: new TextEncoder().encode('{nope') })).status).toBe(400);
    expect((await pub(czUrl('', 'ghost_store'), { method: 'POST', body: { ...base, data: {} } })).status).toBe(404);
    expect(await queryDb('SELECT 1 FROM personalization.customizations')).toHaveLength(0);
  });

  it('requires a valid upload token per attached file and lets a file be used only once', async () => {
    await seedPersonalizableProduct();
    const asset = await uploadCustomerImage();
    const cfg = await storefrontConfig();
    const body = (assets: unknown[]) => ({ productId: PRODUCT_ID, configId: cfg.configId, configVersion: cfg.version, data: {}, assets });

    // No token / someone else's token.
    expect((await pub(czUrl(), { method: 'POST', body: body([{ assetId: asset.assetId }]) })).status).toBe(401);
    const other = await uploadCustomerImage();
    expect((await pub(czUrl(), { method: 'POST', body: body([{ assetId: asset.assetId, uploadToken: other.uploadToken }]) })).status).toBe(401);
    // Duplicate ids in one request.
    expect((await pub(czUrl(), { method: 'POST', body: body([{ assetId: asset.assetId, uploadToken: asset.uploadToken }, { assetId: asset.assetId, uploadToken: asset.uploadToken }]) })).status).toBe(422);
    // Nothing was created by the rejected attempts.
    expect(await queryDb('SELECT 1 FROM personalization.customizations')).toHaveLength(0);

    // First use succeeds; the same upload cannot be claimed by a second customization.
    expect((await pub(czUrl(), { method: 'POST', body: body([{ assetId: asset.assetId, uploadToken: asset.uploadToken }]) })).status).toBe(201);
    const replay = await pub(czUrl(), { method: 'POST', body: body([{ assetId: asset.assetId, uploadToken: asset.uploadToken }]) });
    expect(replay.status).toBe(409);
    expect((await errorOf(replay)).details.reason).toBe('asset_unavailable');
    expect(await queryDb('SELECT 1 FROM personalization.customizations')).toHaveLength(1);
  });

  it('refuses an upload token that was issued for another store', async () => {
    await seedPersonalizableProduct();
    await seedPersonalizableProduct(STORE_B, PRODUCT_ID, 'cfg-b');
    const foreign = await uploadCustomerImage(STORE_B);
    const cfg = await storefrontConfig();
    const res = await pub(czUrl(), { method: 'POST', body: { productId: PRODUCT_ID, configId: cfg.configId, configVersion: cfg.version, data: {}, assets: [{ assetId: foreign.assetId, uploadToken: foreign.uploadToken }] } });
    expect(res.status).toBe(401);
  });
});

describe('private access: the id alone authorizes nothing', () => {
  it('requires the customization’s own, unexpired token for read, update and file download', async () => {
    await seedPersonalizableProduct();
    const asset = await uploadCustomerImage();
    const mine = await saveCustomization({ assets: [{ assetId: asset.assetId, uploadToken: asset.uploadToken }] });
    const theirs = await saveCustomization();
    const id = mine.customizationId;
    const fileUrl = czUrl(`${id}/assets/${asset.assetId}`);

    // The bare id.
    for (const [method, url] of [['GET', czUrl(id)], ['PUT', czUrl(id)], ['GET', fileUrl]] as const) {
      const res = await pub(url, { method, body: method === 'PUT' ? { data: {} } : undefined });
      expect(res.status, `${method} ${url}`).toBe(401);
    }
    // Someone else's token, garbage, and a token for the same id in another scope.
    for (const token of [theirs.accessToken, 'garbage', asset.uploadToken]) {
      expect((await pub(czUrl(id), { headers: bearer(token) })).status).toBe(401);
      expect((await pub(fileUrl, { headers: bearer(token) })).status).toBe(401);
      expect((await pub(czUrl(id), { method: 'PUT', headers: bearer(token), body: { data: {} } })).status).toBe(401);
    }
    // An expired token.
    const expired = issueCustomerToken('test-customization-token-secret', { scope: 'customization', storeId: STORE_A, subject: id }, 60, new Date(Date.now() - 3_600_000));
    expect((await pub(czUrl(id), { headers: bearer(expired.token) })).status).toBe(401);
    // The right token but addressed through another store.
    expect((await pub(czUrl(id, STORE_B), { headers: bearer(mine.accessToken) })).status).toBe(404);

    // The right token works.
    const read = await pub(czUrl(id), { headers: bearer(mine.accessToken) });
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('no-store');
    const dto = (await json(read)).data;
    expect(dto).toMatchObject({ customizationId: id, status: 'saved', productId: PRODUCT_ID, data: { fields: { name: 'Ada' } } });
    expect(dto.assets).toHaveLength(1);
    expect(JSON.stringify(dto)).not.toContain('object_key');
    expect(JSON.stringify(dto)).not.toContain('stores/');

    const file = await pub(fileUrl, { headers: bearer(mine.accessToken) });
    expect(file.status).toBe(200);
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(tinyPng());
    // The same file through another customization the token does not cover.
    expect((await pub(czUrl(theirs.customizationId, STORE_A, ''), { headers: bearer(mine.accessToken) })).status).toBe(401);
  });

  it('answers a malformed id with 404 and never reaches the database with it', async () => {
    await seedPersonalizableProduct();
    expect((await pub(czUrl('not-a-uuid'), { headers: bearer('x') })).status).toBe(404);
  });

  it('serves a token-less caller nothing for an unknown id either (no existence oracle)', async () => {
    await seedPersonalizableProduct();
    const unknown = await pub(czUrl(crypto.randomUUID()));
    const known = await pub(czUrl((await saveCustomization()).customizationId));
    expect(unknown.status).toBe(401);
    expect(known.status).toBe(401);
  });
});

describe('updating a customization', () => {
  it('replaces the data, refreshes the inactivity window and re-issues a token', async () => {
    await seedPersonalizableProduct();
    const saved = await saveCustomization();
    await queryDb("UPDATE personalization.customizations SET expires_at = now() + interval '1 day', last_activity_at = now() - interval '29 days'");
    const res = await pub(czUrl(saved.customizationId), { method: 'PUT', headers: bearer(saved.accessToken), body: { data: { fields: { name: 'Grace' } } } });
    expect(res.status).toBe(200);
    const updated = (await json(res)).data;
    expect(updated.accessToken).toMatch(/^zbc1\./);
    const [row] = await queryDb<any>('SELECT data, expires_at, last_activity_at FROM personalization.customizations');
    expect(row.data).toEqual({ fields: { name: 'Grace' } });
    expect(Math.round((new Date(row.expires_at).getTime() - Date.now()) / 86_400_000)).toBe(30);
  });

  it('attaches new uploads (with their tokens) and releases removed ones for deletion after a grace period', async () => {
    await seedPersonalizableProduct();
    const first = await uploadCustomerImage();
    const saved = await saveCustomization({ assets: [{ assetId: first.assetId, uploadToken: first.uploadToken }] });
    const second = await uploadCustomerImage();
    const url = czUrl(saved.customizationId);

    // New asset without a token is refused, and the whole update rolls back.
    const noToken = await pub(url, { method: 'PUT', headers: bearer(saved.accessToken), body: { data: { v: 2 }, assets: [{ assetId: second.assetId }] } });
    expect(noToken.status).toBe(401);
    const [unchanged] = await queryDb<any>('SELECT data FROM personalization.customizations');
    expect(unchanged.data).toEqual({ fields: { name: 'Ada' } });

    const ok = await pub(url, { method: 'PUT', headers: bearer(saved.accessToken), body: { data: { v: 2 }, assets: [{ assetId: second.assetId, uploadToken: second.uploadToken }] } });
    expect(ok.status).toBe(200);
    const rows = await queryDb<any>('SELECT id, status, delete_after FROM personalization.customization_assets ORDER BY created_at');
    expect(rows.map((r: any) => r.status)).toEqual(['released', 'attached']);
    expect(new Date(rows[0].delete_after).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // The released file is no longer downloadable by the shopper.
    expect((await pub(czUrl(`${saved.customizationId}/assets/${first.assetId}`), { headers: bearer(saved.accessToken) })).status).toBe(404);
  });

  it('is refused once the customization is ordered', async () => {
    await seedPersonalizableProduct();
    const saved = await saveCustomization();
    await queryDb("UPDATE personalization.customizations SET status = 'ordered', ordered_at = now(), expires_at = NULL");
    const res = await pub(czUrl(saved.customizationId), { method: 'PUT', headers: bearer(saved.accessToken), body: { data: { tamper: true } } });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details.reason).toBe('customization_not_editable');
    const [row] = await queryDb<any>('SELECT data FROM personalization.customizations');
    expect(row.data).toEqual({ fields: { name: 'Ada' } });
    // Reading an ordered customization is still allowed with the token.
    expect((await pub(czUrl(saved.customizationId), { headers: bearer(saved.accessToken) })).status).toBe(200);
  });

  it('reports an expired customization as 410', async () => {
    await seedPersonalizableProduct();
    const saved = await saveCustomization();
    await queryDb("UPDATE personalization.customizations SET status = 'expired', expired_at = now(), expires_at = NULL, data = '{}'");
    expect((await pub(czUrl(saved.customizationId), { headers: bearer(saved.accessToken) })).status).toBe(410);
    expect((await pub(czUrl(saved.customizationId), { method: 'PUT', headers: bearer(saved.accessToken), body: { data: {} } })).status).toBe(410);
  });
});

describe('storefront CORS and abuse controls', () => {
  const SHOP = 'https://shop.example.com';
  async function allowShop(storeId = STORE_A) {
    const res = await call(`${ADMIN}/settings/storefront`, { method: 'PUT', storeId, body: { storefrontOrigins: [SHOP] } });
    expect(res.status).toBe(200);
  }

  it('lets only the store’s own origins write, and exposes errors to them', async () => {
    await seedPersonalizableProduct();
    await allowShop();
    const cfg = await storefrontConfig();
    const body = { productId: PRODUCT_ID, configId: cfg.configId, configVersion: cfg.version, data: {} };

    const allowed = await pub(czUrl(), { method: 'POST', origin: SHOP, body });
    expect(allowed.status).toBe(201);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(SHOP);

    const evil = await pub(czUrl(), { method: 'POST', origin: 'https://evil.example', body });
    expect(evil.status).toBe(403);
    expect((await errorOf(evil)).code).toBe('origin_not_allowed');
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    expect(await queryDb('SELECT 1 FROM personalization.customizations')).toHaveLength(1);

    // A 4xx for an allowed origin still carries CORS headers, so the storefront can read the code.
    const rejected = await pub(czUrl(), { method: 'POST', origin: SHOP, body: { ...body, productId: 'unmapped' } });
    expect(rejected.status).toBe(404);
    expect(rejected.headers.get('access-control-allow-origin')).toBe(SHOP);
  });

  it('answers preflight only for an allowed origin', async () => {
    await seedPersonalizableProduct();
    await allowShop();
    const headers = { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' };
    const ok = await pub(czUrl(crypto.randomUUID()), { method: 'OPTIONS', origin: SHOP, headers });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(SHOP);
    expect(ok.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization');
    const bad = await pub(czUrl(crypto.randomUUID()), { method: 'OPTIONS', origin: 'https://evil.example', headers });
    expect(bad.status).toBe(204);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rate-limits writes per store + client IP', async () => {
    await seedPersonalizableProduct();
    const env = { STOREFRONT_WRITE_RATE_LIMIT: '3' };
    const { createApp } = await import('../src/app');
    const application = createApp();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await pub(`${STOREFRONT}/uploads?storeId=${STORE_A}`, { method: 'POST', rawBody: tinyPng(), env, application })).status);
    }
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
  });
});

describe('merchant access', () => {
  it('lists, filters and reads customizations of the caller’s store only', async () => {
    await seedPersonalizableProduct();
    await seedPersonalizableProduct(STORE_B, PRODUCT_ID, 'cfg-b');
    const a1 = await saveCustomization();
    const a2 = await saveCustomization();
    const b1 = await saveCustomization({ storeId: STORE_B });
    await queryDb("UPDATE personalization.customizations SET status = 'ordered', ordered_at = now(), expires_at = NULL WHERE id = $1", [a1.customizationId]);

    const list = await json(await call(`${ADMIN}/customizations`));
    expect(list.data.map((c: any) => c.id).sort()).toEqual([a1.customizationId, a2.customizationId].sort());
    expect(list.data[0]).not.toHaveProperty('data');
    expect(list.meta.page).toMatchObject({ limit: 50, hasMore: false, nextCursor: null });
    const ordered = (await json(await call(`${ADMIN}/customizations?status=ordered`))).data;
    expect(ordered.map((c: any) => c.id)).toEqual([a1.customizationId]);

    // Keyset pagination.
    const page1 = await json(await call(`${ADMIN}/customizations?limit=1`));
    expect(page1.meta.page.hasMore).toBe(true);
    const page2 = await json(await call(`${ADMIN}/customizations?limit=1&cursor=${page1.meta.page.nextCursor}`));
    expect(page2.data[0].id).not.toBe(page1.data[0].id);
    expect(page2.meta.page.hasMore).toBe(false);

    // Cross-tenant: store A cannot read store B's customization, nor B's A's.
    expect((await call(`${ADMIN}/customizations/${b1.customizationId}`)).status).toBe(404);
    expect((await call(`${ADMIN}/customizations/${a1.customizationId}`, { storeId: STORE_B })).status).toBe(404);
    const detail = (await json(await call(`${ADMIN}/customizations/${a2.customizationId}`))).data;
    expect(detail.data).toEqual({ fields: { name: 'Ada' } });
  });

  it('requires authentication and streams customer files only to the owning store', async () => {
    await seedPersonalizableProduct();
    await seedPersonalizableProduct(STORE_B, PRODUCT_ID, 'cfg-b');
    const asset = await uploadCustomerImage();
    const saved = await saveCustomization({ assets: [{ assetId: asset.assetId, uploadToken: asset.uploadToken }] });
    const url = `${ADMIN}/customizations/${saved.customizationId}/assets/${asset.assetId}/content`;
    expect((await call(url, { token: null })).status).toBe(401);
    expect((await call(url, { storeId: STORE_B })).status).toBe(404);
    const ok = await call(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(tinyPng());
  });
});
