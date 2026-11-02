# ZenBasket Extension Platform — Contract v1 (DRAFT)

**Status:** draft for review by the ZenBasket platform, storeadmin and storefront teams. Nothing here is
final until those teams agree to it.
**Purpose:** one generic way for 100+ independent extensions to render in storeadmin and the storefront,
attach data to cart and order lines, and hear about orders — without core code that knows any specific
extension.
**First implementer:** Product Personalization (section 13 is the worked example). It is the *reference
implementation* of this contract, not its source: nothing in sections 1–12 mentions it.

Words in capitals (MUST, SHOULD, MAY) have their usual specification meaning.
Each contract is marked **[implemented]** (exists today in the personalization code), **[partial]**, or
**[proposed]** (needs to be built).

---

## 1. Goals and non-goals

**Goals**
1. Core never imports, names or special-cases an extension. Adding extension #101 changes data, not code.
2. A broken, slow or hostile extension cannot break a page, an order or another extension.
3. Extensions never call core cart or order APIs. They declare what they need; the platform acts.
4. Every cross-boundary payload is versioned and validated on the receiving side.

**Non-goals (v1):** billing, marketplace review, theme editing, extension-to-extension messaging,
checkout-page slots.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Extension** | An installable unit with a manifest, optional UI bundles and an optional backend. |
| **Surface** | Where UI runs: `storeadmin` or `storefront`. |
| **Slot** | A named place in a surface where the platform renders an extension element. |
| **Instance** | One rendered element in one slot on one page. Has an `instanceId`. |
| **Store key** | The public identifier of a store (one value, defined by the platform — see Open decision 1). |
| **Line extension** | Namespaced data attached to a cart or order line. |

## 3. Manifest **[proposed]**

One JSON document per extension version, stored by the platform (extend the existing plugin catalog; do
not hard-code extensions in client code). The side navigation, the loader and the webhook dispatcher all read it.

```json
{
  "contract": 1,
  "id": "personalization",
  "name": "Product Personalization",
  "version": "1.4.0",
  "publisher": "Centizen",
  "surfaces": {
    "storeadmin": {
      "slot": "storeadmin.app",
      "tag": "zb-personalization-admin",
      "entry": "https://cdn.example.com/personalization/1.4.0/store-admin.js",
      "integrity": "sha384-…",
      "nav": { "group": "installed-apps", "title": "Product Personalization", "icon": "brush" }
    },
    "storefront": [
      {
        "slot": "storefront.product.detail.block",
        "tag": "zb-product-customizer",
        "entry": "https://cdn.example.com/personalization/1.4.0/storefront.js",
        "integrity": "sha384-…",
        "requires": ["product.id"]
      }
    ]
  },
  "backend": { "baseUrl": "https://api.example.com" },
  "permissions": ["cart.line-extensions:write", "order.events:receive"],
  "lineExtensions": {
    "keys": { "customizationId": { "maxLength": 64 } },
    "affectsLineIdentity": ["customizationId"],
    "onReorder": "drop"
  },
  "events": {
    "receive": ["order.confirmed"],
    "endpoint": "https://api.example.com/api/v1/integrations/personalization/events"
  },
  "auth": { "audience": "personalization" },
  "lifecycle": { "endpoint": "https://api.example.com/api/v1/integrations/personalization/lifecycle" }
}
```

Rules:
- `entry` MUST be an immutable, versioned URL to an ES module, with an `integrity` hash. The platform
  loads exactly that file; a changed file under the same URL is rejected.
- `id` is lowercase `[a-z][a-z0-9-]{1,62}` and unique platform-wide. It is the **namespace** for
  everything the extension owns (line extension keys, custom event types, tokens' `aud`).
- The platform MUST ignore manifest fields it does not know (forward compatibility).
- `backend.baseUrl` is the extension's API. The platform passes it to the element as the `api-base-url`
  attribute, so the element never hard-codes where its backend lives.
- Permissions are least-privilege and checked server-side, not only in the client (section 6).

## 4. Slots and context **[partial]** — attributes implemented; the `context` object is proposed

v1 defines two slots. New slots are additive.

| Slot | Surface | Rendered by | Context |
|---|---|---|---|
| `storeadmin.app` | storeadmin | a route `/app/apps/:extensionId`, listed in the "Installed apps" nav group | `store`, `locale`, `session` |
| `storefront.product.detail.block` | storefront | the product details page, once per extension that declares the slot and is installed and enabled for the store | `store`, `locale`, `currency`, `product` |

The platform gives every instance the same **context**, as properties (and, for simple values, matching
attributes), and re-assigns them when they change (for example a variant selection):

```ts
interface ZbContext {
  contract: 1;
  extensionId: string;
  instanceId: string;           // unique per rendered instance; stable until it is removed
  slot: string;
  placement?: string;           // host-defined label, e.g. "product-detail"
  store: { key: string };       // the Store key
  locale: string;               // BCP 47
  currency?: string;            // ISO 4217
  product?: { id: string; variantId?: string; collectionIds?: string[] };
}
```

- Attributes (kebab-case): `instance-id`, `store-id`, `api-base-url`, `locale`, `product-id`, `variant-id`, plus
  the host-defined `placement` and, for extensions with their own primary button, `hide-save` (the host's
  Add to cart is then the primary action).
  Implemented by the personalization element today: `instance-id`, `store-id`, `api-base-url`, `product-id`,
  `variant-id`, `collection-ids`, `placement`, `hide-save`. `locale` and the single `context` object are not yet.
- An element MUST work when only attributes are set and MUST react to later changes.
- Identifiers are strings, exactly as the platform knows them (for products: the product id).
- The platform renders a storefront slot only when the extension is installed and enabled for the store.
  Whether the extension has anything to show for *this* product is the extension's decision; it reports it
  with the `ready` event (`personalizable`) and the host collapses the slot when it is `false`.

## 5. Event envelope **[implemented]** (element side and reference bridge)

### 5.1 Extension → host

All events use ONE DOM event name, `zb:event`, dispatched on the element with `bubbles: true,
composed: true`, so the platform bridge needs a single listener on `document` and no reference to any element.

```ts
interface ZbEvent<T = unknown> {
  contract: 1;
  extensionId: string;   // MUST equal the manifest id; the bridge drops events whose id does not match the element's slot
  instanceId: string;
  slot: string;
  type: string;          // standard type, or "<extensionId>.<name>"
  data: T;
  ts: number;            // epoch ms
}
```

**Standard types** (the platform understands and may act on these):

| `type` | `data` | Host behaviour |
|---|---|---|
| `ready` | `{ available: boolean }` | `false` → collapse the slot. Marks the instance "usable". |
| `rendered` | `{}` | Sent once, after first paint. Used for analytics and for "when was it shown". |
| `gate` | `{ allowed: boolean; reason?: string }` | While `allowed` is `false`, the host disables the primary action (Add to cart) and may show `reason`. Typically `false` while loading, then `true` once the extension knows (immediately for a product it has nothing to do with). |
| `error` | `{ code: string; recoverable: boolean }` | Logged and counted per extension; never shown raw to shoppers. `data` MUST NOT contain shopper content. |
| `auth.expired` | `{}` | Storeadmin only: host replies by assigning a fresh `authToken` (section 8). |

**Custom types** MUST be prefixed with the extension id (`personalization.saved`). The platform forwards
them to analytics/logging with the extension id and otherwise ignores them. Core code MUST NOT branch on
a specific custom type — if core needs to act on something, it becomes a standard type in a later version.

### 5.2 Host → extension

| Mechanism | Purpose |
|---|---|
| properties / attributes (section 4) | context and changes to it |
| `prepareForCart(): Promise<Record<string,string>>` — a method on the element | Called by the host when the shopper adds to cart, on every instance in the product slot whose extension has `cart.line-extensions:write`. The element does whatever it needs (e.g. save the design) and resolves with the line extension values, or **rejects with an `Error` whose message is safe to show** to cancel the add. Timeout: 30 s. |
| `zb:host-event` on the element (same envelope) | Notifications such as `cart.line-added` `{ lineId, quantity }` so the extension can clear its draft. Optional to handle. |

**The host MUST `await customElements.whenDefined(tag)` before calling `prepareForCart()`:** bundles register
asynchronously, so on a fast click the method may not exist yet (calling it then is a `TypeError`, not a
rejection). Before the element has connected, the method exists but rejects with a shopper-safe message.
Reuse rules for the personalization element: concurrent calls share one save, an unchanged design reuses its
customization, and the host MUST dispatch `cart.line-added` after the line is created so the next add saves a
fresh one (a customization is ordered at most once).

`prepareForCart` is the only synchronous question the host ever asks an extension. Keeping it to one
method is what stops host code from growing a special case per extension.

### 5.3 Delivery rules
- The bridge is written once, by the platform, and is the only place that reads `zb:event`.
- Events do not survive navigation or reloads and are not a persistence mechanism. Anything that must
  outlive the page goes into a **line extension** (section 6).
- Unknown `type`s and unknown `data` fields MUST be ignored.

## 6. Line extensions **[proposed]** (needs backend work)

Namespaced key/value data on a **cart line**, copied to the **order line** when the order is created.
Core stores and returns it and never interprets it.

```graphql
input LineExtensionInput { extensionId: String!  key: String!  value: String! }
# added to the existing cart input (i1_CartInput):   lineExtensions: [LineExtensionInput!]
```

Rules (enforced **server-side** — the client is untrusted):
1. `extensionId` MUST be installed and enabled for the store and hold `cart.line-extensions:write`;
   `key` MUST be declared in its manifest; `value` MUST satisfy the manifest limits. Otherwise the add-to-cart is rejected.
2. Limits: at most 8 keys per extension per line, key ≤ 40 chars, value ≤ 512 chars, ≤ 4 KB per line in total.
   Values MUST be identifiers or opaque tokens — **no personal data** (names, emails, free text).
3. **Line identity.** Today identical product + variant lines merge. The merge key becomes
   `(product, variant, hash of the extension entries listed in affectsLineIdentity)`, so two different
   customizations of one product are two lines.
4. **Edits** (quantity changes, variant changes, saved-for-later, guest→customer cart merge) MUST preserve
   line extensions.
5. **Reorder / add-to-cart-from-order** follows the manifest `onReorder`: `drop` (default) or `copy`.
6. An extension reads only its own namespace. Other extensions never see it. Storeadmin order views MAY
   show a generic "details" list built from the manifest, with no extension-specific code.
7. Order lines keep them for the life of the order, regardless of uninstall.

## 7. Order events (webhooks) **[implemented]** (receiver side; the platform dispatcher is proposed)

The platform pushes domain events to the endpoint declared in `events.endpoint` of every installed,
enabled extension that lists the event in `events.receive`. One dispatcher serves all extensions.

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

- **Data minimisation:** `lines` contains only the lines that carry the receiving extension's namespace,
  and `extensions` only that namespace (keys without the prefix). No customer data.
- **Event types v1:** `order.confirmed` — the order is accepted **and** payment is authorized/captured (or
  committed under a cash-on-delivery style method) and it will be fulfilled. It is never sent for a cart,
  a pending/unpaid order, or on mere creation. `order.cancelled` is reserved for v1.x.
- **Delivery:** HTTPS `POST`, at-least-once, retried with backoff on network errors, 408, 429 and 5xx; **not**
  retried on other 4xx. `eventId` is stable across retries; each attempt is re-signed with a fresh timestamp.
- **Authentication [implemented in the personalization Worker]:** per (store, extension) secret; headers
  `X-ZB-Key-Id`, `X-ZB-Timestamp` (Unix seconds, ±300 s), `X-ZB-Signature: v1=<hex HMAC-SHA256(secret,
  "<timestamp>.<exact body>")>`. Secrets are shown once, encrypted at rest, rotatable with an overlap.
- **Receiver duties:** verify the signature and timestamp; take the store from the credential, not the
  body; be idempotent on `eventId`; answer `200` whenever the event itself is valid, with per-line results:
  `{ "contract": 1, "eventId": "…", "duplicate": false, "results": [ { "lineId": "5521-1", "status": "applied" | "duplicate" | "rejected", "reason"?: string } ] }`.
  `rejected` is permanent (not retried) and surfaces to the merchant; `applied`/`duplicate` are success.
  A rejected line never undoes or blocks the other lines. `duplicate: true` on the envelope means the whole
  event was processed before: `results` are the **stored** outcome of the first delivery. To correct a rejected
  line, the platform sends a new `eventId`. Envelope-level problems (signature, store, unsupported type, an
  `eventId` reused with a different payload) are ordinary HTTP errors, not `results`.
- Ordering of events is not guaranteed; receivers MUST NOT depend on it.

## 8. Identity and authentication

### 8.1 Storefront (anonymous shoppers) **[implemented for personalization]**
- The Store key is public and grants nothing. Extension backends treat every storefront call as untrusted
  and rate-limit it. Anything private is protected by a **scoped, expiring token issued by the extension's own
  backend**, never by an id alone.

### 8.2 Storeadmin (merchants) **[proposed]**
- The platform exposes `POST /extensions/{extensionId}/session` (authenticated with the admin session).
  It returns a **short-lived token** (≤ 10 minutes) with claims:
  `iss` (platform), `aud` (extension id), `sub` (user), `store_id`, `scopes`, `iat`, `exp`, `jti`.
- The host assigns it to the element's `authToken` and refreshes it before expiry or on `auth.expired`.
- **The admin session token MUST NOT be passed to an extension.** It carries the whole user record and
  internal keys, and is signed with the platform's own secret.
- **Signature algorithm — decision needed (Open decision 2):**
  - **Preferred: asymmetric** (EdDSA or RS256). The platform signs with a private key only it holds and
    publishes the matching public keys at `/.well-known/jwks.json` (with key ids, so keys can rotate).
    Extension backends can *verify* tokens but can never *create* them. No secret is shared with any extension.
  - **Interim: symmetric HS256** with a **dedicated secret per extension** (never the platform's admin-token
    secret). Acceptable for the first extension; it does not scale to 100+ (every extension holds a
    secret that can forge tokens for itself; each must be distributed and rotated).
  - Extension backends SHOULD accept both during a migration window, selecting by the token header (`alg`, `kid`).
- Extension backends MUST verify signature, `iss`, `aud` (= their own id), `exp`, and use `store_id` from the
  token, never from the request.

### 8.3 Platform → extension (webhooks)
See section 7. Same trade-off applies in principle; per-store HMAC secrets are acceptable for v1 because the
secret is scoped to one (store, extension) pair and rotatable.

## 9. Loading and isolation

**Host MUST:**
1. Load bundles from the manifest as `<script type="module">` with the `integrity` hash and the page's CSP
   nonce, once per URL per page.
2. Treat load failure or a 10 s timeout as "slot empty": collapse the slot, report `extension.load-failed`
   with the extension id, never block rendering or checkout.
3. Load lazily — only for slots actually on the page and only for installed, enabled extensions.
4. Never render a storefront slot during server-side rendering; render it in the browser.
5. Be able to disable an extension for a store or globally without a deploy (install status = kill switch).

**Extension MUST:**
1. Define its custom element idempotently (loading the bundle twice must not register twice or replace an existing definition).
2. Not patch globals (no Zone.js on the host page, no polyfills, no global CSS, no global error listeners).
3. Touch only its own subtree; use Shadow DOM or fully scoped styles.
4. Bound its own work (timeouts on network calls) and never throw out of `prepareForCart` except with a shopper-safe message.
5. Keep the storefront bundle small (target ≤ 150 KB initial, gzip) and lazy-load heavy parts.

## 10. Lifecycle **[proposed]**

- **Install / uninstall:** the platform sends a signed `app.installed` / `app.uninstalled` event (same
  signing as section 7) to `lifecycle.endpoint`, so the extension backend creates or disables its per-store
  record and credentials. Handlers MUST be idempotent. Uninstall removes UI immediately; the extension decides
  what to do with its own data (retention policy MUST be documented); order lines keep their line extensions.
- **Enable / disable** are the same events with `app.enabled` / `app.disabled`.
- Menu entries and slots follow install status.

## 11. Versioning and compatibility

- `contract` is an integer carried in the manifest, every event and every webhook. Within v1 only additive
  changes are allowed (new optional fields, new standard event types, new slots).
- A breaking change is v2. The platform supports v(N) and v(N−1) for a published period; the manifest states
  which contract an extension implements.
- Receivers MUST ignore unknown fields, unknown event types and unknown manifest keys.
- Extension versions are semver; the platform pins a store to an exact version and upgrades explicitly.

## 12. Observability and abuse limits

- The bridge forwards `rendered`, `error` and custom events to the platform analytics with `extensionId`,
  `instanceId`, `slot`. "When was it rendered" = the `rendered` event timestamp; "where" = `slot` + `placement` + context.
- The platform keeps per-extension counters (load failures, errors, time-to-`ready`) and may auto-disable on a
  sustained failure rate.
- Platform limits (v1): ≤ 20 custom events/s per instance (excess dropped), event `data` ≤ 8 KB.

---

## 13. Worked example: Product Personalization

| Contract | How personalization uses it |
|---|---|
| Manifest | `id: personalization`; storeadmin slot `zb-personalization-admin`; storefront slot `zb-product-customizer`; permissions `cart.line-extensions:write`, `order.events:receive`; line key `customizationId`, `onReorder: drop`. |
| Context | `store-id`, `product-id`, `variant-id`, `locale` arrive as attributes/properties. The element resolves the template for the product itself. |
| Events | `ready { available }` (`false` when no template is mapped → slot collapses); `rendered`; `gate { allowed:false }` until the design is valid; custom `personalization.saved { customizationId }` for analytics only. |
| Cart | Host calls `prepareForCart()`; the element saves the design to its backend (`POST /customizations`) and resolves `{ customizationId }`; the platform writes it as a **line extension**. If saving fails it rejects with a shopper-safe message and the add is cancelled. |
| Order | On payment confirmation the platform sends `order.confirmed` with `lines[].extensions.customizationId`. The Worker verifies the signature, links each customization to its order line in one transaction (idempotent on `eventId`; a different order/line is a conflict) and replies with per-line `results`. |
| Admin auth | Storeadmin assigns the short-lived extension token to `authToken`; the Worker verifies it. |
| Reorder | `drop` — a customization can be ordered once. |

### Status of today's personalization code against this contract

| Area | Status |
|---|---|
| Webhook signing, per-store encrypted credentials, rotation | **implemented** (Worker) |
| Order events: contract-v1 envelope (multi-line, `extensions`, per-line `results`, stored replay) at `/integrations/personalization/events` | **implemented** (Worker) |
| Storefront element: `zb:event` (bubbling, composed) with `ready` / `rendered` / `gate` / `error` and `personalization.saved`; `instance-id`, `placement`, `hide-save`; `prepareForCart()`; saves to the Worker itself | **implemented** (element). The original `customizer-*` events and the `customizer-save` flow are unchanged |
| Reference host bridge + demo product page (`integration-demo/extension-bridge.js`, `storefront-cart.html`) | **implemented** — generic, manifest-driven, covered by browser tests |
| Admin token | Worker verifies HS256 (`JWT_SIGNING_SECRET`) or a dev token. EdDSA/RS256 via JWKS **not yet** (waiting on decision 2) |
| Install / uninstall lifecycle endpoint | **not yet**. The Worker has no install state: a store is registered by its first authenticated request and there is no enable/disable flag until this endpoint exists |
| `context` object, `locale` attribute | **not yet** (attributes cover the personalization needs) |
| Storeadmin hosting | POC branch with a hardcoded route and menu entry; manifest-driven `/app/apps/:extensionId` is the platform team's |
| Storefront hosting: slot renderer, module loader, bridge in the product page, `lineExtensions` in the cart API and order lines, webhook dispatcher | **platform teams** (decisions 3, 5, 6) |

## 14. Open decisions

| # | Decision | Owner | Needed for |
|---|---|---|---|
| 1 | **Which identifier is the Store key?** The client exposes `store.id` (numeric), `clientId` and `store.storeId`. Pick one and use it in tokens, storefront attributes and webhooks. | Platform | everything |
| 2 | **Token signing: asymmetric (JWKS) or interim per-extension HS256?** | Platform / backend | storeadmin tokens |
| 3 | **Line extensions in the cart/order GraphQL and DB**, including the line-identity change and the reorder rule. | Backend (`services-api-phase2`) | storefront flow |
| 4 | **Where manifests live** (extend the plugin catalog table with a manifest column, or a new registry) and who may publish one. | Platform | install, nav, loader |
| 5 | **Webhook dispatcher** (queue, retries, dead-letter, merchant-visible failures). | Backend | order events |
| 6 | **CSP and SRI** policy for loading third-party bundles on storefront pages. | Storefront | loader |
| 7 | **Data retention on uninstall** (extension data vs order-line data). | Product / legal | lifecycle |
| 8 | **Business retention of ordered customizations** (how long artwork is kept after fulfilment). | Product | personalization only |

## 15. Conformance checklist for an extension

- [ ] Manifest validates; `entry` is immutable and versioned; `integrity` matches.
- [ ] Element registers idempotently, touches no globals, works from attributes alone.
- [ ] Emits `ready` and `rendered`; uses `gate` rather than reaching into the page.
- [ ] Never calls core cart/order APIs; line extension values are identifiers only.
- [ ] Webhook receiver verifies signature + timestamp, is idempotent on `eventId`, reports per-line results.
- [ ] Backend verifies platform tokens (`iss`, `aud`, `exp`, signature) and takes the store from the token.
- [ ] Survives the platform disabling it: no errors when its slot disappears mid-session.
