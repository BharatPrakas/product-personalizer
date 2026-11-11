import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  PRODUCT_ID,
  STORE_A,
  STORE_B,
  applyMigrations,
  call,
  createCredential,
  json,
  orderEventWith,
  orderLine,
  postOrderEvent,
  queryDb,
  resetBucket,
  saveCustomization,
  seedPersonalizableProduct,
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

type Credential = { id: string; secret: string };

/** Save one customization per line and confirm them all as one order. */
async function placeOrder(
  credential: Credential,
  orderId: string,
  options: { lines?: number; productId?: string; order?: Record<string, unknown>; storeId?: string; withPreview?: boolean } = {},
): Promise<string[]> {
  const storeId = options.storeId ?? STORE_A;
  const productId = options.productId ?? PRODUCT_ID;
  const ids: string[] = [];
  for (let i = 0; i < (options.lines ?? 1); i++) {
    const assets = [];
    if (options.withPreview) {
      const preview = await uploadCustomerImage(storeId, 'preview');
      const upload = await uploadCustomerImage(storeId, 'upload');
      assets.push({ assetId: preview.assetId, uploadToken: preview.uploadToken }, { assetId: upload.assetId, uploadToken: upload.uploadToken });
    }
    ids.push((await saveCustomization({ storeId, productId, assets })).customizationId);
  }
  const res = await postOrderEvent(
    credential,
    orderEventWith(
      ids.map((id, i) => orderLine(id, { id: `${orderId}-L${i + 1}`, productId, title: `Item ${i + 1}` })),
      { storeId, order: { id: orderId, ...options.order } },
    ),
  );
  const body = await json(res);
  if (body.results.some((r: any) => r.status !== 'applied')) throw new Error(JSON.stringify(body));
  return ids;
}

/** Make link times deterministic (they are `created_at` defaults, all within the same millisecond-ish). */
async function setLinkedAt(orderId: string, iso: string) {
  await queryDb('UPDATE order_links SET created_at = $2 WHERE external_order_id = $1', [orderId, iso]);
}

const list = async (query = '', storeId = STORE_A) => {
  const res = await call(`${ADMIN}/orders${query}`, { storeId });
  return { status: res.status, body: await json(res) };
};

describe('merchant orders API', () => {
  it('requires authentication', async () => {
    expect((await call(`${ADMIN}/orders`, { token: null })).status).toBe(401);
    expect((await call(`${ADMIN}/orders/ORD-1`, { token: null })).status).toBe(401);
  });

  it('lists orders newest first, grouped, with line count, thumbnails and placed/linked time', async () => {
    await seedPersonalizableProduct();
    const credential = await createCredential();
    const [c1] = await placeOrder(credential, 'ORD-A', { withPreview: true, order: { number: '#100', placedAt: '2026-11-01T10:00:00Z', customer: { name: 'Ann', email: 'ann@example.test' } } });
    await placeOrder(credential, 'ORD-B', { lines: 3 });
    await setLinkedAt('ORD-A', '2026-11-01T10:05:00.000Z');
    await setLinkedAt('ORD-B', '2026-11-02T10:05:00.000Z');

    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.data.map((o: any) => o.orderId)).toEqual(['ORD-B', 'ORD-A']);
    const [b, a] = body.data;
    expect(b).toMatchObject({ lineCount: 3, orderNumber: null, placedAt: null, customerName: null, linkedAt: '2026-11-02T10:05:00.000Z' });
    expect(b.lines.map((l: any) => l.lineId)).toEqual(['ORD-B-L1', 'ORD-B-L2', 'ORD-B-L3']);
    expect(a).toMatchObject({ orderNumber: '#100', placedAt: '2026-11-01T10:00:00.000Z', customerName: 'Ann', lineCount: 1 });
    expect(a).not.toHaveProperty('customer');
    expect(a.lines[0]).toMatchObject({ customizationId: c1, status: 'ordered', productId: PRODUCT_ID, title: 'Item 1' });
    expect(a.lines[0].previewAssetId).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain('ann@example.test');
  });

  it('pages with a keyset cursor and rejects a tampered cursor', async () => {
    await seedPersonalizableProduct();
    const credential = await createCredential();
    for (let i = 1; i <= 5; i++) {
      await placeOrder(credential, `ORD-${i}`);
      await setLinkedAt(`ORD-${i}`, `2026-11-0${i}T00:00:00.000Z`);
    }
    // Two orders linked at the same instant are still ordered deterministically (by id).
    await setLinkedAt('ORD-4', '2026-11-05T00:00:00.000Z');

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const { body } = await list(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(body.data.length).toBeLessThanOrEqual(2);
      seen.push(...body.data.map((o: any) => o.orderId));
      cursor = body.meta.pagination.hasMore ? body.meta.pagination.nextCursor : null;
    } while (cursor);
    expect(seen).toEqual(['ORD-5', 'ORD-4', 'ORD-3', 'ORD-2', 'ORD-1']);

    expect((await list('?cursor=not-a-cursor')).status).toBe(400);
    expect((await list('?limit=500')).status).toBe(422);
  });

  it('filters by order id / number (exact or prefix), product and date range', async () => {
    await seedPersonalizableProduct();
    await seedPersonalizableProduct(STORE_A, 'zb-prod-2', 'cfg-cz2');
    const credential = await createCredential();
    await placeOrder(credential, 'ORD-111', { order: { number: 'NO-5001', placedAt: '2026-10-01T12:00:00Z' } });
    await placeOrder(credential, 'ORD-222', { productId: 'zb-prod-2', order: { number: 'NO-6001', placedAt: '2026-10-15T12:00:00Z' } });
    await placeOrder(credential, 'ORD-333'); // no placedAt: dated by its link time
    await setLinkedAt('ORD-333', '2026-11-01T00:00:00.000Z');

    const ids = async (q: string) => (await list(q)).body.data.map((o: any) => o.orderId).sort();
    expect(await ids('?q=ORD-222')).toEqual(['ORD-222']);
    expect(await ids('?q=NO-5001')).toEqual(['ORD-111']);
    expect(await ids('?q=NO-')).toEqual(['ORD-111', 'ORD-222']);
    expect(await ids('?q=ORD')).toEqual(['ORD-111', 'ORD-222', 'ORD-333']);
    expect(await ids('?q=%25')).toEqual([]); // LIKE wildcards are literal
    expect(await ids('?productId=zb-prod-2')).toEqual(['ORD-222']);
    expect(await ids(`?productId=${PRODUCT_ID}`)).toEqual(['ORD-111', 'ORD-333']);
    expect(await ids('?from=2026-10-10')).toEqual(['ORD-222', 'ORD-333']);
    expect(await ids('?to=2026-10-15')).toEqual(['ORD-111', 'ORD-222']); // inclusive whole day
    expect(await ids('?from=2026-10-02&to=2026-10-31')).toEqual(['ORD-222']);
    expect(await ids('?from=2026-10-15T12:00:00Z&to=2026-10-15T12:00:00Z')).toEqual(['ORD-222']);
    expect((await list('?from=last-week')).status).toBe(422);
  });

  it('returns one order with several lines, their customization summary and files', async () => {
    await seedPersonalizableProduct();
    const credential = await createCredential();
    const ids = await placeOrder(credential, 'ORD-MULTI', { lines: 2, withPreview: true });
    const res = await call(`${ADMIN}/orders/ORD-MULTI`);
    expect(res.status).toBe(200);
    const order = (await json(res)).data;
    expect(order.lines).toHaveLength(2);
    expect(order.lines.map((l: any) => l.customization.id)).toEqual(ids);
    for (const line of order.lines) {
      expect(line.customization).toMatchObject({ status: 'ordered', configId: 'cfg-cz1', configVersion: expect.any(Number) });
      expect(line.assets.map((a: any) => a.kind).sort()).toEqual(['preview', 'upload']);
      expect(line.assets[0]).toMatchObject({ contentType: 'image/png', width: 1, height: 1, sizeBytes: expect.any(Number) });
    }
    // Files download through the existing customization asset endpoint, privately.
    const asset = order.lines[0].assets[0];
    const file = await call(`${ADMIN}/customizations/${order.lines[0].customization.id}/assets/${asset.assetId}/content`);
    expect(file.status).toBe(200);
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    expect(file.headers.get('x-checksum-sha256')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles order ids that need URL encoding', async () => {
    await seedPersonalizableProduct();
    const credential = await createCredential();
    await placeOrder(credential, 'ORD #7/β');
    const res = await call(`${ADMIN}/orders/${encodeURIComponent('ORD #7/β')}`);
    expect(res.status).toBe(200);
    expect((await json(res)).data.orderId).toBe('ORD #7/β');
  });

  it('404s an unknown order', async () => {
    await seedPersonalizableProduct();
    const res = await call(`${ADMIN}/orders/NOPE`);
    expect(res.status).toBe(404);
  });

  it('isolates tenants: store B neither lists nor reads store A’s orders or their files', async () => {
    await seedPersonalizableProduct();
    await seedPersonalizableProduct(STORE_B, 'p-b', 'cfg-b');
    const credentialA = await createCredential(STORE_A);
    const credentialB = await createCredential(STORE_B);
    await placeOrder(credentialA, 'ORD-SHARED-ID', { withPreview: true, order: { customer: { name: 'Alice A' } } });
    await placeOrder(credentialB, 'ORD-B-ONLY', { storeId: STORE_B, productId: 'p-b' });

    expect((await list('', STORE_B)).body.data.map((o: any) => o.orderId)).toEqual(['ORD-B-ONLY']);
    expect((await call(`${ADMIN}/orders/ORD-SHARED-ID`, { storeId: STORE_B })).status).toBe(404);
    expect((await list('?q=ORD-SHARED-ID', STORE_B)).body.data).toEqual([]);

    const a = (await json(await call(`${ADMIN}/orders/ORD-SHARED-ID`))).data;
    const line = a.lines[0];
    const fileFromB = await call(`${ADMIN}/customizations/${line.customization.id}/assets/${line.assets[0].assetId}/content`, { storeId: STORE_B });
    expect(fileFromB.status).toBe(404);

    // The same external order id in two stores stays two separate orders.
    await placeOrder(credentialB, 'ORD-SHARED-ID', { storeId: STORE_B, productId: 'p-b', order: { customer: { name: 'Bob B' } } });
    const fromB = (await json(await call(`${ADMIN}/orders/ORD-SHARED-ID`, { storeId: STORE_B }))).data;
    expect(fromB.customer.name).toBe('Bob B');
    expect(fromB.lines).toHaveLength(1);
    expect((await json(await call(`${ADMIN}/orders/ORD-SHARED-ID`))).data.customer.name).toBe('Alice A');
  });
});
