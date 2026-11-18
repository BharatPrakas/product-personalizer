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

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await truncateAll();
  resetBucket();
});

const pub = (path: string, options: Parameters<typeof call>[1] = {}) => call(path, { token: null, ...options });
const czUrl = (id = '', storeId = STORE_A, extra = '') => `${STOREFRONT}/customizations${id ? `/${id}` : ''}?storeId=${storeId}${extra}`;
const errorOf = async (res: Response) => (await json(res)).error;

describe('private customer uploads', () => {
  it('stores the image under the private customizations prefix and and returns no token', async () => {
    await seedPersonalizableProduct();
    const asset = await uploadCustomerImage();
    expect(asset).toMatchObject({ kind: 'upload', contentType: 'image/png', width: 1, height: 1 });
    expect(asset).not.toHaveProperty('uploadToken');
    const [row] = await queryDb<any>('SELECT object_key, status, customization_id FROM customization_assets');
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
    expect((await pub(`${STOREFRONT}/assets/${asset.assetId}?sig=not-a-signature`)).status).toBe(404);
  });

  it('rejects non-images, empty bodies, oversized files and unknown stores', async () => {
    await seedPersonalizableProduct();
    const post = (body: Uint8Array, storeId = STORE_A, env = {}) =>
      pub(`${STOREFRONT}/uploads?storeId=${storeId}`, { method: 'POST', rawBody: body, env });
    expect((await post(new TextEncoder().encode('<svg onload=alert(1)>'))).status).toBe(415);
    expect((await post(new Uint8Array())).status).toBe(415);
    expect((await post(tinyPng(), STORE_A, { MAX_UPLOAD_BYTES: '10' })).status).toBe(413);
    expect((await post(tinyPng(), 'no_such_store')).status).toBe(404);
    expect(await queryDb('SELECT 1 FROM customization_assets')).toHaveLength(0);
  });

});

describe('saving a customization', () => {
  it('returns only the id, status, customized image url and expiry — not the customer’s data', async () => {
    await seedPersonalizableProduct();
    const asset = await uploadCustomerImage();
    const cfg = await storefrontConfig();
    const res = await pub(czUrl(), {
      method: 'POST',
      body: {
        productId: PRODUCT_ID, configId: cfg.configId, configVersion: cfg.version,
        data: { fields: { name: 'secret-customer-text' } },
        assets: [{ assetId: asset.assetId }],
      },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const saved = (await json(res)).data;
    expect(Object.keys(saved).sort()).toEqual(['customizationId', 'customizedImageUrl', 'expiresAt', 'status']);
    expect(JSON.stringify(saved)).not.toContain('secret-customer-text');

    const [row] = await queryDb<any>('SELECT * FROM customizations');
    expect(row).toMatchObject({ store_id: STORE_A, config_version: cfg.version, product_external_id: PRODUCT_ID, mapping_scope: 'product', status: 'saved' });
    // 30-day default inactivity window.
    const days = (new Date(row.expires_at).getTime() - new Date(row.last_activity_at).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    const [a] = await queryDb<any>('SELECT status, customization_id FROM customization_assets');
    expect(a).toMatchObject({ status: 'attached', customization_id: saved.customizationId });
  });

  it('honours the configurable retention period', async () => {
    await seedPersonalizableProduct();
    await saveCustomization({ env: { CUSTOMIZATION_RETENTION_DAYS: '7' } });
    const [row] = await queryDb<any>('SELECT expires_at, last_activity_at FROM customizations');
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
    const [row] = await queryDb<any>('SELECT config_version FROM customizations WHERE id = $1', [first.customizationId]);
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
    expect(await queryDb('SELECT 1 FROM customizations')).toHaveLength(0);
  });

  it('lets an upload be claimed only once and rejects duplicate ids and unknown files', async () => {
    await seedPersonalizableProduct();
    const asset = await uploadCustomerImage();
    const cfg = await storefrontConfig();
    const body = (assets: unknown[]) => ({ productId: PRODUCT_ID, configId: cfg.configId, configVersion: cfg.version, data: {}, assets });

    // Duplicate ids in one request.
    expect((await pub(czUrl(), { method: 'POST', body: body([{ assetId: asset.assetId }, { assetId: asset.assetId }]) })).status).toBe(422);
    // An id that names no upload.
    const unknown = await pub(czUrl(), { method: 'POST', body: body([{ assetId: crypto.randomUUID() }]) });
    expect(unknown.status).toBe(409);
    // Nothing was created by the rejected attempts.
    expect(await queryDb('SELECT 1 FROM customizations')).toHaveLength(0);

    // First use succeeds; the same upload cannot be claimed by a second customization.
    expect((await pub(czUrl(), { method: 'POST', body: body([{ assetId: asset.assetId }]) })).status).toBe(201);
    const replay = await pub(czUrl(), { method: 'POST', body: body([{ assetId: asset.assetId }]) });
    expect(replay.status).toBe(409);
    expect((await errorOf(replay)).details.reason).toBe('asset_unavailable');
    expect(await queryDb('SELECT 1 FROM customizations')).toHaveLength(1);
  });

  it('refuses an upload that belongs to another store', async () => {
    await seedPersonalizableProduct();
    await seedPersonalizableProduct(STORE_B, PRODUCT_ID, 'cfg-b');
    const foreign = await uploadCustomerImage(STORE_B);
    const cfg = await storefrontConfig();
    const res = await pub(czUrl(), { method: 'POST', body: { productId: PRODUCT_ID, configId: cfg.configId, configVersion: cfg.version, data: {}, assets: [{ assetId: foreign.assetId }] } });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details.reason).toBe('asset_unavailable');
    const [row] = await queryDb<any>('SELECT status, customization_id FROM customization_assets WHERE id = $1', [foreign.assetId]);
    expect(row).toMatchObject({ status: 'uploaded', customization_id: null });
  });
});

describe('updating a customization', () => {
  it('replaces the data and refreshes the inactivity window', async () => {
    await seedPersonalizableProduct();
    const saved = await saveCustomization();
    await queryDb('UPDATE customizations SET expires_at = $1, last_activity_at = $2', [
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date(Date.now() - 29 * 86_400_000).toISOString(),
    ]);
    const res = await pub(czUrl(saved.customizationId), { method: 'PUT', body: { data: { fields: { name: 'Grace' } } } });
    expect(res.status).toBe(200);
    const updated = (await json(res)).data;
    expect(Object.keys(updated).sort()).toEqual(['customizationId', 'customizedImageUrl', 'expiresAt', 'status']);
    const [row] = await queryDb<any>('SELECT data, expires_at, last_activity_at FROM customizations');
    expect(row.data).toEqual({ fields: { name: 'Grace' } });
    expect(Math.round((new Date(row.expires_at).getTime() - Date.now()) / 86_400_000)).toBe(30);
  });

  it('attaches new uploads and releases removed ones for deletion after a grace period', async () => {
    await seedPersonalizableProduct();
    const first = await uploadCustomerImage();
    const saved = await saveCustomization({ assets: [{ assetId: first.assetId }] });
    const second = await uploadCustomerImage();
    const url = czUrl(saved.customizationId);

    // A file that is not claimable rolls the whole update back.
    const bad = await pub(url, { method: 'PUT', body: { data: { v: 2 }, assets: [{ assetId: crypto.randomUUID() }] } });
    expect(bad.status).toBe(409);
    const [unchanged] = await queryDb<any>('SELECT data FROM customizations');
    expect(unchanged.data).toEqual({ fields: { name: 'Ada' } });

    const ok = await pub(url, { method: 'PUT', body: { data: { v: 2 }, assets: [{ assetId: second.assetId }] } });
    expect(ok.status).toBe(200);
    const rows = await queryDb<any>('SELECT id, status, delete_after FROM customization_assets ORDER BY created_at');
    expect(rows.map((r: any) => r.status)).toEqual(['released', 'attached']);
    expect(new Date(rows[0].delete_after).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it('is refused once the customization is ordered', async () => {
    await seedPersonalizableProduct();
    const saved = await saveCustomization();
    await queryDb("UPDATE customizations SET status = 'ordered', ordered_at = $1, expires_at = NULL", [new Date().toISOString()]);
    const res = await pub(czUrl(saved.customizationId), { method: 'PUT', body: { data: { tamper: true } } });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details.reason).toBe('customization_not_editable');
    const [row] = await queryDb<any>('SELECT data FROM customizations');
    expect(row.data).toEqual({ fields: { name: 'Ada' } });
  });

  it('reports an expired customization as 410', async () => {
    await seedPersonalizableProduct();
    const saved = await saveCustomization();
    await queryDb("UPDATE customizations SET status = 'expired', expired_at = $1, expires_at = NULL, data = '{}'", [new Date().toISOString()]);
    expect((await pub(czUrl(saved.customizationId), { method: 'PUT', body: { data: {} } })).status).toBe(410);
  });

  it('answers a malformed or unknown id with 404', async () => {
    await seedPersonalizableProduct();
    expect((await pub(czUrl('not-a-uuid'), { method: 'PUT', body: { data: {} } })).status).toBe(404);
    expect((await pub(czUrl(crypto.randomUUID()), { method: 'PUT', body: { data: {} } })).status).toBe(404);
  });
});

// D1 has no transaction to wrap "insert/update the customization AND claim its uploads" in — these
// tests exercise the `pending_attach_count` trigger pair in migrations/0001_baseline.sql directly,
// proving the all-or-nothing guarantee survives a PARTIAL claim shortfall (not just a 100% one, which
// the "lets a file be used only once" test above already covers) and a genuine concurrent race.
describe('attach-count guard: atomic customization + upload claim', () => {
  it('save: a partial claim shortfall rolls back the new customization entirely, not just the missing asset', async () => {
    await seedPersonalizableProduct();
    const free = await uploadCustomerImage();
    const taken = await uploadCustomerImage();
    // Make `taken` unavailable by attaching it to an unrelated, already-saved customization.
    await saveCustomization({ assets: [{ assetId: taken.assetId }] });

    const cfg = await storefrontConfig();
    const res = await pub(czUrl(), {
      method: 'POST',
      body: {
        productId: PRODUCT_ID, configId: cfg.configId, configVersion: cfg.version, data: {},
        assets: [
          { assetId: free.assetId },
          { assetId: taken.assetId },
        ],
      },
    });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details.reason).toBe('asset_unavailable');
    // Exactly the one customization from the setup step exists — the second attempt created nothing.
    expect(await queryDb('SELECT 1 FROM customizations')).toHaveLength(1);
    // The claimable asset was NOT left half-attached by the aborted batch.
    const [freeRow] = await queryDb<any>('SELECT status, customization_id FROM customization_assets WHERE id = $1', [free.assetId]);
    expect(freeRow).toMatchObject({ status: 'uploaded', customization_id: null });
  });

  it('update: a partial claim shortfall leaves the customization and its current assets untouched', async () => {
    await seedPersonalizableProduct();
    const kept = await uploadCustomerImage();
    const saved = await saveCustomization({ assets: [{ assetId: kept.assetId }] });
    const free = await uploadCustomerImage();
    const taken = await uploadCustomerImage();
    await saveCustomization({ assets: [{ assetId: taken.assetId }] });

    const res = await pub(czUrl(saved.customizationId), {
      method: 'PUT',
      body: {
        data: { v: 'should not stick' },
        assets: [
          { assetId: kept.assetId },
          { assetId: free.assetId },
          { assetId: taken.assetId },
        ],
      },
    });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details.reason).toBe('asset_unavailable');

    const [row] = await queryDb<any>('SELECT data FROM customizations WHERE id = $1', [saved.customizationId]);
    expect(row.data).toEqual({ fields: { name: 'Ada' } });
    const [keptRow] = await queryDb<any>('SELECT status, customization_id FROM customization_assets WHERE id = $1', [kept.assetId]);
    expect(keptRow).toMatchObject({ status: 'attached', customization_id: saved.customizationId });
    const [freeRow] = await queryDb<any>('SELECT status, customization_id FROM customization_assets WHERE id = $1', [free.assetId]);
    expect(freeRow).toMatchObject({ status: 'uploaded', customization_id: null });
  });

  it('serializes two saves racing for the same single upload: exactly one wins, the asset ends up attached once', async () => {
    await seedPersonalizableProduct();
    const asset = await uploadCustomerImage();
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () => saveCustomization({ assets: [{ assetId: asset.assetId }] })),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);
    expect(await queryDb('SELECT 1 FROM customizations')).toHaveLength(1);
    const [row] = await queryDb<any>('SELECT status, customization_id FROM customization_assets WHERE id = $1', [asset.assetId]);
    expect(row.status).toBe('attached');
    expect(row.customization_id).toBe((succeeded[0] as PromiseFulfilledResult<any>).value.customizationId);
  });
});

describe('storefront abuse controls', () => {
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
    await queryDb("UPDATE customizations SET status = 'ordered', ordered_at = $2, expires_at = NULL WHERE id = $1", [a1.customizationId, new Date().toISOString()]);

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
    const saved = await saveCustomization({ assets: [{ assetId: asset.assetId }] });
    const url = `${ADMIN}/customizations/${saved.customizationId}/assets/${asset.assetId}/content`;
    expect((await call(url, { token: null })).status).toBe(401);
    expect((await call(url, { storeId: STORE_B })).status).toBe(404);
    const ok = await call(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(tinyPng());
  });
});
