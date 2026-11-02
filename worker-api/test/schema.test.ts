import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, queryDb } from './helpers';

beforeAll(async () => {
  await applyMigrations();
});

describe('database schema', () => {
  it('lives in the personalization schema alone', async () => {
    // A leftover `platform` schema means this database predates the baseline migration: drop its
    // schemas (or recreate it) and run the migrations again.
    const schemas = await queryDb<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname IN ('platform', 'personalization')",
    );
    expect(schemas.map((s) => s.nspname)).toEqual(['personalization']);

    const tables = await queryDb<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'personalization' AND table_name <> 'schema_migrations'
        ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'assets',
      'audit_logs',
      'cleanup_runs',
      'config_versions',
      'configs',
      'customization_assets',
      'customizations',
      'integration_credentials',
      'integration_events',
      'mappings',
      'markups',
      'order_links',
      'store_settings',
    ]);
  });

  it('has no plugin dimension on any table', async () => {
    expect(await queryDb("SELECT table_name FROM information_schema.columns WHERE column_name = 'plugin_id'")).toEqual([]);
  });

  it('accepts print-ready artwork as a customer file kind', async () => {
    const [constraint] = await queryDb<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'customization_assets_kind_check'",
    );
    expect(constraint.def).toContain("'artwork'");
  });

  it('keeps one row per order event, with its per-line results', async () => {
    const columns = await queryDb<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'personalization' AND table_name = 'integration_events'
        ORDER BY column_name`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      'credential_id',
      'event_id',
      'event_type',
      'external_order_id',
      'line_count',
      'occurred_at',
      'payload_sha256',
      'received_at',
      'request_id',
      'results',
      'store_id',
    ]);
  });
});
