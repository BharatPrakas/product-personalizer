import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  STORE_A,
  TEST_DATABASE_URL,
  applyMigrations,
  call,
  createCredential,
  json,
  makeEnv,
  orderEvent,
  postOrderEvent,
  queryDb,
  resetBucket,
  saveCustomization,
  seedPersonalizableProduct,
  sharedBucket,
  truncateAll,
  uploadCustomerImage,
} from './helpers';
import { loadConfig } from '../src/config/environment';
import { createDatabase } from '../src/database/connection';
import { Logger } from '../src/shared/logger';
import { CleanupService } from '../src/plugins/personalization/cleanup-service';
import { runScheduledCleanup } from '../src/scheduled';
import { R2ObjectStorage } from '../src/storage/r2-storage';
import type { ObjectStorage } from '../src/storage/object-storage';

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await truncateAll();
  resetBucket();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(Date.now() + ms);

/** Run one cleanup pass "as of" a point in time (the job takes its clock as a parameter). */
async function cleanup(now: Date, options: { storage?: ObjectStorage; env?: Parameters<typeof makeEnv>[0] extends never ? never : Record<string, string>; batchSize?: number } = {}) {
  const env = { ...makeEnv(), ...options.env } as ReturnType<typeof makeEnv>;
  const db = createDatabase(TEST_DATABASE_URL);
  try {
    return await new CleanupService({
      db,
      storage: () => options.storage ?? new R2ObjectStorage(sharedBucket as unknown as R2Bucket),
      config: loadConfig(env),
      logger: new Logger('error', { requestId: 'cleanup-test' }),
      batchSize: options.batchSize,
    }).run('test', now);
  } finally {
    await db.close();
  }
}

const statusOf = async (id: string) => (await queryDb<any>('SELECT status FROM personalization.customizations WHERE id = $1', [id]))[0]?.status;
const assetRows = () => queryDb<any>('SELECT id, status, object_key, delete_after, last_error, delete_attempts FROM personalization.customization_assets ORDER BY created_at');

async function savedWithAsset() {
  const asset = await uploadCustomerImage();
  const saved = await saveCustomization({ assets: [{ assetId: asset.assetId, uploadToken: asset.uploadToken }] });
  return { asset, saved };
}

describe('abandoned customization cleanup', () => {
  it('leaves customizations inside the 30-day window alone', async () => {
    await seedPersonalizableProduct();
    const { saved } = await savedWithAsset();
    const outcome = await cleanup(at(29 * DAY));
    expect(outcome).toMatchObject({ customizationsExpired: 0, assetsDeleted: 0, errors: [] });
    expect(await statusOf(saved.customizationId)).toBe('saved');
  });

  it('expires after inactivity, then deletes files only after the grace period, then purges the empty row', async () => {
    await seedPersonalizableProduct();
    const { saved } = await savedWithAsset();

    // Day 31: expired, data cleared, file RELEASED but still in storage (grace period).
    const expired = await cleanup(at(31 * DAY));
    expect(expired.customizationsExpired).toBe(1);
    const [row] = await queryDb<any>('SELECT status, data, expires_at, expired_at FROM personalization.customizations');
    expect(row).toMatchObject({ status: 'expired', data: {}, expires_at: null });
    expect(row.expired_at).not.toBeNull();
    const [released] = await assetRows();
    expect(released.status).toBe('released');
    expect(sharedBucket.objects.has(released.object_key)).toBe(true);

    // Still inside the grace period: nothing is deleted.
    const early = await cleanup(at(31 * DAY + 23 * HOUR));
    expect(early.assetsDeleted).toBe(0);
    expect(sharedBucket.objects.has(released.object_key)).toBe(true);

    // After the grace period the object goes.
    const later = await cleanup(at(31 * DAY + 25 * HOUR));
    expect(later.assetsDeleted).toBe(1);
    expect(sharedBucket.objects.has(released.object_key)).toBe(false);
    expect((await assetRows())[0].status).toBe('deleted');

    // The empty tombstone is kept for a while (late callbacks get a clear answer), then purged.
    expect(await statusOf(saved.customizationId)).toBe('expired');
    expect((await cleanup(at(40 * DAY))).tombstonesPurged).toBe(0);
    const purged = await cleanup(at(70 * DAY));
    expect(purged.tombstonesPurged).toBe(1);
    expect(await statusOf(saved.customizationId)).toBeUndefined();
    expect(await assetRows()).toHaveLength(0);
  });

  it('honours configurable retention, grace and tombstone periods', async () => {
    await seedPersonalizableProduct();
    const { saved } = await savedWithAsset();
    const env = { CUSTOMIZATION_RETENTION_DAYS: '1', ASSET_DELETE_GRACE_HOURS: '1', EXPIRED_TOMBSTONE_DAYS: '1' };
    // `expires_at` was fixed at save time from the default retention, so move it to the configured one.
    await queryDb("UPDATE personalization.customizations SET expires_at = now() + interval '1 day'");
    expect((await cleanup(at(2 * DAY), { env })).customizationsExpired).toBe(1);
    expect((await cleanup(at(2 * DAY + 2 * HOUR), { env })).assetsDeleted).toBe(1);
    expect((await cleanup(at(4 * DAY), { env })).tombstonesPurged).toBe(1);
    expect(await statusOf(saved.customizationId)).toBeUndefined();
  });

  it('NEVER touches ordered customizations or their files, however old', async () => {
    await seedPersonalizableProduct();
    const credential = await createCredential();
    const { asset, saved } = await savedWithAsset();
    expect((await postOrderEvent(credential, orderEvent(saved.customizationId))).status).toBe(200);

    const outcome = await cleanup(at(5 * 365 * DAY));
    expect(outcome).toMatchObject({ customizationsExpired: 0, assetsDeleted: 0, tombstonesPurged: 0, errors: [] });
    expect(await statusOf(saved.customizationId)).toBe('ordered');
    const [row] = await assetRows();
    expect(row.status).toBe('attached');
    expect(sharedBucket.objects.has(row.object_key)).toBe(true);
    // Still downloadable by the merchant.
    const file = await call(`${ADMIN}/customizations/${saved.customizationId}/assets/${asset.assetId}/content`);
    expect(file.status).toBe(200);
  });

  it('skips a customization that already has an order link, even if its status were stale', async () => {
    await seedPersonalizableProduct();
    const { saved } = await savedWithAsset();
    await queryDb(
      `INSERT INTO personalization.order_links (store_id, customization_id, external_order_id, external_line_id, product_external_id, event_id, occurred_at)
       VALUES ($1, $2, 'ORD-X', 'L-X', 'p', 'evt-x', now())`,
      [STORE_A, saved.customizationId],
    );
    expect((await cleanup(at(100 * DAY))).customizationsExpired).toBe(0);
    expect(await statusOf(saved.customizationId)).toBe('saved');
  });

  it('does not delete a released file whose customization turns out to be ordered', async () => {
    await seedPersonalizableProduct();
    const credential = await createCredential();
    const { asset, saved } = await savedWithAsset();
    // The shopper removes the file, then orders within the grace period.
    const res = await call(`/api/v1/storefront/personalization/customizations/${saved.customizationId}?storeId=${STORE_A}`, {
      method: 'PUT', token: null, headers: { Authorization: `Bearer ${saved.accessToken}` }, body: { data: { v: 2 }, assets: [] },
    });
    expect(res.status).toBe(200);
    expect((await postOrderEvent(credential, orderEvent(saved.customizationId))).status).toBe(200);
    const outcome = await cleanup(at(10 * DAY));
    expect(outcome.assetsDeleted).toBe(0);
    const [row] = await assetRows();
    expect(row.status).toBe('released');
    expect(sharedBucket.objects.has(row.object_key)).toBe(true);
    expect(asset.assetId).toBe(row.id);
  });

  it('is not racing the order callback: an expiry pass skips a row the callback has locked', async () => {
    await seedPersonalizableProduct();
    const { saved } = await savedWithAsset();
    const db = createDatabase(TEST_DATABASE_URL);
    try {
      let outcome: Awaited<ReturnType<typeof cleanup>> | undefined;
      await db.transaction(async (tx) => {
        // What the callback does first: lock the customization row.
        await tx.query('SELECT 1 FROM personalization.customizations WHERE id = $1 FOR UPDATE', [saved.customizationId]);
        outcome = await cleanup(at(40 * DAY));
      });
      expect(outcome!.customizationsExpired).toBe(0);
      expect(await statusOf(saved.customizationId)).toBe('saved');
    } finally {
      await db.close();
    }
  });

  it('answers an event for an already-expired customization with a clear per-line rejection', async () => {
    await seedPersonalizableProduct();
    const credential = await createCredential();
    const { saved } = await savedWithAsset();
    await cleanup(at(31 * DAY));
    const res = await postOrderEvent(credential, orderEvent(saved.customizationId));
    expect(res.status).toBe(200);
    expect((await json(res)).results).toEqual([expect.objectContaining({ status: 'rejected', reason: 'customization_expired' })]);
  });

  it('lets a config be deleted once its expired customizations are purged', async () => {
    await seedPersonalizableProduct();
    await saveCustomization();
    expect((await call(`${ADMIN}/configs/cfg-cz1`, { method: 'DELETE' })).status).toBe(409);
    await cleanup(at(31 * DAY));
    await cleanup(at(70 * DAY));
    expect((await call(`${ADMIN}/configs/cfg-cz1`, { method: 'DELETE' })).status).toBe(204);
  });
});

describe('abandoned upload cleanup', () => {
  it('releases and then deletes uploads nobody attached, separately from customization expiry', async () => {
    await seedPersonalizableProduct();
    const orphan = await uploadCustomerImage();
    const [{ object_key }] = await assetRows();

    expect((await cleanup(at(23 * HOUR))).uploadsReleased).toBe(0);
    const released = await cleanup(at(25 * HOUR));
    expect(released).toMatchObject({ uploadsReleased: 1, customizationsExpired: 0, assetsDeleted: 0 });
    expect(sharedBucket.objects.has(object_key)).toBe(true);
    expect((await cleanup(at(25 * HOUR + 23 * HOUR))).assetsDeleted).toBe(0);
    expect((await cleanup(at(25 * HOUR + 25 * HOUR))).assetsDeleted).toBe(1);
    expect(sharedBucket.objects.has(object_key)).toBe(false);
    expect(orphan.assetId).toBeTruthy();
  });

  it('keeps an upload that was attached in time', async () => {
    await seedPersonalizableProduct();
    const { asset } = await savedWithAsset();
    const outcome = await cleanup(at(3 * DAY));
    expect(outcome).toMatchObject({ uploadsReleased: 0, assetsDeleted: 0 });
    expect((await assetRows())[0]).toMatchObject({ id: asset.assetId, status: 'attached' });
  });
});

describe('failure handling and bookkeeping', () => {
  const failingStorage = (inner: ObjectStorage, failures: { n: number }): ObjectStorage => ({
    put: (...a) => inner.put(...a),
    head: (k) => inner.head(k),
    get: (k) => inner.get(k),
    delete: async (k) => {
      if (failures.n-- > 0) throw new Error('storage unavailable');
      return inner.delete(k);
    },
  });

  it('keeps the file for a retry with backoff when storage fails, and records the failure', async () => {
    await seedPersonalizableProduct();
    await uploadCustomerImage();
    await cleanup(at(25 * HOUR)); // release
    const storage = failingStorage(new R2ObjectStorage(sharedBucket as unknown as R2Bucket), { n: 1 });

    const failed = await cleanup(at(60 * HOUR), { storage });
    expect(failed).toMatchObject({ assetsDeleted: 0, assetsFailed: 1 });
    const [row] = await assetRows();
    expect(row).toMatchObject({ status: 'released', delete_attempts: 1 });
    expect(row.last_error).toContain('storage unavailable');
    expect(new Date(row.delete_after).getTime()).toBeGreaterThan(Date.now() + 60 * HOUR); // backed off
    expect(sharedBucket.objects.size).toBe(1);

    // Backoff not elapsed -> not retried; once it has -> deleted.
    expect((await cleanup(at(60 * HOUR), { storage })).assetsFailed).toBe(0);
    const retried = await cleanup(at(63 * HOUR), { storage });
    expect(retried.assetsDeleted).toBe(1);
    expect(sharedBucket.objects.size).toBe(0);
    expect((await assetRows())[0]).toMatchObject({ status: 'deleted', last_error: null });
  });

  it('hands back claims left in `deleting` by a run that died', async () => {
    await seedPersonalizableProduct();
    await uploadCustomerImage();
    await cleanup(at(25 * HOUR));
    await queryDb("UPDATE personalization.customization_assets SET status = 'deleting', updated_at = now() - interval '3 hours'");
    const outcome = await cleanup(at(60 * HOUR));
    expect(outcome.assetsDeleted).toBe(1);
  });

  it('records every run, including what it did', async () => {
    await seedPersonalizableProduct();
    await savedWithAsset();
    await cleanup(at(31 * DAY));
    await cleanup(at(32 * DAY + 2 * HOUR));
    const runs = await queryDb<any>('SELECT * FROM personalization.cleanup_runs ORDER BY started_at');
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ trigger: 'test', status: 'succeeded', customizations_expired: 1, assets_deleted: 0, error: null });
    expect(runs[1]).toMatchObject({ status: 'succeeded', customizations_expired: 0, assets_deleted: 1 });
    expect(runs.every((r: any) => r.finished_at !== null)).toBe(true);
  });

  it('works in bounded batches', async () => {
    await seedPersonalizableProduct();
    for (let i = 0; i < 3; i++) await saveCustomization();
    expect((await cleanup(at(31 * DAY), { batchSize: 2 })).customizationsExpired).toBe(2);
    expect((await cleanup(at(31 * DAY), { batchSize: 2 })).customizationsExpired).toBe(1);
  });

  it('is what the cron trigger runs (runScheduledCleanup)', async () => {
    await seedPersonalizableProduct();
    await uploadCustomerImage();
    await queryDb("UPDATE personalization.customization_assets SET created_at = now() - interval '2 days'");
    await runScheduledCleanup(makeEnv(sharedBucket), '17 * * * *');
    const [run] = await queryDb<any>('SELECT trigger, status, uploads_released FROM personalization.cleanup_runs');
    expect(run).toEqual({ trigger: '17 * * * *', status: 'succeeded', uploads_released: 1 });
  });
});
