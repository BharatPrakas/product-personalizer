/** What happens to stored assets when the configurations that use them are deleted. */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN, STORE_A, applyMigrations, call, json, publishableDraft, queryDb, resetBucket, sharedBucket, tinyPng, truncateAll,
} from './helpers';
import { provider, type Provider } from './storage-sim';

beforeAll(async () => {
  await applyMigrations();
});

describe('asset lifecycle on configuration delete', () => {
  let p: Provider;
  const png = tinyPng();
  beforeEach(async () => {
    await truncateAll();
    resetBucket();
    p = provider('r2', sharedBucket);
  });
  afterEach(() => p.restore());

  const admin = (path: string, o: Parameters<typeof call>[1] = {}) => call(`${ADMIN}${path}`, { ...o, env: { ...p.env, ...o.env } });

  /** Uploads exactly as the editor does for a NEW configuration: before the config row exists (no configId). */
  async function uploadUnlinked() {
    const init = (await json(await admin('/assets/upload-url', {
      method: 'POST', body: { contentType: 'image/png', size: png.length, purpose: 'merchant-asset' },
    }))).data;
    await p.browserPut(init, png);
    return (await json(await admin('/assets/complete', { method: 'POST', body: { uploadId: init.uploadId } }))).data;
  }
  const draftUsing = (id: string, src: string) => ({
    ...publishableDraft(id),
    mockups: [{ id: 'm1', name: 'Front', src, placements: [] }],
  });
  const createConfig = async (id: string, src: string) =>
    expect((await admin('/configs', { method: 'POST', body: { clientConfigId: id, draft: draftUsing(id, src) } })).status).toBe(201);
  const assetStatus = async (id: string) => (await queryDb<any>('SELECT status, config_id FROM assets WHERE id = $1', [id]))[0];

  it('links an asset to the configuration that first references it', async () => {
    const asset = await uploadUnlinked();
    expect((await assetStatus(asset.id)).config_id).toBeNull();
    await createConfig('cfg-a', asset.deliveryUrl);
    expect((await assetStatus(asset.id)).config_id).not.toBeNull();
  });

  it('links on save too, and never steals an asset another config already owns', async () => {
    const asset = await uploadUnlinked();
    await createConfig('cfg-own', asset.deliveryUrl);
    const owner = (await assetStatus(asset.id)).config_id;
    await createConfig('cfg-other', asset.deliveryUrl);
    expect((await assetStatus(asset.id)).config_id).toBe(owner);

    const later = await uploadUnlinked();
    await createConfig('cfg-save', 'https://cdn.test/a.png');
    const rec = (await json(await admin('/configs/cfg-save'))).data;
    expect((await admin('/configs/cfg-save', {
      method: 'PUT', body: { draft: draftUsing('cfg-save', later.deliveryUrl), expectedUpdatedAt: rec.updatedAt },
    })).status).toBe(200);
    expect((await assetStatus(later.id)).config_id).not.toBeNull();
  });

  it('deleting a configuration removes the images uploaded before it existed', async () => {
    const asset = await uploadUnlinked();
    await createConfig('cfg-del', asset.deliveryUrl);
    expect(p.has(asset.objectKey)).toBe(true);
    expect((await admin('/configs/cfg-del', { method: 'DELETE' })).status).toBe(204);
    expect(p.has(asset.objectKey)).toBe(false);
    expect((await assetStatus(asset.id)).status).toBe('deleted');
  });

  it('removes an unlinked asset even when the link was never made (reference found in the saved content)', async () => {
    const asset = await uploadUnlinked();
    await createConfig('cfg-nolink', asset.deliveryUrl);
    await queryDb('UPDATE assets SET config_id = NULL WHERE id = $1', [asset.id]); // the pre-fix state of existing data
    await admin('/configs/cfg-nolink', { method: 'DELETE' });
    expect(p.has(asset.objectKey)).toBe(false);
  });

  it('keeps a shared asset until the last configuration using it is deleted', async () => {
    const asset = await uploadUnlinked();
    await createConfig('cfg-1', asset.deliveryUrl);
    await createConfig('cfg-2', asset.deliveryUrl);
    await admin('/configs/cfg-1', { method: 'DELETE' });
    expect(p.has(asset.objectKey)).toBe(true);
    expect((await assetStatus(asset.id)).status).toBe('stored');
    await admin('/configs/cfg-2', { method: 'DELETE' });
    expect(p.has(asset.objectKey)).toBe(false);
  });

  it('also covers a duplicated configuration (which clones the same asset references)', async () => {
    const asset = await uploadUnlinked();
    await createConfig('cfg-orig', asset.deliveryUrl);
    const copy = (await json(await admin('/configs/cfg-orig/duplicate', { method: 'POST' }))).data;
    await admin('/configs/cfg-orig', { method: 'DELETE' });
    expect(p.has(asset.objectKey)).toBe(true);
    await admin(`/configs/${copy.id}`, { method: 'DELETE' });
    expect(p.has(asset.objectKey)).toBe(false);
  });

  it('leaves store-wide custom fonts alone when a configuration that uses one is deleted', async () => {
    const init = (await json(await admin('/assets/upload-url', {
      method: 'POST', body: { contentType: 'font/woff2', size: 12, filename: 'Brand' },
    }))).data;
    await p.browserPut(init, new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0]));
    const font = (await json(await admin('/assets/complete', { method: 'POST', body: { uploadId: init.uploadId } }))).data;
    await createConfig('cfg-font', font.deliveryUrl);
    expect((await assetStatus(font.id)).config_id).toBeNull(); // not adopted
    await admin('/configs/cfg-font', { method: 'DELETE' });
    expect(p.has(font.objectKey)).toBe(true);
    expect((await assetStatus(font.id)).status).toBe('stored');
  });

  it('never touches another store’s asset or an asset the config does not reference', async () => {
    const mine = await uploadUnlinked();
    const unrelated = await uploadUnlinked();
    const theirs = await (async () => {
      const init = (await json(await admin('/assets/upload-url', { method: 'POST', storeId: 'store_beta', body: { contentType: 'image/png', size: png.length } }))).data;
      await p.browserPut(init, png);
      return (await json(await admin('/assets/complete', { method: 'POST', storeId: 'store_beta', body: { uploadId: init.uploadId } }))).data;
    })();
    await createConfig('cfg-iso', mine.deliveryUrl);
    await admin('/configs/cfg-iso', { method: 'DELETE' });
    expect(p.has(mine.objectKey)).toBe(false);
    expect(p.has(unrelated.objectKey)).toBe(true);
    expect(p.has(theirs.objectKey)).toBe(true);
    expect(STORE_A).toBeTruthy();
  });
});
