import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
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

describe('health & platform', () => {
  it('health is public and reports a healthy database', async () => {
    const res = await call('/api/v1/health', { token: null });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.status).toBe('ok');
    expect(body.data.checks.database).toBe('ok');
    // No secrets leaked.
    expect(JSON.stringify(body)).not.toContain('personalizer_local_dev');
  });

  it('lists plugins and the personalization plugin is available', async () => {
    const res = await call('/api/v1/plugins');
    expect(res.status).toBe(200);
    const body = await json(res);
    const ids = body.data.map((p: any) => p.pluginId);
    expect(ids).toContain('personalization');
  });

  it('reports plugin status for the store', async () => {
    // Touch a plugin route first so the dev auto-install happens.
    await call('/api/v1/plugins/personalization/configs');
    const res = await call('/api/v1/plugins/personalization/status');
    const body = await json(res);
    expect(body.data.pluginId).toBe('personalization');
    expect(body.data.enabledForStore).toBe(true);
  });
});

describe('authentication & authorization', () => {
  it('rejects an unauthenticated request to a protected route', async () => {
    const res = await call('/api/v1/plugins/personalization/configs', { token: null });
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.requestId).toBeTruthy();
  });
});

describe('configuration CRUD', () => {
  it('creates, reads, lists and updates with optimistic concurrency', async () => {
    const create = await call('/api/v1/plugins/personalization/configs', {
      method: 'POST',
      body: { clientConfigId: 'cfg-crud1', draft: sampleDraft({ id: 'cfg-crud1' }) },
    });
    expect(create.status).toBe(201);
    const created = (await json(create)).data;
    expect(created.id).toBe('cfg-crud1');
    expect(created.draft.product.name).toBe('Sample Tee');
    expect(created.published).toBeNull();

    const get = await call('/api/v1/plugins/personalization/configs/cfg-crud1');
    expect(get.status).toBe(200);

    const list = await call('/api/v1/plugins/personalization/configs');
    const listBody = await json(list);
    expect(listBody.data.length).toBe(1);
    expect(listBody.meta.pagination.total).toBe(1);

    // Correct concurrency token → success, updatedAt advances.
    const save = await call('/api/v1/plugins/personalization/configs/cfg-crud1', {
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
    const stale = await call('/api/v1/plugins/personalization/configs/cfg-crud1', {
      method: 'PUT',
      body: { draft: sampleDraft({ id: 'cfg-crud1' }), expectedUpdatedAt: created.updatedAt },
    });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.code).toBe('conflict');
  });

  it('is idempotent on repeated create with the same client id', async () => {
    const body = { clientConfigId: 'cfg-idem', draft: sampleDraft({ id: 'cfg-idem' }) };
    const first = (await json(await call('/api/v1/plugins/personalization/configs', { method: 'POST', body }))).data;
    const second = (await json(await call('/api/v1/plugins/personalization/configs', { method: 'POST', body }))).data;
    expect(first.id).toBe(second.id);
    const list = await json(await call('/api/v1/plugins/personalization/configs'));
    expect(list.data.length).toBe(1);
  });

  it('rejects an invalid draft with structured 422 issues', async () => {
    const res = await call('/api/v1/plugins/personalization/configs', {
      method: 'POST',
      body: { draft: sampleDraft({ product: { id: 'p' } }) }, // no name
    });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });

  it('duplicates, archives, restores and deletes', async () => {
    await call('/api/v1/plugins/personalization/configs', {
      method: 'POST',
      body: { clientConfigId: 'cfg-life', draft: sampleDraft({ id: 'cfg-life' }) },
    });

    const dup = await call('/api/v1/plugins/personalization/configs/cfg-life/duplicate', { method: 'POST' });
    expect(dup.status).toBe(201);
    const copy = (await json(dup)).data;
    expect(copy.id).not.toBe('cfg-life');
    expect(copy.draft.product.name).toContain('(copy)');

    await call('/api/v1/plugins/personalization/configs/cfg-life/archive', { method: 'POST' });
    const defaultList = await json(await call('/api/v1/plugins/personalization/configs'));
    expect(defaultList.data.find((r: any) => r.id === 'cfg-life')).toBeUndefined();
    const allList = await json(await call('/api/v1/plugins/personalization/configs?includeArchived=true'));
    expect(allList.data.find((r: any) => r.id === 'cfg-life')).toBeTruthy();

    await call('/api/v1/plugins/personalization/configs/cfg-life/restore', { method: 'POST' });
    const restored = await json(await call('/api/v1/plugins/personalization/configs'));
    expect(restored.data.find((r: any) => r.id === 'cfg-life')).toBeTruthy();

    const del = await call('/api/v1/plugins/personalization/configs/cfg-life', { method: 'DELETE' });
    expect(del.status).toBe(204);
    const gone = await call('/api/v1/plugins/personalization/configs/cfg-life');
    expect(gone.status).toBe(404);
  });
});

describe('publishing & versions', () => {
  it('refuses to publish an incomplete config but publishes a complete one', async () => {
    await call('/api/v1/plugins/personalization/configs', {
      method: 'POST',
      body: { clientConfigId: 'cfg-empty', draft: sampleDraft({ id: 'cfg-empty' }) },
    });
    const bad = await call('/api/v1/plugins/personalization/configs/cfg-empty/publish', { method: 'POST' });
    expect(bad.status).toBe(422);

    await call('/api/v1/plugins/personalization/configs', {
      method: 'POST',
      body: { clientConfigId: 'cfg-ok', draft: publishableDraft('cfg-ok') },
    });
    const pub = await call('/api/v1/plugins/personalization/configs/cfg-ok/publish', { method: 'POST' });
    expect(pub.status).toBe(200);
    const record = (await json(pub)).data;
    expect(record.published).toBeTruthy();
    expect(record.published.status).toBe('published');
    expect(record.draft.version).toBe(2); // draft carried on as next version

    const versions = await json(await call('/api/v1/plugins/personalization/configs/cfg-ok/versions'));
    expect(versions.data.length).toBe(1);
    const versionId = versions.data[0].versionId;
    const one = await json(await call(`/api/v1/plugins/personalization/configs/cfg-ok/versions/${versionId}`));
    expect(one.data.snapshot.status).toBe('published');
  });
});

describe('tenant isolation', () => {
  it('store B cannot read, update or delete store A configs', async () => {
    await call('/api/v1/plugins/personalization/configs', {
      storeId: STORE_A,
      method: 'POST',
      body: { clientConfigId: 'cfg-a', draft: sampleDraft({ id: 'cfg-a' }) },
    });
    // Store B: same id, different tenant → not found.
    const get = await call('/api/v1/plugins/personalization/configs/cfg-a', { storeId: STORE_B });
    expect(get.status).toBe(404);
    const del = await call('/api/v1/plugins/personalization/configs/cfg-a', { storeId: STORE_B, method: 'DELETE' });
    expect(del.status).toBe(404);
    // Store B's list is empty.
    const list = await json(await call('/api/v1/plugins/personalization/configs', { storeId: STORE_B }));
    expect(list.data.length).toBe(0);
  });
});

describe('R2 asset flow', () => {
  async function upload(storeId = STORE_A, query = '') {
    return call(`/api/v1/plugins/personalization/assets${query}`, {
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
    expect(asset.deliveryUrl).toContain(`/assets/${asset.id}/content`);
    expect(sharedBucket.objects.has(asset.objectKey)).toBe(true);
    // Stored under this store's folder for this plugin.
    expect(asset.objectKey).toMatch(
      new RegExp(`^stores/${STORE_A}/product-personalization/assets/[0-9a-f-]{36}\\.png$`),
    );

    const content = await call(`/api/v1/plugins/personalization/assets/${asset.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('Content-Type')).toBe('image/png');
    const bytes = new Uint8Array(await content.arrayBuffer());
    expect(bytes.byteLength).toBe(tinyPng().byteLength);

    const list = await json(await call('/api/v1/plugins/personalization/assets'));
    expect(list.data.length).toBe(1);
  });

  it('rejects a file whose bytes are not a supported image', async () => {
    const res = await call('/api/v1/plugins/personalization/assets', {
      method: 'POST',
      rawBody: new TextEncoder().encode('this is not an image'),
      headers: { 'Content-Type': 'image/png' }, // lying Content-Type
    });
    expect(res.status).toBe(415);
  });

  it('enforces asset ownership across tenants', async () => {
    const asset = (await json(await upload(STORE_A))).data;
    const other = await call(`/api/v1/plugins/personalization/assets/${asset.id}`, { storeId: STORE_B });
    expect(other.status).toBe(404);
    const otherContent = await call(`/api/v1/plugins/personalization/assets/${asset.id}/content`, { storeId: STORE_B });
    expect(otherContent.status).toBe(404);
  });

  it('refuses to delete an asset still referenced by a config, allows it otherwise', async () => {
    const asset = (await json(await upload())).data;

    // Reference the asset's delivery URL inside a saved config draft.
    await call('/api/v1/plugins/personalization/configs', {
      method: 'POST',
      body: {
        clientConfigId: 'cfg-ref',
        draft: sampleDraft({
          id: 'cfg-ref',
          mockups: [{ id: 'm1', name: 'Front', src: asset.deliveryUrl, placements: [] }],
        }),
      },
    });
    const blocked = await call(`/api/v1/plugins/personalization/assets/${asset.id}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);

    // Remove the reference, then delete succeeds.
    const current = (await json(await call('/api/v1/plugins/personalization/configs/cfg-ref'))).data;
    await call('/api/v1/plugins/personalization/configs/cfg-ref', {
      method: 'PUT',
      body: { draft: sampleDraft({ id: 'cfg-ref' }), expectedUpdatedAt: current.updatedAt },
    });
    const ok = await call(`/api/v1/plugins/personalization/assets/${asset.id}`, { method: 'DELETE' });
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
    const res = await call('/api/v1/plugins/personalization/configs', {
      method: 'OPTIONS',
      token: null,
      origin: 'http://localhost:4200',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4200');
  });

  it('does not reflect a disallowed origin', async () => {
    const res = await call('/api/v1/plugins/personalization/configs', {
      method: 'OPTIONS',
      token: null,
      origin: 'http://evil.example',
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
