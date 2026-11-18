/**
 * Direct browser-to-storage uploads, end to end through the real Hono app, a real (Miniflare) D1 and a
 * simulated provider — run against BOTH drivers. The "browser" step is `provider.browserPut`, which
 * talks to the simulated R2 / S3 endpoint exactly as a browser would and verifies the presigned
 * signature the way the provider does; the Worker is never in the byte path (asserted below).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  saveCustomization,
  seedDraft,
  seedPersonalizableProduct,
  sharedBucket,
  tinyFont,
  tinyPng,
  truncateAll,
} from './helpers';
import { provider, type Driver, type Provider } from './storage-sim';
import { loadConfig } from '../src/config/environment';

beforeAll(async () => {
  await applyMigrations();
});

const sha256Hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A PNG of a chosen total length (valid signature + IHDR, padded) — only the sniffed header matters. */
function pngOfLength(length: number): Uint8Array {
  const base = tinyPng();
  const out = new Uint8Array(Math.max(length, base.length));
  out.set(base);
  return out;
}

describe.each<Driver>(['r2', 's3'])('direct uploads — merchant (%s)', (driver) => {
  let p: Provider;
  let png: Uint8Array;

  beforeEach(async () => {
    await truncateAll();
    resetBucket();
    p = provider(driver, sharedBucket);
    png = tinyPng();
  });
  afterEach(() => p.restore());

  const admin = (path: string, options: Parameters<typeof call>[1] = {}) =>
    call(`${ADMIN}${path}`, { ...options, env: { ...p.env, ...options.env } });

  const initiate = (body: Record<string, unknown> = {}, options: Parameters<typeof call>[1] = {}) =>
    admin('/assets/upload-url', {
      method: 'POST',
      body: { filename: 'mockup.png', contentType: 'image/png', size: png.length, purpose: 'merchant-asset', ...body },
      ...options,
    });
  const complete = (uploadId: string, options: Parameters<typeof call>[1] = {}) =>
    admin('/assets/complete', { method: 'POST', body: { uploadId }, ...options });

  /** initiate -> browser PUT, returning the initiation data. */
  async function stage(body: Record<string, unknown> = {}, bytes: Uint8Array = png) {
    const res = await initiate({ size: bytes.length, ...body });
    expect(res.status).toBe(201);
    const init = (await json(res)).data;
    const put = await p.browserPut(init, bytes);
    expect(put.status).toBe(200);
    return init;
  }

  describe('initiation', () => {
    it('returns a presigned PUT for ONE staging object and stores nothing yet', async () => {
      const res = await initiate();
      expect(res.status).toBe(201);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const { data } = await json(res);
      expect(data).toMatchObject({ method: 'PUT', status: 'pending', expiresIn: 300, headers: { 'Content-Type': 'image/png' } });
      expect(data.uploadId).toMatch(/^[0-9a-f-]{36}$/);
      expect(data.assetId).toMatch(/^[0-9a-f-]{36}$/);

      const url = new URL(data.uploadUrl);
      const key = `stores/${STORE_A}/product-personalization/pending/${data.uploadId}`;
      expect(decodeURIComponent(url.pathname)).toMatch(new RegExp(`${key}$`));
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
      expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      // R2 presigns against its S3 endpoint — never a public/custom domain.
      if (driver === 'r2') expect(url.host).toMatch(/^[0-9a-f]+\.r2\.cloudflarestorage\.com$/);
      else expect(url.host).toBe('zb-plugins-test.s3.us-west-2.amazonaws.com');
      // No secret material in what the browser receives.
      const wire = JSON.stringify(data);
      expect(wire).not.toContain('secret');
      expect(wire).not.toContain(driver === 'r2' ? 'r2-test-secret' : 's3-test-secret');
      expect(p.keys()).toHaveLength(0);

      const [row] = await queryDb<any>('SELECT * FROM uploads');
      expect(row).toMatchObject({
        id: data.uploadId, asset_id: data.assetId, store_id: STORE_A, scope: 'merchant',
        purpose: 'merchant-asset', status: 'pending', expected_content_type: 'image/png',
        expected_size: png.length, storage_provider: driver,
      });
      expect(row.pending_key).toBe(key);
      expect(await queryDb('SELECT 1 FROM assets')).toHaveLength(0);
    });

    it('requires authentication and derives the store from the token, never the body', async () => {
      expect((await initiate({}, { token: null })).status).toBe(401);
      expect((await initiate({}, { token: 'wrong' })).status).toBe(401);
      // A client-supplied store id is ignored.
      const res = await initiate({ storeId: STORE_B, store_id: STORE_B });
      expect(res.status).toBe(201);
      expect((await queryDb<any>('SELECT store_id FROM uploads'))[0].store_id).toBe(STORE_A);
      const key = (await queryDb<any>('SELECT pending_key FROM uploads'))[0].pending_key;
      expect(key.startsWith(`stores/${STORE_A}/`)).toBe(true);
    });

    it('rejects unsupported types, empty / oversized files and bad checksums', async () => {
      expect((await initiate({ contentType: 'image/gif' })).status).toBe(415);
      expect((await initiate({ contentType: 'image/svg+xml' })).status).toBe(415);
      expect((await initiate({ contentType: 'text/html' })).status).toBe(415);
      expect((await initiate({ size: 0 })).status).toBe(422);
      expect((await initiate({ size: 1.5 })).status).toBe(422);
      expect((await initiate({ size: 11 }, { env: { MAX_UPLOAD_BYTES: '10' } })).status).toBe(413);
      expect((await initiate({ sha256: 'not-hex' })).status).toBe(422);
      expect(await queryDb('SELECT 1 FROM uploads')).toHaveLength(0);
    });

    it('caps how many unconfirmed uploads one store can hold open', async () => {
      const env = { MAX_OPEN_UPLOADS_PER_STORE: '2' };
      expect((await initiate({}, { env })).status).toBe(201);
      expect((await initiate({}, { env })).status).toBe(201);
      const third = await initiate({}, { env });
      expect(third.status).toBe(429);
      expect((await json(third)).error.code).toBe('too_many_open_uploads');
      // Another tenant is unaffected.
      expect((await initiate({}, { env, storeId: STORE_B })).status).toBe(201);
    });

    it('answers 503 (and holds no slot) when direct uploads are not configured', async () => {
      const res = await initiate({}, {
        env: driver === 'r2' ? { R2_ACCESS_KEY_ID: undefined, R2_SECRET_ACCESS_KEY: undefined } : { AWS_SECRET_ACCESS_KEY: 'x', S3_ENDPOINT: 'http://127.0.0.1:1' },
      });
      if (driver === 'r2') {
        expect(res.status).toBe(503);
        expect((await json(res)).error.code).toBe('direct_upload_not_configured');
        expect((await queryDb<any>('SELECT status, cleaned FROM uploads'))[0]).toMatchObject({ status: 'failed', cleaned: 1 });
      } else {
        expect(res.status).toBe(201); // S3 presigning needs no extra settings beyond the adapter's own
      }
    });
  });

  describe('browser upload and confirmation', () => {
    it('stores the verified file under its permanent assets/ key, promoted from staging', async () => {
      const init = await stage({ clientRef: 'idb:abc' });
      // Bytes went browser -> provider; the Worker holds nothing and the permanent key does not exist yet.
      expect(p.has(`stores/${STORE_A}/product-personalization/pending/${init.uploadId}`)).toBe(true);
      expect(p.keys(`stores/${STORE_A}/product-personalization/assets/`)).toHaveLength(0);

      const res = await complete(init.uploadId);
      expect(res.status).toBe(200);
      const { data } = await json(res);
      expect(data).toMatchObject({
        assetId: init.assetId, id: init.assetId, uploadId: init.uploadId, status: 'stored',
        contentType: 'image/png', size: png.length, sizeBytes: png.length, width: 1, height: 1, publicUrl: null,
      });
      expect(data.objectKey).toMatch(new RegExp(`^stores/${STORE_A}/product-personalization/assets/[0-9a-f-]{36}\\.png$`));
      expect(data.checksumSha256).toBe(await sha256Hex(png));

      expect(p.bytes(data.objectKey)).toEqual(png);
      expect(p.contentType(data.objectKey)).toBe('image/png');
      // Staging object removed; the upload record is final.
      expect(p.has(`stores/${STORE_A}/product-personalization/pending/${init.uploadId}`)).toBe(false);
      const [row] = await queryDb<any>('SELECT * FROM uploads');
      expect(row).toMatchObject({ status: 'stored', final_key: data.objectKey, verified_content_type: 'image/png', actual_size: png.length });
      const [asset] = await queryDb<any>('SELECT * FROM assets');
      expect(asset).toMatchObject({ id: init.assetId, object_key: data.objectKey, status: 'stored', client_ref: 'idb:abc' });
    });

    it('serves the stored asset through the existing signed delivery URL', async () => {
      const init = await stage();
      const { data } = await json(await complete(init.uploadId));
      const res = await call(new URL(data.deliveryUrl).pathname + new URL(data.deliveryUrl).search, { token: null, env: p.env });
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
      // Without the signature the draft asset is not served.
      expect((await call(`/api/v1/storefront/personalization/assets/${data.assetId}`, { token: null, env: p.env })).status).toBe(404);
    });

    it('tells the client the file is not there yet, and succeeds once it is', async () => {
      const res0 = await initiate();
      const init = (await json(res0)).data;
      const early = await complete(init.uploadId);
      expect(early.status).toBe(409);
      expect((await json(early)).error.code).toBe('upload_missing');
      expect((await queryDb<any>('SELECT status FROM uploads'))[0].status).toBe('pending');

      expect((await p.browserPut(init, png)).status).toBe(200);
      expect((await complete(init.uploadId)).status).toBe(200);
    });

    it('is idempotent: repeating a successful completion returns the same asset and creates no second', async () => {
      const init = await stage();
      const first = (await json(await complete(init.uploadId))).data;
      const second = await complete(init.uploadId);
      expect(second.status).toBe(200);
      expect((await json(second)).data).toMatchObject({ assetId: first.assetId, objectKey: first.objectKey, status: 'stored' });
      expect(await queryDb('SELECT 1 FROM assets')).toHaveLength(1);
      expect(p.keys(`stores/${STORE_A}/product-personalization/assets/`)).toHaveLength(1);
    });

    it('handles concurrent completions: exactly one asset, every caller gets a consistent answer', async () => {
      const init = await stage();
      const results = await Promise.all([1, 2, 3, 4].map(() => complete(init.uploadId)));
      const bodies = await Promise.all(results.map(async (r) => ({ status: r.status, body: await json(r) })));
      for (const { status, body } of bodies) {
        expect([200, 409]).toContain(status);
        if (status === 409) expect(body.error.code).toBe('upload_in_progress');
      }
      expect(bodies.some((b) => b.status === 200)).toBe(true);
      expect(await queryDb('SELECT 1 FROM assets')).toHaveLength(1);
      expect(p.keys(`stores/${STORE_A}/product-personalization/assets/`)).toHaveLength(1);
      // Afterwards every call agrees.
      const after = await json(await complete(init.uploadId));
      expect(after.data.assetId).toBe(init.assetId);
    });

    it('rejects a file whose size differs from the declaration and removes the staged bytes', async () => {
      const init = (await json(await initiate())).data;
      await p.browserPut(init, pngOfLength(png.length + 40));
      const res = await complete(init.uploadId);
      expect(res.status).toBe(422);
      expect((await json(res)).error).toMatchObject({ code: 'upload_rejected', details: { reason: 'size_mismatch' } });
      expect((await queryDb<any>('SELECT status, failure_reason FROM uploads'))[0]).toMatchObject({ status: 'failed', failure_reason: 'size_mismatch' });
      expect(p.has(`stores/${STORE_A}/product-personalization/pending/${init.uploadId}`)).toBe(false);
      expect(await queryDb('SELECT 1 FROM assets')).toHaveLength(0);
      // Failure is terminal and stable.
      expect((await complete(init.uploadId)).status).toBe(422);
    });

    it('rejects content that is not what was declared (MIME spoofing)', async () => {
      // Declared PNG, bytes are HTML.
      const html = new TextEncoder().encode('<html><script>alert(1)</script></html>'.padEnd(png.length, ' '));
      const a = await stage({ size: html.length }, html);
      const resA = await complete(a.uploadId);
      expect(resA.status).toBe(422);
      expect((await json(resA)).error.details.reason).toBe('invalid_content');

      // Declared JPEG, bytes are a real PNG.
      const b = await stage({ contentType: 'image/jpeg' });
      const resB = await complete(b.uploadId);
      expect(resB.status).toBe(422);
      expect((await json(resB)).error.details.reason).toBe('content_type_mismatch');

      // An image declared as a generic blob is not accepted as a font.
      const c = await stage({ contentType: 'application/octet-stream' });
      expect((await complete(c.uploadId)).status).toBe(422);
      expect(await queryDb('SELECT 1 FROM assets')).toHaveLength(0);
    });

    it('verifies a client-supplied SHA-256', async () => {
      const good = await stage({ sha256: await sha256Hex(png) });
      expect((await complete(good.uploadId)).status).toBe(200);
      const bad = await stage({ sha256: '0'.repeat(64) });
      const res = await complete(bad.uploadId);
      expect(res.status).toBe(422);
      expect((await json(res)).error.details.reason).toBe('checksum_mismatch');
    });

    it('rejects absurd image dimensions', async () => {
      const huge = new Uint8Array(png);
      // IHDR width/height live at bytes 16..23 (big endian): 60000 x 60000 px.
      new DataView(huge.buffer).setUint32(16, 60000);
      new DataView(huge.buffer).setUint32(20, 60000);
      const init = await stage({}, huge);
      const res = await complete(init.uploadId);
      expect(res.status).toBe(422);
      expect((await json(res)).error.details.reason).toBe('image_dimensions');
    });

    it('accepts fonts, deriving the key extension from the bytes', async () => {
      const font = tinyFont('woff2');
      const init = await stage({ contentType: 'font/woff2', filename: 'Brand.woff2' }, font);
      const { data } = await json(await complete(init.uploadId));
      expect(data).toMatchObject({ contentType: 'font/woff2', width: null, height: null });
      expect(data.objectKey.endsWith('.woff2')).toBe(true);
      // Same through a generic type: the bytes decide.
      const generic = await stage({ contentType: 'application/octet-stream' }, tinyFont('ttf'));
      expect((await json(await complete(generic.uploadId))).data.contentType).toBe('font/ttf');
    });

    it('keeps the upload retryable when the provider is briefly unavailable', async () => {
      const init = await stage();
      p.injectReadOutage();
      const res = await complete(init.uploadId);
      expect(res.status).toBe(503);
      expect((await json(res)).error.code).toBe('storage_unavailable');
      // The claim was handed back, not burned: the very next attempt succeeds.
      expect((await queryDb<any>('SELECT status FROM uploads'))[0].status).toBe('uploaded');
      expect((await complete(init.uploadId)).status).toBe(200);
    });
  });

  describe('presigned URL scope', () => {
    it('rejects a PUT whose Content-Type differs from the signed one', async () => {
      const init = (await json(await initiate())).data;
      const res = await p.browserPut(init, png, { headers: { 'Content-Type': 'text/html' } });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('SignatureDoesNotMatch');
      expect(p.keys()).toHaveLength(0);
    });

    it('rejects a PUT after the URL has expired', async () => {
      const init = (await json(await initiate())).data;
      const res = await p.browserPut(init, png, { now: new Date(Date.now() + 6 * 60 * 1000) });
      expect(res.status).toBe(403);
      expect(p.keys()).toHaveLength(0);
    });

    it('cannot be redirected at another key: tampering with the path breaks the signature', async () => {
      const init = (await json(await initiate())).data;
      const url = new URL(init.uploadUrl);
      url.pathname = url.pathname.replace(/pending\/[0-9a-f-]+$/, `assets/${crypto.randomUUID()}.png`);
      const res = await p.browserPut({ ...init, uploadUrl: url.toString() }, png);
      expect(res.status).toBe(403);
    });

    it('never targets a permanent key, so a replayed URL cannot alter a stored asset', async () => {
      const init = await stage();
      const { data } = await json(await complete(init.uploadId));
      // Replay the old URL with different bytes: it can only recreate the throw-away staging object.
      await p.browserPut(init, new Uint8Array(png.length).fill(1));
      expect(p.bytes(data.objectKey)).toEqual(png);
      expect((await queryDb<any>('SELECT checksum_sha256 FROM assets'))[0].checksum_sha256).toBe(await sha256Hex(png));
    });
  });

  describe('retry and idempotency', () => {
    it('re-uses one upload (and its asset id) for a retried initiation with the same client ref', async () => {
      const a = (await json(await initiate({ clientRef: 'idb:1' }))).data;
      const b = (await json(await initiate({ clientRef: 'idb:1' }))).data;
      expect(b.uploadId).toBe(a.uploadId);
      expect(b.assetId).toBe(a.assetId);
      expect(await queryDb('SELECT 1 FROM uploads')).toHaveLength(1);
    });

    it('renews the URL of an open upload by id, but not for another tenant or a different file', async () => {
      const a = (await json(await initiate())).data;
      const renewed = await initiate({ uploadId: a.uploadId });
      expect(renewed.status).toBe(201);
      expect((await json(renewed)).data).toMatchObject({ uploadId: a.uploadId, assetId: a.assetId });
      expect((await initiate({ uploadId: a.uploadId, size: png.length + 1 })).status).toBe(409);
      // Another tenant naming A's upload id just starts its own, separate upload: it never touches A's.
      const other = await initiate({ uploadId: a.uploadId }, { storeId: STORE_B });
      expect(other.status).toBe(201);
      expect((await json(other)).data.uploadId).not.toBe(a.uploadId);
      expect(await queryDb('SELECT 1 FROM uploads WHERE store_id = ?', [STORE_B])).toHaveLength(1);
    });

    it('answers a finished client ref with the stored asset and no new URL', async () => {
      const init = await stage({ clientRef: 'idb:done' });
      await complete(init.uploadId);
      const again = await initiate({ clientRef: 'idb:done' });
      expect(again.status).toBe(200);
      const { data } = await json(again);
      expect(data).toMatchObject({ status: 'stored', uploadUrl: null, assetId: init.assetId });
      expect(data.asset).toMatchObject({ assetId: init.assetId, status: 'stored' });
      expect(await queryDb('SELECT 1 FROM uploads')).toHaveLength(1);
    });

    it('recovers a completion that died after promotion: the retry promotes to the SAME key', async () => {
      const init = await stage();
      const [claimed] = await queryDb<any>('SELECT id FROM uploads');
      // Simulate the crash: claimed long ago, final key chosen and the copy made, DB batch never ran.
      const finalKey = `stores/${STORE_A}/product-personalization/assets/${crypto.randomUUID()}.png`;
      await queryDb(
        `UPDATE uploads SET status = 'verifying', final_key = ?, updated_at = ? WHERE id = ?`,
        [finalKey, new Date(Date.now() - 2 * 3600 * 1000).toISOString(), claimed.id],
      );
      p.write(finalKey, png, 'image/png');
      const res = await complete(init.uploadId);
      expect(res.status).toBe(200);
      expect((await json(res)).data.objectKey).toBe(finalKey);
      expect(p.keys(`stores/${STORE_A}/product-personalization/assets/`)).toEqual([finalKey]);
    });

    it('does not take over a fresh in-flight claim', async () => {
      const init = await stage();
      await queryDb(`UPDATE uploads SET status = 'verifying', updated_at = ? WHERE id = ?`, [new Date().toISOString(), init.uploadId]);
      const res = await complete(init.uploadId);
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe('upload_in_progress');
    });
  });

  describe('tenant isolation', () => {
    it('hides another tenant’s upload on completion', async () => {
      const init = await stage();
      const res = await complete(init.uploadId, { storeId: STORE_B });
      expect(res.status).toBe(404);
      expect((await queryDb<any>('SELECT status FROM uploads'))[0].status).toBe('pending');
      expect(await queryDb('SELECT 1 FROM assets')).toHaveLength(0);
    });

    it('never lets a customer upload id be completed through the merchant API', async () => {
      await seedPersonalizableProduct();
      const c = await json(await call(`${STOREFRONT}/uploads/url?storeId=${STORE_A}`, {
        method: 'POST', token: null, env: p.env, body: { contentType: 'image/png', size: png.length, kind: 'upload' },
      }));
      expect((await complete(c.data.uploadId)).status).toBe(404);
    });
  });

  describe('configurations only reference verified uploads', () => {
    const draftWith = (id: string, assetId: string) =>
      publishableDraft(id) && {
        ...publishableDraft(id),
        mockups: [{ id: 'm1', name: 'Front', src: `http://api.test${STOREFRONT.replace('/api/v1', '/api/v1')}/assets/${assetId}`, placements: [] }],
      };

    it('refuses to save a draft naming a pending upload, then allows it once confirmed', async () => {
      await seedDraft('cfg-u1', STORE_A, publishableDraft('cfg-u1'), p.env);
      const [cfg] = await queryDb<any>(`SELECT updated_at_ms FROM configs WHERE client_config_id = 'cfg-u1'`);
      const init = (await json(await initiate({ configId: 'cfg-u1' }))).data;
      const save = () =>
        admin('/configs/cfg-u1', { method: 'PUT', body: { draft: draftWith('cfg-u1', init.assetId), expectedUpdatedAt: Number(cfg.updated_at_ms) } });
      const blocked = await save();
      expect(blocked.status).toBe(422);
      expect((await json(blocked)).error.details.issues[0]).toMatchObject({ code: 'upload_unverified' });

      await p.browserPut(init, png);
      expect((await complete(init.uploadId)).status).toBe(200);
      expect((await save()).status).toBe(200);
    });

    it('a failed upload can never be referenced either', async () => {
      await seedDraft('cfg-u2', STORE_A, publishableDraft('cfg-u2'), p.env);
      const [cfg] = await queryDb<any>(`SELECT updated_at_ms FROM configs WHERE client_config_id = 'cfg-u2'`);
      const init = (await json(await initiate())).data;
      await p.browserPut(init, pngOfLength(png.length + 5));
      expect((await complete(init.uploadId)).status).toBe(422);
      const res = await admin('/configs/cfg-u2', {
        method: 'PUT', body: { draft: draftWith('cfg-u2', init.assetId), expectedUpdatedAt: Number(cfg.updated_at_ms) },
      });
      expect(res.status).toBe(422);
    });
  });

  describe('private reads', () => {
    it('hands out a short-lived presigned GET for an owned asset, and only to its owner', async () => {
      const init = await stage();
      await complete(init.uploadId);
      const res = await admin(`/assets/${init.assetId}/url`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const { data } = await json(res);
      expect(data).toMatchObject({ method: 'GET', expiresIn: 60 });
      expect(new URL(data.url).searchParams.get('X-Amz-Expires')).toBe('60');
      const got = await p.browserGet(data.url);
      expect(got.status).toBe(200);
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);
      // Expired.
      expect((await p.browserGet(data.url, { now: new Date(Date.now() + 120_000) })).status).toBe(403);
      // Not stored anywhere.
      expect(JSON.stringify(await queryDb('SELECT * FROM assets'))).not.toContain('X-Amz-Signature');
      expect(JSON.stringify(await queryDb('SELECT * FROM uploads'))).not.toContain('X-Amz-Signature');

      expect((await admin(`/assets/${init.assetId}/url`, { token: null })).status).toBe(401);
      expect((await admin(`/assets/${init.assetId}/url`, { storeId: STORE_B })).status).toBe(404);
    });

    it('keeps the legacy proxied upload working, and lets operators switch it off', async () => {
      const legacy = await admin('/assets?filename=x.png', { method: 'POST', rawBody: png, headers: { 'Content-Type': 'image/png' } });
      expect(legacy.status).toBe(201);
      const off = await admin('/assets?filename=x.png', {
        method: 'POST', rawBody: png, headers: { 'Content-Type': 'image/png' }, env: { LEGACY_PROXY_UPLOADS: 'false' },
      });
      expect(off.status).toBe(410);
    });
  });
});

describe.each<Driver>(['r2', 's3'])('direct uploads — shopper (%s)', (driver) => {
  let p: Provider;
  let png: Uint8Array;

  beforeEach(async () => {
    await truncateAll();
    resetBucket();
    p = provider(driver, sharedBucket);
    png = tinyPng();
    await seedPersonalizableProduct(STORE_A, 'zb-prod-1', 'cfg-cz1');
  });
  afterEach(() => p.restore());

  const shop = (path: string, options: Parameters<typeof call>[1] = {}, storeId = STORE_A) =>
    call(`${STOREFRONT}${path}${path.includes('?') ? '&' : '?'}storeId=${storeId}`, {
      token: null,
      ...options,
      env: { ...p.env, ...options.env },
    });
  const initiate = (body: Record<string, unknown> = {}, options: Parameters<typeof call>[1] = {}) =>
    shop('/uploads/url', { method: 'POST', body: { contentType: 'image/png', size: png.length, kind: 'upload', ...body }, ...options });
  const complete = (uploadId: string, options: Parameters<typeof call>[1] = {}) =>
    shop('/uploads/complete', { method: 'POST', body: { uploadId }, ...options });

  async function stage(body: Record<string, unknown> = {}, bytes: Uint8Array = png) {
    const res = await initiate({ size: bytes.length, ...body });
    expect(res.status).toBe(201);
    const init = (await json(res)).data;
    expect((await p.browserPut(init, bytes)).status).toBe(200);
    return init;
  }

  it('uploads straight to private storage and confirms it — no merchant login and no token', async () => {
    const res = await initiate();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const init = (await json(res)).data;
    expect(init).toMatchObject({ method: 'PUT', expiresIn: 300, headers: { 'Content-Type': 'image/png' } });
    expect(init).not.toHaveProperty('uploadToken');
    expect(init).not.toHaveProperty('objectKey');
    await p.browserPut(init, png);

    const done = await complete(init.uploadId);
    expect(done.status).toBe(200);
    const { data } = await json(done);
    expect(data).toMatchObject({ assetId: init.assetId, kind: 'upload', contentType: 'image/png', width: 1, height: 1 });
    expect(data).not.toHaveProperty('uploadToken');
    expect(Object.keys(data).sort()).toEqual(['assetId', 'contentType', 'height', 'kind', 'sizeBytes', 'width']);
    expect(JSON.stringify(data)).not.toContain('stores/'); // the key never reaches the shopper
    const [row] = await queryDb<any>('SELECT * FROM customization_assets');
    expect(row).toMatchObject({ id: init.assetId, status: 'uploaded', customization_id: null, kind: 'upload' });
    expect(row.object_key.startsWith(`stores/${STORE_A}/product-personalization/customizations/`)).toBe(true);
    expect(p.has(row.object_key)).toBe(true);
    expect(p.keys(`stores/${STORE_A}/product-personalization/pending/${init.uploadId}`)).toHaveLength(0);
  });

  it('confirms nothing for an unknown upload id', async () => {
    const a = await stage();
    expect((await complete(crypto.randomUUID())).status).toBe(404);
    expect(await queryDb('SELECT 1 FROM customization_assets')).toHaveLength(0);
    expect((await complete(a.uploadId)).status).toBe(200);
  });

  it('cannot confirm another store’s upload, and unknown stores get a 404', async () => {
    const a = await stage();
    expect((await complete(a.uploadId)).status).toBe(200);
    const other = await stage();
    expect((await shop('/uploads/complete', {
      method: 'POST', body: { uploadId: other.uploadId },
    }, STORE_B)).status).toBe(404);
    expect((await initiate({}, {})).status).toBe(201);
    expect((await shop('/uploads/url', { method: 'POST', body: { contentType: 'image/png', size: 5 } }, 'no_such_store')).status).toBe(404);
  });

  it('validates what it will accept: images only and size limits', async () => {
    expect((await initiate({ contentType: 'font/woff2' })).status).toBe(415);
    expect((await initiate({ contentType: 'application/octet-stream' })).status).toBe(415);
    expect((await initiate({ size: 11 }, { env: { MAX_UPLOAD_BYTES: '10' } })).status).toBe(413);
    expect((await initiate({ kind: 'avatar' })).status).toBe(422);
    expect(await queryDb('SELECT 1 FROM uploads')).toHaveLength(0);
  });

  it('rejects spoofed content on confirmation', async () => {
    const text = new TextEncoder().encode('GIF89a-not-an-image'.padEnd(png.length, ' '));
    const init = await stage({}, text);
    const res = await complete(init.uploadId);
    expect(res.status).toBe(422);
    expect((await json(res)).error.details.reason).toBe('invalid_content');
    expect(await queryDb('SELECT 1 FROM customization_assets')).toHaveLength(0);
  });

  it('is idempotent and renewable', async () => {
    const init = await stage();
    const first = (await json(await complete(init.uploadId))).data;
    const second = (await json(await complete(init.uploadId))).data;
    expect(second.assetId).toBe(first.assetId);
    expect(await queryDb('SELECT 1 FROM customization_assets')).toHaveLength(1);

    const open = (await json(await initiate())).data;
    const renewed = await initiate({ uploadId: open.uploadId });
    expect(renewed.status).toBe(201);
    expect((await json(renewed)).data.assetId).toBe(open.assetId);
  });

  it('attaches only verified uploads when the customization is saved, atomically', async () => {
    const verified = await stage();
    await complete(verified.uploadId);
    const unverified = (await json(await initiate())).data; // URL issued, never uploaded or confirmed

    // A save naming an unverified upload fails and commits NOTHING (no customization, no half-attached files).
    await expect(
      saveCustomization({
        env: p.env,
        assets: [
          { assetId: verified.assetId },
          { assetId: unverified.assetId },
        ],
      }),
    ).rejects.toThrow(/409/);
    expect(await queryDb('SELECT 1 FROM customizations')).toHaveLength(0);
    expect((await queryDb<any>('SELECT status FROM customization_assets'))[0].status).toBe('uploaded');
    expect((await queryDb<any>('SELECT pending_attach_count FROM customizations')).length).toBe(0);

    const saved = await saveCustomization({ env: p.env, assets: [{ assetId: verified.assetId }] });
    expect(saved.customizationId).toBeTruthy();
    expect((await queryDb<any>('SELECT status, customization_id FROM customization_assets'))[0]).toMatchObject({
      status: 'attached', customization_id: saved.customizationId,
    });
  });

  it('stores previews and production artwork the same way, privately', async () => {
    const preview = await stage({ kind: 'preview' });
    const artwork = await stage({ kind: 'artwork' });
    await complete(preview.uploadId);
    await complete(artwork.uploadId);
    const rows = await queryDb<any>('SELECT kind, object_key FROM customization_assets ORDER BY kind');
    expect(rows.map((r) => r.kind)).toEqual(['artwork', 'preview']);
    for (const row of rows) {
      expect(row.object_key).toContain('/customizations/');
      expect(p.has(row.object_key)).toBe(true);
    }
    // Neither is reachable through the public asset route.
    for (const id of [preview.assetId, artwork.assetId]) {
      expect((await shop(`/assets/${id}`)).status).toBe(404);
    }
  });

  it('serves attached files by presigned GET to the owning merchant only', async () => {
    const init = await stage();
    await complete(init.uploadId);
    const saved = await saveCustomization({ env: p.env, assets: [{ assetId: init.assetId }] });

    // There is no shopper read path any more.
    const shopperRead = await shop(`/customizations/${saved.customizationId}/assets/${init.assetId}/url`);
    expect(shopperRead.status).not.toBe(200);

    const merchant = (storeId = STORE_A, token?: string | null) =>
      call(`${ADMIN}/customizations/${saved.customizationId}/assets/${init.assetId}/url`, { storeId, token, env: p.env });
    const res = await merchant();
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({ method: 'GET', expiresIn: 60 });
    const got = await p.browserGet(data.url);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);
    expect((await merchant(STORE_B)).status).toBe(404);
    expect((await merchant(STORE_A, null)).status).toBe(401);
  });

  it('can disable the legacy proxied route without affecting direct uploads', async () => {
    const legacy = await shop('/uploads', { method: 'POST', rawBody: png, headers: { 'Content-Type': 'image/png' }, env: { LEGACY_PROXY_UPLOADS: 'false' } });
    expect(legacy.status).toBe(410);
    expect((await initiate({}, { env: { LEGACY_PROXY_UPLOADS: 'false' } })).status).toBe(201);
  });
});

describe('config', () => {
  it('clamps presigned lifetimes and derives the R2 endpoint', () => {
    const cfg = loadConfig({ UPLOAD_URL_TTL_SECONDS: '999999', PRIVATE_URL_TTL_SECONDS: '999999', R2_ACCOUNT_ID: 'abcdef0123456789' } as never);
    expect(cfg.uploadUrlTtlSeconds).toBe(3600);
    expect(cfg.privateUrlTtlSeconds).toBe(900);
    expect(cfg.r2S3Endpoint).toBe('https://abcdef0123456789.r2.cloudflarestorage.com');
  });
});
