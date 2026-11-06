import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, queryDb } from './helpers';

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
      'integration_credentials',
      'integration_events',
      'mappings',
      'markups',
      'order_links',
      'store_settings',
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
      'status',
      'store_id',
    ]);
  });
});
