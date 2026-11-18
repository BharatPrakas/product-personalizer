# Product Personalization API — Cloudflare Worker backend

The dedicated Cloudflare Worker that provides cloud persistence for the Product Personalization
application: configurations and versions, assets, product mappings, the public storefront routes,
customer customizations and signed order events. It has its own Cloudflare D1 (SQLite) database and its
own object-storage bucket, and nothing else runs on it. Which extensions exist, and whether a store has
this one installed, is the hosting platform's concern, not this Worker's.

```
Angular app ──HTTPS/JSON──▶ Cloudflare Worker (Hono) ──▶ D1 (SQLite, dedicated)
                                   │
                                   └──────────────────────▶ R2 (artwork, images, mockups, previews)
```

- **D1** is the authoritative store for configurations, version history and asset metadata. It is a
  native Cloudflare binding (no pooling layer): the Worker calls `env.DB` directly.
- **R2** stores binary files. Image bytes are never stored in D1's JSON-as-TEXT columns.

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
- [Asset workflow (direct R2 / S3 uploads)](#asset-workflow-direct-r2--s3-uploads)
- [End-to-end with the Angular elements](#end-to-end-with-the-angular-elements)
- [Angular integration](#angular-integration)
- [IndexedDB → cloud migration](#indexeddb--cloud-migration)
- [Migrations](#database-migrations)
- [Testing](#testing)
- [Deploying to staging / production](#deploying-to-staging--production)
- [Environment variables](#environment-variable-inventory)
- [**Beginner's guide: database, configuration & deployment**](docs/beginner-deployment-guide.md)
- [Fresh development environment (reset runbook)](docs/fresh-dev-environment.md)
- [Security notes](#security-notes)
- [Operational notes](#operational-notes)
- [Limitations, assumptions & risks](#limitations-assumptions--risks)

---

## Prerequisites

- Node.js 20+ (verified on Node 24).
- A Cloudflare D1 database. Local development uses Miniflare's local D1 emulation (via `wrangler dev`
  / the test harness) — no separately-provisioned database server, unlike the retired Postgres setup.
  **Separate from ZenBasket's MySQL** — this service never connects to or migrates that database.
- A Cloudflare account with Workers, D1 and R2 enabled (for deployment only).

## Project structure

```
worker-api/
├── src/
│   ├── index.ts                 # Worker entry (fetch + scheduled/cron handlers)
│   ├── app.ts                   # Hono app assembly: middleware pipeline + the three route groups
│   ├── scheduled.ts             # the hourly cleanup job run by the cron trigger
│   ├── config/environment.ts    # Env bindings + parsed AppConfig
│   ├── middleware/              # request-id, cors, database, auth, tenant (registers the store), errors
│   ├── modules/
│   │   ├── personalization/     # configs, assets, mappings, markups, storefront, customizations, order events, cleanup
│   │   ├── zenbasket-auth/      # plugin-level secret: HKDF purpose keys + order-webhook signature checks
│   │   ├── store-settings/      # known stores; a row makes a store "known" to the public routes
│   │   ├── audit/               # append-only audit log
│   │   └── health/              # GET /health
│   ├── database/                # thin D1 binding wrapper (connection.ts) — no transaction helper:
│   │                            #   D1 has no interactive transactions, only atomic batch()
│   ├── storage/                 # object storage (R2 or S3) + safe key generation
│   └── shared/                  # api-paths (URL contract), errors, responses, logger, jwt, image-sniff, rate-limit, Hono context types
├── migrations/                  # version-controlled SQLite DDL (ONE consolidated baseline), applied with
│                                 #   `wrangler d1 migrations apply`
├── docs/zenbasket-integration.md # API + authentication contract for the ZenBasket backend team
├── docs/fresh-dev-environment.md # runbook: recreate the dev D1/secrets/Worker from scratch (commands to review)
├── scripts/zb-dev-sign.mjs      # local stand-in for ZenBasket's signer: real JWTs + signed callbacks
├── test/                        # vitest: unit + full HTTP integration (Miniflare-backed D1 + in-memory R2)
├── wrangler.jsonc               # Worker config, bindings, environments
└── package.json
```

`src/app.ts` is the endpoint inventory: it mounts the storefront (public), integration (signed
server-to-server) and merchant (Bearer token) route groups directly. Their URL prefixes are defined once
in `src/shared/api-paths.ts` and are a stable contract: saved configurations embed signed asset URLs, and
the element bundles and the ZenBasket team call these paths.

## Local development

### 1. Install

```bash
cd worker-api
npm install
```

### 2. No separate database to provision

D1 needs nothing installed locally: `wrangler dev` creates a local SQLite file under `.wrangler/state`
on first run, scoped to this Worker. There is no connection string, role or server to set up.

### 3. Apply migrations

```bash
npm run migrate            # wrangler d1 migrations apply <db> --local (idempotent)
npm run migrate:status     # wrangler d1 migrations list <db> --local
```

This applies `migrations/0001_baseline.sql` (the only migration) to the **local** D1 database `wrangler dev`
uses — never a deployed one. Migrations are tracked by wrangler's own `d1_migrations` table.

### 4. Local dev secrets

```bash
cp .dev.vars.example .dev.vars   # gitignored
```

Set `ZB_PLUGIN_SECRET` (any value of at least 32 characters), `ZB_PLUGIN_ID` (e.g. `160`) and
`ASSET_SIGNING_SECRET`, plus your storage keys. **There is no development token and no auth bypass**: locally
you authenticate the way ZenBasket does, with real signatures made from that same secret by the bundled
signer (it reads `.dev.vars`, uses only `node:crypto` and never prints the secret):

```bash
npm run dev:token -- --store 766                                          # a merchant JWT (1 h; --ttl, --plugin, --sub)
npm run dev:event -- --store 766 --customization <uuid> --product <id>    # a signed order.confirmed, POSTed to --url (default :8787)
npm run dev:event -- --file event.json --dry-run                          # or print url + headers + body without sending
```

(`.dev.vars.example` is matched by the `.dev.vars.*` gitignore pattern, so it is a local template and is not committed.)

### 5. Run the Worker

```bash
npm run dev            # wrangler dev on http://localhost:8787 (local D1 + local R2)
```

Smoke test:

```bash
curl http://localhost:8787/api/v1/health
# {"data":{"status":"ok","checks":{"database":"ok"}, ...}}

TOKEN=$(npm run -s dev:token -- --store 766)
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
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
    authToken: '<merchant JWT>',   // issued by ZenBasket; locally: paste the output of `npm run dev:token -- --store <id>` (expires, default 1 h)
    persistence: 'cloud',
  };
</script>
```

With no such config the Angular app stays on IndexedDB (local) — unchanged.

## Database schema

A single flat D1 (SQLite) database holds everything — no schema namespacing, since D1 databases are
already per-Worker. The baseline migration `migrations/0001_baseline.sql` creates it; ids are
`TEXT` UUIDs generated application-side (`crypto.randomUUID()` — SQLite has no `gen_random_uuid()`),
and every `jsonb` column from the original design is `TEXT` holding `JSON.stringify`'d data, validated
with SQLite's `json_valid()`/`json_type()` rather than Postgres's `jsonb_typeof()`. Timestamps are
`TEXT` ISO-8601 strings (`strftime('%Y-%m-%dT%H:%M:%fZ','now')` as the default), not a native
`timestamptz` type — SQLite has none.

### Stores and audit

| Table | Purpose |
|---|---|
| `store_settings` | One row per store (tenant). `store_id` is the **external** ZenBasket id — there is no local users/stores table. The row is created on the store's first authenticated request, and the public routes treat a store without one as unknown. It has no other columns of its own. |
| `audit_logs` | Append-only log of privileged operations (identifiers + small metadata only; never secrets or payloads). |

### Configurations and assets

| Table | Purpose |
|---|---|
| `configs` | One row per managed configuration. `draft` and `published` are JSON-as-`TEXT` (the renderer's `ProductConfig` is stored verbatim — never flattened). `updated_at_ms` is the optimistic-concurrency token. `client_config_id` is unique per store (stable local↔cloud id + idempotent migration). |
| `config_versions` | Immutable publish history (one row per publish). |
| `assets` | Metadata for every binary in object storage: `object_key`, verified `content_type`, `size_bytes`, dimensions, `checksum_sha256`, `status`, and the client's `idb:` ref for dedupe. |

### Mappings and markups

| Table | Purpose |
|---|---|
| `mappings` | Links a host product / variant / collection (`scope`, `external_id`) to one configuration, per store. `UNIQUE (store_id, scope, external_id)`; index `(store_id, config_id)`. `(config_id, store_id)` is a composite FK to `configs (id, store_id)` with `ON DELETE CASCADE`, so deleting a config removes its mappings and the database itself refuses a cross-store mapping. `label` (<= 200) caches the host product title for the admin UI. |
| `markups` | Reusable merchant-authored snippets: `kind` (`area` \| `artwork`), `name` (1..120), `payload` JSON-as-`TEXT` (must be an object; <= 256 KB enforced by the API). `UNIQUE (store_id, kind, lower(name))`; index `(store_id, kind)`. |

Timestamps follow one convention: `*_ms` epoch-millisecond integers, plus `created_at` / `updated_at`
ISO-8601 `TEXT`.

### Customizations, order events and cleanup

| Table | Purpose |
|---|---|
| `customizations` | A shopper's saved design: pins `(config_id, store_id, config_version)` through a composite FK to `config_versions` (`ON DELETE RESTRICT`), records the ZenBasket `product_external_id` / `variant_external_id` and the mapping that matched, `data` JSON-as-`TEXT`, `status` (`saved` → `ordered` \| `expired`) with a CHECK tying status to its timestamps, `expires_at` for the 30-day inactivity expiry, and `pending_attach_count` — not business state, a counter two triggers use to make "create the customization and claim its uploaded files" all-or-nothing without a transaction (see "Database access" below). |
| `customization_assets` | Customer files (private object-storage prefix `…/customizations/`): `kind` upload / preview / artwork (the print-ready file of a printable area), `status` uploaded → attached → released → deleting → deleted, `delete_after` (grace period), retry bookkeeping. Owner FK `(customization_id, store_id)`. Kept apart from `assets` so merchant-asset logic and public delivery can never touch customer files. |
| `order_links` | The ZenBasket order line a customization was bought on. `UNIQUE (customization_id)` and `UNIQUE (store_id, external_order_id, external_line_id)` give the idempotency/conflict guarantees. It also keeps the line's optional display details when the event carries them — `variant_external_id`, `quantity`, `line_title`, `line_sku`, `unit_price` (decimal string) — all nullable, filled only while NULL. |
| `order_details` | **Customer PII.** One row per order, `PRIMARY KEY (store_id, external_order_id)`, with the optional order-level details of `order.confirmed` (contract v1 section 7, [proposed – optional]): `order_number`, `placed_at` (UTC ISO), `currency`, and JSON-as-`TEXT` `totals`, `customer`, `shipping_address`, `billing_address` (`json_valid` + object checks), plus `last_event_id`, `created_at`, `updated_at`. Every detail column is nullable; a row exists only once the order has at least one linked line in that store. Indexed on `(store_id, order_number)` for search. **Plain text at rest** — D1 has no field-level encryption — and only returned by the authenticated merchant `/orders` routes. Nothing purges it (see "Limitations"). |
| `integration_events` | Durable event-id deduplication for order events, `PRIMARY KEY (store_id, event_id)` + a payload hash. One row per processed event (it may carry several order lines); `results` (JSON-as-`TEXT`) stores the per-line outcome so a replay answers identically, `line_count` the number of lines, and `status` (`processing` → `completed`) lets a crashed or genuinely concurrent duplicate delivery be resumed safely instead of answering with incomplete results — see "Order callback concurrency" below. |
| `cleanup_runs` | One row per scheduled cleanup run with its counts and outcome. |

ZenBasket identifiers (store, product, variant, order, line) are plain `text`; there are **no foreign keys
to ZenBasket's MySQL database**.

Design rationale: the configuration is already a structured JSON document, so it is stored verbatim
(JSON-as-`TEXT`) and only lifecycle/ownership/versioning metadata is relational. Every row carries
`store_id` and every query is store-scoped, so a store can never read another store's data by guessing
an id. Uniqueness: `(store_id, client_config_id)` and `assets.object_key`. Indexes cover the frequent
store-scoped list queries.

### Database access

`src/database/connection.ts` wraps the `DB` (D1) binding directly — `env.DB.prepare(sql).bind(...)`.
There is no `transaction()`/`BEGIN`: D1 has no interactive transactions, only `batch()`, which runs a
fixed list of prepared statements atomically (all succeed or none do) with **no branching between
them** based on an earlier statement's result. Every former `runInTransaction(db, async (tx) => ...)`
call site was restructured around that constraint — read everything needed first, decide, then submit
the full write set as one `batch()` — rather than papering over it with a retry wrapper (D1 also has no
serialization-failure errors to retry; writes to one database are fully serialized, so there is nothing
to retry).

Two call sites needed more than a mechanical port:

- **Claiming uploaded files when a customization is saved/updated** (`customization-repository.ts`
  `insertWithAttach`/`applyUpdate`) used to insert the row and conditionally claim N uploads inside one
  Postgres transaction, rolling back both if the claim came up short. `batch()` can't make one
  statement's execution conditional on another's row count, so this is now enforced in SQL instead: the
  `pending_attach_count` column plus two triggers in `migrations/0001_baseline.sql`
  (`customization_assets_attach_decrement`, `customizations_attach_guard`) make the whole batch
  `RAISE(ABORT, ...)` — rolling back the insert and the claim together — if the claimed count ever
  comes up short. No compensating delete/release is ever issued.
- **Order callbacks** (`order-callback-service.ts`) used one Postgres transaction with a `SAVEPOINT`
  per line, so a rejected line didn't undo the others. D1 has no savepoints. Each line now commits as
  its own small `batch()` (its link insert and its `saved`→`ordered` flip, gated by the same
  all-or-nothing trick: the UPDATE's `WHERE` requires the link to now exist for *that specific*
  customization+order+line, so a losing `ON CONFLICT DO NOTHING` insert — whichever unique constraint
  it lost on — stops the status flip too, without branching). The event dedup row's new `status` column
  (`processing`/`completed`) lets a crashed or concurrently-retried delivery resume safely: every line's
  write is already conditional and idempotent, so re-running them is always safe, just not always
  necessary. A genuinely concurrent duplicate delivery briefly polls (bounded, ~500 ms) for the other
  request to finish before giving up and reprocessing itself.

## API reference

All routes are under `/api/v1`. Responses use a consistent envelope:

```jsonc
// success
{ "data": <T>, "meta"?: { "pagination": {...} }, "requestId": "..." }
// error
{ "error": { "code": "...", "message": "...", "requestId": "...", "details"?: {...} } }
```

### Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Public. Liveness + shallow DB check. No secrets. |

### Configurations

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

### Assets

| Method | Path |
|---|---|
| POST | `/plugins/personalization/assets` (raw image body; `?filename=&clientRef=&configId=`) |
| GET | `/plugins/personalization/assets` (`?configId=&page=&pageSize=`) |
| GET | `/plugins/personalization/assets/:assetId` (metadata) |
| GET | `/plugins/personalization/assets/:assetId/content` (authorized delivery) |
| DELETE | `/plugins/personalization/assets/:assetId` (refused with 409 if still referenced) |

See [Mappings, markups & the public storefront route](#mappings-markups--the-public-storefront-route)
for the mapping / markup / settings routes (authenticated) and the public storefront routes.

Status codes: `200/201/204` success, `401` unauthenticated, `403` forbidden,
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
| POST | `/mappings/bulk` | `{ configId, create?: [{scope, externalId, label?}], deleteIds?: string[], reassign? }`, max 500 items (create + deleteIds). The deletes and the first create round's label/move/insert writes are ONE atomic `batch()` — not two separate phases — so an ordinary call (no other request racing the same target) is all-or-nothing end to end, same as the old single Postgres transaction. Only a crash *between two retry rounds*, reachable only when a genuinely concurrent writer races the exact same target, can leave the call partially applied, and even then every write is idempotent and keyed by the target itself, so the next call touching that target (a retry of this one, or any other) always converges cleanly |
| GET | `/markups` | `?kind=&search=&limit=&cursor=` (`search` is a literal, case-insensitive substring of the name) |
| POST | `/markups` | `{ name, kind, payload }` -> 201 |
| PUT | `/markups/:id` | `{ name?, payload? }` |
| DELETE | `/markups/:id` | 204 |

`configId` in every mapping request/response is the configuration's **client id** (`ConfigRecordDto.id`,
e.g. `cfg-ab12cd34`), the same id used in `/configs/:configId`. `GET /configs` and `GET /configs/:id`
now also carry an optional `mappingCount`.

Public (anonymous: no token, key or secret of any kind), under `/api/v1/storefront/personalization`:

| Method | Path | Notes |
|---|---|---|
| GET | `/products/:externalId/config` | `?storeId=` (required) `&variantId=` `&collectionIds=a,b,c` (max 20) |
| GET | `/assets/:assetId` | streams a stored image if a published, non-archived config of the owning store references it |
| POST | `/uploads/url`, `/uploads/complete` (legacy: `/uploads`) | `?storeId=`; direct image upload, see [docs/direct-uploads.md](docs/direct-uploads.md) |
| POST / PUT | `/customizations`, `/customizations/:id` | `?storeId=`; save / replace a customization; the response carries `customizedImageUrl` |
| GET | `/customization-images/:assetId` | `?storeId=`; the customized image, for `<img src>` (see "Customized image" below) |
| OPTIONS | every route above | CORS preflight (`204`, `Access-Control-Allow-Origin: *`) |

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
  `store_settings.store_id`. The store must be known (it has made at least one authenticated request). A missing `storeId`
  is a 422; an unknown or malformed key (anything outside `[A-Za-z0-9._:-]{1,128}`) is answered exactly like "nothing
  mapped" so store existence is not leaked.
- Response `200`, body `{ "data": { personalizable: true, configId, version, scope, externalId, config } }` where `config` is the
  **latest published snapshot** (never the draft), or `{ "data": { "personalizable": false } }`. `scope`/`externalId` describe the mapping
  that matched (e.g. the variant id). The body deliberately has **no `requestId`** so it is byte-stable and cacheable; the id is in `X-Request-Id`.
- A published config that still contains a reference the storefront cannot serve (browser-local `idb:`/`data:`, a relative path with no absolute
  `assetBaseUrl`, an asset of another store, a deleted asset) is **not served** (`personalizable:false`, a warning is logged).
- Caching: `ETag` is the strong SHA-256 of the exact body; `If-None-Match` (strong or weak, lists, `*`) -> `304` with the same headers.
  `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600` for `personalizable:true`;
  `public, max-age=10, s-maxage=30, stale-while-revalidate=60` for `personalizable:false`;
  errors (4xx, 429) are `no-store`.
- Not on the global admin CORS allow-list: see CORS below.

**Asset rewriting** (`src/modules/personalization/storefront-assets.ts`, one pure function with unit tests): every `src`, `thumbnail`
and `thumbnailSrc` (mockups, overlays, fixed-image layers, fonts, artwork choices) is classified. Worker delivery URLs
(`.../plugins/personalization/assets/<id>/content`, any origin) and R2 custom-domain URLs (`ASSET_PUBLIC_BASE_URL/<object key>`) that belong
to the requesting store become `<request origin>/api/v1/storefront/personalization/assets/<id>`; other absolute `http(s)` URLs are kept; relative
paths resolve against an absolute `assetBaseUrl`, or — when the template's base is relative/missing (the editor's default `assets/`) — against this environment's `BUNDLED_ASSET_BASE_URL` var (the hosted `.../assets/` of the built element; set it per environment in `wrangler.jsonc`, it is what lets the plugin's hosting path change per deploy without touching stored templates; unset = such templates answer `personalizable:false`); `assetBaseUrl` is then dropped (all references are absolute). The origin is the origin the
request arrived on (https behind Cloudflare). `GET /assets/:assetId` only serves a `stored` asset whose store's published, non-archived config
references it (by id or object key); it sets `Cache-Control: public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400`, a strong
`ETag` (the stored SHA-256), `nosniff`, `Cross-Origin-Resource-Policy: cross-origin` and `Access-Control-Allow-Origin: *`.

**CORS.** Every public storefront response (success and error) and every preflight carries `Access-Control-Allow-Origin: *` and
`Access-Control-Expose-Headers: ETag, X-Request-Id`; credentials are never allowed and there is no per-store origin list (the former
`store_settings.storefront_origins` setting and its `/settings/storefront` route were removed from the baseline schema). Public
routes read nothing from the caller's cookies or headers, so any page may call them, and a browser Origin gives no access an attacker
could not get with curl. What still protects them: the store key must be known (unknown/disabled/malformed behave as "not found"),
per-store + IP rate limits, the open-upload cap, `MAX_UPLOAD_BYTES`, magic-byte sniffing and unguessable UUIDs. The global `CORS_ALLOWED_ORIGINS`
list (merchant routes) does **not** apply to `/storefront/*`.

**Customized image.** Saving a customization returns `customizedImageUrl`: the absolute, public URL of the FIRST `preview` asset in the
request's `assets` (`null` if none), e.g.
`https://<worker>/api/v1/storefront/personalization/customization-images/<assetId>?storeId=<store key>`. `GET` it with no headers: it serves
only an **attached `preview`** image of that store (uploads, print artwork, unattached/released files, other stores' files and non-UUID ids are
`404`), with the content type the bytes were **sniffed** as at upload (never the declared one), `Cache-Control: public, max-age=86400, immutable`
(the URL changes with every new preview), an `ETag` of the stored SHA-256 (`If-None-Match` -> `304` without touching storage), `nosniff`,
`Cross-Origin-Resource-Policy: cross-origin`, `Content-Security-Policy: default-src 'none'; sandbox` and `Access-Control-Allow-Origin: *`. The
URL carries the preview's asset id, **not** the customization id. Re-saving with a new preview yields a new URL; the replaced preview is released
and follows the normal grace + cleanup rules, after which its old URL is `404`. Reads are rate limited at 5x the storefront budget.

**Rate limiting.** `src/shared/rate-limit.ts`: a fixed-window counter keyed by store key + `CF-Connecting-IP` (config route) or by IP (assets,
5x budget; preflight has its own counter). Defaults 120 requests / 60 s, tunable with `STOREFRONT_RATE_LIMIT` and `STOREFRONT_RATE_WINDOW_SECONDS`.
Over the limit -> `429` with `Retry-After`. The counter store is injectable (`createApp({ rateLimitStore, now })`). The default store is
**per isolate, in memory** - best-effort only. In production also add Cloudflare WAF **rate-limiting rules** (or the Rate Limiting binding) for
`/api/v1/storefront/*`; without a `CF-Connecting-IP` header (local dev) all clients share one bucket.

## Customizations, order callback & cleanup

The shopper-to-order flow — the storefront element saves a customization when the shopper adds to cart,
ZenBasket carries its id on the cart line and order line, and confirms the order with a signed
server-to-server event — is specified for the ZenBasket team in
**[docs/zenbasket-integration.md](docs/zenbasket-integration.md)**, which implements the platform-wide
**[Extension Platform Contract v1](../docs/extension-platform-contract-v1.md)**. Summary of the guarantees:

- **Event auth:** HMAC-SHA256 over `"<timestamp>.<exact body>"`, keyed by a webhook key derived (HKDF) from
  the **one plugin-level secret** ZenBasket generates at registration (`ZB_PLUGIN_SECRET`; no per-store
  secrets, nothing stored in D1), a configurable timestamp window and constant-time comparison. The body's
  `storeId` is untrusted until the signature verifies, then must be a store the Worker knows (`403
  store_not_authorized` otherwise).
- **Generic envelope, per-line outcome:** `POST /api/v1/integrations/personalization/events` takes the
  contract-v1 envelope (`order`, `lines[].extensions`). Event-id dedup is one row with a `processing`/
  `completed` status; each line then commits independently as its own small atomic batch (product/
  variant check → link → `saved`→`ordered`, with no row lock — D1 has none — only conditional writes).
  A line that breaks a business rule is `rejected` in the per-line `results` (HTTP 200) without undoing
  or blocking the others; a replay returns the *stored* results once the event is `completed`; the same
  `eventId` with a different payload is a 409; a different order/line for an ordered customization is a
  rejected line; a zero-row conditional write triggers a state re-read rather than a blind failure. See
  "Database access" above for how this replaced the single-transaction-with-savepoints design.
- **Privacy:** the shopper API has no tokens: ids are unguessable UUIDs, and the only customer file the public can read is an attached
  `preview` image through `customizedImageUrl` (see "Customized image"). Originals (uploads, print artwork) stay private and are only streamed
  to the authenticated, store-scoped merchant routes. `PUT /customizations/:id` is authorized by the customization id alone, so treat that id as
  a capability: it is returned to the element and carried on the cart line, never put in a public URL.
- **Optional order and customer details** *(contract v1 section 7, [proposed – optional]; the platform
  dispatcher does not send them yet — only signed test fixtures exercise them)*: `order.number`,
  `placedAt`, `currency`, `totals` (`subtotal` / `shipping` / `tax` / `discount` / `total`), `customer`
  (`id`, `name`, `email`, `phone`), `shippingAddress` / `billingAddress` (`name`, `line1`, `line2`, `city`,
  `region`, `postalCode`, `country`, `phone`) and per line `title`, `sku`, `unitPrice`. **Amounts are
  decimal strings in the currency's major unit** (`"12.50"`, non-negative, ≤ 12 integer and ≤ 4 fraction
  digits; `discount` is the positive amount taken off) — never JSON numbers, so no float rounding and no
  per-currency exponent table. Strings are trimmed, `""` counts as absent, every string is length-capped,
  objects are `.strict()` (unknown keys are a 422 naming the field), the email check is deliberately loose
  (`x@y`, no whitespace), `country` must be an assigned ISO 3166-1 alpha-2 code and `currency` three
  letters. The callback body limit is **64 KiB** (was 16 KiB) so a 100-line order with titles fits.
  Events in the original id-only shape behave exactly as before, and their replay hash is unchanged (the
  new fields only enter the canonical hash when present). The HMAC still covers the exact raw body, so
  the new fields are signed like everything else.
- **Merge rule** (`ORDER_DETAILS_UPSERT` in `order-callback-service.ts`): *fill-only, first value wins.*
  A later event or line fills NULL fields; an absent value never blanks a stored one; a stored value is
  never replaced — `totals` and `customer` merge per key, an address only as a whole — and a differing
  value is dropped with a `warn` log listing the field **names** only. Events are not ordered (section
  7), so "latest wins" is not knowable and a replayed old event must not roll a value back. The details
  are written in the same atomic `batch()` as the line's link insert and status flip, only when the order
  has a link in that store; a line that was already linked (`duplicate`) still fills NULLs.
- **PII handling:** customer and address values never go to logs (conflict warnings name fields, not
  values), audit metadata (`order.link` stays `{ orderId, lineId, eventId }`), error messages, or the
  replay record (`integration_events.results` stays per-line outcomes). They are returned only by the
  authenticated, store-scoped merchant API below; the storefront and shopper routes never read them.

### Merchant order API

Authenticated and store-scoped exactly like `/customizations` (the store comes from the verified token),
under `/api/v1/plugins/personalization`. Responses are `Cache-Control: private, no-store`.

| Method | Path | Notes |
|---|---|---|
| GET | `/orders` | Orders with at least one linked line, grouped by `external_order_id`, newest first by first-link time; keyset paging `?limit=` (1..50, default 25) `&cursor=`. Filters: `q` (order id or number, exact or prefix; `%`/`_` are literal), `productId` (orders containing that product), `from` / `to` (ISO date = whole UTC day, `to` inclusive; or ISO date-time), applied to `placedAt`, else the link time. Each item: `{ orderId, orderNumber, placedAt, customerName, linkedAt, lineCount, lines: [{ lineId, productId, title, quantity, status, customizationId, previewAssetId }] }` (at most 10 lines summarised). **Only the customer's name** — never email, phone or addresses — is in the list. |
| GET | `/orders/:orderId` | `{ orderId, orderNumber, placedAt, currency, totals: {subtotal, shipping, tax, discount, total}, customer: {id, name, email, phone}, shippingAddress, billingAddress, linkedAt, lines: [{ lineId, productId, variantId, quantity, title, sku, unitPrice, linkedAt, customization: { id, status, configId, configVersion }, assets: [{ assetId, kind, contentType, sizeBytes, width, height, filename }] }] }`. Every field the store did not send is `null` (an address the store never sent is `null` as a whole). 404 for an unknown order or another store's. |

The full design and the file bytes stay on `GET /customizations/:id` and
`GET /customizations/:id/assets/:assetId/content` (private, `X-Checksum-Sha256`); the order API only
lists them.
- **Cleanup:** an hourly cron (`scheduled()` → `CleanupService`) expires inactive `saved` customizations
  (30 days), releases abandoned uploads, deletes released files after a grace period, and purges empty
  tombstones. It also reaps abandoned direct uploads (expired presigned uploads, their `pending/` objects
  and unreferenced promoted copies — see docs/direct-uploads.md). `ordered` customizations are never touched. Runs are recorded in `cleanup_runs`. Claims
  that used `FOR UPDATE SKIP LOCKED` under Postgres are now plain conditional `UPDATE`/`DELETE`
  statements — D1 serializes every write to one logical writer, so there is no concurrent transaction
  to lock against in the first place.

Verification status: covered by node integration tests against a real Miniflare-backed D1 database
(including concurrent deliveries and mutation-checked safety guards) run inside `workerd` semantics,
not plain Node. Not yet re-verified end to end against a *deployed* `wrangler dev`/live Cloudflare D1
database since the Postgres→D1 migration (it previously was, against Postgres); re-run the storefront
element smoke test (save a design, link it via a signed `order.confirmed`, replay, re-order-rejection)
before relying on a staging deploy.
Not verified without a live Cloudflare account: the deployed cron trigger, D1 behaviour under
production load/concurrency (only Miniflare's local D1 has been exercised), and real R2/S3 deletes of
customer files (tests use an in-memory bucket).

## Authentication & tenancy

The store/tenant identity is derived **only** from a verified credential — never from a client header,
query param or body field. Everything ZenBasket proves to the Worker rests on **one plugin-level secret**,
`ZB_PLUGIN_SECRET`: ZenBasket generates it when the plugin is registered, keeps it in its own credential
store, and it is configured here as a Cloudflare secret per environment. The Worker never generates,
stores, logs or returns it. The full contract (claims, key derivation, signing, rotation, the Node signer
example) is [docs/zenbasket-integration.md](docs/zenbasket-integration.md) §3–§4.

There are exactly two ways in, and they are separate verification flows:

- **Merchant routes** (`middleware/authentication.ts`, `shared/jwt.ts`): an HS256 token ZenBasket signs with the
  plugin secret. The Worker requires a valid signature, `iat` and `exp` (a token with no expiry is refused),
  a `pluginId` equal to `ZB_PLUGIN_ID` (a token minted for another plugin is refused) and a `storeId`; the store
  comes only from that claim.
- **Order callbacks** (`integration-controller.ts`): `POST /integrations/personalization/events` accepts only an
  HMAC-SHA256 signature over `<timestamp>.<raw body>` (`v1=<hex>`), keyed by a key derived with HKDF-SHA256 from
  the plugin secret (`info = zb-plugin:v1:order-webhook`). The body's `storeId` is untrusted until the signature
  verifies, then must be a store the Worker knows.

A merchant token is not accepted as a callback, and a callback signature is not accepted on merchant routes.

**Fail closed, no shortcuts:** with `ZB_PLUGIN_SECRET` missing, blank or shorter than 32 characters, merchant routes
answer `401` and the callback answers `503 integrations_not_configured`; with `ZB_PLUGIN_ID` unset, merchant routes
answer `401`. There is no development token, no bypass flag, no second or previous secret, no key-mode switch and
no credential-management endpoint, and no environment can enable one. Use `npm run dev:token` / `npm run dev:event`
locally. `ASSET_SIGNING_SECRET` (signed asset URLs) is independent and has no fallback.

A store becomes known to the Worker on its first authenticated request (the tenant middleware registers it in
`store_settings`); which stores receive tokens at all is the hosting platform's decision, and there is no
per-store enable/disable switch. Ownership of each config/asset is enforced by store-scoped queries in the
repository.

## Bucket layout

One bucket per environment, with the same layout on R2 and S3:

```
stores/
  <store-id>/
    product-personalization/
      assets/<uuid>.<ext>             that store's merchant artwork and mockups
      customizations/<uuid>.<ext>     PRIVATE customer files (never served by the public asset route)
      pending/<uploadId>              INTERNAL staging for direct uploads (never served or referenced)
```

- The `product-personalization` segment namespaces this service inside a bucket that may be shared with
  other services. It is part of every stored `object_key`, so it must not change (`NAMESPACE` in
  `src/storage/object-storage.ts`).
- Keys are generated server-side by `generateObjectKey`. The store id comes from the verified token,
  never from the request. The file name is a UUID, not the original name.
- Before reading or deleting an object, the service checks that its key sits under the store's expected
  `assets/` or `customizations/` prefix.
- Nothing in this API writes element bundles (`storefront.js`, `store-admin.js`); publish those with your
  own deploy step.
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

- `sig` is an HMAC-SHA256 over the store id and asset id, keyed by `ASSET_SIGNING_SECRET` — **only** that: there is no
  fallback to any other secret, and rotating the plugin secret cannot invalidate these URLs. It never expires, so it can live in the configuration, and it only works for
  that asset.
- A valid signature serves the asset even while it is a draft (`Cache-Control: private`). Without one,
  the route serves only assets referenced by the store's published configuration, as before.
- Any origin may load these URLs cross-origin (`Access-Control-Allow-Origin: *`, no credentials).
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
| production, `--env dev` | `r2` | Cloudflare R2 (`PERSONALIZATION_ASSETS` binding) | R2 bucket binding in `wrangler.jsonc` (`env.dev` → `zb-personalization-assets-dev`); for direct uploads also `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| default (`npm run dev`) / staging | `s3` | AWS S3 (or an S3-compatible endpoint) | `S3_BUCKET`, `S3_REGION`, secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |

- The S3 adapter (`src/storage/s3-storage.ts`) calls the S3 REST API with SigV4 through `aws4fetch`.
  It does not bundle the AWS SDK.
- Use an IAM user per environment, limited to that environment's bucket (`s3:GetObject`,
  `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`). Don't share one key across environments. The same
  credentials sign the browser's presigned URLs, and `s3:ListBucket` is required (see docs/direct-uploads.md).
- Put local keys in `.dev.vars`; set staging keys with `wrangler secret put AWS_ACCESS_KEY_ID --env staging`
  (and the same for `AWS_SECRET_ACCESS_KEY`).
- `S3_ENDPOINT` switches to path-style addressing for S3-compatible services such as MinIO. Leave it unset for AWS.
- A misconfigured backend fails the request with a 500 and a log line naming the missing setting.
  Values are never logged.
- Current placeholders: `S3_BUCKET` and `S3_REGION` in `wrangler.jsonc` still read `REPLACE_WITH_...`.
  Replace them before running local uploads.
- To run locally against R2 instead, add an `r2_buckets` binding for `PERSONALIZATION_ASSETS` and set
  `STORAGE_DRIVER=r2`.

## Asset workflow (direct R2 / S3 uploads)

Files go **from the browser straight to object storage** on a short-lived presigned URL; the Worker
authorizes the upload and verifies the stored object, and never carries the bytes. Full design, API
contract, provider setup (R2 token, IAM policy, bucket CORS), retry/cleanup behaviour, security limits and
the staging checklist: **[docs/direct-uploads.md](docs/direct-uploads.md)**.

1. Angular asks the **authenticated** `POST /assets/upload-url` for a presigned `PUT` (declaring type and
   size). The Worker derives the store from the token, validates the declaration, records a `pending` row in
   `uploads` and signs a URL for one staging key, `…/pending/<uploadId>`.
2. The browser `PUT`s the file directly to R2 or S3 (no credentials, no Worker).
3. Angular calls `POST /assets/complete`. The Worker HEADs the object, reads it (bounded), sniffs the real
   bytes (PNG/JPEG/WebP, or fonts — the browser's Content-Type and extension are not trusted), checks size,
   dimensions and SHA-256, copies it to its permanent `assets/<uuid>.<ext>` key and, in one atomic D1 batch,
   creates the `assets` row and marks the upload `stored`. Completion is idempotent and concurrency-safe.
4. The configuration references the asset's stable delivery URL — never a presigned URL. Presigned reads
   (the merchant `GET /assets/:id/url` and `…/customizations/:id/assets/:assetId/url`) are generated on demand, last 60 s and are never stored.

Shopper uploads follow the same flow (`POST /storefront/…/uploads/url` → `PUT` → `POST …/uploads/complete`,
anonymous; the store key must be known and the bytes are sniffed) and land in the private `customizations/` prefix. The old proxied routes
(`POST /assets`, `POST /storefront/…/uploads`) still work unless `LEGACY_PROXY_UPLOADS=false`.

**Delivery** — a published asset is served by the Worker route (referenced-by-published-config check), or,
if `ASSET_PUBLIC_BASE_URL` is set, rewritten to `<base>/<object key>` for CDN delivery (that host must expose
only the `assets/` prefix — never the whole bucket, which also holds private customer files). Drafts keep the
signed Worker URL.

Deletes verify ownership and refuse (409) if any config draft/published copy or historical version
still references the asset; deleting a config releases only the assets nothing else references. All
storage network work happens outside database batches.

New settings (all optional): `UPLOAD_URL_TTL_SECONDS` (300), `PRIVATE_URL_TTL_SECONDS` (60),
`PENDING_UPLOAD_GRACE_MINUTES` (30), `MAX_OPEN_UPLOADS_PER_STORE` (500), `LEGACY_PROXY_UPLOADS` (true); for R2
direct uploads `R2_ACCOUNT_ID`, `R2_BUCKET_NAME` (vars) and the `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
secrets (an R2 API token scoped to the bucket). The bucket also needs a CORS rule (wildcard origin on a private
bucket — rationale in docs/direct-uploads.md). Without them R2 answers `503 direct_upload_not_configured`
and the Angular client falls back to the proxied upload.

## End-to-end with the Angular elements

The repository's browser suite can drive **both** custom elements against a running Worker
(`tests/browser/cloud-e2e.spec.ts`; skipped unless configured). It uses the real cloud repositories over HTTP:
import and publish a template in `<zb-personalization-admin>`, map it to a product, read it back through
`GET /mappings`, resolve it in `<zb-product-customizer product-id=…>` through the public route, and check that an
unmapped product and an archived template stay silent.

```bash
# 1. the local D1 migrations applied (see "Local development" — `npm run migrate`)
# 2. a throw-away wrangler config with a local R2 bucket and the test page origin allowed for the merchant CORS list:
cp wrangler.jsonc wrangler.e2e.jsonc   # then: drop the "env" block, set "STORAGE_DRIVER": "r2",
                                       #   "CORS_ALLOWED_ORIGINS": "http://127.0.0.1:4310",
                                       #   and add "r2_buckets": [{ "binding": "PERSONALIZATION_ASSETS", "bucket_name": "e2e-local" }]
npx wrangler dev -c wrangler.e2e.jsonc --port 8787 --persist-to /tmp/wrangler-e2e-state

# 3. from the repository root: a real signed token for the store the test uses (the signer reads worker-api/.dev.vars)
npm run build:element
ZB_E2E_TOKEN=$(cd worker-api && npm run -s dev:token -- --store 766) \
ZB_E2E_API_URL=http://localhost:8787 ZB_E2E_STORE_ID=766 ZB_E2E_PORT=4310 \
  npx vitest run --config tests/browser/vitest.config.mts tests/browser/cloud-e2e.spec.ts
```

The test leaves its template (archived) and mapping in the dev database; use unique names and clean up with
`wrangler d1 execute <db> --local --command "DELETE FROM ..."` if you care. It needs no Cloudflare account.

## Angular integration

Persistence is chosen at runtime (`src/app/app.config.ts`): with no `window.__ZB_PERSONALIZER__` the
app uses `LocalConfigurationRepository` (IndexedDB) unchanged; with `apiBaseUrl` set it uses
`CloudConfigurationRepository`, which implements the **same** `ConfigurationRepository` contract, so no
editor/renderer/component code changes. See `src/app/workspace/cloud/`:

- `runtime-config.ts` — reads host config; default local.
- `api-client.service.ts` — `HttpClient` wrapper (auth header, request id, typed errors).
- `asset-sync.service.ts` — uploads `idb:`/`data:` assets directly to R2/S3 (via `ApiClient.uploadAsset` →
  `customizer/util/direct-upload.ts`), rewrites refs to delivery URLs.
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

- **One migration: `migrations/0001_baseline.sql`.** It holds the complete final schema (14 tables, 35 indexes,
  2 triggers): configurations, versions, assets, mappings, markups, customizations and their files, order links and
  details, direct uploads, event deduplication, cleanup bookkeeping, audit log. There are **no authentication
  structures in the database** (no credential table, no stored secrets): authentication lives in Cloudflare
  secrets. A fresh database applies this one file and ends with exactly the final schema; the schema tests build it
  from an empty D1 to prove that.
- It was consolidated on 2026-11-18, when the development database was recreated from scratch, so it is editable
  *only* until a database that must be kept exists. From then on it is frozen and every schema change is a new
  forward file (`0002_…`): wrangler refuses to re-apply an edited, already-applied migration and would leave an
  existing database silently out of step.
- Applied with `wrangler d1 migrations apply`/`list` (the `migrate`/`migrate:status` npm scripts); wrangler tracks
  applied migrations itself in a `d1_migrations` table.
- Idempotent objects (`IF NOT EXISTS`, `ON CONFLICT`) so re-runs are safe.

```bash
npm run migrate                                                          # local (wrangler dev's D1)
npx wrangler d1 migrations apply <database_name> --env dev --remote      # a remote D1 — only when intended
```

Run against remote databases from CI or a trusted bastion, and only deliberately: **never** as a side effect of a
code check. The Worker never changes its schema at request time. Forward-recovery is preferred: to undo, write a new
migration that reverses the change. To recreate the development database from scratch, follow
[docs/fresh-dev-environment.md](docs/fresh-dev-environment.md).

## Testing

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest: unit + full HTTP integration
```

Integration tests call the Hono app's `fetch` with a test `Env`: a **real D1 database**, provided by a
local Miniflare instance (`test/helpers.ts`; not `@cloudflare/vitest-pool-workers`/the full workerd
pool, since that package's current release requires vitest 4.x and this project is on vitest 5 — see
the comment at the top of `test/helpers.ts`), and an in-memory R2. They cover health, auth (401), CRUD,
optimistic-concurrency conflicts, idempotent create, structured 422s, duplicate/archive/restore/delete,
publish + version history, **tenant isolation**, the full R2 upload/delivery/ownership/reference-
protected-delete flow, invalid-file rejection, resumable-upload idempotency, and CORS.

Authentication has its own coverage: `test/api.test.ts` (merchant tokens: signature, `iat`/`exp`, plugin binding,
store claim, fail-closed, no fallback secret, no dev token or bypass in any environment),
`test/order-callback.test.ts` (callback HMAC, timestamp window, derived key, unknown/other store, replay,
idempotency, concurrency, interrupted processing), `test/integration-unit.test.ts` (HKDF known answers and
interop with Node's `hkdfSync`) and `test/dev-sign.test.ts` (the local signer produces credentials the Worker accepts).
Every merchant call in the suite goes out with a real signed JWT — the harness has no dev token either.

Mappings, markups, settings and the public storefront (precedence, draft/archived/unpublished handling, re-publish,
cross-tenant isolation, unknown keys, rate limiting with an injected store/clock, CORS, ETag/304, asset rewriting and serving)
are covered in `test/mappings.test.ts`, `test/markups.test.ts`, `test/storefront.test.ts` and `test/storefront-unit.test.ts`.

Store registration (a store becomes known on its first authenticated request; the public routes and shopper
uploads/saves refuse a store that never has) is covered in `test/store-settings.test.ts`, and
`test/schema.test.ts` builds the single baseline in a brand-new empty D1 and asserts the final schema (the exact
tables, indexes and triggers, no `plugin_id`, no credential structures, the `artwork` file kind, the per-line event
`results`/`status` columns, foreign keys and integrity) and that `0001_baseline.sql` is the only migration file.

Each test file gets its own fresh, disposable Miniflare D1 instance (no connection string or
pre-existing database to point at, unlike the retired Postgres setup) — see `getTestD1()` in
`test/helpers.ts`.

## Deploying to staging / production

### Worker environments (what `wrangler.jsonc` defines)

Each `--env` is a **separate Worker** (its name is `zb-product-personalizer-api-<env>`) with its own D1 database, bindings,
vars and secrets. Wrangler does **not** inherit `vars`, secrets or bindings from the top level into an environment, so
every environment block must carry everything it needs — and a resource named "staging" is a real resource of its own,
not a scratch copy.

| `--env` | Worker | D1 database (binding `DB`) | R2 bucket (binding `PERSONALIZATION_ASSETS`) | `STORAGE_DRIVER` |
|---|---|---|---|---|
| *(none)* — `npm run dev`, local only | `zb-product-personalizer-api` | `zb-product-personalizer-db` (placeholder id; only ever a local SQLite file) | – | `s3` |
| `dev` | `zb-product-personalizer-api-dev` | `zb-product-personalizer-db-dev` | `zb-personalization-assets-dev` | `r2` |
| `staging` | `zb-product-personalizer-api-staging` | `zb-product-personalizer-db-staging` | – (S3 bucket `zb-plugins`) | `s3` |
| `production` | `zb-product-personalizer-api-production` | `zb-product-personalizer-db-production` (not created yet: placeholder id) | `zb-personalization-assets-production` (not created yet) | `r2` |

Secrets, routes and the `workers.dev` URL belong to a Worker **name**: a secret set for `--env dev` is invisible to
`--env staging`. Never point one environment at another's D1 database or bucket.

### Environment variable inventory

**Secrets** — `wrangler secret put <NAME> --env <env>` (prompts; never on the command line) or `.dev.vars` locally:

| Name | Required | Purpose |
|---|---|---|
| `ZB_PLUGIN_SECRET` | **always** | ZenBasket's plugin-level secret (≥ 32 chars): verifies merchant JWTs and, through the derived key, order callbacks. One value per environment. Missing/short = fail closed. |
| `ASSET_SIGNING_SECRET` | wherever configs are edited | Signs asset URLs stored in configurations. Independent of the plugin secret; **no fallback**. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | `STORAGE_DRIVER=r2` + direct uploads | R2 API token scoped to the bucket; presigns browser upload/download URLs only. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`AWS_SESSION_TOKEN` for temporary keys) | `STORAGE_DRIVER=s3` | IAM user scoped to the bucket. |

**Vars** — `wrangler.jsonc` `vars` per environment (non-secret):

| Name | Purpose |
|---|---|
| `ZB_PLUGIN_ID` | **Required.** ZenBasket's id for this plugin; a merchant token's `pluginId` must equal it. Unset = merchant auth fails closed. |
| `ENVIRONMENT`, `API_VERSION`, `LOG_LEVEL` | Labels (`development`/`staging`/`production`), URL version (`v1`), log verbosity. |
| `CORS_ALLOWED_ORIGINS` | Merchant CORS allowlist (the storefront routes answer `*`). |
| `STORAGE_DRIVER`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_S3_ENDPOINT` | Object storage. |
| `ASSET_PUBLIC_BASE_URL`, `BUNDLED_ASSET_BASE_URL`, `MAX_UPLOAD_BYTES`, `LEGACY_PROXY_UPLOADS` | Asset delivery and upload limits. |
| `UPLOAD_URL_TTL_SECONDS`, `PRIVATE_URL_TTL_SECONDS`, `PENDING_UPLOAD_GRACE_MINUTES`, `MAX_OPEN_UPLOADS_PER_STORE` | Presigned URL lifetimes and direct-upload limits. |
| `STOREFRONT_RATE_LIMIT`, `STOREFRONT_RATE_WINDOW_SECONDS`, `STOREFRONT_WRITE_RATE_LIMIT`, `ORDER_CALLBACK_RATE_LIMIT`, `ORDER_CALLBACK_TOLERANCE_SECONDS` | Rate limits and the callback timestamp window (default ±300 s). |
| `CUSTOMIZATION_RETENTION_DAYS`, `UNATTACHED_UPLOAD_TTL_HOURS`, `ASSET_DELETE_GRACE_HOURS`, `EXPIRED_TOMBSTONE_DAYS` | Cleanup timings. |

**Does not exist (and must not be set — it is read by nothing):** `JWT_SIGNING_SECRET`, `ZB_PLUGIN_SECRET_PREVIOUS`,
`ZB_JWT_KEY_MODE`, `INTEGRATION_ENCRYPTION_KEY`, `DEV_AUTH_TOKEN`, `DEV_STORE_ID`, `DEV_AUTH_BYPASS`,
`CUSTOMIZATION_TOKEN_SECRET`. A leftover copy in an environment is harmless but dead; delete it
(`wrangler secret delete <NAME> --env <env>`).

### Deploying

```bash
# One-time per environment (names/ids are environment-specific; the database_id is not a secret).
npx wrangler d1 create <database-name>                  # copy the printed id into wrangler.jsonc env.<env>.d1_databases[0]
npx wrangler d1 migrations apply <database-name> --env <env> --remote
npx wrangler secret put ZB_PLUGIN_SECRET   --env <env>  # ZenBasket's value for THIS environment
npx wrangler secret put ASSET_SIGNING_SECRET --env <env>
# ...plus the storage secrets of the driver in use, and ZB_PLUGIN_ID under vars in wrangler.jsonc

npm run deploy:<env>                                    # wrangler deploy --env <env>
```

Apply the migration **before** the deploy that needs it; `wrangler deploy` never migrates. Validate
`GET /api/v1/health` after any deploy or rollback. **Rollback:** `wrangler rollback --env <env>` reverts the Worker;
schema changes roll forward via a new migration.

To recreate the **development** environment from scratch (new D1, fresh secrets), use the reviewed runbook in
[docs/fresh-dev-environment.md](docs/fresh-dev-environment.md). Nothing in this repository runs remote delete, reset
or deploy commands for you.

## Security notes

- Store identity from verified token claims only; never from client input.
- All SQL is parameterized; every query is store-scoped.
- Merchant CORS is a restrictive allowlist (`CORS_ALLOWED_ORIGINS`); disallowed origins get no ACAO. The anonymous storefront routes answer `*` without credentials.
- File **contents** are validated (magic bytes), not the declared MIME type; size-capped.
- Object keys are server-generated, sanitized and traversal-free.
- 5xx responses are opaque; stack traces/causes are logged server-side only.
- Secrets never appear in logs or responses; the health check reveals no connection details.
- Rate limiting: authenticated routes rely on Cloudflare edge rate limiting. The PUBLIC storefront routes have a small
  in-Worker per-isolate limiter (best-effort); also add edge rules for production (see the storefront section).
- Public storefront routes never take the store from a token and expose only published, non-archived data of a store
  that is known to the Worker; config assets are served only while a published config references them, and the only
  customer file served is an attached `preview` image (`customizedImageUrl`). Anonymous callers can: read published
  configs and their assets; upload size-capped, sniffed PNG/JPEG/WebP images (rate limited, per-store open-upload cap);
  save and `PUT`-replace customizations they hold the id of; and read any attached preview image whose id they know.
  They cannot read customization data, uploads or print artwork, and they cannot list anything.

## Operational notes

- **Logging:** structured JSON lines with `requestId`, `storeId` and operation context. No
  tokens, secrets, payload bodies or file bytes are logged. `observability` is enabled in
  `wrangler.jsonc`.
- **Backups / PITR:** **not configured by this project.** D1 has built-in time-travel (point-in-time
  restore via `wrangler d1 time-travel`, 30 days by default) — confirm it covers your recovery needs
  before relying on it; this is not the same as an independently verified backup.
- **Connection lifetime:** none — D1 is a native binding, not a pooled connection. There is no
  per-request client to open or close, unlike the retired Hyperdrive/`pg` setup.
- **No interactive transactions:** D1 only offers atomic `batch()` (a fixed list of statements, all-or-
  nothing, no branching between them) — see "Database access" above. Every write path that used to run
  inside a Postgres transaction was individually restructured around this; there is no generic
  transaction helper to reach for in new code.

## Limitations, assumptions & risks

- **ZenBasket's side of the plugin-secret model is not in this repository.** The Worker verifies tokens and
  callbacks per docs/zenbasket-integration.md, but the issuer signing with the plugin secret (and carrying
  `storeId`, `pluginId`, `iat`, `exp`), the webhook dispatcher using the derived key, and plugin registration
  (secret + id generation) are ZenBasket's. Until they exist, only locally signed credentials
  (`npm run dev:token` / `dev:event`) can authenticate (the Worker fails closed otherwise).
- **Secret rotation is a coordinated cut-over, not an overlap.** There is one secret; anything signed with the old
  one after the swap is refused, and a refused callback (`401`) is not retried by ZenBasket. Pause delivery first
  (docs/zenbasket-integration.md §3.6).
- **One shared secret means one blast radius.** Whoever holds `ZB_PLUGIN_SECRET` can sign an order event for any
  store the Worker knows (it can then only link existing `saved` customizations, by unguessable id). Rotate on suspicion.
- **No per-store enable/disable switch.** A store is known once its merchant has used the API, and whether a
  store has the extension installed is decided by the hosting platform (which issues the tokens). The
  install / uninstall lifecycle events of contract v1 (section 10) are not implemented; when they are, a
  status column on `store_settings` is the place for them.
- **Remote state is only partly verified.** The staging D1 (`zb-product-personalizer-db-staging`, created
  2026-11-06) was exercised with `wrangler dev --remote --env staging` (real remote D1: integrity checks,
  configs/publish, 130-item bulk mappings against the 100-bound-parameter limit, markups, customizations,
  order-callback concurrency, the attach-count triggers via raw SQL) — against the schema of **that date**. The
  baseline has since gained tables and columns and was consolidated on 2026-11-18, so that database has **not**
  been verified against the current baseline; do not use it without recreating it or catching it up. The
  `-dev` Worker is deployed (its D1 is the disposable development database); the `-staging` and `-production`
  Workers have never been deployed, and no production D1 or bucket exists. Object-storage paths (uploads,
  asset endpoint, cleanup deletion) were not re-verified against a real bucket after R2 was enabled.
- **Angular ↔ cloud path** is implemented and type-checked (production build passes) but **not verified
  against a live deployment**. Point a local app at `wrangler dev` to validate before release.
- **In-Worker rate limiting is best-effort only**: the public storefront limiter is per isolate and in memory (not a global limit).
  Authenticated routes have no in-Worker limiter. Configure Cloudflare rate-limiting rules for production.
- **Storefront additions are verified locally only**: node integration tests (Miniflare-backed D1, in-memory R2), the migration applied to the
  local dev DB, `wrangler deploy --dry-run`, and a `wrangler dev` (workerd) smoke run of create/publish/map/storefront read. Not verified
  without a live Cloudflare account: real edge caching (`s-maxage`, `Vary: Origin` and ETag revalidation through the CDN), R2/S3 streaming of
  public assets, `CF-Connecting-IP` behaviour, multi-isolate rate limiting, and D1 latency/throughput of the bulk endpoint under real production
  load (it issues several small per-item statements batched together, not genuinely set-based bulk SQL — see "Database access" above).
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
- **Order details (customer PII) are kept forever and are plain text at rest.** Nothing purges
  `order_details` or the line details on `order_links`; this is the same open decision as the retention
  of ordered customizations (contract decision 8) and must be settled together with it. D1 offers no
  field-level encryption, so customer names, emails, phones and addresses are stored unencrypted (D1's
  own at-rest encryption only). Do not add fields beyond what fulfilment needs.
- **The platform does not send order details yet.** The webhook accepts them (all optional) and the
  Orders page shows "Not provided by the store" until the ZenBasket dispatcher populates them; verified
  only with signed fixtures.
- **Customer-upload abuse** is bounded by per-IP limits (in-memory, per isolate — add Cloudflare rate-limit
  rules), the upload size cap, per-file image sniffing and the 24 h unattached-upload sweep; there is no
  per-store quota on pending customizations or stored bytes yet.
- **`customization.data` is validated structurally only** (object, ≤256 KB, bounded depth). It is not
  checked against the config's fields/limits server-side.
- **No installation state.** The Worker only knows whether a store is *known* (`store_settings`); it cannot tell
  installed from disabled/uninstalled, because that is the Plugin Manager's state and the lifecycle events are not
  implemented (contract §10). A signed event for a known store that was since uninstalled is still processed.
- **Callback scope:** only `order.confirmed` is supported. Order cancellation/refund events do not change a
  customization's state.
- Server-side config validation is structural + limits + minimal publish-readiness; the authoritative
  deep/business validation remains the shared Angular validator.
- **Markup name case-folding is ASCII-only at the database level, Unicode-aware at the application
  level.** SQLite's `lower()` (and therefore the `markups_store_kind_name_uq` unique index and the
  `instr(lower(name), ...)` search this replaced `ILIKE` with) only folds ASCII letters —
  `lower('CAFÉ')` is `'cafÉ'`, not `'café'` — unlike Postgres's locale-aware `lower()`/`ILIKE`. Markup
  *search* (`markup-service.ts` `list()`) was fixed to fold in JS (`toLocaleLowerCase()`, Unicode-
  correct) instead of in SQL, so "café" still finds "CAFÉ wall art" exactly as it did under Postgres —
  see the regression test in `test/markups.test.ts`. The *uniqueness* constraint was **not** changed
  the same way (it's enforced by the database, not application code): two markups of the same kind
  differing only in the case of a non-ASCII letter (e.g. "CAFÉ" and "café") can now both exist, where
  Postgres would have rejected the second as a duplicate. Plain-ASCII names (the common case — see the
  existing "CHEST AREA" vs "Chest area" test) are unaffected either way.
- **D1 bounds parameters per statement at 100** (well below raw SQLite's default), tighter than
  Postgres's effectively-unbounded `unnest()`-based bulk upserts/`= ANY(...)` filters. Every list-based
  query (`mapping-repository.ts` bulk insert/lookup/delete, `storefront-repository.ts` `findAssets`,
  the collection-ids filter on the public config route) is now chunked (`chunkForParamLimit` in
  `src/database/connection.ts`) or defensively capped so a large list degrades (silently truncated, in
  the one case — `resolveMapping`'s `collectionIds`, capped at 90 — where chunking would also require
  re-merging an `ORDER BY ... LIMIT 1` across chunks) rather than erroring the whole request.
- **Mapping bulk writes are atomic for the ordinary case, self-healing for the rare one** (see the
  `/mappings/bulk` row in the API reference above). D1 has no interactive transaction, but the upfront
  delete and the first create round's writes are folded into one `batch()` (the deletes ordered first,
  so a "delete this mapping, then re-create the same target" request sees its own deletes before its
  own inserts run, inside the SAME atomic unit) — so a normal call, with no other request racing the
  same target, is all-or-nothing exactly like the old single Postgres transaction. Only a crash
  *between two retry rounds* — reachable only when a genuinely concurrent writer races the exact same
  target, never from an ordinary single-caller request — can leave a call partially applied, and even
  then nothing is left inconsistent: every write is idempotent and keyed by the target itself
  (`store_id, scope, external_id`), not by this request, so the next call touching that target — a
  retry of this one, or a completely different caller — converges cleanly rather than duplicating or
  corrupting anything.
