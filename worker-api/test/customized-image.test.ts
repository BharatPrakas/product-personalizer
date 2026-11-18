/**
 * The public, anonymous, credential-free storefront surface: the customized-image route, the wildcard
 * CORS contract, and the absence of any shopper token or shopper read path.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { InMemoryRateLimitStore } from '../src/shared/rate-limit';
import {
  ADMIN,
  STOREFRONT,
  STORE_A,
  STORE_B,
  applyMigrations,
  call,
  fetchCustomizationImage,
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
import { provider, type Provider } from './storage-sim';

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await truncateAll();
  resetBucket();
  await seedPersonalizableProduct();
});

const pub = (path: string, options: Parameters<typeof call>[1] = {}) => call(path, { token: null, ...options });
const czUrl = (id = '', storeId = STORE_A) => `${STOREFRONT}/customizations${id ? `/${id}` : ''}?storeId=${storeId}`;
const sha256Hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Upload a preview and save a customization carrying it; returns both. */
async function savedWithPreview(storeId = STORE_A) {
  const preview = await uploadCustomerImage(storeId, 'preview');
  const saved = await saveCustomization({ storeId, assets: [{ assetId: preview.assetId }] });
  return { preview, saved };
}

const imagePathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

describe('public customized image', () => {
  it('serves an attached preview anonymously with the sniffed type, immutable cache, ETag and safe headers', async () => {
    const { preview } = await savedWithPreview();
    const res = await fetchCustomizationImage(preview.assetId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    expect(res.headers.get('etag')).toBe(`"${await sha256Hex(tinyPng())}"`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.has('access-control-allow-credentials')).toBe(false);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(tinyPng());
  });

  it('serves the sniffed type even when the upload declared another one', async () => {
    const res = await pub(`${STOREFRONT}/uploads?storeId=${STORE_A}&kind=preview`, {
      method: 'POST',
      rawBody: tinyPng(),
      headers: { 'Content-Type': 'image/jpeg' },
    });
    if (res.status !== 201) {
      expect([415, 422]).toContain(res.status);
      return;
    }
    const asset = (await json(res)).data;
    await saveCustomization({ assets: [{ assetId: asset.assetId }] });
    expect((await fetchCustomizationImage(asset.assetId)).headers.get('content-type')).toBe('image/png');
  });

  it('answers If-None-Match with 304 and no body', async () => {
    const { preview } = await savedWithPreview();
    const etag = (await fetchCustomizationImage(preview.assetId)).headers.get('etag') ?? '';
    const res = await fetchCustomizationImage(preview.assetId, STORE_A, { headers: { 'If-None-Match': etag } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toBe(etag);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetchCustomizationImage(preview.assetId, STORE_A, { headers: { 'If-None-Match': '"other"' } })).status).toBe(200);
  });

  it('is 404 for another store, an unknown store, a random id and a non-UUID id', async () => {
    await seedPersonalizableProduct(STORE_B, 'zb-prod-1', 'cfg-b');
    const { preview } = await savedWithPreview();
    const missing = await fetchCustomizationImage(crypto.randomUUID());
    expect(missing.status).toBe(404);
    const wrongStore = await fetchCustomizationImage(preview.assetId, STORE_B);
    expect(wrongStore.status).toBe(404);
    const unknownStore = await fetchCustomizationImage(preview.assetId, 'store_never_seen');
    expect(unknownStore.status).toBe(404);
    expect((await fetchCustomizationImage('not-a-uuid')).status).toBe(404);
    // Unknown store and missing asset are indistinguishable from outside.
    expect((await json(unknownStore)).error.code).toBe((await json(missing)).error.code);
  });

  it('requires a store key', async () => {
    const { preview } = await savedWithPreview();
    expect((await fetchCustomizationImage(preview.assetId, null)).status).toBe(422);
  });

  it('never serves uploads or production artwork, attached or not', async () => {
    const photo = await uploadCustomerImage(STORE_A, 'upload');
    const artwork = await uploadCustomerImage(STORE_A, 'artwork');
    expect((await fetchCustomizationImage(photo.assetId)).status).toBe(404);
    expect((await fetchCustomizationImage(artwork.assetId)).status).toBe(404);
    await saveCustomization({ assets: [{ assetId: photo.assetId }, { assetId: artwork.assetId }] });
    const rows = await queryDb<any>("SELECT status FROM customization_assets WHERE status = 'attached'");
    expect(rows).toHaveLength(2);
    expect((await fetchCustomizationImage(photo.assetId)).status).toBe(404);
    expect((await fetchCustomizationImage(artwork.assetId)).status).toBe(404);
  });

  it('never serves a preview that is not attached yet', async () => {
    const preview = await uploadCustomerImage(STORE_A, 'preview');
    expect((await fetchCustomizationImage(preview.assetId)).status).toBe(404);
  });

  it('stops serving a preview once a re-save releases it', async () => {
    const { preview, saved } = await savedWithPreview();
    expect((await fetchCustomizationImage(preview.assetId)).status).toBe(200);
    const res = await pub(czUrl(saved.customizationId), { method: 'PUT', body: { data: { v: 2 }, assets: [] } });
    expect(res.status).toBe(200);
    expect((await json(res)).data.customizedImageUrl).toBeNull();
    expect((await fetchCustomizationImage(preview.assetId)).status).toBe(404);
  });

  it('answers a HEAD request like the GET without a body, and rejects other methods', async () => {
    const { preview } = await savedWithPreview();
    const head = await fetchCustomizationImage(preview.assetId, STORE_A, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await fetchCustomizationImage(preview.assetId, STORE_A, { method: 'DELETE' })).status).not.toBe(200);
  });
});

describe('customizedImageUrl in the save response', () => {
  it('is an absolute URL that actually serves the first preview in request order', async () => {
    const photo = await uploadCustomerImage(STORE_A, 'upload');
    const second = await uploadCustomerImage(STORE_A, 'preview');
    const first = await uploadCustomerImage(STORE_A, 'preview');
    const saved = await saveCustomization({ assets: [{ assetId: photo.assetId }, { assetId: first.assetId }, { assetId: second.assetId }] });
    expect(saved.customizedImageUrl).toBe(
      `http://api.test${STOREFRONT}/customization-images/${first.assetId}?storeId=${STORE_A}`,
    );
    const res = await pub(imagePathOf(saved.customizedImageUrl as string));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(tinyPng());
  });

  it('is null when no preview is included', async () => {
    expect((await saveCustomization()).customizedImageUrl).toBeNull();
    const photo = await uploadCustomerImage(STORE_A, 'upload');
    expect((await saveCustomization({ assets: [{ assetId: photo.assetId }] })).customizedImageUrl).toBeNull();
  });

  it('changes with a new preview on re-save, and the old URL then 404s', async () => {
    const { saved } = await savedWithPreview();
    const oldUrl = saved.customizedImageUrl as string;
    expect((await pub(imagePathOf(oldUrl))).status).toBe(200);

    const next = await uploadCustomerImage(STORE_A, 'preview');
    const res = await pub(czUrl(saved.customizationId), { method: 'PUT', body: { data: { v: 2 }, assets: [{ assetId: next.assetId }] } });
    expect(res.status).toBe(200);
    const body = (await json(res)).data;
    expect(body.customizedImageUrl).not.toBe(oldUrl);
    expect(body.customizedImageUrl).toContain(next.assetId);
    expect((await pub(imagePathOf(body.customizedImageUrl))).status).toBe(200);
    expect((await pub(imagePathOf(oldUrl))).status).toBe(404);
  });
});

describe('no shopper tokens and no shopper reads', () => {
  it('never includes uploadToken or accessToken in any shopper response', async () => {
    const preview = await uploadCustomerImage(STORE_A, 'preview');
    const cfg = await storefrontConfig();
    const responses = [
      await pub(`${STOREFRONT}/uploads?storeId=${STORE_A}&kind=upload`, { method: 'POST', rawBody: tinyPng(), headers: { 'Content-Type': 'image/png' } }),
      await pub(`${STOREFRONT}/uploads/url?storeId=${STORE_A}`, { method: 'POST', body: { contentType: 'image/png', size: 10, kind: 'upload' } }),
      await pub(czUrl(), { method: 'POST', body: { productId: 'zb-prod-1', configId: cfg.configId, configVersion: cfg.version, data: {}, assets: [{ assetId: preview.assetId }] } }),
      await pub(`${STOREFRONT}/products/zb-prod-1/config?storeId=${STORE_A}`),
    ];
    for (const res of responses) {
      const text = await res.text();
      expect(text).not.toContain('uploadToken');
      expect(text).not.toContain('accessToken');
    }
    expect(JSON.stringify(preview)).not.toMatch(/Token/);
  });

  it('ignores any Authorization header on shopper routes', async () => {
    const res = await pub(`${STOREFRONT}/uploads?storeId=${STORE_A}&kind=upload`, {
      method: 'POST',
      rawBody: tinyPng(),
      headers: { 'Content-Type': 'image/png', Authorization: 'Bearer garbage' },
    });
    expect(res.status).toBe(201);
  });

  it('has no shopper GET for a customization or its files', async () => {
    const { preview, saved } = await savedWithPreview();
    const id = saved.customizationId;
    for (const path of [
      czUrl(id),
      `${STOREFRONT}/customizations/${id}/assets/${preview.assetId}?storeId=${STORE_A}`,
      `${STOREFRONT}/customizations/${id}/assets/${preview.assetId}/url?storeId=${STORE_A}`,
    ]) {
      const res = await pub(path);
      expect([404, 405], path).toContain(res.status);
    }
  });

  it('no longer has merchant storefront-origin settings', async () => {
    expect([404, 405]).toContain((await call(`${ADMIN}/settings/storefront`)).status);
    expect([404, 405]).toContain((await call(`${ADMIN}/settings/storefront`, { method: 'PUT', body: { storefrontOrigins: ['https://x.example'] } })).status);
  });

  it('does not restrict by Origin: any origin may write', async () => {
    const res = await pub(`${STOREFRONT}/uploads?storeId=${STORE_A}&kind=upload`, {
      method: 'POST',
      rawBody: tinyPng(),
      headers: { 'Content-Type': 'image/png' },
      origin: 'https://anything.example',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('storefront CORS: wildcard, never credentials', () => {
  const ORIGIN = 'https://shop.example.com';

  it('answers every preflight with 204, `*` and the fixed method/header lists', async () => {
    const id = crypto.randomUUID();
    const paths = [
      `/products/p1/config?storeId=${STORE_A}`,
      `/assets/${id}`,
      `/uploads?storeId=${STORE_A}`,
      `/uploads/url?storeId=${STORE_A}`,
      `/uploads/complete?storeId=${STORE_A}`,
      `/customizations?storeId=${STORE_A}`,
      `/customizations/${id}?storeId=${STORE_A}`,
      `/customization-images/${id}?storeId=${STORE_A}`,
      `/customization-images/${id}?storeId=store_never_seen`,
    ];
    for (const path of paths) {
      const res = await pub(`${STOREFRONT}${path}`, {
        method: 'OPTIONS',
        origin: ORIGIN,
        headers: { 'Access-Control-Request-Method': 'PUT' },
      });
      expect(res.status, path).toBe(204);
      expect(res.headers.get('access-control-allow-origin'), path).toBe('*');
      expect(res.headers.get('access-control-allow-methods'), path).toBe('GET,HEAD,POST,PUT,OPTIONS');
      expect(res.headers.get('access-control-allow-headers'), path).toBe('Content-Type, If-None-Match');
      expect(res.headers.get('access-control-max-age'), path).toBe('600');
      expect(res.headers.has('access-control-allow-credentials'), path).toBe(false);
    }
  });

  it('adds `*` to success and error responses on every route, and never allows credentials', async () => {
    const { preview, saved } = await savedWithPreview();
    const cfg = await storefrontConfig();
    const base = { origin: ORIGIN };
    const responses: Array<[string, Response]> = [
      ['config 200', await pub(`${STOREFRONT}/products/zb-prod-1/config?storeId=${STORE_A}`, base)],
      ['config unknown store', await pub(`${STOREFRONT}/products/zb-prod-1/config?storeId=store_never_seen`, base)],
      ['image 200', await fetchCustomizationImage(preview.assetId, STORE_A, { headers: { Origin: ORIGIN } })],
      ['image 404', await fetchCustomizationImage(crypto.randomUUID(), STORE_A, { headers: { Origin: ORIGIN } })],
      ['image bad request', await fetchCustomizationImage(preview.assetId, null, { headers: { Origin: ORIGIN } })],
      ['image unknown store', await fetchCustomizationImage(preview.assetId, 'store_never_seen', { headers: { Origin: ORIGIN } })],
      ['legacy upload 201', await pub(`${STOREFRONT}/uploads?storeId=${STORE_A}&kind=upload`, { ...base, method: 'POST', rawBody: tinyPng(), headers: { 'Content-Type': 'image/png' } })],
      ['legacy upload 415', await pub(`${STOREFRONT}/uploads?storeId=${STORE_A}&kind=upload`, { ...base, method: 'POST', rawBody: new TextEncoder().encode('<svg/>'), headers: { 'Content-Type': 'image/svg+xml' } })],
      ['legacy upload unknown store', await pub(`${STOREFRONT}/uploads?storeId=store_never_seen`, { ...base, method: 'POST', rawBody: tinyPng() })],
      ['save 201', await pub(czUrl(), { ...base, method: 'POST', body: { productId: 'zb-prod-1', configId: cfg.configId, configVersion: cfg.version, data: {} } })],
      ['save 422', await pub(czUrl(), { ...base, method: 'POST', body: { productId: 'zb-prod-1', data: 'x' } })],
      ['update 200', await pub(czUrl(saved.customizationId), { ...base, method: 'PUT', body: { data: {} } })],
      ['update 404', await pub(czUrl(crypto.randomUUID()), { ...base, method: 'PUT', body: { data: {} } })],
      ['direct init 415', await pub(`${STOREFRONT}/uploads/url?storeId=${STORE_A}`, { ...base, method: 'POST', body: { contentType: 'text/html', size: 5, kind: 'upload' } })],
    ];
    for (const [label, res] of responses) {
      expect(res.headers.get('access-control-allow-origin'), label).toBe('*');
      expect(res.headers.has('access-control-allow-credentials'), label).toBe(false);
      expect(res.headers.get('vary') ?? '', label).not.toContain('Origin');
    }
    expect(responses.map(([, r]) => r.status)).toEqual([200, 200, 200, 404, 422, 404, 201, 415, 404, 201, 422, 200, 404, 415]);
  });

  it('rate limits preflight', async () => {
    const application = createApp({ rateLimitStore: new InMemoryRateLimitStore() });
    const env = { STOREFRONT_RATE_LIMIT: '2' };
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await pub(`${STOREFRONT}/customizations?storeId=${STORE_A}`, { method: 'OPTIONS', application, env })).status);
    }
    expect(statuses).toEqual([204, 204, 429, 429]);
  });
});

describe('abuse controls on the public surface', () => {
  it('rate limits the image route (5x the read budget) per store + IP', async () => {
    const { preview } = await savedWithPreview();
    const application = createApp({ rateLimitStore: new InMemoryRateLimitStore() });
    const env = { STOREFRONT_RATE_LIMIT: '1' };
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await fetchCustomizationImage(preview.assetId, STORE_A, { env, application })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('rate limits uploads with the write budget, with CORS on the 429', async () => {
    const application = createApp({ rateLimitStore: new InMemoryRateLimitStore() });
    const env = { STOREFRONT_WRITE_RATE_LIMIT: '2' };
    const responses: Response[] = [];
    for (let i = 0; i < 3; i++) {
      responses.push(await pub(`${STOREFRONT}/uploads?storeId=${STORE_A}&kind=upload`, { method: 'POST', rawBody: tinyPng(), headers: { 'Content-Type': 'image/png' }, application, env }));
    }
    expect(responses.map((r) => r.status)).toEqual([201, 201, 429]);
    expect(responses[2].headers.get('access-control-allow-origin')).toBe('*');
    expect(responses[2].headers.get('retry-after')).toBeTruthy();
  });

  it('rejects SVG, HTML, non-image and oversize bodies on upload, without tokens', async () => {
    const post = (body: Uint8Array, type: string, env = {}) =>
      pub(`${STOREFRONT}/uploads?storeId=${STORE_A}&kind=preview`, { method: 'POST', rawBody: body, headers: { 'Content-Type': type }, env });
    const text = (s: string) => new TextEncoder().encode(s);
    expect((await post(text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/svg+xml')).status).toBe(415);
    expect((await post(text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png')).status).toBe(415);
    expect((await post(text('<!doctype html><script>alert(1)</script>'), 'text/html')).status).toBe(415);
    expect((await post(text('<!doctype html><script>alert(1)</script>'), 'image/png')).status).toBe(415);
    expect((await post(text('plain text'), 'application/octet-stream')).status).toBe(415);
    expect((await post(tinyPng(), 'image/png', { MAX_UPLOAD_BYTES: '10' })).status).toBe(413);
    expect(await queryDb('SELECT 1 FROM customization_assets')).toHaveLength(0);
    expect(sharedBucket.objects.size).toBe(0);
  });
});

describe.each(['r2', 's3'] as const)('direct upload rejections without a token (%s)', (driver) => {
  let p: Provider;
  beforeEach(() => {
    p = provider(driver, sharedBucket);
  });
  afterEach(() => p.restore());

  const shop = (path: string, options: Parameters<typeof call>[1] = {}) =>
    call(`${STOREFRONT}${path}?storeId=${STORE_A}`, { token: null, ...options, env: { ...p.env, ...options.env } });

  it('declares SVG, HTML and oversize files 415/413 up front', async () => {
    for (const contentType of ['image/svg+xml', 'text/html', 'application/pdf']) {
      expect((await shop('/uploads/url', { method: 'POST', body: { contentType, size: 100, kind: 'preview' } })).status, contentType).toBe(415);
    }
    expect((await shop('/uploads/url', { method: 'POST', body: { contentType: 'image/png', size: 11, kind: 'preview' }, env: { MAX_UPLOAD_BYTES: '10' } })).status).toBe(413);
  });

  it.each([
    ['SVG', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['HTML', '<!doctype html><html><script>alert(1)</script></html>'],
  ])('rejects %s bytes smuggled as a PNG when confirming, and stores nothing', async (_label, markup) => {
    const bytes = new TextEncoder().encode(markup);
    const res = await shop('/uploads/url', { method: 'POST', body: { contentType: 'image/png', size: bytes.length, kind: 'preview' } });
    expect(res.status).toBe(201);
    const init = (await json(res)).data;
    expect((await p.browserPut(init, bytes)).status).toBe(200);
    const done = await shop('/uploads/complete', { method: 'POST', body: { uploadId: init.uploadId } });
    expect(done.status).toBe(422);
    expect(await queryDb('SELECT 1 FROM customization_assets')).toHaveLength(0);
    expect((await fetchCustomizationImage(init.assetId)).status).toBe(404);
  });

  it('serves a confirmed direct-uploaded preview publicly once attached, and only then', async () => {
    const png = tinyPng();
    const res = await shop('/uploads/url', { method: 'POST', body: { contentType: 'image/png', size: png.length, kind: 'preview' } });
    const init = (await json(res)).data;
    await p.browserPut(init, png);
    const done = await shop('/uploads/complete', { method: 'POST', body: { uploadId: init.uploadId } });
    expect(done.status).toBe(200);
    expect((await fetchCustomizationImage(init.assetId, STORE_A, { env: p.env })).status).toBe(404);
    const saved = await saveCustomization({ env: p.env, assets: [{ assetId: init.assetId }] });
    expect(saved.customizedImageUrl).toContain(init.assetId);
    const img = await fetchCustomizationImage(init.assetId, STORE_A, { env: p.env });
    expect(img.status).toBe(200);
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(png);
  });
});

describe('CORS on errors of the config and asset routes', () => {
  it.each([
    ['config for an invalid store key', `${STOREFRONT}/products/p1/config?storeId=%20`],
    ['an unknown published asset', `${STOREFRONT}/assets/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`],
  ])('%s carries Access-Control-Allow-Origin: *', async (_n, url) => {
    const res = await call(url, { token: null });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
