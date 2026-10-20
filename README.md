# Product Personalizer (merchant editor + `<zb-product-customizer>`)

A standalone Angular 22 application for TeeInBlue-style product personalization. A **merchant** manages
*configurations*: for each product, several mockups, independent printable areas (each with its own production
canvas and mask), artworks made of layers, and the customer inputs those layers need. The **customer preview** is
generated from the configuration: add a photo slot to an artwork and the matching upload field appears, with no
code change. The same rendering engine and the same `<zb-product-customizer>` custom element power both.

It runs entirely in the browser: configurations and uploaded images are stored in IndexedDB, rendering is Canvas 2D.
There is no backend yet; the persistence layer is an interface (see below) so ZenBasket integration can replace it
without touching the UI or the renderer.

```bash
npm install
npm start            # http://localhost:4200  ->  opens the Configurations workspace
```

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
   *Published · changes pending*. Leaving with unsaved changes asks first; saving over a copy changed in another tab
   is refused rather than overwritten.

Keyboard: `Ctrl/Cmd+S` save draft, `Ctrl/Cmd+Z` / `Shift+Z` undo / redo, `V` select, `H` pan, arrow keys nudge the
selection, `Esc` cancels drawing. The canvas has numeric alternatives for every move, resize and rotation.

### Persistence and publishing: what is real

| Operation | Status |
|---|---|
| Create, save draft, reopen, duplicate, archive / restore, delete | Implemented against the browser (IndexedDB); each resolves only after the write succeeded and failures are shown |
| Publish | Implemented as a state transition in the same store (draft → published snapshot; draft continues as the next version); validated strictly first |
| Import / export configuration JSON | Implemented (stored images are embedded as data URLs in exports) |
| Server persistence, multi-user publishing, authentication, cloud image storage, cart / checkout | **Not implemented**: no backend exists. The UI says "Saved in this browser only" |

All persistence goes through `ConfigurationRepository` (`src/app/workspace/configuration-repository.ts`):
`list`, `get`, `create`, `createFromDraft`, `saveDraft` (with an optimistic-concurrency check), `publish`, `duplicate`,
`archive`, `restore`, `delete`. `LocalConfigurationRepository` is the only implementation; a hosted deployment provides
another one in `app.config.ts`. If IndexedDB cannot be opened the app falls back to memory and says so on screen.

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

- No backend, authentication, catalog / cart / checkout, cloud upload, AI artwork or 3D.
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
npm run build:element        # production element bundle -> dist/element/
npm run serve:element        # serves dist/element at http://localhost:4300
                             #   plain HTML demo: http://localhost:4300/integration-demo/
```

| Script | What it does |
|---|---|
| `npm start` | Dev server for the standalone application |
| `npm run build` | Production build of the standalone app (`dist/product-personalizer`) |
| `npm run build:element` | Production element build, then `scripts/finalize-element.mjs` (stable entry, `.d.ts`, demo page, `MANIFEST.json`) |
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

## Using the element

```html
<div id="slot"></div>
<script type="module">
  import '/customizer/product-customizer.js';          // the stable entry URL
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

Setting `config`/`configUrl`/`baseUrl`/`initialCustomization`/`assetMap` (re)starts a load: the previous draft is
discarded, in-flight loads are aborted and late responses are ignored. Use the `dirty` flag from
`customizer-change` to confirm with the shopper **before** swapping the configuration.

### Events

Plain `CustomEvent`s dispatched on the element. They do **not** bubble; listen on the element.

| Event | `event.detail` |
|---|---|
| `customizer-ready` | `{productId, templateId, templateVersion}` (+ `schemaVersion: 2` for v2 configurations; `templateId`/`templateVersion` carry the configuration id/version), once per successful load, after fonts and images are ready |
| `customizer-change` | `{draft, valid, dirty, errors}`; text edits debounced by 150 ms, other edits immediate; contains no image bytes |
| `customizer-save` | `{requestId, customization, previewBlob, artworkBlob, assets, artworks, previews}`; `artworks` has one production PNG per active printable area (`artworkBlob` is the first), `previews` one composite per active mockup (`previewBlob` is the first) |
| `customizer-error` | `{code, message, fieldId?, recoverable}`; sanitised (never contains shopper text or photo content) |

Error codes: `invalid-config`, `config-conflict`, `config-load-failed`, `font-load-failed`, `asset-load-failed`,
`asset-cors`, `asset-missing`, `restore-mismatch`, `export-failed`, `unexpected`.

Type declarations ship in `dist/element/types/` (`index.d.ts`, plus a global `HTMLElementTagNameMap` entry so
`document.createElement('zb-product-customizer')` is typed).

### Theming

Set on the element or any ancestor: `--customizer-primary` (default `#296FD7`), `--customizer-font-family`,
`--customizer-radius` (default `8px`), `--customizer-border-color` (default `#6b7280`, which keeps the 3:1 contrast WCAG
asks of form controls). The widget draws its own white surface so contrast holds on any host background.

For debugging the host element mirrors its state in `data-status` (`awaiting-config`, `loading`, `ready`,
`invalid-config`, `asset-error`) and `data-save-state`. These are diagnostic, not part of the contract.

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

`dist/element/MANIFEST.json` lists every file with size and SHA-256 and a role.

| Role | Files | Deploy |
|---|---|---|
| `entry` | `product-customizer.js` | Always. The stable URL; cache briefly |
| `runtime` | `main-<hash>.js` (and any `chunk-*.js`) | Always, next to the entry; content-hashed, cache long |
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
src/main.ts                     demo app bootstrap          src/main.element.ts   element registration
src/app/app.*                   shell + lazy routes (/configurations, /configurations/:id, /preview/:id, /dev)
src/app/configurations/         workspace list, new-configuration dialog
src/app/workspace/              configuration records, repository interface + local implementation, import / export
src/app/editor/                 merchant editor: page, canvas stage, sidebar tabs, inspector, edit operations
src/app/preview/                customer preview (page and in-editor mode)
src/app/ui/                     icons, menu, dialog, confirm, toast, section, empty state
src/app/dev/                    development-only tools and the element contract demo
src/app/customizer/
  product-customizer.component.*  the element (inputs/outputs = public contract; all styles live in its shadow root)
  components/                   preview, text, photo+crop, artwork, action bar
  models/                       config / draft / events types + element contract (compiled to dist/element/types)
  services/                     config, font (shared cache), image, asset-store, state, render, export,
                                save-coordinator (request-id protocol), load-pipeline
  util/                         pure logic: v1/v2 validators, v1→v2 upgrade, resolution, URL policy, crop + DPI math,
                                text layout, scene evaluation, drawing, geometry/shapes
public/data, public/assets, public/schema      samples, fixtures, JSON Schema
integration-demo/index.html     framework-free host page (copied into dist/element/integration-demo/)
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

| Check | Result |
|---|---|
| `npm test`: 13 unit spec files (v1 specs now run through the v1→v2 upgrade path) | 227 passed |
| `npm run test:browser`: production element bundle, headless Chrome 154 | 104 passed (the pre-existing v1 contract suite) |
| `npm run test:types` | consumer compiles against the shipped `.d.ts` (now including `product.models.d.ts`) |
| `npm run build`, `npm run build:element` | succeed within budgets (element bundle ≈ 343 kB raw / ≈ 95 kB transferred; app initial ≈ 364 kB with the editor, preview and workspace as lazy chunks) |
| Manual end-to-end run of the v2 workflows (scripted with puppeteer, scratch scripts not committed) | see below |

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
