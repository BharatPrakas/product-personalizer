import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN,
  DEV_TOKEN,
  INTEGRATIONS,
  PRODUCT_ID,
  STOREFRONT,
  STORE_A,
  STORE_B,
  applyMigrations,
  call,
  createCredential,
  json,
  orderEvent,
  orderEventWith,
  orderLine,
  postOrderEvent,
  queryDb,
  resetBucket,
  saveCustomization,
  seedPersonalizableProduct,
  truncateAll,
} from './helpers';
import { signBody } from '../src/modules/integration-credentials/signature';
import { OrderCallbackService } from '../src/modules/personalization/order-callback-service';
import { createDatabase } from '../src/database/connection';
import { Logger } from '../src/shared/logger';
import { getTestD1 } from './helpers';

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await truncateAll();
  resetBucket();
});

async function errorOf(res: Response): Promise<{ code: string; details?: any }> {
  return (await json(res)).error;
}

async function setup() {
  await seedPersonalizableProduct();
  const credential = await createCredential();
  const customization = await saveCustomization();
  return { credential, customization };
}

const count = async (table: string) =>
  Number((await queryDb<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))[0].n);

describe('credential management', () => {
  it('returns the secret once and only metadata afterwards; the database holds ciphertext', async () => {
    await seedPersonalizableProduct();
    const res = await call(`${ADMIN}/integration/credentials`, { method: 'POST', body: { label: 'zenbasket prod' } });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const issued = (await json(res)).data;
    expect(issued.secret).toMatch(/^zbsec_/);

    const list = (await json(await call(`${ADMIN}/integration/credentials`))).data;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(issued.secret);
    expect(list[0]).not.toHaveProperty('secret');
    expect(list[0]).not.toHaveProperty('secret_encrypted');

    const [row] = await queryDb<{ secret_encrypted: string }>('SELECT secret_encrypted FROM integration_credentials');
    expect(row.secret_encrypted).not.toContain(issued.secret);
    expect(row.secret_encrypted.startsWith('v1.')).toBe(true);
    // Not in the audit trail either.
    const audit = await queryDb<{ metadata: unknown }>("SELECT metadata FROM audit_logs WHERE action LIKE 'integration_credential.%'");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(issued.secret);
  });

  it('is invisible to other stores', async () => {
    await seedPersonalizableProduct(STORE_B, 'p-b', 'cfg-b');
    const cred = await createCredential(STORE_A);
    expect((await json(await call(`${ADMIN}/integration/credentials`, { storeId: STORE_B }))).data).toEqual([]);
    expect((await call(`${ADMIN}/integration/credentials/${cred.id}`, { method: 'DELETE', storeId: STORE_B })).status).toBe(404);
    expect((await call(`${ADMIN}/integration/credentials/${cred.id}/rotate`, { method: 'POST', storeId: STORE_B })).status).toBe(404);
  });

  it('needs the explicit integrations:manage scope (a wildcard session cannot read or mint secrets)', async () => {
    await seedPersonalizableProduct();
    const jwt = (scopes: string[]) => {
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const head = enc({ alg: 'HS256', typ: 'JWT' });
      const body = enc({ store_id: STORE_A, sub: 'u1', scopes, exp: Math.floor(Date.now() / 1000) + 600 });
      const sig = createHmac('sha256', 'jwt-secret').update(`${head}.${body}`).digest('base64url');
      return `${head}.${body}.${sig}`;
    };
    const env = { JWT_SIGNING_SECRET: 'jwt-secret', DEV_AUTH_TOKEN: undefined };
    for (const scopes of [[], ['*'], ['personalization:write']]) {
      const res = await call(`${ADMIN}/integration/credentials`, { token: jwt(scopes), env, method: 'POST', body: {} });
      expect(res.status, JSON.stringify(scopes)).toBe(403);
      expect((await call(`${ADMIN}/integration/credentials`, { token: jwt(scopes), env })).status).toBe(403);
    }
    const ok = await call(`${ADMIN}/integration/credentials`, { token: jwt(['integrations:manage']), env, method: 'POST', body: {} });
    expect(ok.status).toBe(201);
  });

  it('rotation keeps the old secret valid for the grace period, then it stops working', async () => {
    const { credential, customization } = await setup();
    const rotated = await call(`${ADMIN}/integration/credentials/${credential.id}/rotate`, {
      method: 'POST',
      body: { gracePeriodSeconds: 3600 },
    });
    expect(rotated.status).toBe(201);
    const { credential: fresh, previous } = (await json(rotated)).data;
    expect(fresh.secret).not.toBe(credential.secret);
    expect(previous.expiresAt).not.toBeNull();

    // Both work during the grace period.
    const first = await postOrderEvent(credential, orderEvent(customization.customizationId));
    expect(first.status).toBe(200);
    const c2 = await saveCustomization();
    expect((await postOrderEvent(fresh, orderEvent(c2.customizationId, { orderId: 'ORD-2', lineId: 'L2' }))).status).toBe(200);

    // After the grace period the old one is rejected; the new one still works.
    await queryDb('UPDATE integration_credentials SET expires_at = $2 WHERE id = $1', [credential.id, new Date(Date.now() - 1000).toISOString()]);
    const c3 = await saveCustomization();
    expect((await postOrderEvent(credential, orderEvent(c3.customizationId, { orderId: 'ORD-3', lineId: 'L3' }))).status).toBe(401);
    expect((await postOrderEvent(fresh, orderEvent(c3.customizationId, { orderId: 'ORD-3', lineId: 'L3' }))).status).toBe(200);
  });

  it('rotation with no grace period revokes the old secret immediately; revoke is idempotent', async () => {
    const { credential, customization } = await setup();
    const rotated = await call(`${ADMIN}/integration/credentials/${credential.id}/rotate`, { method: 'POST', body: { gracePeriodSeconds: 0 } });
    expect(rotated.status).toBe(201);
    expect((await postOrderEvent(credential, orderEvent(customization.customizationId))).status).toBe(401);
    expect((await call(`${ADMIN}/integration/credentials/${credential.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`${ADMIN}/integration/credentials/${credential.id}/rotate`, { method: 'POST' })).status).toBe(409);
  });

  it('reports 503 when the encryption key is not configured', async () => {
    await seedPersonalizableProduct();
    const res = await call(`${ADMIN}/integration/credentials`, { method: 'POST', body: {}, env: { INTEGRATION_ENCRYPTION_KEY: undefined } });
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe('integrations_not_configured');
  });
});

describe('signed order events — authentication', () => {
  it('rejects missing headers, unknown keys, bad signatures and tampered bodies with a uniform 401', async () => {
    const { credential, customization } = await setup();
    const event = orderEvent(customization.customizationId);
    const body = JSON.stringify(event);
    const url = `${INTEGRATIONS}/events`;
    const ts = Math.floor(Date.now() / 1000);

    const bare = await call(url, { method: 'POST', token: null, rawBody: new TextEncoder().encode(body) });
    expect(bare.status).toBe(401);

    const unknown = await postOrderEvent({ id: crypto.randomUUID(), secret: credential.secret }, event);
    expect(unknown.status).toBe(401);

    const wrongSecret = await postOrderEvent(credential, event, { signWith: 'zbsec_wrong' });
    expect(wrongSecret.status).toBe(401);

    // Signed for one body, sent with another.
    const tampered = await call(url, {
      method: 'POST', token: null,
      rawBody: new TextEncoder().encode(JSON.stringify({ ...event, order: { id: 'ORD-EVIL' } })),
      headers: { 'X-ZB-Key-Id': credential.id, 'X-ZB-Timestamp': String(ts), 'X-ZB-Signature': signBody(credential.secret, ts, body) },
    });
    expect(tampered.status).toBe(401);

    // Signed over a different timestamp than the one sent (timestamp is part of the signature).
    const reTimed = await call(url, {
      method: 'POST', token: null, rawBody: new TextEncoder().encode(body),
      headers: { 'X-ZB-Key-Id': credential.id, 'X-ZB-Timestamp': String(ts + 1), 'X-ZB-Signature': signBody(credential.secret, ts, body) },
    });
    expect(reTimed.status).toBe(401);

    // Nothing was written by any of them.
    expect(await count('order_links')).toBe(0);
    expect(await count('integration_events')).toBe(0);
    // A bearer dev token is NOT an alternative way in.
    const bearer = await call(url, { method: 'POST', token: DEV_TOKEN, body: event });
    expect(bearer.status).toBe(401);
    // The retired single-line endpoint no longer exists.
    expect((await call(`${INTEGRATIONS}/order-events`, { method: 'POST', token: null, body: event })).status).toBe(404);
  });

  it('rejects timestamps outside the configurable window', async () => {
    const { credential, customization } = await setup();
    const event = orderEvent(customization.customizationId);
    const now = Math.floor(Date.now() / 1000);
    const stale = await postOrderEvent(credential, event, { timestamp: now - 3600 });
    expect(stale.status).toBe(401);
    expect((await errorOf(stale)).code).toBe('invalid_timestamp');
    expect((await postOrderEvent(credential, event, { timestamp: now + 3600 })).status).toBe(401);
    // A wider configured window accepts the same request.
    expect((await postOrderEvent(credential, event, { timestamp: now - 3600, env: { ORDER_CALLBACK_TOLERANCE_SECONDS: '7200' } })).status).toBe(200);
  });

  it('rejects a revoked credential', async () => {
    const { credential, customization } = await setup();
    await call(`${ADMIN}/integration/credentials/${credential.id}`, { method: 'DELETE' });
    expect((await postOrderEvent(credential, orderEvent(customization.customizationId))).status).toBe(401);
  });

  it('rejects oversized bodies and malformed JSON (after authentication)', async () => {
    const { credential } = await setup();
    expect((await postOrderEvent(credential, 'x'.repeat(65 * 1024))).status).toBe(413);
    const res = await postOrderEvent(credential, '{not json');
    expect(res.status).toBe(400);
  });

  it('is not served without a configured encryption key', async () => {
    const { credential, customization } = await setup();
    const res = await postOrderEvent(credential, orderEvent(customization.customizationId), { env: { INTEGRATION_ENCRYPTION_KEY: undefined } });
    expect(res.status).toBe(503);
  });
});

/** The per-line results of a response body. */
const resultsOf = async (res: Response) => (await json(res)).results as Array<{ lineId: string; status: string; reason?: string; customizationId?: string }>;

describe('signed order events — linking', () => {
  it('links the customization to the order line and marks it ordered', async () => {
    const { credential, customization } = await setup();
    const event = orderEvent(customization.customizationId);
    const res = await postOrderEvent(credential, event);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      contract: 1,
      eventId: event.eventId,
      duplicate: false,
      results: [{ lineId: 'LINE-1', status: 'applied', customizationId: customization.customizationId }],
    });
    // Contract v1: the receiver response is not wrapped in `data`.
    expect(body.data).toBeUndefined();

    const [row] = await queryDb<any>('SELECT status, ordered_at, expires_at FROM customizations');
    expect(row.status).toBe('ordered');
    expect(row.ordered_at).not.toBeNull();
    expect(row.expires_at).toBeNull();
    const [link] = await queryDb<any>('SELECT * FROM order_links');
    expect(link).toMatchObject({ store_id: STORE_A, external_order_id: 'ORD-1001', external_line_id: 'LINE-1', product_external_id: PRODUCT_ID, event_id: event.eventId });
    const [ev] = await queryDb<any>('SELECT line_count, results FROM integration_events');
    expect(ev.line_count).toBe(1);
    expect(ev.results).toEqual(body.results);
    const audit = await queryDb<any>("SELECT actor FROM audit_logs WHERE action = 'order.link'");
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe(`integration:${credential.id}`);

    // The merchant sees the order on the customization and can find it by order id.
    const detail = (await json(await call(`${ADMIN}/customizations/${customization.customizationId}`))).data;
    expect(detail.status).toBe('ordered');
    expect(detail.order).toMatchObject({ orderId: 'ORD-1001', lineId: 'LINE-1' });
    const byOrder = (await json(await call(`${ADMIN}/customizations?orderId=ORD-1001`))).data;
    expect(byOrder.map((c: any) => c.id)).toEqual([customization.customizationId]);
  });

  it('answers a repeated event with the STORED results and changes nothing', async () => {
    const { credential, customization } = await setup();
    const event = orderEvent(customization.customizationId);
    const first = await json(await postOrderEvent(credential, event));
    const again = await postOrderEvent(credential, event);
    expect(again.status).toBe(200);
    const body = await json(again);
    expect(body.duplicate).toBe(true);
    // Same per-line outcome as the first delivery ("applied"), not a recomputed one.
    expect(body.results).toEqual(first.results);
    expect(await count('order_links')).toBe(1);
    expect(await count('integration_events')).toBe(1);
    expect(await count("audit_logs WHERE action = 'order.link'")).toBe(1);
  });

  it('treats a harmless re-serialization of the same event as a repeat', async () => {
    const { credential, customization } = await setup();
    const event = orderEvent(customization.customizationId);
    expect((await postOrderEvent(credential, event)).status).toBe(200);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(event).reverse()), null, 2);
    const again = await postOrderEvent(credential, reordered);
    expect(again.status).toBe(200);
    expect((await json(again)).duplicate).toBe(true);
  });

  it('is idempotent for the same customization + order line under a NEW eventId (line is `duplicate`)', async () => {
    const { credential, customization } = await setup();
    expect((await postOrderEvent(credential, orderEvent(customization.customizationId))).status).toBe(200);
    const retry = await postOrderEvent(credential, orderEvent(customization.customizationId));
    expect(retry.status).toBe(200);
    const body = await json(retry);
    expect(body.duplicate).toBe(false);
    expect(body.results[0].status).toBe('duplicate');
    expect(await count('order_links')).toBe(1);
  });

  it('rejects the LINE (HTTP 200, status `rejected`) when an ordered customization is linked to a different order or line', async () => {
    const { credential, customization } = await setup();
    expect((await postOrderEvent(credential, orderEvent(customization.customizationId))).status).toBe(200);
    for (const other of [{ orderId: 'ORD-OTHER' }, { lineId: 'LINE-OTHER' }]) {
      const res = await postOrderEvent(credential, orderEvent(customization.customizationId, other));
      expect(res.status).toBe(200);
      expect(await resultsOf(res)).toEqual([
        expect.objectContaining({ status: 'rejected', reason: 'customization_already_ordered' }),
      ]);
    }
    expect(await count('order_links')).toBe(1);
  });

  it('rejects the line when an order line already carries a different customization, leaving the other `saved`', async () => {
    const { credential, customization } = await setup();
    const second = await saveCustomization();
    expect((await postOrderEvent(credential, orderEvent(customization.customizationId))).status).toBe(200);
    const res = await postOrderEvent(credential, orderEvent(second.customizationId));
    expect(await resultsOf(res)).toEqual([expect.objectContaining({ status: 'rejected', reason: 'order_line_already_linked' })]);
    const [row] = await queryDb<any>('SELECT status FROM customizations WHERE id = $1', [second.customizationId]);
    expect(row.status).toBe('saved');
    expect(await count('order_links')).toBe(1);
  });

  it('409s when an eventId is reused with a different payload (envelope-level conflict)', async () => {
    const { credential, customization } = await setup();
    const event = orderEvent(customization.customizationId);
    expect((await postOrderEvent(credential, event)).status).toBe(200);
    const res = await postOrderEvent(credential, { ...event, order: { id: 'ORD-SNEAKY' } });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details.reason).toBe('event_id_reused');
  });

  it('rejects a product (or variant) that does not match what the shopper customized, changing nothing', async () => {
    const { credential, customization } = await setup();
    const wrongProduct = await postOrderEvent(credential, orderEvent(customization.customizationId, { productId: 'some-other-product' }));
    expect(wrongProduct.status).toBe(200);
    expect(await resultsOf(wrongProduct)).toEqual([expect.objectContaining({ status: 'rejected', reason: 'product_mismatch' })]);
    expect(await count('order_links')).toBe(0);
    const [row] = await queryDb<any>('SELECT status FROM customizations');
    expect(row.status).toBe('saved');

    // A product-scoped customization has no variant recorded, so a variant in the event is not a mismatch.
    const ok = await postOrderEvent(credential, orderEvent(customization.customizationId, { variantId: 'v-1' }));
    expect((await resultsOf(ok))[0].status).toBe('applied');
  });

  it('checks the variant when the customization recorded one', async () => {
    await seedPersonalizableProduct();
    const credential = await createCredential();
    const cfg = await (await import('./helpers')).storefrontConfig();
    const saved = await call(`${STOREFRONT}/customizations?storeId=${STORE_A}`, {
      method: 'POST', token: null,
      body: { productId: PRODUCT_ID, variantId: 'v-red', configId: cfg.configId, configVersion: cfg.version, data: {} },
    });
    expect(saved.status).toBe(201);
    const id = (await json(saved)).data.customizationId;
    const bad = await postOrderEvent(credential, orderEvent(id, { variantId: 'v-blue' }));
    expect(await resultsOf(bad)).toEqual([expect.objectContaining({ status: 'rejected', reason: 'variant_mismatch' })]);
    expect((await resultsOf(await postOrderEvent(credential, orderEvent(id, { variantId: 'v-red' }))))[0].status).toBe('applied');
  });

  it('never lets one store reach another store’s customization (rejected as not found, nothing changes)', async () => {
    const { customization } = await setup();
    await seedPersonalizableProduct(STORE_B, 'p-b', 'cfg-b');
    const credentialB = await createCredential(STORE_B);
    const res = await postOrderEvent(credentialB, orderEvent(customization.customizationId, { storeId: STORE_B }));
    expect(await resultsOf(res)).toEqual([expect.objectContaining({ status: 'rejected', reason: 'customization_not_found' })]);
    const [row] = await queryDb<any>('SELECT status FROM customizations WHERE id = $1', [customization.customizationId]);
    expect(row.status).toBe('saved');
    expect(await count('order_links')).toBe(0);
  });

  it('rejects an event whose storeId is not the credential’s store (403)', async () => {
    const { credential, customization } = await setup();
    const res = await postOrderEvent(credential, orderEvent(customization.customizationId, { storeId: STORE_B }));
    expect(res.status).toBe(403);
    expect(await count('order_links')).toBe(0);
  });

  it('rejects unsupported event types, unknown fields and malformed envelopes (422)', async () => {
    const { credential, customization } = await setup();
    const id = customization.customizationId;
    const unsupported = await postOrderEvent(credential, orderEvent(id, { type: 'order.created' }));
    expect(unsupported.status).toBe(422);
    expect((await errorOf(unsupported)).code).toBe('unsupported_event_type');
    expect((await postOrderEvent(credential, { ...orderEvent(id), order_id: 'x' } as any)).status).toBe(422);
    expect((await postOrderEvent(credential, orderEvent(id, { occurredAt: 'yesterday' }))).status).toBe(422);
    expect((await postOrderEvent(credential, orderEvent(id, { orderId: '' }))).status).toBe(422);
    expect((await postOrderEvent(credential, orderEvent(id, { contract: 2 as any }))).status).toBe(422);
    expect((await postOrderEvent(credential, orderEventWith([]))).status).toBe(422);
    expect((await postOrderEvent(credential, orderEventWith([orderLine(id), orderLine(id)]))).status).toBe(422); // duplicate line ids
    expect((await postOrderEvent(credential, { ...orderEvent(id), lines: [{ ...orderLine(id), extra: 1 }] } as any)).status).toBe(422);
    expect(await count('order_links')).toBe(0);
    expect(await count('integration_events')).toBe(0);
  });

  it('rejects a line with no or an invalid customizationId, and an unknown customization', async () => {
    const { credential } = await setup();
    const res = await postOrderEvent(
      credential,
      orderEventWith([
        orderLine('x', { id: 'L-1', extensions: {} }),
        orderLine('not-a-uuid', { id: 'L-2' }),
        orderLine(crypto.randomUUID(), { id: 'L-3' }),
      ]),
    );
    expect(res.status).toBe(200);
    expect(await resultsOf(res)).toEqual([
      expect.objectContaining({ lineId: 'L-1', status: 'rejected', reason: 'missing_customization_id' }),
      expect.objectContaining({ lineId: 'L-2', status: 'rejected', reason: 'invalid_customization_id' }),
      expect.objectContaining({ lineId: 'L-3', status: 'rejected', reason: 'customization_not_found' }),
    ]);
  });

  it('rejects a customization that expired before it was ordered', async () => {
    const { credential, customization } = await setup();
    await queryDb(
      `UPDATE customizations SET status = 'expired', expired_at = $2, expires_at = NULL, data = '{}'
        WHERE id = $1`,
      [customization.customizationId, new Date().toISOString()],
    );
    const res = await postOrderEvent(credential, orderEvent(customization.customizationId));
    expect(await resultsOf(res)).toEqual([expect.objectContaining({ status: 'rejected', reason: 'customization_expired' })]);
  });

  it('processes several lines in one event; a rejected line does not undo or block the others (savepoints)', async () => {
    const { credential, customization } = await setup();
    const second = await saveCustomization();
    const third = await saveCustomization();
    const event = orderEventWith([
      orderLine(customization.customizationId, { id: 'L-1' }),
      orderLine(second.customizationId, { id: 'L-2', productId: 'wrong-product' }), // rejected in the middle
      orderLine(third.customizationId, { id: 'L-3' }),
    ]);
    const res = await postOrderEvent(credential, event);
    expect(res.status).toBe(200);
    const firstResults = await resultsOf(res);
    expect(firstResults).toEqual([
      expect.objectContaining({ lineId: 'L-1', status: 'applied' }),
      expect.objectContaining({ lineId: 'L-2', status: 'rejected', reason: 'product_mismatch' }),
      expect.objectContaining({ lineId: 'L-3', status: 'applied' }),
    ]);
    expect(await count('order_links')).toBe(2);
    expect(await count("customizations WHERE status = 'ordered'")).toBe(2);
    const [rejected] = await queryDb<any>('SELECT status FROM customizations WHERE id = $1', [second.customizationId]);
    expect(rejected.status).toBe('saved');
    const [ev] = await queryDb<any>('SELECT line_count FROM integration_events');
    expect(ev.line_count).toBe(3);

    // A replay returns the identical per-line outcome and applies nothing again.
    const replay = await json(await postOrderEvent(credential, event));
    expect(replay.duplicate).toBe(true);
    expect(replay.results).toEqual(firstResults);
    expect(await count('order_links')).toBe(2);
    // The rejected line can be re-sent under a NEW eventId once the cause is fixed.
    const fixed = await postOrderEvent(credential, orderEventWith([orderLine(second.customizationId, { id: 'L-2' })]));
    expect((await resultsOf(fixed))[0].status).toBe('applied');
  });

  it('serializes concurrent duplicate deliveries: exactly one applies, every caller gets 200', async () => {
    const { credential, customization } = await setup();
    const event = orderEvent(customization.customizationId);
    const results = await Promise.all(Array.from({ length: 6 }, () => postOrderEvent(credential, event)));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    const bodies = await Promise.all(results.map(async (r) => json(r)));
    expect(bodies.filter((b) => b.duplicate === false)).toHaveLength(1);
    for (const b of bodies) expect(b.results).toEqual([expect.objectContaining({ lineId: 'LINE-1', status: 'applied' })]);
    expect(await count('order_links')).toBe(1);
    expect(await count('integration_events')).toBe(1);
  });

  it('serializes events that race for one order line: one applies, the rest are rejected', async () => {
    const { credential } = await setup();
    const customizations = await Promise.all(Array.from({ length: 4 }, () => saveCustomization()));
    const responses = await Promise.all(
      customizations.map((c) => postOrderEvent(credential, orderEvent(c.customizationId))),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const statuses = (await Promise.all(responses.map(resultsOf))).map((r) => r[0].status).sort();
    expect(statuses).toEqual(['applied', 'rejected', 'rejected', 'rejected']);
    expect(await count('order_links')).toBe(1);
    expect(await count("customizations WHERE status = 'ordered'")).toBe(1);
    // setup() saved one customization of its own, plus the four that raced.
    expect(await count("customizations WHERE status = 'saved'")).toBe(4);
  });

  it('resumes a stale `processing` event left by a simulated crash, without double-applying or hanging', async () => {
    const { credential, customization } = await setup();
    const event = orderEvent(customization.customizationId);
    const db = createDatabase(await getTestD1());

    // Simulate a prior attempt that inserted the dedup row and then died before any line ran.
    await db.query(
      `INSERT INTO integration_events
         (store_id, event_id, event_type, payload_sha256, occurred_at, status)
       VALUES ($1, $2, $3, $4, $5, 'processing')`,
      [STORE_A, event.eventId, event.type, 'simulated-crash-hash', event.occurredAt],
    );

    const service = new OrderCallbackService({ db, logger: new Logger('error', { requestId: 'crash-recovery-test' }), requestId: 'crash-recovery-test' });
    const result = await service.confirm({
      storeId: STORE_A,
      credentialId: credential.id,
      event,
      payloadSha256: 'simulated-crash-hash',
    });

    expect(result.duplicate).toBe(false);
    expect(result.results).toEqual([expect.objectContaining({ lineId: 'LINE-1', status: 'applied' })]);
    const [row] = await queryDb<any>('SELECT status, results FROM integration_events WHERE event_id = $1', [event.eventId]);
    expect(row.status).toBe('completed');
    expect(row.results).toEqual(result.results);
    expect(await count('order_links')).toBe(1);
    const [cz] = await queryDb<any>('SELECT status FROM customizations WHERE id = $1', [customization.customizationId]);
    expect(cz.status).toBe('ordered');

    // A genuine replay (now `completed`) answers from the stored results and changes nothing further.
    const replay = await service.confirm({ storeId: STORE_A, credentialId: credential.id, event, payloadSha256: 'simulated-crash-hash' });
    expect(replay.duplicate).toBe(true);
    expect(replay.results).toEqual(result.results);
    expect(await count('order_links')).toBe(1);
  });

  it('409s a stale `processing` event replayed with a different payload hash, same as a completed one would', async () => {
    const { credential, customization } = await setup();
    const event = orderEvent(customization.customizationId);
    const db = createDatabase(await getTestD1());
    await db.query(
      `INSERT INTO integration_events
         (store_id, event_id, event_type, payload_sha256, occurred_at, status)
       VALUES ($1, $2, $3, $4, $5, 'processing')`,
      [STORE_A, event.eventId, event.type, 'original-hash', event.occurredAt],
    );
    const service = new OrderCallbackService({ db, logger: new Logger('error', { requestId: 'x' }), requestId: 'x' });
    await expect(
      service.confirm({ storeId: STORE_A, credentialId: credential.id, event, payloadSha256: 'different-hash' }),
    ).rejects.toMatchObject({ status: 409, details: { reason: 'event_id_reused' } });
    expect(await count('order_links')).toBe(0);
  });
});

describe('configurations with customizations', () => {
  it('cannot be deleted (409) but can be archived', async () => {
    await seedPersonalizableProduct();
    await saveCustomization();
    const del = await call(`${ADMIN}/configs/cfg-cz1`, { method: 'DELETE' });
    expect(del.status).toBe(409);
    expect((await errorOf(del)).details.reason).toBe('config_has_customizations');
    expect((await call(`${ADMIN}/configs/cfg-cz1/archive`, { method: 'POST' })).status).toBe(200);
    // Still there, with its mappings and versions intact.
    expect((await call(`${ADMIN}/configs/cfg-cz1`)).status).toBe(200);
  });

  it('can still be deleted when nobody has customized it', async () => {
    await seedPersonalizableProduct();
    expect((await call(`${ADMIN}/configs/cfg-cz1`, { method: 'DELETE' })).status).toBe(204);
  });
});

// ---- optional order / customer details (contract v1 section 7, [proposed – optional]) ----------------
//
// The platform dispatcher does not send these yet: every event below is a signed fixture.

const FULL_ORDER = {
  id: 'ORD-1001',
  number: '#1001',
  placedAt: '2026-10-29T09:31:30+02:00',
  currency: 'EUR',
  totals: { subtotal: '40.00', shipping: '4.95', tax: '8.00', discount: '2.00', total: '50.95' },
  customer: { id: 'cust-77', name: 'Zelda Quill', email: 'zelda.quill@example.test', phone: '+33 6 12 34 56 78' },
  shippingAddress: {
    name: 'Zelda Quill', line1: '12 Rue Imaginaire', line2: 'Apt 4', city: 'Lyon', region: 'ARA',
    postalCode: '69001', country: 'fr', phone: '+33 6 12 34 56 78',
  },
  billingAddress: { name: 'Zelda Quill', line1: '1 Billing Way', city: 'Paris', postalCode: '75001', country: 'FR' },
};
/** Every PII value in FULL_ORDER; none of them may appear in logs, audit rows or the replay record. */
const PII = ['Zelda Quill', 'zelda.quill@example.test', '+33 6 12 34 56 78', '12 Rue Imaginaire', '1 Billing Way', 'cust-77', '69001'];

const orderOf = async (orderId = 'ORD-1001', storeId = STORE_A) =>
  call(`${ADMIN}/orders/${encodeURIComponent(orderId)}`, { storeId });

describe('signed order events — optional order details', () => {
  it('applies a minimal legacy event exactly as before, with every detail null', async () => {
    const { credential, customization } = await setup();
    const res = await postOrderEvent(credential, orderEvent(customization.customizationId));
    expect((await resultsOf(res))[0].status).toBe('applied');
    expect(await count('order_details')).toBe(0);
    const [link] = await queryDb<any>('SELECT variant_external_id, line_title, line_sku, unit_price, quantity FROM order_links');
    expect(link).toEqual({ variant_external_id: null, line_title: null, line_sku: null, unit_price: null, quantity: 1 });

    const order = (await json(await orderOf())).data;
    expect(order).toMatchObject({
      orderId: 'ORD-1001', orderNumber: null, placedAt: null, currency: null,
      totals: { subtotal: null, shipping: null, tax: null, discount: null, total: null },
      customer: { id: null, name: null, email: null, phone: null },
      shippingAddress: null, billingAddress: null,
    });
  });

  it('answers a replay of an event stored BEFORE the details existed from its stored results (hash unchanged)', async () => {
    const { credential, customization } = await setup();
    const event = orderEvent(customization.customizationId);
    // The canonical hash exactly as the original (id-only) receiver computed it.
    const lines = event.lines.map((l) => [l.id, l.productId, l.variantId ?? null, l.quantity ?? null, Object.entries(l.extensions).sort()]);
    const legacy = JSON.stringify([event.contract, event.type, event.storeId, event.order.id, event.occurredAt, lines]);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(legacy).digest('hex');
    await queryDb(
      `INSERT INTO integration_events (store_id, event_id, event_type, payload_sha256, occurred_at, status, results)
       VALUES ($1, $2, $3, $4, $5, 'completed', $6)`,
      [STORE_A, event.eventId, event.type, hash, event.occurredAt, JSON.stringify([{ lineId: 'LINE-1', status: 'applied' }])],
    );
    const body = await json(await postOrderEvent(credential, event));
    expect(body.duplicate).toBe(true);
  });

  it('stores a full event and returns it from the merchant order API (normalised)', async () => {
    const { credential, customization } = await setup();
    const event = orderEventWith(
      [orderLine(customization.customizationId, { variantId: 'v-1', quantity: 2, title: '  Mug — personalised ', sku: 'MUG-01', unitPrice: '20.00' })],
      { order: FULL_ORDER },
    );
    expect((await resultsOf(await postOrderEvent(credential, event)))[0].status).toBe('applied');

    const [link] = await queryDb<any>('SELECT variant_external_id, quantity, line_title, line_sku, unit_price FROM order_links');
    expect(link).toEqual({ variant_external_id: 'v-1', quantity: 2, line_title: 'Mug — personalised', line_sku: 'MUG-01', unit_price: '20.00' });

    const res = await orderOf();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const order = (await json(res)).data;
    expect(order).toMatchObject({
      orderId: 'ORD-1001',
      orderNumber: '#1001',
      placedAt: '2026-10-29T07:31:30.000Z',
      currency: 'EUR',
      totals: FULL_ORDER.totals,
      customer: FULL_ORDER.customer,
      shippingAddress: { ...FULL_ORDER.shippingAddress, country: 'FR' },
      billingAddress: { ...FULL_ORDER.billingAddress, line2: null, region: null, phone: null },
    });
    expect(order.lines[0]).toMatchObject({ lineId: 'LINE-1', variantId: 'v-1', quantity: 2, title: 'Mug — personalised', sku: 'MUG-01', unitPrice: '20.00' });

    // The list carries only the number, dates and customer NAME.
    const list = (await json(await call(`${ADMIN}/orders`))).data;
    expect(list[0]).toMatchObject({ orderId: 'ORD-1001', orderNumber: '#1001', customerName: 'Zelda Quill' });
    const listed = JSON.stringify(list);
    for (const value of ['zelda.quill@example.test', '+33 6 12 34 56 78', '12 Rue Imaginaire', 'Lyon']) {
      expect(listed).not.toContain(value);
    }
  });

  it('stores a partial event (customer only) and leaves the rest null; empty strings count as absent', async () => {
    const { credential, customization } = await setup();
    const event = orderEvent(customization.customizationId, {
      order: { id: 'ORD-1001', number: '   ', customer: { name: 'Zelda Quill', email: '' } },
    });
    expect((await resultsOf(await postOrderEvent(credential, event)))[0].status).toBe('applied');
    const [row] = await queryDb<any>('SELECT * FROM order_details');
    expect(row).toMatchObject({ order_number: null, placed_at: null, currency: null, totals: null, shipping_address: null, billing_address: null });
    expect(row.customer).toEqual({ name: 'Zelda Quill' });
    const order = (await json(await orderOf())).data;
    expect(order.customer).toEqual({ id: null, name: 'Zelda Quill', email: null, phone: null });
    expect(order.orderNumber).toBeNull();
  });

  it('fills missing fields from a later event / line, never wipes stored ones, and keeps (and warns about) a conflicting value', async () => {
    const { credential, customization } = await setup();
    const second = await saveCustomization();
    const first = orderEventWith([orderLine(customization.customizationId, { id: 'L-1' })], {
      order: { id: 'ORD-1001', number: '#1001', customer: { name: 'Zelda Quill' }, totals: { total: '50.95' } },
    });
    expect((await resultsOf(await postOrderEvent(credential, first)))[0].status).toBe('applied');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // Second event for the same order, another line: adds email/currency/address, omits the number,
      // and disagrees on the customer's name and the total.
      const later = orderEventWith([orderLine(second.customizationId, { id: 'L-2', title: 'Second line' })], {
        order: {
          id: 'ORD-1001',
          currency: 'EUR',
          customer: { name: 'Someone Else', email: 'zelda.quill@example.test' },
          totals: { total: '99.00', tax: '8.00' },
          shippingAddress: FULL_ORDER.shippingAddress,
        },
      });
      const res = await postOrderEvent(credential, later, { env: { LOG_LEVEL: 'debug' } });
      expect((await resultsOf(res))[0].status).toBe('applied');

      const order = (await json(await orderOf())).data;
      expect(order.orderNumber).toBe('#1001'); // not wiped by an absent value
      expect(order.currency).toBe('EUR'); // filled
      expect(order.customer).toMatchObject({ name: 'Zelda Quill', email: 'zelda.quill@example.test' }); // kept + filled
      expect(order.totals).toMatchObject({ total: '50.95', tax: '8.00' });
      expect(order.shippingAddress).toMatchObject({ line1: '12 Rue Imaginaire' });
      expect(order.lines.map((l: any) => l.lineId)).toEqual(['L-1', 'L-2']);

      const warnings = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('order details conflict'));
      expect(warnings).toHaveLength(1);
      expect(JSON.parse(warnings[0]).fields.sort()).toEqual(['customer.name', 'totals.total']);
      const everything = [...warn.mock.calls, ...log.mock.calls].map((c) => String(c[0])).join('\n');
      for (const value of [...PII, 'Someone Else', '99.00']) expect(everything).not.toContain(value);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }

    // An address is one unit: a different second address never replaces or merges into the first.
    const third = orderEventWith([orderLine(customization.customizationId, { id: 'L-1' })], {
      order: { id: 'ORD-1001', shippingAddress: { line1: 'Elsewhere 1', city: 'Nice', country: 'FR' } },
    });
    expect((await resultsOf(await postOrderEvent(credential, third)))[0].status).toBe('duplicate');
    const order = (await json(await orderOf())).data;
    expect(order.shippingAddress).toMatchObject({ line1: '12 Rue Imaginaire', city: 'Lyon' });
  });

  it('lets a duplicate line (new eventId) fill details the first event lacked', async () => {
    const { credential, customization } = await setup();
    expect((await resultsOf(await postOrderEvent(credential, orderEvent(customization.customizationId))))[0].status).toBe('applied');
    const retry = orderEventWith([orderLine(customization.customizationId, { title: 'Late title', sku: 'SKU-9' })], {
      order: { id: 'ORD-1001', number: '#1001' },
    });
    expect((await resultsOf(await postOrderEvent(credential, retry)))[0].status).toBe('duplicate');
    const order = (await json(await orderOf())).data;
    expect(order.orderNumber).toBe('#1001');
    expect(order.lines[0]).toMatchObject({ title: 'Late title', sku: 'SKU-9' });
  });

  it('stores no details when every line of the event is rejected', async () => {
    const { credential } = await setup();
    const res = await postOrderEvent(credential, orderEventWith([orderLine(crypto.randomUUID())], { order: FULL_ORDER }));
    expect((await resultsOf(res))[0].status).toBe('rejected');
    expect(await count('order_details')).toBe(0);
  });

  it('replays the same event as a duplicate with the same results; the same eventId with different details is a 409', async () => {
    const { credential, customization } = await setup();
    const event = orderEventWith([orderLine(customization.customizationId)], { order: FULL_ORDER });
    const first = await json(await postOrderEvent(credential, event));
    const again = await json(await postOrderEvent(credential, event));
    expect(again).toMatchObject({ duplicate: true, results: first.results });

    for (const changed of [
      { ...event, order: { ...FULL_ORDER, customer: { ...FULL_ORDER.customer, email: 'other@example.test' } } },
      { ...event, order: { ...FULL_ORDER, totals: { ...FULL_ORDER.totals, total: '1.00' } } },
      { ...event, lines: [{ ...event.lines[0], title: 'changed' }] },
    ]) {
      const res = await postOrderEvent(credential, changed);
      expect(res.status).toBe(409);
      expect((await errorOf(res)).details.reason).toBe('event_id_reused');
    }
  });

  it('rejects invalid details with 422 naming just that field, and writes nothing', async () => {
    const { credential, customization } = await setup();
    const id = customization.customizationId;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ order: { id: 'O', customer: { email: 'not-an-email' } } }, 'order.customer.email'],
      [{ order: { id: 'O', customer: { email: 'two words@example.test' } } }, 'order.customer.email'],
      [{ order: { id: 'O', shippingAddress: { country: 'XX' } } }, 'order.shippingAddress.country'],
      [{ order: { id: 'O', billingAddress: { country: 'FRA' } } }, 'order.billingAddress.country'],
      [{ order: { id: 'O', customer: { name: 'x'.repeat(201) } } }, 'order.customer.name'],
      [{ order: { id: 'O', number: 'x'.repeat(101) } }, 'order.number'],
      [{ order: { id: 'O', totals: { total: '-1.00' } } }, 'order.totals.total'],
      [{ order: { id: 'O', totals: { total: 'ten' } } }, 'order.totals.total'],
      [{ order: { id: 'O', totals: { total: 12.5 } } }, 'order.totals.total'],
      [{ order: { id: 'O', totals: { total: '1.23456' } } }, 'order.totals.total'],
      [{ order: { id: 'O', currency: 'EURO' } }, 'order.currency'],
      [{ order: { id: 'O', placedAt: 'yesterday' } }, 'order.placedAt'],
      [{ order: { id: 'O', customer: { phone: 'call me' } } }, 'order.customer.phone'],
      [{ order: { id: 'O', customer: { address: 'unknown key' } } }, 'order.customer'],
      [{ lines: [orderLine(id, { unitPrice: '-5' })] }, 'lines.0.unitPrice'],
      [{ lines: [orderLine(id, { sku: 'x'.repeat(101) })] }, 'lines.0.sku'],
    ];
    for (const [overrides, path] of cases) {
      const event = { ...orderEvent(id), ...overrides };
      const res = await postOrderEvent(credential, event as any);
      expect(res.status, path).toBe(422);
      const issues = (await errorOf(res)).details.issues as Array<{ path: string; message: string }>;
      expect(issues.map((i) => i.path), path).toEqual([path]);
      // The rejected value itself is not echoed back.
      expect(JSON.stringify(issues)).not.toContain('two words');
    }
    expect(await count('order_links')).toBe(0);
    expect(await count('order_details')).toBe(0);
  });

  it('accepts unusual but valid emails and a realistic 100-line event within the body limit', async () => {
    const { credential, customization } = await setup();
    const res = await postOrderEvent(
      credential,
      orderEvent(customization.customizationId, { order: { id: 'ORD-1001', customer: { email: '"o\'hara+tag"@sub.example.museum' } } }),
    );
    expect((await resultsOf(res))[0].status).toBe('applied');

    const lines = Array.from({ length: 100 }, (_, i) =>
      orderLine(crypto.randomUUID(), { id: `LINE-${i}`, title: 't'.repeat(200), sku: 's'.repeat(100), unitPrice: '123456789012.1234' }));
    const big = orderEventWith(lines, { order: { ...FULL_ORDER, id: 'ORD-BIG' } });
    expect(JSON.stringify(big).length).toBeLessThan(64 * 1024);
    expect((await postOrderEvent(credential, big)).status).toBe(200);
  });

  it('fails the signature when a new field is tampered with', async () => {
    const { credential, customization } = await setup();
    const event = orderEventWith([orderLine(customization.customizationId)], { order: FULL_ORDER });
    const ts = Math.floor(Date.now() / 1000);
    const signature = signBody(credential.secret, ts, JSON.stringify(event));
    const tampered = { ...event, order: { ...FULL_ORDER, shippingAddress: { ...FULL_ORDER.shippingAddress, line1: '1 Attacker Rd' } } };
    const res = await call(`${INTEGRATIONS}/events`, {
      method: 'POST', token: null,
      rawBody: new TextEncoder().encode(JSON.stringify(tampered)),
      headers: { 'X-ZB-Key-Id': credential.id, 'X-ZB-Timestamp': String(ts), 'X-ZB-Signature': signature },
    });
    expect(res.status).toBe(401);
    expect(await count('order_details')).toBe(0);
  });

  it('never lets store B read store A’s order details', async () => {
    const { credential, customization } = await setup();
    await postOrderEvent(credential, orderEventWith([orderLine(customization.customizationId)], { order: FULL_ORDER }));
    await seedPersonalizableProduct(STORE_B, 'p-b', 'cfg-b');
    const res = await orderOf('ORD-1001', STORE_B);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await json(res))).not.toContain('Zelda');
    expect((await json(await call(`${ADMIN}/orders`, { storeId: STORE_B }))).data).toEqual([]);
    // Nor through the public storefront routes, which have no order endpoint at all.
    expect((await call(`${STOREFRONT}/orders/ORD-1001?storeId=${STORE_A}`, { token: null })).status).toBe(404);
  });

  it('keeps customer data out of logs, audit rows, the replay record and the shopper read', async () => {
    const { credential, customization } = await setup();
    const spies = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      const event = orderEventWith([orderLine(customization.customizationId)], { order: FULL_ORDER });
      const env = { LOG_LEVEL: 'debug' };
      expect((await postOrderEvent(credential, event, { env })).status).toBe(200);
      expect((await postOrderEvent(credential, event, { env })).status).toBe(200); // replay
      await postOrderEvent(credential, { ...event, order: { ...FULL_ORDER, number: 'changed' } }, { env }); // 409
      await postOrderEvent(credential, { ...event, eventId: 'bad', order: { ...FULL_ORDER, customer: { email: 'Zelda Quill' } } }, { env }); // 422
      await orderOf(); // merchant read
      const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
      expect(logged.length).toBeGreaterThan(0);
      for (const value of PII) expect(logged).not.toContain(value);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const audit = await queryDb<any>('SELECT * FROM audit_logs');
    expect(audit.find((a) => a.action === 'order.link').metadata).toEqual({
      orderId: 'ORD-1001', lineId: 'LINE-1', eventId: expect.any(String),
    });
    const events = await queryDb<any>('SELECT * FROM integration_events');
    const stored = JSON.stringify([audit, events]);
    for (const value of PII) expect(stored).not.toContain(value);
    // The shopper's own read of the customization carries no order details.
    const shopper = await call(
      `${STOREFRONT}/customizations/${customization.customizationId}?storeId=${STORE_A}`,
      { token: null, headers: { Authorization: `Bearer ${customization.accessToken}` } },
    );
    expect(shopper.status).toBe(200);
    const shopperBody = await shopper.text();
    for (const value of PII) expect(shopperBody).not.toContain(value);
  });
});
