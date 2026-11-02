# ZB Plugin Platform — Cloudflare Worker backend

A shared, multi-plugin Cloudflare Worker that provides cloud persistence for the Product
Personalization application. **Product Personalization is the first plugin**; the platform is built so
additional, independent plugins can be added to the same Worker and database without rewriting
authentication, tenant handling, storage or migrations.

```
Angular app ──HTTPS/JSON──▶ Cloudflare Worker (Hono) ──▶ Hyperdrive ──▶ PostgreSQL (dedicated)
                                   │
                                   └──────────────────────▶ R2 (artwork, images, mockups, previews)
```

- **PostgreSQL** is the authoritative store for configurations, version history and asset metadata.
- **R2** stores binary files. Image bytes are never stored in PostgreSQL JSON.
- **Hyperdrive** pools the Postgres connection at the edge; the Worker uses the `pg` driver with
  `nodejs_compat`.

> This backend is **additive**. The standalone Angular app still runs entirely in the browser
> (IndexedDB) and is unchanged. Cloud persistence is opt-in (see "Angular integration").

---

## Contents

- [Prerequisites](#prerequisites)
- [Project structure](#project-structure)
- [Local development](#local-development)
- [Database schema](#database-schema)
- [API reference](#api-reference)
- [Mappings, markups & the public storefront route](#mappings-markups--the-public-storefront-route)
- [Customizations, order callback & cleanup](#customizations-order-callback--cleanup)
- [Authentication & tenancy](#authentication--tenancy)
- [R2 asset workflow](#r2-asset-workflow)
- [End-to-end with the Angular elements](#end-to-end-with-the-angular-elements)
- [Angular integration](#angular-integration)
- [IndexedDB → cloud migration](#indexeddb--cloud-migration)
- [Migrations](#database-migrations)
- [Testing](#testing)
- [Deploying to staging / production](#deploying-to-staging--production)
- [Security notes](#security-notes)
- [Operational notes](#operational-notes)
- [Limitations, assumptions & risks](#limitations-assumptions--risks)

---

## Prerequisites

- Node.js 20+ (verified on Node 24).
- A PostgreSQL 14+ database (verified on PostgreSQL 18). **Separate from ZenBasket's MySQL** — this
  service never connects to or migrates that database.
- A Cloudflare account with Workers, Hyperdrive and R2 enabled (for deployment only).

## Project structure

```
worker-api/
├── src/
│   ├── index.ts                 # Worker entry (fetch + scheduled/cron handlers)
│   ├── app.ts                   # Hono app assembly + plugin mounting
│   ├── config/environment.ts    # Env bindings + parsed AppConfig
│   ├── middleware/              # request-id, cors, database, auth, tenant, authorization, errors
│   ├── platform/                # shared platform: plugin registry, installations, audit, integration credentials, controller
│   ├── plugins/personalization/ # the first plugin: routes/controller/service/repository/validation/types
│   ├── database/                # pg-over-Hyperdrive connection + transaction helpers
│   ├── storage/r2-storage.ts    # R2 object storage + safe key generation
│   └── shared/                  # errors, responses, logger, jwt, image-sniff, Hono context types
├── migrations/                  # version-controlled SQL (platform + personalization)
├── docs/zenbasket-integration.md # API contract for the ZenBasket backend team
├── scripts/migrate.mjs          # migration runner (trusted machine / CI, not in a request)
├── test/                        # vitest: unit + full HTTP integration (real Postgres + in-memory R2)
├── wrangler.jsonc               # Worker config, bindings, environments
└── package.json
```

The shared platform (auth, tenant, DB, storage, plugin registry) is independent of any plugin's
business logic. A plugin is a `PluginModule` (`src/platform/plugin-registry/registry.ts`) that mounts
its own routes; `src/app.ts` guards each plugin with the shared middleware and mounts it under
`/api/v1/plugins/<id>`. **Adding a plugin = append a module to `buildRegistry()` and add its
migration.**

## Local development

### 1. Install

```bash
cd worker-api
npm install
```

### 2. Provision a local PostgreSQL database

Use any local Postgres. Example (psql as a superuser):

```sql
CREATE ROLE personalizer LOGIN PASSWORD 'personalizer_local_dev';
CREATE DATABASE personalizer_dev OWNER personalizer;
```

Connection string for local dev:
`postgres://personalizer:personalizer_local_dev@127.0.0.1:5432/personalizer_dev`

> `wrangler dev` connects to this **local** database through the Hyperdrive binding's
> `localConnectionString` (already set in `wrangler.jsonc`). It does **not** use a deployed Hyperdrive
> resource — so local development never touches a deployed database.

### 3. Apply migrations

Migrations run from your machine (not from the Worker) using a trusted `DATABASE_URL`:

```bash
DATABASE_URL="postgres://personalizer:personalizer_local_dev@127.0.0.1:5432/personalizer_dev" \
  npm run migrate            # apply pending migrations (idempotent)

DATABASE_URL="..." npm run migrate:status   # show applied / pending
```

### 4. Local dev secrets

```bash
cp .dev.vars.example .dev.vars   # already gitignored
```

`.dev.vars` provides a static `DEV_AUTH_TOKEN` (mapped to `DEV_STORE_ID`) so you can call the API
locally without an identity provider, plus a `JWT_SIGNING_SECRET` for verifying real tokens. The dev
token is only honoured when `ENVIRONMENT != production`.

### 5. Run the Worker

```bash
npm run dev            # wrangler dev on http://localhost:8787 (local Postgres + local R2)
```

Smoke test:

```bash
curl http://localhost:8787/api/v1/health
# {"data":{"status":"ok","checks":{"database":"ok"}, ...}}

curl -H "Authorization: Bearer local-dev-token" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:8787/api/v1/plugins/personalization/configs \
  -d '{"clientConfigId":"cfg-demo","draft":{"schemaVersion":2,"id":"cfg-demo","version":1,"status":"draft","product":{"id":"p1","name":"Demo"},"variants":[],"mockups":[],"printableAreas":[],"artworks":[],"fonts":[],"fields":[]}}'
```

### 6. Point the Angular app at the Worker

In the Angular app's host page (or `index.html` during local dev), set the runtime config before the
app bootstraps:

```html
<script>
  window.__ZB_PERSONALIZER__ = {
    apiBaseUrl: 'http://localhost:8787',
    authToken: 'local-dev-token',   // host-issued session token in real deployments
    persistence: 'cloud',
  };
</script>
```

With no such config the Angular app stays on IndexedDB (local) — unchanged.

## Database schema

Two schemas keep platform-owned and plugin-owned data separate.

### `platform` (migration `0001_platform.sql`)

| Table | Purpose |
|---|---|
| `plugin_registry` | Catalogue of plugins (`plugin_id`, display name, version, status). |
| `store_plugins` | Which plugins are enabled for a store (tenant). `store_id` is the **external** ZenBasket id — no local users/stores table. |
| `audit_logs` | Append-only log of privileged operations (identifiers + small metadata only; never secrets or payloads). |
| `schema_migrations` | Applied-migration tracking (created by the runner). |

### `personalization` (migration `0002_personalization.sql`)

| Table | Purpose |
|---|---|
| `configs` | One row per managed configuration. `draft` and `published` are **JSONB** (the renderer's `ProductConfig` is stored verbatim — never flattened). `updated_at_ms` is the optimistic-concurrency token. `client_config_id` is unique per store (stable local↔cloud id + idempotent migration). |
| `config_versions` | Immutable publish history (one row per publish). |
| `assets` | Metadata for every binary in R2: `object_key`, verified `content_type`, `size_bytes`, dimensions, `checksum_sha256`, `status`, and the client's `idb:` ref for dedupe. |

### `personalization` additions (migration `0003_mappings_markups.sql`)

| Table | Purpose |
|---|---|
| `mappings` | Links a host product / variant / collection (`scope`, `external_id`) to one configuration, per store. `UNIQUE (store_id, scope, external_id)`; index `(store_id, config_id)`. `(config_id, store_id)` is a composite FK to `configs (id, store_id)` with `ON DELETE CASCADE`, so deleting a config removes its mappings and the database itself refuses a cross-store mapping. `label` (<= 200) caches the host product title for the admin UI. |
| `markups` | Reusable merchant-authored snippets: `kind` (`area` \| `artwork`), `name` (1..120), `payload` jsonb (must be an object; <= 256 KB enforced by the API). `UNIQUE (store_id, kind, lower(name))`; index `(store_id, kind)`. |

The migration also adds a unique index `configs (id, store_id)` (needed by the composite FK). Timestamps
follow the existing convention (`*_ms` epoch-millisecond bigints, plus `created_at` / `updated_at`
timestamptz). Per-store storefront CORS origins need **no new column**: they live in the existing
`platform.store_plugins.settings` jsonb (`storefrontOrigins`).

### `platform` / `personalization` additions (migrations `0004` and `0005`)

| Table | Purpose |
|---|---|
| `platform.integration_credentials` | Per-store, per-plugin HMAC signing secrets, **encrypted at rest** (AES-256-GCM, `secret_encrypted`; the key is the Worker secret `INTEGRATION_ENCRYPTION_KEY`, the ciphertext is bound to `(store_id, id)`). Several can be live at once for rotation (`expires_at` on the outgoing one); `status` active/revoked. FK to `store_plugins`. |
| `customizations` | A shopper's saved design: pins `(config_id, store_id, config_version)` through a composite FK to `config_versions` (`ON DELETE RESTRICT`), records the ZenBasket `product_external_id` / `variant_external_id` and the mapping that matched, `data` jsonb, `status` (`saved` → `ordered` \| `expired`) with a CHECK tying status to its timestamps, and `expires_at` for the 30-day inactivity expiry. |
| `customization_assets` | Customer files (private object-storage prefix `…/customizations/`): `kind` upload/preview, `status` uploaded → attached → released → deleting → deleted, `delete_after` (grace period), retry bookkeeping. Owner FK `(customization_id, store_id)`. Kept apart from `assets` so merchant-asset logic and public delivery can never touch customer files. |
| `order_links` | The ZenBasket order line a customization was bought on. `UNIQUE (customization_id)` and `UNIQUE (store_id, external_order_id, external_line_id)` give the idempotency/conflict guarantees. |
| `integration_events` | Durable event-id deduplication for order events, `PRIMARY KEY (store_id, event_id)` + a payload hash. One row per delivered event (it may carry several order lines); `results` (jsonb, migration `0006`) stores the per-line outcome so a replay answers identically. Written in the same transaction as the links. |
| `cleanup_runs` | One row per scheduled cleanup run with its counts and outcome. |

ZenBasket identifiers (store, product, variant, order, line) are plain `text`; there are **no foreign keys
to ZenBasket's MySQL database**.

Design rationale: the configuration is already a structured JSON document, so it is stored as JSONB
and only lifecycle/ownership/versioning metadata is relational. Every row carries `store_id` and
every query is store-scoped, so a store can never read another store's data by guessing an id.
Uniqueness: `(store_id, client_config_id)` and `assets.object_key`. Indexes cover the frequent
store-scoped list queries.

## API reference

All routes are under `/api/v1`. Responses use a consistent envelope:

```jsonc
// success
{ "data": <T>, "meta"?: { "pagination": {...} }, "requestId": "..." }
// error
{ "error": { "code": "...", "message": "...", "requestId": "...", "details"?: {...} } }
```

### Platform

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Public. Liveness + shallow DB check. No secrets. |
| GET | `/plugins` | Plugin catalogue + per-store enabled flag. |
| GET | `/plugins/:pluginId/status` | Install/enable status for the store. |

### Personalization — configurations

| Method | Path |
|---|---|
| GET | `/plugins/personalization/configs` (`?includeArchived=&page=&pageSize=`) |
| POST | `/plugins/personalization/configs` |
| GET | `/plugins/personalization/configs/:configId` |
| PUT | `/plugins/personalization/configs/:configId` (optimistic concurrency via `expectedUpdatedAt`) |
| DELETE | `/plugins/personalization/configs/:configId` |
| POST | `/plugins/personalization/configs/:configId/publish` |
| POST | `/plugins/personalization/configs/:configId/duplicate` |
| POST | `/plugins/personalization/configs/:configId/archive` |
| POST | `/plugins/personalization/configs/:configId/restore` |
| GET | `/plugins/personalization/configs/:configId/versions` |
| GET | `/plugins/personalization/configs/:configId/versions/:versionId` |

### Personalization — assets

| Method | Path |
|---|---|
| POST | `/plugins/personalization/assets` (raw image body; `?filename=&clientRef=&configId=`) |
| GET | `/plugins/personalization/assets` (`?configId=&page=&pageSize=`) |
| GET | `/plugins/personalization/assets/:assetId` (metadata) |
| GET | `/plugins/personalization/assets/:assetId/content` (authorized delivery) |
| DELETE | `/plugins/personalization/assets/:assetId` (refused with 409 if still referenced) |

See [Mappings, markups & the public storefront route](#mappings-markups--the-public-storefront-route)
for the mapping / markup / settings routes (authenticated) and the public storefront routes.

Status codes: `200/201/204` success, `401` unauthenticated, `403` plugin not enabled / forbidden,
`404` not found (also returned cross-tenant, so ids are not oracles), `409` concurrency conflict or
referenced-asset delete, `413` payload too large, `415` unsupported media type, `422` validation
(structured `details.issues`), `429` rate limited, `5xx` opaque server error.

## Mappings, markups & the public storefront route

### New routes

Authenticated (Bearer token; store comes from the verified token, never from the request), mounted under
`/api/v1/plugins/personalization`, all writes audited (`mapping.*`, `markup.*`, `settings.update`):

| Method | Path | Notes |
|---|---|---|
| GET | `/mappings` | `?configId=&scope=&externalId=&limit=&cursor=` (limit 1..200, default 50; newest first) |
| POST | `/mappings` | `{ configId, scope, externalId, label?, reassign? }` -> **201** created, **200** if it already pointed at that config (idempotent; a provided `label` updates) or was moved with `reassign: true` |
| PUT | `/mappings/:id` | `{ configId?, label?, reassign? }` (at least one of `configId`/`label`; `label: ""`/`null` clears). Changing `configId` to a different config needs `reassign: true`, else 409 |
| DELETE | `/mappings/:id` | 204 (404 if not in this store) |
| POST | `/mappings/bulk` | `{ configId, create?: [{scope, externalId, label?}], deleteIds?: string[], reassign? }`, max 500 items (create + deleteIds), ONE transaction |
| GET | `/markups` | `?kind=&search=&limit=&cursor=` (`search` is a literal, case-insensitive substring of the name) |
| POST | `/markups` | `{ name, kind, payload }` -> 201 |
| PUT | `/markups/:id` | `{ name?, payload? }` |
| DELETE | `/markups/:id` | 204 |
| GET / PUT | `/settings/storefront` | `{ storefrontOrigins: string[] }` - the store's allowed CORS origins (see below) |

`configId` in every mapping request/response is the configuration's **client id** (`ConfigRecordDto.id`,
e.g. `cfg-ab12cd34`), the same id used in `/configs/:configId`. `GET /configs` and `GET /configs/:id`
now also carry an optional `mappingCount`.

Public (no token), under `/api/v1/storefront/personalization`:

| Method | Path | Notes |
|---|---|---|
| GET | `/products/:externalId/config` | `?storeId=` (required) `&variantId=` `&collectionIds=a,b,c` (max 20) |
| GET | `/assets/:assetId` | streams a stored image if a published, non-archived config of the owning store references it |
| OPTIONS | both of the above | per-store CORS preflight |

Mapping JSON: `{ id, storeId, configId, configName, configStatus: "draft"|"published"|"archived", scope, externalId, label, createdAt, updatedAt }`
(timestamps are epoch ms, like the rest of the API). Markup JSON: `{ id, storeId, name, kind, payload, createdAt, updatedAt }`.
List responses: `{ data: [...], meta: { pagination: { limit, hasMore, nextCursor } } }` - pass `nextCursor` back as `?cursor=`
(opaque, keyset on `(created_at_ms, id)`; a malformed cursor is a 400).

Bulk response: `{ created: Mapping[], reassigned: Mapping[], unchanged: Mapping[], conflicts: [{ scope, externalId, existing: { id, configId, configName } }], deleted: number }`.
Deletes run first (so delete + re-create of a target in one request works), duplicates inside `create` are collapsed, and
conflicting items are reported but not applied unless `reassign: true`; everything else is applied.

Error codes added: `409 mapping_conflict` (`details.existing = { id, configId, configName }`), `422 config_archived`,
`409 markup_name_taken`, `404 not_found` (unknown config, mapping or markup - also for another store's ids),
`422 validation_failed` (bad scope / ids / lengths / >500 bulk items / markup payload not an object or > 256 KB / too deep),
`413 payload_too_large` (markup request body > 1 MiB by `Content-Length`).

### Precedence rules (storefront)

For a product page the Worker looks for a mapping in this order and serves the first hit:

1. `variant` mapping for `variantId`
2. `product` mapping for `:externalId`
3. `collection` mapping for any id in `collectionIds` - if several match, the **earliest-created** mapping wins
   (ties broken by mapping id), independent of the order of ids in the query.

Only configurations that are **published and not archived** take part. A higher-precedence mapping whose config is
draft-only or archived is skipped, so resolution falls through to the next level instead of failing. Archiving a
config keeps its mappings (restore brings them back); deleting it removes them.

### Public config route

`GET /api/v1/storefront/personalization/products/:externalId/config?storeId=<store key>[&variantId=][&collectionIds=a,b]`

- `storeId` is the platform's **external store id** - the same value as the `store_id` claim in merchant tokens and as
  `store_plugins.store_id`. The plugin must be enabled for that store. A missing `storeId` is a 422; an unknown, disabled
  or malformed key (anything outside `[A-Za-z0-9._:-]{1,128}`) is answered exactly like "nothing mapped" so store existence
  is not leaked.
- Response `200`, body `{ "data": { personalizable: true, configId, version, scope, externalId, config } }` where `config` is the
  **latest published snapshot** (never the draft), or `{ "data": { "personalizable": false } }`. `scope`/`externalId` describe the mapping
  that matched (e.g. the variant id). The body deliberately has **no `requestId`** so it is byte-stable and cacheable; the id is in `X-Request-Id`.
- A published config that still contains a reference the storefront cannot serve (browser-local `idb:`/`data:`, a relative path with no absolute
  `assetBaseUrl`, an asset of another store, a deleted asset) is **not served** (`personalizable:false`, a warning is logged).
- Caching: `ETag` is the strong SHA-256 of the exact body; `If-None-Match` (strong or weak, lists, `*`) -> `304` with the same headers.
  `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600` for `personalizable:true`;
  `public, max-age=10, s-maxage=30, stale-while-revalidate=60` for `personalizable:false`; `Vary: Origin` always;
  errors (4xx, 429) are `no-store`.
- Not on the global admin CORS allow-list: see CORS below.

**Asset rewriting** (`src/plugins/personalization/storefront-assets.ts`, one pure function with unit tests): every `src`, `thumbnail`
and `thumbnailSrc` (mockups, overlays, fixed-image layers, fonts, artwork choices) is classified. Worker delivery URLs
(`.../plugins/personalization/assets/<id>/content`, any origin) and R2 custom-domain URLs (`ASSET_PUBLIC_BASE_URL/<object key>`) that belong
to the requesting store become `<request origin>/api/v1/storefront/personalization/assets/<id>`; other absolute `http(s)` URLs are kept; relative
paths resolve against an absolute `assetBaseUrl`; `assetBaseUrl` is then dropped (all references are absolute). The origin is the origin the
request arrived on (https behind Cloudflare). `GET /assets/:assetId` only serves a `stored` asset whose store's published, non-archived config
references it (by id or object key); it sets `Cache-Control: public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400`, a strong
`ETag` (the stored SHA-256), `nosniff` and `Cross-Origin-Resource-Policy: cross-origin`, and applies the owning store's CORS list.

**CORS (per store).** The store's allowed origins are stored in `platform.store_plugins.settings.storefrontOrigins` and managed with
`PUT /plugins/personalization/settings/storefront` (`{ "storefrontOrigins": ["https://shop.example.com"] }`; bare origins only, normalised,
max 20). A request `Origin` that is in the list gets `Access-Control-Allow-Origin: <origin>` (and `Access-Control-Expose-Headers: ETag, X-Request-Id`);
anything else - or an empty list, the default - gets no CORS headers. The global `CORS_ALLOWED_ORIGINS` list does **not** apply to `/storefront/*`.

**Rate limiting.** `src/shared/rate-limit.ts`: a fixed-window counter keyed by store key + `CF-Connecting-IP` (config route) or by IP (assets,
5x budget; preflight has its own counter). Defaults 120 requests / 60 s, tunable with `STOREFRONT_RATE_LIMIT` and `STOREFRONT_RATE_WINDOW_SECONDS`.
Over the limit -> `429` with `Retry-After`. The counter store is injectable (`createApp(registry, { rateLimitStore, now })`). The default store is
**per isolate, in memory** - best-effort only. In production also add Cloudflare WAF **rate-limiting rules** (or the Rate Limiting binding) for
`/api/v1/storefront/*`; without a `CF-Connecting-IP` header (local dev) all clients share one bucket.

## Customizations, order callback & cleanup

The shopper-to-order flow — the storefront element saves a customization when the shopper adds to cart,
ZenBasket carries its id on the cart line and order line, and confirms the order with a signed
server-to-server event — is specified for the ZenBasket team in
**[docs/zenbasket-integration.md](docs/zenbasket-integration.md)**, which implements the platform-wide
**[Extension Platform Contract v1](../docs/extension-platform-contract-v1.md)**. Summary of the guarantees:

- **Event auth:** HMAC-SHA256 over `"<timestamp>.<exact body>"`, per-store encrypted secrets, a
  configurable timestamp window, constant-time comparison, and rotation with an overlap period. The store
  comes from the credential, never the body.
- **Generic envelope, per-line outcome:** `POST /api/v1/integrations/personalization/events` takes the
  contract-v1 envelope (`order`, `lines[].extensions`). The whole event is ONE PostgreSQL transaction (event-id
  dedup → per line, under a savepoint: row lock → product/variant check → link → `saved`→`ordered`). A line that
  breaks a business rule is `rejected` in the per-line `results` (HTTP 200) without undoing or blocking the
  others; a replay returns the *stored* results; the same `eventId` with a different payload is a 409; a
  different order/line for an ordered customization is a rejected line; a zero-row conditional update triggers a
  state re-read rather than a blind failure.
- **Privacy:** the `customizationId` authorizes nothing by itself. Shoppers use a scoped, expiring token;
  merchants are store-scoped; customer files sit in a private prefix streamed only after an access check.
- **Cleanup:** an hourly cron (`scheduled()` → `CleanupService`) expires inactive `saved` customizations
  (30 days), releases abandoned uploads, deletes released files after a grace period, and purges empty
  tombstones. `ordered` customizations are never touched. Runs are recorded in `personalization.cleanup_runs`.

Verification status: covered by node integration tests against real Postgres (including concurrent
deliveries and mutation-checked safety guards) and exercised end to end on the real `workerd` runtime via
`wrangler dev` with local R2: the storefront element in Chrome (via the reference bridge page) saves a design
(photo, print-ready artwork and previews uploaded privately), the cart line carries only `customizationId`, a
signed contract-v1 `order.confirmed` links it to the order line, a replay returns the stored result, and
re-ordering it is rejected; the cron handler was checked via `--test-scheduled`.
Known gap: the per-line savepoint is only exercised by rejections that happen before any write in that line, so
no test proves a *partial write* inside a rejected line is rolled back (the case is defensive).
Not verified without a live Cloudflare account: the deployed cron trigger, Hyperdrive behaviour under load,
and real R2/S3 deletes of customer files (tests use an in-memory bucket).

## Authentication & tenancy

The store/tenant identity is derived **only** from a verified credential — never from a client header,
query param or body field.

- **Production/staging:** the hosting platform (ZenBasket) issues an HS256 session token signed with a
  shared secret (`JWT_SIGNING_SECRET`), carrying the store id as a claim (`store_id`/`storeId`). The
  Worker verifies the signature and expiry (`src/shared/jwt.ts`) and trusts only the claim.
- **Development:** a static `DEV_AUTH_TOKEN` maps to `DEV_STORE_ID`. Never honoured in production.

> **There is no production identity provider in this repository.** This is the documented integration
> boundary. Until `JWT_SIGNING_SECRET` is configured, protected routes reject every request, so no
> data operation is ever unauthenticated. To integrate a real IdP, issue tokens signed with
> `JWT_SIGNING_SECRET`, or replace `verifyJwtHs256` with the provider's verifier.

Plugin installation is enforced per store (`store_plugins`); ownership of each config/asset is enforced
by store-scoped queries in the repository.

## Bucket layout

One bucket per environment, with the same layout on R2 and S3:

```
plugins/
  <plugin-folder>/storefront.js, store-admin.js     plugin code bundles (not written by this API)
stores/
  <store-id>/
    <plugin-folder>/assets/<uuid>.<ext>             that store's artwork, customer images, mockups
```

- The personalization plugin's folder is `product-personalization` (`STORAGE_FOLDER` in
  `src/plugins/personalization/types.ts`); its API id stays `personalization`.
- Each plugin declares `storageFolder` on its `PluginModule`. The registry validates it
  (lowercase letters, digits, hyphens) and refuses two plugins that share one.
- Keys are generated server-side by `generateObjectKey`. The store id comes from the verified token,
  never from the request. The file name is a UUID, not the original name.
- Before reading or deleting an object, the service checks that its key sits under
  `stores/<store>/<plugin-folder>/assets/`.
- The `plugins/` code folder is separate. Nothing in this API writes there; publish those bundles
  with your own deploy step.
- Existing rows keep whatever key they were stored with. Assets uploaded under the earlier
  `personalization/<store>/<yyyy>/<mm>/` layout (local test data only) will be refused by the prefix
  check; re-upload them or clear the dev data.

## Signed asset URLs

The editor draws saved images with plain browser requests (`<img>`, `fetch`), which cannot send a Bearer
token, and a draft's assets must not be public. So the delivery URL stored in a configuration is a
signed URL on the public asset route:

```
<origin>/api/v1/storefront/personalization/assets/<uuid>?sig=<signature>
```

- `sig` is an HMAC-SHA256 over the store id and asset id, keyed by `ASSET_SIGNING_SECRET` (falls back to
  `JWT_SIGNING_SECRET`). It never expires, so it can live in the configuration, and it only works for
  that asset.
- A valid signature serves the asset even while it is a draft (`Cache-Control: private`). Without one,
  the route serves only assets referenced by the store's published configuration, as before.
- The admin origins in `CORS_ALLOWED_ORIGINS` may load these URLs cross-origin, in addition to the
  store's own storefront origins.
- Configurations saved earlier with the Bearer-only URL (`/plugins/personalization/assets/<id>/content`)
  are re-pointed at the signed URL whenever they are read, so no data migration is needed.
- Set the secret per deployed environment: `wrangler secret put ASSET_SIGNING_SECRET --env production`
  (and `--env staging`). Changing it later invalidates the URLs already saved in configurations, so
  treat it as a long-lived value.
- The Bearer-protected `GET /assets/:id/content` still exists for API clients.

## Storage backends

Binary assets go through one interface (`src/storage/object-storage.ts`). The backend is chosen per
environment with `STORAGE_DRIVER`:

| Environment | Driver | Backing store | Required settings |
|---|---|---|---|
| production | `r2` | Cloudflare R2 (`PERSONALIZATION_ASSETS` binding) | R2 bucket binding in `wrangler.jsonc` |
| development / staging | `s3` | AWS S3 (or an S3-compatible endpoint) | `S3_BUCKET`, `S3_REGION`, secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |

- The S3 adapter (`src/storage/s3-storage.ts`) calls the S3 REST API with SigV4 through `aws4fetch`.
  It does not bundle the AWS SDK.
- Use an IAM user per environment, limited to that environment's bucket (`s3:GetObject`,
  `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`). Don't share one key across environments.
- Put local keys in `.dev.vars`; set staging keys with `wrangler secret put AWS_ACCESS_KEY_ID --env staging`
  (and the same for `AWS_SECRET_ACCESS_KEY`).
- `S3_ENDPOINT` switches to path-style addressing for S3-compatible services such as MinIO. Leave it unset for AWS.
- A misconfigured backend fails the request with a 500 and a log line naming the missing setting.
  Values are never logged.
- Current placeholders: `S3_BUCKET` and `S3_REGION` in `wrangler.jsonc` still read `REPLACE_WITH_...`.
  Replace them before running local uploads.
- To run locally against R2 instead, add an `r2_buckets` binding for `PERSONALIZATION_ASSETS` and set
  `STORAGE_DRIVER=r2`.

## R2 asset workflow

1. Angular `POST`s the image bytes to the **authenticated** `/assets` endpoint (no R2 credentials in
   the browser).
2. The Worker validates size and the actual **file contents** (magic-byte sniffing — the browser's
   Content-Type is not trusted; only PNG/JPEG/WebP accepted), computes a SHA-256 checksum, generates a
   tenant-scoped, traversal-free object key, and streams the bytes into R2 via the binding.
3. Metadata is recorded in `personalization.assets`; the configuration references a **stable delivery
   URL**, never a short-lived signed URL.

**Delivery URL strategy** — persisted configs store a stable URL:
- If `ASSET_PUBLIC_BASE_URL` is set (an R2 custom domain), that public URL is used — recommended for
  storefront rendering, where assets are intentionally public. Configure CORS on the bucket/domain.
- Otherwise the Worker's authorized `/assets/:id/content` endpoint is used (CORS-enabled, auth +
  ownership checked).

Deletes verify ownership and refuse (409) if any config draft/published copy or historical version
still references the asset; deleting a config releases only the assets nothing else references. All R2
network work happens outside DB transactions.

## End-to-end with the Angular elements

The repository's browser suite can drive **both** custom elements against a running Worker
(`tests/browser/cloud-e2e.spec.ts`; skipped unless configured). It uses the real cloud repositories over HTTP:
import and publish a template in `<zb-personalization-admin>`, map it to a product, read it back through
`GET /mappings`, resolve it in `<zb-product-customizer product-id=…>` through the public route, and check that an
unmapped product and an archived template stay silent.

```bash
# 1. a local Postgres with the migrations applied (see "Local development")
# 2. a throw-away wrangler config with a local R2 bucket and the test page origin allowed for CORS:
cp wrangler.jsonc wrangler.e2e.jsonc   # then: drop the "env" block, set "STORAGE_DRIVER": "r2",
                                       #   "CORS_ALLOWED_ORIGINS": "http://127.0.0.1:4310",
                                       #   and add "r2_buckets": [{ "binding": "PERSONALIZATION_ASSETS", "bucket_name": "e2e-local" }]
npx wrangler dev -c wrangler.e2e.jsonc --port 8787 --persist-to /tmp/wrangler-e2e-state

# 3. from the repository root (values come from worker-api/.dev.vars)
npm run build:element
ZB_E2E_API_URL=http://localhost:8787 ZB_E2E_TOKEN=<DEV_AUTH_TOKEN> ZB_E2E_STORE_ID=<DEV_STORE_ID> ZB_E2E_PORT=4310 \
  npx vitest run --config tests/browser/vitest.config.mts tests/browser/cloud-e2e.spec.ts
```

The test leaves its template (archived) and mapping in the dev database; use unique names and clean up with SQL if
you care. It needs no Cloudflare account.

## Angular integration

Persistence is chosen at runtime (`src/app/app.config.ts`): with no `window.__ZB_PERSONALIZER__` the
app uses `LocalConfigurationRepository` (IndexedDB) unchanged; with `apiBaseUrl` set it uses
`CloudConfigurationRepository`, which implements the **same** `ConfigurationRepository` contract, so no
editor/renderer/component code changes. See `src/app/workspace/cloud/`:

- `runtime-config.ts` — reads host config; default local.
- `api-client.service.ts` — `HttpClient` wrapper (auth header, request id, typed errors).
- `asset-sync.service.ts` — uploads `idb:`/`data:` assets to R2, rewrites refs to delivery URLs.
- `cloud-configuration-repository.service.ts` — cloud-authoritative repo with an IndexedDB read-cache.
- `migration.service.ts` — the IndexedDB → cloud migration.

## IndexedDB → cloud migration

`MigrationService.migrateAll()` is user-triggered (never automatic on startup) and:

- **non-destructive** — local IndexedDB is never cleared;
- **idempotent** — configs push under their existing local id; assets push under their `idb:` ref; the
  Worker dedupes both;
- **resumable** — per-record status is written to a new `sync` IndexedDB store, surviving refreshes;
- **verified** — a record is marked `migrated` only after the cloud copy is read back.

Failed records are retried on the next run; `MigrationService.status()` exposes per-record state for
inspection/recovery.

## Database migrations

- Current migrations: `0001_platform.sql`, `0002_personalization.sql`, `0003_mappings_markups.sql`.
- SQL files in `migrations/`, applied in filename order, each in its own transaction, tracked by
  checksum in `platform.schema_migrations`.
- **Append-only:** editing an already-applied file is refused (add a new migration instead).
- Idempotent objects (`IF NOT EXISTS`, `ON CONFLICT`) so re-runs are safe.

```bash
DATABASE_URL=<local|staging|prod> npm run migrate           # apply
DATABASE_URL=<...> npm run migrate:status                   # inspect
```

Run against staging/production from CI or a trusted bastion using that environment's credentials.
**Never** run destructive schema changes during normal API requests (the Worker never does).
Forward-recovery is preferred: to undo, write a new migration that reverses the change.

## Testing

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest: unit + full HTTP integration
```

Integration tests call the Hono app's `fetch` with a test `Env`: a **real local Postgres** and an
in-memory R2. They cover health, auth (401), CRUD, optimistic-concurrency conflicts, idempotent
create, structured 422s, duplicate/archive/restore/delete, publish + version history, **tenant
isolation**, the full R2 upload/delivery/ownership/reference-protected-delete flow, invalid-file
rejection, resumable-upload idempotency, and CORS.

Mappings, markups, settings and the public storefront (precedence, draft/archived/unpublished handling, re-publish,
cross-tenant isolation, unknown keys, rate limiting with an injected store/clock, CORS, ETag/304, asset rewriting and serving)
are covered in `test/mappings.test.ts`, `test/markups.test.ts`, `test/storefront.test.ts` and `test/storefront-unit.test.ts`.

Set `TEST_DATABASE_URL` to point at a disposable test database (default
`postgres://personalizer:personalizer_local_dev@127.0.0.1:5432/personalizer_test`).

## Deploying to staging / production

One-time Cloudflare setup per environment (replace names/ids; **ids are environment-specific, not
secrets, but update `wrangler.jsonc` with the real ones**):

```bash
# 1. Create the Hyperdrive config pointing at that environment's Postgres (the connection string,
#    which contains the DB password, is stored by Cloudflare — not in your repo).
wrangler hyperdrive create zb-personalization-prod \
  --connection-string="postgres://USER:PASSWORD@HOST:5432/DBNAME"
#    → copy the printed id into wrangler.jsonc env.production.hyperdrive[0].id

# 2. Create the R2 bucket.
wrangler r2 bucket create zb-personalization-assets-production

# 3. Set secrets (never in source):
wrangler secret put JWT_SIGNING_SECRET --env production
wrangler secret put INTEGRATION_ENCRYPTION_KEY --env production   # openssl rand -base64 32 — back it up!
wrangler secret put CUSTOMIZATION_TOKEN_SECRET --env production
#    (DEV_AUTH_TOKEN / DEV_STORE_ID are NOT set in production.)

# 4. Apply migrations against the production database from CI/bastion:
DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DBNAME" npm run migrate

# 5. Deploy:
npm run deploy:production     # wrangler deploy --env production
```

Staging mirrors the above with `--env staging` and its own Hyperdrive id, bucket, secret, CORS
allowlist and API URL. Keep staging and production fully separated; never point local/staging at
production resources.

**Rollback:** `wrangler rollback [--env <env>]` reverts the Worker to the previous deployment. Schema
changes roll forward via a new migration. Validate `GET /api/v1/health` after any deploy or rollback.

## Security notes

- Store identity from verified token claims only; never from client input.
- All SQL is parameterized; every query is store-scoped.
- CORS is a restrictive allowlist (`CORS_ALLOWED_ORIGINS`); disallowed origins get no ACAO.
- File **contents** are validated (magic bytes), not the declared MIME type; size-capped.
- Object keys are server-generated, sanitized and traversal-free.
- 5xx responses are opaque; stack traces/causes are logged server-side only.
- Secrets never appear in logs or responses; the health check reveals no connection details.
- Rate limiting: authenticated routes rely on Cloudflare edge rate limiting. The PUBLIC storefront routes have a small
  in-Worker per-isolate limiter (best-effort); also add edge rules for production (see the storefront section).
- Public storefront routes never take the store from a token and expose only published, non-archived data of a store
  that has the plugin enabled; assets are served only while a published config references them.

## Operational notes

- **Logging:** structured JSON lines with `requestId`, `plugin`, `storeId` and operation context. No
  tokens, secrets, payload bodies or file bytes are logged. `observability` is enabled in
  `wrangler.jsonc`.
- **Backups / PITR:** **not configured by this project.** Enable and verify automated backups / point-
  in-time recovery on your managed Postgres (e.g. the provider's PITR) before relying on it. Do not
  assume backups exist until verified.
- **Connection lifetime:** one short-lived `pg` client per request (Hyperdrive pools at the edge),
  closed after the response via `waitUntil`. Transactions are short and never wrap R2 I/O.

## Limitations, assumptions & risks

- **No production identity provider** is included. `JWT_SIGNING_SECRET` + the token contract are the
  integration boundary; wire ZenBasket's token issuance to complete auth.
- **Cloud deployment not provisioned here.** Verified locally: migrations, the full HTTP API + R2 flow
  via node integration tests, and an end-to-end run on the real `workerd` runtime (`wrangler dev`) with
  a local Postgres (Hyperdrive `localConnectionString`) and Miniflare R2 — health DB check, config
  CRUD and R2 upload/retrieval all pass. A live Cloudflare account (deployed Hyperdrive + R2 + secrets)
  has **not** been exercised; do a staging smoke test after the one-time setup above.
- **Angular ↔ cloud path** is implemented and type-checked (production build passes) but **not verified
  against a live deployment**. Point a local app at `wrangler dev` to validate before release.
- **In-Worker rate limiting is best-effort only**: the public storefront limiter is per isolate and in memory (not a global limit).
  Authenticated routes have no in-Worker limiter. Configure Cloudflare rate-limiting rules for production.
- **Storefront additions are verified locally only**: node integration tests (real Postgres, in-memory R2), the migration applied to the
  local dev DB, `wrangler deploy --dry-run`, and a `wrangler dev` (workerd) smoke run of create/publish/map/storefront read. Not verified
  without a live Cloudflare account: real edge caching (`s-maxage`, `Vary: Origin` and ETag revalidation through the CDN), R2/S3 streaming of
  public assets, `CF-Connecting-IP` behaviour, multi-isolate rate limiting, and Hyperdrive latency of the bulk endpoint (it issues a handful of
  set-based queries, not one per item).
- **Storefront assumptions/risks**: `storeId` is the guessable external store id (a public key, not a secret); the safety comes from serving
  published data only. Published configs that reference browser-local or relative assets are deliberately not served. Asset reference checks use a
  substring match on the published JSON (same approach as the existing delete guard). The public asset URL does not carry the store key, so
  a cached asset can outlive an unpublish by up to its `s-maxage` (7 days).
- **Mapping model**: one configuration per `(scope, externalId)`; draft-only/archived configs can be mapped (the response says so via `configStatus`)
  but are not served until published/restored. Archived configs cannot receive new mappings (422).
- **Publish fidelity during migration:** the Worker publishes the current draft, so a config with
  pending unpublished changes migrates with the cloud published snapshot reflecting the draft rather
  than the older published copy. Configs with no pending changes migrate faithfully.
- **Merchant-asset cleanup** (`personalization.assets`) still relies on the reference check at delete time
  plus config-delete cleanup; the scheduled sweep covers *customer* files only.
- **Ordered-customization retention is undefined.** Nothing deletes `ordered` customizations or their
  files; define the business retention policy (and a purge) before this grows unbounded.
- **Customer-upload abuse** is bounded by per-IP limits (in-memory, per isolate — add Cloudflare rate-limit
  rules), the upload size cap, per-file image sniffing and the 24 h unattached-upload sweep; there is no
  per-store quota on pending customizations or stored bytes yet.
- **`customization.data` is validated structurally only** (object, ≤256 KB, bounded depth). It is not
  checked against the config's fields/limits server-side.
- **`INTEGRATION_ENCRYPTION_KEY` rotation** (re-encrypting stored secrets under a new master key) has no
  tooling yet; the recovery path is to issue new credentials.
- **Callback scope:** only `order.confirmed` is supported. Order cancellation/refund events do not change a
  customization's state.
- Server-side config validation is structural + limits + minimal publish-readiness; the authoritative
  deep/business validation remains the shared Angular validator.
