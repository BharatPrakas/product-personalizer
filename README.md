# Product Personalizer (two custom elements: `<zb-personalization-admin>` + `<zb-product-customizer>`)

A standalone Angular 22 application for TeeInBlue-style product personalization. A **merchant** manages
*configurations*: for each product, several mockups, independent printable areas (each with its own production
canvas and mask), artworks made of layers, and the customer inputs those layers need. The **customer preview** is
generated from the configuration: add a photo slot to an artwork and the matching upload field appears, with no
code change. The same rendering engine and the same `<zb-product-customizer>` custom element power both.

It runs entirely in the browser: configurations and uploaded images are stored in IndexedDB, rendering is Canvas 2D.
The persistence layer is an interface (see below) so ZenBasket integration can replace it without touching the UI or
the renderer. A **shared Cloudflare Worker backend** (PostgreSQL via Hyperdrive + R2 for assets) lives in
[`worker-api/`](worker-api/README.md) and plugs into that interface; it is **opt-in** — with no runtime config the app
stays on IndexedDB and is unchanged.

```bash
npm install
npm start            # http://localhost:4200  ->  opens the Configurations workspace
```

## Two custom elements, one codebase

The app ships as **two framework-free web components** any storefront or admin shell loads with a plain
`<script type="module">`:

| Element | Audience | Purpose | Entry |
|---|---|---|---|
| [`<zb-personalization-admin>`](#using-the-admin-element) | Store admin / merchant | Create, edit, publish and **map** templates (mockups, printable areas, artworks, customer inputs) to store products; markup library | `store-admin.js` |
| [`<zb-product-customizer>`](#using-the-storefront-element) | Shopper on the product page | Resolve the template mapped to the current product and let the shopper personalize it live | `storefront.js` |

```
dist/product-personalization/            (npm run build:element)
├── storefront.js          stable un-hashed entry -> loads the storefront code
├── store-admin.js         stable un-hashed entry -> loads the admin code
├── main-<hash>.js         tiny shared façade (no side effects)
├── chunk-<hash>.js        content-hashed code: Angular runtime + shared engine in shared chunks,
│                          each element's own code and the admin's heavy parts (editor, mapping,
│                          dialogs) in lazy chunks. The storefront never downloads editor code.
├── assets/  data/         demo fonts, clipart, mockups and sample templates (replace with your own)
├── schema/                product-config.schema.json, customizer-config.schema.json
├── types/                 public .d.ts for both elements (index.d.ts, element-contract.d.ts, admin-element-contract.d.ts, ...)
├── integration-demo/      plain-HTML pages: storefront.html, store-admin.html
└── MANIFEST.json          every file: size, sha256, role (entry | runtime | contract | demo-*), plus each
                           entry's initial download graph
dist/element/product-customizer.js       compatibility shim (imports ../product-personalization/storefront.js)
```

`scripts/finalize-element.mjs` enforces the bundle budgets on the *real* per-entry download graph (the Angular
builder only sees the shared façade as "initial"): **storefront** warn 400 kB / error 700 kB raw (currently ~396 kB),
**admin** warn 1.4 MB / error 2.0 MB for the initial download (currently ~430 kB; the editor, mapping and preview
pages are lazy chunks). It also fails the build if admin code (`zb-personalization-admin`, `config-published`,
`mapping-changed`) ever leaks into the storefront graph.

Why one build with a façade instead of two builds: the Angular builder takes a single browser entry, so
`src/main.elements.ts` exports `loadStorefront()` / `loadAdmin()` (dynamic imports of `src/main.storefront.ts` /
`src/main.admin.ts`) and the build splits shared code into chunks both entries reuse. Loading both elements on one
page downloads Angular once.

**Moved from `dist/element/`:** the old output folder now only contains the shim above. Deploy the whole
`product-personalization/` folder and point pages at `storefront.js`; the shim exists for pages that still import
`/element/product-customizer.js`.

## Using the application

**Configurations** (`/configurations`) is the workspace: search, filter (All / Draft / Published / Archived), and
open, preview, duplicate, archive, restore, delete or import a configuration. A new browser starts empty; nothing is
seeded.

1. **New configuration**: name it and, optionally, upload the product photo (a *mockup*).
2. The **editor** opens with a short setup guide in the properties panel:
   - *Add a product photo*: **Mockups** tab. Each mockup can be renamed, reordered, shown or hidden, duplicated and
     assigned to variants. Overlays (glass, clock hands) can sit above the artwork.
   - *Define a printable area*: **Add area** → choose Rectangle, Circle / ellipse or Custom shape (an uploaded SVG or
     pasted path) → **Draw on mockup** (or place it in the centre and adjust). Move, resize and rotate it on the
     canvas, or type exact values. Perspective placement (four corners) is available in the placement settings.
   - *Design the artwork*: **Artwork** view of the canvas shows that area's own production canvas. The **Layers** tab
     adds *Photo upload*, *Editable text*, *Clipart choice* (customer inputs) and *Fixed image*, *Fixed text*,
     *Rectangle*, *Ellipse* (fixed design). Drag layers to reorder; hide, lock, duplicate or delete from the row.
   - *Add a customer input*: selecting a customer-input layer shows its input settings (label, required, accepted
     formats, maximum size, fonts, colours, style controls, visibility rule) next to its geometry.
   - Printable areas can offer several **Artworks** for customers to choose between, and each variant picks which
     mockups and areas it includes.
3. **Preview** opens the customer's view of the working draft: gallery, variants, the generated inputs, live
   preview and validation. *Save customization* checks the design (nothing is stored or sent) and enables
   **Test files**: one production PNG per printable area and one composite PNG per mockup.
4. **Save draft** stores the working copy. **Publish** (enabled once the setup steps are complete) makes the current
   design the published configuration and keeps the draft open for further edits; the list shows *Published* and
   *Unpublished changes* (with the live version number). Leaving with unsaved changes asks first; saving over a copy changed in another tab
   is refused rather than overwritten.

Keyboard: `Ctrl/Cmd+S` save draft, `Ctrl/Cmd+Z` / `Shift+Z` undo / redo, `V` select, `H` pan, arrow keys nudge the
selection, `Esc` cancels drawing. The canvas has numeric alternatives for every move, resize and rotation.

### Persistence and publishing: what is real

| Operation | Status |
|---|---|
| Create, save draft, reopen, duplicate, archive / restore, delete | Implemented against the browser (IndexedDB); each resolves only after the write succeeded and failures are shown |
| Publish | Implemented as a state transition in the same store (draft → published snapshot; draft continues as the next version); validated strictly first |
| Import / export configuration JSON | Implemented (stored images are embedded as data URLs in exports) |
| Server persistence, cloud image storage, version history | Implemented as an **opt-in** Cloudflare Worker backend (`worker-api/`): PostgreSQL via Hyperdrive + R2. Verified locally (migrations, full API + R2 flow, and an end-to-end `wrangler dev` run on the `workerd` runtime); not yet exercised on a live Cloudflare account. Default standalone build still says "Saved in this browser only" |
| Authentication, multi-user publishing | Integration boundary defined (HS256 session token issued by the host; store id from verified claims). No production identity provider is bundled — see `worker-api/README.md` |
| Cart / checkout | **Not implemented** |

All persistence goes through `ConfigurationRepository` (`src/app/workspace/configuration-repository.ts`):
`list`, `get`, `create`, `createFromDraft`, `saveDraft` (with an optimistic-concurrency check), `publish`, `duplicate`,
`archive`, `restore`, `delete`. `LocalConfigurationRepository` (IndexedDB) is the default; `CloudConfigurationRepository`
(`src/app/workspace/cloud/`) is the hosted implementation that talks to the Worker API, selected at runtime in
`app.config.ts` when `window.__ZB_PERSONALIZER__.apiBaseUrl` is set. If IndexedDB cannot be opened the app falls back to
memory and says so on screen. A one-time, resumable, non-destructive IndexedDB→cloud migration lives in
`src/app/workspace/cloud/migration.service.ts`.

### Developer tools

`/dev` (development builds only; the route is guarded by `isDevMode()` and there is no navigation link) can add the
bundled sample configurations from `public/data/products` to the workspace, open the custom-element contract demo
(`/dev/element`, with the original v1 samples) and wipe local data. Nothing there runs automatically. If you used an
earlier build in this browser, its seeded sample products are still in IndexedDB until you delete them (delete from the
list, or *Clear all local data* in the developer tools).

## What the code is

| Area | Where |
|---|---|
| Schema v2 | `models/product.models.ts`, `public/schema/product-config.schema.json`, validator `util/product-validator.ts` (drafts may be incomplete; published and storefront-loaded configurations are validated strictly) |
| v1 compatibility | `util/config-upgrade.ts` turns a v1 configuration into a one-variant, one-mockup, one-area v2 configuration at load time; v1 hosts keep the v1 snapshot, events and messages |
| Resolution | `util/resolve.ts`: variant → mockups → enabled areas → artwork per area → visible layers → active fields (declarative `showWhen` conditions) |
| Rendering | `util/scene.ts` (one scene per area), `util/draw.ts` (masks, rotation, opacity, clipping, shapes, wrapped text, composition, perspective), `AreaCanvasCache` repaints only the area that changed |
| Exports | `ExportService`: production PNG per area from its own canvas (transparent outside the mask; no mockup, placeholders or outlines); composite preview PNG per mockup |
| Workspace | `src/app/workspace`: configuration records and lifecycle, repository interface and local implementation, publish readiness, import / export |
| Editor | `src/app/editor`: store (undo / redo, selection, asset sync, save / publish), stage (zoom, pan, drag, resize, rotate, draw, snapping), sidebar tabs, inspector, immutable edit operations (`util/config-edit.ts`) |
| Customer preview | `src/app/preview`: the customer's view, plus the real `<app-product-customizer>` |
| Design system | tokens in `src/styles/_tokens.scss`; shared UI kit in `src/app/ui` (icons, menus, dialogs, toasts, sections) |

### Known limitations and deferred work

- Cloud persistence is opt-in and the Angular↔cloud path is not yet verified against a live Cloudflare deployment
  (the Worker itself is verified locally and on `workerd`); no bundled production auth provider; no catalog / cart /
  checkout, AI artwork or 3D. See [`worker-api/README.md`](worker-api/README.md) for the backend's own limitations.
- Print size is set per printable area, not per variant.
- `idb:` and `data:` image sources are accepted only by the standalone app (`allowLocalAssets`); hosted configurations
  use `http(s)` assets, as before.
- Perspective placements use a 14 x 14 triangle mesh (visually exact for mockup-sized quads, not a GPU warp).
- Customer photo rotation is in 90 degree steps; text is single-style per layer; the visibility-rule editor edits one
  condition (advanced rules are preserved but not editable).
- Undo / redo covers configuration edits, not images already written to IndexedDB.
- Tested in Chrome only (headless Chrome 154).
- The editor's property panels bind directly to an immutable store rather than using Signal Forms (they are
  inspectors, not submit-able forms); the customer-facing fields keep the original Reactive Forms.
- `Customization` is a union (`CustomizationV1 | CustomizationV2`); TypeScript hosts narrow on `schemaVersion`.

## Quick start

```bash
npm install
npm start                    # Angular demo app at http://localhost:4200
npm run build:element        # both elements -> dist/product-personalization/
npm run serve:element        # serves it at http://localhost:4300
                             #   demos: http://localhost:4300/integration-demo/storefront.html
                             #          http://localhost:4300/integration-demo/store-admin.html
```

| Script | What it does |
|---|---|
| `npm start` | Dev server for the standalone application |
| `npm run build` | Production build of the standalone app (`dist/product-personalizer`) |
| `npm run build:element` | Production build of both elements, then `scripts/finalize-element.mjs` (stable entries, `.d.ts`, demo pages, budgets, `MANIFEST.json`) |
| `npm test` | Unit tests (Vitest through `ng test`; `npm run test:ci` runs once without watch) |
| `npm run test:browser` | Builds the element, then runs the browser suite against it in headless Chrome |
| `npm run test:browser:dev` | Same suite against the **development** build (surfaces Angular dev-mode assertions) |
| `npm run test:types` | Compiles a consumer file against the shipped `.d.ts` files |
| `npm run generate:fixtures` | Regenerates the v1 demo mockups, clipart and sample photos (needs Chrome) |
| `npm run generate:demo-assets` | Regenerates the v2 demo mockups, clock-hand overlays and sample customer photos (needs Chrome) |

Browser tests use `puppeteer-core` with the system Chrome (`/usr/bin/google-chrome`, or set `CHROME_PATH`).

## Versions and compatibility

Selected and locked in `package-lock.json`:

| Package | Version |
|---|---|
| Angular (`core`, `common`, `forms`, `platform-browser`, `compiler`) | 22.2.2 |
| `@angular/elements` | 22.2.2 (kept in step with Angular core) |
| `@angular/build`, `@angular/cli` | 22.2.2 |
| TypeScript | 6.0.3 (strict) |
| RxJS | 7.8.2 |
| Node (build and test) | `^22.22.3 \|\| ^24.15.0 \|\| >=26` (Angular 22's range; developed on 24.21.0) |

Runtime: the element needs a current evergreen browser (Canvas 2D, `createImageBitmap`, `FontFace`, CSS container
queries and `:has()`; `Intl.Segmenter` is used when present). Going by feature support that means roughly Chrome/Edge 111+,
Safari 16.4+ and Firefox 121+. **That range is an estimate: tests ran on Chrome 154 only.**

**No Zone.js.** The bundle is zoneless (`provideZonelessChangeDetection`) and never patches the host's globals.
It installs no global error listeners and adds **no CSS to the host document**.

Extra dev dependencies and why: `puppeteer-core` (browser tests, fixture generation), `axe-core` (accessibility
audit in tests), `ajv` (checks the sample configs against the JSON Schema in tests only; it is **not** in the
bundle, because it compiles code and would need `unsafe-eval`; runtime validation is hand-written),
`@types/node` (test tooling). `@angular/router` provides the lazy-loaded routes of the standalone app only; it is
not part of the element bundle.

## Using the storefront element

```html
<div id="slot"></div>
<script type="module">
  import '/customizer/storefront.js';                  // the stable entry URL
  await customElements.whenDefined('zb-product-customizer');

  const element = document.createElement('zb-product-customizer');
  element.configUrl = '/customizer/data/tote-photo.json';
  element.addEventListener('customizer-save', async (event) => {
    const { requestId } = event.detail;
    try {
      await persistCustomizationInHost(event.detail);    // YOUR code: see "Persistence handoff"
      element.saveResult = { requestId, status: 'success' };
    } catch {
      element.saveResult = { requestId, status: 'error', message: 'Unable to save. Please try again.' };
    }
  });
  document.querySelector('#slot').append(element);       // assign properties first, append last
</script>
```

Assign object properties before appending and never serialise config objects or Blobs into attributes.
Create **a fresh element** after removing one (Angular Elements destroys the component shortly after
disconnect; a detached instance cannot be re-attached). Restore a draft by setting `initialCustomization` and
`assetMap` on the new element.

### Properties and attributes

| Property | Attribute | Meaning |
|---|---|---|
| `config` | none | Full configuration object. Replace, don't mutate. Exactly one of `config` / `configUrl`; both set shows a `config-conflict` error |
| `configUrl` | `config-url` | URL of the JSON configuration |
| `baseUrl` | `base-url` | Directory that relative asset paths in an **object** `config` resolve against (falls back to `document.baseURI`) |
| `initialCustomization` | none | A saved `customization` to restore. Must match product id, template id and template version, otherwise a `restore-mismatch` error is emitted and defaults are used |
| `assetMap` | none | `Map` or object: asset id -> durable image URL (CORS-readable) or `Blob` |
| `disabled` | `disabled` | Disables all inputs and Save. Absent/`"false"` is false; empty/`"true"`/any other string is true |
| `saveResult` | none | `{requestId, status: 'success' \| 'error', message?}`: the host's acknowledgement |
| `allowedAssetOrigins` | none | *Extension.* Origin allow-list (`['https://cdn.example']`). Empty means any http(s) origin; the page's own origin is always allowed |
| `mode` | `mode` | `storefront` (a trigger button, shown only for a personalizable product, opens the editor in a modal) or `preview` (the editor inline, no trigger). Absent: `storefront` when the template is resolved from `product-id`, `preview` when `config` / `config-url` is supplied. See [Storefront mode](#storefront-mode-a-button-only-where-it-applies) |
| `triggerStyle` | `trigger-style` (JSON) | The trigger button's appearance, in the ZenBasket Builder's button model. See [Trigger button style](#trigger-button-style-zenbasket-builder) |
| `productId` | `product-id` | *Resolve by product.* The host's id of the product on this page |
| `variantId` | `variant-id` | The host's currently selected variant; a variant mapping wins over a product mapping |
| `collectionIds` | `collection-ids` | Collections of the product (`string[]` property, or comma separated attribute) |
| `apiBaseUrl` | `api-base-url` | Base URL of the personalization API |
| `storeId` | `store-id` | Public storefront key of the store (identifies, grants nothing) |

Setting `config`/`configUrl`/`baseUrl`/`initialCustomization`/`assetMap` (re)starts a load: the previous draft is
discarded, in-flight loads are aborted and late responses are ignored. Use the `dirty` flag from
`customizer-change` to confirm with the shopper **before** swapping the configuration.

### Storefront mode: a button, only where it applies

On a product page the element no longer unfolds the whole editor into the page. It is a **lightweight shell**:

1. It mounts without rendering any editor and asks the personalization API (the existing public read described in
   the next section) whether the product has a published template. Nothing is shown while it waits, and nothing
   blocks the page.
2. **No published template** (nothing mapped, draft-only, archived, unknown store): no button at all, only the
   `fallback` slot, `data-status="not-personalizable"`, `ready { available: false }`.
3. **A published template**: a **trigger button** (default label *Personalize*). The editor is **not** downloaded or
   created yet.
4. A click opens the existing editor in an accessible **modal** (a native `<dialog>` in the browser's top layer: no
   page container clips it or stacks above it, the page behind is inert, Tab stays inside, Escape closes, focus
   returns to the button). The editor's code is a separate chunk that is fetched by that first click; the template
   already in hand is reused, so there is no second API call.
5. **Save customization** in the modal validates, saves and closes it. The button becomes *Edit personalization* and
   the design is restored when the modal is reopened. Closing with unsaved changes asks first (*Keep editing* /
   *Discard changes*); closing is refused while a save is in progress.

The element never touches the cart: the host still adds to cart, calling `prepareForCart()` (below).

**Who saves.** The distinction the element always had is kept:

| | Attribute | Save in the modal | Host hears |
|---|---|---|---|
| Element-managed (the platform extension flow) | `hide-save` | the element saves the design to the personalization API itself and closes on success | `zb:event` `personalization.saved { customizationId, templateId, templateVersion, productId, variantId?, expiresAt?, source: 'save' }` |
| Host-acknowledged | none | emits `customizer-save` and waits for `saveResult`; closes on `success` | `customizer-save` (unchanged), then your `saveResult` |

In the modal the Save button is always shown; `hide-save` only chooses who persists. A failed save keeps the modal open,
shows why, and Save retries (the same retry, 30 s timeout and idempotency as before). `prepareForCart()` reuses a
saved, unchanged design instead of saving it again; a product the shopper has not personalized is refused (and
`gate` stays `allowed: false` with a reason) rather than added as the plain product. Saving never adds to the cart.

**Reacting to the product.** Changing `product-id`, `variant-id`, `collection-ids`, `store-id` or `api-base-url`
re-asks the API, **hides the button at once** (eligibility is unknown), ignores stale answers and aborts superseded
requests. A saved design is kept only while the product and the resolved template (id *and* version) are the same; an
open modal whose template changed is closed. Changing `trigger-style` never causes a request or touches the editor.

**Not in the modal flow, and unchanged:** `mode="preview"` (and any host-supplied `config` / `config-url`) render the
editor inline exactly as before. The admin app's live preview uses it explicitly (`<app-product-customizer mode="preview">`),
so the trigger never appears there.

> **Behaviour change for hosts that embedded the inline editor by `product-id`:** that is now the trigger + modal.
> Add `mode="preview"` to keep the inline editor.

### Trigger button style (ZenBasket Builder)

```js
element.triggerStyle = {            // or attribute trigger-style='{"buttonColor":"#0a5c36", ...}'
  buttonText: 'Personalize this product',
  buttonColor: '#0a5c36',           // background
  buttonTextColor: '#ffffff',
  buttonFont: 'Georgia, serif',
  buttonTextSize: 18,               // px
  buttonTextFontStyle: ['B'],       // 'B' bold, 'I' italic, 'U' underline
  buttonRadius: 24,                 // px, optional borderRadiusPositions: ['TL','TR','BR','BL']
  buttonPadding: 12,                // px (vertical); buttonPaddingInline defaults to twice that
  width: 320,                       // px, or 'full'
  buttonAlignment: 'center',        // 'start' | 'center' | 'end' (also 'left' / 'right')
  buttonBorderColor: '#112233', buttonBorderThickness: 2, buttonBorderPositions: ['T','B'], borderStyle: 'solid',
  buttonHoverColor: '#083d24', buttonHoverTextColor: '#fff', buttonBorderHoverColor: '#000', // unless isButtonHoverEffect === false
  buttonDisabledColor: '#ccc', buttonDisabledTextColor: '#666', buttonDisabledBorderColor: '#999',
};
```

The names and units are those of the Builder's own button model (`ButtonPropertiesModel` in the store admin's
theme editor), so a Builder button object can be passed as it is; unknown keys are ignored. `buttonDisabled*` is an
addition (the Builder has no disabled state yet).

* **Validated, never injected.** Each field is checked against a narrow grammar (colour, bounded number, keyword,
  font name) and anything else is dropped so the default applies. The result is a set of CSS custom properties
  written one by one through the CSSOM, never CSS text: a value cannot add a rule, `url()`, `var()` or a second
  declaration, and a strict `style-src` CSP is unaffected. The label is plain text.
* **Readable by construction.** A text colour below 4.5:1 on the chosen background is replaced by black or white
  (hover pair included). The focus ring is a dark ring with a light halo, visible on any background the merchant picks.
* **Update in place.** Assign a new object any time (`element.triggerStyle = ...`): the button is restyled, no request
  is made and nothing is reloaded. Missing values fall back to the defaults / `--customizer-primary`, `--customizer-radius`.
* Only the trigger follows the Builder. The modal keeps the Personalizer's own design (`--customizer-*` theming, `theme`).
* `::part(trigger)` exposes the button to host CSS as well.

### Resolve by product (no `config` / `config-url` needed)

```html
<zb-product-customizer
  product-id="gid-1234" variant-id="gid-1234-m" collection-ids="summer,apparel"
  api-base-url="https://api.example.com" store-id="my-store">
  <p slot="fallback">This product cannot be personalized.</p>
</zb-product-customizer>
```

When neither `config` nor `config-url` is set and `product-id`, `api-base-url` and `store-id` are, the element calls
the **public** read endpoint (no merchant token, no cookies: `credentials: 'omit'`)

```
GET {api-base-url}/api/v1/storefront/personalization/products/{product-id}/config
    ?storeId=…[&variantId=…][&collectionIds=a,b]
→ 200 { "data": { "personalizable": true, "configId", "version", "scope": "product|variant|collection",
                  "externalId", "config": <published ProductConfig, absolute https asset URLs> } }
→ 200 { "data": { "personalizable": false } }          nothing mapped / published (also unknown store)
```

and loads only the **published** template mapped to that target. Precedence: **variant > product > collection**
(`src/app/mapping/mapping-resolution.ts` mirrors the server). `config` / `config-url`, when present, always win and
the API is not asked.

* Nothing mapped: the element renders only the `fallback` slot (host-provided light-DOM content), sets
  `data-status="not-personalizable"` and emits `customizer-ready` with `{ personalizable: false, templateId: '',
  templateVersion: 0, productId }` so the theme can hide the whole section.
* Changing `variant-id` / `collection-ids` / `product-id` re-resolves. In `storefront` mode the button is hidden until
  the new answer is in; inline (`preview`) the same template id and version keeps the loaded design (and the shopper's
  input) and a new published version or a different template replaces it.
* A failing service shows no button, a short *temporarily unavailable* line with **Try again** (inline: the
  recoverable error panel), and `customizer-error` code `config-load-failed`; Add to cart stays gated.
* The URL policy still applies to the answer: asset URLs outside the page origin / `allowedAssetOrigins` are
  rejected (the API origin is added automatically when you set a restrictive list).
* The response is cacheable (`ETag`, `Cache-Control: s-maxage`, `stale-while-revalidate`), so repeat views are cheap.

### Events

Plain `CustomEvent`s dispatched on the element. The `customizer-*` events below do **not** bubble; listen on the element. (The contract-v1 `zb:event`, next section, does bubble.)

| Event | `event.detail` |
|---|---|
| `customizer-ready` | `{productId, templateId, templateVersion}` (+ `schemaVersion: 2` for v2 configurations, + `personalizable` when resolved by product; `templateId`/`templateVersion` carry the configuration id/version). Inline: once per successful load, after fonts and images are ready. `storefront` mode: once the product is known to be (not) personalizable, before the editor exists; opening the modal does not repeat it |
| `customizer-change` | `{draft, valid, dirty, errors}`; text edits debounced by 150 ms, other edits immediate; contains no image bytes |
| `customizer-save` | `{requestId, customization, previewBlob, artworkBlob, assets, artworks, previews}`; `artworks` has one production PNG per active printable area (`artworkBlob` is the first), `previews` one composite per active mockup (`previewBlob` is the first) |
| `customizer-error` | `{code, message, fieldId?, recoverable}`; sanitised (never contains shopper text or photo content) |

Error codes: `invalid-config`, `config-conflict`, `config-load-failed`, `font-load-failed`, `asset-load-failed`,
`asset-cors`, `asset-missing`, `restore-mismatch`, `export-failed`, `unexpected`.

#### Extension mode (ZenBasket Extension Platform Contract v1)

When the element resolves its template from the product (`product-id` + `api-base-url` + `store-id`) it can run as a
platform **extension**: it never touches the cart or order APIs, talks to its host through one generic envelope, and
saves the design to the personalization API itself. Everything above keeps working unchanged. Full contract:
[`docs/extension-platform-contract-v1.md`](docs/extension-platform-contract-v1.md); reference host bridge and demo
page: `integration-demo/extension-bridge.js`, `integration-demo/storefront-cart.html`.

| Surface | What |
|---|---|
| attributes / properties | `instance-id` (generated if absent), `placement` (host label), `hide-save` (hide the element's own Save button: the host's Add to cart is the primary action) |
| event `zb:event` | `bubbles` + `composed`. `detail = { contract: 1, extensionId, instanceId, slot, type, data, ts }` with standard types `ready {available}`, `rendered`, `gate {allowed, reason?}`, `error {code, recoverable}` (no message) and the custom `personalization.saved {customizationId, templateId, templateVersion, productId, variantId?, expiresAt?, source: 'save' \| 'cart'}` (identifiers and metadata only; the last four fields were added after the first release). In `storefront` mode `ready` arrives when the trigger is known to apply, `rendered` once the button is on screen, and `gate` is `allowed: false` until the shopper has saved a design |
| method `prepareForCart()` | Call on Add to cart, **after** `await customElements.whenDefined('zb-product-customizer')`. Saves the design (photo, print-ready artwork per area, previews, then the customization) and resolves `{ customizationId }`, or `{}` for a product with no personalization; rejects with a shopper-safe `Error` to cancel the add. Concurrent calls share one save; an unchanged design reuses its customization (including the one the modal's Save already stored). In `storefront` mode it uses the design the shopper saved in the modal and refuses a product they have not personalized |
| host event `zb:host-event` | Dispatch `{ type: 'cart.line-added' }` on the element after the line is created, so the next add saves a fresh customization |

Put only the returned `customizationId` on the cart line (as a line extension, namespace `personalization`). The
element keeps its access token to itself; the id alone cannot read or change anything.

Type declarations ship in `dist/product-personalization/types/` (`index.d.ts`, plus global `HTMLElementTagNameMap` entries so
`document.createElement('zb-product-customizer')` and `('zb-personalization-admin')` are typed).

### Theming

Set on the element or any ancestor: `--customizer-primary` (default `#296FD7`), `--customizer-font-family`,
`--customizer-radius` (default `8px`), `--customizer-border-color` (default `#6b7280`, which keeps the 3:1 contrast WCAG
asks of form controls). The widget draws its own white surface so contrast holds on any host background.

For debugging the host element mirrors its state in `data-status` (`awaiting-config`, `loading`, `ready`,
`invalid-config`, `asset-error`, `not-personalizable`), `data-save-state`, `data-mode` (`storefront` | `preview`) and
`data-modal` (`open`). In `storefront` mode `ready` means the trigger is showing. These are diagnostic, not part of the contract.

## Using the admin element

```html
<zb-personalization-admin id="admin" style="height: 800px"></zb-personalization-admin>
<script type="module">
  import '/personalization/store-admin.js';
  await customElements.whenDefined('zb-personalization-admin');
  const admin = document.getElementById('admin');

  admin.apiBaseUrl = 'https://api.example.com';            // enables cloud persistence
  admin.authToken = await myApp.getShortLivedSessionToken(); // yours to issue and refresh
  admin.productCatalog = await myApp.loadProducts();        // [{ id, title, sku?, imageUrl?, variants?, collections? }]
  admin.locale = 'fr';

  admin.addEventListener('config-published', (e) => console.log('live version', e.detail.version));
  admin.addEventListener('mapping-changed', (e) => console.log(e.detail.action, e.detail.mappings));
  admin.addEventListener('admin-error', (e) => console.warn(e.detail.code));
</script>
```

Give the element a height (CSS `height`, or `--zb-admin-height`; default `100vh`). Everything renders inside its
shadow root; the host page's CSS cannot reach in and nothing leaks out (no global styles, no `window` globals, no
`history` / `location` / `document.title` changes, no host-wide keyboard shortcuts). **Use one admin element per
page**: instances share one session (storage, API, token) and a second instance logs a warning.

### Properties and attributes

| Property | Attribute | Meaning |
|---|---|---|
| `apiBaseUrl` | `api-base-url` | Personalization API. With it set, templates, mappings and markups live in your store (PostgreSQL via the Worker); without it they live in this browser (IndexedDB) and the header says so |
| `authToken` | none | Host-issued short-lived session token for the signed-in merchant. **Never persisted** by the element and re-read on every request, so assigning a fresh token is all a refresh needs. The Worker takes the store from the verified token claims; the element never sends a store id |
| `productCatalog` | none | The host's products for the mapping UI: `{ id, title, sku?, imageUrl?, variants?: {id, title, sku?}[], collections?: {id, title}[] }[]`. The element never invents products; malformed entries and non-http(s) images are dropped |
| `productSearchUrl` | `product-search-url` | Alternative to `productCatalog`: `GET <url>?q=<text>&limit=50` answering `ProductRef[]`, `{items: ProductRef[]}` or `{data: ...}`. The session token is only ever sent to the personalization API's own origin, never to this URL |
| `view` | `view` | `list` \| `editor` \| `mapping` \| `preview` \| `orders`. Assigning it (even to the same value) navigates there |
| `configId` | `config-id` | Template shown by `editor` / `preview` / `mapping` |
| `orderId` | `order-id` | Order shown by `orders` (any platform order id; `null` shows the order list) |
| `readonly` | `readonly` | Disables every control that changes data (the editor shows the customer preview instead) |
| `locale` | `locale` | BCP-47 tag. Built-in: `en`, `fr`, `ar` (right-to-left languages mirror the layout); missing messages fall back to English |
| `allowedAssetOrigins` | none | Extra origins template images and fonts may load from |
| `persistence` | `persistence` | `'local'` / `'cloud'` override (default: cloud when `apiBaseUrl` is set) |

`view`, `configId` and `orderId` are *commands*: the merchant can navigate on their own, and the element reports
where it is through `data-view` / `data-config-id` / `data-order-id` attributes on itself and the `view-change`
event. Routing is in memory (a custom `LocationStrategy`), so the host URL never changes; deep-link by assigning
`view` / `config-id` / `order-id`.

### Events

Plain `CustomEvent`s on the element, not bubbling. Details never contain merchant content (template text,
product titles, tokens) beyond what is listed.

| Event | `event.detail` |
|---|---|
| `admin-ready` | `{ version, persistence }`, once, after the first view rendered |
| `view-change` | `{ view, configId, orderId }` (`orderId` is `null` outside the `orders` view) |
| `config-saved` | `{ configId, name, updatedAt }`, after a draft was stored |
| `config-published` | `{ configId, name, version, publishedAt }` |
| `config-archived` | `{ configId, name, archived, affectedMappings }`; `archived: false` is a restore |
| `mapping-changed` | `{ action: 'created'\|'reassigned'\|'updated'\|'deleted'\|'bulk', configId, mappings, deletedIds }` |
| `admin-error` | `{ code, message, recoverable }`; codes `auth`, `network`, `conflict`, `invalid`, `not-found`, `storage`, `forbidden`, `rate-limited`, `unexpected`. Messages are fixed strings chosen by error class: server messages and tokens never reach the host |

### Orders

`view = 'orders'` lists the store's orders that carry personalized lines (from the signed `order.confirmed`
webhook; needs `apiBaseUrl` — in browser-only mode the page says orders need the connected backend). Search by
order id/number, filter by date, page with "Load more". An order shows its header (number, date,
customer, addresses, totals — each "Not supplied by the store" until the platform sends it, see contract §7.1)
and one card per line: product/variant/SKU/quantity, template and version, a preview gallery with a lightbox,
every customer input labelled from the pinned template version (raw field ids if that version cannot be read),
and the production files with their pixel sizes. Files download through the authenticated API (the token is
never put in a URL): one file, "Download all" per line (`order-<orderId>-line-<lineId>.zip` with `production/`,
`previews/`, `uploads/`, `customization.json`) or "Download order" (a folder per line). ZIPs are built in the
browser by a small store-only writer (`src/app/orders/zip.ts`, no dependency: the files are already-compressed
PNG/JPEG); progress is announced, failed files are listed and only those are retried. `customization.json`
carries order/line identifiers and the design, not the customer's contact details. Uploads are named after the
field they were submitted for — the shopper's original file name is not stored by the storefront.

### Templates, editor, preview

The existing editor, unchanged in behaviour and tests: list (search, filter, create, duplicate, archive/restore,
delete, import/export), mockups, printable areas (rectangle, ellipse, custom SVG, four-corner perspective), artworks
and layers (photo, editable text, clipart choice, fixed image/text, shapes), customer inputs, `showWhen` rules,
variants, undo/redo, draft autosave with optimistic-concurrency conflict handling, keyboard shortcuts (active only
while focus is inside the editor) with numeric alternatives to every drag. **Preview** embeds the real storefront
renderer on the working draft, with test exports (one production PNG per area, one composite per mockup).
**Publish** is validated strictly; the confirmation says where the template is stored.

### Product mapping

*Product mapping* (header tab, or the row menu / editor header **Assign to products**) assigns a **published**
template to products. The template being assigned is picked in the page header.

* **Scopes:** the data model, API and storefront resolution support `product`, `variant` and `collection`; the
  target is the host's id (`externalId`). **Precedence when several match:** variant > product > collection
  (collection ties: lowest id). The admin page currently offers **products only**. SKUs are searchable and shown.
* **One active template per target.** `ProductMapping { id, storeId, configId, scope, externalId, label,
  createdAt, updatedAt }` is unique on `(storeId, scope, externalId)`. A target owned by another template is shown
  as **Assigned to another template** ("Currently uses “X”"); assigning it asks to **change the assignment** (it
  moves, the other template stops showing for it). Status is always text + icon, never colour alone.
* **Bulk assign / remove** with checkboxes, per-row buttons, status tabs (*All products / Not assigned / Using
  this template / Using another template*) and search.
* **Lifecycle:** mappings point at the template *id*, so publishing a new version needs no remapping (the storefront
  always gets the latest published version). Archiving a template warns how many mappings it has (archived
  templates are not served); deleting a template removes its mappings.

### Markup library

A **markup** is a reusable printable area (canvas, mask, print size, boundary) or artwork (its layers plus the
customer fields they use). **Save as markup…** is in the area / artwork menus; the **Markups** sidebar tab lists,
searches, inserts, renames and deletes them (names are unique per kind, case-insensitively). Inserting **copies**
the markup into the template (fresh ids for areas, artworks, layers and fields; fonts the template lacks fall back
to its first font with a notice); it is never a live link, and an insert that would make the template invalid is
refused. Stored per store (cloud) or in the browser.

### Language, direction, accessibility

All admin chrome is externalised (`src/app/admin/i18n/`); see *Known limitations* for what is still English.
Right-to-left locales mirror the layout (logical CSS properties). Responsive from 360 px, focus moves to the page
heading after a view change, a live region announces it, toasts are live regions, dialogs are native `<dialog>`,
reduced motion is respected. axe-core (WCAG 2.2 AA + best practice) is part of the browser suite for the list,
dialogs, mapping, the editor and every sidebar tab at 1280 px and 360 px, plus RTL and read-only variants.

### Strict CSP

Same recipe as the storefront (nonce via `<meta name="csp-nonce">`); the admin additionally needs
`img-src … blob: data:` (thumbnails). Verified with `default-src 'none'; script-src 'self'; style-src 'nonce-…'`.

### Theming

Design tokens are CSS custom properties on the element: `--c-primary`, `--c-primary-hover`, `--c-bg`, `--c-surface`,
`--c-text`, `--r-md`, `--font-sans` ... (see `src/styles/_tokens.scss`), plus `--zb-admin-height`.

## Persistence handoff (what the host must do)

`JSON.stringify(event.detail)` is **not** a persistence strategy: Blobs don't serialise. On `customizer-save`
the host should durably store

1. `customization`: plain JSON, no image bytes, no `blob:` URLs;
2. each `assets[i].blob` (canonical, metadata-free PNG/JPEG the shopper uploaded), keyed by `assetId`;
3. `artworks[i].blob`: one transparent PNG per active printable area, each at that area's own canvas size and
   masked to its shape (production artwork: no mockup, placeholders or outlines), and `previews[i].blob`: one
   composite per active mockup (mockup + artwork, longest edge ≤ 1200 px). `artworkBlob` / `previewBlob` are the
   first of each, kept for v1 hosts. A v2 `customization` also records the variant, the chosen artwork per area and
   only the fields that were active.

Then replace local ids (`local-…`) with durable references of your own, and answer with `saveResult`.

- **Idempotency.** Make persistence idempotent on `requestId`. After 30 s without an answer the element shows
  "No response yet" and offers **Retry**, which re-emits an identical payload: the same `requestId`, equal JSON and the
  very same Blob objects. Each emission carries its own copy of the JSON, so a host that mutates an event it received
  cannot alter what a retry sends. A *confirmed* `error` result unlocks editing; the next Save uses a new id.
- If the host sets `disabled` while the export is still running, the request is dropped, not sent.
- **Stale acknowledgements** (other request id, an old request, a request from before a config change) are ignored.
  Always acknowledge, because the form stays frozen while a request is pending.
- **Restore.** Pass the saved `customization` as `initialCustomization` and `assetMap` (durable URLs or Blobs, keyed
  by the asset ids in the JSON). An image that can't be resolved is reported (`asset-missing`) and must be
  uploaded again; it is never treated as valid.
- Display prices come from the config and are **indicative only**. The `displayPrice` snapshot in the JSON is
  marked `authoritative: false`; do pricing, tax and payment on your server.
- The artwork PNG is browser-generated: it carries no printer-specific DPI metadata. Physical dimensions travel in the
  JSON (`print`), so call it *artwork export*, not universally print-ready output.

### Cart line-item convention

(Standalone hosts that persist the design themselves from `customizer-save`. In extension mode the line carries the
`personalization` line extension instead; see above.)

The element never implements cart or checkout. Attach your own record id to the cart line so the order can be
tied back to the saved design:

| Line property | Value |
|---|---|
| `_zb_personalization_id` | The id of the record **your** backend created from `customizer-save` (e.g. the `requestId`, or your own id for the stored `customization` + PNGs + image files) |
| `_zb_template` | optional: `customization.templateId` / `configId` and version, for support and reorders |

Underscore-prefixed properties are hidden from the shopper by most storefronts. To edit from the cart or re-order,
load your stored customization and assets and assign `initialCustomization` + `assetMap` to a fresh element.

## Configuration

**Schema version 2** (`public/schema/product-config.schema.json`, types in `models/product.models.ts`, examples in
`public/data/products/*.json`) is what the editor produces. Coordinates: layers use the area's canvas pixels, mockup
placements are 0..1 fractions of the mockup photograph (so editor size never changes saved coordinates), z-order is
array order. Layer ids are unique across the configuration; fields are bound by `layer.fieldId` and may be scoped to
an area/artwork (omit the scope to share one field across artworks). Version 1 files are upgraded at load time.

The rest of this section documents **schema version 1**. `public/schema/customizer-config.schema.json` is the JSON Schema; `src/app/customizer/models/` has the matching
TypeScript types; `public/data/*.json` are three working examples. The runtime validator additionally enforces
what a schema can't: unique ids, field/font references, one layer per field, geometry inside the canvas,
print/canvas aspect equality, **mockup placement aspect equality (checked after the mockup loads; mismatches are
rejected, never stretched)**, asset URL policy, and the limits below.

Ids (fields, layers, fonts, choices, template, product) must match `[A-Za-z0-9][A-Za-z0-9_-]*` and must not be
`Object.prototype` names such as `constructor` or `toString`. Limits (v1): 10 fields, 20 layers, 5 fonts, 20 artwork choices per field, 100 grapheme clusters per text field;
images PNG/JPEG only, 10 MiB, 25 decoded megapixels; output ≤ 4096 px per axis and ≤ 16 MP.

Asset URLs: an asset path never contains `..` (only `assetBaseUrl` may climb), and may not start or end with
whitespace; only `http(s)` (no `data:`, `blob:`,
`javascript:`, `file:`), no credentials. For `configUrl` the `assetBaseUrl` resolves against the absolute config URL;
for object configuration it resolves against `baseUrl`, then `document.baseURI`.

Optional additions beyond the brief: `fonts[].label` (name in the font picker), `fields[].defaultChoiceId` and
`choices[].thumbnailSrc` for artwork.

Behaviour worth knowing: text is NFC-normalised and counted in grapheme clusters; over-limit text is an error, never
truncated; the font size shrinks in whole pixels from `fontSize` to `minFontSize` and, if it still doesn't fit, Save is
blocked; glyphs the font can't draw are rejected by probing the browser's rendering (heuristic, see limitations);
invisible format characters (zero-width, direction marks, BOM) are accepted but never count as content, and
direction overrides are rejected;
photo crops are `[left, top, width, height]` normalised to the EXIF-corrected image and always match the layer's aspect
ratio; effective DPI = retained source pixels / physical layer size, warning below 150 and blocking below 100 (a config
may raise those, not lower them).

## Deployment

`dist/product-personalization/MANIFEST.json` lists every file with size and SHA-256 and a role, and each entry's initial download graph.

| Role | Files | Deploy |
|---|---|---|
| `entry` | `storefront.js`, `store-admin.js` | The stable URLs (one per element); cache briefly |
| `runtime` | `main-<hash>.js`, `chunk-*.js` | Always, next to the entries; content-hashed, cache long |
| `license` | `3rdpartylicenses.txt` | Ship with the runtime |
| `contract` | `types/*.d.ts`, `schema/*.json` | For developers |
| `demo-asset` / `demo-page` | `data/`, `assets/`, `integration-demo/` | Samples; replace with your own templates and assets |

Static hosting is enough. Serve `.js` as `text/javascript`, `.woff2` as `font/woff2`. One bundle version per tag per
page: a second import is a no-op, and a different version logs a warning and keeps the first.
**Cross-origin assets, fonts and config need `Access-Control-Allow-Origin`** (they are fetched with CORS so the canvas
is never tainted; without it the element shows a readable asset error instead of a broken export).
Nothing here is a secret: don't put API keys in configuration.

### Content-Security-Policy

Verified with a strict host policy (`default-src 'none'`):

| Directive | Needs |
|---|---|
| `script-src` | the origin that serves the entry module (no `unsafe-eval`, no inline script) |
| `style-src` | a nonce: publish it as `<meta name="csp-nonce" content="…">`; the element applies it to its shadow-root styles (or allow `'unsafe-inline'`) |
| `connect-src` | origins of the config, images and fonts (all are `fetch`ed) |
| `img-src` | origins of artwork thumbnails (`<img>` cards) |

## Project layout

```
src/main.ts                     demo app bootstrap
src/main.elements.ts            side-effect-free build entry: loadStorefront() / loadAdmin()
src/main.storefront.ts          <zb-product-customizer> registration     src/main.admin.ts   <zb-personalization-admin> registration
src/app/app.*                   shell + lazy routes (/configurations, /configurations/:id, /preview/:id, /dev)
src/app/configurations/         workspace list, new-configuration dialog
src/app/workspace/              configuration records, repository interface + local implementation, import / export
src/app/editor/                 merchant editor: page, canvas stage, sidebar tabs, inspector, edit operations
src/app/preview/                customer preview (page and in-editor mode)
src/app/ui/                     icons, menu, dialog, confirm, toast, section, empty state
src/app/admin/                  the admin element: root component, in-memory router, host state, events, i18n
src/app/mapping/                product mapping: models, resolution, repositories (local/cloud/admin), catalog, page
src/app/markups/                markup library: models, pure capture/insert logic, repositories, sidebar tab, dialog
src/app/dev/                    development-only tools and the element contract demo
src/app/customizer/
  product-customizer.component.*  the element (inputs/outputs = public contract; all styles live in its shadow root)
  components/                   preview, text, photo+crop, artwork, action bar
  models/                       config / draft / events types + both element contracts (compiled to dist/product-personalization/types)
  services/                     config, font (shared cache), image, asset-store, state, render, export,
                                save-coordinator (request-id protocol), load-pipeline
  util/                         pure logic: v1/v2 validators, v1→v2 upgrade, resolution, URL policy, crop + DPI math,
                                text layout, scene evaluation, drawing, geometry/shapes
public/data, public/assets, public/schema      samples, fixtures, JSON Schema
integration-demo/               framework-free host pages: storefront.html, store-admin.html (copied into dist/…/integration-demo/)
scripts/                        finalize-element, serve-static, generate-fixtures
tests/browser, tests/types      browser suite and declaration consumer test (unit specs sit beside their sources)
```

Architecture in one paragraph: a pure function (`evaluateProduct`) turns configuration + resolved variant + draft +
loaded assets into one scene (list of draw operations) per active printable area plus every validation result. The
on-screen preview, the merchant canvas, every area's production PNG and the preview PNGs all draw those same scenes
with the same `drawAreaScene` / `drawComposite` code (only the target canvas size differs). Mutable state (`StateService`,
`AssetStore`, `SaveCoordinator`) is provided on each component instance, so two elements never share a draft; only the
immutable font cache is application-wide.

## Independent review

A separate reviewer was given the code and a condensed requirements list (not my conclusions) and asked for bugs the
tests would miss. It reported twelve; each was verified before acting, and all twelve were fixed with tests:
`Object.prototype`-named ids breaking the form, a restored canonical image over 10 MiB being refused, a `..` check
bypass through surrounding whitespace, the glyph probe wrongly rejecting format characters and accepting private-use /
unassigned code points, zero-width-only text satisfying a required field, fractional `minFontSize` handling, the
disabled/locked gates being re-checked only after a one-tick lag, events sharing mutable objects with internal
state, per-keystroke work on huge pasted text, an upload completing after Reset, `allowedAssetOrigins` not being
normalised, and a decoded bitmap not being closed on the pixel-budget error. Two of the new race tests were
mutation-checked: removing their fix makes them fail.

## Decisions that differ from, or add to, the brief

- **Action buttons are not sticky.** A pinned bar covers fields and focused controls (WCAG 2.4.11; axe flagged it), and a
  shadow-DOM widget cannot set `scroll-padding` on the host page to compensate. Price, blockers, status and Save sit
  together at the end of the controls.
- **Reactive Forms** are used as the brief asks (the repo's CLAUDE.md prefers Signal Forms for new forms).
- **Save is truly `disabled`** while invalid; the reasons are listed above the button. **Reset** uses `aria-disabled` so
  focus isn't lost when it becomes inactive after a reset.
- **No "abandon request" path** after a timeout: the form stays frozen until the host answers or the shopper retries, as
  the brief requires, so hosts must always acknowledge.
- `allowedAssetOrigins`, `fonts[].label`, `defaultChoiceId`, `thumbnailSrc`, the `csp-nonce` meta tag and `data-*` state
  attributes are small additions; the first implements the brief's "host configuration policy" for asset paths.
- UI text is English only; prices format with the `en` locale and the currency/exponent from the config.

## Verification (what was actually run)

Storefront trigger + modal (2026-11-18; the editor split out of the element into a lazy chunk). Baseline before the change on the
same machine: 419 unit tests, 157 browser tests passed / 12 failed (the mock harness did not answer the presigned-upload routes,
see below) / 2 skipped.

| Check | Result |
|---|---|
| `npm run test:ci` (38 spec files; new: `trigger-style`, `design-persister`, `design-saver`) | 448 passed (was 419) |
| `npm run build:element` then the whole browser suite (headless Chrome, production bundles) | 231 passed, 2 skipped (the env-gated cloud end-to-end), 0 failed. New: `storefront-trigger` (27 tests), `storefront-modal` (34) and a read-only admin check that the live preview is the inline editor with no trigger. The 12 earlier failures are fixed: the mock now answers the presign routes with the Worker's own `direct_upload_not_configured`, so the element takes its proxied-upload fallback (the direct PUT path itself is covered by `direct-upload.spec.ts` and the cloud e2e, not by these browser tests) |
| `npm run test:types` (new `mode`, `triggerStyle`, `ZbTriggerStyle`, `PersonalizationSavedData` with `@ts-expect-error` guards) | passes |
| `npm run build` (standalone app) | succeeds, no budget warnings |
| Storefront initial download (`MANIFEST.json`) | 429.4 kB -> 278.6 kB (the editor, about 63 kB raw / 17 kB gzip plus what only it needs, is a lazy chunk); budgets unchanged (warning 440 kB, error 700 kB) |

What the new browser specs cover: no button for an unmapped product, with a pending answer, and after a failure (with
Try again); the button for a mapped one; stale answers and rapid variant changes; no editor chunk requested and no second API
call before / on the click; Builder style (property, JSON attribute, in-place update with no request, hover, disabled,
focus ring, hostile values, contrast correction, no `<style>` added to the page, hostile host CSS, strict CSP); `preview`
mode and mode switching; two instances; the modal (native top layer, accessible name, focus in and back, Escape, backdrop,
discard question, refusal to close while saving); both save flows (element-managed and host-acknowledged: success, failure
with retry, stale acknowledgement, 30 s retry with the same request id); reopening a saved design; `prepareForCart()` reuse
and concurrency; product / variant / template changes while the modal is open; the 360 px and desktop layouts; stacking
above a clipping, `contain: paint`, max-z-index host; scroll containment; Tab never reaching the page; a failed editor
download and its recovery; axe-core (WCAG 2.2 AA + best practice) on the trigger, unavailable state, open modal and discard
question at 1280 px and 360 px.

**Not verified here:** Safari, Firefox, iOS (native `<dialog>`, `inert`, `dvh` and overscroll behaviour were exercised in Chrome
only), a low-end mobile profile, and the real ZenBasket storefront (the host-side changes above are the platform team's).
`archived` / draft-only templates are resolved by the Worker and covered by its tests, not re-tested in the browser.

Two-element release (admin element, product mapping, markups, resolve-by-product, backend routes):

| Check | Result |
|---|---|
| `npm run test:ci`: 22 unit spec files (adds mapping resolution, local mapping/markup repositories, markup capture/insert, storefront resolver, catalog, navigation, memory router, i18n incl. plural + catalog consistency) | 274 passed |
| `npm run build:element` then `npx vitest run --config tests/browser/vitest.config.mts` (headless Chrome 154, production bundles) | 137 passed, 1 skipped (the optional cloud end-to-end, below) |
| `npm run test:types`: consumer compiled against both shipped contracts (`@ts-expect-error` lines stay errors) | passes |
| `npm run build` (standalone app), `npm run build:element` | succeed; storefront initial download ≈ 398 kB, admin ≈ 520 kB (both within budget; the admin figure includes ≈ 500 translation keys in three languages) |
| `worker-api`: `npx tsc --noEmit`, `npm test` (real local PostgreSQL + in-memory R2) | 115 passed (43 pre-existing, 72 new: mapping conflicts and reassignment, bulk, precedence, unpublished/archived not served, tenant isolation, rate limiting, CORS, ETag/304, markups, asset URL rewriting) |
| **Live cloud end to end** (`tests/browser/cloud-e2e.spec.ts`): both elements against `wrangler dev` (real workerd, local PostgreSQL, local R2), over HTTP | passed: the admin imports, publishes and maps a template through the cloud repositories (checked back with `GET /mappings`), a markup round-trips, the storefront element resolves it from the public route (CORS per-store allow-list, no credentials), an unmapped product stays silent, an archived template stops being served |

The new browser specs: `admin-element` (registration once, double load, no head/global/history/title leak,
hostile host CSS, events, `view` / `config-id`, cloud token re-read and sanitised `auth` error, locale incl. French
editor and right-to-left), `admin-workflow` (import → publish → map → conflict → reassign → unmap → archive warning,
persistence across loads, read-only incl. editor→preview, markup save / insert / duplicate-name / delete, strict CSP),
`admin-accessibility` (axe-core WCAG 2.2 AA + best practice on list, dialogs, mapping, conflict dialog, editor and all
five sidebar tabs at 1280 px and 360 px, right-to-left + read-only, keyboard navigation and focus), `storefront-resolve`
(product resolution, attribute forms, fallback slot, variant re-resolution, retry, no credentials, origin policy, a
full save), `storefront-theming` (`--zb-*` variables, `::part()`, light / dark / auto, dark axe, skeleton) and
`demo-pages` (both shipped demo pages).

**Not verified:** a live Cloudflare account (deployed Hyperdrive / R2 / rate-limiting rules; the Worker's in-memory limiter
is per isolate and best-effort), browsers other than Chrome, a low-end mobile profile, and the Angular admin against a
*deployed* Worker (only the local `wrangler dev` stack above). The `worker-api` end-to-end test needs that stack running;
see `worker-api/README.md`.

Earlier verification of the single-element release (kept for the record):

| Check | Result |
|---|---|
| `npm test`: 13 unit spec files (v1 specs now run through the v1→v2 upgrade path) | 227 passed |
| `npm run test:browser`: production element bundle, headless Chrome 154 | 104 passed (the pre-existing v1 contract suite) |

Manual run of the redesigned application (Chrome, scripted with puppeteer; the scripts are scratch files and not committed):
a fresh profile opens an empty workspace (no seeded products); New configuration with a product photo opens the editor with
the setup guide; Add area → rectangle → draw on the mockup places and selects the area; layers are added from the Layers
menu (photo upload, editable text) and the customer preview shows the generated inputs, accepts a photo and enables the Test
files; Save draft, Publish, and the list status; duplicate, archive, filter, restore and delete (with confirmation); the
unsaved-changes prompt when leaving; a second tab's save is detected and refused instead of overwritten; configuration JSON
export, re-import and rejection of an invalid file; the compact layout (panels become drawers below 1180 px). With the
sample configurations added through the developer tools: select and drag a placement, five independent uploads in the
customer preview, and 2000 x 2000 / 3200 x 800 area PNGs plus two 1200 x 900 previews. axe-core (WCAG 2 A/AA, 2.1, 2.2 AA)
found no violations on the list, the editor and the customer preview (one label-in-name finding on the zoom button was
fixed).

The browser suite covers acceptance criteria A01–A20 (details in `tests/browser/*.spec.ts`), including pixel-level
checks that the exported artwork matches the crop/zoom/pan and orientation, that artwork excludes the mockup and the
preview includes it, multi-instance isolation and cleanup, a slow-load race on config change, nested base paths, a
second origin with and without CORS, a strict-CSP host, hostile host CSS, axe-core (WCAG 2.2 AA + best practice) at
360 px and 1280 px, keyboard-only completion, and the plain HTML demo end to end. Every test page also fails if Angular
logs an error.

Measured on the development machine (headless desktop Chrome, no GPU profile): preview update p50 33 ms / p95 34 ms
(two 60 Hz frames; i.e. within one frame budget); export 96 ms for the 1200 × 1200 fixture and 275 ms for a 4000 × 4000
canvas. **A low-end mobile device profile was not measured**, so the brief's mobile target is unverified.

### Known limitations

- **Storefront trigger and modal:** the eligibility answer includes the whole published configuration (the sample templates are
  11–16 kB raw, about 2 kB gzip, and the answer is HTTP-cacheable with an ETag), which the editor reuses when opened; a
  lightweight eligibility-only mode would only matter for very large templates that shoppers rarely open, and is not
  built. Add to cart stays gated until the shopper has saved a design (there is no "optional personalization" mode). The
  modal's own strings are English, like the rest of the storefront element. `triggerStyle` styles the button only.
- **Admin language coverage:** the admin chrome, list, editor, inspectors and dialogs are externalised (English,
  French, Arabic; about 500 keys). Still English: validator / server issue texts (shared with the server), names stored
  as template *content* ("Front view", "Print area 1" ...), the shopper-facing storefront strings, and `admin-error`
  event messages. Other languages fall back to English per key.
- One `<zb-personalization-admin>` per page (instances share one session; a second one warns).
- A markup area is inserted unplaced: the merchant places it on a mockup afterwards.
- Restoring a deleted template's mappings, per-store storefront origins UI, and a UI for the Worker's sync issues are
  not implemented. The public storefront route is cached up to 5 minutes at the edge, so a publish or unmap can take
  that long to reach shoppers.
- Mapping scopes are product / variant / collection; a SKU is matched through its product or variant id. The admin
  page assigns products only (variant and collection mappings work through the API and the storefront).
- Only Chrome was tested. Safari/Firefox behaviour is by design, not by test.
- The "can this font draw this character?" check compares browser rendering with generic fallbacks. It is reliable for
  real glyph gaps (CJK, emoji and Devanagari are rejected by the bundled Latin/Cyrillic/Greek fonts), but it is a
  heuristic and cannot see characters whose rendering equals both fallbacks.
- A decoded 25 MP photo is held as a bitmap in memory (about 100 MB); this is bounded by one live photo per image
  field and released on replace, remove, reset and element removal.
- The 30 s acknowledgement timer is scaled in tests (`?ackScale`); the real constant is asserted in the unit tests.
- No Zone-based or router-based host integration was tested, and no Angular-host-app embedding (the brief requires only
  framework independence).
- Fixtures: mockups, clipart and sample photos are original SVG drawings rendered by `scripts/generate-fixtures.mjs`; the four
  bundled fonts are unmodified Liberation fonts (SIL OFL 1.1, licence in `public/assets/fonts`), converted to WOFF2.
