/**
 * HTTP handlers for mappings, markups and storefront settings (authenticated admin routes). The
 * store id always comes from the verified tenant context, never from the request.
 */

import type { Context } from 'hono';
import { ADMIN_SEGMENT, apiPath } from '../../shared/api-paths';
import type { AppEnv } from '../../shared/context';
import { BadRequestError, NotFoundError, PayloadTooLargeError } from '../../shared/errors';
import { created, noContent, ok } from '../../shared/responses';
import { MappingService } from './mapping-service';
import { MarkupService } from './markup-service';
import { SettingsService } from './settings-service';
import type { PluginContext } from './support';
import {
  MAX_MARKUP_BODY_BYTES,
  bulkMappingsSchema,
  createMappingSchema,
  createMarkupSchema,
  mappingListQuerySchema,
  markupListQuerySchema,
  storefrontSettingsSchema,
  updateMappingSchema,
  updateMarkupSchema,
} from './validation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pluginContext(c: Context<AppEnv>): PluginContext {
  const auth = c.get('auth');
  return {
    db: c.get('db'),
    logger: c.get('logger'),
    storeId: c.get('tenant').storeId,
    requestId: c.get('requestId'),
    actor: auth.subject ?? auth.tokenType,
  };
}

/** A malformed id can never exist, so it is a 404 (and never reaches Postgres as a bad uuid). */
function idParam(c: Context<AppEnv>): string {
  const id = c.req.param('id');
  if (!id || !UUID.test(id)) throw new NotFoundError();
  return id.toLowerCase();
}

async function jsonBody(c: Context<AppEnv>, maxBytes?: number): Promise<unknown> {
  if (maxBytes !== undefined) {
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError();
  }
  try {
    return await c.req.json();
  } catch {
    throw new BadRequestError('The request body must be valid JSON.');
  }
}

const base = (c: Context<AppEnv>, resource: string) =>
  `${apiPath(c.get('config').apiVersion, ADMIN_SEGMENT)}/${resource}`;

// ---- mappings ----

export async function listMappings(c: Context<AppEnv>): Promise<Response> {
  const q = mappingListQuerySchema.parse(c.req.query());
  const { items, page } = await new MappingService(pluginContext(c)).list({
    configClientId: q.configId,
    scope: q.scope,
    externalId: q.externalId,
    limit: q.limit,
    cursor: q.cursor,
  });
  return ok(c, items, 200, { pagination: page });
}

export async function createMapping(c: Context<AppEnv>): Promise<Response> {
  const body = createMappingSchema.parse(await jsonBody(c));
  const { mapping, status } = await new MappingService(pluginContext(c)).create(body);
  return status === 201 ? created(c, mapping, `${base(c, 'mappings')}/${mapping.id}`) : ok(c, mapping);
}

export async function updateMapping(c: Context<AppEnv>): Promise<Response> {
  const body = updateMappingSchema.parse(await jsonBody(c));
  return ok(c, await new MappingService(pluginContext(c)).update(idParam(c), body));
}

export async function deleteMapping(c: Context<AppEnv>): Promise<Response> {
  await new MappingService(pluginContext(c)).delete(idParam(c));
  return noContent(c);
}

export async function bulkMappings(c: Context<AppEnv>): Promise<Response> {
  const body = bulkMappingsSchema.parse(await jsonBody(c));
  return ok(c, await new MappingService(pluginContext(c)).bulk(body));
}

// ---- markups ----

export async function listMarkups(c: Context<AppEnv>): Promise<Response> {
  const q = markupListQuerySchema.parse(c.req.query());
  const { items, page } = await new MarkupService(pluginContext(c)).list(q);
  return ok(c, items, 200, { pagination: page });
}

export async function createMarkup(c: Context<AppEnv>): Promise<Response> {
  const body = createMarkupSchema.parse(await jsonBody(c, MAX_MARKUP_BODY_BYTES));
  const markup = await new MarkupService(pluginContext(c)).create(body);
  return created(c, markup, `${base(c, 'markups')}/${markup.id}`);
}

export async function updateMarkup(c: Context<AppEnv>): Promise<Response> {
  const body = updateMarkupSchema.parse(await jsonBody(c, MAX_MARKUP_BODY_BYTES));
  return ok(c, await new MarkupService(pluginContext(c)).update(idParam(c), body));
}

export async function deleteMarkup(c: Context<AppEnv>): Promise<Response> {
  await new MarkupService(pluginContext(c)).delete(idParam(c));
  return noContent(c);
}

// ---- settings ----

export async function getStorefrontSettings(c: Context<AppEnv>): Promise<Response> {
  return ok(c, await new SettingsService(pluginContext(c)).getStorefront());
}

export async function putStorefrontSettings(c: Context<AppEnv>): Promise<Response> {
  const body = storefrontSettingsSchema.parse(await jsonBody(c));
  return ok(c, await new SettingsService(pluginContext(c)).setStorefrontOrigins(body.storefrontOrigins));
}
