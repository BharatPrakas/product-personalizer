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
 <zb-product-customizer> mounts ─── GET products/{id}/config ───────────────────▶   published template (if mapped)
 emits zb:event: ready / rendered / gate        no template → no button (the bridge collapses the slot)
 shopper clicks the element's trigger button ─▶ editor opens in a modal (lazy chunk, no second request)
 Save customization ─▶ element ── POST uploads / POST customizations ──────────▶   status: saved   → { customizationId }
                       emits zb:event personalization.saved, closes the modal, gate opens
 Add to cart ─▶ bridge calls element.prepareForCart()   (reuses the saved design: no second customization)
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
   - **The element owns the button.** Do not render a personalization button of your own: mount the element
     whenever the plugin is installed and its placement is enabled. It asks the Worker whether *this* product has a
     published template and shows its trigger button only if it does (otherwise it reports `ready { available: false }`
     and the bridge collapses the slot). Keep `hide-save`, so the element saves to the Worker itself.
   - **Builder button style.** Assign the Builder's button object to the `triggerStyle` property (or JSON in the
     `trigger-style` attribute): `buttonText`, `buttonColor`, `buttonTextColor`, `buttonFont`, `buttonTextSize`,
     `buttonTextFontStyle`, `buttonRadius`, `buttonPadding`, `width`, `buttonAlignment`, `buttonBorder*`, `buttonHover*`
     (the names of the Builder's `ButtonPropertiesModel`; see the root README, "Trigger button style"). Re-assign it when
     the merchant changes the style; the button restyles in place, with no request. The element validates every value;
     the modal keeps the personalizer's own design and is not styled by it.
   - **Re-assign `variant-id` / `collection-ids`** when the shopper changes variant: the element re-asks the Worker and
     hides its button until it knows the answer.
   - **Add to cart is gated until the shopper has saved a design** (`gate { allowed: false, reason }`; show the reason).
     `prepareForCart()` then reuses the saved customization, and rejects with a shopper-safe message if nothing was saved.
   - Serve every file of `dist/product-personalization/` next to `storefront.js`: the editor is a lazy chunk
     (`chunk-*.js`) fetched on the first click from the same base URL, so the page's CSP `script-src` must allow it too.
2. **Store line extensions on the cart line and copy them to the order line** (contract §6). The bridge
   hands the platform `[{ extensionId: "personalization", key: "customizationId", value: "<uuid>" }]`.
   Requirements the platform must implement:
   - identical product + variant lines must NOT merge when their `customizationId` differs (line identity
     includes the extension entry);
   - quantity/variant edits, saved-for-later and guest→customer cart merges must preserve it;
   - **reorder / add-to-cart-from-order must DROP it** (a customization is ordered once);
   - the platform validates server-side: the extension is installed and enabled for the store and the key is
     one the manifest declares.
3. **Send order events (§4)** once the order is *confirmed*, signed with the key derived from the plugin-level
   secret (§3), containing the order lines that carry the `personalization` line extensions.
4. Keep `eventId` stable across retries of the same event and re-sign every attempt (fresh timestamp).

### 2.1 What "confirmed" means — **Confirm**

`order.confirmed` is the only event type in v1. It means: *the order has been accepted AND payment is
authorized/captured (or the order is committed under a cash-on-delivery style method) — it will be
fulfilled.* Do **not** send it for a cart, a pending/unpaid order, or merely on order creation: it moves the
customization to `ordered`, which freezes it and exempts it from expiry. Cancellation/refund events are out
of scope for v1.

## 3. Authentication: one plugin-level secret

ZenBasket and this Worker share **one secret for the whole plugin** — not one per store, not one per order. It
authenticates both directions: the merchant session token ZenBasket issues, and the order callbacks ZenBasket
sends. The two are separate verification flows with separate rules (§3.2, §3.3). There is **no credential API**
on the Worker, **no development token or bypass**, and **no fallback secret**: with the secret missing, nothing is
accepted.

### 3.1 The secret and the plugin id

| | |
|---|---|
| Generated by | **ZenBasket**, when this plugin is registered with the Plugin Platform: random, at least 32 characters. The Worker never generates, stores (D1), logs or returns it. |
| Held in | ZenBasket's credential store **and** the Worker's Cloudflare secret `ZB_PLUGIN_SECRET`. Nowhere else: not `wrangler.jsonc`, not git, not browser code, not an API response. |
| Registration also yields | ZenBasket's **plugin id** → the Worker var `ZB_PLUGIN_ID` (not a secret; merchant tokens must carry it). |
| One per environment | development, staging and production each have their own secret and plugin registration. Never reuse one across environments. |

```bash
# Prompts for the value (or reads it from stdin); it never appears on the command line.
npx wrangler secret put ZB_PLUGIN_SECRET --env dev        # likewise --env staging / --env production
# ZB_PLUGIN_ID is a plain var: set it per environment under `vars` in wrangler.jsonc.
```

The Worker **fails closed**: with the secret missing, blank or shorter than 32 characters, every merchant route
answers `401` and the callback endpoint answers `503 integrations_not_configured`. With `ZB_PLUGIN_ID` unset every
merchant route answers `401`.

### 3.2 Merchant token (storeadmin → Worker)

`Authorization: Bearer <jwt>` on every merchant route. HS256, signed by ZenBasket with the plugin secret itself;
`alg` must be exactly `HS256`.

| Claim | Rule |
|---|---|
| `storeId` | **Required.** A positive integer, or a non-empty string. The store is taken **only** from here — never from a header, query string or body. A token for store A cannot read or write store B. |
| `pluginId` | **Required.** Must equal the Worker's `ZB_PLUGIN_ID` (a number, or the same id as a string). A token issued for another plugin is refused. |
| `iat` | **Required** (a number). |
| `exp` | **Required**, and not in the past (30 s leeway). A token with no expiry is refused. |
| `nbf` | Honoured when present. |
| `sub` | Optional; recorded as the audit actor. |

Not checked: `iss` and `aud`. ZenBasket does not issue them (the draft contract §8.2 proposes them); the plugin
binding is `pluginId` plus a secret only this plugin holds. Other claims are ignored.

```js
// Node.js, what the ZenBasket token issuer does:
const iat = Math.floor(Date.now() / 1000);
const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const body = Buffer.from(JSON.stringify({ storeId: 766, pluginId: 160, iat, exp: iat + 600 })).toString('base64url');
const jwt = `${head}.${body}.${createHmac('sha256', pluginSecret).update(`${head}.${body}`).digest('base64url')}`;
```

### 3.3 Order callbacks (ZenBasket → Worker)

Authenticated by an HMAC over the exact request body (§4), keyed not by the secret itself but by a key **derived**
from it, so a callback signature can never be replayed as a merchant token or the other way round:

```
webhookKey = HKDF-SHA256( ikm = UTF-8 bytes of the plugin secret, salt = empty,
                          info = UTF-8 "zb-plugin:v1:order-webhook", length = 32 bytes )
```

The `info` string is fixed and versioned — part of this contract. Node.js:
`hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'zb-plugin:v1:order-webhook', 32)`. Known answer
to check an implementation against (a **fake** fixture secret, never a real one): for
`test-plugin-secret-0123456789abcdef0123456789` the key is
`67bf6aafeb509fdb25be8538101e719bead8c81927071a53635edde67dacbec9` (hex).

A merchant token is **not** authorization to post callbacks, and a callback signature is **not** accepted on
merchant routes.

### 3.4 Store identity and authorization

One shared secret proves **"ZenBasket sent this"** — it says nothing about *which store*. So:

1. The `storeId` in the callback body is **untrusted until the signature has verified**.
2. After that it must be a store this Worker knows (it has a `store_settings` row, created the first time that
   store's merchant authenticates — which every personalization flow needs before a shopper can even save a design).
   An unknown store gets `403 store_not_authorized` and nothing is written.
3. Every customization an event references is looked up **inside that store**. Naming another store's customization
   is a per-line `customization_not_found`.

**Installation state is not modelled here.** Whether the plugin is installed, enabled, disabled or uninstalled for a
store belongs to the Plugin Manager. The lifecycle events that would tell this Worker (contract §10:
`app.installed` / `app.uninstalled`) are **not implemented**, so a store that was known and later uninstalled still
passes check 2. When lifecycle events exist, a status column on `store_settings` is where they land and the single
check in `integration-controller.ts` is where it is consulted. Do not rely on the Worker to enforce uninstall today.

### 3.5 One secret, one blast radius

A per-store secret would only tell the Worker *which store signed*, which the signed payload plus the Worker's own
records already establish (§3.4) — at the price of a credential to create, encrypt, rotate and back up. The trade-off
is that whoever holds the plugin secret can sign an event for *any* store. What a forged event can still do is
bounded: it can only link an existing, `saved` customization (an unguessable UUID) to an order line, once, in a store
the Worker knows. Keep the secret only in ZenBasket's credential store and the Worker's Cloudflare secret.

### 3.6 Rotating the plugin secret

There is one secret and no overlap period, so rotation is a **coordinated cut-over**:

1. ZenBasket generates the new secret.
2. Pause the order-webhook dispatcher (or queue deliveries) and stop issuing merchant tokens.
3. `npx wrangler secret put ZB_PLUGIN_SECRET --env <env>` ← the new secret; ZenBasket switches its issuer and signer to it.
4. Resume. Merchants re-fetch a token (the host does this on `auth.expired`); queued callbacks are signed afresh.

Anything signed with the old secret after step 3 is refused — a callback gets `401`, which ZenBasket does **not**
retry (§4.4), so its customization would stay `saved`. Do not rotate without pausing delivery. Rotating does **not**
affect signed asset URLs (§3.7).

### 3.7 Other secrets

| Secret | Purpose |
|---|---|
| `ASSET_SIGNING_SECRET` | Signs the asset URLs stored in configurations. **Independent of the plugin secret on purpose**: rotating the plugin secret must not invalidate them; rotating *this* one does. There is no fallback to any other secret, so set it wherever configurations are edited. |
| storage keys | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (R2 direct uploads) or `AWS_*` (S3), for presigned URLs only. |

The shopper-facing API is anonymous (public, rate-limited, store-scoped; ids are unguessable UUIDs) and has no token
or secret of its own. Customers' files are private and are read only through authenticated merchant routes.

## 4. Order events

`POST /api/v1/integrations/personalization/events` — server-to-server only (no browser/CORS).

### 4.1 Request

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-ZB-Timestamp` | current Unix time in **seconds**. Accepted within ±300 s of the Worker's clock (configurable). |
| `X-ZB-Signature` | `v1=` + lowercase hex of `HMAC-SHA256(webhookKey, "<X-ZB-Timestamp>.<exact request body>")`, where `webhookKey` is the **order-webhook key derived from the plugin secret** (§3.3) — not the secret itself. |

No other header is read: there is no key id, because there is no key to look up.

Sign the **exact bytes you send**. The timestamp is part of the signed message, so a captured request cannot
be replayed with a new timestamp. Body limit: 64 KiB. Re-sign every delivery attempt with a fresh timestamp.

Minimal Node.js signer (nothing but `node:crypto` and `fetch`):

```js
import { createHmac, hkdfSync } from 'node:crypto';

// Once, at startup. `pluginSecret` is the value ZenBasket generated when the plugin was registered.
const webhookKey = Buffer.from(
  hkdfSync('sha256', Buffer.from(pluginSecret, 'utf8'), Buffer.alloc(0), 'zb-plugin:v1:order-webhook', 32),
);

// For every delivery attempt:
const body = JSON.stringify(event);                // the exact bytes you will send
const timestamp = Math.floor(Date.now() / 1000);   // seconds
const signature = 'v1=' + createHmac('sha256', webhookKey).update(`${timestamp}.${body}`).digest('hex');

await fetch(`${workerBaseUrl}/api/v1/integrations/personalization/events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-ZB-Timestamp': String(timestamp), 'X-ZB-Signature': signature },
  body,
});
```

The Worker's own tests run exactly this snippet against the Worker, and `npm run dev:event` (in `worker-api/`)
does the same from the command line for local development.

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
| `storeId` | The store the order belongs to. Untrusted until the signature verifies; then it must be a store the Worker knows (else `403 store_not_authorized`, §3.4). |
| `order.id` | ZenBasket order id (stable text, ≤200). |
| `lines[]` | 1–100 lines, **only those carrying this extension's line extensions**. Line ids unique within the event. |
| `lines[].id` | ZenBasket order-line id, stable. **Confirm**: one customization per line; quantity > 1 shares it. |
| `lines[].productId` | The product id the shopper customized — the same id the product page used (**the canonical id is the ZenBasket product id**). |
| `lines[].variantId` | Optional. If sent *and* the customization recorded one, they must match. |
| `lines[].quantity` | Optional, informational. |
| `lines[].extensions.customizationId` | The uuid the bridge put on the cart line. |

### 4.2.1 Optional order and customer details — **[proposed – optional]**, **Confirm**

So the merchant can fulfil an order from the plugin's Orders page, the event MAY also carry the order's
display details. **Every field is optional**; an event without any of them (the shape above) keeps
working unchanged, and the Worker never fetches what is missing — the Orders page shows "Not provided by
the store". The ZenBasket dispatcher does **not** send these yet: populating them is a platform-team
task (contract §7 open items). Send only what fulfilment needs.

```json
{
  "contract": 1,
  "eventId": "ord-5521-confirmed-1",
  "type": "order.confirmed",
  "occurredAt": "2026-10-29T07:31:30Z",
  "storeId": "766",
  "order": {
    "id": "ORD-5521",
    "number": "#5521",
    "placedAt": "2026-10-29T07:30:02Z",
    "currency": "EUR",
    "totals": { "subtotal": "40.00", "shipping": "4.95", "tax": "8.00", "discount": "2.00", "total": "50.95" },
    "customer": { "id": "c-981", "name": "Ana Example", "email": "ana@example.com", "phone": "+33 6 00 00 00 00" },
    "shippingAddress": { "name": "Ana Example", "line1": "12 Rue Exemple", "line2": "Apt 4", "city": "Lyon",
                         "region": "ARA", "postalCode": "69001", "country": "FR", "phone": "+33 6 00 00 00 00" },
    "billingAddress": { "name": "Ana Example", "line1": "12 Rue Exemple", "city": "Lyon", "postalCode": "69001", "country": "FR" }
  },
  "lines": [
    { "id": "5521-1", "productId": "42", "variantId": "421", "quantity": 2,
      "title": "Photo mug — white", "sku": "MUG-W-11", "unitPrice": "20.00",
      "extensions": { "customizationId": "687a9554-28d3-4b47-80aa-17d840d47b70" } }
  ]
}
```

| Field | Rule |
|---|---|
| `order.number` | Display order number, 1–100 chars. |
| `order.placedAt` | ISO-8601 with offset. |
| `order.currency` | ISO 4217, three letters. |
| `order.totals.*`, `lines[].unitPrice` | **Decimal strings in the currency's major unit** — `"12.50"`, never `12.5` and never minor units. Non-negative, ≤ 12 integer and ≤ 4 fraction digits. `discount` is the positive amount taken off. |
| `order.customer` | `id` ≤200, `name` ≤200, `email` ≤254 (loose `x@y` check), `phone` ≤40 (digits and `+ ( ) . / - # * x`, at least one digit). |
| `order.shippingAddress`, `order.billingAddress` | `name`, `line1`, `line2` ≤200; `city`, `region` ≤100; `postalCode` ≤20; `country` ISO 3166-1 alpha-2; `phone` as above. |
| `lines[].title`, `lines[].sku` | ≤200 and ≤100 chars. |

Strings are trimmed and `""` counts as absent; unknown keys inside these objects are rejected (422, naming
the field) like everywhere else in the envelope. The body limit is **64 KiB**. These fields are covered by
the same HMAC over the exact body — changing any of them after signing fails with 401 — and are part of
the event's identity: resending the same `eventId` with different details is `409 event_id_reused`.

When several events or lines concern one order, the Worker keeps the **first** value of each field and
only fills fields that are still empty (an address only as a whole); a later different value is ignored
and logged by field name. To correct a stored value, a future `order.updated` event would be needed —
not part of v1.

**Personal data:** the Worker stores these in its own D1 database (plain text at rest; no field-level
encryption), never logs them, never puts them in audit records or the replay record, and returns them
only through the authenticated, store-scoped merchant API (§7) — never through storefront or shopper
routes. There is **no retention/purge yet**: it is the same open decision as ordered customizations
(**Confirm**, §6).

### 4.3 What the Worker verifies (never just the payload)

Per **event**, in this order — the first failure ends the request and nothing is written:
1. the plugin secret is configured (else `503`); the body is within the size limit (`413`);
2. `X-ZB-Timestamp` and `X-ZB-Signature` are present and the timestamp is a plain integer within the window (`401`);
3. the HMAC over the exact raw body verifies against the derived key, compared in constant time (`401`; every
   cause looks alike);
4. only now is the body parsed: valid JSON (`400`), a valid contract-v1 envelope (`422`), a supported event type (`422`);
5. the `storeId` is a store this Worker knows (`403 store_not_authorized`, §3.4).

Per **line** (independently of every other line in the event): the customization is looked up **within that
store**; `productId` (and `variantId`) match what was recorded when the shopper saved; the customization is
`saved` and not `expired`; the customization is not already linked elsewhere and the order line does not already
carry another customization.

**Replay protection:** the timestamp window bounds how long a captured request is usable, and `eventId` makes any
repeat within it idempotent (the stored outcome is returned; no second link). Same `eventId` with a different payload
is `409`.

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
| 401 | `unauthorized`, `invalid_timestamp` (bad/missing signature or headers, clock outside window, signed with the wrong secret or key) | after fixing |
| 403 | `store_not_authorized` (the `storeId` is not a store this Worker knows) | no |
| 409 | `conflict` / `event_id_reused` (same `eventId`, different payload) | no — fix the producer |
| 413 | `payload_too_large` | no |
| 422 | `validation_failed`, `unsupported_event_type` | no — fix |
| 429 | `rate_limited` (`Retry-After`) | yes, after the delay |
| 5xx / 503 | `internal_error`, `integrations_not_configured` (plugin secret not set on this environment) | yes, with backoff, **same `eventId`**, fresh signature |

Each line is applied as its own atomic write and the event stays `processing` until every line has been tried,
so after a 5xx the same `eventId` can be retried safely: lines already applied answer `duplicate`, the rest are
applied. To correct a `rejected` line after fixing its cause, send a **new `eventId`** (the rejected outcome of the
old one is stored).

## 5. Shopper API (used by the storefront element — the host does not call it)

Public and anonymous: no merchant token, no key, secret or shopper token of any kind. Every route needs
`?storeId=<store key>` (a routing label, not a credential; an unknown store is `404`). CORS is
`Access-Control-Allow-Origin: *` without credentials on every response. All responses are `Cache-Control: no-store`
except the customized image.
Base: `/api/v1/storefront/personalization`.

| Call | Auth | Purpose |
|---|---|---|
| `GET /products/{productId}/config?storeId=…[&variantId=…&collectionIds=a,b]` | – | The published config for the product (`configId`, `version`, `config`) or `{personalizable:false}`. |
| `POST /uploads?storeId=…&kind=upload\|artwork\|preview[&filename=…]` (raw PNG/JPEG/WebP body) | – | Store a private image through the Worker (legacy; disabled when `LEGACY_PROXY_UPLOADS=false`). `upload` = the shopper's photo, `artwork` = the print-ready file of a printable area, `preview` = a composite. → `{ assetId, kind, contentType, sizeBytes, width, height }` |
| `POST /uploads/url?storeId=…` `{ kind, contentType, size, filename? }` | – | **Preferred.** Start a direct upload: → `201 { uploadId, assetId, uploadUrl, method:"PUT", headers, expiresIn }`. `PUT` the file to `uploadUrl` with exactly `headers` (straight to object storage — no `Authorization`), then confirm. |
| `POST /uploads/complete?storeId=…` `{ uploadId }` | – | Verify the stored file. → the same body as `POST /uploads` (`{ assetId, kind, contentType, sizeBytes, width, height }`). Idempotent. See `docs/direct-uploads.md`. |
| `POST /customizations?storeId=…` | – | Save. Body: `{ productId, variantId?, collectionIds?, configId, configVersion, data, assets:[{assetId}] }` → `201 { customizationId, status:"saved", customizedImageUrl, expiresAt }` |
| `PUT /customizations/{id}?storeId=…` | – | Replace `data` and the asset list; refreshes the 30-day window; returns the same body as `POST` (a new preview gives a new `customizedImageUrl`). 409 `customization_not_editable` once ordered. |
| `GET /customization-images/{assetId}?storeId=…` | – | The customized image, a plain `<img src>` target: only an attached `preview` of that store, sniffed content type, `Cache-Control: public, max-age=86400, immutable`, `ETag`, `nosniff`, CORP `cross-origin`, CORS `*`. Anything else is `404`. |

Rules worth knowing:
- **There are no shopper tokens.** Ids are unguessable UUIDs and the API never reads a customization or a
  customer's original file back to a shopper: the only public read is the customized image. `PUT` is authorized
  by the customization id alone, so the id is a capability (it is returned to the element and carried on the
  cart line; it is not part of any public URL — `customizedImageUrl` carries the preview's asset id).
- **`customizedImageUrl`** (also on the element's `prepareForCart()` result and `personalization.saved` event) is the
  absolute URL of the FIRST `preview` asset of the save, `null` when the save has none. ZenBasket stores it as an
  opaque string (≤ 2048 characters, https; the element drops anything else) and renders it with a plain `<img>`.
  It changes whenever the saved preview changes, so a cart line never shows a stale image.
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

`GET /plugins/personalization/orders[?q=…&productId=…&from=…&to=…&limit=…&cursor=…]` lists orders with
personalized lines (newest first, keyset `meta.pagination.nextCursor`; only the customer's name), and
`GET …/orders/{orderId}` returns one order with its optional details (§4.2.1, `null` when not sent) and its
lines, each with its customization summary and file list. Files and full design data come from the
customization routes above.

## 8. Configuration

| Name | Kind | Default | Purpose |
|---|---|---|---|
| `ZB_PLUGIN_SECRET` | **secret** | – | The plugin-level secret ZenBasket generated (≥ 32 chars). Verifies merchant tokens and, through the derived key, order callbacks. Missing/short = fail closed (§3.1). |
| `ZB_PLUGIN_ID` | var | – | ZenBasket's id for this plugin; a merchant token's `pluginId` must equal it. Unset = merchant auth fails closed. |
| `ASSET_SIGNING_SECRET` | **secret** | – | Signs asset URLs; independent of the plugin secret, no fallback (§3.7). |
| `ORDER_CALLBACK_TOLERANCE_SECONDS` | var | 300 | Timestamp window. |
| `ORDER_CALLBACK_RATE_LIMIT` | var | 600 | Event requests per client IP per window. |
| `STOREFRONT_WRITE_RATE_LIMIT` | var | 30 | Shopper writes (uploads, saves) per store+IP per window. |
| `CUSTOMIZATION_RETENTION_DAYS` | var | 30 | Inactivity expiry. |
| `UNATTACHED_UPLOAD_TTL_HOURS` / `ASSET_DELETE_GRACE_HOURS` / `EXPIRED_TOMBSTONE_DAYS` | var | 24 / 24 / 30 | Cleanup timings. |

Set the secrets with `wrangler secret put ZB_PLUGIN_SECRET --env <env>` — the value is the one **ZenBasket generated
at plugin registration** (for local development, any 32+ character value you also use with `npm run dev:token` /
`npm run dev:event`); the Worker does not generate it. Keep it in ZenBasket's credential store (the source of
truth); the Worker's copy can always be re-put from there. Secrets are per environment and never appear in
`wrangler.jsonc`, git, logs or API responses.

## 9. Error envelope

`{ "error": { "code": "…", "message": "…", "requestId": "…", "details": { "reason": "…" } } }`.
Quote `requestId` (also the `X-Request-Id` response header) when reporting a problem.
