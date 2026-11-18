/**
 * The whole story, through the real app + D1 + a simulated provider, for both drivers:
 * merchant uploads and publishes, the storefront renders, a shopper uploads and saves, files are
 * retrieved by the owner (and refused to everyone else), and cleanup keeps everything referenced.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  STOREFRONT,
  STORE_A,
  STORE_B,
  applyMigrations,
  call,
  getTestD1,
  json,
  makeEnv,
  publishableDraft,
  queryDb,
  resetBucket,
  sharedBucket,
  tinyPng,
  truncateAll,
} from './helpers';
import { provider, type Driver, type Provider } from './storage-sim';
import { loadConfig } from '../src/config/environment';
import { createDatabase } from '../src/database/connection';
import { Logger } from '../src/shared/logger';
import { CleanupService } from '../src/modules/personalization/cleanup-service';
import { createObjectStorage } from '../src/storage';

beforeAll(async () => {
  await applyMigrations();
});

describe.each<Driver>(['r2', 's3'])('direct upload end to end (%s)', (driver) => {
  let p: Provider;
  beforeEach(async () => {
    await truncateAll();
    resetBucket();
    p = provider(driver, sharedBucket);
  });
  afterEach(() => p.restore());

  it.each([
    ['without a public asset host', { ASSET_PUBLIC_BASE_URL: '' }],
    ['with a public asset host', { ASSET_PUBLIC_BASE_URL: 'https://assets.example.com' }],
  ])('merchant upload -> publish -> storefront -> shopper upload -> save -> retrieval -> cleanup (%s)', async (_name, extraEnv) => {
    const env = { ...p.env, ...extraEnv };
    const png = tinyPng();
    const admin = (path: string, o: Parameters<typeof call>[1] = {}) => call(`${ADMIN}${path}`, { ...o, env: { ...env, ...o.env } });
    const shop = (path: string, o: Parameters<typeof call>[1] = {}) =>
      call(`${STOREFRONT}${path}${path.includes('?') ? '&' : '?'}storeId=${STORE_A}`, { token: null, ...o, env: { ...env, ...o.env } });

    // 1. Merchant creates a configuration.
    expect((await admin('/configs', { method: 'POST', body: { clientConfigId: 'cfg-e2e', draft: publishableDraft('cfg-e2e') } })).status).toBe(201);

    // 2-3. Merchant uploads a mockup DIRECTLY; the Worker verifies it.
    const init = (await json(await admin('/assets/upload-url', {
      method: 'POST', body: { filename: 'front.png', contentType: 'image/png', size: png.length, purpose: 'merchant-asset', configId: 'cfg-e2e' },
    }))).data;
    expect((await p.browserPut(init, png)).status).toBe(200);
    const asset = (await json(await admin('/assets/complete', { method: 'POST', body: { uploadId: init.uploadId } }))).data;
    expect(asset).toMatchObject({ status: 'stored', publicUrl: null });
    expect(p.has(asset.objectKey)).toBe(true);

    // 4. Merchant saves (the draft references the verified asset) and publishes.
    const record = (await json(await admin('/configs/cfg-e2e'))).data;
    const draft = { ...record.draft, mockups: [{ id: 'm1', name: 'Front', src: asset.deliveryUrl, placements: [] }] };
    const saved = await admin('/configs/cfg-e2e', { method: 'PUT', body: { draft, expectedUpdatedAt: record.updatedAt } });
    expect(saved.status).toBe(200);
    expect((await admin('/configs/cfg-e2e/publish', { method: 'POST' })).status).toBe(200);
    expect((await admin('/mappings', { method: 'POST', body: { configId: 'cfg-e2e', scope: 'product', externalId: 'prod-e2e' } })).status).toBe(201);

    // 5-6. Storefront loads the configuration; the public asset renders.
    const config = (await json(await shop('/products/prod-e2e/config'))).data;
    expect(config.personalizable).toBe(true);
    const src: string = config.config.mockups[0].src;
    if (extraEnv.ASSET_PUBLIC_BASE_URL) {
      expect(src).toBe(`https://assets.example.com/${asset.objectKey}`); // CDN, no Worker per image
    } else {
      expect(src).toBe(`http://api.test${STOREFRONT}/assets/${asset.assetId}`);
      const image = await call(new URL(src).pathname, { token: null, env });
      expect(image.status).toBe(200);
      expect(image.headers.get('cache-control')).toContain('public');
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    }
    // The pending object is not a published asset and is not reachable by any public route.
    expect((await shop(`/assets/${init.uploadId}`)).status).toBe(404);

    // 7-8. Shopper uploads a photo directly, then a preview and the production artwork; saves the customization.
    const files: Record<string, { uploadId: string; assetId: string }> = {};
    for (const kind of ['upload', 'preview', 'artwork'] as const) {
      const start = (await json(await shop('/uploads/url', { method: 'POST', body: { kind, contentType: 'image/png', size: png.length } }))).data;
      expect((await p.browserPut(start, png)).status).toBe(200);
      const done = await shop('/uploads/complete', { method: 'POST', body: { uploadId: start.uploadId } });
      expect(done.status).toBe(200);
      const { data } = await json(done);
      files[kind] = { uploadId: start.uploadId, assetId: data.assetId };
    }
    const created = await shop('/customizations', {
      method: 'POST',
      body: {
        productId: 'prod-e2e', configId: config.configId, configVersion: config.version, data: { fields: { name: 'Ada' } },
        assets: Object.values(files).map((f) => ({ assetId: f.assetId })),
      },
    });
    expect(created.status).toBe(201);
    const customization = (await json(created)).data;

    // 9. All three customer files are stored privately and attached.
    const rows = await queryDb<any>('SELECT id, kind, status, object_key FROM customization_assets ORDER BY kind');
    expect(rows.map((r) => [r.kind, r.status])).toEqual([['artwork', 'attached'], ['preview', 'attached'], ['upload', 'attached']]);
    for (const row of rows) {
      expect(row.object_key).toContain('/customizations/');
      expect(p.has(row.object_key)).toBe(true);
    }

    // 10. Authorized retrieval succeeds for the merchant — by presigned GET and by stream. Shoppers have no read path.
    const art = files['artwork'].assetId;
    const merchantUrl = await admin(`/customizations/${customization.customizationId}/assets/${art}/url`);
    expect(merchantUrl.status).toBe(200);
    expect((await admin(`/customizations/${customization.customizationId}/assets/${art}/content`)).status).toBe(200);

    // 11. Unauthorized retrieval fails.
    const denied = async (res: Response) => expect([401, 404, 405]).toContain(res.status);
    await denied(await shop(`/customizations/${customization.customizationId}/assets/${art}/url`));
    await denied(await shop(`/customizations/${customization.customizationId}/assets/${art}`));
    await denied(await shop(`/customizations/${customization.customizationId}`));
    await denied(await admin(`/customizations/${customization.customizationId}/assets/${art}/url`, { token: null }));
    await denied(await admin(`/customizations/${customization.customizationId}/assets/${art}/url`, { storeId: STORE_B }));
    await denied(await shop(`/assets/${art}`)); // private files never go through the public route
    expect(await queryDb('SELECT 1 FROM uploads WHERE scope = ? AND store_id = ?', ['customer', STORE_B])).toHaveLength(0);

    // 12. Cleanup (long after every URL expired) removes staging objects but keeps everything referenced.
    const cfg = loadConfig({ ...makeEnv(sharedBucket), ...env } as never);
    const outcome = await new CleanupService({
      db: createDatabase(await getTestD1()),
      storage: () => createObjectStorage({ ...makeEnv(sharedBucket), ...env } as never, cfg),
      config: cfg,
      logger: new Logger('error', { requestId: 'e2e' }),
    }).run('test', new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(outcome).toMatchObject({ errors: [], uploadsExpired: 0, assetsDeleted: 0, customizationsExpired: 0 });
    expect(outcome.uploadObjectsDeleted).toBe(4); // one staging key per upload (idempotent deletes)
    expect(p.keys('stores/' + STORE_A + '/product-personalization/pending/')).toHaveLength(0);
    expect(p.has(asset.objectKey)).toBe(true);
    for (const row of rows) expect(p.has(row.object_key)).toBe(true);
    expect((await queryDb<any>('SELECT status FROM assets'))[0].status).toBe('stored');
    expect((await queryDb<any>(`SELECT count(*) AS n FROM uploads WHERE status = 'stored' AND cleaned = 1`))[0].n).toBe(4);
  });
});
