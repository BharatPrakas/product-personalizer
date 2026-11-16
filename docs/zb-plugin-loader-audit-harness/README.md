# Plugin loader audit harness (2026-11-11)

Runs the **unmodified** `zb-storeadmin/.../custom-plugins.component.ts` in headless Chrome against this repo's real
`dist/product-personalization` build. Only Angular DI is stubbed (`src/ng-stub.ts`). Report: `../zb-plugin-loader-audit-2026-11-11.md`.

Setup (paths are absolute to the audit machine; adjust the constants at the top of `build.mjs`, `lib.mjs`, `src/entry.ts`):

1. `npm run build:element` in this repo (produces `dist/product-personalization`).
2. `node build.mjs` -> `site/harness.js`; create `site/index.html` (a page with `<div id="host">` and `<script type="module" src="/harness.js">`).
3. `cp -r ../../dist/product-personalization bucket/product-personalization` (and again as `bucket/plugin-b`) — the fake CDN on :14700.
4. For DEV1 only: `ng build --configuration development --output-path bucket3` — served on :14800 (`bucket2/evil.js` is copied there for F8).
5. `node t1.mjs` (T1-T3), `t2.mjs` (F1-F10), `t3.mjs` (DEV1), `t4.mjs` (P1, L1, L3, F9b, F11, F12).

Ports 14300/14700/14800 are used so the Store Admin dev port (4300) is never touched. Nothing here modifies the app sources.

`t5.mjs` (2026-11-12) exercises the updated loader + SDK end to end: a fake Worker on :14900 answers 401 to a stale token, the harness's
`zbService` hands out `stale` then `fresh`, and the mapping view must list the products the SDK returns. Needs `bucket/personalizedproduct`
(a copy of the served plugin folder) and `site/harness.js` built from the updated `build.mjs` (it stubs `ZbService` with `src/zb-service-stub.ts`).
