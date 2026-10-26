/**
 * Platform-level handlers: health and the plugin catalogue. The health endpoint reports liveness and
 * a shallow database check WITHOUT ever exposing connection strings, credentials or other secrets.
 */

import type { Context } from 'hono';
import type { AppEnv } from '../shared/context';
import { NotFoundError } from '../shared/errors';
import { ok } from '../shared/responses';
import { PluginRegistryRepository } from './plugin-registry/repository';
import { StorePluginsRepository } from './plugin-permissions/repository';

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

export async function listPlugins(c: Context<AppEnv>): Promise<Response> {
  const storeId = c.get('tenant').storeId;
  const plugins = await new PluginRegistryRepository(c.get('db')).list();
  const installs = await new StorePluginsRepository(c.get('db')).listForStore(storeId);
  const enabled = new Map(installs.map((i) => [i.pluginId, i.status === 'enabled']));
  return ok(
    c,
    plugins.map((p) => ({
      pluginId: p.pluginId,
      displayName: p.displayName,
      version: p.version,
      status: p.status,
      enabledForStore: enabled.get(p.pluginId) ?? false,
    })),
  );
}

export async function pluginStatus(c: Context<AppEnv>): Promise<Response> {
  const pluginId = c.req.param('pluginId');
  if (!pluginId) throw new NotFoundError('No plugin id was provided.');
  const storeId = c.get('tenant').storeId;
  const plugin = await new PluginRegistryRepository(c.get('db')).get(pluginId);
  if (!plugin) throw new NotFoundError(`Unknown plugin "${pluginId}".`);
  const install = await new StorePluginsRepository(c.get('db')).get(storeId, pluginId);
  return ok(c, {
    pluginId: plugin.pluginId,
    displayName: plugin.displayName,
    version: plugin.version,
    status: plugin.status,
    installed: install !== null,
    enabledForStore: install?.status === 'enabled',
  });
}
