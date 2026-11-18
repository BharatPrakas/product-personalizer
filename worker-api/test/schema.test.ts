import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, queryDb, splitStatements } from './helpers';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const migrationSql = (file: string) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

beforeAll(async () => {
  await applyMigrations();
});

describe('database schema', () => {
  it('defines every expected table and nothing else', async () => {
    const tables = await queryDb<{ name: string }>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
        ORDER BY name`,
    );
    expect(tables.map((t) => t.name)).toEqual([
      'assets',
      'audit_logs',
      'cleanup_runs',
      'config_versions',
      'configs',
      'customization_assets',
      'customizations',
      'integration_events',
      'mappings',
      'markups',
      'order_details',
      'order_links',
      'store_settings',
      'uploads',
    ]);
  });

  it('has no plugin dimension on any table', async () => {
    const [hit] = await queryDb<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%plugin_id%'`,
    );
    expect(hit).toBeUndefined();
  });

  it('accepts print-ready artwork as a customer file kind', async () => {
    const [table] = await queryDb<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customization_assets'`,
    );
    expect(table.sql).toContain("'artwork'");
  });

  it('keeps one row per order event, with its per-line results', async () => {
    const columns = await queryDb<{ name: string }>(`PRAGMA table_info(integration_events)`);
    expect(columns.map((c) => c.name).sort()).toEqual([
      'event_id',
      'event_type',
      'external_order_id',
      'line_count',
      'occurred_at',
      'payload_sha256',
      'received_at',
      'request_id',
      'results',
      'status',
      'store_id',
    ]);
  });

  it('adds the optional order details as nullable columns and one order_details row per order', async () => {
    const links = await queryDb<{ name: string; notnull: number }>(`PRAGMA table_info(order_links)`);
    for (const name of ['variant_external_id', 'quantity', 'line_title', 'line_sku', 'unit_price']) {
      expect(links.find((c) => c.name === name), name).toMatchObject({ notnull: 0 });
    }
    const details = await queryDb<{ name: string; notnull: number; pk: number }>(`PRAGMA table_info(order_details)`);
    expect(details.map((c) => c.name).sort()).toEqual([
      'billing_address', 'created_at', 'currency', 'customer', 'external_order_id', 'last_event_id',
      'order_number', 'placed_at', 'shipping_address', 'store_id', 'totals', 'updated_at',
    ]);
    expect(details.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['store_id', 'external_order_id']);
    for (const name of ['order_number', 'placed_at', 'currency', 'totals', 'customer', 'shipping_address', 'billing_address']) {
      expect(details.find((c) => c.name === name)!.notnull, name).toBe(0);
    }
    const indexes = await queryDb<{ name: string }>(`PRAGMA index_list(order_details)`);
    expect(indexes.map((i) => i.name)).toContain('order_details_number_idx');
  });

  it('refuses non-JSON-object order detail columns', async () => {
    await expect(
      queryDb(`INSERT INTO order_details (store_id, external_order_id, customer, last_event_id) VALUES ('s', 'o', 'not json', 'e')`),
    ).rejects.toThrow();
    await expect(
      queryDb(`INSERT INTO order_details (store_id, external_order_id, totals, last_event_id) VALUES ('s', 'o', '[1]', 'e')`),
    ).rejects.toThrow();
  });
});

describe('per-store webhook credentials are absent from the final schema', () => {
  it('leaves no table, index, trigger or view mentioning credentials after the full migration chain', async () => {
    const hits = await queryDb<{ type: string; name: string }>(
      `SELECT type, name FROM sqlite_master
        WHERE name LIKE '%credential%' OR sql LIKE '%credential%' OR sql LIKE '%secret_encrypted%'`,
    );
    expect(hits).toEqual([]);
  });

  it('keeps the replay-protection and order-link tables with their uniqueness guarantees', async () => {
    const events = await queryDb<{ name: string; pk: number }>(`PRAGMA table_info(integration_events)`);
    expect(events.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['store_id', 'event_id']);
    const links = await queryDb<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'order_links'`,
    );
    expect(links[0].sql).toContain('order_links_customization_uq UNIQUE (customization_id)');
    expect(links[0].sql).toContain('order_links_line_uq UNIQUE (store_id, external_order_id, external_line_id)');
  });

  it('keeps both attach-count triggers (tenant-safe customization asset attachment)', async () => {
    const triggers = await queryDb<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`);
    expect(triggers.map((t) => t.name)).toEqual(['customization_assets_attach_decrement', 'customizations_attach_guard']);
  });

  it('passes the database integrity checks', async () => {
    expect(await queryDb(`PRAGMA foreign_key_check`)).toEqual([]);
    expect((await queryDb<Record<string, string>>(`PRAGMA quick_check`))[0]).toEqual({ quick_check: 'ok' });
  });
});

describe('the consolidated baseline (the only migration)', () => {
  const FINAL_TABLES = [
    'assets', 'audit_logs', 'cleanup_runs', 'config_versions', 'configs', 'customization_assets', 'customizations',
    'integration_events', 'mappings', 'markups', 'order_details', 'order_links', 'store_settings', 'uploads',
  ];
  const FINAL_INDEXES = [
    'assets_config_idx', 'assets_store_client_ref_uq', 'assets_store_idx', 'audit_logs_store_idx',
    'cleanup_runs_started_idx', 'config_versions_config_idx', 'config_versions_config_store_version_uq',
    'configs_id_store_uq', 'configs_store_archived_idx', 'configs_store_client_uq', 'configs_store_updated_idx',
    'customization_assets_deleting_idx', 'customization_assets_owner_idx', 'customization_assets_release_idx',
    'customization_assets_unattached_idx', 'customizations_config_idx', 'customizations_expiry_idx',
    'customizations_product_idx', 'customizations_purge_idx', 'customizations_store_created_idx',
    'customizations_store_status_idx', 'mappings_store_config_idx', 'mappings_store_created_idx',
    'markups_store_created_idx', 'markups_store_kind_idx', 'markups_store_kind_name_uq', 'order_details_number_idx',
    'order_links_order_idx', 'order_links_store_created_idx', 'uploads_open_client_ref_uq', 'uploads_open_expiry_idx',
    'uploads_purge_idx', 'uploads_store_status_idx', 'uploads_uncleaned_idx', 'uploads_verifying_idx',
  ];
  const FINAL_TRIGGERS = ['customization_assets_attach_decrement', 'customizations_attach_guard'];

  const rows = async (db: D1Database, sql: string) => (await db.prepare(sql).all<Record<string, any>>()).results;
  const objects = (db: D1Database, type: string) =>
    rows(db, `SELECT name FROM sqlite_master WHERE type = '${type}' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`)
      .then((r) => r.map((x) => x.name as string));

  /** A brand-new EMPTY D1 (not the shared test one), so nothing can be left over from an earlier step. */
  async function emptyDatabase(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
    const mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("unused"); } };',
      d1Databases: { DB: 'empty-baseline-test' },
    });
    return { db: await mf.getD1Database('DB'), dispose: () => mf.dispose() };
  }

  it('is the ONLY migration file: there is no 0002 and no per-store-credential migration', () => {
    expect(readdirSync(MIGRATIONS_DIR).sort()).toEqual(['0001_baseline.sql']);
  });

  it('creates the complete final schema from an empty database, and nothing else', async () => {
    const { db, dispose } = await emptyDatabase();
    try {
      expect(await objects(db, 'table')).toEqual([]); // genuinely empty to begin with
      for (const statement of splitStatements(migrationSql('0001_baseline.sql'))) await db.prepare(statement).run();

      expect(await objects(db, 'table')).toEqual(FINAL_TABLES);
      expect(await objects(db, 'index')).toEqual(FINAL_INDEXES);
      expect(await objects(db, 'trigger')).toEqual(FINAL_TRIGGERS);
      expect(await objects(db, 'view')).toEqual([]);

      // No authentication structure of any kind lives in the database.
      const leftovers = await rows(
        db,
        `SELECT name FROM sqlite_master WHERE name LIKE '%credential%' OR sql LIKE '%credential%'
            OR sql LIKE '%secret_encrypted%' OR sql LIKE '%token_hash%'`,
      );
      expect(leftovers).toEqual([]);

      // Sound: every foreign key points at a table that exists, and the database passes its checks.
      for (const table of FINAL_TABLES) {
        for (const fk of await rows(db, `PRAGMA foreign_key_list(${table})`)) {
          expect(FINAL_TABLES, `${table} -> ${fk.table}`).toContain(fk.table);
        }
      }
      expect(await rows(db, `PRAGMA foreign_key_check`)).toEqual([]);
      expect((await rows(db, `PRAGMA quick_check`))[0]).toEqual({ quick_check: 'ok' });
    } finally {
      await dispose();
    }
  });

  it('contains the latest intended structures: order details, direct uploads, line details, upload counters', async () => {
    const { db, dispose } = await emptyDatabase();
    try {
      for (const statement of splitStatements(migrationSql('0001_baseline.sql'))) await db.prepare(statement).run();
      const columns = async (table: string) => (await rows(db, `PRAGMA table_info(${table})`)).map((c) => c.name as string);
      expect(await columns('order_links')).toEqual(expect.arrayContaining(['variant_external_id', 'quantity', 'line_title', 'line_sku', 'unit_price']));
      expect(await columns('cleanup_runs')).toEqual(expect.arrayContaining(['uploads_expired', 'upload_objects_deleted', 'upload_records_purged']));
      expect(await columns('uploads')).toEqual(expect.arrayContaining(['pending_key', 'final_key', 'status', 'asset_id', 'cleaned']));
      expect(await columns('customizations')).toContain('pending_attach_count');
      expect(await columns('integration_events')).not.toContain('credential_id');
      expect(await columns('integration_events')).toEqual(expect.arrayContaining(['status', 'results', 'payload_sha256']));
    } finally {
      await dispose();
    }
  });

  it('can be applied twice without error (every object is created IF NOT EXISTS)', async () => {
    const { db, dispose } = await emptyDatabase();
    try {
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of splitStatements(migrationSql('0001_baseline.sql'))) await db.prepare(statement).run();
      }
      expect(await objects(db, 'table')).toEqual(FINAL_TABLES);
    } finally {
      await dispose();
    }
  });

  it('keeps the attach-count triggers working: a short claim aborts the whole unit (tenant-safe attachment)', async () => {
    const { db, dispose } = await emptyDatabase();
    try {
      for (const statement of splitStatements(migrationSql('0001_baseline.sql'))) await db.prepare(statement).run();
      await db.batch([
        db.prepare(`INSERT INTO store_settings (store_id) VALUES ('s')`),
        db.prepare(`INSERT INTO configs (id, store_id, schema_version, draft, created_at_ms, updated_at_ms) VALUES ('c','s',2,'{}',1,1)`),
        db.prepare(`INSERT INTO config_versions (id, config_id, store_id, version, snapshot, created_at_ms) VALUES ('v','c','s',1,'{}',1)`),
      ]);
      // Asks to claim one upload that does not exist: the whole batch (including the customization) must abort.
      await expect(
        db.batch([
          db.prepare(
            `INSERT INTO customizations (id, store_id, config_id, config_version, product_external_id, mapping_scope,
                                         mapping_external_id, data, expires_at, pending_attach_count, created_at_ms, updated_at_ms)
             VALUES ('z','s','c',1,'p','product','p','{}','2027-01-01T00:00:00.000Z',1,1,1)`,
          ),
          db.prepare(`UPDATE customizations SET updated_at = updated_at WHERE id = 'z'`),
        ]),
      ).rejects.toThrow();
      expect(await rows(db, `SELECT count(*) AS n FROM customizations`)).toEqual([{ n: 0 }]);
    } finally {
      await dispose();
    }
  });
});
