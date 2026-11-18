/**
 * Known stores (`store_settings`). A store becomes known to this service when it makes its first
 * authenticated request; the public routes treat a store without a row as unknown. Store ids are
 * external (ZenBasket) identifiers.
 */

import type { SqlExecutor } from '../../database/connection';

export class StoreSettingsRepository {
  constructor(private readonly db: SqlExecutor) {}

  /** Register the store on its first authenticated request. Idempotent. */
  async ensure(storeId: string): Promise<void> {
    // Read first: a known store (nearly every request) costs one SELECT instead of a write.
    if (await this.exists(storeId)) return;
    await this.db.query(
      `INSERT INTO store_settings (store_id) VALUES ($1)
       ON CONFLICT (store_id) DO NOTHING`,
      [storeId],
    );
  }

  async exists(storeId: string): Promise<boolean> {
    const { rows } = await this.db.query(`SELECT 1 FROM store_settings WHERE store_id = $1`, [storeId]);
    return rows.length > 0;
  }
}
