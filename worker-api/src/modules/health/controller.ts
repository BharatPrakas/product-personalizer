/**
 * Health endpoint: liveness and a shallow database check WITHOUT ever exposing connection strings,
 * credentials or other secrets.
 */

import type { Context } from 'hono';
import type { AppEnv } from '../../shared/context';
import { ok } from '../../shared/responses';

export async function health(c: Context<AppEnv>): Promise<Response> {
  const config = c.get('config');
  let database: 'ok' | 'unavailable' = 'ok';
  try {
    await c.get('db').query('SELECT 1');
  } catch (error) {
    database = 'unavailable';
    c.get('logger').error('health db check failed', { error: String(error) });
  }
  const status = database === 'ok' ? 'ok' : 'degraded';
  return ok(c, {
    status,
    environment: config.environment,
    apiVersion: config.apiVersion,
    time: new Date().toISOString(),
    checks: { database },
  }, status === 'ok' ? 200 : 503);
}
