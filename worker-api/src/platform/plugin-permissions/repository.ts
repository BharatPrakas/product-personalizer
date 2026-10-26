/**
 * Per-store plugin installations (`platform.store_plugins`). Answers "is this plugin enabled for
 * this store?" and records installs. Store ids are external (ZenBasket) identifiers.
 */

import type { SqlExecutor } from '../../database/connection';

export interface StorePluginRecord {
  storeId: string;
  pluginId: string;
  status: 'enabled' | 'disabled';
  settings: Record<string, unknown>;
  installedAt: string;
  updatedAt: string;
}

interface StorePluginRow {
  store_id: string;
  plugin_id: string;
  status: 'enabled' | 'disabled';
  settings: Record<string, unknown>;
  installed_at: Date | string;
  updated_at: Date | string;
}

function toRecord(row: StorePluginRow): StorePluginRecord {
  return {
    storeId: row.store_id,
    pluginId: row.plugin_id,
    status: row.status,
    settings: row.settings ?? {},
    installedAt: new Date(row.installed_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class StorePluginsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async isEnabled(storeId: string, pluginId: string): Promise<boolean> {
    const row = await this.db.query<{ enabled: boolean }>(
      `SELECT (status = 'enabled') AS enabled
         FROM platform.store_plugins WHERE store_id = $1 AND plugin_id = $2`,
      [storeId, pluginId],
    );
    return row.rows[0]?.enabled ?? false;
  }

  async get(storeId: string, pluginId: string): Promise<StorePluginRecord | null> {
    const { rows } = await this.db.query<StorePluginRow>(
      `SELECT store_id, plugin_id, status, settings, installed_at, updated_at
         FROM platform.store_plugins WHERE store_id = $1 AND plugin_id = $2`,
      [storeId, pluginId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForStore(storeId: string): Promise<StorePluginRecord[]> {
    const { rows } = await this.db.query<StorePluginRow>(
      `SELECT store_id, plugin_id, status, settings, installed_at, updated_at
         FROM platform.store_plugins WHERE store_id = $1 ORDER BY plugin_id`,
      [storeId],
    );
    return rows.map(toRecord);
  }

  /** Install (enable) a plugin for a store. Idempotent. */
  async install(storeId: string, pluginId: string): Promise<StorePluginRecord> {
    const { rows } = await this.db.query<StorePluginRow>(
      `INSERT INTO platform.store_plugins (store_id, plugin_id, status)
            VALUES ($1, $2, 'enabled')
       ON CONFLICT (store_id, plugin_id)
         DO UPDATE SET status = 'enabled', updated_at = now()
       RETURNING store_id, plugin_id, status, settings, installed_at, updated_at`,
      [storeId, pluginId],
    );
    return toRecord(rows[0]);
  }

  /** Merge `patch` into the store's plugin settings (top-level keys). Returns null if not installed. */
  async updateSettings(
    storeId: string,
    pluginId: string,
    patch: Record<string, unknown>,
  ): Promise<StorePluginRecord | null> {
    const { rows } = await this.db.query<StorePluginRow>(
      `UPDATE platform.store_plugins
          SET settings = settings || $3::jsonb, updated_at = now()
        WHERE store_id = $1 AND plugin_id = $2
        RETURNING store_id, plugin_id, status, settings, installed_at, updated_at`,
      [storeId, pluginId, JSON.stringify(patch)],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
