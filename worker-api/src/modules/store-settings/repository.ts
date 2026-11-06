/**
 * Per-store settings (`store_settings`). A store becomes known to this service when it makes its first
 * authenticated request; the public routes treat a store without a row as unknown. Store ids are
 * external (ZenBasket) identifiers.
 */

import type { SqlExecutor } from '../../database/connection';

export interface StoreSettings {
  storeId: string;
  /** Browser origins allowed to call the PUBLIC storefront routes cross-origin. Empty = none. */
  storefrontOrigins: string[];
}

interface StoreSettingsRow {
  store_id: string;
  storefront_origins: string;
}

export class StoreSettingsRepository {
  constructor(private readonly db: SqlExecutor) {}

  /** Register the store on its first authenticated request. Idempotent. */
  async ensure(storeId: string): Promise<void> {
    // Read first: a known store (nearly every request) costs one SELECT instead of a write.
    const known = await this.db.query(
      `SELECT 1 FROM store_settings WHERE store_id = $1`,
      [storeId],
    );
    if (known.rowCount > 0) return;
    await this.db.query(
      `INSERT INTO store_settings (store_id) VALUES ($1)
       ON CONFLICT (store_id) DO NOTHING`,
      [storeId],
    );
  }

  async get(storeId: string): Promise<StoreSettings | null> {
    const { rows } = await this.db.query<StoreSettingsRow>(
      `SELECT store_id, storefront_origins FROM store_settings WHERE store_id = $1`,
      [storeId],
    );
    return rows[0] ? { storeId: rows[0].store_id, storefrontOrigins: JSON.parse(rows[0].storefront_origins) } : null;
  }

  async setStorefrontOrigins(storeId: string, origins: readonly string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO store_settings (store_id, storefront_origins)
            VALUES ($1, $2)
       ON CONFLICT (store_id)
         DO UPDATE SET storefront_origins = excluded.storefront_origins, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      [storeId, JSON.stringify(origins)],
    );
  }
}
