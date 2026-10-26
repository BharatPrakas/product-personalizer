/**
 * Read access to `platform.plugin_registry` (the durable plugin catalogue) for the platform API.
 */

import type { SqlExecutor } from '../../database/connection';

export interface PluginRecord {
  pluginId: string;
  displayName: string;
  version: string;
  status: 'active' | 'disabled' | 'deprecated';
  createdAt: string;
  updatedAt: string;
}

interface PluginRow {
  plugin_id: string;
  display_name: string;
  version: string;
  status: PluginRecord['status'];
  created_at: Date | string;
  updated_at: Date | string;
}

function toRecord(row: PluginRow): PluginRecord {
  return {
    pluginId: row.plugin_id,
    displayName: row.display_name,
    version: row.version,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PluginRegistryRepository {
  constructor(private readonly db: SqlExecutor) {}

  async list(): Promise<PluginRecord[]> {
    const { rows } = await this.db.query<PluginRow>(
      `SELECT plugin_id, display_name, version, status, created_at, updated_at
         FROM platform.plugin_registry
        ORDER BY plugin_id`,
    );
    return rows.map(toRecord);
  }

  async get(pluginId: string): Promise<PluginRecord | null> {
    const { rows } = await this.db.query<PluginRow>(
      `SELECT plugin_id, display_name, version, status, created_at, updated_at
         FROM platform.plugin_registry WHERE plugin_id = $1`,
      [pluginId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
