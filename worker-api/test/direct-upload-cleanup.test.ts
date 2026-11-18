/** Scheduled cleanup of abandoned / finished direct uploads, against both storage drivers. */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  STOREFRONT,
  STORE_A,
  STORE_B,
  applyMigrations,
  call,
  getTestD1,
  json,
  makeEnv,
  queryDb,
  resetBucket,
  saveCustomization,
  seedPersonalizableProduct,
  sharedBucket,
  tinyPng,
  truncateAll,
} from './helpers';
import { provider, type Driver, type Provider } from './storage-sim';
import { loadConfig } from '../src/config/environment';
import { createDatabase } from '../src/database/connection';
import { Logger } from '../src/shared/logger';
import { CleanupService } from '../src/modules/personalization/cleanup-service';
import { createObjectStorage } from '../src/storage';
import type { ObjectStorage } from '../src/storage/object-storage';

beforeAll(async () => {
  await applyMigrations();
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (ms: number) => new Date(Date.now() + ms);

describe.each<Driver>(['r2', 's3'])('direct-upload cleanup (%s)', (driver) => {
  let p: Provider;
  const png = tinyPng();

  beforeEach(async () => {
    await truncateAll();
    resetBucket();
    p = provider(driver, sharedBucket);
  });
  afterEach(() => p.restore());

  async function cleanup(now: Date, options: { storage?: (real: ObjectStorage) => ObjectStorage } = {}) {
    const env = { ...makeEnv(sharedBucket), ...p.env } as ReturnType<typeof makeEnv>;
    const config = loadConfig(env);
    return new CleanupService({
      db: createDatabase(await getTestD1()),
      storage: () => {
        const real = createObjectStorage(env, config);
        return options.storage ? options.storage(real) : real;
      },
      config,
      logger: new Logger('error', { requestId: 'cleanup-test' }),
    }).run('test', now);
  }

  const admin = (path: string, options: Parameters<typeof call>[1] = {}) =>
    call(`${ADMIN}${path}`, { ...options, env: { ...p.env, ...options.env } });

  async function merchantUpload(opts: { put?: boolean; complete?: boolean; clientRef?: string } = {}) {
    const res = await admin('/assets/upload-url', {
      method: 'POST',
      body: { contentType: 'image/png', size: png.length, filename: 'a.png', clientRef: opts.clientRef },
    });
    const init = (await json(res)).data;
    if (opts.put !== false) await p.browserPut(init, png);
    if (opts.complete) expect((await admin('/assets/complete', { method: 'POST', body: { uploadId: init.uploadId } })).status).toBe(200);
    return init;
  }
  const pendingKey = (init: { uploadId: string }) => `stores/${STORE_A}/product-personalization/pending/${init.uploadId}`;
  const uploadRow = async (id: string) => (await queryDb<any>('SELECT * FROM uploads WHERE id = $1', [id]))[0];

  it('leaves an upload alone while its URL (plus grace) is still live', async () => {
    const init = await merchantUpload();
    const outcome = await cleanup(at(10 * MIN));
    expect(outcome).toMatchObject({ uploadsExpired: 0, uploadObjectsDeleted: 0, errors: [] });
    expect(p.has(pendingKey(init))).toBe(true);
    expect((await uploadRow(init.uploadId)).status).toBe('pending');
  });

  it('expires an abandoned upload and deletes its staged bytes; no asset ever existed', async () => {
    const init = await merchantUpload();
    const outcome = await cleanup(at(40 * MIN));
    expect(outcome).toMatchObject({ uploadsExpired: 1, uploadObjectsDeleted: 1, errors: [] });
    expect(p.has(pendingKey(init))).toBe(false);
    expect(await uploadRow(init.uploadId)).toMatchObject({ status: 'expired', failure_reason: 'url_expired', cleaned: 1 });
    expect(await queryDb('SELECT 1 FROM assets')).toHaveLength(0);
    // A late confirmation says so, rather than creating anything.
    const late = await admin('/assets/complete', { method: 'POST', body: { uploadId: init.uploadId } });
    expect(late.status).toBe(410);
    // Idempotent.
    expect(await cleanup(at(41 * MIN))).toMatchObject({ uploadsExpired: 0, uploadObjectsDeleted: 0 });
  });

  it('handles an upload whose bytes never arrived', async () => {
    const init = await merchantUpload({ put: false });
    expect(await cleanup(at(40 * MIN))).toMatchObject({ uploadsExpired: 1, errors: [] });
    expect((await uploadRow(init.uploadId)).cleaned).toBe(1);
  });

  it('sweeps a staging object re-created by a replayed URL — but only after the URL has expired', async () => {
    const init = await merchantUpload({ complete: true });
    const stored = (await queryDb<any>('SELECT object_key FROM assets'))[0].object_key;
    await p.browserPut(init, png); // replay within the 5-minute window
    expect(p.has(pendingKey(init))).toBe(true);

    expect(await cleanup(at(1 * MIN))).toMatchObject({ uploadObjectsDeleted: 0 });
    expect(p.has(pendingKey(init))).toBe(true);

    expect(await cleanup(at(10 * MIN))).toMatchObject({ uploadObjectsDeleted: 1, errors: [] });
    expect(p.has(pendingKey(init))).toBe(false);
    expect(p.has(stored)).toBe(true); // the verified asset is never touched
    expect((await uploadRow(init.uploadId)).cleaned).toBe(1);
  });

  it('never deletes an asset referenced by a configuration, whatever the age', async () => {
    const init = await merchantUpload({ complete: true });
    const stored = (await queryDb<any>('SELECT object_key FROM assets'))[0].object_key;
    await cleanup(at(10 * MIN));
    const outcome = await cleanup(at(400 * DAY));
    expect(outcome).toMatchObject({ uploadRecordsPurged: 1, errors: [] });
    expect(await queryDb('SELECT 1 FROM uploads')).toHaveLength(0);
    expect(p.has(stored)).toBe(true);
    expect((await queryDb<any>('SELECT status FROM assets WHERE id = $1', [init.assetId]))[0].status).toBe('stored');
  });

  it('removes a promoted copy that no asset references, but keeps one that is referenced', async () => {
    const orphanUpload = await merchantUpload();
    const orphanKey = `stores/${STORE_A}/product-personalization/assets/${crypto.randomUUID()}.png`;
    p.write(orphanKey, png, 'image/png');
    await queryDb(`UPDATE uploads SET status = 'failed', failure_reason = 'x', final_key = $2 WHERE id = $1`, [orphanUpload.uploadId, orphanKey]);

    const keptUpload = await merchantUpload();
    const live = await merchantUpload({ complete: true });
    const liveKey = (await queryDb<any>('SELECT object_key FROM assets WHERE id = $1', [live.assetId]))[0].object_key;
    await queryDb(`UPDATE uploads SET status = 'failed', failure_reason = 'x', final_key = $2 WHERE id = $1`, [keptUpload.uploadId, liveKey]);

    expect(await cleanup(at(10 * MIN))).toMatchObject({ errors: [] });
    expect(p.has(orphanKey)).toBe(false);
    expect(p.has(liveKey)).toBe(true);
  });

  it('retries a failed deletion on the next run and records the error', async () => {
    const init = await merchantUpload();
    const flaky = (real: ObjectStorage): ObjectStorage => ({
      put: (...a) => real.put(...a),
      head: (...a) => real.head(...a),
      get: (...a) => real.get(...a),
      presignPut: (...a) => real.presignPut(...a),
      presignGet: (...a) => real.presignGet(...a),
      readBytes: (...a) => real.readBytes(...a),
      copy: (...a) => real.copy(...a),
      delete: async () => {
        throw new Error('storage unavailable');
      },
    });
    const failed = await cleanup(at(40 * MIN), { storage: flaky });
    expect(failed).toMatchObject({ uploadsExpired: 1, uploadObjectsDeleted: 0, uploadObjectsFailed: 1 });
    expect(await uploadRow(init.uploadId)).toMatchObject({ cleaned: 0, cleanup_attempts: 1, last_error: expect.stringContaining('unavailable') });
    expect(p.has(pendingKey(init))).toBe(true);

    expect(await cleanup(at(45 * MIN))).toMatchObject({ uploadObjectsDeleted: 1, uploadObjectsFailed: 0 });
    expect(await uploadRow(init.uploadId)).toMatchObject({ cleaned: 1, last_error: null });
    expect(p.has(pendingKey(init))).toBe(false);
  });

  it('hands back a verification claim whose owner died, then expires it like any other', async () => {
    const init = await merchantUpload();
    await queryDb(`UPDATE uploads SET status = 'verifying', updated_at = $2 WHERE id = $1`, [init.uploadId, at(-3 * 60 * MIN).toISOString()]);
    const outcome = await cleanup(at(40 * MIN));
    expect(outcome.uploadsExpired).toBe(1);
    expect((await uploadRow(init.uploadId)).status).toBe('expired');
  });

  it('refuses to delete outside its own store’s staging prefix, even from a corrupted row', async () => {
    const victimKey = `stores/${STORE_B}/product-personalization/customizations/${crypto.randomUUID()}.png`;
    p.write(victimKey, png, 'image/png');
    const init = await merchantUpload();
    await queryDb(`UPDATE uploads SET status = 'expired', pending_key = $2 WHERE id = $1`, [init.uploadId, victimKey]);
    const outcome = await cleanup(at(40 * MIN));
    expect(outcome).toMatchObject({ uploadObjectsFailed: 1, uploadObjectsDeleted: 0 });
    expect(p.has(victimKey)).toBe(true);
  });

  it('leaves attached customer files alone', async () => {
    await seedPersonalizableProduct();
    const res = await call(`${STOREFRONT}/uploads/url?storeId=${STORE_A}`, {
      method: 'POST', token: null, env: p.env, body: { contentType: 'image/png', size: png.length, kind: 'artwork' },
    });
    const init = (await json(res)).data;
    await p.browserPut(init, png);
    await call(`${STOREFRONT}/uploads/complete?storeId=${STORE_A}`, {
      method: 'POST', token: null, env: p.env, body: { uploadId: init.uploadId }
    });
    await saveCustomization({ env: p.env, assets: [{ assetId: init.assetId }] });
    const key = (await queryDb<any>('SELECT object_key FROM customization_assets'))[0].object_key;

    const outcome = await cleanup(at(10 * MIN));
    expect(outcome).toMatchObject({ errors: [], assetsDeleted: 0, customizationsExpired: 0 });
    expect(p.has(key)).toBe(true);
    expect((await queryDb<any>('SELECT status FROM customization_assets'))[0].status).toBe('attached');
  });
});
