# ZenBasket SDK and plugin manifest (Product Personalization)

How the Store Admin host and this plugin talk to each other. Status: first version, token is a MOCK.

## The SDK (`zbService`)

* Contract: `src/app/zenbasket/zb-sdk.ts` here, `apps/zb-storeadmin/src/app/apps/models/zb-sdk.ts` in `zb-app`.
  **The two files must stay byte-identical** (no imports, plain types, `ZB_SDK_VERSION`). Check with
  `cmp <plugin>/src/app/zenbasket/zb-sdk.ts <zb-app>/apps/zb-storeadmin/src/app/apps/models/zb-sdk.ts`.
  Change it additively and bump `ZB_SDK_VERSION` when a plugin needs something older hosts lack.
* Host side: `ZbService` implements `ZenBasketSdk` and is assigned to the element as the property `zbService`
  by `custom-plugins.component.ts`, before the element is attached.
  * `auth.getAccessToken({ forceRefresh? })` → `ZbPluginTokenService` (**mock**, see below)
  * `products.search({ query?, limit?, offset? })` → `ZbProductsService` (`getAllProductDetails`, current store)
  * `core` → `AngularCoreAdapter` (navigation, image, graphqlClient, store)
* Plugin side: `ZenBasketBridge` reads `element.zbService` once at start-up and validates its shape; anything else
  (no SDK, the old empty facade, an older version) is ignored and the plain element properties keep working.
  * Tokens: `RuntimeConfig` asks the bridge for a token before a request (and when the current one is within 30 s
    of `expiresAt`). On a `401` the `ApiClient` asks again with `forceRefresh: true` and repeats the request once.
    A token assigned through the `authToken` property still works and is used until it is rejected.
  * Products: with no `productCatalog` and no `productSearchUrl`, the mapping page searches through
    `products.search` (debounced, 50 per search).

### Replacing the mock token (host team)

`apps/services/zb-plugin-token.service.ts` returns the static dev token `zb-local-dev-token` (accepted by
`wrangler dev --var DEV_AUTH_TOKEN:zb-local-dev-token` and by the deployed dev Worker's `DEV_AUTH_BYPASS`).
It throws in `prod`/`preprod`. Replace `getAccessToken` with the call to the backend endpoint that mints a
short-lived, **store-scoped** plugin token; return `{ token, expiresAt }`. Do not return the Store Admin session JWT.
Nothing in the plugin changes.

## manifest.json

Fetched by the host from `<base>/manifest.json` (`awsFileUrl + <pluginName>/` outside `app: 'local'`,
`customPluginLocalBaseUrl` in `local`). Source file: `public/personalizedproduct/manifest.json`; the host
reads the copy in the served plugin folder (`dist/personalizedproduct/manifest.json` for the local setup).

Per `development` / `production` → `storeadmin` | `storefront` entry:

| Field | Meaning |
|---|---|
| `elementName` | Custom element tag. Admin: `zb-personalization-admin`; storefront: `zb-product-customizer` |
| `script` | Entry module: `store-admin.js` / `storefront.js` (relative to the plugin folder, or absolute) |
| `styles` | Extra stylesheets; empty, the element is self-contained (Shadow DOM) |
| `sdkVersion` | (admin) oldest host SDK the plugin runs against; the loader refuses a lower host |
| `config` | Properties assigned to the element before it is attached. Admin: `apiBaseUrl`, `persistence: "cloud"`. Storefront: `apiBaseUrl` |
| `subMenus` | Informational for now; the host does not read it yet |

`production.*.config.apiBaseUrl` currently names the deployed **dev** Worker, the only one that exists. Put the real
Worker URL there when the plugin is published to S3.

## Local run

1. `npm run build:element` → `dist/product-personalization/`
2. Copy it to the served folder next to your manifest: `dist/personalizedproduct/` (keep `manifest.json`).
3. `node scripts/serve-static.mjs dist 4600 --cors`
4. Worker: deployed dev Worker, or `wrangler dev --var DEV_AUTH_TOKEN:zb-local-dev-token` (CORS must allow the Store Admin origin).
5. Store Admin with `awsFileUrl: 'http://localhost:4600/'` → `/app/customplugin/personalizedproduct`.
