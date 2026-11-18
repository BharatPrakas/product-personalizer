import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  STOREFRONT,
  STORE_A,
  STORE_B,
  applyMigrations,
  OTHER_PLUGIN_SECRET,
  TEST_PLUGIN_SECRET,
  call,
  json,
  makeEnv,
  publishableDraft,
  resetBucket,
  sampleDraft,
  sharedBucket,
  signJwt,
  tinyFont,
  tinyPng,
  truncateAll,
} from './helpers';
import { deriveWebhookKey } from '../src/modules/zenbasket-auth/plugin-secret';
import type { Env } from '../src/config/environment';

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

/** Variables the Worker no longer reads. Passing them must change nothing; typed loosely on purpose. */
const removedVars = (vars: Record<string, string | undefined>) => vars as unknown as Partial<Env>;

describe('authentication & authorization', () => {
  it('rejects an unauthenticated request to a protected route', async () => {
    const res = await call(`${ADMIN}/configs`, { token: null });
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.requestId).toBeTruthy();
  });

  describe('merchant token (HS256, signed with the plugin secret; { storeId, pluginId, iat, exp })', () => {
    const zbToken = signJwt;
    const get = (token: string, env: Partial<Env> = {}) => call(`${ADMIN}/configs`, { token, env });

    it('accepts the token shape the backend issues ({ storeId: <number>, pluginId, iat, exp })', async () => {
      const token = await zbToken({ storeId: 766, pluginId: 160 });
      expect((await get(token)).status).toBe(200);
    });

    it('treats the numeric claim and the same id as a string as one store', async () => {
      const numeric = await zbToken({ storeId: 766 });
      const text = await zbToken({ storeId: '766' });
      const create = await call(`${ADMIN}/configs`, {
        method: 'POST', token: numeric,
        body: { clientConfigId: 'cfg-numeric-claim', draft: sampleDraft({ id: 'cfg-numeric-claim' }) },
      });
      expect(create.status).toBe(201);
      expect((await call(`${ADMIN}/configs/cfg-numeric-claim`, { token: text })).status).toBe(200);
      // A token for another store never reaches this store's data.
      const other = await zbToken({ storeId: 767 });
      expect((await call(`${ADMIN}/configs/cfg-numeric-claim`, { token: other })).status).toBe(404);
    });

    it('takes the store ONLY from the signed claim, never from a header, query string or body', async () => {
      await call(`${ADMIN}/configs`, {
        method: 'POST', storeId: STORE_B,
        body: { clientConfigId: 'cfg-of-b', draft: sampleDraft({ id: 'cfg-of-b' }) },
      });
      const asA = await zbToken({ storeId: STORE_A });
      const res = await call(`${ADMIN}/configs/cfg-of-b?storeId=${STORE_B}&store_id=${STORE_B}`, {
        token: asA, headers: { 'X-Store-Id': STORE_B, 'X-ZB-Store-Id': STORE_B },
      });
      expect(res.status).toBe(404);
    });

    it.each([[0], [-1], [1.5], [null], [''], [{ id: 1 }]])('rejects a token whose storeId claim is %j', async (storeId) => {
      expect((await get(await zbToken({ storeId }))).status).toBe(401);
    });

    it('does not read the legacy `store_id` claim: a token that only carries it names no store', async () => {
      const token = await zbToken({ storeId: undefined, store_id: 'store_legacy' });
      const res = await get(token);
      expect(res.status).toBe(401);
      expect((await json(res)).error.message).toMatch(/does not identify a store/);
    });

    it('rejects a token signed with another secret and an expired one', async () => {
      expect((await get(await zbToken({}, OTHER_PLUGIN_SECRET))).status).toBe(401);
      const iat = Math.floor(Date.now() / 1000);
      expect((await get(await zbToken({ iat: iat - 7200, exp: iat - 3600 }))).status).toBe(401);
    });

    it.each([
      ['exp', /no expiry/],
      ['iat', /no issue time/],
    ])('rejects a validly signed token with no %s claim', async (missing, message) => {
      const iat = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = { storeId: 766, pluginId: 160, iat, exp: iat + 600 };
      delete claims[missing];
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const head = enc({ alg: 'HS256', typ: 'JWT' });
      const body = enc(claims);
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TEST_PLUGIN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = Buffer.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${head}.${body}`)))).toString('base64url');
      const res = await get(`${head}.${body}.${sig}`);
      expect(res.status).toBe(401);
      expect((await json(res)).error.message).toMatch(message);
    });

    describe('plugin binding: a token must be issued for THIS plugin', () => {
      it('accepts the plugin id as a number or as the same id in a string', async () => {
        expect((await get(await zbToken({ pluginId: 160 }))).status).toBe(200);
        expect((await get(await zbToken({ pluginId: '160' }))).status).toBe(200);
      });

      it.each([[161], ['161'], [0], [-160], [160.5], [null], [{ id: 160 }], ['']])(
        'rejects a token issued for plugin %j',
        async (pluginId) => {
          const res = await get(await zbToken({ pluginId }));
          expect(res.status).toBe(401);
          expect((await json(res)).error.message).toMatch(/not issued for this plugin/);
        },
      );

      it('rejects a validly signed token with no pluginId claim at all', async () => {
        expect((await get(await zbToken({ pluginId: undefined }))).status).toBe(401);
      });

      it('fails closed while ZB_PLUGIN_ID is not configured', async () => {
        const token = await zbToken({});
        expect((await get(token, { ZB_PLUGIN_ID: undefined })).status).toBe(401);
        expect((await get(token, { ZB_PLUGIN_ID: '   ' })).status).toBe(401);
      });
    });

    describe('fails closed when the plugin secret is missing or invalid', () => {
      it.each([
        ['missing', undefined],
        ['empty', ''],
        ['shorter than 32 characters', 'too-short-to-be-real'],
      ])('401s every token when ZB_PLUGIN_SECRET is %s — even one signed with that very value', async (_label, secret) => {
        const token = await zbToken({}, secret || 'x');
        const res = await get(token, { ZB_PLUGIN_SECRET: secret });
        expect(res.status).toBe(401);
        expect((await json(res)).error.message).toMatch(/not configured/);
      });
    });

    describe('there is exactly one verification key: no fallback, no overlap, no second secret', () => {
      const legacy = 'legacy-shared-jwt-secret-0123456789abcdef0123';

      it('ignores the legacy JWT_SIGNING_SECRET entirely, with or without the plugin secret', async () => {
        const token = await zbToken({}, legacy);
        expect((await get(token, removedVars({ JWT_SIGNING_SECRET: legacy }))).status).toBe(401);
        expect((await get(token, { ...removedVars({ JWT_SIGNING_SECRET: legacy }), ZB_PLUGIN_SECRET: undefined })).status).toBe(401);
      });

      it('ignores ZB_PLUGIN_SECRET_PREVIOUS: a token signed with an "old" secret is simply a bad signature', async () => {
        const old = await zbToken({}, OTHER_PLUGIN_SECRET);
        expect((await get(old, removedVars({ ZB_PLUGIN_SECRET_PREVIOUS: OTHER_PLUGIN_SECRET }))).status).toBe(401);
      });

      it('ignores ZB_JWT_KEY_MODE: only the plugin secret itself verifies, never a derived key', async () => {
        const withDerivedKey = await zbToken({}, await deriveWebhookKey(TEST_PLUGIN_SECRET));
        for (const mode of [undefined, 'root', 'derived']) {
          const env = removedVars({ ZB_JWT_KEY_MODE: mode });
          expect((await get(await zbToken({}), env)).status, String(mode)).toBe(200);
          expect((await get(withDerivedKey, env)).status, String(mode)).toBe(401);
        }
      });
    });

    describe('a webhook credential is not a merchant credential', () => {
      it('a token signed with the order-webhook key is rejected', async () => {
        expect((await get(await zbToken({}, await deriveWebhookKey(TEST_PLUGIN_SECRET)))).status).toBe(401);
      });

      it('a webhook-style signature presented as a Bearer token is rejected', async () => {
        expect((await get('v1=67bf6aafeb509fdb25be8538101e719bead8c81927071a53635edde67dacbec9')).status).toBe(401);
      });
    });

    it('accepts only alg HS256 even with a matching MAC', async () => {
      const iat = Math.floor(Date.now() / 1000);
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const head = enc({ alg: 'HS512', typ: 'JWT' });
      const body = enc({ storeId: 766, pluginId: 160, iat, exp: iat + 600 });
      const { createHmac } = await import('node:crypto');
      const sig = createHmac('sha512', TEST_PLUGIN_SECRET).update(`${head}.${body}`).digest('base64url');
      expect((await get(`${head}.${body}.${sig}`)).status).toBe(401);
    });
  });

  describe('there is no development authentication', () => {
    const devToken = 'zb-local-dev-token';

    it.each(['development', 'staging', 'production'])(
      'a static DEV_AUTH_TOKEN + DEV_STORE_ID is not a credential (ENVIRONMENT=%s)',
      async (environment) => {
        const res = await call(`${ADMIN}/configs`, {
          token: devToken,
          env: { ENVIRONMENT: environment, ...removedVars({ DEV_AUTH_TOKEN: devToken, DEV_STORE_ID: STORE_A }) },
        });
        expect(res.status).toBe(401);
      },
    );

    it.each(['development', 'staging', 'production'])(
      'DEV_AUTH_BYPASS=true does not let an unauthenticated request through (ENVIRONMENT=%s)',
      async (environment) => {
        const env = { ENVIRONMENT: environment, ...removedVars({ DEV_AUTH_BYPASS: 'true', DEV_STORE_ID: STORE_A }) };
        expect((await call(`${ADMIN}/configs`, { token: null, env })).status).toBe(401);
        expect((await call(`${ADMIN}/configs`, { token: 'not-a-real-token-at-all', env })).status).toBe(401);
      },
    );

    it('the Worker has no code path that reads the dev variables', async () => {
      const { loadConfig } = await import('../src/config/environment');
      const config = loadConfig({
        ...makeEnv(),
        ...removedVars({ DEV_AUTH_TOKEN: 'x', DEV_STORE_ID: 'y', DEV_AUTH_BYPASS: 'true' }),
      } as Env);
      expect(Object.keys(config).filter((k) => /dev/i.test(k))).toEqual([]);
    });
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

  it('lets any origin load the delivery URL cross-origin, with a credential-free wildcard', async () => {
    const asset = (await json(await upload())).data;
    const url = pathAndQuery(asset.deliveryUrl);

    for (const origin of ['http://localhost:4200', 'http://evil.example']) {
      const res = await call(url, { token: null, origin });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.has('Access-Control-Allow-Credentials')).toBe(false);
    }

    const preflight = await call(url, { method: 'OPTIONS', token: null, origin: 'http://localhost:4200' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
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

describe('custom font uploads (store-wide, same pipeline as images)', () => {
  async function uploadFont(bytes = tinyFont('woff2'), contentType = 'font/woff2') {
    return call(`${ADMIN}/assets`, {
      method: 'POST',
      rawBody: bytes,
      headers: { 'Content-Type': contentType },
      storeId: STORE_A,
    });
  }

  it('accepts WOFF2/WOFF/TTF/OTF, storing content-based type and no dimensions', async () => {
    for (const [format, type] of [
      ['woff2', 'font/woff2'],
      ['woff', 'font/woff'],
      ['ttf', 'font/ttf'],
      ['otf', 'font/otf'],
    ] as const) {
      const res = await uploadFont(tinyFont(format));
      expect(res.status, format).toBe(201);
      const asset = (await json(res)).data;
      expect(asset.contentType).toBe(type);
      expect(asset.width).toBeNull();
      expect(asset.height).toBeNull();
      expect(asset.objectKey).toMatch(new RegExp(`\\.${format}$`));
    }
  });

  it('is never confused with an image: a declared image/* Content-Type does not change the sniffed type', async () => {
    const res = await uploadFont(tinyFont('woff2'), 'image/png'); // lying Content-Type
    expect(res.status).toBe(201);
    expect((await json(res)).data.contentType).toBe('font/woff2');
  });

  it('rejects bytes that are neither an image nor a font', async () => {
    const res = await uploadFont(new TextEncoder().encode('not a font or image'), 'font/woff2');
    expect(res.status).toBe(415);
  });

  it('is served through the same signed delivery URL as an image, with the font Content-Type', async () => {
    const asset = (await json(await uploadFont())).data;
    const res = await call(new URL(asset.deliveryUrl).pathname + new URL(asset.deliveryUrl).search, { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('font/woff2');
  });

  it('lists fonts separately from images with ?kind=font, and images are unaffected by it', async () => {
    const font = (await json(await uploadFont())).data;
    const image = (await json(await call(`${ADMIN}/assets`, { method: 'POST', storeId: STORE_A, rawBody: tinyPng(), headers: { 'Content-Type': 'image/png' } }))).data;

    const fonts = await json(await call(`${ADMIN}/assets?kind=font`));
    expect(fonts.data.map((a: { id: string }) => a.id)).toEqual([font.id]);

    const images = await json(await call(`${ADMIN}/assets?kind=image`));
    expect(images.data.map((a: { id: string }) => a.id)).toEqual([image.id]);

    const all = await json(await call(`${ADMIN}/assets`));
    expect(all.data.map((a: { id: string }) => a.id).sort()).toEqual([font.id, image.id].sort());
  });

  it('is store-scoped like every other asset', async () => {
    await uploadFont();
    expect((await json(await call(`${ADMIN}/assets?kind=font`, { storeId: STORE_B }))).data).toEqual([]);
  });

  it('can be deleted once nothing references it, and is blocked while a config uses it (same rule as images)', async () => {
    const font = (await json(await uploadFont())).data;
    await call(`${ADMIN}/configs`, {
      method: 'POST',
      body: {
        clientConfigId: 'cfg-font-ref',
        draft: sampleDraft({
          id: 'cfg-font-ref',
          fonts: [{ id: 'custom', family: 'Custom', src: font.deliveryUrl, label: 'Custom' }],
        }),
      },
    });
    expect((await call(`${ADMIN}/assets/${font.id}`, { method: 'DELETE' })).status).toBe(409);

    await call(`${ADMIN}/configs/cfg-font-ref`, { method: 'DELETE' });
    const deleted = await call(`${ADMIN}/assets/${font.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(sharedBucket.objects.has(font.objectKey)).toBe(false);
  });

  it('lists a store’s custom fonts filtered by ?configId= the same way images already do (the pre-existing listAssets bug is fixed)', async () => {
    await call(`${ADMIN}/configs`, { method: 'POST', body: { clientConfigId: 'cfg-a', draft: sampleDraft({ id: 'cfg-a' }) } });
    const font = (await json(await call(`${ADMIN}/assets?configId=cfg-a`, { method: 'POST', storeId: STORE_A, rawBody: tinyFont(), headers: { 'Content-Type': 'font/woff2' } }))).data;
    await uploadFont(); // a second, unrelated font not tied to any config

    const scoped = await json(await call(`${ADMIN}/assets?configId=cfg-a`));
    expect(scoped.data.map((a: { id: string }) => a.id)).toEqual([font.id]);
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
