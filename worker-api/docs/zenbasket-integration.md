# ZenBasket ⇄ Personalization — integration guide (contract v1)

Audience: the ZenBasket backend and storefront teams. This is the **personalization-specific** half of the
platform-wide [Extension Platform Contract v1](../../docs/extension-platform-contract-v1.md); read that
first — it defines the generic envelope, the line-extension rules and the webhook semantics that
personalization implements. Anything marked **Confirm** needs a decision from the ZenBasket side.

Base URL: `https://<worker-host>/api/v1` (staging and production hosts differ).

## 1. Lifecycle

```
 shopper (product page)                      ZenBasket                               Worker
 ──────────────────────                      ─────────                               ──────
 <zb-product-customizer> renders ─── GET products/{id}/config ───────────────────▶   published template (if mapped)
 emits zb:event: ready / rendered / gate
 Add to cart ─▶ bridge calls element.prepareForCart()
                 element ── POST uploads (photo, print-ready artwork, previews) ──▶   private storage
                 element ── POST customizations ────────────────────────────────▶   status: saved   → { customizationId }
 bridge puts { personalization / customizationId } on the CART LINE ─▶ cart ─▶ order line
                                              order accepted AND paid
                                              POST /integrations/personalization/events  (signed, contract v1)
                                                                                    ──▶ link to order line, status: ordered
```

A customization is `saved` until ZenBasket confirms the order, then `ordered`. A `saved` customization
nobody orders (and nobody edits) for 30 days becomes `expired` and its files are deleted (§6).

## 2. What ZenBasket must do

1. **Render the element** in the `storefront.product.detail.block` slot, configured by attributes only
   (`product-id`, `variant-id`, `store-id`, `api-base-url`, `instance-id`, `placement`, `hide-save`), and run
   the **bridge** (reference: `integration-demo/extension-bridge.js`). The bridge is generic — it contains no
   personalization knowledge.
2. **Store line extensions on the cart line and copy them to the order line** (contract §6). The bridge
   hands the platform `[{ extensionId: "personalization", key: "customizationId", value: "<uuid>" }]`.
   Requirements the platform must implement:
   - identical product + variant lines must NOT merge when their `customizationId` differs (line identity
     includes the extension entry);
   - quantity/variant edits, saved-for-later and guest→customer cart merges must preserve it;
   - **reorder / add-to-cart-from-order must DROP it** (a customization is ordered once);
   - the platform validates server-side: the extension is installed and enabled for the store and the key is
     one the manifest declares.
3. **Send order events (§4)** once the order is *confirmed*, signed with the store's secret, containing the
   order lines that carry the `personalization` line extensions.
4. Keep `eventId` stable across retries of the same event and re-sign every attempt (fresh timestamp).

### 2.1 What "confirmed" means — **Confirm**

`order.confirmed` is the only event type in v1. It means: *the order has been accepted AND payment is
authorized/captured (or the order is committed under a cash-on-delivery style method) — it will be
fulfilled.* Do **not** send it for a cart, a pending/unpaid order, or merely on order creation: it moves the
customization to `ordered`, which freezes it and exempts it from expiry. Cancellation/refund events are out
of scope for v1.

## 3. Credentials (one-time setup per store)

Each store has its own HMAC secret. Secrets are encrypted at rest (AES-256-GCM, key held only in a Worker
secret) and are **shown once**; the Worker never returns them again, and the Angular admin app has no access
(the endpoints need the explicit `integrations:manage` scope, which an ordinary editor session does not
carry — a wildcard scope does not count).

There is no separate install step on this Worker: a store is registered by its first authenticated request
(creating its credential is enough), and the storefront routes answer for a store only after that. Which
stores get session tokens at all is the platform's decision.

Authenticated like any admin route (`Authorization: Bearer <store session token>`), under
`/plugins/personalization/integration/credentials`:

| Method & path | Body | Result |
|---|---|---|
| `POST /credentials` | `{ "label": "zenbasket prod" }` | `201` `{ id, secret, label, status, createdAt, … }` — **store `secret` now** |
| `GET /credentials` | – | metadata only (`id`, `label`, `status`, `expiresAt`, `lastUsedAt`, …) |
| `POST /credentials/{id}/rotate` | `{ "gracePeriodSeconds": 86400 }` (0–604800; default 86400; `0` revokes the old one immediately) | `201` `{ credential: {…, secret}, previous: {…, expiresAt} }` |
| `DELETE /credentials/{id}` | – | `204` (idempotent) |

**Rotation without downtime:** rotate → deploy the new `secret` → the old secret keeps working until
`previous.expiresAt`. `id` (the key id) changes on rotation; send the `id` that matches the secret you sign with.

## 4. Order events

`POST /api/v1/integrations/personalization/events` — server-to-server only (no browser/CORS).

### 4.1 Request

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-ZB-Key-Id` | the credential `id` (uuid) |
| `X-ZB-Timestamp` | current Unix time in **seconds**. Accepted within ±300 s of the Worker's clock (configurable). |
| `X-ZB-Signature` | `v1=` + lowercase hex of `HMAC-SHA256(secret, "<X-ZB-Timestamp>.<exact request body>")` |

Sign the **exact bytes you send**. The timestamp is part of the signed message, so a captured request cannot
be replayed with a new timestamp. Body limit: 16 KB.

```js
const body = JSON.stringify(event);
const ts = Math.floor(Date.now() / 1000);
const sig = 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
await fetch(url, { method: 'POST', body, headers: {
  'Content-Type': 'application/json', 'X-ZB-Key-Id': keyId, 'X-ZB-Timestamp': String(ts), 'X-ZB-Signature': sig } });
```

### 4.2 Body (the generic contract envelope; unknown fields are rejected with 422)

```json
{
  "contract": 1,
  "eventId": "ord-5521-confirmed-1",
  "type": "order.confirmed",
  "occurredAt": "2026-10-29T07:31:30Z",
  "storeId": "766",
  "order": { "id": "ORD-5521" },
  "lines": [
    { "id": "5521-1", "productId": "42", "variantId": "421", "quantity": 2,
      "extensions": { "customizationId": "687a9554-28d3-4b47-80aa-17d840d47b70" } }
  ]
}
```

| Field | Meaning |
|---|---|
| `contract` | `1` |
| `eventId` | ≤128 chars. Unique per event, **stable across retries**. Durable dedup key (per store). |
| `type` | `"order.confirmed"` (§2.1). |
| `occurredAt` | ISO-8601 with offset: when the order became confirmed. |
| `storeId` | Must equal the store the signing credential belongs to (else 403). |
| `order.id` | ZenBasket order id (stable text, ≤200). |
| `lines[]` | 1–100 lines, **only those carrying this extension's line extensions**. Line ids unique within the event. |
| `lines[].id` | ZenBasket order-line id, stable. **Confirm**: one customization per line; quantity > 1 shares it. |
| `lines[].productId` | The product id the shopper customized — the same id the product page used (**the canonical id is the ZenBasket product id**). |
| `lines[].variantId` | Optional. If sent *and* the customization recorded one, they must match. |
| `lines[].quantity` | Optional, informational. |
| `lines[].extensions.customizationId` | The uuid the bridge put on the cart line. |

### 4.3 What the Worker verifies (never just the payload)

Per **event**: HMAC signature, timestamp window, credential active and not expired (401, all causes alike);
the **store comes from the credential**, `storeId` in the body is only cross-checked (403); the event type is
supported (422).
Per **line** (independently of every other line in the event): the customization is looked up **within that
store**; `productId` (and `variantId`) match what was recorded when the shopper saved; the customization is
`saved` and not `expired`; the customization is not already linked elsewhere and the order line does not already
carry another customization.

### 4.4 Response

`200` whenever the event itself is valid and authenticated, **even if some lines are rejected**:

```json
{ "contract": 1, "eventId": "ord-5521-confirmed-1", "duplicate": false,
  "results": [ { "lineId": "5521-1", "status": "applied", "customizationId": "687a9554-…" } ],
  "requestId": "…" }
```

`status` per line: `applied` (linked now), `duplicate` (this customization was already linked to this exact
order line), `rejected` (+ `reason`). `rejected` is **permanent** — do not retry it; surface it to the
merchant. A rejected line never undoes or blocks the other lines. `duplicate: true` on the envelope means the
**whole event** was already processed: `results` are the *stored* outcome of the first delivery.

| `reason` | Meaning |
|---|---|
| `customization_not_found` | No such customization in this store |
| `missing_customization_id` / `invalid_customization_id` | The line has no (valid) `customizationId` |
| `product_mismatch` / `variant_mismatch` | Does not match what the shopper customized |
| `customization_already_ordered` | Already linked to a *different* order/line |
| `order_line_already_linked` | That line already carries a *different* customization |
| `customization_expired` | Expired before it was ordered; its data/files are gone — alert the merchant |
| `customization_not_orderable` | Changed state while being ordered |

Envelope-level errors (the standard error envelope `{ error: { code, message, requestId, details } }`):

| Status | `code` / `details.reason` | Retry? |
|---|---|---|
| 400 | `bad_request` (not JSON) | no — fix |
| 401 | `unauthorized`, `invalid_timestamp` (bad/missing signature or headers, clock outside window, revoked/expired/unknown key) | after fixing |
| 403 | `forbidden` (`storeId` ≠ credential's store) | no |
| 409 | `conflict` / `event_id_reused` (same `eventId`, different payload) | no — fix the producer |
| 413 | `payload_too_large` | no |
| 422 | `validation_failed`, `unsupported_event_type` | no — fix |
| 429 | `rate_limited` (`Retry-After`) | yes, after the delay |
| 5xx / 503 | `internal_error`, `integrations_not_configured` | yes, with backoff, **same `eventId`**, fresh signature |

The whole event is one database transaction, so a 5xx leaves nothing behind and the same `eventId` can be
retried. To correct a `rejected` line after fixing its cause, send a **new `eventId`** (the rejected outcome of the
old one is stored).

## 5. Shopper API (used by the storefront element — the host does not call it)

Public, no merchant token. Every route needs `?storeId=<store key>`; CORS is answered from the store's own
allowed origins (set under `PUT /plugins/personalization/settings/storefront`), and **writes from a browser
Origin that is not allowed are refused (403)**. All responses are `Cache-Control: no-store`.
Base: `/api/v1/storefront/personalization`.

| Call | Auth | Purpose |
|---|---|---|
| `GET /products/{productId}/config?storeId=…[&variantId=…&collectionIds=a,b]` | – | The published config for the product (`configId`, `version`, `config`) or `{personalizable:false}`. |
| `POST /uploads?storeId=…&kind=upload\|artwork\|preview[&filename=…]` (raw PNG/JPEG/WebP body) | – | Store a private image. `upload` = the shopper's photo, `artwork` = the print-ready file of a printable area, `preview` = a composite. → `{ assetId, kind, contentType, sizeBytes, width, height, uploadToken, uploadTokenExpiresAt }` |
| `POST /customizations?storeId=…` | – | Save. Body: `{ productId, variantId?, collectionIds?, configId, configVersion, data, assets:[{assetId, uploadToken}] }` → `201 { customizationId, status:"saved", accessToken, accessTokenExpiresAt, expiresAt }` |
| `GET /customizations/{id}?storeId=…` | `Bearer accessToken` | Read back. 410 once expired. |
| `PUT /customizations/{id}?storeId=…` | `Bearer accessToken` | Replace `data` and the asset list; refreshes the 30-day window. 409 `customization_not_editable` once ordered. |
| `GET /customizations/{id}/assets/{assetId}?storeId=…` | `Bearer accessToken` | The private file (`Cache-Control: private, no-store`). |

Rules worth knowing:
- **The id alone never authorizes anything.** The `accessToken` (HMAC-signed, scoped to one customization and
  store, 7-day default lifetime) is required to read or change it. The element keeps it in memory and does
  **not** hand it to the host: only `customizationId` goes onto the cart line.
- The config is **resolved from the mapping** for `productId`; `configId`/`configVersion` are what the element
  rendered. A changed mapping → `409 config_changed`; an unknown version → `422`. The version is **pinned**, so
  republishing never alters existing customizations.
- `data` carries the shopper's values plus a `files` map saying which stored file is which (photos, per-area
  print-ready artwork, previews), so the merchant can fulfil the order from the merchant API.
- One save = N uploads + 1 create. The default write limit is 30 requests/minute per store+IP
  (`STOREFRONT_WRITE_RATE_LIMIT`); a design with many printable areas and mockups can need ~10 requests.

## 6. Expiry & cleanup

A scheduled job (cron, hourly) runs the following; each run is recorded in `personalization.cleanup_runs`.

| What | When | Result |
|---|---|---|
| `saved` customization, no order link | inactive for **30 days** (`CUSTOMIZATION_RETENTION_DAYS`; every successful `PUT` resets it) | `expired`: data cleared, files *released* |
| Upload never attached to a customization | **24 h** (`UNATTACHED_UPLOAD_TTL_HOURS`) | *released* |
| Released file | after a **24 h grace period** (`ASSET_DELETE_GRACE_HOURS`), and only if its customization is not ordered / order-linked | object deleted from storage (failures retry with backoff) |
| Expired (empty) customization row | **30 days** after expiry (`EXPIRED_TOMBSTONE_DAYS`), once no files remain | row deleted |

**`ordered` customizations and their files are never touched by this job.** Their retention is a business
decision that is **not yet defined — Confirm** — and nothing deletes them until one is implemented. An event
for an *expired* customization gets `rejected` / `customization_expired`; ZenBasket should alert the merchant.

Because customizations pin a published config version, a configuration with customizations **cannot be
deleted** (409 `config_has_customizations`) — archive it instead.

## 7. Merchant read API (authenticated, store-scoped)

`GET /plugins/personalization/customizations[?status=saved|ordered|expired&orderId=…&productId=…&limit=…&cursor=…]`
(keyset pagination, `meta.page.nextCursor`), `GET …/customizations/{id}` (includes `data`, `assets`, `order`),
`GET …/customizations/{id}/assets/{assetId}/content` (private file stream).

## 8. Configuration

| Name | Kind | Default | Purpose |
|---|---|---|---|
| `INTEGRATION_ENCRYPTION_KEY` | **secret** | – | 32 bytes, base64. Encrypts integration secrets at rest. Required for credentials + events (503 otherwise). |
| `CUSTOMIZATION_TOKEN_SECRET` | **secret** | – | Signs shopper access/upload tokens. Required for uploads + customizations (503 otherwise). |
| `ORDER_CALLBACK_TOLERANCE_SECONDS` | var | 300 | Timestamp window. |
| `ORDER_CALLBACK_RATE_LIMIT` | var | 600 | Event requests per client IP per window. |
| `STOREFRONT_WRITE_RATE_LIMIT` | var | 30 | Shopper writes (uploads, saves) per store+IP per window. |
| `CUSTOMIZATION_RETENTION_DAYS` | var | 30 | Inactivity expiry. |
| `CUSTOMIZATION_TOKEN_TTL_SECONDS` | var | 604800 | Shopper token lifetime. |
| `UNATTACHED_UPLOAD_TTL_HOURS` / `ASSET_DELETE_GRACE_HOURS` / `EXPIRED_TOMBSTONE_DAYS` | var | 24 / 24 / 30 | Cleanup timings. |

Set the secrets with `wrangler secret put INTEGRATION_ENCRYPTION_KEY --env <env>` (generate with
`openssl rand -base64 32`) and `wrangler secret put CUSTOMIZATION_TOKEN_SECRET --env <env>`.
**Losing or changing `INTEGRATION_ENCRYPTION_KEY` makes every stored integration secret undecryptable** —
back it up in your secret manager; recovery is to issue new credentials.

## 9. Error envelope

`{ "error": { "code": "…", "message": "…", "requestId": "…", "details": { "reason": "…" } } }`.
Quote `requestId` (also the `X-Request-Id` response header) when reporting a problem.
