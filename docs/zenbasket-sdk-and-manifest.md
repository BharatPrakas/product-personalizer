# ZenBasket SDK and plugin manifest (Product Personalization)

How the Store Admin host and this plugin talk to each other. Status: token comes from the backend `getPluginToken`.

## The SDK (`zbService`)

* Contract: `src/app/zenbasket/zb-sdk.ts` here, `apps/zb-storeadmin/src/app/apps/models/zb-sdk.ts` in `zb-app`.
  **The two files must stay byte-identical** (no imports, plain types, `ZB_SDK_VERSION`). Check with
  `cmp <plugin>/src/app/zenbasket/zb-sdk.ts <zb-app>/apps/zb-storeadmin/src/app/apps/models/zb-sdk.ts`.
  Change it additively and bump `ZB_SDK_VERSION` when a plugin needs something older hosts lack.
* Host side: the loader assigns `zbService.forPlugin(pluginCode)` (a `ZenBasketSdk`) to the element as the property
  `zbService`, before the element is attached.
  * `auth.getAccessToken({ forceRefresh? })` → `ZbPluginTokenService` → backend `getPluginToken`. The plugin supplies
    **neither `pluginCode` nor `storeId`**: `forPlugin` binds the plugin code (route) and reads the signed-in store
    (`ZbaSharedService.user().storeId`) on every call, so a plugin can only get tokens for itself and the current store.
    The backend must also check both against the authenticated admin session.
  * `products.search({ query?, limit?, offset? })` → `ZbProductsService` (`getAllProductDetails`, current store)
  * `core` → `AngularCoreAdapter` (navigation, image, graphqlClient, store)
* Plugin side: `ZenBasketBridge` reads `element.zbService` once at start-up and validates its shape; anything else
  (no SDK, the old empty facade, an older version) is ignored and the plain element properties keep working.
  * Tokens: `RuntimeConfig` asks the bridge for a token before a request (and when the current one is within 30 s
    of `expiresAt`). On a `401` the `ApiClient` asks again with `forceRefresh: true` and repeats the request once.
    A token assigned through the `authToken` property still works and is used until it is rejected.
  * Products: with no `productCatalog` and no `productSearchUrl`, the mapping page searches through
    `products.search` (debounced, 50 per search).

### Token expiry

`getPluginToken` returns no expiry, so the plugin renews on a `401`. If the backend adds `expiresAt`/`expiresIn`,
return it from `ZbPluginTokenService` (`ZbAccessToken.expiresAt`) and the plugin will renew shortly before it lapses.

## manifest.json

The host now reads the manifest from the backend (`getOnePluginByCode(pluginCode, storeId).manifestJson`), not from
the plugin folder. `public/personalizedproduct/manifest.json` is the source to register there (and the copy served
next to the bundle for reference). Shape, per target `storeadmin` | `storefront`:

| Field | Meaning |
|---|---|
| `elementName` | Custom element tag. Admin: `zb-personalization-admin`; storefront: `zb-product-customizer` |
| `local` / `build` | `{ script, styles }` for the local dev server / the published bundle. `script` is absolute, or relative to `awsFileUrl + <pluginCode>/` |
| `sdkVersion` | (admin) oldest host SDK the plugin runs against; the loader refuses a lower host |
| `config` | Properties assigned to the element before it is attached. Admin: `apiBaseUrl`, `persistence: "cloud"`. Storefront: `apiBaseUrl` |
| `subMenus` | Informational; the host does not read it yet |

`config` is shared by `local` and `build` (no per-mode config). It currently names the deployed **dev** Worker, the only
one that exists; put the real Worker URL there when publishing to S3.

## Local run

1. `npm run build:element` → `dist/product-personalization/`
2. Copy it to the served folder next to your manifest: `dist/personalizedproduct/` (keep `manifest.json`).
3. `node scripts/serve-static.mjs dist 4600 --cors`
4. Worker: deployed dev Worker, or `wrangler dev --var DEV_AUTH_TOKEN:zb-local-dev-token` (CORS must allow the Store Admin origin).
5. Store Admin route `/app/customplugin/<pluginCode>`; for `app: 'local'` the `local` assets are used, otherwise `build` under `awsFileUrl + <pluginCode>/`.
