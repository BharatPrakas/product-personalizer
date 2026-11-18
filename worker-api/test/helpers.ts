/**
 * Test harness. The Hono app is exercised end-to-end by calling `app.fetch(request, env, ctx)` with a
 * test `Env`: a REAL D1 database, provided by a local Miniflare instance (standing in for the `DB`
 * binding — this does NOT use `@cloudflare/vitest-pool-workers`/workerd, since that package's latest
 * release requires vitest ^4 and this project is on vitest 5; Miniflare's D1 is a faithful-enough
 * SQLite implementation for these tests without needing the whole pool/workerd switch), and an
 * in-memory R2 bucket. This verifies routing, middleware, auth, tenant isolation, CRUD, versioning,
 * optimistic concurrency and the full R2 upload/delivery/delete flow, running in plain Node.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { createApp } from '../src/app';
import { deriveWebhookKey } from '../src/modules/zenbasket-auth/plugin-secret';
import { signBody } from '../src/modules/zenbasket-auth/webhook-signature';
import { toSqliteSql } from '../src/database/connection';
import type { Env } from '../src/config/environment';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

/** Test fixtures only — not a real secret. >= 32 characters, as a ZenBasket-generated secret would be. */
export const TEST_PLUGIN_SECRET = 'test-plugin-secret-0123456789abcdef0123456789';
/** A different plugin's secret, to prove the Worker rejects what it did not issue. */
export const OTHER_PLUGIN_SECRET = 'some-other-plugins-secret-9876543210fedcba9876';
/** ZenBasket's id for this plugin (the `pluginId` claim of merchant tokens), as in the issued-token fixture. */
export const TEST_PLUGIN_ID = '160';
export const STORE_A = 'store_alpha';
export const STORE_B = 'store_beta';

/** Minimal in-memory R2 bucket implementing only the methods the storage adapter uses. */
export class InMemoryR2 {
  readonly objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string; customMetadata?: Record<string, string>; etag: string }
  >();
  private version = 0;

  async put(
    key: string,
    value: ArrayBuffer | ReadableStream | Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<{ size: number; etag: string }> {
    const bytes = await toBytes(value);
    // A fresh etag per write (like real R2): overwriting with different — or identical — bytes changes it.
    const etag = `etag-${++this.version}`;
    this.objects.set(key, {
      bytes,
      contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream',
      customMetadata: options?.customMetadata,
      etag,
    });
    return { size: bytes.byteLength, etag };
  }

  async head(key: string): Promise<{ size: number; etag: string; httpMetadata: { contentType: string } } | null> {
    const object = this.objects.get(key);
    return object
      ? { size: object.bytes.byteLength, etag: object.etag, httpMetadata: { contentType: object.contentType } }
      : null;
  }

  async get(
    key: string,
    options?: { onlyIf?: { etagMatches?: string } },
  ): Promise<{
    body?: ReadableStream;
    size: number;
    etag: string;
    httpMetadata?: { contentType?: string };
  } | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = object.bytes;
    const meta = { size: bytes.byteLength, etag: object.etag, httpMetadata: { contentType: object.contentType } };
    // Real R2 answers a failed precondition with the object metadata and NO body.
    if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== object.etag) return meta;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return { body, ...meta };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

async function toBytes(value: ArrayBuffer | ReadableStream | Uint8Array): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  const reader = (value as ReadableStream).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk as Uint8Array);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// ---- D1 test database (Miniflare-backed) ----

let mf: Miniflare | null = null;
let testD1: D1Database | null = null;

export async function getTestD1(): Promise<D1Database> {
  if (testD1) return testD1;
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("not used"); } };',
    d1Databases: { DB: 'test' },
  });
  testD1 = await mf.getD1Database('DB');
  return testD1;
}

/**
 * Splits a migration file into top-level statements. A plain split on `;` would cut a trigger's
 * `BEGIN ... END;` body apart, since D1's `prepare()` only accepts one statement at a time (unlike
 * Postgres's simple query protocol, which ran the whole file as one `client.query()` call) — so this
 * strips `--` comments first (prose in them may itself contain semicolons) and then tracks BEGIN/END
 * nesting, only splitting at a `;` outside of one.
 */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  const parts = withoutComments.split(/(\bBEGIN\b|\bEND\b|;)/i);
  const statements: string[] = [];
  let depth = 0;
  let current = '';
  for (const part of parts) {
    if (/^BEGIN$/i.test(part)) depth++;
    else if (/^END$/i.test(part)) depth = Math.max(0, depth - 1);
    if (part === ';' && depth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += part;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function makeEnv(bucket: InMemoryR2 = new InMemoryR2()): Env & { bucket: InMemoryR2 } {
  return {
    DB: undefined as unknown as D1Database, // filled in per-call by `call()`, which awaits the real test D1
    // High by default so ordinary tests never trip the public limiter; limiter tests override it.
    STOREFRONT_RATE_LIMIT: '100000',
    PERSONALIZATION_ASSETS: bucket as unknown as R2Bucket,
    ENVIRONMENT: 'development',
    API_VERSION: 'v1',
    CORS_ALLOWED_ORIGINS: 'http://localhost:4200',
    ASSET_PUBLIC_BASE_URL: '',
    MAX_UPLOAD_BYTES: String(15 * 1024 * 1024),
    LOG_LEVEL: 'error',
    ASSET_SIGNING_SECRET: 'test-asset-signing-secret',
    ZB_PLUGIN_SECRET: TEST_PLUGIN_SECRET,
    ZB_PLUGIN_ID: TEST_PLUGIN_ID,
    STOREFRONT_WRITE_RATE_LIMIT: '100000',
    ORDER_CALLBACK_RATE_LIMIT: '100000',
    bucket,
  };
}

/**
 * A context WITHOUT `waitUntil` — D1 has no per-request connection to close in the background anyway,
 * unlike the old Hyperdrive/`pg` client, so this just satisfies the type.
 */
export function executionContext(): ExecutionContext {
  return {
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

export const app = createApp();

export interface CallOptions {
  method?: string;
  /** A merchant token. Omitted: a real signed JWT for `storeId`. `null`: no Authorization header at all. */
  token?: string | null;
  /** The store the default merchant token is issued for (default STORE_A). */
  storeId?: string;
  body?: unknown;
  rawBody?: ArrayBuffer | Uint8Array;
  headers?: Record<string, string>;
  origin?: string;
  /** Per-call overrides of the test Env (e.g. `ASSET_PUBLIC_BASE_URL`, `STOREFRONT_RATE_LIMIT`). */
  env?: Partial<Env>;
  /** Use a different app instance (e.g. one built with an injected rate-limit store). */
  application?: { fetch: (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response> };
}

/**
 * Call the app. Merchant routes are called with a REAL signed ZenBasket-style JWT (HS256, signed with the
 * test plugin secret) for `storeId`, so cross-tenant tests just pass another `storeId`. There is no
 * development token: pass `token: null` for an anonymous call or `token: '<jwt>'` to send your own.
 */
export async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const env = { ...makeEnv(sharedBucket), DB: await getTestD1(), ...options.env };
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? await signJwt({ storeId: options.storeId ?? STORE_A }) : options.token;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.origin) headers.set('Origin', options.origin);

  let body: BodyInit | undefined;
  if (options.rawBody) {
    body = options.rawBody as BodyInit;
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }
  const request = new Request(`http://api.test${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });
  return (options.application ?? app).fetch(request, env, executionContext());
}

/** The shared R2 bucket persists across calls within a test (the app reads env per call). */
export let sharedBucket = new InMemoryR2();
export function resetBucket(): void {
  sharedBucket = new InMemoryR2();
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ---- DB lifecycle ----

let migrated = false;

export async function applyMigrations(): Promise<void> {
  if (migrated) return;
  const db = await getTestD1();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of splitStatements(sql)) {
      await db.prepare(statement).run();
    }
  }
  migrated = true;
}

/** Child tables first, respecting the `ON DELETE RESTRICT` chain (customizations -> config_versions
 *  -> configs); SQLite has no `TRUNCATE ... CASCADE`, and ids are app-generated UUIDs so there is no
 *  sequence to reset. */
const TABLES_CHILD_FIRST = [
  'uploads',
  'order_links',
  'order_details',
  'customization_assets',
  'customizations',
  'config_versions',
  'mappings',
  'configs',
  'assets',
  'markups',
  'store_settings',
  'audit_logs',
  'integration_events',
  'cleanup_runs',
];

export async function truncateAll(): Promise<void> {
  const db = await getTestD1();
  for (const table of TABLES_CHILD_FIRST) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
}

/** D1 stores JSON columns (data/draft/published/snapshot/payload/results/metadata/...) as plain TEXT,
 *  unlike Postgres's jsonb; parse anything that looks like JSON so assertions can keep comparing
 *  against plain objects/arrays as they did before. */
function parseJsonish<T>(row: T): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try {
      out[key] = JSON.parse(trimmed);
    } catch {
      // Not actually JSON; leave it as the plain string it is.
    }
  }
  return out as T;
}

export async function queryDb<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const db = await getTestD1();
  const { results } = await db.prepare(toSqliteSql(text)).bind(...params).all<T>();
  return results.map(parseJsonish);
}

/** A tiny valid PNG (1x1) as bytes. */
export function tinyPng(): Uint8Array {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Minimal bytes carrying a real font format's magic number, enough for `sniffFont` (and the Worker's
 * upload pipeline, which only inspects bytes — never the browser) to accept it. Not a loadable font.
 */
export function tinyFont(format: 'woff2' | 'woff' | 'ttf' | 'otf' = 'woff2'): Uint8Array {
  const tag =
    format === 'woff2'
      ? [0x77, 0x4f, 0x46, 0x32] // 'wOF2'
      : format === 'woff'
        ? [0x77, 0x4f, 0x46, 0x46] // 'wOFF'
        : format === 'otf'
          ? [0x4f, 0x54, 0x54, 0x4f] // 'OTTO'
          : [0x00, 0x01, 0x00, 0x00]; // sfnt v1 (TTF)
  return new Uint8Array([...tag, 0, 0, 0, 0, 0, 0, 0, 0]);
}

/** A minimal but valid v2 ProductConfig draft. */
export function sampleDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'cfg-sample1',
    version: 1,
    status: 'draft',
    product: { id: 'product-sample1', name: 'Sample Tee' },
    assetBaseUrl: 'assets/',
    variants: [{ id: 'default', label: 'Default', mockupIds: [], printableAreaIds: [] }],
    mockups: [],
    printableAreas: [],
    artworks: [],
    fonts: [],
    fields: [],
    ...overrides,
  };
}

/** A publishable draft (one mockup, area and artwork). */
export function publishableDraft(id = 'cfg-pub1'): Record<string, unknown> {
  return sampleDraft({
    id,
    product: { id: `product-${id}`, name: 'Publishable Tee' },
    mockups: [{ id: 'm1', name: 'Front', src: 'https://cdn.test/m1.png', placements: [] }],
    printableAreas: [
      { id: 'a1', name: 'Front', enabled: true, canvas: { width: 100, height: 100 },
        shape: { type: 'rect' }, artworkId: 'art1', artworkIds: ['art1'] },
    ],
    artworks: [{ id: 'art1', name: 'Design', printableAreaId: 'a1', layers: [] }],
  });
}

// ---- mapping / storefront fixtures ----

export const ADMIN = '/api/v1/plugins/personalization';
export const STOREFRONT = '/api/v1/storefront/personalization';

/** Create a draft config for `storeId` (its first authenticated request makes the store known) and return it. */
export async function seedDraft(
  id: string,
  storeId: string = STORE_A,
  draft: Record<string, unknown> = publishableDraft(id),
  env?: Partial<Env>,
): Promise<any> {
  const res = await call(`${ADMIN}/configs`, {
    method: 'POST',
    storeId,
    env,
    body: { clientConfigId: id, draft: { ...draft, id } },
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`seedDraft failed: ${res.status}`);
  return (await json(res)).data;
}

export async function publish(id: string, storeId: string = STORE_A, env?: Partial<Env>): Promise<any> {
  const res = await call(`${ADMIN}/configs/${id}/publish`, { method: 'POST', storeId, env });
  if (res.status !== 200) throw new Error(`publish failed: ${res.status} ${await res.text()}`);
  return (await json(res)).data;
}

export async function seedPublished(
  id: string,
  storeId: string = STORE_A,
  draft: Record<string, unknown> = publishableDraft(id),
  env?: Partial<Env>,
): Promise<any> {
  await seedDraft(id, storeId, draft, env);
  return publish(id, storeId, env);
}

export async function mapTo(
  configId: string,
  scope: 'product' | 'variant' | 'collection',
  externalId: string,
  storeId: string = STORE_A,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return call(`${ADMIN}/mappings`, { method: 'POST', storeId, body: { configId, scope, externalId, ...extra } });
}

// ---- customization / order-callback fixtures ----

export const INTEGRATIONS = '/api/v1/integrations/personalization';
export const PRODUCT_ID = 'zb-prod-1';

/** Publish a config for `storeId`, map it to `productId`, and return the config id. */
export async function seedPersonalizableProduct(
  storeId: string = STORE_A,
  productId: string = PRODUCT_ID,
  configId = 'cfg-cz1',
): Promise<string> {
  await seedPublished(configId, storeId);
  const res = await mapTo(configId, 'product', productId, storeId);
  if (res.status !== 201) throw new Error(`mapTo failed: ${res.status} ${await res.text()}`);
  return configId;
}

/** What the storefront element renders from: the config response for a product. */
export async function storefrontConfig(storeId: string = STORE_A, productId: string = PRODUCT_ID): Promise<any> {
  const res = await call(`${STOREFRONT}/products/${productId}/config?storeId=${storeId}`, { token: null });
  return (await json(res)).data;
}

export async function uploadCustomerImage(
  storeId: string = STORE_A,
  kind: 'upload' | 'preview' | 'artwork' = 'upload',
  env?: Partial<Env>,
): Promise<any> {
  const res = await call(`${STOREFRONT}/uploads?storeId=${storeId}&kind=${kind}`, {
    method: 'POST',
    token: null,
    rawBody: tinyPng(),
    headers: { 'Content-Type': 'image/png' },
    env,
  });
  if (res.status !== 201) throw new Error(`uploadCustomerImage failed: ${res.status} ${await res.text()}`);
  return (await json(res)).data;
}

export interface SavedCustomization {
  customizationId: string;
  status: 'saved';
  customizedImageUrl: string | null;
  expiresAt: string;
}

/** Save a customization the way the storefront does; returns the public save response. */
export async function saveCustomization(
  options: {
    storeId?: string;
    productId?: string;
    data?: Record<string, unknown>;
    assets?: Array<{ assetId: string }>;
    env?: Partial<Env>;
  } = {},
): Promise<SavedCustomization> {
  const storeId = options.storeId ?? STORE_A;
  const productId = options.productId ?? PRODUCT_ID;
  const cfg = await storefrontConfig(storeId, productId);
  const res = await call(`${STOREFRONT}/customizations?storeId=${storeId}`, {
    method: 'POST',
    token: null,
    env: options.env,
    body: {
      productId,
      configId: cfg.configId,
      configVersion: cfg.version,
      data: options.data ?? { fields: { name: 'Ada' } },
      assets: options.assets ?? [],
    },
  });
  if (res.status !== 201) throw new Error(`saveCustomization failed: ${res.status} ${await res.text()}`);
  return (await json(res)).data;
}

/** Fetch the public customized image anonymously (no Authorization, no Origin). */
export async function fetchCustomizationImage(
  assetId: string,
  storeId: string | null = STORE_A,
  options: Pick<CallOptions, 'headers' | 'method' | 'env' | 'application'> = {},
): Promise<Response> {
  const query = storeId === null ? '' : `?storeId=${storeId}`;
  return call(`${STOREFRONT}/customization-images/${assetId}${query}`, { token: null, ...options });
}

/**
 * A merchant session JWT the way ZenBasket issues it: HS256, `{ storeId, pluginId, iat, exp }`. `key` is
 * the plugin secret (root mode, the default) or a derived key; claims override the defaults.
 */
export async function signJwt(
  claims: Record<string, unknown> = {},
  key: string | Uint8Array = TEST_PLUGIN_SECRET,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc({ storeId: 766, pluginId: Number(TEST_PLUGIN_ID), iat, exp: iat + 3600, ...claims });
  const hmac = await crypto.subtle.importKey(
    'raw', typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(new Uint8Array(sig)).toString('base64url')}`;
}

export interface OrderEventLineBody {
  id: string;
  productId: string;
  variantId?: string;
  quantity?: number;
  title?: string;
  sku?: string;
  unitPrice?: string;
  extensions: Record<string, string>;
}

/** The optional order details (contract v1 section 7, [proposed – optional]). */
export interface OrderBody {
  id: string;
  number?: string;
  placedAt?: string;
  currency?: string;
  totals?: Record<string, string>;
  customer?: Record<string, string>;
  shippingAddress?: Record<string, string>;
  billingAddress?: Record<string, string>;
}

/** The contract-v1 order event envelope (docs/extension-platform-contract-v1.md, section 7). */
export interface OrderEventBody {
  contract: 1;
  eventId: string;
  type: string;
  occurredAt: string;
  storeId: string;
  order: OrderBody;
  lines: OrderEventLineBody[];
}

/** One line of an event: a customization on an order line. */
export function orderLine(customizationId: string, overrides: Partial<OrderEventLineBody> = {}): OrderEventLineBody {
  return {
    id: 'LINE-1',
    productId: PRODUCT_ID,
    quantity: 1,
    extensions: { customizationId },
    ...overrides,
  };
}

/** A whole event with the given lines. */
export function orderEventWith(lines: OrderEventLineBody[], overrides: Partial<OrderEventBody> = {}): OrderEventBody {
  return {
    contract: 1,
    eventId: `evt-${crypto.randomUUID()}`,
    type: 'order.confirmed',
    occurredAt: new Date().toISOString(),
    storeId: STORE_A,
    order: { id: 'ORD-1001' },
    lines,
    ...overrides,
  };
}

/**
 * Single-line convenience: `orderId` / `lineId` / `productId` / `variantId` / `quantity` override the
 * line and order; every other key overrides the envelope.
 */
export function orderEvent(
  customizationId: string,
  overrides: Partial<OrderEventBody> & {
    orderId?: string;
    lineId?: string;
    productId?: string;
    variantId?: string;
    quantity?: number;
  } = {},
): OrderEventBody {
  const { orderId, lineId, productId, variantId, quantity, ...envelope } = overrides;
  return orderEventWith(
    [
      orderLine(customizationId, {
        ...(lineId !== undefined ? { id: lineId } : {}),
        ...(productId !== undefined ? { productId } : {}),
        ...(variantId !== undefined ? { variantId } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
      }),
    ],
    { ...(orderId !== undefined ? { order: { id: orderId } } : {}), ...envelope },
  );
}

/**
 * POST an order callback signed exactly as the integration contract documents: HMAC-SHA256 over
 * `<timestamp>.<raw body>` with the order-webhook key derived (HKDF) from the plugin secret.
 *
 * `secret` signs with another plugin's secret; `key` with an explicit key (e.g. a key derived for another
 * purpose); `signature` replaces the whole header value.
 */
export async function postOrderEvent(
  event: OrderEventBody | string,
  options: {
    timestamp?: number;
    secret?: string;
    key?: Uint8Array;
    signature?: string;
    env?: Partial<Env>;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const body = typeof event === 'string' ? event : JSON.stringify(event);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const key = options.key ?? (await deriveWebhookKey(options.secret ?? TEST_PLUGIN_SECRET));
  return call(`${INTEGRATIONS}/events`, {
    method: 'POST',
    token: null,
    rawBody: new TextEncoder().encode(body),
    env: options.env,
    headers: {
      'Content-Type': 'application/json',
      'X-ZB-Timestamp': String(timestamp),
      'X-ZB-Signature': options.signature ?? signBody(key, timestamp, body),
      ...options.headers,
    },
  });
}
