/**
 * Mockup-space geometry on a placement (printable boundary, cylinder surface, mesh). These fields are
 * additive configuration JSON: the Worker validates only the envelope, so they must round-trip
 * verbatim, and a raster boundary (an ordinary image asset referenced from `placements[].mask.src`)
 * must follow the same adoption, protection and storefront rewriting rules as a mockup image. No
 * migration is involved.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  queryDb,
  resetBucket,
  seedDraft,
  seedPublished,
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

const pub = (path: string, options: Parameters<typeof call>[1] = {}) => call(path, { token: null, ...options });

const path = {
  version: 1,
  fillRule: 'evenodd',
  contours: [
    { anchors: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2, handleIn: [0.6, 0.15], handleOut: [0.85, 0.3], smooth: true }, { x: 0.5, y: 0.9 }] },
  ],
};
const cylinder = { type: 'cylinder', curvature: 140, centre: -10, visibleLeft: 80, visibleRight: 90, tilt: 12 };
const mesh = { cols: 2, rows: 2, points: [0, 0, 1, 0, 0, 1, 1, 1] };

async function uploadMask(storeId: string = STORE_A): Promise<any> {
  const res = await call(`${ADMIN}/assets?filename=mask.png`, {
    method: 'POST',
    storeId,
    rawBody: tinyPng(),
    headers: { 'Content-Type': 'image/png' },
  });
  expect(res.status).toBe(201);
  return (await json(res)).data;
}

const draftWithPlacement = (id: string, placement: Record<string, unknown>) => ({
  ...publishableDraft(id),
  mockups: [
    {
      id: 'm1',
      name: 'Front',
      src: 'https://cdn.test/m1.png',
      placements: [{ printableAreaId: 'a1', type: 'rect', x: 0.2, y: 0.3, width: 0.5, height: 0.3, ...placement }],
    },
  ],
});

describe('placement geometry is stored and published verbatim', () => {
  it('round-trips a Bezier boundary, a cylinder surface and a mesh through save, publish and the storefront', async () => {
    const placement = { mask: { type: 'path', path }, surface: cylinder, mesh };
    await seedPublished('cfg-geo', STORE_A, draftWithPlacement('cfg-geo', placement));
    const stored = (await json(await call(`${ADMIN}/configs/cfg-geo`))).data;
    expect(stored.draft.mockups[0].placements[0]).toMatchObject(placement);
    expect(stored.published.mockups[0].placements[0]).toMatchObject(placement);

    await mapTo('cfg-geo', 'product', 'prod-geo');
    const served = (await json(await pub(`${STOREFRONT}/products/prod-geo/config?storeId=${STORE_A}`))).data;
    expect(served.personalizable).toBe(true);
    expect(served.config.mockups[0].placements[0]).toMatchObject(placement);
  });

  it('keeps the geometry through a later draft save and when a published version is retrieved', async () => {
    await seedPublished('cfg-ver', STORE_A, draftWithPlacement('cfg-ver', { surface: cylinder }));
    const rec = (await json(await call(`${ADMIN}/configs/cfg-ver`))).data;
    const next = draftWithPlacement('cfg-ver', { surface: { ...cylinder, curvature: 200 }, mesh });
    const saved = await call(`${ADMIN}/configs/cfg-ver`, { method: 'PUT', body: { draft: next, expectedUpdatedAt: rec.updatedAt } });
    expect(saved.status).toBe(200);
    const after = (await json(await call(`${ADMIN}/configs/cfg-ver`))).data;
    expect(after.draft.mockups[0].placements[0].surface.curvature).toBe(200);
    expect(after.draft.mockups[0].placements[0].mesh).toEqual(mesh);
    // The published snapshot of the earlier version is untouched.
    expect(after.published.mockups[0].placements[0].surface.curvature).toBe(140);
    expect(after.published.mockups[0].placements[0].mesh).toBeUndefined();
  });

  it('stays under the configuration size limit with a large path and the biggest mesh', async () => {
    const ring = Array.from({ length: 256 }, (_, i) => ({
      x: 0.5 + 0.4 * Math.cos((i / 256) * 2 * Math.PI),
      y: 0.5 + 0.4 * Math.sin((i / 256) * 2 * Math.PI),
      handleIn: [0.5, 0.5],
      handleOut: [0.5, 0.5],
    }));
    const big = { version: 1, fillRule: 'nonzero', contours: Array.from({ length: 4 }, () => ({ anchors: ring })) };
    const points = Array.from({ length: 12 * 12 * 2 }, (_, i) => (i % 2 === 0 ? (i / 2 % 12) / 11 : Math.floor(i / 24) / 11));
    const draft = draftWithPlacement('cfg-big', { mask: { type: 'path', path: big }, mesh: { cols: 12, rows: 12, points } });
    expect(JSON.stringify(draft).length).toBeLessThan(4 * 1024 * 1024);
    expect((await call(`${ADMIN}/configs`, { method: 'POST', body: { clientConfigId: 'cfg-big', draft } })).status).toBe(201);
  });
});

describe('a raster boundary is an ordinary image asset', () => {
  const raster = (src: string) => ({ mask: { type: 'raster', src, width: 800, height: 600 } });

  it('is adopted by the configuration that references it from placements[].mask.src', async () => {
    const asset = await uploadMask();
    expect((await queryDb<any>('SELECT config_id FROM assets WHERE id = $1', [asset.id]))[0].config_id).toBeNull();
    await seedDraft('cfg-mask', STORE_A, draftWithPlacement('cfg-mask', raster(asset.deliveryUrl)));
    expect((await queryDb<any>('SELECT config_id FROM assets WHERE id = $1', [asset.id]))[0].config_id).not.toBeNull();
  });

  it('cannot be deleted while a configuration references it', async () => {
    const asset = await uploadMask();
    await seedDraft('cfg-ref', STORE_A, draftWithPlacement('cfg-ref', raster(asset.deliveryUrl)));
    const res = await call(`${ADMIN}/assets/${asset.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await queryDb<any>('SELECT status FROM assets WHERE id = $1', [asset.id]))[0].status).toBe('stored');
  });

  it('is removed together with its configuration', async () => {
    const asset = await uploadMask();
    await seedDraft('cfg-gone', STORE_A, draftWithPlacement('cfg-gone', raster(asset.deliveryUrl)));
    expect((await call(`${ADMIN}/configs/cfg-gone`, { method: 'DELETE' })).status).toBe(204);
    expect((await queryDb<any>('SELECT status FROM assets WHERE id = $1', [asset.id]))[0].status).toBe('deleted');
  });

  it('is rewritten to a public URL for the storefront and served without a token once published', async () => {
    const asset = await uploadMask();
    await seedPublished('cfg-pubmask', STORE_A, draftWithPlacement('cfg-pubmask', raster(asset.deliveryUrl)));
    await mapTo('cfg-pubmask', 'product', 'prod-mask');
    const d = (await json(await pub(`${STOREFRONT}/products/prod-mask/config?storeId=${STORE_A}`))).data;
    const expected = `http://api.test${STOREFRONT}/assets/${asset.id}`;
    expect(d.config.mockups[0].placements[0].mask).toEqual({ type: 'raster', src: expected, width: 800, height: 600 });
    expect(JSON.stringify(d)).not.toContain('/plugins/personalization/assets');
    const img = await pub(new URL(expected).pathname);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(tinyPng());
  });

  it("never serves another store's mask: the storefront answers 'not personalizable' instead of leaking it", async () => {
    const theirs = await uploadMask(STORE_B);
    await seedPublished('cfg-steal', STORE_A, draftWithPlacement('cfg-steal', raster(theirs.deliveryUrl)));
    await mapTo('cfg-steal', 'product', 'prod-steal');
    const d = (await json(await pub(`${STOREFRONT}/products/prod-steal/config?storeId=${STORE_A}`))).data;
    expect(d).toEqual({ personalizable: false });
  });
});
