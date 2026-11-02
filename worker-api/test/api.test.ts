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
  resetBucket,
  sampleDraft,
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

describe('health', () => {
  it('health is public and reports a healthy database', async () => {
    const res = await call('/api/v1/health', { token: null });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.status).toBe('ok');
    expect(body.data.checks.database).toBe('ok');
    // No secrets leaked.
    expect(JSON.stringify(body)).not.toContain('personalizer_local_dev');
  });

  it('does not expose a plugin catalogue', async () => {
    for (const path of ['/api/v1/plugins', `${ADMIN}/status`]) {
      expect((await call(path)).status).toBe(404);
    }
  });
});

describe('authentication & authorization', () => {
  it('rejects an unauthenticated request to a protected route', async () => {
    const res = await call(`${ADMIN}/configs`, { token: null });
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.requestId).toBeTruthy();
  });
});

describe('configuration CRUD', () => {
  it('creates, reads, lists and updates with optimistic concurrency', async () => {
    const create = await call(`${ADMIN}/configs`, {
      method: 'POST',
      body: { clientConfigId: 'cfg-crud1', draft: sampleDraft({ id: 'cfg-crud1' }) },
    });
    expect(create.status).toBe(201);
    const created = (await json(create)).data;
    expect(created.id).toBe('cfg-crud1');
    expect(created.draft.product.name).toBe('Sample Tee');
    expect(created.published).toBeNull();

    const get = await call(`${ADMIN}/configs/cfg-crud1`);
    expect(get.status).toBe(200);

    const list = await call(`${ADMIN}/configs`);
    const listBody = await json(list);
    expect(listBody.data.length).toBe(1);
    expect(listBody.meta.pagination.total).toBe(1);

    // Correct concurrency token → success, updatedAt advances.
    const save = await call(`${ADMIN}/configs/cfg-crud1`, {
      method: 'PUT',
      body: {
        draft: sampleDraft({ id: 'cfg-crud1', product: { id: 'product-cfg-crud1', name: 'Renamed' } }),
        expectedUpdatedAt: created.updatedAt,
      },
    });
    expect(save.status).toBe(200);
    const saved = (await json(save)).data;
    expect(saved.draft.product.name).toBe('Renamed');
    expect(saved.updatedAt).toBeGreaterThan(created.updatedAt);

    // Stale token → 409 conflict (never clobbers a newer copy).
    const stale = await call(`${ADMIN}/configs/cfg-crud1`, {
      method: 'PUT',
      body: { draft: sampleDraft({ id: 'cfg-crud1' }), expectedUpdatedAt: created.updatedAt },
    });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.code).toBe('conflict');
  });

  it('is idempotent on repeated create with the same client id', async () => {
    const body = { clientConfigId: 'cfg-idem', draft: sampleDraft({ id: 'cfg-idem' }) };
    const first = (await json(await call(`${ADMIN}/configs`, { method: 'POST', body }))).data;
    const second = (await json(await call(`${ADMIN}/configs`, { method: 'POST', body }))).data;
    expect(first.id).toBe(second.id);
    const list = await json(await call(`${ADMIN}/configs`));
    expect(list.data.length).toBe(1);
  });

  it('rejects an invalid draft with structured 422 issues', async () => {
    const res = await call(`${ADMIN}/configs`, {
      method: 'POST',
      body: { draft: sampleDraft({ product: { id: 'p' } }) }, // no name
    });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });

  it('duplicates, archives, restores and deletes', async () => {
    await call(`${ADMIN}/configs`, {
      method: 'POST',
      body: { clientConfigId: 'cfg-life', draft: sampleDraft({ id: 'cfg-life' }) },
    });

    const dup = await call(`${ADMIN}/configs/cfg-life/duplicate`, { method: 'POST' });
    expect(dup.status).toBe(201);
    const copy = (await json(dup)).data;
    expect(copy.id).not.toBe('cfg-life');
    expect(copy.draft.product.name).toContain('(copy)');

    await call(`${ADMIN}/configs/cfg-life/archive`, { method: 'POST' });
    const defaultList = await json(await call(`${ADMIN}/configs`));
    expect(defaultList.data.find((r: any) => r.id === 'cfg-life')).toBeUndefined();
    const allList = await json(await call(`${ADMIN}/configs?includeArchived=true`));
    expect(allList.data.find((r: any) => r.id === 'cfg-life')).toBeTruthy();

    await call(`${ADMIN}/configs/cfg-life/restore`, { method: 'POST' });
    const restored = await json(await call(`${ADMIN}/configs`));
    expect(restored.data.find((r: any) => r.id === 'cfg-life')).toBeTruthy();

    const del = await call(`${ADMIN}/configs/cfg-life`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const gone = await call(`${ADMIN}/configs/cfg-life`);
    expect(gone.status).toBe(404);
  });
});

describe('publishing & versions', () => {
  it('refuses to publish an incomplete config but publishes a complete one', async () => {
    await call(`${ADMIN}/configs`, {
      method: 'POST',
      body: { clientConfigId: 'cfg-empty', draft: sampleDraft({ id: 'cfg-empty' }) },
    });
    const bad = await call(`${ADMIN}/configs/cfg-empty/publish`, { method: 'POST' });
    expect(bad.status).toBe(422);

    await call(`${ADMIN}/configs`, {
      method: 'POST',
      body: { clientConfigId: 'cfg-ok', draft: publishableDraft('cfg-ok') },
    });
    const pub = await call(`${ADMIN}/configs/cfg-ok/publish`, { method: 'POST' });
    expect(pub.status).toBe(200);
    const record = (await json(pub)).data;
    expect(record.published).toBeTruthy();
    expect(record.published.status).toBe('published');
    expect(record.draft.version).toBe(2); // draft carried on as next version

    const versions = await json(await call(`${ADMIN}/configs/cfg-ok/versions`));
    expect(versions.data.length).toBe(1);
    const versionId = versions.data[0].versionId;
    const one = await json(await call(`${ADMIN}/configs/cfg-ok/versions/${versionId}`));
    expect(one.data.snapshot.status).toBe('published');
  });
});

describe('tenant isolation', () => {
  it('store B cannot read, update or delete store A configs', async () => {
    await call(`${ADMIN}/configs`, {
      storeId: STORE_A,
      method: 'POST',
      body: { clientConfigId: 'cfg-a', draft: sampleDraft({ id: 'cfg-a' }) },
    });
    // Store B: same id, different tenant → not found.
    const get = await call(`${ADMIN}/configs/cfg-a`, { storeId: STORE_B });
    expect(get.status).toBe(404);
    const del = await call(`${ADMIN}/configs/cfg-a`, { storeId: STORE_B, method: 'DELETE' });
    expect(del.status).toBe(404);
    // Store B's list is empty.
    const list = await json(await call(`${ADMIN}/configs`, { storeId: STORE_B }));
    expect(list.data.length).toBe(0);
  });
});

describe('R2 asset flow', () => {
  async function upload(storeId = STORE_A, query = '') {
    return call(`${ADMIN}/assets${query}`, {
      storeId,
      method: 'POST',
      rawBody: tinyPng(),
      headers: { 'Content-Type': 'image/png' },
    });
  }

  it('uploads, stores metadata, serves content and lists', async () => {
    const res = await upload();
    expect(res.status).toBe(201);
    const asset = (await json(res)).data;
    expect(asset.contentType).toBe('image/png');
    expect(asset.sizeBytes).toBe(tinyPng().byteLength);
    expect(asset.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(asset.deliveryUrl).toContain(`${STOREFRONT}/assets/${asset.id}`);
    expect(sharedBucket.objects.has(asset.objectKey)).toBe(true);
    expect(asset).not.toHaveProperty('pluginId');
    // Stored under this store's asset folder.
    expect(asset.objectKey).toMatch(
      new RegExp(`^stores/${STORE_A}/product-personalization/assets/[0-9a-f-]{36}\\.png$`),
    );

    const content = await call(`${ADMIN}/assets/${asset.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('Content-Type')).toBe('image/png');
    const bytes = new Uint8Array(await content.arrayBuffer());
    expect(bytes.byteLength).toBe(tinyPng().byteLength);

    const list = await json(await call(`${ADMIN}/assets`));
    expect(list.data.length).toBe(1);
  });

  const pathAndQuery = (url: string) => {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  };

  it('serves the stored delivery URL with no token, even for an unpublished (draft) asset', async () => {
    const asset = (await json(await upload())).data;
    expect(asset.deliveryUrl).toContain('?sig=');

    const res = await call(pathAndQuery(asset.deliveryUrl), { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('private');
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(tinyPng().byteLength);
  });

  it('refuses a draft asset without a valid signature', async () => {
    const asset = (await json(await upload())).data;
    const path = new URL(asset.deliveryUrl).pathname;

    expect((await call(path, { token: null })).status).toBe(404);
    expect((await call(`${path}?sig=not-a-real-signature`, { token: null })).status).toBe(404);
    // A signature for a different asset id does not transfer.
    const other = (await json(await upload())).data;
    const otherSig = new URL(other.deliveryUrl).search;
    expect((await call(`${path}${otherSig}`, { token: null })).status).toBe(404);
  });

  it('lets the admin origin load the delivery URL cross-origin, and not a stranger', async () => {
    const asset = (await json(await upload())).data;
    const url = pathAndQuery(asset.deliveryUrl);

    const admin = await call(url, { token: null, origin: 'http://localhost:4200' });
    expect(admin.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4200');

    const preflight = await call(url, { method: 'OPTIONS', token: null, origin: 'http://localhost:4200' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4200');

    const stranger = await call(url, { token: null, origin: 'http://evil.example' });
    expect(stranger.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('re-points a config saved with the old Bearer-only URL at the signed URL when it is read', async () => {
    const asset = (await json(await upload())).data;
    const legacy = `http://api.test${ADMIN}/assets/${asset.id}/content`;
    await call(`${ADMIN}/configs`, {
      method: 'POST',
      body: {
        clientConfigId: 'cfg-legacy',
        draft: sampleDraft({ id: 'cfg-legacy', mockups: [{ id: 'm1', name: 'Front', src: legacy, placements: [] }] }),
      },
    });

    const record = (await json(await call(`${ADMIN}/configs/cfg-legacy`))).data;
    const src: string = record.draft.mockups[0].src;
    expect(src).toBe(asset.deliveryUrl);
    const res = await call(pathAndQuery(src), { token: null });
    expect(res.status).toBe(200);
  });

  it('rejects a file whose bytes are not a supported image', async () => {
    const res = await call(`${ADMIN}/assets`, {
      method: 'POST',
      rawBody: new TextEncoder().encode('this is not an image'),
      headers: { 'Content-Type': 'image/png' }, // lying Content-Type
    });
    expect(res.status).toBe(415);
  });

  it('enforces asset ownership across tenants', async () => {
    const asset = (await json(await upload(STORE_A))).data;
    const other = await call(`${ADMIN}/assets/${asset.id}`, { storeId: STORE_B });
    expect(other.status).toBe(404);
    const otherContent = await call(`${ADMIN}/assets/${asset.id}/content`, { storeId: STORE_B });
    expect(otherContent.status).toBe(404);
  });

  it('refuses to delete an asset still referenced by a config, allows it otherwise', async () => {
    const asset = (await json(await upload())).data;

    // Reference the asset's delivery URL inside a saved config draft.
    await call(`${ADMIN}/configs`, {
      method: 'POST',
      body: {
        clientConfigId: 'cfg-ref',
        draft: sampleDraft({
          id: 'cfg-ref',
          mockups: [{ id: 'm1', name: 'Front', src: asset.deliveryUrl, placements: [] }],
        }),
      },
    });
    const blocked = await call(`${ADMIN}/assets/${asset.id}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);

    // Remove the reference, then delete succeeds.
    const current = (await json(await call(`${ADMIN}/configs/cfg-ref`))).data;
    await call(`${ADMIN}/configs/cfg-ref`, {
      method: 'PUT',
      body: { draft: sampleDraft({ id: 'cfg-ref' }), expectedUpdatedAt: current.updatedAt },
    });
    const ok = await call(`${ADMIN}/assets/${asset.id}`, { method: 'DELETE' });
    expect(ok.status).toBe(204);
    expect(sharedBucket.objects.has(asset.objectKey)).toBe(false);
  });

  it('is idempotent when re-uploading with the same clientRef (resumable migration)', async () => {
    const first = (await json(await upload(STORE_A, '?clientRef=idb:abc123'))).data;
    const second = (await json(await upload(STORE_A, '?clientRef=idb:abc123'))).data;
    expect(first.id).toBe(second.id);
    expect(sharedBucket.objects.size).toBe(1);
  });
});

describe('CORS', () => {
  it('answers preflight for an allowed origin', async () => {
    const res = await call(`${ADMIN}/configs`, {
      method: 'OPTIONS',
      token: null,
      origin: 'http://localhost:4200',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4200');
  });

  it('does not reflect a disallowed origin', async () => {
    const res = await call(`${ADMIN}/configs`, {
      method: 'OPTIONS',
      token: null,
      origin: 'http://evil.example',
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
