/**
 * HTTP handlers for configurations, versions and merchant assets. Keeps transport concerns (parsing,
 * status codes, streaming) out of the service, which stays pure business logic. Each handler builds a
 * request-scoped `PersonalizationService` from the typed context.
 */

import type { Context } from 'hono';
import { createObjectStorage } from '../../storage';
import { ADMIN_SEGMENT, apiPath } from '../../shared/api-paths';
import type { AppEnv } from '../../shared/context';
import { BadRequestError } from '../../shared/errors';
import { created, noContent, ok, paginated } from '../../shared/responses';
import { PersonalizationService, type ServiceContext } from './service';
import {
  assetListQuerySchema,
  createConfigSchema,
  listQuerySchema,
  publishSchema,
  saveDraftSchema,
  uploadMetadataSchema,
} from './validation';

/** Route params are guaranteed by the route pattern; narrow the `string | undefined` type safely. */
function param(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new BadRequestError(`Missing path parameter "${name}".`);
  return value;
}

function serviceFor(c: Context<AppEnv>): PersonalizationService {
  const auth = c.get('auth');
  const ctx: ServiceContext = {
    db: c.get('db'),
    storage: createObjectStorage(c.env, c.get('config')),
    config: c.get('config'),
    logger: c.get('logger'),
    storeId: c.get('tenant').storeId,
    requestId: c.get('requestId'),
    actor: auth.subject ?? auth.tokenType,
    origin: new URL(c.req.url).origin,
  };
  return new PersonalizationService(ctx);
}

const basePath = (c: Context<AppEnv>) => `${apiPath(c.get('config').apiVersion, ADMIN_SEGMENT)}/configs`;

export async function listConfigs(c: Context<AppEnv>): Promise<Response> {
  const query = listQuerySchema.parse(c.req.query());
  const result = await serviceFor(c).listConfigs(query);
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  return paginated(c, result.records, {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    totalPages,
  });
}

export async function getConfig(c: Context<AppEnv>): Promise<Response> {
  return ok(c, await serviceFor(c).getConfig(param(c, 'configId')));
}

export async function createConfig(c: Context<AppEnv>): Promise<Response> {
  const body = createConfigSchema.parse(await c.req.json());
  const record = await serviceFor(c).createConfig(body);
  return created(c, record, `${basePath(c)}/${record.id}`);
}

export async function saveDraft(c: Context<AppEnv>): Promise<Response> {
  const body = saveDraftSchema.parse(await c.req.json());
  const record = await serviceFor(c).saveDraft(param(c, 'configId'), body.draft, body.expectedUpdatedAt);
  return ok(c, record);
}

export async function publishConfig(c: Context<AppEnv>): Promise<Response> {
  const raw = c.req.header('content-length') && Number(c.req.header('content-length')) > 0
    ? await c.req.json().catch(() => undefined)
    : undefined;
  const body = publishSchema.parse(raw);
  const record = await serviceFor(c).publish(param(c, 'configId'), body?.expectedUpdatedAt);
  return ok(c, record);
}

export async function duplicateConfig(c: Context<AppEnv>): Promise<Response> {
  const record = await serviceFor(c).duplicate(param(c, 'configId'));
  return created(c, record, `${basePath(c)}/${record.id}`);
}

export async function archiveConfig(c: Context<AppEnv>): Promise<Response> {
  return ok(c, await serviceFor(c).archive(param(c, 'configId')));
}

export async function restoreConfig(c: Context<AppEnv>): Promise<Response> {
  return ok(c, await serviceFor(c).restore(param(c, 'configId')));
}

export async function deleteConfig(c: Context<AppEnv>): Promise<Response> {
  await serviceFor(c).deleteConfig(param(c, 'configId'));
  return noContent(c);
}

export async function listVersions(c: Context<AppEnv>): Promise<Response> {
  return ok(c, await serviceFor(c).listVersions(param(c, 'configId')));
}

export async function getVersion(c: Context<AppEnv>): Promise<Response> {
  return ok(c, await serviceFor(c).getVersion(param(c, 'configId'), param(c, 'versionId')));
}

// ---- assets ----

export async function uploadAsset(c: Context<AppEnv>): Promise<Response> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > c.get('config').maxUploadBytes) {
    throw new BadRequestError('The declared Content-Length exceeds the upload limit.');
  }
  const meta = uploadMetadataSchema.parse(c.req.query());
  const bytes = await c.req.arrayBuffer();
  const asset = await serviceFor(c).uploadAsset({
    bytes,
    declaredContentType: c.req.header('content-type') ?? undefined,
    filename: meta.filename,
    clientRef: meta.clientRef,
    configClientId: meta.configId,
  });
  return created(c, asset);
}

export async function getAsset(c: Context<AppEnv>): Promise<Response> {
  return ok(c, await serviceFor(c).getAsset(param(c, 'assetId')));
}

export async function getAssetContent(c: Context<AppEnv>): Promise<Response> {
  const object = await serviceFor(c).getAssetContent(param(c, 'assetId'));
  const headers = new Headers({
    'Content-Type': object.contentType,
    'Content-Length': String(object.size),
    'Cache-Control': 'private, max-age=3600',
    ETag: object.etag,
  });
  if (object.checksum) headers.set('X-Checksum-Sha256', object.checksum);
  return new Response(object.body, { status: 200, headers });
}

export async function listAssets(c: Context<AppEnv>): Promise<Response> {
  const query = assetListQuerySchema.parse(c.req.query());
  // `configClientId` is the service's own name for `query.configId`; mapped explicitly here (not
  // forwarded as `query` directly) so a filter by config id actually reaches the repository.
  const result = await serviceFor(c).listAssets({
    configClientId: query.configId,
    kind: query.kind,
    page: query.page,
    pageSize: query.pageSize,
  });
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  return paginated(c, result.assets, {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    totalPages,
  });
}

export async function deleteAsset(c: Context<AppEnv>): Promise<Response> {
  await serviceFor(c).deleteAsset(param(c, 'assetId'));
  return noContent(c);
}
