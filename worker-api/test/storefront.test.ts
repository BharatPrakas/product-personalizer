import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { InMemoryRateLimitStore } from '../src/shared/rate-limit';
import {
  ADMIN,
  STOREFRONT,
  STORE_A,
  STORE_B,
  applyMigrations,
  call,
  json,
  mapTo,
  publishableDraft,
  publish,
  resetBucket,
  seedDraft,
  seedPublished,
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

const cfgUrl = (externalId: string, storeId: string, extra = '') =>
  `${STOREFRONT}/products/${encodeURIComponent(externalId)}/config?storeId=${encodeURIComponent(storeId)}${extra}`;

/** Public call: no merchant token. */
const pub = (path: string, options: Parameters<typeof call>[1] = {}) => call(path, { token: null, ...options });

async function data(res: Response): Promise<any> {
  return (await json(res)).data;
}

describe('storefront config resolution', () => {
  it('serves the mapped published config with the documented shape', async () => {
    await seedPublished('cfg-s1');
    await mapTo('cfg-s1', 'product', 'prod-1');
    const res = await pub(cfgUrl('prod-1', STORE_A));
    expect(res.status).toBe(200);
    const d = await data(res);
    expect(d).toMatchObject({ personalizable: true, configId: 'cfg-s1', version: 1, scope: 'product', externalId: 'prod-1' });
    expect(d.config.status).toBe('published');
    expect(d.config.product.name).toBe('Publishable Tee');
    expect(d.config.mockups[0].src).toBe('https://cdn.test/m1.png');
    // assetBaseUrl ('assets/' in the fixture) is dropped: every reference is absolute now.
    expect(d.config.assetBaseUrl).toBeUndefined();
  });

  it('returns personalizable:false (200) when nothing is mapped', async () => {
    await seedPublished('cfg-s2');
    const res = await pub(cfgUrl('prod-unmapped', STORE_A));
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ personalizable: false });
  });

  it('applies variant > product > collection precedence', async () => {
    for (const id of ['cfg-var', 'cfg-prod', 'cfg-col']) await seedPublished(id);
    await mapTo('cfg-col', 'collection', 'col-1');
    await mapTo('cfg-prod', 'product', 'prod-9');
    await mapTo('cfg-var', 'variant', 'var-9');

    const all = await data(await pub(cfgUrl('prod-9', STORE_A, '&variantId=var-9&collectionIds=col-1')));
    expect(all).toMatchObject({ configId: 'cfg-var', scope: 'variant', externalId: 'var-9' });
    const noVariant = await data(await pub(cfgUrl('prod-9', STORE_A, '&collectionIds=col-1')));
    expect(noVariant).toMatchObject({ configId: 'cfg-prod', scope: 'product' });
    const otherVariant = await data(await pub(cfgUrl('prod-9', STORE_A, '&variantId=var-unmapped')));
    expect(otherVariant).toMatchObject({ configId: 'cfg-prod' });
    const onlyCollection = await data(await pub(cfgUrl('prod-other', STORE_A, '&collectionIds=x,%20col-1,')));
    expect(onlyCollection).toMatchObject({ configId: 'cfg-col', scope: 'collection', externalId: 'col-1' });
  });

  it('picks the earliest-created matching collection mapping deterministically', async () => {
    await seedPublished('cfg-c-first');
    await seedPublished('cfg-c-second');
    await mapTo('cfg-c-first', 'collection', 'col-a');
    await new Promise((r) => setTimeout(r, 5));
    await mapTo('cfg-c-second', 'collection', 'col-b');
    // The result must not depend on the order of ids in the query.
    for (const ids of ['col-a,col-b', 'col-b,col-a']) {
      const d = await data(await pub(cfgUrl('p', STORE_A, `&collectionIds=${ids}`)));
      expect(d.configId).toBe('cfg-c-first');
    }
  });

  it('limits collectionIds to 20 and validates the query', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `c${i}`).join(',');
    expect((await pub(cfgUrl('p', STORE_A, `&collectionIds=${ids}`))).status).toBe(400);
    expect((await pub(`${STOREFRONT}/products/p/config`)).status).toBe(422); // storeId is required
    expect((await pub(cfgUrl('x'.repeat(201), STORE_A))).status).toBe(400);
  });

  it('does not serve draft-only (never published) configs', async () => {
    await seedDraft('cfg-draft');
    await mapTo('cfg-draft', 'product', 'prod-draft');
    expect(await data(await pub(cfgUrl('prod-draft', STORE_A)))).toEqual({ personalizable: false });
    await publish('cfg-draft');
    expect((await data(await pub(cfgUrl('prod-draft', STORE_A)))).personalizable).toBe(true);
  });

  it('falls through a draft-only higher-precedence mapping to the next published one', async () => {
    await seedDraft('cfg-vdraft');
    await seedPublished('cfg-pub');
    await mapTo('cfg-vdraft', 'variant', 'v1');
    await mapTo('cfg-pub', 'product', 'p1');
    const d = await data(await pub(cfgUrl('p1', STORE_A, '&variantId=v1')));
    expect(d.configId).toBe('cfg-pub');
  });

  it('does not serve archived configs, and serves them again once restored', async () => {
    await seedPublished('cfg-arch');
    await mapTo('cfg-arch', 'product', 'prod-arch');
    expect((await data(await pub(cfgUrl('prod-arch', STORE_A)))).personalizable).toBe(true);
    await call(`${ADMIN}/configs/cfg-arch/archive`, { method: 'POST' });
    expect(await data(await pub(cfgUrl('prod-arch', STORE_A)))).toEqual({ personalizable: false });
    await call(`${ADMIN}/configs/cfg-arch/restore`, { method: 'POST' });
    expect((await data(await pub(cfgUrl('prod-arch', STORE_A)))).personalizable).toBe(true);
  });

  it('serves the latest published snapshot, never the draft', async () => {
    await seedPublished('cfg-ver');
    await mapTo('cfg-ver', 'product', 'prod-ver');
    const v1 = await data(await pub(cfgUrl('prod-ver', STORE_A)));
    expect(v1.version).toBe(1);

    // Edit the draft without publishing: the storefront must not change.
    let rec = (await json(await call(`${ADMIN}/configs/cfg-ver`))).data;
    const edited = (name: string) => ({
      ...rec.draft,
      product: { ...rec.draft.product, name },
    });
    let put = await call(`${ADMIN}/configs/cfg-ver`, {
      method: 'PUT',
      body: { draft: edited('DRAFT ONLY NAME'), expectedUpdatedAt: rec.updatedAt },
    });
    rec = (await json(put)).data;
    const stillV1 = await data(await pub(cfgUrl('prod-ver', STORE_A)));
    expect(stillV1.version).toBe(1);
    expect(stillV1.config.product.name).toBe('Publishable Tee');
    expect(JSON.stringify(stillV1)).not.toContain('DRAFT ONLY NAME');

    // Re-publish: version 2 with the new content is served.
    put = await call(`${ADMIN}/configs/cfg-ver/publish`, { method: 'POST' });
    expect(put.status).toBe(200);
    const v2 = await data(await pub(cfgUrl('prod-ver', STORE_A)));
    expect(v2.version).toBe(2);
    expect(v2.config.product.name).toBe('DRAFT ONLY NAME');
  });

  it('stops serving after a mapping is removed or its config deleted', async () => {
    await seedPublished('cfg-gone');
    const m = (await json(await mapTo('cfg-gone', 'product', 'prod-gone'))).data;
    await call(`${ADMIN}/mappings/${m.id}`, { method: 'DELETE' });
    expect((await data(await pub(cfgUrl('prod-gone', STORE_A)))).personalizable).toBe(false);
    await mapTo('cfg-gone', 'product', 'prod-gone');
    await call(`${ADMIN}/configs/cfg-gone`, { method: 'DELETE' });
    expect((await data(await pub(cfgUrl('prod-gone', STORE_A)))).personalizable).toBe(false);
  });
});

describe('storefront tenancy and unknown stores', () => {
  it('never returns store A data for store B (or an unknown key)', async () => {
    await seedPublished('cfg-ta', STORE_A);
    await mapTo('cfg-ta', 'product', 'same-product', STORE_A);
    await seedPublished('cfg-tb', STORE_B);

    expect(await data(await pub(cfgUrl('same-product', STORE_B)))).toEqual({ personalizable: false });
    expect(await data(await pub(cfgUrl('same-product', 'store_nobody')))).toEqual({ personalizable: false });

    // When B maps the same external id, B gets B's config and A still gets A's.
    await mapTo('cfg-tb', 'product', 'same-product', STORE_B);
    expect((await data(await pub(cfgUrl('same-product', STORE_B)))).configId).toBe('cfg-tb');
    expect((await data(await pub(cfgUrl('same-product', STORE_A)))).configId).toBe('cfg-ta');
  });

  it('answers unknown, malformed and probing keys identically with personalizable:false', async () => {
    await seedPublished('cfg-u', STORE_A);
    await mapTo('cfg-u', 'product', 'prod-u');
    const known = await pub(cfgUrl('nothing', STORE_A));
    const unknown = await pub(cfgUrl('prod-u', 'store_does_not_exist'));
    const weird = await pub(cfgUrl('prod-u', "x' OR '1'='1"));
    const traversal = await pub(cfgUrl('prod-u', '../store_alpha'));
    for (const res of [known, unknown, weird, traversal]) {
      expect(res.status).toBe(200);
      expect(await data(res)).toEqual({ personalizable: false });
    }
    expect(unknown.headers.get('etag')).toBe(known.headers.get('etag'));
  });

  it('does not serve a store whose plugin is not enabled', async () => {
    await seedPublished('cfg-off', STORE_A);
    await mapTo('cfg-off', 'product', 'prod-off');
    await (await import('./helpers')).queryDb(
      `UPDATE platform.store_plugins SET status = 'disabled' WHERE store_id = $1`,
      [STORE_A],
    );
    expect(await data(await pub(cfgUrl('prod-off', STORE_A)))).toEqual({ personalizable: false });
  });
});

describe('storefront caching', () => {
  it('sets cache headers, Vary and a strong ETag, and honours If-None-Match', async () => {
    await seedPublished('cfg-etag');
    await mapTo('cfg-etag', 'product', 'prod-etag');
    const res = await pub(cfgUrl('prod-etag', STORE_A));
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    expect(res.headers.get('vary')).toContain('Origin');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const etag = res.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    // Body is byte-stable (no per-request ids) and the ETag is its hash.
    const body = await res.text();
    expect(body).not.toContain('requestId');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    expect(etag).toBe(`"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}"`);

    const again = await pub(cfgUrl('prod-etag', STORE_A));
    expect(again.headers.get('etag')).toBe(etag);

    const cond = await pub(cfgUrl('prod-etag', STORE_A), { headers: { 'If-None-Match': etag } });
    expect(cond.status).toBe(304);
    expect(await cond.text()).toBe('');
    expect(cond.headers.get('etag')).toBe(etag);
    expect(cond.headers.get('cache-control')).toContain('s-maxage=300');

    const weak = await pub(cfgUrl('prod-etag', STORE_A), { headers: { 'If-None-Match': `"nope", W/${etag}` } });
    expect(weak.status).toBe(304);
    const stale = await pub(cfgUrl('prod-etag', STORE_A), { headers: { 'If-None-Match': '"stale"' } });
    expect(stale.status).toBe(200);

    // Re-publishing changes the representation, so the old validator no longer matches.
    await call(`${ADMIN}/configs/cfg-etag/publish`, { method: 'POST' });
    const after = await pub(cfgUrl('prod-etag', STORE_A), { headers: { 'If-None-Match': etag } });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(etag);
  });

  it('uses a shorter cache for personalizable:false', async () => {
    const res = await pub(cfgUrl('whatever', STORE_A));
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('public');
    expect(cc).not.toContain('s-maxage=300');
    expect(cc).toMatch(/max-age=\d+/);
    const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1]);
    expect(maxAge).toBeLessThan(60);
    expect(res.headers.get('vary')).toContain('Origin');
  });
});

describe('storefront CORS (per store)', () => {
  async function seedMapped(store = STORE_A): Promise<void> {
    await seedPublished('cfg-cors', store);
    await mapTo('cfg-cors', 'product', 'prod-cors', store);
  }
  const allow = (origins: string[], storeId = STORE_A) =>
    call(`${ADMIN}/settings/storefront`, { method: 'PUT', storeId, body: { storefrontOrigins: origins } });

  it('allows no cross-origin access when the store has no allowed origins', async () => {
    await seedMapped();
    // Not even the globally allowed ADMIN origin may use the public route.
    for (const origin of ['http://localhost:4200', 'https://shop.example.com']) {
      const res = await pub(cfgUrl('prod-cors', STORE_A), { origin });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('vary')).toContain('Origin');
    }
  });

  it('reflects only origins on the store list', async () => {
    await seedMapped();
    await allow(['https://shop.example.com']);
    const ok = await pub(cfgUrl('prod-cors', STORE_A), { origin: 'https://shop.example.com' });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
    expect(ok.headers.get('vary')).toContain('Origin');
    const other = await pub(cfgUrl('prod-cors', STORE_A), { origin: 'https://evil.example' });
    expect(other.status).toBe(200);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const noOrigin = await pub(cfgUrl('prod-cors', STORE_A));
    expect(noOrigin.headers.get('access-control-allow-origin')).toBeNull();

    // 304 responses keep the CORS headers.
    const etag = ok.headers.get('etag') ?? '';
    const cond = await pub(cfgUrl('prod-cors', STORE_A), {
      origin: 'https://shop.example.com',
      headers: { 'If-None-Match': etag },
    });
    expect(cond.status).toBe(304);
    expect(cond.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
  });

  it('keeps one store origin list from granting access to another store', async () => {
    await seedMapped(STORE_A);
    await seedMapped(STORE_B);
    await allow(['https://shop-a.example'], STORE_A);
    const forB = await pub(cfgUrl('prod-cors', STORE_B), { origin: 'https://shop-a.example' });
    expect(forB.headers.get('access-control-allow-origin')).toBeNull();
    const forA = await pub(cfgUrl('prod-cors', STORE_A), { origin: 'https://shop-a.example' });
    expect(forA.headers.get('access-control-allow-origin')).toBe('https://shop-a.example');
  });

  it('answers preflight from the store list and gives unknown stores nothing', async () => {
    await seedMapped();
    await allow(['https://shop.example.com']);
    const ok = await pub(cfgUrl('prod-cors', STORE_A), { method: 'OPTIONS', origin: 'https://shop.example.com' });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
    expect(ok.headers.get('access-control-allow-methods')).toContain('GET');
    const bad = await pub(cfgUrl('prod-cors', STORE_A), { method: 'OPTIONS', origin: 'https://evil.example' });
    expect(bad.status).toBe(204);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const unknown = await pub(cfgUrl('prod-cors', 'store_unknown'), { method: 'OPTIONS', origin: 'https://shop.example.com' });
    expect(unknown.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('leaves the admin CORS allow-list untouched', async () => {
    const res = await call(`${ADMIN}/configs`, { method: 'OPTIONS', token: null, origin: 'http://localhost:4200' });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4200');
  });
});

describe('storefront rate limiting', () => {
  it('returns 429 with Retry-After after the per-store+IP budget, then recovers', async () => {
    let now = 1_000_000;
    const application = createApp(undefined, { rateLimitStore: new InMemoryRateLimitStore(), now: () => now });
    const env = { STOREFRONT_RATE_LIMIT: '3', STOREFRONT_RATE_WINDOW_SECONDS: '60' };
    const hit = (store: string, ip: string) =>
      pub(cfgUrl('p', store), { application, env, headers: { 'CF-Connecting-IP': ip } });

    for (let i = 0; i < 3; i++) expect((await hit(STORE_A, '203.0.113.1')).status).toBe(200);
    const limited = await hit(STORE_A, '203.0.113.1');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect((await json(limited)).error.code).toBe('rate_limited');

    // Another client and another store each have their own budget.
    expect((await hit(STORE_A, '203.0.113.2')).status).toBe(200);
    expect((await hit(STORE_B, '203.0.113.1')).status).toBe(200);

    // After the window the budget is restored.
    now += 61_000;
    expect((await hit(STORE_A, '203.0.113.1')).status).toBe(200);
  });

  it('also protects the asset route', async () => {
    const application = createApp(undefined, { rateLimitStore: new InMemoryRateLimitStore() });
    const env = { STOREFRONT_RATE_LIMIT: '1' }; // assets get 5x
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await pub(`${STOREFRONT}/assets/00000000-0000-4000-8000-000000000000`, { application, env });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe('storefront assets', () => {
  async function upload(storeId: string = STORE_A, env?: Record<string, string>): Promise<any> {
    const res = await call(`${ADMIN}/assets?filename=m.png`, {
      method: 'POST',
      storeId,
      env,
      rawBody: tinyPng(),
      headers: { 'Content-Type': 'image/png' },
    });
    expect(res.status).toBe(201);
    return (await json(res)).data;
  }

  const draftWith = (id: string, src: string, extra: Record<string, unknown> = {}) => ({
    ...publishableDraft(id),
    mockups: [{ id: 'm1', name: 'Front', src, thumbnail: src, placements: [], ...extra }],
  });

  it('rewrites Worker-managed asset references to public absolute URLs and serves them without a token', async () => {
    const asset = await upload();
    await seedPublished('cfg-asset', STORE_A, draftWith('cfg-asset', asset.deliveryUrl));
    await mapTo('cfg-asset', 'product', 'prod-asset');
    await call(`${ADMIN}/settings/storefront`, { method: 'PUT', body: { storefrontOrigins: ['https://shop.example.com'] } });

    const d = await data(await pub(cfgUrl('prod-asset', STORE_A)));
    const expected = `http://api.test/api/v1/storefront/personalization/assets/${asset.id}`;
    expect(d.config.mockups[0].src).toBe(expected);
    expect(d.config.mockups[0].thumbnail).toBe(expected);
    expect(JSON.stringify(d)).not.toContain('/plugins/personalization/assets');

    const path = new URL(expected).pathname;
    const img = await pub(path, { origin: 'https://shop.example.com' });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('cache-control')).toContain('public');
    expect(img.headers.get('cache-control')).toContain('s-maxage=');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(img.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
    expect(img.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(tinyPng());

    const etag = img.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const cond = await pub(path, { headers: { 'If-None-Match': etag } });
    expect(cond.status).toBe(304);
    // A foreign origin gets the bytes but no CORS grant.
    const foreign = await pub(path, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves assets only while a PUBLISHED, non-archived config references them', async () => {
    const asset = await upload();
    const url = `${STOREFRONT}/assets/${asset.id}`;
    // Uploaded but unreferenced.
    expect((await pub(url)).status).toBe(404);

    // Referenced only by a DRAFT.
    await seedDraft('cfg-ad', STORE_A, draftWith('cfg-ad', asset.deliveryUrl));
    expect((await pub(url)).status).toBe(404);

    // Published -> served.
    await publish('cfg-ad');
    expect((await pub(url)).status).toBe(200);

    // Archived -> not served.
    await call(`${ADMIN}/configs/cfg-ad/archive`, { method: 'POST' });
    expect((await pub(url)).status).toBe(404);
    await call(`${ADMIN}/configs/cfg-ad/restore`, { method: 'POST' });
    expect((await pub(url)).status).toBe(200);

    // A malformed id is just a 404.
    expect((await pub(`${STOREFRONT}/assets/not-a-uuid`)).status).toBe(404);
    expect((await pub(`${STOREFRONT}/assets/${asset.id}/extra`)).status).toBe(404);
  });

  it("never exposes another store's asset, even when a config references it", async () => {
    const aAsset = await upload(STORE_A);
    // Store B publishes a config that points at store A's asset delivery URL.
    await seedPublished('cfg-steal', STORE_B, draftWith('cfg-steal', aAsset.deliveryUrl));
    await mapTo('cfg-steal', 'product', 'prod-steal', STORE_B);

    // The asset is not referenced by any of store A's published configs -> not served...
    expect((await pub(`${STOREFRONT}/assets/${aAsset.id}`)).status).toBe(404);
    // ...and store B's storefront refuses the config instead of leaking or rewriting the reference.
    expect(await data(await pub(cfgUrl('prod-steal', STORE_B)))).toEqual({ personalizable: false });
  });

  it('refuses a published config that holds browser-local or unresolvable references', async () => {
    for (const [i, src] of ['idb:abc123', 'data:image/png;base64,AAAA', 'relative/path.png'].entries()) {
      const id = `cfg-bad${i}`;
      await seedPublished(id, STORE_A, draftWith(id, src));
      await mapTo(id, 'product', `prod-bad${i}`);
      expect(await data(await pub(cfgUrl(`prod-bad${i}`, STORE_A)))).toEqual({ personalizable: false });
    }
  });

  it('resolves relative references against an absolute assetBaseUrl', async () => {
    await seedPublished('cfg-rel', STORE_A, {
      ...draftWith('cfg-rel', 'mockups/front.png'),
      assetBaseUrl: 'https://cdn.example.com/shop/',
    });
    await mapTo('cfg-rel', 'product', 'prod-rel');
    const d = await data(await pub(cfgUrl('prod-rel', STORE_A)));
    expect(d.config.mockups[0].src).toBe('https://cdn.example.com/shop/mockups/front.png');
    expect(d.config.assetBaseUrl).toBeUndefined();
  });

  it('maps R2 custom-domain URLs (ASSET_PUBLIC_BASE_URL) back to the public asset route', async () => {
    const env = { ASSET_PUBLIC_BASE_URL: 'https://assets.example.com' };
    const asset = await upload(STORE_A, env);
    expect(asset.deliveryUrl).toBe(`https://assets.example.com/${asset.objectKey}`);
    await seedPublished('cfg-pubbase', STORE_A, draftWith('cfg-pubbase', asset.deliveryUrl), env);
    await mapTo('cfg-pubbase', 'product', 'prod-pubbase');
    const res = await pub(cfgUrl('prod-pubbase', STORE_A), { env });
    const d = await data(res);
    expect(d.config.mockups[0].src).toBe(`http://api.test/api/v1/storefront/personalization/assets/${asset.id}`);
    // The object key reference also makes the asset publicly servable.
    expect((await pub(`${STOREFRONT}/assets/${asset.id}`, { env })).status).toBe(200);
    expect(sharedBucket.objects.has(asset.objectKey)).toBe(true);
  });
});
