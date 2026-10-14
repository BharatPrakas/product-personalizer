# Product Customizer (`<zb-product-customizer>`)

A product personalization widget built with Angular and packaged as a framework-independent custom
element. A host page gives it a JSON configuration; the shopper enters text, uploads and crops a photo
or picks artwork, and sees a live preview. On **Save** the element hands the host a serialisable JSON
snapshot plus generated PNG files. It has no backend, no checkout and no admin UI: persistence, pricing
and the cart stay with the host.

This repository contains

- the **element** (`src/app/customizer`, built by `npm run build:element` into `dist/element/`),
- a standalone **Angular demo app** that plays the host (`src/app`, `npm start`),
- a **plain HTML integration demo** with no framework (`integration-demo/index.html`),
- three **sample templates** (text-only T-shirt, name + photo tote, text + artwork poster) with original assets,
- a **JSON Schema**, public **TypeScript declarations**, and automated tests.

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
| `npm start` | Dev server for the Angular demo app |
| `npm run build` | Production build of the demo app (`dist/product-personalizer`) |
| `npm run build:element` | Production element build, then `scripts/finalize-element.mjs` (stable entry, `.d.ts`, demo page, `MANIFEST.json`) |
| `npm test` | Unit tests (Vitest through `ng test`; `npm run test:ci` runs once without watch) |
| `npm run test:browser` | Builds the element, then runs the browser suite against it in headless Chrome |
| `npm run test:browser:dev` | Same suite against the **development** build (surfaces Angular dev-mode assertions) |
| `npm run test:types` | Compiles a consumer file against the shipped `.d.ts` files |
| `npm run generate:fixtures` | Regenerates the demo mockups, clipart and sample photos (needs Chrome) |

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
`@types/node` (test tooling). `@angular/router` from the scaffold was removed; it is not needed.

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
| `customizer-ready` | `{productId, templateId, templateVersion}`, once per successful load, after fonts and images are ready |
| `customizer-change` | `{draft, valid, dirty, errors}`; text edits debounced by 150 ms, other edits immediate; contains no image bytes |
| `customizer-save` | `{requestId, customization, previewBlob, artworkBlob, assets}` |
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
3. `artworkBlob` (transparent PNG at the configured pixel size; production artwork, no mockup) and
   `previewBlob` (mockup + artwork, longest edge ≤ 1200 px).

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

`public/schema/customizer-config.schema.json` is the JSON Schema; `src/app/customizer/models/` has the matching
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
src/app/app.*                   demo host (simulated save / failure / no response, downloads, restore)
src/app/customizer/
  product-customizer.component.*  the element (inputs/outputs = public contract; all styles live in its shadow root)
  components/                   preview, text, photo+crop, artwork, action bar
  models/                       config / draft / events types + element contract (compiled to dist/element/types)
  services/                     config, font (shared cache), image, asset-store, state, render, export,
                                save-coordinator (request-id protocol), load-pipeline
  util/                         pure logic: validator, URL policy, crop + DPI math, text fit, scene evaluation, drawing
public/data, public/assets, public/schema      samples, fixtures, JSON Schema
integration-demo/index.html     framework-free host page (copied into dist/element/integration-demo/)
scripts/                        finalize-element, serve-static, generate-fixtures
tests/browser, tests/types      browser suite and declaration consumer test (unit specs sit beside their sources)
```

Architecture in one paragraph: a pure function (`evaluateDraft`) turns configuration + draft + loaded assets into a list
of draw operations and every validation result. The on-screen preview, the artwork PNG and the preview PNG all draw that
same scene with the same `drawScene` code (only the target canvas size differs). Mutable state (`StateService`,
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
| `npm test`: 13 unit spec files | 227 passed |
| `npm run test:browser`: production bundle, headless Chrome 154 | 104 passed |
| `npm run test:browser:dev`: same suite on the dev build | 104 passed |
| `npm run test:types` | consumer compiles; five negative cases still error |
| `npm run build`, `npm run build:element` | succeed within budgets (element bundle ≈ 294 kB raw; Angular estimates ~80 kB transferred, plain gzip gives ~91 kB) |

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
