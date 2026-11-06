/**
 * Wraps the D1 binding in the `Database` helper for the duration of the request. D1 has no
 * per-request connection to open or close (unlike the old Hyperdrive/`pg` client), so this is just a
 * thin `c.set('db', ...)` — kept as middleware so route code never touches `c.env.DB` directly.
 */

import type { MiddlewareHandler } from 'hono';
import { createDatabase } from '../database/connection';
import type { AppEnv } from '../shared/context';

export const withDatabase: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('db', createDatabase(c.env.DB));
  await next();
};
