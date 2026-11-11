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
      'order_details',
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
